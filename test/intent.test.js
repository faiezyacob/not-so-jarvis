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

// --- stripVideoRequestMeta / isRawRequestEcho --------------------------------

test('stripVideoRequestMeta: removes video scaffolding and meta filler', () => {
    assert.equal(videoGenerator.stripVideoRequestMeta('animate this image. make it mindblowing.'), '');
    assert.equal(videoGenerator.stripVideoRequestMeta('generate a video of a dog running'), 'a dog running');
    assert.equal(videoGenerator.stripVideoRequestMeta('make a cinematic video of a city at night'), 'a city at night');
    assert.equal(videoGenerator.stripVideoRequestMeta('bring this image to life'), '');
});

test('stripVideoRequestMeta: preserves concrete concepts', () => {
    assert.equal(videoGenerator.stripVideoRequestMeta('a cat on a sunny beach'), 'a cat on a sunny beach');
    assert.equal(videoGenerator.stripVideoRequestMeta('wild horses running through a river'), 'wild horses running through a river');
});

test('isRawRequestEcho: flags an echoed instruction, allows a rewritten prompt', () => {
    assert.equal(videoGenerator.isRawRequestEcho('[Shot 1] animate this image. make it mindblowing.', 'animate this image. make it mindblowing.'), true);
    assert.equal(videoGenerator.isRawRequestEcho('[Shot 1] the subject turns to face the camera as light sweeps across the scene', 'animate this image. make it mindblowing.'), false);
    assert.equal(videoGenerator.isRawRequestEcho('[Shot 1] a dog running on a beach', 'a dog running on a beach'), false);
});

// --- parseDirectorJson (lenient H3 director response reader) ------------------

test('parseDirectorJson: reads a normal JSON envelope', () => {
    const parsed = videoGenerator.parseDirectorJson('{"mode":"i2va","prompt":"[Shot 1] a scene"}');
    assert.equal(parsed.mode, 'i2va');
    assert.equal(parsed.prompt, '[Shot 1] a scene');
});

test('parseDirectorJson: salvages a prompt with raw newlines in the JSON string', () => {
    const raw = '{"mode":"i2va","prompt":"integrated_multimodal_description:\n[Shot 1] A dog runs across sand.\n\noverall_soundscape:\nWaves."}';
    const parsed = videoGenerator.parseDirectorJson(raw);
    assert.ok(parsed);
    assert.equal(parsed.mode, 'i2va');
    assert.match(parsed.prompt, /A dog runs across sand\./);
    assert.match(parsed.prompt, /overall_soundscape:/);
});

test('parseDirectorJson: returns null for a non-JSON reply', () => {
    assert.equal(videoGenerator.parseDirectorJson('not json at all'), null);
});

// --- H3 multi-shot direction (Director mode) ---------------------------------

test('resolveShotPlan: reads the shot plan array, ignores the single-shot pipeline', () => {
    assert.deepEqual(
        videoGenerator.resolveShotPlan({ shot_plan: ['Wide shot', 'Close-up'] }),
        ['Wide shot', 'Close-up']
    );
    assert.deepEqual(videoGenerator.resolveShotPlan({ shot_plan: [] }), []);
    assert.deepEqual(videoGenerator.resolveShotPlan({}), []);
    assert.deepEqual(videoGenerator.resolveShotPlan(null), []);
});

test('formatCutTime: renders MM:SS.mmm cut times', () => {
    assert.equal(videoGenerator.formatCutTime(0), '00:00.000');
    assert.equal(videoGenerator.formatCutTime(3.5), '00:03.500');
    assert.equal(videoGenerator.formatCutTime(65.25), '01:05.250');
});

test('buildMultiShotFallbackPrompt: cuts every shot inside the duration, no timestamp on Shot 1', () => {
    const prompt = videoGenerator.buildMultiShotFallbackPrompt({
        shotPlan: ['Wide establishing shot', 'Medium shot', 'Close-up'],
        hasReferenceImage: true,
        durationSeconds: 10
    });
    assert.match(prompt, /<Picture 1> \(from \[Shot 1\]\) is fully referenced/);
    assert.match(prompt, /\[Shot 1\] Wide establishing shot/);
    assert.match(prompt, /\[Shot 2\] At 00:03\.333, the camera cuts to Medium shot/);
    assert.match(prompt, /\[Shot 3\] At 00:06\.667, the camera cuts to Close-up/);
    assert.doesNotMatch(prompt, /\[Shot 1\] At /);
    // The override addendum carries the guide's cut syntax.
    assert.match(videoGenerator.H3_MULTISHOT_ADDENDUM, /STRICTLY INCREASING|strictly increasing/);
    assert.match(videoGenerator.H3_MULTISHOT_ADDENDUM, /\[Shot 2\] At 00:03\.500/);
});

test('buildH3VideoPrompt: a shot plan switches to the multi-shot addendum and emits every shot', async () => {
    const providers = require('../server/providers');
    const originalChat = providers.chat;
    let seenSystem = '';
    providers.chat = async (provider, messages) => {
        seenSystem = String((messages[0] && messages[0].content) || '');
        return JSON.stringify({
            mode: 'i2va',
            prompt: 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n' +
                '[Shot 1] The woman steps forward. [Shot 2] At 00:04.000, the camera cuts to a close-up of her face.'
        });
    };
    try {
        const result = await videoGenerator.buildH3VideoPrompt({
            intent: 'video_generation',
            action: 'generate',
            user_prompt: 'Direct this as a cut sequence of 2 shots.',
            previous_prompt: '',
            creative_mode: 'none',
            has_reference_image: true,
            requested_duration: 8,
            explicit_constraints: [],
            shot_plan: ['The woman steps forward', 'Close-up of her face']
        }, providers, 'ollama', 'test-model', null, null, false);
        assert.match(seenSystem, /MULTI-SHOT DIRECTION/);
        assert.match(result.prompt, /\[Shot 2\]/);
    } finally {
        providers.chat = originalChat;
    }
});

// --- parseEnhancerJson / isImagePromptEcho -----------------------------------

test('parseEnhancerJson: reads a normal JSON envelope with attributes', () => {
    const parsed = imageGenerator.parseEnhancerJson('{"prompt":"A cat on a wall","attributes":{"subject":"a cat"}}');
    assert.equal(parsed.prompt, 'A cat on a wall');
    assert.equal(parsed.attributes.subject, 'a cat');
});

test('parseEnhancerJson: repairs raw newlines inside the JSON string', () => {
    const raw = '{"prompt":"A cat on a wall.\nWarm light.","attributes":{"subject":"a cat"}}';
    const parsed = imageGenerator.parseEnhancerJson(raw);
    assert.ok(parsed);
    assert.match(parsed.prompt, /A cat on a wall\./);
    assert.match(parsed.prompt, /Warm light\./);
    assert.equal(parsed.attributes.subject, 'a cat');
});

test('parseEnhancerJson: extracts the prompt from a badly malformed reply', () => {
    const parsed = imageGenerator.parseEnhancerJson('here: {"prompt": "A fox in a meadow", }');
    assert.ok(parsed);
    assert.equal(parsed.prompt, 'A fox in a meadow');
});

test('isImagePromptEcho: flags verbatim echoes, allows expansions', () => {
    assert.equal(imageGenerator.isImagePromptEcho('a cat', 'a cat'), true);
    assert.equal(imageGenerator.isImagePromptEcho('A cat sitting on a brick wall at dusk', 'a cat'), false);
    assert.equal(imageGenerator.isImagePromptEcho('generate an image of a cat', 'generate an image of a cat'), true);
});

