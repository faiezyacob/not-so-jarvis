/* ============================================
   JARVIS — Image Generation Service
   Detects image-generation intent, builds the
   Krea2 text-to-image workflow graph, submits it
   to ComfyUI, and stores the finished image so
   the chat layer can display it.
   SPDX-License-Identifier: GPL-3.0-only
   Copyright (c) 2025 not-so-jarvis contributors.
   Adapted from Mix Studio (https://github.com/BlackMixture/Mix-Studio,
   GPL-3.0-only): Krea2 workflow graph, S/M/L resolution tiers,
   LoRA chain, and SeedVR2 / Ultimate SD upscale pipelines.
   Modified: simplified to plain T2I path, chat-driven intent,
   not-so-jarvis/ output prefixes.
   ============================================ */

const fs = require('fs');
const path = require('path');
const comfyui = require('./comfyui');
const configManager = require('../server/config-manager');
const generatedHistory = require('./generated-history');

const GENERATED_DIR = path.join(__dirname, '..', 'data', 'generated');

// --- Upscaling constants -------------------------------------------------------
//
// Adapted from Mix Studio's upscale pipeline (lib/upscale-workflows.js and
// server.js buildUpscale). SeedVR2 is the default engine: a tiled diffusion
// upscaler with sharp/balanced detail profiles and a configurable input noise
// level. The Ultimate SD engine is a prompt-guided tiled upscale that reuses
// the Krea2 pipeline's own UNET/CLIP/VAE models.

const LEGACY_KREA_SEEDVR2_DIT = 'seedvr2_ema_3b_fp16.safetensors';
const DEFAULT_SEEDVR2_DIT = 'seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors';
const SHARP_SEEDVR2_DIT = 'seedvr2_ema_7b_sharp_fp8_e4m3fn_mixed_block35_fp16.safetensors';
const DEFAULT_SEEDVR2_VAE = 'ema_vae_fp16.safetensors';
const DEFAULT_SEEDVR2_ATTENTION = 'sdpa';
const NVIDIA_ONLY_SEEDVR2_ATTENTION = new Set(['sageattn_2', 'sageattn_3', 'flash_attn_2', 'flash_attn_3']);
const ULTIMATE_SD_UPSCALE_MODEL = '4x_foolhardy_Remacri.pth';
const SEEDVR2_NOISE_LEVELS = { off: 0, low: 0.06, medium: 0.15 };

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

// Level 1 fast heuristic: a SIGNAL, not the final authority. It catches obvious
// generation requests without needing the LLM; the LLM (or task router) makes
// the final call. Unlike a naive keyword matcher it is NOT position-dependent —
// the generation verb may appear anywhere in the request, and concept questions
// ("What is image generation?") are explicitly excluded.

const IMAGE_MEDIA_WORDS = [
    'image', 'picture', 'photo', 'photograph', 'portrait', 'art', 'artwork',
    'illustration', 'drawing', 'painting', 'comic', 'shot', 'scene', 'view',
    'screenshot', 'wallpaper', 'poster', 'logo', 'avatar', 'meme', 'graphic',
    'landscape', 'interior'
];
// Verb stems so inflected forms ("generate", "generating", "created",
// "make", "making") are all detected wherever they appear in the sentence.
const GENERATION_VERB_STEMS = [
    'generat', 'creat', 'mak', 'render', 'produc', 'paint', 'draw',
    'imagin', 'design', 'illustrat', 'compos', 'show'
];
const IMAGE_WORD_RE = new RegExp('\\b(?:' + IMAGE_MEDIA_WORDS.join('|') + ')s?\\b', 'i');
const GENERATION_VERB_RE = new RegExp('\\b(?:' + GENERATION_VERB_STEMS.join('|') + ')\\w*\\b', 'i');
// "X of [subject]" pattern where X is itself an image word ("image of",
// "portrait of", "photo of", ...). A strong signal regardless of any verb.
const IMAGE_OF_RE = new RegExp(
    '\\b(?:' + IMAGE_MEDIA_WORDS.join('|') + ')s?\\s+of\\b', 'i'
);

// Frames that DISCUSS image/media ideas rather than request them. Any message
// matching these is chat intent even if it also contains "image" or a
// generation verb. This is what keeps "What is image generation?" and
// "Can you explain how to generate images?" out of the image pipeline.
function isConceptQuestion(message) {
    const text = String(message || '').trim();
    if (!text) return true;

    // Leading interrogatives: "What is X?", "Which model...?", "Why...".
    if (/^(?:what|which|why|who|when|where)\b/i.test(text)) return true;
    // "How do/does/can/should/to/i..." — process / concept questions.
    if (/^how\b[\s\S]*\b(?:do|does|can|could|would|should|to|i)\b/i.test(text)) return true;
    // Explanatory / definitional request verbs.
    if (/\b(?:explain|describe|teach|define|learn|understand|tell\s+me)\b/i.test(text)) return true;
    // The concept noun phrases "image generation" and "image model(s)".
    if (/\bimage\s*[-_ ]?\s*generation\b/i.test(text)) return true;
    if (/\bimage\s+models?\b/i.test(text)) return true;
    // "how to generate/..." ("Can you explain how to generate images?").
    if (/\bhow\s+to\s+(?:generate|create|make|render|produce|paint|draw)/i.test(text)) return true;

    return false;
}

// Creative-freedom markers for the heuristic fallback ("be creative",
// "something creative", "surprise me", "use your imagination", ...).
const CREATIVE_FREEDOM_RE =
    /\b(?:creative|be\s+creative|as\s+creative\s+as\s+you\s+(?:want|like|can)|something\s+creative|surprise\s+me|use\s+your\s+imagination|be\s+imaginative|imaginative\s+art(?:work)?|go\s+wild|do\s+(?:your|my)\s+thing|whatever\s+you\s+(?:think|want)|you\s+decide)\b/i;

function detectCreativeFreedom(message) {
    return CREATIVE_FREEDOM_RE.test(String(message || '')) ? 'full' : 'none';
}

