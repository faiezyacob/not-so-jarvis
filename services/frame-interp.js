/* ============================================
   JARVIS — Frame Interpolation Installer + Status
   Optional post-process for MiniMax H3 video: raises a clip's frame rate by
   synthesising intermediate frames with the ComfyUI-Frame-Interpolation node
   pack's `RIFE VFI` node
   (https://github.com/Fannovel16/ComfyUI-Frame-Interpolation).

   This module checks whether the ComfyUI side is ready (the custom node is
   loaded) and, on first enable, git-clones the node pack into
   ComfyUI/custom_nodes and runs the pack's own install.py so its runtime
   dependencies (einops/opencv/kornia/scipy + the cupy or taichi ops backend)
   are present. The RIFE checkpoint downloads on first use. ComfyUI itself
   cannot be restarted from here, so a successful install reports
   restartRequired until the node shows up in /object_info.

   Mirrors services/face-refine.js and services/fbcache.js: a single-flight
   background job, a status endpoint the VIDEO panel polls, and a fire-and-
   forget first-enable install.

   Zero npm dependencies: only node builtins (fs/path/child_process) plus the
   ComfyUI HTTP client.
   SPDX-License-Identifier: MIT
   ============================================ */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const comfyui = require('./comfyui');

const FRAMEINTERP_REPO = 'https://github.com/Fannovel16/ComfyUI-Frame-Interpolation.git';
const FRAMEINTERP_DIR = 'ComfyUI-Frame-Interpolation';
const FRAMEINTERP_NODE = 'RIFE VFI';
// The pack reads config.yaml `ops_backend` (cupy by default) and its stmfnet
// module imports vfi_models.ops at import time, so the pack will not register
// `RIFE VFI` unless those ops deps import. The pack ships an install.py that
// pip-installs requirements-no-cupy.txt (einops/opencv/kornia/scipy/...) and
// then the matching cupy build; running it is the upstream-supported path.
// The explicit list is the fallback when install.py is missing.
const FRAMEINTERP_INSTALL_SCRIPT = 'install.py';
const PIP_PACKAGES = ['einops', 'opencv-contrib-python', 'kornia', 'scipy', 'tqdm'];
// Bare import names for the readiness probe. cupy/taichi are intentionally not
// part of this list: the node's presence in /object_info already proves the
// pack imported, and a manual taichi setup should not be reported as broken.
const PIP_MODULES = ['einops', 'cv2', 'kornia'];
// The node pack downloads its checkpoint lazily on first render; report where
// it lands so the UI can tell the user it is not pre-fetched.
const CKPT_SUBDIR = path.join('ckpts', 'rife');

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
    console.log('[frame-interp] ' + line);
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

