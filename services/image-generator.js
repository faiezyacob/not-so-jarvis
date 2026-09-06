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
const generatedHistory = require('./generated-history');

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
    'You are JARVIS, a local AI assistant. Classify whether the user wants to generate an ' +
    'image, and if so, extract structured data from their request.\n\n' +
    'Respond with ONLY a single JSON object, no markdown, no commentary.\n\n' +
    'For image generation requests, use this exact shape:\n' +
    '{"intent": "image_generation", "user_prompt": "the actual image concept", ' +
    '"creative_mode": "none|light|full", "explicit_constraints": []}\n\n' +
    'For normal chat questions, use this exact shape:\n' +
    '{"intent": "chat", "message": "the original user message"}\n\n' +
    'Classification rules:\n' +
    '- "generate an image of X", "create a picture of X", "make a photo of X", ' +
    '"render X", "draw X as a ...", "generate a cinematic bedroom interior" → image_generation\n' +
    '- Normal questions (facts, code, math, summaries, reports, text output) → chat\n\n' +
    'user_prompt rules:\n' +
    '- Extract ONLY the visual concept the user wants to see.\n' +
    '- Remove verb preambles ("generate an image of", "create a picture of", etc.).\n' +
    '- Remove meta-instructions about HOW to generate ("be creative", "surprise me").\n' +
    '- Keep all visual details: subject descriptions, clothing, poses, locations, colors, style.\n\n' +
    'creative_mode rules:\n' +
    '- "none": No creative freedom requested. Default when user just asks for an image.\n' +
    '- "light": User requests a specific enhancement like "make it cinematic", ' +
    '"dramatic lighting", "professional composition", "make it moody".\n' +
    '- "full": User explicitly says "be creative", "surprise me", "use your imagination", ' +
    '"go wild", "do your thing", "whatever you think looks best".\n\n' +
    'explicit_constraints rules:\n' +
    '- Array of strings for any explicit constraints the user states ' +
    '(e.g., "must be in black and white", "no text", "landscape orientation").\n' +
    '- Empty array [] if none.';

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
// { intent: 'image_generation', user_prompt, creative_mode, explicit_constraints }
// or { intent: 'chat', message }.
async function detectIntent(message, providers, provider, model) {
    const strength = imageRequestStrength(message);

    if (strength === null) {
        return { intent: 'chat', message };
    }

    // For both "definite" and "likely" image requests, call the LLM to get
    // structured data including creative_mode and explicit constraints. This
    // ensures meta-instructions like "be creative" are separated from the
    // actual image concept.
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
            const user_prompt = String(parsed.user_prompt || '').trim();
            if (user_prompt) {
                return {
                    intent: 'image_generation',
                    user_prompt,
                    creative_mode: parsed.creative_mode || 'none',
                    explicit_constraints: Array.isArray(parsed.explicit_constraints)
                        ? parsed.explicit_constraints
                        : []
                };
            }
        }
    } catch (err) {
        console.warn('[image-generator] LLM intent detection failed, using heuristic:', err.message);
    }

    // LLM unavailable or said "chat" — for "definite" requests, fall back to
    // heuristic extraction with meta-instruction cleanup.
    if (strength === 'definite') {
        const { prompt } = extractImageSubject(message);
        if (prompt) {
            return {
                intent: 'image_generation',
                user_prompt: stripCreativeMetaInstructions(prompt),
                creative_mode: 'none',
                explicit_constraints: []
            };
        }
    }

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

