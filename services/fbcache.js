/* ============================================
   JARVIS — MiniMax H3 First Block Cache Installer + Status
   Optional MODEL patch for MiniMax H3 video:
   (https://github.com/duckyshell/ComfyUI-MiniMaxH3-FirstBlockCache).

   This module checks whether the ComfyUI side is ready (the custom node is
   loaded) and, on first enable, git-clones the node pack when it is missing.
   The pack has no Python packages or model downloads, so cloning it into
   ComfyUI/custom_nodes is the entire install. ComfyUI itself cannot be
   restarted from here, so a successful install reports restartRequired until
   the node shows up in /object_info.

   Mirrors services/face-refine.js: a single-flight background job, a status
   endpoint the VIDEO panel polls, and a fire-and-forget first-enable install.

   Zero npm dependencies: only node builtins (fs/path/child_process) plus the
   ComfyUI HTTP client.
   SPDX-License-Identifier: MIT
   ============================================ */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const comfyui = require('./comfyui');

const FBCACHE_REPO = 'https://github.com/duckyshell/ComfyUI-MiniMaxH3-FirstBlockCache.git';
const FBCACHE_DIR = 'ComfyUI-MiniMaxH3-FirstBlockCache';
const FBCACHE_NODE = 'ApplyMiniMaxH3FirstBlockCache';

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
    console.log('[fbcache] ' + line);
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

async function getStatus() {
    const status = {
        comfyAvailable: false,
        comfyRoot: null,
        packInstalled: false,
        nodePresent: false,
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
    status.nodePresent = Boolean(info && info[FBCACHE_NODE]);

    try {
        status.comfyRoot = await comfyui.resolveComfyRoot();
    } catch { status.comfyRoot = null; }
    if (status.comfyRoot) {
        status.packInstalled = fs.existsSync(path.join(customNodesDir(status.comfyRoot), FBCACHE_DIR));
    }

    status.ready = Boolean(status.comfyAvailable && status.nodePresent);
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
                'Install manually: git clone ' + FBCACHE_REPO + ' into ComfyUI/custom_nodes/, then restart ComfyUI.'
            );
        }
        logLine('ComfyUI root: ' + comfyRoot);
        const nodesDir = customNodesDir(comfyRoot);
        fs.mkdirSync(nodesDir, { recursive: true });

        const gitCheck = runCommand('git', ['--version'], { timeoutMs: 30000 });
        if (!gitCheck.ok) {
            throw new Error(
                'git is not installed or not on PATH. Install manually: git clone ' + FBCACHE_REPO +
                ' into ' + nodesDir + ', then restart ComfyUI.'
            );
        }

        const packDir = path.join(nodesDir, FBCACHE_DIR);
        if (!gitCloneOrPull(packDir, FBCACHE_REPO, 'FirstBlockCache pack')) {
            throw new Error('Could not clone ' + FBCACHE_REPO + '. Check the log above and your network connection.');
        }

        job.ok = true;
        logLine('Done. RESTART ComfyUI so the new node loads, then generate a video.');
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
    FBCACHE_REPO,
    FBCACHE_DIR,
    FBCACHE_NODE,
    getStatus,
    startInstall,
    ensureAutoInstall,
    jobState
};
