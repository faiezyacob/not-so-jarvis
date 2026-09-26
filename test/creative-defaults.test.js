/* ============================================
   JARVIS — Creative Defaults tests
   Covers the automatic clothing + image-style
   defaults: explicit user instructions always win,
   clothing is generated per character from the
   existing Outfit Pack / wardrobe system, style is a
   coherent scene-driven package (smartphone for
   casual scenes), and follow-ups preserve the
   established look. State stores are pointed at temp
   files so nothing in data/ is touched.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-creative-defaults-'));
process.env.PLAYGROUND_STATE_PATH = path.join(tmpDir, 'playground-state.json');
process.env.CHARACTER_PRESETS_PATH = path.join(tmpDir, 'character-presets.json');
process.env.CHARACTER_CONTEXT_PATH = path.join(tmpDir, 'character-context.json');

const creativeDefaults = require('../services/creative-defaults');
const characterPresets = require('../services/character-presets');
const context = require('../services/character-context');

function makeApproved(name, identity) {
    const character = characterPresets.create(Object.assign({ name }, identity ? { identity } : {}));
    characterPresets.setCandidateBaseImage(character.id, {
        url: '/generated/' + name.toLowerCase() + '-base.png',
        filename: name.toLowerCase() + '-base.png'
    });
    characterPresets.approveBaseImage(character.id);
    return characterPresets.get(character.id);
}

const JULES = () => makeApproved('Jules', { age: '28-year-old', gender: 'woman', skinTone: 'medium golden skin', hairColor: 'dark brown' });
const QUINN = () => makeApproved('Quinn', { age: '31-year-old', gender: 'man', skinTone: 'deep warm brown skin', hairColor: 'black' });

// --- Explicit detection -------------------------------------------------------

test('explicit clothing wording is detected', () => {
    assert.equal(creativeDefaults.specifiesClothing('wearing a red leather jacket'), true);
    assert.equal(creativeDefaults.specifiesClothing('she has a white shirt and jeans'), true);
    assert.equal(creativeDefaults.specifiesClothing('standing in a cafe'), false);
    assert.equal(creativeDefaults.specifiesClothing('on a beach at sunset'), false);
});

test('explicit style wording is detected', () => {
    assert.equal(creativeDefaults.specifiesStyle('in a cinematic portrait'), true);
    assert.equal(creativeDefaults.specifiesStyle('photographed on film'), true);
    assert.equal(creativeDefaults.specifiesStyle('as an oil painting'), true);
    assert.equal(creativeDefaults.specifiesStyle('in a fashion editorial'), true);
    assert.equal(creativeDefaults.specifiesStyle('taking a casual selfie'), false);
    assert.equal(creativeDefaults.specifiesStyle('sitting in a cafe'), false);
});

test('detectExplicitStyle maps the recognized style presets', () => {
    assert.equal(creativeDefaults.detectExplicitStyle('in a cinematic portrait'), 'cinematic');
    assert.equal(creativeDefaults.detectExplicitStyle('photographed on film'), 'film');
    assert.equal(creativeDefaults.detectExplicitStyle('as an oil painting'), 'painting');
    assert.equal(creativeDefaults.detectExplicitStyle('in a fashion editorial'), 'editorial');
    assert.equal(creativeDefaults.detectExplicitStyle('a product photo of shoes'), 'product');
    assert.equal(creativeDefaults.detectExplicitStyle('an anime portrait'), 'anime');
    assert.equal(creativeDefaults.detectExplicitStyle('eating a sandwich'), '');
});

// --- Scene-driven style -------------------------------------------------------

test('casual social scenes default to smartphone photography', () => {
    assert.equal(creativeDefaults.classifySceneStyle('sitting in a cafe').id, 'smartphone');
    assert.equal(creativeDefaults.classifySceneStyle('a bedroom mirror selfie').id, 'smartphone');
    assert.equal(creativeDefaults.classifySceneStyle('hanging out with friends').id, 'smartphone');
    assert.equal(creativeDefaults.classifySceneStyle('walking through a city street').id, 'smartphone');
});

test('a selfie selects the handheld selfie treatment', () => {
    const style = creativeDefaults.selectStylePackage({ rawPrompt: '@Jules taking a selfie with @Quinn', scenePrompt: 'taking a selfie with Quinn' });
    assert.equal(style.id, 'selfie');
    assert.match(style.package.direction, /selfie/i);
    assert.match(style.package.direction, /front-facing phone lens/i);
});

test('a nightlife scene selects the low-light social treatment', () => {
    const style = creativeDefaults.selectStylePackage({ scenePrompt: 'under colorful nightclub lighting' });
    assert.equal(style.id, 'night');
});

test('product and studio scenes never default to a phone photo', () => {
    assert.equal(creativeDefaults.classifySceneStyle('a product photo of a watch').id, 'product');
    assert.equal(creativeDefaults.classifySceneStyle('a studio headshot').id, 'studio');
});

test('the default style package is coherent, not a keyword list', () => {
    const pkg = creativeDefaults.STYLE_PACKAGES.smartphone;
    assert.match(pkg.direction, /capture|photography/i);
    assert.match(pkg.direction, /lighting/i);
    // No disconnected camera-spec dump: it stays a readable direction.
    assert.ok(pkg.direction.length < 400);
    assert.doesNotMatch(pkg.direction, /bokeh|f\/1\.|ISO \d+/i);
});

// --- Automatic clothing -------------------------------------------------------

test('clothing is generated automatically when the user omits it', () => {
    const jules = JULES();
    const result = creativeDefaults.buildCreativeDefaults([jules], { rawPrompt: '@Jules sitting in a cafe', scenePrompt: 'sitting in a cafe', seed: 1 });
    assert.equal(result.hasExplicitClothing, false);
    assert.equal(result.clothing.length, 1);
    assert.equal(result.clothing[0].name, 'Jules');
    assert.ok(result.clothing[0].outfit.length > 0);
    assert.match(result.section, /CLOTHING/);
    assert.match(result.section, /Jules wears /);
});

test('explicit clothing suppresses automatic clothing entirely', () => {
    const jules = JULES();
    const raw = '@Jules sitting in a cafe wearing a red leather jacket';
    const result = creativeDefaults.buildCreativeDefaults([jules], { rawPrompt: raw, scenePrompt: raw.replace('@Jules ', ''), seed: 1 });
    assert.equal(result.hasExplicitClothing, true);
    assert.equal(result.clothing.length, 0);
    assert.doesNotMatch(result.section, /Jules wears /);
});

test('every character gets an independent outfit in a multi-character scene', () => {
    const jules = JULES();
    const quinn = QUINN();
    const result = creativeDefaults.buildCreativeDefaults([jules, quinn], {
        rawPrompt: '@Jules and @Quinn standing next to each other',
        scenePrompt: 'standing next to each other',
        seed: 12
    });
    assert.equal(result.clothing.length, 2);
    assert.equal(result.clothing[0].name, 'Jules');
    assert.equal(result.clothing[1].name, 'Quinn');
    assert.notEqual(result.clothing[0].outfit.toLowerCase(), result.clothing[1].outfit.toLowerCase());
    assert.match(result.section, /keep each outfit independent/i);
});

test('a male character does not receive a feminine outfit from an untagged pack', () => {
    const quinn = QUINN();
    for (const seed of [1, 2, 3, 7, 42, 99]) {
        const result = creativeDefaults.buildCreativeDefaults([quinn], {
            rawPrompt: '@Quinn on a night out',
            scenePrompt: 'on a night out',
            seed
        });
        const outfit = result.clothing[0].outfit;
        assert.doesNotMatch(outfit, /\b(?:dress|gown|nightgown|skirt|camisole|blouse|leggings|bikini)\b/i, 'seed ' + seed + ': ' + outfit);
    }
});

test('a gym scene selects an athletic wardrobe personality', () => {
    const quinn = QUINN();
    const result = creativeDefaults.buildCreativeDefaults([quinn], {
        rawPrompt: '@Quinn at the gym',
        scenePrompt: 'at the gym',
        seed: 42
    });
    assert.equal(result.clothing[0].packId, 'gym-activewear');
});

test('the composed clothing is deterministic for a seed', () => {
    const jules = JULES();
    const first = creativeDefaults.buildCreativeDefaults([jules], { rawPrompt: '@Jules in a cafe', scenePrompt: 'in a cafe', seed: 5 });
    const second = creativeDefaults.buildCreativeDefaults([jules], { rawPrompt: '@Jules in a cafe', scenePrompt: 'in a cafe', seed: 5 });
    assert.equal(first.clothing[0].outfit, second.clothing[0].outfit);
});

test('an assigned Outfit Pack drives the automatic clothing', () => {
    const character = characterPresets.create({
        name: 'Maya',
        identity: { gender: 'woman' },
        outfitPack: 'edgy-alternative'
    });
    characterPresets.setCandidateBaseImage(character.id, { url: '/generated/maya.png', filename: 'maya.png' });
    characterPresets.approveBaseImage(character.id);
    const maya = characterPresets.get(character.id);
    const result = creativeDefaults.buildCreativeDefaults([maya], { rawPrompt: '@Maya in a cafe', scenePrompt: 'in a cafe', seed: 3 });
    assert.ok(result.clothing[0].outfit.length > 0);
    // The composed outfit comes from the assigned pack, not the scene default.
    const composed = require('../services/playground/outfit-packs').composeFromPack('edgy-alternative', () => 0.5, { gender: 'woman' });
    assert.ok(composed.outfit.length > 0);
});

// --- Continuity ---------------------------------------------------------------

test('a follow-up preserves the established clothing and style', () => {
    const jules = JULES();
    const quinn = QUINN();
    const first = creativeDefaults.buildCreativeDefaults([jules, quinn], {
        rawPrompt: '@Jules and @Quinn standing in a park',
        scenePrompt: 'standing in a park',
        seed: 7
    });
    const followUp = creativeDefaults.buildCreativeDefaults([jules, quinn], {
        rawPrompt: 'change the background to a beach',
        scenePrompt: 'change the background to a beach',
        seed: 999,
        continuity: true,
        previousClothing: first.clothing,
        previousStyle: first.style
    });
    assert.deepEqual(followUp.clothing.map((c) => c.outfit), first.clothing.map((c) => c.outfit));
    assert.equal(followUp.style.id, first.style.id);
});

test('an explicit clothing change overrides continuity', () => {
    const jules = JULES();
    const first = creativeDefaults.buildCreativeDefaults([jules], { rawPrompt: '@Jules in a park', scenePrompt: 'in a park', seed: 7 });
    const changed = creativeDefaults.buildCreativeDefaults([jules], {
        rawPrompt: 'change her outfit to a formal suit',
        scenePrompt: 'change her outfit to a formal suit',
        seed: 8,
        continuity: true,
        previousClothing: first.clothing,
        previousStyle: first.style
    });
    assert.equal(changed.hasExplicitClothing, true);
    assert.equal(changed.clothing.length, 0);
});

test('a new standalone scene generates fresh defaults', () => {
    const jules = JULES();
    const first = creativeDefaults.buildCreativeDefaults([jules], { rawPrompt: '@Jules in a park', scenePrompt: 'in a park', seed: 7 });
    const fresh = creativeDefaults.buildCreativeDefaults([jules], { rawPrompt: '@Jules at the gym', scenePrompt: 'at the gym', seed: 7 });
    assert.equal(fresh.clothing[0].packId, 'gym-activewear');
    assert.notEqual(fresh.clothing[0].outfit, first.clothing[0].outfit);
});

// --- Integration with the character instruction -------------------------------

test('single-character generation appends auto clothing and a style package', () => {
    const jules = JULES();
    const conditioning = context.buildConditioning([jules], 'sitting in a cafe', {
        rawPrompt: '@Jules sitting in a cafe',
        seed: 1
    });
    assert.match(conditioning.instruction, /IDENTITY:/);
    assert.match(conditioning.instruction, /SCENE \(change only this\):/);
    assert.match(conditioning.instruction, /CLOTHING \(automatically selected/);
    assert.match(conditioning.instruction, /Jules wears /);
    assert.match(conditioning.instruction, /IMAGE STYLE\nNatural modern smartphone photography/);
    assert.ok(conditioning.creativeDefaults);
});

test('single-character explicit clothing survives and no auto clothing appears', () => {
    const jules = JULES();
    const raw = '@Jules sitting in a cafe wearing a red leather jacket';
    const conditioning = context.buildConditioning([jules], raw.replace('@Jules ', ''), { rawPrompt: raw, seed: 1 });
    assert.match(conditioning.instruction, /SCENE \(change only this\):/);
    assert.doesNotMatch(conditioning.instruction, /CLOTHING \(automatically selected/);
    assert.doesNotMatch(conditioning.instruction, /Jules wears /);
});

test('multi-character generation assigns clothing inside each named identity block', () => {
    const jules = JULES();
    const quinn = QUINN();
    const conditioning = context.buildConditioning([jules, quinn], 'standing next to each other', {
        rawPrompt: '@Jules and @Quinn standing next to each other',
        seed: 12
    });
    assert.match(conditioning.instruction, /CHARACTER 1 \u2014 JULES/);
    assert.match(conditioning.instruction, /CHARACTER 2 \u2014 QUINN/);
    // Each character's clothing appears under its own block, never a shared line.
    assert.match(conditioning.instruction, /Jules wears [^\n]+/);
    assert.match(conditioning.instruction, /Quinn wears [^\n]+/);
    assert.doesNotMatch(conditioning.instruction, /they wear/i);
});

test('multi-character explicit clothing is preserved per character', () => {
    const jules = JULES();
    const quinn = QUINN();
    const raw = '@Jules and @Quinn standing together, Jules wearing a white shirt and Quinn wearing a black jacket';
    const conditioning = context.buildConditioning([jules, quinn], raw.replace(/@/g, ''), { rawPrompt: raw, seed: 12 });
    assert.match(conditioning.instruction, /Jules wearing a white shirt/);
    assert.match(conditioning.instruction, /Quinn wearing a black jacket/);
    assert.doesNotMatch(conditioning.instruction, /CLOTHING \(automatically selected/);
});

test('an explicit style suppresses the default style package but not identity', () => {
    const jules = JULES();
    const raw = '@Jules and @Quinn photographed on film';
    const quinn = QUINN();
    const conditioning = context.buildConditioning([jules, quinn], 'photographed on film', { rawPrompt: raw, seed: 1 });
    assert.doesNotMatch(conditioning.instruction, /Natural modern smartphone photography/);
    assert.match(conditioning.instruction, /CHARACTER ATTRIBUTE ISOLATION/);
    assert.match(conditioning.instruction, /SKIN-TONE CONTINUITY ACROSS CHARACTERS/);
});

test('the automatic style never overrides character identity', () => {
    const jules = JULES();
    const quinn = QUINN();
    const conditioning = context.buildConditioning([jules, quinn], 'under colorful nightclub lighting', {
        rawPrompt: '@Jules and @Quinn under colorful nightclub lighting',
        seed: 1
    });
    assert.match(conditioning.instruction, /CHARACTER IDENTITY/);
    assert.match(conditioning.instruction, /Jules retains Jules's natural complexion/);
    assert.match(conditioning.instruction, /Quinn retains Quinn's natural complexion/);
    assert.match(conditioning.instruction, /Reference image 1 = Jules only\./);
    assert.match(conditioning.instruction, /Reference image 2 = Quinn only\./);
});

test('creative defaults can be disabled for the video/portrait paths', () => {
    const jules = JULES();
    const conditioning = context.buildConditioning([jules], 'walking down the street', {
        rawPrompt: '@Jules walking down the street',
        defaults: false
    });
    assert.equal(conditioning.creativeDefaults, null);
    assert.doesNotMatch(conditioning.instruction, /CLOTHING \(automatically selected/);
});

test('the persisted clothing/style shapes round-trip for continuity', () => {
    const jules = JULES();
    const result = creativeDefaults.buildCreativeDefaults([jules], { rawPrompt: '@Jules in a cafe', scenePrompt: 'in a cafe', seed: 4 });
    // The layer consumes the same shape it produces.
    const again = creativeDefaults.buildCreativeDefaults([jules], {
        rawPrompt: 'change the background',
        scenePrompt: 'change the background',
        seed: 4,
        continuity: true,
        previousClothing: result.clothing,
        previousStyle: result.style
    });
    assert.deepEqual(again.clothing.map((c) => c.outfit), result.clothing.map((c) => c.outfit));
});