// Strip creative meta-instructions that leak into heuristic-extracted prompts
// when the LLM is unavailable. Preserves visual descriptions ("with dramatic
// lighting") but removes process-level instructions ("be creative").
function stripCreativeMetaInstructions(text) {
    return text
        .replace(/[,;]\s*(?:but\s+)?(?:i\s+)?(?:want|'?d like|would like|need)\s+you\s+to\s+be\s+(?:as\s+)?creative(?:(?:\s+(?:as\s+(?:you\s+)?(?:want|like|can)|as\s+possible|with\s+it))+)?\.?\s*/i, '')
        .replace(/[,;]\s*(?:but\s+)?(?:please\s+)?be\s+(?:as\s+)?creative(?:(?:\s+(?:as\s+(?:you\s+)?(?:want|like|can)|as\s+possible|with\s+it))+)?\.?\s*/i, '')
        .replace(/[,;]\s*(?:but\s+)?(?:surprise\s+me|use\s+your\s+imagination|be\s+imaginative|go\s+wild|do\s+your\s+thing|whatever\s+you\s+think\s+looks\s+best)(?:\s+with\s+it)?\.?\s*/i, '')
        .replace(/\s*,?\s*with\s+it\.?$/i, '')
        .trim();
}

// --- Prompt Builder -------------------------------------------------------------

const PROMPT_BUILDER_SYSTEM_PROMPT =
    'You are a prompt builder for an image-generation model (Krea2).\n\n' +
    'The user\'s original image concept is the source of truth.\n' +
    'Preserve every explicit requirement.\n\n' +
    'If creative_mode is "none", only clarify and improve the request without ' +
    'materially changing it.\n' +
    'If creative_mode is "light", enhance only the requested aspects.\n' +
    'If creative_mode is "full", creatively expand secondary visual details ' +
    'while preserving the user\'s core concept and all explicit constraints.\n\n' +
    'What you may enhance based on creative_mode:\n' +
    '- Lighting and atmosphere\n' +
    '- Environment details and textures\n' +
    '- Composition and framing\n' +
    '- Camera angle and lens\n' +
    '- Visual storytelling and mood\n' +
    '- Background details\n\n' +
    'What you must NEVER change regardless of creative_mode:\n' +
    '- The subject (person, animal, object, scene)\n' +
    '- Explicit attributes (clothing color, hair, pose, action)\n' +
    '- The location/setting the user specified\n' +
    '- Any explicit constraint the user stated\n\n' +
    'Never replace, contradict, remove, or reinterpret the user\'s intent.\n' +
    'Output ONLY the final image-generation prompt. No explanations, no quotes, no markdown.';

// Use the conversational model to build the final image-generation prompt from
// the structured intent data. Falls back to the raw user_prompt on failure.
async function buildImagePrompt(structuredRequest, providers, provider, model) {
    const { user_prompt, creative_mode, explicit_constraints } = structuredRequest;

    const userMessage =
        'user_prompt: "' + user_prompt + '"\n' +
        'creative_mode: "' + (creative_mode || 'none') + '"\n' +
        'explicit_constraints: ' + JSON.stringify(explicit_constraints || []) + '\n\n' +
        'Build the final image-generation prompt. Output ONLY the prompt text.';

    try {
        const raw = await providers.chat(provider, [
            { role: 'system', content: PROMPT_BUILDER_SYSTEM_PROMPT },
            { role: 'user', content: userMessage }
        ], model);

        const prompt = String(raw || '').trim();
        if (prompt) return prompt;
    } catch (err) {
        console.warn('[image-generator] Prompt builder failed, using raw prompt:', err.message);
    }

    return user_prompt;
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
    // Stacked LoRAs applied to every Krea2 generation, in order. Each entry
    // is { name, strength, on } where strength is the model+clip LoRA scale.
    loras: [],
};

// Fields the user may override through the settings panel / API. Kept
// separate from DEFAULT_SETTINGS so we only persist explicit overrides.
const CONFIGURABLE_KEYS = ['unet', 'clip', 'clipType', 'vae', 'width', 'height', 'steps', 'cfg', 'loras'];

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

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

// Normalize a client-supplied LoRA list. Drops entries without a name and
// clamps strength to Mix Studio's -100..100 range (the UI uses 0..2).
function sanitizeLoras(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const item of value) {
        const name = String((item && item.name) || '').trim();
        if (!name) continue;
        out.push({
            name,
            strength: clampNumber(item.strength, -100, 100, 1),
            on: item.on !== false
        });
    }
    return out;
}

function sanitizeSettings(patch) {
    const out = {};
    for (const key of CONFIGURABLE_KEYS) {
        if (!(key in patch)) continue;
        const value = patch[key];
        if (value === null) { out[key] = null; continue; }
        if (key === 'loras') {
            out[key] = sanitizeLoras(value);
        } else if (key === 'width' || key === 'height' || key === 'steps') {
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
            vaes: required(info.VAELoader, 'vae_name'),
            loras: required(info.LoraLoader, 'lora_name')
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

// Chain LoraLoader nodes after the base UNET/CLIP loaders. Each active LoRA
// becomes a LoraLoader whose model/clip outputs feed the next, so stacked
// LoRAs compose in order (same approach Mix Studio uses). Returns the final
// { model, clip } references for the sampler and prompt encoders.
function buildLoraChain(graph, loras) {
    let model = ['unet', 0];
    let clip = ['clip', 0];
    let n = 0;
    for (const l of loras || []) {
        if (!l || !l.on || !l.name) continue;
        n += 1;
        const key = 'lora' + n;
        graph[key] = {
            class_type: 'LoraLoader',
            inputs: {
                model,
                clip,
                lora_name: l.name,
                strength_model: Number(l.strength) || 0,
                strength_clip: Number(l.strength) || 0
            }
        };
        model = [key, 0];
        clip = [key, 1];
    }
    return { model, clip };
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

    // Chain any attached LoRAs onto the base model + clip. When no LoRAs are
    // configured (or all disabled) this returns the raw ['unet', 0] / ['clip', 0]
    // refs, so the graph is identical to the plain text-to-image pipeline.
    const chain = buildLoraChain(graph, settings.loras);
    const modelRef = chain.model;
    const clipRef = chain.clip;

    graph.pos = { class_type: 'CLIPTextEncode', inputs: { clip: clipRef, text: String(prompt || '') } };
    graph.neg = negative
        ? { class_type: 'CLIPTextEncode', inputs: { clip: clipRef, text: negative } }
        : { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['pos', 0] } };

    graph.latent = {
        class_type: 'EmptySD3LatentImage',
        inputs: { width, height, batch_size: 1 }
    };

    graph.sampler = {
        class_type: 'KSampler',
        inputs: {
            model: modelRef,
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

        // Record lightweight metadata so the Generated gallery can show it.
        const activeLoras = (settings.loras || [])
            .filter((l) => l && l.on && l.name)
            .map((l) => ({ name: l.name, strength: Number(l.strength) || 0 }));
        const meta = generatedHistory.add({
            file: '/generated/' + encodeURIComponent(basename),
            rawFilename: basename,
            prompt,
            model: 'Krea2',
            loras: activeLoras,
            width: settings.width,
            height: settings.height
        });

        return {
            url: meta.file,
            filename: basename,
            width: settings.width,
            height: settings.height,
            prompt,
            meta
        };
    });
}

module.exports = {
    GENERATED_DIR,
    IMAGE_INTENT_SYSTEM_PROMPT,
    PROMPT_BUILDER_SYSTEM_PROMPT,
    DEFAULT_SETTINGS,
    canStartGeneration,
    detectIntent,
    buildImagePrompt,
    imageRequestStrength,
    extractImageSubject,
    stripCreativeMetaInstructions,
    generateImage,
    buildKrea2T2IGraph,
    buildLoraChain,
    validateGraphAgainstComfy,
    effectiveSettings,
    getDefaults,
    saveSettings,
    getModelChoices
};