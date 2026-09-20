/* ============================================
   JARVIS — Image Generation Service
   Detects image-generation intent, builds the
   Krea2 or Qwen Image 2.1 text-to-image workflow
   graph, submits it to ComfyUI, and stores the
   finished image so the chat layer can display it.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');
const comfyui = require('./comfyui');
const configManager = require('../server/config-manager');
const generatedHistory = require('./generated-history');
const generationQueue = require('./generation-queue');

const GENERATED_DIR = path.join(__dirname, '..', 'data', 'generated');

// --- Upscaling constants -------------------------------------------------------
//
// Pipeline selection is shared across media. SeedVR2 is a tiled diffusion
// upscaler with sharp/balanced detail profiles and an adjustable input noise
// level. Ultimate SD is a prompt-guided tiled upscale that reuses the Krea2
// UNET/CLIP/VAE stack (images only). RTX is a single-pass super-resolution
// node (videos only). When a request asks for an engine its medium cannot
// run, it falls back: images from RTX to SeedVR2, videos from Ultimate SD to
// RTX, so graph construction always yields a runnable pipeline.

const LEGACY_KREA_SEEDVR2_DIT = 'seedvr2_ema_3b_fp16.safetensors';
const DEFAULT_SEEDVR2_DIT = 'seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors';
const SHARP_SEEDVR2_DIT = 'seedvr2_ema_7b_sharp_fp8_e4m3fn_mixed_block35_fp16.safetensors';
const DEFAULT_SEEDVR2_VAE = 'ema_vae_fp16.safetensors';
const DEFAULT_SEEDVR2_ATTENTION = 'sdpa';
const NVIDIA_ONLY_SEEDVR2_ATTENTION = new Set(['sageattn_2', 'sageattn_3', 'flash_attn_2', 'flash_attn_3']);
const ULTIMATE_SD_UPSCALE_MODEL = '4x_foolhardy_Remacri.pth';
const SEEDVR2_NOISE_LEVELS = { off: 0, low: 0.06, medium: 0.15 };

// --- One generation at a time -------------------------------------------------
// Shared FIFO across image/video/upscale (see services/generation-queue.js).
// Extra requests wait their turn instead of failing with generation_busy.

function withGenerationLock(fn, opts = {}) {
    // The queue passes an AbortSignal so a running job can be cancelled
    // promptly (see generationQueue.cancelActive).
    return generationQueue.enqueue((signal) => fn(signal), opts);
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
// Note: "show" is deliberately absent — "show me the image" asks to display
// an existing one, so it must not register as a generation verb.
const GENERATION_VERB_STEMS = [
    'generat', 'creat', 'mak', 'render', 'produc', 'paint', 'draw',
    'imagin', 'design', 'illustrat', 'compos'
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
    const hasImageWord = IMAGE_WORD_RE.test(message) || hasFuzzyImageWord(message);

    if (hasGenerationVerb && hasImageWord) return 'definite';
    if (hasGenerationVerb) return 'likely';
    return null;
}

// Typo-tolerant fallback for image nouns ("iamge", "pictue", "potrait", ...)
// so a misspelled medium still reaches the LLM classifier instead of falling
// through to chat. Plain Levenshtein against the canonical media words.
function hasFuzzyImageWord(message) {
    const tokens = String(message || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/);
    for (const raw of tokens) {
        const token = String(raw || '').trim();
        if (token.length < 4 || token.length > 14) continue;
        if (IMAGE_WORD_RE.test(token)) return true;
        for (const word of IMAGE_MEDIA_WORDS) {
            if (Math.abs(token.length - word.length) > 2) continue;
            if (levenshteinDistance(token, word) <= 2) return true;
        }
    }
    return false;
}

// True when an extracted image concept carries no concrete subject — only
// generic filler ("another image", "an image", "one more", "iamge"). Such
// requests are anaphoric: they mean "another one in the same lineage", never
// a blank concept for the prompt builder to invent from scratch.
const VAGUE_IMAGE_FILLER_RE = /^(?:another|other|one|more|new|next|second|2nd|just|please|me|an?|the|of|for|generate|create|make|give|show|do|image|picture|photo|photograph|portrait|art|artwork|illustration|drawing|painting|wallpaper|poster|logo|avatar|graphic|landscape|interior|iamge|imge|imgae|pictue|potrait)[\s,;.]*$/i;

function isVagueImageConcept(text) {
    const t = String(text || '').trim().replace(/^[",']+|[",'.!?]+$/g, '').trim();
    if (!t) return true;
    const tokens = t.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    const concrete = tokens.filter((tok) => !VAGUE_IMAGE_FILLER_RE.test(tok));
    return concrete.length === 0;
}

// Use the configured LLM to classify intent. Returns
// { intent: 'image_generation', action, user_prompt, creative_mode, explicit_constraints }
// or { intent: 'chat', related_task, message }.
//
// The heuristic decides WHEN the LLM is consulted and supplies the fallback;
// the structured LLM classification (extension of the schema, not the chat
// model's natural-language reply) adds action / creative_mode / constraints.
async function detectIntent(message, providers, provider, model, think) {
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
        ], model, { think: false, temperature: 0 });

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

// Explicit new-image phrasing: a generation verb driving at an image noun
// that names a subject ("generate an image of a forest", "create a picture
// of a dog") or ends the turn ("generate a dreamy image", "draw me a
// portrait"). Tweaks ("make the image brighter", "change the image to
// sunset") do not match — the noun must be followed by of/about/with/for,
// punctuation, or end-of-turn.
const EXPLICIT_NEW_IMAGE_RE = new RegExp(
    '\\b(?:' + GENERATION_VERB_STEMS.join('|') + ')\\w*' +
    '\\b(?:\\s+[\\w\']+){0,6}?\\s+(?:' + IMAGE_MEDIA_WORDS.join('|') + ')s?\\b' +
    '\\s*(?:of\\b|about\\b|with\\b|for\\b|featuring\\b|showing\\b|$|[,.!?:;])',
    'i'
);

function isExplicitNewImageRequest(message) {
    const text = String(message || '');
    if (!text.trim() || isConceptQuestion(text)) return false;
    return EXPLICIT_NEW_IMAGE_RE.test(text);
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
    'concrete visual prompt. You are NOT a keyword generator and you are NOT ' +
    'a summarizer: preserve the user\'s visual intent and all meaningful explicit ' +
    'details, then improve clarity and fill appropriate missing information. ' +
    'Never pad prompts with generic filler such as "cinematic", "highly detailed", ' +
    '"photorealistic", "atmospheric depth", or "professional". Only add a detail ' +
    'when it materially improves the image.\n\n' +

    'CORE PRINCIPLE — INFORMATION PRESERVATION:\n' +
    'The user\'s request is the source of truth. Never remove, weaken, replace, ' +
    'or generalize an explicit visual detail just to make the prompt shorter. ' +
    'Preserve explicit subjects, appearance, clothing, pose, action, expression, ' +
    'setting, objects, composition, camera angle, framing, lens, perspective, ' +
    'depth of field, focus, lighting direction, lighting quality, time of day, ' +
    'color palette, style, and other visual constraints. If the user specifies ' +
    'a detail such as "wide-angle", "deep focus", "slightly off-center", ' +
    '"overhead light", or "most of the bed is visible", that detail MUST remain ' +
    'represented in the final prompt.\n\n' +

    'Do not summarize multiple specific photographic instructions into a vague ' +
    'phrase. For example, do not turn "high-angle, wide-angle, deep focus, ' +
    'slightly off-center framing" into merely "a mobile phone photo". Specific ' +
    'camera and composition instructions must remain specific.\n\n' +

    'VISUAL ATTRIBUTE FIELDS — alongside the prompt you also populate these ' +
    'structured attribute fields. Empty string "" when an attribute is not ' +
    'present or applicable:\n' +
    '- subject: who/what the image shows\n' +
    '- appearance: hair, build, distinguishing physical traits\n' +
    '- top: the upper-body clothing\n' +
    '- bottom: the lower-body clothing\n' +
    '- pose: pose / action / body position\n' +
    '- setting: environment / location / important background elements\n' +
    '- expression: facial expression or gaze direction\n' +
    '- camera: camera angle, framing, composition, lens, perspective\n' +
    '- lighting: light source, direction, quality, intensity, time of day\n' +
    '- focus: depth of field, focus behavior, sharpness\n' +
    '- style: visual medium, photographic aesthetic, artistic style, color grade\n\n' +

    'The attribute fields are a structured representation of the image concept. ' +
    'Do not force information into an inappropriate field. Preserve meaningful ' +
    'details even when they do not fit neatly into one field.\n\n' +

    'PROMPT CONSTRUCTION:\n' +
    'Build the final prompt as natural language that an image-generation model ' +
    'can understand directly. Organize information in a sensible visual order: ' +
    'subject and appearance, clothing, pose/action, environment, composition and ' +
    'camera, lighting, focus, then style/color when applicable.\n' +
    'You may reorganize the user\'s wording for clarity, but do not reduce the ' +
    'amount of meaningful visual information. The final prompt may be multiple ' +
    'sentences when necessary. Conciseness means avoiding redundancy and filler, ' +
    'NOT removing useful visual instructions.\n\n' +

    'ENHANCEMENT:\n' +
    'When the user leaves a visual attribute unspecified, you may fill it according ' +
    'to creative_mode. When an attribute is explicitly specified, preserve it. ' +
    'Do not invent major subjects, objects, wardrobe items, actions, locations, ' +
    'or story elements unless creative_mode and the request clearly allow it. ' +
    'Small complementary details are acceptable when they logically support the ' +
    'existing concept.\n\n' +

    'EXAMPLE — detailed photographic request:\n' +
    'If the user specifies a high-angle selfie, slightly off-center composition, ' +
    'wide-angle mobile perspective, deep focus, most of the bed visible, overhead ' +
    'daylight, minimal shadows, natural skin texture, and cool blue-white grading, ' +
    'ALL of those details must remain represented in the final prompt. Do not ' +
    'compress them into "a realistic mobile photo".\n\n' +

    'Do not default to a person when the user did not ask for one. A mood or ' +
    'style word alone ("dreamy", "moody", "epic", "beautiful") is NOT a subject — ' +
    'invent a varied, fitting subject instead of falling back to a woman/portrait.\n\n' +

    'creative_mode controls how freely you invent unspecified detail:\n' +
    '- "none": stay very close to the user\'s request. Preserve explicit details ' +
    'and only add information needed to make the image prompt coherent. Do not ' +
    'invent unnecessary visual details.\n' +
    '- "light": preserve every explicit detail and fill obvious unspecified visual ' +
    'attributes with restrained, believable choices.\n' +
    '- "full": preserve every explicit detail and freely complete unspecified areas ' +
    'of the visual concept with appropriate subject, setting, composition, lighting, ' +
    'and style. When no subject is given, invent a varied one rather than defaulting ' +
    'to a woman or portrait.\n\n' +

    'PREVIOUS CONTEXT — a previous image prompt may be provided as context ' +
    '(the image generated before). If the user\'s new concept clearly continues ' +
    'the same subject or scene, keep the prior details and layer the change on top ' +
    'of them. If it is genuinely a new subject, do not carry the prior subject, ' +
    'pose, clothing, or scene over. For anaphoric requests such as "another image", ' +
    '"one more", or "generate me another", keep the previous STYLE only (mood, ' +
    'visual language, creative register), while creating a fresh subject and scene. ' +
    'A vague creative request such as "be creative", "something dreamy", or ' +
    '"surprise me" is a NEW subject unless the user explicitly references the ' +
    'previous subject.\n\n' +

    'MODIFICATION — when a current image prompt, its current attribute values, ' +
    'and a modification request are provided, they are the single source of truth:\n' +
    '1. Identify exactly which attribute(s) the user wants changed.\n' +
    '2. Replace ONLY those attributes with concrete, specific new values.\n' +
    '3. Every attribute not being changed must remain unchanged in meaning. Do not ' +
    'silently alter unrelated clothing, appearance, pose, setting, camera, lighting, ' +
    'or style details.\n' +
    '4. Clothing is independent: changing the top never changes the bottom and vice ' +
    'versa unless the user explicitly asks for both.\n' +
    '5. Rebuild the complete prompt from the updated visual state so the image model ' +
    'receives the full context, including unchanged details.\n' +
    '6. List exactly the modified attributes in "changed".\n\n' +

    'OUTPUT:\n' +
    'Respond with ONLY a single JSON object, no markdown, no commentary.\n' +
    '- Brand-new generation: {"prompt": "...", "attributes": {field: value, ...}}\n' +
    '- Modification: {"changed": ["field"], "attributes": {field: value, ...}, "prompt": "..."}';

// Escape raw control characters that appear inside JSON string literals. Models
// often emit a multi-line prompt value with real newlines, which makes
// JSON.parse fail even though the payload is otherwise well-formed.
function repairJsonControlChars(text) {
    let out = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { out += ch; escaped = false; continue; }
        if (ch === '\\') { out += ch; escaped = true; continue; }
        if (ch === '"') { inString = !inString; out += ch; continue; }
        if (inString) {
            if (ch === '\n') { out += '\\n'; continue; }
            if (ch === '\r') { out += '\\r'; continue; }
            if (ch === '\t') { out += '\\t'; continue; }
        }
        out += ch;
    }
    return out;
}

// Pull a single string field out of a malformed JSON reply (last resort).
function extractJsonStringField(text, field) {
    const m = new RegExp('"' + field + '"\\s*:\\s*"').exec(text);
    if (!m) return null;
    let i = m.index + m[0].length;
    let out = '';
    while (i < text.length) {
        const ch = text[i];
        if (ch === '\\') {
            const next = text[i + 1];
            if (next === 'n') out += '\n';
            else if (next === 't') out += '\t';
            else if (next === 'r') out += '\r';
            else if (next === '"') out += '"';
            else if (next === '\\') out += '\\';
            else out += (next === undefined ? '\\' : next);
            i += 2;
            continue;
        }
        if (ch === '"') {
            const rest = text.slice(i + 1).trim();
            if (rest === '' || rest.startsWith(',') || rest.startsWith('}')) break;
            out += ch;
            i += 1;
            continue;
        }
        out += ch;
        i += 1;
    }
    return out;
}

// Pull a balanced object field (attributes) out of a malformed JSON reply.
function extractJsonObjectField(text, field) {
    const m = new RegExp('"' + field + '"\\s*:\\s*\\{').exec(text);
    if (!m) return null;
    let i = m.index + m[0].length;
    let depth = 1;
    let inString = false;
    let escaped = false;
    const start = i;
    for (; i < text.length && depth > 0; i++) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
    }
    try {
        return JSON.parse(repairJsonControlChars('{' + text.slice(start, i - 1) + '}'));
    } catch (err) {
        return null;
    }
}

// Strip code fences and isolate the JSON payload from the enhancer's reply.
// Falls back to a lenient repair (raw newlines inside strings) and finally to
// field extraction so a good prompt is never discarded over formatting.
function parseEnhancerJson(raw) {
    if (!raw) return null;
    let text = String(raw).trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) text = fenced[1].trim();
    const braceStart = text.indexOf('{');
    const braceEnd = text.lastIndexOf('}');
    if (braceStart === -1 || braceEnd === -1 || braceEnd <= braceStart) return null;
    text = text.slice(braceStart, braceEnd + 1);

    try { return JSON.parse(text); } catch (err) { /* repair below */ }
    try { return JSON.parse(repairJsonControlChars(text)); } catch (err) { /* extract below */ }

    const prompt = extractJsonStringField(text, 'prompt');
    if (!prompt) return null;
    const out = { prompt };
    const attributes = extractJsonObjectField(text, 'attributes');
    if (attributes) out.attributes = attributes;
    return out;
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

