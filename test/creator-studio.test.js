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
                content: { creatorId: 'maya-profile', characterId: 'maya-id', deliveryStyle: 'natural', deliveryDirection: 'legacy style' },
                videos: [{ id: 'legacy-video', url: '/generated/old%20clip.mp4?cache=1' }]
            }
        }
    }));
    const session = studio.getSession('legacy');
    assert.equal(session.characterId, 'maya-id');
    assert.equal(Object.hasOwn(session, 'creatorId'), false);
    assert.equal(Object.hasOwn(session.content, 'creatorId'), false);
    assert.equal(Object.hasOwn(session.content, 'deliveryStyle'), false);
    assert.equal(Object.hasOwn(session.content, 'deliveryDirection'), false);
    assert.equal(Object.hasOwn(studio.loadStore(), 'profiles'), false);
    assert.equal(session.videos[0].filename, 'old clip.mp4');
    assert.equal(session.videos[0].url, '/generated/old%20clip.mp4');
});

test('recordVideo stores a canonical generated-media URL and filename', () => {
    const session = studio.recordVideo(null, {
        characterId: 'maya-id', concept: 'weekend update', contentType: 'talking'
    }, { url: '/generated/clip%20one.mp4', prompt: 'creator prompt' });
    assert.equal(session.videos[0].filename, 'clip one.mp4');
    assert.equal(session.videos[0].url, '/generated/clip%20one.mp4');
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
    assert.equal(Object.hasOwn(catalog, 'deliveryStyles'), false);
    assert.ok(catalog.expressionArcs.some((item) => item.id === 'smile_to_smirk'));
    assert.ok(catalog.faceActions.some((item) => item.id === 'smirk'));
});

test('creator performance contains varied identity-safe face actions and exact speech beats', async () => {
    const content = await studio.buildCreatorContent({
        characterId: 'maya-id',
        personality: ['playful', 'confident'],
        concept: 'a funny weekend story',
        contentType: 'storytelling',
        duration: 15
    }, makeCharacter('29-year-old'));

    assert.equal(content.performanceBeats.length, content.recipe.structure.length);
    assert.deepEqual(Object.keys(content.performanceBeats[0]).sort(), [
        'bodyAction', 'camera', 'delivery', 'expression', 'eyes', 'faceAction', 'faceActionId',
        'gaze', 'gesture', 'head', 'label', 'mouth', 'speech', 'stage'
    ].sort());
    assert.ok(new Set(content.performanceBeats.map((beat) => beat.faceActionId)).size > 1);
    assert.match(content.shotPlan[0], /<d>\[English\]/);
    assert.match(content.userPrompt, /IDENTITY:/);
    assert.match(content.userPrompt, /PERSONALITY DIRECTION:/);
    assert.match(content.userPrompt, /ENVIRONMENT:/);
    assert.equal(content.characterId, 'maya-id');
    assert.equal(content.creatorName, 'Maya');
    assert.equal(Object.hasOwn(content, 'creatorId'), false);
    // Every guide beat is present with its own baseline.
    assert.deepEqual(content.creatorDialogue.guide.structure, content.recipe.structure);
    assert.deepEqual(content.creatorDialogue.dialogue.lines.map((line) => line.stage), content.recipe.structure);
    assert.ok(content.creatorDialogue.dialogue.lines.every((line) => line.speech));
    assert.equal(Object.hasOwn(content.performanceBeats[0], 'timing'), false);
    // The complete dialogue is preserved; H3 owns pacing, so it is never chopped
    // to a word budget (which previously produced truncated lines).
    assert.ok(content.creatorDialogue.dialogue.lines.every((line) => line.speech.trim().length > 0));
});

