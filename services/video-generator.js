/* ============================================
   JARVIS — Video Generation Service (MiniMax H3)
   Detects video-generation intent, builds the
   MiniMax H3 ComfyUI workflow graph (T2VA and
   I2VA modes), submits it to ComfyUI, and stores
   the finished video so the chat layer can display it.
   SPDX-License-Identifier: GPL-3.0-only
   Copyright (c) 2025 not-so-jarvis contributors.
   Adapted from Mix Studio's working H3 implementation
   (https://github.com/BlackMixture/Mix-Studio, GPL-3.0-only):
   lib/video-workflows.js buildMiniMaxH3Graph + H3 resolution helpers.
   Modified: simplified to T2VA/first-frame I2VA only (no turbo,
   reference-video/audio, long-context, or RTX post-pass).
   ============================================ */

const fs = require('fs');
const path = require('path');
const comfyui = require('./comfyui');
const configManager = require('../server/config-manager');
const generatedHistory = require('./generated-history');
const generationQueue = require('./generation-queue');
const imageGenerator = require('./image-generator');
const { getModelById } = require('../server/models');

const GENERATED_DIR = path.join(__dirname, '..', 'data', 'generated');

// --- H3 Constants (from Mix Studio video-workflows.js + h3-resolution.js) -----
// S/M/L share Mix Studio's image tiers: 0.75 MP (S), 1 MP (M), 1.75 MP (L,
// the model's native canvas). H3 renders from a 768-short-edge base canvas
// capped at 768x1344 pixels, scaled per tier (S 0.5x, M 0.75x, L 1x).

const H3_FPS = 24;
const H3_MIN_SECONDS = 5;
const H3_MAX_SECONDS = 15;
const H3_BASE_SHORT_EDGE = 768;
const H3_MAX_PIXELS = 768 * 1344;

const H3_SIZE_SCALES = { S: 0.5, M: 0.75, L: 1 };
// Backwards-compatible alias: previous revisions exposed short-side pixels
// under this name ({ S: 768, M: 1024, L: 1536 }).
const H3_IMAGE_SIZES = H3_SIZE_SCALES;

// --- Default H3 Video Settings ------------------------------------------------

const H3_DEFAULT_STEPS = Number(process.env.H3_STEPS) || 20;

// Attention backend used for H3 video generation, matching Mix Studio's
// three mutually exclusive options:
//   standard      — dense PyTorch attention (no patch node)
//   sageattention — KJNodes PathchSageAttentionKJ patch (sageattention pkg)
//   sla           — H3SLAAttention sparse attention node (experimental)
const H3_ATTENTION_BACKENDS = Object.freeze(['standard', 'sageattention', 'sla']);

function normalizeH3AttentionBackend(value) {
    const requested = String(value || '').trim().toLowerCase().replace(/-/g, '');
    if (requested === 'sage' || requested === 'sageattention') return 'sageattention';
    if (requested === 'sla' || requested === 'h3sla') return 'sla';
    if (requested === 'standard' || requested === 'normal' || requested === 'pytorch') return 'standard';
    return 'standard';
}

const H3_DEFAULTS = {
    h3Unet: process.env.H3_UNET || 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
    h3Clip: process.env.H3_CLIP || 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    h3VideoVae: process.env.H3_VIDEO_VAE || 'minimax_h3_video_vae_fp16.safetensors',
    h3AudioVae: process.env.H3_AUDIO_VAE || 'minimax_h3_audio_vae_fp32.safetensors',
    h3Duration: Number(process.env.H3_DURATION) || 5,
    h3Size: process.env.H3_SIZE || 'M',
    attentionBackend: H3_ATTENTION_BACKENDS.includes(process.env.H3_ATTENTION_BACKEND)
        ? process.env.H3_ATTENTION_BACKEND
        : 'standard',
    loras: [],
    loraTriggerWords: {},
    // Video upscaling (SeedVR2 quality or fast RTX) shares the single global
    // upscale settings in imageGeneration (upscaleResolution/Profile/Noise/
    // PreScale, seedvr2 DiT/VAE/attention, upscaleEngine, upscaleMultiplier) —
    // one "upscale" for both image and video. There are no videoUpscale* keys;
    // see sharedUpscaleSettings().
};

const H3_CONFIGURABLE_KEYS = [
    'h3Unet', 'h3Clip', 'h3VideoVae', 'h3AudioVae',
    'h3Duration', 'h3Size', 'attentionBackend', 'loras', 'loraTriggerWords'
];

// Shared upscale keys (canonical names in imageGeneration). Posted to
// /api/settings/video for backwards compatibility they are written through
// to the image settings so there is exactly one upscale configuration.
const SHARED_UPSCALE_KEYS = [
    'upscaleEngine', 'upscaleMode', 'upscaleResolution', 'upscaleMultiplier',
    'upscaleProfile', 'upscaleNoise', 'upscalePreScale',
    'seedvr2Dit', 'seedvr2Vae', 'seedvr2Attention'
];

// Legacy per-video upscale keys. No longer stored; accepted once via
// saveVideoSettings and mapped onto the shared keys above.
const LEGACY_VIDEO_UPSCALE_MAP = {
    videoUpscaleEngine: 'upscaleEngine',
    videoUpscaleResolution: 'upscaleResolution',
    videoUpscaleProfile: 'upscaleProfile',
    videoUpscaleNoise: 'upscaleNoise',
    videoUpscalePreScale: 'upscalePreScale',
    videoUpscaleDit: 'seedvr2Dit',
    videoUpscaleVae: 'seedvr2Vae',
    videoUpscaleAttention: 'seedvr2Attention'
};

// Single source of truth for upscale tuning: the shared imageGeneration
// upscale settings. Both "upscale this image" and "upscale this video" read
// resolution/profile/noise/pre-scale/DiT/VAE/attention from here.
function sharedUpscaleSettings() {
    return imageGenerator.effectiveSettings();
}

// --- Frame / Dimension helpers (adapted from Mix Studio) ----------------------

function h3DurationSeconds(requestedSeconds) {
    const requested = Number(requestedSeconds);
    return Math.max(H3_MIN_SECONDS, Math.min(
        H3_MAX_SECONDS,
        Number.isFinite(requested) ? requested : H3_MIN_SECONDS
    ));
}

function h3FramesForSeconds(seconds) {
    const raw = Math.max(5, Math.round(h3DurationSeconds(seconds) * H3_FPS));
    return raw + ((5 - (raw % 17) + 17) % 17);
}

function h3EffectiveDurationSeconds(seconds) {
    return h3FramesForSeconds(seconds) / H3_FPS;
}

function readImageDimensions(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(32);
        fs.readSync(fd, buf, 0, 32, 0);
        fs.closeSync(fd);

        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
            const w = buf.readUInt32BE(16);
            const h = buf.readUInt32BE(20);
            if (w > 0 && h > 0) return { width: w, height: h };
        }

        if (buf[0] === 0xFF && buf[1] === 0xD8) {
            let offset = 2;
            while (offset < 30) {
                if (buf[offset] !== 0xFF) break;
                const marker = buf[offset + 1];
                if ((marker >= 0xC0 && marker <= 0xCF) && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
                    const h = buf.readUInt16BE(offset + 5);
                    const w = buf.readUInt16BE(offset + 7);
                    if (w > 0 && h > 0) return { width: w, height: h };
                }
                offset += 2;
            }
        }
    } catch (_) {}
    return null;
}

function h3SizeScale(size) {
    const key = String(size || '').trim().toUpperCase();
    return H3_SIZE_SCALES[key] || H3_SIZE_SCALES.M;
}

function h3Dimensions(width, height, size) {
    const requestedWidth = Number(width);
    const requestedHeight = Number(height);
    const sourceWidth = Number.isFinite(requestedWidth) && requestedWidth > 0 ? requestedWidth : 1344;
    const sourceHeight = Number.isFinite(requestedHeight) && requestedHeight > 0 ? requestedHeight : 768;
    const ratio = sourceWidth / sourceHeight;

    let nominalWidth;
    let nominalHeight;
    if (ratio >= 1) {
        nominalWidth = H3_BASE_SHORT_EDGE * ratio;
        nominalHeight = H3_BASE_SHORT_EDGE;
    } else {
        nominalWidth = H3_BASE_SHORT_EDGE;
        nominalHeight = H3_BASE_SHORT_EDGE / ratio;
    }
    if (nominalWidth * nominalHeight > H3_MAX_PIXELS) {
        const fit = Math.sqrt(H3_MAX_PIXELS / (nominalWidth * nominalHeight));
        nominalWidth *= fit;
        nominalHeight *= fit;
    }
    const scale = h3SizeScale(size);
    return {
        W: Math.max(32, Math.round((nominalWidth * scale) / 32) * 32),
        H: Math.max(32, Math.round((nominalHeight * scale) / 32) * 32),
    };
}

// --- Generation lock (shared with image-generator) ---------------------------
// Single FIFO in services/generation-queue.js. Both pipelines delegate here
// so image/video/upscale never run concurrently and extras queue.

function canStartGeneration() {
    return generationQueue.canStartGeneration();
}

