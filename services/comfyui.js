/* ============================================
   JARVIS — ComfyUI Service
   Handles all communication with the local
   ComfyUI instance: health check, queueing a
   workflow, tracking its progress, and
   downloading generated images.
   ============================================ */

const fs = require('fs');
const path = require('path');

const COMFYUI_URL = (process.env.COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');
const CLIENT_ID = 'jarvis-' + Math.random().toString(16).slice(2, 10);

// How long to wait for a generation to finish (image jobs on local hardware
// can take a while, especially the first model load).
const GENERATION_TIMEOUT_MS = Number(process.env.COMFYUI_TIMEOUT_MS) || 15 * 60 * 1000;

function comfyUrl(path) {
    return COMFYUI_URL + path;
}

// WebSocket endpoint for real-time progress events ({"type":"progress","data":{value,max}}).
// Derived from the same origin/config as the fetch endpoints.
function comfyWsUrl() {
    const wsBase = COMFYUI_URL.replace(/^https/i, 'wss').replace(/^http/i, 'ws');
    return wsBase + '/ws';
}

async function comfyFetch(path, options = {}) {
    let res;
    try {
        res = await fetch(comfyUrl(path), Object.assign({
            signal: AbortSignal.timeout(Number(options.timeout) || 120000)
        }, options));
    } catch (error) {
        const detail = String((error && error.cause && error.cause.message) || error.message || error || 'connection failed');
        const wrapped = new Error(
            'Could not reach ComfyUI for ' + (options.method || 'GET') + ' ' + path + ': ' + detail +
            '. Check that ComfyUI is running at ' + COMFYUI_URL + '.'
        );
        wrapped.code = 'comfyui_unavailable';
        wrapped.cause = error;
        throw wrapped;
    }

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const wrapped = new Error('ComfyUI ' + path + ' -> ' + res.status + ' ' + text.slice(0, 400));
        wrapped.code = 'comfyui_api_error';
        wrapped.status = res.status;
        throw wrapped;
    }

    return res;
}

// Quick health check used before starting a generation so we can give the
// user a friendly error when ComfyUI is not running.
async function isAvailable() {
    try {
        const res = await comfyFetch('/system_stats', { timeout: 5000 });
        const stats = await res.json();
        return !!stats && !!stats.system;
    } catch (err) {
        return false;
    }
}

async function getObjectInfo(timeoutMs) {
    const res = await comfyFetch('/object_info', { timeout: Number(timeoutMs) || 120000 });
    return res.json();
}

// --- Real-time progress relay ---------------------------------------------
//
// Keeps a single process-wide WebSocket connection to ComfyUI and broadcasts
// its text progress events ({"type":"progress","data":{value,max}}) to any
// registered subscriber. This mirrors how the frontend learns the live step
// percentage without the browser ever connecting to ComfyUI directly. Native
// WebSocket is available in Node >= 22; on older runtimes this falls back to
// nothing (the widget just shows the indeterminate bar).

let progressWs = null;
let progressWsTimer = null;
let progressSubscribers = [];

function subscribeProgress(cb) {
    if (typeof cb !== 'function') return;
    progressSubscribers.push(cb);
    if (progressSubscribers.length === 1) ensureProgressWs();
}

function unsubscribeProgress(cb) {
    progressSubscribers = progressSubscribers.filter((fn) => fn !== cb);
    if (progressSubscribers.length === 0) closeProgressWs();
}

function ensureProgressWs() {
    if (typeof WebSocket === 'undefined') return;
    if (progressWs && (progressWs.readyState === 0 || progressWs.readyState === 1)) return;
    let ws;
    try {
        ws = new WebSocket(comfyWsUrl() + '?clientId=' + CLIENT_ID);
    } catch (err) {
        scheduleProgressWsRetry();
        return;
    }
    progressWs = ws;
    ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (!msg || typeof msg !== 'object' || !msg.data) return;
        const d = msg.data;
        if (msg.type === 'progress' && typeof d.value === 'number' && typeof d.max === 'number') {
            const update = { value: d.value, max: d.max };
            progressSubscribers.slice().forEach((fn) => { try { fn(update); } catch {} });
        } else if (msg.type === 'executing' && d.node === null) {
            // Generation finished — clear to 100% then idle.
            progressSubscribers.slice().forEach((fn) => { try { fn({ value: 1, max: 1, idle: true }); } catch {} });
        }
    };
    ws.onclose = () => { progressWs = null; scheduleProgressWsRetry(); };
    ws.onerror = () => { try { ws.close(); } catch {} };
}

function scheduleProgressWsRetry() {
    if (progressSubscribers.length === 0) return;
    clearTimeout(progressWsTimer);
    progressWsTimer = setTimeout(ensureProgressWs, 2000);
}

