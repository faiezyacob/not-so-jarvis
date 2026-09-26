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
    assert.equal(readyOption.imageUrl, '/generated/ready-base.png');
    assert.equal(basicOption.identityStatus, context.IDENTITY_STATUS.BASIC);
    assert.equal(basicOption.hasIdentity, false);
    assert.equal(basicOption.imageUrl, '/generated/basic-base.png');
    assert.equal(noneOption.identityStatus, context.IDENTITY_STATUS.NONE);
});

test('one character leads with the approved portrait and never sends the sheet to generation', () => {
    const maya = makeCharacter();
    characterPresets.setIdentityPackage(maya.id, readyPackage('maya-base.png', 'maya-sheet.png'));
    const conditioning = context.buildConditioning([maya], 'a full-body fashion shot');
    assert.equal(conditioning.sourceFilename, 'maya-base.png', 'the single approved portrait leads');
    assert.deepEqual(conditioning.sheetFilenames, [], 'the multi-angle sheet is display-only');
    assert.deepEqual(conditioning.referenceFilenames, [], 'no per-angle reference array');
    assert.match(conditioning.instruction, /IDENTITY:/);
    assert.match(conditioning.instruction, /SCENE \(change only this\):/);
    assert.doesNotMatch(conditioning.instruction, /identity sheet/i);
});

test('a character without a sheet conditions through the approved base image', () => {
    const maya = makeCharacter();
    characterPresets.setIdentityPackage(maya.id, basicPackage('maya-base.png'));
    const conditioning = context.buildConditioning([maya], 'standing in a park');
    assert.equal(conditioning.sourceFilename, 'maya-base.png');
    assert.deepEqual(conditioning.referenceFilenames, []);
    assert.deepEqual(conditioning.sheetFilenames, []);
});

