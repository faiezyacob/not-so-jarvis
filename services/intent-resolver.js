/* ============================================
   JARVIS — Intent Resolver
   The semantic decision layer between the raw
   user message and the action router.

   Pipeline:
     User Message
       -> Context Builder      (buildIntentContext)
       -> Intent Resolver      (resolveIntent)  <- this file
       -> Structured Intent
       -> Action Router        (services/task-router.js)
       -> Action

   This module decides WHAT the user wants JARVIS
   to DO. It NEVER executes a tool — it only
   returns a structured intent. Regex/keyword
   matching is collected as lightweight EVIDENCE
   (collectSignals); it is not the source of
   truth. When the intent is ambiguous the LLM is
   consulted and is the final authority.

   Priority hierarchy:
     A. Explicit user action ("director mode",
        "write a prompt for ...")
     B. Semantic intent (LLM) — final authority
        when ambiguous
     C. Regex/keyword signals (fallback evidence)
     D. Normal chat fallback
   ============================================ */

const providers = require('../server/providers');
const conversationService = require('../server/conversation-service');
const taskState = require('./task-state');
const imageGenerator = require('./image-generator');
const videoGenerator = require('./video-generator');

// --- Structured intent schema -------------------------------------------------

const INTENTS = Object.freeze({
    CHAT: 'chat',
    IMAGE_GENERATION: 'image_generation',
    VIDEO_GENERATION: 'video_generation',
    PROMPT_WRITING: 'prompt_writing',
    PROMPT_IDEATION: 'prompt_ideation',
    MODIFY_PREVIOUS_GENERATION: 'modify_previous_generation',
    IMAGE_EDIT: 'image_edit',
    IMAGE_UPSCALE: 'image_upscale',
    VIDEO_UPSCALE: 'video_upscale'
});

const MODES = Object.freeze({
    DIRECTOR: 'director',
    DIRECT: 'direct',
    UNKNOWN: 'unknown'
});

// --- Signal regexes (EVIDENCE ONLY, never execution) --------------------------

const REFERENCE_RE =
    /\b(?:this|that|it|her|him|them|these|those|the\s+(?:image|photo|picture|video|clip|prompt|frame|one)|previous|last|above|aforementioned|same)\b/i;
const CONTEXT_CHANGE_RE =
    /\b(?:now|turn\s+(?:it|this|that)|make\s+(?:it|her|him|them)|change|convert|transform|animate|continue|same\s+but|keep|instead|modify|adjust|tweak)\b/i;

const PROMPT_NOUN_RE = /\bprompts?\b/i;
const IDEATION_RE =
    /\b(?:ideas?|suggestions?|brainstorm\w*|inspir\w*|examples?|concepts?|options?|variations?|directions?|angles?|possibilities|recommendations?)\b/i;
const WRITE_PROMPT_RE =
    /\b(?:write|draft|compose|craft|formulate|give|suggest|produce|create|generate|make|need|want|come\s+up\s+with|put\s+together)\b(?:\s+\w+){0,3}?\s+\bprompts?\b/i;

const DIRECTOR_MODE_SIGNAL_RE =
    /\b(?:director\s+mode|as\s+(?:a|the)\s+director|direct\s+(?:this|a|the)\s+(?:movie|film|video|scene|shot)|production\s+mode|multi[-\s]?stage\s+(?:production|video))\b/i;
const DIRECT_MODE_SIGNAL_RE =
    /\b(?:direct\s+(?:video|generation)|plain\s+video|normal\s+video|no\s+director|skip\s+(?:the\s+)?director|without\s+(?:the\s+)?director|just\s+(?:generate\s+)?(?:the\s+)?video|generate\s+the\s+video\s+directly)\b/i;

const QUESTION_LEAD_RE =
    /^(?:what|which|why|who|when|where|how|is|are|was|were|do|does|did|can|could|would|should|will|tell\s+me|describe|explain|show\s+me)\b/i;

