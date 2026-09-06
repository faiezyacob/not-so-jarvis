/* ============================================
   JARVIS — Image Generation Service
   Detects image-generation intent, builds the
   Krea2 text-to-image workflow graph, submits it
   to ComfyUI, and stores the finished image so
   the chat layer can display it.
   ============================================ */

const fs = require('fs');
const path = require('path');
const comfyui = require('./comfyui');
const configManager = require('../server/config-manager');

const GENERATED_DIR = path.join(__dirname, '..', 'data', 'generated');

// --- One generation at a time -------------------------------------------------

const MAX_GENERATIONS = 1;
let activeGeneration = 0;

function canStartGeneration() {
    return activeGeneration < MAX_GENERATIONS;
}

async function withGenerationLock(fn) {
    if (!canStartGeneration()) {
        const error = new Error('An image generation is already in progress. Please wait for it to finish.');
        error.code = 'generation_busy';
        throw error;
    }
    activeGeneration += 1;
    try {
        return await fn();
    } finally {
        activeGeneration -= 1;
    }
}

// --- Intent detection ----------------------------------------------------------

// Level 1 fast heuristic: explicit image vocabulary. Catches the obvious
// requests without needing the LLM.
const IMAGE_MEDIA_WORDS = [
    'image', 'picture', 'photo', 'photograph', 'portrait', 'art', 'artwork',
    'illustration', 'drawing', 'painting', 'comic', 'shot', 'scene', 'view',
    'screenshot', 'wallpaper', 'poster', 'logo', 'avatar', 'meme', 'graphic',
    'landscape', 'interior'
];
const GENERATION_VERBS = [
    'generate', 'create', 'make', 'render', 'produce', 'paint', 'draw',
    'imagine', 'design', 'illustrate', 'compose', 'show'
];
const IMAGE_WORD_RE = new RegExp('\\b(?:' + IMAGE_MEDIA_WORDS.join('|') + ')\\b', 'i');
const GENERATION_VERB_RE = new RegExp(
    '^(?:please\\s+)?(?:' + GENERATION_VERBS.join('|') +
    ')(?:\\s+(?:me|us|a|an|the))?\\b', 'i'
);
// "X of [subject]" pattern where X is itself an image word ("image of",
// "portrait of", "photo of", ...).
const IMAGE_OF_RE = new RegExp(
    '\\b(?:' + IMAGE_MEDIA_WORDS.join('|') + ')\\s+of\\b', 'i'
);

const IMAGE_INTENT_SYSTEM_PROMPT =
    'You are JARVIS, a local AI assistant. Decide whether the user is asking you to ' +
    'GENERATE AN IMAGE (text-to-image) or asking a normal chat question.\n\n' +
    'Respond with ONLY a single JSON object, no markdown, no commentary. Use exactly one of ' +
    'these two shapes:\n' +
    '{"intent": "image_generation", "prompt": "the image subject without extraneous chat words"}\n' +
    '{"intent": "chat", "message": "the original user message"}\n\n' +
    'Treat requests like "generate an image of X", "create a picture of X", "make a photo of X", ' +
    '"render X", "draw X as a ...", "generate a cinematic bedroom interior" as image_generation. ' +
    'For image_generation, extract ONLY the visual subject/description into the prompt field, ' +
    'dropping phrases like "generate an image of". Normal questions (facts, code help, math, ' +
    'summaries, reports, text output) must be chat.';

// Returns 'definite' | 'likely' | null. "definite" means the message clearly
// asks for an image (explicit image vocabulary). "likely" means it opens with
// a generation verb but has no explicit image word — worth asking the LLM.
function imageRequestStrength(message) {
    if (IMAGE_OF_RE.test(message)) return 'definite';
    if (GENERATION_VERB_RE.test(message)) {
        if (IMAGE_WORD_RE.test(message)) return 'definite';
        return 'likely';
    }
    return null;
}

