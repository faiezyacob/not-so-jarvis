/* ============================================
   JARVIS — DWPose point prompts
   Turns the selected DWPose track into the
   positive/negative SAM 3.1 point prompts used
   by the SCAIL-2 target tracker. Identity stays
   keyed to the selected track; other people and
   the frame corners become negative prompts.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');

const MIN_CONFIDENCE = 0.25;
const ANCHOR_POINT_INDICES = [0, 1, 2, 5, 8, 11, 9, 12, 10, 13];

function validBody(person) {
    return ((person && person.body) || []).filter((point) =>
        point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)) &&
        (point.c === undefined ? 1 : Number(point.c)) >= MIN_CONFIDENCE);
}

function mapPoint(point, mapping) {
    return {
        x: Math.max(0, Math.min(mapping.width - 1, Math.round(Number(point.x) * mapping.scaleX - mapping.offsetX))),
        y: Math.max(0, Math.min(mapping.height - 1, Math.round(Number(point.y) * mapping.scaleY - mapping.offsetY)))
    };
}

function mappingFor(sourceWidth, sourceHeight, width, height) {
    const sw = Math.max(1, Number(sourceWidth) || width);
    const sh = Math.max(1, Number(sourceHeight) || height);
    const scale = Math.max(width / sw, height / sh);
    return {
        width,
        height,
        scaleX: scale,
        scaleY: scale,
        offsetX: Math.max(0, (sw * scale - width) / 2),
        offsetY: Math.max(0, (sh * scale - height) / 2)
    };
}

function loadKeypoints(project) {
    const rel = project && project.selection && project.selection.keypointsFile;
    if (!rel) return null;
    const file = path.join(require('./state').projectDir(project.id), rel);
    if (!fs.existsSync(file)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function frameEntry(keypoints, frame) {
    if (!Array.isArray(keypoints) || !keypoints.length) return null;
    let best = null;
    for (const entry of keypoints) {
        if (!entry || !Number.isFinite(Number(entry.frame))) continue;
        if (Number(entry.frame) > frame) break;
        best = entry;
    }
    return best || keypoints[0];
}

function pointKey(point) {
    return Math.round(point.x / 8) + ',' + Math.round(point.y / 8);
}

function buildPointPrompts(project, options = {}) {
    const trackId = String(options.trackId || '');
    const frame = Math.max(0, Math.round(Number(options.frame) || 0));
    const width = Math.max(2, Math.round(Number(options.width) || 1));
    const height = Math.max(2, Math.round(Number(options.height) || 1));
    const mapping = mappingFor(
        options.sourceWidth || (project.part && project.part.width),
        options.sourceHeight || (project.part && project.part.height),
        width,
        height
    );
    const keypoints = options.keypoints || loadKeypoints(project);
    const entry = frameEntry(keypoints, frame);
    if (!entry) return null;
    const people = Array.isArray(entry.people) ? entry.people : [];
    const target = people.find((person) => String(person.trackId) === trackId);
    if (!target) return null;

    const body = validBody(target);
    const picked = [];
    for (const index of ANCHOR_POINT_INDICES) {
        const point = body[index];
        if (point) picked.push(mapPoint(point, mapping));
    }
    if (!picked.length) {
        for (const point of body) picked.push(mapPoint(point, mapping));
    }
    if (target.bbox) {
        picked.push(mapPoint({
            x: target.bbox.x + target.bbox.width / 2,
            y: target.bbox.y + target.bbox.height * 0.55
        }, mapping));
    }
    const positive = [];
    const seen = new Set();
    for (const point of picked) {
        const key = pointKey(point);
        if (seen.has(key)) continue;
        seen.add(key);
        positive.push(point);
        if (positive.length >= 10) break;
    }

    const negative = [];
    const negativeSeen = new Set();
    const addNegative = (point) => {
        if (!point) return;
        const mapped = mapPoint(point, mapping);
        const key = pointKey(mapped);
        if (negativeSeen.has(key) || seen.has(key)) return;
        negativeSeen.add(key);
        negative.push(mapped);
    };
    for (const person of people) {
        if (String(person.trackId) === trackId) continue;
        const other = validBody(person);
        if (person.bbox) {
            addNegative({
                x: person.bbox.x + person.bbox.width / 2,
                y: person.bbox.y + person.bbox.height / 2
            });
        }
        (other.length ? [other[0], other[8], other[11]] : []).forEach(addNegative);
        if (negative.length >= 8) break;
    }
    const insetX = Math.max(2, Math.round(width * 0.02));
    const insetY = Math.max(2, Math.round(height * 0.02));
    addNegative({ x: insetX, y: insetY });
    addNegative({ x: width - insetX, y: insetY });
    addNegative({ x: insetX, y: height - insetY });
    addNegative({ x: width - insetX, y: height - insetY });

    return {
        positive,
        negative,
        frame: Number(entry.frame),
        sourceWidth: mapping.width,
        sourceHeight: mapping.height,
        mapping
    };
}

module.exports = {
    MIN_CONFIDENCE,
    ANCHOR_POINT_INDICES,
    validBody,
    mapPoint,
    mappingFor,
    loadKeypoints,
    frameEntry,
    pointKey,
    buildPointPrompts
};