// Change verbs/qualifiers that, with a clear reference and an active task, mark
// a follow-up tweak rather than conversation.
const SIGNALS_CHANGE_RE =
    /\b(?:change|replace|swap|remove|add|turn|convert|transform|instead|darker|brighter|bigger|smaller|faster|slower|more|less)\b/i;

// Production language ("make a commercial", "create cinematic movie") names a
// video request that may not contain a literal medium word. A still-image
// production noun suffix ("movie poster") is NOT a video request.
const VIDEO_PRODUCTION_NOUN_RE =
    /\b(?:movie|short[\s-]*film|feature[\s-]*film|documentary|commercial|trailer|teaser|cinematic\s+(?:video|film|movie|clip|sequence|short|scene)|multi[\s-]?shot|storyboard|video\s+production|film\s+production)\b/i;
const NON_VIDEO_PRODUCTION_RE =
    /\b(?:movie|film|video|clip)\s+(?:poster|cover|thumbnail|art|artwork|image|picture|photo|logo|title)\b/i;

function looksLikeQuestion(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (QUESTION_LEAD_RE.test(t)) return true;
    return /\?\s*$/.test(t);
}

// --- Debug mode ---------------------------------------------------------------
//
// Internal, development-only. Set JARVIS_INTENT_DEBUG=1 (or pass { debug: true })
// to print the resolver decision, the regex evidence, and the final action.

function debugEnabled(opts = {}) {
    if (opts && opts.debug === true) return true;
    return String(process.env.JARVIS_INTENT_DEBUG || '') === '1';
}

function formatDebugTrace({ message, signals, resolved, finalAction }) {
    const s = signals || {};
    const r = resolved || {};
    const truth = (v) => (v ? 'true' : 'false');
    return [
        'USER:',
        '"' + String(message || '') + '"',
        '',
        'RESOLVER:',
        'intent: ' + (r.intent || INTENTS.CHAT),
        'confidence: ' + (typeof r.confidence === 'number' ? r.confidence : 0),
        'subject: ' + (r.subject || s.subject || 'other'),
        'referencesPreviousContext: ' + truth(r.referencesPreviousContext),
        '',
        'REGEX SIGNALS:',
        'image: ' + truth(s.hasImageWord || s.imageStrength),
        'prompt: ' + truth(s.hasPromptWord),
        'video: ' + truth(s.hasVideoWord || s.videoStrength),
        '',
        'FINAL ACTION:',
        finalAction || r.intent || INTENTS.CHAT
    ].join('\n');
}

// --- Signal collection --------------------------------------------------------

