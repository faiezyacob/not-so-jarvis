/* ============================================
   JARVIS — H3 attention backend selection
   Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const videoGenerator = require('../services/video-generator');

const CK_VALUE = videoGenerator.H3_CK_ATTENTION_VALUE;

function infoWith(classes) {
    return classes || {};
}

function ckNode(choices) {
    return {
        ModelAttentionBackend: {
            input: { required: { attention: [choices || ['pytorch attention', CK_VALUE]] } }
        }
    };
}

test('normalizeH3AttentionBackend: legacy names resolve to auto', () => {
    for (const value of ['auto', 'standard', 'normal', 'pytorch', '', undefined, 'nonsense']) {
        assert.equal(videoGenerator.normalizeH3AttentionBackend(value), 'auto', 'value=' + String(value));
    }
});

test('normalizeH3AttentionBackend: aliases map to their concrete backend', () => {
    assert.equal(videoGenerator.normalizeH3AttentionBackend('kitchen'), 'comfykitchen');
    assert.equal(videoGenerator.normalizeH3AttentionBackend('comfy-kitchen'), 'comfykitchen');
    assert.equal(videoGenerator.normalizeH3AttentionBackend('CK'), 'comfykitchen');
    assert.equal(videoGenerator.normalizeH3AttentionBackend('sage'), 'sageattention');
    assert.equal(videoGenerator.normalizeH3AttentionBackend('sageattention'), 'sageattention');
    assert.equal(videoGenerator.normalizeH3AttentionBackend('sla'), 'sla');
    assert.equal(videoGenerator.normalizeH3AttentionBackend('h3sla'), 'sla');
});

test('resolveH3AttentionBackend: auto prefers comfy kitchen when offered', () => {
    assert.equal(
        videoGenerator.resolveH3AttentionBackend(ckNode(), 'auto'),
        'comfykitchen'
    );
});

test('resolveH3AttentionBackend: auto falls back to sageattention', () => {
    assert.equal(
        videoGenerator.resolveH3AttentionBackend(infoWith({ PathchSageAttentionKJ: {} }), 'auto'),
        'sageattention'
    );
});

test('resolveH3AttentionBackend: auto falls back to standard when nothing is installed', () => {
    assert.equal(videoGenerator.resolveH3AttentionBackend(infoWith({}), 'auto'), 'standard');
    assert.equal(videoGenerator.resolveH3AttentionBackend(null, 'auto'), 'standard');
});

test('resolveH3AttentionBackend: a kitchen node without the option is not auto-selected', () => {
    const info = ckNode(['pytorch attention']);
    assert.equal(videoGenerator.attentionBackendAvailable(info, 'comfykitchen'), false);
    // No sageattention either -> standard.
    assert.equal(videoGenerator.resolveH3AttentionBackend(info, 'auto'), 'standard');
});

test('resolveH3AttentionBackend: explicit choices pass through untouched', () => {
    assert.equal(videoGenerator.resolveH3AttentionBackend(infoWith({}), 'sla'), 'sla');
    assert.equal(videoGenerator.resolveH3AttentionBackend(infoWith({}), 'sageattention'), 'sageattention');
    assert.equal(videoGenerator.resolveH3AttentionBackend(infoWith({}), 'comfykitchen'), 'comfykitchen');
    // The legacy "standard" spelling normalizes to auto, then resolves to the
    // concrete dense fallback when no accelerated node is installed.
    assert.equal(videoGenerator.resolveH3AttentionBackend(infoWith({}), 'standard'), 'standard');
});

test('attentionBackendAvailable: standard is always available', () => {
    assert.equal(videoGenerator.attentionBackendAvailable(infoWith({}), 'standard'), true);
    assert.equal(videoGenerator.attentionBackendAvailable(infoWith({}), 'sla'), false);
    assert.equal(videoGenerator.attentionBackendAvailable(infoWith({ H3SLAAttention: {} }), 'sla'), true);
});

test('applyAttentionPatch: comfykitchen inserts ModelAttentionBackend', () => {
    const graph = {};
    const node = videoGenerator.applyAttentionPatch(graph, 'model', 'comfykitchen');
    assert.equal(node, 'ck_attention');
    assert.equal(graph.ck_attention.class_type, 'ModelAttentionBackend');
    assert.equal(graph.ck_attention.inputs.attention, CK_VALUE);
    assert.deepEqual(graph.ck_attention.inputs.model, ['model', 0]);
});

test('applyAttentionPatch: sageattention and sla keep their own nodes', () => {
    const sageGraph = {};
    assert.equal(videoGenerator.applyAttentionPatch(sageGraph, 'model', 'sageattention'), 'sage_attention');
    assert.equal(sageGraph.sage_attention.class_type, 'PathchSageAttentionKJ');

    const slaGraph = {};
    assert.equal(videoGenerator.applyAttentionPatch(slaGraph, 'model', 'sla'), 'sla_attention');
    assert.equal(slaGraph.sla_attention.class_type, 'H3SLAAttention');
});

test('applyAttentionPatch: auto and standard leave the model chain untouched', () => {
    for (const backend of ['auto', 'standard']) {
        const graph = {};
        assert.equal(videoGenerator.applyAttentionPatch(graph, 'model', backend), 'model');
        assert.deepEqual(graph, {});
    }
});

test('buildH3Graph: undefined attentionBackend produces no attention node', () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a kite over a field',
        mode: 't2va',
        settings: { h3Unet: 'base.safetensors' }
    });
    assert.equal(graph.ck_attention, undefined);
    assert.equal(graph.sage_attention, undefined);
    assert.equal(graph.sla_attention, undefined);
    assert.deepEqual(graph.guider.inputs.model, ['model', 0]);
});

test('buildH3Graph: a resolved comfykitchen backend wires the node into the guider', () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a city at night',
        mode: 't2va',
        settings: { h3Unet: 'base.safetensors', attentionBackend: 'comfykitchen' }
    });
    assert.equal(graph.ck_attention.class_type, 'ModelAttentionBackend');
    assert.deepEqual(graph.guider.inputs.model, ['ck_attention', 0]);
});