function withGenerationLock(fn, opts = {}) {
    return generationQueue.enqueue(fn, opts);
}

// Backwards-compat no-op: both services already share generation-queue.
function registerGenerationLock(imageGen) {
    return true;
}

// --- Video intent detection --------------------------------------------------

const VIDEO_SIGNAL_RE = /\b(?:generat|creat|mak|render|produc|record|shoot|animat|turn\s+into|bring\s+to\s+life|make\s+(?:a\s+)?video)\w*\b/i;
const VIDEO_WORD_RE = /\b(?:video|film|clip|movie|animation|reel|footage|scene|walkthrough|timelapse|time\s*lapse)\b/i;
const VIDEO_REQUEST_RE = /\b(?:generate|create|make|render|produce|record|shoot|animate)\w*\s+(?:a\s+)?(?:video|film|clip|movie|animation|reel|footage)\b/i;

// Image-to-video reference phrases: "use this image", "animate this",
// "turn this into", "make a video from this", "bring this to life", etc.
// This gates entry into the LLM intent classifier (the final authority), so it
// deliberately covers every phrasing the router must recognize as I2VA.
// NOTE: pronoun + motion patterns ("make her walk", "make it rain") REQUIRE a
// motion verb — a bare "make her ..." must NOT match, otherwise still-image
// tweaks like "make her wear a blue tank top" are misread as video requests.
const I2V_REF_RE =
    /\b(?:use\s+(?:this|that|the\s+(?:image|photo|picture|generated))|turn\s+(?:this|that|the)\s+(?:(?:image|photo|picture)\s+)?into|make\s+(?:this|that)\s+(?:(?:image|photo|picture)\s+)?into|make\s+(?:a\s+)?(?:video|film|clip|movie|animation)\s+from\s+(?:this|that|it|the\s+(?:image|photo|picture))|make\s+(?:this|that)\s+(?:image|photo|picture)\s+(?:a\s+)?video|animat(?:e|ing)\s+(?:this|that|the)|bring\s+(?:this|that|the|it)\s+(?:(?:image|photo|picture)\s+)?to\s+life|from\s+(?:this|that|the)\s+(?:image|photo|picture)|using\s+(?:this|that|the)\s+(?:image|photo|picture)|with\s+(?:this|that|the)\s+(?:image|photo|picture)|(?:the|that)\s+image\s+above|make\s+(?:her|him|them|it)\s+(?:walk|run|smile|wave|talk|move|dance|spin|turn|laugh|cry|jump|fly|float|glow|sparkle|rain|snow))\b/i;

// Still-image attribute changes ("make her wear X", "change her dress", ...)
// are NEVER video requests on their own. When such a pattern is present and
// there is no explicit video noun or motion verb, the video pipeline must stay
// out so the request falls through to the image router.
const STILL_IMAGE_EDIT_RE =
    /\b(?:wear(?:ing|s)?|dress(?:ed|es)?|outfit|cloth(?:es|ing)|tank\s*top|neckline|blouse|shirt|jeans|skirt|trousers|kimono|sweater|jacket|gown|background|hairstyle|makeup)\b/i;
const VIDEO_MOTION_VERB_RE =
    /\b(?:walk|run|smile|wave|talk|move|moving|dance|spin|turn|laugh|cry|jump|fly|float|animat(?:e|ing)|bring\s+(?:\w+\s+)?to\s+life)\b/i;

function isStillImageOnlyChange(message) {
    const text = String(message || '');
    if (!STILL_IMAGE_EDIT_RE.test(text)) return false;
    if (VIDEO_WORD_RE.test(text)) return false;
    if (VIDEO_MOTION_VERB_RE.test(text)) return false;
    return true;
}

// Concept questions about video generation.
function isVideoConceptQuestion(message) {
    const text = String(message || '').trim();
    if (!text) return true;
    if (/^(?:what|which|why|who|when|where)\b/i.test(text)) return true;
    if (/^how\b[\s\S]*\b(?:do|does|can|could|would|should|to|i)\b/i.test(text)) return true;
    if (/\b(?:explain|describe|teach|define|learn|understand|tell\s+me)\b/i.test(text)) return true;
    if (/\bvideo\s*(?:generation|model|making)\b/i.test(text)) return true;
    return false;
}

function videoRequestStrength(message) {
    if (isVideoConceptQuestion(message)) return null;
    // Still-image clothing/appearance tweaks are never video — bail out before
    // the broad generation-verb heuristic ("make ...") can flag them as likely.
    if (isStillImageOnlyChange(message)) return null;
    if (VIDEO_REQUEST_RE.test(message)) return 'definite';
    if (I2V_REF_RE.test(message)) return 'definite';
    const hasVideoVerb = VIDEO_SIGNAL_RE.test(message);
    if (hasVideoVerb && VIDEO_WORD_RE.test(message)) return 'definite';
    if (hasVideoVerb) return 'likely';
    if (VIDEO_WORD_RE.test(message)) return 'likely';
    return null;
}

// --- H3 Video Director System Prompt (Ollama) --------------------------------

const H3_DIRECTOR_SYSTEM_PROMPT =
    'You are JARVIS\'s H3 Video Director. You convert video requests into MiniMax H3 compliant ' +
    'prompts following the official H3 Video Prompt Writing Guide.\\n\\n' +

    'OUTPUT FORMAT — always output a JSON object:\\n' +
    '{"mode": "t2va"|"i2va", "prompt": "..."}\\n\\n' +

    'MODE RULES:\\n' +
    '- "t2va": Text-to-Video-Audio. No reference image.\\n' +
    '- "i2va": Image-to-Video-Audio. A reference image is provided as the first frame.\\n' +
    '- For I2VA, the prompt MUST reference <Picture 1>.\\n' +
    '- For I2VA, always include this exact alignment line:\\n' +
    '"For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced."\\n' +
    '- Never leave <Picture 1> empty or replace it with a blank space.\\n\\n' +

    'SHOT RULE — CRITICAL:\\n' +
    '- Use ONLY [Shot 1] by default.\\n' +
    '- Do NOT create [Shot 2], [Shot 3], or any additional shots unless the user explicitly requests ' +
    'multiple shots, a scene change, a cut, a transition to another scene, or separate shots.\\n' +
    '- A continuous action MUST remain entirely inside [Shot 1].\\n' +
    '- Do NOT use timestamps to divide a continuous action into multiple shots.\\n' +
    '- Do NOT create additional shots simply because the action changes over time.\\n' +
    '- If the user does not specify a shot change, assume the entire video is one continuous shot.\\n\\n' +

    'PROMPT STRUCTURE:\\n\\n' +

    'integrated_multimodal_description:\\n' +
    '[Shot 1] Describe the complete continuous sequence: starting visual state, subject appearance, ' +
    'environment, composition, lighting, camera position, action, movement, reactions, and natural ' +
    'visual evolution throughout the video.\\n' +
    'For I2VA, describe the reference image as the starting state and explain how the action naturally ' +
    'continues from that frame.\\n\\n' +

    'overall_soundscape:\\n' +
    'Describe environmental and diegetic sounds that naturally match the visual action. Include relevant ' +
    'ambience such as footsteps, wind, rain, traffic, crowd noise, object movement, or other physical sounds.\\n\\n' +

    'non_diegetic_music:\\n' +
    'Describe suitable background music when appropriate, or write "N/A" when no music is needed.\\n\\n' +

    'I2VA ACTION TIMING — CRITICAL:\\n' +
    '- The reference image is the first frame, not a static introductory pause.\\n' +
    '- Unless the user explicitly requests a delay, the requested action MUST begin at 0.00 seconds.\\n' +
    '- NEVER invent a 2-5 second pause before the action.\\n' +
    '- NEVER delay the action simply to separate the reference image from the motion.\\n' +
    '- The reference image establishes the starting state at 0.00 seconds.\\n' +
    '- Describe the action beginning immediately from that starting state.\\n' +
    '- Only introduce delayed timing when the user explicitly specifies it.\\n\\n' +

    'CONTINUOUS ACTION:\\n' +
    '- Describe how the action develops naturally from beginning to end within [Shot 1].\\n' +
    '- You may describe progression such as "begins", "then", "continues", "gradually", and "ends" ' +
    'without creating additional shots.\\n' +
    '- Use timestamps only when the user explicitly specifies timing or when timing is essential to a ' +
    'specific requested event.\\n\\n' +

    'CREATIVE RULES:\\n' +
    '- When the user says "be creative", act as a director: decide natural movement, pacing, camera ' +
    'motion, soundscape, and music that serve the visual concept.\\n' +
    '- For I2VA, preserve the subject identity, clothing, hairstyle, environment, composition, colors, ' +
    'key objects, and visual style from <Picture 1>.\\n' +
    '- Never change the subject\'s identity, clothing, hairstyle, setting, or important objects unless ' +
    'the user explicitly asks for the change.\\n' +
    '- When the user gives a specific action, center the video on that action while preserving the reference image.\\n' +
    '- Camera movement should be concrete and purposeful: push in, pull out, pan, tilt, tracking, arc, ' +
    'static, handheld, etc.\\n' +
    '- Do not invent dialogue. Preserve user-provided dialogue exactly.\\n' +
    '- Do not invent on-screen text. Preserve user-provided on-screen text exactly.\\n' +
    '- Avoid generic filler such as "highly detailed", "stunning visuals", "cinematic masterpiece", ' +
    '"8K", "professional quality", or "beautiful lighting".\\n' +
    '- Prefer concrete, observable visual and audio descriptions over abstract praise.\\n\\n' +

    'I2VA FIRST-FRAME RULE:\\n' +
    'When a reference image is available, the first-frame alignment line must explicitly identify ' +
    '<Picture 1>. The visual description must describe what happens FROM that starting frame. Do not ' +
    'describe a separate introductory scene before the requested action.\\n\\n' +

    'TECHNICAL SETTINGS & VIDEO DURATION:\\n' +
    '- The target video duration is determined by application settings and provided in the request context.\\n' +
    '- Craft the pacing, continuous action, movement speed, and audio evolution to fit naturally within this duration.\\n' +
    '- Do NOT override or invent technical generation parameters.\\n' +
    '- Your responsibility is the H3 mode and creative prompt only.\\n\\n' +

    'FINAL CHECK BEFORE OUTPUT:\\n' +
    '- Default to exactly ONE shot: [Shot 1].\\n' +
    '- Only use additional shots when explicitly requested by the user.\\n' +
    '- If I2VA, confirm the exact <Picture 1> alignment line is present.\\n' +
    '- Confirm the requested action begins at 0.00 seconds unless the user explicitly requested a delay.\\n' +
    '- Confirm there is no artificial introductory pause.\\n' +
    '- Confirm unrelated reference-image details are preserved.\\n' +
    '- Output ONLY the JSON object.\\n\\n' +

    'Respond with ONLY the JSON object.';

