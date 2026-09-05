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
    + 'Be concise and helpful. The local environment may expose CPU, RAM, GPU and '
    + 'VRAM telemetry.';

// Placeholder for future semantic retrieval. Returns [] for now.
function getRelevantMessages(conversationId, query) {
    // Future: semantic / keyword search over older messages.
    return [];
}

function buildContext(conversationId, userMessage, provider, model) {
    const recent = conversationService
        .getMessages(conversationId)
        .slice(-conversationService.CONFIG.RECENT_MESSAGE_LIMIT);

    const messages = [];

    messages.push({ role: 'system', content: SYSTEM_PROMPT });

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

    messages.push({ role: 'user', content: userMessage });

    return messages;
}

module.exports = { buildContext, getRelevantMessages };
