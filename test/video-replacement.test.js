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

// --- Prompt construction ------------------------------------------------------

test('buildReplacementPrompt: uses the reference token contract and preserves motion', () => {
    const plan = {
        sourceVideo: asset('clip.mp4', 'generated', 'video'),
        replacements: [asset('a.png', 'upload', 'image'), asset('b.png', 'upload', 'image')],
        preserve: { motion: true, background: true, camera: true, timing: true, clothing: true },
        additionalInstructions: 'the woman becomes image one'
    };
    const prompt = videoReplacement.buildReplacementPrompt(plan);
    assert.match(prompt, /^\[Shot 1\]/);
    assert.match(prompt, /<Video 1>/);
    assert.match(prompt, /<Picture 1>/);
    assert.match(prompt, /<Picture 2>/);
    assert.match(prompt, /camera motion/i);
    assert.match(prompt, /additional instruction/i);
    assert.doesNotMatch(prompt, /At \d\d:\d\d/);
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

test('validateReplacementGraph: accepts a complete node set', async () => {
    const info = {
        MiniMaxH3ReferenceToVideo: {}, VHS_LoadVideo: {}, UNETLoader: {}, CLIPLoader: {}, VAELoader: {},
        RandomNoise: {}, KSamplerSelect: {}, BasicScheduler: {}, BasicGuider: {}, SamplerCustomAdvanced: {},
        VAEDecode: {}, VAEDecodeAudio: {}, CreateVideo: {}, SaveVideo: {}, LoadImage: {}
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
