/* ============================================
   JARVIS — Character Life store
   Whole-file JSON persistence (data/character-life.json)
   keyed by characterId so two characters never share
   fictional life state. Holds the current life state,
   a bounded recent-activity history, the generated
   scene history used for image continuity, and the
   pending photo offers used by the acceptance flow.

   Fictional life state is deliberately separate from
   the companion memory store (data/companion.json):
   memories are facts about the real user, life state
   is fiction about the character.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
// Explicit path keeps tests hermetic (they never touch data/).
const LIFE_PATH = process.env.CHARACTER_LIFE_PATH || path.join(DATA_DIR, 'character-life.json');

const PROVENANCE = ['none', 'user', 'llm', 'scheduled'];

const LIMITS = {
    FIELD: 400,
    RECENT: 12,
    SCENES: 30,
    OFFERS: 12,
    SUMMARY: 600
};

let store = null;

function nowIso() {
    return new Date().toISOString();
}

function makeId(prefix) {
    return (prefix || 'scene') + '_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

function cleanText(value, max) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max || LIMITS.FIELD);
}

function loadStore() {
    if (store) return store;
    try {
        const raw = fs.readFileSync(LIFE_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        store = {
            updatedAt: parsed && parsed.updatedAt ? parsed.updatedAt : null,
            characters: parsed && parsed.characters && typeof parsed.characters === 'object' ? parsed.characters : {}
        };
    } catch {
        store = { updatedAt: null, characters: {} };
    }
    Object.keys(store.characters).forEach((key) => {
        store.characters[key] = normalizeRecord(store.characters[key]);
    });
    return store;
}

function saveStore() {
    if (!store) return;
    store.updatedAt = nowIso();
    try {
        const dir = path.dirname(LIFE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(LIFE_PATH, JSON.stringify(store, null, 2), 'utf-8');
    } catch (err) {
        console.error('Failed to save character life store:', err.message);
    }
}

function sanitizeLife(value) {
    const src = value && typeof value === 'object' ? value : {};
    const provenance = PROVENANCE.indexOf(src.provenance) !== -1 ? src.provenance : 'none';
    return {
        activity: cleanText(src.activity, LIMITS.FIELD),
        location: cleanText(src.location, LIMITS.FIELD),
        outfit: cleanText(src.outfit, LIMITS.FIELD),
        context: cleanText(src.context, LIMITS.FIELD),
        mood: cleanText(src.mood, LIMITS.FIELD),
        tone: cleanText(src.tone, LIMITS.FIELD),
        planned: cleanText(src.planned, LIMITS.FIELD),
        provenance,
        updatedAt: src.updatedAt || null
    };
}

function sanitizeActivityEntry(value) {
    const src = value && typeof value === 'object' ? value : { activity: value };
    const activity = cleanText(src.activity, LIMITS.FIELD);
    if (!activity) return null;
    return {
        activity,
        location: cleanText(src.location, LIMITS.FIELD),
        at: src.at || nowIso()
    };
}

function sanitizeScene(value) {
    const src = value && typeof value === 'object' ? value : {};
    const summary = cleanText(src.summary, LIMITS.SUMMARY);
    if (!summary && !src.file) return null;
    return {
        id: String(src.id || makeId('scene')),
        intent: cleanText(src.intent, 40) || 'selfie',
        cameraView: cleanText(src.cameraView, 20) || 'front',
        subject: cleanText(src.subject, LIMITS.FIELD),
        activity: cleanText(src.activity, LIMITS.FIELD),
        location: cleanText(src.location, LIMITS.FIELD),
        outfit: cleanText(src.outfit, LIMITS.FIELD),
        summary,
        file: cleanText(src.file, 300),
        url: cleanText(src.url, 400),
        at: src.at || nowIso()
    };
}

function sanitizeOffer(value) {
    const src = value && typeof value === 'object' ? value : {};
    const intent = cleanText(src.intent, 40);
    if (!intent) return null;
    return {
        intent,
        subject: cleanText(src.subject, LIMITS.FIELD),
        auto: src.auto === true,
        at: src.at || nowIso()
    };
}

function normalizeRecord(value) {
    const src = value && typeof value === 'object' ? value : {};
    const recentActivities = [];
    if (Array.isArray(src.recentActivities)) {
        for (const raw of src.recentActivities) {
            const entry = sanitizeActivityEntry(raw);
            if (entry) recentActivities.push(entry);
        }
    }
    const sceneHistory = [];
    if (Array.isArray(src.sceneHistory)) {
        for (const raw of src.sceneHistory) {
            const scene = sanitizeScene(raw);
            if (scene) sceneHistory.push(scene);
        }
    }
    const pendingOffers = {};
    if (src.pendingOffers && typeof src.pendingOffers === 'object') {
        Object.keys(src.pendingOffers).forEach((key) => {
            const offer = sanitizeOffer(src.pendingOffers[key]);
            if (offer) pendingOffers[String(key)] = offer;
        });
    }
    return {
        life: sanitizeLife(src.life),
        recentActivities: recentActivities.slice(-LIMITS.RECENT),
        sceneHistory: sceneHistory.slice(-LIMITS.SCENES),
        pendingOffers,
        lastEvolutionAt: src.lastEvolutionAt || null,
        createdAt: src.createdAt || nowIso(),
        updatedAt: src.updatedAt || nowIso()
    };
}

function ensureRecord(characterId) {
    const key = String(characterId || '').trim();
    if (!key) return null;
    const data = loadStore();
    if (!data.characters[key]) {
        data.characters[key] = normalizeRecord({});
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

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

// --- Life state ---

function getLife(characterId) {
    const record = ensureRecord(characterId);
    if (!record) return null;
    return clone(record.life);
}

function setLife(characterId, patch, provenance) {
    const record = ensureRecord(characterId);
    if (!record) return null;
    const merged = Object.assign({}, record.life, patch || {});
    if (provenance) merged.provenance = provenance;
    merged.updatedAt = nowIso();
    record.life = sanitizeLife(merged);
    record.updatedAt = nowIso();
    saveStore();
    return clone(record.life);
}

// --- Recent activities ---

function getRecentActivities(characterId, limit) {
    const record = getRecord(characterId);
    if (!record) return [];
    const list = record.recentActivities.slice();
    const n = Number(limit);
    return Number.isFinite(n) && n > 0 ? list.slice(-n) : list;
}

function pushRecentActivity(characterId, entry) {
    const record = ensureRecord(characterId);
    if (!record) return null;
    const clean = sanitizeActivityEntry(entry);
    if (!clean) return null;
    // Never repeat the immediately previous identical activity.
    const last = record.recentActivities[record.recentActivities.length - 1];
    if (last && last.activity.toLowerCase() === clean.activity.toLowerCase()) return clean;
    record.recentActivities.push(clean);
    if (record.recentActivities.length > LIMITS.RECENT) {
        record.recentActivities = record.recentActivities.slice(-LIMITS.RECENT);
    }
    record.updatedAt = nowIso();
    saveStore();
    return clean;
}

// --- Scene history ---

function getSceneHistory(characterId, limit) {
    const record = getRecord(characterId);
    if (!record) return [];
    const list = record.sceneHistory.slice();
    const n = Number(limit);
    return Number.isFinite(n) && n > 0 ? list.slice(-n) : list;
}

function currentScene(characterId) {
    const list = getSceneHistory(characterId, 1);
    return list.length ? list[list.length - 1] : null;
}

function addSceneEntry(characterId, entry) {
    const record = ensureRecord(characterId);
    if (!record) return null;
    const clean = sanitizeScene(entry);
    if (!clean) return null;
    record.sceneHistory.push(clean);
    if (record.sceneHistory.length > LIMITS.SCENES) {
        record.sceneHistory = record.sceneHistory.slice(-LIMITS.SCENES);
    }
    record.updatedAt = nowIso();
    saveStore();
    return clean;
}

function clearSceneHistory(characterId) {
    const record = getRecord(characterId);
    if (!record) return false;
    record.sceneHistory = [];
    record.updatedAt = nowIso();
    saveStore();
    return true;
}

// --- Pending photo offers ---

function getPendingOffer(characterId, conversationId) {
    const record = getRecord(characterId);
    if (!record || !conversationId) return null;
    const offer = record.pendingOffers[String(conversationId)];
    return offer ? clone(offer) : null;
}

function setPendingOffer(characterId, conversationId, offer) {
    const record = ensureRecord(characterId);
    if (!record || !conversationId) return null;
    const clean = sanitizeOffer(offer);
    if (!clean) return null;
    record.pendingOffers[String(conversationId)] = clean;
    const keys = Object.keys(record.pendingOffers);
    if (keys.length > LIMITS.OFFERS) {
        // Drop the oldest offers (object insertion order is chronological).
        keys.slice(0, keys.length - LIMITS.OFFERS).forEach((key) => { delete record.pendingOffers[key]; });
    }
    record.updatedAt = nowIso();
    saveStore();
    return clone(clean);
}

function clearPendingOffer(characterId, conversationId) {
    const record = getRecord(characterId);
    if (!record || !conversationId) return false;
    if (!record.pendingOffers[String(conversationId)]) return false;
    delete record.pendingOffers[String(conversationId)];
    record.updatedAt = nowIso();
    saveStore();
    return true;
}

function setLastEvolutionAt(characterId, value) {
    const record = ensureRecord(characterId);
    if (!record) return null;
    record.lastEvolutionAt = value || nowIso();
    record.updatedAt = nowIso();
    saveStore();
    return record.lastEvolutionAt;
}

function _reset() {
    store = null;
}

module.exports = {
    LIFE_PATH,
    PROVENANCE,
    LIMITS,
    sanitizeLife,
    sanitizeScene,
    sanitizeOffer,
    normalizeRecord,
    getRecord,
    ensureRecord,
    deleteRecord,
    getLife,
    setLife,
    getRecentActivities,
    pushRecentActivity,
    getSceneHistory,
    currentScene,
    addSceneEntry,
    clearSceneHistory,
    getPendingOffer,
    setPendingOffer,
    clearPendingOffer,
    setLastEvolutionAt,
    _reset
};
