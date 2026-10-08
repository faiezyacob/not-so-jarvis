/* SPDX-License-Identifier: MIT */
/* ============================================
   JARVIS — H3 LongTake graph builder
   The faithful, low-level implementation of the
   xyzDist/H3-LongTakeNoCuts (MIT) anti-degradation
   technique for long videos.

   Where the legacy `H3LongVideos` AIO node chains
   beats by decoding each shot and re-encoding its
   last frame (a lossy decode/VAE round trip that
   compounds as the "photocopy effect"), this builder
   reproduces the reference workflow:

     1. MOTION CONTEXT — each beat is conditioned on
        the previous beat's SAMPLER-OUTPUT LATENT
        (sliced straight out, no decode/re-encode),
        pinning real motion instead of guessing it
        from a single still.
     2. REFINE RESAMPLE — the freshly sampled beat is
        re-sampled at low denoise (0.5, 2 steps) to
        restore the detail the chain has lost.
     3. FRAME BLEND — the raw sample (latent1) and
        the refined latent (latent2) are blended in
        LATENT space by frame (`0:0, 22:0, 44:1`),
        keeping the continuity-critical head from the
        raw generation and the refined detail after
        it.
     4. TRIM — the pinned context head is removed from
        picture and sound together, so the beats join
        as one continuous take.

   Steps 2-3 (refine + blend) are OPT-IN and OFF by
   default (`H3_LONGTAKE_REFINE`): the low-denoise
   resample repairs a latent that has already degraded
   after many beats, but on an already-consistent chain
   it introduces its own visible shift (the reference's
   documented dissolve), which the user sees as a
   drift ~2s into each beat. Motion context + trim are
   always applied.

   All beats are unrolled into ONE ComfyUI graph and
   submitted as a single job; JARVIS never extracts a
   frame and never concatenates clips itself.

   Node packs: `MiniMaxH3MotionContext`/`...Trim`
   (NikoDemon80/ComfyUI-H3-Motion-Context) and
   `H3BlendLatentsByFrames` (xyzDist/H3-LongTakeNoCuts).
   ============================================ */

const videoGenerator = require('../video-generator');

const H3_I2V_NODE = 'MiniMaxH3ImageToVideo';
const MOTION_CONTEXT_NODE = 'MiniMaxH3MotionContext';
const MOTION_TRIM_NODE = 'MiniMaxH3MotionContextTrim';
const BLEND_NODE = 'H3BlendLatentsByFrames';

// The reference's own parameters (H3-LongTakeNoCuts).
const REFINE_DENOISE = 0.5;
const REFINE_STEPS = 2;
const BLEND_KEYFRAMES = '0:0, 22:0, 44:1';
const CONTEXT_LENGTH = '22';
const AUDIO_CONTEXT_LENGTH = 24;

// H3's native canvas per aspect preset, scaled by the megapixel budget exactly
// like the installed node's ResolutionSelector (every value stays a multiple
// of 32).
const H3_NATIVE_RES = Object.freeze({
    '16:9': [1344, 768],
    '9:16': [768, 1344],
    '4:3': [1024, 768],
    '3:4': [768, 1024],
    '1:1': [768, 768],
    '21:9': [1536, 672],
    '9:21': [672, 1536]
});
const RES_MULTIPLE = 32;

// Node classes the LongTake engine needs. Anything beyond these is core
// ComfyUI and assumed present.
const LONGTAKE_NODES = [MOTION_CONTEXT_NODE, MOTION_TRIM_NODE, BLEND_NODE];

function frameSize(ratio, megapixels) {
    const [w0, h0] = H3_NATIVE_RES[ratio] || H3_NATIVE_RES['16:9'];
    const mp = Number(megapixels);
    if (!Number.isFinite(mp) || mp <= 0) return [w0, h0];
    const scale = Math.sqrt(mp * 1024 * 1024 / (w0 * h0));
    const w = Math.max(RES_MULTIPLE, Math.round(w0 * scale / RES_MULTIPLE) * RES_MULTIPLE);
    const h = Math.max(RES_MULTIPLE, Math.round(h0 * scale / RES_MULTIPLE) * RES_MULTIPLE);
    return [w, h];
}

