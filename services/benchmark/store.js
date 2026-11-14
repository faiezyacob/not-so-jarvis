/* ============================================
   JARVIS — Image Arena persistence
   Benchmark sessions and their per-model jobs are
   small metadata records (image files stay in
   data/generated). They live in one local JSON file
   so history survives a reload and a server restart.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
// Tests point this at a temp file so data/ is never touched.
const STORE_PATH = process.env.BENCHMARK_PATH || path.join(DATA_DIR, 'benchmark-sessions.json');

let cache = null;

function emptyStore() {
    return { sessions: [] };
}

function normalizeStore(parsed) {
    const sessions = parsed && Array.isArray(parsed.sessions) ? parsed.sessions : [];
    return { sessions: sessions.filter((s) => s && typeof s === 'object' && s.id) };
}

function load() {
    if (cache) return cache;
    try {
        const raw = fs.readFileSync(STORE_PATH, 'utf-8');
        cache = normalizeStore(JSON.parse(raw));
    } catch (err) {
        cache = emptyStore();
    }
    return cache;
}

function save() {
    const data = load();
    const parent = path.dirname(STORE_PATH);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify({
        updatedAt: new Date().toISOString(),
        sessions: data.sessions
    }, null, 2), 'utf-8');
}

// Newest first. The returned records are references to the in-memory store;
// callers persist through upsert() after mutating them.
function list() {
    return load().sessions;
}

function get(id) {
    if (!id) return null;
    return load().sessions.find((session) => session.id === String(id)) || null;
}

function upsert(session) {
    if (!session || !session.id) return null;
    const data = load();
    const index = data.sessions.findIndex((entry) => entry.id === session.id);
    if (index === -1) data.sessions.unshift(session);
    else data.sessions[index] = session;
    save();
    return session;
}

function remove(id) {
    const data = load();
    const index = data.sessions.findIndex((entry) => entry.id === String(id));
    if (index === -1) return null;
    const [removed] = data.sessions.splice(index, 1);
    save();
    return removed;
}

module.exports = {
    STORE_PATH,
    load,
    save,
    list,
    get,
    upsert,
    remove,
    // Test hook: drop the in-memory cache so the next read comes from disk.
    reset: () => { cache = null; }
};
