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
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-setup-'));
process.env.JARVIS_CONFIG_PATH = path.join(TMP, 'config.json');

const modelSetup = require('../services/model-setup');
const configManager = require('../server/config-manager');

test('Setup catalog offers the FL2VA and Ref2VA H3 UNETs and the reference node', () => {
    const h3Unets = modelSetup.MODEL_CATALOG.filter((entry) => entry.group === 'video' && /^h3_.*unet/i.test(entry.id));
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

test('Setup catalog offers the official SCAIL-2 INT8 stack and the DWPose pack', () => {
    const unet = modelSetup.MODEL_CATALOG.find((entry) => entry.id === 'scail2_unet');
    assert.ok(unet);
    assert.equal(unet.file, 'wan2.1_14B_SCAIL_2_int8_convrot.safetensors');
    assert.equal(unet.dest, 'diffusion_models');
    assert.equal(unet.required, false);
    assert.match(unet.note, /UNETLoader/);

    const retired = ['scail2_unet_q2', 'scail2_unet_q3', 'scail2_unet_q5',
        'scail2_unet_q6', 'scail2_unet_q8', 'scail2_unet_fp16'];
    for (const id of retired) {
        assert.equal(modelSetup.MODEL_CATALOG.find((item) => item.id === id), undefined, id + ' is retired');
    }

    const sam = modelSetup.MODEL_CATALOG.find((entry) => entry.id === 'scail2_sam');
    assert.match(sam.file, /sam3\.1/i);
    assert.equal(sam.dest, 'checkpoints');

    const textEncoder = modelSetup.MODEL_CATALOG.find((entry) => entry.id === 'wan_animate_text_encoder');
    assert.match(textEncoder.file, /umt5/i);
    assert.equal(textEncoder.dest, 'text_encoders');

    const clipVision = modelSetup.MODEL_CATALOG.find((entry) => entry.id === 'wan_animate_clip_vision');
    assert.equal(clipVision.dest, 'clip_vision');

    const lightx2v = modelSetup.MODEL_CATALOG.find((entry) => entry.id === 'scail2_lightx2v');
    assert.match(lightx2v.file, /lightx2v/i);

    const relight = modelSetup.MODEL_CATALOG.find((entry) => entry.id === 'scail2_relight_lora');
    assert.match(relight.file, /relight/i);

    const dwpose = modelSetup.NODE_CATALOG.find((entry) => entry.id === 'controlnet_aux');
    assert.ok(dwpose);
    assert.deepEqual(dwpose.nodes, ['DWPreprocessor', 'PixelPerfectResolution']);
    assert.equal(dwpose.preserveTorch, true);
    assert.match(dwpose.repo, /Fannovel16\/comfyui_controlnet_aux/);

    const nativeNode = modelSetup.NODE_CATALOG.find((entry) => entry.id === 'scail2_native');
    assert.deepEqual(nativeNode.nodes, ['WanSCAILToVideo', 'SCAIL2ColoredMask', 'SAM3_Detect', 'SAM3_VideoTrack']);
    const infinityNode = modelSetup.NODE_CATALOG.find((entry) => entry.id === 'scail2_infinity');
    assert.deepEqual(infinityNode.nodes, ['WanSCAILInfinity']);
    assert.equal(modelSetup.NODE_CATALOG.find((entry) => entry.id === 'wan_native'), undefined);
});
test('Setup catalog offers the H3 Turbo pack with its nodes and install URL', () => {
    const pack = modelSetup.NODE_CATALOG.find((entry) => entry.id === 'h3_turbo');
    assert.ok(pack);
    assert.deepEqual(pack.nodes, ['MiniMaxH3TurboLoRA', 'MiniMaxH3TurboSampler']);
    assert.match(pack.repo, /MiniMax-H3-Turbo/);
});

test('Setup catalog resolves the Civitai BFS Character Swap LoRA download', () => {
    const entry = modelSetup.MODEL_CATALOG.find((item) => item.id === 'h3_recast_swap_lora');
    assert.ok(entry);
    assert.equal(entry.dest, 'loras');
    const resolved = modelSetup.resolveCatalogEntry(entry);
    assert.equal(resolved.source, 'civitai');
    assert.equal(resolved.requiresToken, 'civitai');
    assert.equal(resolved.repo, 'Civitai');
    assert.match(resolved.url, /civitai\.com\/api\/download\/models\/3401556/);
    assert.match(resolved.url, /fileId=3293741/);
    assert.match(resolved.repoUrl, /civitai\.com\/models\/2027766/);
    assert.equal(resolved.approxMB, 580);
});

test('Civitai download and page URLs follow the model-version contract', () => {
    assert.equal(
        modelSetup.civitaiDownloadUrl({ modelVersionId: 3401556, fileId: 3293741 }),
        'https://civitai.com/api/download/models/3401556?fileId=3293741'
    );
    assert.equal(
        modelSetup.civitaiPageUrl({ modelId: 2027766, modelVersionId: 3401556 }),
        'https://civitai.com/models/2027766?modelVersionId=3401556'
    );
});

test('Civitai token: env wins over stored settings; removal clears it', () => {
    process.env.CIVITAI_TOKEN = 'env-token';
    assert.equal(configManager.getCivitaiToken(), 'env-token');
    delete process.env.CIVITAI_TOKEN;
    process.env.CIVITAI_API_KEY = 'env-api-key';
    assert.equal(configManager.getCivitaiToken(), 'env-api-key');
    delete process.env.CIVITAI_API_KEY;

    configManager.setCivitai({ token: 'stored-token', user: 'tester' });
    assert.equal(configManager.getCivitaiToken(), 'stored-token');
    assert.equal(configManager.getCivitai().user, 'tester');

    configManager.setCivitai({ token: null, user: null, verifiedAt: null });
    assert.equal(configManager.getCivitaiToken(), '');
});

test('verifyCivitaiToken accepts a user and rejects a 401', async () => {
    const original = global.fetch;
    try {
        global.fetch = async () => ({ status: 200, ok: true, json: async () => ({ username: 'alice' }) });
        const good = await modelSetup.verifyCivitaiToken('token');
        assert.deepEqual(good, { valid: true, user: 'alice', error: null });

        global.fetch = async () => ({ status: 401, ok: false, json: async () => ({}) });
        const bad = await modelSetup.verifyCivitaiToken('token');
        assert.equal(bad.valid, false);
        assert.match(bad.error, /401/);
    } finally {
        global.fetch = original;
    }
});