test('talking-to-camera content defaults to a front-on eye-level angle and offers other perspectives', async () => {
    const frontOn = await studio.buildCreatorContent({
        characterId: 'maya-id',
        concept: 'a weekend update'
    }, makeCharacter('29-year-old'));

    assert.equal(frontOn.camera, 'front_on_eye_level');
    assert.match(frontOn.cameraDirection, /straight-on front-facing camera/i);
    assert.match(frontOn.cameraDirection, /at eye level/i);
    assert.match(frontOn.cameraDirection, /not above the creator and does not angle down/i);
    assert.match(frontOn.shotPlan[0], /straight-on front-facing camera/i);

    const lowAngle = await studio.buildCreatorContent({
        characterId: 'maya-id', concept: 'a weekend update', camera: 'low_angle_front'
    }, makeCharacter('29-year-old'));
    assert.match(lowAngle.cameraDirection, /slightly below eye level and angled gently upward/i);

    const threeQuarter = await studio.buildCreatorContent({
        characterId: 'maya-id', concept: 'a weekend update', camera: 'three_quarter_eye_level'
    }, makeCharacter('29-year-old'));
    assert.match(threeQuarter.cameraDirection, /subtle three-quarter view/i);

    const tripod = await studio.buildCreatorContent({
        characterId: 'maya-id',
        concept: 'a weekend update',
        camera: 'tripod'
    }, makeCharacter('29-year-old'));
    assert.equal(tripod.camera, 'tripod');
    assert.match(tripod.cameraDirection, /fixed tripod/i);
    assert.doesNotMatch(tripod.cameraDirection, /selfie|front-facing smartphone/i);

    assert.equal(studio.resolveDimension('Change the camera angle to a front view'), 'camera');
    assert.equal(studio.matchCameraPresetFromText('Put the camera straight in front of her'), studio.CAMERA_PRESETS[0]);
    assert.equal(studio.matchCameraPresetFromText('Use a slightly low angle from below'), studio.CAMERA_PRESETS[1]);
    assert.equal(studio.matchCameraPresetFromText('Make it a three-quarter view'), studio.CAMERA_PRESETS[2]);
});

test('flirty personality direction requires structured adult age', async () => {
    await assert.rejects(
        studio.buildCreatorContent({ concept: 'an update', personality: ['flirty'] }, makeCharacter('17-year-old')),
        { code: 'creator_adult_required' }
    );
    await assert.rejects(
        studio.buildCreatorContent({ concept: 'an update', personality: ['flirty'] }, makeCharacter('')),
        { code: 'creator_adult_required' }
    );
    const valid = await studio.buildCreatorContent({ concept: 'an update', personality: ['flirty'] }, makeCharacter('29-year-old'));
    assert.ok(valid.personality.includes('flirty'));
    assert.match(valid.personalityDirection, /non-explicit/i);
});

test('playful personality is the default direction', async () => {
    const content = await studio.buildCreatorContent({ concept: 'a weekend update' }, makeCharacter('29-year-old'));
    assert.deepEqual(content.personality, ['playful']);
    assert.match(content.personalityDirection, /playful phrasing/i);
    assert.match(content.script.hook, /quick update/i);
    assert.equal(Object.hasOwn(content, 'deliveryStyle'), false);
});

test('content suggestion context captures live Creator Studio controls and canonical Character details', () => {
    const context = studio.buildContentSuggestionContext({
        characterId: 'maya-id',
        content: {
            concept: 'Talk about dating.', contentType: 'lifestyle_update', personality: ['playful'],
            speechBehavior: 'playful_teasing', duration: 15, camera: 'phone_selfie', cameraMotion: 'subtle_handheld',
            expressionArc: 'playful', bodyAction: 'small_laugh', scene: 'Bedroom', outfit: 'Auto', outfitPack: 'lounge-home',
            energy: 'high', pacing: 'fast', pauseFrequency: 'high', eyeContact: 'strong',
            voice: { tone: 'bright', speed: 'fast', pitch: 'natural', energy: 'high', emotion: 'playful' },
            performanceBeats: [{ faceActionId: 'smirk' }]
        }
    }, {
        concept: '', contentType: 'storytelling', personality: ['warm', 'playful'], speechBehavior: 'storytelling',
        duration: 10, camera: 'phone_selfie', cameraMotion: 'static', expressionArc: 'storytelling',
        bodyAction: 'lean_in', scene: 'Cafe', outfitPack: 'casual-everyday', energy: 'medium', pacing: 'natural'
    }, Object.assign(makeCharacter('29-year-old'), { identity: { age: '29-year-old', ageGroup: 'adult', gender: 'woman' } }));

    assert.equal(context.character.name, 'Maya');
    assert.equal(context.character.gender, 'woman');
    assert.equal(context.character.adult, true);
    assert.equal(context.contentType.id, 'storytelling');
    assert.equal(context.hasExistingContent, false);
    assert.deepEqual(context.personality, ['warm', 'playful']);
    assert.equal(context.speechBehavior.id, 'storytelling');
    assert.equal(context.duration, 10);
    assert.equal(context.camera.id, 'phone_selfie');
    assert.equal(context.cameraMotion.id, 'static');
    assert.equal(context.expressionStyle, 'Storytelling arc');
    assert.equal(context.faceAction, 'smirk');
    assert.equal(context.bodyAction, 'Lean slightly toward camera');
    assert.equal(context.environment, 'Cafe');
    assert.equal(context.outfit, 'casual-everyday');
    assert.equal(context.energy, 'medium');
    assert.equal(context.voice.tone, 'bright');
});

