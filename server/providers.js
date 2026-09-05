/* ============================================
   JARVIS — Local AI Providers
   Ollama and LM Studio chat + summarization.
   ============================================ */

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const LMSTUDIO_URL = process.env.LMSTUDIO_URL || 'http://localhost:1234';

async function callOllama(messages, model) {
    const res = await fetch(OLLAMA_URL + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: model || 'llama3.2',
            messages: messages,
            stream: false
        })
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error('Ollama error ' + res.status + ': ' + err);
    }

    const data = await res.json();
    return data.message.content;
}

async function callLMStudio(messages, model) {
    const res = await fetch(LMSTUDIO_URL + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: model || 'lm-studio',
            messages: messages,
            temperature: 0.7,
            stream: false
        })
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error('LM Studio error ' + res.status + ': ' + err);
    }

    const data = await res.json();
    return data.choices[0].message.content;
}

// Streaming versions
async function* streamOllama(messages, model) {
    const res = await fetch(OLLAMA_URL + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: model || 'llama3.2',
            messages: messages,
            stream: true
        })
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

async function* streamLMStudio(messages, model) {
    const res = await fetch(LMSTUDIO_URL + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: model || 'lm-studio',
            messages: messages,
            temperature: 0.7,
            stream: true
        })
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error('LM Studio error ' + res.status + ': ' + err);
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
            if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') return;
                try {
                    const json = JSON.parse(data);
                    if (json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content) {
                        yield { type: 'content', text: json.choices[0].delta.content };
                    }
                } catch (e) {
                    // Skip invalid JSON
                }
            }
        }
    }
}

// Provider router for chat
async function chat(provider, messages, model) {
    if (provider === 'ollama') return callOllama(messages, model);
    if (provider === 'lmstudio') return callLMStudio(messages, model);
    throw new Error('Unknown provider: ' + provider);
}

// Provider router for streaming chat
async function* chatStream(provider, messages, model) {
    if (provider === 'ollama') yield* streamOllama(messages, model);
    else if (provider === 'lmstudio') yield* streamLMStudio(messages, model);
    else throw new Error('Unknown provider: ' + provider);
}

// Provider router for summarization
async function summarize(provider, model, messagesToSummarize) {
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
        return callOllama([sysPrompt, { role: 'user', content: content }], model);
    }
    if (provider === 'lmstudio') {
        return callLMStudio([sysPrompt, { role: 'user', content: content }], model);
    }
    throw new Error('Unknown provider: ' + provider);
}

// Unload the model from the provider's memory.
// Ollama: POST /api/generate with keep_alive 0.
// LM Studio: POST /api/v1/models/unload.
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

    if (provider === 'lmstudio') {
        if (!model) throw new Error('Model name is required');

        const res = await fetch(LMSTUDIO_URL + '/api/v1/models/unload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instance_id: model })
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error('LM Studio unload error ' + res.status + ': ' + err);
        }

        let data = {};
        try {
            data = await res.json();
        } catch (e) {}
        return { unloaded: true, instance_id: data.instance_id };
    }

    throw new Error('Unknown provider: ' + provider);
}

module.exports = { chat, chatStream, summarize, unloadModel };
