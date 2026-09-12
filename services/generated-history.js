/* ============================================
   JARVIS — Generated Image History
   Lightweight metadata store for every image the
   Krea2 / ComfyUI pipeline produces. The image
   files themselves live on disk in data/generated;
   only small metadata records are kept here in a
   single local JSON file so the gallery survives
   page reloads and server restarts.
   ============================================ */

const fs = require('fs');
const path = require('path');

const activityLog = require('./activity-log');

const GENERATED_DIR = path.join(__dirname, '..', 'data', 'generated');
const HISTORY_PATH = path.join(__dirname, '..', 'data', 'generated-history.json');

let history = null;      // cached array of metadata records (newest first)
let loadedOnce = false;

function loadHistory() {
    try {
        const raw = fs.readFileSync(HISTORY_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.entries)) return parsed.entries;
    } catch (err) {
        // Missing or corrupt metadata file — seed from disk below.
    }
    return null;
}

function saveHistory(entries) {
    const dir = path.dirname(HISTORY_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload = { updatedAt: new Date().toISOString(), entries };
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(payload, null, 2), 'utf-8');
}

// Seed the history from the image files currently on disk. Used when no
// metadata file exists yet (e.g. images generated before this widget was
// added). Width/height is approximated from the current Krea2 defaults since
// it was not recorded; prompt/model are marked unknown.
function seedFromDisk() {
    const entries = [];
    let files = [];
    try {
        files = fs.readdirSync(GENERATED_DIR);
    } catch (err) {
        return entries;
    }
    for (const name of files) {
        if (!/\.(?:png|jpg|jpeg|webp|mp4|webm|mov)$/i.test(name)) continue;
        const abs = path.join(GENERATED_DIR, name);
        let mtime;
        try { mtime = fs.statSync(abs).mtime; } catch { continue; }
        const createdAt = mtime.toISOString().replace(/\.\d+Z$/, '');
        entries.push({
            id: makeId(createdAt),
            file: '/generated/' + encodeURIComponent(name),
            prompt: '',
            model: 'Krea2',
            rawFilename: name,
            createdAt
        });
    }
    return entries;
}

function entriesSorted(entries) {
    return entries.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

// Build an id like "2026-09-06_2041_001" (date, time, 3-digit sequence).
function makeId(createdAtIso) {
    const d = new Date(Date.parse(createdAtIso) || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const min = pad(d.getMinutes());
    const base = yyyy + '-' + mm + '-' + dd + '_' + hh + min + '_';

    // Keep a per-process sequence so ids are unique even within the same minute.
    let lastBase = null;
    let seq = 0;
    const existing = new Set((history || []).map((e) => e.id));
    let id = base + String(++seq).padStart(3, '0');
    let attempts = 0;
    while (existing.has(id) && attempts < 1000) {
        if (lastBase !== null && lastBase !== base) seq = 0;
        lastBase = base;
        seq += 1;
        id = base + String(seq).padStart(3, '0');
        attempts += 1;
    }
    return id;
}

function ensureLoaded() {
    if (loadedOnce) return;
    loadedOnce = true;
    const loaded = loadHistory();
    history = entriesSorted(loaded || seedFromDisk());
    if (history.length) saveHistory(history);
}

// Returns all generated image metadata, newest first.
function list() {
    ensureLoaded();
    return history.map(publicMeta);
}

// Limit to the most recent N entries.
function listRecent(limit) {
    const all = list();
    return typeof limit === 'number' ? all.slice(0, limit) : all;
}

function publicMeta(entry) {
    return {
        id: entry.id,
        file: entry.file,
        prompt: entry.prompt || '',
        model: entry.model || 'Krea2',
        width: entry.width || null,
        height: entry.height || null,
        createdAt: entry.createdAt,
        generationMs: Number.isFinite(Number(entry.generationMs)) ? Number(entry.generationMs) : null,
        seed: Number.isFinite(Number(entry.seed)) ? Number(entry.seed) : null,
        loras: Array.isArray(entry.loras) ? entry.loras : [],
        upscale: entry.upscale || null,
        video: entry.video || null
    };
}

// Map a freshly recorded generation to a dashboard ACTIVITY entry. The type
// is inferred from metadata plus the filename markers the pipelines use
// (`_edit_`, `_refined_`, `_up_`). Best-effort: activity logging must never
// break a generation.
function recordActivity(entry) {
    try {
        const raw = entry.rawFilename || '';
        const prompt = String(entry.prompt || '').trim();
        const detail = prompt.length > 140 ? prompt.slice(0, 137) + '\u2026' : prompt;
        let type = 'image';
        let title = 'Image generated';
        if (entry.upscale) {
            type = 'upscale';
            title = entry.video ? 'Video upscaled' : 'Image upscaled';
        } else if (entry.video) {
            type = 'video';
            title = entry.video.refined ? 'Video face-refined' : 'Video generated';
        } else if (raw.includes('_edit_')) {
            type = 'edit';
            title = 'Image edited';
        }
        activityLog.record({
            type,
            title,
            detail: detail || (entry.model || ''),
            file: entry.file
        });
    } catch (err) {
        console.warn('[generated-history] Activity record failed:', err.message);
    }
}

// Record a freshly generated image. Returns the added entry (public shape).
function add(meta) {
    ensureLoaded();
    const createdAt = meta.createdAt || new Date().toISOString().replace(/\.\d+Z$/, '');
    const entry = {
        id: meta.id || makeId(createdAt),
        file: meta.file,
        rawFilename: meta.rawFilename || meta.filename || null,
        prompt: meta.prompt || '',
        model: meta.model || 'Krea2',
        width: meta.width || null,
        height: meta.height || null,
        generationMs: Number.isFinite(Number(meta.generationMs)) ? Number(meta.generationMs) : null,
        seed: Number.isFinite(Number(meta.seed)) ? Number(meta.seed) : null,
        loras: Array.isArray(meta.loras) ? meta.loras : [],
        upscale: meta.upscale || null,
        video: meta.video || null,
        createdAt
    };
    // Replace an existing entry with the same id (idempotent re-add).
    history = history.filter((e) => e.id !== entry.id);
    history.unshift(entry);
    saveHistory(history);
    recordActivity(entry);
    return publicMeta(entry);
}

// Delete a generated image by id: removes the metadata record and, when the
// rawFilename is known, the image file from disk. Returns the removed entry,
// or null if no matching record was found.
function remove(id) {
    ensureLoaded();
    const index = history.findIndex((e) => e.id === id);
    if (index === -1) return null;
    const [entry] = history.splice(index, 1);
    saveHistory(history);

    const raw = entry.rawFilename || lastPathSegment(entry.file);
    if (raw) {
        const abs = path.join(GENERATED_DIR, path.basename(raw));
        if (abs.startsWith(GENERATED_DIR) && fs.existsSync(abs)) {
            try { fs.unlinkSync(abs); } catch (err) { /* ignore — record already removed */ }
        }
    }
    return entry;
}

function lastPathSegment(str) {
    if (!str) return null;
    const decoded = decodeURIComponent(str);
    const idx = decoded.lastIndexOf('/');
    return idx === -1 ? decoded : decoded.slice(idx + 1);
}

module.exports = {
    GENERATED_DIR,
    HISTORY_PATH,
    list,
    listRecent,
    add,
    remove,
    makeId
};
