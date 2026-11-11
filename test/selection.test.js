/* ============================================
   JARVIS — Wan person selection (no SAM)
   Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const selection = require('../services/character-swap/selection');

function kp(x, y, c = 1) {
    return { x, y, c };
}

// A compact 18-point COCO body centred on (cx, top) with height h.
function body(cx, top, h) {
    return [
        kp(cx, top),                     // nose
        kp(cx, top + h * 0.1),           // neck
        kp(cx + h * 0.12, top + h * 0.12), // r shoulder
        kp(cx + h * 0.2, top + h * 0.3),  // r elbow
        kp(cx + h * 0.24, top + h * 0.48), // r wrist
        kp(cx - h * 0.12, top + h * 0.12), // l shoulder
        kp(cx - h * 0.2, top + h * 0.3),  // l elbow
        kp(cx - h * 0.24, top + h * 0.48), // l wrist
        kp(cx + h * 0.08, top + h * 0.5), // r hip
        kp(cx + h * 0.09, top + h * 0.75), // r knee
        kp(cx + h * 0.1, top + h),        // r ankle
        kp(cx - h * 0.08, top + h * 0.5), // l hip
        kp(cx - h * 0.09, top + h * 0.75), // l knee
        kp(cx - h * 0.1, top + h),        // l ankle
        kp(cx + h * 0.03, top + 0.02 * h), // r eye
        kp(cx - h * 0.03, top + 0.02 * h), // l eye
        kp(cx + h * 0.06, top + 0.03 * h), // r ear
        kp(cx - h * 0.06, top + 0.03 * h)  // l ear
    ];
}

function flat(points) {
    const out = [];
    for (const point of points) out.push(point.x, point.y, point.c);
    return out;
}

function frameWith(pointsList, index) {
    return {
        frame: index,
        width: 640,
        height: 360,
        people: pointsList.map((points) => ({
            body: points,
            leftHand: [],
            rightHand: [],
            bbox: bbox(points),
            score: 1,
            trackId: null
        }))
    };
}

function bbox(points) {
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

test('parseTriples accepts flat and triplet keypoints', () => {
    const flatPoints = selection.parseTriples([1, 2, 1, 3, 4, 0.5]);
    assert.equal(flatPoints.length, 2);
    assert.equal(flatPoints[1].x, 3);
    assert.equal(flatPoints[1].c, 0.5);
    const triplets = selection.parseTriples([[1, 2, 1], [3, 4, 0]]);
    assert.equal(triplets.length, 2);
    assert.equal(triplets[0].y, 2);
});

test('parseKeypointFrames builds bboxes and drops empty detections', () => {
    const json = [{
        canvas_width: 640,
        canvas_height: 360,
        people: [
            { pose_keypoints_2d: flat(body(320, 80, 200)), hand_left_keypoints_2d: null, hand_right_keypoints_2d: null },
            { pose_keypoints_2d: flat([kp(0, 0, 0), kp(0, 0, 0), kp(0, 0, 0)]), hand_left_keypoints_2d: null, hand_right_keypoints_2d: null }
        ]
    }];
    const frames = selection.parseKeypointFrames(json, 640, 360);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].people.length, 1);
    const box = frames[0].people[0].bbox;
    assert.ok(box.width > 40 && box.height > 150);
    assert.ok(box.x >= 0 && box.y >= 0);
});

test('trackPeople keeps one stable ID through motion and a short occlusion', () => {
    const frames = [
        frameWith([body(200, 60, 200)], 0),
        frameWith([body(205, 62, 200)], 1),
        frameWith([], 2),
        frameWith([body(212, 64, 200)], 3),
        frameWith([body(560, 60, 200)], 4)
    ];
    const framesOnly = frames.map((frame, index) => ({ ...frame, frame: index }));
    const tracks = selection.summarize(framesOnly, [], 24);
    // The same person keeps one ID through the gap; the far-away detection at
    // the end may start a new track but must not inherit the old one silently.
    const first = tracks.find((track) => track.firstFrame === 0);
    assert.ok(first);
    assert.ok(first.frames >= 3);
    assert.equal(first.lostSpans.length, 1);
});

test('summarize applies a manual ID correction and recomputes track membership', () => {
    const frames = [
        frameWith([body(150, 60, 200), body(400, 60, 200)], 0),
        frameWith([body(152, 60, 200), body(402, 60, 200)], 1),
        frameWith([body(154, 60, 200), body(404, 60, 200)], 2)
    ];
    const base = selection.summarize(frames, [], 24);
    assert.equal(base.length, 2);
    const target = base[0];
    // Force the first detection on frame 1 onto the second track.
    const corrected = selection.summarize(JSON.parse(JSON.stringify(frames)), [
        { frame: 1, detectionIndex: 0, trackId: base[1].id }
    ], 24);
    const moved = corrected.find((track) => track.id === base[1].id);
    assert.equal(moved.frames, 3);
    const lost = corrected.find((track) => track.id === target.id);
    assert.equal(lost.frames, 2);
});

test('buildGraph asks DWPose for body+hand keypoints and saves them as JSON', () => {
    const graph = selection.buildGraph({ sourceName: 'clip.mp4', width: 640, height: 360, prefix: 'jarvis_cs/selection_test' });
    assert.equal(graph.dw.class_type, 'DWPreprocessor');
    assert.equal(graph.dw.inputs.detect_body, 'enable');
    assert.equal(graph.dw.inputs.detect_hand, 'enable');
    assert.equal(graph.dw.inputs.detect_face, 'disable');
    assert.equal(graph.save.class_type, 'SavePoseKpsAsJsonFile');
    assert.deepEqual(graph.save.inputs.pose_kps, ['dw', 1]);
    assert.equal(graph.save.inputs.filename_prefix, 'jarvis_cs/selection_test');
});

test('trackFrameBoxes returns only the requested track in frame order', () => {
    const frames = [
        { frame: 2, people: [{ trackId: '1', bbox: { x: 20, y: 10, width: 40, height: 90 } }, { trackId: '2', bbox: { x: 200, y: 10, width: 40, height: 90 } }] },
        { frame: 0, people: [{ trackId: '2', bbox: { x: 200, y: 10, width: 40, height: 90 } }] },
        { frame: 1, people: [{ trackId: '1', bbox: { x: 25, y: 12, width: 42, height: 92 } }] }
    ];
    const boxes = selection.trackFrameBoxes(frames, '1');
    assert.deepEqual(boxes.map((item) => item.frame), [1, 2]);
    assert.equal(boxes[0].bbox.x, 25);
    assert.deepEqual(selection.trackFrameBoxes(frames, '3'), []);
    assert.deepEqual(selection.trackFrameBoxes(null, '1'), []);
});

test('frameBoxes strips keypoints and expands the display box to include the head', () => {
    const frames = [frameWith([body(200, 80, 200)], 0)];
    frames[0].people[0].trackId = 'track_1';
    const boxes = selection.frameBoxes(frames);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].people[0].trackId, 'track_1');
    assert.equal(boxes[0].people[0].body, undefined);
    assert.ok(boxes[0].people[0].displayBbox.y < boxes[0].people[0].bbox.y);
    assert.ok(boxes[0].people[0].displayBbox.height > boxes[0].people[0].bbox.height);
    assert.ok(boxes[0].people[0].displayBbox.x >= 0);
    assert.ok(boxes[0].people[0].displayBbox.y >= 0);
    assert.deepEqual(selection.frameBoxes(null), []);
});

test('frameBoxes keeps separate boxes for two people in the same frame', () => {
    const frames = [frameWith([body(150, 60, 200), body(500, 60, 200)], 0)];
    frames[0].people[0].trackId = 'track_1';
    frames[0].people[1].trackId = 'track_4';
    const boxes = selection.frameBoxes(frames);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].people.length, 2);
    assert.deepEqual(boxes[0].people.map((person) => person.trackId), ['track_1', 'track_4']);
    assert.notDeepEqual(boxes[0].people[0].displayBbox, boxes[0].people[1].displayBbox);
});

test('reliableDetection rejects degenerate close-up detections', () => {
    const validBody = body(320, 80, 200);
    assert.equal(selection.reliableDetection(
        { body: validBody, bbox: bbox(validBody) },
        bbox(validBody), 640, 360
    ), true);
    const thin = { body: [kp(300, 10), kp(20, 20), kp(620, 20)], bbox: { x: 20, y: 10, width: 600, height: 2 } };
    assert.equal(selection.reliableDetection(thin, thin.bbox, 640, 360), false);
    const wide = {
        body: [kp(10, 20), kp(320, 20), kp(630, 20), kp(5, 200), kp(635, 200), kp(100, 300)],
        bbox: { x: 5, y: 20, width: 630, height: 280 }
    };
    assert.equal(selection.reliableDetection(wide, wide.bbox, 640, 360), false);
    const sparse = { body: [kp(100, 100), kp(110, 100), kp(120, 100)], bbox: { x: 100, y: 100, width: 100, height: 100 } };
    assert.equal(selection.reliableDetection(sparse, sparse.bbox, 640, 360), false);
});

test('frameBoxes drops an unreliable detection but keeps a valid one in the same frame', () => {
    const frames = [frameWith([body(200, 80, 200)], 0)];
    frames[0].people[0].trackId = 'track_good';
    frames[0].people.push({
        body: [kp(300, 10), kp(20, 20), kp(620, 20)],
        bbox: { x: 20, y: 10, width: 600, height: 2 },
        score: 1,
        trackId: 'track_bad'
    });
    const boxes = selection.frameBoxes(frames);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].people.length, 1);
    assert.equal(boxes[0].people[0].trackId, 'track_good');
});