// Ordered python candidates for the ComfyUI environment. The runtime venv
// ComfyUI actually executes from comes first (<comfyRoot>/.venv, used by
// ComfyUI Desktop and most manual installs); the Desktop launcher's base env
// (<install>/standalone-env) is only a fallback.
function pythonCandidates(comfyRoot) {
    const candidates = [];
    const add = (p) => { if (p && !candidates.includes(p)) candidates.push(p); };
    const win = process.platform === 'win32';
    const root = comfyRoot ? path.resolve(String(comfyRoot)) : null;
    const parent = root ? path.dirname(root) : null;
    if (root) {
        add(win ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python3'));
        if (!win) add(path.join(root, '.venv', 'bin', 'python'));
        add(win ? path.join(root, 'python_embeded', 'python.exe') : path.join(root, 'python_embeded', 'bin', 'python3'));
    }
    if (parent) {
        add(win ? path.join(parent, 'standalone-env', 'python.exe') : path.join(parent, 'standalone-env', 'bin', 'python'));
        add(win ? path.join(parent, 'standalone-env', 'Scripts', 'python.exe') : path.join(parent, 'standalone-env', 'bin', 'python3'));
        add(win ? path.join(parent, 'python_embeded', 'python.exe') : path.join(parent, 'python_embeded', 'bin', 'python3'));
    }
    return candidates;
}

async function detectPythonExe(comfyRoot, opts = {}) {
    const candidates = pythonCandidates(comfyRoot);
    let argv = [];
    try {
        const stats = await comfyui.getSystemStats();
        argv = (stats && stats.system && stats.system.argv) || [];
    } catch { argv = []; }
    if (argv.length && /python/i.test(String(argv[0] || ''))) {
        candidates.push(String(argv[0]));
    }
    candidates.push('python', 'py');
    for (const exe of candidates) {
        if (!exe) continue;
        if (path.isAbsolute(exe) && !fs.existsSync(exe)) continue;
        const args = path.basename(String(exe)).toLowerCase() === 'py' ? ['-3', '--version'] : ['--version'];
        try {
            const res = runCommand(exe, args, { timeoutMs: 30000 });
            if (res.ok) {
                if (!opts.quiet) {
                    logLine('python: using ' + exe + ' (' + (res.stdout || res.stderr || '').trim().split('\n')[0] + ')');
                }
                return path.basename(String(exe)).toLowerCase() === 'py'
                    ? { exe, prefix: ['-3'] }
                    : { exe, prefix: [] };
            }
        } catch { /* try next */ }
    }
    return null;
}

// Cached runtime-python lookup for the status endpoint (getStatus polls).
let pythonCache = { root: null, at: 0, exe: null };

async function detectPythonExeCached(comfyRoot) {
    const now = Date.now();
    if (pythonCache.root === comfyRoot && (now - pythonCache.at) < 60000) return pythonCache.exe;
    const exe = await detectPythonExe(comfyRoot, { quiet: true });
    pythonCache = { root: comfyRoot, at: now, exe };
    return exe;
}

// Which packages are missing from the given python. importlib does not import
// the modules, so this is cheap; results are cached briefly.
let packagesCache = { key: null, at: 0, missing: null };

function checkPythonPackages(py, comfyRoot) {
    if (!py) return null;
    const key = py.exe + ' ' + (py.prefix || []).join(' ');
    const now = Date.now();
    if (packagesCache.key === key && (now - packagesCache.at) < 30000) return packagesCache.missing;
    const code = 'import importlib.util as u, json; print(json.dumps([m for m in ' +
        JSON.stringify(PIP_MODULES) + ' if u.find_spec(m) is None]))';
    let missing = [];
    try {
        const res = runCommand(py.exe, (py.prefix || []).concat(['-c', code]), {
            timeoutMs: 120000,
            cwd: comfyRoot || undefined
        });
        if (res.ok) {
            const parsed = JSON.parse(String(res.stdout || '').trim().split('\n').pop());
            if (Array.isArray(parsed)) missing = parsed.map(String);
        }
    } catch { missing = []; }
    packagesCache = { key, at: now, missing };
    return missing;
}

function findRifeCheckpoint(comfyRoot, name) {
    if (!comfyRoot) return null;
    const dir = path.join(comfyRoot, 'custom_nodes', FRAMEINTERP_DIR, CKPT_SUBDIR);
    const wanted = path.basename(String(name || 'rife49.pth'));
    for (const file of [wanted, 'rife49.pth', 'rife47.pth']) {
        const candidate = path.join(dir, file);
        try {
            const st = fs.statSync(candidate);
            if (st.isFile() && st.size > 1024 * 1024) return candidate;
        } catch { /* missing */ }
    }
    return null;
}

async function getStatus() {
    const status = {
        comfyAvailable: false,
        comfyRoot: null,
        packInstalled: false,
        nodePresent: false,
        vhsPresent: false,
        ckptFound: false,
        ckptPath: null,
        pythonExe: null,
        packagesMissing: [],
        depsReady: true,
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
    if (info) {
        status.nodePresent = Boolean(info[FRAMEINTERP_NODE]);
        status.vhsPresent = Boolean(info.VHS_LoadVideo);
    }

    try {
        status.comfyRoot = await comfyui.resolveComfyRoot();
    } catch { status.comfyRoot = null; }
    if (status.comfyRoot) {
        status.packInstalled = fs.existsSync(path.join(customNodesDir(status.comfyRoot), FRAMEINTERP_DIR));
        const found = findRifeCheckpoint(status.comfyRoot, 'rife49.pth');
        if (found) {
            status.ckptFound = true;
            status.ckptPath = found;
        }
    }

    // The node imports einops at load time. Check ComfyUI's actual python so
    // status does not claim ready when it is not; only treat the result as
    // authoritative when the interpreter lives inside the ComfyUI tree.
    if (status.comfyRoot) {
        try {
            const py = await detectPythonExeCached(status.comfyRoot);
            status.pythonExe = py ? py.exe : null;
            const runtimeRoot = path.resolve(String(status.comfyRoot)) + path.sep;
            const authoritative = Boolean(py && path.resolve(py.exe).startsWith(runtimeRoot));
            if (authoritative) {
                const missing = checkPythonPackages(py, status.comfyRoot);
                status.packagesMissing = Array.isArray(missing) ? missing : [];
                status.depsReady = status.packagesMissing.length === 0;
            }
        } catch {
            status.pythonExe = null;
            status.packagesMissing = [];
        }
    }

    status.ready = Boolean(status.comfyAvailable && status.nodePresent && status.depsReady);
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
    // A directory that already exists (e.g. installed by ComfyUI Manager or a
    // manual copy) but has no .git is left untouched: it is already present, so
    // there is nothing to clone. Only an absent/empty directory is cloned.
    if (fs.existsSync(dir)) {
        let entries = [];
        try { entries = fs.readdirSync(dir); } catch { entries = []; }
        if (entries.length) {
            logLine(label + ': folder already exists at ' + dir + ' — skipping clone (assuming installed).');
            return true;
        }
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
                'Install manually: git clone ' + FRAMEINTERP_REPO + ' into ComfyUI/custom_nodes/, ' +
                'pip install ' + PIP_PACKAGES.join(' ') + ', then restart ComfyUI.'
            );
        }
        logLine('ComfyUI root: ' + comfyRoot);
        const nodesDir = customNodesDir(comfyRoot);
        fs.mkdirSync(nodesDir, { recursive: true });

        const gitCheck = runCommand('git', ['--version'], { timeoutMs: 30000 });
        if (!gitCheck.ok) {
            throw new Error(
                'git is not installed or not on PATH. Install manually: git clone ' + FRAMEINTERP_REPO +
                ' into ' + nodesDir + ', pip install ' + PIP_PACKAGES.join(' ') + ', then restart ComfyUI.'
            );
        }

        const packDir = path.join(nodesDir, FRAMEINTERP_DIR);
        if (!gitCloneOrPull(packDir, FRAMEINTERP_REPO, 'Frame-Interpolation pack')) {
            throw new Error('Could not clone ' + FRAMEINTERP_REPO + '. Check the log above and your network connection.');
        }

        const py = await detectPythonExe(comfyRoot);
        const installScript = path.join(packDir, FRAMEINTERP_INSTALL_SCRIPT);
        if (!py) {
            job.warn = 'python not found — install Frame-Interpolation dependencies manually in ComfyUI\'s python: ' +
                PIP_PACKAGES.join(' ') + ' (plus cupy / taichi).';
            logLine('python: not found — ' + job.warn);
        } else if (fs.existsSync(installScript)) {
            // Run the pack's own installer: it pip-installs the declared
            // requirements (without upgrading already-satisfied packages) and
            // selects the matching cupy build, which the pack's ops module
            // needs at import time.
            logLine('running ' + FRAMEINTERP_INSTALL_SCRIPT + ' with ' + py.exe + ' (may take several minutes)...');
            const res = runCommand(py.exe, py.prefix.concat([FRAMEINTERP_INSTALL_SCRIPT]), {
                timeoutMs: 30 * 60 * 1000,
                cwd: packDir
            });
            if (res.ok) {
                logLine('install.py: ok');
            } else {
                job.warn = 'Frame-Interpolation install.py reported an error — install dependencies manually: ' +
                    PIP_PACKAGES.join(' ') + ' (plus cupy / taichi).';
                logLine('install.py: FAILED — ' + job.warn);
                if (res.stderr) logLine('install.py stderr: ' + res.stderr.slice(-500));
            }
        } else {
            logLine('install.py not found — pip installing ' + PIP_PACKAGES.join(', ') + '...');
            const pip = runCommand(py.exe, py.prefix.concat(['-m', 'pip', 'install', '--disable-pip-version-check'].concat(PIP_PACKAGES)), { timeoutMs: 30 * 60 * 1000 });
            if (pip.ok) {
                logLine('pip: ok (remember to install cupy or taichi for the pack ops)');
            } else {
                job.warn = 'pip install failed in ComfyUI\'s python — run manually: pip install ' + PIP_PACKAGES.join(' ');
                logLine('pip: FAILED — ' + job.warn);
                if (pip.stderr) logLine('pip stderr: ' + pip.stderr.slice(-500));
            }
        }

        job.ok = true;
        logLine('Done. RESTART ComfyUI so the new node loads. The RIFE checkpoint downloads on first use.');
    } catch (err) {
        job.ok = false;
        job.error = err.message || String(err);
        logLine('FAILED: ' + job.error);
    } finally {
        job.running = false;
        job.done = true;
        job.finishedAt = new Date().toISOString();
        // Re-probe the environment on the next status call.
        pythonCache.at = 0;
        packagesCache.at = 0;
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
    FRAMEINTERP_REPO,
    FRAMEINTERP_DIR,
    FRAMEINTERP_NODE,
    PIP_PACKAGES,
    getStatus,
    startInstall,
    ensureAutoInstall,
    jobState
};
