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

function readyPackage(baseFilename = 'base.png', sheetFilename = 'sheet.png') {
    return identity.normalizePackage({
        approvedBaseImage: {
            filename: baseFilename,
            url: '/generated/' + baseFilename,
            approvedAt: new Date().toISOString()
        },
        identitySheet: {
            filename: sheetFilename,
            imageUrl: '/generated/' + sheetFilename,
            status: 'ready',
            version: 1
        }
    });
}

function basicPackage(baseFilename = 'base.png') {
    return identity.normalizePackage({
        approvedBaseImage: {
            filename: baseFilename,
            url: '/generated/' + baseFilename,
            approvedAt: new Date().toISOString()
        }
    });
}

test('the picker options carry the identity status and the single primary image', () => {
    const ready = makeCharacter({ name: 'Ready' });
    characterPresets.setIdentityPackage(ready.id, readyPackage('ready-base.png', 'ready-sheet.png'));
    const basic = makeCharacter({ name: 'Basic' });
    characterPresets.setIdentityPackage(basic.id, basicPackage('basic-base.png'));
    const none = makeCharacter({ name: 'None' });
    const options = context.listCharacterOptions();
    const readyOption = options.find((o) => o.id === ready.id);
    const basicOption = options.find((o) => o.id === basic.id);
    const noneOption = options.find((o) => o.id === none.id);
    assert.equal(readyOption.identityStatus, context.IDENTITY_STATUS.READY);
    assert.equal(readyOption.hasIdentity, true);
    assert.equal(readyOption.imageUrl, '/generated/ready-sheet.png');
    assert.equal(basicOption.identityStatus, context.IDENTITY_STATUS.BASIC);
    assert.equal(basicOption.hasIdentity, false);
    assert.equal(basicOption.imageUrl, '/generated/basic-base.png');
    assert.equal(noneOption.identityStatus, context.IDENTITY_STATUS.NONE);
});

test('one character contributes exactly ONE identity image', () => {
    const maya = makeCharacter();
    characterPresets.setIdentityPackage(maya.id, readyPackage('maya-base.png', 'maya-sheet.png'));
    const conditioning = context.buildConditioning([maya], 'a full-body fashion shot');
    assert.equal(conditioning.sourceFilename, 'maya-sheet.png', 'the consolidated sheet is the reference');
    assert.deepEqual(conditioning.referenceFilenames, [], 'no per-angle reference array');
    assert.match(conditioning.instruction, /IDENTITY:/);
    assert.match(conditioning.instruction, /SCENE \(change only this\):/);
});

test('a character without a sheet conditions through the approved base image', () => {
    const maya = makeCharacter();
    characterPresets.setIdentityPackage(maya.id, basicPackage('maya-base.png'));
    const conditioning = context.buildConditioning([maya], 'standing in a park');
    assert.equal(conditioning.sourceFilename, 'maya-base.png');
    assert.deepEqual(conditioning.referenceFilenames, []);
});

test('two characters contribute exactly two identity images', () => {
    const maya = makeCharacter({ name: 'Maya' });
    const quinn = makeCharacter({ name: 'Quinn' });
    characterPresets.setIdentityPackage(maya.id, readyPackage('maya-base.png', 'maya-sheet.png'));
    characterPresets.setIdentityPackage(quinn.id, readyPackage('quinn-base.png', 'quinn-sheet.png'));
    const conditioning = context.buildConditioning([maya, quinn], 'standing next to each other in front of a cafe');
    assert.equal(conditioning.sourceFilename, 'maya-sheet.png');
    assert.deepEqual(conditioning.referenceFilenames, ['quinn-sheet.png']);
    assert.match(conditioning.instruction, /CHARACTER 1/);
    assert.match(conditioning.instruction, /CHARACTER 2/);
    assert.match(conditioning.instruction, /CHARACTER SEPARATION/);
    assert.match(conditioning.instruction, /Do not merge, swap, or blend/);
    assert.match(conditioning.instruction, /ONE new standalone scene image/i);
    assert.match(conditioning.instruction, /Never return an identity sheet/i);
});

