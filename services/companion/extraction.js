/* ============================================
   JARVIS — Companion memory formation
   Turns a bounded conversation excerpt into a
   small set of durable memories using the locally
   configured chat model. Extraction is fail-open:
   any error leaves the conversation untouched, and
   the caller runs it deferred so it never delays a
   reply. Dedupe/supersede happens against the
   store, not in the model.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const store = require('./store');
const text = require('./text');

const MAX_CANDIDATES = 6;
const SEMANTIC_DUPLICATE = 0.72;
const SEMANTIC_CORRECTION = 0.42;
const EPISODIC_DUPLICATE = 0.82;
const DEFAULT_MIN_USER_CHARS = 60;

const EXTRACTION_SYSTEM_PROMPT =
    'You maintain long-term memory for an AI companion character in a private, local chat app. '
    + 'Read the conversation excerpt and extract ONLY durable, useful memories. '
    + 'Return STRICT JSON with this exact shape and nothing else:\n'
    + '{"memories":[{"type":"semantic|episodic|correction","category":"short label","text":"one self-contained sentence","importance":1-5,"confidence":"stated|inferred"}],"state":{"goals":[],"activities":[],"events":[],"notes":""}}\n'
    + 'Rules:\n'
    + '- semantic = a stable fact, preference, interest, opinion or ongoing project about the USER or shared context. "stated" only when the user said it; otherwise "inferred".\n'
    + '- episodic = a meaningful shared event, decision, experience or unresolved topic worth revisiting.\n'
    + '- correction = a durable fact that REPLACES an earlier one the user has now corrected.\n'
    + '- Never store greetings, small talk, transient details, or anything already obvious.\n'
    + '- Never invent facts. Only record what the excerpt supports. Prefer 0-4 memories; quality over quantity.\n'
    + '- "state" describes the CHARACTER\'S fictional circumstances only (her goals, activities, events, notes); leave it empty when unknown. Never put user facts in state.\n'
    + '- Output only the JSON object.';

function cleanExcerpt(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/\r/g, '')
        .trim()
        .slice(-6000);
}

// Build the chat messages for one extraction pass. `existing` is the small set
// of active memories already known, so the model can flag corrections.
function buildExtractionMessages(excerpt, options) {
    const opts = options || {};
    const existing = Array.isArray(opts.existing) ? opts.existing.slice(0, 20) : [];
    const known = existing.length
        ? 'Already stored memories (use type "correction" to replace one; do not repeat unchanged ones):\n'
            + existing.map((m) => '- (' + m.id + ') ' + m.text).join('\n')
        : 'No memories stored yet.';
    const parts = [
        'Character: ' + (opts.characterName || 'the character'),
        known,
        '',
        'Conversation excerpt:',
        cleanExcerpt(opts.excerpt)
    ];
    return [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: parts.join('\n') }
    ];
}

// Extract the first balanced JSON object from a model reply (fenced or not).
function extractJsonObject(raw) {
    const value = String(raw || '');
    const start = value.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < value.length; i++) {
        const ch = value[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                try {
                    return JSON.parse(value.slice(start, i + 1));
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

function normalizeCandidate(raw) {
    if (!raw || typeof raw !== 'object') return null;
    let type = String(raw.type || 'semantic').toLowerCase();
    if (type !== 'semantic' && type !== 'episodic' && type !== 'correction') type = 'semantic';
    const body = String(raw.text || raw.memory || '').replace(/\s+/g, ' ').trim();
    if (body.length < 3) return null;
    const importanceRaw = Number(raw.importance);
    const importance = Number.isFinite(importanceRaw) ? Math.max(1, Math.min(5, Math.round(importanceRaw))) : 3;
    const confidence = String(raw.confidence || '').toLowerCase() === 'inferred' ? 'inferred' : 'stated';
    return {
        type: type === 'correction' ? 'semantic' : type,
        correction: type === 'correction',
        category: String(raw.category || 'general').replace(/\s+/g, ' ').trim().slice(0, 60) || 'general',
        text: body.slice(0, 1200),
        importance,
        confidence,
        supersedesId: raw.supersedes ? String(raw.supersedes) : null
    };
}

function parseExtraction(raw) {
    const parsed = extractJsonObject(raw);
    if (!parsed || typeof parsed !== 'object') return { memories: [], state: null };
    const memories = [];
    if (Array.isArray(parsed.memories)) {
        for (const item of parsed.memories) {
            const candidate = normalizeCandidate(item);
            if (candidate) memories.push(candidate);
            if (memories.length >= MAX_CANDIDATES) break;
        }
    }
    const rawState = parsed.state && typeof parsed.state === 'object' ? parsed.state : null;
    const state = rawState ? {
        goals: Array.isArray(rawState.goals) ? rawState.goals : [],
        activities: Array.isArray(rawState.activities) ? rawState.activities : [],
        events: Array.isArray(rawState.events) ? rawState.events.map((e) => (e && typeof e === 'object' ? e : { text: e })) : [],
        notes: rawState.notes || ''
    } : null;
    return { memories, state };
}

// Apply parsed candidates to the store: dedupe near-identical records, update
// importance when the same fact is restated, and supersede on correction.
// Returns a small report; never throws.
function applyExtraction(characterId, extraction, context) {
    const report = { added: 0, updated: 0, superseded: 0, skipped: 0, stateUpdated: false };
    try {
        // Accept candidates already normalized by parseExtraction as well as raw
        // ones (tests / direct callers) by normalizing anything unmarked.
        const candidates = ((extraction && extraction.memories) || [])
            .map((c) => (c && c.correction !== undefined ? c : normalizeCandidate(c)))
            .filter(Boolean);
        for (const candidate of candidates) {
            const existing = store.findSimilar(characterId, candidate.text, {
                type: candidate.type,
                threshold: candidate.type === 'episodic' ? EPISODIC_DUPLICATE : SEMANTIC_DUPLICATE
            });
            if (existing && !candidate.correction) {
                // Same fact restated: bump importance/recency, keep provenance.
                store.updateMemory(characterId, existing.memory.id, {
                    importance: Math.max(existing.memory.importance, candidate.importance),
                    lastAccessedAt: new Date().toISOString(),
                    sourceConversationId: (context && context.conversationId) || existing.memory.sourceConversationId
                });
                report.updated += 1;
                continue;
            }

            let supersededId = null;
            if (candidate.correction) {
                const conflict = candidate.supersedesId
                    ? { memory: store.getMemory(characterId, candidate.supersedesId) }
                    : store.findSimilar(characterId, candidate.text, { type: 'semantic', threshold: SEMANTIC_CORRECTION });
                if (conflict && conflict.memory && conflict.memory.status === 'active' && !conflict.memory.pinned) {
                    supersededId = conflict.memory.id;
                }
            }

            const added = store.addMemory(characterId, {
                type: candidate.type,
                category: candidate.category,
                text: candidate.text,
                importance: candidate.importance,
                confidence: candidate.confidence,
                sourceConversationId: context && context.conversationId,
                sourceMessageId: context && context.messageId,
                supersedes: supersededId ? [supersededId] : []
            });
            if (!added) { report.skipped += 1; continue; }
            report.added += 1;
            if (supersededId) {
                store.supersedeMemory(characterId, supersededId, added.id);
                report.superseded += 1;
            }
        }

        if (extraction && extraction.state && context && context.lifeProgression) {
            const current = store.getState(characterId) || {};
            const next = {
                goals: mergeList(current.goals, extraction.state.goals, 40),
                activities: mergeList(current.activities, extraction.state.activities, 40),
                events: mergeEvents(current.events, extraction.state.events)
            };
            store.setState(characterId, next);
            report.stateUpdated = true;
        }
    } catch (err) {
        console.warn('[companion-memory] applyExtraction failed:', err.message);
    }
    return report;
}

function mergeList(existing, incoming, cap) {
    const out = [];
    const push = (item) => {
        const value = String(item || '').replace(/\s+/g, ' ').trim();
        if (!value) return;
        if (out.some((x) => x.toLowerCase() === value.toLowerCase())) return;
        out.push(value);
    };
    (Array.isArray(existing) ? existing : []).forEach(push);
    (Array.isArray(incoming) ? incoming : []).forEach(push);
    return out.slice(-cap);
}

function mergeEvents(existing, incoming) {
    const out = [];
    const seen = new Set();
    const push = (event) => {
        const value = event && typeof event === 'object' ? event : { text: event };
        const body = String(value.text || '').replace(/\s+/g, ' ').trim();
        if (!body) return;
        const key = body.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ text: body, at: value.at || new Date().toISOString() });
    };
    (Array.isArray(existing) ? existing : []).forEach(push);
    (Array.isArray(incoming) ? incoming : []).forEach(push);
    return out.slice(-60);
}

// Heuristic gate: skip short or purely transactional excerpts so extraction is
// not run (and no model call is spent) on every trivial turn.
function shouldExtract(excerpt, options) {
    const opts = options || {};
    const minUserChars = Number.isFinite(Number(opts.minUserChars)) ? Number(opts.minUserChars) : DEFAULT_MIN_USER_CHARS;
    const userText = String(excerpt || '').replace(/^assistant:.*$/gim, '').trim();
    if (userText.length < minUserChars) return false;
    const tokens = text.tokenize(userText);
    return tokens.length >= 8;
}

// Run one extraction pass and persist the result. `providers` is injected to
// keep this module free of a hard dependency on server/providers.
async function extractMemories(deps) {
    const opts = deps || {};
    const characterId = String(opts.characterId || '').trim();
    if (!characterId) return { ok: false, reason: 'no_character' };
    try {
        const excerpt = cleanExcerpt(opts.excerpt);
        if (!shouldExtract(excerpt, opts)) return { ok: false, reason: 'too_short' };
        const existing = store.listMemories(characterId, { status: 'active', limit: 20 });
        const messages = buildExtractionMessages(excerpt, {
            characterName: opts.characterName,
            existing
        });
        const raw = await opts.providers.chat(
            opts.provider || 'ollama',
            messages,
            opts.model || '',
            { temperature: 0, think: false }
        );
        const extraction = parseExtraction(raw);
        const report = applyExtraction(characterId, extraction, {
            conversationId: opts.conversationId,
            messageId: opts.messageId,
            lifeProgression: Boolean(opts.lifeProgression)
        });
        store.setLastExtractionAt(characterId);
        store.enforceRetention(characterId, {
            maxMemoriesPerCharacter: opts.maxMemoriesPerCharacter,
            retentionDays: opts.retentionDays
        });
        return { ok: true, report };
    } catch (err) {
        console.warn('[companion-memory] extraction skipped:', err.message);
        return { ok: false, reason: 'error', error: err.message };
    }
}

// Deferred wrapper: run off the reply's critical path. `run` defaults to the
// direct call but is overridable for tests.
function scheduleExtraction(deps, run) {
    const task = () => {
        Promise.resolve()
            .then(() => (typeof run === 'function' ? run(deps) : extractMemories(deps)))
            .catch((err) => console.warn('[companion-memory] scheduled extraction failed:', err.message));
    };
    if (typeof setImmediate === 'function') setImmediate(task);
    else setTimeout(task, 0);
}

module.exports = {
    EXTRACTION_SYSTEM_PROMPT,
    MAX_CANDIDATES,
    buildExtractionMessages,
    extractJsonObject,
    parseExtraction,
    applyExtraction,
    shouldExtract,
    extractMemories,
    scheduleExtraction,
    mergeList,
    mergeEvents
};
