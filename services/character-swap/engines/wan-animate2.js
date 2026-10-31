/* ============================================
   JARVIS — Wan Animate 2 workflow
   Pure helpers and ComfyUI graph for the native
   WanAnimate2ToVideo character animation
   pipeline (single reference image + a
   performance video + a scene prompt).

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const FPS = 24;
const WINDOW_FRAMES = 81;
const FRAME_ADVANCE = WINDOW_FRAMES - 1;
const MAX_SECONDS = 15;
const STEPS = 6;
const SHIFT = 5;
const POSE_PROMPT = 'The character follows the body motion, gestures, facial expressions, gaze and timing of the performance video exactly.';

const DEFAULT_SCENE = 'Character description: Match the reference image exactly. Background description: Keep a coherent natural environment with consistent lighting and camera framing.';

const RESOLUTION_BUDGETS = Object.freeze({
    '480p': 832 * 480,
    '720p': 1280 * 720
});

function scenePrompt(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    return text ? 'Character and background description: ' + text : DEFAULT_SCENE;
}

function snapTo16(value) {
    return Math.max(16, Math.round(Number(value) / 16) * 16);
}

function dimensionsFor(sourceWidth, sourceHeight, options = {}) {
    const width = Math.max(1, Number(sourceWidth) || 832);
    const height = Math.max(1, Number(sourceHeight) || 480);
    const key = options.resolution === '720p' ? '720p' : '480p';
    const budget = RESOLUTION_BUDGETS[key];
    const scale = Math.sqrt(budget / (width * height));
    return {
        width: Math.max(256, snapTo16(width * scale)),
        height: Math.max(256, snapTo16(height * scale)),
        budget,
        resolution: key
    };
}

function continuationPlan(input = {}) {
    const inputFps = Math.max(1, Math.min(240, Number(input.sourceFps) || FPS));
    const fps = Math.min(FPS, inputFps);
    const inputFrames = Math.max(1, Math.floor(Number(input.sourceFrames) || WINDOW_FRAMES));
    const sourceSeconds = inputFrames / inputFps;
    const availableFrames = Math.max(1, Math.round(sourceSeconds * fps));
    const requested = Number(input.requestedSeconds);
    const boundedSeconds = Math.min(
        sourceSeconds,
        MAX_SECONDS,
        Number.isFinite(requested) && requested > 0 ? requested : sourceSeconds
    );
    const outputFrames = Math.max(1, Math.min(availableFrames, Math.round(boundedSeconds * fps)));
    const windowCount = Math.max(1, Math.ceil((outputFrames - 1) / FRAME_ADVANCE));
    const segments = [];
    let remaining = outputFrames;
    for (let index = 0; index < windowCount; index += 1) {
        const overlapFrames = index === 0 ? 0 : 1;
        const availableOutputFrames = WINDOW_FRAMES - overlapFrames;
        const keepFrames = Math.max(1, Math.min(availableOutputFrames, remaining));
        const startFrame = index * FRAME_ADVANCE;
        const videoFrameOffset = index === 0 ? 0 : startFrame + overlapFrames;
        segments.push({
            index,
            startFrame,
            videoFrameOffset,
            generationFrames: WINDOW_FRAMES,
            overlapFrames,
            keepFrames
        });
        remaining -= keepFrames;
    }
    return {
        fps,
        inputFps,
        inputFrames,
        sourceFrames: availableFrames,
        sourceSeconds,
        requestedSeconds: boundedSeconds,
        outputFrames,
        seconds: outputFrames / fps,
        windowCount,
        generatedFrames: WINDOW_FRAMES + (windowCount - 1) * FRAME_ADVANCE,
        segments
    };
}

function buildGraph(opts = {}) {
    const settings = opts.settings || {};
    const segment = opts.segment || {
        index: 0,
        videoFrameOffset: 0,
        generationFrames: WINDOW_FRAMES,
        overlapFrames: 0,
        keepFrames: WINDOW_FRAMES
    };
    const width = Math.max(16, Math.round(Number(opts.width) || 832));
    const height = Math.max(16, Math.round(Number(opts.height) || 480));
    const graph = {};

    graph.unet = {
        class_type: 'UNETLoader',
        inputs: { unet_name: settings.unet, weight_dtype: 'default' }
    };
    graph.lightx = {
        class_type: 'LoraLoaderModelOnly',
        inputs: { model: ['unet', 0], lora_name: settings.lightx2v, strength_model: 1 }
    };
    let activeModel = ['lightx', 0];
    for (const [index, lora] of (Array.isArray(opts.loras) ? opts.loras : []).entries()) {
        if (!lora || lora.on === false || !lora.name) continue;
        const key = 'lora_' + index;
        graph[key] = {
            class_type: 'LoraLoaderModelOnly',
            inputs: {
                model: activeModel,
                lora_name: String(lora.name),
                strength_model: Math.max(0, Math.min(2, Number(lora.strength) || 1))
            }
        };
        activeModel = [key, 0];
    }
    graph.sampling = {
        class_type: 'ModelSamplingSD3',
        inputs: { model: activeModel, shift: Number(settings.shift) || SHIFT }
    };
    graph.clip = {
        class_type: 'CLIPLoader',
        inputs: { clip_name: settings.textEncoder, type: 'wan', device: 'default' }
    };
    graph.positive = {
        class_type: 'CLIPTextEncode',
        inputs: { clip: ['clip', 0], text: opts.positive }
    };
    graph.negative = {
        class_type: 'CLIPTextEncode',
        inputs: { clip: ['clip', 0], text: opts.negative }
    };
    graph.pose_prompt = {
        class_type: 'CLIPTextEncode',
        inputs: { clip: ['clip', 0], text: POSE_PROMPT }
    };
    graph.vae = { class_type: 'VAELoader', inputs: { vae_name: settings.vae } };
    graph.clip_vision = {
        class_type: 'CLIPVisionLoader',
        inputs: { clip_name: settings.clipVision }
    };

    graph.reference_load = { class_type: 'LoadImage', inputs: { image: opts.referenceName } };
    graph.reference_resize = {
        class_type: 'ResizeImageMaskNode',
        inputs: {
            input: ['reference_load', 0],
            resize_type: 'scale dimensions',
            'resize_type.width': width,
            'resize_type.height': height,
            'resize_type.crop': 'center',
            scale_method: 'area'
        }
    };
    graph.reference_vision = {
        class_type: 'CLIPVisionEncode',
        inputs: { clip_vision: ['clip_vision', 0], image: ['reference_resize', 0], crop: 'none' }
    };

    graph.performance_load = { class_type: 'LoadVideo', inputs: { file: opts.performanceName } };
    graph.performance_parts = {
        class_type: 'GetVideoComponents',
        inputs: { video: ['performance_load', 0] }
    };
    graph.performance_first = {
        class_type: 'ImageFromBatch',
        inputs: { image: ['performance_parts', 0], batch_index: 0, length: 1 }
    };
    graph.performance_vision = {
        class_type: 'CLIPVisionEncode',
        inputs: { clip_vision: ['clip_vision', 0], image: ['performance_first', 0], crop: 'none' }
    };

    const conditioning = {
        positive: ['positive', 0],
        negative: ['negative', 0],
        vae: ['vae', 0],
        width,
        height,
        length: WINDOW_FRAMES,
        batch_size: 1,
        video_frame_offset: Math.max(0, Math.floor(Number(segment.videoFrameOffset) || 0)),
        pose_strength: Math.max(0, Math.min(2, Number(opts.motionStrength) || 1)),
        pose_start_percent: 0,
        pose_end_percent: 1,
        reference_image_strength: Math.max(0, Math.min(2, Number(opts.identityStrength) || 1)),
        reference_image: ['reference_resize', 0],
        pose_video: ['performance_parts', 0],
        clip_vision_output: ['reference_vision', 0],
        positive_pose: ['pose_prompt', 0],
        clip_vision_output_pose: ['performance_vision', 0]
    };
    if (segment.index > 0 && opts.continuationImageName) {
        graph.continuation_load = {
            class_type: 'LoadImage',
            inputs: { image: opts.continuationImageName }
        };
        conditioning.continue_motion = ['continuation_load', 0];
    }
    graph.conditioning = { class_type: 'WanAnimate2ToVideo', inputs: conditioning };

    graph.scheduler = {
        class_type: 'BasicScheduler',
        inputs: {
            model: ['sampling', 0],
            scheduler: 'simple',
            steps: Math.max(1, Math.min(30, Math.round(Number(settings.steps) || STEPS))),
            denoise: 1
        }
    };
    graph.sampler_select = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'lcm' } };
    graph.sample = {
        class_type: 'SamplerCustom',
        inputs: {
            model: ['sampling', 0],
            add_noise: true,
            noise_seed: Math.max(0, Math.floor(Number(opts.seed) || 0)),
            cfg: 1,
            positive: ['conditioning', 0],
            negative: ['conditioning', 1],
            sampler: ['sampler_select', 0],
            sigmas: ['scheduler', 0],
            latent_image: ['conditioning', 2]
        }
    };
    graph.trim = {
        class_type: 'TrimVideoLatent',
        inputs: { samples: ['sample', 0], trim_amount: ['conditioning', 3] }
    };
    graph.decode = {
        class_type: 'VAEDecode',
        inputs: { samples: ['trim', 0], vae: ['vae', 0] }
    };

    let frameSource = ['decode', 0];
    const overlapFrames = Math.max(0, Number(segment.overlapFrames) || 0);
    if (overlapFrames > 0) {
        graph.overlap_trim = {
            class_type: 'ImageFromBatch',
            inputs: {
                image: frameSource,
                batch_index: ['conditioning', 4],
                length: WINDOW_FRAMES
            }
        };
        frameSource = ['overlap_trim', 0];
    }
    const availableSegmentFrames = WINDOW_FRAMES - overlapFrames;
    const keepFrames = Math.max(1, Math.min(availableSegmentFrames, Number(segment.keepFrames) || availableSegmentFrames));
    if (keepFrames < availableSegmentFrames) {
        graph.output_trim = {
            class_type: 'ImageFromBatch',
            inputs: { image: frameSource, batch_index: 0, length: keepFrames }
        };
        frameSource = ['output_trim', 0];
    }
    if (opts.saveContinuation) {
        graph.continuation_pick = {
            class_type: 'ImageFromBatch',
            inputs: { image: frameSource, batch_index: keepFrames - 1, length: 1 }
        };
        graph.continuation_save = {
            class_type: 'SaveImage',
            inputs: { images: ['continuation_pick', 0], filename_prefix: 'jarvis_cs/wan2_continue' }
        };
    }
    graph.video = {
        class_type: 'CreateVideo',
        inputs: { images: frameSource, fps: FPS }
    };
    graph.save = {
        class_type: 'SaveVideo',
        inputs: {
            video: ['video', 0],
            filename_prefix: 'jarvis_cs/wan2_window',
            format: 'auto',
            codec: 'auto'
        }
    };
    return graph;
}

module.exports = {
    FPS,
    WINDOW_FRAMES,
    FRAME_ADVANCE,
    MAX_SECONDS,
    STEPS,
    SHIFT,
    POSE_PROMPT,
    DEFAULT_SCENE,
    RESOLUTION_BUDGETS,
    scenePrompt,
    snapTo16,
    dimensionsFor,
    continuationPlan,
    buildGraph
};