test('content suggestions adapt by content type, duration, and existing content without creating shots', async () => {
    const character = Object.assign(makeCharacter('29-year-old'), {
        identity: { age: '29-year-old', ageGroup: 'adult', gender: 'woman' }
    });
    const context = studio.buildContentSuggestionContext(null, {
        characterId: character.id, contentType: 'product_review', personality: ['confident'],
        speechBehavior: 'conversational', duration: 10, camera: 'phone_selfie', concept: 'My new coffee maker',
        scene: 'Kitchen', outfitPack: 'casual-everyday'
    }, character);
    const result = await studio.generateContentSuggestions(context, null);
    assert.ok(result.length >= 3 && result.length <= 5);
    assert.match(result[0].text, /“My new coffee maker”/);
    assert.match(result[0].text, /specific|funny|unexpected|example/i);
    assert.ok(result.every((item) => !/\[Shot [2-9]\]|cinematic|shot list/i.test(item.text)));

    const tutorialContext = studio.buildContentSuggestionContext(null, {
        characterId: character.id, contentType: 'tutorial', personality: ['warm'], duration: 8,
        camera: 'phone_selfie', concept: '', scene: 'Auto'
    }, character);
    const tutorialIdeas = studio.contentSuggestionFallback(tutorialContext);
    assert.ok(tutorialIdeas.some((idea) => /quick|under 8 seconds|simple/i.test(idea.text)));
});

test('suggestion generation asks the configured provider for structured ideation and recovers short output', async () => {
    const character = Object.assign(makeCharacter('29-year-old'), {
        identity: { age: '29-year-old', ageGroup: 'adult', gender: 'woman' }
    });
    const context = studio.buildContentSuggestionContext(null, {
        characterId: character.id, contentType: 'comedy', personality: ['funny', 'playful'],
        speechBehavior: 'conversational', duration: 12, camera: 'phone_selfie', concept: '', scene: 'Bedroom'
    }, character);
    let prompt = '';
    const result = await studio.generateContentSuggestions(context, {
        chat: async (_provider, messages, model, options) => {
            prompt = messages[1].content;
            assert.equal(model, 'suggestion-test-model');
            assert.equal(options.think, false);
            return JSON.stringify({ suggestions: [
                { text: 'Tell a quick story about confidently waving back at the wrong person.', reason: 'Relatable comic setup.' },
                { text: '[Shot 2] Cut to a dramatic close-up.' }
            ] });
        }
    }, 'ollama', 'suggestion-test-model');
    assert.match(prompt, /comedy/i);
    assert.match(prompt, /phone selfie/i);
    assert.match(prompt, /12/);
    assert.match(prompt, /one continuous take/i);
    assert.ok(result.length >= 3);
    assert.equal(result[0].text, 'Tell a quick story about confidently waving back at the wrong person.');
    assert.ok(result.every((item) => !/\[Shot 2\]/.test(item.text)));
});

