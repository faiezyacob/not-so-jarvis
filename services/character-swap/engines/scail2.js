/* ============================================
   JARVIS — SCAIL-2 Character Swap engine
   Official SCAIL-2 replacement mode through the
   ComfyUI-native WanSCAILToVideo node. SAM 3.1
   tracks the selected target and renders the
   identity-coloured reference + driving masks.

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
const metrics = require('../metrics');
const scailGraph = require('./scail2-graph');
const scailPrompt = require('./scail2-prompt');
const shared = require('./scail2-shared');

const ID = 'scail2';
const LABEL = 'SCAIL-2';

const PREPROCESS_VERSION = 'scail2-prepare-v1';

// Ordered from lightest to highest fidelity. GGUF files load through
// UnetLoaderGGUF (models/unet); the full-precision safetensors loads through
// the ordinary UNETLoader (models/diffusion_models), never the GGUF loader.
const MODEL_VARIANTS = Object.freeze([
    {
        id: 'q2_k',
        label: 'Q2_K — ~6 GB',
        file: 'SCAIL-2-Q2_K.gguf',
        loader: 'gguf',
        approxGB: 5.6,
        description: 'Smallest quant. Runs on minimal VRAM but expect visible quality loss.'
    },
    {
        id: 'q3_k_m',
        label: 'Q3_K_M — ~8.1 GB',
        file: 'SCAIL-2-Q3_K_M.gguf',
        loader: 'gguf',
        approxGB: 7.6,
        description: 'Budget tier. Better coherence than Q2 while staying under ~8 GB.'
    },
    {
        id: 'q4_k_m',
        label: 'Q4_K_M — ~10 GB (recommended)',
        file: 'SCAIL-2-Q4_K_M.gguf',
        loader: 'gguf',
        approxGB: 10.1,
        description: 'Recommended daily driver. Best balance of quality and 16 GB VRAM headroom.'
    },
    {
        id: 'q5_k_m',
        label: 'Q5_K_M — ~12 GB',
        file: 'SCAIL-2-Q5_K_M.gguf',
        loader: 'gguf',
        approxGB: 11.4,
        description: 'Sweet spot above Q4 when you can spare a little more VRAM.'
    },
    {
        id: 'q6_k',
        label: 'Q6_K — ~14 GB',
        file: 'SCAIL-2-Q6_K.gguf',
        loader: 'gguf',
        approxGB: 12.8,
        description: 'Higher fidelity. Tight on a 16 GB card once SAM 3.1 and activations are resident.'
    },
    {
        id: 'q8_0',
        label: 'Q8_0 — ~17 GB',
        file: 'SCAIL-2-Q8_0.gguf',
        loader: 'gguf',
        approxGB: 16.5,
        description: 'Closest GGUF to FP16. Exceeds 16 GB of VRAM; expect heavy offload and slow renders.'
    },
    {
        id: 'fp16',
        label: 'FP16 — full precision, ~30.5 GB',
        file: 'wan2.1_14B_SCAIL_2_fp16.safetensors',
        loader: 'safetensors',
        approxGB: 30.5,
        description: 'Full-precision SCAIL-2 from Comfy-Org. Lives in models/diffusion_models and uses UNETLoader, not the GGUF loader. Needs far more than 16 GB and heavy offload.'
    }
]);

const DEFAULT_MODEL_FILE = MODEL_VARIANTS.find((variant) => variant.id === 'q4_k_m').file;

function isGgufFile(name) {
    return /\.gguf$/i.test(String(name || ''));
}

function variantFor(file) {
    const name = String(file || '').trim();
    return MODEL_VARIANTS.find((variant) => variant.file.toLowerCase() === name.toLowerCase()) || null;
}

function listVariants(info) {
    return MODEL_VARIANTS.map((variant) => {
        const loader = variant.loader === 'gguf' ? 'UnetLoaderGGUF' : 'UNETLoader';
        const installed = Boolean(info && scailGraph.hasChoice(info, loader, 'unet_name', variant.file));
        return Object.assign({}, variant, { installed });
    });
}

const DEFAULTS = Object.freeze({
    unet: process.env.SCAIL2_UNET || DEFAULT_MODEL_FILE,
    samModel: process.env.SCAIL2_SAM_MODEL || 'sam3.1_multiplex_fp16.safetensors',
    textEncoder: process.env.SCAIL2_TEXT_ENCODER || 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
    vae: process.env.SCAIL2_VAE || 'wan_2.1_vae.safetensors',
    clipVision: process.env.SCAIL2_CLIP_VISION || 'clip_vision_h.safetensors',
    accelerationLora: process.env.SCAIL2_ACCEL_LORA || 'Wan21_I2V_14B_lightx2v_cfg_step_distill_lora_rank64.safetensors',
    relightLora: process.env.SCAIL2_RELIGHT_LORA || 'wan2.1_SCAIL_2_relight_lora_bf16.safetensors',
    dpoLora: process.env.SCAIL2_DPO_LORA || 'wan2.1_SCAIL_2_DPO_lora_bf16.safetensors',
    fps: shared.FPS,
    resolution: process.env.SCAIL2_RESOLUTION === '720p' ? '720p' : '480p',
    steps: Number(process.env.SCAIL2_STEPS) || 6,
    cfg: process.env.SCAIL2_CFG === undefined ? 1 : Number(process.env.SCAIL2_CFG),
    shift: Number(process.env.SCAIL2_SHIFT) || 5,
    windowFrames: scailGraph.WINDOW_FRAMES,
    timeoutMs: Number(process.env.SCAIL2_TIMEOUT_MS) || 60 * 60 * 1000
});

const REQUIRED_NODES = [
    'WanSCAILToVideo',
    'SCAIL2ColoredMask',
    'SAM3_Detect',
    'SAM3_VideoTrack',
    'CheckpointLoaderSimple',
    'CLIPLoader',
    'CLIPTextEncode',
    'CLIPVisionLoader',
    'CLIPVisionEncode',
    'VAELoader',
    'LoadImage',
    'LoadVideo',
    'GetVideoComponents',
    'ImageFromBatch',
    'ModelSamplingSD3',
    'BasicScheduler',
    'KSamplerSelect',
    'SamplerCustom',
    'VAEDecode',
    'CreateVideo',
    'SaveVideo'
];

const INFINITY_NODE = 'WanSCAILInfinity';
const PRESET_STEPS = Object.freeze({ draft: 4, standard: DEFAULTS.steps, quality: 8 });

const GENERATED_DIR = process.env.GENERATED_DIR || path.join(__dirname, '..', '..', '..', 'data', 'generated');

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function safeName(value) {
    return String(value || 'scail2').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40);
}

function finite(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function truthy(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return !['0', 'false', 'off', 'no'].includes(String(value).toLowerCase());
}

function normalizeSettings(input = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const preset = ['draft', 'standard', 'quality'].includes(String(source.preset)) ? String(source.preset) : 'standard';
    // The per-project setting wins so the UI can switch variants even when the
    // environment supplies a default. The loader is always derived from the
    // file extension: .gguf -> UnetLoaderGGUF, otherwise UNETLoader.
    const unet = String(source.unet || process.env.SCAIL2_UNET || DEFAULTS.unet);
    const gguf = isGgufFile(unet);
    const modelVariant = variantFor(unet);
    const steps = Math.round(Math.max(1, Math.min(100, finite(source.steps, PRESET_STEPS[preset] || DEFAULTS.steps))));
    return {
        preset,
        resolution: (source.resolution || DEFAULTS.resolution) === '720p' ? '720p' : '480p',
        width: Math.max(0, Math.min(2048, Math.round(finite(source.width, 0)))),
        height: Math.max(0, Math.min(2048, Math.round(finite(source.height, 0)))),
        steps,
        cfg: Math.max(0, Math.min(20, finite(source.cfg, DEFAULTS.cfg))),
        shift: Math.max(1, Math.min(20, finite(source.shift, DEFAULTS.shift))),
        sampler: String(source.sampler || 'euler').slice(0, 40),
        scheduler: String(source.scheduler || 'simple').slice(0, 40),
        poseStrength: Math.max(0, Math.min(10, finite(source.poseStrength, 1))),
        poseStart: Math.max(0, Math.min(1, finite(source.poseStart, 0))),
        poseEnd: Math.max(0, Math.min(1, finite(source.poseEnd, 1))),
        seedMode: source.seedMode === 'fixed' ? 'fixed' : 'random',
        seed: source.seed === null || source.seed === undefined || source.seed === ''
            ? null
            : Math.max(0, Math.round(Number(source.seed) || 0)),
        durationMode: source.durationMode === 'fixed' ? 'fixed' : 'match',
        durationSeconds: source.durationSeconds === null || source.durationSeconds === undefined || source.durationSeconds === ''
            ? null
            : Math.max(1, Math.min(scailGraph.MAX_SECONDS, finite(source.durationSeconds, scailGraph.MAX_SECONDS))),
        positive: String(source.positive || '').slice(0, 4000),
        negative: String(source.negative || '').slice(0, 4000),
        unet,
        modelVariant: modelVariant ? modelVariant.id : null,
        modelLabel: modelVariant ? modelVariant.label : unet,
        gguf,
        loadWithGguf: gguf,
        samModel: String(process.env.SCAIL2_SAM_MODEL || source.samModel || DEFAULTS.samModel),
        textEncoder: String(process.env.SCAIL2_TEXT_ENCODER || source.textEncoder || DEFAULTS.textEncoder),
        vae: String(process.env.SCAIL2_VAE || source.vae || DEFAULTS.vae),
        clipVision: String(process.env.SCAIL2_CLIP_VISION || source.clipVision || DEFAULTS.clipVision),
        accelerationLora: String(process.env.SCAIL2_ACCEL_LORA || source.accelerationLora || DEFAULTS.accelerationLora),
        accelerationStrength: Math.max(0, Math.min(2, finite(source.accelerationStrength, 0.8))),
        relight: truthy(process.env.SCAIL2_RELIGHT, truthy(source.relight, true)),
        relightLora: String(process.env.SCAIL2_RELIGHT_LORA || source.relightLora || DEFAULTS.relightLora),
        relightStrength: Math.max(0, Math.min(2, finite(source.relightStrength, 1))),
        dpo: truthy(process.env.SCAIL2_DPO, truthy(source.dpo, false)),
        dpoLora: String(process.env.SCAIL2_DPO_LORA || source.dpoLora || DEFAULTS.dpoLora),
        dpoStrength: Math.max(0, Math.min(2, finite(source.dpoStrength, 1))),
        chunkFeedForward: truthy(process.env.SCAIL2_CHUNK_FF, truthy(source.chunkFeedForward, true)),
        chunkFeedForwardChunks: Math.round(Math.max(1, Math.min(100, finite(source.chunkFeedForwardChunks, 4)))),
        chunkFeedForwardDim: Math.round(Math.max(1024, Math.min(16384, finite(source.chunkFeedForwardDim, 4096)))),
        requireInfinity: truthy(source.requireInfinity, true),
        fps: shared.FPS,
        maxSeconds: scailGraph.MAX_SECONDS,
        windowFrames: scailGraph.WINDOW_FRAMES
    };
}

function availability(info, inputSettings = {}) {
    const settings = normalizeSettings(inputSettings);
    const missing = [];
    const warnings = [];
    if (!info || typeof info !== 'object') {
        return { id: ID, label: LABEL, available: false, missing: ['ComfyUI is not reachable.'], warnings };
    }
    for (const name of REQUIRED_NODES) {
        if (!Object.prototype.hasOwnProperty.call(info, name)) missing.push('ComfyUI node "' + name + '"');
    }
    const loader = settings.loadWithGguf ? 'UnetLoaderGGUF' : 'UNETLoader';
    if (!Object.prototype.hasOwnProperty.call(info, loader)) {
        missing.push('ComfyUI node "' + loader + '"');
    }
    if (settings.requireInfinity && !Object.prototype.hasOwnProperty.call(info, INFINITY_NODE)) {
        missing.push('ComfyUI node "' + INFINITY_NODE + '" (comfyui-scail2-infinity)');
    }
    if (!missing.length) {
        if (!scailGraph.hasChoice(info, loader, 'unet_name', settings.unet)) {
            missing.push('SCAIL-2 diffusion model "' + settings.unet + '"');
        }
        if (!scailGraph.hasChoice(info, 'CheckpointLoaderSimple', 'ckpt_name', settings.samModel)) {
            missing.push('SAM 3.1 checkpoint "' + settings.samModel + '" (ComfyUI/models/checkpoints)');
        }
        if (!scailGraph.hasChoice(info, 'CLIPLoader', 'clip_name', settings.textEncoder)) {
            missing.push('UMT5 text encoder "' + settings.textEncoder + '"');
        }
        if (!scailGraph.hasChoice(info, 'VAELoader', 'vae_name', settings.vae)) {
            missing.push('Wan VAE "' + settings.vae + '"');
        }
        if (!scailGraph.hasChoice(info, 'CLIPVisionLoader', 'clip_name', settings.clipVision)) {
            missing.push('CLIP Vision "' + settings.clipVision + '"');
        }
        if (settings.accelerationLora && !scailGraph.hasChoice(info, 'LoraLoaderModelOnly', 'lora_name', settings.accelerationLora)) {
            warnings.push('The LightX2V acceleration LoRA "' + settings.accelerationLora + '" is not installed; SCAIL-2 will use more sampling steps.');
        }
        if (settings.relight && settings.relightLora && !scailGraph.hasChoice(info, 'LoraLoaderModelOnly', 'lora_name', settings.relightLora)) {
            warnings.push('The SCAIL-2 relighting LoRA "' + settings.relightLora + '" is not installed; replacement runs without it.');
        }
        if (settings.dpo && settings.dpoLora && !scailGraph.hasChoice(info, 'LoraLoaderModelOnly', 'lora_name', settings.dpoLora)) {
            warnings.push('The SCAIL-2 DPO LoRA "' + settings.dpoLora + '" is not installed; it is skipped.');
        }
        const types = scailGraph.choiceList(info, 'CLIPLoader', 'type');
        if (types.length && !types.map((type) => type.toLowerCase()).includes('wan')) {
            missing.push('ComfyUI CLIPLoader type "wan"');
        }
        if (settings.chunkFeedForward && !Object.prototype.hasOwnProperty.call(info, 'WanChunkFeedForward')) {
            warnings.push('WanChunkFeedForward is not installed; peak VRAM will be higher.');
        }
    }
    return { id: ID, label: LABEL, available: missing.length === 0, missing, warnings };
}

function preflight(inputSettings, stats) {
    const settings = normalizeSettings(inputSettings);
    const device = stats && stats.devices && stats.devices[0];
    const freeBytes = Number(device && device.vram_free) || 0;
    const freeRam = Number(stats && stats.system && stats.system.ram_free) || 0;
    const variant = variantFor(settings.unet);
    const modelMB = variant
        ? Math.round(variant.approxGB * 1024)
        : (settings.gguf ? 10300 : 30600);
    // Model weights plus SAM 3.1, the VAE and the attention workspace. A larger
    // quant or FP16 is blocked early with an actionable message instead of
    // letting ComfyUI OOM mid-render.
    const requiredMB = Math.max(6500, modelMB + 2400 + (settings.resolution === '720p' ? 1800 : 0));
    return {
        freeVramMB: Math.round(freeBytes / (1024 * 1024)),
        requiredVramMB: requiredMB,
        modelMB,
        variant: variant ? variant.id : null,
        freeRamMB: Math.round(freeRam / (1024 * 1024)),
        ramOk: freeRam === 0 || freeRam >= 8 * 1024 ** 3,
        ok: freeBytes >= requiredMB * 1024 * 1024,
        preset: settings.preset
    };
}

function validateGraph(info, graph) {
    scailGraph.validateGraph(info, graph);
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
    const dir = ensureDir(path.join(plan.projectDir, 'scail2'));
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

    if (opts.onStage) opts.onStage('Preparing the driving video at 24 fps');
    const durationLimit = Number(plan.durationSeconds) > 0 ? Number(plan.durationSeconds) : undefined;
    const source = await media.conformExact(plan.sourceVideoPath, sourcePath, {
        fps: shared.FPS,
        width: settings.width,
        height: settings.height,
        duration: durationLimit,
        audio: true,
        crf: 16,
        fit: 'crop'
    });
    const frames = Math.max(1, Math.round((source.duration || 0) * shared.FPS));
    meta = {
        key,
        width: settings.width,
        height: settings.height,
        fps: shared.FPS,
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

async function render(plan, options = {}) {
    const queueOpts = {
        label: options.label || 'character swap (SCAIL-2)',
        kind: options.kind || 'video_generation',
        conversationId: options.conversationId || null,
        onQueued: options.onQueued || null,
        onStart: options.onStart || null
    };
    return generationQueue.enqueue(async (signal) => {
        ensureDir(GENERATED_DIR);
        const settings = normalizeSettings(Object.assign({}, plan.settings, options.settings));
        // One SCAIL-2 pass per selected character; the passes run in sequence and
        // each one drives on the previous pass's output, so both replacements end
        // up in the same video.
        const fallbackTarget = plan.people && plan.people[0];
        const targets = (Array.isArray(plan.targets) && plan.targets.length)
            ? plan.targets.slice()
            : (fallbackTarget
                ? [Object.assign({}, fallbackTarget, { points: plan.points, subjectDescription: fallbackTarget.subjectDescription || null })]
                : []);
        if (!targets.length) throw new Error('Select the person to replace before rendering with SCAIL-2.');
        targets.forEach((target, index) => {
            if (!target.referencePath || !fs.existsSync(target.referencePath)) {
                throw new Error('Upload a character image for ' + (target.place ? 'the person ' + target.place : target.label || ('person ' + (index + 1))) + ' before rendering with SCAIL-2.');
            }
            const points = target.points || plan.points;
            if (!points || !Array.isArray(points.positive) || !points.positive.length) {
                throw new Error('A selected person has no usable tracking points. Detect people again and select the target.');
            }
            target.points = points;
        });
        if (!settings.width || !settings.height) {
            const dims = shared.dimensionsFor(1280, 720, settings);
            settings.width = dims.width;
            settings.height = dims.height;
        }
        plan.settings = settings;
        const info = await comfyui.getObjectInfo();
        const status = availability(info, settings);
        if (!status.available) {
            const error = new Error('SCAIL-2 is not ready: ' + status.missing.join('; '));
            error.code = 'scail2_unavailable';
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
        const takeId = options.takeId || ('scail2_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'));
        const takeDir = ensureDir(path.join(plan.projectDir, 'takes', takeId));
        const sampler = metrics.startSampler();
        const uploaded = [];
        try {
            onStage('Preparing SCAIL-2');
            const prepared = await prepare(plan, { info, signal, onStage });
            const positive = plan.prompt || scailPrompt.buildScailPrompt({
                userPrompt: settings.positive,
                people: targets,
                identitySummary: targets.length === 1 ? targets[0].identitySummary : undefined,
                description: targets.length === 1 ? targets[0].description : undefined,
                subject: targets.length === 1 ? targets[0].subjectDescription || null : undefined,
                scene: plan.sceneDescription
            });
            const negative = shared.buildNegativePrompt(settings.negative);

            // Optional adapters are only wired when the file is actually installed;
            // otherwise the graph would reference a missing LoRA and fail validation.
            const accelerationLora = settings.accelerationLora && scailGraph.hasChoice(info, 'LoraLoaderModelOnly', 'lora_name', settings.accelerationLora)
                ? settings.accelerationLora : null;
            const relightLora = settings.relight && settings.relightLora && scailGraph.hasChoice(info, 'LoraLoaderModelOnly', 'lora_name', settings.relightLora)
                ? settings.relightLora : null;
            const dpoLora = settings.dpo && settings.dpoLora && scailGraph.hasChoice(info, 'LoraLoaderModelOnly', 'lora_name', settings.dpoLora)
                ? settings.dpoLora : null;
            const effectiveSettings = Object.assign({}, settings, { accelerationLora });

            const passes = [];
            const windows = [];
            let drivingPath = prepared.sourcePath;
            let drivingFrames = prepared.frames;
            let lastBuilt = null;
            for (let index = 0; index < targets.length; index += 1) {
                const target = targets[index];
                const passLabel = targets.length > 1
                    ? 'Replacing ' + (target.place ? 'the person ' + target.place : target.label || ('person ' + (index + 1))) +
                        ' (' + (index + 1) + ' of ' + targets.length + ')'
                    : 'Generating with SCAIL-2';
                onStage(passLabel);
                const referenceName = await uploadFile(target.referencePath, 'jarvis_scail2_ref', 'image/png');
                uploaded.push(referenceName);
                const performanceName = await uploadFile(drivingPath, 'jarvis_scail2_drive', 'video/mp4');
                uploaded.push(performanceName);
                const planWindows = scailGraph.windowPlan(drivingFrames);
                const built = scailGraph.buildGraph({
                    settings: effectiveSettings,
                    width: settings.width,
                    height: settings.height,
                    frames: drivingFrames,
                    windowPlan: planWindows,
                    positive,
                    negative,
                    seed: seed + index,
                    referenceName,
                    performanceName,
                    points: target.points,
                    anchorFrame: target.anchorFrame || target.points.anchorFrame || 0,
                    relightLora,
                    dpoLora,
                    chunkFeedForward: settings.chunkFeedForward && Object.prototype.hasOwnProperty.call(info, 'WanChunkFeedForward'),
                    decodeTiled: settings.resolution === '720p'
                });
                validateGraph(info, built.graph);
                const pid = await comfyui.queuePrompt(built.graph);
                const history = await comfyui.waitForPrompt(pid, {
                    timeoutMs: DEFAULTS.timeoutMs,
                    signal
                });
                const entry = outputEntryForNode(history, 'save');
                if (!entry) throw new Error('SCAIL-2 produced no video.');
                const buffer = await comfyui.downloadImage(entry);
                await comfyui.deleteOutputFile(entry, { history: pid }).catch(() => {});
                const passVideo = path.join(takeDir, 'pass-' + index + '.mp4');
                fs.writeFileSync(passVideo, buffer);
                const windowEntry = {
                    pass: index,
                    index: 0,
                    seed: seed + index,
                    sourceStart: 0,
                    keep: built.plan.frames,
                    drop: 0,
                    mode: built.plan.mode,
                    windowCount: built.plan.windows,
                    status: 'done',
                    file: passVideo,
                    prompt: positive
                };
                windows.push(windowEntry);
                passes.push({
                    pass: index,
                    personId: target.id,
                    label: target.label,
                    video: passVideo,
                    windows: [windowEntry]
                });
                lastBuilt = built;
                drivingPath = passVideo;
                const probedPass = await media.probeVideo(passVideo).catch(() => null);
                drivingFrames = Math.max(1, Math.round(((probedPass && probedPass.duration) || prepared.duration || 0) * shared.FPS));
            }

            const finalPass = passes[passes.length - 1];
            onStage('Muxing the original audio');
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const basename = safeName(path.basename(plan.sourceVideoPath, path.extname(plan.sourceVideoPath))) +
                '_scail2_' + stamp + '_' + crypto.randomBytes(3).toString('hex') + '.mp4';
            const outputPath = path.join(GENERATED_DIR, basename);
            await media.muxAudio(finalPass.video, prepared.audioPath, outputPath, {
                hasAudio: prepared.hasAudio
            });
            const probed = await media.probeVideo(outputPath).catch(() => null);
            const duration = (probed && probed.duration) || prepared.duration || (lastBuilt.plan.frames / shared.FPS);
            const outputFrames = Math.max(1, Math.round(duration * shared.FPS));
            const metaWindows = windows.map((entry) => {
                const clean = Object.assign({}, entry);
                delete clean.file;
                return clean;
            });
            const meta = generatedHistory.add({
                file: '/generated/' + encodeURIComponent(basename),
                rawFilename: basename,
                conversationId: options.conversationId || null,
                prompt: positive,
                model: 'SCAIL-2',
                modelFile: settings.unet,
                modelVariant: settings.modelVariant || null,
                width: settings.width,
                height: settings.height,
                seed,
                generationMs: Date.now() - startedAt,
                video: {
                    duration,
                    frames: outputFrames,
                    fps: shared.FPS,
                    mode: 'character-swap',
                    engine: ID,
                    videoPipeline: 'scail-2',
                    modelFile: settings.unet,
                    modelVariant: settings.modelVariant || null,
                    loader: settings.gguf ? 'UnetLoaderGGUF' : 'UNETLoader',
                    rawPrompt: settings.positive,
                    replacementMode: true,
                    sceneCaptured: Boolean(plan.sceneDescription && plan.sceneDescription.summary),
                    subject: targets.length === 1 ? targets[0].subjectDescription || null : null,
                    targets: targets.map((target) => ({
                        personId: target.id,
                        label: target.label,
                        place: target.place || null,
                        trackId: target.trackId || null,
                        anchorFrame: target.anchorFrame || null,
                        referenceImage: path.basename(target.referencePath)
                    })),
                    windows: metaWindows,
                    passes: passes.length,
                    resolution: { width: settings.width, height: settings.height },
                    preset: settings.preset,
                    steps: settings.steps,
                    cfg: settings.cfg,
                    shift: settings.shift,
                    windowLength: scailGraph.WINDOW_FRAMES,
                    previousFrameCount: scailGraph.PREVIOUS_FRAMES,
                    referenceImage: path.basename(targets[0].referencePath),
                    target: targets.length === 1 ? {
                        personId: targets[0].id,
                        label: targets[0].label,
                        trackId: targets[0].trackId || null,
                        anchorFrame: targets[0].anchorFrame || null
                    } : null,
                    loras: {
                        acceleration: accelerationLora,
                        accelerationStrength: settings.accelerationStrength,
                        relight: relightLora,
                        dpo: dpoLora
                    },
                    preserveAudio: prepared.hasAudio,
                    audioPolicy: prepared.hasAudio ? 'fully_copy' : 'none',
                    background: { strategy: 'scail2-replacement', guaranteed: true },
                    facialControl: {
                        engine: 'SCAIL2',
                        input: 'pose_video',
                        source: 'original-video',
                        textPromptOnly: false
                    },
                    audio: {
                        source: prepared.hasAudio ? 'original-soundtrack' : 'none',
                        generatedSpeech: false,
                        muxedFromSource: prepared.hasAudio,
                        lipSyncGuaranteed: false
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
                frames: outputFrames,
                fps: shared.FPS,
                engine: ID,
                windows,
                passes,
                prompt: positive,
                generationMs: meta.generationMs,
                metrics: peaks,
                meta,
                takeId
            };
        } catch (err) {
            await sampler.stop().catch(() => {});
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
    INFINITY_NODE,
    PREPROCESS_VERSION,
    MODEL_VARIANTS,
    DEFAULT_MODEL_FILE,
    isGgufFile,
    variantFor,
    listVariants,
    normalizeSettings,
    availability,
    preflight,
    validateGraph,
    prepare,
    render,
    dimensionsFor: shared.dimensionsFor
};
