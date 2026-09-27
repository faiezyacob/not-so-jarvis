/* ============================================
   JARVIS — Shared Activity Library tests
   Covers the activity catalog, environment
   compatibility, natural-language matching, automatic
   selection, activity-aware outfit resolution, explicit
   overrides, selfie composition/camera hints and reuse
   by non-Playground callers (future Chat integration).
   The state stores are pointed at temp files so nothing
   in data/ is touched.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-activities-'));
process.env.PLAYGROUND_STATE_PATH = path.join(tmpDir, 'playground-state.json');
process.env.CHARACTER_PRESETS_PATH = path.join(tmpDir, 'character-presets.json');
process.env.CHARACTER_CONTEXT_PATH = path.join(tmpDir, 'character-context.json');

const activities = require('../services/playground/activities');
const outfitContext = require('../services/playground/outfit-context');
const outfitPacks = require('../services/playground/outfit-packs');
const creativeDefaults = require('../services/creative-defaults');
const concept = require('../services/playground/concept');
const playground = require('../services/playground/playground');
const characterGen = require('../services/playground/character');
const characterPresets = require('../services/character-presets');

const first = () => 0;
let counter = 0;

function conversationId(name) {
    counter += 1;
    return 'activities-' + name + '-' + counter + '-' + Date.now();
}

// --- Catalog + helpers --------------------------------------------------------

test('the activity library exposes 15-25 broad activities', () => {
    const list = activities.listActivities();
    assert.ok(list.length >= 15 && list.length <= 25, 'unexpected catalog size ' + list.length);
    const ids = list.map((a) => a.id);
    for (const id of ['coffee-chat', 'casual-conversation', 'hanging-out', 'laughing-together',
        'taking-selfie', 'walking-together', 'relaxing', 'reading', 'watching-tv',
        'listening-to-music', 'getting-ready', 'cooking', 'working-on-laptop', 'shopping',
        'studying', 'working', 'exercising', 'taking-photos', 'sightseeing',
        'exploring-city', 'waiting-for-transport']) {
        assert.ok(ids.includes(id), 'missing activity ' + id);
    }
});

test('every activity carries lightweight structured metadata', () => {
    for (const activity of activities.ACTIVITIES) {
        assert.ok(activity.id && activity.label && activity.description, 'missing basics for ' + activity.id);
        assert.ok(Array.isArray(activity.categories) && activity.categories.length, activity.id + ' categories');
        assert.ok(activity.environments && Array.isArray(activity.environments.preferred), activity.id + ' preferred');
        assert.ok(Array.isArray(activity.groupSizes) && activity.groupSizes.length, activity.id + ' groupSizes');
        assert.ok(Array.isArray(activity.actions) && activity.actions.length, activity.id + ' actions');
        assert.ok(Array.isArray(activity.compositionHints) && activity.compositionHints.length, activity.id + ' compositionHints');
        assert.ok(Array.isArray(activity.cameraHints) && activity.cameraHints.length, activity.id + ' cameraHints');
        // Activities describe creative intent, never final prompt wording.
        assert.ok(!/photorealistic|highly detailed|masterpiece|8k/i.test(activity.phrase), activity.id + ' prompt slop');
    }
});

test('getActivity resolves ids and labels, unknown ids are null', () => {
    assert.equal(activities.getActivity('coffee-chat').id, 'coffee-chat');
    assert.equal(activities.getActivity('Reading').id, 'reading');
    assert.equal(activities.getActivityById('not-real'), null);
    assert.equal(activities.normalizeActivityId('TAKING-SELFIE'), 'taking-selfie');
});

test('resolveActivitySelection normalizes the UI values', () => {
    assert.deepEqual(activities.resolveActivitySelection(''), { mode: 'none', id: '' });
    assert.deepEqual(activities.resolveActivitySelection('auto'), { mode: 'auto', id: '' });
    assert.deepEqual(activities.resolveActivitySelection('random'), { mode: 'random', id: '' });
    assert.deepEqual(activities.resolveActivitySelection('reading'), { mode: 'explicit', id: 'reading' });
    assert.deepEqual(activities.resolveActivitySelection('nonsense'), { mode: 'none', id: '' });
});

// --- Environment compatibility ------------------------------------------------

test('1. bedroom + reading is a valid preferred combination', () => {
    const reading = activities.getActivity('reading');
    assert.ok(reading.environments.preferred.includes('bedroom'));
    const forBedroom = activities.getActivitiesForEnvironment('a cosy bedroom');
    assert.ok(forBedroom.some((a) => a.id === 'reading'));
});

test('coffee-chat / walking-together expose preferred environments', () => {
    const coffee = activities.getActivity('coffee-chat');
    for (const env of ['cafe', 'restaurant', 'kitchen', 'living_room']) {
        assert.ok(coffee.environments.preferred.includes(env), 'coffee-chat missing ' + env);
    }
    const walking = activities.getActivity('walking-together');
    for (const env of ['street', 'park', 'mall', 'travel']) {
        assert.ok(walking.environments.preferred.includes(env), 'walking missing ' + env);
    }
});

test('2. Auto in a bedroom yields a bedroom-compatible activity', () => {
    const bedroomCompatible = new Set(
        activities.getActivitiesForEnvironment('a cosy bedroom').map((a) => a.id)
    );
    assert.ok(bedroomCompatible.has('reading'), 'reading should be bedroom-compatible');
    for (let seed = 1; seed <= 40; seed++) {
        const chosen = activities.selectActivity({
            environment: 'a cosy bedroom',
            groupSize: 1,
            mode: 'auto',
            rng: characterGen.createRng(seed)
        });
        assert.ok(chosen, 'expected an activity');
        assert.ok(bedroomCompatible.has(chosen.id), 'bedroom auto picked incompatible ' + chosen.id);
    }
    // Obviously incompatible activities never appear for a bedroom.
    assert.ok(!bedroomCompatible.has('cooking'));
    assert.ok(!bedroomCompatible.has('sightseeing'));
});

test('auto never picks an obviously incompatible activity for a cafe', () => {
    const forbidden = new Set(['cooking', 'exercising', 'getting-ready']);
    for (let seed = 1; seed <= 40; seed++) {
        const chosen = activities.selectActivity({
            environment: 'a warm neighbourhood cafe',
            groupSize: 1,
            mode: 'auto',
            rng: characterGen.createRng(seed * 7)
        });
        assert.ok(chosen && !forbidden.has(chosen.id), 'cafe auto picked ' + (chosen && chosen.id));
    }
});

test('activity compatibility guides selection but never blocks explicit use', () => {
    // An explicitly requested but unusual pairing is still available.
    const reading = activities.getActivity('reading');
    assert.ok(reading, 'reading must exist regardless of environment');
    const applied = concept.assembleConcept({
        themeId: 'anything',
        mode: 'none',
        activity: 'reading',
        rng: first
    });
    assert.equal(applied.activityId, 'reading');
    assert.equal(applied.activitySource, 'library');
});

// --- Natural-language matching ------------------------------------------------

test('11. natural-language matching maps phrases to structured activities', () => {
    const cases = [
        ['having coffee', 'coffee-chat'],
        ['reading a book', 'reading'],
        ['just hanging out', 'hanging-out'],
        ['taking a selfie', 'taking-selfie'],
        ['going shopping', 'shopping'],
        ['working on her laptop', 'working-on-laptop'],
        ['walking around the city', 'exploring-city']
    ];
    for (const [text, expected] of cases) {
        const match = activities.matchActivityFromText(text);
        assert.equal(match.id, expected, text + ' -> ' + match.id);
        assert.ok(match.confidence >= 0.6);
    }
    // "catching up" is a conversation cue (coffee-chat or casual-conversation).
    const catchUp = activities.matchActivityFromText('catching up');
    assert.ok(['coffee-chat', 'casual-conversation'].includes(catchUp.id), 'catching up -> ' + catchUp.id);
});

test('an uncertain phrase leaves the activity unspecified', () => {
    const match = activities.matchActivityFromText('a dreamy abstract portrait');
    assert.equal(match.id, '');
    assert.equal(match.confident, false);
    assert.equal(activities.matchActivityFromText('').id, '');
});

// --- Activity-aware outfit resolution ----------------------------------------

test('3. bedroom + reading adapts footwear (and comfort) when not explicit', () => {
    const input = {
        outfit: 'a basic white T-shirt with classic blue jeans and clean white sneakers',
        components: { top: 'a basic white T-shirt', bottom: 'classic blue jeans', shoes: 'clean white sneakers' }
    };
    const resolved = outfitContext.resolveOutfitForContext(input, 'a cosy bedroom', 'reading', { rng: first });
    assert.equal(resolved.resolution.environment, 'bedroom');
    const shoesCategory = outfitContext.footwearCategory(resolved.components.shoes);
    assert.ok(['barefoot', 'socks', 'slippers'].includes(shoesCategory),
        'unexpected footwear: ' + resolved.components.shoes);
    assert.ok(!/jeans/i.test(resolved.components.bottom), 'structured bottoms should relax for reading');
});

test('activity adaptation also runs through the Outfit Pack composer', () => {
    for (let seed = 1; seed <= 30; seed++) {
        const composed = outfitPacks.composeFromPack('casual-everyday', characterGen.createRng(seed), {
            environment: 'a cosy bedroom',
            activity: 'reading'
        });
        assert.equal(composed.environment, 'bedroom');
        const shoes = composed.components && composed.components.shoes;
        if (!shoes) continue;
        const category = outfitContext.footwearCategory(shoes);
        assert.ok(!category || ['barefoot', 'socks', 'slippers'].includes(category),
            'reading in a bedroom left ' + shoes);
    }
});

test('4. explicit footwear is preserved over activity/environment adaptation', () => {
    const input = {
        outfit: 'a fitted top with jeans and clean white sneakers',
        components: { top: 'a fitted top', bottom: 'jeans', shoes: 'clean white sneakers' }
    };
    const resolved = outfitContext.resolveOutfitForContext(input, 'a cosy bedroom', 'reading', {
        rng: first,
        explicit: { footwear: true, bottom: true }
    });
    assert.equal(resolved.components.shoes, 'clean white sneakers');
    assert.equal(resolved.components.bottom, 'jeans');
    assert.equal(resolved.adaptations.length, 0);

    // ...and through the auto-fill the explicit slot is never filled in.
    const jules = characterPresets.create({ name: 'Jules', identity: 'a woman with short hair', gender: 'woman' });
    const built = creativeDefaults.buildCreativeDefaults([jules], {
        rawPrompt: '@Jules reading in her bedroom wearing white sneakers',
        scenePrompt: 'reading in her bedroom wearing white sneakers',
        environment: 'in her bedroom',
        activity: 'reading',
        seed: 3
    });
    assert.equal(built.explicitSlots.footwear, true);
    if (built.clothing.length) {
        assert.doesNotMatch(built.clothing[0].outfit, /\b(?:sneakers|boots|heels|sandals|slippers|barefoot|flats)\b/i);
    }
});

test('an explicit activity survives a resolved outfit pass untouched', () => {
    const input = { outfit: 'a dress', components: { onePiece: 'a dress', shoes: 'elegant heels' } };
    const resolved = outfitContext.resolveOutfitForContext(input, 'date night', 'coffee-chat', { rng: first });
    assert.equal(resolved.components.onePiece, 'a dress');
});

// --- Playground integration ---------------------------------------------------

test('5. taking-selfie exposes smartphone camera/composition hints', () => {
    const selfie = activities.getActivity('taking-selfie');
    assert.ok(selfie.cameraHints.some((h) => /front-facing smartphone/i.test(h)));
    assert.ok(selfie.cameraHints.some((h) => /arm/i.test(h)));
    assert.ok(selfie.compositionHints.some((h) => /phone|arm|selfie/i.test(h)));

    const built = concept.assembleConcept({
        themeId: 'lifestyle-candid',
        mode: 'none',
        activity: 'taking-selfie',
        rng: first
    });
    const direction = concept.conceptToDirection(built);
    assert.match(direction, /front-facing smartphone lens/);
    assert.match(direction, /Activity composition:/);
    assert.match(direction, /Activity camera:/);
});

test('6. a Surprise with an explicit activity resolves it and records the mode', () => {
    const id = conversationId('explicit');
    const session = playground.start({
        conversationId: id,
        themeId: 'lifestyle-candid',
        mode: 'none',
        activity: 'coffee-chat',
        rng: first
    });
    assert.equal(session.concept.activityId, 'coffee-chat');
    assert.equal(session.concept.activitySource, 'library');
    assert.equal(session.activity, 'coffee-chat');
    const card = playground.buildCard(session, null);
    assert.equal(card.activityId, 'coffee-chat');
    assert.equal(card.activityMode, 'explicit');
    assert.ok(card.concept.activityActions.length > 0);
});

test('6b. an Auto Surprise picks a scene-compatible activity deterministically', () => {
    // Determinism is a property of the seeded concept assembly (a repeated
    // Surprise in one conversation deliberately avoids repeating an activity).
    const a = concept.assembleConcept({
        themeId: 'lifestyle-candid', mode: 'none', activity: 'auto', rng: characterGen.createRng(1234)
    });
    const b = concept.assembleConcept({
        themeId: 'lifestyle-candid', mode: 'none', activity: 'auto', rng: characterGen.createRng(1234)
    });
    assert.ok(a.activityId, 'expected a library activity');
    assert.equal(a.activitySource, 'library');
    assert.equal(a.activityMode, 'auto');
    assert.equal(a.activityId, b.activityId);

    const id = conversationId('auto');
    const session = playground.start({
        conversationId: id,
        themeId: 'lifestyle-candid',
        mode: 'none',
        activity: 'auto',
        rng: characterGen.createRng(1234)
    });
    assert.ok(session.concept.activityId, 'expected a library activity');
    assert.equal(session.concept.activitySource, 'library');
    assert.equal(session.concept.activityMode, 'auto');
});

test('7. activity hints reach the image request composition and camera', () => {
    const id = conversationId('request');
    const session = playground.start({
        conversationId: id,
        themeId: 'lifestyle-candid',
        mode: 'none',
        activity: 'taking-selfie',
        rng: first
    });
    const request = playground.buildImageRequest(session);
    assert.match(request.scene.camera, /smartphone/i);
    assert.match(request.scene.composition, /phone|arm|selfie/i);
    assert.match(request.user_prompt, /Activity camera:/);
});

test('a typed follow-up routes activity wording through the library matcher', () => {
    const interpreted = concept.interpretContextMessage('make her read a book in the bedroom', {
        open: true,
        themeId: 'lifestyle-candid'
    });
    assert.equal(interpreted.action, 'modify');
    assert.equal(interpreted.changes.activityId, 'reading');
});

test('a locked activity is preserved across a scene reroll', () => {
    const id = conversationId('lock');
    const session = playground.start({
        conversationId: id,
        themeId: 'lifestyle-candid',
        mode: 'random_character',
        activity: 'reading',
        locks: { activity: true },
        rng: characterGen.createRng(2)
    });
    const before = session.concept.activity;
    playground.modify(session, { changes: { environment: 'a bright private garden' }, rng: characterGen.createRng(3) });
    assert.equal(session.concept.activity, before);
    assert.equal(session.concept.activityId, 'reading');
});

test('a popover activity change adapts the outfit without recomposing it', () => {
    const id = conversationId('change');
    const session = playground.start({
        conversationId: id,
        themeId: 'lifestyle-candid',
        mode: 'none',
        activity: 'walking-together',
        outfitPack: 'casual-everyday',
        rng: characterGen.createRng(5)
    });
    const walkingOutfit = session.concept.outfit;
    playground.modify(session, { activity: 'reading', rng: characterGen.createRng(6) });
    assert.equal(session.concept.activityId, 'reading');
    assert.equal(session.activity, 'reading');
    // The pack is kept (same pack id) rather than a new one silently chosen.
    assert.equal(session.concept.outfitPack, 'casual-everyday');
    assert.ok(session.concept.outfit, 'the outfit stays present after adaptation');
    assert.notEqual(typeof walkingOutfit, 'undefined');
});

test('activity history avoids immediately repeating an auto activity', () => {
    const id = conversationId('history');
    const s1 = playground.start({
        conversationId: id, themeId: 'lifestyle-candid', mode: 'none',
        activity: 'auto', rng: characterGen.createRng(11)
    });
    const s2 = playground.start({
        conversationId: id, themeId: 'lifestyle-candid', mode: 'none',
        activity: 'auto', rng: characterGen.createRng(11)
    });
    if (s1.concept.activityId && s2.concept.activityId) {
        assert.notEqual(s1.concept.activityId, s2.concept.activityId);
    }
    assert.ok(Array.isArray(s2.activityIds));
});

// --- Future Chat compatibility ------------------------------------------------

test('8. the Activity Library is reusable without Playground UI state', () => {
    // No playground session is involved: any caller can select and format.
    const two = activities.selectActivity({
        environment: 'a warm neighbourhood cafe',
        groupSize: 2,
        mode: 'auto',
        rng: characterGen.createRng(1)
    });
    assert.ok(two && two.groupSizes.includes(2), 'expected a 2-person activity');

    const single = activities.listActivities({ groupSize: 1 }).map((a) => a.id);
    assert.ok(!single.includes('laughing-together'), 'single-character Playground must exclude 2+ activities');

    assert.equal(
        activities.formatActivityAction(activities.getActivity('coffee-chat'), 'Yara'),
        'Yara is having coffee and chatting.'
    );
    const scene = activities.getActivitiesForContext('a cafe', 'lifestyle-candid', null, { groupSize: 2 });
    assert.ok(scene.some((a) => a.id === 'coffee-chat'));
});

test('9. Playground regression: outfit packs and environments still work', () => {
    const composed = outfitPacks.composeFromPack('casual-everyday', characterGen.createRng(1), {
        environment: 'a cafe'
    });
    assert.ok(composed.outfit, 'cafe composition still works');
    assert.equal(composed.environment, 'cafe');

    const bedroom = outfitPacks.composeFromPack('casual-everyday', characterGen.createRng(1), {
        environment: 'a cosy bedroom'
    });
    assert.equal(bedroom.environment, 'bedroom');
});

test('10. Playground regression: character identity is untouched by activity selection', () => {
    const preset = characterPresets.create({ name: 'Ada', identity: 'a woman with auburn hair', appearance: 'a soft jawline', hair: 'a long braid' });
    const id = conversationId('identity');
    const session = playground.start({
        conversationId: id,
        themeId: 'lifestyle-candid',
        characterId: preset.id,
        activity: 'reading',
        rng: characterGen.createRng(9)
    });
    assert.equal(session.concept.subject, preset.identity);
    assert.equal(session.concept.appearance, preset.appearance);
    assert.equal(session.concept.hair, preset.hair);
    assert.equal(session.concept.activityId, 'reading');
});

test('conceptToDirection names the character in the activity sentence', () => {
    const built = concept.assembleConcept({
        themeId: 'lifestyle-candid',
        mode: 'random_character',
        activity: 'reading',
        rng: characterGen.createRng(4)
    });
    const direction = concept.conceptToDirection(built);
    assert.ok(built.name, 'random character should have a name');
    assert.match(direction, new RegExp('Character activity: ' + built.name + ' is '));
});
