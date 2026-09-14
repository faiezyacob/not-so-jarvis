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
const productionPlan = require('../services/director/production-plan');
const prompts = require('../services/director/director-prompts');
const approval = require('../services/director/approval-manager');
const director = require('../services/director/director');

const originals = {
    chat: providers.chat,
    buildImagePrompt: imageGenerator.buildImagePrompt
};

test.afterEach(() => {
    providers.chat = originals.chat;
    imageGenerator.buildImagePrompt = originals.buildImagePrompt;
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

// --- Mode choice (Direct video vs Director mode) -----------------------------

test('mode choice: any new video request asks, explicit director/direct skip it', () => {
    assert.equal(director.shouldOfferModeChoice('make a video of a cat', {}), true);
    assert.equal(director.shouldOfferModeChoice('create a commercial for coffee', {}), true);
    assert.equal(director.shouldOfferModeChoice('make a cinematic movie of a woman', {}), true);
    assert.equal(director.shouldOfferModeChoice('turn this image into a video', {}), true);
    assert.equal(director.shouldOfferModeChoice('director mode: a movie about a dog', {}), false);
    assert.equal(director.shouldOfferModeChoice('just generate the video of a cat', {}), false);
    assert.equal(director.shouldOfferModeChoice('generate a portrait of a woman', {}), false);
    assert.equal(director.shouldOfferModeChoice('upscale this video', {}), false);
    assert.equal(director.shouldOfferModeChoice('make her wear a red dress', {}), false);
    assert.equal(director.shouldOfferModeChoice('make a movie poster', {}), false);
});

test('mode choice: tweaks of an active video task never ask', () => {
    assert.equal(director.shouldOfferModeChoice('make her walk faster', { activeTaskType: 'video' }), false);
    assert.equal(director.shouldOfferModeChoice('generate a video of her walking', { activeTaskType: 'video' }), true);
});

test('mode choice: a failed production stays open but does not claim a new video request', () => {
    // A restart reconciles a running stage to failed_* (still "open"), so the
    // server relies on classifyMessage returning null to know it must supersede
    // the stale production and ask the workflow question again.
    const production = { id: 'f1', status: productionPlan.STATUS.FAILED_IMAGE, stages: [] };
    assert.equal(productionPlan.isOpen(production), true);
    assert.equal(approval.classifyMessage('make a video of a cat', production), null);
    assert.equal(director.shouldOfferModeChoice('make a video of a cat', {}), true);
});

test('mode choice: wantsDirectorMode only matches explicit director phrasing', () => {
    assert.equal(director.wantsDirectorMode('director mode'), true);
    assert.equal(director.wantsDirectorMode('as a director, make a film'), true);
    assert.equal(director.wantsDirectorMode('make a cinematic movie'), false);
});

test('mode choice: classifyMessage reads the answer', () => {
    const production = { id: 'mc1', status: productionPlan.STATUS.AWAITING_MODE_CHOICE, stages: [] };
    assert.equal(approval.classifyMessage('director mode', production).action, approval.ACTIONS.CHOOSE_DIRECTOR);
    assert.equal(approval.classifyMessage('movie please', production).action, approval.ACTIONS.CHOOSE_DIRECTOR);
    assert.equal(approval.classifyMessage('direct video', production).action, approval.ACTIONS.CHOOSE_DIRECT);
    assert.equal(approval.classifyMessage('just generate it', production).action, approval.ACTIONS.CHOOSE_DIRECT);
    assert.equal(approval.classifyMessage('cancel', production).action, approval.ACTIONS.CANCEL);
    assert.equal(approval.classifyMessage('what do you recommend?', production), null);
});

test('mode choice: validate gates stage actions until a workflow is picked', () => {
    const production = { id: 'mc2', status: productionPlan.STATUS.AWAITING_MODE_CHOICE, stages: [] };
    assert.equal(approval.validate(production, { type: approval.ACTIONS.CHOOSE_DIRECT }).ok, true);
    assert.equal(approval.validate(production, { type: approval.ACTIONS.CHOOSE_DIRECTOR }).ok, true);
    assert.equal(approval.validate(production, { type: approval.ACTIONS.APPROVE }).ok, false);
});

test('mode choice: createModeChoice parks the request with its duration', () => {
    const id = conversationId('choice');
    const production = director.createModeChoice({
        conversationId: id,
        message: 'Make a 12-second movie of a robot dancing'
    });
    assert.equal(production.status, productionPlan.STATUS.AWAITING_MODE_CHOICE);
    assert.equal(production.video.duration, 12);
    assert.equal(production.pendingRequest, 'Make a 12-second movie of a robot dancing');
    assert.equal(productionPlan.isOpen(production), true);
    assert.match(director.renderModeChoiceContent(production), /Director Mode/i);
    productionPlan.remove(id);
});

test('mode choice: choosing Director builds the brief and resumes the production', async () => {
    providers.chat = async (provider, messages) => {
        const sys = String((messages[0] && messages[0].content) || '');
        if (/creative brief/i.test(sys)) {
            return JSON.stringify({ subject: 'a robot', setting: 'a stage', action: 'dancing', shots: '1' });
        }
        return '{}';
    };
    const id = conversationId('choice-build');
    const production = director.createModeChoice({
        conversationId: id,
        message: 'Make a 10-second movie of a robot dancing on a stage'
    });
    await director.buildProductionFromChoice(production, {
        provider: 'ollama', model: 'test-model', think: false
    });
    assert.equal(production.type, 'video_production');
    assert.equal(production.status, productionPlan.STATUS.GENERATING_IMAGE);
    assert.equal(production.brief.subject, 'a robot');
    assert.equal(production.video.duration, 10);
    productionPlan.remove(id);
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
    assert.match(video, /single continuous shot/i);
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
