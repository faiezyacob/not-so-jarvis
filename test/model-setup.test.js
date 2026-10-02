/* ============================================
   JARVIS — Setup catalog tests
   Covers the H3 video model/node entries exposed
   in Settings > Setup. H3 is image-to-video only,
   so no reference-video packs are offered.
   Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const modelSetup = require('../services/model-setup');

test('Setup catalog offers the single H3 UNET and no reference-video packs', () => {
    const h3Unets = modelSetup.MODEL_CATALOG.filter((entry) => entry.group === 'video' && /unet/i.test(entry.id));
    assert.equal(h3Unets.length, 1);
    assert.equal(h3Unets[0].file.settings, 'video');
    assert.equal(h3Unets[0].file.key, 'h3Unet');
    assert.equal(modelSetup.NODE_CATALOG.find((entry) => entry.id === 'h3_refmods'), undefined);
    assert.equal(modelSetup.MODEL_CATALOG.find((entry) => entry.id === 'h3_ref_turbo_lora'), undefined);
    assert.equal(modelSetup.MODEL_CATALOG.find((entry) => entry.id === 'h3_unet_i2va'), undefined);
});

test('Setup catalog offers the H3 Turbo pack with its nodes and install URL', () => {
    const pack = modelSetup.NODE_CATALOG.find((entry) => entry.id === 'h3_turbo');
    assert.ok(pack);
    assert.deepEqual(pack.nodes, ['MiniMaxH3TurboLoRA', 'MiniMaxH3TurboSampler']);
    assert.match(pack.repo, /MiniMax-H3-Turbo/);
});
