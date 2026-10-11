/* ============================================
   JARVIS — Companion memory text utilities
   Dependency-free, deterministic tokenization and
   similarity helpers shared by the memory store
   and the retrieval layer. No embeddings: a small
   stop-word list plus token overlap keeps memory
   retrieval local and predictable.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const STOP_WORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from',
    'had', 'has', 'have', 'he', 'her', 'hers', 'him', 'his', 'i', 'if', 'in', 'into',
    'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'she', 'so', 'than',
    'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to',
    'was', 'we', 'were', 'what', 'when', 'which', 'who', 'will', 'with', 'you',
    'your', 'yours', 'do', 'does', 'did', 'about', 'just', 'really', 'very'
]);

// Lowercase, strip punctuation, split on whitespace. Unicode-aware so names and
// non-English text survive.
function normalizeText(value) {
    return String(value === undefined || value === null ? '' : value)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Meaningful tokens for similarity/recall. Short tokens and stop words drop out
// so overlap reflects content, not grammar.
function tokenize(value) {
    const normalized = normalizeText(value);
    if (!normalized) return [];
    const tokens = [];
    for (const word of normalized.split(' ')) {
        if (!word || word.length < 3) continue;
        if (STOP_WORDS.has(word)) continue;
        tokens.push(word);
    }
    return tokens;
}

// Unique token set, useful for overlap scoring.
function tokenSet(value) {
    return new Set(tokenize(value));
}

// Fraction of the shorter token set that the two texts share. 0 when either is
// empty. Symmetric and bounded to [0,1].
function jaccard(a, b) {
    const setA = a instanceof Set ? a : tokenSet(a);
    const setB = b instanceof Set ? b : tokenSet(b);
    if (!setA.size || !setB.size) return 0;
    let shared = 0;
    for (const token of setA) {
        if (setB.has(token)) shared += 1;
    }
    const min = Math.min(setA.size, setB.size);
    return min ? shared / min : 0;
}

// How much of `query` is covered by `text`. Used for retrieval where the query
// is short and the memory may be long.
function queryOverlap(query, text) {
    const q = query instanceof Set ? query : tokenSet(query);
    if (!q.size) return 0;
    const t = text instanceof Set ? text : tokenSet(text);
    if (!t.size) return 0;
    let shared = 0;
    for (const token of q) {
        if (t.has(token)) shared += 1;
    }
    return shared / q.size;
}

// Combine both directions so neither a short query nor a short memory is
// unfairly penalized.
function similarity(a, b) {
    return Math.max(jaccard(a, b), queryOverlap(a, b), queryOverlap(b, a));
}

module.exports = {
    STOP_WORDS,
    normalizeText,
    tokenize,
    tokenSet,
    jaccard,
    queryOverlap,
    similarity
};