function closeProgressWs() {
    clearTimeout(progressWsTimer);
    progressWsTimer = null;
    if (progressWs) {
        try {
            progressWs.onopen = null;
            progressWs.onmessage = null;
            progressWs.onerror = null;
            progressWs.onclose = null;
            progressWs.close();
        } catch {}
    }
    progressWs = null;
}

// Fetch the ComfyUI execution queue. Returns an object with queue_running
// (array of currently executing prompts) and queue_pending (queued prompts).
async function getQueue() {
    const res = await comfyFetch('/queue', { timeout: 5000 });
    return res.json();
}

// Fetch ComfyUI system/device stats (GPU name, VRAM usage, etc.).
async function getSystemStats() {
    const res = await comfyFetch('/system_stats', { timeout: 5000 });
    return res.json();
}

// Unload all models from VRAM and free cached memory in ComfyUI. Used to free
// VRAM before loading/using the chat model when the GPU is nearly full.
async function freeModels() {
    const res = await comfyFetch('/free', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
        timeout: 30000
    });
    await res.text();
}

// Submit a workflow graph (API format) and return the prompt id.
async function queuePrompt(graph) {
    const body = { prompt: graph, client_id: CLIENT_ID };
    let res;
    try {
        res = await comfyFetch('/prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    } catch (err) {
        if (err.code === 'comfyui_api_error') {
            const wrapped = new Error('ComfyUI rejected the workflow. Check that the Krea2 custom nodes are installed: ' + String(err.message).slice(0, 400));
            wrapped.code = 'comfyui_validation_error';
            throw wrapped;
        }
        throw err;
    }

    const json = await res.json();
    if (json.node_errors && Object.keys(json.node_errors).length) {
        const error = new Error('ComfyUI validation: ' + JSON.stringify(json.node_errors).slice(0, 500));
        error.code = 'comfyui_validation_error';
        throw error;
    }
    if (!json.prompt_id) {
        const error = new Error('ComfyUI did not return a prompt id');
        error.code = 'comfyui_api_error';
        throw error;
    }
    return json.prompt_id;
}

function findOutputFiles(outputs, extRe) {
    const files = [];
    for (const out of Object.values(outputs || {})) {
        if (!out || typeof out !== 'object') continue;
        for (const arr of Object.values(out)) {
            if (!Array.isArray(arr)) continue;
            for (const entry of arr) {
                if (entry && typeof entry === 'object' && typeof entry.filename === 'string'
                    && entry.type === 'output' && extRe.test(entry.filename)) {
                    files.push(entry);
                }
            }
        }
    }
    return files;
}

function extractTextOutputs(outputs) {
    const texts = [];
    for (const out of Object.values(outputs || {})) {
        if (out && Array.isArray(out.text) && out.text.length) {
            texts.push(String(out.text[0]));
        }
    }
    return texts;
}

// Poll ComfyUI's /history until the prompt is done, errors out, or we time
// out. Returns the history entry.
async function waitForPrompt(pid, options = {}) {
    const timeoutMs = Number(options.timeoutMs) || GENERATION_TIMEOUT_MS;
    const startedAt = Date.now();
    const pollMs = Number(options.pollMs) || 1000;

    // First check: ComfyUI may already have removed the prompt from the
    // queue and written its history entry before our first poll.
    while (Date.now() - startedAt < timeoutMs) {
        let hist;
        try {
            const res = await comfyFetch('/history/' + encodeURIComponent(pid), { timeout: 15000 });
            hist = await res.json();
        } catch (err) {
            if (err.code === 'comfyui_unavailable') {
                // ComfyUI temporarily offline; keep polling until timeout.
                await sleep(pollMs);
                continue;
            }
            if (err.status === 404) {
                // No history entry yet — still running or queued.
                await sleep(pollMs);
                continue;
            }
            throw err;
        }

        const entry = hist && hist[pid];
        if (!entry) {
            await sleep(pollMs);
            continue;
        }

        if (entry.status && entry.status.completed) {
            return entry;
        }
        if (entry.status && entry.status.status_str === 'error') {
            const messages = (entry.status.messages || [])
                .map((m) => (m && m[1] && m[1].message) || '')
                .filter(Boolean)
                .join(' ');
            const error = new Error('ComfyUI generation failed: ' + (messages || 'execution error (see ComfyUI console)'));
            error.code = 'comfyui_generation_error';
            throw error;
        }

        await sleep(pollMs);
    }

    const error = new Error('ComfyUI generation timed out after ' + Math.round(timeoutMs / 1000) + 's');
    error.code = 'comfyui_timeout';
    throw error;
}

async function downloadImage(entry) {
    const query =
        '/view?filename=' + encodeURIComponent(entry.filename) +
        '&subfolder=' + encodeURIComponent(entry.subfolder || '') +
        '&type=output';
    const res = await comfyFetch(query, { timeout: 60000 });
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) {
        const error = new Error('ComfyUI returned an empty image for ' + entry.filename);
        error.code = 'comfyui_empty_output';
        throw error;
    }
    return buf;
}

