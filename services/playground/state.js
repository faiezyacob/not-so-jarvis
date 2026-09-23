/* ============================================
   JARVIS — Creative Playground State
   Per-conversation active concept sessions plus a
   small saved-concept library, persisted to disk so
   "try another one" and the concept card survive
   reloads and server restarts.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
// An explicit path keeps the tests hermetic (they never touch data/).
const STORE_PATH = process.env.PLAYGROUND_STATE_PATH || path.join(DATA_DIR, 'playground-state.json');

let store = null;

function loadStore() {
    if (store) return store;
    try {
        const raw = fs.readFileSync(STORE_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        store = {
            sessions: (parsed && typeof parsed.sessions === 'object' && parsed.sessions) || {},
            saved: Array.isArray(parsed && parsed.saved) ? parsed.saved : []
        };
    } catch (err) {
        store = { sessions: {}, saved: [] };
    }
    return store;
}

function saveStore() {
    const parent = path.dirname(STORE_PATH);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    const data = loadStore();
    fs.writeFileSync(STORE_PATH, JSON.stringify({
        updatedAt: new Date().toISOString(),
        sessions: data.sessions,
        saved: data.saved
    }, null, 2), 'utf-8');
}

function getSession(conversationId) {
    if (!conversationId) return null;
    return loadStore().sessions[String(conversationId)] || null;
}

function setSession(conversationId, session) {
    if (!conversationId) return null;
    const data = loadStore();
    data.sessions[String(conversationId)] = session;
    saveStore();
    return session;
}

function removeSession(conversationId) {
    if (!conversationId) return false;
    const data = loadStore();
    const key = String(conversationId);
    if (!data.sessions[key]) return false;
    delete data.sessions[key];
    saveStore();
    return true;
}

function listSaved() {
    return loadStore().saved.slice();
}

function addSaved(record) {
    const data = loadStore();
    data.saved.unshift(record);
    if (data.saved.length > 200) data.saved.length = 200;
    saveStore();
    return record;
}

function removeSaved(id) {
    const data = loadStore();
    const key = String(id || '');
    const index = data.saved.findIndex((c) => c.id === key);
    if (index === -1) return false;
    data.saved.splice(index, 1);
    saveStore();
    return true;
}

function listScenes() {
    return loadStore().saved.slice().map((record) => record.scene || record.concept).filter(Boolean);
}

function getComposition(id) {
    const session = Object.values(loadStore().sessions).find((item) => item && item.id === String(id));
    if (session) return session.composition || session;
    return loadStore().saved.find((item) => item && item.id === String(id)) || null;
}

module.exports = {
    getSession,
    setSession,
    removeSession,
    listSaved,
    addSaved,
    removeSaved,
    listScenes,
    getComposition
};
