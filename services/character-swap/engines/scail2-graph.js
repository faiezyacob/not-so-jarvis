/* ============================================
   JARVIS — SCAIL-2 replacement graph
   Builds the ComfyUI graph for SCAIL-2 character
   replacement: SAM 3.1 tracks the target in the
   driving video, SCAIL2ColoredMask renders the
   identity-coloured reference/driving masks, and
   WanSCAILToVideo consumes them in replacement
   mode. Long clips run through WanSCAILInfinity,
   which reuses WanSCAILToVideo per 81-frame
   window with the model's trained 5-frame anchor.

   No legacy Wan Animate nodes are emitted.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const shared = require('./scail2-shared');

const FPS = shared.FPS;
const WINDOW_FRAMES = 81;
const PREVIOUS_FRAMES = 5;
const FRAME_ADVANCE = WINDOW_FRAMES - PREVIOUS_FRAMES;
const MAX_SECONDS = shared.MAX_SECONDS;

const SCAIL_PROMPT = 'person';

function node(classType, inputs) {
    return { class_type: classType, inputs: inputs || {} };
}

function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function clampFloat(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

// WanSCAILToVideo/H3 latents live on a 4n+1 frame grid.
function snapFrameLength(value) {
    const frames = Math.max(1, Math.round(Number(value) || 1));
    return Math.max(1, Math.floor((frames - 1) / 4) * 4 + 1);
}

// SCAIL-2 was trained on 81-frame chunks with a 5-frame anchor. WanSCAILInfinity
// loops those windows internally and trims the last overshoot to the exact
// driving length, so every clip (including a short one) uses it. The plain
// single-chunk path is kept for a build without the Infinity pack.
function windowPlan(frameCount) {
    const frames = Math.max(1, Math.round(Number(frameCount) || 1));
    const windows = frames <= WINDOW_FRAMES
        ? 1
        : Math.max(1, Math.ceil((frames - WINDOW_FRAMES) / FRAME_ADVANCE) + 1);
    return {
        mode: 'infinity',
        frames,
        length: WINDOW_FRAMES,
        windows
    };
}

function pointsJson(points) {
    return JSON.stringify((Array.isArray(points) ? points : []).map((point) => ({
        x: Math.round(Number(point.x)),
        y: Math.round(Number(point.y))
    })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
}

function buildModelChain(graph, opts) {
    const settings = opts.settings || {};
    // The official SCAIL-2 INT8 convrot checkpoint always loads through
    // UNETLoader from models/diffusion_models.
    graph.unet = node('UNETLoader', { unet_name: settings.unet, weight_dtype: 'default' });
    let model = ['unet', 0];

    const lora = (key, name, strength) => {
        if (!name) return;
        graph[key] = node('LoraLoaderModelOnly', {
            model,
            lora_name: name,
            strength_model: clampFloat(strength, 0, 2, 1)
        });
        model = [key, 0];
    };

    if (settings.accelerationLora) lora('lora_accel', settings.accelerationLora, settings.accelerationStrength);
    if (opts.relightLora) lora('lora_relight', opts.relightLora, settings.relightStrength);
    if (opts.dpoLora) lora('lora_dpo', opts.dpoLora, settings.dpoStrength);

    if (opts.chunkFeedForward) {
        graph.chunk_ff = node('WanChunkFeedForward', {
            model,
            chunks: clampInt(settings.chunkFeedForwardChunks, 1, 100, 4),
            dim_threshold: clampInt(settings.chunkFeedForwardDim, 1024, 16384, 4096)
        });
        model = ['chunk_ff', 0];
    }

    graph.sampling = node('ModelSamplingSD3', {
        model,
        shift: clampFloat(settings.shift, 1, 20, 5)
    });
    return ['sampling', 0];
}

function buildPromptNodes(graph, opts) {
    graph.clip = node('CLIPLoader', {
        clip_name: opts.settings.textEncoder,
        type: 'wan',
        device: 'cpu'
    });
    graph.positive = node('CLIPTextEncode', { clip: ['clip', 0], text: opts.positive });
    graph.negative = node('CLIPTextEncode', { clip: ['clip', 0], text: opts.negative });
}

// SAM 3.1 produces per-object tracks. Two mask modes are supported:
//
//   text   (default, the official ComfyUI template) - open-vocabulary detection
//          from a short description of the selected person, re-detected across
//          every frame. The reference image is tracked the same way. Because
//          both sides produce track data, SCAIL2ColoredMask keeps each identity
//          on one colour for the whole clip and a crossing cannot silently
//          reassign the mask to the other person.
//   anchor (fallback) - seed the driving track from the DWPose point prompts on
//          one frame when the subject could not be described. No text
//          conditioning is supplied, so new people are never detected; the
//          tracker can only follow the seeded mask.
function buildMaskNodes(graph, opts) {
    const settings = opts.settings || {};
    const start = clampInt(opts.anchorFrame, 0, Math.max(0, opts.frames - 1), 0);
    const samText = String(opts.samText || '').trim();
    const mode = (opts.sam3Mode === 'anchor' || !samText) ? 'anchor' : 'text';

    graph.sam = node('CheckpointLoaderSimple', { ckpt_name: settings.samModel });

    graph.performance = node('LoadVideo', { file: opts.performanceName });
    graph.performance_parts = node('GetVideoComponents', { video: ['performance', 0] });
    graph.reference = node('LoadImage', { image: opts.referenceName });

    if (mode === 'text') {
        const refText = String(opts.samRefText || settings.sam3ImageObject || 'human').trim() || 'human';
        const maxObjects = clampInt(
            opts.maxObjects === undefined ? settings.sam3MaxObjects : opts.maxObjects,
            1, 16, 4
        );
        graph.sam_text = node('CLIPTextEncode', { clip: ['sam', 1], text: samText });
        graph.sam_ref_text = node('CLIPTextEncode', { clip: ['sam', 1], text: refText });
        graph.driving_track = node('SAM3_VideoTrack', {
            images: ['performance_parts', 0],
            model: ['sam', 0],
            conditioning: ['sam_text', 0],
            detection_threshold: 0.5,
            max_objects: maxObjects,
            detect_interval: 1
        });
        graph.reference_track = node('SAM3_VideoTrack', {
            images: ['reference', 0],
            model: ['sam', 0],
            conditioning: ['sam_ref_text', 0],
            detection_threshold: 0.5,
            max_objects: maxObjects,
            detect_interval: 1
        });
        graph.colored = node('SCAIL2ColoredMask', {
            driving_track_data: ['driving_track', 0],
            ref_track_data: ['reference_track', 0],
            object_indices: '',
            sort_by: 'left_to_right',
            replacement_mode: true
        });
    } else {
        graph.sam_text = node('CLIPTextEncode', { clip: ['sam', 1], text: SCAIL_PROMPT });
        graph.anchor_frame = node('ImageFromBatch', {
            image: ['performance_parts', 0],
            batch_index: start,
            length: 1
        });
        // Seed ONLY from the DWPose points. Adding text conditioning here would
        // union in every other person SAM 3.1 detects.
        const detectInputs = {
            model: ['sam', 0],
            image: ['anchor_frame', 0],
            positive_coords: pointsJson(opts.points && opts.points.positive),
            threshold: 0.5,
            refine_iterations: 2,
            individual_masks: false
        };
        const negative = pointsJson(opts.points && opts.points.negative);
        if (negative && negative !== '[]') detectInputs.negative_coords = negative;
        graph.anchor_detect = node('SAM3_Detect', detectInputs);

        graph.driving_track = node('SAM3_VideoTrack', {
            images: ['performance_parts', 0],
            model: ['sam', 0],
            initial_mask: ['anchor_detect', 0],
            detection_threshold: 0.5,
            max_objects: 1,
            detect_interval: 1
        });
        // One reference identity, unioned, so it maps to the single driving colour.
        graph.reference_detect = node('SAM3_Detect', {
            model: ['sam', 0],
            image: ['reference', 0],
            conditioning: ['sam_text', 0],
            threshold: 0.5,
            refine_iterations: 2,
            individual_masks: false
        });
        graph.colored = node('SCAIL2ColoredMask', {
            driving_track_data: ['driving_track', 0],
            ref_track_data: ['reference_detect', 0],
            object_indices: '',
            sort_by: 'left_to_right',
            replacement_mode: true
        });
    }

    graph.clip_vision = node('CLIPVisionLoader', { clip_name: settings.clipVision });
    graph.reference_vision = node('CLIPVisionEncode', {
        clip_vision: ['clip_vision', 0],
        image: ['reference', 0],
        crop: 'none'
    });
}

function buildGraph(opts = {}) {
    const settings = opts.settings || {};
    const width = Math.max(32, Math.round(Number(opts.width) || 832));
    const height = Math.max(32, Math.round(Number(opts.height) || 480));
    const frames = Math.max(1, Math.round(Number(opts.frames) || WINDOW_FRAMES));
    const plan = opts.windowPlan || windowPlan(frames);
    const graph = {};

    const model = buildModelChain(graph, opts);
    buildPromptNodes(graph, opts);
    buildMaskNodes(graph, opts);
    graph.vae = node('VAELoader', { vae_name: settings.vae });

    const seed = clampInt(opts.seed, 0, Number.MAX_SAFE_INTEGER, 0);
    const steps = clampInt(settings.steps, 1, 100, 6);
    const cfg = clampFloat(settings.cfg, 0, 20, 1);
    const samplerName = String(settings.sampler || 'euler');
    const scheduler = String(settings.scheduler || 'simple');
    const poseStrength = clampFloat(settings.poseStrength, 0, 10, 1);

    const common = {
        positive: ['positive', 0],
        negative: ['negative', 0],
        vae: ['vae', 0],
        width,
        height,
        pose_video: ['performance_parts', 0],
        pose_video_mask: ['colored', 0],
        replacement_mode: true,
        reference_image: ['reference', 0],
        reference_image_mask: ['colored', 1],
        clip_vision_output: ['reference_vision', 0],
        pose_strength: poseStrength,
        pose_start: clampFloat(settings.poseStart, 0, 1, 0),
        pose_end: clampFloat(settings.poseEnd, 0, 1, 1)
    };

    if (plan.mode === 'infinity') {
        graph.conditioning = node('WanSCAILInfinity', Object.assign({}, common, {
            model,
            seed,
            steps,
            cfg,
            sampler_name: samplerName,
            scheduler,
            denoise: 1,
            window_length: WINDOW_FRAMES,
            previous_frame_count: PREVIOUS_FRAMES,
            max_frames: frames,
            decode_tiled: opts.decodeTiled === true,
            vary_seed_per_window: false
        }));
        graph.video = node('CreateVideo', { images: ['conditioning', 0], fps: FPS });
    } else {
        graph.conditioning = node('WanSCAILToVideo', Object.assign({}, common, {
            length: plan.length,
            batch_size: 1,
            video_frame_offset: 0,
            previous_frame_count: PREVIOUS_FRAMES
        }));
        graph.scheduler = node('BasicScheduler', {
            model,
            scheduler,
            steps,
            denoise: 1
        });
        graph.sampler_select = node('KSamplerSelect', { sampler_name: samplerName });
        graph.sample = node('SamplerCustom', {
            model,
            add_noise: true,
            noise_seed: seed,
            cfg,
            positive: ['conditioning', 0],
            negative: ['conditioning', 1],
            sampler: ['sampler_select', 0],
            sigmas: ['scheduler', 0],
            latent_image: ['conditioning', 2]
        });
        graph.decode = node('VAEDecode', { samples: ['sample', 0], vae: ['vae', 0] });
        graph.video = node('CreateVideo', { images: ['decode', 0], fps: FPS });
    }

    graph.save = node('SaveVideo', {
        video: ['video', 0],
        filename_prefix: 'jarvis_cs/scail2',
        format: 'auto',
        codec: 'auto'
    });
    return { graph, plan };
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

function validateGraph(info, graph) {
    for (const [key, entry] of Object.entries(graph)) {
        if (!entry || !entry.class_type) continue;
        if (!Object.prototype.hasOwnProperty.call(info, entry.class_type)) {
            const error = new Error('ComfyUI is missing the node "' + entry.class_type + '" (used as "' + key + '").');
            error.code = 'scail2_node_missing';
            throw error;
        }
    }
}

module.exports = {
    FPS,
    WINDOW_FRAMES,
    PREVIOUS_FRAMES,
    FRAME_ADVANCE,
    MAX_SECONDS,
    SCAIL_PROMPT,
    snapFrameLength,
    windowPlan,
    pointsJson,
    buildGraph,
    choiceList,
    hasChoice,
    validateGraph
};
