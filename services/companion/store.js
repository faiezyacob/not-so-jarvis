/* ============================================
   JARVIS — Companion memory store
   Whole-file JSON persistence (data/companion.json)
   keyed by characterId so two characters never share
   memory. Holds per-character companion settings, the
   fictional character state, and episodic/semantic
   memory records with provenance, pinning and
   supersede handling.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const text = require('./text');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
// Explicit path keeps tests hermetic (they never touch data/).
const COMPANION_PATH = process.env.COMPANION_PATH || path.join(DATA_DIR, 'companion.json');

const MEMORY_TYPES = ['episodic', 'semantic'];
const CONFIDENCE = ['stated', 'inferred'];

const DEFAULT_SETTINGS = {
    enabled: true,
    personality: '',
    traits: [],
    communicationStyle: '',
    humor: '',
    habits: [],
    interests: [],
    preferences: [],
    background: '',
    goals: [],
    relationship: '',
    voice: '',
    // Per-character overrides; undefined inherits the global Settings > Companion value.
    memoryEnabled: null,
    autoMemory: null,
    lifeProgression: null,
    initiative: null,
    photoSharing: null
};

const INITIATIVE_MODES = ['passive', 'conversational', 'scheduled'];
const PHOTO_SHARING_MODES = ['ask', 'auto', 'off'];

const DEFAULT_STATE = {
    goals: [],
    activities: [],
    relationships: [],
    events: [],
    notes: '',
    updatedAt: null
};

const LIMITS = {
    SETTING_TEXT: 800,
    SETTING_LIST: 24,
    SETTING_ITEM: 160,
    MEMORY_TEXT: 1200,
    MEMORY_SUMMARY: 240,
    MEMORY_CATEGORY: 60,
    MEMORY_TAGS: 12,
    MEMORY_TAG: 40,
    STATE_LIST: 40,
    STATE_ITEM: 240,
    STATE_EVENTS: 60
};

let store = null;

function nowIso() {
    return new Date().toISOString();
}

function makeId(prefix) {
    return (prefix || 'mem') + '_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

function loadStore() {
    if (store) return store;
    try {
        const raw = fs.readFileSync(COMPANION_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        store = {
            updatedAt: parsed && parsed.updatedAt ? parsed.updatedAt : null,
            characters: parsed && parsed.characters && typeof parsed.characters === 'object' ? parsed.characters : {}
        };
    } catch {
        store = { updatedAt: null, characters: {} };
    }
    // Normalize every record defensively so a malformed file can never crash a turn.
    Object.keys(store.characters).forEach((key) => {
        store.characters[key] = normalizeRecord(store.characters[key], key);
    });
    return store;
}

function saveStore() {
    if (!store) return;
    store.updatedAt = nowIso();
    try {
        const dir = path.dirname(COMPANION_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(COMPANION_PATH, JSON.stringify(store, null, 2), 'utf-8');
    } catch (err) {
        console.error('Failed to save companion store:', err.message);
    }
}

function cleanText(value, max) {
    const s = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
    return s.slice(0, max || LIMITS.SETTING_TEXT);
}

function cleanList(value, maxItems, maxItem) {
    const list = Array.isArray(value) ? value : (value === undefined || value === null || value === '' ? [] : [value]);
    const out = [];
    for (const item of list) {
        const s = cleanText(item, maxItem || LIMITS.SETTING_ITEM);
        if (!s) continue;
        if (out.some((existing) => existing.toLowerCase() === s.toLowerCase())) continue;
        out.push(s);
        if (out.length >= (maxItems || LIMITS.SETTING_LIST)) break;
    }
    return out;
}

function cleanBoolOrNull(value) {
    if (value === true || value === false) return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
}

function cleanEnumOrNull(value, allowed) {
    const v = String(value === undefined || value === null ? '' : value).toLowerCase().trim();
    return allowed.indexOf(v) !== -1 ? v : null;
}

function sanitizeSettings(value) {
    const src = value && typeof value === 'object' ? value : {};
    const out = {};
    out.enabled = src.enabled === false ? false : true;
    out.personality = cleanText(src.personality, LIMITS.SETTING_TEXT);
    out.traits = cleanList(src.traits);
    out.communicationStyle = cleanText(src.communicationStyle, LIMITS.SETTING_TEXT);
    out.humor = cleanText(src.humor, LIMITS.SETTING_TEXT);
    out.habits = cleanList(src.habits);
    out.interests = cleanList(src.interests);
    out.preferences = cleanList(src.preferences);
    out.background = cleanText(src.background, LIMITS.SETTING_TEXT);
    out.goals = cleanList(src.goals);
    out.relationship = cleanText(src.relationship, LIMITS.SETTING_TEXT);
    out.voice = cleanText(src.voice, LIMITS.SETTING_TEXT);
    out.memoryEnabled = cleanBoolOrNull(src.memoryEnabled);
    out.autoMemory = cleanBoolOrNull(src.autoMemory);
    out.lifeProgression = cleanBoolOrNull(src.lifeProgression);
    out.initiative = cleanEnumOrNull(src.initiative, INITIATIVE_MODES);
    out.photoSharing = cleanEnumOrNull(src.photoSharing, PHOTO_SHARING_MODES);
    return out;
}

function cleanRelationship(value) {
    const src = value && typeof value === 'object' ? value : {};
    const name = cleanText(src.name, LIMITS.SETTING_ITEM);
    const description = cleanText(src.description, LIMITS.STATE_ITEM);
    if (!name && !description) return null;
    return { name, description };
}

function sanitizeState(value) {
    const src = value && typeof value === 'object' ? value : {};
    const out = {
        goals: cleanList(src.goals, LIMITS.STATE_LIST, LIMITS.STATE_ITEM),
        activities: cleanList(src.activities, LIMITS.STATE_LIST, LIMITS.STATE_ITEM),
        notes: cleanText(src.notes, LIMITS.STATE_ITEM),
        updatedAt: src.updatedAt || null
    };
    out.relationships = [];
    if (Array.isArray(src.relationships)) {
        for (const rel of src.relationships) {
            const clean = cleanRelationship(rel);
            if (clean && !out.relationships.some((r) => r.name.toLowerCase() === clean.name.toLowerCase())) {
                out.relationships.push(clean);
            }
            if (out.relationships.length >= LIMITS.STATE_LIST) break;
        }
    }
    out.events = [];
    if (Array.isArray(src.events)) {
        for (const ev of src.events) {
            const entry = ev && typeof ev === 'object' ? ev : { text: ev };
            const entryText = cleanText(entry.text, LIMITS.STATE_ITEM);
            if (!entryText) continue;
            out.events.push({ text: entryText, at: entry.at || null });
            if (out.events.length >= LIMITS.STATE_EVENTS) break;
        }
    }
    return out;
}

function sanitizeMemory(value, characterId) {
    const src = value && typeof value === 'object' ? value : {};
    const type = MEMORY_TYPES.indexOf(src.type) !== -1 ? src.type : 'semantic';
    const body = cleanText(src.text, LIMITS.MEMORY_TEXT);
    if (!body) return null;
    const confidence = CONFIDENCE.indexOf(src.confidence) !== -1 ? src.confidence : 'stated';
    const importanceRaw = Number(src.importance);
    const importance = Number.isFinite(importanceRaw)
        ? Math.max(1, Math.min(5, Math.round(importanceRaw)))
        : 3;
    return {
        id: String(src.id || makeId(type === 'episodic' ? 'epi' : 'sem')),
        characterId: String(characterId),
        type,
        category: cleanText(src.category, LIMITS.MEMORY_CATEGORY) || 'general',
        text: body,
        summary: cleanText(src.summary, LIMITS.MEMORY_SUMMARY),
        importance,
        confidence,
        tags: cleanList(src.tags, LIMITS.MEMORY_TAGS, LIMITS.MEMORY_TAG),
        sourceConversationId: src.sourceConversationId ? String(src.sourceConversationId) : null,
        sourceMessageId: src.sourceMessageId ? String(src.sourceMessageId) : null,
        pinned: src.pinned === true,
        status: src.status === 'superseded' ? 'superseded' : 'active',
        supersedes: Array.isArray(src.supersedes) ? src.supersedes.map(String).slice(0, 8) : [],
        supersededBy: src.supersededBy ? String(src.supersededBy) : null,
        createdAt: src.createdAt || nowIso(),
        updatedAt: src.updatedAt || src.createdAt || nowIso(),
        lastAccessedAt: src.lastAccessedAt || null,
        accessCount: Number.isFinite(Number(src.accessCount)) ? Math.max(0, Math.floor(Number(src.accessCount))) : 0
    };
}

function normalizeRecord(value, characterId) {
    const src = value && typeof value === 'object' ? value : {};
    const memories = [];
    if (Array.isArray(src.memories)) {
        for (const raw of src.memories) {
            const memory = sanitizeMemory(raw, characterId);
            if (memory) memories.push(memory);
        }
    }
    return {
        settings: sanitizeSettings(src.settings),
        state: sanitizeState(src.state),
        memories,
        meta: {
            lastExtractionAt: src.meta && src.meta.lastExtractionAt ? src.meta.lastExtractionAt : null,
            createdAt: src.meta && src.meta.createdAt ? src.meta.createdAt : nowIso(),
            updatedAt: src.meta && src.meta.updatedAt ? src.meta.updatedAt : nowIso()
        }
    };
}

function ensureRecord(characterId) {
    const key = String(characterId || '').trim();
    if (!key) return null;
    const data = loadStore();
    if (!data.characters[key]) {
        data.characters[key] = normalizeRecord({}, key);
        saveStore();
    }
    return data.characters[key];
}

function getRecord(characterId) {
    const key = String(characterId || '').trim();
    if (!key) return null;
    const data = loadStore();
    return data.characters[key] || null;
}

function deleteRecord(characterId) {
    const key = String(characterId || '').trim();
    if (!key) return false;
    const data = loadStore();
    if (!data.characters[key]) return false;
    delete data.characters[key];
    saveStore();
    return true;
}

// --- Settings ---

function getSettings(characterId) {
    const record = ensureRecord(characterId);
    if (!record) return null;
    return JSON.parse(JSON.stringify(record.settings));
}

function setSettings(characterId, patch) {
    const record = ensureRecord(characterId);
    if (!record) return null;
    record.settings = sanitizeSettings(Object.assign({}, record.settings, patch || {}));
    record.meta.updatedAt = nowIso();
    saveStore();
    return JSON.parse(JSON.stringify(record.settings));
}

// --- Character state (fictional life) ---

function getState(characterId) {
    const record = ensureRecord(characterId);
    if (!record) return null;
    return JSON.parse(JSON.stringify(record.state));
}

function setState(characterId, patch) {
    const record = ensureRecord(characterId);
    if (!record) return null;
    const merged = Object.assign({}, record.state, patch || {});
    // Full-replacement semantics: undefined/empty overwrites. Only assign keys
    // actually present so an absent patch field is not treated as a clear.
    Object.keys(patch || {}).forEach((key) => {
        merged[key] = patch[key];
    });
    record.state = sanitizeState(merged);
    record.state.updatedAt = nowIso();
    record.meta.updatedAt = nowIso();
    saveStore();
    return JSON.parse(JSON.stringify(record.state));
}

// --- Memory CRUD ---

function listMemories(characterId, filter) {
    const record = getRecord(characterId);
    if (!record) return [];
    const opts = filter || {};
    let list = record.memories.slice();
    if (opts.type) list = list.filter((m) => m.type === opts.type);
    if (opts.category) list = list.filter((m) => m.category === opts.category);
    if (opts.status && opts.status !== 'all') list = list.filter((m) => m.status === opts.status);
    else if (!opts.status) list = list.filter((m) => m.status === 'active');
    if (opts.pinned === true) list = list.filter((m) => m.pinned);
    if (opts.query) {
        const q = text.tokenSet(opts.query);
        if (q.size) {
            list = list.filter((m) => text.similarity(q, text.tokenSet(m.text + ' ' + m.summary + ' ' + m.category + ' ' + m.tags.join(' '))) > 0);
        }
    }
    list.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return String(b.updatedAt).localeCompare(String(a.updatedAt));
    });
    const limit = Number(opts.limit);
    if (Number.isFinite(limit) && limit > 0) list = list.slice(0, limit);
    return list;
}

function getMemory(characterId, id) {
    const record = getRecord(characterId);
    if (!record) return null;
    return record.memories.find((m) => m.id === String(id)) || null;
}

function addMemory(characterId, value) {
    const record = ensureRecord(characterId);
    if (!record) return null;
    const memory = sanitizeMemory(value, characterId);
    if (!memory) return null;
    record.memories.push(memory);
    record.meta.updatedAt = nowIso();
    saveStore();
    return memory;
}

function updateMemory(characterId, id, patch) {
    const record = getRecord(characterId);
    if (!record) return null;
    const memory = record.memories.find((m) => m.id === String(id));
    if (!memory) return null;
    const merged = Object.assign({}, memory, patch || {}, { id: memory.id, characterId: memory.characterId });
    const clean = sanitizeMemory(merged, characterId);
    if (!clean) return null;
    Object.assign(memory, clean, { updatedAt: nowIso() });
    record.meta.updatedAt = nowIso();
    saveStore();
    return memory;
}

function removeMemory(characterId, id) {
    const record = getRecord(characterId);
    if (!record) return false;
    const before = record.memories.length;
    record.memories = record.memories.filter((m) => m.id !== String(id));
    if (record.memories.length === before) return false;
    record.meta.updatedAt = nowIso();
    saveStore();
    return true;
}

function clearMemories(characterId) {
    const record = getRecord(characterId);
    if (!record) return false;
    record.memories = [];
    record.meta.updatedAt = nowIso();
    saveStore();
    return true;
}

// Mark `id` superseded by an existing `byId` memory (provenance preserved).
function supersedeMemory(characterId, id, byId) {
    const record = getRecord(characterId);
    if (!record) return null;
    const old = record.memories.find((m) => m.id === String(id));
    if (!old) return null;
    old.status = 'superseded';
    old.supersededBy = byId ? String(byId) : old.supersededBy;
    old.updatedAt = nowIso();
    if (byId) {
        const replacement = record.memories.find((m) => m.id === String(byId));
        if (replacement && !replacement.supersedes.includes(old.id)) {
            replacement.supersedes.push(old.id);
        }
    }
    record.meta.updatedAt = nowIso();
    saveStore();
    return old;
}

// Find the highest-overlap active memory of a type above the threshold. Used by
// memory formation to dedupe/supersede instead of piling up near-duplicates.
function findSimilar(characterId, value, options) {
    const opts = options || {};
    const type = opts.type || null;
    const threshold = Number.isFinite(Number(opts.threshold)) ? Number(opts.threshold) : 0.72;
    const record = getRecord(characterId);
    if (!record) return null;
    let best = null;
    let bestScore = 0;
    for (const memory of record.memories) {
        if (memory.status !== 'active') continue;
        if (memory.pinned) continue;
        if (type && memory.type !== type) continue;
        const score = text.similarity(value, memory.text);
        if (score > bestScore) {
            bestScore = score;
            best = memory;
        }
    }
    return bestScore >= threshold ? { memory: best, score: bestScore } : null;
}

function markAccessed(characterId, ids) {
    const record = getRecord(characterId);
    if (!record) return;
    const wanted = new Set((ids || []).map(String));
    let changed = false;
    for (const memory of record.memories) {
        if (wanted.has(memory.id)) {
            memory.lastAccessedAt = nowIso();
            memory.accessCount += 1;
            changed = true;
        }
    }
    if (changed) {
        record.meta.updatedAt = nowIso();
        saveStore();
    }
}

// Drop superseded records and (optionally) age out low-value unpinned memories
// so storage and prompt size stay bounded. Pinned and high-importance memories
// are never pruned.
function enforceRetention(characterId, options) {
    const record = getRecord(characterId);
    if (!record) return 0;
    const opts = options || {};
    const max = Number.isFinite(Number(opts.maxMemoriesPerCharacter)) && Number(opts.maxMemoriesPerCharacter) > 0
        ? Math.floor(Number(opts.maxMemoriesPerCharacter))
        : 500;
    const retentionDays = Number(opts.retentionDays) > 0 ? Number(opts.retentionDays) : 0;
    const before = record.memories.length;

    if (retentionDays > 0) {
        const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        record.memories = record.memories.filter((m) => {
            if (m.pinned || m.importance >= 4) return true;
            const stamp = Date.parse(m.lastAccessedAt || m.updatedAt || m.createdAt);
            return !Number.isFinite(stamp) || stamp >= cutoff;
        });
    }

    if (record.memories.length > max) {
        // Remove superseded records first (provenance is only useful while the
        // replacement lives), then the lowest-value unpinned active memories.
        const rank = (m) => {
            if (m.pinned) return 3;
            if (m.status === 'superseded') return 0;
            if (m.importance >= 4) return 2;
            return 1;
        };
        const ordered = record.memories.slice().sort((a, b) => {
            const ra = rank(a);
            const rb = rank(b);
            if (ra !== rb) return ra - rb;
            return String(a.updatedAt).localeCompare(String(b.updatedAt));
        });
        const dropCount = record.memories.length - max;
        const dropIds = new Set(ordered.slice(0, dropCount).map((m) => m.id));
        record.memories = record.memories.filter((m) => !dropIds.has(m.id));
    }

    const removed = before - record.memories.length;
    if (removed > 0) {
        record.meta.updatedAt = nowIso();
        saveStore();
    }
    return removed;
}

function getStats(characterId) {
    const record = getRecord(characterId);
    if (!record) return { total: 0, episodic: 0, semantic: 0, pinned: 0, superseded: 0, lastExtractionAt: null };
    const memories = record.memories;
    return {
        total: memories.length,
        episodic: memories.filter((m) => m.type === 'episodic').length,
        semantic: memories.filter((m) => m.type === 'semantic').length,
        pinned: memories.filter((m) => m.pinned).length,
        superseded: memories.filter((m) => m.status === 'superseded').length,
        lastExtractionAt: record.meta.lastExtractionAt
    };
}

function setLastExtractionAt(characterId, value) {
    const record = getRecord(characterId);
    if (!record) return null;
    record.meta.lastExtractionAt = value || nowIso();
    saveStore();
    return record.meta.lastExtractionAt;
}

// Test seam: force a reload from disk.
function _reset() {
    store = null;
}

module.exports = {
    COMPANION_PATH,
    MEMORY_TYPES,
    DEFAULT_SETTINGS,
    DEFAULT_STATE,
    INITIATIVE_MODES,
    PHOTO_SHARING_MODES,
    LIMITS,
    sanitizeSettings,
    sanitizeState,
    sanitizeMemory,
    getRecord,
    ensureRecord,
    deleteRecord,
    getSettings,
    setSettings,
    getState,
    setState,
    listMemories,
    getMemory,
    addMemory,
    updateMemory,
    removeMemory,
    clearMemories,
    supersedeMemory,
    findSimilar,
    markAccessed,
    enforceRetention,
    getStats,
    setLastExtractionAt,
    _reset
};
