/* ============================================
   JARVIS — First-Run Model Setup Guide
   New installations have ComfyUI but none of the checkpoints JARVIS needs
   (Krea2 image stack, MiniMax H3 video stack, SeedVR2/Ultimate SD upscale
   weights, and the custom nodes the graphs reference). This module is the
   backend for the Settings > Setup guide: it reports what is already on
   disk, stores the user's Hugging Face token, and downloads the missing
   files straight from Hugging Face into ComfyUI's models/ folders.

   Model sources (verified file listings, mirrored from the Mix Studio
   asset set):
     Krea2 UNET ......... Comfy-Org/Krea-2 (diffusion_models/)
     Krea2 CLIP (Qwen3-VL 4B fp8) .. ahmed22xa/Huihui-Qwen3-VL-4B-Instruct-abliterated-comfy
     Krea2 VAE (Wan 2.1)  Comfy-Org/Wan_2.1_ComfyUI_repackaged (split_files/vae/)
     Identity Edit LoRA .. conradlocke/krea2-identity-edit
     H3 UNET/CLIP/VAEs ... Comfy-Org/MiniMax-H3 (diffusion_models/, text_encoders/, vae/)
     SeedVR2 DiT (7B fp8, default) .. mekrod/seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16
     SeedVR2 sharp DiT + VAE ........ Comfy-Org/SeedVR2
     Ultimate SD model ... FacehugmanIII/4x_foolhardy_Remacri

   Custom nodes checked against ComfyUI's /object_info (upscale included):
     UltimateSDUpscale .... ssitu/ComfyUI_UltimateSDUpscale
     Krea2Edit* ........... lbouaraba/comfyui-krea2edit
     VHS_LoadVideo ........ Kosinkadink/ComfyUI-VideoHelperSuite
     RTXVideoSuperResolution Comfy-Org/Nvidia_RTX_Nodes_ComfyUI (NVIDIA only)
     SeedVR2* / MiniMaxH3* .. ship with current ComfyUI — update hint only.

   Zero npm dependencies: node builtins + global fetch, streamed to disk so
   multi-GB checkpoints never sit fully in memory.
   SPDX-License-Identifier: GPL-3.0-only
   ============================================ */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const comfyui = require('./comfyui');
const configManager = require('../server/config-manager');

// --- Known Hugging Face files -------------------------------------------------
// Maps an exact ComfyUI filename to the repo + path it downloads from.
// Filenames configured in settings that are NOT in this table cannot be
// auto-downloaded — status reports them with a manual-download link instead.

