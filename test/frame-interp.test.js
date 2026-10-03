/* ============================================
   JARVIS — Frame Interpolation (RIFE VFI)
   Covers the multiplier normalization, the
   input-name resolution against /object_info,
   the graph builder (fps doubling / audio pass-
   through), availability/model resolution and
   graph validation.
   Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const videoGenerator = require('../services/video-generator');

const NODE = videoGenerator.H3_FRAME_INTERP_NODE;

// A modern RIFE VFI node spec (extra required widgets) plus the surrounding
// core nodes the graph uses.
function rifeInfo(overrides) {
    return Object.assign({
        [NODE]: {
            input: {
                required: {
                    ckpt_name: [['rife47.pth', 'rife49.pth'], { default: 'rife49.pth' }],
                    frames: ['IMAGE'],
                    clear_cache_after_n_frames: ['INT', { default: 10 }],
                    multiplier: ['INT', { default: 2 }],
                    fast_mode: ['BOOLEAN', { default: true }],
                    ensemble: ['BOOLEAN', { default: true }],
                    scale_factor: [[0.25, 0.5, 1.0], { default: 1.0 }],
                    dtype: [['float32', 'float16'], { default: 'float32' }],
                    torch_compile: ['BOOLEAN', { default: false }],
                    batch_size: ['INT', { default: 1 }]
                }
            }
        },
        VHS_LoadVideo: {},
        CreateVideo: {},
        SaveVideo: {}
    }, overrides || {});
}

// --- Multiplier normalization ------------------------------------------------

test('normalizeFrameInterpMultiplier: defaults to double (2x)', () => {
    assert.equal(videoGenerator.normalizeFrameInterpMultiplier(undefined), 2);
    assert.equal(videoGenerator.normalizeFrameInterpMultiplier('nonsense'), 2);
    assert.equal(videoGenerator.normalizeFrameInterpMultiplier(2), 2);
});

test('normalizeFrameInterpMultiplier: honors 2/3/4 and rejects the rest', () => {
    assert.equal(videoGenerator.normalizeFrameInterpMultiplier(3), 3);
    assert.equal(videoGenerator.normalizeFrameInterpMultiplier('4'), 4);
    assert.equal(videoGenerator.normalizeFrameInterpMultiplier(5), 2);
    assert.equal(videoGenerator.normalizeFrameInterpMultiplier(1), 2);
});

// --- Graph builder -----------------------------------------------------------

test('buildFrameInterpGraph: doubles fps by default and wires audio through', () => {
    const built = videoGenerator.buildFrameInterpGraph('clip.mp4', {
        fps: 24,
        nodeSpec: rifeInfo()[NODE]
    });
    const graph = built.graph;
    assert.equal(built.multiplier, 2);
    assert.equal(built.outputFps, 48);
    assert.equal(graph.rife.class_type, NODE);
    assert.deepEqual(graph.rife.inputs.frames, ['src', 0]);
    assert.deepEqual(graph.video.inputs.images, ['rife', 0]);
    assert.equal(graph.video.inputs.fps, 48);
    assert.deepEqual(graph.video.inputs.audio, ['src', 2]);
    assert.equal(graph.save.class_type, 'SaveVideo');
});

test('buildFrameInterpGraph: multiplier 3 renders at 3x the frame rate', () => {
    const built = videoGenerator.buildFrameInterpGraph('clip.mp4', {
        fps: 24,
        multiplier: 3,
        nodeSpec: rifeInfo()[NODE]
    });
    assert.equal(built.multiplier, 3);
    assert.equal(built.outputFps, 72);
    assert.equal(built.graph.video.inputs.fps, 72);
});

test('buildFrameInterpGraph: no audio link when hasAudio is false', () => {
    const built = videoGenerator.buildFrameInterpGraph('clip.mp4', {
        fps: 24,
        hasAudio: false,
        nodeSpec: rifeInfo()[NODE]
    });
    assert.equal(built.graph.video.inputs.audio, undefined);
});

// --- Input-name resolution ---------------------------------------------------

test('buildFrameInterpInputs: fills required widgets from declared defaults', () => {
    const inputs = videoGenerator.buildFrameInterpInputs(['src', 0], {
        model: 'rife49.pth',
        multiplier: 2,
        nodeSpec: rifeInfo()[NODE]
    });
    assert.deepEqual(inputs.ckpt_name, 'rife49.pth');
    assert.equal(inputs.multiplier, 2);
    assert.equal(inputs.clear_cache_after_n_frames, 10);
    assert.equal(inputs.fast_mode, true);
    assert.equal(inputs.ensemble, true);
    assert.equal(inputs.scale_factor, 1.0);
    assert.equal(inputs.dtype, 'float32');
    assert.equal(inputs.torch_compile, false);
    assert.equal(inputs.batch_size, 1);
});

test('buildFrameInterpInputs: resolves renamed image/ckpt fields', () => {
    const renamed = {
        input: {
            required: {
                ckpt: [['rife49.pth'], { default: 'rife49.pth' }],
                image: ['IMAGE'],
                multiplier: ['INT', { default: 2 }]
            }
        }
    };
    const inputs = videoGenerator.buildFrameInterpInputs(['src', 0], {
        model: 'rife49.pth',
        multiplier: 2,
        nodeSpec: renamed
    });
    assert.deepEqual(inputs.image, ['src', 0]);
    assert.equal(inputs.ckpt, 'rife49.pth');
    assert.equal(inputs.multiplier, 2);
});

// --- Availability / model resolution ----------------------------------------

test('frameInterpAvailability: ready only when the RIFE node is loaded', () => {
    assert.equal(videoGenerator.frameInterpAvailability({}).ready, false);
    const ready = videoGenerator.frameInterpAvailability(rifeInfo());
    assert.equal(ready.ready, true);
    assert.equal(ready.nodePresent, true);
});

test('resolveFrameInterpModel: prefers the configured checkpoint when listed', () => {
    const info = rifeInfo();
    assert.equal(videoGenerator.resolveFrameInterpModel(info, 'rife47.pth'), 'rife47.pth');
    assert.equal(videoGenerator.resolveFrameInterpModel(info, 'rife49.pth'), 'rife49.pth');
});

test('resolveFrameInterpModel: falls back to a listed checkpoint, not an unlisted name', () => {
    const info = rifeInfo({
        [NODE]: {
            input: {
                required: {
                    ckpt_name: [['rife47.pth', 'rife426.pth'], { default: 'rife49.pth' }],
                    frames: ['IMAGE']
                }
            }
        }
    });
    // rife49.pth is not offered -> falls back to a list entry.
    assert.ok(['rife47.pth', 'rife426.pth'].includes(videoGenerator.resolveFrameInterpModel(info, 'rife49.pth')));
});

test('frameInterpChoices: returns an empty array when the node is absent', () => {
    assert.deepEqual(videoGenerator.frameInterpChoices({}), []);
});

// --- Graph validation --------------------------------------------------------

test('validateFrameInterpGraph: throws frameinterp_failed when a node is missing', () => {
    const built = videoGenerator.buildFrameInterpGraph('clip.mp4', {
        fps: 24,
        nodeSpec: rifeInfo()[NODE]
    });
    const incomplete = rifeInfo();
    delete incomplete[NODE];
    assert.throws(
        () => videoGenerator.validateFrameInterpGraph(incomplete, built.graph),
        (err) => err.code === 'frameinterp_failed' && err.missingNodes.includes(NODE)
    );
});

test('validateFrameInterpGraph: accepts a graph wired to the source clip', () => {
    const built = videoGenerator.buildFrameInterpGraph('clip.mp4', {
        fps: 24,
        nodeSpec: rifeInfo()[NODE]
    });
    videoGenerator.validateFrameInterpGraph(rifeInfo(), built.graph);
});