test('natural follow-ups identify and rebuild only the requested performance layer', async () => {
    const character = makeCharacter('29-year-old');
    const first = await studio.buildCreatorContent({
        characterId: 'maya-id',
        personality: ['warm'],
        concept: 'weekend update',
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

test('Creator performance beats become timestamped events inside exactly one continuous H3 shot, deterministically', async () => {
    const content = await studio.buildCreatorContent({
        characterId: 'maya-id',
        personality: ['playful'],
        concept: 'a weekend update',
        duration: 15
    }, makeCharacter('29-year-old'));
    let llmCalled = false;
    const providers = {
        chat: async () => { llmCalled = true; throw new Error('the deterministic Creator Studio builder must not call an LLM'); }
    };
    const result = await videoGenerator.buildH3VideoPrompt({
        creator_content: true,
        user_prompt: content.userPrompt,
        reference_images: ['maya-base.png'],
        shot_plan: content.shotPlan,
        creator_performance_beats: content.performanceSequence,
        creator_dialogue: content.creatorDialogue,
        creator_name: content.creatorName,
        creator_environment: content.scene,
        creator_wardrobe: content.outfit,
        creator_camera_direction: content.cameraDirection,
        dialogue_language: 'English',
        requested_duration: 15,
        explicit_constraints: []
    }, providers, 'ollama', 'test-model', null, 'creator-test', false);

    assert.equal(llmCalled, false);
    assert.equal(result.mode, 'ref2va');
    for (const beat of content.performanceBeats) assert.ok(result.prompt.includes(beat.speech));
    assert.deepEqual(videoGenerator.creatorShotHeaders(result.prompt), ['[Shot 1]']);
    assert.equal(videoGenerator.validateCreatorContinuousShot(result.prompt), true);
    assert.doesNotMatch(result.prompt, /\[Shot [2-9]\]/);
    // No timestamps anywhere in the prompt: H3 owns all timing.
    assert.doesNotMatch(result.prompt, /\b\d{2}:\d{2}\.\d{3}\b/);
    assert.doesNotMatch(result.prompt, /\bAt\s+\d{1,2}:\d{2}/);
    // One complete dialogue block plus explicit natural-timing guidance.
    assert.match(result.prompt, /Dialogue \(the complete script/);
    assert.match(result.prompt, /<Subject 1> \(S1\) says: <d>\[English\]/);
    assert.match(result.prompt, /TIMING \(H3\): The creator must speak the complete dialogue from beginning to end/);
    assert.match(result.prompt, /Do not skip, shorten, summarize, paraphrase, reorder or omit any dialogue/);
    assert.match(result.prompt, /straight-on front-facing camera/i);
    assert.match(result.prompt, /not above the creator and does not angle down/i);
    assert.doesNotMatch(result.prompt, /held at a natural arm's length/i);
    assert.doesNotMatch(result.prompt, /user-generated-content phone-camera/i);
    assert.equal(videoGenerator.validateCreatorStudioPrompt(result.prompt, content.creatorDialogue).ok, true);
});

function canonicalDialogue(overrides = {}) {
    const base = {
        guide: {
            id: 'talking',
            name: 'Talking to Camera',
            structure: ['hook', 'main_point', 'reaction', 'closing'],
            stages: ['hook', 'main point', 'reaction', 'closing'],
            ctaRequired: true,
            personality: ['playful'],
            topic: 'a productivity hack',
            talkingPoints: ['productivity']
        },
        creator: {
            name: 'Sofia',
            identityDescription: 'warm olive complexion, dark wavy hair, brown eyes',
            referenceDescription: 'the approved Character identity portrait supplied as <Picture 1>'
        },
        shot: {
            id: 'Shot 1',
            cameraDirection: 'self-filmed direct-to-camera video on a front-facing smartphone held at arm\'s length',
            environment: 'a bright relaxed bedroom',
            wardrobe: 'a cream knit sweater'
        },
        dialogue: {
            lines: [
                { stage: 'hook', label: 'hook', speech: 'Ever feel like a productivity hack is too much work?' },
                { stage: 'main_point', label: 'main point', speech: 'I just trick my brain.' },
                { stage: 'reaction', label: 'reaction', speech: 'Five minutes of movement actually works.' },
                { stage: 'closing', label: 'closing', speech: 'Try it now.' }
            ],
            text: 'Ever feel like a productivity hack is too much work? I just trick my brain. Five minutes of movement actually works. Try it now.'
        },
        performance: [
            { stage: 'hook', label: 'hook', expression: 'a soft warm smile', gaze: 'direct eye contact with the lens', body: 'small natural hand gestures' },
            { stage: 'main_point', label: 'main point', expression: 'a playful grin', gaze: 'direct eye contact with the lens', body: 'leans slightly toward the camera' },
            { stage: 'reaction', label: 'reaction', expression: 'an amused expression', gaze: 'direct eye contact with the lens', body: 'a small shoulder movement' },
            { stage: 'closing', label: 'closing', expression: 'a warm smile', gaze: 'direct eye contact with the lens', body: 'hands resting naturally' }
        ]
    };
    const result = Object.assign({}, base, overrides, {
        creator: Object.assign({}, base.creator, overrides.creator),
        shot: Object.assign({}, base.shot, overrides.shot)
    });
    if (overrides.guide) result.guide = Object.assign({}, base.guide, overrides.guide);
    if (overrides.dialogue) result.dialogue = Object.assign({}, base.dialogue, overrides.dialogue);
    if (overrides.performance) result.performance = overrides.performance;
    return result;
}

test('Test A — every dialogue line appears completely and exactly in the final H3 prompt', () => {
    const canonical = canonicalDialogue();
    const prompt = videoGenerator.buildCreatorStudioPrompt(canonical);
    for (const line of canonical.dialogue.lines) {
        assert.ok(prompt.includes(line.speech), 'missing speech: ' + line.speech);
    }
    assert.ok(prompt.includes(canonical.dialogue.text));
    assert.equal(videoGenerator.validateCreatorStudioPrompt(prompt, canonical).ok, true);
});

test('Test B — multiple guide beats remain inside one [Shot 1] with no timestamps', () => {
    const canonical = canonicalDialogue();
    const prompt = videoGenerator.buildCreatorStudioPrompt(canonical);
    assert.deepEqual(videoGenerator.creatorShotHeaders(prompt), ['[Shot 1]']);
    assert.doesNotMatch(prompt, /\[Shot [2-9]\]/);
    assert.doesNotMatch(prompt, /\b\d{2}:\d{2}\.\d{3}\b/);
    let cursor = 0;
    for (const line of canonical.dialogue.lines) {
        const at = prompt.indexOf(line.speech, cursor);
        assert.ok(at > -1, 'missing or out-of-order speech: ' + line.speech);
        cursor = at + line.speech.length;
    }
});

test('Test C — creator name and reference information are populated', () => {
    const canonical = canonicalDialogue();
    const prompt = videoGenerator.buildCreatorStudioPrompt(canonical);
    assert.match(prompt, /<Subject 1> is Sofia/);
    assert.match(prompt, /<Picture 1>/);
    assert.ok(prompt.includes(canonical.creator.identityDescription));
    assert.ok(prompt.includes(canonical.creator.referenceDescription));
    assert.match(prompt, /<Subject 1> \(S1\) says: <d>\[English\]/);
});

test('Test D — a missing optional identity description falls back without malformed prose', () => {
    const canonical = canonicalDialogue({ creator: { identityDescription: '' } });
    const prompt = videoGenerator.buildCreatorStudioPrompt(canonical);
    assert.doesNotMatch(prompt, /Their identity:\s*\./);
    assert.doesNotMatch(prompt, /shown in\s*,/);
    assert.equal(videoGenerator.validateCreatorDialogue(canonical).ok, true);
    assert.equal(videoGenerator.validateCreatorStudioPrompt(prompt, canonical).ok, true);
});

test('Test E — malformed or incomplete dialogue is rejected before H3 submission', async () => {
    const missingSpeech = canonicalDialogue();
    missingSpeech.dialogue.lines[1].speech = '';
    const dialogueCheck = videoGenerator.validateCreatorDialogue(missingSpeech);
    assert.equal(dialogueCheck.ok, false);
    assert.ok(dialogueCheck.errors.some((error) => /dialogue 2 speech is missing/.test(error)));

    const missingBeat = canonicalDialogue();
    missingBeat.guide.structure = ['hook', 'reveal', 'closing'];
    const beatCheck = videoGenerator.validateCreatorDialogue(missingBeat);
    assert.equal(beatCheck.ok, false);
    assert.ok(beatCheck.errors.some((error) => /guide beat "reveal" is missing/.test(error)));

    const missingCta = canonicalDialogue();
    missingCta.dialogue.lines[3].speech = 'That is the whole story.';
    missingCta.dialogue.text = missingCta.dialogue.lines.map((line) => line.speech).join(' ');
    const ctaCheck = videoGenerator.validateCreatorDialogue(missingCta);
    assert.equal(ctaCheck.ok, false);
    assert.ok(ctaCheck.errors.some((error) => /call to action is missing/.test(error)));

    const malformedPrompt = 'detailed_description:\n[Shot 1] The shot begins from  as the creator, Sofia (), speaks. Finally she says: .\n\noverall_soundscape:\nroom tone\n\nnon_diegetic_music:\nN/A';
    const promptCheck = videoGenerator.validateCreatorStudioPrompt(malformedPrompt, canonicalDialogue());
    assert.equal(promptCheck.ok, false);
    assert.ok(promptCheck.errors.some((error) => /empty|interpolation|truncated|missing/i.test(error)));

    await assert.rejects(
        videoGenerator.buildH3VideoPrompt({
            creator_content: true,
            reference_images: ['maya-base.png'],
            creator_dialogue: missingSpeech,
            dialogue_language: 'English',
            requested_duration: 10
        }, { chat: async () => { throw new Error('must not be called'); } }, 'ollama', 'test-model', null, 'creator-invalid', false),
        { code: 'creator_dialogue_invalid' }
    );
});

test('Test F — punctuation and contractions are preserved exactly', () => {
    const canonical = canonicalDialogue();
    canonical.dialogue.lines[0].speech = "I'm not kidding, don't try it, it's *Grins* actually fun!";
    canonical.dialogue.lines[1].speech = "Wait — really? Let's see...";
    canonical.dialogue.text = canonical.dialogue.lines.map((line) => line.speech).join(' ');
    const prompt = videoGenerator.buildCreatorStudioPrompt(canonical);
    assert.ok(prompt.includes("I'm not kidding, don't try it, it's *Grins* actually fun!"));
    assert.ok(prompt.includes("Wait — really? Let's see..."));
    assert.equal(videoGenerator.validateCreatorStudioPrompt(prompt, canonical).ok, true);
});

test('Test G — long dialogue remains complete and is not truncated', () => {
    const canonical = canonicalDialogue();
    canonical.dialogue.lines[0].speech = 'Sometimes the smallest change to your morning routine makes the biggest difference, and I promise you it is easier than it sounds, so stay with me for a second while I explain exactly how it works.';
    canonical.dialogue.text = canonical.dialogue.lines.map((line) => line.speech).join(' ');
    const prompt = videoGenerator.buildCreatorStudioPrompt(canonical);
    assert.ok(prompt.includes(canonical.dialogue.lines[0].speech));
    assert.equal(videoGenerator.validateCreatorStudioPrompt(prompt, canonical).ok, true);
});

test('the guide drives dialogue generation and no beat is dropped or timestamped', async () => {
    const content = await studio.buildCreatorContent({
        characterId: 'maya-id',
        personality: ['warm'],
        concept: 'my favorite hobby',
        contentType: 'talking',
        duration: 15
    }, makeCharacter('29-year-old'));
    assert.deepEqual(content.creatorDialogue.guide.structure, content.recipe.structure);
    assert.deepEqual(content.creatorDialogue.dialogue.lines.map((line) => line.stage), content.recipe.structure);
    assert.ok(content.creatorDialogue.dialogue.lines.every((line) => line.speech));
    assert.equal(content.creatorDialogue.guide.ctaRequired, true);
    assert.equal(videoGenerator.validateCreatorDialogue(content.creatorDialogue).ok, true);
    const prompt = videoGenerator.buildCreatorStudioPrompt(content.creatorDialogue);
    assert.doesNotMatch(prompt, /\b\d{2}:\d{2}\.\d{3}\b/);
    assert.equal(videoGenerator.validateCreatorStudioPrompt(prompt, content.creatorDialogue).ok, true);
});

test('an LLM that omits guide beats is repaired to cover every guide stage', async () => {
    const providers = {
        chat: async () => JSON.stringify({
            segments: [
                { stage: 'hook', text: 'Okay, quick one about my morning.' },
                { stage: 'closing', text: 'Try it and tell me what you think.' }
            ]
        })
    };
    const content = await studio.buildCreatorContent({
        characterId: 'maya-id',
        personality: ['playful'],
        concept: 'my favorite hobby',
        contentType: 'talking',
        duration: 15
    }, makeCharacter('29-year-old'), { providers, provider: 'ollama', model: 'test-model' });
    assert.deepEqual(content.creatorDialogue.dialogue.lines.map((line) => line.stage), content.recipe.structure);
    assert.equal(content.creatorDialogue.dialogue.lines[0].speech, 'Okay, quick one about my morning.');
    assert.equal(content.creatorDialogue.dialogue.lines[3].speech, 'Try it and tell me what you think.');
    assert.ok(content.creatorDialogue.dialogue.lines[1].speech && content.creatorDialogue.dialogue.lines[2].speech);
    assert.equal(videoGenerator.validateCreatorDialogue(content.creatorDialogue).ok, true);
});

test('resolveCreatorCanonical preserves a complete canonical dialogue object', () => {
    const canonical = videoGenerator.resolveCreatorCanonical({ creator_dialogue: canonicalDialogue() }, ['maya-base.png']);
    assert.equal(canonical.creator.name, 'Sofia');
    assert.deepEqual(canonical.guide.structure, ['hook', 'main_point', 'reaction', 'closing']);
    assert.equal(canonical.dialogue.lines.length, 4);
    assert.equal(canonical.dialogue.lines[0].speech, 'Ever feel like a productivity hack is too much work?');
    assert.equal(videoGenerator.validateCreatorDialogue(canonical).ok, true);
});

test('canonical normalization maps legacy speech beats instead of dropping the dialogue', () => {
    const canonical = videoGenerator.resolveCreatorCanonical({
        creator_name: 'Sofia',
        creator_environment: 'a cafe',
        creator_wardrobe: 'a denim jacket',
        creator_camera_direction: 'front-facing smartphone',
        creator_reference_description: 'the approved Character identity portrait supplied as <Picture 1>',
        creator_performance_beats: [
            { stage: 'hook', label: 'hook', expression: 'a soft smile', dialogue: 'Hello there, welcome back.', gaze: 'eye contact', body: 'a small gesture' }
        ]
    }, ['maya-base.png']);
    assert.equal(canonical.dialogue.lines[0].speech, 'Hello there, welcome back.');
    assert.equal(canonical.dialogue.lines[0].stage, 'hook');
    assert.equal(videoGenerator.validateCreatorDialogue(canonical).ok, true);
});

test('Creator Studio permits multiple shots only for an explicit multi-shot request', async () => {
    const providers = {
        chat: async () => JSON.stringify({
            mode: 'ref2va',
            prompt: 'subject_definitions:\n<Subject 1> is the creator in <Picture 1>.\n\n' +
                'summary:\nA creator moves between two requested scenes.\n\n' +
                'retention_analysis:\n<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - identity.\n\n' +
                'detailed_description:\n[Shot 1] The creator begins speaking. [Shot 2] At 00:05.000, the camera cuts to a close-up.\n\n' +
                'overall_soundscape:\nNatural room tone.\n\nnon_diegetic_music:\nN/A'
        })
    };
    const result = await videoGenerator.buildH3VideoPrompt({
        creator_content: true,
        creator_multi_shot: true,
        user_prompt: 'Create a montage with multiple shots.',
        reference_images: ['maya-base.png'],
        shot_plan: ['The creator starts speaking.', 'Cut to a close-up of the creator.'],
        requested_duration: 10
    }, providers, 'ollama', 'test-model', null, 'creator-multishot-test', false);

    assert.deepEqual(videoGenerator.creatorShotHeaders(result.prompt), ['[Shot 1]', '[Shot 2]']);
});

test.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
