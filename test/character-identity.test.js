/* ============================================
   JARVIS — Character Identity System tests
   Covers the single-sheet identity package
   lifecycle (candidate -> approved -> ready), the
   structured metadata, the consolidated sheet
   prompt, regeneration safety, the preset
   persistence and the UI card. The state stores are
   pointed at temp files so nothing in data/ is
   touched.
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
        approvedBaseImage: {
            url: '/generated/base.png',
            filename: 'base.png',
            width: 1024,
            height: 1024,
            approvedAt: new Date().toISOString()
        }
    }, overrides);
}

// A deterministic fake generator: every call succeeds with a stable filename.
function fakeGenerate(_source, instruction, options) {
    const calls = fakeGenerate.calls;
    calls.push({ source: _source, instruction, references: (options && options.references) || [] });
    return {
        url: '/generated/identity_sheet.png',
        filename: 'identity_sheet.png',
        width: 1024,
        height: 1024
    };
}
fakeGenerate.calls = [];

function resetCalls() { fakeGenerate.calls = []; }

test('identity metadata is derived from the structured identity', () => {
    const meta = identity.deriveMetadata(makeCharacter());
    assert.equal(meta.face.shape, 'an oval face');
    assert.equal(meta.face.eyes, 'hazel almond-shaped eyes');
    assert.equal(meta.hair.color, 'dark brown');
    assert.equal(meta.hair.style, 'long');
    assert.equal(meta.hair.texture, 'wavy');
    assert.equal(meta.skin.tone, 'medium golden skin');
    assert.equal(meta.body.build, 'a slim build');
    assert.deepEqual(meta.distinctiveFeatures, ['a small beauty mark beneath one eye']);
    assert.match(meta.identityPreservationInstructions, /facial identity/i);
});

test('skin metadata is structured with a base tone, undertone and complexion', () => {
    const meta = identity.deriveMetadata(makeCharacter());
    assert.equal(meta.skin.tone, 'medium golden skin');
    assert.equal(meta.skin.baseTone, 'medium');
    assert.equal(meta.skin.undertone, 'warm');
    assert.equal(meta.skin.complexion, 'even');
    assert.equal(meta.skin.identityCritical, true);
    assert.match(meta.skin.consistencyInstruction, /one consistent underlying natural skin tone/i);
});

test('deeper and lighter skin tones classify deterministically', () => {
    const base = makeCharacter().identity;
    const deep = identity.deriveMetadata(makeCharacter({
        identity: Object.assign({}, base, {
            skinTone: 'deep warm brown skin',
            skin: { tone: 'deep warm brown skin', group: 'deep' }
        })
    }));
    assert.equal(deep.skin.baseTone, 'deep');
    assert.equal(deep.skin.undertone, 'warm');

    const fair = identity.deriveMetadata(makeCharacter({
        identity: Object.assign({}, base, {
            skinTone: 'fair porcelain skin',
            skin: { tone: 'fair porcelain skin', group: 'light' }
        })
    }));
    assert.equal(fair.skin.baseTone, 'light');
    assert.equal(fair.skin.undertone, 'cool');
});

test('legacy metadata upgrades to structured skin information', () => {
    const normalized = identity.normalizeMetadata({
        skin: { tone: 'light olive skin', undertone: 'neutral' },
        distinctiveFeatures: []
    });
    assert.equal(normalized.skin.baseTone, 'light');
    assert.equal(normalized.skin.undertone, 'neutral');
    assert.ok(normalized.skin.consistencyInstruction);
});

test('a character without skin data gets no invented complexion', () => {
    const meta = identity.deriveMetadata({ identity: { face: { shape: 'an oval face' } } });
    assert.equal(meta.skin.tone, '');
    assert.equal(meta.skin.baseTone, '');
    assert.equal(meta.skin.undertone, '');
    assert.equal(meta.skin.identityCritical, false);
});

test('a candidate package is unapproved with no sheet', () => {
    const pkg = identity.createPackage({
        baseImage: { url: '/generated/base.png', filename: 'base.png' },
        character: makeCharacter()
    });
    assert.equal(pkg.status, identity.STATUS.CANDIDATE);
    assert.equal(pkg.approvedBaseImage.approvedAt, null);
    assert.equal(pkg.identitySheet, null);
});

test('approving the base moves the package to approved', () => {
    let pkg = identity.createPackage({
        baseImage: { url: '/generated/base.png', filename: 'base.png' },
        character: makeCharacter()
    });
    pkg = identity.approveBase(pkg);
    assert.equal(pkg.status, identity.STATUS.APPROVED);
    assert.ok(pkg.approvedBaseImage.approvedAt);
});

test('generateSheet produces exactly ONE consolidated identity sheet', async () => {
    resetCalls();
    const character = makeCharacter();
    let pkg = identity.createPackage({
        baseImage: { url: '/generated/base.png', filename: 'base.png' },
        character
    });
    pkg = identity.approveBase(pkg);
    const result = await identity.generateSheet({
        character,
        package: pkg,
        generate: fakeGenerate,
        resolveAbs: (n) => n
    });
    assert.equal(fakeGenerate.calls.length, 1, 'exactly one image is generated');
    assert.equal(result.status, identity.STATUS.READY);
    assert.equal(result.identitySheet.status, identity.SHEET_STATUS.READY);
    assert.equal(result.identitySheet.filename, 'identity_sheet.png');
    assert.equal(result.identitySheet.version, 1);
    // The approved base image is untouched.
    assert.equal(result.approvedBaseImage.filename, 'base.png');
    assert.ok(result.approvedBaseImage.approvedAt);
});

test('generateSheet refuses to run without an approved base image', async () => {
    resetCalls();
    const character = makeCharacter();
    const pkg = identity.createPackage({ baseImage: {}, character });
    const result = await identity.generateSheet({ character, package: pkg, generate: fakeGenerate, resolveAbs: (n) => n });
    assert.equal(fakeGenerate.calls.length, 0);
    assert.equal(result.status, identity.STATUS.FAILED);
});

test('a failed regeneration keeps the previous valid sheet', async () => {
    resetCalls();
    const character = makeCharacter();
    let pkg = identity.approveBase(identity.createPackage({
        baseImage: { url: '/generated/base.png', filename: 'base.png' },
        character
    }));
    const ready = await identity.generateSheet({ character, package: pkg, generate: fakeGenerate, resolveAbs: (n) => n });
    assert.equal(ready.status, identity.STATUS.READY);
    const failing = () => { throw new Error('ComfyUI unavailable'); };
    const result = await identity.generateSheet({
        character,
        package: ready,
        previousSheet: ready,
        generate: failing,
        resolveAbs: (n) => n,
        logger: { warn: () => {} }
    });
    assert.equal(result.status, identity.STATUS.READY, 'previous sheet is preserved');
    assert.equal(result.identitySheet.filename, 'identity_sheet.png');
    assert.match(result.error, /previous sheet was kept/i);
});

test('a failed first generation marks the package failed', async () => {
    const character = makeCharacter();
    const pkg = identity.approveBase(identity.createPackage({
        baseImage: { url: '/generated/base.png', filename: 'base.png' },
        character
    }));
    const failing = () => { throw new Error('ComfyUI OOM'); };
    const result = await identity.generateSheet({
        character, package: pkg, generate: failing, resolveAbs: (n) => n, logger: { warn: () => {} }
    });
    assert.equal(result.status, identity.STATUS.FAILED);
    assert.match(result.error, /ComfyUI OOM/);
});

test('selectIdentityImage prefers the sheet and falls back to the base image', () => {
    const character = makeCharacter();
    const baseOnly = identity.normalizePackage(character);
    const baseImage = identity.selectIdentityImage(baseOnly);
    assert.equal(baseImage.kind, 'approved_base');
    assert.equal(baseImage.filename, 'base.png');

    const withSheet = identity.normalizePackage(Object.assign({}, character, {
        identitySheet: { imageUrl: '/generated/sheet.png', filename: 'sheet.png', status: 'ready', version: 1 }
    }));
    const sheetImage = identity.selectIdentityImage(withSheet);
    assert.equal(sheetImage.kind, 'identity_sheet');
    assert.equal(sheetImage.filename, 'sheet.png');
});

test('the identity-sheet prompt is a neutral multi-panel reference document', () => {
    const prompt = identity.buildIdentitySheetPrompt(makeCharacter());
    assert.match(prompt, /single character identity reference sheet/i);
    assert.match(prompt, /full-body front view/i);
    assert.match(prompt, /three-quarter view/i);
    assert.match(prompt, /side profile/i);
    assert.match(prompt, /close-up head-and-shoulders/i);
    assert.match(prompt, /not a creative scene/i);
    assert.match(prompt, /neutral light-grey/i);
});

test('accessory and distinctive details are only requested when relevant', () => {
    const plain = identity.buildIdentitySheetPrompt(makeCharacter({
        identity: Object.assign({}, makeCharacter().identity, { distinctiveFeature: '' })
    }));
    assert.doesNotMatch(plain, /signature accessory/i);
    const accessorized = identity.buildIdentitySheetPrompt(makeCharacter({
        identity: Object.assign({}, makeCharacter().identity, {
            distinctiveFeature: 'wears round glasses and has a small tattoo on the wrist'
        })
    }));
    assert.match(accessorized, /signature accessory/i);
    assert.match(accessorized, /distinctive feature/i);
});

test('the scene edit instruction separates identity from changeable scene', () => {
    const pkg = identity.normalizePackage(makeCharacter());
    const instruction = identity.buildSceneEditInstruction(pkg, 'a bedroom mirror selfie in a white tank top', 'Maya');
    assert.match(instruction, /IDENTITY:/);
    assert.match(instruction, /SCENE \(change only this\):/);
    assert.match(instruction, /DO NOT:/);
    assert.match(instruction, /bedroom mirror selfie/);
    assert.match(instruction, /OUTPUT:/);
    assert.match(instruction, /ONE new standalone scene image/i);
    assert.match(instruction, /Never return the identity reference itself/i);
    assert.match(instruction, /contact sheet|character turnaround/i);
    const identityPart = instruction.slice(0, instruction.indexOf('SCENE'));
    assert.ok(!/tank top|bedroom/i.test(identityPart), 'the identity clause must not carry the scene');
});

test('the scene edit instruction keeps skin tone continuous across the body', () => {
    const pkg = identity.normalizePackage(makeCharacter());
    const instruction = identity.buildSceneEditInstruction(pkg, 'a bedroom mirror selfie in a white tank top', 'Maya');
    assert.match(instruction, /CHARACTER SKIN-TONE CONTINUITY/);
    assert.match(instruction, /one consistent underlying natural skin tone/i);
    assert.match(instruction, /independent skin-tone interpretations/i);
    assert.match(instruction, /neck/i);
    assert.match(instruction, /lighting changes affect every exposed area consistently/i);
    // Skin continuity is part of the identity layer, not the scene description.
    const beforeScene = instruction.slice(0, instruction.indexOf('SCENE (change only this)'));
    assert.ok(!/tank top|bedroom/i.test(beforeScene), 'the identity/skin layer must not carry the scene');
});

test('identity constraints carry the skin-tone continuity rule', () => {
    const pkg = identity.normalizePackage(makeCharacter());
    const all = identity.buildIdentityConstraints(pkg).join(' ');
    assert.match(all, /underlying natural skin tone/i);
    assert.match(all, /one continuous physical material/i);
    assert.match(all, /neck/i);
    assert.ok(!/tank top|bedroom/i.test(all), 'identity constraints must not name a scene');
});

test('identity is never lost when only the outfit/environment changes', () => {
    const pkg = identity.normalizePackage(makeCharacter());
    const all = identity.buildIdentityConstraints(pkg).join(' ');
    assert.match(all, /facial identity/i);
    assert.match(all, /hairstyle/i);
    assert.ok(!/tank top|bedroom/i.test(all), 'identity constraints must not name a scene');
});

test('mediaFilenames lists the approved base image and the single sheet', () => {
    const pkg = identity.normalizePackage(Object.assign({}, makeCharacter(), {
        identitySheet: { imageUrl: '/generated/sheet.png', filename: 'sheet.png', status: 'ready', version: 1 }
    }));
    assert.deepEqual(identity.mediaFilenames(pkg).sort(), ['base.png', 'sheet.png']);
});

test('buildCard exposes the identity state without leaking paths', () => {
    const pkg = identity.normalizePackage(Object.assign({}, makeCharacter(), {
        identitySheet: { imageUrl: '/generated/sheet.png', filename: 'sheet.png', status: 'ready', version: 2 }
    }));
    const card = identity.buildCard(Object.assign({}, makeCharacter(), pkg));
    assert.equal(card.name, 'Maya');
    assert.equal(card.status, identity.STATUS.READY);
    assert.equal(card.approvedBaseImage.url, '/generated/base.png');
    assert.equal(card.identitySheet.filename, 'sheet.png');
    assert.equal(card.identitySheet.version, 2);
    assert.equal(card.identityMetadata.face.shape, 'an oval face');
    assert.ok(!JSON.stringify(card).includes('tmp'), 'card must not leak absolute paths');
});

test('the preset store round-trips the single-sheet identity package', () => {
    const character = characterPresets.create({
        name: 'Identity Roundtrip',
        identityText: 'a person',
        identity: makeCharacter().identity,
        provenance: { type: 'generated' }
    });
    assert.equal(characterPresets.getIdentityPackage(character.id).approvedBaseImage, null);

    let pkg = identity.approveBase(identity.createPackage({
        baseImage: { url: '/generated/base.png', filename: 'base.png' },
        character
    }));
    pkg = identity.applySheet(pkg, { url: '/generated/sheet.png', filename: 'sheet.png' });
    characterPresets.setIdentityPackage(character.id, pkg);

    const stored = characterPresets.getIdentityPackage(character.id);
    assert.equal(stored.approvedBaseImage.filename, 'base.png');
    assert.ok(stored.approvedBaseImage.approvedAt);
    assert.equal(stored.identitySheet.filename, 'sheet.png');
    assert.equal(stored.identitySheet.status, 'ready');

    characterPresets.clearIdentitySheet(character.id);
    const cleared = characterPresets.getIdentityPackage(character.id);
    assert.equal(cleared.identitySheet, null);
    assert.equal(cleared.approvedBaseImage.filename, 'base.png');
    assert.equal(characterPresets.remove(character.id), true);
});

test('save_character carries the chosen name through action normalization', () => {
    const action = playground.normalizeAction({
        type: 'save_character', conceptId: 'pg_x', expectedRevision: 2, name: '  Maya  '
    });
    assert.equal(action.type, 'save_character');
    assert.equal(action.name, 'Maya');
});

test('playground concept cards carry a single-image identity summary', () => {
    const character = characterPresets.create({
        name: 'Card Character',
        identityText: 'a person',
        identity: makeCharacter().identity,
        provenance: { type: 'generated' }
    });
    characterPresets.setCandidateBaseImage(character.id, { url: '/generated/cand.png', filename: 'cand.png' });
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
    assert.equal(card.identity.hasApprovedBase, false);
    characterPresets.remove(character.id);
});