const IMAGE_INTENT_SYSTEM_PROMPT =
    'You are JARVIS, a local AI assistant with an image-generation tool ' +
    '(Krea2/ComfyUI). Classify whether the user wants to generate an image, and ' +
    'if so, extract structured data from their request.\n\n' +
    'Respond with ONLY a single JSON object, no markdown, no commentary.\n\n' +
    'For image generation requests:\n' +
    '{"intent": "image_generation", "action": "generate|modify", "user_prompt": "the actual image concept", ' +
    '"creative_mode": "none|light|full", "explicit_constraints": []}\n\n' +
    'For normal chat:\n' +
    '{"intent": "chat", "related_task": "image_generation"|null, "message": "the original user message"}\n\n' +
    'action rules:\n' +
    '- "generate": a brand-new image request.\n' +
    '- "modify": an incremental change to an existing image concept (used by the task router).\n\n' +
    'Classification rules:\n' +
    '- Image requests may use ANY natural phrasing. Examples:\n' +
    '  "generate me an image", "can you generate me an image", "could you create a picture",\n' +
    '  "I want you to make a photo", "please create an image of X", "I\'d like you to generate a portrait",\n' +
    '  "show me a futuristic city", "draw me a cyberpunk character", "make something creative".\n' +
    '- CHAT — do NOT classify as image generation:\n' +
    '  "What is image generation?", "How does image generation work?",\n' +
    '  "What image model should I use?", "Can you explain how to generate images?".\n' +
    '- Normal questions (facts, code, math, summaries, reports, text output) → chat, related_task null.\n\n' +
    'user_prompt rules:\n' +
    '- Extract ONLY the visual concept. Remove verb preambles and meta-instructions.\n' +
    '- If the user grants creative freedom without a concrete subject ("be creative", ' +
    '"something creative", "surprise me"), set creative_mode "full"; user_prompt may be a ' +
    'generic inventive subject ("" is allowed).\n\n' +
    'creative_mode rules:\n' +
    '- "none": no creative freedom. Default when the user just asks for an image.\n' +
    '- "light": a specific enhancement is requested ("make it cinematic", "dramatic lighting", "make it moody").\n' +
    '- "full": the user grants creative freedom ("be creative", "creative", "creative image", ' +
    '"something creative", "surprise me", "use your imagination", "go wild", "you decide").\n\n' +
    'related_task rules:\n' +
    '- Set "related_task": "image_generation" when a chat question refers to an image or an ' +
    'image-generation task (e.g., about the current or desired image). Otherwise null.\n\n' +
    'explicit_constraints rules:\n' +
    '- Array of strings for any explicit constraints the user states ' +
    '(e.g., "must be in black and white", "no text", "landscape orientation").\n' +
    '- Empty array [] if none.';

// Returns 'definite' | 'likely' | null. "definite" means the message clearly
// asks for an image (generation verb + explicit image vocabulary, or an "X of"
// construction). "likely" means generation vocabulary is present but no explicit
// image word — worth asking the LLM. Concept questions are excluded entirely.
function imageRequestStrength(message) {
    if (isConceptQuestion(message)) return null;

    // Strong explicit frame: "image of X", "portrait of X", ...
    if (IMAGE_OF_RE.test(message)) return 'definite';

    const hasGenerationVerb = GENERATION_VERB_RE.test(message);

    if (hasGenerationVerb && IMAGE_WORD_RE.test(message)) return 'definite';
    if (hasGenerationVerb) return 'likely';
    return null;
}

// Use the configured LLM to classify intent. Returns
// { intent: 'image_generation', action, user_prompt, creative_mode, explicit_constraints }
// or { intent: 'chat', related_task, message }.
//
// The heuristic decides WHEN the LLM is consulted and supplies the fallback;
// the structured LLM classification (extension of the schema, not the chat
// model's natural-language reply) adds action / creative_mode / constraints.
async function detectIntent(message, providers, provider, model) {
    const strength = imageRequestStrength(message);

    if (strength === null) {
        return { intent: 'chat', related_task: null, message };
    }

    // For both "definite" and "likely" image requests, call the LLM to get
    // structured data including action, creative_mode and explicit constraints.
    // This ensures meta-instructions like "be creative" are separated from the
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
        if (parsed) {
            // Structured classification is authoritative for tool execution:
            // action, user_prompt and creative_mode decide whether a tool runs.
            if (parsed.intent === 'image_generation') {
                const creative_mode = normalizeCreativeMode(parsed.creative_mode);
                const user_prompt = String(parsed.user_prompt || '').trim();
                // A concrete subject is not required when creative freedom is granted.
                if (user_prompt || creative_mode === 'full') {
                    return {
                        intent: 'image_generation',
                        action: normalizeAction(parsed.action),
                        user_prompt: user_prompt || DEFAULT_CREATIVE_PROMPT,
                        creative_mode,
                        explicit_constraints: Array.isArray(parsed.explicit_constraints)
                            ? parsed.explicit_constraints
                            : []
                    };
                }
            }
            if (parsed.intent === 'chat') {
                return {
                    intent: 'chat',
                    related_task: parsed.related_task || null,
                    message
                };
            }
        }
    } catch (err) {
        console.warn('[image-generator] LLM intent detection failed, using heuristic:', err.message);
    }

    // LLM unavailable, malformed JSON, or said "chat" — for "definite" requests,
    // fall back to heuristic extraction with meta-instruction cleanup. If the
    // user granted creative freedom without a concrete subject, that alone is
    // enough to run (creative_mode full) using a generic inventive prompt.
    const creative = detectCreativeFreedom(message);
    if (strength === 'definite' || creative === 'full') {
        const { prompt } = extractImageSubject(message);
        let cleaned = String(stripCreativeMetaInstructions(prompt) || '').trim();
        if (cleaned && isBareCreativeRequest(cleaned)) cleaned = '';
        if (cleaned || creative === 'full') {
            return {
                intent: 'image_generation',
                action: 'generate',
                user_prompt: cleaned || DEFAULT_CREATIVE_PROMPT,
                creative_mode: creative,
                explicit_constraints: []
            };
        }
    }

    return { intent: 'chat', related_task: null, message };
}

const DEFAULT_CREATIVE_PROMPT = 'an original, imaginative piece of art';

function normalizeAction(value) {
    return String(value || '').toLowerCase() === 'modify' ? 'modify' : 'generate';
}

function normalizeCreativeMode(value) {
    const v = String(value || 'none').toLowerCase();
    return v === 'full' || v === 'light' ? v : 'none';
}

