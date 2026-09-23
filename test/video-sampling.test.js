/* ============================================
   JARVIS — H3 video sampling settings
   Covers the base Steps / CFG controls exposed
   in Settings > Video: normalization, defaults,
   and the BasicGuider -> CFGGuider switch.
   Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const videoGenerator = require('../services/video-generator');

test('normalizeH3Steps: clamps to 1-100 and falls back when unusable', () => {
    assert.equal(videoGenerator.normalizeH3Steps(30), 30);
    assert.equal(videoGenerator.normalizeH3Steps(0), 1);
    assert.equal(videoGenerator.normalizeH3Steps(101), 100);
    assert.equal(videoGenerator.normalizeH3Steps('6.4'), 6);
    assert.equal(videoGenerator.normalizeH3Steps('nope'), videoGenerator.H3_DEFAULT_STEPS);
});

test('normalizeH3Cfg: a non-negative guidance scale with fallback', () => {
    assert.equal(videoGenerator.normalizeH3Cfg(3.5), 3.5);
    assert.equal(videoGenerator.normalizeH3Cfg(1), 1);
    assert.equal(videoGenerator.normalizeH3Cfg(-1), 0);
    assert.equal(videoGenerator.normalizeH3Cfg('x'), videoGenerator.H3_DEFAULT_CFG);
});

test('H3_DEFAULTS expose the base sampling controls', () => {
    assert.equal(videoGenerator.H3_DEFAULTS.h3Steps, videoGenerator.H3_DEFAULT_STEPS);
    assert.equal(videoGenerator.H3_DEFAULTS.h3Cfg, videoGenerator.H3_DEFAULT_CFG);
});

test('buildH3Graph: default settings use the unguided BasicGuider', () => {
    const graph = videoGenerator.buildH3Graph({ prompt: 'a kite', mode: 't2va', settings: {} });
    assert.equal(graph.guider.class_type, 'BasicGuider');
    assert.deepEqual(graph.guider.inputs.conditioning, ['condition', 0]);
    assert.equal(graph.negative, undefined);
    assert.equal(graph.scheduler.inputs.steps, videoGenerator.H3_DEFAULT_STEPS);
});

test('buildH3Graph: h3Steps drives the scheduler step count', () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a kite',
        mode: 't2va',
        settings: { h3Steps: 30 }
    });
    assert.equal(graph.scheduler.inputs.steps, 30);
});

test('buildH3Graph: h3Cfg above 1 switches to CFGGuider with a zeroed negative', () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a kite',
        mode: 't2va',
        settings: { h3Cfg: 3.5 }
    });
    assert.equal(graph.guider.class_type, 'CFGGuider');
    assert.equal(graph.guider.inputs.cfg, 3.5);
    assert.deepEqual(graph.guider.inputs.positive, ['condition', 0]);
    assert.deepEqual(graph.guider.inputs.negative, ['negative', 0]);
    assert.equal(graph.negative.class_type, 'ConditioningZeroOut');
    assert.deepEqual(graph.negative.inputs.conditioning, ['condition', 0]);
});

test('buildH3Graph: an explicit cfg of 1 stays on BasicGuider', () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a kite',
        mode: 't2va',
        settings: { h3Cfg: 1 }
    });
    assert.equal(graph.guider.class_type, 'BasicGuider');
    assert.equal(graph.negative, undefined);
});
