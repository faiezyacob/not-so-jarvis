/* ============================================
   JARVIS — FastH3 8-Step V2 video settings + graph
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const videoGenerator = require('../services/video-generator');

const FASTH3_UNET = 'fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors';

test('FastH3 defaults are off and match the trained 8-step schedule', () => {
    const defaults = videoGenerator.getVideoDefaults();
    assert.equal(defaults.fastH3Enabled, false);
    assert.equal(defaults.fastH3Unet, FASTH3_UNET);
    assert.equal(defaults.fastH3Steps, 8);
    assert.equal(defaults.fastH3SigmaVideo, 10);
    assert.equal(defaults.fastH3SigmaAudio, 3);
});

test('selectH3Model: FastH3 applies to T2VA only, never I2VA', () => {
    const base = { h3Unet: 'base.safetensors', fastH3Unet: FASTH3_UNET, fastH3Enabled: true };
    assert.deepEqual(videoGenerator.selectH3Model(base, 't2va'), { useFastH3: true, unetName: FASTH3_UNET });
    assert.deepEqual(videoGenerator.selectH3Model(base, 'i2va'), { useFastH3: false, unetName: 'base.safetensors' });
    assert.deepEqual(
        videoGenerator.selectH3Model({ h3Unet: 'base.safetensors', fastH3Enabled: false }, 't2va'),
        { useFastH3: false, unetName: 'base.safetensors' }
    );
});

test('buildH3Graph: FastH3 inserts the sigma shift and drops to 8 steps', () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a kite over a field',
        mode: 't2va',
        settings: { fastH3Enabled: true, fastH3Unet: FASTH3_UNET, fastH3Steps: 8, fastH3SigmaVideo: 10, fastH3SigmaAudio: 3 }
    });
    assert.equal(graph.model.inputs.unet_name, FASTH3_UNET);
    assert.ok(graph.sigma_shift, 'MiniMaxH3SigmaShift node is present');
    assert.equal(graph.sigma_shift.class_type, 'MiniMaxH3SigmaShift');
    assert.equal(graph.sigma_shift.inputs.shift_video, 10);
    assert.equal(graph.sigma_shift.inputs.shift_audio, 3);
    assert.deepEqual(graph.sigma_shift.inputs.model, ['model', 0]);
    assert.equal(graph.scheduler.inputs.steps, 8);
    assert.deepEqual(graph.scheduler.inputs.model, ['sigma_shift', 0]);
    assert.deepEqual(graph.guider.inputs.model, ['sigma_shift', 0]);
});

test('buildH3Graph: I2VA keeps the base model even when FastH3 is enabled', () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'wind moves the grass',
        mode: 'i2va',
        firstImageName: 'frame.png',
        settings: { h3Unet: 'base.safetensors', fastH3Enabled: true, fastH3Unet: FASTH3_UNET }
    });
    assert.equal(graph.model.inputs.unet_name, 'base.safetensors');
    assert.equal(graph.sigma_shift, undefined);
    assert.equal(graph.scheduler.inputs.steps, videoGenerator.H3_DEFAULT_STEPS);
});

test('buildH3Graph: base graph is unchanged when FastH3 is off', () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a city at night',
        mode: 't2va',
        settings: { h3Unet: 'base.safetensors', fastH3Enabled: false }
    });
    assert.equal(graph.model.inputs.unet_name, 'base.safetensors');
    assert.equal(graph.sigma_shift, undefined);
    assert.equal(graph.scheduler.inputs.steps, videoGenerator.H3_DEFAULT_STEPS);
});
