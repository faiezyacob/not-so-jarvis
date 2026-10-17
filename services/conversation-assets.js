/* ============================================
   JARVIS — Conversation Asset Registry
   A single, conversation-scoped index over media
   that already exists on disk (generated output and
   user uploads). This is a DERIVED VIEW, never a
   second storage layer: it scans the persisted
   conversation messages plus generated-history and
   exposes each asset with a stable id, media type,
   origin, scope, source message and validated path.

   Every reference the chat resolves (the @-picker
   tokens / `body.videos` / `body.references`) is
   validated here before it reaches a workflow, so an
   asset is never identified by its label or by the
   order it was uploaded. Scoped by conversation: one
   conversation can never reference another's media.

   No LLM, no GPU, no dependencies.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');
const conversationService = require('../server/conversation-service');
const generatedHistory = require('./generated-history');

const DATA_DIR = path.join(__dirname, '..', 'data');
// Env overrides keep the tests hermetic and match the server's own dirs.
const GENERATED_DIR = process.env.GENERATED_DIR || path.join(DATA_DIR, 'generated');
const IMAGES_DIR = process.env.IMAGES_DIR || path.join(DATA_DIR, 'images');

const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif|bmp)$/i;
const VIDEO_EXT_RE = /\.(?:mp4|webm|mov|m4v|avi|mkv)$/i;
const AUDIO_EXT_RE = /\.(?:mp3|wav|ogg|oga|m4a|flac|aac)$/i;

const MEDIA_EXT_RE = /\.(?:png|jpe?g|webp|gif|bmp|mp4|webm|mov|m4v|avi|mkv|mp3|wav|ogg|oga|m4a|flac|aac)/i;

const MIME_BY_EXT = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.gif': 'image/gif', '.bmp': 'image/bmp',
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
    '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac'
};

// Markdown/HTML media links the persisted messages embed. Captures the
// /generated/ or /images/ origin prefix so the asset's storage dir is known.
const MEDIA_LINK_RE = /(?:\/generated\/|\/images\/)([^\s)"'<>?#]+?\.(?:png|jpe?g|webp|gif|bmp|mp4|webm|mov|m4v|avi|mkv|mp3|wav|ogg|oga|m4a|flac|aac))/gi;

function decodeName(value) {
    const base = path.basename(String(value || '').split('?')[0]);
    try { return decodeURIComponent(base); } catch (_) { return base; }
}

function classifyMedia(filename) {
    const name = String(filename || '');
    if (IMAGE_EXT_RE.test(name)) return 'image';
    if (VIDEO_EXT_RE.test(name)) return 'video';
    if (AUDIO_EXT_RE.test(name)) return 'audio';
    return null;
}

function mimeForName(filename) {
    return MIME_BY_EXT[path.extname(String(filename || '')).toLowerCase()] || 'application/octet-stream';
}

function withinDir(dir, fullPath) {
    const rel = path.relative(dir, fullPath);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Resolve a bare filename to its on-disk location + origin. `originHint`
// (`generated`/`upload`) narrows the search; otherwise both roots are tried.
function resolveAssetLocation(filename, originHint) {
    const name = decodeName(filename);
    if (!name) return null;
    const candidates = [];
    if (originHint === 'upload') candidates.push(IMAGES_DIR);
    else if (originHint === 'generated') candidates.push(GENERATED_DIR);
    else candidates.push(GENERATED_DIR, IMAGES_DIR);
    for (const dir of candidates) {
        const fullPath = path.join(dir, name);
        if (!withinDir(dir, fullPath)) continue;
        try {
            const stat = fs.statSync(fullPath);
            if (!stat.isFile() || stat.size <= 0) continue;
            return {
                absPath: fullPath,
                origin: dir === IMAGES_DIR ? 'upload' : 'generated',
                filename: name,
                size: stat.size
            };
        } catch (_) { /* missing -> try next root */ }
    }
    return null;
}

function assetUrl(origin, filename) {
    const prefix = origin === 'upload' ? '/images/' : '/generated/';
    return prefix + encodeURIComponent(filename);
}

