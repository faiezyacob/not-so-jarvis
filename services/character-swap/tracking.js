/* ============================================
   JARVIS — Character Swap SAM 3.1 tracking
   Anchor planning, mask detection, video
   tracking, gap filling and lost-span reporting.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const comfyui = require('../comfyui');
const media = require('./media');

const SAM_CHECKPOINT = process.env.CHARACTER_SWAP_SAM_MODEL || 'sam3.1_multiplex_fp16.safetensors';
const TRACK_TIMEOUT_MS = Number(process.env.CHARACTER_SWAP_TRACK_TIMEOUT_MS) || 45 * 60 * 1000;

function node(classType, inputs) {
    return { class_type: classType, inputs: inputs || {} };
}

function pointsJson(points) {
    return JSON.stringify((Array.isArray(points) ? points : []).map((p) => ({
        x: Math.round(Number(p.x)),
        y: Math.round(Number(p.y))
    })));
}

function planSegments(anchors, frames) {
    if (!Array.isArray(anchors) || !anchors.length) throw new Error('Add at least one anchor first.');
    const ordered = anchors.slice().sort((a, b) => a.frame - b.frame);
    const marked = ordered.map((a) => Number(a.frame));
    if (new Set(marked).size !== marked.length) throw new Error('Each frame can hold only one anchor.');
    if (marked.some((frame) => frame < 0 || frame >= frames)) throw new Error('An anchor lies outside the trimmed clip.');
    const segments = [];
    if (marked[0] > 0) {
        segments.push({ anchor: ordered[0], start: 0, length: marked[0] + 1, backward: true });
    }
    for (let i = 0; i < ordered.length; i += 1) {
        const anchor = ordered[i];
        const end = i + 1 < ordered.length ? ordered[i + 1].frame : frames;
        segments.push({ anchor, start: anchor.frame, length: end - anchor.frame, backward: false });
    }
    return segments.filter((segment) => segment.length > 0);
}

function detectGraph(frameName, anchor) {
    const inputs = {
        model: ['sam', 0],
        image: ['frame', 0],
        positive_coords: pointsJson(anchor.positive),
        threshold: 0.5,
        refine_iterations: 2,
        individual_masks: false
    };
    if (Array.isArray(anchor.negative) && anchor.negative.length) {
        inputs.negative_coords = pointsJson(anchor.negative);
    }
    return {
        sam: node('CheckpointLoaderSimple', { ckpt_name: SAM_CHECKPOINT }),
        frame: node('LoadImage', { image: frameName }),
        detect: node('SAM3_Detect', inputs),
        mask_image: node('MaskToImage', { mask: ['detect', 0] }),
        save: node('SaveImage', { images: ['mask_image', 0], filename_prefix: 'jarvis_cs/detect' })
    };
}

function trackGraph(sourceName, reversedName, segments, frames) {
    const graph = {
        sam: node('CheckpointLoaderSimple', { ckpt_name: SAM_CHECKPOINT })
    };
    const source = (name, id) => {
        if (!name) return null;
        graph[id + '_file'] = node('LoadVideo', { file: name });
        graph[id] = node('GetVideoComponents', { video: [id + '_file', 0] });
        return id;
    };
    const forward = source(sourceName, 'forward');
    const backward = source(reversedName, 'backward');
    segments.forEach((segment, index) => {
        const base = segment.backward ? backward : forward;
        if (!base) throw new Error('Tracking needs the source video.');
        const part = 'part_' + index;
        const first = 'first_' + index;
        graph[part] = node('ImageFromBatch', {
            image: [base, 0],
            batch_index: segment.backward ? Math.max(0, frames - 1 - segment.anchor.frame) : segment.start,
            length: segment.length
        });
        graph[first] = node('ImageFromBatch', { image: [part, 0], batch_index: 0, length: 1 });
        const inputs = {
            model: ['sam', 0],
            image: [first, 0],
            positive_coords: pointsJson(segment.anchor.positive),
            threshold: 0.5,
            refine_iterations: 2,
            individual_masks: false
        };
        if (Array.isArray(segment.anchor.negative) && segment.anchor.negative.length) {
            inputs.negative_coords = pointsJson(segment.anchor.negative);
        }
        graph['detect_' + index] = node('SAM3_Detect', inputs);
        graph['track_' + index] = node('SAM3_VideoTrack', {
            images: [part, 0],
            model: ['sam', 0],
            initial_mask: ['detect_' + index, 0],
            detection_threshold: 0.5,
            max_objects: 1,
            detect_interval: 1
        });
        graph['masks_' + index] = node('SAM3_TrackToMask', {
            track_data: ['track_' + index, 0],
            object_indices: '0'
        });
        graph['mask_image_' + index] = node('MaskToImage', { mask: ['masks_' + index, 0] });
        graph['video_' + index] = node('CreateVideo', {
            images: ['mask_image_' + index, 0],
            fps: media.FPS
        });
        graph['save_' + index] = node('SaveVideo', {
            video: ['video_' + index, 0],
            filename_prefix: 'jarvis_cs/track_' + index,
            format: 'auto',
            codec: 'auto'
        });
    });
    return graph;
}

function outputFile(history, nodeId, extRe) {
    const output = history && history.outputs && history.outputs[nodeId];
    if (!output) return null;
    const files = comfyui.findOutputFiles(output, extRe || /\.(?:mp4|webm|mov|mkv)$/i);
    return files.length ? files[files.length - 1] : null;
}

async function assertSamReady() {
    const info = await comfyui.getObjectInfo();
    for (const name of ['CheckpointLoaderSimple', 'SAM3_Detect', 'SAM3_VideoTrack', 'SAM3_TrackToMask', 'MaskToImage', 'CreateVideo', 'SaveVideo', 'LoadVideo', 'GetVideoComponents', 'ImageFromBatch']) {
        if (!info || !Object.prototype.hasOwnProperty.call(info, name)) {
            const err = new Error('Character Swap needs the ComfyUI node "' + name + '". Update ComfyUI and try again.');
            err.code = 'character_swap_node_missing';
            throw err;
        }
    }
    const required = info.CheckpointLoaderSimple && info.CheckpointLoaderSimple.input &&
        info.CheckpointLoaderSimple.input.required && info.CheckpointLoaderSimple.input.required.ckpt_name;
    const choices = Array.isArray(required) && Array.isArray(required[0]) ? required[0] : [];
    if (choices.length && !choices.some((name) => String(name).toLowerCase() === SAM_CHECKPOINT.toLowerCase())) {
        const err = new Error('The SAM 3.1 checkpoint "' + SAM_CHECKPOINT + '" is not installed in ComfyUI/models/checkpoints.');
        err.code = 'character_swap_sam_missing';
        throw err;
    }
    return info;
}

async function detectOnce(uploadedName, anchor, workDir, suffix) {
    const graph = detectGraph(uploadedName, anchor);
    const pid = await comfyui.queuePrompt(graph);
    const history = await comfyui.waitForPrompt(pid, { timeoutMs: 10 * 60 * 1000 });
    const entry = outputFile(history, 'save', /\.(?:png|jpg|jpeg|webp)$/i);
    if (!entry) throw new Error('SAM 3.1 did not return a mask. Tap directly on the person and try again.');
    const bufferOut = await comfyui.downloadImage(entry);
    await comfyui.deleteOutputFile(entry, { history: pid }).catch(() => {});
    const maskPath = path.join(workDir, 'anchor-mask-' + anchor.frame + (suffix || '') + '.png');
    fs.writeFileSync(maskPath, bufferOut);
    const mask = await media.readMask(maskPath);
    mask.values = media.removeSpecks(mask.values, mask.width, mask.height);
    if (!mask.values.some((value) => value >= 128)) {
        throw new Error('Nobody was found where you tapped. Tap on the person, not the background.');
    }
    return { maskPath, mask };
}

function bodyPoints(mask, positive) {
    const box = media.bbox(mask.values, mask.width, mask.height);
    if (!box) return [];
    const height = mask.height;
    const width = mask.width;
    const bottom = box.y + box.height;
    const headSized = box.height < height * 0.45 && bottom < height * 0.7;
    if (!headSized) return [];
    const centre = box.x + box.width * 0.5;
    const extra = [];
    [0.35, 0.9, 1.55, 2.2].forEach((factor) => {
        const y = Math.round(bottom + box.height * factor);
        if (y >= height - 4) return;
        extra.push({ x: Math.max(2, Math.min(width - 2, Math.round(centre))), y });
    });
    const seen = new Set((positive || []).map((p) => p.x + ',' + p.y));
    return extra.filter((point) => !seen.has(point.x + ',' + point.y));
}

async function detectAnchor(projectId, partPath, anchor, workDir) {
    await assertSamReady();
    const framePath = path.join(workDir, 'anchor-' + anchor.frame + '.png');
    await media.extractFrame(partPath, anchor.frame, framePath);
    let uploaded = null;
    try {
        const buffer = fs.readFileSync(framePath);
        uploaded = await comfyui.uploadFile(buffer, 'jarvis_cs_anchor_' + projectId + '_' + anchor.frame + '.png', { mime: 'image/png' });
        let positive = anchor.positive;
        let result = await detectOnce(uploaded.name, Object.assign({}, anchor, { positive }), workDir, '');
        const extra = bodyPoints(result.mask, positive);
        if (extra.length) {
            // A head-only tap makes SAM return only the head. Add points down the
            // visible torso/legs and re-run once; keep the larger mask.
            const combined = positive.concat(extra);
            const expanded = await detectOnce(uploaded.name, Object.assign({}, anchor, { positive: combined }), workDir, '-body');
            const before = result.mask.values.reduce((sum, value) => sum + (value >= 128 ? 1 : 0), 0);
            const after = expanded.mask.values.reduce((sum, value) => sum + (value >= 128 ? 1 : 0), 0);
            if (after > before * 1.25) {
                result = expanded;
                positive = combined;
            }
        }
        return { maskPath: result.maskPath, mask: result.mask, positive };
    } finally {
        if (uploaded && uploaded.name) await comfyui.deleteInputFile(uploaded.name).catch(() => {});
    }
}

async function trackPerson(options) {
    const {
        projectId,
        person,
        sourceName,
        reversedName,
        frames,
        workDir
    } = options;
    if (!frames) throw new Error('The trimmed clip has no frames.');
    await assertSamReady();
    fs.mkdirSync(workDir, { recursive: true });
    const anchors = (person.anchors || []).map((anchor) => ({
        frame: anchor.frame,
        positive: anchor.positive,
        negative: anchor.negative || []
    }));
    const segments = planSegments(anchors, frames);
    const needsReverse = segments.some((segment) => segment.backward);
    if (needsReverse && !reversedName) throw new Error('Tracking from an anchor needs the reversed source video.');
    const graph = trackGraph(sourceName, reversedName, segments, frames);
    const pid = await comfyui.queuePrompt(graph);
    const history = await comfyui.waitForPrompt(pid, { timeoutMs: TRACK_TIMEOUT_MS });
    const segmentFrames = [];
    for (let index = 0; index < segments.length; index += 1) {
        const entry = outputFile(history, 'save_' + index);
        if (!entry) throw new Error('SAM 3.1 did not return masks for part of the clip.');
        const buffer = await comfyui.downloadImage(entry);
        const videoPath = path.join(workDir, 'segment-' + index + '.mp4');
        fs.writeFileSync(videoPath, buffer);
        const dir = path.join(workDir, 'segment-' + index);
        await media.extractFrames(videoPath, dir);
        segmentFrames.push({ segment: segments[index], dir });
        await comfyui.deleteOutputFile(entry, { history: pid }).catch(() => {});
    }
    return assemble(segments, segmentFrames, frames, workDir);
}

async function assemble(segments, segmentFrames, frames, workDir) {
    let width = 0;
    let height = 0;
    const masks = new Array(frames).fill(null);
    for (const item of segmentFrames) {
        const files = media.listFrames(item.dir);
        if (!files.length) throw new Error('SAM 3.1 returned an empty mask video.');
        for (let i = 0; i < item.segment.length; i += 1) {
            const file = files[i];
            if (!file) continue;
            const mask = await media.readMask(path.join(item.dir, file));
            mask.values = media.removeSpecks(mask.values, mask.width, mask.height);
            width = mask.width;
            height = mask.height;
            const index = item.segment.backward
                ? item.segment.anchor.frame - i
                : item.segment.start + i;
            if (index < 0 || index >= frames) continue;
            masks[index] = mask.values;
        }
    }
    if (!width || !height) throw new Error('SAM 3.1 returned no usable masks.');
    if (!masks.some((mask) => mask && mask.some((value) => value >= 128))) {
        throw new Error('The person was not found in any tracked frame. Add a fresh anchor.');
    }
    const filled = media.fillGaps(masks);
    const outDir = path.join(workDir, 'frames');
    fs.mkdirSync(outDir, { recursive: true });
    for (let index = 0; index < filled.length; index += 1) {
        const values = filled[index] || media.emptyMask(width, height);
        media.writeMask(path.join(outDir, media.frameName(index)), values, width, height);
    }
    const first = await media.readMask(path.join(outDir, media.frameName(0)));
    return {
        width,
        height,
        frames: filled.length,
        dir: outDir,
        lostSpans: lostSpans(masks, media.FPS),
        x: media.centroid(first.values, width, height)
    };
}

function lostSpans(masks, fps) {
    const spans = [];
    let start = -1;
    for (let index = 0; index <= masks.length; index += 1) {
        const empty = index === masks.length || !masks[index] || !masks[index].some((value) => value >= 128);
        if (empty && start < 0) start = index;
        if (!empty && start >= 0) {
            spans.push([Number((start / fps).toFixed(2)), Number((index / fps).toFixed(2))]);
            start = -1;
        }
    }
    return spans;
}

function temporaryName(prefix) {
    return prefix + '_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
}

module.exports = {
    SAM_CHECKPOINT,
    planSegments,
    detectGraph,
    trackGraph,
    detectAnchor,
    trackPerson,
    bodyPoints,
    assemble,
    lostSpans,
    assertSamReady,
    temporaryName
};
