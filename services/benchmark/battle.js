/* ============================================
   JARVIS — Image Arena battles
   Blind A/B voting over completed benchmark
   results with an Elo leaderboard. Pairing only
   ever reads completed jobs that already exist
   (same session + prompt first), and the model
   identity is withheld until the vote is cast so
   the pick is about the picture, not the label.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');

const store = require('./store');
const promptPool = require('./prompts');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
// Tests point this at a temp file so data/ is never touched.
const RATINGS_PATH = process.env.BENCHMARK_RATINGS_PATH || path.join(DATA_DIR, 'benchmark-ratings.json');

const INITIAL_RATING = 1200;
// A fresh model swings fast, then settles: 32 for the first ten games, 16 after.
const K_EARLY = 32;
const K_SETTLED = 16;
const SETTLE_GAMES = 10;
const MAX_RESULTS = 120;
const MAX_SEEN = 4000;

// The battle prompt itself (the LLM-written creative prompt + the local fallback
// pool) lives in ./prompts.js. Battle pairing/Elo only needs to expose it.
const PROMPTS = promptPool.PROMPTS;
const randomPrompt = promptPool.randomPrompt;

let cache = null;

function nowIso() {
    return new Date().toISOString();
}

function round1(value) {
    return Math.round(Number(value) * 10) / 10;
}

function httpError(status, message, extra) {
    const error = new Error(message);
    error.status = status;
    Object.assign(error, extra || {});
    return error;
}

function ownerKey(sessionId) {
    const clean = String(sessionId || '').trim();
    return clean || 'shared';
}

function emptyStore() {
    return { owners: {} };
}

function normalizeModel(entry) {
    const src = entry && typeof entry === 'object' ? entry : {};
    const rating = Number(src.rating);
    return {
        id: String(src.id || ''),
        label: String(src.label || src.id || ''),
        rating: Number.isFinite(rating) ? round1(rating) : INITIAL_RATING,
        peak: Number.isFinite(Number(src.peak)) ? round1(src.peak) : (Number.isFinite(rating) ? round1(rating) : INITIAL_RATING),
        games: Math.max(0, Math.round(Number(src.games) || 0)),
        wins: Math.max(0, Math.round(Number(src.wins) || 0)),
        losses: Math.max(0, Math.round(Number(src.losses) || 0)),
        ties: Math.max(0, Math.round(Number(src.ties) || 0)),
        updatedAt: src.updatedAt || null
    };
}

function normalizeOwner(entry) {
    const src = entry && typeof entry === 'object' ? entry : {};
    const models = {};
    if (src.models && typeof src.models === 'object') {
        Object.keys(src.models).forEach((id) => {
            const model = normalizeModel(Object.assign({ id }, src.models[id]));
            if (model.id) models[model.id] = model;
        });
    }
    const seen = {};
    if (src.seen && typeof src.seen === 'object') {
        Object.keys(src.seen).forEach((key) => { seen[String(key)] = String(src.seen[key] || ''); });
    }
    const headToHead = {};
    if (src.headToHead && typeof src.headToHead === 'object') {
        Object.keys(src.headToHead).forEach((key) => {
            const record = src.headToHead[key] || {};
            headToHead[String(key)] = {
                a: Math.max(0, Math.round(Number(record.a) || 0)),
                b: Math.max(0, Math.round(Number(record.b) || 0)),
                ties: Math.max(0, Math.round(Number(record.ties) || 0))
            };
        });
    }
    // Votes cast, not pairs rated: a pair can be judged more than once once the
    // pool is exhausted, and the counter should reflect the work done.
    const derivedVotes = Object.keys(headToHead).reduce((total, key) => {
        const record = headToHead[key];
        return total + record.a + record.b + record.ties;
    }, 0);
    return {
        models,
        seen,
        headToHead,
        voteCount: Number.isFinite(Number(src.voteCount)) ? Math.max(0, Math.round(Number(src.voteCount))) : derivedVotes,
        lastPairId: src.lastPairId ? String(src.lastPairId) : null,
        updatedAt: src.updatedAt || null
    };
}

function load() {
    if (cache) return cache;
    try {
        const parsed = JSON.parse(fs.readFileSync(RATINGS_PATH, 'utf-8'));
        const owners = {};
        if (parsed && parsed.owners && typeof parsed.owners === 'object') {
            Object.keys(parsed.owners).forEach((key) => { owners[key] = normalizeOwner(parsed.owners[key]); });
        }
        cache = { owners };
    } catch (err) {
        cache = emptyStore();
    }
    return cache;
}

function save() {
    const data = load();
    try {
        const dir = path.dirname(RATINGS_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(RATINGS_PATH, JSON.stringify({ updatedAt: nowIso(), owners: data.owners }, null, 2), 'utf-8');
    } catch (err) {
        console.error('Failed to save benchmark ratings:', err.message);
    }
}

function getOwner(key) {
    const data = load();
    const id = ownerKey(key);
    if (!data.owners[id]) data.owners[id] = normalizeOwner({});
    return data.owners[id];
}

// --- Elo ----------------------------------------------------------------------

function expectedScore(rating, opponent) {
    return 1 / (1 + Math.pow(10, (opponent - rating) / 400));
}

function kFactor(games) {
    return Number(games) >= SETTLE_GAMES ? K_SETTLED : K_EARLY;
}

function ensureModel(owner, modelId, label) {
    if (!owner.models[modelId]) {
        owner.models[modelId] = normalizeModel({ id: modelId, label: label || modelId, rating: INITIAL_RATING });
    } else if (label) {
        owner.models[modelId].label = label;
    }
    return owner.models[modelId];
}

// Apply one decisive or tied result. Both models move by the same magnitude in
// opposite directions, so a decisive win is +delta / -delta.
function applyResult(owner, aId, aLabel, bId, bLabel, winner) {
    const a = ensureModel(owner, aId, aLabel);
    const b = ensureModel(owner, bId, bLabel);
    const scoreA = winner === 'a' ? 1 : (winner === 'tie' ? 0.5 : 0);
    const scoreB = 1 - scoreA;
    const expectedA = expectedScore(a.rating, b.rating);
    const expectedB = 1 - expectedA;
    const deltaA = round1(kFactor(a.games) * (scoreA - expectedA));
    const deltaB = round1(kFactor(b.games) * (scoreB - expectedB));

    a.rating = round1(a.rating + deltaA);
    b.rating = round1(b.rating + deltaB);
    a.peak = Math.max(a.peak, a.rating);
    b.peak = Math.max(b.peak, b.rating);
    a.games += 1;
    b.games += 1;
    if (winner === 'a') { a.wins += 1; b.losses += 1; }
    else if (winner === 'b') { b.wins += 1; a.losses += 1; }
    else { a.ties += 1; b.ties += 1; }
    a.updatedAt = nowIso();
    b.updatedAt = nowIso();

    const key = [aId, bId].sort().join('|');
    const head = owner.headToHead[key] || { a: 0, b: 0, ties: 0 };
    if (winner === 'tie') head.ties += 1;
    else if ((winner === 'a' && aId < bId) || (winner === 'b' && bId < aId)) head.a += 1;
    else head.b += 1;
    owner.headToHead[key] = head;
    owner.updatedAt = nowIso();

    return {
        a: { id: a.id, label: a.label, rating: a.rating, delta: deltaA, games: a.games },
        b: { id: b.id, label: b.label, rating: b.rating, delta: deltaB, games: b.games }
    };
}

// --- Pairing ------------------------------------------------------------------

function pairKey(left, right) {
    const ids = [left.sessionId + ':' + left.jobId, right.sessionId + ':' + right.jobId].sort();
    return ids.join('|');
}

function pairToken(left, right) {
    return left.sessionId + ':' + left.jobId + '|' + right.sessionId + ':' + right.jobId;
}

function parseToken(token) {
    const parts = String(token || '').split('|');
    if (parts.length !== 2) return null;
    const read = (part) => {
        const at = part.lastIndexOf(':');
        if (at <= 0) return null;
        return { sessionId: part.slice(0, at), jobId: part.slice(at + 1) };
    };
    const a = read(parts[0]);
    const b = read(parts[1]);
    if (!a || !b) return null;
    if (a.sessionId === b.sessionId && a.jobId === b.jobId) return null;
    return { left: a, right: b };
}

function ownerSessions(sessionId) {
    const key = String(sessionId || '');
    return store.list().filter((session) => !key || !session.sessionId || session.sessionId === key);
}

function findJob(sessionId, jobId) {
    const session = store.get(sessionId);
    if (!session) return null;
    const job = (session.jobs || []).find((entry) => entry.id === jobId);
    if (!job) return null;
    return { session, job };
}

// Every completed job that still has a renderable file, newest first.
function completedResults(sessions) {
    const results = [];
    (sessions || []).forEach((session) => {
        (session.jobs || []).forEach((job) => {
            if (job.status !== 'completed' || !job.result || !job.result.url) return;
            results.push({
                sessionId: session.id,
                jobId: job.id,
                modelId: job.modelId,
                modelLabel: job.modelLabel || job.modelId,
                prompt: String(session.prompt || ''),
                url: job.result.url,
                width: job.result.width || (job.config && job.config.width) || null,
                height: job.result.height || (job.config && job.config.height) || null,
                createdAt: job.completedAt || job.createdAt || session.createdAt || ''
            });
        });
    });
    results.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return results.slice(0, MAX_RESULTS);
}

function publicSide(result) {
    return {
        url: result.url,
        width: result.width,
        height: result.height,
        prompt: result.prompt
    };
}

function normalizedPrompt(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Same session wins (identical prompt, canvas and seed in controlled mode), then
// a matching prompt across sessions, then any two different engines.
function candidateGroups(results) {
    const same = [];
    const samePrompt = [];
    const other = [];
    for (let i = 0; i < results.length; i++) {
        for (let j = i + 1; j < results.length; j++) {
            const a = results[i];
            const b = results[j];
            if (a.modelId === b.modelId) continue;
            if (a.sessionId === b.sessionId) same.push([a, b]);
            else if (normalizedPrompt(a.prompt) === normalizedPrompt(b.prompt)) samePrompt.push([a, b]);
            else other.push([a, b]);
        }
    }
    return { same, samePrompt, other };
}

function leaderboard(owner) {
    return Object.values(owner.models)
        .filter((model) => model.games > 0)
        .sort((a, b) => b.rating - a.rating || b.wins - a.wins || a.label.localeCompare(b.label))
        .map((model, index) => ({
            rank: index + 1,
            id: model.id,
            label: model.label,
            rating: model.rating,
            peak: model.peak,
            games: model.games,
            wins: model.wins,
            losses: model.losses,
            ties: model.ties,
            winRate: model.games ? round1((model.wins + model.ties * 0.5) / model.games * 100) : 0
        }));
}

function stats(owner, results) {
    return {
        results: results.length,
        models: new Set(results.map((result) => result.modelId)).size,
        votes: owner.voteCount,
        pairs: Object.keys(owner.seen).length
    };
}

// Which engines render a fresh battle. By default that is EVERY ready engine,
// because choosing fighters by hand defeats the point: you cannot know which
// model made which image until the vote. A pinned list is still honoured for
// API callers; ids that are unknown or not ready come back reported, never
// silently dropped.
function resolveRoster(discovered, requested) {
    const list = Array.isArray(discovered) ? discovered : [];
    const byId = new Map(list.filter((model) => model && model.id).map((model) => [model.id, model]));
    const ready = list.filter((model) => model && model.available);
    const pinned = Array.isArray(requested)
        ? requested.map((id) => String(id || '').trim()).filter(Boolean)
        : [];
    const wanted = pinned.length ? pinned : ready.map((model) => model.id);
    const unique = wanted.filter((id, index) => wanted.indexOf(id) === index);
    const models = unique.filter((id) => {
        const model = byId.get(id);
        return Boolean(model && model.available);
    });
    const unavailable = unique
        .filter((id) => models.indexOf(id) === -1)
        .map((id) => {
            const model = byId.get(id);
            return {
                id,
                label: model ? (model.label || model.id) : id,
                reason: model ? (model.reason || 'not available') : 'not registered'
            };
        });
    return { models, pinned: pinned.length > 0, readyCount: ready.length, unavailable };
}

// The next blind pair, or an explanation of why there isn't one yet.
// `options.session` scopes the pool to one benchmark session, which is how a
// freshly generated battle (two fighters, one prompt) is compared.
function getBattle(sessionId, options) {
    const opts = options || {};
    const onlySession = opts.session ? String(opts.session) : null;
    const key = ownerKey(sessionId);
    const owner = getOwner(key);
    const allSessions = ownerSessions(sessionId);
    const sessions = onlySession ? allSessions.filter((session) => session.id === onlySession) : allSessions;
    const results = completedResults(sessions);
    const base = { leaderboard: leaderboard(owner), stats: stats(owner, results), sessionId: onlySession };
    if (results.length < 2) {
        return Object.assign(
            { pair: null, reason: onlySession ? 'session_not_ready' : 'not_enough_results' },
            base
        );
    }

    const groups = candidateGroups(results);
    const fresh = (pairs) => pairs.filter(([a, b]) => !owner.seen[pairKey(a, b)]);
    let repeated = false;
    let pool = fresh(groups.same);
    if (!pool.length) pool = fresh(groups.samePrompt);
    if (!pool.length) pool = fresh(groups.other);
    if (!pool.length) {
        // Every pair has been judged: keep going (a leaderboard needs repeats to
        // settle) but say so.
        repeated = true;
        pool = groups.same.length ? groups.same : (groups.samePrompt.length ? groups.samePrompt : groups.other);
    }
    if (!pool.length) {
        return Object.assign({ pair: null, reason: 'no_comparable_results' }, base);
    }
    if (owner.lastPairId && pool.length > 1) {
        const filtered = pool.filter(([a, b]) => pairKey(a, b) !== owner.lastPairId);
        if (filtered.length) pool = filtered;
    }

    const [a, b] = pool[Math.floor(Math.random() * pool.length)];
    // Randomise the sides so position never becomes a bias.
    const left = Math.random() < 0.5 ? a : b;
    const right = left === a ? b : a;
    const token = pairToken(left, right);
    owner.lastPairId = pairKey(left, right);
    save();

    return Object.assign({
        pair: {
            token,
            left: publicSide(left),
            right: publicSide(right),
            repeated
        },
        reason: null
    }, base);
}

// Cast one vote. `winner` is 'left', 'right' or 'tie'. The model identity is
// resolved from the stored job, never from the client payload.
function submitVote(sessionId, token, winner) {
    const choice = String(winner || '').toLowerCase();
    if (['left', 'right', 'tie'].indexOf(choice) === -1) {
        throw httpError(400, 'Pick a winner (left, right or tie).');
    }
    const parsed = parseToken(token);
    if (!parsed) throw httpError(400, 'This battle is no longer valid. Load a new pair.');

    const left = findJob(parsed.left.sessionId, parsed.left.jobId);
    const right = findJob(parsed.right.sessionId, parsed.right.jobId);
    if (!left || !right) throw httpError(404, 'One of these results no longer exists. Load a new pair.', { code: 'pair_stale' });
    if (left.job.status !== 'completed' || right.job.status !== 'completed') {
        throw httpError(409, 'Only completed results can be compared.', { code: 'pair_not_ready' });
    }
    if (left.job.modelId === right.job.modelId) {
        throw httpError(400, 'Both sides are the same model. Load a new pair.', { code: 'pair_same_model' });
    }

    const key = ownerKey(sessionId);
    const owner = getOwner(key);
    const outcome = choice === 'left' ? 'a' : (choice === 'right' ? 'b' : 'tie');
    const deltas = applyResult(
        owner,
        left.job.modelId, left.job.modelLabel || left.job.modelId,
        right.job.modelId, right.job.modelLabel || right.job.modelId,
        outcome
    );

    const seenKey = pairKey(
        { sessionId: parsed.left.sessionId, jobId: parsed.left.jobId },
        { sessionId: parsed.right.sessionId, jobId: parsed.right.jobId }
    );
    owner.seen[seenKey] = choice;
    owner.voteCount += 1;
    const seenKeys = Object.keys(owner.seen);
    if (seenKeys.length > MAX_SEEN) {
        seenKeys.slice(0, seenKeys.length - MAX_SEEN).forEach((entry) => { delete owner.seen[entry]; });
    }
    owner.lastPairId = seenKey;
    save();

    const results = completedResults(ownerSessions(sessionId));
    return {
        vote: { winner: choice, leftJobs: parsed.left, rightJobs: parsed.right },
        result: { left: deltas.a, right: deltas.b },
        leaderboard: leaderboard(owner),
        stats: stats(owner, results)
    };
}

// The full cast of one generated battle, WITH model names. This is the payoff
// screen: it is only requested once every pair from the set has been judged, so
// knowing which image came from which engine can no longer bias a vote.
function getLineup(sessionId, options) {
    const opts = options || {};
    const onlySession = String(opts.session || '');
    if (!onlySession) return { sessionId: null, prompt: '', lineup: [] };
    const session = ownerSessions(sessionId).find((entry) => entry.id === onlySession);
    if (!session) throw httpError(404, 'Battle session not found.');
    const owner = getOwner(ownerKey(sessionId));
    const lineup = completedResults([session]).map((result) => {
        const rating = owner.models[result.modelId] || null;
        return {
            jobId: result.jobId,
            modelId: result.modelId,
            modelLabel: result.modelLabel,
            url: result.url,
            width: result.width,
            height: result.height,
            rating: rating ? rating.rating : INITIAL_RATING,
            games: rating ? rating.games : 0,
            wins: rating ? rating.wins : 0,
            losses: rating ? rating.losses : 0,
            ties: rating ? rating.ties : 0
        };
    });
    lineup.sort((a, b) => b.rating - a.rating || a.modelLabel.localeCompare(b.modelLabel));
    return {
        sessionId: session.id,
        prompt: session.prompt || '',
        createdAt: session.createdAt || null,
        completed: lineup.length,
        total: (session.jobs || []).length,
        lineup
    };
}

function resetBattle(sessionId) {
    const data = load();
    const key = ownerKey(sessionId);
    delete data.owners[key];
    save();
    return {
        ok: true,
        leaderboard: [],
        stats: { results: completedResults(ownerSessions(sessionId)).length, models: 0, votes: 0 }
    };
}

module.exports = {
    RATINGS_PATH,
    INITIAL_RATING,
    PROMPTS,
    randomPrompt,
    resolveRoster,
    getBattle,
    submitVote,
    getLineup,
    resetBattle,
    // exported for tests
    applyResult,
    expectedScore,
    kFactor,
    pairKey,
    parseToken,
    leaderboard,
    completedResults,
    candidateGroups,
    _reset: () => { cache = null; }
};