const KNOWN_FILES = {
    'krea2_turbo_fp8_scaled.safetensors': {
        repo: 'Comfy-Org/Krea-2',
        hfPath: 'diffusion_models/krea2_turbo_fp8_scaled.safetensors',
        approxMB: 13100
    },
    'krea2_turbo_nvfp4.safetensors': {
        repo: 'Comfy-Org/Krea-2',
        hfPath: 'diffusion_models/krea2_turbo_nvfp4.safetensors',
        approxMB: 7700
    },
    'Huihui-Qwen3-VL-4B-Instruct-abliterated-fp8_scaled.safetensors': {
        repo: 'ahmed22xa/Huihui-Qwen3-VL-4B-Instruct-abliterated-comfy',
        hfPath: 'Huihui-Qwen3-VL-4B-Instruct-abliterated-fp8_scaled.safetensors',
        approxMB: 4300
    },
    'qwen3vl_4b_fp8_scaled.safetensors': {
        repo: 'Comfy-Org/Krea-2',
        hfPath: 'text_encoders/qwen3vl_4b_fp8_scaled.safetensors',
        approxMB: 4300
    },
    'wan_2.1_vae.safetensors': {
        repo: 'Comfy-Org/Wan_2.1_ComfyUI_repackaged',
        hfPath: 'split_files/vae/wan_2.1_vae.safetensors',
        approxMB: 254
    },
    'krea2_identity_edit_v1_2.safetensors': {
        repo: 'conradlocke/krea2-identity-edit',
        hfPath: 'krea2_identity_edit_v1_2.safetensors',
        approxMB: 1830
    },
    'minimax_h3_fl2va_pruned_int8_convrot.safetensors': {
        repo: 'Comfy-Org/MiniMax-H3',
        hfPath: 'diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors',
        approxMB: 21000
    },
    'minimax_h3_fl2va_pruned_fp8_scaled.safetensors': {
        repo: 'Comfy-Org/MiniMax-H3',
        hfPath: 'diffusion_models/minimax_h3_fl2va_pruned_fp8_scaled.safetensors',
        approxMB: 24000
    },
    'minimax_h3_ref2va_pruned_int8_convrot.safetensors': {
        repo: 'Comfy-Org/MiniMax-H3',
        hfPath: 'diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors',
        approxMB: 21000
    },
    'minimax_h3_ref2va_pruned_fp8_scaled.safetensors': {
        repo: 'Comfy-Org/MiniMax-H3',
        hfPath: 'diffusion_models/minimax_h3_ref2va_pruned_fp8_scaled.safetensors',
        approxMB: 24000
    },
    'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors': {
        repo: 'Comfy-Org/MiniMax-H3',
        hfPath: 'text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
        approxMB: 16000
    },
    'minimax_h3_video_vae_fp16.safetensors': {
        repo: 'Comfy-Org/MiniMax-H3',
        hfPath: 'vae/minimax_h3_video_vae_fp16.safetensors',
        approxMB: 2000
    },
    'minimax_h3_audio_vae_fp32.safetensors': {
        repo: 'Comfy-Org/MiniMax-H3',
        hfPath: 'vae/minimax_h3_audio_vae_fp32.safetensors',
        approxMB: 500
    },
    'seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors': {
        repo: 'mekrod/seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16',
        hfPath: 'seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors',
        approxMB: 8500
    },
    'ema_vae_fp16.safetensors': {
        repo: 'Comfy-Org/SeedVR2',
        hfPath: 'vae/ema_vae_fp16.safetensors',
        approxMB: 500
    },
    'seedvr2_ema_vae_fp16.safetensors': {
        repo: 'Comfy-Org/SeedVR2',
        hfPath: 'vae/seedvr2_ema_vae_fp16.safetensors',
        approxMB: 500
    },
    '4x_foolhardy_Remacri.pth': {
        repo: 'FacehugmanIII/4x_foolhardy_Remacri',
        hfPath: '4x_foolhardy_Remacri.pth',
        approxMB: 67
    }
};

function hfDownloadUrl(repo, hfPath) {
    return 'https://huggingface.co/' + repo + '/resolve/main/' + hfPath.split('/').map(encodeURIComponent).join('/');
}

function hfRepoUrl(repo) {
    return 'https://huggingface.co/' + repo;
}

// --- Model catalog ------------------------------------------------------------
// `file` may be a string (fixed name) or { settings: 'image'|'video', key }
// resolving to the currently configured filename so renamed overrides keep
// working when they match a known file. `dest` is the ComfyUI models/
// subfolder the file is downloaded into; `also` lists extra folders that
// count as "installed" when scanning.

