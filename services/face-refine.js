/* ============================================
   JARVIS — H3 FaceRefine Installer + Status
   Optional post-process for MiniMax H3 video: per-frame face tracking,
   crop, H3 re-generation at low denoise, feathered stitch-back
   (https://github.com/Carasibana/ComfyUI-H3-FaceRefine).

   This module checks whether the ComfyUI side is ready (custom nodes +
   face detector model) and, on first enable, installs what is missing:
   git-clones the custom node pack (+ NativeAudioLock for lipsync),
   pip-installs its Python requirements, and downloads face_yolov8m.pt.
   ComfyUI itself cannot be restarted from here, so a successful install
   reports restartRequired until the nodes show up in /object_info.

   Zero npm dependencies: only node builtins (fs/path/os/child_process)
   plus the global fetch for the detector download.
   SPDX-License-Identifier: GPL-3.0-only
   ============================================ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const comfyui = require('./comfyui');

const FACEREFINE_REPO = 'https://github.com/Carasibana/ComfyUI-H3-FaceRefine.git';
const FACEREFINE_DIR = 'ComfyUI-H3-FaceRefine';
const NATIVE_AUDIO_REPO = 'https://github.com/Shrek3OnVH5/MiniMax-H3-NativeAudio-MusicVideo-Workflow.git';
const NATIVE_AUDIO_SUBDIR = path.join('custom_nodes', 'ComfyUI-H3-NativeAudioLock');
const NATIVE_AUDIO_DIR = 'ComfyUI-H3-NativeAudioLock';
const DETECTOR_FILE = process.env.H3_FACEREFINE_DETECTOR || 'face_yolov8m.pt';
const DETECTOR_URL = 'https://huggingface.co/Bingsu/adetailer/resolve/main/face_yolov8m.pt';
const PIP_PACKAGES = ['ultralytics', 'scipy', 'insightface'];

// Nodes the refine graph needs. MiniMaxH3NativeAudioLock is optional (the
// graph falls back to the source clip audio when it is absent); VHS_LoadVideo
// is required (already a prerequisite of the video upscale pipeline).
const REQUIRED_NODES = [
    'H3FaceTrackCrop',
    'H3InjectVideoLatent',
    'H3PerFrameDenoise',
    'H3FaceStitch',
    'VHS_LoadVideo'
];
const OPTIONAL_NODES = ['MiniMaxH3NativeAudioLock'];

// Background install job (single-flight). Never persisted; the status
// endpoint reports it so the settings UI can poll.
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
    console.log('[face-refine] ' + line);
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

async function detectPythonExe(comfyRoot) {
    const candidates = [];
    // Comfy Desktop venv first: <install>/standalone-env/python.exe, so pip
    // lands in ComfyUI's environment instead of a system Python.
    if (comfyRoot) {
        const installDir = path.dirname(String(comfyRoot));
        candidates.push(
            path.join(installDir, 'standalone-env', 'python.exe'),
            path.join(installDir, 'standalone-env', 'Scripts', 'python.exe'),
            path.join(installDir, 'standalone-env', 'bin', 'python')
        );
    }
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
                logLine('python: using ' + exe + ' (' + (res.stdout || res.stderr || '').trim().split('\n')[0] + ')');
                return path.basename(String(exe)).toLowerCase() === 'py'
                    ? { exe, prefix: ['-3'] }
                    : { exe, prefix: [] };
            }
        } catch { /* try next */ }
    }
    return null;
}

function detectorSearchDirs(modelRoot) {
    if (!modelRoot) return [];
    return [
        path.join(modelRoot, 'ultralytics', 'bbox'),
        path.join(modelRoot, 'ultralytics'),
        path.join(modelRoot, 'ultralytics', 'segm')
    ];
}

function findDetectorFile(modelRoot, name) {
    for (const dir of detectorSearchDirs(modelRoot)) {
        const candidate = path.join(dir, path.basename(name));
        try {
            const st = fs.statSync(candidate);
            if (st.isFile() && st.size > 512 * 1024) return candidate;
        } catch { /* missing */ }
    }
    return null;
}

