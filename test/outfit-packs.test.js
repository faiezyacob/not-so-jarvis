/* ============================================
   JARVIS — Outfit Pack tests
   Covers the pack catalog, the structured wardrobe
   space, deterministic composition, true outfit
   replacement, identity preservation, the custom
   override, context-aware pack selection and the
   character-preset persistence. The state stores are
   pointed at temp files so nothing in data/ is
   touched.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-outfit-packs-'));
process.env.PLAYGROUND_STATE_PATH = path.join(tmpDir, 'playground-state.json');
process.env.CHARACTER_PRESETS_PATH = path.join(tmpDir, 'character-presets.json');

const outfitPacks = require('../services/playground/outfit-packs');
const concept = require('../services/playground/concept');
const playground = require('../services/playground/playground');
const themes = require('../services/playground/themes');
const characterGen = require('../services/playground/character');
const characterPresets = require('../services/character-presets');

const first = () => 0;

function conversationId(name) {
    return 'outfit-test-' + name + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
}

const WARDROBE_SLOTS = ['tops', 'bottoms', 'dresses', 'layers', 'footwear', 'accessories'];

function wardrobeValues(packId) {
    const pack = outfitPacks.getPack(packId);
    const values = [];
    for (const slot of Object.keys(pack.wardrobe)) {
        for (const entry of pack.wardrobe[slot]) values.push(entry.value);
    }
    return values;
}

// --- Catalog -----------------------------------------------------------------

test('outfit catalog exposes the eleven named packs', () => {
    const packs = outfitPacks.listPacks();
    assert.equal(packs.length, 11);
    const ids = packs.map((p) => p.id);
    for (const id of ['casual-everyday', 'lounge-home', 'soft-feminine-casual', 'casual-streetwear',
        'vacation-summer', 'gym-activewear', 'casual-smart', 'casual-night-out',
        'minimalist-neutral', 'edgy-alternative', 'glam-boudoir']) {
        assert.ok(ids.includes(id), 'missing pack: ' + id);
    }
    assert.equal(outfitPacks.getPack('casual-everyday').label, 'Casual Everyday');
    assert.equal(outfitPacks.getPack('vacation-summer').label, 'Vacation & Summer');
    assert.equal(outfitPacks.getPack('glam-boudoir').label, 'Glam & Boudoir');
});

test('every pack describes a wardrobe space, not a prompt string', () => {
    for (const pack of outfitPacks.OUTFIT_PACKS) {
        assert.ok(pack.description, pack.id + ' needs a description');
        assert.ok(pack.wardrobe && typeof pack.wardrobe === 'object', pack.id + ' needs a wardrobe');
        for (const slot of WARDROBE_SLOTS) {
            const list = pack.wardrobe[slot];
            assert.ok(Array.isArray(list) && list.length > 0, pack.id + ' needs ' + slot);
            for (const entry of list) {
                assert.equal(typeof entry.value, 'string', pack.id + ' has a malformed piece');
                assert.ok(entry.value.trim(), pack.id + ' has an empty piece');
                if (entry.weight !== undefined) assert.ok(Number(entry.weight) > 0, pack.id + ' has a bad weight');
            }
        }
        assert.ok(Array.isArray(pack.palette) && pack.palette.length >= 4, pack.id + ' needs a palette');
        assert.ok(Array.isArray(pack.rules) && pack.rules.length > 0, pack.id + ' needs rules');
        assert.equal(pack.prompt, undefined, pack.id + ' must not store a prompt string');
    }
});

test('the catalog payload is compact and UI-ready', () => {
    for (const pack of outfitPacks.listPacks()) {
        assert.equal(typeof pack.id, 'string');
        assert.equal(typeof pack.label, 'string');
        assert.equal(typeof pack.description, 'string');
        assert.ok(Array.isArray(pack.palette));
        assert.equal(pack.wardrobe, undefined, 'the UI payload should not ship the wardrobe pools');
    }
});

// --- Composition -------------------------------------------------------------

test('composition draws only from the pack wardrobe and yields a full outfit', () => {
    for (const pack of outfitPacks.OUTFIT_PACKS) {
        const allowed = new Set(wardrobeValues(pack.id));
        let full = 0;
        for (let seed = 1; seed <= 25; seed++) {
            const composed = outfitPacks.composeFromPack(pack.id, characterGen.createRng(seed));
            if (!composed.outfit) continue;
            full++;
            for (const value of Object.values(composed.components || {})) {
                if (!value) continue;
                assert.ok(allowed.has(value), pack.id + ' produced a foreign piece: ' + value);
            }
        }
        assert.ok(full > 20, pack.id + ' rarely composed a complete outfit (' + full + ')');
    }
});

test('the same pack produces many different outfits', () => {
    const seen = new Set();
    for (let seed = 1; seed <= 250; seed++) {
        seen.add(outfitPacks.composeFromPack('casual-everyday', characterGen.createRng(seed)).outfit);
    }
    assert.ok(seen.size > 20, 'expected a large combination space, got ' + seen.size);
});

test('composition is deterministic for a seed', () => {
    const a = outfitPacks.composeFromPack('casual-smart', characterGen.createRng(4242));
    const b = outfitPacks.composeFromPack('casual-smart', characterGen.createRng(4242));
    assert.equal(a.outfit, b.outfit);
    assert.equal(a.archetype, b.archetype);
});

test('gender-tagged wardrobe pieces are filtered for the character', () => {
    const pack = outfitPacks.getPack('gym-activewear');
    const womanTops = outfitPacks.toSystem(pack, { gender: 'woman' }).components.tops.map((e) => e.value);
    const manTops = outfitPacks.toSystem(pack, { gender: 'man' }).components.tops.map((e) => e.value);
    assert.ok(womanTops.some((v) => /sports bra/.test(v)));
    assert.ok(!manTops.some((v) => /sports bra/.test(v)));
});

// --- Replacement + identity preservation -------------------------------------

test('selecting a new pack replaces the outfit and preserves the character', () => {
    const id = conversationId('replace');
    const session = playground.start({
        conversationId: id, themeId: 'lifestyle-candid', mode: 'random_character',
        outfitPack: 'casual-everyday', rng: first
    });
    const before = session.concept;
    assert.equal(before.outfitPack, 'casual-everyday');
    assert.ok(before.outfit, 'expected a composed outfit');

    const next = playground.modify(session, { outfitPack: 'vacation-summer', rng: characterGen.createRng(99) });
    assert.equal(next.concept.outfitPack, 'vacation-summer');
    assert.equal(next.concept.outfitPackLabel, 'Vacation & Summer');

    // Identity / face / hair / skin are untouched.
    assert.equal(next.concept.identitySignature, before.identitySignature);
    assert.equal(next.concept.subject, before.subject);
    assert.equal(next.concept.appearance, before.appearance);
    assert.equal(next.concept.hair, before.hair);
    assert.equal(next.concept.characterSeed, before.characterSeed);

    // True replacement: nothing that belonged only to the old pack survives.
    const vacation = new Set(wardrobeValues('vacation-summer'));
    const casualOnly = wardrobeValues('casual-everyday').filter((v) => !vacation.has(v));
    for (const piece of casualOnly) {
        assert.ok(!next.concept.outfit.includes(piece), 'old piece remained after replacement: ' + piece);
    }
    assert.notEqual(next.concept.outfit, before.outfit);
});

test('the whole concept except the outfit is preserved by a pack switch', () => {
    const id = conversationId('preserve');
    const session = playground.start({
        conversationId: id, themeId: 'lifestyle-candid', mode: 'random_character',
        outfitPack: 'casual-everyday', rng: first
    });
    const before = Object.assign({}, session.concept);
    playground.modify(session, { outfitPack: 'edgy-alternative', rng: characterGen.createRng(7) });
    const after = session.concept;
    for (const field of ['subject', 'appearance', 'hair', 'environment', 'activity', 'lighting',
        'camera', 'composition', 'mood', 'style', 'aspectRatio', 'category', 'identitySignature']) {
        assert.equal(after[field], before[field], 'field changed unexpectedly: ' + field);
    }
    assert.notEqual(after.outfit, before.outfit);
});

test('an unchanged pack on a scene-only tweak keeps the outfit intact', () => {
    const id = conversationId('scene-only');
    const session = playground.start({
        conversationId: id, themeId: 'lifestyle-candid', mode: 'random_character',
        outfitPack: 'casual-everyday', rng: first
    });
    const outfit = session.concept.outfit;
    playground.modify(session, { changes: { environment: 'a bright private garden' }, rng: first });
    assert.equal(session.concept.environment, 'a bright private garden');
    assert.equal(session.concept.outfit, outfit);
});

// --- Custom override ---------------------------------------------------------

test('a custom pack uses the user-defined outfit verbatim', () => {
    const id = conversationId('custom');
    const session = playground.start({
        conversationId: id, themeId: 'lifestyle-candid', mode: 'random_character', rng: first
    });
    const next = playground.modify(session, {
        outfitPack: 'custom',
        outfitPackCustom: 'a white summer dress with thin straps and beige sandals',
        rng: first
    });
    assert.equal(next.concept.outfit, 'a white summer dress with thin straps and beige sandals');
    assert.equal(next.concept.outfitPack, 'custom');
    assert.equal(next.concept.outfitPackLabel, 'Custom');
    assert.equal(next.concept.outfitPackCustom, 'a white summer dress with thin straps and beige sandals');
});

test('an empty custom outfit is ignored, not blanked', () => {
    const id = conversationId('custom-empty');
    const session = playground.start({
        conversationId: id, themeId: 'lifestyle-candid', mode: 'random_character', rng: first
    });
    const outfit = session.concept.outfit;
    playground.modify(session, { outfitPack: 'custom', outfitPackCustom: '   ', rng: first });
    assert.equal(session.concept.outfit, outfit);
    assert.notEqual(session.concept.outfitPack, 'custom');
});

// --- Character presets -------------------------------------------------------

test('a saved character carries its outfit pack', () => {
    const preset = characterPresets.create({
        name: 'Ivy', identity: 'a woman with curly hair', outfitPack: 'edgy-alternative'
    });
    assert.equal(preset.outfitPack, 'edgy-alternative');

    const id = conversationId('preset');
    const session = playground.start({
        conversationId: id, themeId: 'fashion-editorial', characterId: preset.id, rng: first
    });
    assert.equal(session.concept.outfitPack, 'edgy-alternative');
    assert.equal(session.concept.subject, 'a woman with curly hair');
});

test('an explicit pack overrides the character preset pack', () => {
    const preset = characterPresets.create({ name: 'Ada', identity: 'a woman', outfitPack: 'edgy-alternative' });
    const id = conversationId('override');
    const session = playground.start({
        conversationId: id, themeId: 'fashion-editorial', characterId: preset.id,
        outfitPack: 'minimalist-neutral', rng: first
    });
    assert.equal(session.concept.outfitPack, 'minimalist-neutral');
});

test('a locked outfit is preserved even when a pack is selected', () => {
    const preset = characterPresets.create({
        name: 'Lock', identity: 'a woman', outfit: 'a striped knit sweater'
    });
    const id = conversationId('lock');
    const session = playground.start({
        conversationId: id, themeId: 'lifestyle-candid', characterId: preset.id,
        locks: { outfit: true }, outfitPack: 'vacation-summer', rng: first
    });
    assert.equal(session.concept.outfit, 'a striped knit sweater');
    assert.equal(session.concept.outfitPack, 'vacation-summer');
});

test('a locked outfit survives a context-inferred pack change', () => {
    const preset = characterPresets.create({
        name: 'Locked', identity: 'a woman', outfit: 'a striped knit sweater'
    });
    const id = conversationId('lock-context');
    const session = playground.start({
        conversationId: id, themeId: 'lifestyle-candid', characterId: preset.id,
        locks: { outfit: true }, rng: first
    });
    const text = 'Keep the outfit but make it a beach scene';
    const info = concept.interpretContextMessage(text, { open: true, themeId: 'lifestyle-candid' });
    assert.equal(info.locks.outfit, true);
    assert.equal(info.changes.outfitPack, 'vacation-summer');
    playground.modify(session, {
        locks: info.locks, changes: info.changes, direction: text, rng: first
    });
    assert.equal(session.concept.outfit, 'a striped knit sweater');
    assert.equal(session.concept.environment, 'a wide sunlit sandy beach with the ocean behind');
});

// --- Context-aware selection -------------------------------------------------

test('context wording selects the matching pack', () => {
    assert.equal(outfitPacks.detectOutfitPackFromText('make her outfit more suitable for the gym'), 'gym-activewear');
    assert.equal(outfitPacks.detectOutfitPackFromText('dress her for a warm beach vacation'), 'vacation-summer');
    assert.equal(outfitPacks.detectOutfitPackFromText('something cosy for lounging at home'), 'lounge-home');
    assert.equal(outfitPacks.detectOutfitPackFromText('a polished look for the office'), 'casual-smart');
    assert.equal(outfitPacks.detectOutfitPackFromText('edgy leather and boots'), 'edgy-alternative');
    assert.equal(outfitPacks.detectOutfitPackFromText('keep it casual and relaxed'), 'casual-everyday');
    assert.equal(outfitPacks.detectOutfitPackFromText('give her a seductive look for tonight'), 'glam-boudoir');
    assert.equal(outfitPacks.detectOutfitPackFromText('a sultry boudoir outfit'), 'glam-boudoir');
});

test('unrelated chat does not select a pack', () => {
    assert.equal(outfitPacks.detectOutfitPackFromText('what is the weather today?'), '');
    assert.equal(outfitPacks.detectOutfitPackFromText('generate me another image'), '');
    assert.equal(outfitPacks.detectOutfitPackFromText('no outfit pack, let the theme decide'), '');
    assert.equal(outfitPacks.detectOutfitPackFromText(''), '');
});

test('a typed follow-up can switch the outfit pack', () => {
    const interpreted = concept.interpretContextMessage('make her outfit more suitable for the gym', { open: true });
    assert.equal(interpreted.action, 'modify');
    assert.equal(interpreted.changes.outfitPack, 'gym-activewear');
});

test('naming an exact outfit becomes a custom pack', () => {
    const interpreted = concept.interpretContextMessage('make her outfit a red dress', { open: true });
    assert.equal(interpreted.action, 'modify');
    assert.equal(interpreted.changes.outfitPack, 'custom');
    assert.ok(/red dress/i.test(interpreted.changes.outfitPackCustom));
});

// --- Prompt direction --------------------------------------------------------

test('the pack label reaches the creative direction', () => {
    const theme = themes.getTheme('fashion-editorial');
    const built = concept.assembleConcept({ theme, mode: 'none', outfitPack: 'gym-activewear', rng: first });
    const direction = concept.conceptToDirection(built);
    assert.ok(direction.includes('Gym & Activewear'));
    assert.ok(direction.includes('Outfit:'));
});