// Use the configured LLM to classify intent. Returns
// { intent: 'image_generation', prompt } | { intent: 'chat', message }.
async function detectIntent(message, providers, provider, model) {
    const strength = imageRequestStrength(message);

    if (strength === 'definite') {
        // The heuristic is confident; still let the LLM refine the extracted
        // prompt subject when available, falling back to the heuristic extract.
        const { prompt } = extractImageSubject(message);
        if (prompt) return { intent: 'image_generation', prompt };
        return { intent: 'chat', message };
    }

    // Normal chat questions never reach the LLM.
    if (strength === null) {
        return { intent: 'chat', message };
    }

    // "likely" — verb-led but no image word. Ask the LLM so requests like
    // "Generate a cinematic bedroom interior." still work while "Generate a
    // summary of today's meetings." stays a chat response.
    const cluesPrompt =
        'User message: "' + message + '"\n\n' +
        'Output the JSON classification only.';

    try {
        const raw = await providers.chat(provider, [
            { role: 'system', content: IMAGE_INTENT_SYSTEM_PROMPT },
            { role: 'user', content: cluesPrompt }
        ], model);

        const parsed = parseIntentJson(raw);
        if (parsed && parsed.intent === 'image_generation') {
            const prompt = String(parsed.prompt || '').trim();
            if (prompt) {
                return { intent: 'image_generation', prompt };
            }
        }
    } catch (err) {
        console.warn('[image-generator] LLM intent detection failed, using heuristic:', err.message);
    }

    // LLM unavailable or said "chat" — safe default.
    return { intent: 'chat', message };
}

function parseIntentJson(raw) {
    if (!raw) return null;
    let text = String(raw).trim();
    // Strip markdown fences if the model wrapped the JSON in a code block.
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) text = fenced[1].trim();

    const braceStart = text.indexOf('{');
    const braceEnd = text.lastIndexOf('}');
    if (braceStart === -1 || braceEnd === -1 || braceEnd <= braceStart) return null;
    text = text.slice(braceStart, braceEnd + 1);

    try {
        return JSON.parse(text);
    } catch (err) {
        return null;
    }
}

