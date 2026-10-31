/* ============================================
   JARVIS — Character Swap person selection
   DWPose-driven person detection, stable
   tracking, thumbnails and manual correction.
   Independent of the SAM tracking path.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const comfyui = require('../comfyui');
const media = require('./media');
const characterState = require('./state');

const METHOD = 'dwpose';
const VERSION = 'selection-v1';
const CHUNK = 64;
const MIN_SCORE = 0.15;
const COAST_FRAMES = 12;
const SELECTION_TIMEOUT_MS = Number(process.env.CHARACTER_SWAP_SELECTION_TIMEOUT_MS) || 30 * 60 * 1000;

const BODY_PAIRS = [
    [1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [1, 11],
    [8, 9], [9, 10], [11, 12], [12, 13], [8, 11], [8, 2], [11, 5], [0, 1]
];

function node(classType, inputs) {
    return { class_type: classType, inputs: inputs || {} };
}

function rngToken() {
    return crypto.randomBytes(4).toString('hex');
}

function parseTriples(value) {
    if (!Array.isArray(value)) return [];
    if (Array.isArray(value[0])) {
        return value.map((item) => ({
            x: Number(item[0]) || 0,
            y: Number(item[1]) || 0,
            c: item.length > 2 ? (Number(item[2]) || 0) : 1
        }));
    }
    const out = [];
    for (let i = 0; i + 2 < value.length; i += 3) {
        out.push({ x: Number(value[i]) || 0, y: Number(value[i + 1]) || 0, c: Number(value[i + 2]) || 0 });
    }
    return out;
}

function validPoints(points) {
    return (points || []).filter((point) => point && point.c > 0.05 && Number.isFinite(point.x) && Number.isFinite(point.y));
}

function bboxOf(points, width, height) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of points) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
    }
    if (!Number.isFinite(minX)) return null;
    const x = Math.max(0, Math.min(width - 1, minX));
    const y = Math.max(0, Math.min(height - 1, minY));
    const x2 = Math.max(x + 1, Math.min(width, maxX));
    const y2 = Math.max(y + 1, Math.min(height, maxY));
    return { x, y, width: x2 - x, height: y2 - y };
}

// Parse the DWPreprocessor POSE_KEYPOINT JSON (one dict per frame, COCO body
// keypoints as a flat [x, y, conf, ...] array). Faces are intentionally not
// used here; they feed Wan's face_video separately from untouched frames.
function parseKeypointFrames(json, width, height) {
    const frames = Array.isArray(json) ? json.flat(2) : [];
    return frames.map((frame, index) => {
        const canvasWidth = Number(frame && frame.canvas_width) || width;
        const canvasHeight = Number(frame && frame.canvas_height) || height;
        const people = [];
        for (const person of (frame && frame.people) || []) {
            const body = parseTriples(person.pose_keypoints_2d);
            const leftHand = parseTriples(person.hand_left_keypoints_2d);
            const rightHand = parseTriples(person.hand_right_keypoints_2d);
            const bodyValid = validPoints(body);
            if (bodyValid.length < 3) continue;
            const all = bodyValid.concat(validPoints(leftHand), validPoints(rightHand));
            const box = bboxOf(all, canvasWidth, canvasHeight);
            if (!box) continue;
            const score = bodyValid.reduce((sum, point) => sum + Math.min(1, point.c), 0) / bodyValid.length;
            if (score < MIN_SCORE) continue;
            people.push({
                body: body.map((point) => ({ x: point.x, y: point.y, c: point.c })),
                leftHand: leftHand.map((point) => ({ x: point.x, y: point.y, c: point.c })),
                rightHand: rightHand.map((point) => ({ x: point.x, y: point.y, c: point.c })),
                bbox: box,
                score,
                trackId: null
            });
        }
        return { frame: index, width: canvasWidth, height: canvasHeight, people };
    });
}

function iou(a, b) {
    if (!a || !b) return 0;
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    if (!inter) return 0;
    const union = a.width * a.height + b.width * b.height - inter;
    return union > 0 ? inter / union : 0;
}

function centre(box) {
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function centreDistance(a, b, frameWidth, frameHeight) {
    const ca = centre(a);
    const cb = centre(b);
    const diagonal = Math.hypot(frameWidth || 1, frameHeight || 1);
    return Math.hypot(ca.x - cb.x, ca.y - cb.y) / Math.max(1, diagonal);
}

// Greedy IoU tracker with centroid fallback and short occlusion coasting.
// Stable IDs only; labels are assigned afterwards so they read left-to-right.
function trackPeople(frames, options = {}) {
    const coast = Math.max(1, Math.min(60, Number(options.coast) || COAST_FRAMES));
    let nextId = 1;
    let active = [];
    const tracks = new Map();
    const ordered = frames.slice().sort((a, b) => a.frame - b.frame);

    const newTrack = (frame, detection) => {
        const id = 'track_' + nextId++;
        const track = {
            id,
            label: '',
            sourceIndex: 0,
            firstFrame: frame.frame,
            lastFrame: frame.frame,
            frames: 0,
            missed: 0,
            bbox: detection.bbox,
            score: detection.score,
            thumbFrame: frame.frame
        };
        tracks.set(id, track);
        return id;
    };

    for (const frame of ordered) {
        const detections = frame.people.slice().sort((a, b) => b.score - a.score);
        const pairs = [];
        for (const track of active) {
            for (let i = 0; i < detections.length; i += 1) {
                const overlap = iou(track.bbox, detections[i].bbox);
                if (overlap >= 0.2) pairs.push({ track, index: i, overlap, distance: 0 });
            }
        }
        pairs.sort((a, b) => b.overlap - a.overlap);
        const usedDetections = new Set();
        const matchedTracks = new Set();
        for (const pair of pairs) {
            if (usedDetections.has(pair.index) || matchedTracks.has(pair.track.id)) continue;
            usedDetections.add(pair.index);
            matchedTracks.add(pair.track.id);
            assign(frame, detections[pair.index], pair.track);
        }
        // Centroid fallback for fast motion / brief overlap.
        for (const track of active) {
            if (matchedTracks.has(track.id)) continue;
            let best = -1;
            let bestDistance = 0.12;
            for (let i = 0; i < detections.length; i += 1) {
                if (usedDetections.has(i)) continue;
                const distance = centreDistance(track.bbox, detections[i].bbox, frame.width, frame.height);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = i;
                }
            }
            if (best >= 0) {
                usedDetections.add(best);
                matchedTracks.add(track.id);
                assign(frame, detections[best], track);
            }
        }
        for (let i = 0; i < detections.length; i += 1) {
            if (usedDetections.has(i)) continue;
            const track = tracks.get(newTrack(frame, detections[i]));
            detections[i].trackId = track.id;
            track.frames += 1;
            track.lastFrame = frame.frame;
            track.matched = true;
            active.push(track);
            matchedTracks.add(track.id);
        }
        active = active.filter((track) => {
            if (matchedTracks.has(track.id)) {
                track.missed = 0;
                return true;
            }
            track.missed += 1;
            return track.missed <= coast;
        });
    }

    const list = Array.from(tracks.values())
        .filter((track) => track.frames > 0)
        .sort((a, b) => (a.firstFrame - b.firstFrame) || (a.bbox.x - b.bbox.x));
    list.forEach((track, index) => {
        track.sourceIndex = index;
        track.label = 'Person ' + (index + 1);
        delete track.matched;
        delete track.missed;
    });
    return list;

    function assign(frame, detection, track) {
        detection.trackId = track.id;
        track.bbox = detection.bbox;
        track.lastFrame = frame.frame;
        track.frames += 1;
        track.missed = 0;
        if (detection.score >= track.score || track.thumbFrame === undefined) {
            track.score = detection.score;
            track.thumbFrame = frame.frame;
        }
        track.matched = true;
    }
}

// Apply user corrections before track summaries are built. A correction names
// the frame and either a detection index or a point inside the detection box.
function applyCorrections(frames, corrections) {
    for (const correction of Array.isArray(corrections) ? corrections : []) {
        const frame = frames[Number(correction.frame)];
        if (!frame) continue;
        let index = Number.isInteger(correction.detectionIndex) ? correction.detectionIndex : -1;
        if (index < 0 || index >= frame.people.length) {
            const x = Number(correction.x);
            const y = Number(correction.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            let best = -1;
            let bestDistance = Infinity;
            frame.people.forEach((person, i) => {
                const box = person.bbox;
                const inside = x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
                const distance = Math.hypot(
                    x - (box.x + box.width / 2),
                    y - (box.y + box.height / 2)
                ) - (inside ? 1e9 : 0);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = i;
                }
            });
            index = best;
        }
        if (index < 0) continue;
        const detection = frame.people[index];
        if (correction.trackId) detection.trackId = String(correction.trackId);
    }
    return frames;
}

function lostSpans(perFrame, fps) {
    const spans = [];
    let start = -1;
    for (let frame = 0; frame <= perFrame.length; frame += 1) {
        const missing = frame === perFrame.length || !perFrame[frame];
        if (missing && start < 0) start = frame;
        if (!missing && start >= 0) {
            spans.push([Number((start / fps).toFixed(2)), Number((frame / fps).toFixed(2))]);
            start = -1;
        }
    }
    return spans;
}

function summarize(frames, corrections, fps) {
    const tracked = trackPeople(frames);
    applyCorrections(frames, corrections);
    const detectionsByTrack = new Map();
    for (const frame of frames) {
        const seen = new Set();
        for (const person of frame.people) {
            if (!person.trackId || seen.has(person.trackId)) continue;
            seen.add(person.trackId);
            if (!detectionsByTrack.has(person.trackId)) detectionsByTrack.set(person.trackId, []);
            detectionsByTrack.get(person.trackId).push({ frame: frame.frame, bbox: person.bbox, score: person.score });
        }
    }
    const tracks = [];
    for (const track of tracked) {
        const entries = detectionsByTrack.get(track.id) || [];
        if (!entries.length) continue;
        const best = entries.reduce((winner, item) => (item.score > winner.score ? item : winner), entries[0]);
        track.firstFrame = entries[0].frame;
        track.lastFrame = entries[entries.length - 1].frame;
        track.frames = entries.length;
        track.score = best.score;
        track.thumbFrame = best.frame;
        track.bbox = best.bbox;
        const perFrame = new Array(frames.length).fill(false);
        for (const item of entries) perFrame[item.frame] = true;
        track.lostSpans = lostSpans(perFrame, fps);
        tracks.push(track);
    }
    tracks.sort((a, b) => (a.firstFrame - b.firstFrame) || (a.bbox.x - b.bbox.x));
    tracks.forEach((track, index) => {
        track.sourceIndex = index;
        track.label = 'Person ' + (index + 1);
    });
    return tracks;
}

function buildGraph(opts) {
    const { sourceName, width, height, prefix } = opts;
    return {
        load: node('LoadVideo', { file: sourceName }),
        src: node('GetVideoComponents', { video: ['load', 0] }),
        ppr: node('PixelPerfectResolution', {
            original_image: ['src', 0],
            image_gen_width: width,
            image_gen_height: height,
            resize_mode: 'Just Resize'
        }),
        dw: node('DWPreprocessor', {
            image: ['src', 0],
            resolution: ['ppr', 0],
            detect_hand: 'enable',
            detect_body: 'enable',
            detect_face: 'disable',
            bbox_detector: 'yolox_l.onnx',
            pose_estimator: 'dw-ll_ucoco_384_bs5.torchscript.pt',
            scale_stick_for_xinsr_cn: 'disable'
        }),
        save: node('SavePoseKpsAsJsonFile', { pose_kps: ['dw', 1], filename_prefix: prefix })
    };
}

async function findJsonOutput(prefix) {
    const root = await comfyui.resolveOutputDir();
    if (!root) return null;
    const folder = path.join(root, path.dirname(prefix));
    const base = path.basename(prefix);
    let names = [];
    try {
        names = fs.readdirSync(folder).filter((name) => name.indexOf(base) === 0 && /\.json$/i.test(name));
    } catch {
        return null;
    }
    if (!names.length) return null;
    names.sort();
    const newest = names[names.length - 1];
    return path.join(folder, newest);
}

async function detect(project, options = {}) {
    const onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
    const partPath = characterStatePart(project);
    if (!partPath || !fs.existsSync(partPath)) throw new Error('The prepared clip is missing. Re-upload the video.');
    const width = Math.max(2, Number(project.part.width) || 1280);
    const height = Math.max(2, Number(project.part.height) || 720);
    const token = rngToken();
    const prefix = 'jarvis_cs/selection_' + token;
    onStage('Detecting people in the clip');

    let uploaded = null;
    let jsonPath = null;
    try {
        const upload = await comfyui.uploadFile(fs.readFileSync(partPath), 'jarvis_cs_selection_' + token + '.mp4', {
            mime: 'video/mp4'
        });
        uploaded = upload.name;
        const graph = buildGraph({ sourceName: upload.name, width, height, prefix });
        const pid = await comfyui.queuePrompt(graph);
        await comfyui.waitForPrompt(pid, { timeoutMs: SELECTION_TIMEOUT_MS, signal: options.signal });
        jsonPath = await findJsonOutput(prefix);
        if (!jsonPath || !fs.existsSync(jsonPath)) {
            throw new Error('The detected people could not be read back from ComfyUI.');
        }
        onStage('Tracking the detected people');
        const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const frames = parseKeypointFrames(raw, width, height);
        if (!frames.some((frame) => frame.people.length)) {
            throw new Error('No people were detected in the clip. Try a clearer or closer shot.');
        }
        const corrections = Array.isArray(project.selection && project.selection.corrections)
            ? project.selection.corrections
            : [];
        const fps = Number(project.part.fps) || media.FPS;
        const tracks = summarize(frames, corrections, fps);
        return { frames, tracks, width, height, token, fps };
    } finally {
        if (uploaded) await comfyui.deleteInputFile(uploaded).catch(() => {});
        if (jsonPath) {
            const outputDir = await comfyui.resolveOutputDir().catch(() => null);
            if (outputDir && jsonPath.indexOf(path.resolve(outputDir)) === 0) {
                try { fs.unlinkSync(jsonPath); } catch { /* best-effort */ }
            }
        }
    }
}

