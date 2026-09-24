/* ============================================
   JARVIS — Character Context tests
   Covers @mention parsing (only known characters,
   never emails), bare-name resolution, the
   per-conversation active character store
   (switch / inherit / explicit removal), the
   identity status surfaced to the picker, and the
   reference-guided conditioning built for a scene.
   State stores are pointed at temp files so nothing
   in data/ is touched.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-character-context-'));
process.env.PLAYGROUND_STATE_PATH = path.join(tmpDir, 'playground-state.json');
process.env.CHARACTER_PRESETS_PATH = path.join(tmpDir, 'character-presets.json');
process.env.CHARACTER_CONTEXT_PATH = path.join(tmpDir, 'character-context.json');

const identity = require('../services/character-identity');
const characterPresets = require('../services/character-presets');
const context = require('../services/character-context');

function makeCharacter(overrides = {}) {
    return characterPresets.create(Object.assign({
        name: 'Maya',
        identity: { age: '29-year-old', gender: 'woman', skinTone: 'medium golden skin', hairColor: 'dark brown' },
        identityText: 'a 29-year-old woman with long dark brown hair',
        identitySignature: 'sig-maya'
    }, overrides));
}

function readySheet(baseFilename = 'base.png') {
    return identity.normalizeSheet({
        status: identity.STATUS.READY,
        baseImage: { filename: baseFilename, url: '/generated/' + baseFilename, approved: true },
        identity: {
            status: identity.SHEET_STATUS.READY,
            references: {
                fullBody: [
                    { role: 'full_body_front', imagePath: 'fb_front.png', imageUrl: '/generated/fb_front.png' },
                    { role: 'full_body_three_quarter', imagePath: 'fb_34.png', imageUrl: '/generated/fb_34.png' }
                ],
                face: [
                    { role: 'face_front', imagePath: 'face_front.png', imageUrl: '/generated/face_front.png' }
                ],
                profile: [
                    { role: 'face_profile', imagePath: 'face_profile.png', imageUrl: '/generated/face_profile.png' }
                ],
                accessories: [],
                distinctiveFeatures: []
            }
        }
    });
}

test('@mentions resolve to known characters and are stripped from the prompt', () => {
    const maya = makeCharacter();
    const parsed = context.parseMentions('generate image: @Maya wearing a red dress in a cafe', [maya]);
    assert.equal(parsed.characters.length, 1);
    assert.equal(parsed.characters[0].id, maya.id);
    assert.equal(parsed.prompt, 'generate image: wearing a red dress in a cafe');
});

test('unknown @ mentions are left untouched', () => {
    makeCharacter();
    const parsed = context.parseMentions('generate image: @Nobody in a cafe');
    assert.equal(parsed.characters.length, 0);
    assert.equal(parsed.prompt, 'generate image: @Nobody in a cafe');
});

test('an email address is never treated as a mention or a bare name', () => {
    const maya = makeCharacter();
    const parsed = context.parseMentions('email me at maya@example.com', [maya]);
    assert.equal(parsed.characters.length, 0);
    assert.equal(parsed.prompt, 'email me at maya@example.com');
    assert.equal(context.matchNames('email me at maya@example.com', [maya]).length, 0);
});

test('multiple mentions resolve in order', () => {
    const maya = makeCharacter({ name: 'Maya' });
    const sarah = makeCharacter({ name: 'Sarah' });
    const parsed = context.parseMentions('generate video: @Maya and @Sarah talking in a cafe', [maya, sarah]);
    assert.deepEqual(parsed.characters.map((c) => c.name), ['Maya', 'Sarah']);
    assert.equal(parsed.prompt, 'generate video: and talking in a cafe');
});

test('a bare character name is recognised and not stripped from the prompt', () => {
    const maya = makeCharacter();
    const parsed = context.parseCharacterMessage('bring Maya back, wearing a black jacket', { characters: [maya] });
    assert.equal(parsed.characters.length, 1);
    assert.equal(parsed.characters[0].id, maya.id);
    assert.equal(parsed.prompt, 'bring Maya back, wearing a black jacket');
});

test('a name collision resolves the longest matching name only', () => {
    const maya = makeCharacter({ name: 'Maya' });
    const maya2 = makeCharacter({ name: 'Maya 2' });
    const bare = context.parseCharacterMessage('use Maya 2 in the scene', { characters: [maya, maya2] });
    assert.deepEqual(bare.characters.map((c) => c.name), ['Maya 2']);
    const mentioned = context.parseMentions('@Maya 2 walking', [maya, maya2]);
    assert.deepEqual(mentioned.characters.map((c) => c.name), ['Maya 2']);
});

test('an explicit mention switches the active character; a continuation inherits it', () => {
    const maya = makeCharacter({ name: 'Maya' });
    const conversationId = 'conv-switch';

    const first = context.resolveCharacterContext({
        message: 'generate video: @Maya walking through Tokyo',
        conversationId,
        action: 'new_task'
    });
    assert.deepEqual(first.characters.map((c) => c.name), ['Maya']);
    assert.equal(context.getActiveCharacter(conversationId).characters.length, 1);

    const followUp = context.resolveCharacterContext({
        message: 'generate another one where she stops and looks at the camera',
        conversationId,
        action: 'continue_task'
    });
    assert.deepEqual(followUp.characters.map((c) => c.name), ['Maya']);

    const landscape = context.resolveCharacterContext({
        message: 'generate image: a mountain landscape',
        conversationId,
        action: 'new_task'
    });
    assert.equal(landscape.characters.length, 0, 'a fresh characterless request does not inherit');
});

test('explicit removal clears the active character for the flow', () => {
    const maya = makeCharacter();
    const conversationId = 'conv-remove';
    context.resolveCharacterContext({ message: 'generate image: @Maya at a cafe', conversationId, action: 'new_task' });
    assert.equal(context.getActiveCharacter(conversationId).characters.length, 1);

    const removed = context.resolveCharacterContext({
        message: 'now generate a landscape of the same cafe without her',
        conversationId,
        action: 'new_task'
    });
    assert.equal(removed.characters.length, 0);
    assert.equal(removed.removed, true);
    assert.equal(context.getActiveCharacter(conversationId).characters.length, 0);
});

test('switching characters replaces the active one', () => {
    const maya = makeCharacter({ name: 'Maya' });
    const sarah = makeCharacter({ name: 'Sarah' });
    const conversationId = 'conv-swap';
    context.resolveCharacterContext({ message: 'generate image: @Maya sitting', conversationId, action: 'new_task' });
    const switched = context.resolveCharacterContext({
        message: 'use @Sarah instead',
        conversationId,
        action: 'new_task'
    });
    assert.deepEqual(switched.characters.map((c) => c.name), ['Sarah']);
    assert.deepEqual(context.getActiveCharacter(conversationId).characters.map((c) => c.name), ['Sarah']);
    assert.ok(sarah.id && maya.id);
});

test('the picker options carry the identity status and primary image', () => {
    const ready = makeCharacter({ name: 'Ready' });
    characterPresets.setIdentitySheet(ready.id, readySheet());
    const legacy = characterPresets.create({
        name: 'Legacy',
        identityText: 'a legacy character',
        portraitReference: { url: '/generated/portrait.png', filename: 'portrait.png' }
    });
    const options = context.listCharacterOptions();
    const readyOption = options.find((o) => o.id === ready.id);
    const legacyOption = options.find((o) => o.id === legacy.id);
    assert.equal(readyOption.identityStatus, context.IDENTITY_STATUS.READY);
    assert.equal(readyOption.hasIdentity, true);
    assert.equal(legacyOption.identityStatus, context.IDENTITY_STATUS.BASIC);
    assert.equal(legacyOption.hasIdentity, false);
});

test('conditioning selects scene-relevant references from the identity sheet', () => {
    const maya = makeCharacter();
    characterPresets.setIdentitySheet(maya.id, readySheet('maya_base.png'));

    const fullBody = context.buildConditioning([maya], 'a full-body fashion shot');
    assert.equal(fullBody.sourceFilename, 'maya_base.png');
    assert.ok(fullBody.referenceFilenames.includes('fb_front.png'));
    assert.ok(fullBody.referenceFilenames.includes('fb_34.png'));

    const portrait = context.buildConditioning([maya], 'a close-up portrait headshot');
    assert.equal(portrait.sourceFilename, 'maya_base.png');
    assert.ok(portrait.referenceFilenames.includes('face_front.png'));
    assert.match(portrait.instruction, /IDENTITY:/);
    assert.match(portrait.instruction, /SCENE \(change only this\):/);
});

test('a legacy character conditions through its portrait (basic reference)', () => {
    const legacy = characterPresets.create({
        name: 'Legacy Basic',
        identityText: 'a legacy character',
        portraitReference: { url: '/generated/portrait.png', filename: 'portrait.png' }
    });
    const conditioning = context.buildConditioning([legacy], 'standing in a park');
    assert.equal(conditioning.sourceFilename, 'portrait.png');
    assert.deepEqual(conditioning.referenceFilenames, []);
    assert.match(conditioning.instruction, /image 1/);
});

test('multiple characters contribute a combined conditioning', () => {
    const maya = makeCharacter({ name: 'Maya' });
    const sarah = makeCharacter({ name: 'Sarah' });
    characterPresets.setIdentitySheet(maya.id, readySheet('maya.png'));
    characterPresets.setIdentitySheet(sarah.id, readySheet('sarah.png'));
    const conditioning = context.buildConditioning([maya, sarah], 'talking in a cafe');
    assert.equal(conditioning.sourceFilename, 'maya.png');
    assert.ok(conditioning.referenceFilenames.includes('sarah.png'), 'the second base image is a reference');
    assert.match(conditioning.instruction, /image 1 is Maya/);
    assert.match(conditioning.instruction, /image 2 is Sarah/);
});

test('the active store survives a reload from disk', () => {
    const maya = makeCharacter({ name: 'Persist' });
    const conversationId = 'conv-persist';
    context.setActiveCharacter(conversationId, [{ id: maya.id, name: maya.name }]);
    // A fresh require would reload the JSON; here we assert the in-memory store
    // reflects the persisted payload.
    const raw = JSON.parse(fs.readFileSync(process.env.CHARACTER_CONTEXT_PATH, 'utf-8'));
    assert.equal(raw[conversationId].characters[0].id, maya.id);
    assert.deepEqual(context.getActiveCharacter(conversationId).characters.map((c) => c.id), [maya.id]);
});

test('deleted characters are dropped from the active store', () => {
    const temp = makeCharacter({ name: 'Temporary' });
    const conversationId = 'conv-delete';
    context.setActiveCharacter(conversationId, [{ id: temp.id, name: temp.name }]);
    characterPresets.remove(temp.id);
    assert.deepEqual(context.getActiveCharacter(conversationId).characters, []);
});