function collectSignals(message, opts = {}) {
    const text = String(message || '').trim();
    const activeTask = opts.activeTask || {};
    const activeIsImage = activeTask.type === 'image';

    let imageStrength = null;
    let videoStrength = null;
    try { imageStrength = imageGenerator.imageRequestStrength(text); } catch (err) { imageStrength = null; }
    try { videoStrength = videoGenerator.videoRequestStrength(text); } catch (err) { videoStrength = null; }
    // "make a movie poster" is a still image that happens to name a video medium.
    const nonVideoProduction = NON_VIDEO_PRODUCTION_RE.test(text);
    if (nonVideoProduction) videoStrength = null;

    const hasImageWord = imageGenerator.IMAGE_WORD_RE.test(text);
    const hasVideoWord = videoGenerator.VIDEO_WORD_RE.test(text);
    const hasPromptWord = PROMPT_NOUN_RE.test(text);
    const generationVerb = /\b(?:generat|creat|mak|render|produc|draw|paint|illustrat|animat|record|shoot|recreat)\w*\b/i.test(text);
    const ideation = IDEATION_RE.test(text);
    const writeVerb = WRITE_PROMPT_RE.test(text);
    const isQuestion = looksLikeQuestion(text);
    const directorMode = DIRECTOR_MODE_SIGNAL_RE.test(text);
    const directMode = DIRECT_MODE_SIGNAL_RE.test(text);
    const i2v = videoGenerator.I2V_REF_RE.test(text);
    const referencesPrevious =
        REFERENCE_RE.test(text) || i2v || CONTEXT_CHANGE_RE.test(text);
    const imageUpscale = Boolean(imageGenerator.detectUpscaleIntent(text));
    const videoUpscale = Boolean(videoGenerator.detectVideoUpscaleIntent(text));
    const productionRequest = VIDEO_PRODUCTION_NOUN_RE.test(text) &&
        !NON_VIDEO_PRODUCTION_RE.test(text) && generationVerb;

    let editIntent = false;
    try { editIntent = Boolean(imageGenerator.detectEditIntent(text, activeIsImage)); } catch (err) { editIntent = false; }

    // Prompt meta-requests (writing / ideation) are high-precision: a media
    // noun inside them is a SUBJECT, not an action. Ideation beats writing.
    const promptIdeation = ideation &&
        (hasPromptWord || hasImageWord || hasVideoWord || Boolean(activeTask.type));
    const promptWriting = !promptIdeation &&
        (writeVerb || (hasPromptWord && isQuestion));

    const subject = hasVideoWord ? 'video'
        : (hasImageWord ? 'image'
            : (hasPromptWord ? 'prompt' : 'other'));

    return {
        text,
        imageStrength,
        videoStrength,
        hasImageWord,
        hasVideoWord,
        hasPromptWord,
        generationVerb,
        ideation,
        promptIdeation,
        promptWriting,
        isQuestion,
        directorMode,
        directMode,
        i2v,
        referencesPrevious,
        imageUpscale,
        videoUpscale,
        productionRequest,
        editIntent,
        subject,
        any: Boolean(
            imageStrength || videoStrength || hasImageWord || hasVideoWord ||
            hasPromptWord || generationVerb || referencesPrevious ||
            imageUpscale || videoUpscale || editIntent || productionRequest
        )
    };
}

// --- Context builder ----------------------------------------------------------
//
// A compact, bounded view of the conversation. Not the entire history: just the
// state the resolver needs to interpret references and inheritance.

const GENERATED_URL_RE = /\/generated\/([^\s)\]}"']+)/g;

function scanGeneratedAssets(messages) {
    const out = { lastImage: null, lastVideo: null };
    for (const m of (messages || [])) {
        if (!m || m.role !== 'assistant') continue;
        const content = String(m.content || '');
        let match;
        GENERATED_URL_RE.lastIndex = 0;
        while ((match = GENERATED_URL_RE.exec(content))) {
            let name = match[1];
            try { name = decodeURIComponent(name); } catch (err) { /* keep raw */ }
            name = String(name).split('?')[0];
            if (/\.(?:mp4|webm|avi|mov)$/i.test(name)) out.lastVideo = name;
            else if (/\.(?:png|jpe?g|webp|gif)$/i.test(name)) out.lastImage = name;
        }
    }
    return out;
}

function buildIntentContext(input = {}) {
    const conversationId = input.conversationId || null;
    const activeTask = input.activeTask || taskState.getTask(conversationId) || {};

    let messages = [];
    try { messages = conversationService.getMessages(conversationId) || []; } catch (err) { messages = []; }

    const lastStored = messages[messages.length - 1];
    const history = (lastStored && String(lastStored.content || '') === String(input.message || ''))
        ? messages.slice(0, -1)
        : messages;

    const assets = scanGeneratedAssets(history);
    const lastUser = [...history].reverse().find((m) => m && m.role === 'user');
    const lastAssistant = [...history].reverse().find((m) => m && m.role === 'assistant');

    const parameters = activeTask.parameters || {};
    const selectedMode = activeTask.type === 'video'
        ? (activeTask.videoMode || parameters.videoMode || null)
        : null;

    return {
        conversationId,
        activeTask: {
            type: activeTask.type || null,
            status: activeTask.status || 'idle',
            prompt: activeTask.prompt || '',
            originalPrompt: activeTask.originalPrompt || '',
            generatedAsset: activeTask.generatedAsset || null,
            videoMode: activeTask.videoMode || null,
            lastAction: activeTask.lastAction || ''
        },
        lastUserRequest: lastUser ? String(lastUser.content || '').slice(0, 500) : '',
        lastAssistantAction: lastAssistant ? String(lastAssistant.content || '').slice(0, 500) : '',
        lastGeneratedImage: assets.lastImage,
        lastGeneratedVideo: assets.lastVideo,
        activePrompt: activeTask.prompt || '',
        activeGeneration: activeTask.type
            ? { type: activeTask.type, status: activeTask.status || 'idle' }
            : null,
        selectedMode,
        referenceImage: input.referenceImage || null,
        hasAttachedImage: Boolean(input.hasAttachedImage)
    };
}

