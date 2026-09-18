/* ============================================
   JARVIS — FastH3 8-Step V2 Installer + Status
   Optional T2VA accelerator: FastVideo's FastH3 8-Step V2 distillation of
   MiniMax H3 (https://huggingface.co/FastVideo/FastVideo-FastH3-8-Step-V2),
   repackaged for ComfyUI as FastVideo/FastVideo-FastH3-Comfy. The checkpoint
   renders synchronized video+audio in eight transformer forwards with VSA
   sparse attention and a video flow shift of 10.

   This module reports whether ComfyUI is ready (checkpoint on disk, the
   MiniMaxH3SigmaShift node loaded) and, on first enable, streams the
   checkpoint from Hugging Face into ComfyUI's models/diffusion_models/
   folder. The text encoder + VAEs are the standard H3 files the Setup guide
   already installs, so only the UNET is fetched here.

   Unlike FaceRefine no custom node pack or pip package is needed: the
   checkpoint is a drop-in ComfyUI model and MiniMaxH3SigmaShift ships with
   current ComfyUI. Loading the checkpoint still requires a ComfyUI build with
   FastH3 VSA gate support (native MiniMax H3 plus the VSA gate loader).

   Zero npm dependencies: node builtins + global fetch, streamed to disk so
   the multi-GB checkpoint never sits fully in memory.
   SPDX-License-Identifier: MIT
   ============================================ */

const fs = require('fs');
const path = require('path');
const comfyui = require('./comfyui');
const configManager = require('../server/config-manager');

const HF_REPO = 'FastVideo/FastVideo-FastH3-Comfy';
const HF_PATH = 'diffusion_models/fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors';
const UNET_FILE = process.env.H3_FASTH3_UNET || 'fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors';
const UNET_DEST = 'diffusion_models';
const UNET_MIN_BYTES = 5 * 1024 ** 3;
const DOWNLOAD_URL = 'https://huggingface.co/' + HF_REPO + '/resolve/main/' +
    HF_PATH.split('/').map(encodeURIComponent).join('/');

// MiniMaxH3SigmaShift is the core ComfyUI node FastH3 uses to apply its
// trained video/audio flow shift (10 / 3).
const REQUIRED_NODES = ['MiniMaxH3SigmaShift'];

// Background install job (single-flight, never persisted; the status endpoint
// reports it so the settings UI can poll). Mirrors face-refine.js.
const job = {
    running: false,
    done: false,
    ok: false,
    error: null,
    log: [],
    received: 0,
    total: 0,
    startedAt: null,
    finishedAt: null,
    autoStarted: false
};

function logLine(text) {
    const line = String(text || '');
    job.log.push(line);
    if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
    console.log('[fast-h3] ' + line);
}

function jobState() {
    return {
        running: job.running,
        done: job.done,
        ok: job.ok,
        error: job.error,
        log: job.log.slice(-40),
        received: job.received,
        total: job.total,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt
    };
}

// Configured checkpoint filename (a custom fastH3Unet setting wins over the
// default). Loaded lazily to avoid a require cycle with video-generator.
function configuredUnetFile() {
    try {
        const videoGenerator = require('./video-generator');
        const settings = videoGenerator.effectiveVideoSettings();
        const fallback = videoGenerator.getVideoDefaults();
        const value = settings.fastH3Unet || fallback.fastH3Unet;
        return String(value || UNET_FILE).trim() || UNET_FILE;
    } catch {
        return UNET_FILE;
    }
}

function authHeaders() {
    const token = configManager.getHuggingFaceToken();
    return token ? { Authorization: 'Bearer ' + token } : {};
}

function filePresent(dir, filename, minBytes) {
    try {
        const full = path.join(dir, filename);
        const st = fs.statSync(full);
        return st.isFile() && st.size >= (minBytes || 1) ? { path: full, size: st.size } : null;
    } catch {
        return null;
    }
}