// True when the extracted prompt is nothing but a creative-freedom marker
// ("something creative", "creative image", "just be creative", ...) — i.e. the
// user granted creative freedom without specifying a subject.
function isBareCreativeRequest(text) {
    const t = String(text || '').replace(/[,;.\s]+$/i, '').trim();
    return CREATIVE_FREEDOM_RE.test(t) &&
        /^(?:something\s+)?(?:just\s+)?(?:be\s+)?creative(?:\s+(?:image|art(?:work)?))?$/i.test(t);
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

// Heuristic fallback: strip the generation verb phrase, modal/politeness
// preambles, and the "image of" preamble to get the visual subject
// ("Can you please generate an image of a futuristic Tokyo street" ->
// "a futuristic Tokyo street"). Used directly for "definite" requests and as
// a fallback when the LLM is unavailable.
function extractImageSubject(message) {
    let cleaned = String(message || '').trim();

    // Strip politeness + modal/politeness preambles ("please", "can you",
    // "could you", "would you", "I want you to", "I'd like you to", ...).
    cleaned = cleaned
        .replace(/^(?:please\s+)?/i, '')
        .replace(/^(?:can|could|would|will|do|did)\s+you\s+/i, '')
        .replace(/^(?:can|could|would|will|shall|should)\s+/i, '')
        .replace(/^i\s+(?:want|'?d like|would like|need)\s+(?:you\s+to\s+)?/i, '')
        .replace(/^(?:would\s+you\s+mind\s+)?/i, '')
        .trim();

    // Strip leading generation verb + recipient + articles.
    const verbStems = GENERATION_VERB_STEMS.join('|');
    cleaned = cleaned
        .replace(new RegExp('^(?:' + verbStems + ')\\w*\\s+(?:me|us)?\\s*(?:an?|the)?\\s*', 'i'), '')
        .replace(/^(?:give\s+me|show\s+me)\s+(?:an?|the)?\s*/i, '')
        .trim();

    // "X of <subject>" where X is an image word — keep only the subject.
    const media = IMAGE_MEDIA_WORDS.join('|');
    const ofMatch = cleaned.match(new RegExp('\\b(?:' + media + ')s?\\s+of\\s+(.+)$', 'i'));
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

// Structured visual attributes the enhancer tracks so modifications can target
// individual details instead of rewriting the whole prompt. Each prompt the
// enhancer produces is also broken down into these fields.
const VISUAL_ATTRIBUTE_KEYS = [
    'subject', 'appearance', 'top', 'bottom', 'pose',
    'setting', 'expression', 'camera', 'lighting'
];

const PROMPT_BUILDER_SYSTEM_PROMPT =
    'You are JARVIS\'s creative visual director for a local image-generation ' +
    'pipeline (Krea2/ComfyUI). You turn image requests into ONE complete, ' +
    'concrete visual prompt. You are NOT a keyword generator: fill missing ' +
    'visual information with specific, usable detail, and never pad prompts ' +
    'with generic filler such as "cinematic", "highly detailed", ' +
    '"photorealistic", "atmospheric depth", or "professional". Only include a ' +
    'detail when it materially improves the image.\n\n' +

    'VISUAL ATTRIBUTE FIELDS — alongside the prompt you also populate these ' +
    'structured attribute fields. Empty string "" when an attribute is not ' +
    'present in the prompt:\n' +
    '- subject: who/what the image shows\n' +
    '- appearance: hair, build, distinguishing physical traits\n' +
    '- top: the upper-body clothing\n' +
    '- bottom: the lower-body clothing\n' +
    '- pose: pose / action\n' +
    '- setting: the environment / location\n' +
    '- expression: facial expression (when useful)\n' +
    '- camera: camera angle / framing / lens (when useful)\n' +
    '- lighting: lighting and time of day (when useful)\n\n' +

    'EXAMPLE — user concept "a young Korean woman". Prompt:\n' +
    '"A young Korean woman with long black hair, wearing an oversized cream ' +
    'sweater and blue jeans, standing casually on a quiet Seoul street in the ' +
    'late afternoon."\n' +
    'attributes: {"subject": "a young Korean woman", "appearance": "with long ' +
    'black hair", "top": "wearing an oversized cream sweater", "bottom": "blue ' +
    'jeans", "pose": "standing casually", "setting": "on a quiet Seoul street ' +
    'in the late afternoon", "expression": "", "camera": "", "lighting": ""}\n' +
    'Keep prompts concise (usually one or two sentences). Never change the ' +
    'subject or drop any explicit detail the user gave.\n\n' +

    'creative_mode controls how freely you invent detail:\n' +
    '- "none": stay close to the user\'s request; only fill in what is needed ' +
    'to make the prompt usable; do not invent unnecessary details.\n' +
    '- "light": fill the obvious missing visual attributes (for example a ' +
    'believable outfit when the user named only a subject and setting).\n' +
    '- "full": freely complete the visual concept with an appropriate ' +
    'appearance, outfit, pose, setting, etc.\n\n' +

    'PREVIOUS CONTEXT — a previous image prompt may be provided as context ' +
    '(the image generated before). If the user\'s new concept clearly continues ' +
    'the same subject (same person or scene, an incremental tweak like changing ' +
    'the top), keep the prior details and layer the change on top of them. If ' +
    'it is genuinely a new subject, do not carry the prior details over.\n\n' +

    'MODIFICATION — when a current image prompt, its current attribute values, ' +
    'and a modification request are provided, they are the single source of ' +
    'truth:\n' +
    '1. Identify which attribute(s) the user wants changed.\n' +
    '2. Replace ONLY those attributes with concrete, specific new values. Never ' +
    'write vague phrases such as "in a different pose" — describe the actual ' +
    'new pose, outfit, setting, lighting, etc.\n' +
    '3. List exactly those attributes in "changed". Every attribute not listed ' +
    'keeps its current value word-for-word. Clothing is independent: changing ' +
    'the top never changes the bottom and vice versa unless the user explicitly ' +
    'asks for both.\n' +
    '4. Rebuild the complete prompt from the updated attribute values.\n\n' +

    'Respond with ONLY a single JSON object, no markdown, no commentary:\n' +
    '- Brand-new generation: {"prompt": "...", "attributes": {field: value, ...}}\n' +
    '- Modification: {"changed": ["field"], "attributes": {field: value, ...}, ' +
    '"prompt": "..."}';

// Strip code fences and isolate the JSON payload from the enhancer's reply.
function parseEnhancerJson(raw) {
    if (!raw) return null;
    let text = String(raw).trim();
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

// Coerce a parsed attributes object into the canonical shape. Returns null when
// every field is empty (nothing worth tracking).
function normalizeAttributes(value) {
    const src = value && typeof value === 'object' ? value : {};
    const out = {};
    let any = false;
    for (const key of VISUAL_ATTRIBUTE_KEYS) {
        const v = src[key];
        out[key] = (typeof v === 'string' && v.trim()) ? v.trim() : '';
        if (out[key]) any = true;
    }
    return any ? out : null;
}

// Deterministic preservation: every attribute NOT listed in changedKeys is
// copied word-for-word from the base attributes. This guarantees a modifier
// over-rewrite can never drop e.g. the top when only the bottom was requested.
function mergeVisualAttributes(base, updated, changedKeys) {
    if (!base || !Object.values(base).some(Boolean)) return normalizeAttributes(updated);
    const changed = Array.isArray(changedKeys) && changedKeys.length
        ? new Set(changedKeys.map((k) => String(k)))
        : new Set();
    const out = {};
    let any = false;
    for (const key of VISUAL_ATTRIBUTE_KEYS) {
        if (changed.has(key) && typeof updated[key] === 'string' && updated[key].trim()) {
            out[key] = updated[key].trim();
        } else if (typeof base[key] === 'string' && base[key].trim()) {
            out[key] = base[key];
        } else {
            out[key] = '';
        }
        if (out[key]) any = true;
    }
    return any ? out : null;
}

// Use the conversational model to build the final image-generation prompt from
// the structured intent data. Returns { prompt, attributes } so modifications
// can deterministically preserve untouched details. In modify mode the current
// prompt + current attributes are the source of truth: only the targeted fields
// change and every other field is copied verbatim from the stored attributes.
// Falls back to the raw concept + prior attributes on failure.
async function buildImagePrompt(structuredRequest, providers, provider, model) {
    const { user_prompt, creative_mode, explicit_constraints, base_prompt, modification, previous_prompt, base_attributes } = structuredRequest;
    const isModify = Boolean(base_prompt && modification);
    // Escalate to "full" when the modification itself grants creative freedom,
    // otherwise keep the creative mode carried by the active task.
    const mode = detectCreativeFreedom(modification) === 'full'
        ? 'full'
        : normalizeCreativeMode(creative_mode);

    let userMessage;
    if (isModify) {
        // Modify mode: the current prompt + attributes are the source of truth.
        userMessage =
            'CURRENT IMAGE PROMPT (source of truth):\n"' + base_prompt + '"\n\n' +
            'CURRENT VISUAL ATTRIBUTES:\n' + JSON.stringify(base_attributes || {}) + '\n\n' +
            'USER MODIFICATION REQUEST:\n"' + modification + '"\n\n' +
            'creative_mode: "' + mode + '"\n' +
            'explicit_constraints: ' + JSON.stringify(explicit_constraints || []) + '\n\n' +
            'Output ONLY the JSON described in the system prompt.';
    } else {
        // Generate mode: enhance the new concept. When a previous prompt exists,
        // give the LLM that context so incremental tweaks ("make her top ...")
        // can continue the same subject instead of starting from scratch.
        userMessage =
            'user concept: "' + user_prompt + '"\n' +
            'creative_mode: "' + mode + '"\n' +
            'explicit_constraints: ' + JSON.stringify(explicit_constraints || []) + '\n\n';
        if (previous_prompt) {
            userMessage +=
                'PREVIOUS IMAGE PROMPT (context — continue the same subject when ' +
                'the concept builds on it, ignore when it is a new subject):\n"' +
                previous_prompt + '"\n\n';
        }
        userMessage += 'Output ONLY the JSON described in the system prompt.';
    }

    try {
        const raw = await providers.chat(provider, [
            { role: 'system', content: PROMPT_BUILDER_SYSTEM_PROMPT },
            { role: 'user', content: userMessage }
        ], model);

        const parsed = parseEnhancerJson(raw);
        const prompt = parsed && typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '';
        if (prompt) {
            let attributes = normalizeAttributes(parsed.attributes);
            if (isModify) {
                attributes = mergeVisualAttributes(base_attributes, parsed.attributes, parsed.changed);
            }
            return { prompt, attributes };
        }
    } catch (err) {
        console.warn('[image-generator] Prompt builder failed, using raw prompt:', err.message);
    }

    if (isModify) {
        console.warn('[image-generator] Prompt builder modify failed; keeping current prompt unchanged.');
        return {
            prompt: String(base_prompt || user_prompt || '').trim(),
            attributes: base_attributes || null
        };
    }
    return { prompt: user_prompt, attributes: null };
}

// --- Resolution (Aspect Ratio + Size) ------------------------------------------
//
// The only user-facing resolution controls, matching Mix Studio's S/M/L tiers
// (public/app.js RESOLUTION_SIZE_OPTIONS + createSizeLabel +
// dimensionsForMegapixels): S is 0.75 MP, M is 1 MP, L is 1.75 MP total
// pixels. Dimensions are derived from the aspect ratio as
//   w = round32(sqrt(pixels * ratio)), h = round32(sqrt(pixels / ratio))
// so M + 1:1 yields ~992x992, M + 4:5 yields ~896x1120, and
// M + 16:9 yields ~1344x736. Dimensions are snapped to multiples of 32
// (Mix Studio's round32) before reaching Krea2.

const ASPECT_RATIOS = ['1:1', '4:5', '3:4', '16:9', '9:16'];
const IMAGE_MEGAPIXELS = { S: 0.75, M: 1, L: 1.75 };
// Backwards-compatible alias: previous revisions exposed short-side pixels
// under this name ({ S: 768, M: 1024, L: 1536 }).
const IMAGE_SIZES = IMAGE_MEGAPIXELS;

function normalizeAspectRatio(value) {
    const v = String(value || '').trim();
    return ASPECT_RATIOS.includes(v) ? v : null;
}

function normalizeImageSize(value) {
    const v = String(value || '').trim().toUpperCase();
    return Object.prototype.hasOwnProperty.call(IMAGE_MEGAPIXELS, v) ? v : null;
}

function round32(n) {
    return Math.max(64, Math.round(n / 32) * 32);
}

// Map aspectRatio + imageSize to concrete Krea2 latent dimensions, matching
// Mix Studio's dimensionsForMegapixels(). Invalid inputs fall back to the
// 4:5 / M defaults.
function resolveDimensions(settings) {
    const ratio = normalizeAspectRatio(settings && settings.aspectRatio) || '4:5';
    const size = normalizeImageSize(settings && settings.imageSize) || 'M';
    const parts = ratio.split(':').map(Number);
    const aspect = Math.max(0.1, Math.min(10, parts[0] / parts[1] || 1));
    const pixels = (IMAGE_MEGAPIXELS[size] || IMAGE_MEGAPIXELS.M) * 1e6;
    return {
        width: round32(Math.sqrt(pixels * aspect)),
        height: round32(Math.sqrt(pixels / aspect)),
        aspectRatio: ratio,
        imageSize: size
    };
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
    // User-facing resolution controls. The UI exposes only these two
    // dropdowns — never raw pixels. Width/height below are always derived
    // from them via resolveDimensions(), so stored or env-provided pixel
    // values never reach the Krea2 graph directly.
    aspectRatio: normalizeAspectRatio(process.env.KREA2_ASPECT_RATIO) || '4:5',
    imageSize: normalizeImageSize(process.env.KREA2_IMAGE_SIZE) || 'M',
    width: Number(process.env.KREA2_WIDTH) || 1024,
    height: Number(process.env.KREA2_HEIGHT) || 1024,
    steps: Number(process.env.KREA2_STEPS) || 8,
    cfg: Number(process.env.KREA2_CFG) || 1,
    // Stacked LoRAs applied to every Krea2 generation, in order. Each entry
    // is { name, strength, on, triggerWord } where strength is the model+clip
    // LoRA scale and triggerWord is an optional keyword prepended to the prompt.
    loras: [],
    // Remembered trigger words keyed by LoRA name. Kept separate from the
    // active stack so a removed LoRA keeps its trigger word if re-added later.
    loraTriggerWords: {},
    // Image upscaling (SeedVR2 default, Ultimate SD alternative). Profile is
    // "sharp" (sharp DiT variant) or "balanced"; noise is off/low/medium detail
    // input noise; mode is "target" (target short-side resolution) or
    // "multiplier" (scale factor on the source short side); preScale applies an
    // optional lanczos pre-resize before SeedVR2 (1 = off).
    upscaleEngine: 'seedvr2',
    upscaleMode: 'target',
    upscaleResolution: 2160,
    upscaleMultiplier: 2,
    upscaleProfile: 'sharp',
    upscaleNoise: 'low',
    upscalePreScale: 1,
    seedvr2Dit: DEFAULT_SEEDVR2_DIT,
    seedvr2Vae: DEFAULT_SEEDVR2_VAE,
    seedvr2Attention: DEFAULT_SEEDVR2_ATTENTION
};

// Fields the user may override through the settings panel / API. Kept
// separate from DEFAULT_SETTINGS so we only persist explicit overrides.
const CONFIGURABLE_KEYS = ['unet', 'clip', 'clipType', 'vae', 'aspectRatio', 'imageSize', 'width', 'height', 'steps', 'cfg', 'loras', 'loraTriggerWords',
    'upscaleEngine', 'upscaleMode', 'upscaleResolution', 'upscaleMultiplier', 'upscaleProfile', 'upscaleNoise', 'upscalePreScale',
    'seedvr2Dit', 'seedvr2Vae', 'seedvr2Attention'];

// Effective settings = env-driven defaults merged with any globally stored
// overrides from data/config.json (see config-manager). Width/height are
// always (re)derived from aspectRatio + imageSize here, so the Krea2 graph,
// metadata, and task parameters downstream never see raw pixel settings.
function effectiveSettings() {
    const stored = configManager.getImageSettings();
    const settings = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(settings)) {
        const value = stored[key];
        if (value !== undefined && value !== null && value !== '') {
            settings[key] = value;
        }
    }
    const dims = resolveDimensions(settings);
    settings.width = dims.width;
    settings.height = dims.height;
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
        const triggerWord = String((item && item.triggerWord) || '').trim();
        out.push({
            name,
            strength: clampNumber(item.strength, -100, 100, 1),
            on: item.on !== false,
            triggerWord: triggerWord || ''
        });
    }
    return out;
}

// Normalize the remembered per-LoRA trigger word map. Keys are LoRA names,
// values are trimmed trigger words. Empty values are dropped.
function sanitizeLoraTriggerWords(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out = {};
    for (const [name, word] of Object.entries(value)) {
        const key = String(name || '').trim();
        const trimmed = String(word || '').trim();
        if (key && trimmed) out[key] = trimmed;
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
        } else if (key === 'loraTriggerWords') {
            out[key] = sanitizeLoraTriggerWords(value);
        } else if (key === 'aspectRatio') {
            const v = normalizeAspectRatio(value);
            if (v) out[key] = v;
        } else if (key === 'imageSize') {
            const v = normalizeImageSize(value);
            if (v) out[key] = v;
        } else if (key === 'width' || key === 'height' || key === 'steps') {
            const n = Math.round(Number(value));
            if (Number.isFinite(n) && n > 0) out[key] = n;
        } else if (key === 'cfg') {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 0) out[key] = n;
        } else if (key === 'upscaleEngine') {
            const v = String(value || '').toLowerCase();
            if (v === 'seedvr2' || v === 'ultimate') out[key] = v;
        } else if (key === 'upscaleMode') {
            const v = String(value || '').toLowerCase();
            if (v === 'target' || v === 'multiplier') out[key] = v;
        } else if (key === 'upscaleResolution') {
            const n = Math.round(Number(value));
            if ([1080, 1440, 2160, 3840].includes(n)) out[key] = n;
        } else if (key === 'upscaleMultiplier') {
            const n = Number(value);
            if (Number.isFinite(n)) out[key] = Math.max(1, Math.min(4, Math.round(n * 10) / 10));
        } else if (key === 'upscaleProfile') {
            const v = String(value || '').toLowerCase();
            if (v === 'sharp' || v === 'balanced') out[key] = v;
        } else if (key === 'upscaleNoise') {
            const v = String(value || '').toLowerCase();
            if (v === 'off' || v === 'low' || v === 'medium') out[key] = v;
        } else if (key === 'upscalePreScale') {
            const n = Math.round(Number(value));
            if (n === 1 || n === 2) out[key] = n;
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
    graph.save = { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'not-so-jarvis/gen' } };

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

// --- Upscaling -----------------------------------------------------------------
//
// Two engines mirroring Mix Studio's upscale pipeline:
//   - SeedVR2 (default): a tiled diffusion upscaler. "sharp" profile uses the
//     sharp 7B DiT variant (falls back to balanced when not installed), and the
//     noise level controls the detail input noise (off/low/medium).
//   - Ultimate SD: a prompt-guided tiled upscaler (UltimateSDUpscale custom
//     node) driven by the same Krea2 UNET/CLIP/VAE models as generation.
//
// The source image lives in data/generated/ and is uploaded into ComfyUI's
// input folder so a LoadImage node can reference it; the finished upscale is
// downloaded back into data/generated/ and recorded in generated-history.

function isSeedVr2SevenB(model) {
    return /(?:^|[_-])7b(?:[_-]|$)/i.test(String(model || ''));
}

// Some attention modes (sageattn / flash attn v2+) are NVIDIA-only; downgrade
// them to sdpa on non-NVIDIA GPUs so graph construction never hard-fails.
function seedVr2AttentionForVendor(value, vendor) {
    const attention = String(value || DEFAULT_SEEDVR2_ATTENTION);
    const normalizedVendor = String(vendor || '').toLowerCase();
    if (normalizedVendor && normalizedVendor !== 'nvidia' && NVIDIA_ONLY_SEEDVR2_ATTENTION.has(attention)) {
        return DEFAULT_SEEDVR2_ATTENTION;
    }
    return attention;
}

function seedVr2DitInputs(settings) {
    const model = settings.seedvr2Dit || DEFAULT_SEEDVR2_DIT;
    return {
        model,
        device: 'cuda:0',
        blocks_to_swap: isSeedVr2SevenB(model) ? 32 : 0,
        swap_io_components: true,
        offload_device: 'cpu',
        cache_model: false,
        attention_mode: seedVr2AttentionForVendor(settings.seedvr2Attention, settings.gpuVendor || '')
    };
}

function seedVr2NoiseLevel(requested) {
    return Object.prototype.hasOwnProperty.call(SEEDVR2_NOISE_LEVELS, requested) ? requested : 'low';
}

function seedVr2Profile(settings, requestedProfile, availableModels, requestedNoise) {
    const noise = seedVr2NoiseLevel(requestedNoise);
    const balanced = {
        key: 'balanced',
        ditModel: settings.seedvr2Dit || DEFAULT_SEEDVR2_DIT,
        colorCorrection: 'lab',
        noise,
        inputNoiseScale: SEEDVR2_NOISE_LEVELS[noise]
    };
    const hasSharp = !Array.isArray(availableModels) || availableModels.includes(SHARP_SEEDVR2_DIT);
    if (requestedProfile === 'sharp' && hasSharp) {
        return {
            key: 'sharp',
            ditModel: SHARP_SEEDVR2_DIT,
            colorCorrection: 'wavelet',
            noise,
            inputNoiseScale: SEEDVR2_NOISE_LEVELS[noise]
        };
    }
    return balanced;
}

// List the SeedVR2 DiT/VAE checkpoint files ComfyUI currently has on disk, so
// the sharp profile can detect whether its 7B-sharp DiT is installed.
function installedSeedVr2Models(dirs) {
    const models = new Set();
    for (const dir of dirs || []) {
        if (!dir) continue;
        let entries = [];
        try { entries = fs.readdirSync(dir); } catch { continue; }
        for (const name of entries) {
            if (!name || name.endsWith('.download')) continue;
            const ext = path.extname(name).toLowerCase();
            if (ext === '.safetensors' || ext === '.gguf') models.add(name);
        }
    }
    return [...models];
}

// Directories to scan for installed SeedVR2 checkpoints: explicit env
// overrides first (KREA2_SEEDVR2_DIR / COMFYUI_SEEDVR2_DIR), then ComfyUI's
// models/seedvr2 (or models/SEEDVR2) folder.
async function seedVr2ModelDirs() {
    const dirs = [];
    for (const value of [process.env.KREA2_SEEDVR2_DIR, process.env.COMFYUI_SEEDVR2_DIR]) {
        if (value) dirs.push(path.resolve(value));
    }
    const modelRoot = await comfyui.resolveModelRoot().catch(() => null);
    if (modelRoot) {
        for (const dir of [path.join(modelRoot, 'seedvr2'), path.join(modelRoot, 'SEEDVR2')]) {
            if (fs.existsSync(dir)) dirs.push(dir);
        }
    }
    return dirs;
}

// Read width/height straight from a PNG or JPEG header (no dependencies). JPEG
// dimensions come from the SOF marker. Returns { width: 0, height: 0 } for
// unknown formats so multiplier mode can fall back to the target resolution.
function readImageDimensions(filePath) {
    try {
        const buf = fs.readFileSync(filePath);
        if (buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') {
            return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
        }
        if (buf[0] === 0xFF && buf[1] === 0xD8) {
            let i = 2;
            while (i < buf.length - 9) {
                if (buf[i] !== 0xFF) { i += 1; continue; }
                const marker = buf[i + 1];
                if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { i += 2; continue; }
                const len = buf.readUInt16BE(i + 2);
                if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
                    return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
                }
                i += 2 + len;
            }
        }
    } catch (err) {
        // Fall through to unknown dimensions.
    }
    return { width: 0, height: 0 };
}

// Turn the configured upscale mode into a concrete SeedVR2 target resolution.
// "target" uses the configured short-side resolution; "multiplier" scales the
// source short side by the multiplier (clamped to 512..8192).
function resolveUpscaleResolution(sourceWidth, sourceHeight, settings, requested) {
    const mode = (requested && requested.mode) || settings.upscaleMode || 'target';
    if (mode === 'multiplier') {
        const factor = clampNumber((requested && requested.multiplier) || settings.upscaleMultiplier, 1, 4, 2);
        if (sourceWidth > 0 && sourceHeight > 0) {
            return Math.max(512, Math.min(8192, Math.round(Math.min(sourceWidth, sourceHeight) * factor)));
        }
    }
    return clampNumber((requested && requested.resolution) || settings.upscaleResolution, 512, 8192, 2160);
}

function findHistoryMeta(rawFilename) {
    if (!rawFilename) return null;
    const decoded = decodeURIComponent(String(rawFilename)).split('/').pop();
    return generatedHistory.list().find((e) =>
        e.rawFilename === decoded || String(e.file).split('/').pop() === decoded) || null;
}

// --- Upscale intent detection -------------------------------------------------
//
// A narrow, deterministic intent — no LLM needed. Normalizes the message
// (lowercase, dashes/underscores to spaces) then looks for an explicit upscale
// signal AND an image/pronoun reference, so "upscale this image" fires while
// concept questions ("what is upscaling?") and passing mentions ("upscaling is
// slow") do not.

const UPSCALE_SIGNAL_RE = /\b(?:up\s*scale\w*|up\s*res\w*|super\s*res\w*|higher\s*res\w*|hi\s*res\b|increase\w*\s+(?:the\s+)?res\w*|improve\w*\s+(?:the\s+)?(?:res\w*|image\w*|picture\w*|photo\w*)|make\s+(?:it|this|that)\s+(?:bigger|larger|sharper|crisper|clearer|higher\s*res)|sharpen\w*|enlarge\w*)\b/i;
const UPSCALE_REF_RE = /\b(?:image\w*|pict\w*|pic\b|photo\w*|artw?o?r?k?|illustr\w*|paint\w*|render\w*|screenshot\w*|wallpaper\w*|poster\w*|logo\w*|avatar\w*|graphic\w*|shot\b|this\b|that\b|it\b|them\b|one\b|the last\b|previous\b|generated\b)\b/i;

function detectUpscaleIntent(message) {
    const text = String(message || '');
    if (!text.trim()) return null;
    if (isConceptQuestion(text)) return null;
    const norm = text.toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!UPSCALE_SIGNAL_RE.test(norm)) return null;
    if (!UPSCALE_REF_RE.test(norm)) return null;
    return { intent: 'image_upscale' };
}

// --- Upscale graph builders -----------------------------------------------------

function buildSeedVr2ImageUpscaleGraph(imageName, options = {}) {
    const settings = Object.assign({}, DEFAULT_SETTINGS, options.settings || {});
    const profile = seedVr2Profile(settings, options.profile || 'sharp', options.availableModels, options.noise || 'low');
    const seed = Number.isInteger(options.seed) && options.seed >= 0 ? options.seed : Math.floor(Math.random() * 2 ** 31);

    const graph = {};
    graph.load = { class_type: 'LoadImage', inputs: { image: imageName } };
    let imgRef = ['load', 0];

    const preScale = clampNumber(options.preScale, 1, 4, 1);
    if (preScale !== 1) {
        graph.prescale = {
            class_type: 'ImageScaleBy',
            inputs: { image: imgRef, upscale_method: 'lanczos', scale_by: preScale }
        };
        imgRef = ['prescale', 0];
    }

    graph.dit = {
        class_type: 'SeedVR2LoadDiTModel',
        inputs: seedVr2DitInputs(Object.assign({}, settings, {
            seedvr2Dit: profile.ditModel,
            gpuVendor: options.gpuVendor || settings.gpuVendor || ''
        }))
    };
    graph.svvae = {
        class_type: 'SeedVR2LoadVAEModel',
        inputs: {
            model: settings.seedvr2Vae || DEFAULT_SEEDVR2_VAE,
            device: 'cuda:0',
            encode_tiled: true,
            encode_tile_size: 1024,
            encode_tile_overlap: 256,
            decode_tiled: true,
            decode_tile_size: 1024,
            decode_tile_overlap: 256,
            tile_debug: 'false',
            offload_device: 'cpu',
            cache_model: false
        }
    };
    graph.upscale = {
        class_type: 'SeedVR2VideoUpscaler',
        inputs: {
            image: imgRef,
            dit: ['dit', 0],
            vae: ['svvae', 0],
            seed,
            resolution: clampNumber(options.resolution, 512, 8192, 2160),
            max_resolution: 0,
            batch_size: 1,
            uniform_batch_size: false,
            color_correction: profile.colorCorrection,
            temporal_overlap: 0,
            prepend_frames: 0,
            input_noise_scale: profile.inputNoiseScale,
            latent_noise_scale: 0,
            offload_device: 'cpu',
            enable_debug: false
        }
    };
    graph.save = { class_type: 'SaveImage', inputs: { images: ['upscale', 0], filename_prefix: 'not-so-jarvis/upscale' } };

    return { graph, profile };
}

function buildUltimateSdUpscaleGraph(imageName, options = {}) {
    const settings = Object.assign({}, DEFAULT_SETTINGS, options.settings || {});
    const scaleFactor = clampNumber(options.scaleFactor, 1, 4, 2);
    const seed = Number.isInteger(options.seed) && options.seed >= 0 ? options.seed : Math.floor(Math.random() * 2 ** 31);
    const prompt = String(options.prompt || '').trim() || 'a faithful, highly detailed upscale of the source image';

    const graph = {};
    graph.load = { class_type: 'LoadImage', inputs: { image: imageName } };
    graph.unet = diffusionModelLoader(settings.unet);
    graph.clip = { class_type: 'CLIPLoader', inputs: { clip_name: settings.clip, type: settings.clipType, device: 'default' } };
    graph.vae = { class_type: 'VAELoader', inputs: { vae_name: settings.vae } };
    const chain = buildLoraChain(graph, settings.loras);
    graph.upscale_model = { class_type: 'UpscaleModelLoader', inputs: { model_name: options.upscaleModel || ULTIMATE_SD_UPSCALE_MODEL } };
    graph.pos = { class_type: 'CLIPTextEncode', inputs: { clip: chain.clip, text: prompt } };
    graph.neg = { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['pos', 0] } };
    graph.ultimate = {
        class_type: 'UltimateSDUpscale',
        inputs: {
            image: ['load', 0],
            model: chain.model,
            positive: ['pos', 0],
            negative: ['neg', 0],
            vae: ['vae', 0],
            upscale_by: scaleFactor,
            seed,
            steps: 12,
            cfg: 1,
            sampler_name: 'euler',
            scheduler: 'beta',
            denoise: 0.22,
            upscale_model: ['upscale_model', 0],
            mode_type: 'Chess',
            tile_width: 768,
            tile_height: 768,
            mask_blur: 8,
            tile_padding: 64,
            seam_fix_mode: 'None',
            seam_fix_denoise: 0.1,
            seam_fix_width: 64,
            seam_fix_mask_blur: 8,
            seam_fix_padding: 16,
            force_uniform_tiles: true,
            tiled_decode: true,
            batch_size: 1
        }
    };
    graph.save = { class_type: 'SaveImage', inputs: { images: ['ultimate', 0], filename_prefix: 'not-so-jarvis/upscale' } };

    return graph;
}

