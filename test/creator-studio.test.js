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

test('Creator Studio opening frame is a stored checkpoint with a persisted marker', () => {
    const session = studio.createOpeningFrame(null, { characterId: 'maya-id', concept: 'weekend update' }, {
        filename: 'frame one.png', url: '/generated/frame%20one.png', prompt: 'identity', seed: 42
    });
    assert.equal(session.status, 'awaiting_frame_approval');
    assert.equal(session.frame.filename, 'frame one.png');
    assert.equal(session.frame.url, '/generated/frame%20one.png');
    assert.equal(session.frame.seed, 42);
    const marker = studio.frameMarker(session);
    assert.match(marker, /\[\[creator-frame:\{/);
    const parsed = JSON.parse(marker.match(/\[\[creator-frame:(\{[^\n]*?\})\]\]/)[1]);
    assert.equal(parsed.frameId, session.frame.id);
    assert.equal(parsed.sessionId, session.id);
    assert.equal(parsed.status, 'awaiting_frame_approval');
});

test('buildFrameDirection turns the chosen camera into an explicit first-frame framing directive', () => {
    const low = studio.buildFrameDirection({ camera: 'low_angle_front' });
    assert.match(low, /FIRST FRAME FRAMING/);
    assert.match(low, /slightly below eye level/i);
    assert.match(low, /Do not default to a front-on/i);

    const tripod = studio.buildFrameDirection({ camera: 'tripod' });
    assert.match(tripod, /supported, not held/i);

    const close = studio.buildFrameDirection({ camera: 'close_talking_head' });
    assert.match(close, /close selfie-camera framing/i);

    // An unknown camera falls back to the default preset without throwing.
    assert.match(studio.buildFrameDirection({ camera: 'nope' }), /FIRST FRAME FRAMING/);
    assert.match(studio.buildFrameDirection(null), /FIRST FRAME FRAMING/);
});

test('the standalone frame plan derives from the Creator Studio settings and scales with duration', () => {
    const short = studio.buildFramePlan({
        concept: 'my new coffee maker',
        camera: 'low_angle_front',
        scene: 'a bright kitchen',
        outfit: 'a cream knit sweater',
        duration: 5,
        performanceBeats: [{ expression: 'a curious look', gesture: 'turns the mug toward the lens' }]
    });
    assert.equal(short.source, 'deterministic');
    assert.equal(short.premise, 'my new coffee maker');
    assert.equal(short.camera, 'low_angle_front');
    assert.equal(short.durationBand, 'short');
    assert.equal(short.duration, 5);
    assert.match(short.openingMoment, /curious|mug|speaking/i);
    assert.equal(short.wardrobe, 'a cream knit sweater');
    assert.equal(short.setting, 'a bright kitchen');

    const long = studio.buildFramePlan({ concept: 'a weekend update', duration: 30 });
    assert.equal(long.durationBand, 'long');
    assert.equal(long.duration, 30);
    assert.match(long.durationGuidance, /longer single-take/i);
});

test('buildFramePrompt is a standalone still-frame brief that respects content, camera, outfit and location', async () => {
    const character = makeCharacter('29-year-old');
    const content = await studio.buildCreatorContent({
        characterId: 'maya-id',
        concept: 'my honest take on morning routines',
        camera: 'close_talking_head',
        scene: 'a quiet cafe table',
        outfitPack: 'custom',
        outfitPackCustom: 'a sage linen shirt',
        duration: 8
    }, character);
    const prompt = studio.buildFramePrompt(content, character, studio.buildFramePlan(content));

    assert.match(prompt, /OPENING FRAME/);
    assert.match(prompt, /WHAT THE VIDEO IS ABOUT: my honest take on morning routines/);
    assert.match(prompt, /SETTING \/ LOCATION: a quiet cafe table/);
    assert.match(prompt, /WARDROBE: a sage linen shirt/);
    assert.match(prompt, /8-second creator video/);
    assert.match(prompt, /POSTURE: seated at the cafe table/);
    // A still frame must never carry spoken dialogue or scripted beats.
    assert.doesNotMatch(prompt, /<d>\[English\]/);
    assert.doesNotMatch(prompt, /DIALOGUE:/);
    assert.doesNotMatch(prompt, /\[Shot [0-9]\]/);

    // The camera directive is separate, explicit, and confirms the requested
    // preset instead of a front-on portrait.
    const directive = studio.buildFrameCameraDirective(content);
    assert.match(directive, /Recompose the shot to exactly match the Close Talking Head camera/i);
    assert.match(directive, /close selfie-camera framing/i);
    assert.match(directive, /must visibly change from the reference portrait/i);
});

test('frameInstruction leads and trails the final edit prompt with the camera directive', () => {
    const content = { camera: 'phone_selfie', cameraStyle: 'SELFIE_SMARTPHONE_FRONT_CAMERA' };
    const directive = studio.buildFrameCameraDirective(content);
    const wrapped = studio.frameInstruction('IDENTITY: keep the same person shown in image 1.', directive);
    assert.ok(wrapped.startsWith('SHOT / CAMERA — highest priority'));
    assert.match(wrapped, /Phone Selfie camera/);
    assert.match(wrapped, /front-facing phone-camera character/i);
    assert.match(wrapped, /mildly wide selfie lens/i);
    assert.match(wrapped, /FINAL REMINDER/);
    assert.ok(wrapped.indexOf('IDENTITY:') > wrapped.indexOf('SHOT / CAMERA'));
    // A missing camera directive leaves the instruction untouched.
    assert.equal(studio.frameInstruction('BASE', ''), 'BASE');
});

test('generateFramePlan refines the premise from the LLM but rejects production jargon', async () => {
    const character = makeCharacter('29-year-old');
    let systemPrompt = '';
    const planned = await studio.generateFramePlan({
        concept: 'a coffee maker', camera: 'phone_selfie', scene: 'a bright kitchen',
        outfit: 'a cream knit sweater', duration: 10
    }, character, {
        chat: async (_provider, messages, model, options) => {
            systemPrompt = messages[0].content;
            assert.equal(model, 'frame-test-model');
            assert.equal(options.think, false);
            return JSON.stringify({
                premise: 'An honest first impression of a coffee maker she actually uses.',
                opening_moment: 'She holds the mug up at selfie distance and begins speaking.',
                composition: '[Shot 1] At 00:02.000, cut to a close-up.'
            });
        }
    }, 'ollama', 'frame-test-model');

    assert.match(systemPrompt, /opening-frame director/i);
    assert.match(systemPrompt, /Return valid JSON only/);
    assert.equal(planned.source, 'planned');
    assert.match(planned.premise, /coffee maker she actually uses/i);
    assert.match(planned.openingMoment, /selfie distance/i);
    // The invalid composition is rejected and replaced by the deterministic one.
    assert.doesNotMatch(planned.composition, /Shot 1|00:02/);

    const fallback = await studio.generateFramePlan(
        { concept: 'a coffee maker', camera: 'phone_selfie', duration: 10 },
        character,
        { chat: async () => 'not json at all' },
        'ollama', 'frame-test-model'
    );
    assert.equal(fallback.source, 'deterministic');
    assert.equal(fallback.premise, 'a coffee maker');
});

test('normalizeAction accepts the Creator Studio frame actions', () => {
    assert.deepEqual(studio.normalizeAction({ type: 'create_video' }), { type: 'create_video' });
    assert.deepEqual(studio.normalizeAction({ type: 'regenerate_frame' }), { type: 'regenerate_frame' });
    assert.equal(studio.normalizeAction({ type: 'bogus' }), null);
});

test('recordVideo consumes the opening frame so the approval card goes stale', () => {
    const session = studio.createOpeningFrame(null, { characterId: 'maya-id', concept: 'c' }, {
        filename: 'a.png', url: '/generated/a.png'
    });
    const ready = studio.recordVideo(session, session.content, { filename: 'clip.mp4', url: '/generated/clip.mp4' });
    assert.equal(ready.status, 'ready');
    assert.equal(ready.frame, null);
    assert.equal(ready.videos.length, 1);
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
        onCameraAction: 'Holds up a small prop beside her face, then turns it toward the lens.',
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
    assert.match(content.userPrompt, /ON-CAMERA ACTION \(visual direction only; never spoken\): Holds up a small prop/);
    assert.equal(content.creatorDialogue.shot.action, 'Holds up a small prop beside her face, then turns it toward the lens.');
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

test('a custom outfit field overrides the Character wardrobe only when selected', async () => {
    const character = Object.assign(makeCharacter('29-year-old'), {
        outfitPack: 'lounge-home',
        outfitPackCustom: 'a Character saved custom wardrobe'
    });

    const automatic = await studio.buildCreatorContent({
        characterId: character.id, concept: 'a weekend update', outfit: 'Auto', outfitPack: ''
    }, character);
    assert.notEqual(automatic.outfit, 'a hand-picked slate jumpsuit');

    const custom = await studio.buildCreatorContent({
        characterId: character.id, concept: 'a weekend update', outfit: 'Auto',
        outfitPack: 'custom', outfitPackCustom: 'a hand-picked slate jumpsuit'
    }, character);
    assert.equal(custom.outfit, 'a hand-picked slate jumpsuit');
    assert.equal(custom.outfitSource, 'explicit');
    assert.equal(custom.outfitPack, 'custom');

    const explicitText = await studio.buildCreatorContent({
        characterId: character.id, concept: 'a weekend update',
        outfitPack: 'custom', outfitPackCustom: 'a hand-picked slate jumpsuit',
        outfit: 'a crimson wrap dress'
    }, character);
    assert.equal(explicitText.outfit, 'a crimson wrap dress');
});

test('talking-to-camera content defaults to a smartphone selfie camera and offers other framings', async () => {
    const selfie = await studio.buildCreatorContent({
        characterId: 'maya-id',
        concept: 'a weekend update'
    }, makeCharacter('29-year-old'));

    assert.equal(selfie.camera, 'phone_selfie');
    assert.equal(selfie.cameraStyle, 'SELFIE_SMARTPHONE_FRONT_CAMERA');
    assert.match(selfie.cameraDirection, /chest or upper torso/i);
    assert.match(selfie.cameraDirection, /selfie-distance|selfie distance|handheld movement/i);
    assert.match(selfie.shotPlan[0], /chest or upper torso/i);
    // Handheld selfies release the free hand for small conversational gestures.
    assert.match(selfie.userPrompt, /CAMERA \/ RECORDING STYLE \(SELFIE_SMARTPHONE_FRONT_CAMERA\)/);
    assert.match(selfie.userPrompt, /front-facing selfie camera/i);

    const lowAngle = await studio.buildCreatorContent({
        characterId: 'maya-id', concept: 'a weekend update', camera: 'low_angle_front'
    }, makeCharacter('29-year-old'));
    assert.match(lowAngle.cameraDirection, /slightly below eye level/i);

    const threeQuarter = await studio.buildCreatorContent({
        characterId: 'maya-id', concept: 'a weekend update', camera: 'three_quarter_eye_level'
    }, makeCharacter('29-year-old'));
    assert.match(threeQuarter.cameraDirection, /three-quarter selfie angle/i);

    const tripod = await studio.buildCreatorContent({
        characterId: 'maya-id',
        concept: 'a weekend update',
        camera: 'tripod'
    }, makeCharacter('29-year-old'));
    assert.equal(tripod.camera, 'tripod');
    assert.match(tripod.cameraDirection, /front-facing selfie camera/i);

    assert.equal(studio.resolveDimension('Change the camera angle to a front view'), 'camera');
    assert.equal(studio.matchCameraPresetFromText('Put the camera straight in front of her'), studio.CAMERA_PRESETS.find((item) => item.id === 'front_on_eye_level'));
    assert.equal(studio.matchCameraPresetFromText('Use a slightly low angle from below'), studio.CAMERA_PRESETS.find((item) => item.id === 'low_angle_front'));
    assert.equal(studio.matchCameraPresetFromText('Make it a three-quarter view'), studio.CAMERA_PRESETS.find((item) => item.id === 'three_quarter_eye_level'));
    assert.equal(studio.matchCameraPresetFromText('Shoot it as a selfie').id, 'phone_selfie');
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
    assert.equal(context.onCameraAction, '');
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
    assert.ok(result.every((item) => /coffee maker/i.test(item.text)));
    assert.equal(new Set(result.map((item) => item.text)).size, result.length);
    assert.ok(result.every((item) => !/\[Shot [2-9]\]|cinematic|shot list/i.test(item.text)));

    const tutorialContext = studio.buildContentSuggestionContext(null, {
        characterId: character.id, contentType: 'tutorial', personality: ['warm'], duration: 8,
        camera: 'phone_selfie', concept: '', scene: 'Auto'
    }, character);
    const tutorialIdeas = studio.contentSuggestionFallback(tutorialContext);
    assert.ok(tutorialIdeas.some((idea) => /quick|under 8 seconds|simple/i.test(idea.text)));
});

test('AI suggestions stay anchored to the selected concept and preserve its chosen action', () => {
    const context = studio.buildContentSuggestionContext(null, {
        concept: 'My new coffee maker',
        contentType: 'product_review',
        onCameraAction: 'Holds the coffee maker beside her and turns it toward the camera.'
    }, Object.assign(makeCharacter('29-year-old'), {
        identity: { age: '29-year-old', ageGroup: 'adult', gender: 'woman' }
    }));
    const suggestions = studio.normalizeContentSuggestions({ suggestions: [
        { concept: 'Tell a funny story about a beach day.', action: 'Picks up sunglasses.' },
        { concept: 'Share what surprised me about my coffee maker.', action: 'Gestures toward its controls.' }
    ] }, context);

    assert.equal(suggestions.some((item) => /beach day/i.test(item.concept)), false);
    assert.ok(suggestions.every((item) => /coffee|maker/i.test(item.concept)));
    assert.ok(suggestions.every((item) => item.action === context.onCameraAction));
});

test('AI suggestions stay anchored to existing content while varying by rotated angle', () => {
    const character = Object.assign(makeCharacter('29-year-old'), {
        identity: { age: '29-year-old', ageGroup: 'adult', gender: 'woman' }
    });
    const makeContext = () => {
        const context = studio.buildContentSuggestionContext(null, {
            characterId: character.id, contentType: 'product_review', personality: ['confident'],
            duration: 10, camera: 'phone_selfie', concept: 'My new coffee maker'
        }, character);
        context.suggestionAngles = studio.selectSuggestionAngles(4, []);
        return context;
    };
    const first = studio.contentSuggestionFallback(makeContext());
    const second = studio.contentSuggestionFallback(makeContext());
    assert.ok(first.length >= 3);
    assert.ok(first.every((item) => /coffee maker/i.test(item.text)));
    assert.ok(second.every((item) => /coffee maker/i.test(item.text)));
    assert.equal(new Set(first.map((item) => item.text)).size, first.length);
    assert.notDeepEqual(first.map((item) => item.text), second.map((item) => item.text));
});

test('suggestion generation asks the configured provider for structured ideation and recovers short output', async () => {
    const character = Object.assign(makeCharacter('29-year-old'), {
        identity: { age: '29-year-old', ageGroup: 'adult', gender: 'woman' }
    });
    const context = studio.buildContentSuggestionContext(null, {
        characterId: character.id, contentType: 'comedy', personality: ['funny', 'playful'],
        speechBehavior: 'conversational', duration: 12, camera: 'phone_selfie', concept: '', scene: 'Bedroom',
        onCameraAction: 'Holds a mug while telling the story.'
    }, character);
    let prompt = '';
    const result = await studio.generateContentSuggestions(context, {
        chat: async (_provider, messages, model, options) => {
            prompt = messages.map((message) => message.content).join('\n');
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
    assert.match(prompt, /concept is what the fictional creator will talk about/i);
    assert.match(prompt, /action is what they physically do on camera/i);
    assert.match(prompt, /Holds a mug while telling the story/);
    assert.ok(result.length >= 3);
    assert.equal(result[0].text, 'Tell a quick story about confidently waving back at the wrong person.');
    assert.ok(result[0].action);
    assert.ok(result.every((item) => !/\[Shot 2\]/.test(item.text)));
});

test('AI suggestions rotate through distinct angles so repeated requests do not repeat a topic', () => {
    const first = studio.selectSuggestionAngles(4, []);
    const second = studio.selectSuggestionAngles(4, []);
    assert.equal(first.length, 4);
    assert.equal(second.length, 4);
    assert.equal(first[0].id === second[0].id, false);
    assert.equal(new Set(first.map((angle) => angle.id)).size, 4);

    const character = Object.assign(makeCharacter('29-year-old'), {
        identity: { age: '29-year-old', ageGroup: 'adult', gender: 'woman' }
    });
    const context = studio.buildContentSuggestionContext(null, {
        characterId: character.id, contentType: 'talking', personality: ['playful'], duration: 15,
        camera: 'phone_selfie', concept: '', scene: 'Auto'
    }, character);
    context.suggestionAngles = studio.selectSuggestionAngles(4, []);
    const ideas = studio.contentSuggestionFallback(context);
    assert.equal(ideas.length, 4);
    assert.equal(new Set(ideas.map((idea) => idea.text)).size, ideas.length);
    assert.ok(ideas.every((idea) => idea.action));
});

test('AI suggestions avoid repeating ideas already shown to the user', () => {
    const character = Object.assign(makeCharacter('29-year-old'), {
        identity: { age: '29-year-old', ageGroup: 'adult', gender: 'woman' }
    });
    const context = studio.buildContentSuggestionContext(null, {
        characterId: character.id, contentType: 'talking', personality: ['playful'], duration: 15,
        camera: 'phone_selfie', concept: '', scene: 'Auto',
        exclude: ['Share a bold, playful opinion about a small everyday moment and why you feel that way.']
    }, character);
    assert.equal(context.avoidSuggestions.length, 1);
    const normalized = studio.normalizeContentSuggestions({ suggestions: [
        { concept: 'Share a bold, playful opinion about a small everyday moment and why you feel that way.' },
        { concept: 'Describe a tiny behind-the-scenes detail that most people never notice.' }
    ] }, context);
    assert.equal(normalized.some((item) => /bold, playful opinion/i.test(item.concept)), false);
    assert.ok(normalized.some((item) => /behind-the-scenes detail/i.test(item.concept)));
});

test('AI suggestions keep returning a varied full set as the angle pool cycles', async () => {
    const character = Object.assign(makeCharacter('29-year-old'), {
        identity: { age: '29-year-old', ageGroup: 'adult', gender: 'woman' }
    });
    const avoid = [];
    for (let i = 0; i < 8; i++) {
        const context = studio.buildContentSuggestionContext(null, {
            concept: 'My new coffee maker', contentType: 'product_review', personality: ['confident'],
            duration: 10, camera: 'phone_selfie', exclude: avoid.slice(-16)
        }, character);
        const result = await studio.generateContentSuggestions(context, null);
        assert.ok(result.length >= 3, 'click ' + i + ' returned ' + result.length);
        assert.ok(result.every((item) => /coffee maker/i.test(item.text)));
        assert.equal(new Set(result.map((item) => item.text)).size, result.length);
        result.forEach((item) => avoid.push(item.text));
    }
});

test('suggestion prompts ask for one distinct angle per idea and carry the avoid list', async () => {
    const character = Object.assign(makeCharacter('29-year-old'), {
        identity: { age: '29-year-old', ageGroup: 'adult', gender: 'woman' }
    });
    const context = studio.buildContentSuggestionContext(null, {
        characterId: character.id, contentType: 'talking', personality: ['playful'], duration: 15,
        camera: 'phone_selfie', concept: '', scene: 'Auto',
        exclude: ['React to a small, oddly relatable annoyance about your everyday life.']
    }, character);
    let prompt = '';
    await studio.generateContentSuggestions(context, {
        chat: async (_provider, messages) => {
            prompt = messages.map((message) => message.content).join('\n');
            return JSON.stringify({ suggestions: [
                { concept: 'Rank three small things about a daily routine.', action: 'Counts on her fingers.' },
                { concept: 'Bust one common myth about getting ready in the morning.', action: 'Shakes her head playfully.' }
            ] });
        }
    }, 'ollama', 'suggestion-test-model');
    assert.match(prompt, /one suggestion per angle/i);
    assert.match(prompt, /DIFFERENT angle/i);
    assert.match(prompt, /already shown to the user/i);
    assert.match(prompt, /relatable annoyance/i);
    assert.match(prompt, /morning routines, coffee, mugs/i);
    assert.ok(context.suggestionAngles.length >= 4);
});

test('natural follow-ups identify and rebuild only the requested performance layer', async () => {
    const character = makeCharacter('29-year-old');
    const first = await studio.buildCreatorContent({
        characterId: 'maya-id',
        personality: ['warm'],
        concept: 'weekend update',
        onCameraAction: 'Holds a small product beside her face and turns it toward the lens.',
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
    assert.equal(updated.onCameraAction, first.onCameraAction);
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

test('Creator performance beats become timestamped events inside exactly one continuous H3 shot, deterministically', async () => {
    const content = await studio.buildCreatorContent({
        characterId: 'maya-id',
        personality: ['playful'],
        concept: 'a weekend update',
        onCameraAction: 'Holds the product beside her face and turns it toward the camera.',
        duration: 15
    }, makeCharacter('29-year-old'));
    let llmCalled = false;
    const providers = {
        chat: async () => { llmCalled = true; throw new Error('the deterministic Creator Studio builder must not call an LLM'); }
    };
    const result = await videoGenerator.buildH3VideoPrompt({
        creator_content: true,
        user_prompt: content.userPrompt,
        has_reference_image: true,
        shot_plan: content.shotPlan,
        creator_performance_beats: content.performanceSequence,
        creator_dialogue: content.creatorDialogue,
        creator_name: content.creatorName,
        creator_environment: content.scene,
        creator_wardrobe: content.outfit,
        creator_camera_direction: content.cameraDirection,
        creator_action: content.onCameraAction,
        dialogue_language: 'English',
        requested_duration: 15,
        explicit_constraints: []
    }, providers, 'ollama', 'test-model', 'opening-frame.png', 'creator-test', false);

    assert.equal(llmCalled, false);
    assert.equal(result.mode, 'i2va');
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
    assert.match(result.prompt, /Creator Studio camera style: SELFIE_SMARTPHONE_FRONT_CAMERA/);
    assert.match(result.prompt, /smartphone selfie video recorded by the creator using the phone's front-facing camera/i);
    assert.match(result.prompt, /The creator looks directly into the front-facing phone lens while speaking/i);
    assert.match(result.prompt, /subtle natural handheld micro-movement/i);
    assert.match(result.prompt, /On-camera action \(visual direction only; this is NOT dialogue and must never be spoken\): Holds the product beside her face/);
    assert.doesNotMatch(result.prompt.match(/<d>\[English\]([\s\S]*?)<\/d>/)[1], /Holds the product beside her face/);
    assert.doesNotMatch(result.prompt, /straight-on front-facing camera/i);
    assert.doesNotMatch(result.prompt, /stable camera position/i);
    assert.doesNotMatch(result.prompt, /level horizon/i);
    assert.doesNotMatch(result.prompt, /no camera repositioning/i);
    assert.doesNotMatch(result.prompt, /lens changes and no framing changes/i);
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
            referenceDescription: 'the opening frame supplied as <Picture 1>'
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
            has_reference_image: true,
            creator_dialogue: missingSpeech,
            dialogue_language: 'English',
            requested_duration: 10
        }, { chat: async () => { throw new Error('must not be called'); } }, 'ollama', 'test-model', 'opening-frame.png', 'creator-invalid', false),
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

test('a paraphrased script is repaired to retain a required topic point', async () => {
    let scriptPrompt = '';
    const providers = {
        chat: async (_provider, messages) => {
            scriptPrompt = String(messages[1] && messages[1].content || '');
            const stages = ['hook', 'main_point', 'reaction', 'closing'];
            return JSON.stringify({
                segments: stages.map((stage) => ({
                    stage,
                    text: stage === 'closing' ? 'Tell me what you think.' : 'Here is something I wanted to share.'
                }))
            });
        }
    };
    const content = await studio.buildCreatorContent({
        characterId: 'maya-id',
        personality: ['warm'],
        concept: 'a skincare routine for dry skin',
        contentType: 'talking',
        duration: 15
    }, makeCharacter('29-year-old'), { providers, provider: 'ollama', model: 'test-model' });
    const dialogue = content.creatorDialogue.dialogue.text.toLowerCase();
    assert.match(scriptPrompt, /required talking-point terms/i);
    assert.ok(content.creatorDialogue.guide.talkingPoints.some((point) => dialogue.includes(point)));
    assert.equal(videoGenerator.validateCreatorDialogue(content.creatorDialogue).ok, true);
});

test('resolveCreatorCanonical preserves a complete canonical dialogue object', () => {
    const canonical = videoGenerator.resolveCreatorCanonical({ creator_dialogue: canonicalDialogue() });
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
        creator_reference_description: 'the opening frame supplied as <Picture 1>',
        creator_performance_beats: [
            { stage: 'hook', label: 'hook', expression: 'a soft smile', dialogue: 'Hello there, welcome back.', gaze: 'eye contact', body: 'a small gesture' }
        ]
    });
    assert.equal(canonical.dialogue.lines[0].speech, 'Hello there, welcome back.');
    assert.equal(canonical.dialogue.lines[0].stage, 'hook');
    assert.equal(videoGenerator.validateCreatorDialogue(canonical).ok, true);
});

test('Creator Studio permits multiple shots only for an explicit multi-shot request', async () => {
    const providers = {
        chat: async () => JSON.stringify({
            mode: 'i2va',
            prompt: 'integrated_multimodal_description:\n[Shot 1] The creator begins speaking. [Shot 2] At 00:05.000, the camera cuts to a close-up.\n\n' +
                'overall_soundscape:\nNatural room tone.\n\nnon_diegetic_music:\nN/A'
        })
    };
    const result = await videoGenerator.buildH3VideoPrompt({
        creator_content: true,
        creator_multi_shot: true,
        user_prompt: 'Create a montage with multiple shots.',
        has_reference_image: true,
        shot_plan: ['The creator starts speaking.', 'Cut to a close-up of the creator.'],
        requested_duration: 10
    }, providers, 'ollama', 'test-model', 'opening-frame.png', 'creator-multishot-test', false);

    assert.deepEqual(videoGenerator.creatorShotHeaders(result.prompt), ['[Shot 1]', '[Shot 2]']);
});

test('Creator Studio derives a natural location posture from the shot environment', () => {
    assert.equal(studio.poseForLocation('a quiet cafe table').stance, 'sitting');
    assert.equal(studio.poseForLocation('a bright kitchen').stance, 'standing');
    assert.equal(studio.poseForLocation('her cozy bedroom').stance, 'sitting');
    assert.equal(studio.poseForLocation('a generic empty void').stance, 'standing');
    assert.equal(studio.poseForLocation('a generic empty void').id, 'default');
});

test('an explicitly requested stance overrides the location posture', () => {
    const pose = studio.poseForLocation('her cozy bedroom', 'she wants to be standing up for this one');
    assert.equal(pose.stance, 'standing');
    assert.equal(pose.source, 'explicit');
});

test('Creator content anchors a location pose and the H3 prompt keeps it grounded', async () => {
    const content = await studio.buildCreatorContent({
        characterId: 'maya-id',
        concept: 'a weekend update',
        scene: 'a quiet cafe table',
        duration: 15
    }, makeCharacter('29-year-old'));
    assert.equal(content.poseId, 'cafe');
    assert.equal(content.creatorDialogue.shot.pose, content.pose);
    assert.equal(content.creatorDialogue.shot.pose, studio.LOCATION_POSES.cafe.phrase);
    assert.match(content.userPrompt, /POSTURE: seated at the cafe table/);
    assert.match(content.userPrompt, /PHYSICAL BEHAVIOUR:/);
    assert.match(content.shotPlan[0], /Posture: seated at the cafe table/);

    const prompt = videoGenerator.buildCreatorStudioPrompt(content.creatorDialogue);
    assert.ok(prompt.includes(studio.LOCATION_POSES.cafe.phrase));
    assert.ok(prompt.includes(studio.POSTURE_CONTINUITY));
    assert.match(prompt, /Creator Studio camera style: SELFIE_SMARTPHONE_FRONT_CAMERA/);
    assert.doesNotMatch(prompt, /Posture \(constant/);
    assert.equal(videoGenerator.validateCreatorStudioPrompt(prompt, content.creatorDialogue).ok, true);
});

test('a scene change moves the creator posture with the location', async () => {
    const character = makeCharacter('29-year-old');
    const first = await studio.buildCreatorContent({
        characterId: 'maya-id', concept: 'a weekend update', scene: 'a quiet cafe table', duration: 15
    }, character);
    assert.equal(first.poseId, 'cafe');
    const moved = await studio.buildCreatorContent({
        characterId: 'maya-id', dimension: 'scene', scene: 'a bright kitchen',
        message: 'Change the scene to a bright kitchen'
    }, character, { previousSession: { characterId: character.id, content: first } });
    assert.equal(moved.poseId, 'kitchen');
    assert.equal(moved.pose, studio.LOCATION_POSES.kitchen.phrase);
    assert.equal(moved.creatorDialogue.shot.pose, studio.LOCATION_POSES.kitchen.phrase);
});

test('Creator Studio selfie camera style holds across talking, activity, gesture and wider-framing scenarios', async () => {
    const character = makeCharacter('29-year-old');
    const scenarios = [
        { name: 'talking in a kitchen', input: { concept: 'a quick kitchen update', scene: 'a bright kitchen' } },
        { name: 'discussing a topic', input: { concept: 'my honest take on everyday productivity', contentType: 'talking' } },
        { name: 'demonstrating an activity', input: { concept: 'making a simple coffee', onCameraAction: 'Demonstrates pouring a coffee on the counter.', scene: 'a bright kitchen' } },
        { name: 'expressive hand gestures', input: { concept: 'a lively weekend story', onCameraAction: 'Uses big, expressive hand gestures while telling the story.' } },
        { name: 'wider framing for a location', input: { concept: 'a styling update', scene: 'a spacious living room' } }
    ];
    for (const scenario of scenarios) {
        const content = await studio.buildCreatorContent(Object.assign({ characterId: 'maya-id', duration: 15 }, scenario.input), character);
        const prompt = videoGenerator.buildCreatorStudioPrompt(content.creatorDialogue);
        assert.match(prompt, /Creator Studio camera style: SELFIE_SMARTPHONE_FRONT_CAMERA/, scenario.name);
        assert.match(prompt, /smartphone selfie video recorded by the creator using the phone's front-facing camera/i, scenario.name);
        assert.match(prompt, /directly into the front-facing phone lens/i, scenario.name);
        assert.deepEqual(videoGenerator.creatorShotHeaders(prompt), ['[Shot 1]'], scenario.name);
        assert.doesNotMatch(prompt, /\[Shot [2-9]\]/, scenario.name);
        assert.doesNotMatch(prompt, /(?:dolly|orbit|camera tracking|push-in|pull-out|tripod commercial)/i, scenario.name);
        assert.doesNotMatch(prompt, /(?:stable camera position|level horizon|camera remains steady|locked-off|consistent lens perspective|professional camera)/i, scenario.name);
        assert.equal(videoGenerator.validateCreatorStudioPrompt(prompt, content.creatorDialogue).ok, true, scenario.name);
    }
});

test('Creator Studio prevents the flying-toward-camera failure with one grounding and one distance rule', async () => {
    const content = await studio.buildCreatorContent({
        characterId: 'maya-id', concept: 'a weekend update', duration: 15
    }, makeCharacter('29-year-old'));
    const prompt = videoGenerator.buildCreatorStudioPrompt(content.creatorDialogue);
    const distanceMentions = prompt.match(/maintains a natural selfie distance from the phone/gi) || [];
    assert.equal(distanceMentions.length, 1);
    assert.match(prompt, /does not suddenly approach, lunge, fly, float or rush toward the camera/i);
    assert.match(prompt, /remains naturally grounded and comfortable while recording herself/i);
    assert.match(prompt, /does not walk, jump, fly, float, teleport, lunge toward the phone/i);
    assert.doesNotMatch(prompt, /(?:physically plausible|correctly placed|keeps one stable)/i);
});

test('a handheld selfie keeps the free hand for gestures while a supported phone frees both hands', async () => {
    const handheld = await studio.buildCreatorContent({
        characterId: 'maya-id', concept: 'a weekend update', camera: 'phone_selfie', duration: 15
    }, makeCharacter('29-year-old'));
    const handheldPrompt = videoGenerator.buildCreatorStudioPrompt(handheld.creatorDialogue);
    assert.match(handheldPrompt, /gestures with the free hand while speaking/i);

    const supported = await studio.buildCreatorContent({
        characterId: 'maya-id', concept: 'a weekend update', camera: 'tripod', duration: 15
    }, makeCharacter('29-year-old'));
    const supportedPrompt = videoGenerator.buildCreatorStudioPrompt(supported.creatorDialogue);
    assert.match(supportedPrompt, /both hands are free for small, natural conversational gestures/i);
    // Never invent extra arms/hands for a phone that is held.
    assert.doesNotMatch(handheldPrompt, /additional (?:arms|hands)|third hand|extra hands/i);
});

test.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
