/* ============================================
   JARVIS — Shared H3 I2V prompt system tests
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const h3Prompt = require('../services/h3-prompt');
const videoGenerator = require('../services/video-generator');
const directorPrompts = require('../services/director/director-prompts');

test('buildPromptDocument emits the four shared I2V sections in order', () => {
    const doc = h3Prompt.buildPromptDocument({
        alignment: h3Prompt.firstFrameAlignmentLine(),
        summary: 'A creator says hello.',
        detailedDescription: '[Shot 1] She waves.',
        soundscape: 'Room tone.',
        music: ''
    });
    const s = doc.indexOf('summary:');
    const d = doc.indexOf('detailed_description:');
    const o = doc.indexOf('overall_soundscape:');
    const n = doc.indexOf('non_diegetic_music:');
    assert.ok(s > -1 && d > s && o > d && n > o, 'sections must appear in order');
    assert.match(doc, /^For the target video, at 0\.00 seconds into the target video, <Picture 1> \(from \[Shot 1\]\) is fully referenced\./);
    assert.match(doc, /non_diegetic_music:\nN\/A/);
    assert.doesNotMatch(doc, /subject_definitions:|retention_analysis:|integrated_multimodal_description:/);
});

test('stripLegacyReferenceLanguage removes the full-reference format', () => {
    const legacy = 'subject_definitions:\n<Subject 1> is a woman in <Picture 1>.\n\n' +
        'summary:\nA woman sits.\n\n' +
        'retention_analysis:\n<Subject 1> (appears in [Shot 1]): fully_preserved - hair retained.\n\n' +
        'integrated_multimodal_description:\n[Shot 1] She stands.\n\n' +
        'overall_soundscape:\nRoom tone.\n\n' +
        'non_diegetic_music:\nN/A';
    const cleaned = h3Prompt.stripLegacyReferenceLanguage(legacy);
    assert.doesNotMatch(cleaned, /subject_definitions:/);
    assert.doesNotMatch(cleaned, /retention_analysis:/);
    assert.doesNotMatch(cleaned, /<Subject\s+1>/);
    assert.doesNotMatch(cleaned, /integrated_multimodal_description:/);
    assert.match(cleaned, /^summary:\n/);
    assert.match(cleaned, /detailed_description:\n\[Shot 1\] She stands\./);
    assert.match(cleaned, /overall_soundscape:\nRoom tone\./);
});

test('the shared system prompt frames H3 as I2V and forbids reference sections', () => {
    const base = h3Prompt.H3_DIRECTOR_SYSTEM_PROMPT;
    assert.match(base, /image-to-video \(I2V\)/);
    assert.match(base, /ACTUAL FIRST FRAME/);
    assert.match(base, /MOTION, NOT THE IMAGE/);
    assert.match(base, /summary:/);
    assert.match(base, /detailed_description:/);
    assert.match(base, /Never use the words "reference image", "reference video", "identity reference"/);
    assert.match(base, /subject_definitions/);
    assert.match(base, /retention_analysis/);
});

test('the deterministic Creator Studio prompt uses the shared I2V structure', () => {
    const canonical = {
        guide: { id: 'talking', name: 'Talking to Camera', structure: ['hook', 'closing'], stages: ['hook', 'closing'], ctaRequired: false, personality: ['warm'], talkingPoints: [] },
        creator: { name: 'Maya', identityDescription: 'long identity block that must not be embedded: olive skin, dark hair, brown eyes', referenceDescription: 'the opening frame supplied as <Picture 1>' },
        shot: { id: 'Shot 1', cameraStyle: 'SELFIE_SMARTPHONE_FRONT_CAMERA', cameraDirection: 'front-facing smartphone', environment: 'a bright kitchen', wardrobe: 'a cream sweater' },
        dialogue: { lines: [{ stage: 'hook', label: 'hook', speech: 'Hello there.' }, { stage: 'closing', label: 'closing', speech: 'See you soon.' }], text: 'Hello there. See you soon.' },
        performance: []
    };
    const prompt = videoGenerator.buildCreatorStudioPrompt(canonical);
    assert.match(prompt, /^For the target video, at 0\.00 seconds into the target video, <Picture 1> \(from \[Shot 1\]\) is fully referenced\./);
    assert.match(prompt, /\nsummary:\n/);
    assert.match(prompt, /\ndetailed_description:\n/);
    assert.doesNotMatch(prompt, /subject_definitions:|retention_analysis:|<Subject 1>/);
    assert.ok(!prompt.includes('long identity block'), 'the static identity block must not be logged into the prompt');
    assert.ok(prompt.includes('Hello there. See you soon.'));
    assert.deepEqual(videoGenerator.creatorShotHeaders(prompt), ['[Shot 1]']);
    assert.equal(videoGenerator.validateCreatorStudioPrompt(prompt, canonical).ok, true);
});

test('buildH3VideoPrompt sanitizes a reference-format LLM reply into the shared I2V structure', async () => {
    const providers = require('../server/providers');
    const originalChat = providers.chat;
    let seenSystem = '';
    providers.chat = async (provider, messages) => {
        seenSystem = String((messages[0] && messages[0].content) || '');
        return JSON.stringify({
            mode: 'i2va',
            prompt: 'subject_definitions:\n<Subject 1> is a woman.\n\n' +
                'retention_analysis:\n<Subject 1> ([Shot 1]): fully_preserved - identity retained.\n\n' +
                'integrated_multimodal_description:\n[Shot 1] She turns toward the window.\n\n' +
                'overall_soundscape:\nRoom tone.\n\nnon_diegetic_music:\nN/A'
        });
    };
    try {
        const result = await videoGenerator.buildH3VideoPrompt({
            intent: 'video_generation',
            action: 'generate',
            user_prompt: 'have her turn toward the window',
            creative_mode: 'none',
            has_reference_image: true,
            requested_duration: 6,
            explicit_constraints: []
        }, providers, 'ollama', 'test-model', null, null, false);
        assert.match(seenSystem, /H3 I2V Director/);
        assert.doesNotMatch(result.prompt, /subject_definitions:|retention_analysis:|<Subject\s+1>/);
        assert.doesNotMatch(result.prompt, /integrated_multimodal_description:/);
        assert.match(result.prompt, /detailed_description:/);
        assert.match(result.prompt, /\[Shot 1\] She turns toward the window\./);
    } finally {
        providers.chat = originalChat;
    }
});

test('the Director (Image Director) direction animates the opening frame as the first frame', () => {
    const brief = {
        subject: 'a young woman',
        action: 'raises a cup',
        setting: 'a cafe',
        visualStyle: 'photorealistic',
        camera: 'medium shot',
        shotList: []
    };
    const direction = directorPrompts.composeVideoDirection(brief, 5, { shotList: [] });
    assert.match(direction, /approved opening frame as the video's first frame/i);
    assert.match(direction, /instead of recreating the still image/i);
    assert.doesNotMatch(direction, /reference image/i);
});

test('the shared system prompt carries the subtle natural-teeth constraint', () => {
    const base = h3Prompt.H3_DIRECTOR_SYSTEM_PROMPT;
    assert.match(base, /NATURAL TEETH \(SUBTLE REALISM\)/);
    assert.match(base, /naturally off-white with a subtle warm ivory tone/i);
    assert.match(base, /at most ONE short clause/i);
    assert.match(base, /never make the teeth yellow, stained, dirty or visibly discolored/i);
    assert.match(base, /pure bright\s*\n?\s*white|pure bright '?\s*'?white|porcelain/i);
});

test('ensureTeethRealism adds the clause once, idempotently, and never to the soundscape', () => {
    const doc = h3Prompt.buildPromptDocument({
        alignment: h3Prompt.firstFrameAlignmentLine(),
        summary: 'A creator talks.',
        detailedDescription: '[Shot 1] She speaks to the camera.',
        soundscape: 'Room tone.',
        music: 'N/A'
    });
    const once = h3Prompt.ensureTeethRealism(doc);
    assert.equal(h3Prompt.mentionsTeeth(once), true);
    // Inserted inside the description, not the soundscape section.
    const descStart = once.indexOf('detailed_description:');
    const soundStart = once.indexOf('overall_soundscape:');
    const teethAt = once.search(/\bteeth\b/i);
    assert.ok(teethAt > descStart && teethAt < soundStart);
    // A second pass is a no-op.
    assert.equal(h3Prompt.ensureTeethRealism(once), once);
    // No description section -> untouched.
    assert.equal(h3Prompt.ensureTeethRealism('overall_soundscape:\nN/A'), 'overall_soundscape:\nN/A');
});

test('Creator Studio prompts automatically include exactly one natural-teeth clause', () => {
    const canonical = {
        guide: { id: 'talking', name: 'Talking to Camera', structure: ['hook', 'closing'], stages: ['hook', 'closing'], ctaRequired: false, personality: ['warm'], talkingPoints: [] },
        creator: { name: 'Maya', identityDescription: '', referenceDescription: 'the opening frame supplied as <Picture 1>' },
        shot: { id: 'Shot 1', cameraStyle: 'SELFIE_SMARTPHONE_FRONT_CAMERA', cameraDirection: 'front-facing smartphone', environment: 'a bright kitchen', wardrobe: 'a cream sweater' },
        dialogue: { lines: [{ stage: 'hook', label: 'hook', speech: 'Hello there.' }, { stage: 'closing', label: 'closing', speech: 'See you soon.' }], text: 'Hello there. See you soon.' },
        performance: []
    };
    const prompt = videoGenerator.buildCreatorStudioPrompt(canonical);
    const matches = prompt.match(/\bnaturally off-white\b/gi) || [];
    assert.equal(matches.length, 1);
    assert.match(prompt, /subtle warm ivory tone/i);
    assert.doesNotMatch(prompt, /yellow|stained|discolored/i);
    assert.equal(videoGenerator.validateCreatorStudioPrompt(prompt, canonical).ok, true);
});

test('buildH3VideoPrompt adds the teeth clause for a talking/talking-head request', async () => {
    const providers = require('../server/providers');
    const originalChat = providers.chat;
    providers.chat = async () => JSON.stringify({
        mode: 'i2va',
        prompt: 'summary:\nShe talks to the camera.\n\ndetailed_description:\n[Shot 1] The creator speaks directly to the camera.\n\noverall_soundscape:\nRoom tone.\n\nnon_diegetic_music:\nN/A'
    });
    try {
        const result = await videoGenerator.buildH3VideoPrompt({
            intent: 'video_generation',
            action: 'generate',
            user_prompt: 'make her talk to the camera and smile',
            previous_prompt: '',
            creative_mode: 'none',
            has_reference_image: true,
            requested_duration: 8,
            explicit_constraints: []
        }, providers, 'ollama', 'test-model', null, null, false);
        assert.match(result.prompt, /naturally off-white with a subtle warm ivory tone/i);
        const matches = result.prompt.match(/\bnaturally off-white\b/gi) || [];
        assert.equal(matches.length, 1);
        assert.match(result.prompt, /detailed_description:/);
    } finally {
        providers.chat = originalChat;
    }
});

test('the natural-teeth clause is not forced into a subject-free text prompt', () => {
    assert.equal(h3Prompt.shouldIncludeTeeth('a wide drone shot of mountains at sunrise'), false);
    assert.equal(h3Prompt.shouldIncludeTeeth('a woman smiles at the camera'), true);
    assert.equal(h3Prompt.shouldIncludeTeeth(''), false);
});