// --- H3 Video Prompt Modifier (for conversational modifications) ---------------

const H3_MODIFIER_SYSTEM_PROMPT =
    'You are an H3 video prompt editor. You are given the CURRENT H3 video prompt ' +
    'and a USER MODIFICATION. Rewrite the entire prompt into a NEW complete H3 prompt ' +
    'that applies the requested change.\n\n' +

    'RULES:\n' +
    '- Preserve the H3 prompt structure (integrated_multimodal_description, ' +
    'overall_soundscape, non_diegetic_music).\n' +
    '- For I2VA prompts, preserve the <Picture 1> alignment and all reference tokens.\n' +
    '- When a reference image is attached, it is the video\'s first frame: study ' +
    'it and keep the subject identity, clothing, setting, composition, and ' +
    'visual style unless the modification explicitly changes them.\n' +
    '- Apply the modification as an actual change, not an instruction appended.\n' +
    '- Preserve every existing detail the user did not ask to change.\n' +
    '- Update the soundscape and music if the visual change affects them.\n' +
    '- The result must describe the final video, not describe the editing operation.\n\n' +

    'Output ONLY the new full H3 prompt. No explanations, no quotes, no markdown.';

// --- H3 intent detection (LLM-based) -----------------------------------------

const H3_INTENT_SYSTEM_PROMPT =
    'You are JARVIS\'s video intent classifier. Classify whether the user wants ' +
    'to generate a video using the MiniMax H3 pipeline.\n\n' +

    'Respond with ONLY a single JSON object, no markdown, no commentary.\n\n' +

    'For video generation requests:\n' +
    '{"intent": "video_generation", "action": "generate|modify", ' +
    '"user_prompt": "the video concept or scene description", ' +
    '"creative_mode": "none|light|full", "has_reference_image": true|false, ' +
    '"explicit_constraints": []}\n\n' +

    'For normal chat:\n' +
    '{"intent": "chat", "related_task": "video_generation"|null, "message": "..."}\n\n' +

    'Classification rules:\n' +
    '- Video requests: "generate a video of X", "make a film about X", ' +
    '"animate this image", "use this image to generate a video", ' +
    '"bring this to life", "make a video", "create a clip of X".\n' +
    '- NOT video (→ chat): still-image attribute changes with no motion or ' +
    'video noun, e.g. "make her wear a blue tank top", "change her dress", ' +
    '"change the background". These belong to the image pipeline.\n' +
    '- "has_reference_image": true when the user references an existing image ' +
    '("this image", "the image above", "use the generated image").\n' +
    '- "modify": an incremental change to an existing video concept.\n' +
    '- Normal questions → chat.\n\n' +

    'creative_mode rules:\n' +
    '- "none": specific video concept provided.\n' +
    '- "light": some creative enhancement requested.\n' +
    '- "full": user grants creative freedom ("be creative", "surprise me").\n\n' +

    'Output ONLY the JSON.';

function parseIntentJson(raw) {
    if (!raw) return null;
    let text = String(raw).trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) text = fenced[1].trim();
    const braceStart = text.indexOf('{');
    const braceEnd = text.lastIndexOf('}');
    if (braceStart === -1 || braceEnd === -1 || braceEnd <= braceStart) return null;
    text = text.slice(braceStart, braceEnd + 1);
    try { return JSON.parse(text); } catch { return null; }
}

async function detectVideoIntent(message, providers, provider, model) {
    const strength = videoRequestStrength(message);
    if (strength === null) {
        return { intent: 'chat', related_task: null, message };
    }

    const cluesPrompt =
        'User message: "' + message + '"\n\n' +
        'Output the JSON classification only.';

    try {
        const raw = await providers.chat(provider, [
            { role: 'system', content: H3_INTENT_SYSTEM_PROMPT },
            { role: 'user', content: cluesPrompt }
        ], model);

        const parsed = parseIntentJson(raw);
        if (parsed && parsed.intent === 'video_generation') {
            const creative_mode = String(parsed.creative_mode || 'none').toLowerCase();
            const normalized = (creative_mode === 'full' || creative_mode === 'light') ? creative_mode : 'none';
            return {
                intent: 'video_generation',
                action: String(parsed.action || '').toLowerCase() === 'modify' ? 'modify' : 'generate',
                user_prompt: String(parsed.user_prompt || '').trim() || message,
                creative_mode: normalized,
                has_reference_image: Boolean(parsed.has_reference_image),
                explicit_constraints: Array.isArray(parsed.explicit_constraints) ? parsed.explicit_constraints : []
            };
        }
        if (parsed && parsed.intent === 'chat') {
            return { intent: 'chat', related_task: parsed.related_task || null, message };
        }
    } catch (err) {
        console.warn('[video-generator] LLM intent detection failed:', err.message);
    }

    // Heuristic fallback for definite requests.
    if (strength === 'definite') {
        const hasRef = I2V_REF_RE.test(message);
        return {
            intent: 'video_generation',
            action: 'generate',
            user_prompt: message,
            creative_mode: 'none',
            has_reference_image: hasRef,
            explicit_constraints: []
        };
    }

    return { intent: 'chat', related_task: null, message };
}

// --- Video upscale intent detection -------------------------------------------
//
// Narrow, deterministic intent — no LLM needed. Mirrors image-generator's
// detectUpscaleIntent but requires a VIDEO reference (video/film/clip/movie/
// footage/etc. or a pronoun pointing at the last generated video), so
// "upscale this video" routes to the video upscale pipeline while
// "upscale this image" still routes to the image pipeline. Concept questions
// ("what is upscaling?") never fire.

const VIDEO_UPSCALE_SIGNAL_RE = /\b(?:up\s*scale\w*|up\s*res\w*|super\s*res\w*|higher\s*res\w*|hi\s*res\b|increase\w*\s+(?:the\s+)?res\w*|improve\w*\s+(?:the\s+)?(?:res\w*|video\w*|clip\w*|film\w*|movie\w*|footage\w*)|make\s+(?:it|this|that)\s+(?:bigger|larger|sharper|crisper|clearer|higher\s*res)|sharpen\w*|enlarge\w*|4k\b)\b/i;
const VIDEO_UPSCALE_REF_RE = /\b(?:video\w*|film\w*|clip\w*|movie\w*|footage\w*|animation\w*|reel\w*|mp4\b|webm\b|mov\b|this\b|that\b|it\b|them\b|one\b|the last\b|previous\b|generated\b)\b/i;

function detectVideoUpscaleIntent(message) {
    const text = String(message || '');
    if (!text.trim()) return null;
    if (isVideoConceptQuestion(text)) return null;
    const norm = text.toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!VIDEO_UPSCALE_SIGNAL_RE.test(norm)) return null;
    if (!VIDEO_UPSCALE_REF_RE.test(norm)) return null;
    // Require an explicit video noun so a bare "upscale this" still goes to
    // the image pipeline (backwards compatible). Pronoun-only requests are
    // resolved by the active task type in the router.
    if (!/\b(?:video|film|clip|movie|footage|animation|reel|mp4|webm|mov|4k)\b/i.test(norm)) return null;
    return { intent: 'video_upscale' };
}

// --- H3 Prompt Building -------------------------------------------------------

