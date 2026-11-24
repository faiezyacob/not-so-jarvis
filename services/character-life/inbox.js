/* ============================================
   JARVIS — Character photo inbox
   A character who is set to share photos on her
   own can drop one into the inbox without being
   asked: a selfie taken from her current fictional
   life, with a short message in her voice.

   This module owns the policy (is a drop due?) and
   the message. It never touches ComfyUI: the server
   renders the photo through the existing identity
   edit pipeline and hands the finished file here.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const store = require('./store');
const moments = require('./moments');

const DEFAULTS = {
    // A drop needs an explicit opt-in on the character: scheduled initiative
    // plus automatic photo sharing. Nothing here runs for a passive character.
    intervalMinutes: 180,
    maxUnread: 2,
    // A photo with no life state has no reason to exist yet.
    requireLife: true
};

const LEAD_INS = ['', '', '', 'Thought of you. ', 'You missed this. '];

function cleanId(characterId) {
    return String(characterId || '').trim();
}

function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function withinQuietHours(hour, start, end) {
    const h = Number(hour);
    const s = clampInt(start, 0, 23, 22);
    const e = clampInt(end, 0, 23, 8);
    if (s === e) return false;
    if (s < e) return h >= s && h < e;
    return h >= s || h < e;
}

function hash(value) {
    let h = 2166136261;
    const text = String(value || '');
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
}

function sentence(value) {
    const text = String(value === undefined || value === null ? '' : value)
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.!?]+$/, '');
    if (!text) return '';
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowerFirst(value) {
    const text = String(value || '');
    return text ? text.charAt(0).toLowerCase() + text.slice(1) : '';
}

// Her message. Deterministic from the moment (no model call, so a drop never
// costs GPU time beyond the image itself) and always ending in a full stop.
function captionFor(lifeState) {
    const life = lifeState || {};
    const activity = sentence(life.activity);
    const mood = sentence(life.mood);
    const lead = LEAD_INS[hash((activity + '|' + mood).toLowerCase()) % LEAD_INS.length];
    const parts = [];
    if (activity) parts.push(activity + '.');
    if (mood && hash('mood:' + mood.toLowerCase()) % 3 === 0) {
        parts.push('Feeling ' + lowerFirst(mood) + '.');
    }
    if (!parts.length) parts.push('Just wanted to send you this.');
    return (lead + parts.join(' ')).trim();
}

// The Camera Director intent for an unprompted drop. Every drop carries a
// creative moment (place + body position + camera), so the photo recomposes the
// frame instead of only restyling the portrait. A casual front-camera moment is
// the default; a mirror moment is used when the look is the subject, which also
// reads naturally in a message.
function planMoment(options) {
    const opts = options || {};
    const lifeState = opts.life || {};
    const count = Number(opts.count) || 0;
    const moment = opts.moment || moments.pickDeterministicMoment({
        recent: opts.recent,
        seed: opts.seed,
        count,
        hour: opts.hour
    });
    const caption = (moment && moment.caption) || captionFor({
        activity: moment ? moment.activity : lifeState.activity,
        location: moment ? moment.location : lifeState.location,
        mood: (moment && moment.mood) || lifeState.mood
    });
    return {
        intent: moment && moment.camera === 'mirror' ? 'outfit' : 'selfie',
        subject: '',
        caption: caption || '',
        reason: (moment && (moment.title || moment.activity)) || String(lifeState.activity || '').trim() || 'a quiet moment',
        moment: moment || null
    };
}

// Is a drop due right now? Pure decision: the caller does the rendering.
// `behavior` is companionService.behaviorFor(...); `record` is the life record.
function dueCheck(options) {
    const opts = options || {};
    const behavior = opts.behavior || {};
    const record = opts.record || null;
    const now = opts.now === undefined ? Date.now() : Number(opts.now);
    const inbox = (record && Array.isArray(record.inbox)) ? record.inbox : [];
    const unread = inbox.filter((item) => !item.readAt).length;
    const life = (record && record.life) || {};
    const maxUnread = clampInt(opts.maxUnread, 1, 10, DEFAULTS.maxUnread);
    const interval = clampInt(
        opts.intervalMinutes !== undefined ? opts.intervalMinutes : behavior.proactiveMinIntervalMinutes,
        30, 10080, DEFAULTS.intervalMinutes
    );

    if (behavior.photoSharing === 'off') return { due: false, reason: 'disabled', intervalMinutes: interval, unread };
    if (behavior.photoSharing !== 'auto') return { due: false, reason: 'not_auto', intervalMinutes: interval, unread };
    if (behavior.initiative !== 'scheduled') return { due: false, reason: 'passive', intervalMinutes: interval, unread };
    if (unread >= maxUnread) return { due: false, reason: 'unread_full', intervalMinutes: interval, unread };

    const hour = opts.hour === undefined ? new Date(now).getHours() : Number(opts.hour);
    if (withinQuietHours(hour, behavior.quietHoursStart, behavior.quietHoursEnd)) {
        return { due: false, reason: 'quiet_hours', intervalMinutes: interval, unread };
    }

    const missingLife = DEFAULTS.requireLife && !String(life.activity || '').trim();
    if (missingLife) return { due: false, reason: 'no_life', intervalMinutes: interval, unread };

    const lastDelivered = record && record.lastInboxAt ? Date.parse(record.lastInboxAt) : NaN;
    const lastAttempt = record && record.lastInboxAttemptAt ? Date.parse(record.lastInboxAttemptAt) : NaN;
    const last = Math.max(Number.isFinite(lastDelivered) ? lastDelivered : 0, Number.isFinite(lastAttempt) ? lastAttempt : 0);
    if (last && now - last < interval * 60000) {
        return { due: false, reason: 'too_soon', intervalMinutes: interval, unread, nextAt: new Date(last + interval * 60000).toISOString() };
    }

    return { due: true, reason: 'due', intervalMinutes: interval, unread };
}

// Record a delivered photo. The caller has already rendered the file and
// resolved the Camera Director spec.
function capture(characterId, input) {
    const id = cleanId(characterId);
    if (!id) return null;
    const opts = input || {};
    const spec = opts.spec || {};
    const result = opts.result || {};
    if (!result.url) return null;
    const item = store.addInboxItem(id, {
        status: 'ready',
        url: result.url,
        file: result.filename || '',
        caption: opts.caption || captionFor(opts.life),
        moment: opts.moment || '',
        activity: spec.activity || '',
        location: spec.location || '',
        outfit: spec.outfit || '',
        intent: spec.intent || 'selfie',
        cameraView: spec.cameraView || 'front',
        summary: opts.summary || '',
        createdAt: opts.createdAt || new Date().toISOString()
    });
    store.setLastInboxAttemptAt(id, opts.createdAt || new Date().toISOString());
    return item;
}

function markAttempt(characterId, at) {
    return store.setLastInboxAttemptAt(cleanId(characterId), at);
}

function listInbox(characterId, limit) {
    return store.getInbox(cleanId(characterId), limit);
}

function unreadCount(characterId) {
    return listInbox(characterId).filter((item) => !item.readAt).length;
}

function markRead(characterId, itemId) {
    return store.markInboxRead(cleanId(characterId), itemId);
}

function remove(characterId, itemId) {
    return store.removeInboxItem(cleanId(characterId), itemId);
}

function clear(characterId) {
    return store.clearInbox(cleanId(characterId));
}

module.exports = {
    DEFAULTS,
    dueCheck,
    captionFor,
    planMoment,
    capture,
    markAttempt,
    listInbox,
    unreadCount,
    markRead,
    remove,
    clear,
    // exported for tests
    withinQuietHours,
    sentence
};
