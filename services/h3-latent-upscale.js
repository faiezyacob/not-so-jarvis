/* ============================================
   JARVIS — MiniMax H3 Latent Upscaler status + installer
   Learned 24-channel H3 latent upscaler
   (https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler,
   https://huggingface.co/LBH-123-AI/Minimax_h3_latent_Upscaler).

   An optional three-stage H3 video pipeline: generate a low-resolution AV
   latent, upscale the 24-channel video latent with the learned 3D upscaler,
   then re-sample (refine) at the target resolution before the single VAE
   decode. It saves TIME, not VRAM.

   This module checks whether the ComfyUI side is ready (the custom node is
   loaded and at least one checkpoint is installed) and, on first enable,
   git-clones the node pack when missing. The checkpoint is NOT auto-downloaded
   (it is ~691 MB and gated behind an explicit model download), so it is
   surfaced through the existing Setup > Models catalog instead; the status
   reports the expected name/folder/size/link when it is absent.

   Mirrors services/fbcache.js: a single-flight background job, a status
   endpoint the VIDEO panel polls, and a fire-and-forget first-enable install.

   Zero npm dependencies: only node builtins (fs/path/child_process) plus the
   ComfyUI HTTP client.
   SPDX-License-Identifier: MIT
   ============================================ */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const comfyui = require('./comfyui');
const modelSetup = require('./model-setup');

const REPO = 'https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler.git';
const DIR = 'Comfyui_Minimax_h3_latent_Upscaler';
const NODE = 'MinimaxH3LatentUpscaler3D';
const SEPARATE_NODE = 'LTXVSeparateAVLatent';
const CONCAT_NODE = 'LTXVConcatAVLatent';
const MODEL_DIR = 'latent_upscale_models';
const MODEL_REPO = 'LBH-123-AI/Minimax_h3_latent_Upscaler';
const MODEL_DEFAULT = 'minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors';
const MODEL_APPROX_MB = 691;
const MODEL_URL = 'https://huggingface.co/' + MODEL_REPO;

// Background install job (single-flight). Never persisted; the status endpoint
// reports it so the settings UI can poll.
const job = {
    running: false,
    done: false,
    ok: false,
    error: null,
    warn: null,
    log: [],
    startedAt: null,
    finishedAt: null,
    autoStarted: false
};

function logLine(text) {
    const line = String(text || '');
    job.log.push(line);
    if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
    console.log('[h3-latent-upscale] ' + line);
}

function jobState() {
    return {
        running: job.running,
        done: job.done,
        ok: job.ok,
        error: job.error,
        warn: job.warn,
        log: job.log.slice(-40),
        startedAt: job.startedAt,
        finishedAt: job.finishedAt
    };
}

function customNodesDir(comfyRoot) {
    return path.join(comfyRoot, 'custom_nodes');
}

function runCommand(exe, args, opts = {}) {
    const res = spawnSync(exe, args, {
        encoding: 'utf8',
        timeout: Number(opts.timeoutMs) || 10 * 60 * 1000,
        cwd: opts.cwd || undefined,
        shell: false
    });
    return {
        ok: res.status === 0,
        status: res.status,
        stdout: String(res.stdout || '').slice(-2000),
        stderr: String(res.stderr || '').slice(-2000),
        error: res.error ? String(res.error.message || res.error) : null
    };
}

// Filenames ComfyUI reports in the upscaler node's `model_name` dropdown.
function modelChoices(info) {
    const node = info && info[NODE];
    const entry = node && node.input && node.input.required && node.input.required.model_name;
    let options = [];
    if (Array.isArray(entry)) {
        if (Array.isArray(entry[0])) options = entry[0];
        else if (entry[1] && Array.isArray(entry[1].options)) options = entry[1].options;
    }
    return options
        .map((name) => String(name || '').trim())
        .filter((name) => /\.(safetensors|pth|pt|ckpt)$/i.test(name));
}