// --- Upscale execution ----------------------------------------------------------
//
// Upscale the image file at data/generated/<rawFilename> and write the result
// into data/generated/. Shares the single-generation lock with generateImage so
// ComfyUI never runs two jobs at once. Returns { url, filename, width, height,
// sourceWidth, sourceHeight, engine, profile, noise, resolution, meta }.
async function upscaleImage(rawFilename, options = {}) {
    return withGenerationLock(async () => {
        await ensureGeneratedDir();
        const startedAt = Date.now();

        const safeName = path.basename(String(rawFilename || ''));
        if (!safeName) {
            const error = new Error('No source image specified.');
            error.code = 'upscale_source_missing';
            throw error;
        }
        const filePath = path.join(GENERATED_DIR, safeName);
        if (!fs.existsSync(filePath)) {
            const error = new Error('Upscale source not found on disk: ' + safeName);
            error.code = 'upscale_source_missing';
            throw error;
        }
        const buffer = fs.readFileSync(filePath);

        const settings = effectiveSettings();
        const engine = String(options.engine || settings.upscaleEngine || 'seedvr2').toLowerCase() === 'ultimate' ? 'ultimate' : 'seedvr2';
        const sourceMeta = findHistoryMeta(safeName);
        const { width: sourceWidth, height: sourceHeight } = readImageDimensions(filePath);
        const resolution = resolveUpscaleResolution(sourceWidth, sourceHeight, settings, options);
        const scaleFactor = clampNumber(options.scaleFactor || options.multiplier || settings.upscaleMultiplier, 1, 4, 2);
        const seed = Math.floor(Math.random() * 2 ** 32);
        const profile = engine === 'seedvr2' ? (options.profile || settings.upscaleProfile || 'sharp') : null;
        const noise = engine === 'seedvr2' ? (options.noise || settings.upscaleNoise || 'low') : null;

        // Make the source available to ComfyUI's LoadImage node, then always
        // clean it up afterwards so the input folder does not accumulate files.
        const uploadName = 'jarvis_upscale_' + Date.now() + '_' + safeName;
        const uploaded = await comfyui.uploadImage(buffer, uploadName);
        const loadName = (uploaded && uploaded.name) || uploadName;

        let graph;
        let basename;
        let effectiveProfile = null;
        try {
            if (engine === 'seedvr2') {
                const availableModels = installedSeedVr2Models(await seedVr2ModelDirs());
                const built = buildSeedVr2ImageUpscaleGraph(loadName, {
                    settings,
                    profile,
                    noise,
                    resolution,
                    preScale: options.preScale || settings.upscalePreScale || 1,
                    seed,
                    availableModels
                });
                graph = built.graph;
                effectiveProfile = built.profile;
            } else {
                const prompt = String(options.prompt || '').trim()
                    || (sourceMeta && sourceMeta.prompt) || '';
                graph = buildUltimateSdUpscaleGraph(loadName, {
                    settings,
                    scaleFactor,
                    seed,
                    prompt
                });
            }

            const info = await comfyui.getObjectInfo();
            await validateGraphAgainstComfy(info, graph);

            const pid = await comfyui.queuePrompt(graph);
            console.log('[image-generator] queued upscale (' + engine + ') workflow:', pid);

            const history = await comfyui.waitForPrompt(pid, { timeoutMs: options.timeoutMs });
            const files = comfyui.findOutputFiles(history.outputs || {}, /\.(?:png|jpg|jpeg|webp)$/i);
            if (!files.length) {
                const error = new Error('ComfyUI finished but produced no upscaled image file.');
                error.code = 'comfyui_output_not_found';
                throw error;
            }

            const entry = files[files.length - 1];
            const outBuffer = await comfyui.downloadImage(entry);

            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const extension = path.extname(entry.filename).toLowerCase() || '.png';
            basename = safeFilename(outBuffer.toString('hex', 0, 4)) + '_up_' + stamp + extension;
            fs.writeFileSync(path.join(GENERATED_DIR, basename), outBuffer);
            console.log('[image-generator] saved upscaled image:', basename, '(' + outBuffer.length + ' bytes)');

            // The image is safely on disk — remove the ComfyUI original.
            await comfyui.deleteOutputFile(entry, { history: pid });
        } finally {
            await comfyui.deleteInputFile(loadName).catch(() => {});
        }

        const { width, height } = readImageDimensions(path.join(GENERATED_DIR, basename));
        const modelLabel = engine === 'seedvr2' ? 'SeedVR2' : 'UltimateSD';
        const meta = generatedHistory.add({
            file: '/generated/' + encodeURIComponent(basename),
            rawFilename: basename,
            prompt: String(options.prompt || (sourceMeta && sourceMeta.prompt) || '').trim() || 'Upscaled image',
            model: modelLabel,
            width,
            height,
            generationMs: Date.now() - startedAt,
            upscale: {
                engine,
                profile: effectiveProfile ? effectiveProfile.key : null,
                noise: effectiveProfile ? effectiveProfile.noise : null,
                resolution,
                source: safeName
            }
        });

        return {
            url: meta.file,
            filename: basename,
            width,
            height,
            sourceWidth,
            sourceHeight,
            engine,
            profile: effectiveProfile ? effectiveProfile.key : null,
            noise: effectiveProfile ? effectiveProfile.noise : null,
            resolution,
            source: safeName,
            sourceMeta,
            prompt: meta.prompt,
            generationMs: meta.generationMs,
            meta
        };
    });
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

// LoRA trigger words are prepended automatically at generation time, so a
// prompt that already carries a trigger-word prefix (e.g. the finalPrompt
// recorded in generated-history metadata, or a task-state prompt grafted from
// it) must be stripped before it is stored or re-grafted. Otherwise the next
// generation prepends the words again and they accumulate across modify turns.
function stripLoraTriggerWords(prompt) {
    const text = String(prompt || '').trim();
    if (!text) return text;
    const settings = effectiveSettings();
    const triggerWords = (settings.loras || [])
        .filter((l) => l && l.on && l.name && l.triggerWord && String(l.triggerWord).trim())
        .map((l) => String(l.triggerWord).trim());
    if (!triggerWords.length) return text;
    const prefix = triggerWords.join(', ') + ', ';
    let stripped = text;
    while (stripped.startsWith(prefix)) {
        stripped = stripped.slice(prefix.length).trim();
    }
    return stripped || text;
}

// Generate an image from a text prompt and write it into data/generated.
// Returns { url, filename, width, height }.
async function generateImage(prompt, options = {}) {
    return withGenerationLock(async () => {
        await ensureGeneratedDir();
        const startedAt = Date.now();

        const seed = Number.isInteger(options.seed) && options.seed >= 0
            ? options.seed
            : Math.floor(Math.random() * 2 ** 32);
        // Prefer a fresh read of the global settings so edits made through
        // the settings panel take effect without restarting the server.
        const settings = effectiveSettings();

        // Prepend trigger words from active LoRAs to the prompt. The incoming
        // prompt is normalized first so a value that already carries a
        // trigger-word prefix (e.g. from task state or generated metadata) is
        // stripped — the words are prepended exactly once, never duplicated.
        const cleanPrompt = stripLoraTriggerWords(prompt);
        const triggerWords = (settings.loras || [])
            .filter((l) => l && l.on && l.name && l.triggerWord)
            .map((l) => l.triggerWord);
        const finalPrompt = triggerWords.length
            ? triggerWords.join(', ') + ', ' + String(cleanPrompt || '')
            : String(cleanPrompt || '');

        const graph = buildKrea2T2IGraph(finalPrompt, Object.assign({}, options, { seed, settings }));

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

        // The image is safely on disk — remove the ComfyUI original (and its
        // history entry) so it isn't stored twice. Best-effort; a cleanup
        // failure never breaks the finished generation.
        await comfyui.deleteOutputFile(entry, { history: pid });

        // Record lightweight metadata so the Generated gallery can show it.
        const activeLoras = (settings.loras || [])
            .filter((l) => l && l.on && l.name)
            .map((l) => ({ name: l.name, strength: Number(l.strength) || 0, triggerWord: l.triggerWord || '' }));
        const meta = generatedHistory.add({
            file: '/generated/' + encodeURIComponent(basename),
            rawFilename: basename,
            prompt: finalPrompt,
            model: 'Krea2',
            loras: activeLoras,
            width: settings.width,
            height: settings.height,
            generationMs: Date.now() - startedAt
        });

        return {
            url: meta.file,
            filename: basename,
            width: settings.width,
            height: settings.height,
            prompt: finalPrompt,
            generationMs: meta.generationMs,
            meta
        };
    });
}

module.exports = {
    GENERATED_DIR,
    IMAGE_INTENT_SYSTEM_PROMPT,
    PROMPT_BUILDER_SYSTEM_PROMPT,
    DEFAULT_SETTINGS,
    ASPECT_RATIOS,
    IMAGE_SIZES,
    IMAGE_MEGAPIXELS,
    canStartGeneration,
    detectIntent,
    buildImagePrompt,
    imageRequestStrength,
    extractImageSubject,
    stripCreativeMetaInstructions,
    resolveDimensions,
    generateImage,
    stripLoraTriggerWords,
    buildKrea2T2IGraph,
    buildLoraChain,
    validateGraphAgainstComfy,
    effectiveSettings,
    getDefaults,
    saveSettings,
    getModelChoices,
    detectUpscaleIntent,
    upscaleImage,
    buildSeedVr2ImageUpscaleGraph,
    buildUltimateSdUpscaleGraph,
    seedVr2Profile,
    resolveUpscaleResolution,
    readImageDimensions,
    UPSCALE_SIGNAL_RE,
    UPSCALE_REF_RE,
    DEFAULT_SEEDVR2_DIT,
    SHARP_SEEDVR2_DIT,
    DEFAULT_SEEDVR2_VAE,
    DEFAULT_SEEDVR2_ATTENTION,
    ULTIMATE_SD_UPSCALE_MODEL
};