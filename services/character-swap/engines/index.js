/* ============================================
   JARVIS — Character Swap engine registry
   Wan Animate 2 is the default; MiniMax H3
   stays available as the alternative backend.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const wanAnimate = require('./wan-animate');
const h3 = require('./h3');

const DEFAULT_ENGINE = 'wan_animate';
const ORDER = ['wan_animate', 'h3'];

const ENGINES = {
    wan_animate: wanAnimate,
    h3
};

function normalizeEngine(value) {
    const name = String(value || '').trim().toLowerCase();
    if (name === 'wan' || name === 'wan_animate' || name === 'wan22' || name === 'wan-animate') return 'wan_animate';
    if (name === 'h3' || name === 'minimax' || name === 'minimax_h3') return 'h3';
    return DEFAULT_ENGINE;
}

function getEngine(value) {
    return ENGINES[normalizeEngine(value)] || ENGINES[DEFAULT_ENGINE];
}

function listEngines(info, settingsByEngine = {}) {
    return ORDER.map((id) => {
        const engine = ENGINES[id];
        const status = engine.availability(info, settingsByEngine[id] || {});
        return Object.assign({}, status, {
            id,
            label: engine.label,
            default: id === DEFAULT_ENGINE,
            maxSeconds: id === 'h3' ? h3.MAX_SECONDS : undefined
        });
    });
}

module.exports = {
    DEFAULT_ENGINE,
    ORDER,
    ENGINES,
    normalizeEngine,
    getEngine,
    listEngines,
    wanAnimate,
    h3
};