// Heuristic fallback: strip the generation verb phrase and the "image of"
// preamble to get the visual subject ("Generate an image of a futuristic
// Tokyo street" -> "a futuristic Tokyo street"). Used directly for "definite"
// requests and as a fallback when the LLM is unavailable.
function extractImageSubject(message) {
    let cleaned = String(message || '').trim();

    // Strip leading politeness + generation verb + articles.
    cleaned = cleaned
        .replace(/^(please\s+)?/i, '')
        .replace(/^(?:generate|create|make|render|produce|paint|draw|imagine|design|illustrate|compose|show)\s+(?:me|us)?\s*(?:an?|the)?\s+/i, '')
        .replace(/^(?:i\s+(?:want|'?d like|would like|need)|give\s+me)\s+(?:an?|the)?\s*/i, '')
        .trim();

    // "X of <subject>" where X is an image word — keep only the subject.
    const media = IMAGE_MEDIA_WORDS.join('|');
    const ofMatch = cleaned.match(new RegExp('\\b(?:' + media + ')\\s+of\\s+(.+)$', 'i'));
    if (ofMatch) {
        cleaned = ofMatch[1].trim();
    }

    cleaned = cleaned
        .replace(/\s+(?:please|thanks|thank you)(?:[!.]+)?$/i, '')
        .replace(/[.!?]+$/, '')
        .trim();

    return { prompt: cleaned };
}

// --- Krea2 text-to-image workflow ----------------------------------------------
//
// Adapted from Mix Studio's working Krea2 pipeline (server.js buildT2I +
// krea2-workflows.js buildKrea2LatentInput + krea2-model.js). This produce the
// exact same ComfyUI API graph Mix Studio submits for a plain text-to-image job:
//
//   UNETLoader (krea2 turbo)  →  CLIPLoader (krea2)  →  VAELoader
//   CLIPTextEncode (positive = prompt, negative = zero-out)
//   EmptySD3LatentImage
//   KSampler (euler / beta, steps 8, cfg 1, seed from settings)
//   VAEDecode → SaveImage (KreaStudio/gen)

const DEFAULT_SETTINGS = {
    unet: process.env.KREA2_UNET || 'krea2_turbo_fp8_scaled.safetensors',
    clip: process.env.KREA2_CLIP || 'Huihui-Qwen3-VL-4B-Instruct-abliterated-fp8_scaled.safetensors',
    clipType: process.env.KREA2_CLIP_TYPE || 'krea2',
    vae: process.env.KREA2_VAE || 'wan_2.1_vae.safetensors',
    width: Number(process.env.KREA2_WIDTH) || 1024,
    height: Number(process.env.KREA2_HEIGHT) || 1024,
    steps: Number(process.env.KREA2_STEPS) || 8,
    cfg: Number(process.env.KREA2_CFG) || 1,
};

// Fields the user may override through the settings panel / API. Kept
// separate from DEFAULT_SETTINGS so we only persist explicit overrides.
const CONFIGURABLE_KEYS = ['unet', 'clip', 'clipType', 'vae', 'width', 'height', 'steps', 'cfg'];

// Effective settings = env-driven defaults merged with any globally stored
// overrides from data/config.json (see config-manager).
function effectiveSettings() {
    const stored = configManager.getImageSettings();
    const settings = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(settings)) {
        const value = stored[key];
        if (value !== undefined && value !== null && value !== '') {
            settings[key] = value;
        }
    }
    return settings;
}

function getDefaults() {
    return { ...DEFAULT_SETTINGS };
}

function sanitizeSettings(patch) {
    const out = {};
    for (const key of CONFIGURABLE_KEYS) {
        if (!(key in patch)) continue;
        const value = patch[key];
        if (value === null) { out[key] = null; continue; }
        if (key === 'width' || key === 'height' || key === 'steps') {
            const n = Math.round(Number(value));
            if (Number.isFinite(n) && n > 0) out[key] = n;
        } else if (key === 'cfg') {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 0) out[key] = n;
        } else if (typeof value === 'string') {
            const s = value.trim();
            out[key] = s || null;
        }
    }
    return out;
}

function saveSettings(patch) {
    const cleaned = sanitizeSettings(patch || {});
    if (!Object.keys(cleaned).length) return effectiveSettings();
    configManager.setImageSettings(cleaned);
    return effectiveSettings();
}

// List the UNET / CLIP / VAE files ComfyUI currently has on disk, for the
// settings UI. Returns null when ComfyUI is unreachable so the UI can fall
// back to free-text entries.
async function getModelChoices() {
    try {
        if (!(await comfyui.isAvailable())) return null;
        const info = await comfyui.getObjectInfo(10000);
        const required = (node, field) => {
            const list = node && node.input && node.input.required && node.input.required[field];
            return Array.isArray(list) && Array.isArray(list[0]) ? list[0] : [];
        };
        return {
            unets: required(info.UNETLoader, 'unet_name'),
            clips: required(info.CLIPLoader, 'clip_name'),
            vaes: required(info.VAELoader, 'vae_name')
        };
    } catch {
        return null;
    }
}

function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function diffusionModelLoader(unetName) {
    const name = String(unetName || '').trim();
    if (/\.gguf$/i.test(name)) {
        return { class_type: 'UnetLoaderGGUF', inputs: { unet_name: name } };
    }
    return { class_type: 'UNETLoader', inputs: { unet_name: name, weight_dtype: 'default' } };
}

function buildKrea2T2IGraph(prompt, options = {}) {
    const settings = Object.assign({}, DEFAULT_SETTINGS, options.settings || {});
    const seed = Number.isInteger(options.seed) && options.seed >= 0 ? options.seed : 0;
    const width = clampInt(options.width || settings.width, 64, 4096, settings.width);
    const height = clampInt(options.height || settings.height, 64, 4096, settings.height);
    const steps = clampInt(options.steps || settings.steps, 1, 100, settings.steps);
    const cfg = Number.isFinite(Number(options.cfg)) ? Math.max(0, Number(options.cfg)) : settings.cfg;
    const negative = String(options.negativePrompt || '').trim();

    const graph = {};
    graph.unet = diffusionModelLoader(settings.unet);
    graph.clip = { class_type: 'CLIPLoader', inputs: { clip_name: settings.clip, type: settings.clipType, device: 'default' } };
    graph.vae = { class_type: 'VAELoader', inputs: { vae_name: settings.vae } };

    graph.pos = { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: String(prompt || '') } };
    graph.neg = negative
        ? { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: negative } }
        : { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['pos', 0] } };

    graph.latent = {
        class_type: 'EmptySD3LatentImage',
        inputs: { width, height, batch_size: 1 }
    };

    graph.sampler = {
        class_type: 'KSampler',
        inputs: {
            model: ['unet', 0],
            positive: ['pos', 0],
            negative: ['neg', 0],
            latent_image: ['latent', 0],
            seed,
            steps,
            cfg,
            sampler_name: 'euler',
            scheduler: 'beta',
            denoise: 1
        }
    };

    graph.decode = { class_type: 'VAEDecode', inputs: { samples: ['sampler', 0], vae: ['vae', 0] } };
    graph.save = { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'KreaStudio/gen' } };

    return graph;
}

