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

test('sanitizeSettings: custom imageSize + width/height are validated and clamped', () => {
    assert.deepEqual(imageGenerator.sanitizeSettings({ imageSize: 'custom' }), { imageSize: 'CUSTOM' });
    assert.deepEqual(imageGenerator.sanitizeSettings({ width: 5000, height: 10 }), { width: 4096, height: 64 });
    assert.deepEqual(imageGenerator.sanitizeSettings({ width: 'abc' }), {});
});

test('resolveBaseModels: returns krea2 slots by default and qwen slots when selected', () => {
    const defaults = imageGenerator.getDefaults();
    const krea = imageGenerator.resolveBaseModels(defaults);
    assert.equal(krea.unet, defaults.unet);
    assert.equal(krea.clip, defaults.clip);
    assert.equal(krea.clipType, 'krea2');
    assert.equal(krea.vae, defaults.vae);

    const qwen = imageGenerator.resolveBaseModels(Object.assign({}, defaults, { model: 'qwen_image_2_1' }));
    assert.equal(qwen.unet, defaults.qwenUnet);
    assert.equal(qwen.clip, defaults.qwenClip);
    assert.equal(qwen.clipType, 'qwen_image');
    assert.equal(qwen.vae, defaults.qwenVae);
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
    assert.equal(graph.sampler.inputs.scheduler, 'simple');
    assert.equal(graph.sampler.inputs.cfg, imageGenerator.getDefaults().qwenCfg);
    assert.equal(graph.sampler.inputs.steps, 25);
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
    const settings = imageGenerator.getDefaults();
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
    assert.equal(graph.sampler.inputs.cfg, imageGenerator.getDefaults().qwenCfg);
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
    assert.equal(defaults.qwenSteps, 25);
    assert.equal(defaults.qwenCfg, 1);
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