async function getStatus() {
    const status = {
        comfyAvailable: false,
        comfyRoot: null,
        modelRoot: null,
        packInstalled: false,
        nodePresent: false,
        splitNodePresent: false,
        concatNodePresent: false,
        modelPresent: false,
        modelChoices: [],
        expectedModel: MODEL_DEFAULT,
        modelDir: MODEL_DIR,
        modelApproxMB: MODEL_APPROX_MB,
        modelUrl: MODEL_URL,
        repo: REPO,
        ready: false,
        restartRequired: false,
        job: jobState()
    };
    if (!(await comfyui.isAvailable())) return status;
    status.comfyAvailable = true;

    let info = null;
    try {
        info = await comfyui.getObjectInfo(30000);
    } catch { info = null; }
    status.nodePresent = Boolean(info && info[NODE]);
    status.splitNodePresent = Boolean(info && info[SEPARATE_NODE]);
    status.concatNodePresent = Boolean(info && info[CONCAT_NODE]);
    status.modelChoices = modelChoices(info);

    try {
        status.comfyRoot = await comfyui.resolveComfyRoot();
    } catch { status.comfyRoot = null; }
    if (status.comfyRoot) {
        status.packInstalled = fs.existsSync(path.join(customNodesDir(status.comfyRoot), DIR));
    }
    try { status.modelRoot = await comfyui.resolveModelRoot(); } catch { status.modelRoot = null; }

    // A checkpoint on disk counts even before ComfyUI is restarted (the node's
    // dropdown only refreshes after a restart, but the file is already there).
    status.modelOnDisk = false;
    if (status.modelRoot) {
        try {
            const files = fs.readdirSync(path.join(status.modelRoot, MODEL_DIR))
                .filter((f) => /\.(safetensors|pth|pt|ckpt)$/i.test(f));
            status.modelOnDisk = files.length > 0;
        } catch { status.modelOnDisk = false; }
    }
    status.modelPresent = status.modelOnDisk || status.modelChoices.length > 0;

    status.ready = Boolean(
        status.comfyAvailable && status.nodePresent &&
        status.splitNodePresent && status.concatNodePresent && status.modelPresent
    );
    // Pack on disk but node not loaded yet: ComfyUI needs a restart.
    status.restartRequired = Boolean(status.packInstalled && !status.nodePresent);
    return status;
}

function gitCloneOrPull(dir, repoUrl, label) {
    if (fs.existsSync(path.join(dir, '.git'))) {
        logLine(label + ': already cloned, pulling latest...');
        const pulled = runCommand('git', ['-C', dir, 'pull', '--ff-only'], { timeoutMs: 120000 });
        logLine(label + ': pull ' + (pulled.ok ? 'ok' : 'skipped (' + (pulled.stderr || pulled.error || 'failed') + ')'));
        return true;
    }
    logLine(label + ': cloning ' + repoUrl + ' ...');
    const cloned = runCommand('git', ['clone', '--depth', '1', repoUrl, dir], { timeoutMs: 10 * 60 * 1000 });
    if (!cloned.ok) {
        logLine(label + ': clone FAILED: ' + (cloned.stderr || cloned.error || 'unknown error'));
        return false;
    }
    logLine(label + ': cloned.');
    return true;
}