// Validate that ComfyUI knows the required node classes and models. Called
// after the graph is built so we can surface clean, specific errors (missing
// custom nodes, missing models, unsupported clip type).
async function validateGraphAgainstComfy(info, graph) {
    const missingNodes = [];
    for (const node of Object.values(graph)) {
        if (!info[node.class_type]) missingNodes.push(node.class_type);
    }
    if (missingNodes.length) {
        const error = new Error(
            'ComfyUI is missing custom node' + (missingNodes.length > 1 ? 's' : '') + ': ' +
            missingNodes.join(', ') + '. Install them (and restart ComfyUI), then try again.'
        );
        error.code = 'comfyui_missing_nodes';
        error.missingNodes = missingNodes;
        throw error;
    }

    const clipInfo = info.CLIPLoader;
    if (clipInfo && clipInfo.input && clipInfo.input.required && clipInfo.input.required.type) {
        const typeChoices = clipInfo.input.required.type[0];
        if (Array.isArray(typeChoices) && !typeChoices.includes('krea2')) {
            const error = new Error(
                'This ComfyUI build does not support the krea2 CLIPLoader type. ' +
                'Update ComfyUI, then try again.'
            );
            error.code = 'comfyui_krea2_clip_unsupported';
            throw error;
        }
    }
}

// --- Generation ----------------------------------------------------------------

function ensureGeneratedDir() {
    if (!fs.existsSync(GENERATED_DIR)) {
        fs.mkdirSync(GENERATED_DIR, { recursive: true });
    }
}

function safeFilename(name) {
    return String(name || 'x').replace(/[^a-z0-9._-]/gi, '_').replace(/_+/g, '_').slice(0, 100) || 'x';
}

// Generate an image from a text prompt and write it into data/generated.
// Returns { url, filename, width, height }.
async function generateImage(prompt, options = {}) {
    return withGenerationLock(async () => {
        await ensureGeneratedDir();

        const seed = Number.isInteger(options.seed) && options.seed >= 0
            ? options.seed
            : Math.floor(Math.random() * 2 ** 32);
        // Prefer a fresh read of the global settings so edits made through
        // the settings panel take effect without restarting the server.
        const settings = effectiveSettings();
        const graph = buildKrea2T2IGraph(prompt, Object.assign({}, options, { seed, settings }));

        const info = await comfyui.getObjectInfo();
        await validateGraphAgainstComfy(info, graph);

        const pid = await comfyui.queuePrompt(graph);
        console.log('[image-generator] queued Krea2 workflow:', pid);

        const history = await comfyui.waitForPrompt(pid, {
            timeoutMs: options.timeoutMs
        });

        const files = comfyui.findOutputFiles(history.outputs || {}, /\.(?:png|jpg|jpeg|webp)$/i);
        if (!files.length) {
            const error = new Error('ComfyUI finished but produced no image file.');
            error.code = 'comfyui_output_not_found';
            throw error;
        }

        // The last output file is the finished image.
        const entry = files[files.length - 1];
        const buffer = await comfyui.downloadImage(entry);

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const extension = path.extname(entry.filename).toLowerCase() || '.png';
        const basename = safeFilename(buffer.toString('hex', 0, 4)) + '_' + stamp + extension;
        const filePath = path.join(GENERATED_DIR, basename);
        fs.writeFileSync(filePath, buffer);

        console.log('[image-generator] saved image:', basename, '(' + buffer.length + ' bytes)');
        return {
            url: '/generated/' + encodeURIComponent(basename),
            filename: basename,
            width: settings.width,
            height: settings.height,
            prompt
        };
    });
}

module.exports = {
    GENERATED_DIR,
    IMAGE_INTENT_SYSTEM_PROMPT,
    DEFAULT_SETTINGS,
    canStartGeneration,
    detectIntent,
    imageRequestStrength,
    extractImageSubject,
    generateImage,
    buildKrea2T2IGraph,
    validateGraphAgainstComfy,
    effectiveSettings,
    getDefaults,
    saveSettings,
    getModelChoices
};