/* ============================================
   JARVIS — MiniMax H3 Character Swap engine
   Thin adapter over the existing Ref2VA /
   Character LoRA v1.5 replacement pipeline.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const videoReplacement = require('../../video-replacement');

const ID = 'h3';
const LABEL = 'MiniMax H3 + Character LoRA v1.5';
const MAX_SECONDS = 15;

function availability(info, settings = {}) {
    const missing = [];
    const warnings = [];
    if (!info || typeof info !== 'object') {
        return { id: ID, label: LABEL, available: false, missing: ['ComfyUI is not reachable.'], warnings };
    }
    for (const node of videoReplacement.REQUIRED_NODES) {
        if (!Object.prototype.hasOwnProperty.call(info, node)) missing.push('ComfyUI node "' + node + '"');
    }
    const unet = videoReplacement.resolveRefUnet(info, settings);
    if (!unet) missing.push('MiniMax H3 Ref2VA diffusion model');
    return { id: ID, label: LABEL, available: missing.length === 0, missing, warnings };
}

async function render(plan, options = {}) {
    return videoReplacement.generateReplacementVideo(plan, options);
}

module.exports = {
    id: ID,
    ID,
    label: LABEL,
    LABEL,
    MAX_SECONDS,
    availability,
    render
};