// --- LLM resolver -------------------------------------------------------------

const RESOLVER_SYSTEM_PROMPT =
    'You are JARVIS\'s Intent Resolver. Decide WHAT the user wants JARVIS to DO. ' +
    'You never reply to the user and the user never sees your JSON.\n\n' +

    'Determine the ACTION first. Media words (image, photo, picture, video, prompt, ' +
    'woman, portrait, cinematic) are only SUBJECT or CONTEXT and must NEVER by ' +
    'themselves decide the action.\n\n' +

    'Respond with ONLY a single JSON object, no markdown, no commentary:\n' +
    '{"intent": "...", "confidence": 0.0, "mode": "director|direct", ' +
    '"subject": "image|video|prompt|other", "referencesPreviousContext": false, ' +
    '"extractedRequest": "...", "creative_mode": "none|light|full", "explicit_constraints": []}\n\n' +

    'intent (one of):\n' +
    '- "chat": normal conversation, questions, explanations, advice, or anything that is not a tool action.\n' +
    '- "image_generation": create a NEW image. A generation verb drives at an image or a visual subject.\n' +
    '- "video_generation": create a NEW video (any medium word: video, film, clip, movie, animation).\n' +
    '- "prompt_writing": write / compose / draft a prompt FOR an image or video. This is NOT generation.\n' +
    '- "prompt_ideation": brainstorm / suggest prompt ideas or concepts. This is NOT generation.\n' +
    '- "modify_previous_generation": change or continue the previously generated image or video.\n\n' +

    'ACTION vs SUBJECT — examples:\n' +
    '- "write me a prompt for an image of a woman in Tokyo" -> prompt_writing (subject: image). The word "image" is the subject, not the action.\n' +
    '- "give me some ideas for video prompts" -> prompt_ideation (subject: video).\n' +
    '- "generate an image of a forest" -> image_generation.\n' +
    '- "generate a video of a woman walking" -> video_generation.\n' +
    '- "make this image into a video" -> video_generation, referencesPreviousContext true.\n' +
    '- "what do you think of this image?" -> chat.\n\n' +

    'referencesPreviousContext rules:\n' +
    '- true ONLY when the message clearly refers to prior work: "this", "that", "it", "her", "him", "the image", "the previous prompt", "make it ...", "now turn it into ...", "change ...", "same but ...".\n' +
    '- false when the message is a new, self-contained request. Never assume a new message belongs to the previous generation.\n\n' +

    'mode rules (video_generation):\n' +
    '- "director": explicit Director mode / "as a director" / approval-flow phrasing ONLY.\n' +
    '- "direct": the default for every other video request. Never ask the user to choose; a production noun ("movie", "commercial", "cinematic") is NOT director mode.\n\n' +

    'extractedRequest: the actual thing to act on (image concept, video scene, edit instruction, or prompt subject). ' +
    'Strip verb preambles and meta-instructions. Do not include the word "prompt" when the action is generation.\n' +
    'creative_mode: "none" by default, "light" for a requested enhancement, "full" when the user grants creative freedom ("be creative", "surprise me").\n' +
    'explicit_constraints: any explicit constraints the user states, else [].\n\n' +
    'Prefer "chat" when the message is a question or has no clear tool action.';