async function runInstallJob() {
    job.running = true;
    job.done = false;
    job.ok = false;
    job.error = null;
    job.warn = null;
    job.startedAt = new Date().toISOString();
    job.finishedAt = null;
    try {
        if (!(await comfyui.isAvailable())) {
            throw new Error('ComfyUI is not reachable at ' + comfyui.COMFYUI_URL + '. Start ComfyUI, then retry.');
        }
        const comfyRoot = await comfyui.resolveComfyRoot();
        if (!comfyRoot) {
            throw new Error(
                'Could not locate the ComfyUI install folder (is ComfyUI running on this machine?). ' +
                'Install manually: git clone ' + REPO + ' into ComfyUI/custom_nodes/, then restart ComfyUI.'
            );
        }
        logLine('ComfyUI root: ' + comfyRoot);
        const nodesDir = customNodesDir(comfyRoot);
        fs.mkdirSync(nodesDir, { recursive: true });

        const gitCheck = runCommand('git', ['--version'], { timeoutMs: 30000 });
        if (!gitCheck.ok) {
            throw new Error(
                'git is not installed or not on PATH. Install manually: git clone ' + REPO +
                ' into ' + nodesDir + ', then restart ComfyUI.'
            );
        }

        const packDir = path.join(nodesDir, DIR);
        if (!gitCloneOrPull(packDir, REPO, 'H3 Latent Upscaler pack')) {
            throw new Error('Could not clone ' + REPO + '. Check the log above and your network connection.');
        }

        // Also fetch the ~691 MB checkpoint through the shared Setup downloader
        // (it knows the verified Hugging Face repo/path and streams to disk).
        // The node pack clone alone is not enough to run the pipeline.
        const modelMissing = !(await modelPresentOnDisk());
        if (modelMissing) {
            logLine('Downloading the upscaler checkpoint via Setup (~' + MODEL_APPROX_MB + ' MB)...');
            const started = modelSetup.startDownload(['h3_latent_upscaler']);
            if (!started || started.started === false) {
                job.warn = 'Node pack installed, but the checkpoint download could not start (' +
                    ((started && started.reason) || 'unknown') + '). Download it from Setup > Models, then restart ComfyUI.';
                logLine('WARNING: ' + job.warn);
            } else {
                await waitForModelDownload();
            }
        } else {
            logLine('Upscaler checkpoint already present.');
        }

        job.ok = true;
        if (job.warn) {
            logLine('Node pack installed. RESTART ComfyUI, then check the status again.');
        } else {
            logLine('Node pack and checkpoint installed. RESTART ComfyUI so the node loads.');
        }
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

// Poll the shared Setup download job until it stops running. Bounded so a
// stalled download cannot hang the install forever.
async function waitForModelDownload(timeoutMs = 30 * 60 * 1000) {
    const startedAt = Date.now();
    let lastReceived = -1;
    while (Date.now() - startedAt < timeoutMs) {
        const state = modelSetup.jobState();
        if (!state.running) {
            if (state.error) {
                job.warn = 'Node pack installed, but the checkpoint download failed: ' + state.error +
                    ' Download it from Setup > Models, then restart ComfyUI.';
                logLine('WARNING: ' + job.warn);
            } else {
                logLine('Checkpoint download finished.');
            }
            return;
        }
        const current = state.current;
        if (current && Number.isFinite(current.received) && current.received !== lastReceived) {
            lastReceived = current.received;
            const mb = current.total
                ? Math.round((current.received / current.total) * 100) + '%'
                : Math.round(current.received / 1024 / 1024) + ' MB';
            logLine('Downloading checkpoint: ' + mb);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    job.warn = 'Node pack installed, but the checkpoint download is still running after 30 minutes. ' +
        'Check Setup > Models, then restart ComfyUI.';
    logLine('WARNING: ' + job.warn);
}

// True when a checkpoint is already installed on disk (or ComfyUI reports one).
async function modelPresentOnDisk() {
    try {
        const modelRoot = await comfyui.resolveModelRoot();
        if (modelRoot) {
            const dirs = [path.join(modelRoot, MODEL_DIR)];
            for (const dir of dirs) {
                try {
                    const files = fs.readdirSync(dir).filter((f) => /\.(safetensors|pth|pt|ckpt)$/i.test(f));
                    if (files.length) return true;
                } catch { /* folder may not exist yet */ }
            }
        }
    } catch { /* fall through to the ComfyUI signal */ }
    try {
        const info = await comfyui.getObjectInfo(15000);
        return modelChoices(info).length > 0;
    } catch {
        return false;
    }
}

function startInstall() {
    if (job.running) return { started: false, reason: 'already running', job: jobState() };
    setImmediate(() => { runInstallJob().catch(() => {}); });
    return { started: true, job: jobState() };
}

// Fire-and-forget first-enable install: starts the background job unless one
// is running or a previous run already succeeded. Never throws.
function ensureAutoInstall() {
    try {
        if (job.running || (job.done && job.ok && !job.warn)) return jobState();
        job.autoStarted = true;
        startInstall();
    } catch { /* install is best-effort */ }
    return jobState();
}

module.exports = {
    REPO,
    DIR,
    NODE,
    SEPARATE_NODE,
    CONCAT_NODE,
    MODEL_DIR,
    MODEL_DEFAULT,
    MODEL_REPO,
    MODEL_APPROX_MB,
    MODEL_URL,
    getStatus,
    startInstall,
    ensureAutoInstall,
    jobState,
    modelChoices
};
