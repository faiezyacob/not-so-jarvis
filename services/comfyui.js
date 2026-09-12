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
    const { timeout, signal: cancelSignal, ...fetchOptions } = options;
    const timeoutSignal = AbortSignal.timeout(Number(timeout) || 120000);
    const signal = cancelSignal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([timeoutSignal, cancelSignal])
        : timeoutSignal;
    let res;
    try {
        res = await fetch(comfyUrl(path), Object.assign({}, fetchOptions, { signal }));
    } catch (error) {
        // A cancelled generation must surface as cancellation, not as an
        // "unreachable" error, even when it lands mid-request.
        if (cancelSignal && cancelSignal.aborted) {
            const cancelled = new Error('Generation cancelled.');
            cancelled.code = 'generation_cancelled';
            throw cancelled;
        }
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
    const signal = options.signal || null;
    const throwIfCancelled = () => {
        if (signal && signal.aborted) {
            const err = new Error('Generation cancelled.');
            err.code = 'generation_cancelled';
            throw err;
        }
    };

    // First check: ComfyUI may already have removed the prompt from the
    // queue and written its history entry before our first poll.
    while (Date.now() - startedAt < timeoutMs) {
        throwIfCancelled();
        let hist;
        try {
            const res = await comfyFetch('/history/' + encodeURIComponent(pid), { timeout: 15000, signal });
            hist = await res.json();
        } catch (err) {
            // Cancellation wins over the offline/404 retry paths.
            if (err.code === 'generation_cancelled') throw err;
            if (err.code === 'comfyui_unavailable') {
                // ComfyUI temporarily offline; keep polling until timeout.
                await sleep(pollMs, signal);
                continue;
            }
            if (err.status === 404) {
                // No history entry yet — still running or queued.
                await sleep(pollMs, signal);
                continue;
            }
            throw err;
        }

        const entry = hist && hist[pid];
        if (!entry) {
            await sleep(pollMs, signal);
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

        await sleep(pollMs, signal);
    }

    throwIfCancelled();
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

// Locate ComfyUI's install root (the folder containing main.py) so services
// can manage files there (custom node installs, input cleanup, ...). Tries,
// in order: an explicit COMFYUI_ROOT override, ComfyUI's main.py script path
// (from /system_stats argv), and the Comfy Desktop layout (where argv carries
// a relative main.py plus --output/--input-directory under
// <base>/ComfyUI-Shared, while the install lives at
// <base>/ComfyUI-Installs/ComfyUI/ComfyUI). Returns null when unknown.
async function resolveComfyRoot() {
    if (process.env.COMFYUI_ROOT) {
        const override = path.resolve(process.env.COMFYUI_ROOT);
        if (fs.existsSync(override)) return override;
    }

    let argv = [];
    try {
        const stats = await getSystemStats();
        argv = (stats && stats.system && stats.system.argv) || [];
    } catch {}

    for (const arg of argv) {
        const script = String(arg || '');
        if (!/[\\/]main\.py$/i.test(script)) continue;
        const root = path.resolve(path.dirname(script));
        if (fs.existsSync(path.join(root, 'main.py'))) return root;
    }

    // Comfy Desktop: derive the install root from the shared data dir.
    for (const dir of comfyArgDirs(argv, ['--output-directory', '--output_directory', '--input-directory', '--input_directory'])) {
        const parent = path.basename(dir);
        if (parent !== 'ComfyUI-Shared' && parent !== 'output' && parent !== 'input') continue;
        const base = parent === 'ComfyUI-Shared' ? path.dirname(dir) : path.dirname(path.dirname(dir));
        const candidate = path.join(base, 'ComfyUI-Installs', 'ComfyUI', 'ComfyUI');
        if (fs.existsSync(path.join(candidate, 'main.py'))) return candidate;
    }

    return null;
}

// Values of the given CLI flags from ComfyUI's argv (both `--flag value`
// and `--flag=value` forms), resolved to absolute paths that exist.
function comfyArgDirs(argv, flags) {
    const out = [];
    for (let i = 0; i < argv.length; i += 1) {
        const arg = String(argv[i] || '');
        let dir = null;
        if (flags.indexOf(arg) !== -1) {
            dir = String(argv[i + 1] || '');
        } else {
            for (const flag of flags) {
                if (arg.indexOf(flag + '=') === 0) dir = arg.slice(flag.length + 1);
            }
        }
        if (dir) {
            const resolved = path.resolve(dir);
            if (fs.existsSync(resolved)) out.push(resolved);
        }
    }
    return out;
}

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

// Resolve ComfyUI's models directory (default <ComfyUI>/models) so services can
// discover installed models (SeedVR2 DiT/VAE, upscale models, ...). Tries an
// explicit COMFYUI_MODEL_DIR override, then the resolved output/input directory
// siblings (covers Comfy Desktop's shared-data layout, where <shared>/models
// sits next to <shared>/output), then the root-derived path. Returns null when
// unknown.
async function resolveModelRoot() {
    if (process.env.COMFYUI_MODEL_DIR) {
        return path.resolve(process.env.COMFYUI_MODEL_DIR);
    }

    for (const sibling of [await resolveOutputDir(), await resolveInputDir()]) {
        if (!sibling) continue;
        const candidate = path.join(path.dirname(sibling), 'models');
        if (fs.existsSync(candidate)) return candidate;
    }

    const root = await resolveComfyRoot();
    if (!root) return null;
    const candidate = path.join(root, 'models');
    return fs.existsSync(candidate) ? candidate : null;
}

// Resolve ComfyUI's input directory (default <ComfyUI>/input) so files uploaded
// for upscaling can be cleaned up afterwards. Tries an explicit COMFYUI_INPUT_DIR
// override, then ComfyUI's --input-directory CLI arg (from /system_stats argv),
// then derives it from the resolved ComfyUI root. Returns null when unknown.
async function resolveInputDir() {
    if (process.env.COMFYUI_INPUT_DIR) {
        return path.resolve(process.env.COMFYUI_INPUT_DIR);
    }

    let argv = [];
    try {
        const stats = await getSystemStats();
        argv = (stats && stats.system && stats.system.argv) || [];
    } catch {}

    for (let i = 0; i < argv.length; i += 1) {
        const arg = String(argv[i] || '');
        let dir = null;
        if (arg === '--input-directory' || arg === '--input_directory') {
            dir = String(argv[i + 1] || '');
        } else if (/^--input-(?:directory|_directory)=/.test(arg)) {
            dir = arg.split('=').slice(1).join('=');
        }
        if (dir) {
            const resolved = path.resolve(dir);
            if (fs.existsSync(resolved)) return resolved;
        }
    }

    const root = await resolveComfyRoot();
    if (!root) return null;
    const candidate = path.join(root, 'input');
    return fs.existsSync(candidate) ? candidate : null;
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

// Upload a source image into ComfyUI's input folder so a LoadImage node can
// reference it (used by the upscale pipeline). Returns ComfyUI's
// { name, subfolder, type } entry.
async function uploadImage(buffer, filename, options = {}) {
    const form = new FormData();
    form.append('image', new Blob([buffer], { type: 'image/png' }), filename);
    form.append('type', 'input');
    form.append('overwrite', 'true');
    if (options.subfolder) form.append('subfolder', options.subfolder);
    const res = await comfyFetch('/upload/image', {
        method: 'POST',
        body: form,
        timeout: 60000
    });
    return res.json();
}

// Best-effort removal of a file previously uploaded to ComfyUI's input folder.
// ComfyUI ships no HTTP delete for input files, so when it runs on the same
// machine we unlink the file directly. Never throws.
async function deleteInputFile(filename) {
    if (!filename) return false;
    let inputDir;
    try {
        inputDir = await resolveInputDir();
    } catch {
        inputDir = null;
    }
    if (!inputDir) return false;
    const target = path.resolve(path.join(inputDir, path.basename(filename)));
    const root = path.resolve(inputDir) + path.sep;
    if (target !== path.resolve(inputDir) && target.indexOf(root) !== 0) {
        console.warn('[comfyui] refusing to delete path outside input dir: ' + target);
        return false;
    }
    try {
        await fs.promises.unlink(target);
        console.log('[comfyui] removed ComfyUI input:', target);
        return true;
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn('[comfyui] could not remove ComfyUI input ' + target + ': ' + err.message);
        }
        return false;
    }
}

// Interrupt the currently executing ComfyUI prompt. Used when the user
// cancels the active generation from the queue endpoint.
async function interrupt() {
    const res = await comfyFetch('/interrupt', {
        method: 'POST',
        timeout: 15000
    });
    await res.text().catch(() => '');
    return true;
}

// Clear ComfyUI's native pending queue (prompts waiting behind the running
// one). ComfyUI's /queue endpoint accepts { "clear": true } for this.
// Best-effort: never throws for an empty queue, throws only when ComfyUI
// is unreachable or rejects the request.
async function clearQueue() {
    const res = await comfyFetch('/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true }),
        timeout: 15000
    });
    await res.text().catch(() => '');
    return true;
}

// Cancel whatever ComfyUI is doing right now: interrupt the running prompt
// and drop any pending prompts so the GPU goes idle. Used by the ComfyUI
// widget's Cancel button. Both steps are best-effort — interrupting an idle
// instance is a no-op and ComfyUI answers 200 either way.
async function cancelCurrentJob() {
    let interrupted = false;
    let cleared = false;
    let interruptError = null;
    let clearError = null;
    try {
        await interrupt();
        interrupted = true;
    } catch (err) {
        interruptError = err;
    }
    try {
        await clearQueue();
        cleared = true;
    } catch (err) {
        clearError = err;
    }
    if (!interrupted && !cleared) {
        const detail = (interruptError && interruptError.message) || (clearError && clearError.message) || 'cancel failed';
        const error = new Error(detail);
        error.code = (interruptError && interruptError.code) || (clearError && clearError.code) || 'comfyui_api_error';
        throw error;
    }
    return { interrupted, cleared };
}

function sleep(ms, signal) {
    if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
    return new Promise((resolve, reject) => {
        const cancelled = () => {
            const err = new Error('Generation cancelled.');
            err.code = 'generation_cancelled';
            return err;
        };
        if (signal.aborted) {
            reject(cancelled());
            return;
        }
        const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
        const onAbort = () => { cleanup(); reject(cancelled()); };
        function cleanup() {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
        }
        signal.addEventListener('abort', onAbort, { once: true });
    });
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
    interrupt,
    clearQueue,
    cancelCurrentJob,
    queuePrompt,
    waitForPrompt,
    findOutputFiles,
    extractTextOutputs,
    downloadImage,
    deleteOutputFile,
    deleteHistory,
    downloadSourceImage,
    uploadImage,
    deleteInputFile,
    resolveComfyRoot,
    resolveModelRoot,
    resolveInputDir,
    sleep
};