async function buildH3VideoPrompt(structuredRequest, providers, provider, model, sourceImageRawFilename, conversationId) {
    const { user_prompt, creative_mode, has_reference_image, previous_prompt, explicit_constraints } = structuredRequest;
    const isModify = Boolean(previous_prompt && structuredRequest.modification);

    let visionAvailable = false;
    let sourceImageBase64 = null;

    if (has_reference_image && !isModify && sourceImageRawFilename) {
        const modelInfo = getModelById(model);
        if (modelInfo && modelInfo.capabilities && modelInfo.capabilities.includes('vision')) {
            const filePath = path.join(GENERATED_DIR, sourceImageRawFilename);
            if (fs.existsSync(filePath)) {
                try {
                    sourceImageBase64 = fs.readFileSync(filePath).toString('base64');
                    visionAvailable = true;
                    console.log('[video] vision-capable model detected, sending reference image to LLM');
                } catch (err) {
                    console.warn('[video] failed to read source image for vision:', err.message);
                }
            } else {
                console.warn('[video] source image file not found:', filePath);
            }
        } else {
            console.log('[video] model "' + model + '" does not have vision capabilities, falling back to text-only prompting');
        }
    }

    const videoSettings = effectiveVideoSettings();
    const durationSeconds = h3DurationSeconds(videoSettings.h3Duration);

    let userMessage;
    let userMessageImages = null;
    if (isModify) {
        userMessage =
            'CURRENT H3 VIDEO PROMPT (source of truth):\n"' + previous_prompt + '"\n\n' +
            'USER MODIFICATION REQUEST:\n"' + structuredRequest.modification + '"\n\n' +
            'creative_mode: "' + creative_mode + '"\n' +
            'explicit_constraints: ' + JSON.stringify(explicit_constraints || []) + '\n\n' +
            'Mode: ' + (has_reference_image ? 'i2va' : 't2va') + '\n' +
            'Video duration: ' + durationSeconds + ' seconds\n' +
            'Output ONLY the JSON described in the system prompt.';
    } else {
        const mode = has_reference_image ? 'i2va' : 't2va';
        let sourceNote;
        if (has_reference_image && visionAvailable) {
            sourceNote =
                'SOURCE IMAGE: The image is attached directly below. Study it carefully.\n' +
                'It is the exact first frame of the video at 0.00 seconds. Describe what you see ' +
                'in [Shot 1] by matching the subject identity, clothing, hairstyle, environment, ' +
                'composition, lighting, and visual style from the image.\n';
        } else if (has_reference_image) {
            sourceNote =
                'SOURCE IMAGE: a previously generated image will serve as <Picture 1>. ' +
                'It is the exact first frame of the video at 0.00 seconds. Preserve its subject, ' +
                'identity, outfit, setting, composition, lighting, and visual style in [Shot 1].\n';
        } else {
            sourceNote = 'SOURCE IMAGE: none. This is text-only T2VA.\n';
        }
        userMessage =
            sourceNote +
            'USER VIDEO REQUEST: "' + user_prompt + '"\n' +
            'MODE: ' + mode + '\n' +
            'creative_mode: "' + creative_mode + '"\n' +
            'has_reference_image: ' + JSON.stringify(has_reference_image) + '\n' +
            'explicit_constraints: ' + JSON.stringify(explicit_constraints || []) + '\n\n' +
            'Video duration: ' + durationSeconds + ' seconds\n' +
            'Output ONLY the JSON described in the system prompt.';
        if (visionAvailable && sourceImageBase64) {
            userMessageImages = [sourceImageBase64];
        }
    }

    try {
        const userMsg = { role: 'user', content: userMessage };
        if (userMessageImages) userMsg.images = userMessageImages;
        const raw = await providers.chat(provider, [
            { role: 'system', content: H3_DIRECTOR_SYSTEM_PROMPT },
            userMsg
        ], model);

        const parsed = parseIntentJson(raw);
        if (parsed && parsed.prompt) {
            return {
                mode: parsed.mode || (has_reference_image ? 'i2va' : 't2va'),
                prompt: String(parsed.prompt).trim(),
                duration: Math.max(H3_MIN_SECONDS, Math.min(H3_MAX_SECONDS, Number(parsed.duration) || H3_MIN_SECONDS)),
                width: Number(parsed.width) || 1024,
                height: Number(parsed.height) || 768,
            };
        }
    } catch (err) {
        console.warn('[video-generator] H3 prompt builder failed:', err.message);
    }

    // Fallback: wrap the raw user request in basic H3 structure.
    const mode = has_reference_image ? 'i2va' : 't2va';
    const alignmentLine = has_reference_image
        ? 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n'
        : '';
    const fallbackPrompt =
        alignmentLine +
        'integrated_multimodal_description:\n' +
        '[Shot 1] ' + user_prompt + '\n\n' +
        'overall_soundscape:\n' +
        'Ambient environmental sounds matching the scene.\n\n' +
        'non_diegetic_music:\n' +
        'N/A';

    return {
        mode,
        prompt: fallbackPrompt,
        duration: H3_MIN_SECONDS,
        width: 1024,
        height: 768,
    };
}

// --- H3 Video Prompt Modifier (conversational modifications) ------------------

async function modifyH3VideoPrompt(currentPrompt, userMessage, providers, provider, model, opts) {
    // Reference the last generated image with eyes on it: when the caller
    // passes the I2VA source filename and the chat model supports vision, the
    // source frame is attached so the rewrite edits what is actually on
    // screen (e.g. "generate the video again but make her wave" keeps the
    // same woman/outfit/setting and only changes the motion).
    let sourceImageBase64 = null;
    const sourceImageRawFilename = opts && opts.sourceImageRawFilename;
    if (sourceImageRawFilename) {
        const modelInfo = getModelById(model);
        if (modelInfo && modelInfo.capabilities && modelInfo.capabilities.includes('vision')) {
            const filePath = path.join(GENERATED_DIR, path.basename(String(sourceImageRawFilename).split('?')[0]));
            if (fs.existsSync(filePath)) {
                try {
                    sourceImageBase64 = fs.readFileSync(filePath).toString('base64');
                    console.log('[video] modifier using reference image for vision:', sourceImageRawFilename);
                } catch (err) {
                    console.warn('[video] modifier failed to read source image:', err.message);
                }
            }
        }
    }
    const modifierMessage =
        (sourceImageBase64
            ? 'REFERENCE IMAGE: attached below — it is the video\'s exact first frame (<Picture 1>). Preserve its subject, identity, outfit, setting, composition, lighting, and visual style unless the modification explicitly changes them.\n\n'
            : '') +
        'CURRENT H3 VIDEO PROMPT:\n"' + currentPrompt + '"\n\n' +
        'USER MODIFICATION:\n"' + userMessage + '"\n\n' +
        'Output ONLY the new full H3 video prompt.';

    try {
        const userMsg = { role: 'user', content: modifierMessage };
        if (sourceImageBase64) userMsg.images = [sourceImageBase64];
        const raw = await providers.chat(provider, [
            { role: 'system', content: H3_MODIFIER_SYSTEM_PROMPT },
            userMsg
        ], model);
        const updated = String(raw || '').trim();
        if (updated) return updated;
    } catch (err) {
        console.warn('[video-generator] H3 prompt modifier failed:', err.message);
    }

    // Keep current prompt unchanged on failure.
    return String(currentPrompt || '').trim();
}

// --- H3 Video Settings --------------------------------------------------------

function effectiveVideoSettings() {
    const stored = configManager.getVideoSettings();
    const settings = { ...H3_DEFAULTS };
    for (const key of Object.keys(settings)) {
        let value = stored[key];
        if (value !== undefined && value !== null && value !== '') {
            if (key === 'h3Size') {
                const s = String(value).trim().toUpperCase();
                value = Object.prototype.hasOwnProperty.call(H3_IMAGE_SIZES, s) ? s : H3_DEFAULTS.h3Size;
            } else if (key === 'attentionBackend') {
                value = normalizeH3AttentionBackend(value);
            }
            settings[key] = value;
        }
    }
    return settings;
}

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

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

// --- Video Upscale Settings ----------------------------------------------------
//
// Video upscale shares the single global upscale configuration with image
// upscale (resolution/profile/noise/pre-scale/DiT/VAE/attention live in
// imageGeneration). Engine is shared too but mapped per medium like Mix
// Studio: videos run SeedVR2 or RTX (an Ultimate SD selection falls back to
// RTX); images run SeedVR2 or Ultimate SD (an RTX selection falls back to
// SeedVR2 there). RTX is a fast single-pass super-resolution node and the
// default, matching Mix Studio's `seedvr2 ? seedvr2 : rtx` normalization —
// SeedVR2 is the slow diffusion DiT quality path. RTX uses upscaleMultiplier
// as its scale factor; SeedVR2 uses upscaleResolution as its target short
// side. Image-only keys (upscaleMode, Ultimate SD engine) are ignored here.