async function getStatus() {
    const status = {
        comfyAvailable: false,
        comfyRoot: null,
        packInstalled: false,
        nodesPresent: {},
        nodesMissing: [],
        nativeAudioPresent: false,
        vhsPresent: false,
        detectorFound: false,
        detectorPath: null,
        detectorName: DETECTOR_FILE,
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
        for (const name of REQUIRED_NODES.concat(OPTIONAL_NODES)) {
            status.nodesPresent[name] = Boolean(info[name]);
        }
        status.nodesMissing = REQUIRED_NODES.filter((n) => !info[n]);
        status.vhsPresent = Boolean(info.VHS_LoadVideo);
        status.nativeAudioPresent = Boolean(info.MiniMaxH3NativeAudioLock);
    }

    try {
        status.comfyRoot = await comfyui.resolveComfyRoot();
    } catch { status.comfyRoot = null; }
    if (status.comfyRoot) {
        status.packInstalled = fs.existsSync(path.join(customNodesDir(status.comfyRoot), FACEREFINE_DIR));
    }

    try {
        const modelRoot = await comfyui.resolveModelRoot();
        const found = findDetectorFile(modelRoot, DETECTOR_FILE);
        if (found) {
            status.detectorFound = true;
            status.detectorPath = found;
        }
    } catch { /* unknown */ }

    const nodesOk = status.nodesMissing.length === 0;
    status.ready = Boolean(status.comfyAvailable && nodesOk && status.vhsPresent && status.detectorFound);
    // Pack on disk but nodes not loaded yet: ComfyUI needs a restart.
    status.restartRequired = Boolean(status.packInstalled && !nodesOk);
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

async function downloadDetector(destPath) {
    logLine('detector: downloading ' + DETECTOR_URL + ' ...');
    const res = await fetch(DETECTOR_URL, { signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!res.ok) throw new Error('detector download failed with HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 512 * 1024) throw new Error('detector download too small (' + buf.length + ' bytes), refusing to write.');
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buf);
    logLine('detector: saved ' + destPath + ' (' + Math.round(buf.length / 1024 / 1024) + ' MB).');
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
                'Install manually: git clone ' + FACEREFINE_REPO + ' into ComfyUI/custom_nodes/, ' +
                'pip install ' + PIP_PACKAGES.join(' ') + ', and place ' + DETECTOR_FILE +
                ' (https://huggingface.co/Bingsu/adetailer) in models/ultralytics/bbox/. Then restart ComfyUI.'
            );
        }
        logLine('ComfyUI root: ' + comfyRoot);
        const nodesDir = customNodesDir(comfyRoot);
        fs.mkdirSync(nodesDir, { recursive: true });

        const gitCheck = runCommand('git', ['--version'], { timeoutMs: 30000 });
        if (!gitCheck.ok) {
            throw new Error(
                'git is not installed or not on PATH. Install manually: git clone ' + FACEREFINE_REPO +
                ' into ' + nodesDir + ', pip install ' + PIP_PACKAGES.join(' ') +
                ', and place ' + DETECTOR_FILE + ' in models/ultralytics/bbox/. Then restart ComfyUI.'
            );
        }

        const packDir = path.join(nodesDir, FACEREFINE_DIR);
        if (!gitCloneOrPull(packDir, FACEREFINE_REPO, 'FaceRefine pack')) {
            throw new Error('Could not clone ' + FACEREFINE_REPO + '. Check the log above and your network connection.');
        }

        // Lipsync helper (best-effort): the refine graph uses it when present
        // and falls back to the source clip audio when it is not.
        try {
            const audioDir = path.join(nodesDir, NATIVE_AUDIO_DIR);
            if (!fs.existsSync(audioDir)) {
                const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-h3audio-'));
                try {
                    if (gitCloneOrPull(tmpDir, NATIVE_AUDIO_REPO, 'NativeAudioLock tmp')) {
                        const nested = path.join(tmpDir, NATIVE_AUDIO_SUBDIR);
                        if (fs.existsSync(nested)) {
                            fs.cpSync(nested, audioDir, { recursive: true });
                            logLine('NativeAudioLock: installed.');
                        } else {
                            logLine('NativeAudioLock: subfolder not found in repo, skipping (optional).');
                        }
                    }
                } finally {
                    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
                }
            } else {
                logLine('NativeAudioLock: already present, skipping (optional).');
            }
        } catch (err) {
            logLine('NativeAudioLock: skipped (' + err.message + ') — refine still works without lipsync lock.');
        }

        const py = await detectPythonExe(comfyRoot);
        if (!py) {
            logLine('python: not found — skipping pip install. Install manually in ComfyUI\'s python: pip install ' + PIP_PACKAGES.join(' '));
        } else {
            logLine('python: ' + py.exe + ' — installing ' + PIP_PACKAGES.join(', ') + ' (may take several minutes)...');
            const pip = runCommand(py.exe, py.prefix.concat(['-m', 'pip', 'install', '--disable-pip-version-check'].concat(PIP_PACKAGES)), { timeoutMs: 30 * 60 * 1000 });
            if (pip.ok) {
                logLine('pip: ok');
            } else {
                // Non-fatal, but the nodes will not import without these —
                // flag it so the UI shows the manual command after restart.
                job.warn = 'pip install failed in ComfyUI\'s python — run manually: pip install ' + PIP_PACKAGES.join(' ');
                logLine('pip: FAILED — ' + job.warn);
                if (pip.stderr) logLine('pip stderr: ' + pip.stderr.slice(-500));
            }
        }

        const modelRoot = await comfyui.resolveModelRoot();
        if (!modelRoot) {
            logLine('detector: could not resolve ComfyUI models dir — place ' + DETECTOR_FILE + ' (from ' + DETECTOR_URL + ') in models/ultralytics/bbox/ manually.');
        } else {
            const existing = findDetectorFile(modelRoot, DETECTOR_FILE);
            if (existing) {
                logLine('detector: already present at ' + existing);
            } else {
                await downloadDetector(path.join(modelRoot, 'ultralytics', 'bbox', path.basename(DETECTOR_FILE)));
            }
        }

        job.ok = true;
        logLine('Done. RESTART ComfyUI so the new nodes load, then generate a video.');
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
        if (job.running || (job.done && job.ok)) return jobState();
        job.autoStarted = true;
        startInstall();
    } catch { /* install is best-effort */ }
    return jobState();
}

module.exports = {
    FACEREFINE_REPO,
    FACEREFINE_DIR,
    DETECTOR_FILE,
    REQUIRED_NODES,
    OPTIONAL_NODES,
    getStatus,
    startInstall,
    ensureAutoInstall,
    jobState
};