test('two characters contribute only their two approved portraits', () => {
    const maya = makeCharacter({ name: 'Maya' });
    const quinn = makeCharacter({ name: 'Quinn' });
    characterPresets.setIdentityPackage(maya.id, readyPackage('maya-base.png', 'maya-sheet.png'));
    characterPresets.setIdentityPackage(quinn.id, readyPackage('quinn-base.png', 'quinn-sheet.png'));
    const conditioning = context.buildConditioning([maya, quinn], 'standing next to each other in front of a cafe');
    assert.equal(conditioning.sourceFilename, 'maya-base.png');
    assert.deepEqual(conditioning.referenceFilenames, ['quinn-base.png']);
    assert.deepEqual(conditioning.sheetFilenames, []);
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

test('three characters contribute exactly three portraits and no sheets', () => {
    const maya = makeCharacter({ name: 'Maya' });
    const quinn = makeCharacter({ name: 'Quinn' });
    const sarah = makeCharacter({ name: 'Sarah' });
    characterPresets.setIdentityPackage(maya.id, readyPackage('maya.png', 'maya-sheet.png'));
    characterPresets.setIdentityPackage(quinn.id, readyPackage('quinn.png', 'quinn-sheet.png'));
    characterPresets.setIdentityPackage(sarah.id, readyPackage('sarah.png', 'sarah-sheet.png'));
    const conditioning = context.buildConditioning([maya, quinn, sarah], 'at a party');
    const portraits = [conditioning.sourceFilename].concat(conditioning.referenceFilenames);
    assert.deepEqual(portraits, ['maya.png', 'quinn.png', 'sarah.png']);
    assert.deepEqual(conditioning.sheetFilenames, []);
});

test('user @image references ride along after character portraits without sheets', () => {
    const maya = makeCharacter();
    characterPresets.setIdentityPackage(maya.id, readyPackage('maya-base.png', 'maya-sheet.png'));
    const conditioning = context.buildConditioning([maya], 'a close-up portrait');
    const combined = context.combineReferenceFilenames(conditioning, { userReferences: ['prop.png'] });
    assert.equal(combined.base, 'maya-base.png');
    assert.deepEqual(combined.references, ['prop.png']);
    assert.deepEqual(combined.userIndexes, [1]);
});

test('still and video conditioning both omit the multi-panel sheet', () => {
    const maya = makeCharacter();
    characterPresets.setIdentityPackage(maya.id, readyPackage('maya-base.png', 'maya-sheet.png'));
    const conditioning = context.buildConditioning([maya], 'walking down the street');
    conditioning.sheetFilenames = ['maya-sheet.png'];
    const combined = context.combineReferenceFilenames(conditioning);
    assert.equal(combined.base, 'maya-base.png');
    assert.deepEqual(combined.references, [], 'a sheet can bleed its layout into generated media');
});

test('an @image that is already the character portrait is not duplicated', () => {
    const maya = makeCharacter();
    characterPresets.setIdentityPackage(maya.id, readyPackage('maya-base.png', 'maya-sheet.png'));
    const conditioning = context.buildConditioning([maya], 'a scene');
    const combined = context.combineReferenceFilenames(conditioning, { userReferences: ['maya-base.png', 'prop.png'] });
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
    assert.equal(entry.identitySheetImage, '');
    assert.equal(entry.identityImage, 'maya-base.png', 'the approved portrait is the primary image');
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
    assert.equal(built.sourceFilename, 'maya-base.png');
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

// --- Multi-character identity mode -------------------------------------------

// Two approved characters whose structured identity metadata survives (via
// candidate + approve), so skin descriptors and summaries are real.
function makeApproved(name, identity) {
    const character = makeCharacter({ name, identity });
    characterPresets.setCandidateBaseImage(character.id, {
        url: '/generated/' + name.toLowerCase() + '-base.png',
        filename: name.toLowerCase() + '-base.png'
    });
    characterPresets.approveBaseImage(character.id);
    return character.id;
}

function scenePair(rawPrompt, scenePrompt) {
    const jules = characterPresets.get(makeApproved('Jules', {
        age: '28-year-old', gender: 'woman', skinTone: 'medium golden skin', hairColor: 'dark brown'
    }));
    const quinn = characterPresets.get(makeApproved('Quinn', {
        age: '31-year-old', gender: 'man', skinTone: 'deep warm brown skin', hairColor: 'black'
    }));
    const conditioning = context.buildConditioning([jules, quinn], scenePrompt || rawPrompt.replace(/@/g, ''), {
        rawPrompt
    });
    return { jules, quinn, conditioning };
}

test('multi-character mode: each reference maps to exactly one named character', () => {
    const { conditioning } = scenePair('@Jules and @Quinn standing next to each other in front of a cafe');
    assert.equal(conditioning.multiCharacter.count, 2);
    assert.deepEqual(conditioning.multiCharacter.names, ['Jules', 'Quinn']);
    assert.match(conditioning.instruction, /CHARACTER IDENTITY/);
    assert.match(conditioning.instruction, /CHARACTER 1 \u2014 JULES/);
    assert.match(conditioning.instruction, /CHARACTER 2 \u2014 QUINN/);
    assert.match(conditioning.instruction, /Reference image 1 is Jules's identity reference\./);
    assert.match(conditioning.instruction, /Reference image 2 is Quinn's identity reference\./);
    assert.match(conditioning.instruction, /REFERENCE IMAGE ROLES/);
    assert.match(conditioning.instruction, /Reference image 1 = Jules only\./);
    assert.match(conditioning.instruction, /Reference image 2 = Quinn only\./);
    assert.match(conditioning.instruction, /Preserve Jules's facial identity/);
    assert.doesNotMatch(conditioning.instruction, /preserve their/i, 'never use an ambiguous "their" for one identity');
});

test('multi-character mode isolates attributes and forbids cross-assignment', () => {
    const { conditioning } = scenePair('@Jules and @Quinn standing together');
    assert.match(conditioning.instruction, /CHARACTER ATTRIBUTE ISOLATION/);
    assert.match(conditioning.instruction, /never be transferred to another character/i);
    for (const attribute of ['face shape', 'eyes', 'nose', 'mouth', 'facial structure', 'freckles and marks',
        'hair colour', 'hairstyle', 'skin tone', 'skin undertone', 'body proportions', 'body build', 'complexion']) {
        assert.match(conditioning.instruction, new RegExp(attribute, 'i'), 'protects ' + attribute);
    }
    assert.match(conditioning.instruction, /CHARACTER SEPARATION/);
    assert.match(conditioning.instruction, /Do not merge, swap, or blend/);
    assert.match(conditioning.instruction, /cross-assign one character's attributes to another/i);
});

test('multi-character mode assigns explicit actions to named characters', () => {
    const { conditioning } = scenePair('@Jules and @Quinn standing next to each other');
    assert.match(conditioning.instruction,
        /CHARACTER-SPECIFIC ACTIONS \/ POSITIONS\nJules and Quinn standing next to each other/);
});

test('multi-character mode keeps explicit action ownership verbatim', () => {
    const { conditioning } = scenePair('@Jules taking a selfie with @Quinn');
    assert.match(conditioning.instruction, /Jules taking a selfie with Quinn/);
});

test('multi-character mode resolves a pronoun with a named antecedent', () => {
    const { conditioning } = scenePair('@Jules is sitting on the bed with @Quinn beside her');
    assert.match(conditioning.instruction, /beside Jules/);
    assert.doesNotMatch(conditioning.instruction, /beside her/);
});

test('multi-character complex pose resolves the trailing pronoun to the subject', () => {
    const { conditioning } = scenePair('@Jules lying on the bed taking a selfie while @Quinn lies beside her');
    assert.match(conditioning.instruction, /beside Jules/);
});

test('multi-character clothing changes preserve character names', () => {
    const { conditioning } = scenePair(
        '@Jules and @Quinn standing together, Jules wearing a white shirt and Quinn wearing a black jacket');
    assert.match(conditioning.instruction, /Jules wearing a white shirt/);
    assert.match(conditioning.instruction, /Quinn wearing a black jacket/);
});

test('multi-character environment changes preserve character names', () => {
    const { conditioning } = scenePair('@Jules and @Quinn walking through a rainy city street');
    assert.match(conditioning.instruction, /Jules and Quinn walking through a rainy city street/);
});

test('multi-character mode: scene styling cannot overwrite identity', () => {
    const { conditioning } = scenePair('@Jules and @Quinn under colorful nightclub lighting');
    assert.match(conditioning.instruction, /colorful nightclub lighting/);
    assert.match(conditioning.instruction, /SKIN-TONE CONTINUITY ACROSS CHARACTERS/);
    assert.match(conditioning.instruction, /Jules retains Jules's natural complexion/);
    assert.match(conditioning.instruction, /Quinn retains Quinn's natural complexion/);
    assert.match(conditioning.instruction, /do not normalise, swap, or blend/i);
    assert.match(conditioning.instruction, /medium golden skin/);
    assert.match(conditioning.instruction, /deep warm brown skin/);
});

test('multi-character instruction follows the identity priority order', () => {
    const { conditioning } = scenePair('@Jules and @Quinn sitting together in warm bedroom lighting');
    const order = [
        conditioning.instruction.indexOf('CHARACTER IDENTITY'),
        conditioning.instruction.indexOf('CHARACTER ATTRIBUTE ISOLATION'),
        conditioning.instruction.indexOf('CHARACTER SEPARATION'),
        conditioning.instruction.indexOf('REFERENCE IMAGE ROLES'),
        conditioning.instruction.indexOf('\nSCENE\n'),
        conditioning.instruction.indexOf('CHARACTER-SPECIFIC ACTIONS / POSITIONS'),
        conditioning.instruction.indexOf('SKIN-TONE CONTINUITY ACROSS CHARACTERS'),
        conditioning.instruction.indexOf('OUTPUT CONSTRAINT')
    ];
    order.forEach((index, i) => {
        assert.ok(index >= 0, 'section ' + i + ' present');
        if (i > 0) assert.ok(index > order[i - 1], 'section ' + i + ' follows section ' + (i - 1));
    });
});

test('three characters each map to their own reference', () => {
    const jules = characterPresets.get(makeApproved('Jules', { gender: 'woman', skinTone: 'medium golden skin' }));
    const quinn = characterPresets.get(makeApproved('Quinn', { gender: 'man', skinTone: 'deep warm brown skin' }));
    const maya = characterPresets.get(makeApproved('Maya', { gender: 'woman', skinTone: 'olive skin' }));
    const conditioning = context.buildConditioning([jules, quinn, maya], 'standing together', {
        rawPrompt: '@Jules, @Quinn and @Maya standing together'
    });
    assert.equal(conditioning.multiCharacter.count, 3);
    assert.match(conditioning.instruction, /CHARACTER 3 \u2014 MAYA/);
    assert.match(conditioning.instruction, /Reference image 3 = Maya only\./);
    assert.match(conditioning.instruction, /three distinct individuals/);
    assert.match(conditioning.instruction,
        /CHARACTER-SPECIFIC ACTIONS \/ POSITIONS\nJules, Quinn and Maya standing together/);
});

test('an ambiguous multi-character scene is preserved, not guessed at', () => {
    const { conditioning } = scenePair('two people standing next to each other', 'two people standing next to each other');
    assert.doesNotMatch(conditioning.instruction, /CHARACTER-SPECIFIC ACTIONS/);
    // The scene wording survives untouched.
    assert.match(conditioning.instruction, /SCENE\ntwo people standing next to each other/);
});

test('single-character generation is unchanged by the multi-character mode', () => {
    const jules = characterPresets.get(makeApproved('Jules', { gender: 'woman', skinTone: 'medium golden skin' }));
    const conditioning = context.buildConditioning([jules], 'sitting in a cafe', { rawPrompt: '@Jules sitting in a cafe' });
    assert.equal(conditioning.multiCharacter, null);
    assert.match(conditioning.instruction, /IDENTITY:/);
    assert.match(conditioning.instruction, /SCENE \(change only this\):/);
    assert.doesNotMatch(conditioning.instruction, /CHARACTER ATTRIBUTE ISOLATION/);
    assert.doesNotMatch(conditioning.instruction, /CHARACTER-SPECIFIC ACTIONS/);
});
