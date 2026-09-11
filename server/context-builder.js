/* ============================================
   JARVIS — Context Builder
   Responsible for assembling the bounded AI
   context: system prompt + summary + recent
   messages + current message + (future)
   relevant older messages.
   ============================================ */

const conversationService = require('./conversation-service');

const SYSTEM_PROMPT =
    'You are JARVIS, a local AI assistant running on the user\'s own machine. '
    + 'You assist with system monitoring, software development, and general tasks. '
    + 'You also have access to a local image-generation tool (Krea2/ComfyUI): when the '
    + 'user asks you to generate, create, draw, render, or imagine an image, an image '
    + 'is created locally and shown in the conversation. Concept questions about how '
    + 'image generation works are answered as normal chat. '
    + 'Never invent /generated/ image, video, or file links in a plain chat reply: '
    + 'only the image/video tool pipelines can produce /generated/ URLs, and a chat '
    + 'reply without a tool run must not contain any. If the user asks for a '
    + 'generation, upscale, or edit that you cannot run, say so plainly instead of '
    + 'describing a fake result. '
    + 'Be concise and helpful. The local environment may expose CPU, RAM, GPU and '
    + 'VRAM telemetry. The user can attach images: when a message includes an '
    + 'attached image, describe what you see and answer questions about it.';

// Placeholder for future semantic retrieval. Returns [] for now.
function getRelevantMessages(conversationId, query) {
    // Future: semantic / keyword search over older messages.
    return [];
}

function buildContext(conversationId, userMessage, provider, model, activeTaskContext, images) {
    const recent = conversationService
        .getMessages(conversationId)
        .slice(-conversationService.CONFIG.RECENT_MESSAGE_LIMIT);

    const messages = [];

    messages.push({ role: 'system', content: SYSTEM_PROMPT });

    if (activeTaskContext) {
        messages.push({
            role: 'system',
            content: activeTaskContext
        });
    }

    const conv = conversationService.getConversation(conversationId);
    if (conv && conv.summary) {
        messages.push({
            role: 'system',
            content: 'Conversation summary:\n' + conv.summary
        });
    }

    const relevant = getRelevantMessages(conversationId, userMessage);
    if (relevant.length > 0) {
        messages.push({
            role: 'system',
            content: 'Relevant context from earlier in the conversation:\n'
                + relevant.map((m) => (m.role === 'user' ? 'User: ' : 'Assistant: ') + m.content).join('\n')
        });
    }

    recent.forEach((m) => {
        messages.push({ role: m.role, content: m.content });
    });

    const current = { role: 'user', content: userMessage };
    if (Array.isArray(images) && images.length > 0) {
        current.images = images.slice(0, 3);
    }
    messages.push(current);

    return messages;
}

module.exports = { buildContext, getRelevantMessages };