function parseResolverJson(raw) {
    if (!raw) return null;
    let text = String(raw).trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) text = fenced[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch (err) {
        return null;
    }
}

function normalizeIntent(value) {
    const v = String(value || '').trim().toLowerCase();
    if (v === INTENTS.CHAT || v === 'normal_chat') return INTENTS.CHAT;
    if (v === INTENTS.IMAGE_GENERATION || v === 'generate_image') return INTENTS.IMAGE_GENERATION;
    if (v === INTENTS.VIDEO_GENERATION || v === 'generate_video') return INTENTS.VIDEO_GENERATION;
    if (v === INTENTS.PROMPT_WRITING || v === 'write_prompt') return INTENTS.PROMPT_WRITING;
    if (v === INTENTS.PROMPT_IDEATION || v === 'prompt_ideas') return INTENTS.PROMPT_IDEATION;
    if (v === INTENTS.MODIFY_PREVIOUS_GENERATION || v === 'modify_previous' || v === 'modify') {
        return INTENTS.MODIFY_PREVIOUS_GENERATION;
    }
    if (v === INTENTS.IMAGE_EDIT) return INTENTS.IMAGE_EDIT;
    if (v === INTENTS.IMAGE_UPSCALE) return INTENTS.IMAGE_UPSCALE;
    if (v === INTENTS.VIDEO_UPSCALE) return INTENTS.VIDEO_UPSCALE;
    return null;
}

function clampConfidence(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0.5;
    return Math.max(0, Math.min(1, n));
}

// Resolve the video workflow without asking. A video request runs directly by
// default; Director mode is only selected when the user said so explicitly
// (typed "director mode" phrasing, or the composer toggle the server handles
// before resolution).
function applyModeDefault(resolved, text, context, signals) {
    if (resolved.intent === INTENTS.IMAGE_GENERATION) {
        resolved.mode = MODES.DIRECT;
        return resolved;
    }
    if (resolved.intent !== INTENTS.VIDEO_GENERATION) {
        return resolved;
    }
    if (resolved.mode === MODES.DIRECTOR || resolved.mode === MODES.DIRECT) {
        return resolved;
    }

    const active = context.activeTask || {};
    const establishedMode = active.type === 'video'
        ? (active.videoMode || context.selectedMode || null)
        : null;
    const continuing = Boolean(establishedMode) &&
        (resolved.referencesPreviousContext || signals.referencesPrevious || signals.i2v);

    resolved.mode = (continuing && establishedMode === MODES.DIRECTOR) ? MODES.DIRECTOR : MODES.DIRECT;
    return resolved;
}

function finalizeFromParsed(parsed, input, signals, context) {
    const intent = normalizeIntent(parsed.intent);
    if (!intent) return null;
    const text = String(input.message || '');
    const modeRaw = String(parsed.mode || '').toLowerCase();
    const mode = modeRaw === MODES.DIRECTOR ? MODES.DIRECTOR
        : (modeRaw === MODES.DIRECT ? MODES.DIRECT : MODES.UNKNOWN);

    const resolved = {
        intent,
        confidence: clampConfidence(parsed.confidence),
        mode,
        referencesPreviousContext: Boolean(parsed.referencesPreviousContext) && signals.referencesPrevious,
        referencedGenerationId: null,
        extractedRequest: String(parsed.extractedRequest || '').trim() || text,
        subject: String(parsed.subject || '').trim() || signals.subject,
        creative_mode: ['light', 'full'].includes(String(parsed.creative_mode || '').toLowerCase())
            ? String(parsed.creative_mode).toLowerCase() : 'none',
        explicit_constraints: Array.isArray(parsed.explicit_constraints)
            ? parsed.explicit_constraints.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 12)
            : [],
        action: intent === INTENTS.MODIFY_PREVIOUS_GENERATION ? 'modify' : 'generate',
        source: 'semantic',
        signals
    };
    resolved.referencedGenerationId = pickReferencedAsset(resolved, context);
    return applyModeDefault(resolved, text, context, signals);
}

