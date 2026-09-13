/* ============================================
   JARVIS — Auto LoRA keyword matching
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const imageGenerator = require('../services/image-generator');

// --- sanitizeSettings: LoRA mode --------------------------------------------

test('LoRA sanitize: legacy on/off derives mode', () => {
    const { loras } = imageGenerator.sanitizeSettings({
        loras: [
            { name: 'a.safetensors', strength: 1 },
            { name: 'b.safetensors', strength: 1, on: false }
        ]
    });
    assert.equal(loras[0].mode, 'on');
    assert.equal(loras[0].on, true);
    assert.equal(loras[1].mode, 'off');
    assert.equal(loras[1].on, false);
});

test('LoRA sanitize: explicit auto mode disables the on flag', () => {
    const { loras } = imageGenerator.sanitizeSettings({
        loras: [{ name: 'realism.safetensors', mode: 'auto', triggerWord: 'realism' }]
    });
    assert.equal(loras[0].mode, 'auto');
    assert.equal(loras[0].on, false);
    assert.equal(loras[0].triggerWord, 'realism');
});

// --- promptHasKeyword --------------------------------------------------------

test('promptHasKeyword: whole-word, case-insensitive match', () => {
    assert.equal(imageGenerator.promptHasKeyword('a Realism portrait', 'realism'), true);
    assert.equal(imageGenerator.promptHasKeyword('realism', 'realism'), true);
    assert.equal(imageGenerator.promptHasKeyword('a surrealism painting', 'realism'), false);
    assert.equal(imageGenerator.promptHasKeyword('a woman', 'realism'), false);
    assert.equal(imageGenerator.promptHasKeyword('anything', ''), false);
});

// --- resolveActiveLoras ------------------------------------------------------

test('resolveActiveLoras: on always applies, off never', () => {
    const loras = [
        { name: 'on.safetensors', mode: 'on', triggerWord: '' },
        { name: 'off.safetensors', mode: 'off', triggerWord: '' }
    ];
    const active = imageGenerator.resolveActiveLoras(loras, 'anything at all');
    assert.deepEqual(active.map((l) => l.name), ['on.safetensors']);
});

test('resolveActiveLoras: auto applies only when its keyword is present', () => {
    const loras = [{ name: 'realism.safetensors', mode: 'auto', triggerWord: 'realism' }];
    assert.equal(imageGenerator.resolveActiveLoras(loras, 'a portrait').length, 0);
    assert.equal(imageGenerator.resolveActiveLoras(loras, 'a realism portrait').length, 1);
});

test('resolveActiveLoras: auto entries are normalized to enabled', () => {
    const loras = [{ name: 'realism.safetensors', mode: 'auto', on: false, strength: 0.8, triggerWord: 'realism' }];
    const active = imageGenerator.resolveActiveLoras(loras, 'realism');
    assert.equal(active[0].mode, 'on');
    assert.equal(active[0].on, true);
    assert.equal(active[0].strength, 0.8);
});

test('resolveActiveLoras: a keyword-less auto entry never applies', () => {
    const loras = [{ name: 'x.safetensors', mode: 'auto', triggerWord: '' }];
    assert.equal(imageGenerator.resolveActiveLoras(loras, 'anything').length, 0);
});

// --- resolveTriggerWords -----------------------------------------------------

test('resolveTriggerWords: prepends on-LoRA triggers once', () => {
    const active = imageGenerator.resolveActiveLoras(
        [{ name: 'instafame.safetensors', mode: 'on', triggerWord: 'instafame' }],
        'a woman'
    );
    assert.deepEqual(imageGenerator.resolveTriggerWords(active, 'a woman'), ['instafame']);
});

test('resolveTriggerWords: skips words already in the prompt', () => {
    const active = imageGenerator.resolveActiveLoras(
        [{ name: 'instafame.safetensors', mode: 'on', triggerWord: 'instafame' }],
        'instafame woman'
    );
    assert.deepEqual(imageGenerator.resolveTriggerWords(active, 'instafame woman'), []);
});

// --- matchAutoLoras / mergeForcedLoras (pre-LLM capture) ---------------------

test('matchAutoLoras: matches the raw message keyword, not the rewritten prompt', () => {
    const settings = {
        autoLoraPreLlm: true,
        loras: [
            { name: 'nofilter.safetensors', mode: 'auto', triggerWord: 'nofilter' },
            { name: 'realism.safetensors', mode: 'auto', triggerWord: 'realism' }
        ]
    };
    assert.deepEqual(imageGenerator.matchAutoLoras('raw portrait with nofilter', settings), ['nofilter.safetensors']);
    assert.deepEqual(imageGenerator.matchAutoLoras('a portrait', settings), []);
});

test('matchAutoLoras: only auto entries, gated by the global setting', () => {
    const loras = [
        { name: 'on.safetensors', mode: 'on', triggerWord: 'realism' },
        { name: 'auto.safetensors', mode: 'auto', triggerWord: 'realism' }
    ];
    assert.deepEqual(imageGenerator.matchAutoLoras('realism', { autoLoraPreLlm: true, loras }), ['auto.safetensors']);
    assert.deepEqual(imageGenerator.matchAutoLoras('realism', { autoLoraPreLlm: false, loras }), []);
});

test('mergeForcedLoras: force-applies a matched auto entry and normalizes it', () => {
    const loras = [{ name: 'nofilter.safetensors', mode: 'auto', on: false, strength: 1, triggerWord: 'nofilter' }];
    const active = imageGenerator.mergeForcedLoras(loras, [], ['nofilter.safetensors']);
    assert.deepEqual(active.map((l) => l.name), ['nofilter.safetensors']);
    assert.equal(active[0].on, true);
    assert.equal(active[0].mode, 'on');
});

test('mergeForcedLoras: no duplicates and never revives an off entry', () => {
    const loras = [
        { name: 'x.safetensors', mode: 'on', on: true, triggerWord: '' },
        { name: 'off.safetensors', mode: 'off', on: false, triggerWord: '' }
    ];
    const active = imageGenerator.resolveActiveLoras(loras, '');
    const merged = imageGenerator.mergeForcedLoras(loras, active, ['x.safetensors', 'off.safetensors']);
    assert.deepEqual(merged.map((l) => l.name), ['x.safetensors']);
});

