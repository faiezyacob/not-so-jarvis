/* ============================================
   JARVIS — Local AI Providers
   Ollama chat + summarization.
   ============================================ */

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

const configManager = require('./config-manager');

// Resolve the Ollama `think` flag for a chat request. An explicit per-request
// boolean wins; otherwise the persisted global setting applies (on by
// default). The flag is always sent explicitly — Ollama ignores it for
// non-thinking models, and it makes on/off deterministic for thinking ones.
function resolveThink(model, options) {
    const explicit = options && typeof options.think === 'boolean' ? options.think : null;
    if (explicit !== null) return explicit;
    try {
        return configManager.getReasoningEnabled();
    } catch {
        return true;
    }
}

// Sampling for creative chat replies. An explicit per-request value wins;
// otherwise the persisted Settings > Chat value applies (null = model
// default, omitted from the payload). Classification calls pass an explicit
// temperature 0 and are never affected by the user setting.
function resolveSampling(options) {
    const out = {};
    const explicitTemp = options && options.temperature !== undefined && options.temperature !== null
        ? Number(options.temperature) : NaN;
    const explicitTopP = options && (options.topP !== undefined || options.top_p !== undefined)
        ? Number(options.topP !== undefined ? options.topP : options.top_p) : NaN;
    let cfg = null;
    try {
        cfg = configManager.getChatSettings();
    } catch {
        cfg = null;
    }
    const temp = Number.isFinite(explicitTemp) ? explicitTemp
        : (cfg && cfg.temperature !== null && cfg.temperature !== undefined ? Number(cfg.temperature) : NaN);
    const topP = Number.isFinite(explicitTopP) ? explicitTopP
        : (cfg && cfg.topP !== null && cfg.topP !== undefined ? Number(cfg.topP) : NaN);
    if (Number.isFinite(temp)) out.temperature = temp;
    if (Number.isFinite(topP)) out.top_p = topP;
    return out;
}

async function callOllama(messages, model, options) {
    // Classification calls (router, intent) pass temperature 0 for
    // deterministic JSON verdicts; creative chat replies fall back to the
    // persisted Settings > Chat sampling (model default when blank).
    const payload = {
        model: model || 'llama3.2',
        messages: messages,
        stream: false,
        think: resolveThink(model, options)
    };
    const sampling = resolveSampling(options);
    if (sampling.temperature !== undefined || sampling.top_p !== undefined) {
        payload.options = sampling;
    }
    const res = await fetch(OLLAMA_URL + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error('Ollama error ' + res.status + ': ' + err);
    }

    const data = await res.json();
    return data.message.content;
}

// Streaming versions
async function* streamOllama(messages, model, options) {
    const body = {
        model: model || 'llama3.2',
        messages: messages,
        stream: true,
        think: resolveThink(model, options)
    };
    const sampling = resolveSampling(options);
    if (sampling.temperature !== undefined || sampling.top_p !== undefined) {
        body.options = sampling;
    }
    const res = await fetch(OLLAMA_URL + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error('Ollama error ' + res.status + ': ' + err);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            if (line.trim()) {
                try {
                    const json = JSON.parse(line);
                    if (json.message && json.message.content) {
                        yield { type: 'content', text: json.message.content };
                    }
                    if (json.done && json.total_duration != null) {
                        const tokensPerSec = json.eval_count / (json.eval_duration / 1e9);
                        yield {
                            type: 'stats',
                            tokensPerSec: Math.round(tokensPerSec),
                            totalTokens: json.eval_count,
                            durationMs: Math.round(json.total_duration / 1e6),
                            model: json.model
                        };
                    }
                } catch (e) {
                    // Skip invalid JSON
                }
            }
        }
    }
}

// Provider router for chat
async function chat(provider, messages, model, options) {
    if (provider === 'ollama') return callOllama(messages, model, options);
    throw new Error('Unknown provider: ' + provider);
}

// Provider router for streaming chat
async function* chatStream(provider, messages, model, options) {
    if (provider === 'ollama') yield* streamOllama(messages, model, options);
    else throw new Error('Unknown provider: ' + provider);
}

// Provider router for summarization
async function summarize(provider, model, messagesToSummarize, options) {
    const content = messagesToSummarize
        .map((m) => (m.role === 'user' ? 'User: ' : 'Assistant: ') + m.content)
        .join('\n');

    const sysPrompt = {
        role: 'system',
        content: 'You are a conversation summarizer. Given a transcript of an ongoing '
            + 'conversation, write a concise summary that captures the key decisions, '
            + 'user requirements, technical details, unresolved issues, and important '
            + 'facts needed to continue the conversation later. Do not summarize every '
            + 'sentence. Output only the summary text.'
    };

    if (provider === 'ollama') {
        return callOllama([sysPrompt, { role: 'user', content: content }], model, options);
    }
    throw new Error('Unknown provider: ' + provider);
}

// Unload the model from the provider's memory.
// Ollama: POST /api/generate with keep_alive 0.
async function unloadModel(provider, model) {
    if (provider === 'ollama') {
        if (!model) throw new Error('Model name is required');

        const res = await fetch(OLLAMA_URL + '/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model,
                prompt: '',
                keep_alive: 0
            })
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error('Ollama unload error ' + res.status + ': ' + err);
        }

        return { unloaded: true };
    }

    throw new Error('Unknown provider: ' + provider);
}

module.exports = { chat, chatStream, summarize, unloadModel };
