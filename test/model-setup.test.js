/* ============================================
   JARVIS — Setup catalog tests
   Covers the H3 video model/node entries exposed
   in Settings > Setup: the FL2VA generation model,
   the Ref2VA model for @video character replacement,
   and the built-in reference node. The opt-in
   "refmod" packs and a reference Turbo LoRA are not
   offered.
   Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const modelSetup = require('../services/model-setup');

test('Setup catalog offers the FL2VA and Ref2VA H3 UNETs and the reference node', () => {
    const h3Unets = modelSetup.MODEL_CATALOG.filter((entry) => entry.group === 'video' && /unet/i.test(entry.id));
    assert.equal(h3Unets.length, 2);

    const fl2va = modelSetup.MODEL_CATALOG.find((entry) => entry.id === 'h3_unet');
    assert.equal(fl2va.file.settings, 'video');
    assert.equal(fl2va.file.key, 'h3Unet');

    const ref2va = modelSetup.MODEL_CATALOG.find((entry) => entry.id === 'h3_ref_unet');
    assert.ok(ref2va);
    assert.equal(ref2va.required, false);
    assert.equal(ref2va.dest, 'diffusion_models');
    assert.match(ref2va.file, /ref2va/i);

    const refNode = modelSetup.NODE_CATALOG.find((entry) => entry.id === 'h3_reference');
    assert.ok(refNode);
    assert.deepEqual(refNode.nodes, ['MiniMaxH3ReferenceToVideo']);
    assert.equal(refNode.repo, null);

    // Still no separate reference packs / reference Turbo LoRA / alternate UNET.
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
