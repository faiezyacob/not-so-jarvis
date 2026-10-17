/* ============================================
   JARVIS — Seed lock + variation settings
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const imageGenerator = require('../services/image-generator');

test('normalizeSeed: wraps into unsigned 32-bit range', () => {
    assert.equal(imageGenerator.normalizeSeed(0), 0);
    assert.equal(imageGenerator.normalizeSeed(42), 42);
    assert.equal(imageGenerator.normalizeSeed(1.9), 1);
    assert.equal(imageGenerator.normalizeSeed(-1), 4294967295);
    assert.equal(imageGenerator.normalizeSeed(2 ** 32), 0);
    assert.equal(imageGenerator.normalizeSeed(2 ** 32 + 5), 5);
    assert.equal(imageGenerator.normalizeSeed('abc'), null);
    assert.equal(imageGenerator.normalizeSeed(null), null);
});

test('resolveSeed: a per-request seed wins over everything', () => {
    assert.equal(imageGenerator.resolveSeed({ seedMode: 'fixed', seed: 42 }, 7), 7);
    assert.equal(imageGenerator.resolveSeed({ seedMode: 'random' }, 0), 0);
});

test('resolveSeed: fixed mode reuses the stored seed', () => {
    assert.equal(imageGenerator.resolveSeed({ seedMode: 'fixed', seed: 42 }, null), 42);
    assert.equal(imageGenerator.resolveSeed({ seedMode: 'fixed', seed: -1 }, null), 4294967295);
});

test('resolveSeed: random mode (or an unusable fixed seed) returns a fresh seed', () => {
    const fixedBad = imageGenerator.resolveSeed({ seedMode: 'fixed', seed: 'nope' }, null);
    assert.ok(fixedBad >= 0 && fixedBad <= imageGenerator.MAX_SEED);
    const random = imageGenerator.resolveSeed({ seedMode: 'random' }, null);
    assert.ok(random >= 0 && random <= imageGenerator.MAX_SEED);
});

test('sanitizeSettings: seed + variations are clamped and validated', () => {
    assert.deepEqual(
        imageGenerator.sanitizeSettings({ seedMode: 'fixed', seed: '12', variations: 9 }),
        { seedMode: 'fixed', seed: 12, variations: 4 }
    );
    assert.deepEqual(
        imageGenerator.sanitizeSettings({ seedMode: 'bogus', variations: 0 }),
        { variations: 1 }
    );
    assert.deepEqual(
        imageGenerator.sanitizeSettings({ seed: -1 }),
        { seed: 4294967295 }
    );
    assert.deepEqual(
        imageGenerator.sanitizeSettings({ variations: 2.4 }),
        { variations: 2 }
    );
});

test('defaults expose seed lock + variations', () => {
    const defaults = imageGenerator.getDefaults();
    assert.equal(defaults.seedMode, 'random');
    assert.equal(defaults.seed, 0);
    assert.equal(defaults.variations, 1);
});

test('normalizeImageModel: aliases map to the two supported models', () => {
    assert.equal(imageGenerator.normalizeImageModel('krea2'), 'krea2');
    assert.equal(imageGenerator.normalizeImageModel('Krea 2'), 'krea2');
    assert.equal(imageGenerator.normalizeImageModel('qwen_image_2_1'), 'qwen_image_2_1');
    assert.equal(imageGenerator.normalizeImageModel('Qwen Image 2.1'), 'qwen_image_2_1');
    assert.equal(imageGenerator.normalizeImageModel('qwen'), 'qwen_image_2_1');
    assert.equal(imageGenerator.normalizeImageModel('bogus'), null);
    assert.equal(imageGenerator.normalizeImageModel(''), null);
});

test('sanitizeSettings: model is validated, unknown values are dropped', () => {
    assert.deepEqual(imageGenerator.sanitizeSettings({ model: 'Qwen Image 2.1' }), { model: 'qwen_image_2_1' });
    assert.deepEqual(imageGenerator.sanitizeSettings({ model: 'nope' }), {});
    assert.deepEqual(imageGenerator.sanitizeSettings({ model: 'krea2' }), { model: 'krea2' });
});

test('resolveDimensions: CUSTOM size pins exact width/height snapped to the grid', () => {
    const custom = imageGenerator.resolveDimensions({ imageSize: 'CUSTOM', width: 1000, height: 1500 });
    assert.equal(custom.imageSize, 'CUSTOM');
    assert.equal(custom.width, 992);
    assert.equal(custom.height, 1504);

    // Out-of-range custom edges are clamped to the supported window.
    const clamped = imageGenerator.resolveDimensions({ imageSize: 'CUSTOM', width: 99999, height: 1 });
    assert.equal(clamped.width, 4096);
    assert.equal(clamped.height, 64);
});

test('resolveDimensions: ratio + size still derive dimensions for S/M/L', () => {
    const dims = imageGenerator.resolveDimensions({ imageSize: 'M', aspectRatio: '1:1' });
    assert.equal(dims.width, 992);
    assert.equal(dims.height, 992);
});

test('resolveDimensions: L is the 1.25MP tier and XL is the 1.75MP tier', () => {
    assert.equal(imageGenerator.IMAGE_MEGAPIXELS.L, 1.25);
    assert.equal(imageGenerator.IMAGE_MEGAPIXELS.XL, 1.75);
    const l = imageGenerator.resolveDimensions({ imageSize: 'L', aspectRatio: '1:1' });
    const xl = imageGenerator.resolveDimensions({ imageSize: 'XL', aspectRatio: '1:1' });
    assert.equal(l.width, 1120);
    assert.equal(l.height, 1120);
    assert.equal(xl.width, 1312);
    assert.ok(l.width < xl.width);
});

test('sanitizeSettings: custom imageSize + width/height are validated and clamped', () => {
    assert.deepEqual(imageGenerator.sanitizeSettings({ imageSize: 'custom' }), { imageSize: 'CUSTOM' });
    assert.deepEqual(imageGenerator.sanitizeSettings({ width: 5000, height: 10 }), { width: 4096, height: 64 });
    assert.deepEqual(imageGenerator.sanitizeSettings({ width: 'abc' }), {});
});

test('resolveBaseModels: returns the selected model slots (qwen by default, krea2 when selected)', () => {
    const defaults = imageGenerator.getDefaults();
    const qwen = imageGenerator.resolveBaseModels(defaults);
    assert.equal(qwen.unet, defaults.qwenUnet);
    assert.equal(qwen.clip, defaults.qwenClip);
    assert.equal(qwen.clipType, 'qwen_image');
    assert.equal(qwen.vae, defaults.qwenVae);

    const krea = imageGenerator.resolveBaseModels(Object.assign({}, defaults, { model: 'krea2' }));
    assert.equal(krea.unet, defaults.unet);
    assert.equal(krea.clip, defaults.clip);
    assert.equal(krea.clipType, 'krea2');
    assert.equal(krea.vae, defaults.vae);
});

test('buildQwenImage21T2IGraph: uses the qwen encoder node, clip type and sampler', () => {
    const settings = Object.assign({}, imageGenerator.getDefaults(), { model: 'qwen_image_2_1' });
    const graph = imageGenerator.buildQwenImage21T2IGraph('a red fox', { seed: 7, settings, width: 1024, height: 1024 });

    assert.equal(graph.clip.class_type, 'CLIPLoader');
    assert.equal(graph.clip.inputs.type, 'qwen_image');
    assert.equal(graph.clip.inputs.clip_name, settings.qwenClip);
    assert.equal(graph.unet.class_type, 'UNETLoader');
    assert.equal(graph.unet.inputs.unet_name, settings.qwenUnet);
    assert.equal(graph.vae.inputs.vae_name, settings.qwenVae);

    assert.equal(graph.conditioning.class_type, 'TextEncodeQwenImage21');
    assert.equal(graph.conditioning.inputs.prompt, 'a red fox');
    assert.equal(graph.conditioning.inputs.clip[0], 'clip');
    assert.equal(graph.canvas.class_type, 'EmptyLatentImage');

    assert.deepEqual(graph.sampler.inputs.positive, ['conditioning', 0]);
    assert.deepEqual(graph.sampler.inputs.negative, ['conditioning', 1]);
    assert.deepEqual(graph.sampler.inputs.latent_image, ['canvas', 0]);
    assert.equal(graph.sampler.inputs.sampler_name, 'euler');
    // The official Qwen Image 2.1 template samples with bong_tangent, ~24
    // steps and cfg 3, so the builder follows those defaults.
    assert.equal(graph.sampler.inputs.scheduler, imageGenerator.QWEN_T2I_SCHEDULER);
    assert.equal(graph.sampler.inputs.cfg, imageGenerator.getDefaults().qwenCfg);
    assert.equal(graph.sampler.inputs.steps, 24);
    assert.equal(graph.sampler.inputs.seed, 7);
    assert.equal(graph.save.inputs.filename_prefix, 'not-so-jarvis/gen');
});

test('buildKrea2T2IGraph: still uses CLIPTextEncode + EmptySD3LatentImage', () => {
    const settings = imageGenerator.getDefaults();
    const graph = imageGenerator.buildKrea2T2IGraph('a red fox', { seed: 7, settings });
    assert.equal(graph.positive.class_type, 'CLIPTextEncode');
    assert.equal(graph.clip.inputs.type, 'krea2');
    assert.equal(graph.canvas.class_type, 'EmptySD3LatentImage');
    assert.equal(graph.sampler.inputs.scheduler, 'beta');
});

test('buildQwenImage21EditGraph: always uses the qwen slots (edit is Qwen-only)', () => {
    // Even with Krea2 as the generation model, editing runs the Qwen editor.
    const settings = Object.assign({}, imageGenerator.getDefaults(), { model: 'krea2' });
    assert.equal(settings.model, 'krea2');
    const graph = imageGenerator.buildQwenImage21EditGraph('make it sunset', 'jarvis_edit_x.png', { seed: 3, settings });

    assert.equal(graph.clip.inputs.type, 'qwen_image');
    assert.equal(graph.clip.inputs.clip_name, settings.qwenClip);
    assert.equal(graph.unet.inputs.unet_name, settings.qwenUnet);
    assert.equal(graph.vae.inputs.vae_name, settings.qwenVae);
    assert.equal(graph.load_image.inputs.image, 'jarvis_edit_x.png');
    assert.equal(graph.conditioning.class_type, 'TextEncodeQwenImage21');
    assert.equal(graph.conditioning.inputs.prompt, 'make it sunset');
    // The API only resolves a link at a top-level (dotted) key; a nested
    // { images: { image_1 } } object is silently dropped by ComfyUI.
    assert.deepEqual(graph.conditioning.inputs['images.image_1'], ['load_image', 0]);
    assert.equal(graph.conditioning.inputs.images, undefined);
    assert.deepEqual(graph.conditioning.inputs.vae, ['vae', 0]);
    assert.equal(graph.conditioning.inputs.resolution, 0);

    assert.deepEqual(graph.sampler.inputs.positive, ['conditioning', 0]);
    assert.deepEqual(graph.sampler.inputs.negative, ['conditioning', 1]);
    assert.deepEqual(graph.sampler.inputs.latent_image, ['conditioning', 2]);
    assert.equal(graph.sampler.inputs.steps, 25);
    // Editing keeps its own unguided calibration (cfg 1), not the t2i cfg.
    assert.equal(graph.sampler.inputs.cfg, 1);
    assert.equal(graph.sampler.inputs.seed, 3);
    assert.equal(graph.sampler.inputs.sampler_name, 'euler');
    assert.equal(graph.sampler.inputs.scheduler, 'simple');
});

test('buildQwenImage21EditGraph: extra references wire images.image_2, image_3', () => {
    const settings = imageGenerator.getDefaults();
    const graph = imageGenerator.buildQwenImage21EditGraph('hold the bag from image 2', 'edit_1.png', {
        seed: 1,
        settings,
        referenceLoadNames: ['edit_2.png', 'edit_3.png']
    });

    // image_1 stays the base/source; extras are additional LoadImage nodes.
    assert.equal(graph.load_image.inputs.image, 'edit_1.png');
    assert.equal(graph.load_image_2.inputs.image, 'edit_2.png');
    assert.equal(graph.load_image_3.inputs.image, 'edit_3.png');

    // Flat dotted top-level keys (a nested object is dropped by ComfyUI).
    assert.deepEqual(graph.conditioning.inputs['images.image_1'], ['load_image', 0]);
    assert.deepEqual(graph.conditioning.inputs['images.image_2'], ['load_image_2', 0]);
    assert.deepEqual(graph.conditioning.inputs['images.image_3'], ['load_image_3', 0]);
    assert.equal(graph.conditioning.inputs.images, undefined);
    assert.equal(graph.load_image_4, undefined);

    // The reference latent still comes from image_1.
    assert.deepEqual(graph.sampler.inputs.latent_image, ['conditioning', 2]);
});

test('buildQwenImage21EditGraph: a pinned canvas uses the global dimensions, not the identity sheet', () => {
    const settings = imageGenerator.getDefaults();
    // Character scene generation passes the global width/height (e.g. 4:5 M).
    const graph = imageGenerator.buildQwenImage21EditGraph('Maya at a cafe', 'identity-sheet.png', {
        seed: 7,
        settings,
        width: 896,
        height: 1120
    });

    // The identity sheet stays image_1 — the reference, never the output size.
    assert.equal(graph.load_image.inputs.image, 'identity-sheet.png');
    assert.deepEqual(graph.conditioning.inputs['images.image_1'], ['load_image', 0]);
    // The sampler now samples an explicit canvas instead of the reference latent.
    assert.equal(graph.canvas.class_type, 'EmptyLatentImage');
    assert.equal(graph.canvas.inputs.width, 896);
    assert.equal(graph.canvas.inputs.height, 1120);
    assert.equal(graph.canvas.inputs.batch_size, 1);
    assert.deepEqual(graph.sampler.inputs.latent_image, ['canvas', 0]);
});

test('defaults expose per-model sampling (Krea 2 steps/cfg, Qwen qwenSteps/qwenCfg)', () => {
    const defaults = imageGenerator.getDefaults();
    assert.equal(defaults.steps, 8);
    assert.equal(defaults.cfg, 1);
    // Qwen Image 2.1 follows the official template: ~24 steps, cfg 3.
    assert.equal(defaults.qwenSteps, 24);
    assert.equal(defaults.qwenCfg, 3);
});

test('sanitizeSettings: qwen sampling values are validated', () => {
    assert.deepEqual(
        imageGenerator.sanitizeSettings({ qwenSteps: '30', qwenCfg: '4.5' }),
        { qwenSteps: 30, qwenCfg: 4.5 }
    );
    assert.deepEqual(imageGenerator.sanitizeSettings({ qwenSteps: 0 }), {});
    assert.deepEqual(imageGenerator.sanitizeSettings({ qwenSteps: -3 }), {});
    assert.deepEqual(imageGenerator.sanitizeSettings({ qwenCfg: -1 }), {});
    assert.deepEqual(imageGenerator.sanitizeSettings({ qwenCfg: 'x' }), {});
});

test('buildQwenImage21T2IGraph: honours qwenSteps / qwenCfg from settings', () => {
    const settings = Object.assign({}, imageGenerator.getDefaults(), {
        model: 'qwen_image_2_1',
        qwenSteps: 30,
        qwenCfg: 5
    });
    const graph = imageGenerator.buildQwenImage21T2IGraph('a red fox', { seed: 1, settings, width: 1024, height: 1024 });
    assert.equal(graph.sampler.inputs.steps, 30);
    assert.equal(graph.sampler.inputs.cfg, 5);
});

test('buildKrea2T2IGraph: keeps using the shared steps / cfg', () => {
    const settings = Object.assign({}, imageGenerator.getDefaults(), { steps: 12, cfg: 2.5 });
    const graph = imageGenerator.buildKrea2T2IGraph('a red fox', { seed: 1, settings });
    assert.equal(graph.sampler.inputs.steps, 12);
    assert.equal(graph.sampler.inputs.cfg, 2.5);
});

// --- Image-edit engine (Qwen vs Krea 2 Identity Edit) --------------------------

test('normalizeEditEngine: aliases map to the two supported editors', () => {
    assert.equal(imageGenerator.normalizeEditEngine('qwen'), 'qwen');
    assert.equal(imageGenerator.normalizeEditEngine('Qwen Image Edit'), 'qwen');
    assert.equal(imageGenerator.normalizeEditEngine('qwen_image_2_1'), 'qwen');
    assert.equal(imageGenerator.normalizeEditEngine('krea2'), 'krea2');
    assert.equal(imageGenerator.normalizeEditEngine('Krea 2 Identity Edit'), 'krea2');
    assert.equal(imageGenerator.normalizeEditEngine('krea2ref'), 'krea2');
    assert.equal(imageGenerator.normalizeEditEngine('identity'), 'krea2');
    assert.equal(imageGenerator.normalizeEditEngine('bogus'), null);
    assert.equal(imageGenerator.normalizeEditEngine(''), null);
});

test('defaults expose the edit engine + Krea 2 identity edit settings', () => {
    const defaults = imageGenerator.getDefaults();
    assert.ok(['qwen', 'krea2'].includes(defaults.editEngine));
    assert.equal(defaults.editEngine, 'qwen');
    assert.equal(defaults.krea2IdentityEditLora, 'krea2_identity_edit_v1_2.safetensors');
    assert.equal(defaults.krea2EditSteps, 10);
    assert.equal(defaults.krea2EditCfg, 1);
});

test('sanitizeSettings: editEngine is validated, Krea 2 edit values are clamped', () => {
    assert.deepEqual(imageGenerator.sanitizeSettings({ editEngine: 'Krea 2 Identity Edit' }), { editEngine: 'krea2' });
    assert.deepEqual(imageGenerator.sanitizeSettings({ editEngine: 'nope' }), {});
    assert.deepEqual(imageGenerator.sanitizeSettings({ krea2EditSteps: 3 }), { krea2EditSteps: 8 });
    assert.deepEqual(imageGenerator.sanitizeSettings({ krea2EditSteps: 99 }), { krea2EditSteps: 12 });
    assert.deepEqual(imageGenerator.sanitizeSettings({ krea2EditCfg: 9 }), { krea2EditCfg: 5 });
    assert.deepEqual(imageGenerator.sanitizeSettings({ krea2EditCfg: 0.2 }), { krea2EditCfg: 1 });
    assert.deepEqual(
        imageGenerator.sanitizeSettings({ krea2IdentityEditLora: 'custom_identity.safetensors' }),
        { krea2IdentityEditLora: 'custom_identity.safetensors' }
    );
});

test('normalizeIdentityEditDimensions: snaps to 16, enforces a 256 floor and a 2 MP ceiling', () => {
    assert.deepEqual(imageGenerator.normalizeIdentityEditDimensions(1024, 1024), { width: 1024, height: 1024 });
    assert.deepEqual(imageGenerator.normalizeIdentityEditDimensions(100, 100), { width: 256, height: 256 });
    // A missing/zero size falls back to the 1024 default.
    assert.deepEqual(imageGenerator.normalizeIdentityEditDimensions(0, 0), { width: 1024, height: 1024 });

    const huge = imageGenerator.normalizeIdentityEditDimensions(4096, 4096);
    assert.ok(huge.width * huge.height <= 2000000);
    assert.equal(huge.width % 16, 0);
    assert.equal(huge.height % 16, 0);
    assert.ok(huge.width >= 256 && huge.height >= 256);
});

test('buildKrea2IdentityEditGraph: wires the Identity Edit LoRA + grounded nodes', () => {
    const settings = imageGenerator.getDefaults();
    const graph = imageGenerator.buildKrea2IdentityEditGraph('make it sunset', 'jarvis_edit_1.png', {
        seed: 3,
        settings,
        width: 1024,
        height: 1024
    });

    assert.equal(graph.clip.class_type, 'CLIPLoader');
    assert.equal(graph.clip.inputs.type, 'krea2');
    assert.equal(graph.clip.inputs.clip_name, settings.clip);
    assert.equal(graph.unet.inputs.unet_name, settings.unet);
    assert.equal(graph.vae.inputs.vae_name, settings.vae);

    assert.equal(graph.identity_lora.class_type, 'LoraLoaderModelOnly');
    assert.equal(graph.identity_lora.inputs.lora_name, settings.krea2IdentityEditLora);
    assert.deepEqual(graph.identity_lora.inputs.model, ['unet', 0]);

    assert.equal(graph.source.class_type, 'LoadImage');
    assert.equal(graph.source.inputs.image, 'jarvis_edit_1.png');
    assert.equal(graph.source_latent.class_type, 'VAEEncode');
    assert.deepEqual(graph.source_latent.inputs.pixels, ['source', 0]);

    assert.equal(graph.model_patch.class_type, 'Krea2EditModelPatch');
    assert.deepEqual(graph.model_patch.inputs.model, ['identity_lora', 0]);
    assert.deepEqual(graph.model_patch.inputs.source_image, ['source', 0]);
    assert.deepEqual(graph.model_patch.inputs.source_latent, ['source_latent', 0]);
    assert.equal(graph.model_patch.inputs.source_latent_b, undefined);

    assert.equal(graph.positive.class_type, 'Krea2EditGroundedEncode');
    assert.equal(graph.positive.inputs.prompt, 'make it sunset');
    assert.deepEqual(graph.positive.inputs.image, ['source', 0]);
    assert.equal(graph.negative.inputs.prompt, '');

    assert.equal(graph.canvas.class_type, 'EmptySD3LatentImage');
    assert.equal(graph.canvas.inputs.width, 1024);
    assert.equal(graph.canvas.inputs.height, 1024);
    assert.deepEqual(graph.sampler.inputs.latent_image, ['canvas', 0]);
    assert.deepEqual(graph.sampler.inputs.model, ['model_patch', 0]);
    assert.equal(graph.sampler.inputs.sampler_name, 'euler');
    assert.equal(graph.sampler.inputs.scheduler, 'simple');
    assert.equal(graph.sampler.inputs.steps, 10);
    assert.equal(graph.sampler.inputs.cfg, 1);
    assert.equal(graph.sampler.inputs.seed, 3);
    assert.equal(graph.save.inputs.filename_prefix, 'not-so-jarvis/edit');
});

test('buildKrea2IdentityEditGraph: a secondary reference wires source_b slots, extras dropped', () => {
    const settings = imageGenerator.getDefaults();
    const graph = imageGenerator.buildKrea2IdentityEditGraph('fuse them', 'a.png', {
        seed: 1,
        settings,
        referenceLoadNames: ['b.png', 'c.png']
    });

    assert.equal(graph.source_b.inputs.image, 'b.png');
    assert.equal(graph.source_latent_b.class_type, 'VAEEncode');
    assert.deepEqual(graph.model_patch.inputs.source_latent_b, ['source_latent_b', 0]);
    assert.deepEqual(graph.model_patch.inputs.source_image_b, ['source_b', 0]);
    assert.deepEqual(graph.positive.inputs.image_b, ['source_b', 0]);
    assert.deepEqual(graph.negative.inputs.image_b, ['source_b', 0]);
    // The node pack fuses at most two images, so the third is ignored.
    assert.equal(graph.source_c, undefined);
});

test('buildKrea2IdentityEditGraph: user LoRAs stack model-only after the identity LoRA', () => {
    const settings = Object.assign({}, imageGenerator.getDefaults(), {
        loras: [
            { name: 'style.safetensors', strength: 0.7, on: true },
            { name: 'off.safetensors', strength: 1, on: false }
        ]
    });
    const graph = imageGenerator.buildKrea2IdentityEditGraph('x', 'a.png', { seed: 1, settings });

    assert.equal(graph.lora1.class_type, 'LoraLoaderModelOnly');
    assert.deepEqual(graph.lora1.inputs.model, ['identity_lora', 0]);
    assert.equal(graph.lora1.inputs.lora_name, 'style.safetensors');
    assert.equal(graph.lora1.inputs.strength_model, 0.7);
    // The disabled LoRA is skipped, and the patch reads the top of the stack.
    assert.equal(graph.lora2, undefined);
    assert.deepEqual(graph.model_patch.inputs.model, ['lora1', 0]);
});

test('buildKrea2IdentityEditGraph: a user entry matching the identity LoRA is not doubled', () => {
    const settings = Object.assign({}, imageGenerator.getDefaults(), {
        loras: [{ name: imageGenerator.getDefaults().krea2IdentityEditLora, strength: 1, on: true }]
    });
    const graph = imageGenerator.buildKrea2IdentityEditGraph('x', 'a.png', { seed: 1, settings });
    assert.equal(graph.lora1, undefined);
    assert.deepEqual(graph.model_patch.inputs.model, ['identity_lora', 0]);
});

test('buildKrea2IdentityEditGraph: reads Krea 2 edit steps/cfg from settings', () => {
    const settings = Object.assign({}, imageGenerator.getDefaults(), {
        krea2EditSteps: 12,
        krea2EditCfg: 3
    });
    const graph = imageGenerator.buildKrea2IdentityEditGraph('x', 'a.png', { seed: 1, settings });
    assert.equal(graph.sampler.inputs.steps, 12);
    assert.equal(graph.sampler.inputs.cfg, 3);
});

test('buildKrea2IdentityEditGraph: a missing source throws edit_source_missing', () => {
    const settings = imageGenerator.getDefaults();
    assert.throws(
        () => imageGenerator.buildKrea2IdentityEditGraph('x', '', { settings }),
        (err) => err.code === 'edit_source_missing'
    );
});

test('buildKrea2IdentityEditGraph: a missing Identity Edit LoRA throws a clear error', () => {
    const settings = Object.assign({}, imageGenerator.getDefaults(), { krea2IdentityEditLora: '' });
    assert.throws(
        () => imageGenerator.buildKrea2IdentityEditGraph('x', 'a.png', { settings }),
        (err) => err.code === 'krea2_identity_edit_lora_missing'
    );
});

// --- Image attention backend ---------------------------------------------------

const CK_INFO = { ModelAttentionBackend: { input: { required: { attention: [['comfy kitchen attention', 'pytorch']] } } } };
const SAGE_INFO = { PathchSageAttentionKJ: {} };

test('normalizeImageAttentionBackend: aliases map to auto/kitchen/sage', () => {
    assert.equal(imageGenerator.normalizeImageAttentionBackend('auto'), 'auto');
    assert.equal(imageGenerator.normalizeImageAttentionBackend('standard'), 'auto');
    assert.equal(imageGenerator.normalizeImageAttentionBackend('pytorch'), 'auto');
    assert.equal(imageGenerator.normalizeImageAttentionBackend('kitchen'), 'comfykitchen');
    assert.equal(imageGenerator.normalizeImageAttentionBackend('Comfy-Kitchen'), 'comfykitchen');
    assert.equal(imageGenerator.normalizeImageAttentionBackend('sageattention'), 'sageattention');
    assert.equal(imageGenerator.normalizeImageAttentionBackend('bogus'), 'auto');
    assert.equal(imageGenerator.normalizeImageAttentionBackend(''), 'auto');
});

test('imageAttentionBackendAvailable: kitchen needs the combo, sage needs the node', () => {
    assert.equal(imageGenerator.imageAttentionBackendAvailable(CK_INFO, 'comfykitchen'), true);
    assert.equal(imageGenerator.imageAttentionBackendAvailable({}, 'comfykitchen'), false);
    assert.equal(imageGenerator.imageAttentionBackendAvailable(SAGE_INFO, 'sageattention'), true);
    assert.equal(imageGenerator.imageAttentionBackendAvailable({}, 'sageattention'), false);
});

test('resolveImageAttentionBackend: auto prefers Comfy Kitchen, then SageAttention, else dense', () => {
    assert.equal(imageGenerator.resolveImageAttentionBackend({}, 'auto'), 'standard');
    assert.equal(imageGenerator.resolveImageAttentionBackend(SAGE_INFO, 'auto'), 'sageattention');
    assert.equal(imageGenerator.resolveImageAttentionBackend(Object.assign({}, CK_INFO, SAGE_INFO), 'auto'), 'comfykitchen');
    // An explicit choice passes through untouched so a missing node surfaces.
    assert.equal(imageGenerator.resolveImageAttentionBackend({}, 'sageattention'), 'sageattention');
});

test('applyImageAttentionPatch: inserts the matching node and returns its id', () => {
    const graph = {};
    assert.equal(imageGenerator.applyImageAttentionPatch(graph, 'unet', 'comfykitchen'), 'ck_attention');
    assert.equal(graph.ck_attention.class_type, 'ModelAttentionBackend');
    assert.deepEqual(graph.ck_attention.inputs.model, ['unet', 0]);

    const sage = {};
    assert.equal(imageGenerator.applyImageAttentionPatch(sage, 'model_patch', 'sageattention'), 'sage_attention');
    assert.equal(sage.sage_attention.class_type, 'PathchSageAttentionKJ');
    assert.deepEqual(sage.sage_attention.inputs.model, ['model_patch', 0]);

    const none = {};
    assert.equal(imageGenerator.applyImageAttentionPatch(none, 'unet', 'standard'), null);
    assert.deepEqual(none, {});
});

test('buildQwenImage21T2IGraph: an explicit attention backend patches the sampler model', () => {
    const settings = Object.assign({}, imageGenerator.getDefaults(), {
        model: 'qwen_image_2_1',
        attentionBackend: 'sageattention'
    });
    const graph = imageGenerator.buildQwenImage21T2IGraph('a red fox', { seed: 7, settings, width: 1024, height: 1024 });
    assert.equal(graph.sage_attention.class_type, 'PathchSageAttentionKJ');
    assert.deepEqual(graph.sampler.inputs.model, ['sage_attention', 0]);
});

test('buildKrea2T2IGraph + buildKrea2IdentityEditGraph honour the attention backend', () => {
    const t2i = imageGenerator.buildKrea2T2IGraph('x', {
        seed: 1,
        settings: Object.assign({}, imageGenerator.getDefaults(), { attentionBackend: 'comfykitchen' })
    });
    assert.equal(t2i.ck_attention.class_type, 'ModelAttentionBackend');
    assert.deepEqual(t2i.sampler.inputs.model, ['ck_attention', 0]);

    const edit = imageGenerator.buildKrea2IdentityEditGraph('x', 'a.png', {
        seed: 1,
        settings: Object.assign({}, imageGenerator.getDefaults(), { attentionBackend: 'sageattention' })
    });
    assert.deepEqual(edit.sage_attention.inputs.model, ['model_patch', 0]);
    assert.deepEqual(edit.sampler.inputs.model, ['sage_attention', 0]);
});

test('resolveQwenScheduler: bong_tangent when supported, simple as the fallback', () => {
    assert.equal(imageGenerator.resolveQwenScheduler({}, 'bong_tangent'), 'bong_tangent');
    assert.equal(
        imageGenerator.resolveQwenScheduler({ KSampler: { input: { required: { scheduler: [['simple', 'normal']] } } } }),
        'simple'
    );
    assert.equal(
        imageGenerator.resolveQwenScheduler({ KSampler: { input: { required: { scheduler: [['bong_tangent', 'simple']] } } } }),
        'bong_tangent'
    );
});

test('sanitizeSettings: attentionBackend is normalized', () => {
    assert.deepEqual(imageGenerator.sanitizeSettings({ attentionBackend: 'SageAttention' }), { attentionBackend: 'sageattention' });
    assert.deepEqual(imageGenerator.sanitizeSettings({ attentionBackend: 'bogus' }), { attentionBackend: 'auto' });
});