const VIDEO_UPSCALE_RESOLUTIONS = [1080, 1440, 2160, 3840];
const VIDEO_UPSCALE_SCALES = [1.5, 2, 3, 4];
const VIDEO_UPSCALE_PROFILES = ['sharp', 'balanced'];
const VIDEO_UPSCALE_NOISE_LEVELS = { off: 0, low: 0.06, medium: 0.15 };
const VIDEO_UPSCALE_ENGINES = ['seedvr2', 'rtx'];
const VIDEO_UPSCALE_DEFAULT_ENGINE = 'rtx';
const VIDEO_UPSCALE_RTX_QUALITIES = ['ULTRA', 'HIGH', 'BALANCED', 'FAST'];

// Mix Studio normalization (server.js buildExistingVideoUpscale,
// lib/video-workflows.js videoProcessInfo): only an explicit SeedVR2 choice
// selects the diffusion path; everything else (including the image-only
// Ultimate SD engine) falls back to the fast RTX path.
function normalizeVideoUpscaleEngine(value, fallback) {
    const v = String(value || '').trim().toLowerCase();
    if (v === 'seedvr2') return 'seedvr2';
    if (v === 'rtx') return 'rtx';
    if (v === 'ultimate') return 'rtx';
    return fallback !== undefined ? fallback : VIDEO_UPSCALE_DEFAULT_ENGINE;
}

function normalizeVideoUpscaleScale(value, fallback) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(1, Math.min(4, Math.round(n * 10) / 10));
    return fallback !== undefined ? fallback : 2;
}

function normalizeRtxQuality(value, fallback) {
    const v = String(value || '').trim().toUpperCase();
    if (VIDEO_UPSCALE_RTX_QUALITIES.includes(v)) return v;
    return fallback !== undefined ? fallback : 'ULTRA';
}

function getVideoDefaults() {
    return { ...H3_DEFAULTS };
}

function saveVideoSettings(patch) {
    const out = {};
    const sharedPatch = {};
    for (const [key, value] of Object.entries(patch || {})) {
        if (Object.prototype.hasOwnProperty.call(LEGACY_VIDEO_UPSCALE_MAP, key)) {
            sharedPatch[LEGACY_VIDEO_UPSCALE_MAP[key]] = value;
        } else if (SHARED_UPSCALE_KEYS.includes(key)) {
            sharedPatch[key] = value;
        }
    }
    if (Object.keys(sharedPatch).length) imageGenerator.saveSettings(sharedPatch);
    for (const key of H3_CONFIGURABLE_KEYS) {
        if (!(key in patch)) continue;
        const value = patch[key];
        if (value === null || value === undefined || value === '') {
            out[key] = null;
        } else if (key === 'loras') {
            out[key] = sanitizeLoras(value);
        } else if (key === 'loraTriggerWords') {
            out[key] = sanitizeLoraTriggerWords(value);
        } else if (key === 'h3Duration') {
            const n = Math.round(Number(value));
            if (Number.isFinite(n) && n >= 5 && n <= 15) out[key] = n;
        } else if (key === 'h3Size') {
            const s = String(value).trim().toUpperCase();
            if (Object.prototype.hasOwnProperty.call(H3_IMAGE_SIZES, s)) out[key] = s;
        } else if (key === 'attentionBackend') {
            out[key] = normalizeH3AttentionBackend(value);
        } else if (typeof value === 'string') {
            out[key] = value.trim() || null;
        }
    }
    if (Object.keys(out).length) configManager.setVideoSettings(out);
    return effectiveVideoSettings();
}

async function getVideoModelChoices() {
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

// --- H3 ComfyUI Workflow Graph ------------------------------------------------
//
// Adapted from Mix Studio's buildMiniMaxH3Graph(). Simplified for JARVIS:
// no turbo LoRAs, no long context, no reference videos/audio, no custom
// attention nodes. Supports T2VA (frames mode, optional first image) and
// I2VA (frames mode with first image as reference).

function buildH3Graph(opts) {
    const {
        prompt,
        mode = 't2va',
        W = 1024,
        H = 768,
        frames = 124,
        seed = 0,
        settings = {},
        firstImageName = null,
    } = opts;

    const loras = (Array.isArray(settings.loras) ? settings.loras : [])
        .filter((l) => l && l.on !== false && l.name);

    const graph = {
        model: {
            class_type: 'UNETLoader',
            inputs: {
                unet_name: settings.h3Unet || H3_DEFAULTS.h3Unet,
                weight_dtype: 'default',
            },
        },
        clip: {
            class_type: 'CLIPLoader',
            inputs: {
                clip_name: settings.h3Clip || H3_DEFAULTS.h3Clip,
                type: 'minimax',
                device: 'default',
            },
        },
        video_vae: {
            class_type: 'VAELoader',
            inputs: { vae_name: settings.h3VideoVae || H3_DEFAULTS.h3VideoVae },
        },
        audio_vae: {
            class_type: 'VAELoader',
            inputs: { vae_name: settings.h3AudioVae || H3_DEFAULTS.h3AudioVae },
        },
        noise: {
            class_type: 'RandomNoise',
            inputs: { noise_seed: seed },
        },
        sampler_select: {
            class_type: 'KSamplerSelect',
            inputs: { sampler_name: 'res_multistep' },
        },
    };

    // Chain user LoRAs onto the base model. Each active LoRA becomes a
    // LoraLoaderModelOnly node whose model output feeds the next, matching
    // Mix Studio's approach for H3 (model-only adapters, no CLIP).
    let userModelNode = 'model';
    let loraIndex = 0;
    for (const lora of loras) {
        const name = String(lora.name).trim();
        if (!name) continue;
        const strength = clampNumber(lora.strength, -100, 100, 0);
        loraIndex += 1;
        const key = 'lora' + loraIndex;
        graph[key] = {
            class_type: 'LoraLoaderModelOnly',
            inputs: {
                model: [userModelNode, 0],
                lora_name: name,
                strength_model: strength,
            },
        };
        userModelNode = key;
    }

    // Attention backend patch — mirrors Mix Studio's three mutually exclusive
    // options applied after the LoRA chain. SageAttention patches only the
    // guider; SLA patches both the guider and the scheduler model input.
    const attention = normalizeH3AttentionBackend(settings.attentionBackend);
    let patchedModelNode = userModelNode;
    if (attention === 'sageattention') {
        graph.sage_attention = {
            class_type: 'PathchSageAttentionKJ',
            inputs: {
                model: [userModelNode, 0],
                sage_attention: 'auto',
                allow_compile: false,
            },
        };
        patchedModelNode = 'sage_attention';
    } else if (attention === 'sla') {
        graph.sla_attention = {
            class_type: 'H3SLAAttention',
            inputs: {
                model: [userModelNode, 0],
                sparsity_ratio: 0.85,
                block_size: '64',
                min_seq_len: 8192,
                dense_last_steps: 0,
                protect_audio: true,
                enabled: true,
            },
        };
        patchedModelNode = 'sla_attention';
    }

    // Condition node: MiniMaxH3ImageToVideo handles both T2V and I2V (first frame).
    const conditionInputs = {
        clip: ['clip', 0],
        vae: ['video_vae', 0],
        prompt: String(prompt || ''),
        width: W,
        height: H,
        length: frames,
    };

    if (mode === 'i2va' && firstImageName) {
        graph.first_image = {
            class_type: 'LoadImage',
            inputs: { image: firstImageName },
        };
        conditionInputs.first_frame = ['first_image', 0];
    }

    graph.condition = {
        class_type: 'MiniMaxH3ImageToVideo',
        inputs: conditionInputs,
    };

    // Sampling branch. The guider always uses the attention-patched model
    // when one is active. The scheduler only uses the patch for SLA (sparse
    // attention must shape denoising), matching Mix Studio's wiring.
    const schedulerModelNode = attention === 'sla' ? patchedModelNode : userModelNode;
    graph.scheduler = {
        class_type: 'BasicScheduler',
        inputs: {
            model: [schedulerModelNode, 0],
            scheduler: 'simple',
            steps: H3_DEFAULT_STEPS,
            denoise: 1,
        },
    };

    graph.guider = {
        class_type: 'BasicGuider',
        inputs: {
            model: [patchedModelNode, 0],
            conditioning: ['condition', 0],
        },
    };

    graph.sample = {
        class_type: 'SamplerCustomAdvanced',
        inputs: {
            noise: ['noise', 0],
            guider: ['guider', 0],
            sampler: ['sampler_select', 0],
            sigmas: ['scheduler', 0],
            latent_image: ['condition', 1],
        },
    };

    // Decode video and audio.
    graph.decode = {
        class_type: 'VAEDecode',
        inputs: { samples: ['sample', 0], vae: ['video_vae', 0] },
    };

    graph.decode_audio = {
        class_type: 'VAEDecodeAudio',
        inputs: { samples: ['sample', 0], vae: ['audio_vae', 0] },
    };

    // Assemble video.
    graph.video = {
        class_type: 'CreateVideo',
        inputs: { images: ['decode', 0], audio: ['decode_audio', 0], fps: H3_FPS, crf: 8 },
    };

    graph.save = {
        class_type: 'SaveVideo',
        inputs: {
            video: ['video', 0],
            filename_prefix: 'not-so-jarvis/video',
            format: 'auto',
            codec: 'auto',
        },
    };

    return graph;
}

// Validate that ComfyUI knows the required H3 node classes.
async function validateH3Graph(info, graph) {
    const missingNodes = [];
    for (const node of Object.values(graph)) {
        if (!info[node.class_type]) missingNodes.push(node.class_type);
    }
    if (missingNodes.length) {
        const error = new Error(
            'ComfyUI is missing H3 custom node' + (missingNodes.length > 1 ? 's' : '') + ': ' +
            missingNodes.join(', ') + '. Install MiniMax H3 support in ComfyUI, then try again.'
        );
        error.code = 'comfyui_missing_nodes';
        error.missingNodes = missingNodes;
        throw error;
    }

    // Check CLIPLoader supports minimax type.
    const clipInfo = info.CLIPLoader;
    if (clipInfo && clipInfo.input && clipInfo.input.required && clipInfo.input.required.type) {
        const typeChoices = clipInfo.input.required.type[0];
        if (Array.isArray(typeChoices) && !typeChoices.includes('minimax')) {
            const error = new Error(
                'This ComfyUI build does not support the minimax CLIPLoader type for H3. ' +
                'Update ComfyUI or install MiniMax H3 nodes, then try again.'
            );
            error.code = 'comfyui_h3_clip_unsupported';
            throw error;
        }
    }
}

// --- Source image resolution (for I2VA) ---------------------------------------

function resolveVideoSourceImage(conversationId, explicitFilename) {
    if (explicitFilename) {
        const safeName = path.basename(String(explicitFilename || '').split('?')[0]);
        if (!safeName) return null;
        return { rawFilename: safeName };
    }
    if (!conversationId) return null;

    const conversationService = require('../server/conversation-service');
    const taskState = require('./task-state');
    const messages = conversationService.getMessages(conversationId) || [];
    const urlRe = /\/generated\/([^\s)\]}"']+)/g;
    let last = null;
    for (const m of messages) {
        if (!m || m.role !== 'assistant') continue;
        const content = String(m.content || '');
        let match;
        while ((match = urlRe.exec(content))) last = match[1];
    }
    if (!last) {
        const asset = taskState.getTask(conversationId).generatedAsset;
        if (asset) last = String(asset).split('/').pop();
    }
    if (!last) return null;
    const rawFilename = decodeURIComponent(last);
    // Only accept image files as source for I2VA.
    if (!/\.(?:png|jpg|jpeg|webp)$/i.test(rawFilename)) return null;
    return { rawFilename };
}

