/* ============================================
   JARVIS — Creative Playground scene posture
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const concept = require('../services/playground/concept');
const themes = require('../services/playground/themes');
const scenePosture = require('../services/playground/scene-posture');

test('posing at a restaurant table is a supported seated posture, never an edge perch', () => {
    const posture = scenePosture.resolve({
        environment: 'a restaurant table',
        activity: 'posing before going out'
    });
    assert.equal(posture.stance, 'sitting');
    assert.match(posture.phrase, /seated squarely/);
    assert.match(posture.phrase, /back resting against the backrest/i);
    assert.match(posture.phrase, /both feet flat on the floor/i);
    assert.match(posture.phrase, /hand resting lightly on the table/i);
    assert.doesNotMatch(posture.phrase, /\bperched\b|\bedge\b/i);
});

test('a bar scene keeps the character standing beside the bar', () => {
    const posture = scenePosture.resolve({
        environment: 'a bar',
        activity: 'posing for a quick photo'
    });
    assert.equal(posture.stance, 'standing');
    assert.match(posture.phrase, /standing casually beside the bar/i);
    assert.match(posture.phrase, /both feet on the floor/i);
});

test('an activity that belongs on the feet overrides a seated room', () => {
    const posture = scenePosture.resolve({
        environment: 'a bedroom mirror',
        activity: 'doing skincare'
    });
    assert.equal(posture.stance, 'standing');
    assert.match(posture.phrase, /in front of the mirror/i);
});

test('the user explicitly requested stance always wins', () => {
    const posture = scenePosture.resolve({
        environment: 'a restaurant',
        activity: 'having a drink',
        userPrompt: 'lying on the floor of the restaurant'
    });
    assert.equal(posture.stance, 'lying');
    assert.match(posture.phrase, /reclining comfortably/i);
});

test('a requested standing pose beats the place locative', () => {
    const posture = scenePosture.resolve({
        environment: 'a restaurant',
        activity: 'having a drink',
        userPrompt: 'standing at the table with one hand on the chair'
    });
    assert.equal(posture.stance, 'standing');
});

test('the resolved posture reaches the creative direction', () => {
    const built = concept.assembleConcept({
        theme: themes.getTheme('lifestyle-candid'),
        mode: 'none',
        category: 'night-out',
        rng: require('../services/playground/character').createRng(53)
    });
    assert.ok(built.postureStance, 'expected a resolved stance on the concept');
    const direction = concept.conceptToDirection(built);
    assert.match(direction, /Body position: /);
    assert.match(direction, /seated squarely|standing casually beside the bar/i);
    assert.match(direction, new RegExp(built.postureDescription.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 40)));
});

test('a user prompt that names no stance is not given a generic body position', () => {
    const built = concept.assembleConcept({
        theme: themes.getTheme('lifestyle-candid'),
        mode: 'none',
        userPrompt: 'a woman reading by the window in soft daylight',
        rng: require('../services/playground/character').createRng(7)
    });
    const direction = concept.conceptToDirection(built);
    assert.doesNotMatch(direction, /Body position:/);
});

test('a user prompt with an explicit stance still gets the posture line', () => {
    const built = concept.assembleConcept({
        theme: themes.getTheme('lifestyle-candid'),
        mode: 'none',
        userPrompt: 'a woman lying on a sofa reading',
        rng: require('../services/playground/character').createRng(8)
    });
    const direction = concept.conceptToDirection(built);
    assert.match(direction, /Body position:/);
    assert.match(direction, /reclining comfortably/i);
});

test('Night Out environments and activities stay scene-coherent', () => {
    const theme = themes.getTheme('lifestyle-candid');
    const nightOut = theme.categories.find((category) => category.id === 'night-out');
    assert.ok(nightOut, 'expected the night-out category');
    assert.ok(Array.isArray(nightOut.lighting) && nightOut.lighting.length, 'night out needs its own lighting');
    assert.ok(Array.isArray(nightOut.moods) && nightOut.moods.length, 'night out needs its own moods');
    assert.ok(Array.isArray(nightOut.styles) && nightOut.styles.length, 'night out needs its own styles');
    assert.ok(!nightOut.activities.includes('posing before going out'),
        'pre-departure posing does not belong at a restaurant or bar');
    for (const environment of nightOut.environments) {
        for (const activity of nightOut.activities) {
            const posture = scenePosture.resolve({ environment, activity });
            assert.ok(['sitting', 'standing', 'walking'].includes(posture.stance),
                'unexpected stance for ' + environment + ' / ' + activity + ': ' + posture.stance);
            assert.match(posture.phrase, /feet|foot/i,
                'posture must ground the body for ' + environment + ' / ' + activity);
        }
    }
});