// Split the director's paragraph prompt into [scene, ...beatParagraphs].
function splitPrompt(prompt) {
    const paragraphs = String(prompt || '')
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean);
    if (!paragraphs.length) return { scene: 'A single continuous scene.', beats: [] };
    return { scene: paragraphs[0], beats: paragraphs.slice(1) };
}

function clampSteps(steps) {
    return Math.max(1, Math.min(100, Math.round(Number(steps) || videoGenerator.H3_DEFAULT_STEPS)));
}

// The refine + frame-blend parameters (H3-LongTakeNoCuts). The refine resamples
// the whole beat at low denoise; the blend keeps the head from the raw sample
// and fades into the refined latent by frame. Tunable (env / settings.longTake)
// so a setup where the refine softens the clip can dial it back or turn it off.
function normalizeRefineOptions(settings = {}) {
    const stored = settings && typeof settings.longTake === 'object' && settings.longTake
        ? settings.longTake : {};
    const truthy = (value, fallback) => {
        if (value === undefined || value === null || value === '') return fallback;
        const s = String(value).trim().toLowerCase();
        if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false;
        if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true;
        return fallback;
    };
    const num = (value, fallback) => {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    };
    const env = process.env;
    return {
        // OFF by default: the refine resample repairs a latent that has already
        // degraded after many beats, but on an already-consistent chain it
        // introduces its own visible shift (the reference's dissolve). Motion
        // context + trim are always applied; the refine is opt-in.
        enabled: stored.refine !== undefined
            ? truthy(stored.refine, false)
            : truthy(env.H3_LONGTAKE_REFINE, false),
        denoise: Math.min(0.9, Math.max(0.05, num(
            stored.refineDenoise !== undefined ? stored.refineDenoise : env.H3_LONGTAKE_REFINE_DENOISE,
            REFINE_DENOISE))),
        steps: Math.max(1, Math.min(20, Math.round(num(
            stored.refineSteps !== undefined ? stored.refineSteps : env.H3_LONGTAKE_REFINE_STEPS,
            REFINE_STEPS)))),
        keyframes: String(stored.blendKeyframes || env.H3_LONGTAKE_BLEND_KEYFRAMES || BLEND_KEYFRAMES)
    };
}

