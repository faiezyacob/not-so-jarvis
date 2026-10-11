/* SPDX-License-Identifier: MIT */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-life-'));
process.env.CHARACTER_LIFE_PATH = path.join(tempDir, 'character-life.json');
process.env.CHARACTER_PRESETS_PATH = path.join(tempDir, 'character-presets.json');
process.env.COMPANION_PATH = path.join(tempDir, 'companion.json');

const characterLife = require('../services/character-life');
const camera = require('../services/character-life/camera-director');
const life = require('../services/character-life/life');
const companion = require('../services/companion');
const characterPresets = require('../services/character-presets');

test.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

// 1. "Send me a pic" defaults to a selfie.
test('ambiguous "send me a pic" defaults to a selfie', () => {
    const result = camera.detectPhotoIntent('send me a pic');
    assert.equal(result.intent, camera.INTENT.SELFIE);
    assert.notEqual(result.confidence, 'none');
    assert.equal(camera.detectPhotoIntent('let me see you').intent, camera.INTENT.SELFIE);
    assert.equal(camera.detectPhotoIntent("show me what you're doing").intent, camera.INTENT.SELFIE);
});

// 7. Ordinary conversation never triggers image generation.
test('ordinary conversation is not a photo request', () => {
    assert.equal(camera.detectPhotoIntent('what are you doing?').intent, camera.INTENT.NONE);
    assert.equal(camera.detectPhotoIntent('how is it going?').intent, camera.INTENT.NONE);
    assert.equal(camera.detectPhotoIntent('what are you eating?').intent, camera.INTENT.NONE);
    assert.equal(camera.detectPhotoIntent('tell me about your day').intent, camera.INTENT.NONE);
    // A general scene-generation request is not a life-state photo request.
    assert.equal(camera.detectPhotoIntent('generate an image of a castle in the forest').intent, camera.INTENT.NONE);
});

// 2. "Show me what you're eating" -> rear-camera food photo, no character face.
test('food request prioritizes the subject on the back camera', () => {
    const intent = camera.detectPhotoIntent("show me what you're eating");
    assert.equal(intent.intent, camera.INTENT.SUBJECT);
    const spec = camera.buildPhotoSpec({ intent: intent.intent, subject: intent.subject, life: { location: 'the kitchen', activity: 'eating lunch' } });
    assert.equal(spec.cameraView, camera.CAMERA_VIEW.REAR);
    assert.equal(spec.includeCharacter, false);
    const built = camera.buildPhotoInstruction(spec);
    assert.equal(built.mode, 'plain');
    assert.match(built.prompt, /no one looking at the camera/i);
});

test('an animal request targets the animal, not the character', () => {
    const intent = camera.detectPhotoIntent('show me that cat');
    assert.equal(intent.intent, camera.INTENT.SUBJECT);
    const spec = camera.buildPhotoSpec({ intent: intent.intent, subject: intent.subject });
    assert.equal(spec.cameraView, camera.CAMERA_VIEW.REAR);
    assert.equal(spec.includeCharacter, false);
});

test('a scenery request uses the back camera without a face', () => {
    const intent = camera.detectPhotoIntent('show me the view');
    assert.equal(intent.intent, camera.INTENT.SCENERY);
    const spec = camera.buildPhotoSpec({ intent: intent.intent, life: { location: 'the harbour' } });
    assert.equal(spec.cameraView, camera.CAMERA_VIEW.REAR);
    assert.equal(spec.includeCharacter, false);
});

// 3. "Show me your outfit" -> mirror, full-body, identity preserved.
test('outfit request produces mirror full-body framing', () => {
    const intent = camera.detectPhotoIntent('show me your outfit');
    assert.equal(intent.intent, camera.INTENT.OUTFIT);
    const spec = camera.buildPhotoSpec({ intent: intent.intent, characters: [{ name: 'Maya' }], life: { outfit: 'a satin dress and heels' } });
    assert.equal(spec.cameraView, camera.CAMERA_VIEW.MIRROR);
    assert.equal(spec.includeCharacter, true);
    const built = camera.buildPhotoInstruction(spec);
    assert.equal(built.mode, 'identity');
    assert.match(built.instruction, /mirror/i);
    assert.match(built.instruction, /satin dress/);
    assert.match(built.instruction, /identity/i);
});

test('a photo explicitly of the character stays a selfie even with a place mentioned', () => {
    const named = camera.detectPhotoIntent('send me a photo of Maya at the beach', { names: ['Maya'] });
    assert.equal(named.intent, camera.INTENT.SELFIE);
    const generic = camera.detectPhotoIntent('send me a photo of her at the beach');
    assert.equal(generic.intent, camera.INTENT.SELFIE);
    // Without a person reference the same place wording is scenery.
    assert.equal(camera.detectPhotoIntent('show me the beach').intent, camera.INTENT.SCENERY);
});

