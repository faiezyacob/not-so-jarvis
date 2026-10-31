/* ============================================
   JARVIS — Message Media Cleanup
   Deletes the generated images/videos a single
   chat response embeds, together with their
   gallery records and files, and removes any
   leftover references to those files from the
   rest of the conversation transcript.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const conversationService = require('../server/conversation-service');
const generatedHistory = require('./generated-history');
const characterContext = require('./character-context');
const taskState = require('./task-state');

// Video embeds use a quoted src attribute and images use markdown; both hold a
// /generated/ URL. Quotes/brackets terminate the match so the captured name
// never keeps a trailing quote.
const GENERATED_URL_RE = /\/generated\/([^\s)\]}"']+)/g;
const MEDIA_LINK_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;
const VIDEO_TAG_RE = /<video\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/video>/gi;

function basenameOfValue(value) {
    if (!value) return '';
    let name = String(value).split('?')[0];
    name = name.slice(name.lastIndexOf('/') + 1);
    try { return decodeURIComponent(name); } catch (err) { return name; }
}

// Pull every /generated/ filename out of a set of message bodies.
function collectGeneratedFilenames(contents) {
    const wanted = new Set();
    (contents || []).forEach((content) => {
        const text = String(content || '');
        let match;
        GENERATED_URL_RE.lastIndex = 0;
        while ((match = GENERATED_URL_RE.exec(text)) !== null) {
            const name = basenameOfValue(match[1]);
            if (name) wanted.add(name);
        }
    });
    return wanted;
}

// Remove the generated media owned by ONE deleted message. Character identity
// media is always protected, and internal (hidden) media stays owned by its
// production/session. Returns the removed filenames so the client can drop
// matching composer references.
function removeMessageMedia(conversationId, message) {
    const content = (message && message.content) || '';
    const candidates = collectGeneratedFilenames([content]);
    if (!candidates.size) return [];
    const protectedNames = characterContext.characterMediaFilenames();
    const removable = new Set();
    candidates.forEach((name) => {
        if (!name || protectedNames.has(name)) return;
        removable.add(name);
    });
    if (!removable.size) return [];

    const entries = generatedHistory.list();
    const idsToDelete = new Set();
    entries.forEach((entry) => {
        if (entry.hidden === true) return;
        if (entry.conversationId && entry.conversationId !== conversationId) return;
        const name = basenameOfValue(entry.rawFilename || entry.file);
        if (!name || protectedNames.has(name)) return;
        if (removable.has(name)) idsToDelete.add(entry.id);
    });
    if (!idsToDelete.size) return [];

    const removedNames = new Set();
    entries.forEach((entry) => {
        if (idsToDelete.has(entry.id)) removedNames.add(basenameOfValue(entry.rawFilename || entry.file));
    });
    idsToDelete.forEach((entryId) => {
        try { generatedHistory.remove(entryId); } catch (err) { /* ignore */ }
    });

    // The active task held the last generated asset / I2VA source. If either
    // points at a file that is now gone, clear it so a follow-up can't target
    // a missing asset.
    try {
        const task = taskState.getTask(conversationId);
        const patch = {};
        if (removedNames.has(basenameOfValue(task && task.generatedAsset))) patch.generatedAsset = null;
        if (removedNames.has(basenameOfValue(task && task.sourceImage))) patch.sourceImage = null;
        if (Object.keys(patch).length) taskState.setTask(conversationId, patch);
    } catch (err) { /* best-effort cleanup */ }

    return Array.from(removedNames);
}

// Drop every markdown image link and <video> embed that points at a removed
// file, so no remaining message renders a broken asset. Returns how many
// messages were rewritten.
function stripRemovedMediaReferences(conversationId, removedNames) {
    if (!removedNames || !removedNames.size) return 0;
    let rewritten = 0;
    conversationService.getMessages(conversationId).forEach((message) => {
        const content = String((message && message.content) || '');
        let changed = false;
        const withoutLinks = content.replace(MEDIA_LINK_RE, (match, url) => {
            if (!removedNames.has(basenameOfValue(url))) return match;
            changed = true;
            return '';
        });
        const stripped = withoutLinks.replace(VIDEO_TAG_RE, (match, url) => {
            if (!removedNames.has(basenameOfValue(url))) return match;
            changed = true;
            return '';
        });
        if (!changed) return;
        const cleaned = stripped
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        conversationService.updateMessageContent(conversationId, message.id, cleaned);
        rewritten += 1;
    });
    return rewritten;
}

module.exports = {
    basenameOfValue,
    collectGeneratedFilenames,
    removeMessageMedia,
    stripRemovedMediaReferences
};
