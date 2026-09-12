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
