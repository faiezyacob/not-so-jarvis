/* ============================================
   JARVIS — shared SCAIL-2 helpers
   Constants and canvas maths that the SCAIL-2
   engine (a Wan 2.1 backbone) still
   need. The Wan Animate 2 generation graph is
   deliberately not here.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const FPS = 24;
const MAX_SECONDS = 15;

const RESOLUTION_BUDGETS = Object.freeze({
    '480p': 832 * 480,
    '720p': 1280 * 720
});

const DEFAULT_NEGATIVE = [
    'blurry',
    'low quality',
    'worst quality',
    'jpeg artifacts',
    'distorted face',
    'deformed face',
    'extra limbs',
    'extra fingers',
    'fused fingers',
    'malformed hands',
    'missing fingers',
    'duplicate person',
    'warped background',
    'flicker',
    'static',
    'text',
    'watermark',
    'logo'
].join(', ');

function clean(value, max = 4000) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function snapTo16(value) {
    return Math.max(16, Math.round(Number(value) / 16) * 16);
}

function dimensionsFor(sourceWidth, sourceHeight, options = {}) {
    const width = Math.max(1, Number(sourceWidth) || 832);
    const height = Math.max(1, Number(sourceHeight) || 480);
    const key = options.resolution === '720p' ? '720p' : '480p';
    const budget = RESOLUTION_BUDGETS[key];
    const scale = Math.sqrt(budget / (width * height));
    return {
        width: Math.max(256, snapTo16(width * scale)),
        height: Math.max(256, snapTo16(height * scale)),
        budget,
        resolution: key
    };
}

function buildNegativePrompt(value) {
    const text = clean(value);
    return text || DEFAULT_NEGATIVE;
}

module.exports = {
    FPS,
    MAX_SECONDS,
    RESOLUTION_BUDGETS,
    DEFAULT_NEGATIVE,
    clean,
    snapTo16,
    dimensionsFor,
    buildNegativePrompt
};
