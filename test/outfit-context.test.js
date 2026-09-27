/* ============================================
   JARVIS — Environment-aware outfit tests
   Covers the central outfit/environment resolver,
   the clothing context metadata, the environment
   context tags, the new Confident & Seductive pack
   and the required behaviour matrix (bedroom / cafe /
   gym / beach / explicit clothing preservation /
   partial fills / multi-character independence /
   continuity). The state stores are pointed at temp
   files so nothing in data/ is touched.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-outfit-context-'));
process.env.PLAYGROUND_STATE_PATH = path.join(tmpDir, 'playground-state.json');
process.env.CHARACTER_PRESETS_PATH = path.join(tmpDir, 'character-presets.json');
process.env.CHARACTER_CONTEXT_PATH = path.join(tmpDir, 'character-context.json');

const outfitContext = require('../services/playground/outfit-context');
const outfitPacks = require('../services/playground/outfit-packs');
const creativeDefaults = require('../services/creative-defaults');
const characterGen = require('../services/playground/character');
const characterPresets = require('../services/character-presets');

const first = () => 0;
let counter = 0;

function conversationId(name) {
    counter += 1;
    return 'outfit-context-' + name + '-' + counter + '-' + Date.now();
}

function makeApproved(name, identity) {
    const character = characterPresets.create(Object.assign({ name }, identity ? { identity } : {}));
    characterPresets.setCandidateBaseImage(character.id, {
        url: '/generated/' + name.toLowerCase() + '-base.png',
        filename: name.toLowerCase() + '-base.png'
    });
    characterPresets.approveBaseImage(character.id);
    return characterPresets.get(character.id);
}

function contextId(environment) {
    const ctx = outfitContext.classifyEnvironment(environment);
    return ctx ? ctx.id : '';
}

function assertFootwearAllowed(composed, environment) {
    const shoes = composed.components && composed.components.shoes;
    if (!shoes) return;
    const category = outfitContext.footwearCategory(shoes);
    if (!category) return;
    const ctx = outfitContext.classifyEnvironment(environment);
    assert.ok(ctx && ctx.allowedFootwear.includes(category),
        contextId(environment) + ' left incompatible footwear "' + shoes + '" (' + category + ')');
}

// --- Environment context tags -------------------------------------------------

test('environment contexts expose lightweight tags and footwear policy', () => {
    const bedroom = outfitContext.classifyEnvironment('a cosy bedroom');
    assert.equal(bedroom.id, 'bedroom');
    assert.ok(bedroom.tags.includes('indoor') && bedroom.tags.includes('private'));
    assert.ok(bedroom.tags.includes('barefoot-friendly'));
    assert.deepEqual(bedroom.allowedFootwear, ['barefoot', 'socks', 'slippers']);

    const cafe = outfitContext.classifyEnvironment('sitting in a cafe');
    assert.equal(cafe.id, 'cafe');
    assert.ok(cafe.tags.includes('social') && cafe.tags.includes('public'));
    assert.ok(cafe.allowedFootwear.includes('trainers'));

    const gym = outfitContext.classifyEnvironment('at the gym');
    assert.equal(gym.id, 'gym');
    assert.ok(gym.tags.includes('active') && gym.tags.includes('exercise'));
    assert.deepEqual(gym.allowedFootwear, ['trainers']);

    const beach = outfitContext.classifyEnvironment('on the beach');
    assert.equal(beach.id, 'beach');
    assert.ok(beach.tags.includes('hot') && beach.tags.includes('barefoot-friendly'));
    assert.ok(beach.allowedFootwear.includes('barefoot'));

    const office = outfitContext.classifyEnvironment('at the office');
    assert.equal(office.id, 'office');
    assert.ok(office.tags.includes('professional') && office.tags.includes('formal'));
    assert.ok(office.allowedFootwear.includes('formal'));
});

test('an abstract scene classifies to no environment (resolver no-op)', () => {
    assert.equal(outfitContext.classifyEnvironment('a dreamy abstract portrait'), null);
    assert.equal(outfitContext.classifyEnvironment(''), null);
});

test('a getting-ready activity overrides the room it happens in', () => {
    assert.equal(outfitContext.classifyEnvironment('in her bedroom', 'getting ready for a date').id, 'date_night');
    assert.equal(outfitContext.classifyEnvironment('in her bedroom', 'lying on the bed reading').id, 'bedroom');
});

// --- Clothing context metadata ------------------------------------------------

test('clothing metadata is inferred lightly and the named example is explicit', () => {
    const sneakers = outfitContext.pieceMetadata('clean white sneakers');
    assert.equal(sneakers.category, 'footwear');
    assert.ok(sneakers.avoidContexts.includes('bedroom'));

    const example = outfitContext.pieceMetadata('white sneakers');
    assert.equal(example.category, 'footwear');
    assert.ok(example.contexts.includes('cafe'));
    assert.ok(example.compatibleContexts.includes('casual'));
    assert.ok(example.avoidContexts.includes('bedroom'));
    assert.ok(example.substitutes.includes('barefoot'));

    assert.equal(outfitContext.pieceMetadata('a black leather jacket').category, 'outerwear');
    assert.equal(outfitContext.pieceMetadata('classic blue jeans').category, 'bottom');
    assert.equal(outfitContext.pieceMetadata('a satin camisole').category, 'top');
    assert.equal(outfitContext.pieceMetadata('a fitted midi dress').category, 'onePiece');
});

test('compatible pieces drop context-incompatible entries without emptying a slot', () => {
    const bedroom = outfitContext.classifyEnvironment('a bedroom');
    const pool = [
        { value: 'a wool coat', weight: 1 },
        { value: 'a lightweight cardigan', weight: 1 },
        { value: 'a hoodie', weight: 1 }
    ];
    const filtered = outfitContext.compatiblePieces(pool, bedroom);
    assert.ok(!filtered.some((entry) => /wool coat/.test(entry.value)));
    assert.ok(filtered.length > 0);

    const allBad = [{ value: 'sneakers', weight: 1 }];
    assert.equal(outfitContext.compatiblePieces(allBad, bedroom).length, 1, 'a slot is never emptied');
});

// --- The required behaviour matrix --------------------------------------------

function compose(packId, seed, environment, options = {}) {
    return outfitPacks.composeFromPack(packId, characterGen.createRng(seed), Object.assign({ environment }, options));
}

test('1. Casual Everyday + Bedroom adapts footwear to the room', () => {
    for (let seed = 1; seed <= 30; seed++) {
        const composed = compose('casual-everyday', seed, 'a cosy bedroom');
        assert.equal(composed.environment, 'bedroom');
        assertFootwearAllowed(composed, 'a cosy bedroom');
    }
});

test('2. Casual Everyday + Cafe keeps the outfit (no unnecessary sanitizing)', () => {
    for (let seed = 1; seed <= 30; seed++) {
        const plain = outfitPacks.composeFromPack('casual-everyday', characterGen.createRng(seed));
        const cafe = compose('casual-everyday', seed, 'a cafe');
        assert.equal(cafe.outfit, plain.outfit, 'cafe should not restyle an already-appropriate outfit');
        assert.equal(cafe.adaptations.length, 0);
    }
});

test('3. Casual Everyday + Gym guarantees athletic footwear', () => {
    for (let seed = 1; seed <= 30; seed++) {
        const composed = compose('casual-everyday', seed, 'the gym');
        assert.equal(composed.environment, 'gym');
        assertFootwearAllowed(composed, 'the gym');
    }
});

test('4. Casual Everyday + Beach guarantees barefoot-friendly footwear', () => {
    for (let seed = 1; seed <= 30; seed++) {
        const composed = compose('casual-everyday', seed, 'a sunny beach');
        assert.ok(['beach', 'resort'].includes(composed.environment));
        assertFootwearAllowed(composed, 'a sunny beach');
    }
});

test('5. Confident & Seductive + Date Night keeps an evening look', () => {
    for (let seed = 1; seed <= 30; seed++) {
        const composed = compose('confident-seductive', seed, 'date night', { gender: 'woman' });
        assert.ok(composed.outfit, 'expected an outfit');
        assert.equal(composed.environment, 'date_night');
        assertFootwearAllowed(composed, 'date night');
        // The household/casual pack is never silently substituted in.
        assert.ok(!/sweatpants|joggers|slippers/i.test(composed.outfit));
    }
});

test('6. Confident & Seductive + Bedroom adapts the styling, not the person', () => {
    for (let seed = 1; seed <= 30; seed++) {
        const composed = compose('confident-seductive', seed, 'a cosy bedroom', { gender: 'woman' });
        assert.equal(composed.environment, 'bedroom');
        assertFootwearAllowed(composed, 'a cosy bedroom');
        assert.ok(!/\b(?:stilettos?|pumps?|heels?)\b/i.test(composed.outfit),
            'heels should not survive into a bedroom scene: ' + composed.outfit);
    }
});

test('7. Explicit sneakers + Bedroom are preserved', () => {
    const result = outfitContext.resolveOutfitForEnvironment(
        { outfit: 'a fitted top with jeans and clean white sneakers', components: { top: 'a fitted top', bottom: 'jeans', shoes: 'clean white sneakers' } },
        'a bedroom',
        { rng: first, explicit: { footwear: true } }
    );
    assert.equal(result.components.shoes, 'clean white sneakers');
    assert.equal(result.adaptations.length, 0);

    // ...and through the higher-level auto-fill the explicit slot is not filled.
    const jules = makeApproved('Jules', { gender: 'woman' });
    const built = creativeDefaults.buildCreativeDefaults([jules], {
        rawPrompt: '@Jules in her bedroom wearing white sneakers',
        scenePrompt: 'in her bedroom wearing white sneakers',
        environment: 'in her bedroom',
        seed: 3
    });
    assert.equal(built.explicitSlots.footwear, true);
    assert.doesNotMatch(built.clothing[0].outfit, /\b(?:sneakers|boots|heels|sandals|slippers|barefoot|flats)\b/i);
});

test('8. Explicit barefoot + Cafe are preserved', () => {
    const result = outfitContext.resolveOutfitForEnvironment(
        { outfit: 'a dress and barefoot', components: { onePiece: 'a dress', shoes: 'barefoot' } },
        'a cafe',
        { rng: first, explicit: { footwear: true } }
    );
    assert.equal(result.components.shoes, 'barefoot');
    assert.equal(result.adaptations.length, 0);

    // Through the auto-fill the user's "barefoot" is never overridden by shoes.
    const jules = makeApproved('Jules', { gender: 'woman' });
    const built = creativeDefaults.buildCreativeDefaults([jules], {
        rawPrompt: '@Jules barefoot in a cafe',
        scenePrompt: 'barefoot in a cafe',
        environment: 'in a cafe',
        seed: 6
    });
    assert.equal(built.explicitSlots.footwear, true);
    assert.doesNotMatch(built.clothing[0].outfit, /\b(?:sneakers|boots|heels|sandals|flats|slippers)\b/i);
});

test('9. Explicit dress + Gym is preserved', () => {
    const jules = makeApproved('Jules', { gender: 'woman' });
    const built = creativeDefaults.buildCreativeDefaults([jules], {
        rawPrompt: '@Jules at the gym wearing a black dress',
        scenePrompt: 'at the gym wearing a black dress',
        environment: 'at the gym',
        seed: 2
    });
    assert.equal(built.explicitSlots.dress, true);
    assert.equal(built.partial, false);
    assert.equal(built.clothing.length, 0, 'the explicit dress is never replaced by gym clothing');
});

test('10. No Outfit Pack + Bedroom yields a sensible default wardrobe', () => {
    const jules = makeApproved('Jules', { gender: 'woman' });
    const built = creativeDefaults.buildCreativeDefaults([jules], {
        rawPrompt: '@Jules in her bedroom',
        scenePrompt: 'in her bedroom',
        environment: 'in her bedroom',
        seed: 5
    });
    assert.equal(built.clothing.length, 1);
    assert.equal(built.clothing[0].packId, 'lounge-home');
    assert.ok(built.clothing[0].outfit.length > 0);
});

test('11. A partial outfit instruction fills the missing pieces contextually', () => {
    const jules = makeApproved('Jules', { gender: 'woman' });
    const built = creativeDefaults.buildCreativeDefaults([jules], {
        rawPrompt: '@Jules sitting on her bed wearing a white crop top',
        scenePrompt: 'sitting on her bed wearing a white crop top',
        environment: 'in her bedroom',
        seed: 4
    });
    assert.equal(built.partial, true);
    assert.equal(built.explicitSlots.top, true);
    assert.equal(built.clothing.length, 1);
    // Only the missing pieces are filled; the named top is never re-created.
    assert.doesNotMatch(built.clothing[0].outfit, /\bcrop top\b/i);
    assert.match(built.clothing[0].outfit, /\b(?:shorts|trousers|pants|jeans|skirt|leggings|slippers|socks|barefoot|shoes)\b/i);
});

test('12. Multi-character scenes resolve each outfit independently', () => {
    const jules = makeApproved('Jules', { gender: 'woman' });
    const quinn = makeApproved('Quinn', { gender: 'man' });
    const built = creativeDefaults.buildCreativeDefaults([jules, quinn], {
        rawPrompt: '@Jules and @Quinn standing in a bedroom',
        scenePrompt: 'standing in a bedroom',
        environment: 'in a bedroom',
        seed: 12
    });
    assert.equal(built.clothing.length, 2);
    assert.notEqual(built.clothing[0].outfit.toLowerCase(), built.clothing[1].outfit.toLowerCase());
    for (const item of built.clothing) {
        assert.ok(!/\b(?:dress|skirt|camisole)\b/i.test(item.outfit) || item.name === 'Jules');
    }
});

test('13. Existing outfit continuity keeps the outfit stable', () => {
    const jules = makeApproved('Jules', { gender: 'woman' });
    const firstBuild = creativeDefaults.buildCreativeDefaults([jules], {
        rawPrompt: '@Jules lying on her bed',
        scenePrompt: 'lying on her bed',
        environment: 'in her bedroom',
        seed: 8
    });
    const followUp = creativeDefaults.buildCreativeDefaults([jules], {
        rawPrompt: 'change the lighting to warm lamp light',
        scenePrompt: 'change the lighting to warm lamp light',
        environment: 'in her bedroom',
        seed: 999,
        continuity: true,
        previousClothing: firstBuild.clothing,
        previousStyle: firstBuild.style
    });
    assert.deepEqual(followUp.clothing.map((c) => c.outfit), firstBuild.clothing.map((c) => c.outfit));
});

// --- Determinism --------------------------------------------------------------

test('the resolver is deterministic for the same input and rng', () => {
    const input = { outfit: 'a basic white T-shirt with classic blue jeans and clean white sneakers', components: { top: 'a basic white T-shirt', bottom: 'classic blue jeans', shoes: 'clean white sneakers' } };
    const a = outfitContext.resolveOutfitForEnvironment(input, 'a bedroom', { rng: characterGen.createRng(42) });
    const b = outfitContext.resolveOutfitForEnvironment(input, 'a bedroom', { rng: characterGen.createRng(42) });
    assert.deepEqual(a, b);

    const c = compose('confident-seductive', 7, 'a cafe', { gender: 'woman' });
    const d = compose('confident-seductive', 7, 'a cafe', { gender: 'woman' });
    assert.deepEqual(c, d);
});

// --- Debug visibility ---------------------------------------------------------

test('debug resolution formats the adaptation report', () => {
    const resolved = outfitContext.resolveOutfitForEnvironment(
        { outfit: 'a basic white T-shirt with classic blue jeans and clean white sneakers', components: { top: 'a basic white T-shirt', bottom: 'classic blue jeans', shoes: 'clean white sneakers' } },
        'a cosy bedroom',
        { rng: first, packLabel: 'Casual Everyday' }
    );
    const report = outfitContext.formatResolution(resolved.resolution);
    assert.match(report, /Selected Outfit Pack: Casual Everyday/);
    assert.match(report, /Environment: Bedroom/);
    assert.match(report, /Initial Outfit:/);
    assert.match(report, /Adaptations:/);
    assert.match(report, /clean white sneakers/);
    assert.match(report, /Final Outfit:/);
    // The image prompt never carries the decision logic.
    assert.ok(!/category=|avoidContexts/.test(report));
});

// --- The Confident & Seductive pack ------------------------------------------

test('the Confident & Seductive pack is a wardrobe personality with context metadata', () => {
    const pack = outfitPacks.getPack('confident-seductive');
    assert.ok(pack, 'expected the new pack');
    assert.equal(pack.label, 'Confident & Seductive');
    for (const slot of ['tops', 'bottoms', 'dresses', 'layers', 'footwear', 'accessories']) {
        assert.ok(Array.isArray(pack.wardrobe[slot]) && pack.wardrobe[slot].length, 'missing ' + slot);
    }
    for (const value of pack.wardrobe.footwear.map((e) => e.value)) {
        assert.ok(/boots|sandals|pumps|flats/i.test(value), 'unexpected footwear: ' + value);
    }
    // Tasteful adult styling, never explicit wording in the wardrobe itself.
    const text = JSON.stringify(pack.wardrobe).toLowerCase();
    assert.ok(!/lingerie|nude|topless|nsfw|explicit sexual/.test(text));
});

test('detectOutfitPackFromText recognizes confident fashion wording', () => {
    assert.equal(outfitPacks.detectOutfitPackFromText('a confident, attractive look'), 'confident-seductive');
    assert.equal(outfitPacks.detectOutfitPackFromText('something chic and fashion-forward'), 'confident-seductive');
    // Existing sultry/boudoir wording still maps to Glam & Boudoir.
    assert.equal(outfitPacks.detectOutfitPackFromText('a seductive look for tonight'), 'glam-boudoir');
});
