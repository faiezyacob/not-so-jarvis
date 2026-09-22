/* ============================================
   JARVIS — H3 reference-to-video + dialogue repair
   Covers the MultiMaxH3ReferenceToVideo graph wiring
   (all approved UGC scene frames reaching the final
   video) and the deterministic dialogue repair that
   keeps the approved words + language tag in the H3
   prompt instead of letting H3 invent Mandarin.
   Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const videoGenerator = require('../services/video-generator');

// --- buildH3Graph reference wiring -------------------------------------------

test('buildH3Graph: reference images build ReferenceToVideo, not ImageToVideo', () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'integrated_multimodal_description:\n[Shot 1] matching <Picture 1>',
        mode: 'ref2va',
        W: 768,
        H: 1344,
        frames: 124,
        seed: 1,
        settings: {},
        refImageNames: ['a.png', 'b.png', 'c.png']
    });
    assert.equal(graph.condition.class_type, 'MiniMaxH3ReferenceToVideo');
    assert.equal(graph.condition.inputs['ref_images.ref_image_0'][0], 'ref_image_load_1');
    assert.equal(graph.condition.inputs['ref_images.ref_image_1'][0], 'ref_image_load_2');
    assert.equal(graph.condition.inputs['ref_images.ref_image_2'][0], 'ref_image_load_3');
    assert.equal(graph.ref_image_load_1.class_type, 'LoadImage');
    assert.equal(graph.ref_image_load_1.inputs.image, 'a.png');
    assert.equal(graph.ref_image_load_3.inputs.image, 'c.png');
    assert.equal(graph.condition.inputs.ref_image_size, 'match');
    assert.equal(graph.condition.inputs.vae[0], 'video_vae');
    // No single locked first frame in reference mode.
    assert.equal(graph.first_image, undefined);
});

test('buildH3Graph: no references still uses MiniMaxH3ImageToVideo', () => {
    const graph = videoGenerator.buildH3Graph({
        prompt: 'x',
        mode: 'i2va',
        W: 768,
        H: 1344,
        frames: 124,
        seed: 1,
        settings: {},
        firstImageName: 'first.png'
    });
    assert.equal(graph.condition.class_type, 'MiniMaxH3ImageToVideo');
    assert.equal(graph.condition.inputs.first_frame[0], 'first_image');
});

// --- ensureShotDialogue ------------------------------------------------------

test('ensureShotDialogue injects a dropped line with its language tag per shot', () => {
    const shotPlan = [
        'walks into the bathroom. The on-screen creator (S1) says: <d>[English] Okay, you have to see this.</d>',
        'applies the serum. The on-screen creator (S1) says: <d>[English] It sinks in fast.</d>'
    ];
    // The director LLM dropped both dialogue blocks (the Mandarin-dialogue bug).
    const prompt = 'integrated_multimodal_description:\n' +
        '[Shot 1] The woman walks into the bathroom. ' +
        '[Shot 2] At 00:07.500, the camera cuts to a close-up of her applying the serum.\n\n' +
        'overall_soundscape:\nTiles echo softly.\n\n' +
        'non_diegetic_music:\nN/A';
    const repaired = videoGenerator.ensureShotDialogue(prompt, shotPlan, 'English');
    assert.match(repaired, /\[Shot 1\][\s\S]*<d>\[English\] Okay, you have to see this\.<\/d>/);
    assert.match(repaired, /\[Shot 2\][\s\S]*<d>\[English\] It sinks in fast\.<\/d>/);
    // Dialogue stays out of the soundscape.
    assert.ok(repaired.indexOf('<d>') < repaired.indexOf('overall_soundscape'));
});

test('ensureShotDialogue replaces translated dialogue with the approved words', () => {
    const shotPlan = ['speaks. <d>[English] It sinks in fast.</d>'];
    const prompt = 'integrated_multimodal_description:\n[Shot 1] She speaks. <d>[Chinese] \u5f88\u5feb\u5438\u6536\u3002</d>\n\n' +
        'overall_soundscape:\nN/A\n\nnon_diegetic_music:\nN/A';
    const repaired = videoGenerator.ensureShotDialogue(prompt, shotPlan, 'English');
    assert.match(repaired, /<d>\[English\] It sinks in fast\.<\/d>/);
    assert.doesNotMatch(repaired, /Chinese/);
});

test('ensureShotDialogue leaves dialogue-free shot plans untouched', () => {
    const prompt = '[Shot 1] A dog runs.';
    assert.equal(videoGenerator.ensureShotDialogue(prompt, ['A dog runs'], 'English'), prompt);
});

// --- buildH3VideoPrompt reference mode ---------------------------------------

test('buildH3VideoPrompt: references switch to ref2va and emit the full-reference sections', async () => {
    const providers = require('../server/providers');
    const original = providers.chat;
    let seenSystem = '';
    let seenUser = '';
    providers.chat = async (provider, messages) => {
        seenSystem = String((messages[0] && messages[0].content) || '');
        seenUser = String((messages[1] && messages[1].content) || '');
        return JSON.stringify({
            mode: 'ref2va',
            prompt: 'subject_definitions:\n<Subject 1> is the creator in <Picture 1>.\n\n' +
                'summary:\n[reference generation] The target video follows <Picture 1> and <Picture 2>.\n\n' +
                'retention_analysis:\n<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - retained.\n\n' +
                'detailed_description:\nA natural UGC look. ' +
                '[Shot 1] The creator speaks. [Shot 2] At 00:05.000, the shot cuts to the product.\n\n' +
                'overall_soundscape:\nAmbient room tone.\n\n' +
                'non_diegetic_music:\nN/A'
        });
    };
    try {
        const result = await videoGenerator.buildH3VideoPrompt({
            intent: 'video_generation',
            action: 'generate',
            user_prompt: 'Direct this as a cut sequence of 2 shots.',
            previous_prompt: '',
            creative_mode: 'none',
            has_reference_image: false,
            reference_images: ['a.png', 'b.png'],
            requested_duration: 10,
            explicit_constraints: [],
            shot_plan: ['The creator speaks', 'Product close-up']
        }, providers, 'ollama', 'test-model', 'a.png', null, false);
        assert.match(seenSystem, /FULL-REFERENCE MODE/);
        assert.match(seenSystem, /subject_definitions/);
        assert.match(seenUser, /<Picture 1>/);
        assert.match(seenUser, /<Picture 2>/);
        assert.equal(result.mode, 'ref2va');
        assert.match(result.prompt, /detailed_description:/);
        assert.doesNotMatch(result.prompt, /integrated_multimodal_description/);
    } finally {
        providers.chat = original;
    }
});

test('buildH3VideoPrompt: a non-compliant ref reply falls back to the six-section document', async () => {
    const providers = require('../server/providers');
    const original = providers.chat;
    // The LLM ignores the full-reference override and returns the T2VA shape.
    providers.chat = async () => JSON.stringify({
        mode: 'i2va',
        prompt: 'For the target video, at 0.00 seconds into the target video, <Picture 1> is fully referenced.\n[Shot 1] x'
    });
    try {
        const result = await videoGenerator.buildH3VideoPrompt({
            intent: 'video_generation',
            action: 'generate',
            user_prompt: 'Direct this as a cut sequence of 2 shots.',
            previous_prompt: '',
            creative_mode: 'none',
            has_reference_image: false,
            reference_images: ['a.png', 'b.png'],
            requested_duration: 10,
            explicit_constraints: [],
            shot_plan: ['One', 'Two']
        }, providers, 'ollama', 'test-model', 'a.png', null, false);
        assert.equal(result.mode, 'ref2va');
        assert.match(result.prompt, /^subject_definitions:/);
        assert.match(result.prompt, /detailed_description:/);
        assert.match(result.prompt, /retention_analysis:/);
        assert.doesNotMatch(result.prompt, /integrated_multimodal_description/);
    } finally {
        providers.chat = original;
    }
});

test('buildReferenceFallbackPrompt emits the six full-reference sections', () => {
    const p = videoGenerator.buildReferenceFallbackPrompt({
        shotPlan: ['walks in', 'applies it'],
        referenceCount: 2,
        durationSeconds: 10
    });
    for (const section of [
        'subject_definitions:',
        'summary:',
        'retention_analysis:',
        'detailed_description:',
        'overall_soundscape:',
        'non_diegetic_music:'
    ]) {
        assert.ok(p.includes(section), section);
    }
    assert.match(p, /<Subject 1>/);
    assert.match(p, /<Picture 1>/);
    assert.match(p, /\[Shot 2\] At 00:05\.000/);
    assert.ok(!/integrated_multimodal_description/.test(p));
});
