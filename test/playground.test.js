/* ============================================
   JARVIS — Creative Playground tests
   Covers the theme catalog, concept assembly,
   attribute locking, context interpretation, the
   concept -> prompt-builder request, and the
   persisted card/session lifecycle. The state
   stores are pointed at temp files so nothing in
   data/ is touched.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-playground-'));
process.env.PLAYGROUND_STATE_PATH = path.join(tmpDir, 'playground-state.json');
process.env.CHARACTER_PRESETS_PATH = path.join(tmpDir, 'character-presets.json');

const themes = require('../services/playground/themes');
const concept = require('../services/playground/concept');
const playground = require('../services/playground/playground');
const characterGen = require('../services/playground/character');
const characterPresets = require('../services/character-presets');
const characterStudio = require('../services/character-studio');

// Deterministic rng: always returns the first option so assertions are stable.
const first = () => 0;

function conversationId(name) {
    return 'playground-test-' + name + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
}

// --- Theme catalog -----------------------------------------------------------

test('theme catalog exposes Anything plus the seven named themes', () => {
    const list = themes.listThemes();
    assert.equal(list.length, 8);
    const ids = list.map((t) => t.id);
    assert.ok(ids.includes('anything'));
    assert.ok(ids.includes('fashion-editorial'));
    assert.ok(ids.includes('lifestyle-candid'));
    assert.ok(ids.includes('travel-adventure'));
    assert.ok(ids.includes('cinematic-storytelling'));
    assert.ok(ids.includes('fantasy-character-worlds'));
    assert.ok(ids.includes('seasonal-concepts'));
    assert.ok(ids.includes('experimental-photography'));
});

test('Anything draws from every theme pool', () => {
    const anything = themes.getTheme('anything');
    assert.ok(anything.environments.length > themes.getTheme('travel-adventure').environments.length);
    assert.ok(anything.activities.length > 0);
    assert.ok(anything.moods.length > 0);
});

test('unknown theme ids resolve to Anything', () => {
    assert.equal(themes.getTheme('does-not-exist').id, 'anything');
    assert.equal(themes.getTheme('').id, 'anything');
});

test('pickScenario returns a compatible bundle', () => {
    const theme = themes.getTheme('cinematic-storytelling');
    const scenario = themes.pickScenario(theme, first);
    assert.ok(scenario.environment);
    assert.ok(scenario.activity);
    assert.ok(scenario.lighting);
    assert.ok(scenario.camera);
    assert.ok(scenario.mood);
    assert.ok(scenario.style);
});

test('pickScenario prefers an explicit scene bundle when a theme declares one', () => {
    const sceneTheme = {
        id: 'test-scenes',
        environments: ['ignored environment'],
        activities: ['ignored activity'],
        outfits: ['ignored outfit'],
        lighting: ['ignored lighting'],
        cameras: ['ignored camera'],
        moods: ['ignored mood'],
        styles: ['ignored style'],
        scenes: [{ environment: 'scene environment', activity: 'scene activity', mood: 'scene mood' }]
    };
    const scenario = themes.pickScenario(sceneTheme, first);
    assert.equal(scenario.environment, 'scene environment');
    assert.equal(scenario.activity, 'scene activity');
    assert.equal(scenario.mood, 'scene mood');
});

// --- Lifestyle & Candid theme ----------------------------------------------

const AI_SLOP_WORDS = [
    'cinematic', 'highly detailed', 'photorealistic', 'masterpiece',
    'professional photography', 'atmospheric depth', 'dramatic lighting',
    'perfect composition', 'flawless skin', 'editorial photography'
];

function collectStrings(value, out = []) {
    if (typeof value === 'string') {
        out.push(value);
    } else if (Array.isArray(value)) {
        value.forEach((item) => collectStrings(item, out));
    } else if (value && typeof value === 'object') {
        Object.keys(value).forEach((key) => collectStrings(value[key], out));
    }
    return out;
}

test('Lifestyle & Candid theme is present with its subcategories', () => {
    const theme = themes.getTheme('lifestyle-candid');
    assert.equal(theme.id, 'lifestyle-candid');
    assert.equal(theme.label, 'Lifestyle & Candid');
    assert.equal(theme.categories.length, 14);
    const ids = theme.categories.map((c) => c.id);
    for (const id of ['casual-selfie', 'mirror-selfie', 'outfit-check', 'cafe-coffee', 'bedroom-home',
        'street-city', 'travel', 'shopping', 'beauty-skincare', 'gym-fitness', 'morning-routine',
        'night-out', 'candid-social', 'instagram-story']) {
        assert.ok(ids.includes(id), 'missing category ' + id);
    }
});

test('Lifestyle & Candid avoids generic AI-image language', () => {
    const theme = themes.getTheme('lifestyle-candid');
    const text = collectStrings(theme).join(' \u0000 ').toLowerCase();
    for (const word of AI_SLOP_WORDS) {
        assert.ok(!text.includes(word), 'theme contains AI-slop word: ' + word);
    }
    assert.ok(Array.isArray(theme.constraints) && theme.constraints.length > 0);
});

test('a named Lifestyle subcategory pins the scenario', () => {
    const theme = themes.getTheme('lifestyle-candid');
    const scenario = themes.pickScenario(theme, first, 'gym-fitness');
    assert.equal(scenario.category, 'Gym / Fitness');
    assert.equal(scenario.categoryId, 'gym-fitness');
    assert.equal(scenario.environment, 'a gym');
    assert.ok(scenario.camera);
    assert.ok(scenario.composition);
});

test('assembleConcept carries the Lifestyle category and composition', () => {
    const theme = themes.getTheme('lifestyle-candid');
    const built = concept.assembleConcept({ theme, mode: 'none', rng: first });
    assert.equal(built.category, 'Casual Selfie');
    assert.equal(built.composition, 'casual framing, slightly off-center');
    const direction = concept.conceptToDirection(built);
    assert.ok(direction.includes('Social-media category:'));
    assert.ok(direction.includes(built.composition));
});

test('Lifestyle concepts preserve the selected character identity', () => {
    const theme = themes.getTheme('lifestyle-candid');
    const character = { identity: 'a woman with green eyes and freckles', appearance: 'a soft jawline', hair: 'a dark bob', outfit: 'a beige cardigan' };
    const built = concept.assembleConcept({ theme, mode: 'character', character, locks: {}, rng: first });
    assert.equal(built.subject, character.identity);
    assert.equal(built.appearance, character.appearance);
    assert.equal(built.hair, character.hair);
});

test('Lifestyle typed follow-ups can pin a subcategory', () => {
    const mirror = concept.interpretContextMessage('make it a mirror selfie', { open: true, themeId: 'lifestyle-candid' });
    assert.equal(mirror.action, 'modify');
    assert.equal(mirror.changes.category, 'mirror-selfie');
    // Subcategory keywords must not leak into other themes.
    const other = concept.interpretContextMessage('make it a mirror selfie', { open: true, themeId: 'fashion-editorial' });
    assert.ok(!other || !other.changes || other.changes.category === undefined);
});

test('modify re-rolls within a pinned Lifestyle subcategory while preserving locks', () => {
    const id = conversationId('instagram-modify');
    const preset = characterPresets.create({ name: 'Mia', identity: 'a woman with auburn hair', outfit: 'a grey hoodie' });
    const session = playground.start({ conversationId: id, themeId: 'lifestyle-candid', characterId: preset.id, locks: { outfit: true }, rng: first });
    const originalOutfit = session.concept.outfit;
    playground.modify(session, { changes: { category: 'gym-fitness' }, rng: first });
    assert.equal(session.concept.category, 'Gym / Fitness');
    assert.equal(session.concept.environment, 'a gym');
    assert.equal(session.concept.outfit, originalOutfit);
    assert.equal(session.concept.subject, preset.identity);
});

test('buildImageRequest appends the Lifestyle theme guidance', () => {
    const id = conversationId('instagram-request');
    const session = playground.start({ conversationId: id, themeId: 'lifestyle-candid', mode: 'none', rng: first });
    const request = playground.buildImageRequest(session);
    assert.ok(request.explicit_constraints.some((c) => /everyday phone snapshot/i.test(c)));
    assert.ok(/Social-media category:/.test(request.user_prompt));
});

// --- Concept assembly --------------------------------------------------------

test('assembleConcept always preserves a selected character identity', () => {
    const theme = themes.getTheme('fashion-editorial');
    const character = { identity: 'a woman with green eyes', appearance: 'a scar above the brow', hair: 'a red braid', outfit: 'a leather jacket' };
    const built = concept.assembleConcept({ theme, mode: 'character', character, locks: {}, rng: first });
    assert.equal(built.subject, character.identity);
    assert.equal(built.appearance, character.appearance);
    assert.equal(built.hair, character.hair);
});

test('unlocked outfit randomizes even when a character preset has one', () => {
    const theme = themes.getTheme('fashion-editorial');
    const character = { identity: 'a pilot', outfit: 'a flight suit', style: 'analogue' };
    const built = concept.assembleConcept({ theme, mode: 'character', character, locks: {}, rng: first });
    assert.notEqual(built.outfit, character.outfit);
    assert.equal(built.style, concept.assembleConcept({ theme, mode: 'character', character, locks: {}, rng: first }).style);
});

test('locked outfit and style come from the character preset', () => {
    const theme = themes.getTheme('fashion-editorial');
    const character = { identity: 'a pilot', outfit: 'a flight suit', style: 'analogue film' };
    const built = concept.assembleConcept({
        theme, mode: 'character', character,
        locks: { outfit: true, style: true }, rng: first
    });
    assert.equal(built.outfit, character.outfit);
    assert.equal(built.style, character.style);
});

test('locked environment is preserved from the previous concept', () => {
    const theme = themes.getTheme('travel-adventure');
    const previous = { environment: 'a windswept cliff path' };
    const built = concept.assembleConcept({
        theme, mode: 'none', locks: { environment: true }, previous, rng: first
    });
    assert.equal(built.environment, previous.environment);
});

test('random character generates an identity and keeps it when identity is locked', () => {
    const theme = themes.getTheme('lifestyle-candid');
    const first_ = concept.assembleConcept({ theme, mode: 'random_character', locks: {}, rng: first });
    assert.ok(first_.subject.length > 0);
    const second = concept.assembleConcept({
        theme, mode: 'random_character', locks: { identity: true }, previous: first_, rng: () => 0.9
    });
    assert.equal(second.subject, first_.subject);
});

test('an unlocked random character can change between concepts', () => {
    const theme = themes.getTheme('lifestyle-candid');
    const first_ = concept.assembleConcept({ theme, mode: 'random_character', locks: {}, rng: () => 0 });
    const second = concept.assembleConcept({ theme, mode: 'random_character', locks: {}, previous: first_, rng: () => 0.99 });
    assert.notEqual(second.subject, first_.subject);
});

test('a new random Surprise casts a new character even while identity is locked', () => {
    const id = conversationId('fresh-random');
    const a = playground.start({ conversationId: id, themeId: 'lifestyle-candid', mode: 'random_character', locks: { identity: true }, rng: () => 0 });
    const b = playground.start({ conversationId: id, themeId: 'lifestyle-candid', mode: 'random_character', locks: { identity: true }, rng: () => 0.99 });
    assert.notEqual(a.concept.subject, b.concept.subject);
    assert.equal(b.locks.identity, true);
});

test('Surprise Me Again keeps the locked character and rerolls the scene', () => {
    const id = conversationId('again-random');
    const session = playground.start({
        conversationId: id, themeId: 'lifestyle-candid', mode: 'random_character',
        locks: { identity: true }, rng: () => 0
    });
    const beforeSubject = session.concept.subject;
    const beforeSeed = session.concept.characterSeed;
    const beforeTheme = session.themeId;
    const next = playground.again(session, { rng: () => 0.99 });
    assert.equal(next.concept.subject, beforeSubject);
    assert.equal(next.concept.characterSeed, beforeSeed);
    assert.equal(next.themeId, beforeTheme);
});

test('Surprise Me Again casts a new character when identity is unlocked', () => {
    const id = conversationId('again-unlocked');
    const session = playground.start({
        conversationId: id, themeId: 'lifestyle-candid', mode: 'random_character',
        locks: {}, rng: () => 0
    });
    const beforeSubject = session.concept.subject;
    const next = playground.again(session, { rng: () => 0.99 });
    assert.notEqual(next.concept.subject, beforeSubject);
});

test('Surprise Me Again preserves a saved character identity', () => {
    const id = conversationId('again-saved');
    const preset = characterPresets.create({ name: 'Nova', identity: 'a woman with silver hair', outfit: 'a white suit' });
    const session = playground.start({
        conversationId: id, themeId: 'fashion-editorial', characterId: preset.id, locks: {}, rng: first
    });
    const subject = session.concept.subject;
    const next = playground.again(session, { rng: () => 0.99 });
    assert.equal(next.concept.subject, subject);
});

// --- Random character generator ---------------------------------------------

test('generateRandomIdentity is deterministic for a given seed', () => {
    const a = characterGen.generateRandomIdentity(12345);
    const b = characterGen.generateRandomIdentity(12345);
    assert.deepEqual(a, b);
    assert.equal(a.identityText, characterGen.formatIdentity(a));
    assert.equal(a.signature, characterGen.identitySignature(a));
});

test('generateRandomIdentity is deterministic for a given rng', () => {
    const a = characterGen.generateRandomIdentity(characterGen.createRng(42));
    const b = characterGen.generateRandomIdentity(characterGen.createRng(42));
    assert.deepEqual(a, b);
});

test('different seeds produce a diverse identity space', () => {
    const signatures = new Set();
    for (let seed = 1; seed <= 300; seed++) {
        signatures.add(characterGen.generateRandomIdentity(seed).signature);
    }
    assert.ok(signatures.size > 280, 'expected high diversity, got ' + signatures.size);
});

test('generateUniqueIdentity rerolls away from an avoided signature', () => {
    const first_ = characterGen.generateRandomIdentity(5000);
    const rerolled = characterGen.generateUniqueIdentity(5000, [first_.signature]);
    assert.notEqual(rerolled.signature, first_.signature);
});

test('generated traits stay coherent (age-appropriate hair, skin-appropriate eyes)', () => {
    const traits = characterGen.CHARACTER_TRAITS;
    const matureHair = new Set(traits.hairColors.filter((c) => c.groups && c.groups.includes('mature')).map((c) => c.value));
    const deepEyes = new Set(traits.eyeColors.filter((c) => c.skins && c.skins.includes('deep')).map((c) => c.value));
    for (let seed = 1; seed <= 400; seed++) {
        const identity = characterGen.generateRandomIdentity(seed);
        if (identity.ageGroup === 'mature') {
            assert.ok(matureHair.has(identity.hairColor), 'mature hair: ' + identity.hairColor);
        }
        if (identity.skinGroup === 'deep') {
            assert.ok(deepEyes.has(identity.eyeColor), 'deep-skin eyes: ' + identity.eyeColor);
        }
    }
});

test('identity text never bakes in scene, outfit or social-media words', () => {
    const banned = ['cafe', 'instagram', 'selfie', 'outfit', 'mirror', 'gym', 'beach', 'travel', 'coffee', 'bedroom'];
    for (let seed = 1; seed <= 200; seed++) {
        const text = characterGen.generateRandomIdentity(seed).identityText.toLowerCase();
        for (const word of banned) {
            assert.ok(!text.includes(word), 'identity leaked "' + word + '": ' + text);
        }
    }
});

test('a structured identity maps into the concept fields and a preset round-trips', () => {
    const id = conversationId('save-random');
    const session = playground.start({
        conversationId: id, themeId: 'lifestyle-candid', mode: 'random_character', locks: {},
        rng: characterGen.createRng(4242)
    });
    const c = session.concept;
    assert.ok(c.identity && c.identity.signature);
    assert.equal(c.identitySeed, c.identity.seed);
    assert.ok(c.name);

    const preset = characterPresets.create({
        name: c.name, identity: c.subject, appearance: c.appearance, hair: c.hair, outfit: c.outfit, style: c.style,
        appearanceCategory: c.appearanceCategory, appearanceCategoryLabel: c.appearanceCategoryLabel
    });
    const loaded = characterPresets.get(preset.id);
    assert.equal(loaded.identity, c.subject);
    assert.equal(loaded.appearance, c.appearance);
    assert.equal(loaded.hair, c.hair);
    assert.equal(loaded.appearanceCategory, c.appearanceCategory);
    assert.equal(loaded.appearanceCategoryLabel, c.appearanceCategoryLabel);

    // Reusable across themes exactly like a hand-saved character.
    const reused = concept.assembleConcept({
        theme: themes.getTheme('travel-adventure'), mode: 'character', character: loaded, locks: {}, rng: first
    });
    assert.equal(reused.subject, c.subject);
    assert.equal(reused.appearance, c.appearance);
    assert.equal(reused.hair, c.hair);
    assert.equal(reused.name, c.name);
    // The saved demographic must survive so the prompt still renders the person.
    assert.equal(reused.appearanceCategory, c.appearanceCategory);
    assert.equal(reused.appearanceCategoryLabel, c.appearanceCategoryLabel);
    assert.ok(concept.conceptToDirection(reused).includes('Character appearance category: ' + c.appearanceCategoryLabel));
});

test('repeated Surprises in one conversation avoid immediately repeating an identity', () => {
    const id = conversationId('dupe-avoid');
    const s1 = playground.start({ conversationId: id, themeId: 'lifestyle-candid', mode: 'random_character', locks: {}, rng: characterGen.createRng(1) });
    const s2 = playground.start({ conversationId: id, themeId: 'lifestyle-candid', mode: 'random_character', locks: {}, rng: characterGen.createRng(1) });
    assert.notEqual(s1.concept.identitySignature, s2.concept.identitySignature);
    assert.ok(s2.identitySignatures.includes(s1.concept.identitySignature));
    assert.ok(s2.identitySignatures.includes(s2.concept.identitySignature));
});

test('old-format concepts and presets keep working', () => {
    const theme = themes.getTheme('lifestyle-candid');
    const legacyConcept = { subject: 'a legacy subject', appearance: 'legacy appearance', hair: 'legacy hair' };
    const preserved = concept.assembleConcept({
        theme, mode: 'random_character', locks: { identity: true }, previous: legacyConcept, rng: () => 0
    });
    assert.equal(preserved.subject, 'a legacy subject');
    assert.equal(preserved.appearance, 'legacy appearance');
    assert.equal(preserved.hair, 'legacy hair');
    assert.equal(preserved.identity, null);

    const legacyPreset = { id: 'legacy', name: 'Legacy', identity: 'a legacy character', appearance: '', hair: '', outfit: '', style: '' };
    const fromPreset = concept.assembleConcept({ theme, mode: 'character', character: legacyPreset, locks: {}, rng: first });
    assert.equal(fromPreset.subject, 'a legacy character');
});

test('Surprise Me Again rerolls the Lifestyle subcategory', () => {
    const id = conversationId('again-category');
    const session = playground.start({
        conversationId: id, themeId: 'lifestyle-candid', mode: 'none', locks: {},
        rng: characterGen.createRng(7)
    });
    const firstCategory = session.concept.categoryId;
    let changed = false;
    for (let i = 0; i < 6 && !changed; i++) {
        playground.again(session, { rng: characterGen.createRng(200 + i) });
        if (session.concept.categoryId !== firstCategory) changed = true;
    }
    assert.ok(changed, 'expected Surprise Me Again to reroll the subcategory');
});

test('applyChanges overrides explicit fields and keeps the rest', () => {
    const theme = themes.getTheme('travel-adventure');
    const built = concept.assembleConcept({ theme, mode: 'none', rng: first });
    const changed = concept.applyChanges(built, { environment: 'a snowy peak', mood: 'epic' });
    assert.equal(changed.environment, 'a snowy peak');
    assert.equal(changed.mood, 'epic');
    assert.equal(changed.activity, built.activity);
});

// --- Character controls (appearance / age / gender) --------------------------

function poolValues(pool) {
    return new Set((Array.isArray(pool) ? pool : []).map((entry) => (typeof entry === 'string' ? entry : entry.value)));
}

test('all-Random controls reproduce the general random character', () => {
    const profile = characterGen.normalizeProfile({ appearance: 'random', age: 'random', gender: 'random' });
    assert.deepEqual(profile, { appearance: 'random', age: 'random', gender: 'random' });
    const id = characterGen.generateRandomIdentity(2024, profile);
    assert.ok(id.identityText.length > 0);
    assert.deepEqual(id.characterProfile, profile);
    assert.equal(id.characterSeed, 2024);
});

test('every appearance category constrains the generated traits to its pools', () => {
    for (const key of characterGen.APPEARANCE_KEYS) {
        const category = characterGen.APPEARANCE_CATEGORIES[key];
        const skins = poolValues(category.skinTones);
        const hairs = poolValues(category.hairColors);
        const eyes = poolValues(category.eyeColors);
        for (let seed = 1; seed <= 60; seed++) {
            const id = characterGen.generateRandomIdentity(seed, { appearance: key });
            assert.equal(id.appearanceCategory, key);
            assert.ok(skins.has(id.skinTone), key + ' skin: ' + id.skinTone);
            assert.ok(hairs.has(id.hairColor), key + ' hair: ' + id.hairColor);
            assert.ok(eyes.has(id.eyeColor), key + ' eyes: ' + id.eyeColor);
        }
    }
});

test('age is independent from appearance and stays inside its range', () => {
    for (const ageKey of characterGen.AGE_KEYS) {
        for (const appearance of ['random', 'east_asian', 'black_african_diaspora']) {
            const id = characterGen.generateRandomIdentity(42, { appearance, age: ageKey });
            assert.equal(id.ageGroup, ageKey);
            assert.ok(characterGen.AGE_GROUPS[ageKey].ages.includes(id.age), id.age);
            if (appearance !== 'random') assert.equal(id.appearanceCategory, appearance);
        }
    }
});

test('gender is independent from appearance and age', () => {
    for (const gender of characterGen.GENDER_KEYS) {
        for (const appearance of ['random', 'white_european', 'south_asian']) {
            const id = characterGen.generateRandomIdentity(7, { appearance, age: 'adult', gender });
            assert.equal(id.gender, gender);
            assert.equal(id.presentation, characterGen.GENDER_PRESENTATION[gender]);
        }
    }
});

test('Random stays unconstrained across every control', () => {
    const cats = new Set();
    const genders = new Set();
    const ages = new Set();
    for (let seed = 1; seed <= 240; seed++) {
        const id = characterGen.generateRandomIdentity(seed);
        cats.add(id.appearanceCategory);
        genders.add(id.gender);
        ages.add(id.ageGroup);
    }
    assert.ok(cats.size >= 5, 'expected several appearance categories, got ' + cats.size);
    assert.equal(genders.size, 2, 'expected both genders');
    assert.ok(ages.size >= 3, 'expected several age groups, got ' + ages.size);
});

test('same seed and profile reproduce the same character; new seed changes it', () => {
    const profile = { appearance: 'middle_eastern', age: 'mature', gender: 'man' };
    const a = characterGen.generateRandomIdentity(2024, profile);
    const b = characterGen.generateRandomIdentity(2024, profile);
    assert.deepEqual(a, b);
    const c = characterGen.generateRandomIdentity(2025, profile);
    assert.notEqual(c.signature, a.signature);
});

test('changing the profile changes the generated person', () => {
    const a = characterGen.generateRandomIdentity(77, { appearance: 'east_asian', age: 'young_adult', gender: 'woman' });
    const b = characterGen.generateRandomIdentity(77, { appearance: 'black_african_diaspora', age: 'older', gender: 'man' });
    assert.notEqual(a.signature, b.signature);
});

test('character control options always include Random plus the categories', () => {
    const options = characterGen.listProfileOptions();
    for (const key of ['appearance', 'age', 'gender']) {
        assert.equal(options[key][0].value, 'random');
        assert.ok(options[key].length > 1);
    }
    assert.ok(options.appearance.some((o) => o.value === 'east_asian'));
    assert.ok(options.age.some((o) => o.value === 'older'));
    assert.deepEqual(options.gender.map((o) => o.value), ['random', 'woman', 'man']);
});

test('generated identities never resemble a real celebrity', () => {
    const banned = ['scarlett', 'johansson', 'zendaya', 'bingbing', 'beyonc', 'kardashian',
        'jenner', 'hemsworth', 'gadot', 'dicaprio', 'robbie', 'timothee', 'rihanna',
        'taylor swift', 'margot', 'gal gadot'];
    for (let seed = 1; seed <= 300; seed++) {
        const id = characterGen.generateRandomIdentity(seed);
        const text = (id.identityText + ' ' + id.name).toLowerCase();
        for (const name of banned) {
            assert.ok(!text.includes(name), 'identity resembles ' + name + ': ' + text);
        }
    }
});

test('a profile-constrained random character saves and reuses as a preset', () => {
    const id = conversationId('save-profile');
    const session = playground.start({
        conversationId: id, themeId: 'lifestyle-candid', mode: 'random_character',
        profile: { appearance: 'latino_hispanic', age: 'adult', gender: 'man' },
        rng: characterGen.createRng(9)
    });
    const c = session.concept;
    assert.equal(c.characterProfile.appearance, 'latino_hispanic');
    assert.equal(c.characterProfile.age, 'adult');
    assert.equal(c.characterProfile.gender, 'man');
    assert.equal(c.identity.appearanceCategory, 'latino_hispanic');
    assert.equal(c.identity.ageGroup, 'adult');
    assert.equal(c.identity.gender, 'man');

    const preset = characterPresets.create({
        name: c.name, identity: c.subject, appearance: c.appearance, hair: c.hair, outfit: c.outfit, style: c.style
    });
    const loaded = characterPresets.get(preset.id);
    assert.equal(loaded.identity, c.subject);
    assert.equal(loaded.appearance, c.appearance);
    // Saving represents the person, not the generator controls.
    assert.equal(Object.prototype.hasOwnProperty.call(loaded, 'characterProfile'), false);
});

test('changing only the scene does not regenerate the character', () => {
    const id = conversationId('scene-only');
    const session = playground.start({
        conversationId: id, themeId: 'travel-adventure', mode: 'random_character',
        locks: { identity: true }, rng: characterGen.createRng(5)
    });
    const subject = session.concept.subject;
    const seed = session.concept.characterSeed;
    playground.modify(session, { locks: { environment: true }, changes: { environment: 'a quiet lakeside dock' } });
    assert.equal(session.concept.subject, subject);
    assert.equal(session.concept.characterSeed, seed);
    assert.equal(session.concept.environment, 'a quiet lakeside dock');
});

test('changing the character profile casts a new identity', () => {
    const id = conversationId('profile-change');
    const session = playground.start({
        conversationId: id, themeId: 'lifestyle-candid', mode: 'random_character',
        locks: { identity: true },
        profile: { appearance: 'random', age: 'random', gender: 'random' },
        rng: characterGen.createRng(1)
    });
    const before = session.concept.subject;
    playground.modify(session, { profile: { appearance: 'east_asian' }, rng: characterGen.createRng(2) });
    assert.equal(session.concept.characterProfile.appearance, 'east_asian');
    assert.notEqual(session.concept.subject, before);
});

test('a constrained profile still casts a character from "no character" mode', () => {
    const id = conversationId('profile-none-mode');
    const session = playground.start({
        conversationId: id, themeId: 'anything', mode: 'none',
        profile: { appearance: 'east_asian', age: 'older', gender: 'woman' },
        rng: characterGen.createRng(8)
    });
    assert.equal(session.mode, 'random_character');
    assert.equal(session.concept.characterProfile.appearance, 'east_asian');
    assert.equal(session.concept.identity.appearanceCategory, 'east_asian');
    assert.equal(session.concept.identity.ageGroup, 'older');
    assert.equal(session.concept.identity.gender, 'woman');
});

test('an identity lock keeps the same character across a scene reroll', () => {
    const theme = themes.getTheme('lifestyle-candid');
    const profile = { appearance: 'south_asian', age: 'young_adult', gender: 'woman' };
    const original = concept.assembleConcept({
        theme, mode: 'random_character', locks: {}, profile, rng: characterGen.createRng(21)
    });
    const rerolled = concept.assembleConcept({
        theme, mode: 'random_character', locks: { identity: true }, previous: original, profile,
        rng: characterGen.createRng(22)
    });
    assert.equal(rerolled.subject, original.subject);
    assert.equal(rerolled.characterSeed, original.characterSeed);
    assert.equal(rerolled.characterProfile.appearance, 'south_asian');
});

test('a legacy session without character controls still rerolls safely', () => {
    const id = conversationId('legacy-session');
    const session = playground.start({
        conversationId: id, themeId: 'lifestyle-candid', mode: 'random_character',
        rng: characterGen.createRng(3)
    });
    delete session.characterProfile;
    delete session.concept.characterProfile;
    delete session.concept.characterSeed;
    const next = playground.again(session, { rng: characterGen.createRng(4) });
    assert.ok(next.concept.subject.length > 0);
    assert.equal(next.concept.characterProfile.appearance, 'random');
});

// --- Context interpretation --------------------------------------------------

test('try another one means re-roll with the same settings', () => {
    const result = concept.interpretContextMessage('try another one', { open: true });
    assert.equal(result.action, 'again');
});

test('keep the outfit but make it a beach scene locks outfit and changes environment', () => {
    const result = concept.interpretContextMessage('Keep the outfit but make it a beach scene', { open: true });
    assert.equal(result.action, 'modify');
    assert.equal(result.locks.outfit, true);
    assert.match(result.changes.environment, /beach/i);
});

test('keep her hair but change the lighting to neon keeps hair locked', () => {
    const result = concept.interpretContextMessage('keep her hair but change the lighting to neon', { open: true });
    assert.equal(result.action, 'modify');
    assert.equal(result.locks.hair, true);
    assert.match(result.changes.lighting, /neon/i);
});

test('a theme name in the follow-up switches the theme', () => {
    const result = concept.interpretContextMessage('make it a cinematic noir scene', { open: true });
    assert.equal(result.action, 'modify');
    assert.equal(result.changes.themeId, 'cinematic-storytelling');
});

test('unrelated chat is not captured by the playground', () => {
    assert.equal(concept.interpretContextMessage('what is the weather today', { open: true }), null);
    assert.equal(concept.interpretContextMessage('try another one', { open: false }), null);
});

// --- Direction + constraints -------------------------------------------------

test('conceptToDirection describes the concept without leaking schema field names', () => {
    const theme = themes.getTheme('fashion-editorial');
    const built = concept.assembleConcept({ theme, mode: 'none', locks: {}, rng: first });
    const direction = concept.conceptToDirection(built);
    assert.ok(direction.includes('Creative direction:'));
    assert.ok(direction.includes('Camera and composition:'));
    assert.ok(!direction.includes('ending_motion_state'));
    assert.ok(!direction.includes('transition_from_previous'));
});

test('conceptToDirection and constraints carry the appearance category', () => {
    const theme = themes.getTheme('lifestyle-candid');
    const built = concept.assembleConcept({
        theme, mode: 'random_character',
        profile: { appearance: 'east_asian', age: 'adult', gender: 'woman' },
        rng: characterGen.createRng(11)
    });
    assert.equal(built.appearanceCategory, 'east_asian');
    assert.equal(built.appearanceCategoryLabel, 'East Asian');
    const direction = concept.conceptToDirection(built);
    assert.ok(direction.includes('Character appearance category: East Asian'));
    const constraints = concept.conceptToConstraints(built, { mode: 'random_character' });
    assert.ok(constraints.some((c) => /East Asian/.test(c)));
});

test('buildImageRequest forwards the appearance category to the prompt builder', () => {
    const id = conversationId('appearance-request');
    const session = playground.start({
        conversationId: id, themeId: 'lifestyle-candid', mode: 'random_character',
        profile: { appearance: 'south_asian', age: 'adult', gender: 'man' },
        rng: characterGen.createRng(12)
    });
    const request = playground.buildImageRequest(session);
    assert.ok(/Character appearance category: South Asian/.test(request.user_prompt));
    assert.ok(request.explicit_constraints.some((c) => /South Asian/.test(c)));
    const card = playground.buildCard(session, null);
    assert.equal(card.concept.appearanceCategoryLabel, 'South Asian');
});

test('conceptToConstraints carries locked attributes and identity', () => {
    const theme = themes.getTheme('fashion-editorial');
    const character = { identity: 'a violinist', appearance: 'a soft jawline', hair: 'a dark bob', outfit: 'a green coat' };
    const built = concept.assembleConcept({ theme, mode: 'character', character, locks: { outfit: true }, rng: first });
    const constraints = concept.conceptToConstraints(built, { mode: 'character', locks: { outfit: true } });
    assert.ok(constraints.some((c) => /violinist/.test(c)));
    assert.ok(constraints.some((c) => /green coat/.test(c)));
});

// --- Service lifecycle -------------------------------------------------------

test('start builds and persists an active concept session', () => {
    const id = conversationId('start');
    const session = playground.start({ conversationId: id, themeId: 'travel-adventure', mode: 'none', rng: first });
    assert.ok(session.id.startsWith('pg_'));
    assert.equal(session.status, 'preview');
    assert.ok(session.concept.title);
    const restored = playground.getSession(id);
    assert.equal(restored.id, session.id);
});

test('again re-rolls with the same character and locks', () => {
    const id = conversationId('again');
    const preset = characterPresets.create({ name: 'Nova', identity: 'a woman with silver hair', outfit: 'a white suit' });
    const session = playground.start({ conversationId: id, themeId: 'fashion-editorial', characterId: preset.id, locks: { outfit: true }, rng: first });
    const before = session.concept.title;
    const next = playground.again(session, { rng: () => 0.99 });
    assert.equal(next.concept.subject, session.concept.subject);
    assert.equal(next.concept.outfit, 'a white suit');
    assert.notEqual(next.concept.title, before);
});

test('modify applies a change while preserving locked attributes', () => {
    const id = conversationId('modify');
    const session = playground.start({ conversationId: id, themeId: 'lifestyle-candid', mode: 'none', locks: { outfit: true }, rng: first });
    const originalOutfit = session.concept.outfit;
    playground.modify(session, { locks: { environment: true }, changes: { environment: 'a sunlit beach' } });
    assert.equal(session.concept.outfit, originalOutfit);
    assert.equal(session.concept.environment, 'a sunlit beach');
    assert.equal(session.locks.environment, true);
});

test('rerollField draws a new value from the same theme pool, deterministically', () => {
    const theme = themes.getTheme('cinematic-storytelling');
    assert.ok(concept.REROLLABLE_FIELDS.includes('lighting'));
    const conceptObj = concept.assembleConcept({ themeId: 'cinematic-storytelling', mode: 'none', rng: () => 0.1 });
    const before = Object.assign({}, conceptObj);
    const out = concept.rerollField(conceptObj, theme, 'lighting', () => 0);
    assert.ok(out.lighting && out.lighting !== before.lighting);
    // Everything else is untouched.
    assert.equal(out.activity, before.activity);
    assert.equal(out.environment, before.environment);
    assert.equal(out.camera, before.camera);
    assert.equal(out.mood, before.mood);
    assert.equal(out.style, before.style);
    // Same draw = same result.
    const again = concept.rerollField(Object.assign({}, before), theme, 'lighting', () => 0);
    assert.equal(again.lighting, out.lighting);
});

test('rerollField is surgical: unknown fields and one-option pools are no-ops', () => {
    const theme = themes.getTheme('cinematic-storytelling');
    const conceptObj = concept.assembleConcept({ themeId: 'cinematic-storytelling', rng: first });
    assert.equal(concept.rerollField(conceptObj, theme, 'not-a-field', () => 0), conceptObj);
    assert.equal(concept.rerollField(null, theme, 'lighting'), null);
    // aspectRatio is always in the rerollable set and stays a valid ratio.
    concept.rerollField(conceptObj, theme, 'aspectRatio', () => 0);
    assert.ok(/^[0-9.]+:[0-9.]+$/.test(conceptObj.aspectRatio));
});

test('modify honours a per-field re-roll without re-rolling the scenario', () => {
    const id = conversationId('field-reroll');
    const session = playground.start({ conversationId: id, themeId: 'lifestyle-candid', mode: 'none', rng: first });
    const before = session.concept;
    const oldOutfit = before.outfit;
    playground.modify(session, { rerollField: 'scene', rng: first });
    assert.notEqual(session.revision, 1);
    // The outfit is untouched by a scene re-roll, and the identity keeps its line.
    assert.equal(session.concept.outfit, oldOutfit);
    assert.equal(session.concept.subject, before.subject);
    // Physics: the same centre-back reroll changes lighting only, never identity.
    playground.modify(session, { rerollField: 'mood', rng: first });
    assert.equal(session.concept.subject, before.subject);
    assert.equal(session.concept.outfit, oldOutfit);
});

test('buildImageRequest feeds the existing prompt builder with direction and constraints', () => {
    const id = conversationId('request');
    const preset = characterPresets.create({ name: 'Iris', identity: 'a botanist with round glasses' });
    const session = playground.start({ conversationId: id, themeId: 'seasonal-concepts', characterId: preset.id, locks: { identity: true }, rng: first });
    const request = playground.buildImageRequest(session);
    assert.equal(request.creative_mode, 'light');
    assert.ok(request.user_prompt.includes('Creative direction:'));
    assert.ok(request.explicit_constraints.some((c) => /botanist/.test(c)));
});

test('buildPortraitRequest is identity-only direction for the prompt builder', () => {
    const id = conversationId('portrait');
    const session = playground.start({
        conversationId: id, themeId: 'fashion-editorial', mode: 'random_character',
        profile: { appearance: 'black_african_diaspora', age: 'adult', gender: 'woman' },
        rng: characterGen.createRng(31)
    });
    const request = playground.buildPortraitRequest(session);
    assert.equal(request.creative_mode, 'light');
    assert.ok(/portrait/i.test(request.user_prompt));
    assert.ok(request.user_prompt.includes(session.concept.subject));
    assert.ok(request.user_prompt.includes(session.concept.appearanceCategoryLabel));
    assert.ok(request.explicit_constraints.some((c) => /this person/i.test(c)));
    // Identity-only: the scene/outfit must never leak into a face reference.
    assert.ok(!/Outfit:/i.test(request.user_prompt));
    assert.ok(!request.explicit_constraints.some((c) => /Preserve the outfit/i.test(c)));
});

test('needsCharacterImage pre-renders only fresh random characters and reuses an unchanged face', () => {
    const id = conversationId('needs-face');
    const random = playground.start({ conversationId: id, themeId: 'lifestyle-candid', mode: 'random_character', rng: characterGen.createRng(5) });
    assert.equal(playground.needsCharacterImage(random), true);

    const none = playground.start({ conversationId: id, themeId: 'lifestyle-candid', mode: 'none', rng: first });
    assert.equal(playground.needsCharacterImage(none), false);

    const preset = characterPresets.create({ name: 'FaceTest', identity: 'a woman with red hair' });
    const saved = playground.start({ conversationId: id, themeId: 'lifestyle-candid', characterId: preset.id, rng: first });
    assert.equal(playground.needsCharacterImage(saved), false);

    // Once a face exists for this identity it is reused (no re-render)...
    playground.setCharacterImage(random, { url: '/generated/face.png', width: 512, height: 512, seed: 7 });
    assert.equal(playground.needsCharacterImage(random), false);
    // ...until the person changes.
    random.concept.identitySignature = 'a-brand-new-person';
    assert.equal(playground.needsCharacterImage(random), true);
});

test('setCharacterImage persists a face and the card carries it', () => {
    const id = conversationId('face-card');
    const session = playground.start({ conversationId: id, themeId: 'travel-adventure', mode: 'random_character', rng: characterGen.createRng(9) });
    assert.equal(playground.buildCard(session, null).characterImage, null);
    playground.setCharacterImage(session, { url: '/generated/abc.png', width: 768, height: 768, seed: 42 });
    const card = playground.buildCard(session, null);
    assert.equal(card.characterImage.url, '/generated/abc.png');
    assert.equal(card.characterImage.seed, 42);
    // The face survives a reload.
    const restored = playground.getSession(id);
    assert.equal(restored.characterImage.url, '/generated/abc.png');
    assert.ok(restored.characterImage.identitySignature);
});

test('card payload survives a marker round-trip', () => {
    const id = conversationId('marker');
    const session = playground.start({ conversationId: id, themeId: 'fantasy-character-worlds', mode: 'random_character', rng: first });
    const content = playground.renderContent(session, null);
    const match = content.match(playground.MARKER_RE);
    assert.ok(match);
    const json = content.match(/\[\[playground:(\{[^\n]*?\})\]\]/);
    const card = JSON.parse(json[1]);
    assert.equal(card.id, session.id);
    assert.equal(card.themeId, 'fantasy-character-worlds');
    assert.ok(card.concept.environment);
});

test('normalizeAction accepts strings and objects and rejects unknown types', () => {
    assert.deepEqual(playground.normalizeAction('again').type, 'again');
    assert.equal(playground.normalizeAction({ type: 'generate', conceptId: 'x' }).conceptId, 'x');
    assert.equal(playground.normalizeAction('not-a-real-action'), null);
    assert.equal(playground.normalizeAction(null), null);
});

test('canonical generated characters round-trip with identity and base image ownership', () => {
    const identity = characterGen.generateRandomIdentity(90210, {
        appearance: 'south_asian', age: 'adult', gender: 'woman'
    });
    const saved = characterPresets.create({
        name: identity.name, identity, identityText: identity.identityText,
        identitySignature: identity.signature, provenance: { type: 'generated' }
    });
    const loaded = characterPresets.get(saved.id);
    assert.equal(loaded.schemaVersion, 2);
    assert.equal(loaded.identity.identitySignature, identity.signature);
    assert.equal(loaded.identity.ageGroup, identity.ageGroup);
    assert.equal(loaded.identity.appearanceCategory, 'south_asian');
    assert.equal(loaded.identity.gender, 'woman');
    characterPresets.setCandidateBaseImage(saved.id, { url: '/generated/portrait.png', filename: 'portrait.png' });
    assert.equal(characterPresets.get(saved.id).approvedBaseImage.filename, 'portrait.png');
    assert.equal(characterPresets.get(saved.id).approvedBaseImage.approvedAt, null);
    characterPresets.approveBaseImage(saved.id);
    assert.ok(characterPresets.get(saved.id).approvedBaseImage.approvedAt);
    assert.equal(characterStudio.resolveCharacter(saved.id).identity.hair.color, identity.hairColor);
});

test('scene rerolls retain the character snapshot and no-character scenes cannot become characters', () => {
    const id = conversationId('canonical-boundaries');
    const session = playground.start({ conversationId: id, themeId: 'anything', mode: 'random_character', rng: characterGen.createRng(71) });
    const snapshot = JSON.stringify(session.characterSnapshot);
    playground.again(session, { rng: characterGen.createRng(72) });
    assert.equal(JSON.stringify(session.characterSnapshot), snapshot);
    assert.throws(() => playground.save(
        playground.start({ conversationId: conversationId('none-save'), mode: 'none', rng: first }), null
    ), (error) => error.code === 'characterless_scene');
});

// --- Saved character + user's own prompt -------------------------------------

test('a saved character is rendered into the user\'s own prompt', () => {
    const id = conversationId('custom-prompt');
    const preset = characterPresets.create({
        name: 'Mara', identity: 'a woman with copper hair and green eyes',
        appearance: 'a soft jawline', hair: 'long copper hair'
    });
    const session = playground.start({
        conversationId: id, themeId: 'lifestyle-candid', characterId: preset.id,
        customPrompt: 'standing on a neon-lit Tokyo street at night', rng: first
    });
    assert.equal(session.concept.userPrompt, 'standing on a neon-lit Tokyo street at night');
    assert.equal(session.concept.subject, preset.identityText);
    // The randomised scene is dropped so it cannot contradict the user's prompt.
    assert.equal(session.concept.environment, '');
    assert.equal(session.concept.activity, '');
    assert.equal(session.concept.outfit, '');
    assert.ok(/User prompt \(follow this exactly\)/.test(concept.conceptToDirection(session.concept)));

    const request = playground.buildImageRequest(session);
    assert.equal(request.subject.identityText, preset.identityText);
    assert.ok(request.user_prompt.includes('standing on a neon-lit Tokyo street at night'));
    // The theme's scene guidance is skipped for a user prompt...
    assert.ok(!request.explicit_constraints.some((c) => /everyday phone snapshot/i.test(c)));
    // ...but the character identity stays authoritative.
    assert.ok(request.explicit_constraints.some((c) => /copper hair and green eyes/.test(c)));
});

test('a user prompt survives "Surprise Me Again" and a custom prompt with no character stays characterless', () => {
    const id = conversationId('custom-prompt-again');
    const session = playground.start({
        conversationId: id, themeId: 'anything', mode: 'none',
        customPrompt: 'a quiet library with tall windows', rng: first
    });
    playground.again(session, { rng: () => 0.9 });
    assert.equal(session.concept.userPrompt, 'a quiet library with tall windows');
    assert.equal(session.concept.subject, '');
    const request = playground.buildImageRequest(session);
    assert.equal(request.subject.identityText, '');
    assert.ok(request.user_prompt.includes('a quiet library with tall windows'));
});

// --- Lifestyle outfit variety (component system) -----------------------------

function instagramCategoryIds() {
    return themes.getTheme('lifestyle-candid').categories.map((c) => c.id);
}

test('Lifestyle & Candid generates substantially more outfits than its flat pool', () => {
    const theme = themes.getTheme('lifestyle-candid');
    const outfits = new Set();
    for (const categoryId of instagramCategoryIds()) {
        for (let seed = 1; seed <= 150; seed++) {
            outfits.add(themes.pickScenario(theme, characterGen.createRng(seed * 7919), categoryId).outfit);
        }
    }
    assert.ok(outfits.size > 400, 'expected a large combination space, got ' + outfits.size);
    assert.ok(outfits.size > theme.outfits.length * 4, 'composition should beat the flat pool');
});

test('Lifestyle silhouette variation is not just different colours', () => {
    const theme = themes.getTheme('lifestyle-candid');
    const silhouettes = new Set();
    for (const categoryId of instagramCategoryIds()) {
        for (let seed = 1; seed <= 150; seed++) {
            const scenario = themes.pickScenario(theme, characterGen.createRng(seed * 104729), categoryId);
            if (scenario.outfitSilhouette) silhouettes.add(scenario.outfitSilhouette);
        }
    }
    assert.ok(silhouettes.size > 12, 'expected many silhouettes, got ' + silhouettes.size);
    const list = [...silhouettes];
    assert.ok(list.some((s) => s.includes('oversized')), 'expected oversized looks');
    assert.ok(list.some((s) => s.includes('fitted')), 'expected fitted looks');
    assert.ok(list.some((s) => /separates\+.+\+skirt/.test(s)), 'expected skirt looks');
    assert.ok(list.some((s) => s.startsWith('layered')), 'expected layered looks');
    assert.ok(list.includes('dress') || list.includes('set'), 'expected one-piece looks');
});

test('Lifestyle subcategories only receive components tagged for them', () => {
    const theme = themes.getTheme('lifestyle-candid');
    const system = theme.outfitSystem;
    const slots = [
        ['top', 'tops'], ['bottom', 'bottoms'], ['onePiece', 'onePieces'],
        ['outerwear', 'outerwear'], ['shoes', 'shoes'], ['accessories', 'accessories']
    ];
    for (const category of theme.categories) {
        const eligible = {};
        for (const [, key] of slots) {
            eligible[key] = new Set(themes.eligibleComponents(system.components[key], category.outfitTags).map((e) => e.value));
        }
        for (let seed = 1; seed <= 40; seed++) {
            const composed = themes.composeOutfit(system, category, characterGen.createRng(seed * 97), { tags: category.outfitTags });
            assert.ok(composed.outfit, 'expected an outfit for ' + category.id);
            for (const [slot, key] of slots) {
                const value = composed.components[slot];
                if (!value) continue;
                assert.ok(eligible[key].has(value),
                    category.id + ' got an incompatible ' + slot + ': ' + value);
            }
        }
    }
});

test('gym scenarios use athletic clothing', () => {
    const theme = themes.getTheme('lifestyle-candid');
    const athletic = ['sports bra', 'athletic top', 'gym T-shirt', 'fitted tank', 'fitted T-shirt',
        'leggings', 'biker shorts', 'running shorts', 'matching athletic set', 'zip jacket',
        'athletic shorts', 'running shoes', 'zip-up hoodie'];
    const banned = /sundress|midi dress|floral|linen|skirt|blazer|heels|wide-leg jeans/i;
    for (let seed = 1; seed <= 120; seed++) {
        const scenario = themes.pickScenario(theme, characterGen.createRng(seed * 31), 'gym-fitness');
        assert.equal(scenario.categoryId, 'gym-fitness');
        assert.ok(athletic.some((token) => scenario.outfit.includes(token)), 'not athletic: ' + scenario.outfit);
        assert.ok(!banned.test(scenario.outfit), 'gym outfit drifted: ' + scenario.outfit);
    }
});

test('travel scenarios use vacation/summer clothing', () => {
    const theme = themes.getTheme('lifestyle-candid');
    const summer = ['linen', 'sundress', 'summer dress', 'dress', 'shorts', 'wide-leg', 'tank',
        'sandals', 'maxi skirt', 'cargo pants', 'button-up', 'shirt', 'sneakers', 'flats',
        'camisole', 'skirt', 'slides', 'flip-flops', 'running shoes'];
    const banned = /wool|winter|overcoat|tailored trousers|structured blazer|simple heels|satin|cozy cardigan/i;
    for (let seed = 1; seed <= 120; seed++) {
        const scenario = themes.pickScenario(theme, characterGen.createRng(seed * 37), 'travel');
        assert.equal(scenario.categoryId, 'travel');
        assert.ok(summer.some((token) => scenario.outfit.includes(token)), 'not a vacation look: ' + scenario.outfit);
        assert.ok(!banned.test(scenario.outfit), 'travel outfit drifted: ' + scenario.outfit);
    }
});

test('night-out scenarios stay evening-appropriate', () => {
    const theme = themes.getTheme('lifestyle-candid');
    for (let seed = 1; seed <= 80; seed++) {
        const scenario = themes.pickScenario(theme, characterGen.createRng(seed * 53), 'night-out');
        assert.ok(/trousers|jeans|denim|skirt|dress|top|blouse|camisole|blazer/i.test(scenario.outfit),
            'unexpected evening look: ' + scenario.outfit);
        assert.ok(!/bikini|swim|running shorts|sports bra|athletic set|lounge pants|sleep/i.test(scenario.outfit),
            'evening outfit is not tasteful/realistic: ' + scenario.outfit);
    }
});

test('consecutive Lifestyle Surprises do not repeat an exact outfit', () => {
    const id = conversationId('outfit-dup');
    const session = playground.start({
        conversationId: id, themeId: 'lifestyle-candid', mode: 'none', locks: {},
        rng: characterGen.createRng(1234)
    });
    assert.ok(session.concept.outfitSignature, 'expected an outfit signature');
    let previous = session.concept.outfitSignature;
    let repeats = 0;
    for (let i = 0; i < 25; i++) {
        playground.again(session, { rng: characterGen.createRng(5000 + i) });
        const signature = session.concept.outfitSignature;
        if (signature && signature === previous) repeats++;
        previous = signature;
    }
    assert.equal(repeats, 0, 'an exact outfit repeated ' + repeats + ' times');
    assert.ok(session.outfitSignatures.length > 1, 'outfit history should accumulate');
});

test('outfit tracking never changes the character identity', () => {
    const id = conversationId('outfit-identity');
    const preset = characterPresets.create({
        name: 'Ada', identity: 'a woman with auburn hair', appearance: 'a soft jawline', hair: 'a long braid'
    });
    const session = playground.start({
        conversationId: id, themeId: 'lifestyle-candid', characterId: preset.id, locks: {},
        rng: characterGen.createRng(11)
    });
    const subject = session.concept.subject;
    const appearance = session.concept.appearance;
    const hair = session.concept.hair;
    for (let i = 0; i < 8; i++) {
        playground.again(session, { rng: characterGen.createRng(70 + i) });
        assert.equal(session.concept.subject, subject);
        assert.equal(session.concept.appearance, appearance);
        assert.equal(session.concept.hair, hair);
    }
});

test('an identity lock survives an outfit-only reroll', () => {
    const theme = themes.getTheme('lifestyle-candid');
    const original = concept.assembleConcept({ theme, mode: 'random_character', locks: {}, rng: characterGen.createRng(21) });
    const rerolled = concept.assembleConcept({
        theme, mode: 'random_character', locks: { identity: true }, previous: original, rng: characterGen.createRng(22)
    });
    assert.equal(rerolled.subject, original.subject);
    assert.equal(rerolled.appearance, original.appearance);
});

test('a locked Lifestyle outfit is preserved across rerolls', () => {
    const id = conversationId('outfit-lock');
    const preset = characterPresets.create({ name: 'Ivy', identity: 'a woman with curly hair', outfit: 'a striped knit sweater' });
    const session = playground.start({
        conversationId: id, themeId: 'lifestyle-candid', characterId: preset.id, locks: { outfit: true },
        rng: characterGen.createRng(3)
    });
    assert.equal(session.concept.outfit, 'a striped knit sweater');
    for (let i = 0; i < 5; i++) {
        playground.again(session, { rng: characterGen.createRng(90 + i) });
        assert.equal(session.concept.outfit, 'a striped knit sweater');
        assert.equal(session.concept.subject, preset.identity);
    }
});

test('Lifestyle outfit vocabulary stays anti-editorial', () => {
    const theme = themes.getTheme('lifestyle-candid');
    const text = collectStrings(theme.outfitSystem).join(' \u0000 ').toLowerCase();
    for (const word of AI_SLOP_WORDS) {
        assert.ok(!text.includes(word), 'outfit system contains AI-slop word: ' + word);
    }
    assert.ok(!text.includes('editorial'), 'outfit system must not read as editorial');
});

test('Lifestyle outfit composition is deterministic for a seed', () => {
    const theme = themes.getTheme('lifestyle-candid');
    const a = themes.pickScenario(theme, characterGen.createRng(777), 'outfit-check');
    const b = themes.pickScenario(theme, characterGen.createRng(777), 'outfit-check');
    assert.deepEqual(a, b);
    const c1 = concept.assembleConcept({ theme, mode: 'random_character', locks: {}, rng: characterGen.createRng(888) });
    const c2 = concept.assembleConcept({ theme, mode: 'random_character', locks: {}, rng: characterGen.createRng(888) });
    assert.deepEqual(c1, c2);
});

// --- Lifestyle casual wardrobe expansion -------------------------------------

function instagramSystem() {
    return themes.getTheme('lifestyle-candid').outfitSystem;
}

function eligibleValues(key, categoryId) {
    const theme = themes.getTheme('lifestyle-candid');
    const category = theme.categories.find((c) => c.id === categoryId);
    return themes.eligibleComponents(theme.outfitSystem.components[key], category.outfitTags)
        .map((entry) => entry.value);
}

const EVERYDAY_TOP_RE = /tank|T-shirt|tee|camisole|sleeveless|crop top|polo|button-up|knit|cardigan|sweatshirt|hoodie/i;
const BASIC_BOTTOM_RE = /jeans|shorts|skirt|leggings|sweatpants|lounge pants|trousers|denim/i;
const STYLED_RE = /blazer|satin|tailored|varsity|bomber|heels|pleated/i;
const OUTERWEAR_RE = /jacket|blazer|flannel/i;

function sampleOutfits(categoryId, samples, multiplier = 7919) {
    const theme = themes.getTheme('lifestyle-candid');
    const outfits = [];
    for (let seed = 1; seed <= samples; seed++) {
        outfits.push(themes.pickScenario(theme, characterGen.createRng(seed * multiplier), categoryId).outfit);
    }
    return outfits;
}

test('Lifestyle tops pool is dominated by everyday casual pieces', () => {
    const tops = instagramSystem().components.tops;
    const everyday = tops.filter((t) => EVERYDAY_TOP_RE.test(t.value));
    assert.ok(tops.length >= 55, 'expected an expanded tops pool, got ' + tops.length);
    assert.ok(everyday.length >= 35, 'expected many everyday tops, got ' + everyday.length);
    // A healthy silhouette spread: not everything cropped or fitted.
    const silhouettes = new Set(tops.map((t) => t.silhouette));
    for (const shape of ['fitted', 'relaxed', 'oversized', 'cropped']) {
        assert.ok(silhouettes.has(shape), 'missing silhouette ' + shape);
    }
    // Everyday basics outweigh styled/evening pieces by weight.
    const weightOf = (t) => (Number(t.weight) > 0 ? Number(t.weight) : 1);
    const styled = tops.filter((t) => /satin|blouse|off-shoulder/i.test(t.value));
    const basicWeight = everyday.reduce((sum, t) => sum + weightOf(t), 0);
    const styledWeight = styled.reduce((sum, t) => sum + weightOf(t), 0);
    assert.ok(basicWeight > styledWeight * 4, 'everyday tops should dominate styled ones');
});

test('Lifestyle tank tops and basic T-shirts reach casual categories', () => {
    for (const categoryId of ['casual-selfie', 'mirror-selfie', 'outfit-check', 'bedroom-home']) {
        const tops = eligibleValues('tops', categoryId);
        const tanks = tops.filter((v) => /tank/i.test(v));
        const tees = tops.filter((v) => /T-shirt|tee/i.test(v));
        assert.ok(tanks.length >= 6, categoryId + ' needs tanks, got ' + tanks.length);
        assert.ok(tees.length >= 6, categoryId + ' needs T-shirts, got ' + tees.length);
    }
});

test('Lifestyle casual categories can draw casual shorts and jeans', () => {
    for (const categoryId of ['casual-selfie', 'mirror-selfie', 'outfit-check', 'street-city']) {
        const bottoms = eligibleValues('bottoms', categoryId);
        assert.ok(bottoms.some((v) => /shorts/i.test(v)), categoryId + ' has no shorts');
        assert.ok(bottoms.some((v) => /jeans/i.test(v)), categoryId + ' has no jeans');
    }
});

test('Lifestyle lounge categories can draw comfy clothing', () => {
    for (const categoryId of ['bedroom-home', 'morning-routine', 'beauty-skincare']) {
        const tops = eligibleValues('tops', categoryId);
        const bottoms = eligibleValues('bottoms', categoryId);
        assert.ok(tops.some((v) => /sleep T-shirt|hoodie|sweatshirt|cardigan|camisole/i.test(v)),
            categoryId + ' has no comfy tops');
        assert.ok(bottoms.some((v) => /lounge pants|sweatpants|leggings/i.test(v)),
            categoryId + ' has no comfy bottoms');
    }
});

test('Lifestyle casual silhouettes vary across simple separates', () => {
    const theme = themes.getTheme('lifestyle-candid');
    const silhouettes = new Set();
    for (let seed = 1; seed <= 200; seed++) {
        const scenario = themes.pickScenario(theme, characterGen.createRng(seed * 7919), 'casual-selfie');
        if (scenario.outfitSilhouette) silhouettes.add(scenario.outfitSilhouette);
    }
    assert.ok(silhouettes.size >= 8, 'expected varied casual silhouettes, got ' + silhouettes.size);
    const list = [...silhouettes];
    assert.ok(list.some((s) => s.includes('oversized')), 'expected oversized looks');
    assert.ok(list.some((s) => s.includes('fitted')), 'expected fitted looks');
    assert.ok(list.some((s) => s.includes('relaxed')), 'expected relaxed looks');
});

test('Lifestyle casual categories strongly favour casual clothing', () => {
    const casualCategories = ['casual-selfie', 'mirror-selfie', 'outfit-check', 'cafe-coffee',
        'bedroom-home', 'street-city', 'beauty-skincare', 'morning-routine'];
    const samples = 400;
    for (const categoryId of casualCategories) {
        const outfits = sampleOutfits(categoryId, samples);
        const styled = outfits.filter((o) => STYLED_RE.test(o)).length;
        const outer = outfits.filter((o) => OUTERWEAR_RE.test(o)).length;
        const simple = outfits.filter((o) => EVERYDAY_TOP_RE.test(o) && BASIC_BOTTOM_RE.test(o) && !OUTERWEAR_RE.test(o)).length;
        assert.ok(styled / samples < 0.12, categoryId + ' leans too styled: ' + styled + '/' + samples);
        assert.ok(outer / samples < 0.25, categoryId + ' overuses outerwear: ' + outer + '/' + samples);
        assert.ok(simple / samples > 0.35, categoryId + ' rarely produces simple looks: ' + simple + '/' + samples);
    }
});

test('Night Out can still produce dressier outfits', () => {
    const dressy = /blazer|satin|heels|dress|tailored|blouse|trousers|camisole/i;
    const samples = 200;
    const outfits = sampleOutfits('night-out', samples, 53);
    const count = outfits.filter((o) => dressy.test(o)).length;
    assert.ok(count / samples > 0.15, 'Night Out should still produce dressy looks: ' + count + '/' + samples);
});

test('Lifestyle accessories are optional, not mandatory', () => {
    const samples = 400;
    const outfits = sampleOutfits('casual-selfie', samples);
    const values = eligibleValues('accessories', 'casual-selfie');
    const withAccessory = outfits.filter((o) => values.some((v) => o.includes(v))).length;
    const rate = withAccessory / samples;
    assert.ok(rate > 0.05, 'some outfits should still include an accessory');
    assert.ok(rate < 0.7, 'accessories should not be mandatory: ' + Math.round(rate * 100) + '%');
});

test('Lifestyle casual footwear favours sneakers over heels', () => {
    const samples = 400;
    const outfits = sampleOutfits('casual-selfie', samples);
    const heels = outfits.filter((o) => /heels/i.test(o)).length;
    const casualShoes = outfits.filter((o) => /sneakers|sandals|flats|slides|flip-flops/i.test(o)).length;
    assert.ok(heels / samples < 0.05, 'casual categories should rarely use heels: ' + heels + '/' + samples);
    assert.ok(casualShoes / samples > 0.3, 'expected plenty of sneakers/sandals: ' + casualShoes + '/' + samples);
});

// --- Experimental Photography ------------------------------------------------

function experimentalTheme() {
    return themes.getTheme('experimental-photography');
}

function experimentalScenario(seed, multiplier = 7919) {
    return themes.pickScenario(experimentalTheme(), characterGen.createRng(seed * multiplier));
}

test('Experimental Photography has a broad, mixed environment pool', () => {
    const theme = experimentalTheme();
    assert.ok(theme.environments.length >= 20, 'environment pool too small: ' + theme.environments.length);
    const text = theme.environments.join(' | ').toLowerCase();
    for (const token of ['minimal', 'brightly lit', 'parking structure', 'subway', 'rooftop', 'concrete', 'gallery', 'neon', 'tunnel']) {
        assert.ok(text.includes(token), 'missing environment type: ' + token);
    }
    // Not every environment is dark or mysterious.
    const bright = theme.environments.filter((e) => /bright|gallery|white|minimal|sunlight|daylight|convenience/i.test(e));
    assert.ok(bright.length >= 5, 'expected bright/minimal environments');
});

test('Experimental Photography has a broad camera technique pool', () => {
    const theme = experimentalTheme();
    assert.ok(theme.cameras.length >= 35, 'camera pool too small: ' + theme.cameras.length);
    const text = theme.cameras.join(' | ').toLowerCase();
    for (const token of ['motion blur', 'panning', 'fisheye', 'double exposure', 'reflection', 'prism', 'textured glass', 'underexposure']) {
        assert.ok(text.includes(token), 'missing camera technique: ' + token);
    }
    assert.ok(theme.compositions.length >= 8, 'expected a composition pool');
    assert.ok(theme.textures.length >= 12, 'expected a texture/material pool');
});

test('Experimental Photography exposes the expected technique categories', () => {
    const ids = experimentalTheme().techniques.map((t) => t.id);
    for (const id of ['motion-blur', 'panning', 'light-trails', 'strobe', 'prism', 'reflection',
        'projection', 'shadow-play', 'double-exposure', 'distortion', 'texture', 'silhouette', 'light-play']) {
        assert.ok(ids.includes(id), 'missing technique ' + id);
    }
});

test('Experimental Photography covers motion, reflection, prism, projection, exposure and texture', () => {
    const theme = experimentalTheme();
    const cameras = theme.cameras.join(' ').toLowerCase();
    const lighting = theme.lighting.join(' ').toLowerCase();
    const environments = theme.environments.join(' ').toLowerCase();
    assert.ok(/motion blur|slow shutter|panning|vertical camera movement|rotational camera movement/.test(cameras), 'no motion technique');
    assert.ok(/reflection|mirror/.test(cameras), 'no reflection technique');
    assert.ok(/prism/.test(cameras), 'no prism technique');
    assert.ok(/projected/.test(lighting + ' ' + environments), 'no projection technique');
    assert.ok(/shadow/.test(lighting + ' ' + environments), 'no shadow technique');
    assert.ok(/double exposure|multiple exposure/.test(cameras), 'no double/multiple exposure technique');
    assert.ok(/textured glass|translucent fabric|rain-covered glass/.test(cameras), 'no texture/material camera technique');
});

test('Experimental Photography can generate many different techniques', () => {
    const ids = new Set();
    for (let seed = 1; seed <= 200; seed++) ids.add(experimentalScenario(seed).technique);
    assert.ok(ids.size >= 10, 'expected many techniques, got ' + ids.size);
});

test('Experimental Photography does not always lean on gels, smoke, mirrors or long exposure', () => {
    const theme = experimentalTheme();
    const classic = /gel|smoke|mirror|long exposure/i;
    let count = 0;
    const samples = 300;
    for (let seed = 1; seed <= samples; seed++) {
        const s = experimentalScenario(seed);
        if (classic.test([s.camera, s.lighting, s.environment, s.techniqueLabel].join(' '))) count++;
    }
    assert.ok(count / samples < 0.6, 'classic effects dominate: ' + count + '/' + samples);
    // They stay available, just not the default.
    const poolText = [...theme.cameras, ...theme.lighting, ...theme.environments].join(' ').toLowerCase();
    for (const token of ['gel', 'smoke', 'mirror', 'long exposure']) {
        assert.ok(poolText.includes(token), 'classic technique removed: ' + token);
    }
});

test('Experimental Photography picks one coherent technique per concept', () => {
    const theme = experimentalTheme();
    const byId = new Map(theme.techniques.map((t) => [t.id, t]));
    for (let seed = 1; seed <= 200; seed++) {
        const s = experimentalScenario(seed);
        const technique = byId.get(s.technique);
        assert.ok(technique, 'unknown technique ' + s.technique);
        assert.equal(s.techniqueLabel, technique.label);
        assert.ok(technique.cameras.includes(s.camera), 'camera not from technique: ' + s.camera);
        assert.ok(technique.lighting.includes(s.lighting), 'lighting not from technique: ' + s.lighting);
        assert.ok(technique.activities.includes(s.activity), 'activity not from technique: ' + s.activity);
        assert.ok(technique.environments.includes(s.environment), 'environment not from technique: ' + s.environment);
        const textures = technique.textures.length ? technique.textures : theme.textures;
        assert.ok(textures.includes(s.texture), 'texture not from technique: ' + s.texture);
    }
});

test('Experimental Photography composition is deterministic for a seed', () => {
    assert.deepEqual(experimentalScenario(4242), experimentalScenario(4242));
    const theme = experimentalTheme();
    const a = concept.assembleConcept({ theme, mode: 'none', locks: {}, rng: characterGen.createRng(99) });
    const b = concept.assembleConcept({ theme, mode: 'none', locks: {}, rng: characterGen.createRng(99) });
    assert.deepEqual(a, b);
});

test('Experimental Photography environment and style locks are preserved', () => {
    const theme = experimentalTheme();
    const previous = concept.assembleConcept({ theme, mode: 'none', locks: {}, rng: characterGen.createRng(7) });
    const locked = concept.assembleConcept({
        theme, mode: 'none', locks: { environment: true, style: true }, previous, rng: characterGen.createRng(8)
    });
    assert.equal(locked.environment, previous.environment);
    assert.equal(locked.style, previous.style);
});

test('Experimental Photography vocabulary stays non-generic', () => {
    const text = collectStrings(experimentalTheme()).join(' \u0000 ').toLowerCase();
    const banned = ['highly detailed', 'masterpiece', 'cinematic', 'photorealistic',
        'professional photography', 'perfect composition', 'ultra realistic', '8k',
        'hyperrealistic', 'breathtaking'];
    for (const word of banned) {
        assert.ok(!text.includes(word), 'theme contains generic AI word: ' + word);
    }
});

test('Experimental technique reaches the creative direction', () => {
    const theme = experimentalTheme();
    const built = concept.assembleConcept({ theme, mode: 'none', locks: {}, rng: characterGen.createRng(11) });
    assert.ok(built.technique, 'expected a technique id');
    assert.ok(built.techniqueLabel, 'expected a technique label');
    const direction = concept.conceptToDirection(built);
    assert.ok(direction.includes(built.techniqueLabel), 'direction should name the technique');
});