const MODEL_CATALOG = [
    { id: 'krea2_unet', group: 'image', label: 'Krea2 Turbo UNET (FP8)', required: true, dest: 'diffusion_models', file: { settings: 'image', key: 'unet' }, minBytes: 5 * 1024 ** 3 },
    { id: 'krea2_clip', group: 'image', label: 'Krea2 CLIP (Qwen3-VL 4B FP8)', required: true, dest: 'text_encoders', file: { settings: 'image', key: 'clip' }, minBytes: 1 * 1024 ** 3 },
    { id: 'krea2_vae', group: 'image', label: 'Krea2 VAE (Wan 2.1)', required: true, dest: 'vae', file: { settings: 'image', key: 'vae' }, minBytes: 100 * 1024 ** 2 },
    { id: 'krea2_edit_lora', group: 'image', label: 'Identity Edit LoRA v1.2', required: true, dest: 'loras', file: { settings: 'image', key: 'editLora' }, minBytes: 500 * 1024 ** 2 },
    { id: 'h3_unet_t2va', group: 'video', label: 'H3 UNET for text-to-video (FL2VA)', required: true, dest: 'diffusion_models', file: { settings: 'video', key: 'h3Unet' }, minBytes: 5 * 1024 ** 3 },
    { id: 'h3_unet_i2va', group: 'video', label: 'H3 UNET for image-to-video (Ref2VA)', required: true, dest: 'diffusion_models', file: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors', minBytes: 5 * 1024 ** 3 },
    { id: 'h3_clip', group: 'video', label: 'H3 CLIP (Qwen3-VL 32B NVFP4)', required: true, dest: 'text_encoders', file: { settings: 'video', key: 'h3Clip' }, minBytes: 5 * 1024 ** 3 },
    { id: 'h3_video_vae', group: 'video', label: 'H3 video VAE', required: true, dest: 'vae', file: { settings: 'video', key: 'h3VideoVae' }, minBytes: 100 * 1024 ** 2 },
    { id: 'h3_audio_vae', group: 'video', label: 'H3 audio VAE', required: true, dest: 'vae', file: { settings: 'video', key: 'h3AudioVae' }, minBytes: 10 * 1024 ** 2 },
    { id: 'seedvr2_dit', group: 'upscale', label: 'SeedVR2 DiT 7B (balanced)', required: true, dest: 'seedvr2', also: ['SEEDVR2'], seen: 'seedvr2dit', file: { settings: 'image', key: 'seedvr2Dit' }, minBytes: 2 * 1024 ** 3 },
    { id: 'seedvr2_dit_sharp', group: 'upscale', label: 'SeedVR2 DiT 7B (sharp profile)', required: false, dest: 'seedvr2', also: ['SEEDVR2'], seen: 'seedvr2dit', file: 'seedvr2_ema_7b_sharp_fp8_e4m3fn_mixed_block35_fp16.safetensors', minBytes: 2 * 1024 ** 3, note: 'Same profile the sharp upscale uses. The SeedVR2 nodes auto-download it on first use; no token needed.' },
    { id: 'seedvr2_vae', group: 'upscale', label: 'SeedVR2 VAE', required: true, dest: 'seedvr2', also: ['SEEDVR2', 'vae'], seen: 'seedvr2vae', file: { settings: 'image', key: 'seedvr2Vae' }, minBytes: 10 * 1024 ** 2 },
    { id: 'ultimate_sd_model', group: 'upscale', label: 'Upscale model 4x Foolhardy Remacri', required: false, dest: 'upscale_models', seen: 'upscale_models', file: '4x_foolhardy_Remacri.pth', minBytes: 10 * 1024 ** 2, note: 'Needed only for the Ultimate SD upscale engine (images).' }
];

// --- Custom-node catalog ------------------------------------------------------

const NODE_CATALOG = [
    {
        id: 'ultimate_sd', label: 'Ultimate SD Upscale', required: false,
        nodes: ['UltimateSDUpscale'],
        repo: 'https://github.com/ssitu/ComfyUI_UltimateSDUpscale',
        dir: 'ComfyUI_UltimateSDUpscale', recursive: true,
        note: 'Needed for the Ultimate SD image-upscale engine. Clone with --recursive (it has a submodule).'
    },
    {
        id: 'krea2edit', label: 'Krea2 Identity Edit', required: true,
        nodes: ['Krea2EditModelPatch', 'Krea2EditGroundedEncode'],
        repo: 'https://github.com/lbouaraba/comfyui-krea2edit',
        dir: 'comfyui-krea2edit', recursive: false,
        note: 'Needed for "edit this image". No extra Python packages.'
    },
    {
        id: 'vhs', label: 'VideoHelperSuite', required: true,
        nodes: ['VHS_LoadVideo'],
        repo: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite',
        dir: 'ComfyUI-VideoHelperSuite', recursive: false,
        note: 'Needed for video generation and all video upscales. Requires imageio-ffmpeg in ComfyUI python: pip install -r requirements.txt.'
    },
    {
        id: 'rtx', label: 'NVIDIA RTX Video Upscale', required: false,
        nodes: ['RTXVideoSuperResolution'],
        repo: 'https://github.com/Comfy-Org/Nvidia_RTX_Nodes_ComfyUI',
        dir: 'Nvidia_RTX_Nodes_ComfyUI', recursive: false, nvidiaOnly: true,
        note: 'Needed for the default RTX video-upscale engine (NVIDIA GPU only). Needs the nvidia-vfx package — install from https://pypi.nvidia.com if ComfyUI Manager fails.'
    },
    {
        id: 'seedvr2_native', label: 'SeedVR2 (built into ComfyUI)', required: true,
        nodes: ['SeedVR2LoadDiTModel', 'SeedVR2LoadVAEModel', 'SeedVR2VideoUpscaler'],
        repo: null, dir: null,
        note: 'Ships with current ComfyUI. If missing, update ComfyUI.'
    },
    {
        id: 'h3_native', label: 'MiniMax H3 (built into ComfyUI)', required: true,
        nodes: ['MiniMaxH3ImageToVideo'],
        repo: null, dir: null,
        note: 'Ships with current ComfyUI. If missing, update ComfyUI (or install the H3 nodes via ComfyUI Manager search "MiniMax H3").'
    }
];

// --- Settings-backed filenames ------------------------------------------------

function settingsFilename(source) {
    try {
        if (source.settings === 'image') {
            const imageGenerator = require('./image-generator');
            const settings = imageGenerator.effectiveSettings();
            const fallback = imageGenerator.getDefaults();
            const value = settings[source.key];
            return String(value || fallback[source.key] || '').trim();
        }
        if (source.settings === 'video') {
            const videoGenerator = require('./video-generator');
            const settings = videoGenerator.effectiveVideoSettings();
            const fallback = videoGenerator.getVideoDefaults();
            const value = settings[source.key];
            return String(value || fallback[source.key] || '').trim();
        }
    } catch {
        // fall through to empty
    }
    return '';
}

function resolveCatalogEntry(entry) {
    const filename = typeof entry.file === 'string' ? entry.file : settingsFilename(entry.file);
    const known = KNOWN_FILES[filename] || null;
    return {
        id: entry.id,
        group: entry.group,
        label: entry.label,
        required: Boolean(entry.required),
        note: entry.note || null,
        filename,
        dest: entry.dest,
        repo: known ? known.repo : null,
        hfPath: known ? known.hfPath : null,
        url: known ? hfDownloadUrl(known.repo, known.hfPath) : null,
        repoUrl: known ? hfRepoUrl(known.repo) : null,
        approxMB: known ? known.approxMB : null,
        minBytes: entry.minBytes
    };
}

// --- Filesystem scanning ------------------------------------------------------

async function getModelRoot() {
    try {
        return await comfyui.resolveModelRoot();
    } catch {
        return null;
    }
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

// --- Background job (single-flight, like face-refine.js) ----------------------

const job = {
    running: false,
    done: false,
    ok: false,
    error: null,
    kind: null,
    total: 0,
    finished: 0,
    current: null,
    log: [],
    startedAt: null,
    finishedAt: null
};

function logLine(text) {
    const line = String(text || '');
    job.log.push(line);
    if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
    console.log('[model-setup] ' + line);
}

function jobState() {
    return {
        running: job.running,
        done: job.done,
        ok: job.ok,
        error: job.error,
        kind: job.kind,
        total: job.total,
        finished: job.finished,
        current: job.current,
        log: job.log.slice(-40),
        startedAt: job.startedAt,
        finishedAt: job.finishedAt
    };
}

function authHeaders() {
    const token = configManager.getHuggingFaceToken();
    return token ? { Authorization: 'Bearer ' + token } : {};
}

// Stream a Hugging Face file to disk without buffering it in memory.
// Reports progress into job.current. Downloads to `<dest>.download` first so
// an interrupted run never leaves a half file behind under the real name.
async function downloadFileTo(entry, destPath) {
    const headers = authHeaders();
    let res;
    try {
        res = await fetch(entry.url, { headers, signal: AbortSignal.timeout(30 * 1000) });
    } catch (err) {
        throw new Error('Could not reach Hugging Face: ' + (err.message || err) + '. Check your network connection.');
    }
    if (res.status === 401 || res.status === 403) {
        throw new Error('Hugging Face denied access (HTTP ' + res.status + '). The repo may require accepting its license terms, or your token is missing/invalid — save a token in Step 2 and accept the license on the repo page.');
    }
    if (!res.ok) {
        throw new Error('Download failed with HTTP ' + res.status + ' for ' + entry.filename + '. The file may have moved — try the manual link in the guide.');
    }
    const total = Number(res.headers.get('content-length')) || (entry.approxMB ? entry.approxMB * 1024 * 1024 : 0);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmpPath = destPath + '.download';
    const out = fs.createWriteStream(tmpPath);
    let received = 0;
    job.current = { id: entry.id, label: entry.label, filename: entry.filename, received: 0, total };
    try {
        for await (const chunk of res.body) {
            const buf = Buffer.from(chunk);
            received += buf.length;
            job.current.received = received;
            if (!out.write(buf)) {
                await new Promise((resolve) => out.once('drain', resolve));
            }
        }
    } catch (err) {
        try { out.destroy(); } catch {}
        try { fs.unlinkSync(tmpPath); } catch {}
        throw new Error('Download interrupted for ' + entry.filename + ': ' + (err.message || err));
    }
    await new Promise((resolve, reject) => {
        out.on('finish', resolve);
        out.on('error', reject);
        out.end();
    });
    let size = 0;
    try { size = fs.statSync(tmpPath).size; } catch {}
    if (!size || size < (entry.minBytes || 1)) {
        try { fs.unlinkSync(tmpPath); } catch {}
        throw new Error('Downloaded ' + entry.filename + ' looks truncated (' + Math.round(size / 1024 / 1024) + ' MB). Deleted — retry the download.');
    }
    fs.renameSync(tmpPath, destPath);
    job.current.received = size;
    job.current.total = total || size;
    return size;
}

async function runDownloadJob(ids) {
    job.running = true;
    job.done = false;
    job.ok = false;
    job.error = null;
    job.kind = 'download';
    job.startedAt = new Date().toISOString();
    job.finishedAt = null;
    job.finished = 0;
    try {
        if (!(await comfyui.isAvailable())) {
            throw new Error('ComfyUI is not reachable at ' + comfyui.COMFYUI_URL + '. Start ComfyUI first — the guide needs its models/ folder location.');
        }
        const modelRoot = await getModelRoot();
        if (!modelRoot) {
            throw new Error('Could not locate ComfyUI\'s models/ folder. Set COMFYUI_MODEL_DIR and retry, or copy the files manually.');
        }
        logLine('ComfyUI models: ' + modelRoot);
        const wanted = new Set(ids || []);
        const entries = MODEL_CATALOG.map(resolveCatalogEntry).filter((e) => wanted.has(e.id));
        if (!entries.length) throw new Error('No known models selected.');
        job.total = entries.length;
        for (const entry of entries) {
            if (!entry.url) {
                logLine('SKIP ' + entry.label + ': custom filename "' + entry.filename + '" has no known Hugging Face source — download it manually into models/' + entry.dest + '/.');
                job.finished += 1;
                continue;
            }
            const destPath = path.join(modelRoot, entry.dest, entry.filename);
            if (filePresent(path.dirname(destPath), entry.filename, entry.minBytes)) {
                logLine('SKIP ' + entry.label + ': already installed.');
                job.finished += 1;
                continue;
            }
            logLine('Downloading ' + entry.filename + ' (' + entry.repo + ') ...');
            const size = await downloadFileTo(entry, destPath);
            logLine('Saved ' + entry.filename + ' (' + (size / 1024 / 1024 / 1024).toFixed(2) + ' GB) to models/' + entry.dest + '/.');
            job.finished += 1;
        }
        job.ok = true;
        logLine('Done. ComfyUI picks new models up automatically; restart it if a file is not listed.');
    } catch (err) {
        job.ok = false;
        job.error = err.message || String(err);
        logLine('FAILED: ' + job.error);
    } finally {
        job.running = false;
        job.done = true;
        job.current = null;
        job.finishedAt = new Date().toISOString();
    }
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
        stdout: String(res.stdout || '').slice(-2000),
        stderr: String(res.stderr || '').slice(-2000),
        error: res.error ? String(res.error.message || res.error) : null
    };
}

async function runNodeInstallJob(ids) {
    job.running = true;
    job.done = false;
    job.ok = false;
    job.error = null;
    job.kind = 'nodes';
    job.startedAt = new Date().toISOString();
    job.finishedAt = null;
    job.finished = 0;
    try {
        if (!(await comfyui.isAvailable())) {
            throw new Error('ComfyUI is not reachable at ' + comfyui.COMFYUI_URL + '. Start ComfyUI first.');
        }
        const comfyRoot = await comfyui.resolveComfyRoot();
        if (!comfyRoot) {
            throw new Error('Could not locate the ComfyUI install folder. Set COMFYUI_ROOT and retry, or clone the repos manually into ComfyUI/custom_nodes/.');
        }
        const nodesDir = path.join(comfyRoot, 'custom_nodes');
        fs.mkdirSync(nodesDir, { recursive: true });
        const gitCheck = runCommand('git', ['--version'], { timeoutMs: 30000 });
        if (!gitCheck.ok) {
            throw new Error('git is not installed or not on PATH. Install git, or clone the repos manually into ' + nodesDir + '.');
        }
        const wanted = new Set(ids || []);
        const packs = NODE_CATALOG.filter((n) => wanted.has(n.id) && n.repo);
        if (!packs.length) throw new Error('No installable node packs selected (built-in nodes ship with ComfyUI — update it instead).');
        job.total = packs.length;
        for (const pack of packs) {
            const dir = path.join(nodesDir, pack.dir);
            const args = fs.existsSync(path.join(dir, '.git'))
                ? ['-C', dir, 'pull', '--ff-only']
                : ['clone'].concat(pack.recursive ? ['--recursive'] : []).concat([pack.repo, dir]);
            job.current = { id: pack.id, label: pack.label, filename: '', received: 0, total: 0 };
            logLine((fs.existsSync(path.join(dir, '.git')) ? 'Updating ' : 'Cloning ') + pack.repo + ' ...');
            const res = runCommand('git', args, { timeoutMs: 10 * 60 * 1000 });
            if (!res.ok && !fs.existsSync(dir)) {
                throw new Error('Could not clone ' + pack.repo + ': ' + (res.stderr || res.error || 'git failed') + '. Check your network connection.');
            }
            logLine(pack.label + ': ' + (res.ok ? 'ok.' : 'kept existing copy (' + (res.stderr || 'pull skipped') + ').') + ' ' + (pack.note || ''));
            job.finished += 1;
        }
        job.ok = true;
        logLine('Done. RESTART ComfyUI so the new nodes load, then re-check this guide.');
    } catch (err) {
        job.ok = false;
        job.error = err.message || String(err);
        logLine('FAILED: ' + job.error);
    } finally {
        job.running = false;
        job.done = true;
        job.current = null;
        job.finishedAt = new Date().toISOString();
    }
}

function startDownload(ids) {
    if (job.running) return { started: false, reason: 'already running', job: jobState() };
    job.log = [];
    setImmediate(() => { runDownloadJob(ids).catch(() => {}); });
    return { started: true, job: jobState() };
}

function startNodeInstall(ids) {
    if (job.running) return { started: false, reason: 'already running', job: jobState() };
    job.log = [];
    setImmediate(() => { runNodeInstallJob(ids).catch(() => {}); });
    return { started: true, job: jobState() };
}

// --- Token verification --------------------------------------------------------
// Best-effort: confirms the token with Hugging Face and records the username.
// Never throws — callers save the token regardless and surface the warning.

async function verifyToken(token) {
    const value = String(token || '').trim();
    if (!value) return { valid: false, user: null, error: 'Token is empty.' };
    try {
        const res = await fetch('https://huggingface.co/api/whoami', {
            headers: { Authorization: 'Bearer ' + value },
            signal: AbortSignal.timeout(15000)
        });
        if (res.status === 401) return { valid: false, user: null, error: 'Token rejected by Hugging Face (401). Create a new read token and try again.' };
        if (!res.ok) return { valid: false, user: null, error: 'Hugging Face answered HTTP ' + res.status + ' — saved anyway, downloads may fail.' };
        const data = await res.json().catch(() => ({}));
        return { valid: true, user: data && data.name ? String(data.name) : null, error: null };
    } catch (err) {
        return { valid: false, user: null, error: 'Could not reach Hugging Face (' + (err.message || err) + ') — saved anyway, retry verification later.' };
    }
}

// --- Status ---------------------------------------------------------------------

let cachedObjectInfo = null;
let cachedObjectInfoAt = 0;

async function getCachedObjectInfo() {
    if (cachedObjectInfo && Date.now() - cachedObjectInfoAt < 30000) return cachedObjectInfo;
    const info = await comfyui.getObjectInfo(30000);
    cachedObjectInfo = info;
    cachedObjectInfoAt = Date.now();
    return info;
}

function formatBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB';
    if (n >= 1024 ** 2) return Math.round(n / 1024 / 1024) + ' MB';
    return Math.round(n / 1024) + ' KB';
}

