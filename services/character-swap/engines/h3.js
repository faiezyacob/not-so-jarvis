/* ============================================
   JARVIS — MiniMax H3 Character Swap engine
   H3 Recast: the official BFS character-swap
   workflow (scene reference + trained caption +
   guide video) with optional lip repair.

   The chat @video reference-replacement adapter
   (services/video-replacement.js) is separate
   and unchanged.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const recast = require('./h3-recast');

const ID = 'h3';
const LABEL = recast.LABEL;
const MAX_SECONDS = recast.MAX_SECONDS;

module.exports = {
    id: ID,
    ID,
    label: LABEL,
    LABEL,
    MAX_SECONDS,
    DEFAULT_SETTINGS: recast.normalizeSettings({}, null),
    normalizeSettings: recast.normalizeSettings,
    resolveModels: recast.resolveModels,
    availability: recast.availability,
    dimensionsFor: recast.dimensionsFor,
    framesFor: recast.framesFor,
    render: recast.renderSwap,
    renderSwap: recast.renderSwap,
    renderLipRepair: recast.renderLipRepair
};
