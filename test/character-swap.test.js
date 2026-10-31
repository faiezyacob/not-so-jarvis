/* ============================================
   JARVIS — Character Swap workspace
   Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cs-'));
process.env.CHARACTER_SWAP_PATH = path.join(TMP, 'character-swap.json');
process.env.CHARACTER_SWAP_DIR = path.join(TMP, 'projects');
process.env.GENERATED_DIR = path.join(TMP, 'generated');
process.env.GENERATED_HISTORY_PATH = path.join(TMP, 'generated-history.json');
process.env.CONVERSATIONS_PATH = path.join(TMP, 'conversations.json');
fs.mkdirSync(process.env.GENERATED_DIR, { recursive: true });

const characterState = require('../services/character-swap/state');
const media = require('../services/character-swap/media');
const tracking = require('../services/character-swap/tracking');
const promptBuilder = require('../services/character-swap/prompt');
const references = require('../services/character-swap/references');
const videoReplacement = require('../services/video-replacement');

function person(overrides = {}) {
    return Object.assign({
        id: 'p1',
        label: 'Person 1',
        tint: '#90e2dd',
        anchors: [],
        masks: null,
        refs: [
            { id: 'r1', file: 'front.png', role: 'front' },
            { id: 'r2', file: 'face.png', role: 'close_up' },
            { id: 'r3', file: 'back.png', role: 'back' }
        ],
        facing: 'front',
        description: {
            identitySummary: 'A woman with short red hair and a green coat.',
            clothing: 'green wool coat, black boots',
            unlike: ['rings', 'watch']
        }
    }, overrides);
}

test('planSegments: first anchor also tracks backward to the clip start', () => {
    const segments = tracking.planSegments([
        { frame: 10, positive: [{ x: 1, y: 1 }] },
        { frame: 30, positive: [{ x: 1, y: 1 }] }
    ], 60);
    assert.equal(segments.length, 3);
    assert.equal(segments[0].backward, true);
    assert.equal(segments[0].start, 0);
    assert.equal(segments[0].length, 11);
    assert.equal(segments[1].start, 10);
    assert.equal(segments[1].length, 20);
    assert.equal(segments[2].start, 30);
    assert.equal(segments[2].length, 30);
});

test('planSegments: rejects duplicate anchors and out-of-range anchors', () => {
    assert.throws(() => tracking.planSegments([
        { frame: 2, positive: [{ x: 1, y: 1 }] },
        { frame: 2, positive: [{ x: 2, y: 2 }] }
    ], 10), /only one anchor/);
    assert.throws(() => tracking.planSegments([{ frame: 10, positive: [{ x: 1, y: 1 }] }], 10), /outside/);
});

test('prompt: single character uses the first picture and carry-over exclusions', () => {
    const text = promptBuilder.buildPrompt([person()], '');
    assert.match(text, /Replace the selected person in <Video 1>/);
    assert.match(text, /<Picture 1>/);
    assert.match(text, /no rings and no watch/);
    assert.match(text, /green wool coat/);
});

test('prompt: back-facing clips promote the back view to Picture 1', () => {
    const text = promptBuilder.buildPrompt([person({ facing: 'back' })], '');
    assert.match(text, /<Picture 1> shows the same person from behind/);
});

test('prompt: two people get named places and shared picture numbering', () => {
    const people = [
        person({ id: 'a', label: 'A', x: 0.2 }),
        person({ id: 'b', label: 'B', x: 0.8 })
    ];
    promptBuilder.assignPlaces(people);
    const text = promptBuilder.buildPrompt(people, 'both look at the camera');
    assert.match(text, /Replace the 2 selected people/);
    assert.match(text, /on the left/);
    assert.match(text, /on the right/);
    assert.match(text, /<Picture 1>/);
});

test('mask operations: grow, contract, strokes and temporal smoothing', () => {
    const width = 20;
    const height = 20;
    const mask = media.emptyMask(width, height);
    mask[10 * width + 10] = 255;
    const grown = media.dilate(mask, width, height, 2);
    assert.equal(grown.filter((value) => value > 0).length, 25);
    const contracted = media.contract(grown, width, height, 2);
    assert.equal(contracted.filter((value) => value > 0).length, 1);

    const painted = media.applyStrokes(mask, width, height, [{
        tool: 'add',
        radius: 3,
        points: [{ x: 2, y: 2 }, { x: 12, y: 2 }]
    }]);
    assert.ok(painted[2 * width + 2] > 0);
    assert.ok(painted[2 * width + 12] > 0);
    const erased = media.applyStrokes(painted, width, height, [{
        tool: 'erase',
        radius: 2,
        points: [{ x: 2, y: 2 }]
    }]);
    assert.equal(erased[2 * width + 2], 0);

    const smoothed = media.temporalSmooth([
        Uint8Array.from({ length: width * height }, () => 255),
        Uint8Array.from({ length: width * height }, () => 0),
        Uint8Array.from({ length: width * height }, () => 255)
    ], width, height, 1);
    assert.equal(smoothed[1][0], 255);
});

test('reference roles: close-up and full body normalize onto prompt roles', () => {
    assert.equal(references.normalizeRole('close-up'), 'close_up');
    assert.equal(references.normalizeRole('full body'), 'full_body');
    assert.equal(promptBuilder.roleOf({ role: 'close_up' }), 'close');
    assert.equal(promptBuilder.roleOf({ role: 'full_body' }), 'full');
});

test('project state: creation, people and reference persistence', () => {
    const project = characterState.createProject({ sessionId: 's1', filename: 'clip.mp4' });
    assert.ok(project.id.startsWith('cs_'));
    assert.equal(project.people.length, 1);
    const added = characterState.addPerson(project.id);
    assert.equal(added.people.length, 2);
    assert.throws(() => {
        characterState.addPerson(project.id);
        characterState.addPerson(project.id);
    }, /up to 3/);
    characterState.removePerson(project.id, added.people[0].id);
    assert.equal(characterState.get(project.id).people.length, 2);
    characterState.remove(project.id);
    assert.equal(characterState.get(project.id), null);
});

test('H3 graph: refined mask uses the externally tracked mask video', () => {
    const graph = videoReplacement.buildReplacementGraph({
        prompt: 'replace',
        W: 1280,
        H: 720,
        frames: 48,
        seed: 7,
        settings: {},
        refImageNames: ['ref.png'],
        refVideoName: 'source.mp4',
        mask: { enabled: true, videoName: 'mask.mp4', grow: 0 }
    });
    assert.equal(graph.mask_file.class_type, 'LoadVideo');
    assert.equal(graph.mask_file.inputs.file, 'mask.mp4');
    assert.equal(graph.mask_scaled.class_type, 'ImageScale');
    assert.equal(graph.mask_batch.inputs.length, 48);
    assert.deepEqual(graph.mask_tomask.inputs.image, ['mask_batch', 0]);
    assert.deepEqual(graph.composite.inputs.mask, ['mask_tomask', 0]);
    assert.equal(graph.composite.class_type, 'ImageCompositeMasked');
});

test('H3 graph: refined mask drives the Fun ControlNet inpaint branch', () => {
    const graph = videoReplacement.buildReplacementGraph({
        prompt: 'replace',
        W: 1280,
        H: 720,
        frames: 124,
        seed: 9,
        settings: {
            h3FunControlNet: 'patch.safetensors',
            h3FunControlStrength: 0.35,
            h3FunControlEnd: 1,
            h3FunControlUseSourceRef: true
        },
        refImageNames: ['ref.png'],
        refVideoName: 'source.mp4',
        mask: {
            enabled: true,
            videoName: 'mask.mp4',
            grow: 0,
            controlNet: 'patch.safetensors',
            controlStrength: 0.35,
            controlEnd: 1,
            useSourceRef: true
        }
    });
    assert.equal(graph.fun_control_patch.class_type, 'ModelPatchLoader');
    assert.equal(graph.fun_control_patch.inputs.name, 'patch.safetensors');
    assert.equal(graph.fun_control.class_type, 'MiniMaxH3FunControlNetApply');
    assert.equal(graph.fun_control.inputs.strength, 0.35);
    assert.equal(graph.fun_control.inputs.end_percent, 1);
    assert.deepEqual(graph.fun_control.inputs.mask, ['mask_tomask', 0]);
    assert.deepEqual(graph.fun_control.inputs.source_video, ['mask_source', 0]);
    assert.deepEqual(graph.scheduler.inputs.model, ['fun_control', 0]);
    assert.deepEqual(graph.guider.inputs.model, ['fun_control', 0]);
    assert.deepEqual(graph.reference.inputs['ref_videos.ref_video_0'], ['ref_video', 0]);
});

test('H3 graph: refined mask never silently falls back to SAM3', () => {
    const mask = videoReplacement.replacementMaskPlan({ replacements: [] }, {});
    assert.equal(mask.enabled, false);
    const refined = videoReplacement.replacementMaskPlan({ maskVideoName: 'm.mp4', replacements: [] }, {});
    assert.equal(refined.enabled, true);
    assert.equal(refined.videoName, 'm.mp4');
});

test('markTakeUpscaled folds the auto-upscale result onto the take', () => {
    const characterSwap = require('../services/character-swap');
    const project = characterState.createProject({ sessionId: 's-upscale', filename: 'clip.mp4' });
    characterState.update(project.id, (current) => {
        current.takes = [{
            takeId: 'take-1', engine: 'wan_animate', seed: 7, status: 'done',
            url: '/generated/base.mp4', filename: 'base.mp4', width: 848, height: 480,
            duration: 4, fps: 16, windows: [{ pass: 0, index: 0 }], passes: [], error: null
        }];
        current.bestTake = current.takes[0];
    });
    const updated = characterSwap.markTakeUpscaled(project.id, 7, {
        url: '/generated/base_up_2026.mp4',
        filename: 'base_up_2026.mp4',
        width: 1696,
        height: 960,
        generationMs: 1234,
        upscaled: true,
        upscale: { engine: 'seedvr2', scale: 2 },
        meta: { file: '/generated/base_up_2026.mp4' }
    });
    assert.ok(updated);
    assert.equal(updated.filename, 'base_up_2026.mp4');
    assert.equal(updated.width, 1696);
    assert.equal(updated.height, 960);
    assert.equal(updated.upscaled, true);
    assert.equal(updated.upscale.engine, 'seedvr2');
    assert.equal(updated.seed, 7);
    assert.equal(updated.windows.length, 1);
    const stored = characterState.get(project.id);
    assert.equal(stored.bestTake.filename, 'base_up_2026.mp4');
});

test('deleting a take removes its generated files, and a gallery delete removes the take', () => {
    const characterSwap = require('../services/character-swap');
    const generatedHistory = require('../services/generated-history');
    const fsx = require('fs');
    const project = characterState.createProject({ sessionId: 's-delete', filename: 'clip.mp4' });
    const videoName = 'take_delete_base.mp4';
    const upName = 'take_delete_up.mp4';
    fsx.writeFileSync(path.join(process.env.GENERATED_DIR, videoName), 'video');
    fsx.writeFileSync(path.join(process.env.GENERATED_DIR, upName), 'video');
    generatedHistory.add({ file: '/generated/' + videoName, rawFilename: videoName, conversationId: null, model: 'Wan Animate 2', sessionId: 's-delete' });
    generatedHistory.add({ file: '/generated/' + upName, rawFilename: upName, conversationId: null, model: 'Wan Animate 2', sessionId: 's-delete' });
    characterState.update(project.id, (current) => {
        current.takes = [{
            takeId: 'take-delete', engine: 'wan_animate', seed: 9, status: 'done',
            url: '/generated/' + upName, filename: upName, width: 1280, height: 720,
            duration: 5, fps: 16, windows: [], passes: [], error: null,
            upscale: { originalFilename: videoName, upscaledFilename: upName }
        }];
        current.bestTake = current.takes[0];
    });
    const afterTakeDelete = characterSwap.removeTake(project.id, 'take-delete');
    assert.equal(afterTakeDelete.takes.length, 0);
    assert.equal(afterTakeDelete.bestTake, null);
    assert.equal(fsx.existsSync(path.join(process.env.GENERATED_DIR, videoName)), false);
    assert.equal(fsx.existsSync(path.join(process.env.GENERATED_DIR, upName)), false);

    // Gallery -> Character Swap direction.
    const name = 'gallery_delete_take.mp4';
    fsx.writeFileSync(path.join(process.env.GENERATED_DIR, name), 'video');
    const entry = generatedHistory.add({ file: '/generated/' + name, rawFilename: name, conversationId: null, model: 'Wan Animate 2', sessionId: 's-delete' });
    characterState.update(project.id, (current) => {
        current.takes = [{ takeId: 'take-gallery', engine: 'wan_animate', seed: 10, status: 'done', filename: name, url: '/generated/' + name, windows: [] }];
        current.bestTake = current.takes[0];
    });
    generatedHistory.remove(entry.id, 's-delete');
    const removed = characterSwap.removeTakeByFilename(name, 's-delete');
    assert.equal(removed, 1);
    assert.equal(characterState.get(project.id).takes.length, 0);
});
