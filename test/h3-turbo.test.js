/* ============================================
   JARVIS — MiniMax H3 Turbo LoRA support
   Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const videoGenerator = require('../services/video-generator');

function baseSettings(extra) {
    return Object.assign({ h3Unet: 'base.safetensors' }, extra || {});
}

test('normalizeH3Turbo: off by default and only an explicit truthy value enables it', () => {
    assert.equal(videoGenerator.normalizeH3Turbo({}).enabled, false);
    assert.equal(videoGenerator.normalizeH3Turbo({ h3TurboEnabled: false }).enabled, false);
    assert.equal(videoGenerator.normalizeH3Turbo({ h3TurboEnabled: 'no' }).enabled, false);
    assert.equal(videoGenerator.normalizeH3Turbo({ h3TurboEnabled: true }).enabled, true);
    assert.equal(videoGenerator.normalizeH3Turbo({ h3TurboEnabled: 1 }).enabled, true);
    assert.equal(videoGenerator.normalizeH3Turbo({ h3TurboEnabled: 'true' }).enabled, true);
});

test('normalizeH3Turbo: defaults to the recommended checkpoint and 6 steps', () => {
    const turbo = videoGenerator.normalizeH3Turbo({ h3TurboEnabled: true });
    assert.equal(turbo.loraName, videoGenerator.H3_TURBO_DEFAULT_LORA);
    assert.equal(turbo.steps, videoGenerator.H3_TURBO_DEFAULT_STEPS);
});

test('normalizeH3TurboSteps: clamps to the 4-8 range', () => {
    assert.equal(videoGenerator.normalizeH3TurboSteps(4), 4);
    assert.equal(videoGenerator.normalizeH3TurboSteps(8), 8);
    assert.equal(videoGenerator.normalizeH3TurboSteps(1), 4);
    assert.equal(videoGenerator.normalizeH3TurboSteps(99), 8);
    assert.equal(videoGenerator.normalizeH3TurboSteps('6.4'), 6);
    assert.equal(videoGenerator.normalizeH3TurboSteps('nope'), videoGenerator.H3_TURBO_DEFAULT_STEPS);
});

test('buildH3Graph: Turbo off leaves the stock sampler and step count untouched', () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a kite over a field',
        mode: 't2va',
        settings: baseSettings()
    });
    assert.equal(graph.h3_turbo_lora, undefined);
    assert.equal(graph.sampler_select.class_type, 'KSamplerSelect');
    assert.equal(graph.sampler_select.inputs.sampler_name, 'res_multistep');
    assert.equal(graph.scheduler.inputs.steps, videoGenerator.H3_DEFAULT_STEPS);
    assert.equal(graph.scheduler.inputs.scheduler, 'simple');
});

test('buildH3Graph: Turbo on inserts the LoRA and the Turbo sampler', () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a kite over a field',
        mode: 't2va',
        settings: baseSettings({ h3TurboEnabled: true, h3TurboSteps: 8 })
    });
    assert.equal(graph.h3_turbo_lora.class_type, 'MiniMaxH3TurboLoRA');
    assert.equal(graph.h3_turbo_lora.inputs.lora_name, videoGenerator.H3_TURBO_DEFAULT_LORA);
    assert.equal(graph.h3_turbo_lora.inputs.strength, videoGenerator.H3_TURBO_STRENGTH);
    assert.equal(graph.h3_turbo_lora.inputs.low_vram, false);
    assert.deepEqual(graph.h3_turbo_lora.inputs.model, ['model', 0]);

    assert.equal(graph.sampler_select.class_type, 'MiniMaxH3TurboSampler');
    assert.deepEqual(graph.sampler_select.inputs, {});

    assert.equal(graph.scheduler.inputs.steps, 8);
    assert.equal(graph.scheduler.inputs.scheduler, 'simple');
    // Both guider and scheduler read the Turbo-adapted model when no attention
    // patch is present.
    assert.deepEqual(graph.guider.inputs.model, ['h3_turbo_lora', 0]);
    assert.deepEqual(graph.scheduler.inputs.model, ['h3_turbo_lora', 0]);
});

test('buildH3Graph: Turbo composes with the attention patch', () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a city at night',
        mode: 't2va',
        settings: baseSettings({ h3TurboEnabled: true, attentionBackend: 'comfykitchen' })
    });
    assert.equal(graph.ck_attention.class_type, 'ModelAttentionBackend');
    // Attention sits after the Turbo LoRA...
    assert.deepEqual(graph.ck_attention.inputs.model, ['h3_turbo_lora', 0]);
    // ...the guider reads the patched model...
    assert.deepEqual(graph.guider.inputs.model, ['ck_attention', 0]);
    // ...and the scheduler reads the Turbo model (not the attention patch).
    assert.deepEqual(graph.scheduler.inputs.model, ['h3_turbo_lora', 0]);
});

test('buildH3Graph: Turbo keeps the custom LoRA filename', () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a kite',
        mode: 't2va',
        settings: baseSettings({ h3TurboEnabled: true, h3TurboLora: 'custom/turbo.safetensors' })
    });
    assert.equal(graph.h3_turbo_lora.inputs.lora_name, 'custom/turbo.safetensors');
});

test('appendH3TurboLora: no-op when Turbo is off', () => {
    const graph = {};
    assert.equal(videoGenerator.appendH3TurboLora(graph, 'model', {}), 'model');
    assert.deepEqual(graph, {});
});

test('resolveH3TurboAvailability: disabled is always ready', () => {
    const state = videoGenerator.resolveH3TurboAvailability({}, { h3TurboEnabled: false });
    assert.equal(state.enabled, false);
    assert.equal(state.ready, true);
});

test('assertH3TurboReady: missing nodes raise h3_turbo_nodes_missing', () => {
    const settings = { h3TurboEnabled: true };
    assert.throws(
        () => videoGenerator.assertH3TurboReady({}, settings),
        (err) => err.code === 'h3_turbo_nodes_missing' && err.missingNodes.length === 2
    );
});

test('assertH3TurboReady: a missing LoRA raises h3_turbo_lora_missing', () => {
    const info = {
        MiniMaxH3TurboLoRA: {},
        MiniMaxH3TurboSampler: {},
        LoraLoader: { input: { required: { lora_name: [['other.safetensors']] } } }
    };
    assert.throws(
        () => videoGenerator.assertH3TurboReady(info, { h3TurboEnabled: true }),
        (err) => err.code === 'h3_turbo_lora_missing' && /models\/loras/.test(err.message)
    );
});

test('assertH3TurboReady: present nodes and LoRA pass (basename match)', () => {
    const info = {
        MiniMaxH3TurboLoRA: {},
        MiniMaxH3TurboSampler: {},
        LoraLoader: { input: { required: { lora_name: [['h3/' + videoGenerator.H3_TURBO_DEFAULT_LORA]] } } }
    };
    const state = videoGenerator.assertH3TurboReady(info, { h3TurboEnabled: true });
    assert.equal(state.ready, true);
});