// Decide whether a video request is I2VA (uses a prior generated image as the
// first frame) or T2VA (text only). Requires BOTH image-referencing wording
// (from the intent classifier or the reference regex) AND an actually resolvable
// source image. Otherwise the request is plain T2VA. This must run before the
// H3 workflow is selected.
function resolveVideoMode(conversationId, message, structuredRequest) {
    const text = String(message || '');
    const refersToImage = Boolean(structuredRequest && structuredRequest.has_reference_image) ||
        I2V_REF_RE.test(text) ||
        // Regenerate-as-video ("generate the video again ...") while a prior
        // image exists: the last generated image is the intended first frame
        // even though "again" names no image explicitly.
        (/\bagain\b/i.test(text) && VIDEO_WORD_RE.test(text));
    if (!refersToImage) return { videoMode: 't2va', sourceImage: null };
    const sourceImage = resolveVideoSourceImage(conversationId);
    if (!sourceImage) return { videoMode: 't2va', sourceImage: null };
    return { videoMode: 'i2va', sourceImage };
}

// --- Video generation execution -----------------------------------------------

async function generateVideo(prompt, options = {}) {
    const queueOpts = {
        label: options.label || 'video generation',
        kind: options.kind || 'video_generation',
        conversationId: options.conversationId || null,
        onQueued: options.onQueued || null
    };
    return withGenerationLock(async () => {
        await ensureGeneratedDir();
        const startedAt = Date.now();

        const seed = Number.isInteger(options.seed) && options.seed >= 0
            ? options.seed
            : Math.floor(Math.random() * 2 ** 32);

        const settings = effectiveVideoSettings();
        const mode = options.mode || 't2va';
        const duration = h3DurationSeconds(settings.h3Duration || options.duration);
        const frames = h3FramesForSeconds(duration);

        let videoWidth = options.width || 1024;
        let videoHeight = options.height || 768;
        if (mode === 'i2va' && options.sourceImageRawFilename) {
            const imgPath = path.join(GENERATED_DIR, options.sourceImageRawFilename);
            const imgDims = readImageDimensions(imgPath);
            if (imgDims) {
                videoWidth = imgDims.width;
                videoHeight = imgDims.height;
                console.log('[video] source image aspect ratio:', imgDims.width + 'x' + imgDims.height,
                    '-> video dimensions:', videoWidth + 'x' + videoHeight);
            }
        }
        const { W, H } = h3Dimensions(videoWidth, videoHeight, settings.h3Size);

        // Prepend trigger words from active LoRAs to the prompt. For I2VA keep
        // the <Picture 1> first-frame alignment line as the literal first line of
        // the prompt (the H3 alignment contract), placing triggers after it.
        const cleanPrompt = stripVideoLoraTriggerWords(prompt);
        const triggerWords = (settings.loras || [])
            .filter((l) => l && l.on !== false && l.name && l.triggerWord)
            .map((l) => l.triggerWord);
        let finalPrompt = String(cleanPrompt || '');
        if (triggerWords.length) {
            const triggers = triggerWords.join(', ') + ', ';
            if (mode === 'i2va') {
                const nl = finalPrompt.indexOf('\n');
                if (nl !== -1) {
                    finalPrompt = finalPrompt.slice(0, nl + 1) + triggers + finalPrompt.slice(nl + 1);
                } else {
                    finalPrompt = triggers + finalPrompt;
                }
            } else {
                finalPrompt = triggers + finalPrompt;
            }
        }

        let firstImageName = null;
        if (mode === 'i2va' && options.sourceImageRawFilename) {
            // Upload source image to ComfyUI input for LoadImage node.
            const filePath = path.join(GENERATED_DIR, options.sourceImageRawFilename);
            if (fs.existsSync(filePath)) {
                const buffer = fs.readFileSync(filePath);
                const uploadName = 'jarvis_video_' + Date.now() + '_' + options.sourceImageRawFilename;
                const uploaded = await comfyui.uploadImage(buffer, uploadName);
                firstImageName = (uploaded && uploaded.name) || uploadName;
            }
        }

        const graph = buildH3Graph({
            prompt: finalPrompt,
            mode,
            W,
            H,
            frames,
            seed,
            settings,
            firstImageName,
        });

        const info = await comfyui.getObjectInfo();
        await validateH3Graph(info, graph);

        const pid = await comfyui.queuePrompt(graph);
        console.log('[video-generator] queued H3 workflow:', pid, '(' + mode + ', ' + duration + 's, ' + frames + 'f)');

        const timeoutMs = options.timeoutMs || 30 * 60 * 1000;  // 30 min for video
        const history = await comfyui.waitForPrompt(pid, { timeoutMs });

        // Find video output.
        const videoFiles = comfyui.findOutputFiles(history.outputs || {}, /\.(?:mp4|webm|avi|mov)$/i);
        if (!videoFiles.length) {
            const error = new Error('ComfyUI finished but produced no video file.');
            error.code = 'comfyui_output_not_found';
            throw error;
        }

        const entry = videoFiles[videoFiles.length - 1];
        const buffer = await comfyui.downloadImage(entry);  // same download logic works for video

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const extension = path.extname(entry.filename).toLowerCase() || '.mp4';
        const basename = safeFilename(buffer.toString('hex', 0, 4)) + '_vid_' + stamp + extension;
        const filePath = path.join(GENERATED_DIR, basename);
        fs.writeFileSync(filePath, buffer);

        console.log('[video-generator] saved video:', basename, '(' + buffer.length + ' bytes)');

        // Clean up ComfyUI output and uploaded input.
        await comfyui.deleteOutputFile(entry, { history: pid });
        if (firstImageName) {
            await comfyui.deleteInputFile(firstImageName).catch(() => {});
        }

        // Record metadata.
        const activeLoras = (settings.loras || [])
            .filter((l) => l && l.on !== false && l.name)
            .map((l) => ({ name: l.name, strength: Number(l.strength) || 0, triggerWord: l.triggerWord || '' }));
        const meta = generatedHistory.add({
            file: '/generated/' + encodeURIComponent(basename),
            rawFilename: basename,
            prompt: finalPrompt,
            model: 'MiniMax H3',
            width: W,
            height: H,
            loras: activeLoras,
            generationMs: Date.now() - startedAt,
            video: {
                duration: h3EffectiveDurationSeconds(duration),
                frames,
                fps: H3_FPS,
                mode,
                source: options.sourceImageRawFilename || null,
            }
        });

        return {
            url: meta.file,
            filename: basename,
            width: W,
            height: H,
            duration: h3EffectiveDurationSeconds(duration),
            frames,
            fps: H3_FPS,
            mode,
            prompt: finalPrompt,
            generationMs: meta.generationMs,
            meta
        };
    }, queueOpts);
}