// The shared H3 model stack: loader -> optional First Block Cache -> LoRA chain
// -> attention backend. Every beat's guider and scheduler read this one model.
function buildModelStack(graph, settings, firstBlockCacheInputs) {
    graph.model = {
        class_type: 'UNETLoader',
        inputs: {
            unet_name: settings.h3Unet || videoGenerator.H3_DEFAULTS.h3Unet,
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

    let modelNode = videoGenerator.appendFirstBlockCache(graph, 'model', settings, firstBlockCacheInputs);
    const loras = (Array.isArray(settings.loras) ? settings.loras : [])
        .filter((l) => l && l.on !== false && l.name);
    let index = 0;
    for (const lora of loras) {
        const name = String(lora.name).trim();
        if (!name) continue;
        index += 1;
        const key = 'lora' + index;
        graph[key] = {
            class_type: 'LoraLoaderModelOnly',
            inputs: {
                model: [modelNode, 0],
                lora_name: name,
                strength_model: Number.isFinite(Number(lora.strength)) ? Number(lora.strength) : 1
            }
        };
        modelNode = key;
    }
    const attention = videoGenerator.normalizeH3AttentionBackend(settings.attentionBackend);
    const preAttentionModel = modelNode;
    const patchedModel = videoGenerator.applyAttentionPatch(graph, preAttentionModel, attention);
    // SLA shapes the denoise schedule, so its scheduler reads the patched model;
    // every other backend leaves the scheduler on the pre-patch chain. This
    // mirrors buildH3Graph in video-generator.js exactly.
    return {
        guiderModel: patchedModel,
        schedulerModel: attention === 'sla' ? patchedModel : preAttentionModel
    };
}

// Build the full unrolled LongTake graph. One ComfyUI job renders every beat
// with motion-context continuity + refine + latent frame-blend and returns ONE
// continuous video.
function buildLongTakeGraph(opts = {}) {
    const {
        prompt,
        beats = [],
        seed = 0,
        settings = {},
        resolution = '16:9',
        megapixels = 1.0,
        steps = videoGenerator.H3_DEFAULT_STEPS,
        shotSeconds = 15,
        firstImageName = null,
        firstBlockCacheInputs = null,
        refine = null
    } = opts;

    const graph = {};
    const modelStack = buildModelStack(graph, settings, firstBlockCacheInputs);
    const [width, height] = frameSize(resolution, megapixels);
    const { scene, beats: beatParagraphs } = splitPrompt(prompt);
    const refineOpts = Object.assign(
        normalizeRefineOptions(settings),
        refine && typeof refine === 'object' ? refine : {}
    );

    graph.sampler_select = {
        class_type: 'KSamplerSelect',
        inputs: { sampler_name: 'res_multistep' }
    };
    if (firstImageName) {
        graph.first_image = { class_type: 'LoadImage', inputs: { image: firstImageName } };
    }

    // One unrolled segment per planned beat. Fall back to one segment when the
    // plan carries no beats.
    const beatList = (Array.isArray(beats) && beats.length)
        ? beats
        : [{ duration: Number(shotSeconds) || 15 }];
    const count = beatList.length;
    const baseSeed = Number.isFinite(Number(seed)) ? Math.max(0, Math.floor(Number(seed))) : 0;

    let prevBlend = null;
    const imageTaps = [];
    const audioTaps = [];

    for (let i = 0; i < count; i++) {
        const beat = beatList[i] || {};
        const seconds = Number(beat.duration) > 0 ? Number(beat.duration) : (Number(shotSeconds) || 15);
        const frames = videoGenerator.h3FramesForSeconds(seconds);
        const beatText = String(beatParagraphs[i] || beat.action || '').trim();
        const segmentPrompt = beatText ? (scene + '\n\n' + beatText) : scene;
        const key = (suffix) => suffix + '_' + i;

        const conditionInputs = {
            clip: ['clip', 0],
            vae: ['video_vae', 0],
            prompt: segmentPrompt,
            width,
            height,
            length: frames
        };
        // The first frame establishes the visual state; later beats inherit it
        // through the motion-context latent, never re-introduced.
        if (i === 0 && firstImageName) conditionInputs.first_frame = ['first_image', 0];
        graph[key('condition')] = { class_type: H3_I2V_NODE, inputs: conditionInputs };

        const motionInputs = {
            conditioning: [key('condition'), 0],
            vae: ['video_vae', 0],
            latent: [key('condition'), 1],
            context_length: CONTEXT_LENGTH,
            audio_context_length: AUDIO_CONTEXT_LENGTH
        };
        // Beats after the first pin the previous beat's blended sampler latent,
        // skipping the decode/re-encode that used to lose quality per link.
        if (i > 0 && prevBlend) motionInputs.context_latent = [prevBlend, 0];
        graph[key('motion')] = { class_type: MOTION_CONTEXT_NODE, inputs: motionInputs };

        graph[key('guider')] = {
            class_type: 'BasicGuider',
            inputs: { model: [modelStack.guiderModel, 0], conditioning: [key('motion'), 0] }
        };
        graph[key('noise')] = {
            class_type: 'RandomNoise',
            inputs: { noise_seed: ((baseSeed + i * 2) >>> 0) }
        };
        graph[key('scheduler')] = {
            class_type: 'BasicScheduler',
            inputs: { model: [modelStack.schedulerModel, 0], scheduler: 'simple', steps: clampSteps(steps), denoise: 1 }
        };
        graph[key('sample')] = {
            class_type: 'SamplerCustomAdvanced',
            inputs: {
                noise: [key('noise'), 0],
                guider: [key('guider'), 0],
                sampler: ['sampler_select', 0],
                sigmas: [key('scheduler'), 0],
                latent_image: [key('condition'), 1]
            }
        };

        // Refine resample + latent frame-blend (H3-LongTakeNoCuts). Tunable so a
        // setup where the refine softens the clip can dial it back or disable it.
        let beatLatent = key('sample');
        if (refineOpts.enabled) {
            graph[key('noise_refine')] = {
                class_type: 'RandomNoise',
                inputs: { noise_seed: ((baseSeed + i * 2 + 1) >>> 0) }
            };
            graph[key('scheduler_refine')] = {
                class_type: 'BasicScheduler',
                inputs: {
                    model: [modelStack.schedulerModel, 0],
                    scheduler: 'simple',
                    steps: refineOpts.steps,
                    denoise: refineOpts.denoise
                }
            };
            graph[key('refine')] = {
                class_type: 'SamplerCustomAdvanced',
                inputs: {
                    noise: [key('noise_refine'), 0],
                    guider: [key('guider'), 0],
                    sampler: ['sampler_select', 0],
                    sigmas: [key('scheduler_refine'), 0],
                    latent_image: [key('sample'), 0]
                }
            };
            // Blend the raw sample into the refined latent by frame. Audio stays
            // on the raw sample (latent1) so the refine never touches the sound.
            graph[key('blend')] = {
                class_type: BLEND_NODE,
                inputs: {
                    latent1: [key('sample'), 0],
                    latent2: [key('refine'), 1],
                    keyframes: refineOpts.keyframes,
                    duration: seconds,
                    fps: videoGenerator.H3_FPS,
                    interpolation: 'linear',
                    audio_source: 'latent1',
                    blend_audio: false
                }
            };
            beatLatent = key('blend');
        }
        prevBlend = beatLatent;

        graph[key('decode')] = {
            class_type: 'VAEDecode',
            inputs: { samples: [beatLatent, 0], vae: ['video_vae', 0] }
        };
        graph[key('decode_audio')] = {
            class_type: 'VAEDecodeAudio',
            inputs: { samples: [beatLatent, 0], vae: ['audio_vae', 0] }
        };
        // Remove the pinned context head from picture and sound together.
        graph[key('trim')] = {
            class_type: MOTION_TRIM_NODE,
            inputs: {
                images: [key('decode'), 0],
                trim_frames: [key('motion'), 1],
                audio: [key('decode_audio'), 0],
                fps: videoGenerator.H3_FPS,
                match_tail: true
            }
        };
        imageTaps.push([key('trim'), 0]);
        audioTaps.push([key('trim'), 1]);
    }

    // Join the trimmed beats into one continuous take.
    let imagesNode = imageTaps[0];
    for (let i = 1; i < imageTaps.length; i++) {
        const key = 'imgcat_' + i;
        graph[key] = { class_type: 'ImageBatch', inputs: { image1: imagesNode, image2: imageTaps[i] } };
        imagesNode = [key, 0];
    }
    let audioNode = audioTaps[0];
    for (let i = 1; i < audioTaps.length; i++) {
        const key = 'audiocat_' + i;
        graph[key] = { class_type: 'AudioConcat', inputs: { audio1: audioNode, audio2: audioTaps[i], direction: 'after' } };
        audioNode = [key, 0];
    }

    graph.video = {
        class_type: 'CreateVideo',
        inputs: { images: imagesNode, audio: audioNode, fps: videoGenerator.H3_FPS }
    };
    graph.save = {
        class_type: 'SaveVideo',
        inputs: { video: ['video', 0], filename_prefix: 'not-so-jarvis/longvideo', format: 'auto', codec: 'auto' }
    };

    return graph;
}

// True when the installed ComfyUI exposes the LongTake node packs.
function longTakeNodesAvailable(info) {
    if (!info) return false;
    return LONGTAKE_NODES.every((cls) => Boolean(info[cls]));
}

function validateLongTakeGraph(info, graph) {
    const missing = new Set();
    for (const node of Object.values(graph)) {
        if (node && node.class_type && !info[node.class_type]) missing.add(node.class_type);
    }
    if (missing.size) {
        const error = new Error(
            'ComfyUI is missing the nodes the H3 LongTake long-video engine needs: ' +
            Array.from(missing).join(', ') +
            '. Install xyzDist/H3-LongTakeNoCuts and NikoDemon80/ComfyUI-H3-Motion-Context ' +
            'into ComfyUI/custom_nodes and restart ComfyUI.'
        );
        error.code = 'longvideo_longtake_nodes_missing';
        error.missingNodes = Array.from(missing);
        throw error;
    }
    return true;
}

module.exports = {
    H3_I2V_NODE,
    MOTION_CONTEXT_NODE,
    MOTION_TRIM_NODE,
    BLEND_NODE,
    REFINE_DENOISE,
    REFINE_STEPS,
    BLEND_KEYFRAMES,
    CONTEXT_LENGTH,
    AUDIO_CONTEXT_LENGTH,
    H3_NATIVE_RES,
    frameSize,
    splitPrompt,
    normalizeRefineOptions,
    buildLongTakeGraph,
    longTakeNodesAvailable,
    validateLongTakeGraph
};
