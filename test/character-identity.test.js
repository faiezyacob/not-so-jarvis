/* ============================================
   JARVIS — Character Identity System tests
   Covers the identity package lifecycle (candidate
   -> approved -> ready), the deterministic reference
   plan (full body + face + conditional details), the
   reference selection for generation, the
   prompt-layer identity/scene separation, partial
   failure handling, regeneration safety, legacy
   characters and the preset persistence. The state
   stores are pointed at temp files so nothing in
   data/ is touched.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-character-identity-'));
process.env.PLAYGROUND_STATE_PATH = path.join(tmpDir, 'playground-state.json');
process.env.CHARACTER_PRESETS_PATH = path.join(tmpDir, 'character-presets.json');

const identity = require('../services/character-identity');
const characterPresets = require('../services/character-presets');
const playground = require('../services/playground/playground');

function makeCharacter(overrides = {}) {
    const identityRecord = {
        seed: 123,
        age: '29-year-old',
        ageGroup: 'adult',
        gender: 'woman',
        presentation: 'woman',
        appearanceCategory: 'mixed_diverse',
        skinTone: 'medium golden skin',
        skin: { tone: 'medium golden skin', group: 'medium' },
        face: { shape: 'an oval face' },
        faceShape: 'an oval face',
        eyes: { color: 'hazel', shape: 'almond-shaped eyes' },
        eyeColor: 'hazel',
        eyeShape: 'almond-shaped eyes',
        eyebrows: 'softly arched eyebrows',
        hairColor: 'dark brown',
        hairTexture: 'wavy',
        hairStyle: 'long',
        hairStyleType: 'adj',
        hair: { color: 'dark brown', texture: 'wavy', style: 'long', styleType: 'adj' },
        build: 'a slim build',
        distinctiveFeature: 'a small beauty mark beneath one eye'
    };
    return Object.assign({
        id: 'char_test',
        name: 'Maya',
        identity: identityRecord,
        identityText: 'a 29-year-old woman with medium golden skin, an oval face, hazel almond-shaped eyes, long wavy dark brown hair',
        identitySignature: 'sig-123',
        appearanceCategory: 'mixed_diverse',
        portraitReference: { url: '/generated/portrait.png', filename: 'portrait.png', width: 256, height: 256 }
    }, overrides);
}

// A deterministic fake generator: every call succeeds with a stable filename.
function fakeGenerate(_source, instruction, options) {
    const calls = fakeGenerate.calls;
    calls.push({ instruction, references: (options && options.references) || [] });
    return {
        url: '/generated/ref_' + calls.length + '.png',
        filename: 'ref_' + calls.length + '.png',
        width: 1024,
        height: 1024
    };
}
fakeGenerate.calls = [];

function resetCalls() { fakeGenerate.calls = []; }

test('the reference plan always includes full-body and face views', () => {
    const character = makeCharacter();
    const plan = identity.planReferences(character);
    const roles = plan.map((e) => e.role);
    for (const role of ['full_body_front', 'full_body_three_quarter', 'full_body_side', 'full_body_back',
        'face_front', 'face_three_quarter', 'face_profile']) {
        assert.ok(roles.includes(role), 'missing required role ' + role);
    }
});

test('the reference plan is deterministic for the same character', () => {
    const character = makeCharacter();
    assert.deepEqual(identity.planReferences(character), identity.planReferences(character));
});

test('a plain character never adds accessory references', () => {
    const character = makeCharacter({
        identity: Object.assign({}, makeCharacter().identity, { distinctiveFeature: '', distinctiveFeatures: [] })
    });
    const roles = identity.planReferences(character).map((e) => e.role);
    assert.ok(!roles.includes('accessory_detail'));
    assert.ok(!roles.includes('distinctive_feature_detail'));
});

test('a character with glasses and a tattoo adds conditional references', () => {
    const character = makeCharacter({
        identity: Object.assign({}, makeCharacter().identity, {
            distinctiveFeature: 'wears round glasses and has a small tattoo on the wrist'
        })
    });
    const roles = identity.planReferences(character).map((e) => e.role);
    assert.ok(roles.includes('accessory_detail'), 'expected accessory_detail for glasses');
    assert.ok(roles.includes('distinctive_feature_detail'), 'expected a distinctive-feature detail');
});

test('identity metadata is derived from the structured identity', () => {
    const meta = identity.deriveMetadata(makeCharacter().identity);
    assert.equal(meta.ageRange, '29-year-old');
    assert.equal(meta.genderPresentation, 'woman');
    assert.equal(meta.skinTone, 'medium golden skin');
    assert.equal(meta.eyeColor, 'hazel');
    assert.equal(meta.hair.color, 'dark brown');
    assert.equal(meta.hair.style, 'long');
    assert.equal(meta.bodyProportions, 'a slim build');
    assert.deepEqual(meta.distinctiveFeatures, ['a small beauty mark beneath one eye']);
});

test('a candidate sheet starts unapproved with no references', () => {
    const sheet = identity.createSheet({
        baseImage: { url: '/generated/base.png', filename: 'base.png' },
        character: makeCharacter()
    });
    assert.equal(sheet.status, identity.STATUS.CANDIDATE);
    assert.equal(sheet.baseImage.approved, false);
    assert.equal(sheet.identity.status, identity.SHEET_STATUS.NOT_STARTED);
    assert.equal(identity.allReferences(sheet).length, 0);
});

test('generateSheet only produces references when a base image exists', async () => {
    resetCalls();
    const character = makeCharacter();
    const sheet = identity.createSheet({ baseImage: {}, character });
    const result = await identity.generateSheet({
        character,
        sheet,
        generate: fakeGenerate,
        resolveAbs: (n) => n
    });
    assert.equal(result.status, identity.STATUS.FAILED);
    assert.equal(fakeGenerate.calls.length, 0, 'must not generate without a base image');
});

test('approve + generateSheet produces a ready package with role-tagged references', async () => {
    resetCalls();
    const character = makeCharacter();
    let sheet = identity.createSheet({
        baseImage: { url: '/generated/base.png', filename: 'base.png' },
        character
    });
    sheet = identity.applyBaseImage(sheet, {}, { approved: true });
    const result = await identity.generateSheet({
        character,
        sheet,
        generate: fakeGenerate,
        resolveAbs: (n) => n
    });
    assert.equal(result.status, identity.STATUS.READY);
    assert.equal(result.identity.status, identity.SHEET_STATUS.READY);
    const roles = identity.allReferences(result).map((r) => r.role);
    assert.ok(roles.includes('full_body_front'));
    assert.ok(roles.includes('face_front'));
    assert.ok(roles.includes('face_profile'));
    // Every reference carries role metadata and points at the approved base.
    for (const ref of identity.allReferences(result)) {
        assert.ok(ref.imagePath, 'reference has an image path');
        assert.ok(ref.imageUrl.startsWith('/generated/'), 'reference has a public url');
        assert.ok(ref.imagePath !== 'base.png');
        assert.equal(ref.sourceBaseImage, 'base.png');
    }
});

test('later views are conditioned on the earlier ones (image references)', async () => {
    resetCalls();
    const character = makeCharacter();
    let sheet = identity.createSheet({
        baseImage: { url: '/generated/base.png', filename: 'base.png' },
        character
    });
    sheet = identity.applyBaseImage(sheet, {}, { approved: true });
    await identity.generateSheet({ character, sheet, generate: fakeGenerate, resolveAbs: (n) => n });
    const threeQuarter = fakeGenerate.calls.find((c) => /full-body three-quarter view/.test(c.instruction));
    assert.ok(threeQuarter, 'three-quarter call exists');
    assert.ok(threeQuarter.references.includes('ref_1.png'), 'depends on the front view');
});

test('a partial failure is recorded and does not discard successful references', async () => {
    const character = makeCharacter();
    let sheet = identity.createSheet({
        baseImage: { url: '/generated/base.png', filename: 'base.png' },
        character
    });
    sheet = identity.applyBaseImage(sheet, {}, { approved: true });
    let n = 0;
    const flaky = () => {
        n += 1;
        if (n === 1) return { url: '/generated/ok_1.png', filename: 'ok_1.png' };
        if (n === 3) throw new Error('ComfyUI OOM');
        return { url: '/generated/ok_' + n + '.png', filename: 'ok_' + n + '.png' };
    };
    const result = await identity.generateSheet({
        character,
        sheet,
        generate: flaky,
        resolveAbs: (x) => x,
        logger: { warn: () => {} }
    });
    // The failed reference leaves the sheet not-ready, but the successes remain.
    assert.equal(result.status, identity.STATUS.FAILED);
    assert.ok(identity.allReferences(result).length >= 5, 'successful references were kept');
    assert.ok(result.identity.consistencyNotes.some((note) => /Could not generate/.test(note)));
});

test('regeneration keeps the previous working references when the new sheet fails', async () => {
    resetCalls();
    const character = makeCharacter();
    let sheet = identity.createSheet({
        baseImage: { url: '/generated/base.png', filename: 'base.png' },
        character
    });
    sheet = identity.applyBaseImage(sheet, {}, { approved: true });
    const previous = await identity.generateSheet({ character, sheet, generate: fakeGenerate, resolveAbs: (n) => n });
    assert.equal(previous.status, identity.STATUS.READY);
    // Every call now fails.
    const failing = () => { throw new Error('ComfyUI unavailable'); };
    const result = await identity.generateSheet({
        character,
        sheet: identity.markGenerating(previous, { plan: identity.planReferences(character) }),
        previousSheet: previous,
        generate: failing,
        resolveAbs: (n) => n,
        logger: { warn: () => {} }
    });
    // The previous package's references are restored and it stays ready.
    assert.equal(result.status, identity.STATUS.READY);
    assert.ok(identity.allReferences(result).length >= 7);
});

test('reference selection picks views relevant to the request', () => {
    const character = makeCharacter();
    const refs = identity.normalizeSheet({
        baseImage: { filename: 'base.png', approved: true },
        identity: { references: {
            fullBody: [{ role: 'full_body_front', imagePath: 'fb_front.png' }, { role: 'full_body_three_quarter', imagePath: 'fb_34.png' }],
            face: [{ role: 'face_front', imagePath: 'face_front.png' }],
            profile: [{ role: 'face_profile', imagePath: 'face_profile.png' }],
            accessories: [],
            distinctiveFeatures: []
        } }
    });
    const portrait = identity.selectReferencesForRequest(refs, { kind: 'portrait' });
    assert.equal(portrait.source, 'base.png');
    assert.deepEqual(portrait.references, ['face_front.png']);

    const fullBody = identity.selectReferencesForRequest(refs, { kind: 'full_body' });
    assert.deepEqual(fullBody.references, ['fb_front.png', 'fb_34.png']);

    const profile = identity.selectReferencesForRequest(refs, { kind: 'profile' });
    assert.ok(profile.references.includes('face_profile.png'));
});

test('request wording infers a reference kind', () => {
    assert.equal(identity.inferRequestKind({ text: 'a full-body fashion photo' }), 'full_body');
    assert.equal(identity.inferRequestKind({ text: 'a close-up portrait, headshot' }), 'portrait');
    assert.equal(identity.inferRequestKind({ text: 'wearing her signature earrings' }), 'accessory');
});

test('the scene edit instruction separates identity from changeable scene', () => {
    const character = makeCharacter();
    const sheet = identity.createSheet({
        baseImage: { url: '/generated/base.png', filename: 'base.png' },
        character
    });
    const instruction = identity.buildSceneEditInstruction(sheet, 'a bedroom mirror selfie in a white tank top');
    assert.match(instruction, /IDENTITY:/);
    assert.match(instruction, /SCENE \(change only this\):/);
    assert.match(instruction, /DO NOT:/);
    assert.match(instruction, /bedroom mirror selfie/);
    // Outfit/environment belong to the scene; identity instructions stay identity-only.
    const identityPart = instruction.slice(0, instruction.indexOf('SCENE'));
    assert.ok(!/tank top|bedroom/i.test(identityPart), 'the identity clause must not carry the scene');
});

test('identity is never lost when only the outfit/environment changes', () => {
    const character = makeCharacter();
    const sheet = identity.createSheet({
        baseImage: { url: '/generated/base.png', filename: 'base.png' },
        character
    });
    const constraints = identity.buildIdentityConstraints(sheet);
    const all = constraints.join(' ');
    assert.match(all, /facial identity/i);
    assert.match(all, /hairstyle/i);
    assert.ok(!/tank top|bedroom/i.test(all), 'identity constraints must not name a scene');
});

test('creating an identity from the card preview uses it as the approved base', () => {
    // The card already shows a character preview; creating an identity must
    // lock that preview as the approved base and go straight to the sheet,
    // with no separate candidate base-image generation.
    const character = makeCharacter({ identitySheet: null });
    const preview = { url: '/generated/preview.png', filename: 'preview.png', width: 256, height: 256, seed: 7 };
    let sheet = identity.createSheet({ baseImage: preview, character });
    sheet = identity.applyBaseImage(sheet, {}, { approved: true });
    sheet.status = identity.STATUS.APPROVED;
    assert.equal(sheet.baseImage.filename, 'preview.png');
    assert.equal(sheet.baseImage.approved, true);
    assert.equal(sheet.baseImage.approvedAt !== undefined, true);
    // A candidate sheet never generates; the approved one is what the sheet step consumes.
    assert.equal(sheet.status, identity.STATUS.APPROVED);
});

test('a legacy character with only a portrait can build a base image', () => {
    const character = makeCharacter({ identitySheet: null });
    const sheet = characterPresets.getIdentitySheet(character.id);
    assert.equal(sheet, null);
    const base = identity.effectiveBaseImage(character, null);
    assert.equal(base.filename, 'portrait.png');
    assert.equal(identity.hasLegacyBase(character, null), true);
});

test('the preset store round-trips the identity sheet', () => {
    const character = characterPresets.create({
        name: 'Identity Roundtrip',
        identityText: 'a person',
        identity: makeCharacter().identity,
        provenance: { type: 'generated' }
    });
    assert.equal(characterPresets.getIdentitySheet(character.id), null);
    let sheet = identity.createSheet({
        baseImage: { url: '/generated/base.png', filename: 'base.png' },
        character
    });
    sheet = identity.applyBaseImage(sheet, {}, { approved: true });
    characterPresets.setIdentitySheet(character.id, sheet);

    const reloaded = characterPresets.get(character.id);
    assert.ok(reloaded.identitySheet, 'identitySheet persisted');
    const stored = characterPresets.getIdentitySheet(character.id);
    assert.equal(stored.baseImage.filename, 'base.png');
    assert.equal(stored.baseImage.approved, true);

    characterPresets.clearIdentitySheet(character.id);
    assert.equal(characterPresets.getIdentitySheet(character.id), null);
    assert.equal(characterPresets.remove(character.id), true);
});

test('buildCard exposes the identity state without leaking paths', () => {
    const character = makeCharacter();
    let sheet = identity.createSheet({
        baseImage: { url: '/generated/base.png', filename: 'base.png' },
        character
    });
    sheet = identity.applyBaseImage(sheet, {}, { approved: true });
    sheet = identity.recordReference(sheet, 'face_front', identity.CATEGORY.FACE, {
        role: 'face_front', label: 'Face — front', imageUrl: '/generated/f.png', imagePath: 'f.png'
    });
    const card = identity.buildCard(character, sheet);
    assert.equal(card.name, 'Maya');
    assert.equal(card.baseImage.url, '/generated/base.png');
    assert.equal(card.categories.face.length, 1);
    assert.equal(card.referenceCount, 1);
    assert.ok(!JSON.stringify(card).includes('tmp'), 'card must not leak absolute paths');
    assert.equal(card.metadata.eyeColor, 'hazel');
});

test('playground concept cards carry an identity summary for a saved character', () => {
    const character = characterPresets.create({
        name: 'Card Character',
        identityText: 'a person',
        identity: makeCharacter().identity,
        provenance: { type: 'generated' }
    });
    const sheet = identity.createSheet({
        baseImage: { url: '/generated/base.png', filename: 'base.png' },
        character
    });
    characterPresets.setIdentitySheet(character.id, sheet);

    const session = playground.start({
        conversationId: 'identity-card-' + Date.now(),
        themeId: 'lifestyle-candid',
        characterId: character.id,
        mode: 'character'
    });
    const stored = playground.getSession(session.conversationId);
    const card = playground.buildCard(stored, characterPresets.get(character.id));
    assert.ok(card.identity, 'identity summary present');
    assert.equal(card.identity.characterId, character.id);
    assert.equal(card.identity.status, identity.STATUS.CANDIDATE);
    characterPresets.remove(character.id);
});
