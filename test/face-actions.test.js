/* ============================================
   JARVIS — Creative Playground Face Action tests
   Covers the dedicated facial-action catalog,
   natural-language normalization, context weighting,
   Playground persistence and identity separation.
   Runtime stores are isolated in a temp directory.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-face-actions-'));
process.env.PLAYGROUND_STATE_PATH = path.join(tmpDir, 'playground-state.json');
process.env.CHARACTER_PRESETS_PATH = path.join(tmpDir, 'character-presets.json');
process.env.CHARACTER_CONTEXT_PATH = path.join(tmpDir, 'character-context.json');

const faceActions = require('../services/playground/face-actions');
const concept = require('../services/playground/concept');
const playground = require('../services/playground/playground');
const characterGen = require('../services/playground/character');
const characterContext = require('../services/character-context');

function conversationId(name) {
    return 'face-action-' + name + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
}

test('Auto Face Action selection chooses a coherent preset for the content context', () => {
    const selected = faceActions.selectFaceAction({
        themeId: 'lifestyle-candid',
        outfitPack: 'casual-everyday',
        rng: () => 0.4
    });
    assert.ok(selected && selected.id);
    assert.ok(selected.expression && selected.mouth && selected.eyes && selected.head);
    assert.equal(selected.source, 'auto');
});

test('an explicit smile request resolves to a structured soft smile', () => {
    const result = faceActions.matchFaceActionFromText('@Maya smiling');
    assert.equal(result.confident, true);
    assert.equal(result.id, 'soft_smile');
    assert.equal(result.components.expression, 'soft_smile');
    assert.equal(result.components.mouth, 'closed_smile');
});

test('an explicit open-mouth smile remains open-mouth after normalization', () => {
    const result = faceActions.matchFaceActionFromText('Maya gives an open-mouth smile');
    assert.equal(result.components.expression, 'big_smile');
    assert.equal(result.components.mouth, 'open_smile');
});

test('an explicit smirk stays subtle and does not add a big or open-mouth smile', () => {
    const result = faceActions.matchFaceActionFromText('Maya smirking');
    assert.equal(result.id, 'smirk');
    assert.equal(result.components.expression, 'confident');
    assert.equal(result.components.mouth, 'smirk');
    assert.notEqual(result.components.expression, 'big_smile');
    assert.notEqual(result.components.mouth, 'open_smile');
});

test('an explicit tongue-out request normalizes to one playful action', () => {
    const result = faceActions.matchFaceActionFromText('Maya sticking her tongue out');
    assert.equal(result.id, 'tongue_out');
    assert.equal(result.components.expression, 'playful');
    assert.equal(result.components.mouth, 'tongue_out');
    assert.equal(result.components.eyes, 'playful_gaze');
});

test('an explicit wink request selects the coherent wink preset', () => {
    const result = faceActions.matchFaceActionFromText('give Maya a playful wink');
    assert.equal(result.id, 'wink');
    assert.equal(result.components.expression, 'playful');
    assert.equal(result.components.eyes, 'wink');
});

test('explicit gaze requests resolve to direct eye contact and side glances', () => {
    const direct = faceActions.matchFaceActionFromText('looking directly at the camera');
    const side = faceActions.matchFaceActionFromText('give her a side glance');
    assert.equal(direct.id, 'direct_contact');
    assert.equal(direct.components.eyes, 'direct_contact');
    assert.equal(side.id, 'side_glance');
    assert.equal(side.components.eyes, 'side_glance');
});

test('conflicting smile and tongue-out instructions normalize without contradictory mouth actions', () => {
    const result = faceActions.matchFaceActionFromText('Maya smiling with her tongue out');
    assert.equal(result.id, 'tongue_out');
    assert.equal(result.components.expression, 'playful');
    assert.equal(result.components.mouth, 'tongue_out');
    assert.notEqual(result.components.mouth, 'closed_smile');
});

test('recognized facial wording is removed from the raw scene prompt after structuring', () => {
    const built = concept.assembleConcept({
        themeId: 'lifestyle-candid',
        mode: 'none',
        userPrompt: 'Maya smiling with her tongue out on a sunny beach',
        rng: () => 0.3
    });
    const direction = concept.conceptToDirection(built);
    assert.equal(built.faceActionId, 'tongue_out');
    assert.match(direction, /FACIAL EXPRESSION|Facial expression:/);
    assert.match(direction, /sunny beach/i);
    assert.doesNotMatch(direction, /smiling with her tongue out/i);
});

test('typed Playground expression follow-ups become structured face-action changes', () => {
    const result = concept.interpretContextMessage('Make Maya smirk', {
        open: true,
        themeId: 'fashion-editorial'
    });
    assert.equal(result.action, 'modify');
    assert.equal(result.changes.faceAction, 'smirk');
});

test('Surprise Me Again varies Face Actions while keeping the same character identity', () => {
    const session = playground.start({
        conversationId: conversationId('surprise-variety'),
        themeId: 'lifestyle-candid',
        mode: 'random_character',
        locks: { identity: true },
        rng: characterGen.createRng(101)
    });
    const identity = session.concept.identitySignature;
    const actions = new Set([session.concept.faceActionId]);
    for (let i = 0; i < 6; i++) {
        playground.again(session, { rng: characterGen.createRng(200 + i) });
        actions.add(session.concept.faceActionId);
        assert.equal(session.concept.identitySignature, identity);
    }
    assert.ok(actions.size > 1, 'Surprise Me Again should vary the face action');
});

test('face-action locking and unrelated edits preserve the selected expression', () => {
    const session = playground.start({
        conversationId: conversationId('expression-lock'),
        themeId: 'fashion-editorial',
        mode: 'random_character',
        locks: { faceAction: true },
        faceAction: 'smirk',
        rng: characterGen.createRng(33)
    });
    const before = session.concept.faceActionId;
    playground.again(session, { rng: characterGen.createRng(39) });
    assert.equal(session.concept.faceActionId, before);
    playground.modify(session, { changes: { environment: 'a quiet studio' } });
    assert.equal(session.concept.faceActionId, before);
});

test('regeneration requests retain the face-action id and component description', () => {
    const session = playground.start({
        conversationId: conversationId('regenerate'),
        themeId: 'lifestyle-candid',
        mode: 'random_character',
        faceAction: 'soft_smile',
        rng: characterGen.createRng(71)
    });
    const request = playground.buildImageRequest(session);
    assert.equal(request.generationContext.faceActionId, 'soft_smile');
    assert.equal(request.faceAction.id, 'soft_smile');
    assert.match(request.scene.faceAction, /soft, warm smile/i);
    assert.match(request.user_prompt, /Facial expression:/);
});

test('content style changes face-action weights for lifestyle and glamour', () => {
    const smirk = faceActions.getFaceAction('smirk');
    const laughing = faceActions.getFaceAction('laughing');
    assert.ok(faceActions.scoreFaceAction(smirk, { themeId: 'fashion-editorial' })
        > faceActions.scoreFaceAction(smirk, { themeId: 'lifestyle-candid' }));
    assert.ok(faceActions.scoreFaceAction(laughing, { themeId: 'lifestyle-candid' })
        > faceActions.scoreFaceAction(laughing, { themeId: 'fashion-editorial' }));
});

test('Playground generation still works without an explicit Face Action and portrait requests stay identity-only', () => {
    const session = playground.start({
        conversationId: conversationId('backward-compatible'),
        themeId: 'lifestyle-candid',
        mode: 'random_character',
        rng: characterGen.createRng(82)
    });
    const request = playground.buildImageRequest(session);
    assert.ok(request.user_prompt.includes('Creative direction:'));
    assert.ok(request.faceAction && request.faceAction.id);
    assert.ok(request.explicit_constraints.some((item) => /facial expression changes only/i.test(item)));
    const portrait = playground.buildPortraitRequest(session);
    assert.ok(!/Facial expression:/i.test(portrait.user_prompt));
    assert.equal(portrait.scene && Object.keys(portrait.scene).length, 0);
});

test('@Character facial requests are structured and kept separate from identity', () => {
    const section = characterContext.buildFaceActionSection([
        { id: 'maya', name: 'Maya', identity: { gender: 'woman' } }
    ], '@Maya looking over her shoulder with a subtle smile');
    assert.ok(section);
    assert.equal(section.id, 'over_shoulder');
    assert.equal(section.expression, 'soft_smile');
    assert.equal(section.head, 'over_shoulder');
    assert.match(section.section, /FACIAL EXPRESSION/);
    assert.match(section.section, /preserve the same facial structure/i);
});
