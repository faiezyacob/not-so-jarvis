/* ============================================
   JARVIS — Activity Log
   Small persisted ring buffer of notable
   events (generations, edits, upscales, model
   unloads, server lifecycle) so the dashboard
   ACTIVITY widget can show what JARVIS has been
   doing. Only the most recent entries are kept
   (and written to data/activity-log.json).
   ============================================ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOG_PATH = path.join(DATA_DIR, 'activity-log.json');
const MAX_ENTRIES = 100;

const VALID_TYPES = ['image', 'video', 'edit', 'upscale', 'unload', 'system'];

let entries = null;   // newest first
let loadedOnce = false;

function loadEntries() {
    try {
        const raw = fs.readFileSync(LOG_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.entries)) return parsed.entries;
    } catch (err) {
        // Missing or corrupt file — start empty.
    }
    return [];
}

function saveEntries() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        const payload = { updatedAt: new Date().toISOString(), entries };
        fs.writeFileSync(LOG_PATH, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (err) {
        console.warn('[activity-log] Could not persist activity:', err.message);
    }
}

function ensureLoaded() {
    if (loadedOnce) return;
    loadedOnce = true;
    entries = loadEntries().slice(0, MAX_ENTRIES);
}

function makeId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

// Record one activity entry. Unknown/blank titles are ignored; the log must
// never throw into a generation path, so persistence is best-effort.
function record(input) {
    const data = input || {};
    const title = String(data.title || '').trim();
    if (!title) return null;
    ensureLoaded();

    const type = VALID_TYPES.indexOf(data.type) !== -1 ? data.type : 'system';
    const entry = {
        id: data.id || makeId(),
        type,
        title,
        detail: String(data.detail || '').trim(),
        file: data.file || null,
        timestamp: data.timestamp || new Date().toISOString()
    };

    entries = entries.filter((e) => e.id !== entry.id);
    entries.unshift(entry);
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
    saveEntries();
    return entry;
}

// Newest-first activity entries, capped at `limit`.
function list(limit) {
    ensureLoaded();
    const all = entries.slice();
    return typeof limit === 'number' && limit > 0 ? all.slice(0, limit) : all;
}

function clear() {
    ensureLoaded();
    entries = [];
    saveEntries();
}

module.exports = {
    LOG_PATH,
    MAX_ENTRIES,
    record,
    list,
    clear
};
