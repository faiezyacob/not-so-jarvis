/* ============================================
   JARVIS — Wan Animate 2 swap prompt enhancer
   Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const prompt = require('../services/character-swap/engines/wan-animate2-prompt');
const references = require('../services/character-swap/references');

test('extractTarget reads the person the user asked to replace', () => {
    assert.equal(prompt.extractTarget('replace the person on the left'), 'the person on the left');
    assert.equal(prompt.extractTarget('Replace person on the left with the reference character'), 'the person on the left');
    assert.equal(prompt.extractTarget('swap the woman in the middle with my image'), 'the woman in the middle');
    assert.equal(prompt.extractTarget('the man on the right should be replaced'), 'the man on the right');
    assert.equal(prompt.extractTarget('make the guy in the red shirt the reference character'), 'the guy in the red shirt');
});

test('extractTarget never treats the scene, background or clothing as the person', () => {
    assert.equal(prompt.extractTarget('change the background to a rainy street'), '');
    assert.equal(prompt.extractTarget('replace the outfit with a red coat'), '');
    assert.equal(prompt.extractTarget('make the scene brighter'), '');
    assert.equal(prompt.extractTarget('hello there'), '');
});

test('extractSceneOverride only accepts an explicit background cue', () => {
    assert.equal(prompt.extractSceneOverride('replace the person on the left, background: a rainy street'), 'a rainy street');
    assert.equal(prompt.extractSceneOverride('replace the person on the left in a busy cafe'), 'in a busy cafe');
    assert.equal(prompt.extractSceneOverride('replace the person on the left with the woman in the red dress'), '');
    assert.equal(prompt.extractSceneOverride('replace the person on the left'), '');
});

test('buildSwapPrompt follows the Wan Animate 2 subject + background format', () => {
    const text = prompt.buildSwapPrompt({
        userPrompt: 'replace the person on the left',
        identitySummary: 'A woman with short red hair, a green coat and black boots',
        scene: {
            summary: 'A bright cafe with wooden tables, large windows and soft daylight',
            viewpoint: 'front three-quarter medium shot',
            otherPeople: 'two other customers remain in the background'
        }
    });
    assert.match(text, /^Subject appearance: A woman with short red hair/);
    assert.match(text, /Change: only the person on the left is replaced/);
    assert.match(text, /Background: A bright cafe with wooden tables/);
    assert.match(text, /Other people: two other customers remain/);
    assert.match(text, /Viewpoint: front three-quarter medium shot/);
    assert.match(text, /Preservation: keep the original video's background/);
    assert.match(text, /Do not add, remove, move or restyle anything except the person on the left/);
});

test('buildSwapPrompt never copies the user motion into the appearance section', () => {
    const text = prompt.buildSwapPrompt({
        userPrompt: 'replace the person on the left with the character dancing and waving',
        identitySummary: 'A man in a blue jacket',
        scene: { summary: 'A plain studio with even lighting' }
    });
    assert.doesNotMatch(text, /dancing/i);
    assert.doesNotMatch(text, /waving/i);
    assert.match(text, /Subject appearance: A man in a blue jacket/);
});

test('buildSwapPrompt falls back to scene preservation wording without a caption', () => {
    const text = prompt.buildSwapPrompt({ userPrompt: 'replace the person on the left' });
    assert.match(text, /Subject appearance: the character shown in the reference image/);
    assert.match(text, /Background: the same background as the original video/);
    assert.match(text, /Viewpoint: the same camera angle, framing and crop as the original video/);
    assert.match(text, /Preservation:/);
});

test('an explicit new scene wins over the captured original scene', () => {
    const text = prompt.buildSwapPrompt({
        userPrompt: 'replace the person on the left in a neon nightclub',
        scene: { summary: 'A quiet library with warm lamps' }
    });
    assert.match(text, /Background: in a neon nightclub/);
    assert.doesNotMatch(text, /quiet library/);
});

test('normalizeScene trims a caption and keeps the preservation fields', () => {
    const scene = references.normalizeScene({
        summary: '  A   park with trees. ',
        viewpoint: 'wide shot',
        peoplePresent: true,
        otherPeople: 'one other person stays seated'
    });
    assert.equal(scene.summary, 'A park with trees.');
    assert.equal(scene.viewpoint, 'wide shot');
    assert.equal(scene.peoplePresent, true);
    assert.equal(scene.otherPeople, 'one other person stays seated');
    assert.equal(references.normalizeScene({ summary: '' }).summary, '');
});
