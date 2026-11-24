/* ============================================
   JARVIS — Image Arena battle prompt tests
   The LLM-written creative prompt plus its
   deterministic, fail-open fallback pool.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const test = require('node:test');
const assert = require('node:assert');

const prompts = require('../services/benchmark/prompts');
const battle = require('../services/benchmark/battle');

function longPrompt(subject) {
    return subject + ', shot on a 50mm lens in low afternoon light, with weathered wood, '
        + 'wet stone and a thin layer of dust on every surface, cool green and warm ochre palette.';
}

test('battle still exposes the deterministic fallback pool', () => {
    assert.ok(battle.PROMPTS.length >= 20);
    assert.equal(typeof battle.randomPrompt, 'function');
    const pick = battle.randomPrompt();
    assert.ok(pick.prompt && pick.category);
});

test('buildMessages asks for varied, distinct prompts and carries the exclusions', () => {
    const messages = prompts.buildMessages({ exclude: ['an old prompt'], count: 3 });
    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].content, /strict JSON/);
    const user = messages[1].content;
    assert.match(user, /Write 3 new prompts/);
    assert.match(user, /Do not reuse or lightly reword/);
    assert.match(user, /an old prompt/);
});

test('a fenced JSON reply is parsed, sanitized and deduped', () => {
    const reply = '```json\n' + JSON.stringify({
        prompts: [
            { category: 'cinematic', prompt: longPrompt('A ferry dock at dawn') },
            { category: 'made-up', prompt: longPrompt('A ferry dock at dawn') },
            { category: 'nonsense', prompt: longPrompt('A bakery before opening') },
            { category: 'short', prompt: 'too short' },
            { category: 'portrait', prompt: 'masterpiece, 8k, best quality, ' + longPrompt('A potter at the wheel') },
            { category: 'portrait', prompt: longPrompt('A potter at the wheel') }
        ]
    }) + '\n```';
    const parsed = prompts.parsePrompts(reply);
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].category, 'cinematic');
    assert.equal(parsed[1].category, 'creative', 'unknown category falls back to creative');
    assert.equal(parsed[2].category, 'portrait', 'quality spam is dropped');
    assert.deepEqual(parsed.map((entry) => entry.prompt), [
        longPrompt('A ferry dock at dawn'),
        longPrompt('A bakery before opening'),
        longPrompt('A potter at the wheel')
    ]);
});

test('markdown narration around the JSON block is tolerated', () => {
    const reply = 'Here are the prompts:\n\n'
        + JSON.stringify([{ category: 'interior', prompt: longPrompt('A repair shop at night') }])
        + '\n\nEnjoy.';
    const parsed = prompts.parsePrompts(reply);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].category, 'interior');
});

test('a malformed reply yields no prompts instead of throwing', () => {
    assert.deepEqual(prompts.parsePrompts('no json here'), []);
    assert.deepEqual(prompts.parsePrompts(''), []);
    assert.deepEqual(prompts.parsePrompts('{"prompts": [oops]'), []);
});

test('nextPrompt serves its cached batch before calling the model again', async () => {
    prompts._reset();
    let calls = 0;
    const generate = async () => {
        calls += 1;
        return JSON.stringify({
            prompts: [
                { category: 'cinematic', prompt: longPrompt('A ferry dock at dawn') },
                { category: 'food', prompt: longPrompt('A bakery before opening') },
                { category: 'animal', prompt: longPrompt('A barn cat on a hay bale') }
            ]
        });
    };
    const first = await prompts.nextPrompt({ sessionId: 'dev1', generate, model: 'test' });
    assert.equal(first.source, 'llm');
    assert.equal(first.prompt, longPrompt('A ferry dock at dawn'));

    const second = await prompts.nextPrompt({ sessionId: 'dev1', generate, model: 'test' });
    assert.equal(second.source, 'llm');
    assert.equal(second.prompt, longPrompt('A bakery before opening'));
    assert.equal(calls, 1, 'a batch roll costs one model call');

    // The cache is per device session.
    const other = await prompts.nextPrompt({ sessionId: 'dev2', generate, model: 'test' });
    assert.equal(calls, 2);
    assert.ok(other.prompt);
    prompts._reset();
});

test('the previous prompt is excluded from the next roll', async () => {
    prompts._reset();
    const generate = async () => JSON.stringify({
        prompts: [
            { category: 'cinematic', prompt: longPrompt('A ferry dock at dawn') },
            { category: 'food', prompt: longPrompt('A bakery before opening') }
        ]
    });
    const first = await prompts.nextPrompt({ sessionId: 'dev1', generate });
    const next = await prompts.nextPrompt({
        sessionId: 'dev1', generate, exclude: [first.prompt]
    });
    assert.notEqual(next.prompt, first.prompt);
    prompts._reset();
});

test('nextPrompt fails open to the local pool when the model fails or output is unusable', async () => {
    prompts._reset();
    const broken = await prompts.nextPrompt({
        sessionId: 'dev1', generate: async () => { throw new Error('offline'); }
    });
    assert.equal(broken.source, 'pool');
    assert.ok(broken.prompt && broken.category);

    const nonsense = await prompts.nextPrompt({
        sessionId: 'dev1', generate: async () => 'I cannot help with that.'
    });
    assert.equal(nonsense.source, 'pool');
    assert.ok(nonsense.prompt);

    const disabled = await prompts.nextPrompt({ sessionId: 'dev1', generate: null });
    assert.equal(disabled.source, 'pool');
    prompts._reset();
});