function pickReferencedAsset(resolved, context) {
    if (!resolved.referencesPreviousContext) return null;
    if (resolved.intent === INTENTS.VIDEO_GENERATION) {
        return context.lastGeneratedImage || context.lastGeneratedVideo || null;
    }
    if (resolved.intent === INTENTS.IMAGE_GENERATION || resolved.intent === INTENTS.MODIFY_PREVIOUS_GENERATION) {
        return context.lastGeneratedImage || context.lastGeneratedVideo || null;
    }
    return null;
}

// Deterministic fallback when the LLM is unavailable or ambiguous.
function resolveFromSignals(signals, context) {
    const active = context.activeTask || {};
    const text = signals.text;

    if (signals.promptIdeation) {
        return buildSignalResolved(INTENTS.PROMPT_IDEATION, signals, text, {
            subject: signals.subject, extractedRequest: text
        });
    }
    if (signals.promptWriting) {
        return buildSignalResolved(INTENTS.PROMPT_WRITING, signals, text, {
            subject: signals.subject, extractedRequest: text
        });
    }
    if (signals.videoUpscale) {
        return buildSignalResolved(INTENTS.VIDEO_UPSCALE, signals, text, { subject: 'video' });
    }
    if (signals.imageUpscale) {
        return buildSignalResolved(INTENTS.IMAGE_UPSCALE, signals, text, { subject: 'image' });
    }

    if (signals.videoStrength === 'definite' || signals.productionRequest) {
        const references = signals.referencesPrevious;
        const isModify = Boolean(active.type === 'video') && references && !signals.productionRequest;
        return buildSignalResolved(
            isModify ? INTENTS.MODIFY_PREVIOUS_GENERATION : INTENTS.VIDEO_GENERATION,
            signals, text, {
                subject: 'video',
                referencesPreviousContext: references,
                action: isModify ? 'modify' : 'generate'
            }, context
        );
    }
    if (signals.imageStrength === 'definite') {
        const references = signals.referencesPrevious && !signals.generationVerb;
        const isModify = Boolean(active.type === 'image') && references;
        return buildSignalResolved(
            isModify ? INTENTS.MODIFY_PREVIOUS_GENERATION : INTENTS.IMAGE_GENERATION,
            signals, text, {
                subject: 'image',
                referencesPreviousContext: references,
                action: isModify ? 'modify' : 'generate'
            }, context
        );
    }

    // Vague follow-up tweaks ("change her outfit", "make it cinematic") while a
    // generation task is active: a modification of the previous generation.
    if (active.type && signals.referencesPrevious &&
        (signals.hasVideoWord || signals.hasImageWord || active.type === 'image' || active.type === 'video')) {
        return buildSignalResolved(INTENTS.MODIFY_PREVIOUS_GENERATION, signals, text, {
            subject: active.type,
            referencesPreviousContext: true,
            action: 'modify'
        }, context);
    }

    return null;
}

function buildSignalResolved(intent, signals, text, extra = {}, context = {}) {
    const resolved = {
        intent,
        confidence: extra.action === 'modify' ? 0.7 : 0.75,
        mode: extra.mode || MODES.UNKNOWN,
        referencesPreviousContext: Boolean(extra.referencesPreviousContext),
        referencedGenerationId: null,
        extractedRequest: extra.extractedRequest || text,
        subject: extra.subject || signals.subject,
        creative_mode: signals.promptIdeation || signals.promptWriting ? 'none' : detectCreativeFull(text),
        explicit_constraints: [],
        action: extra.action || (intent === INTENTS.MODIFY_PREVIOUS_GENERATION ? 'modify' : 'generate'),
        source: 'signal',
        signals
    };
    resolved.referencedGenerationId = pickReferencedAsset(resolved, context);
    return applyModeDefault(resolved, text, context, signals);
}

