/* ============================================
   JARVIS — MiniMax H3 reference planner/cache
   Covers deterministic reference planning and the
   isolated ComfyUI RefMod preparation adapter.
   Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-h3-reference-test-'));
process.env.H3_REFERENCE_CACHE_PATH = path.join(tempRoot, 'cache.json');
const pipeline = require('../services/h3-reference-pipeline');
const comfyui = require('../services/comfyui');

const originalComfy = {
    getObjectInfo: comfyui.getObjectInfo,
    uploadImage: comfyui.uploadImage,
    deleteInputFile: comfyui.deleteInputFile,
    queuePrompt: comfyui.queuePrompt,
    waitForPrompt: comfyui.waitForPrompt
};

function referenceNodes() {
    const loaderInputs = { show_info: [] };
    for (let slot = 1; slot <= 8; slot += 1) {
        loaderInputs['mod_' + slot] = [];
        loaderInputs['strength_' + slot] = [];
        loaderInputs['copies_' + slot] = [];
    }
    return {
        MiniMaxH3RefModExtract: { input: { required: { name: [], mode: [] }, optional: { refs_image: {}, vae: {}, save: [], background_retention: [] } }, output: ['H3_REF_MODS'] },
        MiniMaxH3RefModsLoader: { input: { required: loaderInputs, optional: { max_total_tokens: [] } }, output: ['H3_REF_MODS'] },
        MiniMaxH3RefModApply: { input: { required: {
            conditioning: [], mods: [], override: [], retention: [], curve_direction: [], scramble_seed: [], curve_shape: [], curve_value: []
        }, optional: { max_total_tokens: [] } }, output: ['CONDITIONING'] }
    };
}

function makeSource(name, content) {
    const filename = path.join(tempRoot, name);
    fs.writeFileSync(filename, content || name);
    return filename;
}

test('no references leave preparation out of the ComfyUI path', async () => {
    let infoCalls = 0;
    comfyui.getObjectInfo = async () => { infoCalls += 1; return {}; };
    const result = await pipeline.prepareH3References({ references: [], settings: {} });
    assert.equal(result.applied, false);
    assert.deepEqual(result.references, []);
    assert.equal(infoCalls, 0);
});

test('mentions resolve through supplied registries and remove only the matched entity token', () => {
    const result = pipeline.resolveRegistryMentions('Have @Hana holding @Product (A) in @Cafe.', [
        { type: 'product', items: [{ id: 'prod_a', name: 'Product (A)' }] },
        { type: 'location', items: [{ id: 'cafe', name: 'Cafe' }] }
    ]);
    assert.deepEqual(result.references.map((ref) => [ref.type, ref.id]), [['product', 'prod_a'], ['location', 'cafe']]);
    assert.match(result.prompt, /@Hana/);
    assert.doesNotMatch(result.prompt, /@Product/);
});

test('planner deduplicates identical sources and keeps character identity ahead of secondary references', () => {
    const shared = makeSource('shared.png');
    const planned = pipeline.planH3References({ references: [
        { id: 'image:shared', type: 'image', source: shared, mode: 'full', order: 0 },
        { id: 'character:hana', entityId: 'hana', type: 'character', source: shared, order: 1 },
        { id: 'product:serum', type: 'product', source: makeSource('serum.png'), mode: 'full', order: 2 },
        { id: 'location:cafe', type: 'location', source: makeSource('cafe.png'), order: 3 }
    ], settings: { referenceTokenBudget: 1100 } });
    assert.equal(planned.references.length, 3);
    assert.equal(planned.references[0].type, 'character');
    assert.equal(planned.references[0].mode, 'full');
    assert.equal(planned.references.find((ref) => ref.type === 'product').mode, 'compressed');
    assert.equal(planned.omittedReferences.some((ref) => ref.id === 'image:shared'), true);
    assert.ok(planned.tokenCount <= planned.tokenBudget);
});

test('reference request planner combines semantic mentions, uploads and studio references deterministically', () => {
    const plan = pipeline.planReferenceRequest({
        prompt: '@Hana holding @Serum in this room',
        mentions: [
            { id: 'character:hana', entityId: 'hana', name: 'Hana', type: 'character', source: makeSource('planner-hana.png') },
            { id: 'product:serum', entityId: 'serum', name: 'Serum', type: 'product', source: makeSource('planner-serum.png') }
        ],
        uploadedReferences: [{ id: 'image:upload', source: makeSource('planner-image.png') }],
        studio: 'ugc',
        generationMode: 'ugc',
        settings: { referenceTokenBudget: 5120 }
    });
    assert.equal(plan.primaryReference.id, 'character:hana');
    assert.deepEqual(plan.references.map((ref) => ref.id), ['character:hana', 'product:serum', 'image:upload']);
    assert.equal(plan.references[0].mode, 'full');
    assert.equal(plan.references[1].mode, 'compressed');
    assert.equal(plan.generationMode, 'ugc');
});

test('required characters are never dropped to satisfy the token budget', () => {
    const refs = [{ id: 'character:hana', type: 'character', source: makeSource('hana.png') }];
    assert.throws(() => pipeline.planH3References({
        references: refs,
        settings: { referenceTokenBudget: 512 }
    }), { code: 'h3_reference_budget_exceeded' });
});

test('RefMod artifacts miss once, hit on reuse, and invalidate when the source changes', async () => {
    const artifactsDir = path.join(tempRoot, 'refmods', 'jarvis');
    fs.mkdirSync(artifactsDir, { recursive: true });
    let prompts = 0;
    let lastGraph = null;
    comfyui.getObjectInfo = async () => {
        const info = referenceNodes();
        info.MiniMaxH3RefModsLoader.input.required.mod_1 = [['(none)', 'jarvis/old-' + prompts], {}];
        return info;
    };
    comfyui.uploadImage = async (_buffer, filename) => ({ name: filename });
    comfyui.deleteInputFile = async () => {};
    comfyui.queuePrompt = async (graph) => {
        lastGraph = graph;
        prompts += 1;
        const name = graph.refmod_create.inputs.name;
        const artifactPath = path.join(artifactsDir, name + '.safetensors');
        fs.writeFileSync(artifactPath, 'artifact:' + name + ':' + prompts);
        comfyui.__testArtifactPath = artifactPath;
        return 'prompt-' + prompts;
    };
    comfyui.waitForPrompt = async () => ({
        outputs: {
            refmod_create: {
                text: [JSON.stringify({ saved_paths: [comfyui.__testArtifactPath], tokens: 1024 })]
            }
        }
    });

    const characterSource = makeSource('cache-hana.png', 'portrait-v1');
    const productSource = makeSource('cache-product.png', 'product-v1');
    const refs = [
        { id: 'character:hana', entityId: 'hana', name: 'Hana', type: 'character', source: characterSource, required: true },
        { id: 'product:serum', entityId: 'serum', name: 'Serum', type: 'product', source: productSource }
    ];
    const first = await pipeline.prepareH3References({ references: refs, settings: { h3VideoVae: 'vae-v1', h3Unet: 'h3-v1' } });
    assert.equal(first.references.length, 2);
    assert.deepEqual(first.cache.map((entry) => entry.status), ['MISS', 'MISS']);
    assert.equal(prompts, 2);
    assert.equal(lastGraph.refmod_create.inputs['refs_image.ref_image_1'][0], 'ref_load_1');
    assert.equal(lastGraph.refmod_create.inputs.save, true);
    assert.equal(lastGraph.refmod_create.inputs.background_retention, 0);

    const second = await pipeline.prepareH3References({ references: refs, settings: { h3VideoVae: 'vae-v1', h3Unet: 'h3-v1' } });
    assert.deepEqual(second.cache.map((entry) => entry.status), ['HIT', 'HIT']);
    assert.equal(prompts, 2);

    fs.writeFileSync(characterSource, 'portrait-v2');
    const changed = await pipeline.prepareH3References({ references: refs, settings: { h3VideoVae: 'vae-v1', h3Unet: 'h3-v1' } });
    assert.equal(changed.references[0].cache, 'MISS');
    assert.equal(changed.references[1].cache, 'HIT');
    assert.equal(prompts, 3);
    assert.notEqual(changed.references[0].referenceHash, first.references[0].referenceHash);
});

test('required reference preparation fails closed when the RefMod API is unavailable', async () => {
    let prompts = 0;
    comfyui.getObjectInfo = async () => ({});
    comfyui.queuePrompt = async () => { prompts += 1; return 'unexpected'; };
    await assert.rejects(pipeline.prepareH3References({
        references: [{ id: 'character:broken', type: 'character', source: makeSource('broken.png'), required: true }]
    }), { code: 'h3_reference_nodes_missing' });
    assert.equal(prompts, 0);
});

test('a missing required character image fails before H3 video generation can proceed', async () => {
    let prompts = 0;
    comfyui.getObjectInfo = async () => referenceNodes();
    comfyui.queuePrompt = async () => { prompts += 1; return 'unexpected'; };
    await assert.rejects(pipeline.prepareH3References({
        references: [{ id: 'character:hana', name: 'Hana', type: 'character', source: path.join(tempRoot, 'missing-hana.png'), required: true }]
    }), { code: 'h3_reference_source_missing' });
    assert.equal(prompts, 0);
});

test.after(() => {
    Object.assign(comfyui, originalComfy);
    delete comfyui.__testArtifactPath;
    pipeline.resetCacheForTests();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});
