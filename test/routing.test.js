/* ============================================
   JARVIS — Task router tests
   Covers the deterministic gates and the
   structured decision normalization. The LLM
   and storage layers are stubbed so these run
   offline and fast. Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const providers = require('../server/providers');
const conversationService = require('../server/conversation-service');
const taskState = require('../services/task-state');
const imageGenerator = require('../services/image-generator');
const videoGenerator = require('../services/video-generator');
const taskRouter = require('../services/task-router');

const originals = {
    chat: providers.chat,
    getMessages: conversationService.getMessages,
    getTask: taskState.getTask,
    detectIntent: imageGenerator.detectIntent,
    detectVideoIntent: videoGenerator.detectVideoIntent
};

// Replace the LLM / storage seams used by routeMessage.
function stub(overrides = {}) {
    providers.chat = overrides.chat || (async () => '{"intent":"unrelated"}');
    conversationService.getMessages = overrides.getMessages || (() => []);
    taskState.getTask = overrides.getTask || (() => ({ type: null }));
    imageGenerator.detectIntent = overrides.detectIntent || (async () => ({ intent: 'chat' }));
    videoGenerator.detectVideoIntent = overrides.detectVideoIntent || (async () => ({ intent: 'chat' }));
}

test.afterEach(() => {
    providers.chat = originals.chat;
    conversationService.getMessages = originals.getMessages;
    taskState.getTask = originals.getTask;
    imageGenerator.detectIntent = originals.detectIntent;
    videoGenerator.detectVideoIntent = originals.detectVideoIntent;
});

function route(message, extra = {}) {
    return taskRouter.routeMessage({
        message,
        provider: 'ollama',
        model: 'test-model',
        conversationId: 'conv-test',
        think: false,
        ...extra
    });
}

// --- Deterministic gates -----------------------------------------------------

test('routeMessage: explicit video upscale wins even with no active task', async () => {
    stub();
    const d = await route('upscale this video');
    assert.equal(d.task, 'video_upscale');
    assert.equal(d.action, 'upscale');
    assert.equal(d.shouldExecuteTool, true);
});

test('routeMessage: image upscale routes to the image pipeline for an image task', async () => {
    stub({ getTask: () => ({ type: 'image' }) });
    const d = await route('upscale this image');
    assert.equal(d.task, 'image_upscale');
});

test('routeMessage: pronoun upscale follows the active video task', async () => {
    stub({ getTask: () => ({ type: 'video' }) });
    const d = await route('upscale this');
    assert.equal(d.task, 'video_upscale');
});

test('routeMessage: bare regenerate re-runs the active prompt', async () => {
    stub({ getTask: () => ({ type: 'image', prompt: 'a cat' }) });
    const d = await route('generate the image again');
    assert.equal(d.intent, 'continue_task');
    assert.equal(d.task, 'image_generation');
    assert.equal(d.action, 'generate');
    assert.equal(d.shouldExecuteTool, true);
});

test('routeMessage: regenerate with a change becomes a modify with the delta', async () => {
    stub({ getTask: () => ({ type: 'image', prompt: 'a cat' }) });
    const d = await route('generate the image again but make her wave');
    assert.equal(d.action, 'modify');
    assert.equal(d.updatedPrompt, 'make her wave');
});

test('routeMessage: a question about a referenced image stays chat', async () => {
    stub();
    const d = await route('what is in this image?', { referenceImage: 'f.png' });
    assert.equal(d.shouldExecuteTool, false);
    assert.notEqual(d.task, 'image_edit');
});

test('routeMessage: an instruction on a referenced image is an identity edit', async () => {
    stub();
    const d = await route('make her hair blue', { referenceImage: 'f.png' });
    assert.equal(d.task, 'image_edit');
    assert.equal(d.action, 'edit');
});

test('routeMessage: "another image" runs the image classifier as a new task', async () => {
    stub({
        getTask: () => ({ type: 'image', prompt: 'a cat' }),
        detectIntent: async () => ({ intent: 'image_generation', action: 'generate', user_prompt: 'a dog' })
    });
    const d = await route('generate another image');
    assert.equal(d.task, 'image_generation');
    assert.equal(d.intent, 'new_task');
    assert.equal(d.shouldExecuteTool, true);
});

// --- normalizeDecision through the LLM router --------------------------------

test('routeMessage: an unknown router task never executes a tool', async () => {
    stub({
        getTask: () => ({ type: 'image', prompt: 'a cat' }),
        chat: async () => '{"intent":"new_task","task":"bogus","shouldExecuteTool":true}'
    });
    const d = await route('zzzz');
    assert.equal(d.task, null);
    assert.equal(d.shouldExecuteTool, false);
});

test('routeMessage: continue_task + image_edit is coerced to a full-regen modify', async () => {
    stub({
        getTask: () => ({ type: 'image', prompt: 'a cat' }),
        chat: async () => '{"intent":"continue_task","task":"image_edit","shouldExecuteTool":true,"updatedPrompt":"make it blue"}'
    });
    const d = await route('zzzz');
    assert.equal(d.task, 'image_generation');
    assert.equal(d.action, 'modify');
});

test('routeMessage: the current turn is dropped from the recent-context block', async () => {
    let captured = '';
    stub({
        getTask: () => ({ type: 'image', prompt: 'a cat' }),
        getMessages: () => ([
            { role: 'user', content: 'old request' },
            { role: 'assistant', content: 'old reply' },
            { role: 'user', content: 'zzzz' }
        ]),
        chat: async (provider, messages) => {
            captured = messages[1].content;
            return '{"intent":"unrelated"}';
        }
    });
    await route('zzzz');
    const recent = captured.split('RECENT CONVERSATION:\n')[1].split('\n\nUSER LATEST MESSAGE')[0];
    assert.equal(recent.includes('User: old request'), true);
    assert.equal(recent.includes('Assistant: old reply'), true);
    assert.equal(recent.includes('zzzz'), false);
});

// --- parseRegenerateRequest --------------------------------------------------

test('parseRegenerateRequest: same-media bare and delta forms', () => {
    assert.deepEqual(
        taskRouter.parseRegenerateRequest('generate the image again', 'image'),
        { media: 'image', crossModal: false, bare: true, delta: '' }
    );
    assert.deepEqual(
        taskRouter.parseRegenerateRequest('do it again but make her wave', 'image'),
        { media: 'image', crossModal: false, bare: false, delta: 'make her wave' }
    );
    assert.deepEqual(
        taskRouter.parseRegenerateRequest('generate the image again please', 'image'),
        { media: 'image', crossModal: false, bare: true, delta: '' }
    );
});

test('parseRegenerateRequest: cross-modal media is detected', () => {
    const d = taskRouter.parseRegenerateRequest('regenerate the image as a video again', 'image');
    assert.equal(d.media, 'video');
    assert.equal(d.crossModal, true);
    assert.equal(d.bare, true);
});

test('parseRegenerateRequest: questions and negations are ignored', () => {
    assert.equal(taskRouter.parseRegenerateRequest('what again?', 'image'), null);
    assert.equal(taskRouter.parseRegenerateRequest('not again', 'image'), null);
});

test('parseRegenerateRequest: no active task means no regenerate', () => {
    assert.equal(taskRouter.parseRegenerateRequest('again', null), null);
});

// --- normalizeDecision -------------------------------------------------------

test('normalizeDecision: known tasks map to executable decisions', () => {
    assert.deepEqual(
        taskRouter.normalizeDecision({ intent: 'new_task', task: 'image_generation' }),
        { intent: 'new_task', task: 'image_generation', action: 'generate', shouldExecuteTool: true, updatedPrompt: '' }
    );
    assert.equal(taskRouter.normalizeDecision({ intent: 'new_task', task: 'image_edit' }).action, 'edit');
    assert.equal(taskRouter.normalizeDecision({ intent: 'new_task', task: 'video_upscale' }).action, 'upscale');
    assert.equal(taskRouter.normalizeDecision({ intent: 'continue_task', task: 'video_generation' }).action, 'modify');
});

test('normalizeDecision: unknown or missing task never executes', () => {
    for (const parsed of [
        { intent: 'new_task', task: 'bogus' },
        { intent: 'new_task' },
        { intent: 'switch_task' }
    ]) {
        const d = taskRouter.normalizeDecision(parsed);
        assert.equal(d.task, null);
        assert.equal(d.shouldExecuteTool, false);
    }
});

test('normalizeDecision: non-executable intents are chat', () => {
    const d = taskRouter.normalizeDecision({ intent: 'task_question', task: 'image_generation' });
    assert.equal(d.task, null);
    assert.equal(d.shouldExecuteTool, false);
    assert.equal(d.intent, 'task_question');
});

test('normalizeDecision: explicit shouldExecuteTool:false is respected', () => {
    const d = taskRouter.normalizeDecision({ intent: 'continue_task', task: 'image_generation', shouldExecuteTool: false });
    assert.equal(d.shouldExecuteTool, false);
});

test('normalizeDecision: continue_task + image_edit becomes image_generation', () => {
    const d = taskRouter.normalizeDecision({ intent: 'continue_task', task: 'image_edit', shouldExecuteTool: true });
    assert.equal(d.task, 'image_generation');
    assert.equal(d.action, 'modify');
});

// --- buildRouterContext ------------------------------------------------------

test('buildRouterContext: formats roles and handles an empty history', () => {
    assert.equal(taskRouter.buildRouterContext(null, []), '(no recent messages)');
    assert.equal(
        taskRouter.buildRouterContext(null, [{ role: 'user', content: 'hi' }]),
        'User: hi'
    );
});

test('buildRouterContext: collapses whitespace and truncates long messages', () => {
    const out = taskRouter.buildRouterContext(null, [{ role: 'assistant', content: 'x'.repeat(600) }]);
    assert.equal(out.endsWith('\u2026'), true);
    assert.equal(out.startsWith('Assistant: x'), true);
    assert.equal(out.length < 520, true);

    assert.equal(
        taskRouter.buildRouterContext(null, [{ role: 'assistant', content: 'a   b\n\nc' }]),
        'Assistant: a b c'
    );
});
