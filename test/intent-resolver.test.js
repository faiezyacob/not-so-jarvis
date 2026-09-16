/* ============================================
   JARVIS — Intent Resolver tests
   Covers the structured intent schema, signal
   evidence, action-vs-subject resolution,
   pending clarification, and the resolver ->
   action-router mapping. LLM/storage seams are
   stubbed so these run offline and fast.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const providers = require('../server/providers');
const conversationService = require('../server/conversation-service');
const taskState = require('../services/task-state');
const intentResolver = require('../services/intent-resolver');
const taskRouter = require('../services/task-router');

const originalChat = providers.chat;
const originalGetMessages = conversationService.getMessages;
const originalGetTask = taskState.getTask;

test.afterEach(() => {
    providers.chat = originalChat;
    conversationService.getMessages = originalGetMessages;
    taskState.getTask = originalGetTask;
});

function stubInvalidChat() {
    providers.chat = async () => 'not json at all';
}

function stubChatJson(obj) {
    providers.chat = async () => JSON.stringify(obj);
}

function contextFor(extra = {}) {
    const activeTask = extra.activeTask || { type: null, prompt: '', videoMode: null, parameters: {} };
    return {
        conversationId: extra.conversationId || 'intent-test',
        activeTask,
        lastUserRequest: '',
        lastAssistantAction: '',
        lastGeneratedImage: extra.lastGeneratedImage || null,
        lastGeneratedVideo: null,
        activePrompt: activeTask.prompt || '',
        activeGeneration: activeTask.type ? { type: activeTask.type, status: 'idle' } : null,
        pendingAction: extra.pendingAction || null,
        selectedMode: extra.selectedMode || null,
        referenceImage: extra.referenceImage || null,
        hasAttachedImage: Boolean(extra.hasAttachedImage)
    };
}

function resolve(message, extra = {}) {
    return intentResolver.resolveIntent({
        message,
        provider: 'ollama',
        model: 'test-model',
        think: false,
        conversationId: 'intent-test',
        context: contextFor(extra)
    });
}

// --- Signals: action vs subject ----------------------------------------------

test('collectSignals: a prompt meta-request reads as prompt writing, not generation', () => {
    const s = intentResolver.collectSignals('write me a prompt for an image of a woman in Tokyo', {});
    assert.equal(s.hasImageWord, true);
    assert.equal(s.hasPromptWord, true);
    assert.equal(s.promptWriting, true);
    assert.equal(s.promptIdeation, false);
    assert.equal(s.subject, 'image');
});

test('collectSignals: prompt ideation is recognized', () => {
    const s = intentResolver.collectSignals('give me some ideas for video prompts', {});
    assert.equal(s.promptIdeation, true);
    assert.equal(s.promptWriting, false);
    assert.equal(s.subject, 'video');
});

test('collectSignals: a plain generation request is not a prompt request', () => {
    const s = intentResolver.collectSignals('generate an image of a forest', {});
    assert.equal(s.imageStrength, 'definite');
    assert.equal(s.promptWriting, false);
    assert.equal(s.promptIdeation, false);
    assert.equal(s.subject, 'image');
});

// --- Signal fallback (LLM unavailable) ---------------------------------------

test('resolveIntent: "write me a prompt for an image ..." is prompt_writing', async () => {
    stubInvalidChat();
    const r = await resolve('write me a prompt for an image of a woman in Tokyo');
    assert.equal(r.intent, 'prompt_writing');
    assert.equal(r.subject, 'image');
    assert.equal(r.referencesPreviousContext, false);
    assert.equal(r.requiresClarification, false);
    assert.equal(r.decisive, true);
});

test('resolveIntent: "give me some ideas for video prompts" is prompt_ideation', async () => {
    stubInvalidChat();
    const r = await resolve('give me some ideas for video prompts');
    assert.equal(r.intent, 'prompt_ideation');
    assert.equal(r.subject, 'video');
    assert.equal(r.decisive, true);
});

test('resolveIntent: a text-to-video request with no mode asks for clarification', async () => {
    stubInvalidChat();
    const r = await resolve('Generate a video of a young Asian woman walking through Tokyo.');
    assert.equal(r.intent, 'video_generation');
    assert.equal(r.mode, 'unknown');
    assert.equal(r.requiresClarification, true);
    assert.equal(r.clarificationReason, 'video_mode');
});

test('resolveIntent: an explicit director request skips the question', async () => {
    stubInvalidChat();
    const r = await resolve('director mode: a cinematic film of a lighthouse');
    assert.equal(r.intent, 'video_generation');
    assert.equal(r.mode, 'director');
    assert.equal(r.requiresClarification, false);
});

test('resolveIntent: a production noun without a medium word still asks (commercial)', async () => {
    stubInvalidChat();
    const r = await resolve('create a commercial for a coffee brand');
    assert.equal(r.intent, 'video_generation');
    assert.equal(r.requiresClarification, true);
});

test('resolveIntent: "make a movie poster" is not a video request', async () => {
    stubInvalidChat();
    const r = await resolve('make a movie poster');
    assert.notEqual(r.intent, 'video_generation');
});

test('resolveIntent: an explicit direct request skips the question', async () => {
    stubInvalidChat();
    const r = await resolve('just generate the video of a cat');
    assert.equal(r.intent, 'video_generation');
    assert.equal(r.requiresClarification, false);
});

test('resolveIntent: "now turn this into a video" references the previous image (no question)', async () => {
    stubInvalidChat();
    const r = await resolve('Now turn this into a video.', {
        activeTask: { type: 'image', prompt: 'a woman in Tokyo', parameters: {}, lastImage: { prompt: 'a woman in Tokyo' } }
    });
    assert.equal(r.intent, 'video_generation');
    assert.equal(r.referencesPreviousContext, true);
    assert.equal(r.requiresClarification, false);
    assert.equal(r.mode, 'direct');
});

test('resolveIntent: an unrelated prompt request does not inherit the previous generation', async () => {
    stubInvalidChat();
    const r = await resolve('Write me a prompt for a spaceship.', {
        activeTask: { type: 'image', prompt: 'a woman in Tokyo', parameters: {} }
    });
    assert.equal(r.intent, 'prompt_writing');
    assert.equal(r.referencesPreviousContext, false);
});

// --- Semantic (LLM) authority -------------------------------------------------

test('resolveIntent: the LLM resolves a referential video request', async () => {
    stubChatJson({
        intent: 'video_generation',
        confidence: 0.96,
        mode: 'unknown',
        referencesPreviousContext: true,
        extractedRequest: 'anime her walking through Tokyo'
    });
    const r = await resolve('Now turn this into a video.', {
        activeTask: { type: 'image', prompt: 'a woman in Tokyo', parameters: {} },
        lastGeneratedImage: 'abc.png'
    });
    assert.equal(r.intent, 'video_generation');
    assert.equal(r.confidence, 0.96);
    assert.equal(r.referencesPreviousContext, true);
    assert.equal(r.extractedRequest, 'anime her walking through Tokyo');
});

test('resolveIntent: a malformed LLM reply falls back to signals', async () => {
    stubInvalidChat();
    const r = await resolve('generate an image of a red fox');
    assert.equal(r.intent, 'image_generation');
    assert.equal(r.decisive, true);
});

test('resolveIntent: a content-targeted edit survives an LLM "chat" verdict', async () => {
    stubChatJson({ intent: 'chat', confidence: 0.9 });
    const r = await resolve('remove the car', {
        activeTask: { type: 'image', prompt: 'a street with a car', parameters: {} }
    });
    assert.equal(r.intent, 'image_edit');
});

test('resolveIntent: a definite image request survives an LLM "chat" verdict', async () => {
    stubChatJson({ intent: 'chat', confidence: 0.9 });
    const r = await resolve('generate an image of a red fox');
    assert.equal(r.intent, 'image_generation');
});

// --- Pending clarification ----------------------------------------------------

test('resolveClarificationAnswer: reads director / direct / cancel / new request', () => {
    const pending = { intent: 'video_generation', mode: 'unknown', request: 'Make a video of a cat' };
    assert.deepEqual(intentResolver.resolveClarificationAnswer('Director', pending), { type: 'director', mode: 'director' });
    assert.equal(intentResolver.resolveClarificationAnswer('use director mode', pending).type, 'director');
    assert.equal(intentResolver.resolveClarificationAnswer('direct video please', pending).type, 'direct');
    assert.equal(intentResolver.resolveClarificationAnswer('cancel', pending).type, 'cancel');
    assert.equal(intentResolver.resolveClarificationAnswer('generate a video of a dog', pending).type, 'new_request');
    assert.equal(intentResolver.resolveClarificationAnswer('what do you recommend?', pending), null);
});

test('resolveIntent: a pending video question resolves as clarification_response', async () => {
    const pending = {
        intent: 'video_generation',
        mode: 'unknown',
        request: 'Generate a video of a young Asian woman walking through Tokyo.',
        reason: 'video_mode',
        createdAt: new Date().toISOString()
    };
    const r = await resolve('director', { pendingAction: pending });
    assert.equal(r.intent, 'clarification_response');
    assert.equal(r.pendingResolution, 'director');
    assert.equal(r.mode, 'director');
    assert.equal(r.extractedRequest, pending.request);
});

test('resolveIntent: an ambiguous turn keeps the pending action parked', async () => {
    stubInvalidChat();
    const pending = { intent: 'video_generation', mode: 'unknown', request: 'Make a video of a cat' };
    const context = contextFor({ pendingAction: pending });
    const r = await intentResolver.resolveIntent({
        message: 'what do you recommend?',
        provider: 'ollama', model: 'm', think: false, conversationId: 'intent-test', context
    });
    assert.equal(r.intent, 'chat');
    assert.equal(context.pendingAction, pending);
});

// --- Resolver -> action-router mapping ---------------------------------------

test('decisionFromResolvedIntent: prompt_writing never executes a tool', () => {
    const d = taskRouter.decisionFromResolvedIntent(
        { intent: 'prompt_writing', extractedRequest: 'an image of a cat', referencesPreviousContext: false },
        { message: 'write a prompt', activeTask: { type: null }, conversationId: 'c', hasAttachedImage: false, referenceImage: null }
    );
    assert.equal(d.shouldExecuteTool, false);
    assert.equal(d.task, null);
});

test('decisionFromResolvedIntent: video with unknown mode parks for clarification', () => {
    const d = taskRouter.decisionFromResolvedIntent(
        { intent: 'video_generation', requiresClarification: true, clarificationReason: 'video_mode', extractedRequest: 'a video of a cat' },
        { message: 'make a video', activeTask: { type: null }, conversationId: 'c', hasAttachedImage: false, referenceImage: null }
    );
    assert.equal(d.requiresClarification, true);
    assert.equal(d.task, 'video_generation');
    assert.equal(d.clarification.mode, 'unknown');
    assert.equal(d.shouldExecuteTool, false);
});

test('decisionFromResolvedIntent: image_generation builds a structured request', () => {
    const d = taskRouter.decisionFromResolvedIntent(
        { intent: 'image_generation', extractedRequest: 'a red fox', creative_mode: 'none', explicit_constraints: [] },
        { message: 'generate a red fox image', activeTask: { type: null }, conversationId: 'c', hasAttachedImage: false, referenceImage: null }
    );
    assert.equal(d.task, 'image_generation');
    assert.equal(d.shouldExecuteTool, true);
    assert.equal(d.structuredRequest.user_prompt, 'a red fox');
    assert.equal(d.intent, 'new_task');
});

// --- routeMessage integration -------------------------------------------------

test('routeMessage: a prompt-writing request stays chat even though "image" is present', async () => {
    conversationService.getMessages = () => [];
    taskState.getTask = () => ({ type: null });
    stubChatJson({ intent: 'prompt_writing', confidence: 0.98, subject: 'image', referencesPreviousContext: false });
    const d = await taskRouter.routeMessage({
        message: 'write me a prompt for an image of a woman in Tokyo',
        provider: 'ollama', model: 'm', conversationId: 'conv-pw', think: false
    });
    assert.equal(d.shouldExecuteTool, false);
    assert.equal(d.task, null);
});

test('routeMessage: a text-to-video request without a mode returns a clarification decision', async () => {
    conversationService.getMessages = () => [];
    taskState.getTask = () => ({ type: null });
    stubChatJson({ intent: 'video_generation', confidence: 0.96, mode: 'unknown', referencesPreviousContext: false, extractedRequest: 'a young Asian woman walking through Tokyo' });
    const d = await taskRouter.routeMessage({
        message: 'Generate a video of a young Asian woman walking through Tokyo.',
        provider: 'ollama', model: 'm', conversationId: 'conv-vid', think: false
    });
    assert.equal(d.requiresClarification, true);
    assert.equal(d.task, 'video_generation');
    assert.equal(d.shouldExecuteTool, false);
});

// --- Debug trace --------------------------------------------------------------

test('formatDebugTrace: renders the resolver decision and regex evidence', () => {
    const trace = intentResolver.formatDebugTrace({
        message: 'write me a prompt for an image of a woman in Tokyo',
        signals: { hasImageWord: true, hasPromptWord: true, hasVideoWord: false, subject: 'image' },
        resolved: { intent: 'prompt_writing', confidence: 0.98, subject: 'image', referencesPreviousContext: false, requiresClarification: false },
        finalAction: 'prompt_writing'
    });
    assert.match(trace, /intent: prompt_writing/);
    assert.match(trace, /confidence: 0.98/);
    assert.match(trace, /image: true/);
    assert.match(trace, /prompt: true/);
    assert.match(trace, /video: false/);
    assert.match(trace, /FINAL ACTION:\nprompt_writing/);
});
