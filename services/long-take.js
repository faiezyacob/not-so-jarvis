/* ============================================
   JARVIS — H3 LongTake node installer + status
   The H3 LongTake long-video engine needs two
   ComfyUI custom node packs:

     * xyzDist/H3-LongTakeNoCuts
         -> H3BlendLatentsByFrames (the latent frame-blend)
     * NikoDemon80/ComfyUI-H3-Motion-Context
         -> MiniMaxH3MotionContext / ...Trim (latent handoff)

   ComfyUI changed its H3 packed layout in 0.34.0: PackedLayout dropped
   `frame_count` and stopped rejecting interior keyframe anchors. The
   motion-context pack is split on that boundary:

     * ComfyUI >= 0.34.0 -> current pack (main); it only CHECKS the layout.
     * ComfyUI <= 0.33.4 -> tag v0.3.1, which runtime-patches the old layout.

   An out-of-range pack fails at render time with
   "the layout patch could not be applied". So this installer reads
   ComfyUI's version from /system_stats and pins the motion-context pack to
   the matching ref (both refs expose the same node signatures).

   Mirrors services/fbcache.js: a single-flight background job, a status
   endpoint the VIDEO panel polls, and a fire-and-forget first-use install.

   Zero npm dependencies: only node builtins (fs/path/child_process) plus the
   ComfyUI HTTP client.
   SPDX-License-Identifier: MIT
   ============================================ */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const comfyui = require('./comfyui');

// ComfyUI 0.34.0 changed the H3 packed layout; the motion-context pack is
// split on it.
const H3_LAYOUT_VERSION = [0, 34, 0];
const MOTION_CONTEXT_LEGACY_TAG = 'v0.3.1';

const PACKS = [
    {
        key: 'longtake',
        label: 'H3-LongTakeNoCuts',
        repo: 'https://github.com/xyzDist/H3-LongTakeNoCuts.git',
        dir: 'H3-LongTakeNoCuts',
        nodes: ['H3BlendLatentsByFrames'],
        refFor: () => null
    },
    {
        key: 'motionContext',
        label: 'ComfyUI-H3-Motion-Context',
        repo: 'https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context.git',
        dir: 'ComfyUI-H3-Motion-Context',
        nodes: ['MiniMaxH3MotionContext', 'MiniMaxH3MotionContextTrim'],
        // null = the remote's default branch (current pack, ComfyUI >= 0.34.0).
        refFor: (version) => (version && !versionAtLeast(version, H3_LAYOUT_VERSION))
            ? MOTION_CONTEXT_LEGACY_TAG
            : null
    }
];

const LONGTAKE_NODES = PACKS.flatMap((p) => p.nodes);

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
    console.log('[longtake] ' + line);
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

function parseVersion(value) {
    const match = String(value || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
}

function versionAtLeast(version, target) {
    const v = Array.isArray(version) ? version : parseVersion(version);
    if (!v) return false;
    for (let i = 0; i < 3; i++) {
        if (v[i] > target[i]) return true;
        if (v[i] < target[i]) return false;
    }
    return true;
}

async function comfyVersion() {
    try {
        const stats = await comfyui.getSystemStats();
        return String((stats && stats.system && stats.system.comfyui_version) || '').trim();
    } catch {
        return '';
    }
}

// The motion-context pack ref matching a ComfyUI version (null = default branch).
function motionContextRefFor(version) {
    return PACKS[1].refFor(version);
}

function customNodesDir(comfyRoot) {
    return path.join(comfyRoot, 'custom_nodes');
}

function normName(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ComfyUI loads EVERY folder under custom_nodes. A renamed backup, a second
// clone, a fork or a Manager install alongside a manual one all load, and each
// self-tests against whichever copy registered first — the usual cause of a
// "layout patch could not be applied" failure (renaming a folder does not stop
// ComfyUI loading it). Move any same-pack folder that is not the canonical one
// OUT of custom_nodes, into a sibling `custom_nodes_disabled/`, non-
// destructively, so exactly one copy loads. Returns the moved entries.
function quarantineDuplicatePackDirs(nodesDir, dirName, onLog) {
    const log = typeof onLog === 'function' ? onLog : logLine;
    const canonical = normName(dirName);
    const disabledDir = path.join(path.dirname(nodesDir), 'custom_nodes_disabled');
    let entries;
    try {
        entries = fs.readdirSync(nodesDir, { withFileTypes: true });
    } catch {
        return [];
    }
    const moved = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = normName(entry.name);
        if (name === canonical || !name.startsWith(canonical)) continue;
        const src = path.join(nodesDir, entry.name);
        try {
            fs.mkdirSync(disabledDir, { recursive: true });
            const dest = path.join(disabledDir, entry.name + '-' + Date.now());
            fs.renameSync(src, dest);
            moved.push({ name: entry.name, to: dest });
            log('duplicate pack folder moved out of custom_nodes: ' + entry.name + ' -> ' + dest);
        } catch (err) {
            log('could not move duplicate ' + entry.name + ': ' + (err.message || err));
        }
    }
    return moved;
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
        comfyuiVersion: '',
        packsInstalled: {},
        nodesPresent: {},
        motionContextRef: null,
        duplicatePackDirs: [],
        ready: false,
        restartRequired: false,
        requiredNodes: LONGTAKE_NODES,
        job: jobState()
    };
    if (!(await comfyui.isAvailable())) return status;
    status.comfyAvailable = true;

    status.comfyuiVersion = await comfyVersion();
    status.motionContextRef = PACKS[1].refFor(status.comfyuiVersion);

    let info = null;
    try {
        info = await comfyui.getObjectInfo(30000);
    } catch { info = null; }
    for (const node of LONGTAKE_NODES) {
        status.nodesPresent[node] = Boolean(info && info[node]);
    }

    try {
        status.comfyRoot = await comfyui.resolveComfyRoot();
    } catch { status.comfyRoot = null; }
    if (status.comfyRoot) {
        const nodesDir = customNodesDir(status.comfyRoot);
        for (const pack of PACKS) {
            status.packsInstalled[pack.key] = fs.existsSync(path.join(nodesDir, pack.dir));
        }
        // Any extra same-pack folder will also be loaded by ComfyUI; surface it.
        for (const pack of PACKS) {
            const canonical = normName(pack.dir);
            try {
                for (const entry of fs.readdirSync(nodesDir, { withFileTypes: true })) {
                    if (!entry.isDirectory()) continue;
                    const name = normName(entry.name);
                    if (name !== canonical && name.startsWith(canonical)) {
                        status.duplicatePackDirs.push(entry.name);
                    }
                }
            } catch { /* folder listing is best-effort */ }
        }
    }

    const allNodes = LONGTAKE_NODES.every((n) => status.nodesPresent[n]);
    const anyPackOnDisk = PACKS.some((p) => status.packsInstalled[p.key]);
    status.ready = Boolean(status.comfyAvailable && allNodes);
    status.restartRequired = Boolean(anyPackOnDisk && !allNodes);
    return status;
}

