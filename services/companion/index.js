/* ============================================
   JARVIS — Companion service facade
   One entry point over the memory store, retrieval,
   prompt assembly and memory formation. Server code
   never reaches into the submodules directly.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const store = require('./store');
const retrieval = require('./retrieval');
const extraction = require('./extraction');
const prompt = require('./prompt');
const textUtil = require('./text');

const DEFAULT_GLOBAL_SETTINGS = {
    memoryEnabled: true,
    autoMemory: true,
    extractionEnabled: true,
    lifeProgression: false,
    retrievalEnabled: true,
    retentionDays: 0,
    maxMemoriesPerCharacter: 500,
    maxContextMemories: 8,
    maxContextChars: 1600,
    // Proactive / living-character behavior.
    initiative: 'passive',
    photoSharing: 'ask',
    lifeIntervalMinutes: 180,
    proactiveMinIntervalMinutes: 180,
    quietHoursStart: 22,
    quietHoursEnd: 8
};

function cleanBool(value, fallback) {
    if (value === true || value === false) return value;
    return fallback;
}

function cleanInt(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}

// Sanitize the global Settings > Companion block.
function cleanEnum(value, allowed, fallback) {
    const v = String(value === undefined || value === null ? '' : value).toLowerCase().trim();
    return allowed.indexOf(v) !== -1 ? v : fallback;
}

function sanitizeGlobalSettings(value, base) {
    const src = value && typeof value === 'object' ? value : {};
    const fallback = base && typeof base === 'object' ? base : DEFAULT_GLOBAL_SETTINGS;
    return {
        memoryEnabled: cleanBool(src.memoryEnabled, cleanBool(fallback.memoryEnabled, true)),
        autoMemory: cleanBool(src.autoMemory, cleanBool(fallback.autoMemory, true)),
        extractionEnabled: cleanBool(src.extractionEnabled, cleanBool(fallback.extractionEnabled, true)),
        lifeProgression: cleanBool(src.lifeProgression, cleanBool(fallback.lifeProgression, false)),
        retrievalEnabled: cleanBool(src.retrievalEnabled, cleanBool(fallback.retrievalEnabled, true)),
        retentionDays: cleanInt(src.retentionDays, fallback.retentionDays || 0, 0, 3650),
        maxMemoriesPerCharacter: cleanInt(src.maxMemoriesPerCharacter, fallback.maxMemoriesPerCharacter || 500, 20, 5000),
        maxContextMemories: cleanInt(src.maxContextMemories, fallback.maxContextMemories || 8, 1, 30),
        maxContextChars: cleanInt(src.maxContextChars, fallback.maxContextChars || 1600, 200, 8000),
        // Proactive / living-character behavior. Passive by default.
        initiative: cleanEnum(src.initiative, store.INITIATIVE_MODES, cleanEnum(fallback.initiative, store.INITIATIVE_MODES, 'passive')),
        photoSharing: cleanEnum(src.photoSharing, store.PHOTO_SHARING_MODES, cleanEnum(fallback.photoSharing, store.PHOTO_SHARING_MODES, 'ask')),
        lifeIntervalMinutes: cleanInt(src.lifeIntervalMinutes, fallback.lifeIntervalMinutes || 180, 15, 10080),
        proactiveMinIntervalMinutes: cleanInt(src.proactiveMinIntervalMinutes, fallback.proactiveMinIntervalMinutes || 180, 15, 10080),
        quietHoursStart: cleanInt(src.quietHoursStart, fallback.quietHoursStart == null ? 22 : fallback.quietHoursStart, 0, 23),
        quietHoursEnd: cleanInt(src.quietHoursEnd, fallback.quietHoursEnd == null ? 8 : fallback.quietHoursEnd, 0, 23)
    };
}

// Merge a character's companion settings with the global defaults.
function effectiveSettings(characterSettings, globalSettings) {
    const character = characterSettings || store.DEFAULT_SETTINGS;
    const global = globalSettings || DEFAULT_GLOBAL_SETTINGS;
    const pick = (value, fallback) => (value === true || value === false ? value : fallback);
    return {
        memoryEnabled: pick(character.memoryEnabled, global.memoryEnabled),
        autoMemory: pick(character.autoMemory, global.autoMemory),
        lifeProgression: pick(character.lifeProgression, global.lifeProgression),
        initiative: (character.initiative || global.initiative || 'passive'),
        photoSharing: (character.photoSharing || global.photoSharing || 'ask'),
        extractionEnabled: global.extractionEnabled,
        retrievalEnabled: global.retrievalEnabled,
        retentionDays: global.retentionDays,
        maxMemoriesPerCharacter: global.maxMemoriesPerCharacter,
        maxContextMemories: global.maxContextMemories,
        maxContextChars: global.maxContextChars,
        lifeIntervalMinutes: global.lifeIntervalMinutes,
        proactiveMinIntervalMinutes: global.proactiveMinIntervalMinutes,
        quietHoursStart: global.quietHoursStart,
        quietHoursEnd: global.quietHoursEnd
    };
}

// Resolve a character's effective initiative + photo-sharing without the caller
// reaching into the store or config.
function behaviorFor(characterId, characterSettings, globalSettings) {
    const effective = effectiveSettings(characterSettings || store.getSettings(characterId), globalSettings);
    return {
        initiative: effective.initiative,
        photoSharing: effective.photoSharing,
        lifeProgression: effective.lifeProgression,
        lifeIntervalMinutes: effective.lifeIntervalMinutes,
        proactiveMinIntervalMinutes: effective.proactiveMinIntervalMinutes,
        quietHoursStart: effective.quietHoursStart,
        quietHoursEnd: effective.quietHoursEnd
    };
}

function getProfile(characterId) {
    const settings = store.getSettings(characterId);
    if (!settings) return null;
    return {
        settings,
        state: store.getState(characterId),
        stats: store.getStats(characterId)
    };
}

function updateSettings(characterId, patch) {
    return store.setSettings(characterId, patch);
}

// Assemble the bounded companion system context for a turn. Returns
// { text, memoryIds } where memoryIds are the memories actually injected (so
// they can be marked accessed). Never throws.
function buildContextForTurn(options) {
    const opts = options || {};
    const characterId = String(opts.characterId || '').trim();
    const character = opts.character || null;
    if (!characterId || !character) return { text: '', memoryIds: [] };
    const settings = opts.settings || store.getSettings(characterId) || store.DEFAULT_SETTINGS;
    const effective = effectiveSettings(settings, opts.globalSettings);

    let memoryText = '';
    let memoryIds = [];
    if (effective.memoryEnabled && effective.retrievalEnabled) {
        try {
            const selection = retrieval.selectMemoryContext(
                store.listMemories(characterId, { status: 'active', limit: effective.maxMemoriesPerCharacter }),
                opts.query || '',
                { maxCount: effective.maxContextMemories, maxChars: effective.maxContextChars }
            );
            memoryText = selection.text;
            memoryIds = selection.selected.map((m) => m.id);
        } catch (err) {
            console.warn('[companion] retrieval failed:', err.message);
        }
    }

    const text = prompt.buildCompanionContext({
        character,
        settings,
        state: store.getState(characterId),
        memoryText,
        memoryEnabled: effective.memoryEnabled,
        lifeText: opts.lifeText || '',
        initiative: effective.initiative
    });
    return { text, memoryIds };
}

function markMemoriesUsed(characterId, ids) {
    if (!characterId || !Array.isArray(ids) || !ids.length) return;
    try {
        store.markAccessed(characterId, ids);
    } catch (err) {
        console.warn('[companion] markAccessed failed:', err.message);
    }
}

// Explicit "save this moment as a memory" action.
function saveMemory(characterId, value) {
    const memory = store.addMemory(characterId, value);
    if (memory) {
        store.enforceRetention(characterId, {
            maxMemoriesPerCharacter: DEFAULT_GLOBAL_SETTINGS.maxMemoriesPerCharacter,
            retentionDays: DEFAULT_GLOBAL_SETTINGS.retentionDays
        });
    }
    return memory;
}

// Deferred automatic memory formation for a finished turn. Returns true when
// scheduled, false when disabled. Never throws.
function scheduleTurnExtraction(options) {
    const opts = options || {};
    const characterId = String(opts.characterId || '').trim();
    if (!characterId) return false;
    const settings = opts.settings || store.getSettings(characterId) || store.DEFAULT_SETTINGS;
    const effective = effectiveSettings(settings, opts.globalSettings);
    if (!effective.memoryEnabled || !effective.autoMemory || !effective.extractionEnabled) return false;
    if (!opts.providers || typeof opts.providers.chat !== 'function') return false;
    extraction.scheduleExtraction({
        characterId,
        characterName: opts.characterName,
        provider: opts.provider,
        model: opts.model,
        conversationId: opts.conversationId,
        messageId: opts.messageId,
        excerpt: opts.excerpt,
        lifeProgression: effective.lifeProgression,
        retentionDays: effective.retentionDays,
        maxMemoriesPerCharacter: effective.maxMemoriesPerCharacter
    }, opts.run);
    return true;
}

// Run extraction synchronously (awaited). Used by tests and explicit actions.
function extractNow(options) {
    return extraction.extractMemories(options);
}

module.exports = {
    DEFAULT_GLOBAL_SETTINGS,
    MEMORY_TYPES: store.MEMORY_TYPES,
    INITIATIVE_MODES: store.INITIATIVE_MODES,
    PHOTO_SHARING_MODES: store.PHOTO_SHARING_MODES,
    sanitizeGlobalSettings,
    effectiveSettings,
    behaviorFor,
    // store passthroughs
    getProfile,
    updateSettings,
    getState: store.getState,
    setState: store.setState,
    listMemories: store.listMemories,
    getMemory: store.getMemory,
    addMemory: store.addMemory,
    updateMemory: store.updateMemory,
    removeMemory: store.removeMemory,
    clearMemories: store.clearMemories,
    supersedeMemory: store.supersedeMemory,
    getStats: store.getStats,
    deleteRecord: store.deleteRecord,
    saveMemory,
    // retrieval
    rankMemories: retrieval.rankMemories,
    selectMemoryContext: retrieval.selectMemoryContext,
    buildContextForTurn,
    markMemoriesUsed,
    // formation
    scheduleTurnExtraction,
    extractNow,
    buildTranscript: prompt.buildTranscript,
    buildCompanionContext: prompt.buildCompanionContext,
    casualizeReply: prompt.casualizeReply,
    // text (tests / advanced callers)
    similarity: textUtil.similarity
};