test('a group request produces a wide group photo', () => {
    const intent = camera.detectPhotoIntent('send a group photo with your friends');
    assert.equal(intent.intent, camera.INTENT.GROUP);
    const spec = camera.buildPhotoSpec({ intent: intent.intent, characters: [{ name: 'Maya' }] });
    assert.equal(spec.includeCharacter, true);
    assert.match(camera.buildPhotoInstruction(spec).instruction, /group photo/i);
});

// User-specified clothing/pose is prioritized over the life state.
test('an explicit clothing request overrides the life-state outfit', () => {
    const characterId = 'char_explicit_outfit';
    characterLife.setLife(characterId, {
        activity: 'relaxing at home', location: 'the living room', outfit: 'an oversized tee and lounge shorts'
    }, 'user');

    const plan = characterLife.planPhoto({
        characterId,
        intent: camera.INTENT.SELFIE,
        characters: [{ name: 'Maya' }],
        message: 'send me a selfie of you wearing a tank top'
    });
    assert.equal(plan.spec.outfit, 'a tank top');
    assert.equal(plan.spec.outfitSource, 'user');
    assert.equal(plan.request.mode, 'identity');
    assert.match(plan.request.instruction, /tank top/);
    assert.ok(!/oversized tee/.test(plan.request.instruction));
    // The stored life state is never changed by a generation request.
    assert.equal(characterLife.getLife(characterId).outfit, 'an oversized tee and lounge shorts');
});

test('parseUserRequest separates clothing from other scene specifics', () => {
    const parsed = camera.parseUserRequest('show me a selfie wearing a red dress at the beach');
    assert.equal(parsed.clothing, 'a red dress');
    assert.match(parsed.scene, /beach/);
    assert.equal(camera.parseUserRequest('send me a selfie at the beach').clothing, '');
    assert.equal(camera.parseUserRequest('send me a selfie').clothing, '');
    assert.equal(camera.parseUserRequest('yes please').clothing, '');
});

test('an explicit action/pose overrides the life activity', () => {
    const characterId = 'char_pose';
    characterLife.setLife(characterId, { activity: 'relaxing at home', location: 'the living room' }, 'user');
    const plan = characterLife.planPhoto({
        characterId,
        intent: camera.INTENT.SELFIE,
        characters: [{ name: 'Maya' }],
        message: 'send me a selfie of you lying on the bed'
    });
    assert.equal(plan.spec.actionSource, 'user');
    assert.match(plan.spec.requestedAction, /lying on the bed/);
    assert.match(plan.request.instruction, /lying on the bed/);
    assert.ok(!/relaxing at home/.test(plan.request.instruction));
});

test('self-referential "what you\'re doing" falls back to the life activity', () => {
    const characterId = 'char_selfref';
    characterLife.setLife(characterId, { activity: 'making coffee', location: 'the kitchen' }, 'user');
    const plan = characterLife.planPhoto({
        characterId,
        intent: camera.INTENT.SELFIE,
        characters: [{ name: 'Maya' }],
        message: "show me what you're doing"
    });
    assert.equal(plan.spec.actionSource, 'life');
    assert.match(plan.request.instruction, /making coffee/);
});

test('outfit requests keep the pose the user added', () => {
    const characterId = 'char_outfit_pose';
    characterLife.setLife(characterId, { activity: 'at home', location: 'the bedroom', outfit: 'jeans' }, 'user');
    const parsed = camera.parseUserRequest('show me your outfit while sitting on the couch');
    assert.equal(parsed.clothing, '');
    assert.match(parsed.scene, /sitting on the couch/);
    const plan = characterLife.planPhoto({
        characterId,
        intent: camera.INTENT.OUTFIT,
        characters: [{ name: 'Maya' }],
        message: 'show me your outfit while sitting on the couch'
    });
    assert.equal(plan.spec.actionSource, 'user');
    assert.match(plan.request.instruction, /sitting on the couch/);
});

test('a non-action modifier is carried as detail, not forced into an action clause', () => {
    const parsed = camera.parseUserRequest('send me a selfie with a big smile');
    assert.match(parsed.scene, /big smile/);
    const plan = characterLife.planPhoto({
        intent: camera.INTENT.SELFIE,
        characters: [{ name: 'Maya' }],
        message: 'send me a selfie with a big smile'
    });
    assert.equal(plan.spec.actionSource, 'none');
    assert.match(plan.spec.detail, /big smile/);
    assert.match(plan.request.instruction, /big smile/);
});

