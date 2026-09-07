/* ============================================
   JARVIS — ComfyUI Service
   Handles all communication with the local
   ComfyUI instance: health check, queueing a
   workflow, tracking its progress, and
   downloading generated images.
   ============================================ */

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
    freeModels,
    queuePrompt,
    waitForPrompt,
    findOutputFiles,
    extractTextOutputs,
    downloadImage,
    downloadSourceImage,
    sleep
};