// Pull a filename choice list out of /object_info. Loader nodes expose the
// list directly as the first tuple item (UNETLoader unet_name, CLIPLoader
// clip_name, VAELoader vae_name, LoraLoader lora_name); COMBO widgets
// (SeedVR2 loaders, UpscaleModelLoader) carry it under [1].options.
function choiceList(info, nodeName, field) {
    try {
        const node = info && info[nodeName];
        const entry = node && node.input && node.input.required && node.input.required[field];
        if (!Array.isArray(entry)) return [];
        if (Array.isArray(entry[0])) return entry[0].map(String);
        if (entry[1] && Array.isArray(entry[1].options)) return entry[1].options.map(String);
    } catch {
        // unknown shape — no choices
    }
    return [];
}

// Filenames ComfyUI itself reports as loadable, per models/ subfolder. This
// is the authoritative "can generate" signal: installs with symlinked,
// junctioned, or extra-path model folders (Comfy Desktop, Mix Studio
// downloads) resolve here even when the plain filesystem scan misses them.
function seenChoices(info) {
    const set = (arr) => new Set(arr);
    return {
        diffusion_models: set(choiceList(info, 'UNETLoader', 'unet_name')),
        text_encoders: set(choiceList(info, 'CLIPLoader', 'clip_name')),
        vae: set(choiceList(info, 'VAELoader', 'vae_name')),
        loras: set(choiceList(info, 'LoraLoader', 'lora_name')),
        seedvr2dit: set(choiceList(info, 'SeedVR2LoadDiTModel', 'model')),
        seedvr2vae: set(choiceList(info, 'SeedVR2LoadVAEModel', 'model')),
        upscale_models: set(choiceList(info, 'UpscaleModelLoader', 'model_name'))
    };
}

