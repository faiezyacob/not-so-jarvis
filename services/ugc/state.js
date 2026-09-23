/* ============================================
   JARVIS — UGC Studio State
   Per-conversation UGC project state (brief,
   product, creator, outfit, environment, script,
   scenes, references, continuity) persisted to
   disk so a project survives a reload or a server
   restart. One project per conversation.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
// An explicit path keeps the tests hermetic (they never touch data/).
const STORE_PATH = process.env.UGC_STATE_PATH || path.join(DATA_DIR, 'ugc-state.json');

// Lifecycle status of a project. "active" keeps the conversational gate open;
// "draft" preserves the project while letting normal chat resume.
const STATUS = Object.freeze({
    ACTIVE: 'active',
    DRAFT: 'draft',
    COMPLETED: 'completed'
});

let store = null;

function loadStore() {
    if (store) return store;
    try {
        const raw = fs.readFileSync(STORE_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        store = {
            projects: (parsed && typeof parsed.projects === 'object' && parsed.projects) || {}
        };
    } catch (err) {
        store = { projects: {} };
    }
    return store;
}

function saveStore() {
    const parent = path.dirname(STORE_PATH);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    const data = loadStore();
    fs.writeFileSync(STORE_PATH, JSON.stringify({
        updatedAt: new Date().toISOString(),
        projects: data.projects
    }, null, 2), 'utf-8');
}

function getProject(conversationId) {
    if (!conversationId) return null;
    return loadStore().projects[String(conversationId)] || null;
}

function setProject(conversationId, project) {
    if (!conversationId || !project) return null;
    const data = loadStore();
    project.updatedAt = new Date().toISOString();
    data.projects[String(conversationId)] = project;
    saveStore();
    return project;
}

function removeProject(conversationId) {
    if (!conversationId) return false;
    const data = loadStore();
    const key = String(conversationId);
    if (!data.projects[key]) return false;
    delete data.projects[key];
    saveStore();
    return true;
}

// Every stored project, newest first. Backs the "resume a draft" picker.
function listProjects() {
    const data = loadStore();
    return Object.keys(data.projects)
        .map((key) => data.projects[key])
        .filter(Boolean)
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

module.exports = {
    STATUS,
    STORE_PATH,
    getProject,
    setProject,
    removeProject,
    listProjects
};
