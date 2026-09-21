/* ============================================
   JARVIS — Director tests
   Covers production detection, brief handling,
   the production-plan lifecycle, approval
   classification/validation, and marker
   rendering. The LLM seam is stubbed so these
   run offline and fast. Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const providers = require('../server/providers');
const imageGenerator = require('../services/image-generator');
const videoGenerator = require('../services/video-generator');
const productionPlan = require('../services/director/production-plan');
const prompts = require('../services/director/director-prompts');
const approval = require('../services/director/approval-manager');
const director = require('../services/director/director');

const originals = {
    chat: providers.chat,
    buildImagePrompt: imageGenerator.buildImagePrompt,
    resolveVideoSourceImage: videoGenerator.resolveVideoSourceImage
};

test.afterEach(() => {
    providers.chat = originals.chat;
    imageGenerator.buildImagePrompt = originals.buildImagePrompt;
    videoGenerator.resolveVideoSourceImage = originals.resolveVideoSourceImage;
});

function conversationId(name) {
    return 'director-test-' + name + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
}

// --- Detection ---------------------------------------------------------------

test('detectProductionRequest: a cinematic movie with duration is a production', () => {
    assert.equal(
        director.detectProductionRequest(
            'Please generate a 10-second cinematic movie of a young Asian woman walking through Tokyo at night.'
        ),
        true
    );
});

test('detectProductionRequest: "make a cinematic video" is a production', () => {
    assert.equal(director.detectProductionRequest('Make a cinematic video of a lighthouse at dawn'), true);
});

test('detectProductionRequest: "create a commercial" is a production', () => {
    assert.equal(director.detectProductionRequest('Create a commercial for a coffee brand'), true);
});

test('detectProductionRequest: turning an image into a movie is a production', () => {
    assert.equal(director.detectProductionRequest('Turn this image into a movie.'), true);
});

test('detectProductionRequest: a simple image request is not a production', () => {
    assert.equal(director.detectProductionRequest('Generate a portrait of a woman.'), false);
});

test('detectProductionRequest: a plain video request is not a production', () => {
    assert.equal(director.detectProductionRequest('generate a video of a dog running on a beach'), false);
});

test('detectProductionRequest: a plain video with a duration is not a production', () => {
    assert.equal(director.detectProductionRequest('generate a 5 second video of a cat'), false);
});

test('detectProductionRequest: turning an existing frame into a timed video is a production', () => {
    assert.equal(director.detectProductionRequest('Turn this into a 10-second video.'), true);
});

test('detectProductionRequest: a concept question is not a production', () => {
    assert.equal(director.detectProductionRequest('What is a movie?'), false);
});

// --- Source image resolution (from-scratch vs existing image) -----------------

test('resolveExistingSource: a possessive pronoun in a from-scratch brief is not an image reference', () => {
    videoGenerator.resolveVideoSourceImage = () => ({ rawFilename: 'previous.png' });
    const source = director.resolveExistingSource(
        'director-test-pronoun',
        'generate 10 seconds video of a young korean woman lying on bed wearing a beige bra ' +
        'and black shorts, she is removing her bra and then rubbing it in front of the camera. ' +
        'she looks seductive. continuous single shot.'
    );
    assert.equal(source, null);
});

test('resolveExistingSource: an explicit image reference reuses the last generated image', () => {
    videoGenerator.resolveVideoSourceImage = () => ({ rawFilename: 'previous.png' });
    assert.equal(
        director.resolveExistingSource('director-test-ref', 'turn this image into a 10-second video'),
        'previous.png'
    );
    assert.equal(
        director.resolveExistingSource('director-test-ref', 'animate this image'),
        'previous.png'
    );
    assert.equal(
        director.resolveExistingSource('director-test-ref', 'make her walk toward the camera'),
        'previous.png'
    );
});

test('resolveExistingSource: no reference wording means no source, even when an image exists', () => {
    videoGenerator.resolveVideoSourceImage = () => ({ rawFilename: 'previous.png' });
    assert.equal(
        director.resolveExistingSource('director-test-plain', 'make a cinematic movie of a lighthouse at dawn'),
        null
    );
});

test('resolveExistingSource: an attached reference always wins', () => {
    videoGenerator.resolveVideoSourceImage = () => ({ rawFilename: 'previous.png' });
    assert.equal(
        director.resolveExistingSource('director-test-attached', 'make a video about a cat', '/generated/ref_9.png'),
        'ref_9.png'
    );
});

test('createProduction: a described subject with pronouns still generates a fresh opening frame', async () => {
    providers.chat = async () => '{}';
    videoGenerator.resolveVideoSourceImage = () => ({ rawFilename: 'previous.png' });
    const id = conversationId('pronoun-frame');
    const production = await director.createProduction({
        conversationId: id,
        message: 'generate 10 seconds video of a young korean woman lying on bed wearing a beige bra ' +
            'and black shorts, she is removing her bra and then rubbing it in front of the camera. ' +
            'she looks seductive. continuous single shot.',
        provider: 'ollama',
        model: 'test-model',
        think: false
    });
    assert.equal(production.video.duration, 10);
    assert.equal(production.sourceImage, null);
    assert.equal(production.status, productionPlan.STATUS.GENERATING_IMAGE);
    productionPlan.remove(id);
});

// --- Workflow selection (direct by default, Director on request) --------------

test('workflow: a failed production stays open but does not claim a new video request', () => {
    // A restart reconciles a running stage to failed_* (still "open"), so the
    // server relies on classifyMessage returning null to know it must supersede
    // the stale production and start a fresh one.
    const production = { id: 'f1', status: productionPlan.STATUS.FAILED_IMAGE, stages: [] };
    assert.equal(productionPlan.isOpen(production), true);
    assert.equal(approval.classifyMessage('make a video of a cat', production), null);
});

test('workflow: wantsDirectorMode only matches explicit director phrasing', () => {
    assert.equal(director.wantsDirectorMode('director mode'), true);
    assert.equal(director.wantsDirectorMode('as a director, make a film'), true);
    assert.equal(director.wantsDirectorMode('make a cinematic movie'), false);
});

test('workflow: shouldForceDirector routes fresh video turns but not tweaks', () => {
    assert.equal(director.shouldForceDirector('make a movie of a cat',
        { task: 'video_generation', intent: 'new_task' }), true);
    assert.equal(director.shouldForceDirector('animate this image',
        { task: 'video_generation', intent: 'switch_task' }), true);
    // Explicit "just generate the video" wins over the toggle.
    assert.equal(director.shouldForceDirector('just generate the video of a cat',
        { task: 'video_generation', intent: 'new_task' }), false);
    // Tweaks of an active video task keep their direct pipeline.
    assert.equal(director.shouldForceDirector('make her walk faster',
        { task: 'video_generation', intent: 'continue_task' }), false);
    // Non-video turns are untouched.
    assert.equal(director.shouldForceDirector('generate a portrait of a woman',
        { task: 'image_generation', intent: 'new_task' }), false);
    assert.equal(director.shouldForceDirector('hello there', null), false);
});

test('workflow: the Director toggle supersedes the long-video duration router', () => {
    // Toggle on: a >15s request still goes to the Director.
    assert.equal(director.shouldForceDirectorOverLongVideo('generate a 30 second video of a cat',
        { forceDirector: true, longVideoBusy: false }), true);
    // Toggle off: the duration router keeps it.
    assert.equal(director.shouldForceDirectorOverLongVideo('generate a 30 second video of a cat',
        { forceDirector: false, longVideoBusy: false }), false);
    // Explicit "just generate the video" wins over the toggle.
    assert.equal(director.shouldForceDirectorOverLongVideo('just generate the video directly, 30 seconds',
        { forceDirector: true, longVideoBusy: false }), false);
    // An actively rendering long video is never clobbered.
    assert.equal(director.shouldForceDirectorOverLongVideo('generate a 30 second video of a cat',
        { forceDirector: true, longVideoBusy: true }), false);
});

// --- Brief -------------------------------------------------------------------

test('parseBriefJson tolerates markdown fences and commentary', () => {
    const parsed = director.parseBriefJson('Here you go:\n```json\n{"subject":"a cat"}\n```');
    assert.equal(parsed.subject, 'a cat');
});

test('mergeBrief fills blanks from the fallback and keeps explicit values', () => {
    const merged = director.mergeBrief(
        { subject: 'fallback subject', visualStyle: 'cinematic photorealistic' },
        { subject: 'a young woman', mood: 'moody' }
    );
    assert.equal(merged.subject, 'a young woman');
    assert.equal(merged.mood, 'moody');
    assert.equal(merged.visualStyle, 'cinematic photorealistic');
    assert.equal(merged.shots, '1');
});

test('buildBrief falls back to the heuristic when the LLM fails', async () => {
    providers.chat = async () => { throw new Error('no llm'); };
    const brief = await director.buildBrief({
        message: 'Generate a 10 second movie of a woman walking through Tokyo at night.',
        provider: 'ollama',
        model: 'test',
        think: false
    });
    assert.match(brief.originalRequest, /woman walking through Tokyo/i);
    assert.ok(brief.subject.length > 0);
});

test('composeVideoDirection/composeImageConcept carry details and the authoritative wording', () => {
    const brief = productionPlan.normalizeBrief({
        subject: 'a knight',
        action: 'charging forward',
        originalRequest: 'make a cute movie of a knight with a red cape and a golden sword',
        details: 'a red cape, a golden sword'
    });
    const video = prompts.composeVideoDirection(brief, 10, { authoritative: brief.originalRequest });
    assert.match(video, /a red cape, a golden sword/);
    assert.match(video, /golden sword/);
    assert.match(video, /authoritative/i);
    const image = prompts.composeImageConcept(brief, { authoritative: brief.originalRequest });
    assert.match(image, /red cape/);
});

test('mergeBrief preserves the details catch-all across an update', () => {
    const base = productionPlan.normalizeBrief({
        subject: 'a knight',
        details: 'a red cape',
        originalRequest: 'a knight'
    });
    const updated = director.mergeBrief(base, { details: 'a red cape, a silver shield' });
    assert.equal(updated.details, 'a red cape, a silver shield');
});

test('buildVideoStageRequest drops the original wording once the brief is edited', async () => {
    providers.chat = async (provider, messages) => {
        const sys = String((messages[0] && messages[0].content) || '');
        if (/H3 Video Director/i.test(sys)) {
            return JSON.stringify({ mode: 'i2va', prompt: '[Shot 1] The knight charges.' });
        }
        return '{}';
    };
    const id = conversationId('authoritative');
    const production = productionPlan.create({
        conversationId: id,
        brief: { subject: 'a knight', originalRequest: 'the original knight request' },
        video: { duration: 5 },
        originalRequest: 'the original knight request'
    });
    productionPlan.set(id, production);
    director.markImageReady(production, {
        url: '/generated/f.png', rawFilename: 'f.png', prompt: 'F', seed: 1
    });

    const first = await director.buildVideoStageRequest(production, {
        provider: 'ollama', model: 'test-model', think: false
    });
    assert.match(first.structuredRequest.user_prompt, /the original knight request/);

    production.briefModified = true;
    const second = await director.buildVideoStageRequest(production, {
        provider: 'ollama', model: 'test-model', think: false
    });
    assert.doesNotMatch(second.structuredRequest.user_prompt, /the original knight request/);
    productionPlan.remove(id);
});

test('composeImageConcept and composeVideoDirection read from the brief', () => {
    const brief = productionPlan.normalizeBrief({
        subject: 'a young woman',
        setting: 'a Tokyo street',
        action: 'walking toward camera',
        visualStyle: 'photorealistic cinematic',
        camera: 'medium tracking shot'
    });
    assert.match(prompts.composeImageConcept(brief), /young woman/);
    assert.match(prompts.composeImageConcept(brief), /Tokyo street/);
    const video = prompts.composeVideoDirection(brief, 10);
    assert.match(video, /10 seconds/);
    // Director mode cuts a real sequence by default, not one continuous take.
    assert.match(video, /cut sequence of 3 shots/i);
    assert.match(video, /\[Shot 2\]/);
    assert.match(video, /strictly increasing cut time/i);
});

test('composeImageConcept strips video timing and background-change language', () => {
    const request = 'generate 10 seconds video of young pretty korean woman wearing tanktop ' +
        'doing a travel vlog video. the background changes every 2 second to another major big city';
    const brief = productionPlan.normalizeBrief({
        subject: 'young pretty korean woman',
        setting: 'major big cities (changing every 2 seconds)',
        temporal: 'background changes every 2 seconds to a new major big city over 10 seconds',
        details: 'wearing tanktop, travel vlog style',
        explicitConstraints: ['video duration is 10 seconds', 'background changes every 2 seconds'],
        originalRequest: request
    });
    const image = prompts.composeImageConcept(brief, { authoritative: request });
    assert.doesNotMatch(image, /every\s*2/i);
    assert.doesNotMatch(image, /10[- ]?seconds?/i);
    assert.doesNotMatch(image, /changes|transition|duration/i);
    assert.match(image, /korean woman/i);
    assert.match(image, /tanktop/);
    assert.match(image, /single location/i);
    assert.match(image, /not a sequence, montage, storyboard, or collage/i);
});

test('stripTemporalForImage keeps genuine subject, setting and detail text', () => {
    assert.equal(
        prompts.stripTemporalForImage('a rain-soaked Tokyo street at night'),
        'a rain-soaked Tokyo street at night'
    );
    assert.equal(prompts.stripTemporalForImage('a red cape, a golden sword'), 'a red cape, a golden sword');
    assert.equal(prompts.stripTemporalForImage('no text, landscape orientation'), 'no text, landscape orientation');
    // Negatives: the words "sec"/"chang"/"length" must not be matched inside
    // unrelated words, and motion/pose particles at the tail must survive.
    assert.equal(prompts.stripTemporalForImage('(secondary subject) woman'), '(secondary subject) woman');
    assert.equal(prompts.stripTemporalForImage('woman with shoulder-length hair'), 'woman with shoulder-length hair');
    assert.equal(prompts.stripTemporalForImage('50mm focal length'), '50mm focal length');
    assert.equal(prompts.stripTemporalForImage('slow push in'), 'slow push in');
    assert.equal(prompts.stripTemporalForImage('leaning in'), 'leaning in');
    assert.equal(prompts.stripTemporalForImage('walking through the rain'), 'walking through the rain');
    assert.equal(prompts.stripTemporalForImage('standing with arms crossed'), 'standing with arms crossed');
    // Era references must survive the duration matcher.
    assert.equal(prompts.stripTemporalForImage('90s fashion'), '90s fashion');
    assert.equal(prompts.stripTemporalForImage('the 2000s aesthetic'), 'the 2000s aesthetic');
    // A wardrobe change is a real visual, not a scene transition.
    assert.equal(prompts.stripTemporalForImage('she changes into a red dress'), 'she changes into a red dress');
});

test('stripTemporalForImage removes the temporal variants that leak into stills', () => {
    assert.equal(prompts.stripTemporalForImage('major big cities (changing every 2 seconds)'), 'major big cities');
    for (const text of [
        'the background changes every 2 second to another major big city',
        'the background is changing to another city',
        'the background slowly changes to Paris',
        'the scene will shift to Tokyo',
        'the camera cuts to a new city',
        'background transitions through iconic urban landscapes',
        'background changes every 2 seconds to a new city over 10 seconds',
        'video duration is 10 seconds',
        'video length 10 seconds',
        'total runtime is 90 seconds',
        'length of 5 seconds',
        'every 2 seconds',
        'every other second',
        'every couple of seconds',
        'every few seconds',
        'each second',
        'every 2nd second',
        'changes every 2 seconds'
    ]) {
        assert.equal(prompts.stripTemporalForImage(text), '', 'should strip: ' + text);
    }
    assert.equal(prompts.stripTemporalForImage('10-second clip of a woman'), 'clip of a woman');
    assert.equal(prompts.stripTemporalForImage('every 2s'), '');
});

test('composeImageConcept preserves genuine detail while dropping timing', () => {
    const brief = productionPlan.normalizeBrief({
        subject: 'a woman with shoulder-length hair',
        action: 'slowly changing into a red dress',
        setting: 'a Paris cafe',
        cameraMovement: 'slow push in',
        details: '50mm focal length, secondary subject in the window',
        explicitConstraints: ['video duration is 10 seconds', 'no text']
    });
    const image = prompts.composeImageConcept(brief);
    assert.match(image, /shoulder-length hair/);
    assert.match(image, /changing into a red dress/);
    assert.match(image, /Paris cafe/);
    assert.match(image, /slow push in/);
    assert.match(image, /50mm focal length/);
    assert.match(image, /secondary subject/);
    assert.match(image, /no text/);
    assert.doesNotMatch(image, /10 seconds|duration/i);
});

test('planShots honors a single-take request, an explicit count, and a shot list', () => {
    const oneTake = productionPlan.normalizeBrief({
        subject: 'a dancer',
        originalRequest: 'make a movie of a dancer in one continuous shot'
    });
    assert.deepEqual(prompts.planShots(oneTake, 10), []);
    assert.match(prompts.composeVideoDirection(oneTake, 10), /single continuous shot/i);

    const counted = productionPlan.normalizeBrief({ subject: 'a knight', shots: '4' });
    assert.equal(prompts.planShots(counted, 10).length, 4);

    const listed = productionPlan.normalizeBrief({
        subject: 'a knight',
        shotList: ['Wide shot of a knight', 'Close-up of the knight', 'Wide shot of the charge']
    });
    assert.equal(prompts.planShots(listed, 10).length, 3);
    assert.equal(listed.shots, '3');
});

// --- Production plan ---------------------------------------------------------

test('production-plan: a from-scratch production starts generating the frame', () => {
    const id = conversationId('fresh');
    const production = productionPlan.create({
        conversationId: id,
        brief: { subject: 'a woman' },
        video: { duration: 10 },
        originalRequest: 'a movie'
    });
    assert.equal(production.status, productionPlan.STATUS.GENERATING_IMAGE);
    assert.equal(production.video.duration, 10);
    assert.equal(productionPlan.stage(production, 'image').status, 'pending');
    assert.equal(productionPlan.isOpen(production), true);
});

test('production-plan: an existing source image is treated as the approved frame', () => {
    const id = conversationId('source');
    const production = productionPlan.create({
        conversationId: id,
        brief: { subject: 'a woman' },
        video: { duration: 5 },
        sourceImage: 'abc_123.png',
        originalRequest: 'turn this into a video'
    });
    assert.equal(production.status, productionPlan.STATUS.AWAITING_IMAGE_APPROVAL);
    assert.equal(productionPlan.stage(production, 'image').status, 'completed');
    assert.equal(productionPlan.stage(production, 'image_approval').status, 'approved');
});

// --- Approval classification / validation ------------------------------------

test('approval: approve / regenerate / modify / cancel / chat are separated', () => {
    const production = {
        id: 'p1',
        status: productionPlan.STATUS.AWAITING_IMAGE_APPROVAL,
        stages: []
    };
    assert.equal(approval.classifyMessage('Approve', production).action, approval.ACTIONS.APPROVE);
    assert.equal(approval.classifyMessage('looks good, go ahead', production).action, approval.ACTIONS.APPROVE);
    assert.equal(approval.classifyMessage('regenerate the image', production).action, approval.ACTIONS.REGENERATE_IMAGE);
    assert.equal(approval.classifyMessage('cancel the production', production).action, approval.ACTIONS.CANCEL);
    const modify = approval.classifyMessage('make her jacket red', production);
    assert.equal(modify.action, approval.ACTIONS.MODIFY_DIRECTION);
    assert.equal(modify.direction, 'make her jacket red');
    assert.equal(approval.classifyMessage('what do you think of it?', production), null);
});

test('approval: video phrasings approve; still-image tweaks modify', () => {
    const production = { id: 'p1b', status: productionPlan.STATUS.AWAITING_IMAGE_APPROVAL, stages: [] };
    assert.equal(approval.classifyMessage('make the video now', production).action, approval.ACTIONS.APPROVE);
    assert.equal(approval.classifyMessage('turn this into a 10-second video', production).action, approval.ACTIONS.APPROVE);
    assert.equal(approval.classifyMessage('generate a portrait of a woman', production), null);
    const tweak = approval.classifyMessage('make her look more elegant and move the camera further away', production);
    assert.equal(tweak.action, approval.ACTIONS.MODIFY_DIRECTION);
});

test('approval: a completed production accepts no further stage actions', () => {
    const production = { id: 'p2', status: productionPlan.STATUS.COMPLETED, stages: [] };
    assert.equal(approval.validate(production, { type: approval.ACTIONS.APPROVE }).ok, false);
    assert.equal(approval.validate(production, { type: approval.ACTIONS.CANCEL }).ok, true);
});

test('approval: approval is only legal while the frame awaits approval', () => {
    const production = { id: 'p3', status: productionPlan.STATUS.GENERATING_IMAGE, stages: [] };
    assert.equal(approval.validate(production, { type: approval.ACTIONS.APPROVE }).ok, false);
});

test('approval: normalizeAction rejects unknown payloads', () => {
    assert.equal(approval.normalizeAction({ type: 'destroy' }), null);
    assert.equal(approval.normalizeAction('approve').type, 'approve');
    assert.deepEqual(
        approval.normalizeAction({ type: 'modify_direction', productionId: 'p9', direction: 'x' }),
        { type: 'modify_direction', productionId: 'p9', direction: 'x' }
    );
    assert.equal(approval.normalizeAction({ type: 'upscale_image' }).type, 'upscale_image');
});

test('approval: "upscale the frame" is an upscale action, not a modify', () => {
    const production = { id: 'pu', status: productionPlan.STATUS.AWAITING_IMAGE_APPROVAL, stages: [] };
    assert.equal(approval.classifyMessage('upscale this frame', production).action, approval.ACTIONS.UPSCALE_IMAGE);
    assert.equal(approval.classifyMessage('make it higher resolution', production).action, approval.ACTIONS.UPSCALE_IMAGE);
    // A concept question is not an action.
    assert.equal(approval.classifyMessage('what is upscaling?', production), null);
});

test('approval: upscale is only legal while the frame awaits approval', () => {
    const awaiting = {
        id: 'pu2',
        status: productionPlan.STATUS.AWAITING_IMAGE_APPROVAL,
        image: { rawFilename: 'f.png' },
        stages: []
    };
    assert.equal(approval.validate(awaiting, { type: approval.ACTIONS.UPSCALE_IMAGE }).ok, true);
    const generating = {
        id: 'pu3',
        status: productionPlan.STATUS.GENERATING_IMAGE,
        image: { rawFilename: 'f.png' },
        stages: []
    };
    assert.equal(approval.validate(generating, { type: approval.ACTIONS.UPSCALE_IMAGE }).ok, false);
    const completed = { id: 'pu4', status: productionPlan.STATUS.COMPLETED, stages: [] };
    assert.equal(approval.validate(completed, { type: approval.ACTIONS.UPSCALE_IMAGE }).ok, false);
});

test('director: markImageUpscaled points the video stage at the upscaled frame', async () => {
    providers.chat = async (provider, messages) => {
        const sys = String((messages[0] && messages[0].content) || '');
        if (/H3 Video Director/i.test(sys)) {
            return JSON.stringify({
                mode: 'i2va',
                prompt: 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n[Shot 1] The woman walks forward.'
            });
        }
        return '{}';
    };
    const id = conversationId('upscale-frame');
    const production = productionPlan.create({
        conversationId: id,
        brief: { subject: 'a woman' },
        video: { duration: 5 },
        originalRequest: 'make a movie of a woman in one continuous shot'
    });
    productionPlan.set(id, production);
    director.markImageReady(production, { url: '/generated/frame.png', rawFilename: 'frame.png', prompt: 'F', seed: 1 });
    director.markImageUpscaled(production, {
        url: '/generated/frame_up.png',
        rawFilename: 'frame_up.png',
        width: 2048,
        height: 1152,
        source: 'frame.png'
    });
    assert.equal(production.status, productionPlan.STATUS.AWAITING_IMAGE_APPROVAL);
    assert.equal(production.image.rawFilename, 'frame_up.png');
    assert.equal(production.image.upscaled, true);
    assert.equal(production.image.upscaledFrom, 'frame.png');

    const stage = await director.buildVideoStageRequest(production, {
        provider: 'ollama', model: 'test-model', think: false
    });
    assert.equal(stage.sourceImageRawFilename, 'frame_up.png');
    productionPlan.remove(id);
});

test('director: a failed upscale keeps the original frame and stays awaiting approval', () => {
    const id = conversationId('upscale-fail');
    const production = productionPlan.create({
        conversationId: id,
        brief: { subject: 'a woman' },
        video: { duration: 5 },
        originalRequest: 'a movie'
    });
    productionPlan.set(id, production);
    director.markImageReady(production, { url: '/generated/frame.png', rawFilename: 'frame.png', prompt: 'F', seed: 1 });
    director.markUpscaleFailed(production, 'CUDA out of memory');
    assert.equal(production.status, productionPlan.STATUS.AWAITING_IMAGE_APPROVAL);
    assert.equal(production.image.rawFilename, 'frame.png');
    assert.match(production.error, /out of memory/);
    productionPlan.remove(id);
});

test('renderUpscaledContent embeds the approval marker with the upscaled frame', () => {
    const production = {
        id: 'pru',
        status: productionPlan.STATUS.AWAITING_IMAGE_APPROVAL,
        video: { duration: 10 },
        image: { upscaled: true }
    };
    const content = director.renderUpscaledContent(
        production,
        '![opening frame](/generated/x_up.png)',
        'Now 2048\u00d71152.'
    );
    assert.match(director.stripMarkers(content), /upscaled/i);
    assert.doesNotMatch(director.stripMarkers(content), /\[\[director:/);
    const match = content.match(/\[\[director:(\{[^\n]*?\})\]\]/);
    assert.ok(match, 'marker present');
    assert.equal(JSON.parse(match[1]).status, 'awaiting_image_approval');
});

// --- Stage prompt building ---------------------------------------------------

test('buildImageStagePrompt uses the existing image prompt builder', async () => {
    let seen = null;
    imageGenerator.buildImagePrompt = async (structuredRequest) => {
        seen = structuredRequest;
        return { prompt: 'ENHANCED FRAME', attributes: { framing: 'wide' } };
    };
    const id = conversationId('prompt');
    const production = productionPlan.create({
        conversationId: id,
        brief: { subject: 'a woman', setting: 'Tokyo', action: 'walking' },
        video: { duration: 10 },
        originalRequest: 'a movie'
    });
    productionPlan.set(id, production);
    const prompt = await director.buildImageStagePrompt(production, {
        provider: 'ollama', model: 'test', think: false
    });
    assert.equal(prompt, 'ENHANCED FRAME');
    assert.match(seen.user_prompt, /woman/i);
    productionPlan.remove(id);
});

// --- End-to-end orchestration (LLM stubbed) ----------------------------------

test('createProduction + video stage: duration is carried and the frame becomes the I2VA source', async () => {
    providers.chat = async (provider, messages) => {
        const sys = String((messages[0] && messages[0].content) || '');
        if (/creative brief/i.test(sys)) {
            return JSON.stringify({
                subject: 'a young woman',
                setting: 'a Tokyo street at night',
                action: 'walking toward the camera',
                visualStyle: 'photorealistic cinematic',
                shots: '1'
            });
        }
        if (/H3 Video Director/i.test(sys)) {
            return JSON.stringify({
                mode: 'i2va',
                prompt: 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n[Shot 1] The woman walks forward.'
            });
        }
        return '{}';
    };
    const id = conversationId('e2e');
    const production = await director.createProduction({
        conversationId: id,
        message: 'Generate a 10-second cinematic movie of a woman walking through Tokyo at night.',
        provider: 'ollama',
        model: 'test-model',
        think: false
    });
    assert.equal(production.video.duration, 10);
    assert.equal(production.status, productionPlan.STATUS.GENERATING_IMAGE);

    director.markImageReady(production, {
        url: '/generated/frame.png',
        rawFilename: 'frame.png',
        prompt: 'FRAME',
        seed: 1
    });
    assert.equal(productionPlan.isAwaitingApproval(production), true);

    const stage = await director.buildVideoStageRequest(production, {
        provider: 'ollama', model: 'test-model', think: false
    });
    assert.equal(stage.videoMode, 'i2va');
    assert.equal(stage.sourceImageRawFilename, 'frame.png');
    assert.equal(stage.duration, 10);
    assert.match(stage.videoPrompt, /Shot 1/);
    assert.match(stage.structuredRequest.user_prompt, /10 seconds/);
    // The production is cut, not one continuous take: the H3 stage is handed an
    // explicit shot plan it renders as [Shot 1]..[Shot N].
    assert.equal(stage.structuredRequest.multi_shot, true);
    assert.equal(stage.structuredRequest.shot_plan.length, 3);
    productionPlan.remove(id);
});

// --- Markers -----------------------------------------------------------------

test('renderImageApprovalContent embeds a parseable marker and stripMarkers removes it', () => {
    const id = conversationId('marker');
    const production = productionPlan.create({
        conversationId: id,
        brief: { subject: 'a woman' },
        video: { duration: 10 },
        originalRequest: 'a movie'
    });
    production.status = productionPlan.STATUS.AWAITING_IMAGE_APPROVAL;
    const content = director.renderImageApprovalContent(production, '![opening frame](/generated/x.png)');
    const match = content.match(/\[\[director:(\{[^\n]*?\})\]\]/);
    assert.ok(match, 'marker present');
    const data = JSON.parse(match[1]);
    assert.equal(data.status, 'awaiting_image_approval');
    assert.equal(data.duration, 10);
    assert.doesNotMatch(director.stripMarkers(content), /\[\[director:/);
    assert.match(director.stripMarkers(content), /opening frame/);
});

// --- H3 dialogue guidance ----------------------------------------------------

test('the H3 director prompt teaches on-screen lip-synced dialogue', () => {
    const base = videoGenerator.H3_DIRECTOR_SYSTEM_PROMPT;
    assert.match(base, /SPEAKERS, DIALOGUE AND SINGING/i);
    assert.match(base, /<d>\[English\]/);
    assert.match(base, /in sync with the words/i);
    assert.match(base, /off-screen voiceover/i);
    assert.match(base, /Never move dialogue or singing into overall_soundscape/i);
    assert.match(videoGenerator.H3_MULTISHOT_ADDENDUM, /lip-synced mouths/i);
});

test('the H3 prompt modifier preserves on-screen dialogue', () => {
    const modifier = videoGenerator.H3_MODIFIER_SYSTEM_PROMPT;
    assert.match(modifier, /speakers and dialogue/i);
    assert.match(modifier, /<d>\[Language\]/);
    assert.match(modifier, /lip-synced/);
    assert.match(modifier, /never move dialogue into overall_soundscape/i);
});