// --- Video Upscale --------------------------------------------------------------
//
// Two engines, adapted from Mix Studio's buildExistingVideoUpscale
// (server.js) + upscale-workflows.js:
//   rtx     — fast single-pass RTXVideoSuperResolution (scale multiplier,
//             default 2x). The default, matching Mix Studio.
//   seedvr2 — slow diffusion DiT quality path (SeedVR2VideoUpscaler at the
//             target short-side resolution, batch 5 / overlap 2).
// Manual-only: runs when the user asks ("upscale this video") or via
// POST /api/video/upscale.

const VIDEO_UPSCALE_DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 60 min for upscale

function seedVr2VideoUpscaleDitInputs(settings) {
    const model = settings.seedvr2Dit || imageGenerator.DEFAULT_SEEDVR2_DIT;
    const vendor = String(settings.gpuVendor || '').toLowerCase();
    const isSevenB = /(?:^|[_-])7b(?:[_-]|$)/i.test(model);
    const attention = String(settings.seedvr2Attention || imageGenerator.DEFAULT_SEEDVR2_ATTENTION);
    const nvidiaOnly = new Set(['sageattn_2', 'sageattn_3', 'flash_attn_2', 'flash_attn_3']);
    let attentionMode = attention;
    if (vendor && vendor !== 'nvidia' && nvidiaOnly.has(attention)) {
        attentionMode = 'sdpa';
    }
    return {
        model,
        device: 'cuda:0',
        blocks_to_swap: isSevenB ? 32 : 0,
        swap_io_components: true,
        offload_device: 'cpu',
        cache_model: false,
        attention_mode: attentionMode
    };
}

function seedVr2VideoUpscaleNoiseLevel(requested) {
    return Object.prototype.hasOwnProperty.call(VIDEO_UPSCALE_NOISE_LEVELS, requested) ? requested : 'low';
}

function seedVr2VideoUpscaleProfile(settings, requestedProfile, requestedNoise) {
    const noise = seedVr2VideoUpscaleNoiseLevel(requestedNoise);
    const balanced = {
        key: 'balanced',
        ditModel: settings.seedvr2Dit || imageGenerator.DEFAULT_SEEDVR2_DIT,
        colorCorrection: 'lab',
        noise,
        inputNoiseScale: VIDEO_UPSCALE_NOISE_LEVELS[noise]
    };
    const sharpDit = 'seedvr2_ema_7b_sharp_fp8_e4m3fn_mixed_block35_fp16.safetensors';
    const availableModels = installedSeedVr2ModelsSync();
    const hasSharp = availableModels.includes(sharpDit);
    if (requestedProfile === 'sharp' && hasSharp) {
        return {
            key: 'sharp',
            ditModel: sharpDit,
            colorCorrection: 'wavelet',
            noise,
            inputNoiseScale: VIDEO_UPSCALE_NOISE_LEVELS[noise]
        };
    }
    return balanced;
}

