/* ============================================
   JARVIS — Creator Studio tests
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-creator-studio-'));
process.env.CREATOR_STUDIO_PATH = path.join(tmpDir, 'creator-studio.json');

const studio = require('../services/creator-studio');
const videoGenerator = require('../services/video-generator');

function makeCharacter(age) {
    return {
        id: 'maya-id',
        name: 'Maya',
        identity: age ? { age, ageGroup: Number(age.match(/\d+/)[0]) < 28 ? 'young_adult' : 'adult' } : null
    };
}

test('Creator Studio drops legacy profiles and keeps the canonical Character on sessions', () => {
    fs.writeFileSync(studio.STORE_PATH, JSON.stringify({
        profiles: [{ id: 'maya-profile', characterId: 'maya-id' }],
        sessions: {
            legacy: {
                creatorId: 'maya-profile', characterId: 'maya-id',
                content: { creatorId: 'maya-profile', characterId: 'maya-id' }
            }
        }
    }));
    const session = studio.getSession('legacy');
    assert.equal(session.characterId, 'maya-id');
    assert.equal(Object.hasOwn(session, 'creatorId'), false);
    assert.equal(Object.hasOwn(session.content, 'creatorId'), false);
    assert.equal(Object.hasOwn(studio.loadStore(), 'profiles'), false);
});

test('Creator Studio includes the primary portrait when there are no supplementary references', () => {
    assert.deepEqual(studio.identityReferenceFilenames({
        sourceAbs: path.join('data', 'generated', 'ari-portrait.png'),
        references: []
    }), ['ari-portrait.png']);
});

test('Creator Studio sends the primary portrait before supplementary identity references', () => {
    assert.deepEqual(studio.identityReferenceFilenames({
        sourceAbs: path.join('data', 'generated', 'ari-portrait.png'),
        references: [
            path.join('data', 'generated', 'other-character.png'),
            path.join('data', 'generated', 'ari-portrait.png')
        ]
    }), ['ari-portrait.png', 'other-character.png']);
});

test('creator content recipes and performance catalogs are structured and reusable', () => {
    const catalog = studio.catalog();
    assert.ok(catalog.contentTypes.some((item) => item.id === 'storytelling' && item.structure.includes('hook')));
    assert.equal(Object.hasOwn(catalog, 'presets'), false);
    assert.ok(catalog.expressionArcs.some((item) => item.id === 'smile_to_smirk'));
    assert.ok(catalog.faceActions.some((item) => item.id === 'smirk'));
});

test('creator performance contains varied identity-safe face actions and exact speech beats', async () => {
    const content = await studio.buildCreatorContent({
        characterId: 'maya-id',
        personality: ['playful', 'confident'],
        concept: 'a funny weekend story',
        contentType: 'storytelling',
        deliveryStyle: 'playful',
        duration: 15
    }, makeCharacter('29-year-old'));

    assert.equal(content.performanceBeats.length, 5);
    assert.deepEqual(Object.keys(content.performanceBeats[0]).sort(), [
        'bodyAction', 'camera', 'delivery', 'expression', 'eyes', 'faceAction', 'faceActionId',
        'gaze', 'gesture', 'head', 'mouth', 'speech', 'timing'
    ].sort());
    assert.ok(new Set(content.performanceBeats.map((beat) => beat.faceActionId)).size > 1);
    assert.match(content.shotPlan[0], /<d>\[English\]/);
    assert.match(content.userPrompt, /IDENTITY:/);
    assert.match(content.userPrompt, /PERFORMANCE:/);
    assert.match(content.userPrompt, /ENVIRONMENT:/);
    assert.equal(content.characterId, 'maya-id');
    assert.equal(content.creatorName, 'Maya');
    assert.equal(Object.hasOwn(content, 'creatorId'), false);
    const words = content.performanceBeats.map((beat) => beat.speech).join(' ').split(/\s+/).length;
    assert.ok(words <= 33);
});

test('flirty and seductive delivery require structured adult age', async () => {
    await assert.rejects(
        studio.buildCreatorContent({ concept: 'an update', deliveryStyle: 'flirty' }, makeCharacter('17-year-old')),
        { code: 'creator_adult_required' }
    );
    await assert.rejects(
        studio.buildCreatorContent({ concept: 'an update', deliveryStyle: 'seductive' }, makeCharacter('')),
        { code: 'creator_adult_required' }
    );
    const valid = await studio.buildCreatorContent({ concept: 'an update', deliveryStyle: 'flirty' }, makeCharacter('29-year-old'));
    assert.equal(valid.deliveryStyle, 'flirty');
    assert.match(valid.deliveryDirection, /non-explicit/i);
});

test('natural follow-ups identify and rebuild only the requested performance layer', async () => {
    const character = makeCharacter('29-year-old');
    const first = await studio.buildCreatorContent({
        characterId: 'maya-id',
        personality: ['warm'],
        concept: 'weekend update',
        deliveryStyle: 'natural'
    }, character);
    const previous = { characterId: character.id, content: first };
    const decision = studio.classifyMessage('Make her smile more.', previous);
    assert.equal(decision.dimension, 'facial_performance');
    const updated = await studio.buildCreatorContent({
        characterId: 'maya-id',
        personality: ['warm'],
        dimension: decision.dimension,
        message: decision.message
    }, character, { previousSession: previous });
    assert.deepEqual(updated.script, first.script);
    assert.equal(updated.performanceBeats[0].expression, 'soft_smile');
    assert.equal(updated.performanceBeats.at(-1).expression, 'soft_smile');
    assert.equal(studio.resolveDimension('Change the camera framing'), 'camera');
    assert.equal(studio.resolveDimension('Change her outfit to a blue sweater'), 'outfit');

    const expressionArc = await studio.buildCreatorContent({
        dimension: 'facial_performance',
        message: 'Make her smile at the beginning and smirk near the end.'
    }, character, { previousSession: previous });
    assert.equal(expressionArc.performanceBeats[0].faceActionId, 'soft_smile');
    assert.equal(expressionArc.performanceBeats.at(-1).faceActionId, 'smirk');
});

test('talking creator requests route without capturing ordinary image or product asks', () => {
    assert.equal(studio.detectCreatorIntent('Create a video for @Maya talking about her weekend.', [{ id: 'maya-id' }]), true);
    assert.equal(studio.detectCreatorIntent('Make an image of @Maya in a cafe.', [{ id: 'maya-id' }]), false);
    assert.equal(studio.detectCreatorIntent('Generate an image of @Maya telling a story.', [{ id: 'maya-id' }]), false);
    assert.equal(studio.detectCreatorIntent('Write a prompt for @Maya telling a story.', [{ id: 'maya-id' }]), false);
    assert.equal(studio.detectCreatorIntent('Can you create a talking video for @Maya?', [{ id: 'maya-id' }]), true);
    assert.equal(studio.detectCreatorIntent('Create a product demo for @Maya.', [{ id: 'maya-id' }]), false);
});

test('Creator reference fallback treats the portrait as identity-only rather than a UGC keyframe', () => {
    const fallback = videoGenerator.buildReferenceFallbackPrompt({
        shotPlan: ['Maya speaks to camera: <d>[English] Hello there.</d>'],
        referenceCount: 1,
        durationSeconds: 10,
        creatorIdentityOnly: true
    });
    assert.match(fallback, /identity-only reference/i);
    assert.match(fallback, /personality-led social creator video/i);
    assert.doesNotMatch(fallback, /user-generated-content/i);
    assert.doesNotMatch(fallback, /shot begins from <Picture/i);
});

test('Creator beat plan reaches the shared H3 reference prompt with exact dialogue repair', async () => {
    const content = await studio.buildCreatorContent({
        characterId: 'maya-id',
        personality: ['playful'],
        concept: 'a weekend update',
        deliveryStyle: 'playful',
        duration: 15
    }, makeCharacter('29-year-old'));
    let systemPrompt = '';
    const providers = {
        chat: async (_provider, messages) => {
            systemPrompt = messages[0].content;
            const shots = content.performanceBeats.map((_, index) => index === 0
                ? '[Shot 1] The creator smiles toward the lens.'
                : '[Shot ' + (index + 1) + '] At 00:' + String(index * 3).padStart(2, '0') + '.000, she reacts naturally.').join(' ');
            return JSON.stringify({
                mode: 'ref2va',
                prompt: 'subject_definitions:\n<Subject 1> is the creator in <Picture 1>.\n\n' +
                    'summary:\nA creator talks to her audience.\n\n' +
                    'retention_analysis:\n<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - identity.\n\n' +
                    'detailed_description:\n' + shots + '\n\n' +
                    'overall_soundscape:\nNatural room tone.\n\nnon_diegetic_music:\nN/A'
            });
        }
    };
    const result = await videoGenerator.buildH3VideoPrompt({
        creator_content: true,
        user_prompt: content.userPrompt,
        reference_images: ['maya-base.png'],
        shot_plan: content.shotPlan,
        dialogue_language: 'English',
        requested_duration: 15,
        explicit_constraints: []
    }, providers, 'ollama', 'test-model', null, 'creator-test', false);

    assert.equal(result.mode, 'ref2va');
    assert.match(systemPrompt, /approved single Character base portrait/i);
    for (const beat of content.performanceBeats) assert.ok(result.prompt.includes(beat.speech));
    assert.match(result.prompt, /<d>\[English\]/);
    assert.doesNotMatch(result.prompt, /user-generated-content phone-camera/i);
});

test.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
