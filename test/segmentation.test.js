/* ============================================
   JARVIS — Wan non-SAM segmentation
   Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-seg-'));
process.env.CHARACTER_SWAP_PATH = path.join(TMP, 'character-swap.json');
process.env.CHARACTER_SWAP_DIR = path.join(TMP, 'projects');

const characterState = require('../services/character-swap/state');
const media = require('../services/character-swap/media');
const segmentation = require('../services/character-swap/segmentation');

function kp(x, y, c = 1) {
    return { x, y, c };
}

function body(cx, top, h) {
    return [
        kp(cx, top), kp(cx, top + h * 0.1),
        kp(cx + h * 0.12, top + h * 0.12), kp(cx + h * 0.2, top + h * 0.3), kp(cx + h * 0.24, top + h * 0.48),
        kp(cx - h * 0.12, top + h * 0.12), kp(cx - h * 0.2, top + h * 0.3), kp(cx - h * 0.24, top + h * 0.48),
        kp(cx + h * 0.08, top + h * 0.5), kp(cx + h * 0.09, top + h * 0.75), kp(cx + h * 0.1, top + h),
        kp(cx - h * 0.08, top + h * 0.5), kp(cx - h * 0.09, top + h * 0.75), kp(cx - h * 0.1, top + h),
        kp(cx + h * 0.03, top + 0.02 * h), kp(cx - h * 0.03, top + 0.02 * h),
        kp(cx + h * 0.06, top + 0.03 * h), kp(cx - h * 0.06, top + 0.03 * h)
    ];
}

function bboxOf(points) {
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function info(matte, modelInstalled = true, legacy = false) {
    const nodes = {};
    for (const name of segmentation.MATTE_NODES) nodes[name] = { input: { required: {} } };
    const options = modelInstalled ? ['birefnet.safetensors'] : [];
    nodes.LoadBackgroundRemovalModel = {
        input: {
            required: {
                bg_removal_name: legacy ? [options] : ['COMBO', { options }]
            }
        }
    };
    return nodes;
}

test('availability is explicit and never reports SAM', () => {
    const ok = segmentation.availability(info(true));
    assert.equal(ok.matte, true);
    assert.equal(ok.method, 'birefnet');
    const legacy = segmentation.availability(info(true, true, true));
    assert.equal(legacy.matte, true);
    const noModel = segmentation.availability(info(true, false));
    assert.equal(noModel.matte, false);
    assert.equal(noModel.method, 'pose');
    assert.ok(noModel.missing.some((item) => /birefnet/i.test(item)));
    const none = segmentation.availability(null);
    assert.equal(none.matte, false);
    assert.equal(none.method, 'pose');
});

test('capsuleSupport covers the performer inside the rough bbox', () => {
    const points = body(32, 8, 48);
    const support = segmentation.capsuleSupport(points, 64, 64, 4);
    let count = 0;
    for (const value of support) if (value) count += 1;
    assert.ok(count > 50);
    const box = bboxOf(points);
    const inside = support[Math.round(box.y + box.height * 0.5) * 64 + Math.round(box.x + box.width * 0.5)];
    assert.equal(inside, 255);
});

test('buildRawMasks intersects the matte with each person and keeps owners exclusive', async () => {
    const project = characterState.createProject({ sessionId: 'seg' });
    characterState.update(project.id, (current) => {
        current.part = { file: 'part.mp4', width: 64, height: 64, fps: 24, frames: 1 };
        current.people = [characterState.newPerson(0), characterState.newPerson(1)];
        current.people[0].selectionId = 'track_1';
        current.people[1].selectionId = 'track_2';
        current.maskSettings = { grow: 0, feather: 0, temporal: 0, opacity: 0.55 };
        current.selection = {
            tracks: [
                { id: 'track_1', label: 'Person 1', bbox: { x: 10, y: 8, width: 20, height: 44 } },
                { id: 'track_2', label: 'Person 2', bbox: { x: 34, y: 8, width: 20, height: 44 } }
            ]
        };
    });
    const current = characterState.get(project.id);
    const matteDir = path.join(characterState.projectDir(project.id), 'segmentation', 'matte');
    fs.mkdirSync(matteDir, { recursive: true });
    const matte = new Uint8Array(64 * 64);
    for (let y = 6; y < 54; y += 1) {
        for (let x = 8; x < 56; x += 1) matte[y * 64 + x] = 255;
    }
    media.writeMask(path.join(matteDir, media.frameName(0)), matte, 64, 64);

    const keypointFrames = [{
        frame: 0,
        people: [
            { trackId: 'track_1', bbox: bboxOf(body(20, 8, 44)), body: body(20, 8, 44), leftHand: [], rightHand: [] },
            { trackId: 'track_2', bbox: bboxOf(body(44, 8, 44)), body: body(44, 8, 44), leftHand: [], rightHand: [] }
        ]
    }];
    const result = await segmentation.buildRawMasks(
        current,
        { dir: 'segmentation/matte', width: 64, height: 64, frames: 1 },
        'birefnet',
        keypointFrames
    );
    const first = await media.readMask(path.join(characterState.projectDir(project.id), result.people[current.people[0].id].dir, media.frameName(0)));
    const second = await media.readMask(path.join(characterState.projectDir(project.id), result.people[current.people[1].id].dir, media.frameName(0)));
    let firstCount = 0;
    let secondCount = 0;
    let shared = 0;
    let outsideMatte = 0;
    for (let i = 0; i < 64 * 64; i += 1) {
        if (first.values[i] >= 128) firstCount += 1;
        if (second.values[i] >= 128) secondCount += 1;
        if (first.values[i] >= 128 && second.values[i] >= 128) shared += 1;
        if ((first.values[i] >= 128 || second.values[i] >= 128) && matte[i] < 128) outsideMatte += 1;
    }
    assert.ok(firstCount > 30);
    assert.ok(secondCount > 30);
    assert.equal(shared, 0);
    assert.equal(outsideMatte, 0);
});
