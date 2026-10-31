/* ============================================
   JARVIS — Wan Animate 2 engine
   Single-reference character animation through
   the native WanAnimate2ToVideo node. A scene
   prompt describes the shot; the performance
   video supplies motion, expression and audio.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const comfyui = require('../../comfyui');
const generationQueue = require('../../generation-queue');
const generatedHistory = require('../../generated-history');

const media = require('../media');
const wanAnimate2 = require('./wan-animate2');
const wanSwapPrompt = require('./wan-animate2-prompt');
const wanPrompt = require('./wan-prompt');
const metrics = require('../metrics');

const ID = 'wan_animate';
const LABEL = 'Wan Animate 2';

// Bumped whenever the cached Wan preparation changes shape.
const PREPROCESS_VERSION = 'wan-animate2-prepare-v1';

const DEFAULTS = Object.freeze({
    unet: process.env.WAN_ANIMATE_UNET || 'wan_animate_2_int8_convrot.safetensors',
    textEncoder: process.env.WAN_ANIMATE_TEXT_ENCODER || 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
    vae: process.env.WAN_ANIMATE_VAE || 'wan_2.1_vae.safetensors',
    clipVision: process.env.WAN_ANIMATE_CLIP_VISION || 'clip_vision_h.safetensors',
    lightx2v: process.env.WAN_ANIMATE_LIGHTX2V_LORA || 'lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors',
    fps: wanAnimate2.FPS,
    resolution: process.env.WAN_ANIMATE_RESOLUTION === '720p' ? '720p' : '480p',
    steps: wanAnimate2.STEPS,
    shift: wanAnimate2.SHIFT,
    windowFrames: wanAnimate2.WINDOW_FRAMES,
    timeoutMs: Number(process.env.WAN_ANIMATE_TIMEOUT_MS) || 45 * 60 * 1000
});

const REQUIRED_NODES = [
    'WanAnimate2ToVideo',
    'UNETLoader',
    'LoraLoaderModelOnly',
    'ModelSamplingSD3',
    'CLIPLoader',
    'CLIPTextEncode',
    'CLIPVisionLoader',
    'CLIPVisionEncode',
    'VAELoader',
    'LoadImage',
    'LoadVideo',
    'GetVideoComponents',
    'ResizeImageMaskNode',
    'ImageFromBatch',
    'BasicScheduler',
    'KSamplerSelect',
    'SamplerCustom',
    'TrimVideoLatent',
    'VAEDecode',
    'CreateVideo',
    'SaveVideo'
];

const PRESET_STEPS = Object.freeze({ draft: 4, standard: wanAnimate2.STEPS, quality: 8 });

const GENERATED_DIR = process.env.GENERATED_DIR || path.join(__dirname, '..', '..', '..', 'data', 'generated');

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function safeName(value) {
    return String(value || 'wan').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40);
}

function choiceList(info, nodeName, field) {
    try {
        const entry = info && info[nodeName] && info[nodeName].input && info[nodeName].input.required &&
            info[nodeName].input.required[field];
        if (Array.isArray(entry) && Array.isArray(entry[0])) return entry[0].map(String);
    } catch {
        // fall through
    }
    return [];
}

function hasChoice(info, nodeName, field, name) {
    const list = choiceList(info, nodeName, field);
    if (!list.length) return false;
    return list.some((item) => String(item).trim().toLowerCase() === String(name).trim().toLowerCase());
}

function isAnimate2Model(name) {
    return /animate[\s_.-]?2/i.test(String(name || ''));
}

function finite(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function normalizeSettings(input = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const preset = ['draft', 'standard', 'quality'].includes(String(source.preset)) ? String(source.preset) : 'standard';
    const steps = Math.round(Math.max(1, Math.min(30, finite(source.steps, PRESET_STEPS[preset] || DEFAULTS.steps))));
    return {
        preset,
        resolution: (source.resolution || DEFAULTS.resolution) === '720p' ? '720p' : '480p',
        width: Math.max(0, Math.min(2048, Math.round(finite(source.width, 0)))),
        height: Math.max(0, Math.min(2048, Math.round(finite(source.height, 0)))),
        steps,
        cfg: 1,
        shift: DEFAULTS.shift,
        length: wanAnimate2.WINDOW_FRAMES,
        overlap: 1,
        blockify: 0,
        relight: false,
        identityStrength: Math.max(0, Math.min(2, finite(source.identityStrength, 1))),
        motionStrength: Math.max(0, Math.min(2, finite(source.motionStrength, 1))),
        seedMode: source.seedMode === 'fixed' ? 'fixed' : 'random',
        seed: source.seed === null || source.seed === undefined || source.seed === '' ? null : Math.max(0, Math.round(Number(source.seed) || 0)),
        durationMode: source.durationMode === 'fixed' ? 'fixed' : 'match',
        durationSeconds: source.durationSeconds === null || source.durationSeconds === undefined || source.durationSeconds === ''
            ? null
            : Math.max(1, Math.min(wanAnimate2.MAX_SECONDS, finite(source.durationSeconds, wanAnimate2.MAX_SECONDS))),
        positive: String(source.positive || '').slice(0, 4000),
        negative: String(source.negative || '').slice(0, 4000),
        unet: String(process.env.WAN_ANIMATE_UNET || source.unet || DEFAULTS.unet),
        textEncoder: String(process.env.WAN_ANIMATE_TEXT_ENCODER || source.textEncoder || DEFAULTS.textEncoder),
        vae: String(process.env.WAN_ANIMATE_VAE || source.vae || DEFAULTS.vae),
        clipVision: String(process.env.WAN_ANIMATE_CLIP_VISION || source.clipVision || DEFAULTS.clipVision),
        lightx2v: String(process.env.WAN_ANIMATE_LIGHTX2V_LORA || source.lightx2v || DEFAULTS.lightx2v),
        fps: wanAnimate2.FPS,
        maxSeconds: wanAnimate2.MAX_SECONDS
    };
}

function availability(info, inputSettings = {}) {
    const settings = normalizeSettings(inputSettings);
    const missing = [];
    const warnings = [];
    if (!info || typeof info !== 'object') {
        return { id: ID, label: LABEL, available: false, missing: ['ComfyUI is not reachable.'], warnings };
    }
    for (const node of REQUIRED_NODES) {
        if (!Object.prototype.hasOwnProperty.call(info, node)) missing.push('ComfyUI node "' + node + '"');
    }
    if (REQUIRED_NODES.every((node) => Object.prototype.hasOwnProperty.call(info, node))) {
        if (!hasChoice(info, 'UNETLoader', 'unet_name', settings.unet)) {
            missing.push('Wan Animate 2 diffusion model "' + settings.unet + '"');
        } else if (!isAnimate2Model(settings.unet)) {
            missing.push('The configured Wan model "' + settings.unet + '" is not Wan Animate 2 (WanAnimate2ToVideo).');
        }
        if (!hasChoice(info, 'CLIPLoader', 'clip_name', settings.textEncoder)) {
            missing.push('UMT5 text encoder "' + settings.textEncoder + '"');
        }
        if (!hasChoice(info, 'VAELoader', 'vae_name', settings.vae)) {
            missing.push('Wan VAE "' + settings.vae + '"');
        }
        if (!hasChoice(info, 'CLIPVisionLoader', 'clip_name', settings.clipVision)) {
            missing.push('CLIP Vision "' + settings.clipVision + '"');
        }
        if (!hasChoice(info, 'LoraLoaderModelOnly', 'lora_name', settings.lightx2v)) {
            missing.push('LightX2V acceleration LoRA "' + settings.lightx2v + '"');
        }
        const types = choiceList(info, 'CLIPLoader', 'type');
        if (types.length && !types.map((t) => t.toLowerCase()).includes('wan')) {
            missing.push('ComfyUI CLIPLoader type "wan"');
        }
        const sampler = choiceList(info, 'KSamplerSelect', 'sampler_name');
        if (sampler.length && !sampler.map((name) => name.toLowerCase()).includes('lcm')) {
            warnings.push('The "lcm" sampler is not listed by this ComfyUI build; Wan Animate 2 expects it.');
        }
    }
    return { id: ID, label: LABEL, available: missing.length === 0, missing, warnings };
}

function preflight(inputSettings, stats) {
    const settings = normalizeSettings(inputSettings);
    const device = stats && stats.devices && stats.devices[0];
    const freeBytes = Number(device && device.vram_free) || 0;
    const freeRam = Number(stats && stats.system && stats.system.ram_free) || 0;
    const requiredMB = settings.resolution === '720p' ? 9000 : (settings.preset === 'draft' ? 4500 : 6000);
    return {
        freeVramMB: Math.round(freeBytes / (1024 * 1024)),
        requiredVramMB: requiredMB,
        freeRamMB: Math.round(freeRam / (1024 * 1024)),
        ramOk: freeRam === 0 || freeRam >= 6 * 1024 ** 3,
        ok: freeBytes >= requiredMB * 1024 * 1024,
        preset: settings.preset
    };
}

function validateGraph(info, graph) {
    for (const [key, node] of Object.entries(graph)) {
        if (!node || !node.class_type) continue;
        if (!Object.prototype.hasOwnProperty.call(info, node.class_type)) {
            const error = new Error('ComfyUI is missing the node "' + node.class_type + '" (used as "' + key + '").');
            error.code = 'wan_animate_node_missing';
            throw error;
        }
    }
}

// --- Preparation --------------------------------------------------------------

function cacheKeyFor(plan, settings) {
    const hash = crypto.createHash('sha1');
    hash.update(PREPROCESS_VERSION);
    hash.update(String(plan.projectId || ''));
    hash.update(String(plan.sourceVideoPath || ''));
    try {
        const stat = fs.statSync(plan.sourceVideoPath);
        hash.update(String(stat.size) + ':' + String(stat.mtimeMs));
    } catch {
        // missing source is reported by conform
    }
    hash.update([settings.width, settings.height, settings.fps, plan.durationSeconds || ''].join(':'));
    return hash.digest('hex').slice(0, 16);
}

async function prepare(plan, opts = {}) {
    const settings = plan.settings;
    const dir = ensureDir(path.join(plan.projectDir, 'wan-animate2'));
    const key = cacheKeyFor(plan, settings);
    const cacheDir = ensureDir(path.join(dir, key));
    const metaPath = path.join(cacheDir, 'meta.json');
    const sourcePath = path.join(cacheDir, 'performance.mp4');
    let meta = null;
    try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
        meta = null;
    }
    if (meta && fs.existsSync(sourcePath)) {
        return Object.assign({}, meta, { sourcePath, audioPath: sourcePath });
    }

    if (opts.onStage) opts.onStage('Preparing the performance video at 24 fps');
    const durationLimit = Number(plan.durationSeconds) > 0 ? Number(plan.durationSeconds) : undefined;
    const source = await media.conformExact(plan.sourceVideoPath, sourcePath, {
        fps: wanAnimate2.FPS,
        width: settings.width,
        height: settings.height,
        duration: durationLimit,
        audio: true,
        crf: 16,
        fit: 'pad'
    });
    const frames = Math.max(1, Math.round((source.duration || 0) * wanAnimate2.FPS));
    meta = {
        key,
        width: settings.width,
        height: settings.height,
        fps: wanAnimate2.FPS,
        frames,
        hasAudio: Boolean(source.hasAudio),
        duration: source.duration,
        createdAt: new Date().toISOString()
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    return Object.assign({}, meta, { sourcePath, audioPath: sourcePath });
}

// --- Rendering ----------------------------------------------------------------

async function uploadFile(absPath, prefix, mime) {
    const buffer = fs.readFileSync(absPath);
    const uploaded = await comfyui.uploadFile(buffer, prefix + '_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex') + '_' + path.basename(absPath), {
        mime: mime || 'video/mp4'
    });
    return uploaded.name;
}

function normalizeSeed(value) {
    return Number.isInteger(value) && value >= 0 ? value : Math.floor(Math.random() * 2 ** 32);
}

function outputEntryForNode(history, nodeId, extRe) {
    const output = history && history.outputs && history.outputs[nodeId];
    if (!output) return null;
    const files = comfyui.findOutputFiles(output, extRe || /\.(?:mp4|webm|mov|mkv)$/i);
    return files.length ? files[files.length - 1] : null;
}

async function runWindow(opts) {
    const {
        plan, settings, prepared, window, seed, continuationPath, takeDir,
        referenceName, performanceName, signal, info, onStage, positive
    } = opts;
    const uploaded = [];
    try {
        onStage('Animating · window ' + (window.index + 1) + ' of ' + opts.windowCount);
        let continuationName = null;
        if (continuationPath) {
            continuationName = await uploadFile(continuationPath, 'jarvis_wan2_cont', 'image/png');
            uploaded.push(continuationName);
        }
        const negative = wanPrompt.buildNegativePrompt(settings.negative);
        const graph = wanAnimate2.buildGraph({
            settings,
            width: settings.width,
            height: settings.height,
            positive,
            negative,
            referenceName,
            performanceName,
            continuationImageName: continuationName,
            segment: window,
            seed,
            identityStrength: settings.identityStrength,
            motionStrength: settings.motionStrength
        });
        validateGraph(info, graph);
        const pid = await comfyui.queuePrompt(graph);
        const history = await comfyui.waitForPrompt(pid, {
            timeoutMs: DEFAULTS.timeoutMs,
            signal
        });
        const entry = outputEntryForNode(history, 'save');
        if (!entry) throw new Error('Wan Animate 2 produced no video for this window.');
        const buffer = await comfyui.downloadImage(entry);
        await comfyui.deleteOutputFile(entry, { history: pid }).catch(() => {});
        const file = path.join(takeDir, 'window-' + window.index + '.mp4');
        fs.writeFileSync(file, buffer);
        return {
            pass: 0,
            index: window.index,
            seed,
            file,
            sourceStart: window.startFrame,
            keep: window.keepFrames,
            drop: window.overlapFrames,
            status: 'done',
            prompt: positive
        };
    } finally {
        for (const name of uploaded) await comfyui.deleteInputFile(name).catch(() => {});
    }
}

async function render(plan, options = {}) {
    const queueOpts = {
        label: options.label || 'character swap (Wan Animate 2)',
        kind: options.kind || 'video_generation',
        conversationId: options.conversationId || null,
        onQueued: options.onQueued || null,
        onStart: options.onStart || null
    };
    return generationQueue.enqueue(async (signal) => {
        ensureDir(GENERATED_DIR);
        const settings = normalizeSettings(Object.assign({}, plan.settings, options.settings));
        if (!settings.width || !settings.height) {
            const dims = wanAnimate2.dimensionsFor(1280, 720, settings);
            settings.width = dims.width;
            settings.height = dims.height;
        }
        plan.settings = settings;
        const info = await comfyui.getObjectInfo();
        const status = availability(info, settings);
        if (!status.available) {
            const error = new Error('Wan Animate 2 is not ready: ' + status.missing.join('; '));
            error.code = 'wan_animate_unavailable';
            error.missing = status.missing;
            throw error;
        }
        const seed = settings.seedMode === 'fixed' && settings.seed !== null
            ? settings.seed
            : normalizeSeed(options.seed);
        const startedAt = Date.now();
        const onStage = (text) => {
            if (typeof options.onStage === 'function') {
                try { options.onStage(text); } catch { /* best-effort */ }
            }
        };
        const projectDir = plan.projectDir;
        const takeId = options.takeId || ('wan_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'));
        const takeDir = ensureDir(path.join(projectDir, 'takes', takeId));
        const sampler = metrics.startSampler();
        const windows = [];
        const uploaded = [];
        try {
            onStage('Preparing Wan Animate 2');
            if (!plan.people || !plan.people.length || !plan.people[0].referencePath) {
                throw new Error('Upload one character reference image before rendering with Wan Animate 2.');
            }
            if (!fs.existsSync(plan.people[0].referencePath)) {
                throw new Error('The character reference image is missing.');
            }
            const prepared = await prepare(plan, { info, signal, onStage });
            const enhancedPrompt = wanSwapPrompt.buildSwapPrompt({
                userPrompt: plan.prompt || settings.positive,
                identitySummary: plan.people[0].identitySummary,
                scene: plan.sceneDescription
            });
            const continuation = wanAnimate2.continuationPlan({
                sourceFrames: prepared.frames,
                sourceFps: prepared.fps,
                requestedSeconds: plan.durationSeconds
            });
            const referenceName = await uploadFile(plan.people[0].referencePath, 'jarvis_wan2_ref', 'image/png');
            uploaded.push(referenceName);
            const performanceName = await uploadFile(prepared.sourcePath, 'jarvis_wan2_perf', 'video/mp4');
            uploaded.push(performanceName);

            const resume = options.resume && typeof options.resume === 'object' ? options.resume : null;
            const existing = new Map();
            if (resume && Array.isArray(resume.windows)) {
                for (const window of resume.windows) {
                    if (window && window.status === 'done' && window.file && fs.existsSync(window.file)) {
                        existing.set(window.index, window);
                    }
                }
            }
            let previousWindow = null;
            let previousKeep = 0;
            for (const segment of continuation.segments) {
                if (signal && signal.aborted) {
                    const error = new Error('The Wan render was cancelled.');
                    error.code = 'cancelled';
                    throw error;
                }
                let continuationPath = null;
                if (previousWindow) {
                    continuationPath = path.join(takeDir, 'continuation-' + segment.index + '.png');
                    await media.extractFrame(previousWindow, Math.max(0, previousKeep - 1), continuationPath);
                }
                const prior = existing.get(segment.index);
                if (prior) {
                    windows.push(prior);
                    previousWindow = prior.file;
                    previousKeep = Number(prior.keep) || segment.keepFrames;
                    continue;
                }
                const result = await runWindow({
                    plan,
                    settings,
                    prepared,
                    window: segment,
                    windowCount: continuation.windowCount,
                    seed: seed + segment.index,
                    continuationPath,
                    takeDir,
                    referenceName,
                    performanceName,
                    signal,
                    info,
                    onStage,
                    positive: enhancedPrompt
                });
                windows.push(result);
                previousWindow = result.file;
                previousKeep = result.keep;
            }

            onStage('Stitching the Wan Animate 2 windows');
            const passVideo = path.join(takeDir, 'pass-0.mp4');
            if (windows.length === 1) {
                fs.copyFileSync(windows[0].file, passVideo);
            } else {
                await media.concatVideos(windows.map((window) => window.file), passVideo);
            }
            onStage('Muxing the original audio');
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const basename = safeName(path.basename(plan.sourceVideoPath, path.extname(plan.sourceVideoPath))) +
                '_wan2_' + stamp + '_' + crypto.randomBytes(3).toString('hex') + '.mp4';
            const outputPath = path.join(GENERATED_DIR, basename);
            await media.muxAudio(passVideo, prepared.audioPath, outputPath, {
                hasAudio: prepared.hasAudio
            });
            const duration = continuation.outputFrames / continuation.fps;
            const finalPrompt = enhancedPrompt;
            const meta = generatedHistory.add({
                file: '/generated/' + encodeURIComponent(basename),
                rawFilename: basename,
                conversationId: options.conversationId || null,
                prompt: finalPrompt,
                model: 'Wan Animate 2',
                width: settings.width,
                height: settings.height,
                seed,
                generationMs: Date.now() - startedAt,
                video: {
                    duration,
                    frames: continuation.outputFrames,
                    fps: continuation.fps,
                    mode: 'character-swap',
                    engine: ID,
                    videoPipeline: 'wan-animate-2',
                    rawPrompt: plan.prompt || settings.positive,
                    sceneCaptured: Boolean(plan.sceneDescription && plan.sceneDescription.summary),
                    windows: windows.map((item) => ({
                        index: item.index,
                        seed: item.seed,
                        sourceStart: item.sourceStart,
                        keep: item.keep,
                        drop: item.drop
                    })),
                    resolution: { width: settings.width, height: settings.height },
                    preset: settings.preset,
                    steps: settings.steps,
                    shift: settings.shift,
                    windowLength: wanAnimate2.WINDOW_FRAMES,
                    overlap: 1,
                    referenceImage: path.basename(plan.people[0].referencePath),
                    preserveAudio: prepared.hasAudio,
                    audioPolicy: prepared.hasAudio ? 'fully_copy' : 'none',
                    background: { strategy: 'wan-animate-2', guaranteed: false },
                    facialControl: {
                        engine: 'WanAnimate2ToVideo',
                        input: 'pose_video',
                        source: 'original-video',
                        textPromptOnly: false
                    },
                    audio: {
                        source: prepared.hasAudio ? 'original-soundtrack' : 'none',
                        generatedSpeech: false,
                        muxedFromSource: prepared.hasAudio
                    }
                }
            });
            const peaks = await sampler.stop();
            return {
                url: meta.file,
                filename: basename,
                width: settings.width,
                height: settings.height,
                duration,
                frames: continuation.outputFrames,
                fps: continuation.fps,
                engine: ID,
                windows,
                passes: [{ pass: 0, personId: plan.people[0].id, label: plan.people[0].label, video: passVideo, windows }],
                prompt: finalPrompt,
                generationMs: meta.generationMs,
                metrics: peaks,
                meta,
                takeId
            };
        } catch (err) {
            await sampler.stop().catch(() => {});
            err.windows = windows;
            err.passes = windows.length
                ? [{ pass: 0, personId: plan.people && plan.people[0] && plan.people[0].id, label: plan.people && plan.people[0] && plan.people[0].label, video: null, windows }]
                : [];
            err.engine = ID;
            err.takeId = takeId;
            throw err;
        } finally {
            for (const name of uploaded) await comfyui.deleteInputFile(name).catch(() => {});
        }
    }, queueOpts);
}

module.exports = {
    id: ID,
    ID,
    label: LABEL,
    LABEL,
    DEFAULTS,
    REQUIRED_NODES,
    PREPROCESS_VERSION,
    normalizeSettings,
    availability,
    preflight,
    buildGraph: wanAnimate2.buildGraph,
    validateGraph,
    prepare,
    render,
    continuationPlan: wanAnimate2.continuationPlan,
    dimensionsFor: wanAnimate2.dimensionsFor
};