test('multi-character scenes keep each complexion while sharing the lighting', () => {
    const maya = makeCharacter({ name: 'Maya' });
    const quinn = makeCharacter({
        name: 'Quinn',
        identity: { age: '30-year-old', gender: 'man', skinTone: 'deep warm brown skin', hairColor: 'black' }
    });
    // Candidate + approve preserves the derived identity metadata (unlike a bare
    // identity package that carries only image fields).
    characterPresets.setCandidateBaseImage(maya.id, { url: '/generated/maya-base.png', filename: 'maya-base.png' });
    characterPresets.approveBaseImage(maya.id);
    characterPresets.setCandidateBaseImage(quinn.id, { url: '/generated/quinn-base.png', filename: 'quinn-base.png' });
    characterPresets.approveBaseImage(quinn.id);
    const conditioning = context.buildConditioning([maya, quinn], 'standing together at sunset');
    assert.match(conditioning.instruction, /SKIN-TONE CONTINUITY ACROSS CHARACTERS/);
    assert.match(conditioning.instruction, /do not normalise, swap, or blend/i);
    assert.match(conditioning.instruction, /Apply the scene's lighting to every character equally/i);
    assert.match(conditioning.instruction, /medium golden skin/);
    assert.match(conditioning.instruction, /deep warm brown skin/);
});

test('a single-character scene carries the body-wide skin continuity section', () => {
    const maya = makeCharacter();
    characterPresets.setIdentityPackage(maya.id, readyPackage('maya-base.png', 'maya-sheet.png'));
    const conditioning = context.buildConditioning([maya], 'standing outside in daylight');
    assert.match(conditioning.instruction, /CHARACTER SKIN-TONE CONTINUITY/);
    assert.match(conditioning.instruction, /one consistent underlying natural skin tone/i);
    assert.match(conditioning.instruction, /neck/i);
});

test('three characters contribute exactly three identity images', () => {
    const maya = makeCharacter({ name: 'Maya' });
    const quinn = makeCharacter({ name: 'Quinn' });
    const sarah = makeCharacter({ name: 'Sarah' });
    characterPresets.setIdentityPackage(maya.id, readyPackage('maya.png', 'maya-sheet.png'));
    characterPresets.setIdentityPackage(quinn.id, readyPackage('quinn.png', 'quinn-sheet.png'));
    characterPresets.setIdentityPackage(sarah.id, readyPackage('sarah.png', 'sarah-sheet.png'));
    const conditioning = context.buildConditioning([maya, quinn, sarah], 'at a party');
    const images = [conditioning.sourceFilename].concat(conditioning.referenceFilenames);
    assert.deepEqual(images, ['maya-sheet.png', 'quinn-sheet.png', 'sarah-sheet.png']);
});

test('user @image references ride along after the character identity images', () => {
    const maya = makeCharacter();
    characterPresets.setIdentityPackage(maya.id, readyPackage('maya-base.png', 'maya-sheet.png'));
    const conditioning = context.buildConditioning([maya], 'a close-up portrait');
    const combined = context.combineReferenceFilenames(conditioning, { userReferences: ['prop.png'] });
    assert.equal(combined.base, 'maya-sheet.png');
    assert.deepEqual(combined.references, ['prop.png']);
    assert.deepEqual(combined.userIndexes, [1]);
});

test('an @image that is already the character identity image is not duplicated', () => {
    const maya = makeCharacter();
    characterPresets.setIdentityPackage(maya.id, readyPackage('maya-base.png', 'maya-sheet.png'));
    const conditioning = context.buildConditioning([maya], 'a scene');
    const combined = context.combineReferenceFilenames(conditioning, { userReferences: ['maya-sheet.png', 'prop.png'] });
    assert.deepEqual(combined.references, ['prop.png']);
    assert.deepEqual(combined.userIndexes, [1]);
});

test('characterMediaFilenames covers the approved base and the identity sheet', () => {
    const maya = makeCharacter({ name: 'Maya' });
    characterPresets.setIdentityPackage(maya.id, readyPackage('maya-base.png', 'maya-sheet.png'));
    const media = context.characterMediaFilenames();
    assert.ok(media.has('maya-base.png'), 'approved base protected');
    assert.ok(media.has('maya-sheet.png'), 'identity sheet protected');
});

test('a conversation delete must not remove character-owned media', () => {
    const maya = makeCharacter({ name: 'Maya' });
    characterPresets.setIdentityPackage(maya.id, readyPackage('maya-base.png', 'maya-sheet.png'));
    const protectedNames = context.characterMediaFilenames();
    const entries = ['maya-base.png', 'maya-sheet.png', 'chat_image.png'];
    const toDelete = entries.filter((name) => !protectedNames.has(name));
    assert.deepEqual(toDelete, ['chat_image.png']);
});

test('getCharactersForGeneration returns the structured single-image package', () => {
    const maya = makeCharacter();
    characterPresets.setIdentityPackage(maya.id, readyPackage('maya-base.png', 'maya-sheet.png'));
    const [entry] = context.getCharactersForGeneration([maya]);
    assert.equal(entry.id, maya.id);
    assert.equal(entry.approvedBaseImage, 'maya-base.png');
    assert.equal(entry.identitySheetImage, 'maya-sheet.png');
    assert.equal(entry.identityImage, 'maya-sheet.png');
    assert.ok(entry.identityMetadata);
    assert.match(entry.identityPreservationInstructions, /facial identity/i);
});

test('the spec-facing aliases resolve mentions and identity context', () => {
    const maya = makeCharacter();
    characterPresets.setIdentityPackage(maya.id, readyPackage('maya-base.png', 'maya-sheet.png'));
    const mentions = context.resolveCharacterMentions('@Maya in a cafe', { characters: [maya] });
    assert.equal(mentions.characters[0].id, maya.id);
    assert.equal(context.getCharacter(maya.id).name, 'Maya');
    assert.equal(context.getCharacterIdentity(maya.id).identitySheet.filename, 'maya-sheet.png');
    const built = context.buildCharacterIdentityContext([maya], 'in a cafe');
    assert.equal(built.sourceFilename, 'maya-sheet.png');
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