function detectCreativeFull(text) {
    try {
        return imageGenerator.detectCreativeFreedom
            ? imageGenerator.detectCreativeFreedom(text)
            : 'none';
    } catch (err) {
        return 'none';
    }
}

function buildChatResolved(signals, text, source) {
    return {
        intent: INTENTS.CHAT,
        confidence: source === 'semantic' ? 0.85 : 0.5,
        mode: MODES.UNKNOWN,
        referencesPreviousContext: false,
        referencedGenerationId: null,
        extractedRequest: text,
        subject: signals ? signals.subject : 'other',
        creative_mode: 'none',
        explicit_constraints: [],
        action: 'respond',
        source: source || 'fallback',
        signals: signals || null
    };
}

async function askResolver(message, input, context, signals) {
    const contextBlock = [
        'ACTIVE TASK: ' + JSON.stringify(context.activeTask),
        'LAST USER REQUEST: ' + JSON.stringify(context.lastUserRequest || ''),
        'LAST ASSISTANT ACTION: ' + JSON.stringify(context.lastAssistantAction || ''),
        'LAST GENERATED IMAGE: ' + JSON.stringify(context.lastGeneratedImage || null),
        'LAST GENERATED VIDEO: ' + JSON.stringify(context.lastGeneratedVideo || null),
        'SELECTED VIDEO MODE: ' + JSON.stringify(context.selectedMode || null),
        'HAS ATTACHED IMAGE: ' + (context.hasAttachedImage ? 'yes' : 'no'),
        'HAS REFERENCE IMAGE: ' + (context.referenceImage ? 'yes' : 'no'),
        'REGEX SIGNALS: ' + JSON.stringify({
            image: Boolean(signals.hasImageWord || signals.imageStrength),
            video: Boolean(signals.hasVideoWord || signals.videoStrength),
            prompt: signals.hasPromptWord,
            generation_verb: signals.generationVerb,
            references_previous: signals.referencesPrevious
        })
    ].join('\n');

    const userMessage =
        'CONVERSATION CONTEXT:\n' + contextBlock + '\n\n' +
        'USER LATEST MESSAGE:\n"' + String(message || '') + '"\n\n' +
        'Output the JSON classification only.';

    const messages = [
        { role: 'system', content: RESOLVER_SYSTEM_PROMPT },
        { role: 'user', content: userMessage }
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            // Intent classification is a deterministic JSON verdict, not a
            // reasoning task. Never run hidden thinking here: it multiplies the
            // turn's latency/GPU load for no accuracy gain (temperature 0).
            const raw = await providers.chat(input.provider, messages, input.model, { think: false, temperature: 0 });
            const parsed = parseResolverJson(raw);
            if (parsed && normalizeIntent(parsed.intent)) return parsed;
            // Malformed / unknown intent: retry once, then let the caller fall back.
            messages.push({ role: 'user', content: 'That was not a valid intent. Respond with ONLY the single JSON object using one of the listed intents.' });
        } catch (err) {
            console.warn('[intent-resolver] LLM resolution failed, using signals:', err.message);
            return null;
        }
    }
    return null;
}

function shouldConsultLlm(signals, context, text) {
    if (!text) return false;
    if (context.referenceImage || context.hasAttachedImage) return true;
    if (signals.any) return true;
    const active = context.activeTask || {};
    if (active.type && text.length <= 120) return true;
    return false;
}

// --- Public entry point -------------------------------------------------------