test('a named place is carried into the photo instruction', () => {
    const characterId = 'char_place';
    characterLife.setLife(characterId, { activity: 'walking', location: 'the park' }, 'user');
    const plan = characterLife.planPhoto({
        characterId,
        intent: camera.INTENT.SELFIE,
        characters: [{ name: 'Maya' }],
        message: 'send me a selfie at the beach'
    });
    assert.match(plan.request.instruction, /the beach/);
});

// 4. Different life states produce different compositions.
test('composition varies with the life state', () => {
    const selfie = { intent: camera.INTENT.SELFIE, characters: [{ name: 'Maya' }] };
    const a = camera.buildPhotoInstruction(camera.buildPhotoSpec(Object.assign({}, selfie, { life: { activity: 'making coffee', location: 'the kitchen' } })));
    const b = camera.buildPhotoInstruction(camera.buildPhotoSpec(Object.assign({}, selfie, { life: { activity: 'reading', location: 'the living room' } })));
    assert.notEqual(a.instruction, b.instruction);
    assert.match(a.instruction, /kitchen/);
    assert.match(b.instruction, /living room/);
    assert.equal(a.mode, 'identity');
});

// 6. Consecutive photos keep location/outfit continuity via the scene history.
test('scene history drives location and outfit continuity', () => {
    const characterId = 'char_continuity';
    characterLife.setLife(characterId, { activity: 'making coffee', location: 'the kitchen', outfit: 'an oversized tee' }, 'user');
    const first = characterLife.planPhoto({ characterId, intent: camera.INTENT.SELFIE, characters: [{ name: 'Maya' }] });
    assert.equal(first.request.mode, 'identity');
    characterLife.recordScene(characterId, first.spec, { filename: 'photo1.png', url: '/generated/photo1.png' });

    const second = characterLife.planPhoto({ characterId, intent: camera.INTENT.SELFIE, characters: [{ name: 'Maya' }] });
    assert.ok(second.spec.continuity.some((c) => /same location/.test(c)));
    assert.ok(second.spec.continuity.some((c) => /same outfit/.test(c)));
    assert.equal(characterLife.listSceneHistory(characterId).length, 1);
});

// 10. Characters keep independent life states.
test('life state is isolated per character', () => {
    characterLife.setLife('life_a', { activity: 'at the gym', location: 'the gym' }, 'user');
    characterLife.setLife('life_b', { activity: 'reading', location: 'the library' }, 'user');
    assert.equal(characterLife.getLife('life_a').activity, 'at the gym');
    assert.equal(characterLife.getLife('life_b').activity, 'reading');
    assert.equal(characterLife.listSceneHistory('life_a').length, 0);
});

// Life state sanitize + format.
test('life state sanitizes and formats for the prompt', () => {
    const characterId = 'char_format';
    const saved = characterLife.setLife(characterId, {
        activity: '  making tea  ',
        location: 'the kitchen',
        outfit: 'a cardigan',
        provenance: 'llm'
    }, 'user');
    assert.equal(saved.activity, 'making tea');
    assert.equal(saved.provenance, 'user');
    assert.ok(saved.updatedAt);
    const text = characterLife.formatForPrompt(characterId);
    assert.match(text, /making tea/);
    assert.match(text, /the kitchen/);
    assert.match(text, /fiction/i);
    assert.equal(characterLife.formatForPrompt('char_empty_none'), '');
});

test('life state survives a store reload', () => {
    const characterId = 'char_reload';
    characterLife.setLife(characterId, { activity: 'painting', location: 'the studio' }, 'user');
    characterLife._reset();
    const reread = characterLife.getLife(characterId);
    assert.equal(reread.activity, 'painting');
    assert.equal(reread.location, 'the studio');
});