// Filenames ComfyUI reports as loadable through UNETLoader. The authoritative
// "ComfyUI can see it" signal, covering symlinked/extra-path model folders.
function unetChoices(info) {
    try {
        const entry = info && info.UNETLoader && info.UNETLoader.input &&
            info.UNETLoader.input.required && info.UNETLoader.input.required.unet_name;
        if (Array.isArray(entry) && Array.isArray(entry[0])) return entry[0].map(String);
    } catch { /* unknown shape */ }
    return [];
}

async function getStatus() {
    const file = configuredUnetFile();
    const status = {
        comfyAvailable: false,
        comfyRoot: null,
        modelRoot: null,
        unetFile: file,
        unetFound: false,
        unetPath: null,
        unetSeen: false,
        nodesPresent: {},
        nodesMissing: [],
        ready: false,
        restartRequired: false,
        source: { repo: HF_REPO, path: HF_PATH, url: DOWNLOAD_URL },
        job: jobState()
    };
    if (!(await comfyui.isAvailable())) return status;
    status.comfyAvailable = true;

    let info = null;
    try {
        info = await comfyui.getObjectInfo(30000);
    } catch { info = null; }
    if (info) {
        for (const name of REQUIRED_NODES) status.nodesPresent[name] = Boolean(info[name]);
        status.nodesMissing = REQUIRED_NODES.filter((n) => !info[n]);
        status.unetSeen = unetChoices(info).includes(file);
    }

    try { status.comfyRoot = await comfyui.resolveComfyRoot(); } catch { status.comfyRoot = null; }
    try {
        const modelRoot = await comfyui.resolveModelRoot();
        status.modelRoot = modelRoot;
        const found = modelRoot ? filePresent(path.join(modelRoot, UNET_DEST), file, UNET_MIN_BYTES) : null;
        if (found) {
            status.unetFound = true;
            status.unetPath = found.path;
        }
    } catch { /* unknown */ }

    const unetReady = status.unetFound || status.unetSeen;
    status.ready = Boolean(status.comfyAvailable && unetReady && status.nodesMissing.length === 0);
    // On disk but not yet listed by UNETLoader: ComfyUI needs a refresh/restart.
    status.restartRequired = Boolean(status.unetFound && !status.unetSeen);
    return status;
}

// Stream the Hugging Face checkpoint to disk without buffering it in memory.
// Writes to `<dest>.download` first so an interrupted run never leaves a
// half file behind under the real name.
async function downloadUnet(destPath) {
    logLine('checkpoint: downloading ' + DOWNLOAD_URL + ' ...');
    // Bound only the connection/header phase: AbortSignal.timeout would abort
    // the whole request (including the multi-GB body) on a fixed wall clock,
    // so clear it once headers arrive and let the body stream run to
    // completion. A per-chunk idle watchdog still aborts a stalled transfer.
    const controller = new AbortController();
    let res;
    try {
        const connectTimer = setTimeout(() => controller.abort(), 30 * 1000);
        try {
            res = await fetch(DOWNLOAD_URL, { headers: authHeaders(), signal: controller.signal });
        } finally {
            clearTimeout(connectTimer);
        }
    } catch (err) {
        throw new Error('Could not reach Hugging Face: ' + (err.message || err) + '. Check your network connection.');
    }
    if (res.status === 401 || res.status === 403) {
        throw new Error('Hugging Face denied access (HTTP ' + res.status + '). The FastH3 repo may need its license accepted, or your token is missing/invalid — set one in Settings > Setup.');
    }
    if (!res.ok) {
        throw new Error('Download failed with HTTP ' + res.status + ' for ' + path.basename(destPath) + '. The file may have moved.');
    }
    const total = Number(res.headers.get('content-length')) || 0;
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmpPath = destPath + '.download';
    const out = fs.createWriteStream(tmpPath);
    let received = 0;
    job.received = 0;
    job.total = total;
    // Abort only when the stream stalls (no bytes for a minute), never on a
    // fixed total duration.
    const IDLE_TIMEOUT_MS = 60 * 1000;
    let idleTimer = null;
    const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
    };
    try {
        resetIdle();
        for await (const chunk of res.body) {
            resetIdle();
            const buf = Buffer.from(chunk);
            received += buf.length;
            job.received = received;
            if (!out.write(buf)) {
                await new Promise((resolve) => out.once('drain', resolve));
            }
        }
    } catch (err) {
        try { out.destroy(); } catch { /* ignore */ }
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        const reason = controller.signal.aborted
            ? 'no data received for ' + Math.round(IDLE_TIMEOUT_MS / 1000) + 's'
            : (err.message || err);
        throw new Error('Download interrupted for ' + path.basename(destPath) + ': ' + reason);
    } finally {
        clearTimeout(idleTimer);
    }
    await new Promise((resolve, reject) => {
        out.on('finish', resolve);
        out.on('error', reject);
        out.end();
    });
    let size = 0;
    try { size = fs.statSync(tmpPath).size; } catch { /* ignore */ }
    if (!size || size < UNET_MIN_BYTES) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw new Error('Downloaded checkpoint looks truncated (' + Math.round(size / 1024 / 1024) + ' MB). Deleted — retry the download.');
    }
    fs.renameSync(tmpPath, destPath);
    job.received = size;
    job.total = total || size;
    logLine('checkpoint: saved ' + destPath + ' (' + (size / 1024 / 1024 / 1024).toFixed(2) + ' GB).');
}

