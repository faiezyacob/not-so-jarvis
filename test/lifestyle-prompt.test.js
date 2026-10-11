/* ============================================
   JARVIS — Lifestyle & Candid prompt normalization
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const lifestylePrompt = require('../services/playground/lifestyle-prompt');
const playground = require('../services/playground/playground');
const themes = require('../services/playground/themes');

const GOLDEN = {
    subject: 'a 27-year-old woman',
    appearance: 'facial features with a warm golden undertone and dark brown eyes',
    hair: 'long wavy dark hair'
};
const NEUTRAL = {
    subject: 'a woman',
    appearance: 'a neutral complexion',
    hair: 'brown hair'
};

function countMatches(text, re) {
    return (String(text || '').match(re) || []).length;
}

// 1. Outdoor street scene with a golden-undertone character.
test('outdoor street: one identity block, scene-consistent lighting, warm-skin guidance', () => {
    const out = lifestylePrompt.normalizeLifestylePrompt(
        'A 27-year-old woman with a warm golden undertone and long wavy dark hair walks down a city sidewalk ' +
        'in golden hour sunlight. Preserve the character identity: a 27-year-old woman with a warm golden ' +
        'undertone and long wavy dark hair.',
        { identity: GOLDEN, scene: { environment: 'a city sidewalk', lighting: 'natural outdoor ambient light' } }
    );

    // Exactly one identity description: the redundant lock sentence is gone.
    assert.equal(countMatches(out, /warm golden undertone/gi), 1);
    assert.doesNotMatch(out, /preserve the character identity/i);
    // The contradictory "golden hour" lighting is reconciled to the scene.
    assert.doesNotMatch(out, /golden hour/i);
    assert.match(out, /natural outdoor ambient daylight/i);
    // Warm-skin characters still get the natural-skin / neutral-balance guidance.
    assert.match(out, /medium beige/i);
    assert.match(out, /no global yellow or orange/i);
    // The identity detail itself is preserved.
    assert.match(out, /long wavy dark hair/i);
});

// 2. Indoor cafe scene with neutral lighting.
test('indoor cafe: golden-hour wording is replaced with indoor ambient light', () => {
    const out = lifestylePrompt.normalizeLifestylePrompt(
        'A woman sits at a table in a cafe bathed in warm golden-hour light.',
        { identity: NEUTRAL, scene: { environment: 'a table in a cafe', lighting: 'everyday indoor lighting' } }
    );
    assert.doesNotMatch(out, /golden-hour/i);
    assert.match(out, /realistic indoor ambient light/i);
    assert.match(out, /no global yellow or orange/i);
    // A neutral identity does not get the golden-undertone correction clause.
    assert.doesNotMatch(out, /medium beige/i);
});

// 3. Evening street scene with warm streetlights.
test('evening street: warm streetlights are preserved as their own sources', () => {
    const out = lifestylePrompt.normalizeLifestylePrompt(
        'A woman walks along a city street in the evening, lit by warm streetlights and storefront signs.',
        { identity: NEUTRAL, scene: { environment: 'a city street at night', lighting: 'natural evening ambience' } }
    );
    assert.match(out, /streetlights/i);
    assert.match(out, /storefront/i);
    assert.doesNotMatch(out, /indoor ambient light/i);
    assert.match(out, /no global yellow or orange/i);
});

// 4. A character with an existing neutral skin tone.
test('neutral skin character: neutral white-balance guidance without the golden clause', () => {
    const out = lifestylePrompt.normalizeLifestylePrompt(
        'A woman with a neutral complexion and brown hair sits on a sofa at home in soft natural window light.',
        { identity: NEUTRAL, scene: { environment: 'a sofa at home', lighting: 'soft natural window light' } }
    );
    assert.match(out, /no global yellow or orange/i);
    assert.doesNotMatch(out, /medium beige/i);
    assert.match(out, /soft natural window light/i);
});

// 5. A prompt containing repeated identity descriptions.
test('repeated identity descriptions collapse to one block', () => {
    const out = lifestylePrompt.normalizeLifestylePrompt(
        'A 27-year-old woman with a warm golden undertone. ' +
        'Preserve the character identity: a 27-year-old woman with a warm golden undertone. ' +
        'The same character identity: a 27-year-old woman with a warm golden undertone.',
        { identity: GOLDEN, scene: {} }
    );
    assert.equal(countMatches(out, /warm golden undertone/gi), 1);
    assert.doesNotMatch(out, /preserve the character identity/i);
    assert.doesNotMatch(out, /the same character identity/i);
});

test('a genuinely new identity attribute in a repeated block is merged, not lost', () => {
    const out = lifestylePrompt.normalizeLifestylePrompt(
        'A 27-year-old woman with a warm golden undertone. ' +
        'Preserve the character identity: a 27-year-old woman with a warm golden undertone and a small mole on her left cheek.',
        { identity: GOLDEN, scene: {} }
    );
    assert.equal(countMatches(out, /warm golden undertone/gi), 1);
    assert.match(out, /small mole on her left cheek/i);
});

// 6. A prompt that already includes the iPhone suffix (through the playground).
test('through the playground: normalization then exactly one photography suffix', () => {
    const session = {
        themeId: 'lifestyle-candid',
        concept: {
            subject: GOLDEN.subject, appearance: GOLDEN.appearance, hair: GOLDEN.hair,
            environment: 'a city sidewalk', lighting: 'natural outdoor ambient light'
        }
    };
    const base = 'A 27-year-old woman with a warm golden undertone and long wavy dark hair walks down a city ' +
        'sidewalk in golden hour sunlight. Preserve the character identity: a 27-year-old woman with a warm ' +
        'golden undertone and long wavy dark hair.';

    const normalized = playground.normalizeThemePrompt(session, base);
    const final = playground.applyThemeImageStyle(session, normalized);
    assert.equal(countMatches(final, /authentic handheld iPhone 16 Pro/gi), 1);
    assert.equal(countMatches(final, /warm golden undertone/gi), 1);

    // Applying the suffix again does not duplicate it.
    const again = playground.applyThemeImageStyle(session, final);
    assert.equal(again, final);
});

// 7. A different theme must remain completely unaffected.
test('other themes are untouched by the normalization stage', () => {
    const prompt = 'A figure in a rain-soaked alley, hard rim light, deep shadow, heavy warm golden color grade.';
    assert.equal(playground.normalizeThemePrompt({ themeId: 'cinematic-storytelling', concept: {} }, prompt), prompt);
    assert.equal(playground.normalizeThemePrompt({ themeId: 'anything', concept: {} }, prompt), prompt);
    assert.equal(playground.normalizeThemePrompt({ themeId: 'experimental-photography', concept: {} }, prompt), prompt);
    // No theme at all: untouched, and no suffix appended.
    assert.equal(playground.applyThemeImageStyle({ themeId: 'cinematic-storytelling' }, prompt), prompt);
});

// Idempotency.
test('normalization is idempotent', () => {
    const options = { identity: GOLDEN, scene: { environment: 'a city sidewalk', lighting: 'natural outdoor ambient light' } };
    const once = lifestylePrompt.normalizeLifestylePrompt(
        'A 27-year-old woman with a warm golden undertone walks a city sidewalk in golden hour sunlight.',
        options
    );
    const twice = lifestylePrompt.normalizeLifestylePrompt(once, options);
    assert.equal(twice, once);
});

// Unwanted global colour grades are stripped, but warm light sources are not.
test('global golden color grade is removed while warm light sources remain', () => {
    const out = lifestylePrompt.normalizeLifestylePrompt(
        'A woman drinks coffee under a single warm table lamp, with a heavy warm golden color grade over the whole image.',
        { identity: NEUTRAL, scene: { environment: 'a cafe', lighting: 'the warm pool of a single table lamp at dusk' } }
    );
    assert.doesNotMatch(out, /color grade/i);
    assert.match(out, /warm table lamp/i);
});

test('an explicit user time of day wins over the theme default lighting', () => {
    const out = lifestylePrompt.normalizeLifestylePrompt(
        'A woman walks a quiet street at night under cool moonlight.',
        {
            identity: NEUTRAL,
            scene: { environment: 'a city street', lighting: 'bright diffused daylight' },
            userPrompt: 'a woman walking at night'
        }
    );
    assert.match(out, /night/i);
    assert.doesNotMatch(out, /daylight/i);
});

test('isLifestyleTheme scopes the normalization to Lifestyle & Candid only', () => {
    assert.equal(lifestylePrompt.isLifestyleTheme('lifestyle-candid'), true);
    assert.equal(lifestylePrompt.isLifestyleTheme('cinematic-storytelling'), false);
    assert.equal(lifestylePrompt.isLifestyleTheme(''), false);
    const empty = lifestylePrompt.normalizeLifestylePrompt('', { identity: GOLDEN, scene: {} });
    assert.equal(empty, '');
});

test('applyLifestyleSuffix appends once and is idempotent', () => {
    const once = lifestylePrompt.applyLifestyleSuffix('a casual scene');
    assert.equal(countMatches(once, /casual Instagram lifestyle photo/gi), 1);
    assert.equal(lifestylePrompt.applyLifestyleSuffix(once), once);
    assert.equal(lifestylePrompt.applyLifestyleSuffix(''), '');
});

// The theme itself must not bias toward a golden/warm cast.
test('Lifestyle & Candid theme carries no golden/warm lighting bias', () => {
    const theme = themes.getTheme('lifestyle-candid');
    const biased = /\b(?:golden|warm|amber)\b/i;
    for (const value of theme.lighting) {
        assert.doesNotMatch(value, biased, `lighting entry is warm/golden biased: ${value}`);
    }
    for (const value of theme.environments) {
        assert.doesNotMatch(value, /\bgolden\b/i, `environment entry mentions golden: ${value}`);
    }
    assert.ok(!theme.moods.includes('warm'), 'mood pool must not include "warm"');
    assert.ok(theme.constraints.some((c) => /no warm, golden or amber cast/i.test(c)),
        'theme constraints must carry the neutral colour clause');
});

// The theme photography suffix is appended without leaving a double period.
test('applyThemeImageStyle does not leave a double period', () => {
    const session = {
        themeId: 'lifestyle-candid',
        concept: { subject: 'a woman', appearance: 'a neutral complexion', hair: 'brown hair', environment: 'a bedroom', lighting: 'clean natural daylight' }
    };
    const normalized = playground.normalizeThemePrompt(session, 'A woman stands in a bedroom in clean natural daylight.');
    const final = playground.applyThemeImageStyle(session, normalized);
    assert.doesNotMatch(final, /\.\./);
    assert.match(final, /no global yellow or orange/i);
});