function characterStatePart(project) {
    const rel = project && project.part && project.part.file;
    if (!rel) return null;
    return characterState.absolute(project.id, rel);
}

// 256px crop of each track's best frame. Used by the person cards; the source
// frame itself is never modified.
async function makeThumbnails(project, tracks, outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const partPath = characterStatePart(project);
    const width = Math.max(2, Number(project.part.width) || 1280);
    const height = Math.max(2, Number(project.part.height) || 720);
    for (const track of tracks) {
        const box = track.bbox;
        const frame = Number.isFinite(track.thumbFrame) ? track.thumbFrame : 0;
        const padX = Math.max(4, Math.round(box.width * 0.18));
        const padY = Math.max(4, Math.round(box.height * 0.12));
        const x = Math.max(0, Math.min(width - 2, box.x - padX));
        const y = Math.max(0, Math.min(height - 2, box.y - padY));
        const w = Math.max(2, Math.min(width - x, box.width + padX * 2));
        const h = Math.max(2, Math.min(height - y, box.height + padY * 2));
        const framePath = path.join(outDir, 'frame-' + track.id + '.png');
        const thumbPath = path.join(outDir, 'thumb-' + track.id + '.png');
        try {
            await media.extractFrame(partPath, frame, framePath);
            await media.run([
                '-hide_banner', '-y', '-i', framePath,
                '-vf', 'crop=' + w + ':' + h + ':' + x + ':' + y + ',scale=256:256:force_original_aspect_ratio=decrease',
                '-frames:v', '1', thumbPath
            ], { code: 'character_swap_selection_thumb_failed' });
            track.thumb = thumbPath;
        } catch {
            track.thumb = null;
        } finally {
            try { fs.unlinkSync(framePath); } catch { /* optional */ }
        }
    }
    return tracks;
}

module.exports = {
    METHOD,
    VERSION,
    BODY_PAIRS,
    parseTriples,
    parseKeypointFrames,
    trackPeople,
    applyCorrections,
    summarize,
    lostSpans,
    buildGraph,
    detect,
    makeThumbnails,
    characterStatePart
};