async function resolveIntent(input = {}) {
    const message = String(input.message || '');
    const text = message.trim();
    const context = input.context || buildIntentContext(input);
    const signals = collectSignals(text, { activeTask: context.activeTask });
    const debug = debugEnabled(input);

    let resolved = null;

    // A. Explicit user action — unambiguous, deterministic, no LLM needed.
    if (signals.directorMode && (signals.hasVideoWord || signals.videoStrength)) {
        resolved = buildSignalResolved(INTENTS.VIDEO_GENERATION, signals, text, {
            mode: MODES.DIRECTOR, subject: 'video', referencesPreviousContext: signals.referencesPrevious
        }, context);
    } else if (signals.directMode && (signals.hasVideoWord || signals.videoStrength)) {
        resolved = buildSignalResolved(INTENTS.VIDEO_GENERATION, signals, text, {
            mode: MODES.DIRECT, subject: 'video', referencesPreviousContext: signals.referencesPrevious
        }, context);
    }

    // B. Semantic resolution (LLM) — the final authority when ambiguous.
    if (!resolved && shouldConsultLlm(signals, context, text)) {
        const parsed = await askResolver(text, input, context, signals);
        if (parsed) {
            const fromLlm = finalizeFromParsed(parsed, input, signals, context);
            if (fromLlm) resolved = fromLlm;
        }
    }

    // Guard against a small model under-classifying explicit requests as chat.
    // High-precision evidence (a definite generation request, a content-targeted
    // edit, or a referenced change while a task is active) stays decisive even
    // when the LLM says "chat".
    if (resolved && resolved.intent === INTENTS.CHAT &&
        !signals.promptWriting && !signals.promptIdeation) {
        let strong = null;
        if (signals.editIntent) {
            strong = buildSignalResolved(INTENTS.IMAGE_EDIT, signals, text, { subject: 'image' }, context);
        } else if (signals.videoStrength === 'definite' || signals.productionRequest) {
            const isModify = Boolean(context.activeTask && context.activeTask.type === 'video' &&
                signals.referencesPrevious && !signals.productionRequest);
            strong = buildSignalResolved(
                isModify ? INTENTS.MODIFY_PREVIOUS_GENERATION : INTENTS.VIDEO_GENERATION,
                signals, text, {
                    subject: 'video',
                    referencesPreviousContext: signals.referencesPrevious,
                    action: isModify ? 'modify' : 'generate'
                }, context);
        } else if (signals.imageStrength === 'definite') {
            const isModify = Boolean(context.activeTask && context.activeTask.type === 'image' &&
                signals.referencesPrevious && !signals.generationVerb);
            strong = buildSignalResolved(
                isModify ? INTENTS.MODIFY_PREVIOUS_GENERATION : INTENTS.IMAGE_GENERATION,
                signals, text, {
                    subject: 'image',
                    referencesPreviousContext: signals.referencesPrevious,
                    action: isModify ? 'modify' : 'generate'
                }, context);
        } else if (context.activeTask && context.activeTask.type && signals.referencesPrevious &&
            !signals.isQuestion && (signals.generationVerb || SIGNALS_CHANGE_RE.test(text))) {
            strong = buildSignalResolved(INTENTS.MODIFY_PREVIOUS_GENERATION, signals, text, {
                subject: context.activeTask.type,
                referencesPreviousContext: true,
                action: 'modify'
            }, context);
        }
        if (strong) resolved = strong;
    }

    // C. Regex/keyword signals (fallback evidence).
    if (!resolved) {
        resolved = resolveFromSignals(signals, context);
    }

    // D. Normal chat fallback.
    let decisive = Boolean(resolved);
    if (!resolved) {
        resolved = buildChatResolved(signals, text, signals.any ? 'fallback' : 'plain');
        // A chat fallback is only decisive when we never consulted the LLM; a
        // failed LLM attempt leaves the turn to the existing action router so a
        // small model's malformed reply never silently swallows a real request.
        decisive = !shouldConsultLlm(signals, context, text);
    }

    resolved.decisive = decisive;
    if (debug) {
        console.log('[intent-resolver]\n' + formatDebugTrace({
            message: text,
            signals,
            resolved,
            finalAction: resolved.intent
        }));
    }
    return resolved;
}

module.exports = {
    INTENTS,
    MODES,
    RESOLVER_SYSTEM_PROMPT,
    collectSignals,
    buildIntentContext,
    resolveIntent,
    resolveFromSignals,
    normalizeIntent,
    parseResolverJson,
    formatDebugTrace,
    debugEnabled,
    looksLikeQuestion
};
