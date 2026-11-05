/* ============================================
   JARVIS — H3 Recast ComfyUI graphs
   The official H3 Recast swap engine and its
   optional lip-repair (FaceRefine) pass, built
   in ComfyUI API format.

   Graph shape follows Bambushu/h3-recast
   (MIT) with the workflow's bypassed nodes
   omitted and the FaceRefine output slots
   resolved against the installed node pack:
   canvas_w / canvas_h / frame_count are slots
   4 / 5 / 6, not the old workflow's 2 / 3 / 4.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const FPS = 24;
const DEFAULT_REF_UNET = process.env.H3_RECAST_UNET || 'minimax_h3_ref2va_pruned_int8_convrot.safetensors';
const DEFAULT_LIP_UNET = process.env.H3_RECAST_LIP_UNET || 'minimax_h3_fl2va_pruned_int8_convrot.safetensors';
const DEFAULT_SWAP_LORA = process.env.H3_RECAST_SWAP_LORA || 'minimax_h3_character_swap_v1.0_ref2va_r64_gl.safetensors';
const DEFAULT_FACE_DETECTOR = process.env.H3_RECAST_FACE_DETECTOR || 'bbox\\face_yolov8m.pt';
const DEFAULT_CLIP = process.env.H3_RECAST_CLIP || process.env.H3_CLIP || 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors';
const DEFAULT_VIDEO_VAE = process.env.H3_RECAST_VIDEO_VAE || process.env.H3_VIDEO_VAE || 'minimax_h3_video_vae_int8_convrot.safetensors';
const DEFAULT_AUDIO_VAE = process.env.H3_RECAST_AUDIO_VAE || process.env.H3_AUDIO_VAE || 'minimax_h3_audio_vae_fp32.safetensors';

const DEFAULT_LIP_PROMPT = process.env.H3_RECAST_LIP_PROMPT || '<Subject 1> is the person in <Picture 1>. They speak the words heard in <Audio 1>, opening their mouth clearly on every syllable, their lips and jaw matching every syllable in time.';

const SWAP_NODES = [
    'UNETLoader',
    'CLIPLoader',
    'VAELoader',
    'MiniMaxH3SigmaShift',
    'ModelAttentionBackend',
    'LoraLoaderModelOnly',
    'LoadImage',
    'ImageScaleBy',
    'VHS_LoadVideoFFmpeg',
    'TrimAudioDuration',
    'EmptyMiniMaxH3LatentAV',
    'MiniMaxH3ReferenceToVideo',
    'MiniMaxH3AddGuide',
    'RandomNoise',
    'KSamplerSelect',
    'BasicScheduler',
    'CFGGuider',
    'SamplerCustomAdvanced',
    'LTXVSeparateAVLatent',
    'VAEDecode',
    'CreateVideo',
    'SaveVideo'
];

const LIP_NODES = [
    'UNETLoader',
    'CLIPLoader',
    'VAELoader',
    'VHS_LoadVideoFFmpeg',
    'H3FaceTrackCrop',
    'MiniMaxH3ReferenceToVideo',
    'H3InjectVideoLatent',
    'MiniMaxH3NativeAudioLock',
    'H3PerFrameDenoise',
    'BasicGuider',
    'BasicScheduler',
    'RandomNoise',
    'KSamplerSelect',
    'SamplerCustomAdvanced',
    'VAEDecode',
    'H3FaceStitch',
    'CreateVideo',
    'SaveVideo'
];

const DEFAULT_SETTINGS = Object.freeze({
    steps: 20,
    denoise: 1,
    swapStrength: 1,
    shiftVideo: 12,
    shiftAudio: 3,
    attention: 'auto',
    lip: {
        enabled: false,
        person: 1,
        denoise: 0.35,
        steps: 20,
        prompt: DEFAULT_LIP_PROMPT,
        facePick: 'position',
        canvasMode: 'manual',
        canvasWidth: 768,
        canvasHeight: 768,
        detector: '',
        // FaceRefine scales the scheduler denoise per frame by face size. Its
        // shipped large-face multiplier (0.35) protects big faces from being
        // rewritten, but on a large face it also preserves the first pass's
        // mouth timing. For lip synchronisation the mouth must be regenerated
        // against the locked audio, so the default here is 1.0 (full denoise on
        // every face). Lower it to 0.35 for the author's detail-only behaviour.
        smallFaceMultiplier: 1,
        largeFaceMultiplier: 1,
        // Optional isolated vocal stem used ONLY to condition lipsync. The
        // original source audio always stays in the rendered output.
        vocalsFile: ''
    }
});

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function clampInt(value, min, max, fallback) {
    return Math.round(clampNumber(value, min, max, fallback));
}

function snap32(value) {
    return Math.max(32, Math.round(Number(value) / 32) * 32);
}

function normalizeAttention(value, info) {
    const requested = String(value || 'auto').trim().toLowerCase();
    const values = enumValues(info, 'ModelAttentionBackend', 'attention') || [];
    // Always resolve to one of the two backends ModelAttentionBackend exposes.
    // A value this node cannot express (e.g. the global video setting
    // "sageattention") falls back to Comfy Kitchen, then PyTorch. Keeping a
    // non-null result also makes re-normalization (live info -> null info)
    // idempotent.
    if (requested === 'comfy kitchen attention' || requested === 'kitchen' || requested === 'ck') {
        return values.length && !values.includes('comfy kitchen attention')
            ? 'pytorch attention'
            : 'comfy kitchen attention';
    }
    if (requested === 'pytorch attention' || requested === 'pytorch' || requested === 'standard') {
        return 'pytorch attention';
    }
    if (requested === 'auto') {
        if (values.includes('comfy kitchen attention')) return 'comfy kitchen attention';
        if (values.includes('pytorch attention')) return 'pytorch attention';
        return 'comfy kitchen attention';
    }
    if (values.includes('comfy kitchen attention')) return 'comfy kitchen attention';
    if (values.includes('pytorch attention')) return 'pytorch attention';
    return 'comfy kitchen attention';
}

function normalizeSettings(settings, info) {
    const input = settings && typeof settings === 'object' ? settings : {};
    // Accept both the persisted shape ({ lipRepair: {...} }) and an already
    // normalized shape ({ lip: {...} }). renderLipRepair normalizes before
    // calling buildLipGraph, which normalizes again; without this fallback the
    // second pass silently replaced every user lip setting with the defaults.
    const lipInput = input.lipRepair && typeof input.lipRepair === 'object'
        ? input.lipRepair
        : (input.lip && typeof input.lip === 'object' ? input.lip : {});
    return {
        steps: clampInt(input.steps, 1, 100, Number(process.env.H3_RECAST_STEPS) || DEFAULT_SETTINGS.steps),
        denoise: clampNumber(input.denoise, 0.05, 1, DEFAULT_SETTINGS.denoise),
        swapStrength: clampNumber(input.swapStrength, 0, 2, Number(process.env.H3_RECAST_SWAP_STRENGTH) || DEFAULT_SETTINGS.swapStrength),
        shiftVideo: clampNumber(input.shiftVideo, 1, 20, DEFAULT_SETTINGS.shiftVideo),
        shiftAudio: clampNumber(input.shiftAudio, 1, 20, DEFAULT_SETTINGS.shiftAudio),
        attention: normalizeAttention(input.attention || process.env.H3_RECAST_ATTENTION, info),
        lip: {
            enabled: lipInput.enabled === true,
            person: clampInt(lipInput.person, 1, 3, DEFAULT_SETTINGS.lip.person),
            denoise: clampNumber(lipInput.denoise, 0.05, 0.8, Number(process.env.H3_RECAST_LIP_DENOISE) || DEFAULT_SETTINGS.lip.denoise),
            steps: clampInt(lipInput.steps, 1, 50, Number(process.env.H3_RECAST_LIP_STEPS) || DEFAULT_SETTINGS.lip.steps),
            prompt: String(lipInput.prompt || DEFAULT_LIP_PROMPT).slice(0, 2000),
            facePick: lipInput.facePick === 'identity' ? 'identity' : 'position',
            canvasMode: ['manual', 'auto_no_downscale', 'auto_capped_768'].includes(String(lipInput.canvasMode))
                ? String(lipInput.canvasMode)
                : DEFAULT_SETTINGS.lip.canvasMode,
            canvasWidth: snap32(clampInt(lipInput.canvasWidth, 128, 1344, DEFAULT_SETTINGS.lip.canvasWidth)),
            canvasHeight: snap32(clampInt(lipInput.canvasHeight, 128, 1344, DEFAULT_SETTINGS.lip.canvasHeight)),
            detector: String(lipInput.detector || '').slice(0, 260),
            smallFaceMultiplier: clampNumber(lipInput.smallFaceMultiplier, 0, 1, DEFAULT_SETTINGS.lip.smallFaceMultiplier),
            largeFaceMultiplier: clampNumber(lipInput.largeFaceMultiplier, 0, 1, DEFAULT_SETTINGS.lip.largeFaceMultiplier),
            vocalsFile: sanitizeVocalsFile(lipInput.vocalsFile)
        }
    };
}

// A vocals stem is stored as a project-relative path under lip/. Keep it to a
// safe basename so a persisted value can never escape the project directory.
function sanitizeVocalsFile(value) {
    const name = String(value || '').trim().replace(/\\/g, '/');
    if (!name) return '';
    const match = name.match(/^lip\/([A-Za-z0-9._-]{1,120})$/);
    return match ? 'lip/' + match[1] : '';
}

function inputSpec(info, node, key) {
    const def = info && info[node] && info[node].input ? info[node].input : null;
    if (!def) return null;
    if (def.required && def.required[key]) return def.required[key];
    if (def.optional && def.optional[key]) return def.optional[key];
    return null;
}

function enumValues(info, node, key) {
    const spec = inputSpec(info, node, key);
    if (!spec) return null;
    if (Array.isArray(spec[0])) return spec[0];
    if (spec[0] === 'COMBO' && spec[1] && Array.isArray(spec[1].options)) return spec[1].options;
    return null;
}

function resolveEnum(info, node, key, requested, patterns) {
    const values = enumValues(info, node, key);
    const wanted = String(requested || '').trim();
    if (values) {
        if (wanted && values.includes(wanted)) return wanted;
        for (const pattern of patterns || []) {
            const hit = values.find((value) => pattern.test(String(value)));
            if (hit) return hit;
        }
        return null;
    }
    return wanted || null;
}

function resolveModels(info, settings) {
    const input = settings && typeof settings === 'object' ? settings : {};
    const unet = resolveEnum(info, 'UNETLoader', 'unet_name', input.unet || DEFAULT_REF_UNET, [/ref2va/i]);
    const lipUnet = resolveEnum(info, 'UNETLoader', 'unet_name', input.lipUnet || DEFAULT_LIP_UNET, [/fl2va/i]);
    const clip = resolveEnum(info, 'CLIPLoader', 'clip_name', input.clip || DEFAULT_CLIP, [/qwen3vl_32b.*minimax_h3/i, /minimax_h3.*qwen/i, /qwen3vl/i]);
    const videoVae = resolveEnum(info, 'VAELoader', 'vae_name', input.videoVae || DEFAULT_VIDEO_VAE, [/minimax_h3_video_vae/i, /minimax_h3.*video/i]);
    const audioVae = resolveEnum(info, 'VAELoader', 'vae_name', input.audioVae || DEFAULT_AUDIO_VAE, [/minimax_h3_audio_vae/i, /minimax_h3.*audio/i]);
    const swapLora = resolveEnum(info, 'LoraLoaderModelOnly', 'lora_name', input.swapLora || DEFAULT_SWAP_LORA, [
        /character_swap_v1\.0.*ref2va/i,
        /minimax_h3_character_swap/i,
        /bfs/i
    ]);
    const requestedDetector = (input.lip && input.lip.detector) || (input.lipRepair && input.lipRepair.detector);
    const faceDetector = resolveEnum(info, 'H3FaceTrackCrop', 'detector', requestedDetector || DEFAULT_FACE_DETECTOR, [/face_yolov8m/i]);
    const missingLip = [
        lipUnet ? null : 'FL2VA diffusion model (' + DEFAULT_LIP_UNET + ')',
        clip ? null : 'MiniMax H3 text encoder',
        videoVae ? null : 'MiniMax H3 video VAE',
        audioVae ? null : 'MiniMax H3 audio VAE'
    ].filter(Boolean);
    const missingSwap = [
        unet ? null : 'Ref2VA diffusion model (' + DEFAULT_REF_UNET + ')',
        clip ? null : 'MiniMax H3 text encoder',
        videoVae ? null : 'MiniMax H3 video VAE',
        audioVae ? null : 'MiniMax H3 audio VAE',
        swapLora ? null : 'BFS character-swap LoRA (' + DEFAULT_SWAP_LORA + ')'
    ].filter(Boolean);
    return {
        unet,
        lipUnet,
        clip,
        videoVae,
        audioVae,
        swapLora,
        faceDetector: faceDetector || DEFAULT_FACE_DETECTOR,
        faceDetectorAvailable: Boolean(faceDetector),
        missingLip,
        missingSwap,
        missing: Array.from(new Set(missingSwap.concat(missingLip)))
    };
}

function missingNodes(info, required) {
    if (!info || typeof info !== 'object') return ['ComfyUI is not reachable.'];
    return required
        .filter((node) => !Object.prototype.hasOwnProperty.call(info, node))
        .map((node) => 'ComfyUI node "' + node + '"');
}

// --- Swap graph ---------------------------------------------------------------

function buildSwapGraph(opts = {}) {
    const {
        prompt,
        W,
        H,
        frames,
        seed = 0,
        settings,
        models,
        sceneRefName,
        sourceName,
        sourceHasAudio = false,
        filenamePrefix = 'not-so-jarvis/h3-recast'
    } = opts;
    const resolved = normalizeSettings(settings, null);
    if (!models || !models.unet || !models.clip || !models.videoVae || !models.audioVae || !models.swapLora) {
        const error = new Error('H3 Recast is missing a required model.');
        error.code = 'h3_recast_model_missing';
        throw error;
    }
    if (!sceneRefName) {
        const error = new Error('Build or upload the H3 Recast scene reference first.');
        error.code = 'h3_recast_scene_reference_missing';
        throw error;
    }
    if (!resolved.attention) {
        const error = new Error('H3 Recast needs an attention backend (Comfy Kitchen or PyTorch).');
        error.code = 'h3_recast_attention_missing';
        throw error;
    }
    const width = snap32(W || 1344);
    const height = snap32(H || 768);
    const length = Number(frames);
    if (!Number.isFinite(length) || length < 5) {
        const error = new Error('H3 Recast needs at least 5 frames.');
        error.code = 'h3_recast_frames_invalid';
        throw error;
    }
    let audioLink = sourceHasAudio ? ['video', 2] : ['empty_audio', 0];

    const graph = {};
    graph.unet = { class_type: 'UNETLoader', inputs: { unet_name: models.unet, weight_dtype: 'default' } };
    graph.clip = { class_type: 'CLIPLoader', inputs: { clip_name: models.clip, type: 'minimax', device: 'default' } };
    graph.video_vae = { class_type: 'VAELoader', inputs: { vae_name: models.videoVae } };
    graph.audio_vae = { class_type: 'VAELoader', inputs: { vae_name: models.audioVae } };
    graph.shift = {
        class_type: 'MiniMaxH3SigmaShift',
        inputs: { model: ['unet', 0], shift_video: resolved.shiftVideo, shift_audio: resolved.shiftAudio }
    };
    graph.attention = {
        class_type: 'ModelAttentionBackend',
        inputs: { model: ['shift', 0], attention: resolved.attention }
    };
    graph.swap_lora = {
        class_type: 'LoraLoaderModelOnly',
        inputs: { model: ['attention', 0], lora_name: models.swapLora, strength_model: resolved.swapStrength }
    };
    graph.scene_ref = { class_type: 'LoadImage', inputs: { image: sceneRefName } };
    graph.scene_ref_scaled = {
        class_type: 'ImageScaleBy',
        inputs: { image: ['scene_ref', 0], upscale_method: 'lanczos', scale_by: 0.7071 }
    };
    graph.video = {
        class_type: 'VHS_LoadVideoFFmpeg',
        inputs: {
            video: sourceName,
            force_rate: FPS,
            custom_width: width,
            custom_height: height,
            frame_load_cap: length,
            start_time: 0,
            format: 'None'
        }
    };
    if (!sourceHasAudio) {
        graph.empty_audio = {
            class_type: 'EmptyAudio',
            inputs: { duration: length / FPS, sample_rate: 44100, channels: 2 }
        };
    } else {
        graph.audio_trim = {
            class_type: 'TrimAudioDuration',
            inputs: { audio: audioLink, start_index: 0, duration: length / FPS }
        };
        audioLink = ['audio_trim', 0];
    }
    graph.empty_av = {
        class_type: 'EmptyMiniMaxH3LatentAV',
        inputs: { width: width, height: height, length: length }
    };
    graph.reference = {
        class_type: 'MiniMaxH3ReferenceToVideo',
        inputs: {
            clip: ['clip', 0],
            vae: ['video_vae', 0],
            audio_vae: ['audio_vae', 0],
            prompt: String(prompt || ''),
            width: width,
            height: height,
            length: length,
            ref_image_size: 'match',
            'ref_images.ref_image_0': ['scene_ref_scaled', 0]
        }
    };
    graph.guide = {
        class_type: 'MiniMaxH3AddGuide',
        inputs: {
            positive: ['reference', 0],
            latent: ['empty_av', 0],
            frame_idx: 0,
            vae: ['video_vae', 0],
            audio_vae: ['audio_vae', 0],
            image: ['video', 0],
            audio: audioLink
        }
    };
    graph.noise = { class_type: 'RandomNoise', inputs: { noise_seed: seed } };
    graph.sampler = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } };
    graph.scheduler = {
        class_type: 'BasicScheduler',
        inputs: { model: ['swap_lora', 0], scheduler: 'simple', steps: resolved.steps, denoise: resolved.denoise }
    };
    graph.guider = {
        class_type: 'CFGGuider',
        inputs: {
            model: ['swap_lora', 0],
            positive: ['guide', 0],
            negative: ['guide', 0],
            cfg: 1
        }
    };
    graph.sample = {
        class_type: 'SamplerCustomAdvanced',
        inputs: {
            noise: ['noise', 0],
            guider: ['guider', 0],
            sampler: ['sampler', 0],
            sigmas: ['scheduler', 0],
            latent_image: ['empty_av', 0]
        }
    };
    graph.separate = { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['sample', 0] } };
    graph.decode = { class_type: 'VAEDecode', inputs: { samples: ['separate', 0], vae: ['video_vae', 0] } };
    graph.video_out = {
        class_type: 'CreateVideo',
        inputs: { images: ['decode', 0], audio: audioLink, fps: FPS, bit_depth: 8, color_space: 'sRGB', codec: 'none' }
    };
    graph.save = {
        class_type: 'SaveVideo',
        inputs: { video: ['video_out', 0], filename_prefix: filenamePrefix, format: 'auto', codec: 'auto' }
    };
    return graph;
}

// --- Lip repair (FaceRefine) graph -------------------------------------------

function buildLipGraph(opts = {}) {
    const {
        prompt,
        frames,
        seed = 0,
        settings,
        models,
        baseVideoName,
        faceRefName,
        sourceVideoName = '',
        lipAudioName = '',
        personIndex = 0,
        sourceHasAudio = false,
        filenamePrefix = 'not-so-jarvis/h3-recast-lip'
    } = opts;
    const resolved = normalizeSettings(settings, null);
    if (!models || !models.lipUnet || !models.clip || !models.videoVae || !models.audioVae) {
        const error = new Error('H3 Recast lip repair is missing a required model.');
        error.code = 'h3_recast_model_missing';
        throw error;
    }
    if (!baseVideoName) {
        const error = new Error('H3 Recast lip repair needs a generated take.');
        error.code = 'h3_recast_lip_source_missing';
        throw error;
    }
    if (!faceRefName) {
        const error = new Error('H3 Recast lip repair needs the character face reference.');
        error.code = 'h3_recast_lip_reference_missing';
        throw error;
    }
    const length = Number(frames);
    if (!Number.isFinite(length) || length < 5) {
        const error = new Error('H3 Recast lip repair needs at least 5 frames.');
        error.code = 'h3_recast_frames_invalid';
        throw error;
    }
    const lip = resolved.lip;
    const useIdentity = lip.facePick === 'identity';

    const graph = {};
    graph.unet = { class_type: 'UNETLoader', inputs: { unet_name: models.lipUnet, weight_dtype: 'default' } };
    graph.clip = { class_type: 'CLIPLoader', inputs: { clip_name: models.clip, type: 'minimax', device: 'default' } };
    graph.video_vae = { class_type: 'VAELoader', inputs: { vae_name: models.videoVae } };
    graph.audio_vae = { class_type: 'VAELoader', inputs: { vae_name: models.audioVae } };
    graph.base_video = {
        class_type: 'VHS_LoadVideoFFmpeg',
        inputs: {
            video: baseVideoName,
            force_rate: FPS,
            custom_width: 0,
            custom_height: 0,
            frame_load_cap: length,
            start_time: 0,
            format: 'None'
        }
    };
    if (!sourceHasAudio) {
        graph.empty_audio = {
            class_type: 'EmptyAudio',
            inputs: { duration: length / FPS, sample_rate: 44100, channels: 2 }
        };
    }

    // The output must carry the clip's own soundtrack. The author's lip pass
    // reads that audio straight from the source clip rather than decoding the
    // generated take back out of its container; do the same when the source is
    // available (the base video is the fallback for older callers).
    let sourceAudioLink = sourceHasAudio ? ['base_video', 2] : ['empty_audio', 0];
    if (sourceVideoName) {
        graph.source_video = {
            class_type: 'VHS_LoadVideoFFmpeg',
            inputs: {
                video: sourceVideoName,
                force_rate: FPS,
                custom_width: 0,
                custom_height: 0,
                frame_load_cap: length,
                start_time: 0,
                format: 'None'
            }
        };
        sourceAudioLink = sourceHasAudio ? ['source_video', 2] : ['empty_audio', 0];
    }

    // Optional isolated vocal stem: it conditions the H3 node and the audio
    // lock only. The rendered output always keeps the original source audio.
    let conditioningAudioLink = sourceAudioLink;
    if (lipAudioName) {
        graph.lip_audio = {
            class_type: 'VHS_LoadAudio',
            inputs: { audio_file: lipAudioName, duration: length / FPS }
        };
        conditioningAudioLink = ['lip_audio', 0];
    }

    graph.face_ref = { class_type: 'LoadImage', inputs: { image: faceRefName } };
    const cropInputs = {
        images: ['base_video', 0],
        detector: models.faceDetector,
        confidence: 0.35,
        crop_factor: 3,
        canvas_width: lip.canvasWidth,
        canvas_height: lip.canvasHeight,
        canvas_mode: lip.canvasMode,
        smooth_window: 21,
        size_smooth_window: 51,
        smooth_method: 'gaussian',
        size_mode: 'per_frame',
        select: useIdentity ? 'left_most' : 'left_most',
        select_index: clampInt(personIndex, 0, 63, 0),
        fallback_detector: 'none',
        fallback_head_frac: 0.5,
        identity_model: 'insightface',
        identity_track: useIdentity,
        identity_threshold: 0.28,
        cut_detection: 'none',
        cut_threshold: 3,
        absent_shots: 'off',
        X: 0,
        Y: 0,
        frame_index: 0
    };
    if (useIdentity) cropInputs.identity_reference = ['face_ref', 0];
    graph.face_crop = { class_type: 'H3FaceTrackCrop', inputs: cropInputs };
    graph.reference = {
        class_type: 'MiniMaxH3ReferenceToVideo',
        inputs: {
            clip: ['clip', 0],
            vae: ['video_vae', 0],
            audio_vae: ['audio_vae', 0],
            prompt: String(prompt || lip.prompt),
            width: ['face_crop', 4],
            height: ['face_crop', 5],
            length: ['face_crop', 6],
            ref_image_size: 'match',
            'ref_images.ref_image_0': ['face_ref', 0],
            'ref_images.ref_image_1': ['face_ref', 0],
            'ref_audios.ref_audio_0': conditioningAudioLink
        }
    };
    graph.inject = {
        class_type: 'H3InjectVideoLatent',
        inputs: { av_latent: ['reference', 1], images: ['face_crop', 0], vae: ['video_vae', 0] }
    };
    graph.audio_lock = {
        class_type: 'MiniMaxH3NativeAudioLock',
        inputs: { model: ['unet', 0], av_latent: ['inject', 0], audio_vae: ['audio_vae', 0], audio: conditioningAudioLink }
    };
    graph.per_frame = {
        class_type: 'H3PerFrameDenoise',
        inputs: {
            model: ['audio_lock', 0],
            av_latent: ['audio_lock', 1],
            transform: ['face_crop', 1],
            denoise_multiplier_small_face: lip.smallFaceMultiplier,
            denoise_multiplier_large_face: lip.largeFaceMultiplier,
            scale_mode: 'absolute_px',
            face_px_small: 30,
            face_px_large: 120,
            gamma: 1,
            smooth_frames: 9
        }
    };
    graph.noise = { class_type: 'RandomNoise', inputs: { noise_seed: seed } };
    graph.sampler = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } };
    graph.scheduler = {
        class_type: 'BasicScheduler',
        inputs: { model: ['per_frame', 2], scheduler: 'simple', steps: lip.steps, denoise: lip.denoise }
    };
    graph.guider = {
        class_type: 'BasicGuider',
        inputs: { model: ['per_frame', 2], conditioning: ['reference', 0] }
    };
    graph.sample = {
        class_type: 'SamplerCustomAdvanced',
        inputs: {
            noise: ['noise', 0],
            guider: ['guider', 0],
            sampler: ['sampler', 0],
            sigmas: ['scheduler', 0],
            latent_image: ['per_frame', 0]
        }
    };
    graph.decode = { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['video_vae', 0] } };
    graph.stitch = {
        class_type: 'H3FaceStitch',
        inputs: {
            base_images: ['base_video', 0],
            refined_crops: ['decode', 0],
            transform: ['face_crop', 1],
            paste_region: 'face_only',
            mask_dilation: 24,
            feather: 24,
            colour_match: 1,
            blend: 1,
            undetected_frames: 'fade_out',
            feather_scales_with_crop: false
        }
    };
    graph.video_out = {
        class_type: 'CreateVideo',
        inputs: { images: ['stitch', 0], audio: sourceAudioLink, fps: FPS, bit_depth: 8, color_space: 'sRGB', codec: 'none' }
    };
    graph.save = {
        class_type: 'SaveVideo',
        inputs: { video: ['video_out', 0], filename_prefix: filenamePrefix, format: 'auto', codec: 'auto' }
    };
    return graph;
}

// --- Validation ---------------------------------------------------------------

function validateGraph(info, graph, options = {}) {
    if (!info || typeof info !== 'object') {
        const error = new Error('ComfyUI did not report its available nodes.');
        error.code = 'comfyui_unavailable';
        throw error;
    }
    const required = options.lip ? LIP_NODES : SWAP_NODES;
    const missing = missingNodes(info, required);
    if (missing.length) {
        const error = new Error('This ComfyUI build is missing: ' + missing.join('; '));
        error.code = 'h3_recast_node_missing';
        throw error;
    }
    for (const [id, node] of Object.entries(graph || {})) {
        if (!node || !node.class_type) continue;
        const def = info[node.class_type];
        if (!def) {
            const error = new Error('ComfyUI is missing the node "' + node.class_type + '" (used as "' + id + '").');
            error.code = 'h3_recast_node_missing';
            throw error;
        }
        const requiredInputs = (def.input && def.input.required) || {};
        const optionalInputs = (def.input && def.input.optional) || {};
        for (const key of Object.keys(requiredInputs)) {
            const supplied = (key in (node.inputs || {})) ||
                Object.keys(node.inputs || {}).some((name) => name.startsWith(key + '.'));
            if (!supplied) {
                const error = new Error('"' + node.class_type + '" is missing required input "' + key + '".');
                error.code = 'h3_recast_graph_invalid';
                throw error;
            }
        }
        for (const key of Object.keys(node.inputs || {})) {
            if (key.includes('.')) {
                const prefix = key.split('.')[0];
                if (!(prefix in requiredInputs) && !(prefix in optionalInputs)) {
                    const error = new Error('"' + node.class_type + '" has no autogrow input "' + prefix + '".');
                    error.code = 'h3_recast_graph_invalid';
                    throw error;
                }
                continue;
            }
            if (!(key in requiredInputs) && !(key in optionalInputs)) {
                const error = new Error('"' + node.class_type + '" has no input "' + key + '".');
                error.code = 'h3_recast_graph_invalid';
                throw error;
            }
        }
        for (const value of Object.values(node.inputs || {})) {
            if (!Array.isArray(value) || value.length !== 2) continue;
            const [target, slot] = value;
            if (!graph[target]) {
                const error = new Error('"' + node.class_type + '" links to missing node "' + target + '".');
                error.code = 'h3_recast_graph_invalid';
                throw error;
            }
            const outputs = info[graph[target].class_type] && info[graph[target].class_type].output;
            if (Array.isArray(outputs) && (slot < 0 || slot >= outputs.length)) {
                const error = new Error('"' + node.class_type + '" links to output ' + slot + ' of "' + graph[target].class_type + '", which has ' + outputs.length + '.');
                error.code = 'h3_recast_graph_invalid';
                throw error;
            }
        }
    }
    return true;
}

module.exports = {
    FPS,
    SWAP_NODES,
    LIP_NODES,
    DEFAULT_REF_UNET,
    DEFAULT_LIP_UNET,
    DEFAULT_SWAP_LORA,
    DEFAULT_FACE_DETECTOR,
    DEFAULT_LIP_PROMPT,
    DEFAULT_SETTINGS,
    normalizeSettings,
    resolveModels,
    missingNodes,
    normalizeAttention,
    buildSwapGraph,
    buildLipGraph,
    validateGraph,
    resolveEnum,
    enumValues,
    inputSpec
};
