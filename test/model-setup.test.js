/* ============================================
   JARVIS — Setup catalog tests
   Covers the optional reusable H3 visual-reference
   node pack exposed in Settings > Setup.
   Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const modelSetup = require('../services/model-setup');

test('Setup catalog offers MiniMaxH3Mod with its reference nodes and Python requirements', () => {
    const pack = modelSetup.NODE_CATALOG.find((entry) => entry.id === 'h3_refmods');
    assert.ok(pack);
    assert.equal(pack.required, false);
    assert.equal(pack.repo, 'https://github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod');
    assert.equal(pack.dir, 'ComfyUI-MiniMaxH3Mod');
    assert.equal(pack.requirements, true);
    assert.deepEqual(pack.nodes, [
        'MiniMaxH3RefModExtract',
        'MiniMaxH3RefModsLoader',
        'MiniMaxH3RefModApply'
    ]);
    assert.match(pack.note, /restart ComfyUI/i);
});
