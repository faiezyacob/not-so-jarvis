/* ============================================
   JARVIS — Video Character Replacement
   A dedicated workflow adapter that edits an
   EXISTING video by replacing the person/people in
   it with identities supplied as image references,
   using MiniMax H3's native reference-to-video node
   (`MiniMaxH3ReferenceToVideo`).

   This is deliberately separate from the ordinary
   H3 I2V/T2V pipeline and from Creator Studio / UGC
   Studio / the Director: those are untouched. This
   adapter only runs when the user references a
   source video AND replacement image(s) in one
   natural-language instruction inside chat.

   The source video is the scene/motion reference; the
   replacement images are identity references. H3
   never receives a first frame here — it receives a
   decoded source video plus image references, so
   motion, camera and timing are inherited from the
   real footage instead of being re-invented.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const comfyui = require('./comfyui');
const generatedHistory = require('./generated-history');
const generationQueue = require('./generation-queue');
const videoGenerator = require('./video-generator');

const H3_FPS = videoGenerator.H3_FPS || 24;
const REPLACEMENT_NODE = 'MiniMaxH3ReferenceToVideo';
const SOURCE_VIDEO_NODE = 'VHS_LoadVideo';
const REQUIRED_NODES = [REPLACEMENT_NODE, SOURCE_VIDEO_NODE];
const DEFAULT_REF_UNET = 'minimax_h3_ref2va_pruned_int8_convrot.safetensors';

const DATA_DIR = path.join(__dirname, '..', 'data');
const GENERATED_DIR = process.env.GENERATED_DIR || path.join(DATA_DIR, 'generated');

const VIDEO_EXT_RE = /\.(?:mp4|webm|mov|m4v|avi|mkv)$/i;

// How the user asks to swap people. Deliberately verb-led so ordinary video
// generation ("make a video of...") is never captured. Covers the natural
// phrasings: replace/swap/switch X with/for Y, "put X in", "use X in".
const REPLACEMENT_VERB_RE = /\b(?:replace|replacing|swap|swapping|switch|switching|substitute|substituting)\b|\bput\b[^.]{0,60}?\b(?:in|into|from)\b|\buse\b[^.]{0,60}?\b(?:in|into|inside)\b/i;
// Motion transfer: "make @image3 perform the same action as the person in
// @video1" is a single-identity replacement with the source providing motion.
const MOTION_TRANSFER_RE = /\b(?:perform\s+the\s+same|same\s+(?:action|movement|motion|gestures?)|do\s+what)\b/i;
// The replacement must target a person/identity (not a background/object),
// unless an explicit @video/@image reference makes the intent concrete.
const PERSON_WORD_RE = /\b(?:person|people|man|woman|guy|girl|character|characters|face|faces|identity|identities|someone|body|bodies|woman's|man's|their)\b/i;
// A request that is explicitly about editing an existing clip rather than
// generating a new one.
const SOURCE_VIDEO_WORD_RE = /\b(?:source\s+video|original\s+video|this\s+video|the\s+video|existing\s+video|@video|video\s*\d+)\b/i;

// Explicit ordering / mapping cues that make multi-image→multi-person
// assignment unambiguous.
const MAPPING_CUE_RE = /\b(?:respectively|in\s+that\s+order|in\s+the\s+same\s+order|first|second|third|1st|2nd|3rd|left|right|->|=>|→|to\s+the\s+(?:man|woman|person|guy|girl))\b/i;

const REFERENCE_TOKEN_RE = /@image\s*\d+\b|@video\s*\d+\b/gi;

function clampToRange(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, num));
}

function safeFilename(name) {
    return String(name || 'x').replace(/[^a-z0-9._-]/gi, '_').replace(/_+/g, '_').slice(0, 100) || 'x';
}

function ensureGeneratedDir() {
    if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

function isVideoFilename(name) {
    return VIDEO_EXT_RE.test(String(name || ''));
}

// --- Intent detection ---------------------------------------------------------

// Conservative detector: a replacement verb is required, and the request must
// be about an existing/source video. Missing pieces are reported so the server
// can ask a concise follow-up instead of guessing.
function detectReferenceReplacement(message, options = {}) {
    const text = String(message || '');
    const hasVideoReference = options.hasVideoReference === true ||
        /\b@video\s*\d+\b/i.test(text) || /\bvideo\s*\d+\b/i.test(text);
    const hasImageReference = options.hasImageReference === true ||
        /\b@image\s*\d+\b/i.test(text) || /\bimage\s*\d+\b/i.test(text);
    const replacementCue = REPLACEMENT_VERB_RE.test(text) || MOTION_TRANSFER_RE.test(text);
    const sourceVideoCue = SOURCE_VIDEO_WORD_RE.test(text);
    const personCue = PERSON_WORD_RE.test(text);
    const detected = replacementCue && (hasVideoReference || sourceVideoCue) && (personCue || hasVideoReference || hasImageReference);
    return {
        detected,
        hasVideoReference,
        hasImageReference,
        needsVideo: detected && !hasVideoReference,
        needsImages: detected && !hasImageReference
    };
}

// --- Plan construction --------------------------------------------------------

// Build the structured replacement plan from already-resolved assets. Returns
// { ok:true, plan } or { ok:false, error, code } — the ambiguity result also
// carries the (candidate) `plan` and `ambiguous:true` so the UI can confirm the
// assumed in-order mapping in one click. `assumeOrder` skips the ambiguity gate
// (used after the user confirms).
function buildPlanObject(options = {}) {
    const message = String(options.message || '');
    const replacements = Array.isArray(options.replacements) ? options.replacements.filter(Boolean) : [];
    const preserve = {
        motion: !/\b(?:change|alter)\s+(?:the\s+)?(?:action|motion|movement)\b/i.test(message),
        background: !/\b(?:change|alter|replace)\s+(?:the\s+)?(?:background|scene)\b/i.test(message),
        camera: !/\b(?:change|alter)\s+(?:the\s+)?(?:camera|framing)\b/i.test(message),
        timing: !/\b(?:change|alter)\s+(?:the\s+)?(?:timing|pacing|duration)\b/i.test(message),
        clothing: !/\b(?:change|alter|new)\s+(?:her\s+|his\s+|their\s+|the\s+)?(?:clothes|clothing|outfit|wardrobe)\b/i.test(message)
    };
    const additionalInstructions = message
        .replace(REFERENCE_TOKEN_RE, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[\[[^\]]*\]\]/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/\s+([.,;!?])/g, '$1')
        .trim();
    return {
        intent: 'video_character_replacement',
        sourceVideo: options.sourceVideo || null,
        replacements,
        targetMapping: [],
        preserve,
        additionalInstructions,
        requestedDuration: options.requestedDuration || null,
        assumedOrder: replacements.length > 1 && !MAPPING_CUE_RE.test(message)
    };
}

function buildReplacementPlan(options = {}) {
    const plan = buildPlanObject(options);
    if (!plan.sourceVideo) {
        return {
            ok: false,
            code: 'replacement_source_video_missing',
            error: 'I need the source video to edit. Reference the clip with @video1 (or generate one first), then ask me to replace the people in it.'
        };
    }
    if (!plan.replacements.length) {
        return {
            ok: false,
            code: 'replacement_images_missing',
            error: 'I need at least one replacement image. Reference who should appear with @image1 (an uploaded image or one generated earlier), then try again.'
        };
    }
    if (plan.assumedOrder && options.assumeOrder !== true) {
        return {
            ok: false,
            code: 'replacement_mapping_ambiguous',
            error: 'Both replacement images are ready, but I need to confirm who replaces whom.',
            ambiguous: true,
            plan
        };
    }
    return { ok: true, plan };
}

// Strip the resolved absPath and round-trip only what the client needs to show
// the mapping; the server re-resolves every filename against the conversation
// registry when the user confirms.
function serializePlanAsset(asset) {
    if (!asset || !asset.filename) return null;
    const origin = asset.origin === 'upload' ? 'upload' : 'generated';
    return {
        filename: asset.filename,
        origin,
        url: asset.url || ('/' + (origin === 'upload' ? 'images' : 'generated') + '/' + encodeURIComponent(asset.filename))
    };
}

function serializeReplacementPlan(plan) {
    if (!plan) return null;
    return {
        sourceVideo: serializePlanAsset(plan.sourceVideo),
        replacements: (plan.replacements || []).map(serializePlanAsset).filter(Boolean),
        preserve: plan.preserve || {},
        additionalInstructions: plan.additionalInstructions || '',
        requestedDuration: plan.requestedDuration || null,
        ambiguous: Boolean(plan.assumedOrder)
    };
}

// --- Prompt construction ------------------------------------------------------

// Deterministic H3 reference prompt. Uses the node's reference token syntax
// (`<Video N>` / `<Picture N>`) plus explicit natural-language direction, so
// the instruction survives whether or not the tokens are honoured.
function buildReplacementPrompt(plan) {
    const replacements = plan.replacements || [];
    const preserve = plan.preserve || {};

    const lines = ['[Shot 1]'];
    lines.push('<Video 1> is the source video: reproduce its scene, actions, gestures, body movement, camera motion, framing and timing.');
    replacements.forEach((ref, i) => {
        lines.push('<Picture ' + (i + 1) + '> is the replacement identity for target person ' + (i + 1) + '.');
    });
    lines.push('');

    const subject = replacements.length === 1 ? 'person' : 'people';
    let body = 'Use the source video as the reference for the original scene, actions, movement, camera motion, framing, timing and background. ';
    body += 'Replace the selected ' + subject + ' with the individual' + (replacements.length === 1 ? '' : 's') +
        ' shown in the supplied reference image' + (replacements.length === 1 ? '' : 's') +
        ', matching each reference image to the intended person in the order given. ';
    body += 'Preserve each replacement person\'s recognizable identity, facial features, hairstyle and natural body proportions throughout the video. ';
    body += 'Follow the original people\'s actions, gestures, positions and interactions as closely as possible. ';
    if (preserve.background !== false) body += 'Preserve the background, ';
    if (preserve.camera !== false) body += 'camera movement, ';
    body += 'lighting and non-target people. ';
    body += preserve.clothing === false
        ? 'Change the clothing as requested. '
        : 'Keep the original clothing unless the user requests a change. ';
    body += 'Maintain temporal consistency and natural integration into the scene. ';
    body += 'Do not introduce additional people, duplicate limbs, unrelated objects or unnecessary scene changes.';
    lines.push(body);

    if (plan.additionalInstructions) {
        lines.push('');
        lines.push('Additional instruction: ' + plan.additionalInstructions);
    }
    return lines.join('\n');
}

// --- Video probing (duration + audio presence, no dependencies) ---------------

function probeDurationBuffer(buf, ext) {
    const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
    if (buffer.length < 16) return null;

    // ISO BMFF (MP4/MOV): the mvhd box carries timescale + duration.
    const mvhd = buffer.indexOf('mvhd');
    if (mvhd !== -1 && mvhd + 32 <= buffer.length) {
        const version = buffer[mvhd + 4];
        if (version === 0) {
            const timescale = buffer.readUInt32BE(mvhd + 16);
            const duration = buffer.readUInt32BE(mvhd + 20);
            if (timescale > 0 && duration > 0) return duration / timescale;
        } else if (version === 1 && mvhd + 36 <= buffer.length) {
            const timescale = buffer.readUInt32BE(mvhd + 24);
            const duration = Number(buffer.readBigUInt64BE(mvhd + 28));
            if (timescale > 0 && duration > 0) return duration / timescale;
        }
    }

    // WebM: the Segment/Info Duration element (0x44 0x89, float seconds).
    const webm = buffer.indexOf(Buffer.from([0x44, 0x89]));
    if (webm !== -1) {
        let pos = webm + 2;
        const first = buffer[pos];
        if (first) {
            let len = 1;
            let mask = 0x80;
            while (len <= 8 && !(first & mask)) { len += 1; mask >>= 1; }
            const size = first & (mask - 1);
            const valuePos = pos + len;
            if ((size === 4 || size === 8) && valuePos + size <= buffer.length) {
                return size === 4 ? buffer.readFloatBE(valuePos) : buffer.readDoubleBE(valuePos);
            }
        }
    }
    return null;
}

function probeVideoDuration(filePath) {
    try {
        return probeDurationBuffer(fs.readFileSync(filePath), path.extname(String(filePath)));
    } catch (_) {
        return null;
    }
}

// Best-effort audio-track detection so the source soundtrack can condition the
// reference node when it exists and is skipped when it does not.
function hasLikelyAudioTrack(buf) {
    const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
    if (!buffer.length) return false;
    const ascii = buffer.toString('latin1');
    if (/mp4a|soun|\.aac|aac\s/.test(ascii)) return true;
    if (/A_OPUS|A_VORBIS|A_AAC|A_FLAC|A_MPEG/.test(ascii)) return true;
    if (/auds/.test(ascii)) return true;
    return false;
}

// --- Reference model resolution -----------------------------------------------

function refUnetCandidates(info) {
    const required = info && info.UNETLoader && info.UNETLoader.input &&
        info.UNETLoader.input.required && info.UNETLoader.input.required.unet_name;
    const list = Array.isArray(required) && Array.isArray(required[0]) ? required[0] : [];
    return list.filter((name) => /ref2va/i.test(String(name || '')));
}

function resolveRefUnet(info, settings) {
    const override = process.env.H3_REF_UNET || (settings && settings.h3RefUnet) || '';
    if (override) return override;
    const candidates = refUnetCandidates(info);
    return candidates[0] || null;
}

// --- Graph construction -------------------------------------------------------

function buildReplacementGraph(opts = {}) {
    const {
        prompt,
        W = 1280,
        H = 720,
        frames = 124,
        seed = 0,
        settings = {},
        refImageNames = [],
        refVideoName = null,
        refVideoHasAudio = false,
        firstBlockCacheInputs = null
    } = opts;

    const graph = {};
    graph.model = {
        class_type: 'UNETLoader',
        inputs: {
            unet_name: settings.h3RefUnet || DEFAULT_REF_UNET,
            weight_dtype: 'default'
        }
    };
    graph.clip = {
        class_type: 'CLIPLoader',
        inputs: {
            clip_name: settings.h3Clip || videoGenerator.H3_DEFAULTS.h3Clip,
            type: 'minimax',
            device: 'default'
        }
    };
    graph.video_vae = {
        class_type: 'VAELoader',
        inputs: { vae_name: settings.h3VideoVae || videoGenerator.H3_DEFAULTS.h3VideoVae }
    };
    graph.audio_vae = {
        class_type: 'VAELoader',
        inputs: { vae_name: settings.h3AudioVae || videoGenerator.H3_DEFAULTS.h3AudioVae }
    };
    graph.noise = {
        class_type: 'RandomNoise',
        inputs: { noise_seed: seed }
    };
    // Turbo is intentionally NOT applied here: the reference pipeline runs on
    // the Ref2VA base with the stock sampler/scheduler, which is the verified
    // configuration for reference conditioning.
    graph.sampler_select = {
        class_type: 'KSamplerSelect',
        inputs: { sampler_name: 'res_multistep' }
    };

    // Model optimization stack: First Block Cache -> user LoRAs -> attention.
    const cachedModelNode = videoGenerator.appendFirstBlockCache(graph, 'model', settings, firstBlockCacheInputs);
    const userModelNode = videoGenerator.appendLoraChain(graph, cachedModelNode, settings.loras);
    const attention = videoGenerator.normalizeH3AttentionBackend(settings.attentionBackend);
    const patchedModelNode = videoGenerator.applyAttentionPatch(graph, userModelNode, attention);
    const schedulerModelNode = attention === 'sla' ? patchedModelNode : userModelNode;

    // Decoded source video (frames at 24 fps, capped to the generation length).
    if (refVideoName) {
        graph.ref_video = {
            class_type: SOURCE_VIDEO_NODE,
            inputs: {
                video: refVideoName,
                force_rate: H3_FPS,
                custom_width: 0,
                custom_height: 0,
                frame_load_cap: frames,
                skip_first_frames: 0,
                select_every_nth: 1,
                format: 'None'
            }
        };
    }

    // Replacement identity images.
    const conditionInputs = {
        clip: ['clip', 0],
        vae: ['video_vae', 0],
        audio_vae: ['audio_vae', 0],
        prompt: String(prompt || ''),
        width: W,
        height: H,
        length: frames,
        ref_image_size: 'match'
    };
    refImageNames.forEach((name, index) => {
        const nodeId = 'ref_image_' + index;
        graph[nodeId] = { class_type: 'LoadImage', inputs: { image: name } };
        conditionInputs['ref_images.ref_image_' + index] = [nodeId, 0];
    });
    if (refVideoName) {
        conditionInputs['ref_videos.ref_video_0'] = ['ref_video', 0];
        if (refVideoHasAudio) {
            conditionInputs['ref_video_audios.ref_video_audio_0'] = ['ref_video', 2];
        }
    }
    graph.reference = { class_type: REPLACEMENT_NODE, inputs: conditionInputs };

    const steps = videoGenerator.normalizeH3Steps(settings.h3Steps, videoGenerator.H3_DEFAULT_STEPS);
    graph.scheduler = {
        class_type: 'BasicScheduler',
        inputs: { model: [schedulerModelNode, 0], scheduler: 'simple', steps, denoise: 1 }
    };
    graph.guider = {
        class_type: 'BasicGuider',
        inputs: { model: [patchedModelNode, 0], conditioning: ['reference', 0] }
    };
    graph.sample = {
        class_type: 'SamplerCustomAdvanced',
        inputs: {
            noise: ['noise', 0],
            guider: ['guider', 0],
            sampler: ['sampler_select', 0],
            sigmas: ['scheduler', 0],
            latent_image: ['reference', 1]
        }
    };
    graph.decode = {
        class_type: 'VAEDecode',
        inputs: { samples: ['sample', 0], vae: ['video_vae', 0] }
    };
    graph.decode_audio = {
        class_type: 'VAEDecodeAudio',
        inputs: { samples: ['sample', 0], vae: ['audio_vae', 0] }
    };
    graph.video = {
        class_type: 'CreateVideo',
        inputs: { images: ['decode', 0], audio: ['decode_audio', 0], fps: H3_FPS, crf: 8 }
    };
    graph.save = {
        class_type: 'SaveVideo',
        inputs: {
            video: ['video', 0],
            filename_prefix: 'not-so-jarvis/replace',
            format: 'auto',
            codec: 'auto'
        }
    };
    return graph;
}

async function validateReplacementGraph(info, graph) {
    if (!info || typeof info !== 'object') {
        const error = new Error('ComfyUI did not report its available nodes.');
        error.code = 'comfyui_unavailable';
        throw error;
    }
    for (const node of REQUIRED_NODES) {
        if (!Object.prototype.hasOwnProperty.call(info, node)) {
            const error = new Error(
                'This ComfyUI build does not provide the "' + node + '" node, so motion-preserving video replacement is unavailable. ' +
                'Update ComfyUI (the MiniMax H3 reference-to-video node and VideoHelperSuite are required).'
            );
            error.code = 'video_replacement_node_missing';
            throw error;
        }
    }
    if (!resolveRefUnet(info, { h3RefUnet: (graph.model.inputs || {}).unet_name })) {
        const error = new Error('The MiniMax H3 reference-to-video model (Ref2VA) is not installed.');
        error.code = 'h3_reference_unet_missing';
        throw error;
    }
    for (const [key, node] of Object.entries(graph)) {
        if (!node || !node.class_type) continue;
        if (!Object.prototype.hasOwnProperty.call(info, node.class_type)) {
            const error = new Error('ComfyUI is missing the node "' + node.class_type + '" (used as "' + key + '").');
            error.code = 'comfyui_missing_nodes';
            throw error;
        }
    }
}

// --- Execution ----------------------------------------------------------------

async function uploadFile(absPath, prefix) {
    const buffer = fs.readFileSync(absPath);
    const name = prefix + '_' + Date.now() + '_' + path.basename(absPath);
    const uploaded = await comfyui.uploadImage(buffer, name);
    return { name: (uploaded && uploaded.name) || name, buffer };
}

async function generateReplacementVideo(plan, options = {}) {
    const queueOpts = {
        label: options.label || 'video character replacement',
        kind: options.kind || 'video_generation',
        conversationId: options.conversationId || null,
        onQueued: options.onQueued || null,
        onStart: options.onStart || null
    };
    return generationQueue.enqueue(async (signal) => {
        ensureGeneratedDir();
        const startedAt = Date.now();
        const seed = Number.isInteger(options.seed) && options.seed >= 0
            ? options.seed
            : Math.floor(Math.random() * 2 ** 32);

        const settings = videoGenerator.effectiveVideoSettings();
        const sourceBuffer = fs.readFileSync(plan.sourceVideo.absPath);
        const sourceExt = path.extname(plan.sourceVideo.absPath).toLowerCase();

        const probedDims = videoGenerator.probeVideoBuffer(sourceBuffer, sourceExt);
        const sourceSeconds = probeDurationBuffer(sourceBuffer, sourceExt);
        const requested = Number(plan.requestedDuration || options.duration);
        const chosenSeconds = Number.isFinite(requested) && requested > 0
            ? requested
            : (Number.isFinite(sourceSeconds) && sourceSeconds > 0 ? sourceSeconds : settings.h3Duration);
        const duration = videoGenerator.h3DurationSeconds(Math.round(chosenSeconds));
        const frames = videoGenerator.h3FramesForSeconds(duration);
        const dims = videoGenerator.h3Dimensions(
            probedDims && probedDims.width ? probedDims.width : 1280,
            probedDims && probedDims.height ? probedDims.height : 720,
            settings.h3Size
        );
        const W = dims.W;
        const H = dims.H;
        const refVideoHasAudio = options.preserveAudio !== false && hasLikelyAudioTrack(sourceBuffer);

        const uploadedInputNames = [];
        const info = await comfyui.getObjectInfo();
        const refUnet = resolveRefUnet(info, settings);
        if (!refUnet) {
            const error = new Error('The MiniMax H3 reference-to-video model (Ref2VA) is not installed.');
            error.code = 'h3_reference_unet_missing';
            throw error;
        }

        const resolvedSettings = Object.assign({}, settings, {
            h3RefUnet: refUnet,
            attentionBackend: videoGenerator.resolveH3AttentionBackend(info, settings.attentionBackend)
        });

        const prompt = buildReplacementPrompt(plan);
        const finalPrompt = String(prompt || '').trim();

        try {
            const sourceUpload = await uploadFile(plan.sourceVideo.absPath, 'jarvis_replace_src');
            uploadedInputNames.push(sourceUpload.name);

            const refImageNames = [];
            for (let i = 0; i < plan.replacements.length; i += 1) {
                const ref = plan.replacements[i];
                const up = await uploadFile(ref.absPath, 'jarvis_replace_ref_' + i);
                uploadedInputNames.push(up.name);
                refImageNames.push(up.name);
            }

            const graph = buildReplacementGraph({
                prompt: finalPrompt,
                W,
                H,
                frames,
                seed,
                settings: resolvedSettings,
                refImageNames,
                refVideoName: sourceUpload.name,
                refVideoHasAudio,
                firstBlockCacheInputs: videoGenerator.resolveFirstBlockCacheInputNames(info)
            });

            await validateReplacementGraph(info, graph);

            if (typeof options.onProgress === 'function') {
                try { options.onProgress('reference-begin'); } catch (_) { /* best-effort */ }
            }

            const pid = await comfyui.queuePrompt(graph);
            console.log('[video-replacement] queued reference workflow:', pid,
                '(' + duration + 's, ' + frames + 'f, ' + plan.replacements.length + ' ref image(s), ' +
                'audio=' + refVideoHasAudio + ')');

            const timeoutMs = options.timeoutMs || 30 * 60 * 1000;
            const history = await comfyui.waitForPrompt(pid, { timeoutMs, signal });

            const videoFiles = comfyui.findOutputFiles(history.outputs || {}, /\.(?:mp4|webm|avi|mov)$/i);
            if (!videoFiles.length) {
                const error = new Error('ComfyUI finished but produced no replacement video.');
                error.code = 'comfyui_output_not_found';
                throw error;
            }
            const entry = videoFiles[videoFiles.length - 1];
            const buffer = await comfyui.downloadImage(entry);
            await comfyui.deleteOutputFile(entry, { history: pid }).catch(() => {});

            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const extension = path.extname(entry.filename).toLowerCase() || '.mp4';
            const basename = safeFilename(buffer.toString('hex', 0, 4)) + '_repl_' + stamp + extension;
            const filePath = path.join(GENERATED_DIR, basename);
            fs.writeFileSync(filePath, buffer);

            const acceleration = videoGenerator.videoAccelerationInfo(resolvedSettings, resolvedSettings.attentionBackend);
            const meta = generatedHistory.add({
                file: '/generated/' + encodeURIComponent(basename),
                rawFilename: basename,
                conversationId: options.conversationId || null,
                prompt: finalPrompt,
                model: 'MiniMax H3 Reference',
                width: W,
                height: H,
                seed,
                generationMs: Date.now() - startedAt,
                video: {
                    duration: videoGenerator.h3EffectiveDurationSeconds(duration),
                    frames,
                    fps: H3_FPS,
                    mode: 'reference',
                    source: plan.sourceVideo.filename,
                    references: plan.replacements.map((r) => r.filename),
                    preserveAudio: refVideoHasAudio,
                    resolution: { width: W, height: H },
                    acceleration,
                    videoPipeline: 'minimax-h3-reference'
                }
            });

            return {
                url: meta.file,
                filename: basename,
                width: W,
                height: H,
                duration: videoGenerator.h3EffectiveDurationSeconds(duration),
                frames,
                fps: H3_FPS,
                mode: 'reference',
                references: plan.replacements.map((r) => r.filename),
                prompt: finalPrompt,
                generationMs: meta.generationMs,
                meta
            };
        } finally {
            for (const name of uploadedInputNames) {
                await comfyui.deleteInputFile(name).catch(() => {});
            }
        }
    }, queueOpts);
}

module.exports = {
    REPLACEMENT_NODE,
    SOURCE_VIDEO_NODE,
    REQUIRED_NODES,
    DEFAULT_REF_UNET,
    REPLACEMENT_VERB_RE,
    MAPPING_CUE_RE,
    detectReferenceReplacement,
    buildReplacementPlan,
    buildReplacementPrompt,
    serializePlanAsset,
    serializeReplacementPlan,
    probeDurationBuffer,
    probeVideoDuration,
    hasLikelyAudioTrack,
    refUnetCandidates,
    resolveRefUnet,
    buildReplacementGraph,
    validateReplacementGraph,
    generateReplacementVideo
};
