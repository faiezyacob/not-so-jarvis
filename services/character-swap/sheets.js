/* ============================================
   JARVIS — Character Swap sheet splitting
   Deterministic plain-backdrop figure finder
   so one uploaded sheet becomes usable views.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');

const thumbnail = require('../thumbnail');
const media = require('./media');

const BACKDROP_DISTANCE = 34;
const MIN_AREA = 0.015;
const MAX_SAMPLE = 512;

function medianBorder(data, width, height) {
    const values = [[], [], []];
    const push = (x, y) => {
        const index = (y * width + x) * 4;
        values[0].push(data[index]);
        values[1].push(data[index + 1]);
        values[2].push(data[index + 2]);
    };
    for (let x = 0; x < width; x += 1) { push(x, 0); push(x, height - 1); }
    for (let y = 0; y < height; y += 1) { push(0, y); push(width - 1, y); }
    return values.map((list) => {
        list.sort((a, b) => a - b);
        return list[Math.floor(list.length / 2)] || 255;
    });
}

function borderSpread(data, width, height) {
    const backdrop = medianBorder(data, width, height);
    let total = 0;
    let count = 0;
    const sample = (x, y) => {
        const index = (y * width + x) * 4;
        total += Math.abs(data[index] - backdrop[0]) +
            Math.abs(data[index + 1] - backdrop[1]) +
            Math.abs(data[index + 2] - backdrop[2]);
        count += 1;
    };
    for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 80))) {
        sample(x, 0);
        sample(x, height - 1);
    }
    for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 80))) {
        sample(0, y);
        sample(width - 1, y);
    }
    return count ? total / count : 0;
}

function foreground(data, width, height) {
    const backdrop = medianBorder(data, width, height);
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i += 1) {
        const r = data[i * 4];
        const g = data[i * 4 + 1];
        const b = data[i * 4 + 2];
        const distance = Math.hypot(r - backdrop[0], g - backdrop[1], b - backdrop[2]);
        mask[i] = distance > BACKDROP_DISTANCE ? 1 : 0;
    }
    return mask;
}

function components(mask, width, height) {
    const seen = new Uint8Array(mask.length);
    const found = [];
    const stack = [];
    for (let start = 0; start < mask.length; start += 1) {
        if (!mask[start] || seen[start]) continue;
        stack.length = 0;
        stack.push(start);
        seen[start] = 1;
        let area = 0;
        let minX = width;
        let maxX = -1;
        let minY = height;
        let maxY = -1;
        while (stack.length) {
            const index = stack.pop();
            const x = index % width;
            const y = (index - x) / width;
            area += 1;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            const neighbors = [
                x > 0 ? index - 1 : -1,
                x + 1 < width ? index + 1 : -1,
                y > 0 ? index - width : -1,
                y + 1 < height ? index + width : -1
            ];
            for (const next of neighbors) {
                if (next < 0 || seen[next] || !mask[next]) continue;
                seen[next] = 1;
                stack.push(next);
            }
        }
        found.push({ area, minX, minY, maxX, maxY });
    }
    return found;
}

function mergeBoxes(boxes) {
    const merged = [];
    for (const box of boxes) {
        const overlap = merged.find((other) => {
            const pad = 6;
            return box.minX <= other.maxX + pad && box.maxX >= other.minX - pad &&
                box.minY <= other.maxY + pad && box.maxY >= other.minY - pad;
        });
        if (!overlap) {
            merged.push(Object.assign({}, box));
            continue;
        }
        overlap.minX = Math.min(overlap.minX, box.minX);
        overlap.minY = Math.min(overlap.minY, box.minY);
        overlap.maxX = Math.max(overlap.maxX, box.maxX);
        overlap.maxY = Math.max(overlap.maxY, box.maxY);
        overlap.area += box.area;
    }
    return merged.sort((a, b) => a.minX - b.minX);
}

async function splitSheet(imagePath, outDir) {
    const decoded = await thumbnail.decodePng(fs.readFileSync(imagePath));
    if (!decoded) return [imagePath];
    const { width, height, data } = decoded;
    if (borderSpread(data, width, height) > 24) return [imagePath];
    const scale = Math.max(1, Math.ceil(Math.max(width, height) / MAX_SAMPLE));
    const sw = Math.max(1, Math.floor(width / scale));
    const sh = Math.max(1, Math.floor(height / scale));
    const small = new Uint8Array(sw * sh);
    const fullMask = foreground(data, width, height);
    for (let y = 0; y < sh; y += 1) {
        for (let x = 0; x < sw; x += 1) {
            const fx = Math.min(width - 1, x * scale);
            const fy = Math.min(height - 1, y * scale);
            small[y * sw + x] = fullMask[fy * width + fx];
        }
    }
    const minArea = sw * sh * MIN_AREA;
    let boxes = components(small, sw, sh)
        .filter((box) => box.area >= minArea)
        .filter((box) => (box.maxX - box.minX) * scale >= width * 0.06)
        .filter((box) => (box.maxY - box.minY) * scale >= height * 0.12)
        .map((box) => ({
            minX: box.minX * scale,
            minY: box.minY * scale,
            maxX: Math.min(width - 1, box.maxX * scale + scale),
            maxY: Math.min(height - 1, box.maxY * scale + scale),
            area: box.area * scale * scale
        }));
    if (boxes.length < 2) return [imagePath];
    boxes = mergeBoxes(boxes);
    if (boxes.length < 2) return [imagePath];
    const covered = boxes.reduce((sum, box) => sum + (box.maxX - box.minX) * (box.maxY - box.minY), 0);
    if (covered > width * height * 0.85) return [imagePath];
    fs.mkdirSync(outDir, { recursive: true });
    const outputs = [];
    for (let i = 0; i < boxes.length; i += 1) {
        const box = boxes[i];
        const pad = Math.round(Math.min(box.maxX - box.minX, box.maxY - box.minY) * 0.06);
        const x = Math.max(0, box.minX - pad);
        const y = Math.max(0, box.minY - pad);
        const w = Math.min(width - x, box.maxX - box.minX + pad * 2);
        const h = Math.min(height - y, box.maxY - box.minY + pad * 2);
        const output = path.join(outDir, 'view-' + (i + 1) + '.png');
        await media.run([
            '-hide_banner', '-y', '-i', imagePath,
            '-vf', 'crop=' + Math.max(2, w) + ':' + Math.max(2, h) + ':' + x + ':' + y,
            output
        ], { code: 'character_swap_sheet_crop_failed' });
        outputs.push(output);
    }
    return outputs;
}

module.exports = {
    splitSheet
};
