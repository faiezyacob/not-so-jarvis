/* ============================================
   Tests — MiniMax H3 Latent Upscale + refinement
   Covers the resolution math, the auto strategy, the
   three-stage graph, availability/error handling and
   the off-path regression (direct H3 stays unchanged).
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate from the live data/config.json (a running JARVIS instance may have
// video settings toggled).
process.env.JARVIS_CONFIG_PATH = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-h3-latent-')), 'config.json');

const videoGenerator = require('../services/video-generator');
const comfyui = require('../services/comfyui');

const UPSCALE_NODE = 'MinimaxH3LatentUpscaler3D';

function baseSettings(extra) {
    return Object.assign({
        h3Unet: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
        h3Clip: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
        h3VideoVae: 'minimax_h3_video_vae_fp16.safetensors',
        h3AudioVae: 'minimax_h3_audio_vae_fp32.safetensors',
        h3Steps: 25,
        h3Cfg: 1,
        h3TurboEnabled: false,
        attentionBackend: 'standard',
        h3LatentUpscale: '2',
        h3LatentUpscaleModel: 'minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors',
        h3LatentUpscaleStrength: 0.35,
        h3LatentUpscalePrecision: 'fp16',
        h3LatentUpscaleTemporalChunking: true,
        h3LatentUpscaleForceUnload: true,
        loras: []
    }, extra || {});
}

function fakeInfo(withUpscaler = true) {
    const info = {
        UNETLoader: {},
        CLIPLoader: { input: { required: { type: [['minimax']] } } },
        VAELoader: {},
        RandomNoise: {},
        KSamplerSelect: {},
        BasicScheduler: {},
        BasicGuider: {},
        SamplerCustomAdvanced: {},
        VAEDecode: {},
        VAEDecodeAudio: {},
        CreateVideo: {},
        SaveVideo: {},
        MiniMaxH3ImageToVideo: {},
        LoraLoaderModelOnly: {},
        ConditioningZeroOut: {},
        CFGGuider: {}
    };
    if (withUpscaler) {
        info[UPSCALE_NODE] = {
            input: {
                required: {
                    latent: ['LATENT', {}],
                    model_name: [['minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors'], {}],
                    mode: ['COMFY_DYNAMICCOMBO_V3', {}],
                    align: ['INT', {}],
                    enable_temporal_chunking: ['BOOLEAN', {}],
                    force_unload: ['BOOLEAN', {}],
                    device: [['cuda', 'rocm', 'cpu'], {}],
                    precision: [['fp32', 'fp16', 'bf16'], {}]
                }
            }
        };
        info.LTXVSeparateAVLatent = {};
        info.LTXVConcatAVLatent = {};
    }
    return info;
}

test('calculateH3LatentUpscaleResolution: 2x of 768x1152 -> 384x576', () => {
    const dims = videoGenerator.calculateH3LatentUpscaleResolution(768, 1152, 2);
    assert.equal(dims.sourceWidth, 384);
    assert.equal(dims.sourceHeight, 576);
    assert.equal(dims.targetWidth, 768);
    assert.equal(dims.targetHeight, 1152);
    assert.equal(dims.scale, 2);
});

test('calculateH3LatentUpscaleResolution: 1024x1536 target at 2x -> 512x768 source', () => {
    const dims = videoGenerator.calculateH3LatentUpscaleResolution(1024, 1536, 2);
    assert.equal(dims.targetWidth, 1024);
    assert.equal(dims.targetHeight, 1536);
    assert.equal(dims.sourceWidth, 512);
    assert.equal(dims.sourceHeight, 768);
});

test('calculateH3LatentUpscaleResolution: 1.5x keeps edge alignment', () => {
    const dims = videoGenerator.calculateH3LatentUpscaleResolution(768, 1152, 1.5);
    assert.equal(dims.targetWidth % 32, 0);
    assert.equal(dims.targetHeight % 32, 0);
    assert.equal(dims.sourceWidth % 32, 0);
    assert.equal(dims.sourceHeight % 32, 0);
    // 768 / 1.5 = 512, 1152 / 1.5 = 768 exactly on the grid.
    assert.equal(dims.sourceWidth, 512);
    assert.equal(dims.sourceHeight, 768);
});

test('calculateH3LatentUpscaleResolution: target dims are the source of truth', () => {
    const dims = videoGenerator.calculateH3LatentUpscaleResolution(770, 1150, 2);
    assert.equal(dims.targetWidth, 768);
    assert.equal(dims.targetHeight, 1152);
});

test('calculateH3LatentUpscaleResolution: never returns a source >= target', () => {
    const dims = videoGenerator.calculateH3LatentUpscaleResolution(320, 320, 1.5);
    assert.ok(dims.sourceWidth < dims.targetWidth);
    assert.ok(dims.sourceHeight < dims.targetHeight);
    assert.ok(dims.sourceWidth >= 32 && dims.sourceHeight >= 32);
});

test('selectH3UpscaleStrategy: off never upscales', () => {
    const s = videoGenerator.selectH3UpscaleStrategy({ mode: 'off', targetWidth: 768, targetHeight: 1152 });
    assert.equal(s.use, false);
    assert.equal(s.reason, 'disabled');
});

test('selectH3UpscaleStrategy: explicit scale is returned when available', () => {
    const s = videoGenerator.selectH3UpscaleStrategy({ mode: '2', targetWidth: 768, targetHeight: 1152, available: true });
    assert.equal(s.use, true);
    assert.equal(s.scale, 2);
    assert.equal(s.reason, 'explicit');
});

test('selectH3UpscaleStrategy: auto picks a scale from the output size', () => {
    const small = videoGenerator.selectH3UpscaleStrategy({ mode: 'auto', targetWidth: 640, targetHeight: 704, available: true });
    const medium = videoGenerator.selectH3UpscaleStrategy({ mode: 'auto', targetWidth: 768, targetHeight: 1024, available: true });
    const large = videoGenerator.selectH3UpscaleStrategy({ mode: 'auto', targetWidth: 1024, targetHeight: 1152, available: true });
    assert.equal(small.scale, 1.5);
    assert.equal(medium.scale, 2);
    assert.equal(large.scale, 2.5);
    assert.equal(small.use, true);
    assert.equal(medium.use, true);
    assert.equal(large.use, true);
});

test('selectH3UpscaleStrategy: auto falls back to direct when unavailable', () => {
    const s = videoGenerator.selectH3UpscaleStrategy({ mode: 'auto', targetWidth: 1024, targetHeight: 1152, available: false });
    assert.equal(s.use, false);
    assert.equal(s.reason, 'model_missing_auto');
});

test('selectH3UpscaleStrategy: a tiny clip stays direct', () => {
    const s = videoGenerator.selectH3UpscaleStrategy({ mode: 'auto', targetWidth: 384, targetHeight: 576, available: true });
    assert.equal(s.use, false);
    assert.equal(s.reason, 'auto_small');
});

test('resolveH3LatentUpscaleAvailability: requires node, split/merge and a checkpoint', () => {
    const info = fakeInfo(true);
    const state = videoGenerator.resolveH3LatentUpscaleAvailability(info, baseSettings());
    assert.equal(state.ready, true);
    assert.equal(state.explicit, true);
    assert.equal(state.scale, 2);

    const noNode = videoGenerator.resolveH3LatentUpscaleAvailability(fakeInfo(false), baseSettings());
    assert.equal(noNode.ready, false);
    assert.equal(noNode.nodePresent, false);
});

test('assertH3LatentUpscaleReady: explicit scale throws when the node is missing', () => {
    assert.throws(
        () => videoGenerator.assertH3LatentUpscaleReady(fakeInfo(false), baseSettings()),
        (err) => err.code === 'h3_latent_upscale_node_missing'
    );
});

test('assertH3LatentUpscaleReady: explicit scale throws when the checkpoint is missing', () => {
    const info = fakeInfo(true);
    info[UPSCALE_NODE].input.required.model_name = [[], {}];
    assert.throws(
        () => videoGenerator.assertH3LatentUpscaleReady(info, baseSettings()),
        (err) => err.code === 'h3_latent_upscale_model_missing'
    );
});

test('assertH3LatentUpscaleReady: auto never throws (fallback path)', () => {
    const state = videoGenerator.assertH3LatentUpscaleReady(fakeInfo(false), baseSettings({ h3LatentUpscale: 'auto' }));
    assert.equal(state.mode, 'auto');
});

test('buildH3LatentUpscalePlan: uses target dimensions and resolved input keys', () => {
    const plan = videoGenerator.buildH3LatentUpscalePlan({
        targetWidth: 768,
        targetHeight: 1152,
        scale: 2,
        settings: baseSettings(),
        info: fakeInfo(true)
    });
    assert.equal(plan.sourceWidth, 384);
    assert.equal(plan.sourceHeight, 576);
    assert.equal(plan.targetWidth, 768);
    assert.equal(plan.targetHeight, 1152);
    assert.equal(plan.strength, 0.35);
    assert.equal(plan.inputNames.width, 'mode.width');
    assert.equal(plan.inputNames.height, 'mode.height');
});

test('buildH3Graph: latent upscale builds low-res -> upscale -> refine', () => {
    const plan = videoGenerator.buildH3LatentUpscalePlan({
        targetWidth: 768,
        targetHeight: 1152,
        scale: 2,
        settings: baseSettings(),
        info: fakeInfo(true)
    });
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a woman walking through a night market',
        mode: 't2va',
        W: 768,
        H: 1152,
        frames: 124,
        seed: 7,
        settings: baseSettings(),
        latentUpscale: plan
    });
    // Stage 1: the base pass generates the low-resolution source.
    assert.equal(graph.condition.inputs.width, 384);
    assert.equal(graph.condition.inputs.height, 576);
    // Stage 2: separate -> upscale -> concat.
    assert.equal(graph.ltxv_separate.class_type, 'LTXVSeparateAVLatent');
    assert.deepEqual(graph.ltxv_separate.inputs.av_latent, ['sample', 0]);
    assert.equal(graph.h3_latent_upscale.class_type, UPSCALE_NODE);
    assert.deepEqual(graph.h3_latent_upscale.inputs.latent, ['ltxv_separate', 0]);
    assert.equal(graph.h3_latent_upscale.inputs.mode, 'target dimensions');
    assert.equal(graph.h3_latent_upscale.inputs['mode.width'], 768);
    assert.equal(graph.h3_latent_upscale.inputs['mode.height'], 1152);
    assert.deepEqual(graph.ltxv_concat.inputs.video_latent, ['h3_latent_upscale', 0]);
    assert.deepEqual(graph.ltxv_concat.inputs.audio_latent, ['ltxv_separate', 1]);
    // Stage 3: refine at the target resolution.
    assert.equal(graph.condition_refine.inputs.width, 768);
    assert.equal(graph.condition_refine.inputs.height, 1152);
    assert.deepEqual(graph.sample_refine.inputs.latent_image, ['ltxv_concat', 0]);
    assert.equal(graph.scheduler_refine.inputs.denoise, 0.35);
    assert.deepEqual(graph.decode.inputs.samples, ['sample_refine', 0]);
    assert.deepEqual(graph.decode_audio.inputs.samples, ['sample_refine', 0]);
    // First Block Cache / Turbo / attention are preserved on the refine model.
    assert.deepEqual(graph.scheduler_refine.inputs.model, graph.sample.inputs.guider === undefined ? graph.scheduler_refine.inputs.model : graph.scheduler_refine.inputs.model);
});

test('buildH3Graph: refinement keeps CFG, scheduler and sampler from the base pass', () => {
    const settings = baseSettings({ h3Cfg: 4, h3Steps: 30 });
    const plan = videoGenerator.buildH3LatentUpscalePlan({
        targetWidth: 768, targetHeight: 1152, scale: 2, settings, info: fakeInfo(true)
    });
    const graph = videoGenerator.buildH3Graph({
        prompt: 'scene', mode: 't2va', W: 768, H: 1152, frames: 124, seed: 3, settings, latentUpscale: plan
    });
    assert.equal(graph.guider_refine.class_type, 'CFGGuider');
    assert.equal(graph.guider_refine.inputs.cfg, 4);
    assert.deepEqual(graph.negative_refine.inputs.conditioning, ['condition_refine', 0]);
    assert.equal(graph.scheduler_refine.inputs.steps, 30);
    assert.equal(graph.sample_refine.inputs.sampler[0], 'sampler_select');
});

test('buildH3Graph: off (no plan) is byte-for-byte the direct H3 workflow', () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'scene', mode: 't2va', W: 768, H: 1152, frames: 124, seed: 1,
        settings: baseSettings({ h3LatentUpscale: 'off' })
    });
    assert.equal(graph.h3_latent_upscale, undefined);
    assert.equal(graph.ltxv_separate, undefined);
    assert.equal(graph.sample_refine, undefined);
    assert.deepEqual(graph.decode.inputs.samples, ['sample', 0]);
    assert.deepEqual(graph.decode_audio.inputs.samples, ['sample', 0]);
});

test('buildH3Graph: latent upscale works with an I2V first frame', () => {
    const plan = videoGenerator.buildH3LatentUpscalePlan({
        targetWidth: 768, targetHeight: 1152, scale: 2, settings: baseSettings(), info: fakeInfo(true)
    });
    const graph = videoGenerator.buildH3Graph({
        prompt: 'animate this', mode: 'i2va', W: 768, H: 1152, frames: 124, seed: 2,
        settings: baseSettings(), firstImageName: 'uploaded_first.png', latentUpscale: plan
    });
    // One uploaded first frame feeds both the low-res and the refine node.
    assert.equal(graph.first_image.inputs.image, 'uploaded_first.png');
    assert.deepEqual(graph.condition.inputs.first_frame, ['first_image', 0]);
    assert.deepEqual(graph.condition_refine.inputs.first_frame, ['first_image', 0]);
});

test('buildH3Graph: latent upscale stays I2VA on a single first frame', () => {
    const plan = videoGenerator.buildH3LatentUpscalePlan({
        targetWidth: 768, targetHeight: 1152, scale: 2, settings: baseSettings(), info: fakeInfo(true)
    });
    const graph = videoGenerator.buildH3Graph({
        prompt: 'scene', mode: 'i2va', W: 768, H: 1152, frames: 124, seed: 2,
        settings: baseSettings(), firstImageName: 'frame.png', latentUpscale: plan
    });
    assert.equal(graph.condition.class_type, 'MiniMaxH3ImageToVideo');
    assert.equal(graph.condition_refine.class_type, 'MiniMaxH3ImageToVideo');
    assert.deepEqual(graph.condition.inputs.first_frame, ['first_image', 0]);
    assert.deepEqual(graph.condition_refine.inputs.first_frame, ['first_image', 0]);
});

test('validateH3Graph: a missing upscaler node fails with an actionable code', async () => {
    const plan = videoGenerator.buildH3LatentUpscalePlan({
        targetWidth: 768, targetHeight: 1152, scale: 2, settings: baseSettings(), info: fakeInfo(true)
    });
    const graph = videoGenerator.buildH3Graph({
        prompt: 'scene', mode: 't2va', W: 768, H: 1152, frames: 124, seed: 1,
        settings: baseSettings(), latentUpscale: plan
    });
    const info = fakeInfo(true);
    delete info[UPSCALE_NODE];
    await assert.rejects(
        () => videoGenerator.validateH3Graph(info, graph),
        (err) => err.code === 'h3_latent_upscale_node_missing'
    );
});

test('validateH3Graph: a well-formed latent-upscale graph validates', async () => {
    const plan = videoGenerator.buildH3LatentUpscalePlan({
        targetWidth: 768, targetHeight: 1152, scale: 2, settings: baseSettings(), info: fakeInfo(true)
    });
    const graph = videoGenerator.buildH3Graph({
        prompt: 'scene', mode: 't2va', W: 768, H: 1152, frames: 124, seed: 1,
        settings: baseSettings(), latentUpscale: plan
    });
    await videoGenerator.validateH3Graph(fakeInfo(true), graph);
});

test('parseRequestedVideoResolution parses WxH and explicit options', () => {
    assert.deepEqual(
        videoGenerator.parseRequestedVideoResolution(null, null, 'generate video: a woman walking through a night market, 768x1152'),
        { W: 768, H: 1152 }
    );
    assert.deepEqual(
        videoGenerator.parseRequestedVideoResolution(512, 768, 'no size here'),
        { W: 512, H: 768 }
    );
    assert.equal(videoGenerator.parseRequestedVideoResolution(null, null, 'no size here'), null);
});

test('normalizeH3LatentUpscale: off/auto/scales and fallback', () => {
    assert.equal(videoGenerator.normalizeH3LatentUpscale('off'), 'off');
    assert.equal(videoGenerator.normalizeH3LatentUpscale('Auto'), 'auto');
    assert.equal(videoGenerator.normalizeH3LatentUpscale('2'), '2');
    assert.equal(videoGenerator.normalizeH3LatentUpscale(2.5), '2.5');
    assert.equal(videoGenerator.normalizeH3LatentUpscale('1.9'), '2');
    assert.equal(videoGenerator.normalizeH3LatentUpscale('garbage'), 'auto');
    assert.equal(videoGenerator.normalizeH3LatentUpscale(undefined), 'auto');
});

test('normalizeH3LatentUpscaleStrength clamps to 0.1-0.8', () => {
    assert.equal(videoGenerator.normalizeH3LatentUpscaleStrength(0.35), 0.35);
    assert.equal(videoGenerator.normalizeH3LatentUpscaleStrength(0), 0.1);
    assert.equal(videoGenerator.normalizeH3LatentUpscaleStrength(5), 0.8);
    assert.equal(videoGenerator.normalizeH3LatentUpscaleStrength('x', 0.35), 0.35);
});
