/* ============================================
   JARVIS — ComfyUI Launcher
   Starts a local ComfyUI server as a detached
   background process and waits for its HTTP API
   to come up. Supports ComfyUI Desktop (standalone
   installs) and portable / venv layouts. An
   explicit COMFYUI_START_CMD (or the value saved
   in data/config.json) always wins.
   ============================================ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const comfyui = require('./comfyui');
const configManager = require('../server/config-manager');

// How long to wait for ComfyUI's API after spawning before giving up. Large
// models/custom nodes can make boot slow, so allow a generous window.
const START_TIMEOUT_MS = Number(process.env.COMFYUI_START_TIMEOUT_MS) || 180000;
const POLL_INTERVAL_MS = 3000;
const LOG_PATH = path.join(__dirname, '..', 'data', 'comfyui-start.log');

// De-dupes concurrent start requests (widget button + chat message) so only
// one process is spawned and everyone awaits the same boot.
let startPromise = null;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitArgs(str) {
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(String(str || '')))) {
        out.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
    }
    return out;
}

// Locate an executable on PATH (used as a last-resort python).
function which(name) {
    const dirs = String(process.env.PATH || '').split(path.delimiter);
    const exts = process.platform === 'win32'
        ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
        : [''];
    for (const dir of dirs) {
        if (!dir) continue;
        for (const ext of exts) {
            const candidate = path.join(dir, name + ext);
            try {
                if (fs.existsSync(candidate)) return candidate;
            } catch {}
        }
    }
    return null;
}

function venvPython(dir) {
    const bins = process.platform === 'win32'
        ? [path.join(dir, '.venv', 'Scripts', 'python.exe')]
        : [path.join(dir, '.venv', 'bin', 'python3'), path.join(dir, '.venv', 'bin', 'python')];
    for (const bin of bins) {
        if (fs.existsSync(bin)) return bin;
    }
    return null;
}

// ComfyUI Desktop keeps its config under the Electron userData folder.
function desktopSettingsDir() {
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, 'Comfy Desktop');
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'Comfy Desktop');
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Comfy Desktop');
}

function readJsonFile(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return null;
    }
}

// Build a launch plan from a ComfyUI Desktop installation. The Desktop app
// runs its standalone environment with the install's venv python; we mirror
// that command so the server boots headless (no Electron window).
function desktopPlan() {
    const dir = desktopSettingsDir();
    const installations = readJsonFile(path.join(dir, 'installations.json'));
    if (!Array.isArray(installations)) return null;

    const local = installations.filter((i) => i && i.installPath && i.sourceId !== 'cloud' && i.status === 'installed');
    if (!local.length) return null;

    const session = readJsonFile(path.join(dir, 'last-session.json'));
    let chosen = session && session.installationId
        ? local.find((i) => i.id === session.installationId)
        : null;
    chosen = chosen || local[0];

    const repoDir = path.join(chosen.installPath, 'ComfyUI');
    const mainPy = path.join(repoDir, 'main.py');
    if (!fs.existsSync(mainPy)) return null;
    const python = venvPython(repoDir);
    if (!python) return null;

    const args = ['-s', mainPy];
    if (chosen.launchArgs) args.push(...splitArgs(chosen.launchArgs));
    // The Desktop app also sets a feature flag; harmless to include.
    args.push('--feature-flag', 'show_signin_button=true');

    const yaml = path.join(dir, 'instance-model-paths', chosen.id + '.yaml');
    if (fs.existsSync(yaml)) args.push('--extra-model-paths-config', yaml);

    const settings = readJsonFile(path.join(dir, 'settings.json')) || {};
    if (settings.inputDir && fs.existsSync(settings.inputDir)) args.push('--input-directory', settings.inputDir);
    if (settings.outputDir && fs.existsSync(settings.outputDir)) args.push('--output-directory', settings.outputDir);

    return { method: 'desktop', command: python, args, cwd: repoDir, label: 'ComfyUI Desktop' };
}

function findPortablePython(root) {
    const parent = path.dirname(root);
    const candidates = process.platform === 'win32'
        ? [
            path.join(root, '.venv', 'Scripts', 'python.exe'),
            path.join(parent, '.venv', 'Scripts', 'python.exe'),
            path.join(parent, 'python_embeded', 'python.exe'),
            path.join(root, 'python_embeded', 'python.exe')
        ]
        : [
            path.join(root, '.venv', 'bin', 'python3'),
            path.join(root, '.venv', 'bin', 'python'),
            path.join(parent, 'python_embeded', 'bin', 'python3')
        ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return which(process.platform === 'win32' ? 'python' : 'python3');
}

async function resolveRoot() {
    if (process.env.COMFYUI_ROOT) {
        const override = path.resolve(process.env.COMFYUI_ROOT);
        if (fs.existsSync(path.join(override, 'main.py'))) return override;
    }
    const stored = configManager.getComfyUI();
    if (stored.root) {
        const root = path.resolve(stored.root);
        if (fs.existsSync(path.join(root, 'main.py'))) return root;
    }
    try {
        const detected = await comfyui.resolveComfyRoot();
        if (detected) {
            // Cache it so a later launch works while ComfyUI is offline.
            try { configManager.setComfyUI({ root: detected }); } catch {}
            return detected;
        }
    } catch {}
    return null;
}

async function portablePlan() {
    const root = await resolveRoot();
    if (!root) return null;

    const parent = path.dirname(root);
    for (const bat of ['run_nvidia_gpu.bat', 'run_cpu.bat']) {
        for (const dir of [parent, root]) {
            const script = path.join(dir, bat);
            if (!fs.existsSync(script)) continue;
            const plan = process.platform === 'win32'
                ? { method: 'portable', command: 'cmd.exe', args: ['/c', script], cwd: dir, label: 'Portable launcher' }
                : { method: 'portable', command: script, args: [], cwd: dir, label: 'Portable launcher' };
            return plan;
        }
    }

    const mainPy = path.join(root, 'main.py');
    const python = findPortablePython(root);
    if (!python) return null;
    return { method: 'portable', command: python, args: ['main.py'], cwd: root, label: 'Portable (python)' };
}

function overridePlan() {
    const stored = configManager.getComfyUI();
    const command = String(process.env.COMFYUI_START_CMD || stored.startCommand || '').trim();
    if (!command) return null;
    if (process.platform === 'win32') {
        return { method: 'override', command: 'cmd.exe', args: ['/c', command], cwd: __dirname, label: 'custom command' };
    }
    return { method: 'override', command: '/bin/sh', args: ['-c', command], cwd: __dirname, label: 'custom command' };
}

// Resolution order: explicit override, then ComfyUI Desktop, then portable.
async function planLaunch() {
    return overridePlan() || desktopPlan() || await portablePlan();
}

async function waitForAvailable(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            if (await comfyui.isAvailable()) return true;
        } catch {}
        await delay(POLL_INTERVAL_MS);
    }
    return false;
}

let spawnError = null;

function spawnComfy(plan) {
    const logFd = fs.openSync(LOG_PATH, 'a');
    fs.writeSync(logFd, '\n[' + new Date().toISOString() + '] start (' + plan.label + '): ' +
        plan.command + ' ' + plan.args.join(' ') + '\n');
    let child;
    try {
        child = spawn(plan.command, plan.args, {
            cwd: plan.cwd,
            detached: true,
            stdio: ['ignore', logFd, logFd],
            windowsHide: true
        });
    } finally {
        try { fs.closeSync(logFd); } catch {}
    }
    spawnError = null;
    child.once('error', (err) => { spawnError = err; });
    child.unref();
    return child;
}

async function runStart() {
    const plan = await planLaunch();
    if (!plan) {
        const err = new Error('I could not find a way to start ComfyUI automatically. Set COMFYUI_START_CMD (or COMFYUI_ROOT) and try again.');
        err.code = 'comfyui_start_unconfigured';
        throw err;
    }

    spawnComfy(plan);
    // Give the OS a beat to surface a synchronous spawn failure (ENOENT etc.).
    await delay(500);
    if (spawnError) {
        const err = new Error('Could not launch ComfyUI (' + plan.label + '): ' + spawnError.message);
        err.code = 'comfyui_start_failed';
        throw err;
    }

    const ok = await waitForAvailable(START_TIMEOUT_MS);
    if (!ok) {
        const err = new Error('ComfyUI was launched (' + plan.label + ') but did not come online at ' +
            comfyui.COMFYUI_URL + ' within ' + Math.round(START_TIMEOUT_MS / 1000) + 's. Check ' + LOG_PATH + '.');
        err.code = 'comfyui_start_timeout';
        throw err;
    }
    return { available: true, started: true, method: plan.method, label: plan.label };
}

// Idempotent: if ComfyUI is already reachable nothing is spawned; concurrent
// callers share one boot attempt.
async function start() {
    if (await comfyui.isAvailable()) {
        return { available: true, alreadyRunning: true, started: false };
    }
    if (startPromise) return startPromise;
    startPromise = runStart().finally(() => { startPromise = null; });
    return startPromise;
}

// Whether a launch is currently possible (used by the widget to decide
// whether to show the Start button) plus the detected method. Plan detection
// touches the disk, so the result is cached briefly while ComfyUI is offline
// (the widget polls status every second).
let planCache = null;
let planCacheAt = 0;
const PLAN_CACHE_MS = 15000;

async function detectPlan() {
    if (planCache && Date.now() - planCacheAt < PLAN_CACHE_MS) return planCache;
    const plan = await planLaunch().catch(() => null);
    planCache = plan;
    planCacheAt = Date.now();
    return plan;
}

// Launch info for the widget when ComfyUI is known to be offline (the caller
// already checked availability, so this only resolves the plan).
async function getLaunchInfo() {
    const plan = await detectPlan();
    return { starting: !!startPromise, canStart: !!plan, method: plan ? plan.method : null };
}

async function getStatus() {
    try {
        if (await comfyui.isAvailable()) {
            planCache = null;
            return { available: true, running: true, canStart: false };
        }
    } catch {}
    const info = await getLaunchInfo();
    return { available: false, running: false, ...info };
}

const START_VERB = '(?:start|launch|boot|open|run|fire\\s+up|spin\\s+up|bring\\s+up|wake|turn\\s+on|power\\s+on)';

// Narrow, deterministic detection of "start ComfyUI" chat commands so small
// chat models cannot downgrade them to chat. Questions ("how do I start
// ComfyUI?") are left to the model.
function isStartComfyRequest(text) {
    const s = String(text || '').trim().toLowerCase();
    if (!s) return false;
    if (/^(how|what|why|when|where|who)\b/.test(s)) return false;
    if (s.endsWith('?')) return false;
    const full = 'comfy\\s?ui';
    const forward = new RegExp('\\b' + START_VERB + '\\b[\\s\\S]{0,10}?\\b(?:' + full + '|comfy)\\b');
    const reverse = new RegExp('\\b' + full + '\\b[\\s\\S]{0,25}?\\b' + START_VERB + '\\b');
    return forward.test(s) || reverse.test(s);
}

module.exports = {
    LOG_PATH,
    START_TIMEOUT_MS,
    start,
    getStatus,
    getLaunchInfo,
    planLaunch,
    isStartComfyRequest
};