// Pull every media link out of one message body, preserving order.
function extractMediaLinks(content) {
    const text = String(content || '');
    const out = [];
    const seen = new Set();
    let match;
    MEDIA_LINK_RE.lastIndex = 0;
    while ((match = MEDIA_LINK_RE.exec(text)) !== null) {
        const raw = match[0];
        const origin = raw.indexOf('/images/') === 0 ? 'upload' : 'generated';
        const filename = decodeName(match[1]);
        if (!filename || seen.has(filename)) continue;
        seen.add(filename);
        out.push({ filename, origin });
    }
    return out;
}

function historyIndexForConversation(conversationId) {
    const index = new Map();
    let entries = [];
    try { entries = generatedHistory.list() || []; } catch (_) { entries = []; }
    for (const entry of entries) {
        if (!entry || entry.conversationId !== conversationId) continue;
        const name = entry.rawFilename || decodeName(entry.file);
        if (name) index.set(name, entry);
    }
    return index;
}

// Build the ordered registry for one conversation. Order follows message
// order (oldest first). Unavailable assets are skipped rather than surfaced.
function listConversationAssets(conversationId, options = {}) {
    if (!conversationId) return [];
    const includeHidden = options.includeHidden === true;
    const messages = conversationService.getMessages(conversationId) || [];
    const historyIndex = historyIndexForConversation(conversationId);
    const seen = new Map();
    const ordered = [];

    const add = (filename, originHint, messageId) => {
        const name = decodeName(filename);
        if (!name) return;
        const existing = seen.get(name);
        if (existing) {
            if (messageId && !existing.sourceMessageId) existing.sourceMessageId = messageId;
            return;
        }
        const type = classifyMedia(name);
        if (!type) return;
        const meta = historyIndex.get(name) || null;
        if (meta && meta.hidden && !includeHidden) return;
        const location = resolveAssetLocation(name, originHint || (meta ? 'generated' : undefined));
        if (!location) return;
        const asset = {
            id: type + ':' + name,
            type,
            origin: location.origin,
            filename: name,
            url: assetUrl(location.origin, name),
            displayName: name,
            mimeType: mimeForName(name),
            size: location.size,
            width: (meta && meta.width) || null,
            height: (meta && meta.height) || null,
            duration: (meta && meta.video && meta.video.duration) || null,
            prompt: (meta && meta.prompt) || '',
            sourceMessageId: messageId || null,
            createdAt: (meta && meta.createdAt) || null
        };
        seen.set(name, asset);
        ordered.push(asset);
    };

    for (const message of messages) {
        if (!message) continue;
        for (const link of extractMediaLinks(message.content)) {
            add(link.filename, link.origin, message.id);
        }
    }
    return ordered;
}

// Validate one reference against the conversation registry. Returns the
// resolved asset (with validated absPath) or null when it is missing,
// unavailable, out of scope, or the wrong media type.
function resolveConversationAsset(conversationId, filename, options = {}) {
    if (!conversationId || !filename) return null;
    const name = decodeName(filename);
    if (!name) return null;
    const wantedType = options.type || null;
    const wantedOrigin = options.origin || null;

    const candidates = listConversationAssets(conversationId, { includeHidden: options.includeHidden === true });
    let asset = candidates.find((a) => a.filename === name) || null;
    if (!asset) {
        // A just-generated asset may not yet be in a message body (e.g. an
        // output not linked from chat); fall back to the history + dirs.
        const meta = historyIndexForConversation(conversationId).get(name) || null;
        const type = classifyMedia(name);
        if (meta && type) {
            const location = resolveAssetLocation(name, 'generated');
            if (location) {
                asset = { id: type + ':' + name, type, origin: 'generated', filename: name };
            }
        }
    }
    if (!asset) return null;
    if (wantedType && asset.type !== wantedType) return null;
    if (wantedOrigin && asset.origin !== wantedOrigin) return null;
    const location = resolveAssetLocation(asset.filename, asset.origin);
    if (!location) return null;
    return Object.assign({}, asset, { absPath: location.absPath, size: location.size });
}

module.exports = {
    GENERATED_DIR,
    IMAGES_DIR,
    IMAGE_EXT_RE,
    VIDEO_EXT_RE,
    AUDIO_EXT_RE,
    MEDIA_EXT_RE,
    classifyMedia,
    mimeForName,
    resolveAssetLocation,
    assetUrl,
    extractMediaLinks,
    listConversationAssets,
    resolveConversationAsset
};