// 9. Evolution failures never break chat (fail-open).
test('life evolution is fail-open when the provider errors', async () => {
    const characterId = 'char_evolve_fail';
    const result = await characterLife.evolve({
        characterId,
        character: { id: characterId, name: 'Nova' },
        provider: 'ollama',
        model: 'test',
        providers: { chat: async () => { throw new Error('ollama offline'); } },
        now: 0
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'scheduled');
    assert.ok(characterLife.getLife(characterId).activity);
});

test('life evolution parses valid model JSON', async () => {
    const characterId = 'char_evolve_llm';
    const result = await characterLife.evolve({
        characterId,
        character: { id: characterId, name: 'Nova' },
        providers: {
            chat: async () => JSON.stringify({
                activity: 'baking bread', location: 'the kitchen', outfit: 'a tee and an apron',
                context: 'a lazy Sunday', mood: 'cheerful', tone: 'warm', planned: 'call her sister'
            })
        },
        now: 0
    });
    assert.equal(result.source, 'llm');
    assert.equal(characterLife.getLife(characterId).activity, 'baking bread');
});

test('life evolution avoids repeating the recent activity', async () => {
    const characterId = 'char_no_repeat';
    // Seed the current activity, then evolve deterministically (no provider).
    characterLife.setLife(characterId, { activity: 'at the gym', location: 'the gym' }, 'user');
    const result = await characterLife.evolve({ characterId, character: { id: characterId, name: 'Nova' }, now: 0 });
    assert.equal(result.ok, true);
    assert.notEqual(result.life.activity, 'at the gym');
});

test('evolution respects the interval', async () => {
    const characterId = 'char_interval';
    await characterLife.evolve({ characterId, character: { id: characterId, name: 'Nova' }, now: 0 });
    const tooSoon = await characterLife.evolve({ characterId, character: { id: characterId, name: 'Nova' }, now: 1000, intervalMinutes: 180 });
    assert.equal(tooSoon.ok, false);
    assert.equal(tooSoon.reason, 'not_due');
});

// 8. Photo offers require acceptance; auto mode marks the offer auto.
test('photo offers require an acceptance and honour photo-sharing policy', () => {
    const offer = camera.detectOffer('I just made a coffee, want to see?');
    assert.ok(offer);
    assert.equal(offer.intent, camera.INTENT.SUBJECT);

    const characterId = 'char_offer';
    characterLife.setOffer(characterId, 'conv-1', { intent: camera.INTENT.SELFIE, subject: '', auto: false });
    assert.ok(characterLife.getOffer(characterId, 'conv-1'));
    assert.equal(camera.isAcceptance('yes please'), true);
    assert.equal(camera.isAcceptance('show me'), true);
    assert.equal(camera.isAcceptance('maybe later'), false);
    assert.equal(camera.isRejection('no thanks'), true);
    characterLife.clearOffer(characterId, 'conv-1');
    assert.equal(characterLife.getOffer(characterId, 'conv-1'), null);
});

test('offers are not detected in ordinary replies', () => {
    assert.equal(camera.detectOffer('That sounds like a nice plan for the weekend.'), null);
    assert.equal(camera.detectOffer(''), null);
});

// Persona prompt carries the life state.
test('companion context includes the life state', () => {
    const text = companion.buildContextForTurn({
        characterId: 'char_prompt_life',
        character: { id: 'char_prompt_life', name: 'Maya' },
        settings: { personality: 'Warm.' },
        globalSettings: companion.DEFAULT_GLOBAL_SETTINGS,
        query: 'hi',
        lifeText: 'Her current fictional life state\n- Right now she is making coffee in the kitchen.'
    });
    assert.match(text.text, /making coffee/);
});

test('conversational initiative adds an offer instruction; passive does not', () => {
    const base = {
        character: { id: 'c', name: 'Maya' },
        settings: { personality: 'Warm.' }
    };
    const passive = companion.buildCompanionContext(Object.assign({}, base, {}));
    assert.ok(!/offer to share a photo/i.test(passive));
    const conversational = companion.buildCompanionContext(Object.assign({}, base, { initiative: 'conversational' }));
    assert.match(conversational, /offer to share a photo/i);
});

// Global + per-character behavior settings.
test('global companion settings sanitize the new behavior fields', () => {
    const sanitized = companion.sanitizeGlobalSettings({ initiative: 'nonsense', photoSharing: 'nonsense', quietHoursStart: 99, lifeIntervalMinutes: 1 });
    assert.equal(sanitized.initiative, 'passive');
    assert.equal(sanitized.photoSharing, 'ask');
    assert.equal(sanitized.quietHoursStart, 23);
    assert.equal(sanitized.lifeIntervalMinutes, 15);

    const behavior = companion.behaviorFor('char_behavior', { initiative: 'conversational', photoSharing: 'auto', lifeProgression: true }, sanitized);
    assert.equal(behavior.initiative, 'conversational');
    assert.equal(behavior.photoSharing, 'auto');
    assert.equal(behavior.lifeProgression, true);
});

test('per-character photo sharing overrides the global default', () => {
    const character = characterPresets.create({ name: 'Nova', identityText: 'A woman with silver hair.' });
    characterPresets.setCompanion(character.id, { photoSharing: 'auto' });
    const behavior = companion.behaviorFor(
        character.id,
        characterPresets.getCompanion(character.id),
        companion.DEFAULT_GLOBAL_SETTINGS
    );
    assert.equal(behavior.photoSharing, 'auto');
});

test('deleting a character clears its life state', () => {
    const character = characterPresets.create({ name: 'Temp', identityText: 'Anyone.' });
    characterLife.setLife(character.id, { activity: 'walking', location: 'the park' }, 'user');
    assert.ok(characterLife.getLife(character.id).activity);
    characterLife.clearRecord(character.id);
    assert.equal(characterLife.getLife(character.id).activity, '');
});
