/* ============================================
   JARVIS - video upscale target dimensions
   Covers the RTX "target dimensions" mode that
   lands every source resolution on the same
   output size (e.g. 2160 -> 3840x2160 for 16:9).
   Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JARVIS_CONFIG_PATH = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-video-upscale-')), 'config.json');

const videoGenerator = require('../services/video-generator');

test('normalizeVideoUpscaleMode: target or multiplier only', () => {
    assert.equal(videoGenerator.normalizeVideoUpscaleMode('target'), 'target');
    assert.equal(videoGenerator.normalizeVideoUpscaleMode('multiplier'), 'multiplier');
    assert.equal(videoGenerator.normalizeVideoUpscaleMode('MultipLier'), 'multiplier');
    assert.equal(videoGenerator.normalizeVideoUpscaleMode('nonsense', 'multiplier'), 'multiplier');
    assert.equal(videoGenerator.normalizeVideoUpscaleMode('', undefined), 'target');
});

test('rtxTargetDimensions: 16:9 source targets short side 2160 (4K UHD)', () => {
    assert.deepEqual(
        videoGenerator.rtxTargetDimensions(1920, 1080, 2160),
        { width: 3840, height: 2160, shortSide: 2160 }
    );
    // Different initial resolution, same target size.
    assert.deepEqual(
        videoGenerator.rtxTargetDimensions(1280, 720, 2160),
        { width: 3840, height: 2160, shortSide: 2160 }
    );
});

test('rtxTargetDimensions: portrait and square keep the source aspect', () => {
    assert.deepEqual(
        videoGenerator.rtxTargetDimensions(1080, 1920, 2160),
        { width: 2160, height: 3840, shortSide: 2160 }
    );
    assert.deepEqual(
        videoGenerator.rtxTargetDimensions(1024, 1024, 2160),
        { width: 2160, height: 2160, shortSide: 2160 }
    );
});

test('rtxTargetDimensions: unknown source dimensions fall back to null', () => {
    assert.equal(videoGenerator.rtxTargetDimensions(0, 0, 2160), null);
    assert.equal(videoGenerator.rtxTargetDimensions(1920, 0, 2160), null);
});

test('buildRtxVideoUpscaleGraph: target mode emits exact width/height', () => {
    const built = videoGenerator.buildRtxVideoUpscaleGraph('clip.mp4', {
        targetWidth: 3840,
        targetHeight: 2160,
        quality: 'ULTRA',
        fps: 16,
        hasAudio: true
    });
    const vsr = built.graph.vsr;
    assert.equal(vsr.class_type, 'RTXVideoSuperResolution');
    assert.equal(vsr.inputs.resize_type, 'target dimensions');
    assert.equal(vsr.inputs['resize_type.width'], 3840);
    assert.equal(vsr.inputs['resize_type.height'], 2160);
    assert.equal(vsr.inputs['resize_type.scale'], undefined);
    assert.equal(built.scale, null);
    assert.equal(built.targetWidth, 3840);
    assert.equal(built.targetHeight, 2160);
});

test('buildRtxVideoUpscaleGraph: multiplier mode is unchanged', () => {
    const built = videoGenerator.buildRtxVideoUpscaleGraph('clip.mp4', {
        scale: 2,
        quality: 'ULTRA',
        fps: 16,
        hasAudio: true
    });
    const vsr = built.graph.vsr;
    assert.equal(vsr.inputs.resize_type, 'scale by multiplier');
    assert.equal(vsr.inputs['resize_type.scale'], 2);
    assert.equal(vsr.inputs['resize_type.width'], undefined);
    assert.equal(built.scale, 2);
    assert.equal(built.targetWidth, null);
});

test('expectedUpscaleDims: RTX target mode reports the target size', () => {
    const dims = videoGenerator.expectedUpscaleDims(1280, 720, {
        engine: 'rtx',
        mode: 'target',
        resolution: 2160
    });
    assert.deepEqual(dims, { width: 3840, height: 2160 });
});

test('expectedUpscaleDims: RTX multiplier mode still scales both sides', () => {
    const dims = videoGenerator.expectedUpscaleDims(1280, 720, {
        engine: 'rtx',
        mode: 'multiplier',
        scale: 2
    });
    assert.deepEqual(dims, { width: 2560, height: 1440 });
});