async function runInstallJob() {
    job.running = true;
    job.done = false;
    job.ok = false;
    job.error = null;
    job.received = 0;
    job.total = 0;
    job.startedAt = new Date().toISOString();
    job.finishedAt = null;
    try {
        if (!(await comfyui.isAvailable())) {
            throw new Error('ComfyUI is not reachable at ' + comfyui.COMFYUI_URL + '. Start ComfyUI, then retry.');
        }
        const modelRoot = await comfyui.resolveModelRoot();
        if (!modelRoot) {
            throw new Error(
                'Could not locate ComfyUI\'s models/ folder. Set COMFYUI_MODEL_DIR and retry, or download ' + HF_PATH +
                ' from https://huggingface.co/' + HF_REPO + ' manually into models/' + UNET_DEST + '/.'
            );
        }
        logLine('ComfyUI models: ' + modelRoot);
        const file = configuredUnetFile();
        const destPath = path.join(modelRoot, UNET_DEST, file);
        if (filePresent(path.join(modelRoot, UNET_DEST), file, UNET_MIN_BYTES)) {
            logLine('checkpoint: already installed.');
        } else {
            await downloadUnet(destPath);
        }
        job.ok = true;
        logLine('Done. ComfyUI usually picks new models up automatically; restart it if FastH3 is still missing.');
    } catch (err) {
        job.ok = false;
        job.error = err.message || String(err);
        logLine('FAILED: ' + job.error);
    } finally {
        job.running = false;
        job.done = true;
        job.finishedAt = new Date().toISOString();
    }
}

function startInstall() {
    if (job.running) return { started: false, reason: 'already running', job: jobState() };
    job.log = [];
    setImmediate(() => { runInstallJob().catch(() => {}); });
    return { started: true, job: jobState() };
}

// Fire-and-forget first-enable install: starts the background download unless
// one is running or a previous run already succeeded. Never throws.
function ensureAutoInstall() {
    try {
        if (job.running || (job.done && job.ok)) return jobState();
        job.autoStarted = true;
        startInstall();
    } catch { /* install is best-effort */ }
    return jobState();
}

module.exports = {
    HF_REPO,
    HF_PATH,
    UNET_FILE,
    UNET_DEST,
    UNET_MIN_BYTES,
    DOWNLOAD_URL,
    REQUIRED_NODES,
    getStatus,
    startInstall,
    ensureAutoInstall,
    jobState
};