async function getStatus() {
    const status = {
        comfyAvailable: false,
        modelRoot: null,
        comfyRoot: null,
        token: { configured: false, source: null, user: null, masked: null },
        models: [],
        nodes: [],
        ready: { image: false, video: false, upscale: false, edit: false },
        job: jobState()
    };

    const token = configManager.getHuggingFaceToken();
    if (token) {
        const stored = configManager.getHuggingFace();
        status.token.configured = true;
        status.token.source = (process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN) ? 'env' : 'settings';
        status.token.user = stored.user || null;
        status.token.masked = token.length > 7 ? token.slice(0, 3) + '…' + token.slice(-4) : '•••';
    }

    if (!(await comfyui.isAvailable())) return status;
    status.comfyAvailable = true;

    let modelRoot = null;
    try { modelRoot = await getModelRoot(); } catch { modelRoot = null; }
    status.modelRoot = modelRoot;
    try { status.comfyRoot = await comfyui.resolveComfyRoot(); } catch { status.comfyRoot = null; }

    let info = null;
    try { info = await getCachedObjectInfo(); } catch { info = null; }
    const seen = seenChoices(info);

    const installedById = {};
    for (const entry of MODEL_CATALOG) {
        const resolved = resolveCatalogEntry(entry);
        let found = null;
        if (modelRoot && resolved.filename) {
            const dirs = [path.join(modelRoot, resolved.dest)]
                .concat((entry.also || []).map((d) => path.join(modelRoot, d)));
            for (const dir of dirs) {
                const hit = filePresent(dir, resolved.filename, entry.minBytes);
                if (hit) { found = hit; break; }
            }
        }
        // ComfyUI's own loader lists win when the filesystem scan misses
        // (symlinked / extra-path model folders). Size is unknown then.
        const seenKey = entry.seen || resolved.dest;
        const seenInstalled = Boolean(info && resolved.filename && seen[seenKey] && seen[seenKey].has(resolved.filename));
        installedById[entry.id] = Boolean(found) || seenInstalled;
        const installed = Boolean(found) || seenInstalled;
        status.models.push({
            ...resolved,
            installed,
            size: found ? found.size : 0,
            sizeLabel: found ? formatBytes(found.size) : (seenInstalled ? 'in ComfyUI' : (resolved.approxMB ? '≈' + (resolved.approxMB >= 1000 ? (resolved.approxMB / 1000).toFixed(1) + ' GB' : resolved.approxMB + ' MB') : '—')),
            foundPath: found ? found.path : null
        });
    }

    for (const pack of NODE_CATALOG) {
        const present = {};
        for (const name of pack.nodes) present[name] = Boolean(info && info[name]);
        const missing = pack.nodes.filter((n) => !present[n]);
        let packInstalled = null;
        if (status.comfyRoot && pack.dir) {
            packInstalled = fs.existsSync(path.join(status.comfyRoot, 'custom_nodes', pack.dir));
        }
        status.nodes.push({
            id: pack.id,
            label: pack.label,
            required: pack.required,
            nodes: pack.nodes,
            present,
            missing,
            ready: info ? missing.length === 0 : null,
            packInstalled,
            repo: pack.repo,
            installable: Boolean(pack.repo),
            nvidiaOnly: Boolean(pack.nvidiaOnly),
            note: pack.note
        });
    }

    const has = (id) => Boolean(installedById[id]);
    const nodeReady = (id) => {
        const pack = status.nodes.find((n) => n.id === id);
        return pack ? pack.ready === true : false;
    };
    status.ready.image = has('krea2_unet') && has('krea2_clip') && has('krea2_vae');
    status.ready.video = has('h3_unet_t2va') && has('h3_clip') && has('h3_video_vae') && has('h3_audio_vae') && nodeReady('vhs') && nodeReady('h3_native');
    status.ready.upscale = has('seedvr2_dit') && has('seedvr2_vae') && nodeReady('seedvr2_native');
    status.ready.edit = has('krea2_edit_lora') && nodeReady('krea2edit');
    return status;
}

module.exports = {
    MODEL_CATALOG,
    NODE_CATALOG,
    getStatus,
    verifyToken,
    startDownload,
    startNodeInstall,
    jobState,
    resolveCatalogEntry
};
