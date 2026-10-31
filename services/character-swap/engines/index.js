/* ============================================
   JARVIS — Character Swap engine registry
   SCAIL-2 is the replacement engine; MiniMax H3
   stays available as the alternative. The legacy
   Wan engines are gone; their old aliases resolve
   to SCAIL-2 so nothing can fall back to a removed
   graph.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const scail2 = require('./scail2');
const h3 = require('./h3');

const DEFAULT_ENGINE = 'scail2';
const ORDER = ['scail2', 'h3'];

const ENGINES = {
    scail2,
    h3
};

function normalizeEngine(value) {
    const name = String(value || '').trim().toLowerCase();
    if (name === 'scail2' || name === 'scail-2' || name === 'scail_2' || name === 'scail' ||
        name === 'wan' || name === 'wan_animate' || name === 'wan_animate2' || name === 'wan22' ||
        name === 'wan-animate' || name === 'move' ||
        name === 'wan_animate_mix' || name === 'wan-animate-mix' || name === 'wan_mix' || name === 'wanmix' ||
        name === 'wan22_mix' || name === 'wan-mix' || name === 'mix') return 'scail2';
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
            maxSeconds: id === 'h3' ? h3.MAX_SECONDS : (engine.DEFAULTS && engine.DEFAULTS.maxSeconds) || 15
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
    scail2,
    h3
};