// Locate ComfyUI's output directory so we can remove the original copy of a
// generated image. Tries, in order: an explicit COMFYUI_OUTPUT_DIR override,
// ComfyUI's --output-directory CLI arg (from /system_stats argv), and a
// .../ComfyUI/main.py script path (again from argv) with an output/ sibling.
// Returns null when the directory cannot be determined.
async function resolveOutputDir() {
    if (process.env.COMFYUI_OUTPUT_DIR) {
        return path.resolve(process.env.COMFYUI_OUTPUT_DIR);
    }

    let argv = [];
    try {
        const stats = await getSystemStats();
        argv = (stats && stats.system && stats.system.argv) || [];
    } catch {}

    for (let i = 0; i < argv.length; i += 1) {
        const arg = String(argv[i] || '');
        let dir = null;
        if (arg === '--output-directory' || arg === '--output_directory') {
            dir = String(argv[i + 1] || '');
        } else if (/^--output-(?:directory|_directory)=/.test(arg)) {
            dir = arg.split('=').slice(1).join('=');
        }
        if (dir) {
            const resolved = path.resolve(dir);
            if (fs.existsSync(resolved)) return resolved;
        }
    }

    for (const arg of argv) {
        const script = String(arg || '');
        if (!/[\\/]main\.py$/i.test(script)) continue;
        const root = path.resolve(path.dirname(script));
        const candidate = path.join(root, 'output');
        if (fs.existsSync(candidate)) return candidate;
    }

    return null;
}

// Remove a generated image from ComfyUI's output folder. ComfyUI ships no HTTP
// delete for output files, so when it runs on the same machine we unlink the
// file directly. Best-effort: never throws. When options.history (a prompt id)
// is given, the corresponding /history entry is cleared too so ComfyUI doesn't
// keep a dangling reference to the removed file.
async function deleteOutputFile(entry, options = {}) {
    if (!entry || !entry.filename) return false;
    let target;
    try {
        target = await resolveOutputFilePath(entry);
    } catch {
        target = null;
    }
    if (!target) {
        console.warn('[comfyui] cannot resolve ComfyUI output dir; leaving original at output/' +
            (entry.subfolder ? entry.subfolder + '/' : '') + entry.filename +
            '. Set COMFYUI_OUTPUT_DIR to enable cleanup.');
        await safeDeleteHistory(options);
        return false;
    }
    try {
        await fs.promises.unlink(target);
        console.log('[comfyui] removed ComfyUI output:', target);
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn('[comfyui] could not remove ComfyUI output ' + target + ': ' + err.message);
        }
    } finally {
        await safeDeleteHistory(options);
    }
    return true;
}

async function resolveOutputFilePath(entry) {
    const outputDir = await resolveOutputDir();
    if (!outputDir) return null;
    const filename = path.basename(entry.filename);
    if (!filename) return null;
    const candidate = path.resolve(outputDir, String(entry.subfolder || ''), filename);
    const root = path.resolve(outputDir) + path.sep;
    if (candidate !== path.resolve(outputDir) && candidate.indexOf(root) !== 0) {
        console.warn('[comfyui] refusing to delete path outside output dir: ' + candidate);
        return null;
    }
    return candidate;
}

async function safeDeleteHistory(options) {
    if (!options || !options.history) return;
    try {
        await deleteHistory(options.history);
    } catch (err) {
        console.warn('[comfyui] could not clear ComfyUI history for ' + options.history + ': ' + err.message);
    }
}

// Remove a prompt's entry from ComfyUI's /history so it doesn't reference a
// deleted output file.
async function deleteHistory(pid) {
    const res = await comfyFetch('/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [pid] }),
        timeout: 30000
    });
    await res.text();
}

async function downloadSourceImage(imageName) {
    const parts = String(imageName || '').split('/');
    const filename = parts.pop();
    const subfolder = parts.join('/');
    const query =
        '/view?filename=' + encodeURIComponent(filename) +
        '&subfolder=' + encodeURIComponent(subfolder) +
        '&type=input';
    const res = await comfyFetch(query, { timeout: 60000 });
    return Buffer.from(await res.arrayBuffer());
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
    COMFYUI_URL,
    GENERATION_TIMEOUT_MS,
    comfyUrl,
    comfyWsUrl,
    comfyFetch,
    isAvailable,
    getObjectInfo,
    getQueue,
    getSystemStats,
    subscribeProgress,
    unsubscribeProgress,
    freeModels,
    queuePrompt,
    waitForPrompt,
    findOutputFiles,
    extractTextOutputs,
    downloadImage,
    deleteOutputFile,
    deleteHistory,
    downloadSourceImage,
    sleep
};