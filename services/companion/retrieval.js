/* ============================================
   JARVIS — Companion memory retrieval
   Deterministic, model-free ranking. Combines
   keyword overlap with the current message,
   recency, importance and pinning, then builds a
   bounded context block. Modular on purpose so a
   local embedding/vector index can replace the
   scoring later without touching callers.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const text = require('./text');

const WEIGHTS = {
    overlap: 1.0,
    recency: 0.35,
    importance: 0.45,
    pinned: 0.6,
    accessPenalty: 0.1
};

const RECENCY_HALF_LIFE_DAYS = 30;
const DEFAULT_MAX_COUNT = 8;
const DEFAULT_MAX_CHARS = 1600;
const PINNED_ALWAYS = 3;

function ageInDays(iso, now) {
    const stamp = Date.parse(iso);
    if (!Number.isFinite(stamp)) return 9999;
    return Math.max(0, (now - stamp) / (24 * 60 * 60 * 1000));
}

// Smaller score contribution the more a memory has been shown, so a handful of
// very generic memories cannot dominate every turn.
function accessPenalty(memory) {
    const count = Number(memory.accessCount) || 0;
    return WEIGHTS.accessPenalty * Math.min(1, count / 20);
}

function scoreMemory(memory, querySet, now) {
    const overlap = text.queryOverlap(querySet, memory.text);
    const recency = 1 / (1 + ageInDays(memory.updatedAt || memory.createdAt, now) / RECENCY_HALF_LIFE_DAYS);
    const importance = (Math.max(1, Math.min(5, memory.importance || 3)) / 5);
    let score = WEIGHTS.overlap * overlap
        + WEIGHTS.recency * recency
        + WEIGHTS.importance * importance;
    if (memory.pinned) score += WEIGHTS.pinned;
    score -= accessPenalty(memory);
    return { score, overlap };
}

// Rank active memories for a query. Pinned memories are always eligible; an
// empty query still surfaces pinned and high-importance memories but overlaps
// with nothing.
function rankMemories(memories, query, options) {
    const opts = options || {};
    const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
    const querySet = query instanceof Set ? query : text.tokenSet(query || '');
    const includeEpisodic = opts.includeEpisodic !== false;
    const includeSemantic = opts.includeSemantic !== false;
    const list = (Array.isArray(memories) ? memories : []).filter((m) => {
        if (!m || m.status !== 'active') return false;
        if (m.type === 'episodic' && !includeEpisodic) return false;
        if (m.type === 'semantic' && !includeSemantic) return false;
        return true;
    });
    return list
        .map((memory) => Object.assign({ memory }, scoreMemory(memory, querySet, now)))
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return String(b.memory.updatedAt).localeCompare(String(a.memory.updatedAt));
        });
}

// Choose the memories to inject and format them under a bounded character
// budget. Pinned memories are guaranteed a seat (up to PINNED_ALWAYS) even when
// unrelated; scored memories fill the rest. Returns '' when nothing qualifies,
// so the caller never invents a memory.
function selectMemoryContext(memories, query, options) {
    const opts = options || {};
    const maxCount = Number.isFinite(Number(opts.maxCount)) && Number(opts.maxCount) > 0
        ? Math.floor(Number(opts.maxCount)) : DEFAULT_MAX_COUNT;
    const maxChars = Number.isFinite(Number(opts.maxChars)) && Number(opts.maxChars) > 0
        ? Math.floor(Number(opts.maxChars)) : DEFAULT_MAX_CHARS;
    const ranked = rankMemories(memories, query, opts);

    const selected = [];
    const seen = new Set();

    // Guarantee a few pinned memories.
    let pinnedSeats = 0;
    for (const entry of ranked) {
        if (!entry.memory.pinned) continue;
        if (pinnedSeats >= PINNED_ALWAYS) break;
        selected.push(entry);
        seen.add(entry.memory.id);
        pinnedSeats += 1;
    }

    for (const entry of ranked) {
        if (selected.length >= maxCount) break;
        if (seen.has(entry.memory.id)) continue;
        // Require either a pinned memory or a positive overlap/importance signal
        // so an unrelated turn does not drag in random memories.
        const relevant = entry.overlap > 0 || entry.memory.pinned || entry.memory.importance >= 4;
        if (!relevant) continue;
        selected.push(entry);
        seen.add(entry.memory.id);
    }

    // Trim to the character budget from the highest scored down.
    const kept = [];
    let used = 0;
    for (const entry of selected) {
        const line = formatMemoryLine(entry.memory);
        if (used + line.length > maxChars && kept.length > 0) continue;
        kept.push(entry.memory);
        used += line.length;
    }

    if (!kept.length) return { selected: [], text: '' };
    return { selected: kept, text: formatMemoryContext(kept) };
}

function labelFor(memory) {
    const parts = [memory.type];
    if (memory.confidence === 'inferred') parts.push('inferred');
    return parts.join(', ');
}

function formatMemoryLine(memory) {
    const inferred = memory.confidence === 'inferred' ? ' (inferred, unconfirmed)' : '';
    return '- [' + labelFor(memory) + '] ' + memory.text + inferred;
}

function formatMemoryContext(memories) {
    const facts = (memories || []).filter((m) => m.type === 'semantic');
    const episodes = (memories || []).filter((m) => m.type === 'episodic');
    const lines = [];
    if (facts.length) {
        lines.push('What you remember about the user and your shared history:');
        facts.forEach((m) => lines.push(formatMemoryLine(m)));
    }
    if (episodes.length) {
        lines.push('Relevant shared experiences:');
        episodes.forEach((m) => lines.push(formatMemoryLine(m)));
    }
    return lines.join('\n');
}

module.exports = {
    WEIGHTS,
    DEFAULT_MAX_COUNT,
    DEFAULT_MAX_CHARS,
    rankMemories,
    scoreMemory,
    selectMemoryContext,
    formatMemoryContext,
    formatMemoryLine
};
