/* ============================================
   JARVIS — MiniMax H3 First Block Cache
   Covers the nested setting normalization, the
   custom-mode validation, MODEL-chain insertion,
   attention/Turbo composition, node detection,
   graph validation and the long-video builder.
   Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const videoGenerator = require('../services/video-generator');
const longWorkflow = require('../services/long-video/h3-longvideos-workflow');

const NODE = 'ApplyMiniMaxH3FirstBlockCache';
const FAST = videoGenerator.H3_FBCACHE_PRESET_FAST;
const CUSTOM = videoGenerator.H3_FBCACHE_CUSTOM;

function baseSettings(extra) {
    return Object.assign({ h3Unet: 'base.safetensors' }, extra || {});
}

function fbc(extra) {
    return Object.assign({ enabled: true, mode: FAST }, extra || {});
}

// --- Normalization -----------------------------------------------------------

test('normalizeFirstBlockCache: defaults match the recommended H3 Fast preset', () => {
    const config = videoGenerator.normalizeFirstBlockCache();
    assert.equal(config.enabled, false);
    assert.equal(config.mode, FAST);
    assert.equal(config.threshold, 0.10);
    assert.equal(config.startPercent, 0.10);
    assert.equal(config.endPercent, 0.95);
    assert.equal(config.maxConsecutiveHits, 2);
    assert.equal(config.temporalGuard, false);
});

test('normalizeFirstBlockCache: only an explicit truthy value enables it', () => {
    assert.equal(videoGenerator.normalizeFirstBlockCache({ enabled: false }).enabled, false);
    assert.equal(videoGenerator.normalizeFirstBlockCache({ enabled: 'no' }).enabled, false);
    assert.equal(videoGenerator.normalizeFirstBlockCache({ enabled: true }).enabled, true);
    assert.equal(videoGenerator.normalizeFirstBlockCache({ enabled: 1 }).enabled, true);
    assert.equal(videoGenerator.normalizeFirstBlockCache({ enabled: 'true' }).enabled, true);
});

test('normalizeFirstBlockCache: short aliases resolve to the exact node mode', () => {
    assert.equal(videoGenerator.normalizeFirstBlockCacheMode('safe'), videoGenerator.H3_FBCACHE_PRESET_SAFE);
    assert.equal(videoGenerator.normalizeFirstBlockCacheMode('H3 Aggressive'), videoGenerator.H3_FBCACHE_PRESET_AGGRESSIVE);
    assert.equal(videoGenerator.normalizeFirstBlockCacheMode('experimental'), videoGenerator.H3_FBCACHE_EXPERIMENTAL);
    assert.equal(videoGenerator.normalizeFirstBlockCacheMode('custom'), CUSTOM);
    assert.equal(videoGenerator.normalizeFirstBlockCacheMode('nonsense'), FAST);
});

test('normalizeFirstBlockCache: numeric fields are clamped', () => {
    const config = videoGenerator.normalizeFirstBlockCache({
        enabled: true,
        threshold: 5,
        startPercent: -1,
        endPercent: 9,
        maxConsecutiveHits: 99
    });
    assert.equal(config.threshold, 1);
    assert.equal(config.startPercent, 0);
    assert.equal(config.endPercent, 1);
    assert.equal(config.maxConsecutiveHits, 20);
});

// --- Custom validation -------------------------------------------------------

test('validateFirstBlockCache: named presets are never validated or sent raw', () => {
    assert.deepEqual(videoGenerator.validateFirstBlockCache(fbc({ mode: FAST })), []);
    assert.deepEqual(videoGenerator.validateFirstBlockCache({ enabled: false, mode: CUSTOM }), []);
});

test('validateFirstBlockCache: custom mode enforces the node constraints', () => {
    const valid = fbc({
        mode: CUSTOM,
        threshold: 0.2,
        startPercent: 0.1,
        endPercent: 0.8,
        maxConsecutiveHits: 3
    });
    assert.deepEqual(videoGenerator.validateFirstBlockCache(valid), []);

    const inverted = videoGenerator.validateFirstBlockCache(fbc({
        mode: CUSTOM, threshold: 0.2, startPercent: 0.9, endPercent: 0.4, maxConsecutiveHits: 2
    }));
    assert.ok(inverted.some((message) => /Start %/.test(message)));

    const outOfRange = videoGenerator.validateFirstBlockCache(fbc({
        mode: CUSTOM, threshold: 2, startPercent: -1, endPercent: 0.5, maxConsecutiveHits: 0
    }));
    assert.equal(outOfRange.length, 3);
});

// --- Node detection / availability -------------------------------------------

test('firstBlockCacheNodeAvailable: keys off the ComfyUI class name', () => {
    assert.equal(videoGenerator.firstBlockCacheNodeAvailable({}), false);
    assert.equal(videoGenerator.firstBlockCacheNodeAvailable(null), false);
    assert.equal(videoGenerator.firstBlockCacheNodeAvailable({ [NODE]: {} }), true);
});

test('resolveFirstBlockCacheAvailability: disabled is always ready', () => {
    const state = videoGenerator.resolveFirstBlockCacheAvailability({}, baseSettings());
    assert.equal(state.enabled, false);
    assert.equal(state.ready, true);
});

test('assertFirstBlockCacheReady: a missing node raises h3_fbcache_node_missing', () => {
    assert.throws(
        () => videoGenerator.assertFirstBlockCacheReady({}, baseSettings({ firstBlockCache: fbc() })),
        (err) => err.code === 'h3_fbcache_node_missing' &&
            err.missingNodes.includes(NODE) &&
            /Then restart ComfyUI/.test(err.message)
    );
});

test('assertFirstBlockCacheReady: the installed node passes', () => {
    const state = videoGenerator.assertFirstBlockCacheReady(
        { [NODE]: {} },
        baseSettings({ firstBlockCache: fbc() })
    );
    assert.equal(state.ready, true);
});

test('assertFirstBlockCacheReady: invalid custom values raise h3_fbcache_invalid', () => {
    assert.throws(
        () => videoGenerator.assertFirstBlockCacheReady({ [NODE]: {} }, baseSettings({
            firstBlockCache: fbc({ mode: CUSTOM, startPercent: 0.9, endPercent: 0.2, maxConsecutiveHits: 2 })
        })),
        (err) => err.code === 'h3_fbcache_invalid'
    );
});

// --- Graph insertion ---------------------------------------------------------

test('appendFirstBlockCache: no-op when disabled', () => {
    const graph = {};
    assert.equal(videoGenerator.appendFirstBlockCache(graph, 'model', {}), 'model');
    assert.deepEqual(graph, {});
});

test('appendFirstBlockCache: every required input is present for named presets', () => {
    const graph = {};
    assert.equal(
        videoGenerator.appendFirstBlockCache(graph, 'model', baseSettings({ firstBlockCache: fbc() })),
        'h3_first_block_cache'
    );
    const inputs = graph.h3_first_block_cache.inputs;
    assert.equal(graph.h3_first_block_cache.class_type, NODE);
    assert.deepEqual(inputs.model, ['model', 0]);
    assert.equal(inputs.mode, FAST);
    // ComfyUI validates required inputs; the node ignores these unless Custom,
    // but they must be sent or the prompt fails validation.
    assert.equal(inputs.threshold, 0.10);
    assert.equal(inputs.start_percent, 0.10);
    assert.equal(inputs.end_percent, 0.95);
    assert.equal(inputs.max_consecutive_hits, 2);
    assert.equal(inputs.temporal_guard, false);
});

test('resolveFirstBlockCacheInputNames: uses the node\'s declared input keys', () => {
    const info = {
        [NODE]: {
            input: {
                required: {
                    model: ['MODEL'],
                    mode: [['H3 Fast — 0.10 / max 2']],
                    threshold: ['FLOAT'],
                    startpercent: ['FLOAT'],
                    end_percent: ['FLOAT'],
                    maxconsecutivehits: ['INT'],
                    temporalguard: ['BOOLEAN']
                }
            }
        }
    };
    const names = videoGenerator.resolveFirstBlockCacheInputNames(info);
    assert.equal(names.threshold, 'threshold');
    assert.equal(names.startPercent, 'startpercent');
    assert.equal(names.endPercent, 'end_percent');
    assert.equal(names.maxConsecutiveHits, 'maxconsecutivehits');
    assert.equal(names.temporalGuard, 'temporalguard');
});

test('buildH3Graph: FBCache sends the node\'s own input names from /object_info', () => {
    const names = {
        threshold: 'threshold',
        startPercent: 'startpercent',
        endPercent: 'end_percent',
        maxConsecutiveHits: 'maxconsecutivehits',
        temporalGuard: 'temporalguard'
    };
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a kite',
        mode: 't2va',
        settings: baseSettings({ firstBlockCache: fbc() }),
        firstBlockCacheInputs: names
    });
    const inputs = graph.h3_first_block_cache.inputs;
    assert.equal(inputs.startpercent, 0.10);
    assert.equal(inputs.maxconsecutivehits, 2);
    assert.equal(inputs.temporalguard, false);
    assert.equal(inputs.end_percent, 0.95);
});

test('resolveFirstBlockCacheInputNames: canonical names without ComfyUI info', () => {
    const names = videoGenerator.resolveFirstBlockCacheInputNames(null);
    assert.deepEqual(names, {
        threshold: 'threshold',
        startPercent: 'start_percent',
        endPercent: 'end_percent',
        maxConsecutiveHits: 'max_consecutive_hits',
        temporalGuard: 'temporal_guard'
    });
});

test('appendFirstBlockCache: Custom mode passes the five manual inputs', () => {
    const graph = {};
    videoGenerator.appendFirstBlockCache(graph, 'model', baseSettings({
        firstBlockCache: fbc({
            mode: CUSTOM,
            threshold: 0.15,
            startPercent: 0.05,
            endPercent: 0.9,
            maxConsecutiveHits: 4,
            temporalGuard: true
        })
    }));
    const inputs = graph.h3_first_block_cache.inputs;
    assert.equal(inputs.mode, CUSTOM);
    assert.equal(inputs.threshold, 0.15);
    assert.equal(inputs.start_percent, 0.05);
    assert.equal(inputs.end_percent, 0.9);
    assert.equal(inputs.max_consecutive_hits, 4);
    assert.equal(inputs.temporal_guard, true);
});

// --- buildH3Graph composition ------------------------------------------------

test('Test A: FBCache off + SageAttention matches the previous workflow', () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a kite over a field',
        mode: 't2va',
        settings: baseSettings({ attentionBackend: 'sageattention' })
    });
    assert.equal(graph.h3_first_block_cache, undefined);
    assert.deepEqual(graph.sage_attention.inputs.model, ['model', 0]);
    assert.deepEqual(graph.guider.inputs.model, ['sage_attention', 0]);
});

test('Test B: FBCache on + SageAttention patches the model before the attention node', () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a kite over a field',
        mode: 't2va',
        settings: baseSettings({ attentionBackend: 'sageattention', firstBlockCache: fbc() })
    });
    assert.equal(graph.h3_first_block_cache.class_type, NODE);
    assert.deepEqual(graph.h3_first_block_cache.inputs.model, ['model', 0]);
    // The attention node reads the patched model, and the guider reads attention.
    assert.deepEqual(graph.sage_attention.inputs.model, ['h3_first_block_cache', 0]);
    assert.deepEqual(graph.guider.inputs.model, ['sage_attention', 0]);
    // The scheduler reads the FBCache model (attention is not SLA).
    assert.deepEqual(graph.scheduler.inputs.model, ['h3_first_block_cache', 0]);
});

test('Test C: Turbo + SageAttention + FBCache all stay enabled', () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a city at night',
        mode: 't2va',
        settings: baseSettings({
            h3TurboEnabled: true,
            h3TurboSteps: 8,
            attentionBackend: 'sageattention',
            firstBlockCache: fbc()
        })
    });
    assert.equal(graph.h3_first_block_cache.class_type, NODE);
    assert.deepEqual(graph.h3_turbo_lora.inputs.model, ['h3_first_block_cache', 0]);
    assert.deepEqual(graph.sage_attention.inputs.model, ['h3_turbo_lora', 0]);
    assert.deepEqual(graph.guider.inputs.model, ['sage_attention', 0]);
    assert.deepEqual(graph.scheduler.inputs.model, ['h3_turbo_lora', 0]);
    assert.equal(graph.sampler_select.class_type, 'MiniMaxH3TurboSampler');
});

test('Test D: SLA + Turbo + FBCache keeps SLA as the scheduler model', () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a storm over the sea',
        mode: 't2va',
        settings: baseSettings({
            h3TurboEnabled: true,
            attentionBackend: 'sla',
            firstBlockCache: fbc()
        })
    });
    assert.equal(graph.sla_attention.class_type, 'H3SLAAttention');
    assert.deepEqual(graph.sla_attention.inputs.model, ['h3_turbo_lora', 0]);
    assert.deepEqual(graph.scheduler.inputs.model, ['sla_attention', 0]);
});

test('Test E: I2VA keeps the first frame while FBCache patches the model', () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: '<Picture 1> a woman turns to the camera',
        mode: 'i2va',
        firstImageName: 'jarvis_video_source.png',
        settings: baseSettings({ attentionBackend: 'sageattention', firstBlockCache: fbc() })
    });
    assert.deepEqual(graph.condition.inputs.first_frame, ['first_image', 0]);
    assert.equal(graph.first_image.inputs.image, 'jarvis_video_source.png');
    assert.equal(graph.h3_first_block_cache.class_type, NODE);
    assert.deepEqual(graph.sage_attention.inputs.model, ['h3_first_block_cache', 0]);
});

// --- validateH3Graph ---------------------------------------------------------

test('validateH3Graph: the installed FBCache node passes and wires through', async () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a kite',
        mode: 't2va',
        settings: baseSettings({ firstBlockCache: fbc() })
    });
    const info = { [NODE]: {}, UNETLoader: {}, CLIPLoader: {}, VAELoader: {}, RandomNoise: {}, KSamplerSelect: {}, MiniMaxH3ImageToVideo: {}, BasicScheduler: {}, BasicGuider: {}, SamplerCustomAdvanced: {}, VAEDecode: {}, VAEDecodeAudio: {}, CreateVideo: {}, SaveVideo: {} };
    await assert.doesNotReject(() => videoGenerator.validateH3Graph(info, graph));
});

test('validateH3Graph: a missing FBCache node gets the friendly install error', async () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a kite',
        mode: 't2va',
        settings: baseSettings({ firstBlockCache: fbc() })
    });
    await assert.rejects(
        () => videoGenerator.validateH3Graph({}, graph),
        (err) => err.code === 'h3_fbcache_node_missing'
    );
});

test('validateH3Graph: duplicate FBCache nodes are rejected', async () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a kite',
        mode: 't2va',
        settings: baseSettings({ firstBlockCache: fbc() })
    });
    graph.copy = { class_type: NODE, inputs: { model: ['h3_first_block_cache', 0], mode: FAST } };
    await assert.rejects(
        () => videoGenerator.validateH3Graph({ [NODE]: {} }, graph),
        (err) => err.code === 'h3_fbcache_duplicate'
    );
});

test('validateH3Graph: an unconnected FBCache output is rejected', async () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a kite',
        mode: 't2va',
        settings: baseSettings({ firstBlockCache: fbc() })
    });
    // Detach every consumer of the FBCache node.
    for (const node of Object.values(graph)) {
        for (const [key, value] of Object.entries(node.inputs || {})) {
            if (Array.isArray(value) && value[0] === 'h3_first_block_cache') {
                node.inputs[key] = ['model', 0];
            }
        }
    }
    await assert.rejects(
        () => videoGenerator.validateH3Graph({ [NODE]: {} }, graph),
        (err) => err.code === 'h3_fbcache_output_unconnected'
    );
});

test('findConflictingCacheNodes: flags other cache implementations only', () => {
    assert.deepEqual(videoGenerator.findConflictingCacheNodes({}), []);
    assert.deepEqual(videoGenerator.findConflictingCacheNodes({ fbc: { class_type: NODE } }), []);
    assert.deepEqual(
        videoGenerator.findConflictingCacheNodes({ a: { class_type: 'EasyCache' }, b: { class_type: 'CacheDiTNode' } }).sort(),
        ['CacheDiTNode', 'EasyCache']
    );
});

test('validateH3Graph: a conflicting cache node is rejected', async () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'a kite',
        mode: 't2va',
        settings: baseSettings({ firstBlockCache: fbc() })
    });
    graph.other_cache = { class_type: 'EasyCache', inputs: {} };
    await assert.rejects(
        () => videoGenerator.validateH3Graph({ [NODE]: {}, EasyCache: {} }, graph),
        (err) => err.code === 'h3_fbcache_cache_conflict'
    );
});

// --- Long video / continuation builder ---------------------------------------

test('buildLongVideoGraph: FBCache patches the model before the LongVideos node', () => {
    const graph = longWorkflow.buildLongVideoGraph({
        prompt: 'a train crosses a bridge',
        settings: baseSettings({ attentionBackend: 'sageattention', firstBlockCache: fbc() })
    });
    assert.equal(graph.h3_first_block_cache.class_type, NODE);
    assert.deepEqual(graph.sage_attention.inputs.model, ['h3_first_block_cache', 0]);
    assert.deepEqual(graph.longvideos.inputs.model, ['sage_attention', 0]);
});

test('buildLongVideoGraph: FBCache off leaves the model chain untouched', () => {
    const graph = longWorkflow.buildLongVideoGraph({
        prompt: 'a train crosses a bridge',
        settings: baseSettings({ attentionBackend: 'comfykitchen' })
    });
    assert.equal(graph.h3_first_block_cache, undefined);
    assert.equal(graph.longvideos.inputs.model[0], 'ck_attention');
});

test('buildLongVideoGraph: every build returns a fresh graph (no shared cache state)', () => {
    const settings = baseSettings({ firstBlockCache: fbc() });
    const first = longWorkflow.buildLongVideoGraph({ prompt: 'segment one', settings });
    const second = longWorkflow.buildLongVideoGraph({ prompt: 'segment two', settings });
    assert.notEqual(first, second);
    assert.notEqual(first.h3_first_block_cache, second.h3_first_block_cache);
    assert.equal(first.prompt.inputs.value, 'segment one');
    assert.equal(second.prompt.inputs.value, 'segment two');
});

// --- Diagnostics -------------------------------------------------------------

test('videoAccelerationInfo + formatAccelerationDiagnostics describe the stack', () => {
    const info = videoGenerator.videoAccelerationInfo(
        baseSettings({ attentionBackend: 'sageattention', h3TurboEnabled: true, h3TurboSteps: 6, firstBlockCache: fbc() }),
        'sageattention'
    );
    assert.equal(info.firstBlockCache, FAST);
    assert.equal(info.attention, 'SageAttention');
    assert.equal(info.turbo, true);
    const text = videoGenerator.formatAccelerationDiagnostics(info);
    assert.match(text, /First Block Cache: H3 Fast/);
    assert.match(text, /Attention: SageAttention/);
    assert.match(text, /Turbo LoRA: Enabled/);
});

test('videoAccelerationInfo: disabled reports Off', () => {
    const info = videoGenerator.videoAccelerationInfo(baseSettings({ attentionBackend: 'sla' }), 'sla');
    assert.equal(info.firstBlockCache, null);
    assert.equal(info.attention, 'SLA');
    assert.match(videoGenerator.formatAccelerationDiagnostics(info), /First Block Cache: Off/);
});
