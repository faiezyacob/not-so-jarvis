/* ============================================
   JARVIS — Long Video Director tests
   Covers the >15s duration router, beat
   segmentation, the Story Bible / storyboard
   lifecycle, H3 LongVideos prompt+graph
   composition, and approval classification.
   The LLM seam is stubbed so these run offline.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const providers = require('../server/providers');
const planStore = require('../services/long-video/plan');
const prompts = require('../services/long-video/prompts');
const motion = require('../services/long-video/motion');
const workflow = require('../services/long-video/h3-longvideos-workflow');
const longTake = require('../services/long-video/long-take');
const longTakeGraph = require('../services/long-video/long-take-graph');
const longTakeInstaller = require('../services/long-take');
const director = require('../services/long-video/director');

const originalChat = providers.chat;

test.afterEach(() => {
    providers.chat = originalChat;
});

function conversationId(name) {
    return 'long-video-test-' + name + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
}

// --- Duration router ---------------------------------------------------------

test('segmentDuration matches the documented splits', () => {
    assert.deepEqual(prompts.segmentDuration(10, 15), [10]);
    assert.deepEqual(prompts.segmentDuration(15, 15), [15]);
    assert.deepEqual(prompts.segmentDuration(20, 15), [10, 10]);
    assert.deepEqual(prompts.segmentDuration(25, 15), [13, 12]);
    assert.deepEqual(prompts.segmentDuration(30, 15), [15, 15]);
    assert.deepEqual(prompts.segmentDuration(40, 15), [13, 14, 13]);
    assert.deepEqual(prompts.segmentDuration(45, 15), [15, 15, 15]);
    assert.deepEqual(prompts.segmentDuration(60, 15), [15, 15, 15, 15]);
});

test('segmentDuration never exceeds the per-beat cap and always sums to the total', () => {
    for (const total of [16, 17, 29, 31, 58, 61, 90, 119]) {
        const parts = prompts.segmentDuration(total, 15);
        assert.equal(parts.reduce((a, b) => a + b, 0), total, 'sum for ' + total);
        assert.ok(parts.every((p) => p >= 1 && p <= 15), 'cap for ' + total);
        assert.equal(parts.length, Math.ceil(total / 15), 'fewest beats for ' + total);
    }
});

test('parseRequestedSeconds reads digits, minutes and words', () => {
    assert.equal(director.parseRequestedSeconds('make a 30 second movie'), 30);
    assert.equal(director.parseRequestedSeconds('a 45-second film'), 45);
    assert.equal(director.parseRequestedSeconds('render it 20s long'), 20);
    assert.equal(director.parseRequestedSeconds('a one minute video'), 60);
    assert.equal(director.parseRequestedSeconds('two minutes please'), 120);
    assert.equal(director.parseRequestedSeconds('half a minute clip'), 30);
    assert.equal(director.parseRequestedSeconds('make a minute long film'), 60);
    assert.equal(director.parseRequestedSeconds('a thirty second movie'), 30);
    assert.equal(director.parseRequestedSeconds('no duration here'), null);
});

test('parseRequestedSeconds ignores an age/decade "Ns", not a duration', () => {
    assert.equal(director.parseRequestedSeconds('a woman in her early 20s'), null);
    assert.equal(director.parseRequestedSeconds('a man in his 30s'), null);
    assert.equal(director.parseRequestedSeconds('a 90s aesthetic portrait'), null);
    // A real bare duration still reads.
    assert.equal(director.parseRequestedSeconds('render it 20s long'), 20);
    assert.equal(director.parseRequestedSeconds('a 30s clip'), 30);
});

test('duration router: a still-image prompt is never a long video', () => {
    const imagePrompt =
        'generate image: portrait of a woman in her early 20s. SCENE: a ryokan. ' +
        'STYLE: soft Korean makeup, gentle smartphone sharpening. 2:3.';
    assert.equal(director.isLongVideoRequest(imagePrompt), false);
});

test('duration router: <=15s stays on the existing workflow', () => {
    assert.equal(director.isLongVideoRequest('generate a 10 second video of a cat'), false);
    assert.equal(director.isLongVideoRequest('make a 15-second clip of rain'), false);
});

test('duration router: >15s routes to the Long Video Director', () => {
    assert.equal(director.isLongVideoRequest('Make a 20 second video of a train'), true);
    assert.equal(director.isLongVideoRequest('make a 30 second movie of a woman walking through Tokyo'), true);
    assert.equal(director.isLongVideoRequest('create a 60 second film of a storm'), true);
});

test('duration router ignores prompt meta-requests, questions and still images', () => {
    assert.equal(director.isLongVideoRequest('write me a prompt for a 30 second video'), false);
    assert.equal(director.isLongVideoRequest('what is a 30 second video?'), false);
    assert.equal(director.isLongVideoRequest('make her wear a red kimono for 30 seconds'), false);
    assert.equal(director.isLongVideoRequest('make a 30 second movie poster'), false);
});

// --- Beat budget -------------------------------------------------------------

test('mergeBeatsWithBudget forces the requested total and the 15s cap', () => {
    const llmBeats = [
        { action: 'a' }, { action: 'b' }, { action: 'c' }
    ];
    const beats = director.mergeBeatsWithBudget(llmBeats, 40);
    assert.equal(beats.reduce((a, b) => a + b.duration, 0), 40);
    assert.ok(beats.every((b) => b.duration <= 15));
    assert.deepEqual(beats.map((b) => b.duration), [13, 14, 13]);
    assert.equal(beats[0].startTime, 0);
    assert.equal(beats[beats.length - 1].endTime, 40);
});

// --- Prompt composition ------------------------------------------------------

test('composeLongVideoPrompt: first paragraph is the scene, one paragraph per beat, no [Shot N]', () => {
    const bible = {
        characters: [{ name: 'Mara', appearance: 'tall, red hair', clothing: 'green jacket' }],
        environment: { location: 'a rainy Tokyo street', timeOfDay: 'night', weather: 'rain', lighting: 'neon' },
        props: ['an umbrella'],
        visualStyle: 'anamorphic',
        cameraStyle: 'handheld',
        continuityRules: [],
        storySummary: 'A woman walks through Tokyo.'
    };
    const beats = prompts.heuristicBeats(bible, 20);
    const prompt = prompts.composeLongVideoPrompt(bible, beats, { request: 'A woman walks through Tokyo.' });
    const paragraphs = prompt.split('\n\n');
    assert.equal(paragraphs.length, 1 + beats.length);
    assert.match(paragraphs[0], /Mara/);
    assert.match(paragraphs[0], /rainy Tokyo/);
    assert.doesNotMatch(prompt, /\[Shot \d\]/);
});

// --- Workflow graph ----------------------------------------------------------

test('buildLongVideoGraph wires the installed H3LongVideos node into the H3 stack', () => {
    const graph = workflow.buildLongVideoGraph({
        prompt: 'scene\n\nbeat',
        seed: 7,
        settings: { h3Unet: 'u.safetensors', h3Clip: 'c.safetensors', h3VideoVae: 'v.safetensors', h3AudioVae: 'a.safetensors' },
        resolution: '9:16',
        megapixels: 0.75,
        shotSeconds: 10,
        steps: 8
    });
    assert.equal(graph.longvideos.class_type, 'H3LongVideos');
    assert.equal(graph.prompt.class_type, 'PrimitiveStringMultiline');
    assert.equal(graph.prompt.inputs.value, 'scene\n\nbeat');
    assert.deepEqual(graph.longvideos.inputs.prompt, ['prompt', 0]);
    assert.deepEqual(graph.longvideos.inputs.model, ['model', 0]);
    assert.equal(graph.longvideos.inputs.resolution, '9:16');
    assert.equal(graph.longvideos.inputs.shot_seconds, 10);
    assert.equal(graph.longvideos.inputs.first_frame, undefined);
    assert.equal(graph.save.class_type, 'SaveVideo');
});

test('buildLongVideoGraph adds a first_image reference and the LoRA chain when present', () => {
    const graph = workflow.buildLongVideoGraph({
        prompt: 'scene',
        seed: 1,
        settings: { loras: [{ name: 'x.safetensors', strength: 0.8, on: true }] },
        firstImageName: 'ref.png'
    });
    assert.equal(graph.first_image.class_type, 'LoadImage');
    assert.deepEqual(graph.longvideos.inputs.first_frame, ['first_image', 0]);
    assert.equal(graph.lora1.class_type, 'LoraLoaderModelOnly');
    assert.deepEqual(graph.longvideos.inputs.model, ['lora1', 0]);
});

test('pickResolution honours an explicit aspect and falls back to source ratio', () => {
    assert.equal(workflow.pickResolution({ aspectRatio: '9:16' }), '9:16');
    assert.equal(workflow.pickResolution({ sourceWidth: 1920, sourceHeight: 1080 }), '16:9');
    assert.equal(workflow.pickResolution({ sourceWidth: 1080, sourceHeight: 1920 }), '9:16');
    assert.equal(workflow.pickResolution({}), '16:9');
});

// --- H3 Long-Take re-anchor --------------------------------------------------

const longTakeBible = {
    characters: [{
        id: 'character_1',
        name: 'Mara',
        appearance: 'tall, red hair',
        clothing: 'green jacket',
        persistentAttributes: ['a scar above the left eyebrow']
    }],
    environment: { location: 'a rainy Tokyo street', timeOfDay: 'night', weather: 'rain', lighting: 'neon' },
    props: [],
    visualStyle: 'anamorphic',
    cameraStyle: 'handheld',
    continuityRules: [],
    storySummary: 'A woman walks through Tokyo.'
};

test('longTake.buildCharacterMemory pins identity, wardrobe and persistent attributes', () => {
    const memory = longTake.buildCharacterMemory(longTakeBible);
    assert.match(memory, /Mara/);
    assert.match(memory, /tall, red hair/);
    assert.match(memory, /green jacket/);
    assert.match(memory, /scar above the left eyebrow/);
});

test('longTake.buildAnchor pins scene, lighting, style and camera language', () => {
    const anchor = longTake.buildAnchor(longTakeBible);
    assert.match(anchor, /night/);
    assert.match(anchor, /rain/);
    assert.match(anchor, /rainy Tokyo street/);
    assert.match(anchor, /neon/);
    assert.match(anchor, /anamorphic/);
    assert.match(anchor, /handheld/);
});

test('longTake composers are empty-safe and never invent detail', () => {
    assert.equal(longTake.buildAnchor({}), '');
    assert.equal(longTake.buildAnchor(null), '');
    assert.equal(longTake.buildCharacterMemory({}), '');
    assert.equal(longTake.buildCharacterMemory({ characters: [{ name: 'Mara' }] }), 'Mara');
});

test('normalizeLongTakeSettings defaults on and honours the explicit override', () => {
    assert.equal(longTake.normalizeLongTakeSettings({}).reanchor, true);
    assert.equal(longTake.normalizeLongTakeSettings({ longTake: { reanchor: false } }).reanchor, false);
    assert.equal(longTake.normalizeLongTakeSettings({ longTake: { reanchor: true } }).reanchor, true);
});

test('buildLongTakeContext produces the re-anchor wires and lock flags', () => {
    const ctx = longTake.buildLongTakeContext({ bible: longTakeBible, settings: {} });
    assert.equal(ctx.enabled, true);
    assert.equal(ctx.identityLocked, true);
    assert.equal(ctx.sceneLocked, true);
    assert.match(ctx.characterMemory, /Mara/);
    assert.match(ctx.anchor, /rainy Tokyo/);
    const off = longTake.buildLongTakeContext({
        bible: longTakeBible,
        settings: { longTake: { reanchor: false } }
    });
    assert.equal(off.enabled, false);
    assert.equal(off.characterMemory, '');
    assert.equal(off.anchor, '');
});

test('buildLongVideoGraph wires the re-anchor channels only when provided', () => {
    const withReanchor = workflow.buildLongVideoGraph({
        prompt: 'scene\n\nbeat',
        seed: 3,
        characterMemory: 'Mara: green jacket',
        anchor: 'night, rainy Tokyo, neon'
    });
    assert.equal(withReanchor.longvideos.inputs.character_memory, 'Mara: green jacket');
    assert.equal(withReanchor.longvideos.inputs.anchor, 'night, rainy Tokyo, neon');

    const without = workflow.buildLongVideoGraph({ prompt: 'scene', seed: 3 });
    assert.equal(without.longvideos.inputs.character_memory, undefined);
    assert.equal(without.longvideos.inputs.anchor, undefined);
});

// --- H3 LongTake engine ------------------------------------------------------

const longTakeNodesInfo = {
    MiniMaxH3MotionContext: {},
    MiniMaxH3MotionContextTrim: {},
    H3BlendLatentsByFrames: {}
};

function buildLT(overrides) {
    return workflow.buildLongTakeGraph(Object.assign({
        prompt: 'A woman walks through an apartment.\n\nShe reaches the window.\n\nThe camera follows her.',
        beats: [{ duration: 10 }, { duration: 10 }],
        seed: 5,
        settings: {},
        resolution: '16:9',
        megapixels: 1.0,
        steps: 20
    }, overrides || {}));
}

test('buildLongTakeGraph unrolls one motion-context segment per beat', () => {
    const graph = buildLT();
    assert.equal(graph.motion_0.class_type, 'MiniMaxH3MotionContext');
    assert.equal(graph.motion_1.class_type, 'MiniMaxH3MotionContext');
    assert.equal(graph.motion_0.inputs.context_length, '22');
    // Beat 1 opens from beat 0's sampler-output latent, not a decoded frame.
    assert.equal(graph.motion_0.inputs.context_latent, undefined);
    assert.deepEqual(graph.motion_1.inputs.context_latent, ['sample_0', 0]);
    // Each beat samples its own conditioning latent.
    assert.deepEqual(graph.sample_0.inputs.latent_image, ['condition_0', 1]);
});

test('buildLongTakeGraph adds the reference refine resample only when enabled', () => {
    // Refine is opt-in (off by default).
    const off = buildLT();
    assert.equal(off.refine_0, undefined);
    assert.equal(off.blend_0, undefined);
    assert.deepEqual(off.decode_0.inputs.samples, ['sample_0', 0]);

    const graph = buildLT({ settings: { longTake: { refine: true } } });
    assert.equal(graph.scheduler_refine_0.class_type, 'BasicScheduler');
    assert.equal(graph.scheduler_refine_0.inputs.denoise, 0.5);
    assert.equal(graph.scheduler_refine_0.inputs.steps, 2);
    assert.deepEqual(graph.refine_0.inputs.latent_image, ['sample_0', 0]);
});

test('buildLongTakeGraph blends raw sample into refined latent by frame', () => {
    const graph = buildLT({ settings: { longTake: { refine: true } } });
    assert.equal(graph.blend_0.class_type, 'H3BlendLatentsByFrames');
    assert.equal(graph.blend_0.inputs.keyframes, '0:0, 22:0, 44:1');
    assert.deepEqual(graph.blend_0.inputs.latent1, ['sample_0', 0]);
    assert.deepEqual(graph.blend_0.inputs.latent2, ['refine_0', 1]);
    assert.equal(graph.blend_0.inputs.audio_source, 'latent1');
    assert.equal(graph.blend_0.inputs.blend_audio, false);
    // The blended latent is what the next beat pins.
    assert.equal(graph.motion_1.inputs.context_latent[0], 'blend_0');
});

test('buildLongTakeGraph trims the pinned head and joins beats into one video', () => {
    const graph = buildLT();
    assert.equal(graph.trim_0.class_type, 'MiniMaxH3MotionContextTrim');
    assert.deepEqual(graph.trim_0.inputs.trim_frames, ['motion_0', 1]);
    assert.deepEqual(graph.trim_0.inputs.audio, ['decode_audio_0', 0]);
    assert.equal(graph.imgcat_1.class_type, 'ImageBatch');
    assert.equal(graph.audiocat_1.class_type, 'AudioConcat');
    assert.deepEqual(graph.video.inputs.images, ['imgcat_1', 0]);
    assert.deepEqual(graph.video.inputs.audio, ['audiocat_1', 0]);
    assert.equal(graph.save.class_type, 'SaveVideo');
});

test('buildLongTakeGraph keeps the first frame on beat 0 only', () => {
    const withFrame = buildLT({ firstImageName: 'ref.png' });
    assert.deepEqual(withFrame.condition_0.inputs.first_frame, ['first_image', 0]);
    assert.equal(withFrame.condition_1.inputs.first_frame, undefined);
});

test('buildLongTakeGraph handles a single beat without concat nodes', () => {
    const graph = buildLT({ beats: [{ duration: 12 }], prompt: 'A single continuous scene.' });
    assert.equal(graph.video.inputs.images[0], 'trim_0');
    assert.equal(graph.imgcat_1, undefined);
    assert.equal(graph.audiocat_1, undefined);
});

test('longTakeNodesAvailable + validateLongTakeGraph gate on the node packs', () => {
    const graph = buildLT();
    const info = {};
    for (const node of Object.values(graph)) {
        if (node && node.class_type) info[node.class_type] = {};
    }
    assert.equal(longTakeGraph.longTakeNodesAvailable(longTakeNodesInfo), true);
    assert.equal(longTakeGraph.longTakeNodesAvailable({}), false);
    assert.equal(workflow.validateLongTakeGraph(info, graph), true);
    assert.throws(() => workflow.validateLongTakeGraph({}, graph), (err) => err.code === 'longvideo_longtake_nodes_missing');
});

test('resolveLongVideoEngine prefers LongTake when installed and honours overrides', () => {
    assert.equal(workflow.resolveLongVideoEngine({}, null), 'h3longvideos');
    assert.equal(workflow.resolveLongVideoEngine({}, longTakeNodesInfo), 'longtake');
    assert.equal(workflow.resolveLongVideoEngine({ longVideoEngine: 'h3longvideos' }, longTakeNodesInfo), 'h3longvideos');
    assert.equal(workflow.resolveLongVideoEngine({ longVideoEngine: 'longtake' }, null), 'longtake');
});

test('buildLongTakeGraph applies the attention backend and mirrors the scheduler model', () => {
    const sage = buildLT({ settings: { attentionBackend: 'sageattention', longTake: { refine: true } } });
    assert.equal(sage.sage_attention.class_type, 'PathchSageAttentionKJ');
    assert.deepEqual(sage.guider_0.inputs.model, ['sage_attention', 0]);
    // Non-SLA: the scheduler reads the pre-attention model (the UNETLoader here).
    assert.deepEqual(sage.scheduler_0.inputs.model, ['model', 0]);
    assert.deepEqual(sage.scheduler_refine_0.inputs.model, ['model', 0]);

    const sla = buildLT({ settings: { attentionBackend: 'sla', longTake: { refine: true } } });
    assert.equal(sla.sla_attention.class_type, 'H3SLAAttention');
    assert.deepEqual(sla.guider_0.inputs.model, ['sla_attention', 0]);
    // SLA shapes the schedule: the scheduler also reads the patched model.
    assert.deepEqual(sla.scheduler_0.inputs.model, ['sla_attention', 0]);
});

test('long-take installer pins the motion-context pack to the ComfyUI layout', () => {
    assert.deepEqual(longTakeInstaller.parseVersion('0.34.2'), [0, 34, 2]);
    assert.equal(longTakeInstaller.versionAtLeast('0.34.0', [0, 34, 0]), true);
    assert.equal(longTakeInstaller.versionAtLeast('0.33.4', [0, 34, 0]), false);
    assert.equal(longTakeInstaller.versionAtLeast('0.40.1', [0, 34, 0]), true);
    const motion = longTakeInstaller.PACKS.find((p) => p.key === 'motionContext');
    assert.equal(motion.refFor('0.33.4'), 'v0.3.1');
    assert.equal(motion.refFor('0.34.0'), null);
    assert.equal(motion.refFor(''), null);
});

test('isLayoutMismatchError recognises the motion-context layout failure', () => {
    const err = new Error('h3_motion_context: the layout patch could not be applied, so interior anchors would be rejected by ComfyUI.');
    assert.equal(longTakeInstaller.isLayoutMismatchError(err), true);
    assert.equal(longTakeInstaller.isLayoutMismatchError(new Error('comfyui timeout')), false);
});

test('quarantineDuplicatePackDirs moves renamed/duplicate pack folders out of custom_nodes', () => {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-lt-'));
    const nodesDir = path.join(root, 'custom_nodes');
    fs.mkdirSync(path.join(nodesDir, 'ComfyUI-H3-Motion-Context'), { recursive: true });
    fs.mkdirSync(path.join(nodesDir, 'ComfyUI-H3-Motion-Context.bak-1'), { recursive: true });
    fs.mkdirSync(path.join(nodesDir, 'ComfyUI-H3-Motion-Context-main'), { recursive: true });
    fs.mkdirSync(path.join(nodesDir, 'SomeOtherPack'), { recursive: true });
    const moved = longTakeInstaller.quarantineDuplicatePackDirs(nodesDir, 'ComfyUI-H3-Motion-Context');
    assert.equal(moved.length, 2);
    assert.ok(fs.existsSync(path.join(nodesDir, 'ComfyUI-H3-Motion-Context')));
    assert.ok(fs.existsSync(path.join(nodesDir, 'SomeOtherPack')));
    assert.ok(!fs.existsSync(path.join(nodesDir, 'ComfyUI-H3-Motion-Context.bak-1')));
    assert.ok(!fs.existsSync(path.join(nodesDir, 'ComfyUI-H3-Motion-Context-main')));
    assert.ok(fs.existsSync(path.join(root, 'custom_nodes_disabled')));
    fs.rmSync(root, { recursive: true, force: true });
});

test('motionContextRefFor pins the pack to the ComfyUI H3 layout version', () => {
    assert.equal(longTakeInstaller.motionContextRefFor('0.33.4'), 'v0.3.1');
    assert.equal(longTakeInstaller.motionContextRefFor('0.34.0'), null);
    assert.equal(longTakeInstaller.motionContextRefFor(''), null);
});

test('buildLongTakeGraph can disable the refine/blend and tune its parameters', () => {
    const on = buildLT({ settings: { longTake: { refine: true } } });
    assert.ok(on.blend_0 && on.refine_0);
    const off = buildLT({ settings: { longTake: { refine: false } } });
    assert.equal(off.blend_0, undefined);
    assert.equal(off.refine_0, undefined);
    assert.deepEqual(off.motion_1.inputs.context_latent, ['sample_0', 0]);
    assert.deepEqual(off.decode_0.inputs.samples, ['sample_0', 0]);
    const tuned = buildLT({
        settings: { longTake: { refine: true, refineDenoise: 0.3, refineSteps: 4, blendKeyframes: '0:0, 40:0, 80:1' } }
    });
    assert.equal(tuned.scheduler_refine_0.inputs.denoise, 0.3);
    assert.equal(tuned.scheduler_refine_0.inputs.steps, 4);
    assert.equal(tuned.blend_0.inputs.keyframes, '0:0, 40:0, 80:1');
});

test('longTakeGraph.frameSize mirrors the node resolution presets', () => {
    assert.deepEqual(longTakeGraph.frameSize('16:9', 1.0), [1344, 768]);
    assert.deepEqual(longTakeGraph.frameSize('9:16', 1.0), [768, 1344]);
    assert.equal(longTakeGraph.frameSize('16:9', 0.5)[0] % 32, 0);
    assert.equal(longTakeGraph.frameSize('16:9', 0.5)[1] % 32, 0);
});



function stubPlanner({ bible, beats }) {
    providers.chat = async (provider, messages) => {
        const system = String((messages[0] && messages[0].content) || '');
        if (/Extract a persistent Story Bible/.test(system)) return JSON.stringify(bible);
        if (/Divide a video request/.test(system)) return JSON.stringify({ beats });
        if (/CURRENT Story Bible/.test(system)) return JSON.stringify({ storyBible: bible, beats });
        return '{}';
    };
}

test('createFromRequest builds an awaiting-approval storyboard with a valid total', async () => {
    const cid = conversationId('create');
    stubPlanner({
        bible: {
            characters: [{ id: 'character_1', name: 'Mara', appearance: 'tall', clothing: 'green jacket' }],
            environment: { location: 'a rainy Tokyo street', timeOfDay: 'night', weather: 'rain', lighting: 'neon' },
            props: [],
            visualStyle: 'anamorphic',
            cameraStyle: 'handheld',
            continuityRules: [],
            storySummary: 'A woman walks to a convenience store.'
        },
        beats: [
            { id: 1, duration: 10, action: 'Mara walks down the street.', camera: 'wide', continuity: '' },
            { id: 2, duration: 10, action: 'She reaches the store.', camera: 'medium', continuity: 'Same street.' }
        ]
    });
    const plan = await director.createFromRequest({
        conversationId: cid,
        message: 'Make a 20 second movie of a woman walking through Tokyo.',
        provider: 'ollama',
        model: 'test',
        think: false
    });
    assert.equal(plan.status, planStore.STATUS.AWAITING_STORYBOARD_APPROVAL);
    assert.equal(plan.duration, 20);
    assert.equal(plan.beats.length, 2);
    assert.equal(plan.beats.reduce((a, b) => a + b.duration, 0), 20);
    assert.equal(plan.composer, 'llm');
    assert.match(plan.prompt, /Mara/);
    assert.equal(director.isLongVideoRequest('Make a 20 second movie of a woman walking through Tokyo.'), true);
    assert.equal(planStore.isAwaitingStoryboard(plan), true);
    planStore.remove(cid);
});

test('applyStoryboardUpdate rewrites the storyboard instead of appending', async () => {
    const cid = conversationId('update');
    stubPlanner({
        bible: {
            characters: [{ id: 'character_1', name: 'Mara', appearance: 'tall', clothing: 'red kimono' }],
            environment: { location: 'a rainy Tokyo street', timeOfDay: 'night', weather: 'rain', lighting: 'neon' },
            props: [],
            visualStyle: 'anamorphic',
            cameraStyle: 'handheld',
            continuityRules: [],
            storySummary: 'A woman walks to a convenience store.'
        },
        beats: [
            { id: 1, duration: 15, action: 'Mara walks in a red kimono.', camera: 'wide', continuity: '' },
            { id: 2, duration: 15, action: 'She reaches the store.', camera: 'medium', continuity: 'Same street.' }
        ]
    });
    const plan = await director.createFromRequest({
        conversationId: cid,
        message: 'Make a 30 second movie of a woman walking through Tokyo.',
        provider: 'ollama',
        model: 'test',
        think: false
    });
    await director.applyStoryboardUpdate(plan, 'Make her wear a red kimono.', { provider: 'ollama', model: 'test', think: false });
    const updated = planStore.get(cid);
    assert.match(updated.prompt, /red kimono/);
    assert.equal(updated.beats.reduce((a, b) => a + b.duration, 0), 30);
    assert.equal(updated.status, planStore.STATUS.AWAITING_STORYBOARD_APPROVAL);
    planStore.remove(cid);
});

test('createFromRequest falls back deterministically when the planner LLM fails', async () => {
    const cid = conversationId('fallback');
    providers.chat = async () => { throw new Error('offline'); };
    const plan = await director.createFromRequest({
        conversationId: cid,
        message: 'Make a 40 second film of a lighthouse.',
        provider: 'ollama',
        model: 'test',
        think: false
    });
    assert.equal(plan.composer, 'fallback');
    assert.equal(plan.duration, 40);
    assert.deepEqual(plan.beats.map((b) => b.duration), [13, 14, 13]);
    assert.ok(plan.prompt.indexOf('\n\n') > 0);
    planStore.remove(cid);
});

test('applyStoryboardUpdate can re-budget the total duration', async () => {
    const cid = conversationId('rebudget');
    stubPlanner({
        bible: {
            characters: [], environment: { location: 'a desert', timeOfDay: 'day', weather: '', lighting: '' },
            props: [], visualStyle: '', cameraStyle: '', continuityRules: [], storySummary: 'A drive.'
        },
        beats: [{ id: 1, duration: 30, action: 'A car crosses the desert.', camera: 'wide', continuity: '' }]
    });
    const plan = await director.createFromRequest({
        conversationId: cid,
        message: 'Make a 30 second movie of a car crossing a desert.',
        provider: 'ollama', model: 'test', think: false
    });
    await director.applyStoryboardUpdate(plan, 'Make it 60 seconds instead.', { provider: 'ollama', model: 'test', think: false });
    const updated = planStore.get(cid);
    assert.equal(updated.duration, 60);
    assert.equal(updated.beats.reduce((a, b) => a + b.duration, 0), 60);
    assert.ok(updated.beats.every((b) => b.duration <= 15));
    planStore.remove(cid);
});

// --- Motion continuity -------------------------------------------------------

function panBeat(overrides) {
    return Object.assign({
        id: 1,
        duration: 10,
        action: 'A woman walks toward the window.',
        camera: 'medium shot',
        ending_motion_state: {
            camera: { movement: 'pan', direction: 'right_to_left', speed: 'slow', momentum: 'continuing', framing: 'medium shot' },
            subject: { movement: 'walk', direction: 'toward_window', speed: 'slow', pose: 'mid_step' },
            objects: [],
            environment: ''
        },
        ending_world_state: { clothing: 'blue dress', location: 'living room', props: [], objectStates: [], completedActions: [] }
    }, overrides || {});
}

test('reconcileMotionChain makes beat 2 start from beat 1\'s actual ending state', () => {
    const beats = [
        panBeat({ id: 1 }),
        {
            id: 2,
            duration: 10,
            action: 'The camera moves closer to the woman. She stops at the window.',
            camera: 'close medium',
            ending_motion_state: {
                camera: { movement: 'push_in', direction: 'forward', speed: 'slow', momentum: 'settling', framing: 'close medium shot' },
                subject: { movement: '', pose: 'standing at the window', gaze: 'toward_camera' }
            }
        }
    ];
    const chain = motion.reconcileMotionChain(beats, { subjectName: 'Mara' });
    const tr = chain[1].transition_from_previous;
    assert.ok(tr, 'beat 2 has a transition');
    assert.match(tr.initial_continuation, /panning right to left/i);
    assert.match(tr.initial_continuation, /Mara is slowly walking/i);
    // Pan settles before the push-in begins — never an instant reset.
    assert.match(tr.transition, /settles/i);
    assert.match(tr.transition, /push in/i);
    assert.match(tr.new_action, /moves closer/i);
    assert.match(tr.resulting_motion_state, /pushing in/i);
});

test('reconcileMotionChain describes a smooth camera reversal', () => {
    const beats = [
        panBeat({ id: 1 }),
        {
            id: 2,
            duration: 10,
            action: 'The camera tracks the other way.',
            ending_motion_state: { camera: { movement: 'pan', direction: 'left_to_right', speed: 'slow' } }
        }
    ];
    const chain = motion.reconcileMotionChain(beats);
    assert.match(chain[1].transition_from_previous.transition, /reverses direction/i);
    assert.match(chain[1].transition_from_previous.transition, /left to right/i);
});

test('reconcileMotionChain decelerates a moving camera to a stop', () => {
    const beats = [
        panBeat({ id: 1 }),
        {
            id: 2,
            duration: 10,
            action: 'Mara sits down.',
            ending_motion_state: {
                camera: { movement: 'static' },
                subject: { movement: 'sit', pose: 'seated' }
            }
        }
    ];
    const chain = motion.reconcileMotionChain(beats, { subjectName: 'Mara' });
    assert.match(chain[1].transition_from_previous.transition, /slows and the camera settles to a natural stop/i);
    assert.match(chain[1].transition_from_previous.resulting_motion_state, /holding still/i);
});

test('reconcileMotionChain preserves an explicit abrupt cut without fabricating continuity', () => {
    const beats = [
        panBeat({ id: 1 }),
        {
            id: 2,
            duration: 10,
            action: 'Then suddenly the camera cuts to a close-up of her face.',
            camera: 'close-up',
            transition_mode: 'abrupt_transition',
            ending_motion_state: { camera: { movement: 'static' } }
        }
    ];
    const chain = motion.reconcileMotionChain(beats, { subjectName: 'Mara' });
    assert.equal(chain[1].transition_mode, 'abrupt_transition');
    // No continuation prose is invented for a deliberate cut.
    assert.equal(chain[1].transition_from_previous.initial_continuation, '');
    assert.match(chain[1].transition_from_previous.new_action, /cuts to a close-up/i);
});

test('abrupt transitions are auto-detected from the request wording', () => {
    assert.equal(motion.resolveTransitionMode({ action: 'The camera cuts to a wide shot.' }), 'abrupt_transition');
    assert.equal(motion.resolveTransitionMode({ action: 'She keeps walking.' }), 'continuous_transition');
});

test('world state carries forward so completed actions are not re-executed', () => {
    const beats = [
        panBeat({ id: 1, ending_world_state: { clothing: 'blue dress', location: 'living room', objectStates: ['door open'], completedActions: ['opened the door'] } }),
        { id: 2, duration: 10, action: 'She steps through.', ending_world_state: { objectStates: ['she is inside'] } }
    ];
    const chain = motion.reconcileMotionChain(beats);
    assert.deepEqual(chain[1].ending_world_state.objectStates, ['door open', 'she is inside']);
    assert.deepEqual(chain[1].ending_world_state.completedActions, ['opened the door']);
    assert.equal(chain[1].ending_world_state.location, 'living room');
});

test('composeLongVideoPrompt writes the transition as prose and never leaks schema terms', () => {
    const beats = [
        panBeat({ id: 1 }),
        {
            id: 2,
            duration: 10,
            action: 'The camera moves closer to the woman.',
            ending_motion_state: { camera: { movement: 'push_in', direction: 'forward', speed: 'slow' } }
        }
    ];
    const chain = motion.reconcileMotionChain(beats, { subjectName: 'Mara' });
    const bible = {
        characters: [{ name: 'Mara', appearance: 'tall', clothing: 'blue dress' }],
        environment: { location: 'living room', timeOfDay: 'evening', weather: '', lighting: 'warm' },
        props: [], visualStyle: '', cameraStyle: '', continuityRules: [], storySummary: 'A woman walks to the window.'
    };
    const prompt = prompts.composeLongVideoPrompt(bible, chain, { request: 'A woman walks to the window.' });
    assert.match(prompt, /continues|continuing|continues its|settles/i);
    assert.doesNotMatch(prompt, /ending_motion_state|transition_from_previous|resulting_motion_state|motion_state/);
    // The transition lives in beat 2's paragraph, after the scene paragraph.
    const paragraphs = prompt.split('\n\n');
    assert.equal(paragraphs.length, 3);
    assert.match(paragraphs[2], /panning right to left/i);
});

test('composeLongVideoPrompt does not force continuation on an abrupt beat', () => {
    const beats = [
        panBeat({ id: 1 }),
        {
            id: 2,
            duration: 10,
            action: 'Then suddenly the camera cuts to a close-up of her face.',
            camera: 'close-up',
            transition_mode: 'abrupt_transition',
            ending_motion_state: { camera: { movement: 'static' } }
        }
    ];
    const chain = motion.reconcileMotionChain(beats, { subjectName: 'Mara' });
    const prompt = prompts.composeLongVideoPrompt({ characters: [], environment: {}, props: [], visualStyle: '', cameraStyle: '', continuityRules: [], storySummary: '' }, chain, { request: 'x' });
    const paragraphs = prompt.split('\n\n');
    assert.equal(paragraphs.length, 3);
    assert.doesNotMatch(paragraphs[2], /panning right to left/i);
    assert.match(paragraphs[2], /cuts to a close-up/i);
});

test('createFromRequest keeps the planner\'s motion states and reconciles the chain', async () => {
    const cid = conversationId('motion');
    stubPlanner({
        bible: {
            characters: [{ id: 'character_1', name: 'Mara', appearance: 'tall', clothing: 'blue dress' }],
            environment: { location: 'living room', timeOfDay: 'evening', weather: '', lighting: 'warm' },
            props: [], visualStyle: '', cameraStyle: '', continuityRules: [], storySummary: 'A woman walks to the window.'
        },
        beats: [
            {
                id: 1, duration: 10, action: 'Mara walks toward the window.', camera: 'medium shot',
                transition_mode: 'continuous_transition',
                ending_motion_state: { camera: { movement: 'pan', direction: 'right_to_left', speed: 'slow', momentum: 'continuing' }, subject: { movement: 'walk', direction: 'toward_window', speed: 'slow' } }
            },
            {
                id: 2, duration: 10, action: 'She stops and looks at the camera.', camera: 'close medium',
                transition_mode: 'continuous_transition',
                ending_motion_state: { camera: { movement: 'push_in', speed: 'slow' }, subject: { pose: 'standing', gaze: 'toward_camera' } }
            }
        ]
    });
    const plan = await director.createFromRequest({
        conversationId: cid,
        message: 'Make a 20 second movie of a woman walking to the window.',
        provider: 'ollama', model: 'test', think: false
    });
    assert.equal(plan.beats.length, 2);
    assert.equal(plan.beats[0].transition_from_previous, null);
    assert.equal(plan.beats[0].ending_motion_state.camera.movement, 'pan');
    assert.ok(plan.beats[1].transition_from_previous);
    assert.match(plan.beats[1].transition_from_previous.initial_continuation, /panning right to left/i);
    assert.match(plan.prompt, /panning right to left/i);
    assert.doesNotMatch(plan.prompt, /ending_motion_state/);
    planStore.remove(cid);
});

test('reconcileMotionChain preserves a planner-provided transition', () => {
    const beats = [
        panBeat({ id: 1 }),
        {
            id: 2,
            duration: 10,
            action: 'She stops.',
            transition_mode: 'continuous_transition',
            transition_from_previous: {
                initial_continuation: 'The camera keeps drifting left as the frame settles on her.',
                transition: 'The drift eases and the camera comes to rest.',
                new_action: 'She stops.',
                resulting_motion_state: 'The camera rests on her.'
            }
        }
    ];
    const chain = motion.reconcileMotionChain(beats);
    assert.match(chain[1].transition_from_previous.initial_continuation, /keeps drifting left/);
    assert.match(chain[1].transition_from_previous.transition, /drift eases/);
});

test('normalizeMotionState keeps acceleration/pose/gaze and drops junk', () => {
    const state = motion.normalizeMotionState({
        camera: { movement: 'pan', direction: 'left_to_right', speed: 'slow', acceleration: 'decelerating', momentum: 'settling', framing: 'wide', screenPosition: 'left third' },
        subject: { movement: 'walk', direction: 'forward', speed: 'slow', acceleration: 'constant', pose: 'mid_step', gaze: 'toward_camera', hands: 'right hand raised' },
        objects: ['a paper bag', null, ''],
        environment: 'rain'
    });
    assert.equal(state.camera.acceleration, 'decelerating');
    assert.equal(state.camera.screenPosition, 'left third');
    assert.equal(state.subject.gaze, 'toward camera');
    assert.equal(state.subject.hands, 'right hand raised');
    assert.deepEqual(state.objects, ['a paper bag']);
    assert.equal(state.environment, 'rain');
});

// --- Approval classification -------------------------------------------------

function makePlan(status) {
    return {
        id: 'lv-x',
        conversationId: 'cid-x',
        status,
        duration: 30,
        request: 'A 30 second movie',
        beats: [],
        stages: planStore.STAGE_DEFS.map((s) => ({ id: s.id, label: s.label, status: 'pending' }))
    };
}

test('classifyMessage maps approvals, retries, changes and cancels', () => {
    assert.equal(director.classifyMessage('yes, generate the video', makePlan(planStore.STATUS.AWAITING_STORYBOARD_APPROVAL)).action, 'approve');
    assert.equal(director.classifyMessage('make the final scene rainy', makePlan(planStore.STATUS.AWAITING_STORYBOARD_APPROVAL)).action, 'modify_plan');
    assert.equal(director.classifyMessage('cancel it', makePlan(planStore.STATUS.AWAITING_STORYBOARD_APPROVAL)).action, 'cancel');
    assert.equal(director.classifyMessage('retry', makePlan(planStore.STATUS.FAILED)).action, 'retry');
    assert.equal(director.classifyMessage('what camera did you use?', makePlan(planStore.STATUS.AWAITING_STORYBOARD_APPROVAL)), null);
});

test('classifyMessage lets a brand-new explicit long request supersede the plan', () => {
    const plan = makePlan(planStore.STATUS.AWAITING_STORYBOARD_APPROVAL);
    assert.equal(director.classifyMessage('Make a 60 second movie of a desert.', plan), null);
    const failed = makePlan(planStore.STATUS.FAILED);
    assert.equal(director.classifyMessage('Make a 60 second movie of a desert.', failed), null);
});

test('normalizeAction accepts button payloads and rejects unknown actions', () => {
    assert.deepEqual(director.normalizeAction('approve'), { type: 'approve', planId: '', direction: '' });
    assert.deepEqual(director.normalizeAction({ type: 'modify_plan', planId: 'lv-1', direction: 'rain' }),
        { type: 'modify_plan', planId: 'lv-1', direction: 'rain' });
    assert.equal(director.normalizeAction('nope'), null);
});

// --- Markers -----------------------------------------------------------------

test('marker extraction strips the storyboard marker from model context', () => {
    const plan = makePlan(planStore.STATUS.AWAITING_STORYBOARD_APPROVAL);
    plan.beats = [{ id: 1, duration: 15, action: 'Mara walks.', purpose: '' }];
    const content = director.renderStoryboardContent(plan);
    assert.match(content, /\[\[longvideo:/);
    const stripped = director.stripMarkers(content);
    assert.doesNotMatch(stripped, /\[\[longvideo:/);
    assert.match(stripped, /Long Video Director/);
});

test('renderCompleteContent names the engine and warns on the legacy fallback', () => {
    const base = makePlan(planStore.STATUS.COMPLETED);
    base.beats = [];
    const lt = director.renderCompleteContent(Object.assign({}, base, { engine: 'longtake' }), '<video></video>');
    assert.match(lt, /LongTake engine/);
    assert.doesNotMatch(lt, /legacy last-frame/);
    const legacy = director.renderCompleteContent(
        Object.assign({}, base, { engine: 'h3longvideos', engineFallback: true }), '<video></video>');
    assert.match(legacy, /legacy last-frame chain/);
    // The engine + fallback ride the persisted marker too.
    const marker = director.markerData(Object.assign({}, base, { engine: 'longtake' }));
    assert.equal(marker.engine, 'longtake');
});