// True when the enhancer merely repeats the concept instead of expanding it.
function isImagePromptEcho(prompt, raw) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const p = norm(prompt);
    const r = norm(raw);
    if (!p) return true;
    if (!r) return false;
    if (p === r) return true;
    if (/\b(?:generat|creat|mak|render|draw|paint|imagin|illustrat)\w*\b|\bmind\s*blowing\b|\bsurprise\s+me\b|\bbe\s+creative\b/i.test(raw) &&
        p.includes(r)) {
        return true;
    }
    return false;
}

// A plain-text reply is only accepted when it is a plausible description, not a
// one-word refusal or an error message.
function looksLikeValidLitePrompt(text) {
    const t = String(text || '').trim();
    if (t.length < 20) return false;
    if (/^(?:i\s+(?:can'?t|cannot|won'?t|am unable)|sorry|as an ai|i'?m not able)\b/i.test(t)) return false;
    return true;
}

// Plain-text enhancer used when the JSON-envelope builder fails twice.
const PROMPT_BUILDER_LITE_SYSTEM_PROMPT =
    'You are JARVIS\'s creative visual director for a local image-generation ' +
    'pipeline (Krea2/ComfyUI). Rewrite the request into ONE complete, concrete ' +
    'visual prompt of one or two sentences. Fill missing visual information with ' +
    'specific, usable detail; never pad with generic filler such as "cinematic", ' +
    '"highly detailed", "photorealistic", or "professional". Never change the ' +
    'subject or drop an explicit detail the user gave. Do NOT quote or repeat the ' +
    'user\'s instruction, and never include imperative or meta words such as ' +
    '"generate", "create", "make", "mindblowing", "epic", or "be creative". ' +
    'Output the prompt only — no JSON, no labels, no markdown.';

// Use the conversational model to build the final image-generation prompt from
// the structured intent data. Returns { prompt, attributes } so modifications
// can deterministically preserve untouched details. In modify mode the current
// prompt + current attributes are the source of truth: only the targeted fields
// change and every other field is copied verbatim from the stored attributes.
// The enhancer is retried, then a plain-text rewrite is attempted, and only if
// both fail does it fall back to a sanitized concept (never the raw request).
async function buildImagePrompt(structuredRequest, providers, provider, model, think) {
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

    const requestRaw = String((isModify ? modification : user_prompt) || user_prompt || '').trim();

    for (let attempt = 0; attempt < 2; attempt++) {
        const retryNote = attempt > 0
            ? '\n\nYour previous answer was invalid. Expand the request into a concrete visual ' +
              'prompt. Do NOT quote or repeat the user\'s words. Output ONLY the JSON object.'
            : '';
        try {
            const raw = await providers.chat(provider, [
                { role: 'system', content: PROMPT_BUILDER_SYSTEM_PROMPT },
                { role: 'user', content: userMessage + retryNote }
            ], model, { think });

            const parsed = parseEnhancerJson(raw);
            const prompt = parsed && typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '';
            if (prompt && !isImagePromptEcho(prompt, requestRaw)) {
                let attributes = normalizeAttributes(parsed.attributes);
                if (isModify) {
                    attributes = mergeVisualAttributes(base_attributes, parsed.attributes, parsed.changed);
                }
                return { prompt, attributes };
            }
            console.warn('[image-generator] Prompt builder returned an invalid or echoing prompt (attempt ' + (attempt + 1) + ')');
        } catch (err) {
            console.warn('[image-generator] Prompt builder failed:', err.message);
        }
    }

    // Plain-text retry: same request, no JSON envelope.
    try {
        const raw = await providers.chat(provider, [
            { role: 'system', content: PROMPT_BUILDER_LITE_SYSTEM_PROMPT },
            { role: 'user', content: userMessage }
        ], model, { think });
        const lite = String(raw || '').trim();
        if (looksLikeValidLitePrompt(lite) && !/^\{/.test(lite) && !isImagePromptEcho(lite, requestRaw)) {
            return {
                prompt: lite,
                attributes: isModify ? (base_attributes || null) : null
            };
        }
        console.warn('[image-generator] Prompt builder lite retry returned an invalid or echoing prompt');
    } catch (err) {
        console.warn('[image-generator] Prompt builder lite retry failed:', err.message);
    }

    if (isModify) {
        console.warn('[image-generator] Prompt builder modify failed; keeping current prompt unchanged.');
        return {
            prompt: String(base_prompt || user_prompt || '').trim(),
            attributes: base_attributes || null
        };
    }
    // Last resort: never forward the raw imperative — keep only the subject.
    const sanitized = stripCreativeMetaInstructions(
        (extractImageSubject(user_prompt || '').prompt || '').trim()
    );
    return {
        prompt: sanitized || String(user_prompt || '').trim() || 'a detailed imaginative scene',
        attributes: null
    };
}

// --- Resolution (Aspect Ratio + Size) ------------------------------------------
//
// The only user-facing resolution controls are the S/M/L size tiers (see
// public/app.js RESOLUTION_SIZE_OPTIONS + createSizeLabel): S is 0.75 MP,
// M is 1 MP, L is 1.75 MP total pixels. Dimensions are derived from the
// aspect ratio as
//   w = snapToLatentGrid(sqrt(pixels * ratio)),
//   h = snapToLatentGrid(sqrt(pixels / ratio))
// so M + 1:1 yields ~992x992, M + 4:5 yields ~896x1120, and
// M + 16:9 yields ~1344x736. Dimensions are snapped to multiples of 32
// before reaching Krea2.

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

function snapToLatentGrid(pixels) {
    const grid = 32;
    return Math.max(64, Math.round(pixels / grid) * grid);
}

// Map aspectRatio + imageSize to concrete Krea2 latent dimensions. Invalid
// inputs fall back to the 4:5 / M defaults.
function resolveDimensions(settings) {
    const source = settings || {};
    const ratio = normalizeAspectRatio(source.aspectRatio) || '4:5';
    const size = normalizeImageSize(source.imageSize) || 'M';
    const [ratioWidth, ratioHeight] = ratio.split(':').map(Number);
    const shape = Math.min(10, Math.max(0.1, (ratioWidth / ratioHeight) || 1));
    const targetPixels = (IMAGE_MEGAPIXELS[size] || IMAGE_MEGAPIXELS.M) * 1e6;
    const longEdge = Math.sqrt(targetPixels * shape);
    const shortEdge = Math.sqrt(targetPixels / shape);
    return {
        width: snapToLatentGrid(longEdge),
        height: snapToLatentGrid(shortEdge),
        aspectRatio: ratio,
        imageSize: size
    };
}

// --- Krea2 text-to-image workflow ----------------------------------------------
//
// The canonical JARVIS text-to-image graph submitted to ComfyUI:
//
//   UNETLoader (krea2 turbo)  →  CLIPLoader (krea2)  →  VAELoader
//   CLIPTextEncode (positive = prompt, negative = zero-out)
//   EmptySD3LatentImage
//   KSampler (euler / beta, steps 8, cfg 1, seed from settings)
//   VAEDecode → SaveImage (not-so-jarvis/gen)

// --- Image model selection ------------------------------------------------------
//
// JARVIS ships two text-to-image pipelines and the user picks one with the
// topmost IMAGE MODEL dropdown in Settings > Image. Both reuse the same
// UNET(net)/CLIP(text encoder)/VAE slots:
//   - krea2:          the Krea 2 Turbo graph (euler / beta).
//   - qwen_image_2_1: the Qwen Image 2.1 graph (Qwen3-VL 8B text encoder,
//                     euler / simple, cfg 1, its own TextEncodeQwenImage21 node).
// The Krea2 slot keys (unet/clip/vae) keep their historical meaning; Qwen's
// filenames live under qwen* keys so switching back and forth remembers both.

const IMAGE_MODELS = ['krea2', 'qwen_image_2_1'];
const DEFAULT_IMAGE_MODEL = 'krea2';
const QWEN_IMAGE_CLIP_TYPE = 'qwen_image';
// Qwen Image 2.1's official pipeline samples at euler/simple, cfg 1, ~25 steps.
const DEFAULT_QWEN_STEPS = 25;
const DEFAULT_QWEN_CFG = 1;

function normalizeImageModel(value) {
    const v = String(value || '').trim().toLowerCase().replace(/[\s.-]+/g, '_');
    if (v === 'qwen' || v === 'qwen2' || v === 'qwen_2' || v === 'qwen_image' ||
        v === 'qwen_image_2' || v === 'qwen_image_21' || v === 'qwen_image_2_1') {
        return 'qwen_image_2_1';
    }
    if (v === 'krea2' || v === 'krea_2' || v === 'krea') return 'krea2';
    return null;
}

const DEFAULT_SETTINGS = {
    // Active text-to-image model: 'krea2' (default) or 'qwen_image_2_1'.
    model: normalizeImageModel(process.env.JARVIS_IMAGE_MODEL) || DEFAULT_IMAGE_MODEL,
    unet: process.env.KREA2_UNET || 'krea2_turbo_fp8_scaled.safetensors',
    clip: process.env.KREA2_CLIP || 'Huihui-Qwen3-VL-4B-Instruct-abliterated-fp8_scaled.safetensors',
    clipType: process.env.KREA2_CLIP_TYPE || 'krea2',
    vae: process.env.KREA2_VAE || 'wan_2.1_vae.safetensors',
    // Qwen Image 2.1 slot (Comfy-Org/Qwen-Image-2.1). The CLIP type is fixed
    // to 'qwen_image'; the setup guide downloads these from Hugging Face.
    qwenUnet: process.env.QWEN_IMAGE_UNET || 'qwen_image_2.1_int8_convrot.safetensors',
    qwenClip: process.env.QWEN_IMAGE_CLIP || 'qwen3vl_8b_int8_convrot.safetensors',
    qwenVae: process.env.QWEN_IMAGE_VAE || 'qwen_image_2.1_vae_bf16.safetensors',
    // Identity Edit LoRA used by the Krea2 instruction-based edit pipeline
    // (community fine-tune conradlocke/krea2-identity-edit). It edits a source
    // image from a plain-language instruction while preserving the rest.
    editLora: process.env.KREA2_EDIT_LORA || 'krea2_identity_edit_v1_2.safetensors',
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
    // Seed control: 'random' picks a fresh seed per image, 'fixed' reuses
    // `seed` so a result is reproducible. `variations` (1-4) generates that
    // many images per request, each using seed + index — so a fixed seed gives
    // a reproducible set of variations.
    seedMode: 'random',
    seed: 0,
    variations: 1,
    // Stacked LoRAs applied to every Krea2 generation, in order. Each entry
    // is { name, strength, on, triggerWord } where strength is the model+clip
    // LoRA scale and triggerWord is an optional keyword prepended to the prompt.
    loras: [],
    // Remembered trigger words keyed by LoRA name. Kept separate from the
    // active stack so a removed LoRA keeps its trigger word if re-added later.
    loraTriggerWords: {},
    // Image upscaling (SeedVR2 / Ultimate SD for images, RTX fast path for
    // video). Profile is "sharp" (sharp DiT variant) or "balanced"; noise is
    // off/low/medium detail input noise; mode is "target" (target short-side
    // resolution) or "multiplier" (scale factor on the source short side);
    // preScale applies an optional lanczos pre-resize before SeedVR2 (1 = off).
    // Engine is shared with video: images run SeedVR2/Ultimate SD (an RTX
    // selection falls back to SeedVR2 for images); videos run SeedVR2/RTX (an
    // Ultimate SD selection falls back to RTX for video). RTX video upscale
    // uses upscaleMultiplier as its scale factor. Default is RTX so video
    // upscales stay fast; image upscales are unaffected.
    upscaleEngine: 'rtx',
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
const CONFIGURABLE_KEYS = ['model', 'unet', 'clip', 'clipType', 'vae', 'qwenUnet', 'qwenClip', 'qwenVae', 'editLora', 'aspectRatio', 'imageSize', 'width', 'height', 'steps', 'cfg', 'seedMode', 'seed', 'variations', 'loras', 'loraTriggerWords',
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

// Resolve the active model's UNET/CLIP/VAE (and CLIP type) from settings.
// Downstream graph builders read these slots; the Krea2 edit/upscale pipelines
// keep using the raw Krea2 keys because they are Krea2-specific, while the
// text-to-image path resolves through here so the selected model actually runs.
function resolveBaseModels(settings) {
    const source = settings || DEFAULT_SETTINGS;
    if (normalizeImageModel(source.model) === 'qwen_image_2_1') {
        return {
            unet: String(source.qwenUnet || DEFAULT_SETTINGS.qwenUnet).trim(),
            clip: String(source.qwenClip || DEFAULT_SETTINGS.qwenClip).trim(),
            clipType: QWEN_IMAGE_CLIP_TYPE,
            vae: String(source.qwenVae || DEFAULT_SETTINGS.qwenVae).trim()
        };
    }
    return {
        unet: String(source.unet || DEFAULT_SETTINGS.unet).trim(),
        clip: String(source.clip || DEFAULT_SETTINGS.clip).trim(),
        clipType: String(source.clipType || DEFAULT_SETTINGS.clipType).trim(),
        vae: String(source.vae || DEFAULT_SETTINGS.vae).trim()
    };
}

function clampToRange(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    if (parsed < min) return min;
    if (parsed > max) return max;
    return parsed;
}

// ComfyUI seeds are unsigned 32-bit. Normalize any input into that range;
// returns null when the value is not a finite number.
const MAX_SEED = 4294967295;
function normalizeSeed(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && !value.trim()) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const range = MAX_SEED + 1;
    return ((Math.floor(n) % range) + range) % range;
}

// Resolve the seed for one generation. A per-request seed always wins; a
// 'fixed' seedMode reuses the stored seed; otherwise a fresh random seed.
function resolveSeed(settings, requestedSeed) {
    const requested = normalizeSeed(requestedSeed);
    if (requested !== null) return requested;
    if (settings && settings.seedMode === 'fixed') {
        const fixed = normalizeSeed(settings.seed);
        if (fixed !== null) return fixed;
    }
    return Math.floor(Math.random() * 2 ** 32);
}

// Normalize a client-supplied LoRA list. Drops entries without a name and
// clamps strength to the -100..100 range the loader accepts (the UI uses 0..2).
function sanitizeLoras(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const item of value) {
        const name = String((item && item.name) || '').trim();
        if (!name) continue;
        const triggerWord = String((item && item.triggerWord) || '').trim();
        out.push({
            name,
            strength: clampToRange(item.strength, -100, 100, 1),
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
        } else if (key === 'model') {
            const v = normalizeImageModel(value);
            if (v) out[key] = v;
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
        } else if (key === 'seedMode') {
            const v = String(value || '').toLowerCase();
            if (v === 'random' || v === 'fixed') out[key] = v;
        } else if (key === 'seed') {
            const n = normalizeSeed(value);
            if (n !== null) out[key] = n;
        } else if (key === 'variations') {
            const n = Math.round(Number(value));
            if (Number.isFinite(n)) out[key] = Math.max(1, Math.min(4, n));
        } else if (key === 'upscaleEngine') {
            const v = String(value || '').toLowerCase();
            if (v === 'seedvr2' || v === 'ultimate' || v === 'rtx') out[key] = v;
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

function clampToInt(value, min, max, fallback) {
    const rounded = Math.round(Number(value));
    return Number.isFinite(rounded) ? clampToRange(rounded, min, max, fallback) : fallback;
}

function buildDiffusionLoaderNode(unetName) {
    const name = String(unetName || '').trim();
    return /\.gguf$/i.test(name)
        ? { class_type: 'UnetLoaderGGUF', inputs: { unet_name: name } }
        : { class_type: 'UNETLoader', inputs: { unet_name: name, weight_dtype: 'default' } };
}

// Stack LoraLoader nodes on top of the base UNET/CLIP loaders. Each enabled
// LoRA consumes the previous loader's model/clip outputs, so the stack is
// applied in order. Returns the final { model, clip } references the sampler
// and prompt encoders link to.
function buildLoraChain(graph, loras) {
    let modelLink = ['unet', 0];
    let clipLink = ['clip', 0];
    let position = 0;
    for (const entry of loras || []) {
        if (!(entry && entry.on && entry.name)) continue;
        position += 1;
        const nodeId = 'lora' + position;
        const strength = Number(entry.strength) || 0;
        graph[nodeId] = {
            class_type: 'LoraLoader',
            inputs: {
                model: modelLink,
                clip: clipLink,
                lora_name: entry.name,
                strength_model: strength,
                strength_clip: strength
            }
        };
        modelLink = [nodeId, 0];
        clipLink = [nodeId, 1];
    }
    return { model: modelLink, clip: clipLink };
}

function buildKrea2T2IGraph(prompt, options = {}) {
    const settings = Object.assign({}, DEFAULT_SETTINGS, options.settings || {});
    const seed = Number.isInteger(options.seed) && options.seed >= 0 ? options.seed : 0;
    const width = clampToInt(options.width || settings.width, 64, 4096, settings.width);
    const height = clampToInt(options.height || settings.height, 64, 4096, settings.height);
    const steps = clampToInt(options.steps || settings.steps, 1, 100, settings.steps);
    const cfg = Number.isFinite(Number(options.cfg)) ? Math.max(0, Number(options.cfg)) : settings.cfg;
    const negativeText = String(options.negativePrompt || '').trim();

    const graph = {
        unet: buildDiffusionLoaderNode(settings.unet),
        clip: { class_type: 'CLIPLoader', inputs: { clip_name: settings.clip, type: settings.clipType, device: 'default' } },
        vae: { class_type: 'VAELoader', inputs: { vae_name: settings.vae } }
    };

    // Apply any attached LoRAs on top of the base model + clip. With no LoRAs
    // configured (or all disabled) the stack returns the raw ['unet', 0] /
    // ['clip', 0] links, leaving a plain text-to-image graph.
    const stack = buildLoraChain(graph, settings.loras);

    graph.positive = { class_type: 'CLIPTextEncode', inputs: { clip: stack.clip, text: String(prompt || '') } };
    graph.negative = negativeText
        ? { class_type: 'CLIPTextEncode', inputs: { clip: stack.clip, text: negativeText } }
        : { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['positive', 0] } };

    graph.canvas = {
        class_type: 'EmptySD3LatentImage',
        inputs: { width, height, batch_size: 1 }
    };

    graph.sampler = {
        class_type: 'KSampler',
        inputs: {
            model: stack.model,
            positive: ['positive', 0],
            negative: ['negative', 0],
            latent_image: ['canvas', 0],
            seed,
            steps,
            cfg,
            sampler_name: 'euler',
            scheduler: 'beta',
            denoise: 1
        }
    };

    graph.decoded = { class_type: 'VAEDecode', inputs: { samples: ['sampler', 0], vae: ['vae', 0] } };
    graph.save = { class_type: 'SaveImage', inputs: { images: ['decoded', 0], filename_prefix: 'not-so-jarvis/gen' } };

    return graph;
}

// --- Qwen Image 2.1 text-to-image workflow -------------------------------------
//
// The canonical JARVIS graph for the Qwen Image 2.1 model, mirroring the
// official Comfy-Org template (image_qwen_image_2_1_t2i):
//
//   UNETLoader (qwen_image_2.1_int8_convrot)  →  CLIPLoader (type qwen_image)
//   VAELoader (qwen_image_2.1_vae_bf16)
//   TextEncodeQwenImage21 (prompt + negative_prompt → positive / negative)
//   EmptyLatentImage
//   KSampler (euler / simple, cfg 1, 25 steps)
//   VAEDecode → SaveImage (not-so-jarvis/gen)
//
// Qwen Image 2.1 uses ComfyUI's dedicated TextEncodeQwenImage21 node (a Qwen3-VL
// text encoder with its own prompt/negative template) instead of CLIPTextEncode,
// so the Krea2 builder above cannot be reused. The negative_prompt stays empty by
// default because the official path runs at cfg 1, where the negative is unused.
function buildQwenImage21T2IGraph(prompt, options = {}) {
    const settings = Object.assign({}, DEFAULT_SETTINGS, options.settings || {});
    const base = resolveBaseModels(settings);
    const seed = Number.isInteger(options.seed) && options.seed >= 0 ? options.seed : 0;
    const width = clampToInt(options.width || settings.width, 64, 4096, settings.width);
    const height = clampToInt(options.height || settings.height, 64, 4096, settings.height);
    const steps = clampToInt(options.steps, 1, 100, DEFAULT_QWEN_STEPS);
    const cfg = Number.isFinite(Number(options.cfg)) ? Math.max(0, Number(options.cfg)) : DEFAULT_QWEN_CFG;
    const negativeText = String(options.negativePrompt || '').trim();
    // Reference-image budget for the Qwen3-VL encoder. No reference image is
    // wired here (pure text-to-image), so 1024 matches the official template.
    const resolution = clampToInt(options.encoderResolution, 0, 4096, 1024);

    const graph = {
        unet: buildDiffusionLoaderNode(base.unet),
        clip: { class_type: 'CLIPLoader', inputs: { clip_name: base.clip, type: QWEN_IMAGE_CLIP_TYPE, device: 'default' } },
        vae: { class_type: 'VAELoader', inputs: { vae_name: base.vae } }
    };

    // Apply any attached LoRAs on top of the base model + clip (LoraLoader
    // consumes and returns both, so the stack feeds the encoder and sampler).
    const stack = buildLoraChain(graph, settings.loras);

    graph.conditioning = {
        class_type: 'TextEncodeQwenImage21',
        inputs: {
            clip: stack.clip,
            prompt: String(prompt || ''),
            negative_prompt: negativeText,
            resolution
        }
    };

    graph.canvas = {
        class_type: 'EmptyLatentImage',
        inputs: { width, height, batch_size: 1 }
    };

    graph.sampler = {
        class_type: 'KSampler',
        inputs: {
            model: stack.model,
            positive: ['conditioning', 0],
            negative: ['conditioning', 1],
            latent_image: ['canvas', 0],
            seed,
            steps,
            cfg,
            sampler_name: 'euler',
            scheduler: 'simple',
            denoise: 1
        }
    };

    graph.decoded = { class_type: 'VAEDecode', inputs: { samples: ['sampler', 0], vae: ['vae', 0] } };
    graph.save = { class_type: 'SaveImage', inputs: { images: ['decoded', 0], filename_prefix: 'not-so-jarvis/gen' } };

    return graph;
}

// Confirm ComfyUI knows every node class in the graph and accepts the clip type
// the graph requires, so failures surface as specific, actionable errors rather
// than a raw queue rejection. `expectedClipType` defaults to the Krea2 type for
// backwards compatibility.
async function validateGraphAgainstComfy(info, graph, expectedClipType) {
    const missing = Object.values(graph)
        .filter((node) => !info[node.class_type])
        .map((node) => node.class_type);
    if (missing.length) {
        const error = new Error(
            'ComfyUI is missing custom node' + (missing.length > 1 ? 's' : '') + ': ' +
            missing.join(', ') + '. Install them (and restart ComfyUI), then try again.'
        );
        error.code = 'comfyui_missing_nodes';
        error.missingNodes = missing;
        throw error;
    }

    const requiredType = String(expectedClipType || DEFAULT_SETTINGS.clipType || 'krea2');
    const clipNode = info.CLIPLoader;
    const typeField = clipNode && clipNode.input && clipNode.input.required && clipNode.input.required.type;
    if (typeField) {
        const acceptedTypes = typeField[0];
        if (Array.isArray(acceptedTypes) && !acceptedTypes.includes(requiredType)) {
            const error = new Error(
                'This ComfyUI build does not support the ' + requiredType + ' CLIPLoader type. ' +
                'Update ComfyUI, then try again.'
            );
            error.code = requiredType === 'krea2' ? 'comfyui_krea2_clip_unsupported' : 'comfyui_clip_type_unsupported';
            error.clipType = requiredType;
            throw error;
        }
    }
}

// --- Upscaling -----------------------------------------------------------------
//
// Images can run one of two engines (videos add a third, RTX — see
// services/video-generator.js):
//   - SeedVR2: a tiled diffusion upscaler. The "sharp" profile selects the
//     sharp 7B DiT variant (falling back to balanced when it is not installed),
//     and the noise level controls the detail input noise (off/low/medium).
//   - Ultimate SD: a prompt-guided tiled upscaler (UltimateSDUpscale custom
//     node) driven by the same Krea2 UNET/CLIP/VAE models as generation.
//
// The source image lives in data/generated/ and is uploaded into ComfyUI's
// input folder so a LoadImage node can reference it; the finished upscale is
// downloaded back into data/generated/ and recorded in generated-history.

function isSevenBSeedVr2(model) {
    return /(?:^|[_-])7b(?:[_-]|$)/i.test(String(model || ''));
}

// sageattn / flash-attn v2+ kernels only run on NVIDIA hardware; on any other
// vendor they are downgraded to the portable default so graph building never
// aborts.
function resolveSeedVr2Attention(value, vendor) {
    const chosen = String(value || DEFAULT_SEEDVR2_ATTENTION);
    const vendorKey = String(vendor || '').toLowerCase();
    const mustDowngrade = vendorKey && vendorKey !== 'nvidia' && NVIDIA_ONLY_SEEDVR2_ATTENTION.has(chosen);
    return mustDowngrade ? DEFAULT_SEEDVR2_ATTENTION : chosen;
}

function buildSeedVr2DitLoaderInputs(settings) {
    const checkpoint = settings.seedvr2Dit || DEFAULT_SEEDVR2_DIT;
    return {
        model: checkpoint,
        device: 'cuda:0',
        blocks_to_swap: isSevenBSeedVr2(checkpoint) ? 32 : 0,
        swap_io_components: true,
        offload_device: 'cpu',
        cache_model: false,
        attention_mode: resolveSeedVr2Attention(settings.seedvr2Attention, settings.gpuVendor || '')
    };
}

function normalizeSeedVr2Noise(requested) {
    return requested === 'off' || requested === 'low' || requested === 'medium' ? requested : 'low';
}

function seedVr2Profile(settings, requestedProfile, availableModels, requestedNoise) {
    const noise = normalizeSeedVr2Noise(requestedNoise);
    const sharpInstalled = !Array.isArray(availableModels) || availableModels.includes(SHARP_SEEDVR2_DIT);
    if (requestedProfile === 'sharp' && sharpInstalled) {
        return {
            key: 'sharp',
            ditModel: SHARP_SEEDVR2_DIT,
            colorCorrection: 'wavelet',
            noise,
            inputNoiseScale: SEEDVR2_NOISE_LEVELS[noise]
        };
    }
    return {
        key: 'balanced',
        ditModel: settings.seedvr2Dit || DEFAULT_SEEDVR2_DIT,
        colorCorrection: 'lab',
        noise,
        inputNoiseScale: SEEDVR2_NOISE_LEVELS[noise]
    };
}

// List the SeedVR2 checkpoint files ComfyUI currently has on disk so the
// sharp profile can tell whether its 7B-sharp DiT is installed.
function listInstalledSeedVr2Checkpoints(dirs) {
    const found = new Set();
    for (const dir of dirs || []) {
        if (!dir) continue;
        let entries;
        try {
            entries = fs.readdirSync(dir);
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry || entry.endsWith('.download')) continue;
            const ext = path.extname(entry).toLowerCase();
            if (ext !== '.safetensors' && ext !== '.gguf') continue;
            found.add(entry);
        }
    }
    return Array.from(found);
}

// Directories to scan for installed SeedVR2 checkpoints: explicit env
// overrides first (KREA2_SEEDVR2_DIR / COMFYUI_SEEDVR2_DIR), then ComfyUI's
// models/seedvr2 (or models/SEEDVR2) folder.
async function resolveSeedVr2ModelDirs() {
    const dirs = [];
    for (const value of [process.env.KREA2_SEEDVR2_DIR, process.env.COMFYUI_SEEDVR2_DIR]) {
        if (value) dirs.push(path.resolve(value));
    }
    let modelRoot = null;
    try {
        modelRoot = await comfyui.resolveModelRoot();
    } catch {
        modelRoot = null;
    }
    if (modelRoot) {
        for (const folder of ['seedvr2', 'SEEDVR2']) {
            const dir = path.join(modelRoot, folder);
            if (fs.existsSync(dir)) dirs.push(dir);
        }
    }
    return dirs;
}

// Read width/height straight from a PNG or JPEG header (no dependencies). PNG
// dimensions sit at fixed offsets in the IHDR chunk; JPEG dimensions are found
// by walking the marker segments to the SOF frame. Any other format yields
// { width: 0, height: 0 } so multiplier mode can fall back to target resolution.
function readImageDimensions(filePath) {
    const UNKNOWN = { width: 0, height: 0 };
    let data;
    try {
        data = fs.readFileSync(filePath);
    } catch {
        return UNKNOWN;
    }
    if (data.length > 24 && data.toString('ascii', 1, 4) === 'PNG') {
        return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    }
    if (!(data.length > 2 && data[0] === 0xFF && data[1] === 0xD8)) return UNKNOWN;
    const NOT_A_FRAME_HEADER = new Set([0xC4, 0xC8, 0xCC]);
    let pos = 2;
    while (pos <= data.length - 10) {
        if (data[pos] !== 0xFF) {
            pos += 1;
            continue;
        }
        const marker = data[pos + 1];
        const isStandalone = marker === 0x01 || marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7);
        if (isStandalone) {
            pos += 2;
            continue;
        }
        const isFrameHeader = marker >= 0xC0 && marker <= 0xCF && !NOT_A_FRAME_HEADER.has(marker);
        if (isFrameHeader) {
            return { width: data.readUInt16BE(pos + 7), height: data.readUInt16BE(pos + 5) };
        }
        pos += 2 + data.readUInt16BE(pos + 2);
    }
    return UNKNOWN;
}

// Turn the configured upscale mode into a concrete SeedVR2 target resolution.
// "target" uses the configured short-side resolution; "multiplier" scales the
// source short side by the multiplier (clamped to 512..8192).
function resolveUpscaleResolution(sourceWidth, sourceHeight, settings, requested) {
    const request = requested || {};
    const mode = request.mode || settings.upscaleMode || 'target';
    const hasSource = sourceWidth > 0 && sourceHeight > 0;
    if (mode === 'multiplier' && hasSource) {
        const factor = clampToRange(request.multiplier || settings.upscaleMultiplier, 1, 4, 2);
        return Math.max(512, Math.min(8192, Math.round(Math.min(sourceWidth, sourceHeight) * factor)));
    }
    return clampToRange(request.resolution || settings.upscaleResolution, 512, 8192, 2160);
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
    if (!UPSCALE_SIGNAL_RE.test(norm) && !hasFuzzyUpscaleSignal(norm)) return null;
    if (!UPSCALE_REF_RE.test(norm)) return null;
    return { intent: 'image_upscale' };
}

// Typo-tolerant fallback for the upscale verb ("uspcale", "upscalle",
// "upcsale", ...). Plain Levenshtein against the canonical forms with a
// threshold of 2 catches transpositions and single extra/missing letters
// without opening the gate to unrelated words. The token must also keep the
// head of the verb: a misspelled "upscale" always starts with "u", while the
// distance-2 near-misses ("scale", "scaled", "scaling", "scaler") are ordinary
// prompt vocabulary ("low-angle shot to emphasize scale") and must not route a
// fresh generation request into the upscale pipeline.
function levenshteinDistance(a, b) {
    const s = String(a || '');
    const t = String(b || '');
    if (s === t) return 0;
    if (!s.length) return t.length;
    if (!t.length) return s.length;
    let prev = new Array(t.length + 1);
    for (let j = 0; j <= t.length; j++) prev[j] = j;
    for (let i = 1; i <= s.length; i++) {
        let prevDiag = prev[0];
        prev[0] = i;
        for (let j = 1; j <= t.length; j++) {
            const tmp = prev[j];
            const cost = s[i - 1] === t[j - 1] ? 0 : 1;
            prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, prevDiag + cost);
            prevDiag = tmp;
        }
    }
    return prev[t.length];
}

function hasFuzzyUpscaleSignal(norm) {
    const targets = ['upscale', 'upscaled', 'upscaling', 'upscaler'];
    const tokens = String(norm || '').split(' ');
    for (const raw of tokens) {
        const token = String(raw || '').replace(/[^a-z]/g, '');
        if (token.length < 5 || token.length > 10) continue;
        for (const target of targets) {
            if (token[0] !== target[0]) continue;
            if (levenshteinDistance(token, target) <= 2) return true;
        }
    }
    return false;
}

// --- Upscale graph builders -----------------------------------------------------

function buildSeedVr2ImageUpscaleGraph(imageName, options = {}) {
    const settings = Object.assign({}, DEFAULT_SETTINGS, options.settings || {});
    const profile = seedVr2Profile(settings, options.profile || 'sharp', options.availableModels, options.noise || 'low');
    const seed = Number.isInteger(options.seed) && options.seed >= 0
        ? options.seed
        : Math.floor(Math.random() * 2 ** 31);

    const graph = {};
    graph.load_image = { class_type: 'LoadImage', inputs: { image: imageName } };
    let imageLink = ['load_image', 0];

    const preScale = clampToRange(options.preScale, 1, 4, 1);
    if (preScale !== 1) {
        graph.prescale = {
            class_type: 'ImageScaleBy',
            inputs: { image: imageLink, upscale_method: 'lanczos', scale_by: preScale }
        };
        imageLink = ['prescale', 0];
    }

    graph.dit_loader = {
        class_type: 'SeedVR2LoadDiTModel',
        inputs: buildSeedVr2DitLoaderInputs(Object.assign({}, settings, {
            seedvr2Dit: profile.ditModel,
            gpuVendor: options.gpuVendor || settings.gpuVendor || ''
        }))
    };
    graph.vae_loader = {
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
    graph.upscaler = {
        class_type: 'SeedVR2VideoUpscaler',
        inputs: {
            image: imageLink,
            dit: ['dit_loader', 0],
            vae: ['vae_loader', 0],
            seed,
            resolution: clampToRange(options.resolution, 512, 8192, 2160),
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
    graph.save_image = { class_type: 'SaveImage', inputs: { images: ['upscaler', 0], filename_prefix: 'not-so-jarvis/upscale' } };

    return { graph, profile };
}

function buildUltimateSdUpscaleGraph(imageName, options = {}) {
    const settings = Object.assign({}, DEFAULT_SETTINGS, options.settings || {});
    const scaleFactor = clampToRange(options.scaleFactor, 1, 4, 2);
    const seed = Number.isInteger(options.seed) && options.seed >= 0
        ? options.seed
        : Math.floor(Math.random() * 2 ** 31);
    const prompt = String(options.prompt || '').trim() || 'a faithful, highly detailed upscale of the source image';

    const graph = {};
    graph.load_image = { class_type: 'LoadImage', inputs: { image: imageName } };
    graph.unet = buildDiffusionLoaderNode(settings.unet);
    graph.clip = { class_type: 'CLIPLoader', inputs: { clip_name: settings.clip, type: settings.clipType, device: 'default' } };
    graph.vae = { class_type: 'VAELoader', inputs: { vae_name: settings.vae } };
    const stack = buildLoraChain(graph, settings.loras);
    graph.upscale_model = { class_type: 'UpscaleModelLoader', inputs: { model_name: options.upscaleModel || ULTIMATE_SD_UPSCALE_MODEL } };
    graph.positive = { class_type: 'CLIPTextEncode', inputs: { clip: stack.clip, text: prompt } };
    graph.negative = { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['positive', 0] } };
    graph.ultimate = {
        class_type: 'UltimateSDUpscale',
        inputs: {
            image: ['load_image', 0],
            model: stack.model,
            positive: ['positive', 0],
            negative: ['negative', 0],
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
    graph.save_image = { class_type: 'SaveImage', inputs: { images: ['ultimate', 0], filename_prefix: 'not-so-jarvis/upscale' } };

    return graph;
}

// --- Upscale execution ----------------------------------------------------------
//
// Upscale the image file at data/generated/<rawFilename> and write the result
// into data/generated/. Shares the single-generation lock with generateImage so
// ComfyUI never runs two jobs at once. Returns { url, filename, width, height,
// sourceWidth, sourceHeight, engine, profile, noise, resolution, meta }.
// options.queue / options.onQueued / options.conversationId feed the shared FIFO.
async function upscaleImage(rawFilename, options = {}) {
    const queueOpts = {
        label: options.label || 'image upscale',
        kind: options.kind || 'image_upscale',
        conversationId: options.conversationId || null,
        onQueued: options.onQueued || null,
        onStart: options.onStart || null
    };
    return withGenerationLock(async (signal) => {
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
        // Images only ever run SeedVR2 or Ultimate SD: an RTX selection (the
        // fast video path) falls back to SeedVR2 here, so the image pipeline
        // never receives the RTX engine.
        const engine = String(options.engine || settings.upscaleEngine || 'seedvr2').toLowerCase() === 'ultimate' ? 'ultimate' : 'seedvr2';
        const sourceMeta = findHistoryMeta(safeName);
        const { width: sourceWidth, height: sourceHeight } = readImageDimensions(filePath);
        const resolution = resolveUpscaleResolution(sourceWidth, sourceHeight, settings, options);
        const scaleFactor = clampToRange(options.scaleFactor || options.multiplier || settings.upscaleMultiplier, 1, 4, 2);
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
                const availableModels = listInstalledSeedVr2Checkpoints(await resolveSeedVr2ModelDirs());
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

            const history = await comfyui.waitForPrompt(pid, { timeoutMs: options.timeoutMs, signal });
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
            conversationId: options.conversationId || null,
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
    }, queueOpts);
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
    const queueOpts = {
        label: options.label || 'image generation',
        kind: options.kind || 'image_generation',
        conversationId: options.conversationId || null,
        onQueued: options.onQueued || null,
        onStart: options.onStart || null
    };
    return withGenerationLock(async (signal) => {
        await ensureGeneratedDir();
        const startedAt = Date.now();

        // Prefer a fresh read of the global settings so edits made through
        // the settings panel take effect without restarting the server.
        const settings = effectiveSettings();
        // A per-request seed (e.g. a variation index) wins; a fixed seedMode
        // reuses the stored seed; otherwise a fresh random seed.
        const seed = resolveSeed(settings, options.seed);

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

        // Route to the model selected in Settings > Image. Qwen Image 2.1 needs
        // its own encoder node and sampler defaults; Krea2 stays byte-for-byte
        // the graph it always was. The resolved base models are merged into the
        // builder settings so the active UNET/CLIP/VAE actually run.
        const activeModel = normalizeImageModel(settings.model) || DEFAULT_IMAGE_MODEL;
        const modelSettings = Object.assign({}, settings, resolveBaseModels(settings));
        const graph = activeModel === 'qwen_image_2_1'
            ? buildQwenImage21T2IGraph(finalPrompt, Object.assign({}, options, { seed, settings: modelSettings }))
            : buildKrea2T2IGraph(finalPrompt, Object.assign({}, options, { seed, settings }));

        const info = await comfyui.getObjectInfo();
        await validateGraphAgainstComfy(info, graph, activeModel === 'qwen_image_2_1' ? QWEN_IMAGE_CLIP_TYPE : 'krea2');

        const pid = await comfyui.queuePrompt(graph);
        console.log('[image-generator] queued ' + (activeModel === 'qwen_image_2_1' ? 'Qwen Image 2.1' : 'Krea2') + ' workflow:', pid);

        const history = await comfyui.waitForPrompt(pid, {
            timeoutMs: options.timeoutMs,
            signal
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
            conversationId: options.conversationId || null,
            prompt: finalPrompt,
            model: activeModel === 'qwen_image_2_1' ? 'Qwen Image 2.1' : 'Krea2',
            loras: activeLoras,
            seed,
            width: settings.width,
            height: settings.height,
            generationMs: Date.now() - startedAt
        });

        return {
            url: meta.file,
            filename: basename,
            width: settings.width,
            height: settings.height,
            seed,
            model: activeModel,
            prompt: finalPrompt,
            generationMs: meta.generationMs,
            meta
        };
    }, queueOpts);
}

// --- Krea2 identity edit --------------------------------------------------------
//
// Instruction-based, identity-preserving image editing built on the community
// Identity Edit LoRA (conradlocke/krea2-identity-edit) plus the
// lbouaraba/comfyui-krea2edit nodes. Given a source image and a plain-language
// instruction it edits only what the instruction describes and preserves the
// rest — people, objects, recolor, restyle, removal. A single reference image
// is supported.
//
// Graph: UNET/CLIP/VAE loaders → identity LoRA (LoraLoaderModelOnly) → user
// LoRAs (model-only) → LoadImage/VAEEncode source latent →
// Krea2EditModelPatch (fit geometry, ref_boost fidelity dial) →
// Krea2EditGroundedEncode positive/negative → KSampler (euler/simple,
// denoise 1) → VAEDecode → SaveImage (not-so-jarvis/edit).

const MAX_IDENTITY_EDIT_PIXELS = 2000000;
const IDENTITY_EDIT_NODE_CLASSES = ['Krea2EditModelPatch', 'Krea2EditGroundedEncode'];

// Explicit edit phrasing aimed at an existing image ("edit this photo",
// "retouch it", "replace the frog with a princess"). A narrow deterministic
// gate like detectUpscaleIntent — the LLM router stays the authority for
// everything vaguer.
const EDIT_SIGNAL_RE = /\b(edit\w*|retouch\w*|recolor\w*|restyle\w*|redraw\w*|inpaint\w*|outpaint\w*|try\s*on)\b/i;
const EDIT_REF_RE = /\b(this\b|that\b|it\b|them\b|the\s+(?:image|picture|photo|pic)|my\s+(?:image|picture|photo|pic)|your\s+(?:image|picture|photo)|image\w*|pict\w*|pic\b|photo\w*)\b/i;

// Substitution phrasing aimed at content inside the existing image: an edit
// verb driving at a definite/possessive/pronoun target plus a with/for/by/to/
// into phrase naming the replacement ("replace the frog with a princess",
// "swap the car for a bike", "edit the frog with long hair"). Unlike vague
// attribute tweaks ("change her dress"), an explicit X-with/for-Y substitution
// names both the target and the replacement, which is exactly what the
// identity-edit LoRA is for. Bare generation requests ("generate an image of
// me replacing my car ...") are excluded via the explicit-new-image guard.
const EDIT_SUBSTITUTE_RE =
    /\b(?:replac\w*|swap\w*|substitut\w*|edit\w*)\b[\s\S]{0,60}?\b(?:the|this|that|these|those|it|them|him|her|my|your|our)\b[\s\S]{0,60}?\b(?:with|for|by|to|into)\b/i;

// Transformation phrasing ("change the frog into a prince", "turn the cat
// into a dog"). Only "into" counts — "change her dress to red" (attribute
// tweak with "to") stays on the full-regen path, where the edit LoRA would
// return the source unchanged.
const EDIT_TRANSFORM_RE =
    /\b(?:chang\w*|turn\w*|convert\w*|transform\w*|morph\w*)\b[\s\S]{0,60}?\b(?:the|this|that|these|those|it|them|him|her|my|your)\b[\s\S]{0,60}?\binto\b/i;

// Removal phrasing aimed at existing content ("remove the frog", "delete the
// car", "erase the watermark").
const EDIT_REMOVE_RE =
    /\b(?:remov\w*|delet\w*|eras\w*|eliminat\w*)\b[\s\S]{0,40}?\b(?:the|this|that|these|those|it|them|him|her|my|your)\b/i;

function detectEditIntent(message, hasImageContext = false) {
    const text = String(message || '');
    if (!text.trim()) return null;
    if (isConceptQuestion(text)) return null;
    const norm = text.toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
    if (EDIT_SIGNAL_RE.test(norm) && EDIT_REF_RE.test(norm)) return { intent: 'image_edit' };
    // Content-targeted edit phrasing. Never fires for fresh generation
    // requests (a generation verb driving at an image noun), which own the
    // "replace"/"change" verbs in their own frame ("generate an image of ...").
    // Explicit video nouns also stay out — the video pipeline owns those
    // ("turn this into a video"), mirroring the router's VIDEO_WORD_RE guard.
    if (isExplicitNewImageRequest(text)) return null;
    if (/\b(?:video|film|clip|movie|animation|footage|reel)\b/i.test(text)) return null;
    // Meta-talk about the prompt itself ("replace the prompt with ...",
    // "change the prompt into ...") is a generation modify — a full regen of
    // the rewritten prompt — never an identity edit of the pixels.
    if (/\bprompts?\b/i.test(text)) return null;
    // These phrases are context-free on their own ("remove the background
    // noise", "replace the text with X") — only treat them as an edit when an
    // image task is actually active, otherwise they hijack plain chat.
    if (!hasImageContext) return null;
    if (EDIT_SUBSTITUTE_RE.test(text)) return { intent: 'image_edit' };
    if (EDIT_TRANSFORM_RE.test(text)) return { intent: 'image_edit' };
    if (EDIT_REMOVE_RE.test(text)) return { intent: 'image_edit' };
    return null;
}

// Strip leading conversational filler from an edit instruction so the
// identity-edit grounding encoder gets clean prose ("hahahaha replace the
// frog with ..." -> "replace the frog with ..."). Only leading tokens are
// removed; the instruction itself is never rewritten.
const EDIT_LEADING_FILLER_RE =
    /^(?:\s*(?:(?:ha)+h?|hehe\w*|hihi\w*|lol|lmao|rofl|omg|wow|hey|hi|hello|ok(?:ay)?|well|so|please|just|actually|can you(?: please)?|could you(?: please)?|would you(?: please)?|i want you to|i'd like you to|i would like you to)[\s,.!;:]+)+/i;

function cleanEditInstruction(text) {
    return String(text || '').replace(EDIT_LEADING_FILLER_RE, '').trim();
}

// --- Follow-up modification gate -------------------------------------------------
//
// Vague follow-up tweaks of the active image ("change her bottom to ripped
// blue jeans", "make her wear a red dress", "change the background to a
// beach") must always run as a full-regen modify — never fall through to
// chat where a small model hallucinates a tool-call JSON blob
// ({"action": "image_generation", "action_input": ...}) instead of running
// anything. This is a narrow deterministic gate like detectUpscaleIntent:
// it only fires while an image task is active and the LLM router stays the
// authority for everything else.
//
// Explicit identity-edit phrasing ("replace X with Y", "remove X", ...) stays
// on the edit path (detectEditIntent wins — callers check it first), as do
// questions, display requests, upscales, fresh generations, and video work.

const IMAGE_MODIFY_VERB_RE = /\b(?:chang\w*|mak\w*|turn\w*|update\w*|switch\w*|wear\w*|dress\w*|put\w*|give\w*|add\w*)\b/i;
const IMAGE_MODIFY_TARGET_RE = /\b(?:her|him|them|it|this|that|bottom|top|dress|jean|pants?|trousers?|skirt|shirt|blouse|jacket|sweater|gown|kimono|outfit|cloth(?:es|ing)|background|hair(?:style)?|pose|setting|lighting|expression|camera|night|day|sunset|beach|city|forest|room)\b/i;
const IMAGE_MODIFY_QUESTION_RE = /^(?:what|which|why|who|when|where|how)\b/i;

function detectImageModifyIntent(message, hasActiveImageTask) {
    if (!hasActiveImageTask) return null;
    const text = String(message || '');
    if (!text.trim()) return null;
    if (isConceptQuestion(text)) return null;
    // Questions about the image ("what jeans is she wearing?") are chat —
    // only imperative / declarative tweaks modify.
    if (IMAGE_MODIFY_QUESTION_RE.test(text.trim())) return null;
    if (/\?\s*$/.test(text.trim())) return null;
    if (/\b(?:explain|describe|tell\s+me|show\s+me\s+the\s+(?:image|picture|photo))\b/i.test(text)) return null;
    // Narrow intents own their phrasing — never steal from them.
    try {
        if (detectUpscaleIntent(text)) return null;
        if (detectEditIntent(text, hasActiveImageTask)) return null;
    } catch (err) { /* fall through — treat as non-narrow */ }
    if (isExplicitNewImageRequest(text)) return null;
    if (!IMAGE_MODIFY_VERB_RE.test(text)) return null;
    if (!IMAGE_MODIFY_TARGET_RE.test(text)) return null;
    return { intent: 'image_generation', action: 'modify' };
}

function isSameAssetFile(a, b) {
    const normalize = (value) => {
        const segments = String(value || '').replace(/\\/g, '/').split('/');
        return segments[segments.length - 1].toLowerCase();
    };
    return normalize(a) === normalize(b);
}

// Fit the output inside 2MP on a 16px grid. The edit LoRA bleeds or duplicates
// content above 2MP, so oversized sources are proportionally scaled down first.
function normalizeIdentityEditDimensions(width, height) {
    const GRID = 16;
    const MIN_SIDE = 256;
    const startW = Math.max(MIN_SIDE, Math.round(Number(width) || 1024));
    const startH = Math.max(MIN_SIDE, Math.round(Number(height) || 1024));
    const area = startW * startH;
    const shrink = area > MAX_IDENTITY_EDIT_PIXELS ? Math.sqrt(MAX_IDENTITY_EDIT_PIXELS / area) : 1;
    let w = Math.max(MIN_SIDE, Math.round((startW * shrink) / GRID) * GRID);
    let h = Math.max(MIN_SIDE, Math.round((startH * shrink) / GRID) * GRID);
    while (w * h > MAX_IDENTITY_EDIT_PIXELS) {
        if (w >= h) w -= GRID;
        else h -= GRID;
    }
    return { width: w, height: h };
}

function listEditLoraNames(info) {
    const node = info && info.LoraLoaderModelOnly;
    const input = (node && node.input) || {};
    const spec = (input.required && input.required.lora_name) || input.lora_name;
    return Array.isArray(spec) && Array.isArray(spec[0]) ? spec[0] : [];
}

// Fail fast with a friendly error when the edit stack is incomplete.
function requireEditStack(info, settings) {
    const unavailable = IDENTITY_EDIT_NODE_CLASSES.filter((cls) => !info[cls]);
    if (unavailable.length) {
        const error = new Error(
            'ComfyUI is missing custom nodes: ' + unavailable.join(', ') +
            '. Install lbouaraba/comfyui-krea2edit (and restart ComfyUI), then try again.'
        );
        error.code = 'comfyui_missing_nodes';
        error.missingNodes = unavailable;
        throw error;
    }
    const editLora = String(settings.editLora || '').trim();
    if (!editLora || !listEditLoraNames(info).some((name) => isSameAssetFile(name, editLora))) {
        const error = new Error(
            'Krea 2 Edit needs the Identity Edit LoRA in ComfyUI loras: ' +
            (editLora || '(not configured)') + '.'
        );
        error.code = 'comfyui_edit_lora_missing';
        throw error;
    }
}

// Non-throwing availability probe for the modify-turn fallback. Never throws.
async function checkEditAvailability() {
    try {
        if (!(await comfyui.isAvailable())) return { ok: false, reason: 'comfyui_unavailable' };
        const info = await comfyui.getObjectInfo(15000);
        requireEditStack(info, effectiveSettings());
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: err.code || 'unavailable' };
    }
}

function buildKrea2IdentityEditGraph(instruction, loadName, options = {}) {
    const settings = Object.assign({}, DEFAULT_SETTINGS, options.settings || {});
    const editLora = String(options.editLora || settings.editLora || '').trim();
    if (!editLora) {
        const error = new Error('Krea 2 Edit needs the Identity Edit LoRA configured (image settings > Edit LoRA).');
        error.code = 'comfyui_edit_lora_missing';
        throw error;
    }
    if (!loadName) {
        const error = new Error('Krea 2 Edit needs a source image.');
        error.code = 'edit_source_missing';
        throw error;
    }
    const seed = Number.isInteger(options.seed) && options.seed >= 0 ? options.seed : 0;
    const steps = clampToInt(options.steps || 10, 8, 12, 10);
    const cfg = clampToRange(options.cfg, 1, 5, 1);
    const refBoost = clampToRange(options.refBoost, 0, 20, 4);
    const groundingPx = Math.round(clampToRange(options.groundingPx, 384, 1024, 768));
    const dims = normalizeIdentityEditDimensions(options.width, options.height);

    // The identity LoRA must be present and enabled. A disabled stack entry
    // means the user switched the edit pipeline off, so refuse rather than run
    // the base UNET without it. Its configured strength is honored; user LoRAs
    // are then stacked model-only on top.
    const override = (settings.loras || []).find((l) => l && l.name && isSameAssetFile(l.name, editLora));
    if (override && override.on === false) {
        const error = new Error('Krea 2 Edit needs the Identity Edit LoRA enabled.');
        error.code = 'comfyui_edit_lora_missing';
        throw error;
    }

    const graph = {};
    graph.base_model = buildDiffusionLoaderNode(settings.unet);
    graph.text_encoder = { class_type: 'CLIPLoader', inputs: { clip_name: settings.clip, type: settings.clipType, device: 'default' } };
    graph.vae_loader = { class_type: 'VAELoader', inputs: { vae_name: settings.vae } };
    graph.identity_stack = {
        class_type: 'LoraLoaderModelOnly',
        inputs: {
            model: ['base_model', 0],
            lora_name: editLora,
            strength_model: clampToRange(override && override.strength, -100, 100, 1)
        }
    };

    let modelLink = ['identity_stack', 0];
    let stackIndex = 0;
    for (const entry of settings.loras || []) {
        if (!entry || entry.on === false || !entry.name || isSameAssetFile(entry.name, editLora)) continue;
        stackIndex += 1;
        const nodeId = 'stack_lora_' + stackIndex;
        graph[nodeId] = {
            class_type: 'LoraLoaderModelOnly',
            inputs: {
                model: modelLink,
                lora_name: entry.name,
                strength_model: clampToRange(entry.strength, -100, 100, 1)
            }
        };
        modelLink = [nodeId, 0];
    }

    graph.reference_image = { class_type: 'LoadImage', inputs: { image: loadName } };
    graph.reference_latent = {
        class_type: 'VAEEncode',
        inputs: { pixels: ['reference_image', 0], vae: ['vae_loader', 0] }
    };
    graph.edit_patch = {
        class_type: 'Krea2EditModelPatch',
        inputs: {
            model: modelLink,
            source_latent: ['reference_latent', 0],
            ref_boost: refBoost,
            ref_boost_a: 1,
            fit_mode: 'fit',
            vae: ['vae_loader', 0],
            source_image: ['reference_image', 0]
        }
    };
    graph.conditioning_pos = {
        class_type: 'Krea2EditGroundedEncode',
        inputs: {
            prompt: String(instruction || ''),
            grounding_px: groundingPx,
            clip: ['text_encoder', 0],
            image: ['reference_image', 0]
        }
    };
    graph.conditioning_neg = {
        class_type: 'Krea2EditGroundedEncode',
        inputs: {
            prompt: String(options.negativePrompt || ''),
            grounding_px: groundingPx,
            clip: ['text_encoder', 0],
            image: ['reference_image', 0]
        }
    };
    graph.canvas = {
        class_type: 'EmptySD3LatentImage',
        inputs: { width: dims.width, height: dims.height, batch_size: 1 }
    };
    graph.sampler = {
        class_type: 'KSampler',
        inputs: {
            model: ['edit_patch', 0],
            positive: ['conditioning_pos', 0],
            negative: ['conditioning_neg', 0],
            latent_image: ['canvas', 0],
            seed,
            steps,
            cfg,
            sampler_name: 'euler',
            scheduler: 'simple',
            denoise: 1
        }
    };
    graph.decoded = { class_type: 'VAEDecode', inputs: { samples: ['sampler', 0], vae: ['vae_loader', 0] } };
    graph.save = { class_type: 'SaveImage', inputs: { images: ['decoded', 0], filename_prefix: 'not-so-jarvis/edit' } };

    return graph;
}

// Edit a local image file (data/images upload or data/generated output) from
// a plain-language instruction. Shares the single-generation queue. Returns
// { url, filename, width, height, prompt, generationMs, meta }.
async function editImage(sourceAbsPath, instruction, options = {}) {
    const queueOpts = {
        label: options.label || 'image edit',
        kind: options.kind || 'image_edit',
        conversationId: options.conversationId || null,
        onQueued: options.onQueued || null,
        onStart: options.onStart || null
    };
    return withGenerationLock(async (signal) => {
        await ensureGeneratedDir();
        const startedAt = Date.now();

        const abs = String(sourceAbsPath || '');
        if (!abs || !fs.existsSync(abs)) {
            const error = new Error('The image to edit could not be found on disk. It may have been deleted.');
            error.code = 'edit_source_missing';
            throw error;
        }
        const buffer = fs.readFileSync(abs);
        if (!buffer.length) {
            const error = new Error('The image to edit is empty.');
            error.code = 'edit_source_missing';
            throw error;
        }

        const seed = Number.isInteger(options.seed) && options.seed >= 0
            ? options.seed
            : Math.floor(Math.random() * 2 ** 32);
        const settings = effectiveSettings();

        // Output follows the source shape (fit inside 2MP); WebP and other
        // dimension-unknown files fall back to the configured S/M/L canvas.
        const srcDims = readImageDimensions(abs);
        const dims = (srcDims.width > 0 && srcDims.height > 0)
            ? normalizeIdentityEditDimensions(srcDims.width, srcDims.height)
            : normalizeIdentityEditDimensions(settings.width, settings.height);

        // LoRA trigger words are prepended exactly once, same as generation.
        const cleanInstruction = stripLoraTriggerWords(instruction);
        const triggerWords = (settings.loras || [])
            .filter((l) => l && l.on && l.name && l.triggerWord)
            .map((l) => l.triggerWord);
        const finalInstruction = triggerWords.length
            ? triggerWords.join(', ') + ', ' + String(cleanInstruction || '')
            : String(cleanInstruction || '');
        if (!finalInstruction.trim()) {
            const error = new Error('Describe what to change in the image.');
            error.code = 'edit_source_missing';
            throw error;
        }

        // Make the source available to ComfyUI's LoadImage node, then always
        // clean it up afterwards so the input folder does not accumulate files.
        const uploadName = 'jarvis_edit_' + Date.now() + '_' + path.basename(abs);
        const uploaded = await comfyui.uploadImage(buffer, uploadName);
        const loadName = (uploaded && uploaded.name) || uploadName;

        let basename;
        try {
            const graph = buildKrea2IdentityEditGraph(finalInstruction, loadName, {
                settings,
                seed,
                width: dims.width,
                height: dims.height,
                steps: options.steps,
                cfg: options.cfg,
                refBoost: options.refBoost,
                groundingPx: options.groundingPx,
                negativePrompt: options.negativePrompt
            });

            const info = await comfyui.getObjectInfo();
            await validateGraphAgainstComfy(info, graph);
            requireEditStack(info, settings);

            const pid = await comfyui.queuePrompt(graph);
            console.log('[image-generator] queued Krea2 edit workflow:', pid);

            const history = await comfyui.waitForPrompt(pid, { timeoutMs: options.timeoutMs, signal });
            const files = comfyui.findOutputFiles(history.outputs || {}, /\.(?:png|jpg|jpeg|webp)$/i);
            if (!files.length) {
                const error = new Error('ComfyUI finished but produced no edited image file.');
                error.code = 'comfyui_output_not_found';
                throw error;
            }

            const entry = files[files.length - 1];
            const outBuffer = await comfyui.downloadImage(entry);

            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const extension = path.extname(entry.filename).toLowerCase() || '.png';
            basename = safeFilename(outBuffer.toString('hex', 0, 4)) + '_edit_' + stamp + extension;
            fs.writeFileSync(path.join(GENERATED_DIR, basename), outBuffer);
            console.log('[image-generator] saved edited image:', basename, '(' + outBuffer.length + ' bytes)');

            await comfyui.deleteOutputFile(entry, { history: pid });
        } finally {
            await comfyui.deleteInputFile(loadName).catch(() => {});
        }

        const { width, height } = readImageDimensions(path.join(GENERATED_DIR, basename));
        const activeLoras = (settings.loras || [])
            .filter((l) => l && l.on && l.name)
            .map((l) => ({ name: l.name, strength: Number(l.strength) || 0, triggerWord: l.triggerWord || '' }));
        const meta = generatedHistory.add({
            file: '/generated/' + encodeURIComponent(basename),
            rawFilename: basename,
            conversationId: options.conversationId || null,
            prompt: finalInstruction,
            model: 'Krea2 Edit',
            loras: activeLoras,
            width: width || dims.width,
            height: height || dims.height,
            generationMs: Date.now() - startedAt,
            edit: { source: path.basename(abs) }
        });

        return {
            url: meta.file,
            filename: basename,
            width: width || dims.width,
            height: height || dims.height,
            prompt: finalInstruction,
            generationMs: meta.generationMs,
            meta
        };
    }, queueOpts);
}

module.exports = {
    GENERATED_DIR,
    IMAGE_INTENT_SYSTEM_PROMPT,
    PROMPT_BUILDER_SYSTEM_PROMPT,
    DEFAULT_SETTINGS,
    ASPECT_RATIOS,
    IMAGE_SIZES,
    IMAGE_MEGAPIXELS,
    withGenerationLock,
    getQueueStatus: generationQueue.getStatus,
    cancelQueued: generationQueue.cancelQueued,
    cancelActive: generationQueue.cancelActive,
    isActive: generationQueue.isActive,
    detectIntent,
    buildImagePrompt,
    parseEnhancerJson,
    isImagePromptEcho,
    repairJsonControlChars,
    IMAGE_MEDIA_WORDS,
    IMAGE_WORD_RE,
    detectCreativeFreedom,
    imageRequestStrength,
    isExplicitNewImageRequest,
    isVagueImageConcept,
    extractImageSubject,
    stripCreativeMetaInstructions,
    resolveDimensions,
    normalizeSeed,
    resolveSeed,
    MAX_SEED,
    generateImage,
    stripLoraTriggerWords,
    buildKrea2T2IGraph,
    buildQwenImage21T2IGraph,
    buildLoraChain,
    normalizeImageModel,
    resolveBaseModels,
    IMAGE_MODELS,
    QWEN_IMAGE_CLIP_TYPE,
    buildKrea2IdentityEditGraph,
    normalizeIdentityEditDimensions,
    detectEditIntent,
    cleanEditInstruction,
    detectImageModifyIntent,
    checkEditAvailability,
    editImage,
    MAX_IDENTITY_EDIT_PIXELS,
    validateGraphAgainstComfy,
    effectiveSettings,
    getDefaults,
    sanitizeSettings,
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