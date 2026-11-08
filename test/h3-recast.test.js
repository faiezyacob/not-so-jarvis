/* ============================================
   JARVIS — H3 Recast Character Swap engine
   Caption templates, graph wiring, model
   resolution, scene instruction and state
   migration.
   Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const caption = require('../services/character-swap/engines/h3-recast-caption');
const graphBuilder = require('../services/character-swap/engines/h3-recast-graph');
const recast = require('../services/character-swap/engines/h3-recast');
const sceneReference = require('../services/character-swap/scene-reference');
const characterSwap = require('../services/character-swap');
const characterState = require('../services/character-swap/state');

function mockInfo(overrides = {}) {
    return {
        UNETLoader: {
            input: { required: { unet_name: [['minimax_h3_ref2va_pruned_int8_convrot.safetensors', 'minimax_h3_fl2va_pruned_int8_convrot.safetensors']], weight_dtype: [['default']] } },
            output: ['MODEL']
        },
        CLIPLoader: {
            input: { required: { clip_name: [['qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors']], type: [['minimax']] } },
            output: ['CLIP']
        },
        VAELoader: {
            input: { required: { vae_name: [['minimax_h3_video_vae_int8_convrot.safetensors', 'minimax_h3_audio_vae_fp32.safetensors']] } },
            output: ['VAE']
        },
        LoraLoaderModelOnly: {
            input: { required: { model: ['MODEL'], lora_name: [overrides.loras || ['minimax_h3_character_swap_v1.0_ref2va_r64_gl.safetensors']], strength_model: ['FLOAT'] } },
            output: ['MODEL']
        },
        H3FaceTrackCrop: {
            input: {
                required: {
                    images: ['IMAGE'],
                    detector: [['bbox\\face_yolov8m.pt']],
                    confidence: ['FLOAT'],
                    crop_factor: ['FLOAT'],
                    canvas_width: ['INT'],
                    canvas_height: ['INT'],
                    canvas_mode: [['manual']],
                    smooth_window: ['INT'],
                    size_smooth_window: ['INT'],
                    smooth_method: [['gaussian']],
                    size_mode: [['per_frame']]
                },
                optional: {
                    select: [['left_most']],
                    select_index: ['INT'],
                    identity_reference: ['IMAGE'],
                    identity_track: ['BOOLEAN'],
                    identity_threshold: ['FLOAT'],
                    identity_model: [['insightface']]
                }
            },
            output: ['IMAGE', 'H3FACEXFORM', 'IMAGE', 'STRING', 'INT', 'INT', 'INT']
        }
    };
}

function modelsFor(info) {
    const models = graphBuilder.resolveModels(info, {});
    if (!models.swapLora) models.swapLora = 'minimax_h3_character_swap_v1.0_ref2va_r64_gl.safetensors';
    return models;
}

function permissiveInfo(graph) {
    const info = {};
    for (const node of Object.values(graph)) {
        if (!node || !node.class_type) continue;
        if (!info[node.class_type]) {
            info[node.class_type] = { input: { required: {}, optional: {} }, output: [] };
        }
        for (const key of Object.keys(node.inputs || {})) {
            const prefix = key.split('.')[0];
            if (!info[node.class_type].input.required[prefix] && !info[node.class_type].input.optional[prefix]) {
                info[node.class_type].input.required[prefix] = ['ANY'];
            }
        }
    }
    for (const node of Object.values(graph)) {
        for (const value of Object.values(node.inputs || {})) {
            if (!Array.isArray(value) || value.length !== 2) continue;
            const target = graph[value[0]];
            if (!target) continue;
            const def = info[target.class_type];
            while (def.output.length <= value[1]) def.output.push('ANY');
        }
    }
    return info;
}

test('caption fills the official one-person template', () => {
    const result = caption.buildCaption([
        { source: 'the woman in the red dress', target: 'an old woman with long silver hair', replaced: true }
    ]);
    assert.equal(result.count, 1);
    assert.match(result.caption, /^body_swap:/);
    assert.match(result.caption, /the woman in the red dress/);
    assert.match(result.caption, /an old woman with long silver hair/);
    assert.doesNotMatch(result.caption, /\{[td]\d\}/);
});

test('caption fills the two- and three-person templates left to right', () => {
    const two = caption.buildCaption([
        { source: 'the woman in the red dress', target: 'a man in a suit', replaced: true },
        { source: 'the man in the blue shirt', target: 'the man in the blue shirt', replaced: false }
    ]);
    assert.match(two.caption, /shown on the left of <Picture 1>/);
    assert.match(two.caption, /shown on the right of <Picture 1>/);
    const three = caption.buildCaption([
        { source: 'a', target: 'b' },
        { source: 'c', target: 'd' },
        { source: 'e', target: 'f' }
    ]);
    assert.match(three.caption, /shown on the left of <Picture 1>/);
    assert.match(three.caption, /shown in the middle of <Picture 1>/);
    assert.match(three.caption, /shown on the right of <Picture 1>/);
});

test('an unchanged person keeps their own description', () => {
    const result = caption.buildCaption([
        { source: 'the man in the blue plaid shirt', target: 'the man in the blue plaid shirt', replaced: false }
    ]);
    assert.match(result.caption, /only the man in the blue plaid shirt is replaced/);
    assert.equal(result.rows[0].source, 'the man in the blue plaid shirt');
});

test('caption rejects empty and more than three people', () => {
    assert.throws(() => caption.buildCaption([]), /at least one person/);
    assert.throws(() => caption.buildCaption([
        { source: 'a', target: 'b' },
        { source: 'c', target: 'd' },
        { source: 'e', target: 'f' },
        { source: 'g', target: 'h' }
    ]), /at most three/);
});

test('official person line parsing', () => {
    assert.deepEqual(caption.parsePersonLine('the woman in red becomes an old woman'), {
        source: 'the woman in red',
        target: 'an old woman'
    });
    assert.equal(caption.parsePersonLine('the woman in red'), null);
});

test('settings are clamped and the scene reference survives normalization', () => {
    const settings = characterState.normalizeEngineSettings({
        h3: {
            steps: 999,
            denoise: -1,
            sceneReference: { file: 'scene/reference.png', frame: 4, source: 'generated', width: 1280, height: 720 },
            lipRepair: { enabled: true, person: 9, denoise: 5, steps: 500, facePick: 'identity' }
        }
    });
    assert.equal(settings.h3.steps, 100);
    assert.equal(settings.h3.denoise, 0.05);
    assert.equal(settings.h3.sceneReference.file, 'scene/reference.png');
    assert.equal(settings.h3.sceneReference.frame, 4);
    assert.equal(settings.h3.lipRepair.enabled, true);
    assert.equal(settings.h3.lipRepair.auto, true);
    assert.equal(settings.h3.lipRepair.person, 3);
    assert.equal(settings.h3.lipRepair.denoise, 0.8);
    assert.equal(settings.h3.lipRepair.steps, 50);
    assert.equal(settings.h3.lipRepair.facePick, 'identity');
});

test('FaceRefine is on by default and can be opted out', () => {
    const defaults = graphBuilder.normalizeSettings({}, null).lip;
    assert.equal(defaults.auto, true);
    assert.equal(defaults.enabled, true);
    const off = graphBuilder.normalizeSettings({ lipRepair: { auto: false } }, null).lip;
    assert.equal(off.auto, false);
});

test('BFS LoRA resolves from the live lora list and is reported when missing', () => {
    const withLora = graphBuilder.resolveModels(mockInfo(), {});
    assert.equal(withLora.swapLora, 'minimax_h3_character_swap_v1.0_ref2va_r64_gl.safetensors');
    const without = graphBuilder.resolveModels(mockInfo({ loras: ['rigless-lora-v1.safetensors'] }), {});
    assert.equal(without.swapLora, null);
    assert.match(without.missingSwap.join(' '), /BFS character-swap LoRA/);
});

test('availability checks lip nodes only for a refine-only request', () => {
    const info = mockInfo();
    const base = characterState.normalizeEngineSettings({}).h3;
    const swapStatus = recast.availability(info, base);
    assert.equal(swapStatus.available, false);
    assert.match(swapStatus.missing.join(' '), /SaveVideo/);
    const lipStatus = recast.availability(info, Object.assign({}, base, { refineOnly: true, lipRepair: Object.assign({}, base.lipRepair, { enabled: true }) }));
    assert.match(lipStatus.missing.join(' '), /SaveVideo/);
});

test('swap graph wires the BFS LoRA, scene reference, guide video and original audio', () => {
    const info = mockInfo();
    const models = modelsFor(info);
    const graph = graphBuilder.buildSwapGraph({
        prompt: 'body_swap: test',
        W: 1344,
        H: 768,
        frames: 124,
        seed: 7,
        settings: {},
        models,
        sceneRefName: 'scene.png',
        sourceName: 'clip.mp4',
        sourceHasAudio: true
    });
    assert.equal(graph.swap_lora.class_type, 'LoraLoaderModelOnly');
    assert.equal(graph.swap_lora.inputs.lora_name, models.swapLora);
    assert.deepEqual(graph.swap_lora.inputs.model, ['attention', 0]);
    assert.equal(graph.unet.inputs.unet_name, models.unet);
    assert.equal(graph.reference.class_type, 'MiniMaxH3ReferenceToVideo');
    assert.deepEqual(graph.reference.inputs['ref_images.ref_image_0'], ['scene_ref_scaled', 0]);
    assert.equal(graph.guide.class_type, 'MiniMaxH3AddGuide');
    assert.deepEqual(graph.guide.inputs.image, ['video', 0]);
    assert.deepEqual(graph.guide.inputs.audio, ['audio_trim', 0]);
    assert.deepEqual(graph.video_out.inputs.audio, ['audio_trim', 0]);
    assert.equal(graph.audio_trim.class_type, 'TrimAudioDuration');
    assert.deepEqual(graph.audio_trim.inputs.audio, ['video', 2]);
    assert.equal(graph.sample.inputs.latent_image[0], 'empty_av');
    assert.equal(graph.scheduler.inputs.steps, 20);
    assert.equal(graph.guider.inputs.positive[0], 'guide');
    assert.equal(graph.guider.inputs.negative[0], 'guide');
    assert.equal(graphBuilder.validateGraph(permissiveInfo(graph), graph), true);
});

test('swap graph uses EmptyAudio when the source has no audio', () => {
    const models = modelsFor(mockInfo());
    const graph = graphBuilder.buildSwapGraph({
        prompt: 'test',
        W: 1344,
        H: 768,
        frames: 124,
        seed: 1,
        settings: {},
        models,
        sceneRefName: 'scene.png',
        sourceName: 'clip.mp4',
        sourceHasAudio: false
    });
    assert.deepEqual(graph.guide.inputs.audio, ['empty_audio', 0]);
    assert.deepEqual(graph.video_out.inputs.audio, ['empty_audio', 0]);
    assert.equal(graph.empty_audio.class_type, 'EmptyAudio');
});

test('lip graph uses the installed FaceRefine canvas and frame-count slots', () => {
    const info = mockInfo();
    const models = modelsFor(info);
    const graph = graphBuilder.buildLipGraph({
        prompt: 'lip',
        frames: 124,
        seed: 1,
        settings: { lipRepair: { person: 2, denoise: 0.35, steps: 20 } },
        models,
        baseVideoName: 'base.mp4',
        faceRefName: 'face.png',
        personIndex: 1,
        sourceHasAudio: true
    });
    assert.deepEqual(graph.reference.inputs.width, ['face_crop', 4]);
    assert.deepEqual(graph.reference.inputs.height, ['face_crop', 5]);
    assert.deepEqual(graph.reference.inputs.length, ['face_crop', 6]);
    assert.equal(graph.face_crop.inputs.select_index, 1);
    assert.equal(graph.face_crop.inputs.detector, 'bbox\\face_yolov8m.pt');
    assert.deepEqual(graph.audio_lock.inputs.av_latent, ['inject', 0]);
    assert.deepEqual(graph.guider.inputs.model, ['per_frame', 2]);
    assert.deepEqual(graph.sample.inputs.latent_image, ['per_frame', 0]);
    assert.deepEqual(graph.stitch.inputs.transform, ['face_crop', 1]);
    assert.deepEqual(graph.video_out.inputs.audio, ['base_video', 2]);
    assert.equal(graphBuilder.validateGraph(permissiveInfo(graph), graph, { lip: true }), true);
});

test('lip graph can lock the face by identity reference', () => {
    const models = modelsFor(mockInfo());
    const graph = graphBuilder.buildLipGraph({
        prompt: 'lip',
        frames: 124,
        seed: 1,
        settings: { lipRepair: { person: 1, facePick: 'identity' } },
        models,
        baseVideoName: 'base.mp4',
        faceRefName: 'face.png',
        personIndex: 0,
        sourceHasAudio: false
    });
    assert.deepEqual(graph.face_crop.inputs.identity_reference, ['face_ref', 0]);
    assert.equal(graph.face_crop.inputs.identity_track, true);
    assert.deepEqual(graph.audio_lock.inputs.audio, ['empty_audio', 0]);
});

test('lip settings survive the second normalization', () => {
    const first = graphBuilder.normalizeSettings({
        lipRepair: {
            denoise: 0.55,
            steps: 32,
            facePick: 'identity',
            canvasWidth: 512,
            canvasHeight: 512,
            largeFaceMultiplier: 0.9,
            vocalsFile: 'lip/vocals.wav'
        }
    }, null);
    const second = graphBuilder.normalizeSettings(first, null);
    assert.equal(second.lip.denoise, 0.55);
    assert.equal(second.lip.steps, 32);
    assert.equal(second.lip.facePick, 'identity');
    assert.equal(second.lip.canvasWidth, 512);
    assert.equal(second.lip.largeFaceMultiplier, 0.9);
    assert.equal(second.lip.vocalsFile, 'lip/vocals.wav');
});

test('lip graph conditions on the source audio and optional vocals while the output keeps the source', () => {
    const models = modelsFor(mockInfo());
    const graph = graphBuilder.buildLipGraph({
        prompt: 'lip',
        frames: 124,
        seed: 1,
        settings: {
            lipRepair: {
                person: 1,
                largeFaceMultiplier: 1,
                smallFaceMultiplier: 1
            }
        },
        models,
        baseVideoName: 'base.mp4',
        faceRefName: 'face.png',
        sourceVideoName: 'source.mp4',
        lipAudioName: 'vocals.wav',
        personIndex: 0,
        sourceHasAudio: true
    });
    assert.equal(graph.source_video.class_type, 'VHS_LoadVideoFFmpeg');
    assert.equal(graph.lip_audio.class_type, 'VHS_LoadAudio');
    assert.equal(graph.lip_audio.inputs.audio_file, 'vocals.wav');
    assert.deepEqual(graph.reference.inputs['ref_audios.ref_audio_0'], ['lip_audio', 0]);
    assert.deepEqual(graph.audio_lock.inputs.audio, ['lip_audio', 0]);
    assert.deepEqual(graph.video_out.inputs.audio, ['source_video', 2]);
    assert.equal(graph.per_frame.inputs.denoise_multiplier_small_face, 1);
    assert.equal(graph.per_frame.inputs.denoise_multiplier_large_face, 1);
    assert.equal(graphBuilder.validateGraph(permissiveInfo(graph), graph, { lip: true }), true);
});

test('lip graph without a vocals stem conditions on the source audio', () => {
    const models = modelsFor(mockInfo());
    const graph = graphBuilder.buildLipGraph({
        prompt: 'lip',
        frames: 124,
        seed: 1,
        settings: { lipRepair: { person: 1 } },
        models,
        baseVideoName: 'base.mp4',
        faceRefName: 'face.png',
        sourceVideoName: 'source.mp4',
        personIndex: 0,
        sourceHasAudio: true
    });
    assert.equal(graph.lip_audio, undefined);
    assert.deepEqual(graph.reference.inputs['ref_audios.ref_audio_0'], ['source_video', 2]);
    assert.deepEqual(graph.audio_lock.inputs.audio, ['source_video', 2]);
    assert.deepEqual(graph.video_out.inputs.audio, ['source_video', 2]);
});

test('validator rejects a missing node and a dangling link', () => {
    const models = modelsFor(mockInfo());
    const graph = graphBuilder.buildSwapGraph({
        prompt: 'test', W: 1344, H: 768, frames: 124, seed: 1,
        settings: {}, models, sceneRefName: 'scene.png', sourceName: 'clip.mp4', sourceHasAudio: true
    });
    const info = permissiveInfo(graph);
    delete info.MiniMaxH3AddGuide;
    assert.throws(() => graphBuilder.validateGraph(info, graph), /missing/i);
    const info2 = permissiveInfo(graph);
    graph.guide.inputs.positive = ['missing_node', 0];
    assert.throws(() => graphBuilder.validateGraph(info2, graph), /missing node/i);
});

test('frames stay on the 17k+5 grid and fall back to what the clip holds', () => {
    assert.equal(recast.framesFor(6, 0), 158);
    assert.equal(recast.framesFor(6, 139), 124);
    assert.equal(recast.framesFor(0.1, 0), 124);
    assert.equal(recast.framesFor(6, 10), 5);
});

test('scene instruction names every replacement and preserves everyone else', () => {
    const instruction = sceneReference.buildInstruction(null, [
        { subjectSummary: 'a woman in a red dress', place: 'on the left' },
        { subjectSummary: '', place: 'in the middle' },
        { subjectSummary: 'a man in a blue shirt', place: 'on the right' }
    ]);
    assert.match(instruction, /Replace the person on the left \(a woman in a red dress\) with the person in image 2/);
    assert.match(instruction, /Replace the person in the middle with the person in image 3/);
    assert.match(instruction, /Replace the person on the right \(a man in a blue shirt\) with the person in image 4/);
    assert.match(instruction, /not being replaced exactly as they are/);
});

test('H3 rows write a line for everyone in the shot, replacing only selected people', () => {
    const project = {
        part: { width: 1000 },
        selection: {
            width: 1000,
            tracks: [
                { id: 't1', label: 'Person 1', bbox: { x: 100, width: 100, height: 200 }, firstFrame: 0, lastFrame: 10 },
                { id: 't2', label: 'Person 2', bbox: { x: 450, width: 100, height: 200 }, firstFrame: 0, lastFrame: 10 },
                { id: 't3', label: 'Person 3', bbox: { x: 800, width: 100, height: 200 }, firstFrame: 0, lastFrame: 10 }
            ]
        },
        people: [
            { id: 'p1', label: 'Person 1', selectionId: 't1', x: 0.15, subjectSummary: 'a woman in a red dress', identitySummary: 'a man with short hair' }
        ]
    };
    const rows = characterSwap.buildH3Rows(project, project.people);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].replaced, true);
    assert.equal(rows[0].target, 'a man with short hair');
    assert.equal(rows[1].replaced, false);
    assert.equal(rows[1].source, rows[1].target);
    assert.match(rows[1].source, /in the middle/);
    const result = caption.buildCaption(rows);
    assert.match(result.caption, /a woman in a red dress/);
    assert.match(result.caption, /a man with short hair/);
});

test('H3 Recast works without DWPose detection when people have character images', () => {
    const project = {
        part: { width: 1000 },
        selection: { width: 1000, tracks: [] },
        people: [
            {
                id: 'p1', label: 'Person 1', selectionId: null, refs: [{ id: 'r1' }], x: 0.5,
                h3Line: 'the woman in the red dress becomes an old woman with silver hair'
            },
            {
                id: 'p2', label: 'Person 2', selectionId: null, refs: [{ id: 'r2' }], x: 0.5,
                h3Line: 'the man in the blue shirt becomes a man in a black suit'
            }
        ]
    };
    const selected = sceneReference.selectedPeople(project);
    assert.equal(selected.length, 2);
    const rows = characterSwap.buildH3Rows(project, selected);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].source, 'the woman in the red dress');
    assert.equal(rows[0].target, 'an old woman with silver hair');
    assert.equal(rows[0].replaced, true);
    assert.equal(rows[1].source, 'the man in the blue shirt');
    const result = caption.buildCaption(rows);
    assert.match(result.caption, /the woman in the red dress/);
    assert.match(result.caption, /an old woman with silver hair/);
});

test('scene instruction uses a manual person line for the source phrase', () => {
    const instruction = sceneReference.buildInstruction(null, [
        {
            subjectSummary: '',
            place: null,
            h3Line: 'the woman in the red dress becomes an old woman with silver hair'
        }
    ], '');
    assert.match(instruction, /Replace the person in the shot \(the woman in the red dress\) with the person in image 2/);
});

test('an unreplaced detected person keeps their real description instead of a placeholder', () => {
    const project = {
        part: { width: 1000 },
        selection: {
            width: 1000,
            tracks: [
                { id: 't1', label: 'Person 1', bbox: { x: 100, width: 100, height: 200 }, firstFrame: 0, lastFrame: 10 },
                { id: 't2', label: 'Person 2', bbox: { x: 500, width: 100, height: 200 }, firstFrame: 0, lastFrame: 10 }
            ]
        },
        people: [
            {
                id: 'p1', label: 'Person 2', selectionId: 't2', refs: [],
                subjectSummary: 'a blue hedgehog sitting in a wooden boat'
            },
            {
                id: 'p2', label: 'Person 1', selectionId: 't1', refs: [{ id: 'r1' }],
                subjectSummary: 'a middle-aged man in a green cap and plaid shirt',
                identitySummary: 'a young man in a fur coat',
                description: { identitySummary: 'a young man with dark brown hair' }
            }
        ]
    };
    const selected = sceneReference.selectedPeople(project);
    const rows = characterSwap.buildH3Rows(project, selected);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].replaced, true);
    assert.equal(rows[0].source, 'a middle-aged man in a green cap and plaid shirt');
    assert.equal(rows[0].target, 'a young man in a fur coat');
    assert.equal(rows[1].replaced, false);
    assert.equal(rows[1].source, 'a blue hedgehog sitting in a wooden boat');
    assert.equal(rows[1].target, rows[1].source);
});

test('a truncated stored person line uses the full structured identity', () => {
    const project = {
        part: { width: 1000 },
        selection: { width: 1000, tracks: [{ id: 't1', label: 'Person 1', bbox: { x: 100, width: 100, height: 200 }, firstFrame: 0, lastFrame: 10 }] },
        people: [{
            id: 'p1', selectionId: 't1', refs: [{ id: 'r1' }],
            subjectSummary: 'a bowl-cut man in a beige suit',
            identitySummary: 'a young man with dark brown hair, a long brown fur coat, black trousers and black leather dress shoes',
            h3Line: 'a bowl-cut man in a beige suit becomes a young man with dark brown hair, a long'
        }]
    };
    const rows = characterSwap.buildH3Rows(project, project.people);
    assert.equal(rows[0].target, 'a young man with dark brown hair, a long brown fur coat, black trousers and black leather dress shoes');
});

test('a user-edited person line is preserved', () => {
    const project = {
        part: { width: 1000 },
        selection: { width: 1000, tracks: [{ id: 't1', label: 'Person 1', bbox: { x: 100, width: 100, height: 200 }, firstFrame: 0, lastFrame: 10 }] },
        people: [{
            id: 'p1', selectionId: 't1', refs: [{ id: 'r1' }],
            subjectSummary: 'a bowl-cut man in a beige suit',
            identitySummary: 'a young man with dark brown hair',
            h3Line: 'a bowl-cut man in a beige suit becomes a green-skinned alien with antennae'
        }]
    };
    const rows = characterSwap.buildH3Rows(project, project.people);
    assert.equal(rows[0].target, 'a green-skinned alien with antennae');
});

test('a line-only person is captioned as unchanged and never replaced', () => {
    const project = {
        part: { width: 1000 },
        selection: { width: 1000, tracks: [] },
        people: [
            { id: 'p1', label: 'Person 1', selectionId: null, refs: [{ id: 'r1' }], x: 0.5, h3Line: 'the woman in the red dress becomes an old woman with silver hair' },
            { id: 'p2', label: 'Person 2', selectionId: null, refs: [], x: 0.5, h3Line: 'the man in the blue plaid shirt' }
        ]
    };
    const selected = sceneReference.selectedPeople(project);
    assert.equal(selected.length, 1);
    const rows = characterSwap.buildH3Rows(project, selected);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].replaced, false);
    assert.equal(rows[1].source, rows[1].target);
    assert.match(rows[1].source, /blue plaid shirt/);
    const result = caption.buildCaption(rows);
    assert.match(result.caption, /blue plaid shirt/);
});

test('attention resolves to a ModelAttentionBackend option and re-normalization is idempotent', () => {
    const info = {
        ModelAttentionBackend: {
            input: {
                required: {
                    model: ['MODEL'],
                    attention: [['pytorch attention', 'comfy kitchen attention']]
                }
            },
            output: ['MODEL']
        }
    };
    assert.equal(graphBuilder.normalizeAttention('auto', info), 'comfy kitchen attention');
    assert.equal(graphBuilder.normalizeAttention('sageattention', info), 'comfy kitchen attention');
    assert.equal(graphBuilder.normalizeAttention('pytorch', info), 'pytorch attention');
    assert.equal(graphBuilder.normalizeAttention('comfy kitchen attention', info), 'comfy kitchen attention');
    // Re-normalizing an already-resolved value without /object_info must not
    // turn it into null (this was the generation failure).
    assert.equal(graphBuilder.normalizeAttention('comfy kitchen attention', null), 'comfy kitchen attention');
    assert.equal(graphBuilder.normalizeAttention('pytorch attention', null), 'pytorch attention');
});

test('buildSwapGraph accepts an already-normalized Comfy Kitchen attention', () => {
    const models = modelsFor(mockInfo());
    const graph = graphBuilder.buildSwapGraph({
        prompt: 'test', W: 1344, H: 768, frames: 124, seed: 1,
        settings: { attention: 'comfy kitchen attention' },
        models, sceneRefName: 'scene.png', sourceName: 'clip.mp4', sourceHasAudio: true
    });
    assert.equal(graph.attention.inputs.attention, 'comfy kitchen attention');
});

test('auto line combines the detected source with the replacement description', () => {
    const line = characterSwap.h3LineForPerson({
        subjectSummary: 'a woman in a red dress',
        identitySummary: 'a woman in a black suit',
        refs: [{ id: 'r1' }]
    }, 0, 2);
    assert.equal(line, 'a woman in a red dress becomes a woman in a black suit');
    const unchanged = characterSwap.h3LineForPerson({
        subjectSummary: 'a man in a blue shirt',
        identitySummary: '',
        refs: []
    }, 1, 2);
    assert.equal(unchanged, 'a man in a blue shirt');
});

test('scene instruction preserves the clip pose and framing while copying the reference look', () => {
    const instruction = sceneReference.buildInstruction(null, [{
        subjectSummary: 'a woman in a red dress',
        h3Line: 'a woman in a red dress becomes a woman in a black suit'
    }], '');
    assert.match(instruction, /Copy the ENTIRE look/);
    assert.match(instruction, /exact body pose/);
    assert.match(instruction, /Do not copy the reference image's pose/);
});

test('person lines keep a long target instead of truncating before the split', () => {
    const longTarget = 'A young man with a lean build and fair skin, dark brown hair styled with a slight side part and a few strands falling over his forehead, striking blue eyes, well-defined eyebrows, an oval-shaped face with a defined jawline, a straight nose and full lips, wearing a brown and tan textured fur coat, a black button-down shirt and black leather dress shoes';
    const line = caption.parsePersonLine('the middle-aged man in the plaid shirt becomes ' + longTarget);
    assert.ok(line);
    assert.match(line.target, /black leather dress shoes/);
    assert.match(line.target, /straight nose and full lips/);
});

test('scene targets are the selected tracks and ignore parked records', () => {
    const project = {
        part: { width: 1000 },
        selection: {
            width: 1000,
            tracks: [
                { id: 't1', label: 'Person 1', bbox: { x: 100, width: 100 }, firstFrame: 0, lastFrame: 10 },
                { id: 't2', label: 'Person 2', bbox: { x: 500, width: 100 }, firstFrame: 0, lastFrame: 10 }
            ]
        },
        people: [
            { id: 'p1', label: 'Person 1', selectionId: 't1', lastSelectionId: 't1', x: 0.15, refs: [{ id: 'r1' }] },
            { id: 'p2', label: 'Person 2', selectionId: null, lastSelectionId: 't2', x: 0.55, refs: [{ id: 'r2' }] }
        ]
    };
    const selected = sceneReference.selectedPeople(project);
    assert.deepEqual(selected.map((person) => person.id), ['p1']);
});

test('a selected person without a character image is not a replacement target', () => {
    const project = {
        part: { width: 1000 },
        selection: {
            width: 1000,
            tracks: [
                { id: 't1', label: 'Person 1', bbox: { x: 100, width: 100 }, firstFrame: 0, lastFrame: 10 },
                { id: 't2', label: 'Person 2', bbox: { x: 500, width: 100 }, firstFrame: 0, lastFrame: 10 }
            ]
        },
        people: [
            { id: 'p1', selectionId: 't1', x: 0.15, refs: [] },
            { id: 'p2', selectionId: 't2', x: 0.55, refs: [{ id: 'r2' }] }
        ]
    };
    const selected = sceneReference.selectedPeople(project);
    assert.deepEqual(selected.map((person) => person.id), ['p2']);
});

test('shot places are computed among everyone, not only the targets', () => {
    const project = {
        part: { width: 1000 },
        selection: {
            width: 1000,
            tracks: [
                { id: 't1', label: 'Person 1', bbox: { x: 100, width: 100 }, firstFrame: 0, lastFrame: 10 },
                { id: 't2', label: 'Person 2', bbox: { x: 450, width: 100 }, firstFrame: 0, lastFrame: 10 },
                { id: 't3', label: 'Person 3', bbox: { x: 800, width: 100 }, firstFrame: 0, lastFrame: 10 }
            ]
        },
        people: [
            { id: 'p2', selectionId: 't2', x: 0.5, refs: [{ id: 'r2' }] },
            { id: 'p3', selectionId: 't3', x: 0.85, refs: [{ id: 'r3' }] }
        ]
    };
    const selected = sceneReference.selectedPeople(project);
    const placed = sceneReference.withShotPlaces(project, selected);
    assert.equal(placed[0].place, 'in the middle');
    assert.equal(placed[1].place, 'on the right');
});

test('without detection, every person with a character image is a target', () => {
    const project = {
        part: { width: 1000 },
        selection: { width: 1000, tracks: [] },
        people: [
            { id: 'p1', selectionId: null, x: 0.5, refs: [{ id: 'r1' }] },
            { id: 'p2', selectionId: null, x: 0.5, refs: [] }
        ]
    };
    const selected = sceneReference.selectedPeople(project);
    assert.deepEqual(selected.map((person) => person.id), ['p1']);
});
