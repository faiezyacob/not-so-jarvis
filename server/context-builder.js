/* ============================================
   JARVIS — Context Builder
   Responsible for assembling the bounded AI
   context: system prompt + summary + recent
   messages + current message + (future)
   relevant older messages.
   ============================================ */

const conversationService = require('./conversation-service');
const configManager = require('./config-manager');

const SYSTEM_PROMPT =
    'You are JARVIS, a local AI assistant running on the user\'s own machine. '
    + 'You assist with system monitoring, software development, and general tasks. '
    + 'You also have access to a local image-generation tool (Krea2/ComfyUI): when the '
    + 'user asks you to generate, create, draw, render, or imagine an image, an image '
    + 'is created locally and shown in the conversation. Concept questions about how '
    + 'image generation works are answered as normal chat. '
    + 'You do NOT execute tools yourself: the system runs generations and edits '
    + 'for you. Never output JSON tool calls such as {"action": "image_generation", '
    + '"action_input": ...} or {"intent": "image_generation", ...} — always reply '
    + 'in plain natural language and describe what you see or will do. '
    + 'Never invent /generated/ image, video, or file links in a plain chat reply: '
    + 'only the image/video tool pipelines can produce /generated/ URLs, and a chat '
    + 'reply without a tool run must not contain any. If the user asks for a '
    + 'generation, upscale, or edit that you cannot run, say so plainly instead of '
    + 'describing a fake result. '
    + 'Be concise and helpful. When the user asks about their machine you may be '
    + 'given a live CPU/RAM/GPU/VRAM telemetry snapshot, and when they ask about '
    + 'the weather you may be given a live weather snapshot, both as system '
    + 'context. Use only those values when present; never estimate or invent '
    + 'numbers or a forecast. The user can attach images: when a message includes '
    + 'an attached image, describe what you see and answer questions about it.';

// Placeholder for future semantic retrieval. Returns [] for now.
function getRelevantMessages(conversationId, query) {
    // Future: semantic / keyword search over older messages.
    return [];
}

// Effective system prompt: base JARVIS guardrails plus the user's custom
// persona instruction (Settings > Chat). The base prompt is never replaced
// so the /generated/ link and image-tool guardrails always apply.
function getSystemPrompt() {
    let custom = '';
    try {
        custom = (configManager.getChatSettings().systemPrompt || '').trim();
    } catch {
        custom = '';
    }
    if (!custom) return SYSTEM_PROMPT;
    return SYSTEM_PROMPT + '\n\nAdditional persona instruction from the user:\n' + custom;
}

function buildContext(conversationId, userMessage, provider, model, activeTaskContext, images, environmentContext) {
    const recent = conversationService
        .getMessages(conversationId)
        .slice(-conversationService.CONFIG.RECENT_MESSAGE_LIMIT);

    const messages = [];

    messages.push({ role: 'system', content: getSystemPrompt() });

    if (environmentContext) {
        messages.push({ role: 'system', content: environmentContext });
    }

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

// --- Environment context (live telemetry + weather) ---
//
// The chat model has no tools, so live machine state is supplied as a system
// message. It is gated on a stats-related question so unrelated turns stay
// lean. Weather context is built asynchronously in server.js (network lookup)
// and passed in through the environmentContext argument of buildContext.

const SYSTEM_QUERY_RE = /\b(cpu|gpu|vram|ram|cores?|clock speed|system (stats|status|info|specs|health|load|resources?|report)|telemetry|utilization|utilisation|(cpu|gpu) temp(erature)?|memory usage|nvidia|hardware|how (hot|loaded|fast) is my (gpu|cpu|pc|computer|system|machine)|how('s| is) my (pc|computer|system|machine))/i;

function isSystemStatsQuery(message) {
    return SYSTEM_QUERY_RE.test(String(message || ''));
}

function formatSystemStats(stats) {
    if (!stats || !stats.cpu || !stats.ram || !stats.vram) return '';
    const lines = ['Live system telemetry (snapshot taken for this request):'];

    const cpu = stats.cpu;
    let cpuLine = '- CPU: ' + (cpu.name || 'Unknown CPU');
    if (Number.isFinite(cpu.usage)) cpuLine += ' \u2014 ' + cpu.usage + '% usage';
    if (cpu.cores) cpuLine += ', ' + cpu.cores + ' cores';
    if (cpu.clock && cpu.clock !== 'N/A') cpuLine += ' @ ' + cpu.clock;
    if (cpu.temperature != null) cpuLine += ', ' + cpu.temperature + '\u00B0C';
    lines.push(cpuLine);

    const ram = stats.ram;
    lines.push('- RAM: ' + ram.used + ' / ' + ram.total + ' GB (' + ram.usage + '%)');

    const gpu = stats.gpu || {};
    const vram = stats.vram;
    if (vram.available) {
        let gpuLine = '- GPU: ' + (gpu.name || 'Unknown GPU');
        if (Number.isFinite(gpu.usage)) gpuLine += ' \u2014 ' + gpu.usage + '% utilization';
        if (gpu.temperature != null) gpuLine += ', ' + gpu.temperature + '\u00B0C';
        lines.push(gpuLine);
        lines.push('- VRAM: ' + vram.used + ' / ' + vram.total + ' GB (' + vram.usage + '%)');
    } else {
        lines.push('- GPU/VRAM: not available (no nvidia-smi GPU detected)');
    }

    lines.push('Answer with these exact values only; never estimate or invent numbers.');
    return lines.join('\n');
}

function buildSystemStatsContext(message, stats) {
    if (!isSystemStatsQuery(message)) return '';
    return formatSystemStats(stats);
}

module.exports = {
    buildContext,
    getRelevantMessages,
    getSystemPrompt,
    SYSTEM_PROMPT,
    isSystemStatsQuery,
    formatSystemStats,
    buildSystemStatsContext,
    SYSTEM_QUERY_RE
};
