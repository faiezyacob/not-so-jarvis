/* ============================================
   JARVIS — Video Character Replacement (@video/@image)
   Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Hermetic temp dirs/files must be in place before any service captures its
// storage paths at require time.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-repl-'));
process.env.GENERATED_DIR = path.join(TMP, 'generated');
process.env.IMAGES_DIR = path.join(TMP, 'images');
process.env.GENERATED_HISTORY_PATH = path.join(TMP, 'generated-history.json');
process.env.CONVERSATIONS_PATH = path.join(TMP, 'conversations.json');
fs.mkdirSync(process.env.GENERATED_DIR, { recursive: true });
fs.mkdirSync(process.env.IMAGES_DIR, { recursive: true });

const videoReplacement = require('../services/video-replacement');
const conversationAssets = require('../services/conversation-assets');
const conversationService = require('../server/conversation-service');
const generatedHistory = require('../services/generated-history');

function writeMedia(dir, name, bytes) {
    fs.writeFileSync(path.join(dir, name), Buffer.from(bytes || [1, 2, 3, 4]));
}

function asset(filename, origin, type) {
    const dir = origin === 'upload' ? process.env.IMAGES_DIR : process.env.GENERATED_DIR;
    return { filename, origin, type, absPath: path.join(dir, filename), url: '/' + (origin === 'upload' ? 'images' : 'generated') + '/' + filename };
}

// --- Intent detection ---------------------------------------------------------

test('detectReferenceReplacement: fires on a video-replacement request', () => {
    const hit = videoReplacement.detectReferenceReplacement(
        'Replace the people in @video1 with the people from @image1 and @image2, respectively.',
        { hasVideoReference: true, hasImageReference: true }
    );
    assert.equal(hit.detected, true);
    assert.equal(hit.needsVideo, false);
    assert.equal(hit.needsImages, false);
});

test('detectReferenceReplacement: does not fire on ordinary video generation', () => {
    const miss = videoReplacement.detectReferenceReplacement('Make a video of a kite flying over a beach', {});
    assert.equal(miss.detected, false);
});

test('detectReferenceReplacement: does not hijack a non-person edit', () => {
    const miss = videoReplacement.detectReferenceReplacement('Generate a video and replace the background with a beach', {});
    assert.equal(miss.detected, false);
});

test('detectReferenceReplacement: recognizes a motion-transfer request', () => {
    const hit = videoReplacement.detectReferenceReplacement('Make @image3 perform the same action as the person in @video1', { hasVideoReference: true, hasImageReference: true });
    assert.equal(hit.detected, true);
});

test('detectReferenceReplacement: recognizes "switch ... for" wording', () => {
    const hit = videoReplacement.detectReferenceReplacement(
        'switch the people on the @video1 for the ones on the two images provided', {}
    );
    assert.equal(hit.detected, true);
});

test('detectReferenceReplacement: recognizes "use ... in" wording', () => {
    const hit = videoReplacement.detectReferenceReplacement(
        'Use the people from @image1 and @image2 in @video1', {}
    );
    assert.equal(hit.detected, true);
});

test('detectReferenceReplacement: reports a missing video', () => {
    const hit = videoReplacement.detectReferenceReplacement('Replace the woman in the video with @image1', {});
    assert.equal(hit.detected, true);
    assert.equal(hit.needsVideo, true);
});

test('detectReferenceReplacement: reports missing images', () => {
    const hit = videoReplacement.detectReferenceReplacement('Replace the person in @video1 with a new face', { hasVideoReference: true });
    assert.equal(hit.detected, true);
    assert.equal(hit.needsImages, true);
});

// --- Plan construction --------------------------------------------------------

test('buildReplacementPlan: requires a source video', () => {
    const result = videoReplacement.buildReplacementPlan({ message: 'replace', sourceVideo: null, replacements: [] });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'replacement_source_video_missing');
});

test('buildReplacementPlan: requires at least one replacement image', () => {
    const result = videoReplacement.buildReplacementPlan({
        message: 'replace', sourceVideo: asset('clip.mp4', 'generated', 'video'), replacements: []
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'replacement_images_missing');
});

test('buildReplacementPlan: multiple images without a mapping cue is ambiguous (with a candidate plan)', () => {
    const result = videoReplacement.buildReplacementPlan({
        message: 'Replace the people in @video1 with @image1 and @image2',
        sourceVideo: asset('clip.mp4', 'generated', 'video'),
        replacements: [asset('a.png', 'upload', 'image'), asset('b.png', 'upload', 'image')]
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'replacement_mapping_ambiguous');
    assert.equal(result.ambiguous, true);
    assert.ok(result.plan);
    assert.equal(result.plan.assumedOrder, true);
    const serialized = videoReplacement.serializeReplacementPlan(result.plan);
    assert.equal(serialized.replacements.length, 2);
    assert.ok(serialized.replacements[0].url);
    assert.ok(serialized.sourceVideo.url);
});

test('buildReplacementPlan: assumeOrder bypasses the ambiguity gate', () => {
    const result = videoReplacement.buildReplacementPlan({
        message: 'replace',
        sourceVideo: asset('clip.mp4', 'generated', 'video'),
        replacements: [asset('a.png', 'upload', 'image'), asset('b.png', 'upload', 'image')],
        assumeOrder: true
    });
    assert.equal(result.ok, true);
    assert.equal(result.plan.replacements.length, 2);
});

test('buildReplacementPlan: "respectively" resolves the mapping', () => {
    const result = videoReplacement.buildReplacementPlan({
        message: 'Replace the two people in @video1 with @image1 and @image2, respectively',
        sourceVideo: asset('clip.mp4', 'generated', 'video'),
        replacements: [asset('a.png', 'upload', 'image'), asset('b.png', 'upload', 'image')]
    });
    assert.equal(result.ok, true);
    assert.equal(result.plan.replacements.length, 2);
    assert.equal(result.plan.intent, 'video_character_replacement');
});

test('buildReplacementPlan: a single image is unambiguous', () => {
    const result = videoReplacement.buildReplacementPlan({
        message: 'Replace the woman in @video1 with @image1',
        sourceVideo: asset('clip.mp4', 'generated', 'video'),
        replacements: [asset('a.png', 'upload', 'image')]
    });
    assert.equal(result.ok, true);
});

// --- Dynamic count, targets, transfer modes and preservation ------------------

test('inferReplacementCount: explicit number wins', () => {
    assert.equal(videoReplacement.inferReplacementCount('replace three people in @video1', 3).count, 3);
    assert.equal(videoReplacement.inferReplacementCount('replace 2 people in @video1', 2).count, 2);
    assert.equal(videoReplacement.inferReplacementCount('replace the two people in @video1', 1).count, 2);
});

test('inferReplacementCount: everyone means every supplied identity', () => {
    const r = videoReplacement.inferReplacementCount('replace everyone with @image1 @image2 @image3', 3);
    assert.equal(r.count, 3);
    assert.equal(r.scope, 'all');
});

test('inferReplacementCount: singular phrasing means one target even with several images', () => {
    const r = videoReplacement.inferReplacementCount('replace the person on the right with @image1', 2);
    assert.equal(r.count, 1);
    assert.equal(r.explicit, true);
});

test('inferReplacementCount: multiple images without a count stay in-order', () => {
    const r = videoReplacement.inferReplacementCount('replace the people with @image1 and @image2', 2);
    assert.equal(r.count, 2);
    assert.equal(r.explicit, false);
});

test('extractTargetDescriptors: keeps text order for positions', () => {
    const d = videoReplacement.extractTargetDescriptors(
        'replace the person on the right with @image1 and the person on the left with @image2'
    );
    assert.equal(d.length, 2);
    assert.equal(d[0].position, 'right');
    assert.equal(d[1].position, 'left');
});

test('extractTargetDescriptors: attaches gender to a position', () => {
    const d = videoReplacement.extractTargetDescriptors('replace the woman on the left with @image1');
    assert.equal(d[0].position, 'left');
    assert.match(d[0].label, /woman on the left/);
});

test('resolveReplacementMode: identity-only is the default; outfit transfer is detected', () => {
    assert.equal(videoReplacement.resolveReplacementMode('replace the woman with @image1'), 'identity_only');
    assert.equal(videoReplacement.resolveReplacementMode('replace the woman with @image1 but keep her original clothes'), 'identity_only');
    assert.equal(videoReplacement.resolveReplacementMode('replace the two people with @image1 and @image2. Use their outfits from the images.'), 'identity_and_outfit');
    assert.equal(videoReplacement.resolveReplacementMode('replace the person with @image1, full appearance including clothing'), 'full_appearance');
    // "keep their outfits from the images" means transfer the reference outfit.
    assert.equal(videoReplacement.resolveReplacementMode('replace all three people with @image1, @image2, and @image3. Keep their outfits from the images.'), 'identity_and_outfit');
    // An explicit "original" garment is preserved.
    assert.equal(videoReplacement.resolveReplacementMode('replace the person with @image1 but keep their original outfit'), 'identity_only');
});

test('resolveAudioPolicy: reuses the source audio but never claims 1:1 preservation', () => {
    const withAudio = videoReplacement.resolveAudioPolicy('replace the people with @image1', true);
    assert.equal(withAudio.policy, 'partially_copy');
    const noAudio = videoReplacement.resolveAudioPolicy('replace the people with @image1', false);
    assert.equal(noAudio.policy, 'none');
    const removed = videoReplacement.resolveAudioPolicy('replace the people with @image1 but remove the audio', true);
    assert.equal(removed.policy, 'none');
});

test('buildReplacementPlan: a stated count larger than the images is rejected', () => {
    const result = videoReplacement.buildReplacementPlan({
        message: 'replace three people with @image1 and @image2',
        sourceVideo: asset('clip.mp4', 'generated', 'video'),
        replacements: [asset('a.png', 'upload', 'image'), asset('b.png', 'upload', 'image')]
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'replacement_images_insufficient');
});

test('buildReplacementPlan: a stated single target with several images asks to confirm (never silently drops)', () => {
    const result = videoReplacement.buildReplacementPlan({
        message: 'replace the person on the right with @image1',
        sourceVideo: asset('clip.mp4', 'generated', 'video'),
        replacements: [asset('a.png', 'upload', 'image'), asset('b.png', 'upload', 'image')]
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'replacement_count_mismatch');
    assert.equal(result.ambiguous, true);
    assert.equal(result.plan.replacements.length, 1);
    assert.equal(result.plan.countAdjusted, true);
    assert.equal(result.plan.ignoredReferences.length, 1);
});

test('buildReplacementPlan: explicit position bindings map each target to its image', () => {
    const result = videoReplacement.buildReplacementPlan({
        message: 'replace the person on the right with @image2 and the person on the left with @image1',
        sourceVideo: asset('clip.mp4', 'generated', 'video'),
        replacements: [asset('a.png', 'upload', 'image'), asset('b.png', 'upload', 'image')],
        assumeOrder: true
    });
    assert.equal(result.ok, true);
    const targets = result.plan.targets;
    assert.equal(targets[0].position, 'right');
    assert.equal(targets[0].referenceIndex, 2);
    assert.equal(targets[1].position, 'left');
    assert.equal(targets[1].referenceIndex, 1);
    // The replacements are reordered to match the targets.
    assert.equal(result.plan.replacements[0].filename, 'b.png');
    assert.equal(result.plan.replacements[1].filename, 'a.png');
});

test('extractTargetDescriptors: does not treat a scene background as a target', () => {
    const d = videoReplacement.extractTargetDescriptors(
        'replace the person on the left with @image1. preserve the background and the original audio.'
    );
    assert.equal(d.length, 1);
    assert.equal(d[0].position, 'left');
});

test('extractExtraDirection: drops the replacement sentence but keeps extra direction', () => {
    const extra = videoReplacement.extractExtraDirection(
        'Replace the person on the left with @image1. Make her smile warmly and keep the golden-hour lighting.'
    );
    assert.doesNotMatch(extra, /Replace the person on the left/i);
    assert.match(extra, /Make her smile warmly/);
});

test('parseReplacementRequest: "leave everyone else unchanged" keeps non-target people', () => {
    const request = videoReplacement.parseReplacementRequest(
        'replace the woman in the middle with @image1 but leave everyone else unchanged',
        { imageCount: 1, hasAudio: false }
    );
    assert.equal(request.count.count, 1);
    assert.equal(request.preserve.nonTargetPeople, true);
});

test('rehydrateReplacementPlan: round-trips mode, targets and preservation', () => {
    const result = videoReplacement.buildReplacementPlan({
        message: 'replace the two people with @image1 and @image2, respectively. Use their outfits from the images but keep the background.',
        sourceVideo: asset('clip.mp4', 'generated', 'video'),
        replacements: [asset('a.png', 'upload', 'image'), asset('b.png', 'upload', 'image')],
        hasAudio: true
    });
    const serialized = videoReplacement.serializeReplacementPlan(result.plan);
    const rebuilt = videoReplacement.rehydrateReplacementPlan(serialized, result.plan.sourceVideo, result.plan.replacements);
    assert.equal(rebuilt.replaceMode, 'identity_and_outfit');
    assert.equal(rebuilt.audioPolicy, 'partially_copy');
    assert.equal(rebuilt.targets.length, 2);
    assert.equal(rebuilt.preserve.background, true);
    assert.equal(rebuilt.preserve.clothing, false);
});

// --- Prompt construction ------------------------------------------------------

test('buildReplacementPrompt: follows the official six-section reference format', () => {
    const plan = videoReplacement.buildReplacementPlan({
        message: 'Replace the two people in @video1 with @image1 and @image2, respectively. Use their outfits from the images but keep the original background.',
        sourceVideo: asset('clip.mp4', 'generated', 'video'),
        replacements: [asset('a.png', 'upload', 'image'), asset('b.png', 'upload', 'image')],
        hasAudio: true
    }).plan;
    const prompt = videoReplacement.buildReplacementPrompt(plan);
    // Six sections in the official order.
    const order = ['subject_definitions:', 'summary:', 'retention_analysis:', 'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:'];
    let lastIndex = -1;
    order.forEach((header) => {
        const idx = prompt.indexOf(header);
        assert.ok(idx > lastIndex, header + ' present and ordered');
        lastIndex = idx;
    });
    // Reference-label contract.
    assert.match(prompt, /<Video 1>/);
    assert.match(prompt, /<Picture 1>/);
    assert.match(prompt, /<Picture 2>/);
    assert.match(prompt, /<Audio 1>/);
    // Retention markers: the target identity is transferred, video is preserved.
    assert.match(prompt, /attribute_transfer/);
    assert.match(prompt, /fully_preserved/);
    assert.match(prompt, /partially_copy/);
    // Task-type prefix and editing summary.
    assert.match(prompt, /^\[video editing \+ audio reuse\]|^\[video editing/m);
    assert.match(prompt, /edited version of <Video 1>/);
    // Single continuous shot with no invented timestamp.
    assert.match(prompt, /\[Shot 1\]/);
    assert.doesNotMatch(prompt, /At \d\d:\d\d/);
    // Outfit transfer requested → clothing is moved, not silently kept.
    assert.match(prompt, /clothing/i);
});

test('buildReplacementPrompt: identity-only default preserves source clothing and declares no audio', () => {
    const plan = videoReplacement.buildReplacementPlan({
        message: 'Replace the person on the right with @image1',
        sourceVideo: asset('clip.mp4', 'generated', 'video'),
        replacements: [asset('a.png', 'upload', 'image')],
        hasAudio: false
    }).plan;
    const prompt = videoReplacement.buildReplacementPrompt(plan);
    assert.match(prompt, /identity_only|facial identity and hairstyle/);
    assert.match(prompt, /original clothing of the replaced person in <Video 1>: fully_preserved/);
    assert.match(prompt, /non_diegetic_music:\nN\/A/);
    assert.doesNotMatch(prompt, /<Audio 1>/);
});

// --- Graph construction -------------------------------------------------------

test('buildReplacementGraph: wires the reference node with source video + images', () => {
    const graph = videoReplacement.buildReplacementGraph({
        prompt: 'p', W: 1280, H: 720, frames: 124, seed: 7, settings: {},
        refImageNames: ['ref_a.png', 'ref_b.png'], refVideoName: 'src.mp4', refVideoHasAudio: true
    });
    assert.equal(graph.reference.class_type, 'MiniMaxH3ReferenceToVideo');
    assert.equal(graph.reference.inputs['ref_images.ref_image_0'][0], 'ref_image_0');
    assert.equal(graph.reference.inputs['ref_images.ref_image_1'][0], 'ref_image_1');
    assert.equal(graph.reference.inputs['ref_videos.ref_video_0'][0], 'ref_video');
    assert.equal(graph.reference.inputs['ref_video_audios.ref_video_audio_0'][1], 2);
    assert.equal(graph.ref_video.class_type, 'VHS_LoadVideo');
    assert.equal(graph.ref_video.inputs.force_rate, 24);
    assert.equal(graph.ref_video.inputs.frame_load_cap, 124);
    // Conditioning (out 0) drives the guider; latent (out 1) seeds the sampler.
    assert.equal(graph.guider.inputs.conditioning[0], 'reference');
    assert.equal(graph.guider.inputs.conditioning[1], 0);
    assert.equal(graph.sample.inputs.latent_image[0], 'reference');
    assert.equal(graph.sample.inputs.latent_image[1], 1);
    assert.ok(!graph.first_image);
});

// --- Multi-character gating + background anchoring ----------------------------

test('characterSwapDecision: every single-target swap uses the adapter, multi-target does not', () => {
    const two = { replacements: [asset('a.png', 'upload', 'image'), asset('b.png', 'upload', 'image')], replaceMode: 'identity_and_outfit' };
    const one = { replacements: [asset('a.png', 'upload', 'image')], replaceMode: 'identity_and_outfit' };
    const oneIdentity = { replacements: [asset('a.png', 'upload', 'image')], replaceMode: 'identity_only' };
    assert.equal(videoReplacement.characterSwapDecision(two, {}).use, false);
    assert.equal(videoReplacement.characterSwapDecision(two, {}).reason, 'multi-target');
    assert.equal(videoReplacement.characterSwapDecision(one, {}).use, true);
    assert.equal(videoReplacement.characterSwapDecision(oneIdentity, {}).use, true);
    assert.equal(videoReplacement.characterSwapDecision(oneIdentity, {}).reason, 'single-target');
    assert.equal(videoReplacement.characterSwapDecision(one, { h3CharSwapEnabled: false }).use, false);
});

test('buildReplacementGraph: multi-target request does NOT apply the single-identity adapter', () => {
    const graph = videoReplacement.buildReplacementGraph({
        prompt: 'p', settings: {}, useCharacterSwap: false,
        refImageNames: ['a.png', 'b.png'], refVideoName: 'src.mp4'
    });
    assert.equal(graph.h3_char_swap_lora, undefined);
    assert.equal(graph.reference.inputs['ref_images.ref_image_0'][0], 'ref_image_0');
    assert.equal(graph.reference.inputs['ref_images.ref_image_1'][0], 'ref_image_1');
});

test('refImageSizeForPlan: high fidelity for appearance transfer, match otherwise', () => {
    assert.equal(videoReplacement.refImageSizeForPlan({ replaceMode: 'identity_and_outfit' }, {}), 'max');
    assert.equal(videoReplacement.refImageSizeForPlan({ replaceMode: 'full_appearance' }, {}), 'max');
    assert.equal(videoReplacement.refImageSizeForPlan({ replaceMode: 'identity_only' }, {}), 'match');
    assert.equal(videoReplacement.refImageSizeForPlan({ replaceMode: 'identity_and_outfit' }, { replacementRefImageSize: 'match' }), 'match');
});

test('buildReplacementGraph: samples from the reference latent at full denoise (no face-refine img2img)', () => {
    const graph = videoReplacement.buildReplacementGraph({
        prompt: 'p', settings: {}, W: 1280, H: 720, frames: 124,
        refImageNames: ['a.png'], refVideoName: 'src.mp4', refVideoHasAudio: true, refImageSize: 'max'
    });
    // Full denoise from the reference node's own latent; no source-latent
    // injection (which would return the original clip unchanged).
    assert.deepEqual(graph.sample.inputs.latent_image, ['reference', 1]);
    assert.equal(graph.scheduler.inputs.denoise, 1);
    assert.equal(graph.inject, undefined);
    assert.equal(graph.ref_video.inputs.custom_width, 0);
    assert.equal(graph.reference.inputs.ref_image_size, 'max');
    // Original soundtrack is muxed straight into the output.
    assert.deepEqual(graph.video.inputs.audio, ['ref_video', 2]);
    // No FaceRefine node is pulled into a replacement job.
    const classes = Object.values(graph).map((n) => n.class_type);
    assert.ok(!classes.some((c) => /FaceRefine|FaceTrack|FaceStitch|InjectVideoLatent|PerFrameDenoise/.test(c)));
});

// --- Opt-in SAM3 subject mask + composite -------------------------------------

test('replacementMaskPlan: off by default, derives prompt and object indices', () => {
    const off = videoReplacement.replacementMaskPlan({ replacements: [{}], targets: [] }, {});
    assert.equal(off.enabled, false);
    const one = videoReplacement.replacementMaskPlan(
        { replacements: [{}], targets: [{ gender: 'man' }] },
        { replacementMaskToSubject: true }
    );
    assert.equal(one.enabled, true);
    assert.equal(one.prompt, 'man');
    assert.equal(one.objectIndices, '0');
    const many = videoReplacement.replacementMaskPlan(
        { replacements: [{}, {}], targets: [{}, {}] },
        { replacementMaskToSubject: true, replacementMaskPrompt: 'person' }
    );
    assert.equal(many.objectIndices, '');
});

test('buildReplacementGraph: mask mode adds the SAM3 chain and composites onto the source', () => {
    const graph = videoReplacement.buildReplacementGraph({
        prompt: 'p', W: 1344, H: 768, frames: 124, settings: {},
        refImageNames: ['a.png'], refVideoName: 'src.mp4', refVideoHasAudio: true,
        mask: { enabled: true, prompt: 'woman', model: 'sam3.1_multiplex_fp16.safetensors', grow: 64, objectIndices: '0' }
    });
    assert.equal(graph.mask_detect.class_type, 'SAM3_Detect');
    assert.equal(graph.mask_track.class_type, 'SAM3_VideoTrack');
    assert.equal(graph.mask_tomask.class_type, 'SAM3_TrackToMask');
    assert.deepEqual(graph.mask_track.inputs.initial_mask, ['mask_detect', 0]);
    assert.equal(graph.mask_tomask.inputs.object_indices, '0');
    assert.equal(graph.mask_grow.class_type, 'GrowMask');
    assert.equal(graph.mask_grow.inputs.expand, 64);
    assert.equal(graph.composite.class_type, 'ImageCompositeMasked');
    // Generated subject inside the mask, original source pixels everywhere else.
    assert.deepEqual(graph.composite.inputs.destination, ['mask_source', 0]);
    assert.deepEqual(graph.composite.inputs.source, ['decode', 0]);
    assert.deepEqual(graph.composite.inputs.mask, ['mask_grow', 0]);
    assert.deepEqual(graph.video.inputs.images, ['composite', 0]);
    assert.deepEqual(graph.video.inputs.audio, ['ref_video', 2]);
});

test('buildReplacementGraph: no mask -> unchanged direct reference path', () => {
    const graph = videoReplacement.buildReplacementGraph({
        prompt: 'p', settings: {}, refImageNames: ['a.png'], refVideoName: 'src.mp4',
        mask: { enabled: false }
    });
    assert.equal(graph.composite, undefined);
    assert.equal(graph.mask_detect, undefined);
    assert.deepEqual(graph.video.inputs.images, ['decode', 0]);
});

test('assertReplacementMaskReady: reports a missing SAM3 checkpoint', () => {
    const info = {};
    for (const node of videoReplacement.MASK_NODES) info[node] = {};
    info.CheckpointLoaderSimple = { input: { required: { ckpt_name: [['sd_xl_base.safetensors']] } } };
    assert.throws(
        () => videoReplacement.assertReplacementMaskReady(info, { enabled: true, model: 'sam3.1_multiplex_fp16.safetensors' }),
        (err) => err.code === 'replacement_mask_model_missing'
    );
});

test('assertReplacementMaskReady: reports missing mask nodes', () => {
    assert.throws(
        () => videoReplacement.assertReplacementMaskReady({ CheckpointLoaderSimple: {} }, { enabled: true, model: 'x' }),
        (err) => err.code === 'replacement_mask_node_missing'
    );
});

test('buildReplacementPlan: rejects more references than the workflow accepts', () => {
    const imgs = Array.from({ length: 10 }, (_, i) => asset('r' + i + '.png', 'upload', 'image'));
    const result = videoReplacement.buildReplacementPlan({
        message: 'replace everyone with @image1 @image2 @image3 @image4 @image5 @image6 @image7 @image8 @image9 @image10',
        sourceVideo: asset('clip.mp4', 'generated', 'video'),
        replacements: imgs, assumeOrder: true
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'replacement_reference_limit');
});

test('buildReplacementGraph: omits source audio when the clip has none', () => {
    const graph = videoReplacement.buildReplacementGraph({
        prompt: 'p', settings: {}, refImageNames: ['ref_a.png'], refVideoName: 'src.mp4', refVideoHasAudio: false
    });
    assert.equal(graph.reference.inputs['ref_video_audios.ref_video_audio_0'], undefined);
});

test('buildReplacementGraph: no Turbo nodes are inserted for the reference path', () => {
    const graph = videoReplacement.buildReplacementGraph({ prompt: 'p', settings: { h3TurboEnabled: true }, refImageNames: ['a.png'], refVideoName: 's.mp4' });
    const classes = Object.values(graph).map((n) => n.class_type);
    assert.ok(!classes.includes('MiniMaxH3TurboLoRA'));
    assert.ok(!classes.includes('MiniMaxH3TurboSampler'));
});

test('buildReplacementGraph: applies the character-swap LoRA by default', () => {
    const graph = videoReplacement.buildReplacementGraph({
        prompt: 'p', settings: {}, refImageNames: ['a.png'], refVideoName: 's.mp4'
    });
    assert.equal(graph.h3_char_swap_lora.class_type, 'LoraLoaderModelOnly');
    assert.equal(graph.h3_char_swap_lora.inputs.lora_name, 'h3_character_swap_v1.5.safetensors');
    assert.equal(graph.h3_char_swap_lora.inputs.strength_model, 1);
    // The adapter reads straight from the diffusion-model loader.
    assert.deepEqual(graph.h3_char_swap_lora.inputs.model, ['model', 0]);
});

test('buildReplacementGraph: honors a custom character-swap filename + strength', () => {
    const graph = videoReplacement.buildReplacementGraph({
        prompt: 'p',
        settings: { h3CharSwapLora: 'custom/swap.safetensors', h3CharSwapStrength: 0.8 },
        refImageNames: ['a.png'], refVideoName: 's.mp4'
    });
    assert.equal(graph.h3_char_swap_lora.inputs.lora_name, 'custom/swap.safetensors');
    assert.equal(graph.h3_char_swap_lora.inputs.strength_model, 0.8);
});

test('buildReplacementGraph: omits the character-swap LoRA when disabled', () => {
    const graph = videoReplacement.buildReplacementGraph({
        prompt: 'p', settings: { h3CharSwapEnabled: false }, refImageNames: ['a.png'], refVideoName: 's.mp4'
    });
    assert.equal(graph.h3_char_swap_lora, undefined);
});

test('validateReplacementGraph: accepts a complete node set', async () => {
    const info = {
        MiniMaxH3ReferenceToVideo: {}, VHS_LoadVideo: {}, UNETLoader: {}, CLIPLoader: {}, VAELoader: {},
        RandomNoise: {}, KSamplerSelect: {}, BasicScheduler: {}, BasicGuider: {}, SamplerCustomAdvanced: {},
        VAEDecode: {}, VAEDecodeAudio: {}, CreateVideo: {}, SaveVideo: {}, LoadImage: {},
        LoraLoaderModelOnly: {}
    };
    const graph = videoReplacement.buildReplacementGraph({ prompt: 'p', settings: {}, refImageNames: ['a.png'], refVideoName: 's.mp4' });
    await assert.doesNotReject(videoReplacement.validateReplacementGraph(info, graph));
});

test('validateReplacementGraph: rejects a ComfyUI without the reference node', async () => {
    const graph = videoReplacement.buildReplacementGraph({ prompt: 'p', settings: {}, refImageNames: ['a.png'], refVideoName: 's.mp4' });
    await assert.rejects(
        videoReplacement.validateReplacementGraph({ UNETLoader: {} }, graph),
        /MiniMaxH3ReferenceToVideo/
    );
});

// --- Reference model + probes -------------------------------------------------

test('resolveRefUnet: finds the installed Ref2VA model, override wins', () => {
    const info = { UNETLoader: { input: { required: { unet_name: [['minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'minimax_h3_ref2va_pruned_int8_convrot.safetensors']] } } } };
    assert.equal(videoReplacement.resolveRefUnet(info, {}), 'minimax_h3_ref2va_pruned_int8_convrot.safetensors');
    assert.equal(videoReplacement.resolveRefUnet(info, { h3RefUnet: 'custom_ref2va.safetensors' }), 'custom_ref2va.safetensors');
});

test('resolveH3CharacterSwapAvailability: ready when the adapter is installed', () => {
    const videoGenerator = require('../services/video-generator');
    const info = { LoraLoaderModelOnly: { input: { required: { lora_name: [['h3_character_swap_v1.5.safetensors']] } } } };
    const state = videoGenerator.resolveH3CharacterSwapAvailability(info, {});
    assert.equal(state.enabled, true);
    assert.equal(state.ready, true);
    assert.equal(state.loraMissing, false);
});

test('resolveH3CharacterSwapAvailability: reports a missing adapter', () => {
    const videoGenerator = require('../services/video-generator');
    const info = { LoraLoaderModelOnly: { input: { required: { lora_name: [['some_other.safetensors']] } } } };
    const state = videoGenerator.resolveH3CharacterSwapAvailability(info, {});
    assert.equal(state.ready, false);
    assert.equal(state.loraMissing, true);
    assert.throws(
        () => videoGenerator.assertH3CharacterSwapReady(info, {}),
        (err) => err.code === 'h3_char_swap_lora_missing'
    );
});

test('resolveH3CharacterSwapAvailability: disabled is always ready', () => {
    const videoGenerator = require('../services/video-generator');
    const info = { LoraLoaderModelOnly: { input: { required: { lora_name: [['some_other.safetensors']] } } } };
    const state = videoGenerator.resolveH3CharacterSwapAvailability(info, { h3CharSwapEnabled: false });
    assert.equal(state.enabled, false);
    assert.equal(state.ready, true);
});

test('probeDurationBuffer: reads an MP4 mvhd duration', () => {
    const buf = Buffer.alloc(48);
    buf.write('mvhd', 16, 'ascii');
    buf.writeUInt32BE(1000, 16 + 16);
    buf.writeUInt32BE(5000, 16 + 20);
    assert.equal(videoReplacement.probeDurationBuffer(buf, '.mp4'), 5);
});

test('hasLikelyAudioTrack: detects common audio sample entries', () => {
    assert.equal(videoReplacement.hasLikelyAudioTrack(Buffer.from('....mp4a....')), true);
    assert.equal(videoReplacement.hasLikelyAudioTrack(Buffer.from('A_OPUS')), true);
    assert.equal(videoReplacement.hasLikelyAudioTrack(Buffer.from('no-media-here')), false);
});

// --- Conversation asset registry ---------------------------------------------

test('conversation-assets: indexes uploaded + generated media with type/origin', () => {
    writeMedia(process.env.IMAGES_DIR, 'up1.png');
    writeMedia(process.env.GENERATED_DIR, 'gen1.png');
    writeMedia(process.env.GENERATED_DIR, 'clip1.mp4');

    conversationService.getMessages = (id) => (id === 'c1' ? [
        { id: 'm1', content: '![upload](/images/up1.png)' },
        { id: 'm2', content: '![x](/generated/gen1.png)' },
        { id: 'm3', content: '<video class="md-video" preload="metadata" playsinline src="/generated/clip1.mp4"></video>' }
    ] : []);
    generatedHistory.list = () => ([
        { rawFilename: 'gen1.png', conversationId: 'c1', width: 1024, height: 1024, prompt: 'a cat', hidden: false },
        { rawFilename: 'clip1.mp4', conversationId: 'c1', video: { duration: 5 }, hidden: false }
    ]);

    const assets = conversationAssets.listConversationAssets('c1');
    assert.equal(assets.length, 3);
    assert.equal(assets[0].origin, 'upload');
    assert.equal(assets[0].type, 'image');
    assert.equal(assets[1].type, 'image');
    assert.equal(assets[2].type, 'video');
    assert.equal(assets[2].id, 'video:clip1.mp4');
});

test('conversation-assets: resolves by filename, enforces type + conversation scope', () => {
    const resolved = conversationAssets.resolveConversationAsset('c1', 'gen1.png', { type: 'image' });
    assert.ok(resolved && resolved.absPath && resolved.origin === 'generated');
    assert.equal(conversationAssets.resolveConversationAsset('c1', 'up1.png', { type: 'video' }), null);
    assert.equal(conversationAssets.resolveConversationAsset('other', 'gen1.png'), null);
    assert.equal(conversationAssets.resolveConversationAsset('c1', 'missing.png'), null);
});

test('conversation-assets: hidden generated media is excluded', () => {
    generatedHistory.list = () => ([
        { rawFilename: 'hidden1.png', conversationId: 'c2', hidden: true }
    ]);
    conversationService.getMessages = (id) => (id === 'c2' ? [
        { id: 'm1', content: '![x](/generated/hidden1.png)' }
    ] : []);
    writeMedia(process.env.GENERATED_DIR, 'hidden1.png');
    assert.equal(conversationAssets.listConversationAssets('c2').length, 0);
    assert.equal(conversationAssets.listConversationAssets('c2', { includeHidden: true }).length, 1);
});
