/* ============================================
   JARVIS — Intent classifier unit tests
   Pure, deterministic classifiers only (no
   LLM calls). Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const imageGenerator = require('../services/image-generator');
const videoGenerator = require('../services/video-generator');

// --- imageRequestStrength ----------------------------------------------------

test('imageRequestStrength: explicit image frames are definite', () => {
    assert.equal(imageGenerator.imageRequestStrength('generate an image of a forest'), 'definite');
    assert.equal(imageGenerator.imageRequestStrength('image of a cat'), 'definite');
    assert.equal(imageGenerator.imageRequestStrength('make a picture'), 'definite');
    assert.equal(imageGenerator.imageRequestStrength('generate an iamge'), 'definite');
});

test('imageRequestStrength: bare generation verb is only likely', () => {
    assert.equal(imageGenerator.imageRequestStrength('generate something'), 'likely');
});

test('imageRequestStrength: display requests are not generation', () => {
    assert.equal(imageGenerator.imageRequestStrength('show me the image'), null);
});

test('imageRequestStrength: concept questions and plain descriptions are null', () => {
    assert.equal(imageGenerator.imageRequestStrength('what is image generation?'), null);
    assert.equal(imageGenerator.imageRequestStrength('how do I generate images?'), null);
    assert.equal(imageGenerator.imageRequestStrength('a serene landscape'), null);
});

// --- isExplicitNewImageRequest ----------------------------------------------

test('isExplicitNewImageRequest: generation verb + subject image noun', () => {
    assert.equal(imageGenerator.isExplicitNewImageRequest('generate an image of a forest'), true);
    assert.equal(imageGenerator.isExplicitNewImageRequest('create a picture of a dog'), true);
    assert.equal(imageGenerator.isExplicitNewImageRequest('generate a dreamy image'), true);
    assert.equal(imageGenerator.isExplicitNewImageRequest('generate a scene'), true);
});

test('isExplicitNewImageRequest: attribute tweaks and display requests are not new', () => {
    assert.equal(imageGenerator.isExplicitNewImageRequest('make the image brighter'), false);
    assert.equal(imageGenerator.isExplicitNewImageRequest('change the image to sunset'), false);
    assert.equal(imageGenerator.isExplicitNewImageRequest('show me the image'), false);
});

test('isExplicitNewImageRequest: concept questions are not new requests', () => {
    assert.equal(imageGenerator.isExplicitNewImageRequest('what is image generation?'), false);
});

// --- detectEditIntent --------------------------------------------------------

test('detectEditIntent: explicit edit phrasing works without image context', () => {
    assert.deepEqual(imageGenerator.detectEditIntent('edit this image', false), { intent: 'image_edit' });
    assert.deepEqual(imageGenerator.detectEditIntent('retouch it', false), { intent: 'image_edit' });
});

test('detectEditIntent: content-targeted phrasing requires an image context', () => {
    assert.equal(imageGenerator.detectEditIntent('replace the frog with a princess', false), null);
    assert.deepEqual(imageGenerator.detectEditIntent('replace the frog with a princess', true), { intent: 'image_edit' });
    assert.deepEqual(imageGenerator.detectEditIntent('remove the frog', true), { intent: 'image_edit' });
    assert.deepEqual(imageGenerator.detectEditIntent('change the frog into a prince', true), { intent: 'image_edit' });
});

test('detectEditIntent: context-free phrases never hijack plain chat', () => {
    assert.equal(imageGenerator.detectEditIntent('remove the background noise', false), null);
    assert.equal(imageGenerator.detectEditIntent('delete the old messages', false), null);
    assert.equal(imageGenerator.detectEditIntent('replace the value with X', false), null);
});

test('detectEditIntent: prompt meta-talk, video nouns and new images are excluded', () => {
    assert.equal(imageGenerator.detectEditIntent('replace the prompt with a castle', true), null);
    assert.equal(imageGenerator.detectEditIntent('turn this into a video', true), null);
    assert.equal(imageGenerator.detectEditIntent('generate an image of me replacing my car', true), null);
    assert.equal(imageGenerator.detectEditIntent('what is upscaling?', true), null);
});

// --- detectImageModifyIntent -------------------------------------------------

test('detectImageModifyIntent: vague attribute tweaks modify', () => {
    assert.deepEqual(imageGenerator.detectImageModifyIntent('change her dress to red', true), { intent: 'image_generation', action: 'modify' });
    assert.deepEqual(imageGenerator.detectImageModifyIntent('make her wear a red dress', true), { intent: 'image_generation', action: 'modify' });
});

test('detectImageModifyIntent: questions and narrow intents are excluded', () => {
    assert.equal(imageGenerator.detectImageModifyIntent('what jeans is she wearing?', true), null);
    assert.equal(imageGenerator.detectImageModifyIntent('edit this image', true), null);
    assert.equal(imageGenerator.detectImageModifyIntent('upscale this image', true), null);
    assert.equal(imageGenerator.detectImageModifyIntent('generate an image of a cat', true), null);
    assert.equal(imageGenerator.detectImageModifyIntent('change her dress to red', false), null);
});

// --- detectUpscaleIntent -----------------------------------------------------

test('detectUpscaleIntent: explicit and typo upscale phrases fire', () => {
    assert.deepEqual(imageGenerator.detectUpscaleIntent('upscale this image'), { intent: 'image_upscale' });
    assert.deepEqual(imageGenerator.detectUpscaleIntent('make it bigger'), { intent: 'image_upscale' });
    assert.deepEqual(imageGenerator.detectUpscaleIntent('uspcale this image'), { intent: 'image_upscale' });
});

test('detectUpscaleIntent: concept questions and passing mentions do not fire', () => {
    assert.equal(imageGenerator.detectUpscaleIntent('what is upscaling?'), null);
    assert.equal(imageGenerator.detectUpscaleIntent('upscaling is slow'), null);
});

// --- videoRequestStrength ----------------------------------------------------

test('videoRequestStrength: explicit video requests are definite', () => {
    assert.equal(videoGenerator.videoRequestStrength('generate a video of a dog'), 'definite');
    assert.equal(videoGenerator.videoRequestStrength('make a video'), 'definite');
    assert.equal(videoGenerator.videoRequestStrength('animate this'), 'definite');
    assert.equal(videoGenerator.videoRequestStrength('turn this into a video'), 'definite');
});

test('videoRequestStrength: still-image clothing tweaks are never video', () => {
    assert.equal(videoGenerator.videoRequestStrength('make her wear a red dress'), null);
});

test('videoRequestStrength: concept questions are null', () => {
    assert.equal(videoGenerator.videoRequestStrength('what is a video?'), null);
});

// --- detectVideoUpscaleIntent ------------------------------------------------

test('detectVideoUpscaleIntent: requires an explicit video noun', () => {
    assert.deepEqual(videoGenerator.detectVideoUpscaleIntent('upscale this video'), { intent: 'video_upscale' });
    assert.deepEqual(videoGenerator.detectVideoUpscaleIntent('uspcale this video'), { intent: 'video_upscale' });
    assert.equal(videoGenerator.detectVideoUpscaleIntent('upscale this image'), null);
});

test('detectVideoUpscaleIntent: concept questions do not fire', () => {
    assert.equal(videoGenerator.detectVideoUpscaleIntent('what is video upscaling?'), null);
});
