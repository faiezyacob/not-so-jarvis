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
    assert.equal(graph.sampler.inputs.cfg, 1);
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