function installedSeedVr2ModelsSync() {
    const models = new Set();
    const dirs = [];
    for (const value of [process.env.KREA2_SEEDVR2_DIR, process.env.COMFYUI_SEEDVR2_DIR]) {
        if (value) dirs.push(path.resolve(value));
    }
    try {
        const modelRoot = require('./comfyui').resolveModelRoot ? null : null;
    } catch {}
    // Fallback to common locations
    const commonDirs = [
        path.join(__dirname, '..', '..', 'ComfyUI', 'models', 'seedvr2'),
        path.join(__dirname, '..', '..', 'ComfyUI', 'models', 'SEEDVR2'),
        path.join(process.env.APPDATA || '', 'ComfyUI', 'models', 'seedvr2'),
        path.join(process.env.APPDATA || '', 'ComfyUI', 'models', 'SEEDVR2'),
        path.join(process.env.USERPROFILE || '', 'ComfyUI', 'models', 'seedvr2'),
        path.join(process.env.USERPROFILE || '', 'ComfyUI', 'models', 'SEEDVR2'),
    ];
    for (const d of commonDirs) {
        if (fs.existsSync(d)) dirs.push(d);
    }
    for (const dir of dirs) {
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

function buildSeedVr2VideoUpscaleGraph(videoName, options = {}) {
    // Shared upscale tuning comes from the single global upscale settings
    // (imageGeneration); per-call options (API overrides) win when present.
    const settings = Object.assign({}, imageGenerator.getDefaults(), options.settings || {});
    const profile = seedVr2VideoUpscaleProfile(settings, options.profile || 'sharp', options.noise || 'low');
    const seed = Number.isInteger(options.seed) && options.seed >= 0 ? options.seed : Math.floor(Math.random() * 2 ** 31);
    const resolution = clampNumber(options.resolution, 512, 8192, 2160);
    const preScale = clampNumber(options.preScale, 1, 4, 1);
    // Preserve the source frame rate (Mix Studio passes the source fps through
    // both VHS_LoadVideo and CreateVideo); fall back to the H3 render rate.
    const fps = Number(options.fps) > 0 ? Number(options.fps) : H3_FPS;
    const hasAudio = options.hasAudio !== false;
    const savePrefix = String(options.savePrefix || 'not-so-jarvis/video_upscale_seedvr2');

    const graph = {};
    graph.src = { class_type: 'VHS_LoadVideo', inputs: {
        video: videoName,
        force_rate: fps,
        custom_width: 0,
        custom_height: 0,
        frame_load_cap: 0,
        skip_first_frames: 0,
        select_every_nth: 1,
        format: 'None'
    }};
    let frameSource = ['src', 0];

    if (preScale !== 1) {
        graph.prescale = {
            class_type: 'VideoScaleBy',
            inputs: { video: frameSource, upscale_method: 'lanczos', scale_by: preScale }
        };
        frameSource = ['prescale', 0];
    }

    graph.dit = {
        class_type: 'SeedVR2LoadDiTModel',
        inputs: seedVr2VideoUpscaleDitInputs(Object.assign({}, settings, {
            seedvr2Dit: profile.ditModel
        }))
    };
    graph.svvae = {
        class_type: 'SeedVR2LoadVAEModel',
        inputs: {
            model: settings.seedvr2Vae || imageGenerator.DEFAULT_SEEDVR2_VAE,
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
            image: frameSource,
            dit: ['dit', 0],
            vae: ['svvae', 0],
            seed,
            resolution,
            max_resolution: 0,
            batch_size: 5,
            uniform_batch_size: true,
            color_correction: profile.colorCorrection,
            temporal_overlap: 2,
            prepend_frames: 0,
            input_noise_scale: profile.inputNoiseScale,
            latent_noise_scale: 0,
            offload_device: 'cpu',
            enable_debug: false
        }
    };

    const videoInputs = { images: ['upscale', 0], fps };
    if (hasAudio) videoInputs.audio = ['src', 2];
    graph.video = { class_type: 'CreateVideo', inputs: videoInputs };
    graph.save = { class_type: 'SaveVideo', inputs: { video: ['video', 0], filename_prefix: savePrefix, format: 'auto', codec: 'auto' } };

    return { graph, profile };
}

// Fast single-pass video upscale, adapted from Mix Studio's
// rtxVideoSuperResolutionNode (lib/upscale-workflows.js) as used by
// buildExistingVideoUpscale: VHS_LoadVideo -> RTXVideoSuperResolution
// (scale by multiplier) -> CreateVideo -> SaveVideo. No DiT/VAE models, no
// diffusion — roughly two orders of magnitude faster than SeedVR2.
function buildRtxVideoUpscaleGraph(videoName, options = {}) {
    const scale = normalizeVideoUpscaleScale(options.scale, 2);
    const quality = normalizeRtxQuality(options.quality, 'ULTRA');
    const fps = Number(options.fps) > 0 ? Number(options.fps) : H3_FPS;
    const hasAudio = options.hasAudio !== false;
    const savePrefix = String(options.savePrefix || 'not-so-jarvis/video_upscale_rtx');

    const graph = {};
    graph.src = { class_type: 'VHS_LoadVideo', inputs: {
        video: videoName,
        force_rate: fps,
        custom_width: 0,
        custom_height: 0,
        frame_load_cap: 0,
        skip_first_frames: 0,
        select_every_nth: 1,
        format: 'None'
    }};
    graph.vsr = {
        class_type: 'RTXVideoSuperResolution',
        inputs: {
            images: ['src', 0],
            resize_type: 'scale by multiplier',
            'resize_type.scale': scale,
            quality
        }
    };

    const videoInputs = { images: ['vsr', 0], fps };
    if (hasAudio) videoInputs.audio = ['src', 2];
    graph.video = { class_type: 'CreateVideo', inputs: videoInputs };
    graph.save = { class_type: 'SaveVideo', inputs: { video: ['video', 0], filename_prefix: savePrefix, format: 'auto', codec: 'auto' } };

    return { graph, scale, quality };
}

async function upscaleVideo(rawFilename, options = {}) {
    const queueOpts = {
        label: options.label || 'video upscale',
        kind: options.kind || 'video_upscale',
        conversationId: options.conversationId || null,
        onQueued: options.onQueued || null
    };
    return withGenerationLock(async () => {
        await ensureGeneratedDir();
        const startedAt = Date.now();

        const safeName = path.basename(String(rawFilename || ''));
        if (!safeName) {
            const error = new Error('No source video specified.');
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

        // One shared upscale configuration for image and video alike.
        // Videos run SeedVR2 or RTX (Mix Studio normalization: only an
        // explicit SeedVR2 choice selects the slow diffusion path, everything
        // else — including the image-only Ultimate SD engine — uses fast RTX).
        const upscale = sharedUpscaleSettings();
        const engine = normalizeVideoUpscaleEngine(
            options.engine !== undefined && options.engine !== null && options.engine !== ''
                ? options.engine
                : upscale.upscaleEngine
        );

        const sourceMeta = generatedHistory.list().find((e) => e.rawFilename === safeName);
        const sourceFps = sourceMeta && sourceMeta.video && Number(sourceMeta.video.fps) > 0
            ? Number(sourceMeta.video.fps)
            : H3_FPS;
        const fps = Number(options.fps) > 0 ? Number(options.fps) : sourceFps;
        const seed = Math.floor(Math.random() * 2 ** 32);

        const isSeedVr2 = engine === 'seedvr2';
        const resolution = isSeedVr2
            ? clampNumber(options.resolution || upscale.upscaleResolution, 512, 8192, 2160)
            : null;
        const profile = isSeedVr2 ? (options.profile || upscale.upscaleProfile || 'sharp') : null;
        const noise = isSeedVr2 ? (options.noise || upscale.upscaleNoise || 'low') : null;
        const preScale = isSeedVr2 ? (options.preScale || upscale.upscalePreScale || 1) : 1;
        const scale = !isSeedVr2
            ? normalizeVideoUpscaleScale(
                options.scale !== undefined && options.scale !== null && options.scale !== ''
                    ? options.scale
                    : upscale.upscaleMultiplier, 2)
            : null;
        const quality = !isSeedVr2 ? normalizeRtxQuality(options.quality, 'ULTRA') : null;

        // Upload source video to ComfyUI input for VHS_LoadVideo node.
        const uploadName = 'jarvis_video_upscale_' + Date.now() + '_' + safeName;
        const uploaded = await comfyui.uploadImage(buffer, uploadName); // uploadImage works for video too
        const loadName = (uploaded && uploaded.name) || uploadName;

        let graph;
        let basename;
        let effectiveProfile = null;
        let effectiveScale = null;
        let effectiveQuality = null;
        try {
            if (isSeedVr2) {
                const built = buildSeedVr2VideoUpscaleGraph(loadName, {
                    settings: upscale,
                    profile,
                    noise,
                    resolution,
                    preScale,
                    seed,
                    fps,
                    hasAudio: true
                });
                graph = built.graph;
                effectiveProfile = built.profile;
            } else {
                const built = buildRtxVideoUpscaleGraph(loadName, {
                    scale,
                    quality,
                    fps,
                    hasAudio: true
                });
                graph = built.graph;
                effectiveScale = built.scale;
                effectiveQuality = built.quality;
            }

            const info = await comfyui.getObjectInfo();
            if (!isSeedVr2 && !info.RTXVideoSuperResolution) {
                const error = new Error(
                    'RTX video upscale needs the RTX Video Super Resolution node. ' +
                    'Install the ComfyUI-RTXVideoSuperResolution custom node, then try again.'
                );
                error.code = 'rtx_video_upscale_setup_required';
                throw error;
            }
            await validateH3Graph(info, graph);

            const pid = await comfyui.queuePrompt(graph);
            console.log('[video-generator] queued video upscale (' + engine + ') workflow:', pid);

            const timeoutMs = options.timeoutMs || VIDEO_UPSCALE_DEFAULT_TIMEOUT_MS;
            const history = await comfyui.waitForPrompt(pid, { timeoutMs });

            const videoFiles = comfyui.findOutputFiles(history.outputs || {}, /\.(?:mp4|webm|avi|mov)$/i);
            if (!videoFiles.length) {
                const error = new Error('ComfyUI finished but produced no upscaled video file.');
                error.code = 'comfyui_output_not_found';
                throw error;
            }

            const entry = videoFiles[videoFiles.length - 1];
            const outBuffer = await comfyui.downloadImage(entry);

            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const extension = path.extname(entry.filename).toLowerCase() || '.mp4';
            basename = safeFilename(outBuffer.toString('hex', 0, 4)) + '_up_' + stamp + extension;
            fs.writeFileSync(path.join(GENERATED_DIR, basename), outBuffer);
            console.log('[video-generator] saved upscaled video:', basename, '(' + outBuffer.length + ' bytes)');

            await comfyui.deleteOutputFile(entry, { history: pid });
        } finally {
            await comfyui.deleteInputFile(loadName).catch(() => {});
        }

        const meta = generatedHistory.add({
            file: '/generated/' + encodeURIComponent(basename),
            rawFilename: basename,
            prompt: (sourceMeta && sourceMeta.prompt) || 'Upscaled video',
            model: isSeedVr2 ? 'SeedVR2 Video Upscale' : 'RTX Video Super Resolution',
            width: 0, // Video dimensions not easily readable without ffprobe
            height: 0,
            generationMs: Date.now() - startedAt,
            upscale: {
                engine,
                profile: effectiveProfile ? effectiveProfile.key : null,
                noise: effectiveProfile ? effectiveProfile.noise : null,
                resolution,
                scale: effectiveScale,
                quality: effectiveQuality,
                fps,
                source: safeName
            },
            video: {
                upscaled: true,
                source: safeName
            }
        });

        return {
            url: meta.file,
            filename: basename,
            engine,
            profile: effectiveProfile ? effectiveProfile.key : null,
            noise: effectiveProfile ? effectiveProfile.noise : null,
            resolution,
            scale: effectiveScale,
            quality: effectiveQuality,
            fps,
            source: safeName,
            sourceMeta,
            generationMs: meta.generationMs,
            meta
        };
    }, queueOpts);
}

// --- Helpers ------------------------------------------------------------------

function stripVideoLoraTriggerWords(prompt) {
    const text = String(prompt || '').trim();
    if (!text) return text;
    const settings = effectiveVideoSettings();
    const triggerWords = (settings.loras || [])
        .filter((l) => l && l.on !== false && l.name && l.triggerWord && String(l.triggerWord).trim())
        .map((l) => String(l.triggerWord).trim());
    if (!triggerWords.length) return text;
    const prefix = triggerWords.join(', ') + ', ';
    let stripped = text;
    while (stripped.startsWith(prefix)) {
        stripped = stripped.slice(prefix.length).trim();
    }
    return stripped || text;
}

function ensureGeneratedDir() {
    if (!fs.existsSync(GENERATED_DIR)) {
        fs.mkdirSync(GENERATED_DIR, { recursive: true });
    }
}

function safeFilename(name) {
    return String(name || 'x').replace(/[^a-z0-9._-]/gi, '_').replace(/_+/g, '_').slice(0, 100) || 'x';
}

// --- Exports ------------------------------------------------------------------

module.exports = {
    H3_FPS,
    H3_MIN_SECONDS,
    H3_MAX_SECONDS,
    H3_DEFAULTS,
    H3_CONFIGURABLE_KEYS,
    H3_DEFAULT_STEPS,
    H3_ATTENTION_BACKENDS,
    normalizeH3AttentionBackend,
    canStartGeneration,
    registerGenerationLock,
    detectVideoIntent,
    detectVideoUpscaleIntent,
    buildH3VideoPrompt,
    modifyH3VideoPrompt,
    buildH3Graph,
    validateH3Graph,
    h3DurationSeconds,
    h3FramesForSeconds,
    h3EffectiveDurationSeconds,
    h3Dimensions,
    h3SizeScale,
    H3_SIZE_SCALES,
    H3_IMAGE_SIZES,
    effectiveVideoSettings,
    getVideoDefaults,
    saveVideoSettings,
    getVideoModelChoices,
    generateVideo,
    upscaleVideo,
    sharedUpscaleSettings,
    SHARED_UPSCALE_KEYS,
    LEGACY_VIDEO_UPSCALE_MAP,
    buildSeedVr2VideoUpscaleGraph,
    resolveVideoSourceImage,
    resolveVideoMode,
    stripVideoLoraTriggerWords,
    VIDEO_SIGNAL_RE,
    VIDEO_WORD_RE,
    I2V_REF_RE,
    isStillImageOnlyChange,
    VIDEO_UPSCALE_RESOLUTIONS,
    VIDEO_UPSCALE_SCALES,
    VIDEO_UPSCALE_PROFILES,
    VIDEO_UPSCALE_NOISE_LEVELS,
    VIDEO_UPSCALE_ENGINES,
    VIDEO_UPSCALE_DEFAULT_ENGINE,
    VIDEO_UPSCALE_RTX_QUALITIES,
    normalizeVideoUpscaleEngine,
    normalizeVideoUpscaleScale,
    normalizeRtxQuality,
    buildRtxVideoUpscaleGraph,
    VIDEO_UPSCALE_DEFAULT_TIMEOUT_MS,
};