// Clone a pack fresh, or update an existing git checkout to the requested ref.
// `ref` null = the remote's default branch.
function installPack(pack, nodesDir, ref) {
    const dir = path.join(nodesDir, pack.dir);
    const label = pack.label;
    // Keep exactly one copy: ComfyUI loads every folder in custom_nodes, so a
    // renamed backup or a second clone is a silent second node registration.
    quarantineDuplicatePackDirs(nodesDir, pack.dir, logLine);
    const hasGit = fs.existsSync(path.join(dir, '.git'));

    if (hasGit) {
        logLine(label + ': updating existing checkout' + (ref ? ' -> ' + ref : '') + ' ...');
        if (ref) {
            runCommand('git', ['-C', dir, 'fetch', '--depth', '1', 'origin',
                'refs/tags/' + ref + ':refs/tags/' + ref], { timeoutMs: 180000 });
        } else {
            runCommand('git', ['-C', dir, 'fetch', '--depth', '1', 'origin', 'HEAD'], { timeoutMs: 180000 });
        }
        const co = runCommand('git', ['-C', dir, 'checkout', '--force', ref || 'FETCH_HEAD'], { timeoutMs: 60000 });
        if (!co.ok) {
            logLine(label + ': update FAILED: ' + (co.stderr || co.error || 'checkout failed'));
            return false;
        }
        logLine(label + ': updated (' + (ref || 'default branch') + ').');
        return true;
    }

    if (fs.existsSync(dir)) {
        const manual = ref
            ? 'git clone --depth 1 --branch ' + ref + ' ' + pack.repo + ' "' + dir + '"'
            : 'git clone --depth 1 ' + pack.repo + ' "' + dir + '"';
        logLine(label + ': found at ' + dir + ' but it is not a git checkout, so it cannot be ' +
            'auto-updated. Delete the folder and retry, or run: ' + manual);
        return false;
    }

    logLine(label + ': cloning ' + pack.repo + (ref ? ' (' + ref + ')' : '') + ' ...');
    const args = ['clone', '--depth', '1'];
    if (ref) args.push('--branch', ref);
    args.push(pack.repo, dir);
    const cloned = runCommand('git', args, { timeoutMs: 10 * 60 * 1000 });
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
                'Install manually: git clone each pack into ComfyUI/custom_nodes/, then restart ComfyUI.'
            );
        }
        const version = await comfyVersion();
        logLine('ComfyUI root: ' + comfyRoot + (version ? ' (ComfyUI ' + version + ')' : ''));
        const nodesDir = customNodesDir(comfyRoot);
        fs.mkdirSync(nodesDir, { recursive: true });

        const gitCheck = runCommand('git', ['--version'], { timeoutMs: 30000 });
        if (!gitCheck.ok) {
            throw new Error(
                'git is not installed or not on PATH. Install manually into ' + nodesDir + ', then restart ComfyUI.'
            );
        }

        for (const pack of PACKS) {
            const ref = pack.refFor(version);
            if (!installPack(pack, nodesDir, ref)) {
                throw new Error('Could not install ' + pack.label + '. Check the log above.');
            }
        }

        job.ok = true;
        logLine('Done. RESTART ComfyUI so the new nodes load, then retry the long video.');
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

// Fire-and-forget install/repair: starts the background job unless one is
// running or a previous run already succeeded. Never throws.
function ensureAutoInstall() {
    try {
        if (job.running || (job.done && job.ok && !job.warn)) return jobState();
        job.autoStarted = true;
        startInstall();
    } catch { /* install is best-effort */ }
    return jobState();
}

// True when a ComfyUI error is the motion-context layout mismatch (an
// out-of-range pack for this ComfyUI version). Used to trigger a repair and
// return an actionable message instead of the raw traceback.
function isLayoutMismatchError(err) {
    const text = String((err && (err.message || err.error || err)) || '');
    return /h3_motion_context/i.test(text) &&
        /(layout patch could not be applied|layout|interior anchor)/i.test(text);
}

module.exports = {
    PACKS,
    LONGTAKE_NODES,
    H3_LAYOUT_VERSION,
    MOTION_CONTEXT_LEGACY_TAG,
    getStatus,
    startInstall,
    ensureAutoInstall,
    isLayoutMismatchError,
    parseVersion,
    versionAtLeast,
    comfyVersion,
    motionContextRefFor,
    quarantineDuplicatePackDirs,
    normName,
    jobState
};
