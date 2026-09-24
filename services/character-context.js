/* ============================================
   JARVIS — Character Context Layer
   The single place that turns a user message into
   structured character context. `@Maya` is never
   treated as ordinary prompt text: it is resolved
   to a saved Character Identity Package, the active
   character is scoped to the conversation's
   generation flow, and the media pipelines receive
   the resolved conditioning (approved base image +
   relevant identity references) instead of parsing
   mentions themselves.

   This module owns:
     - mention parsing (only known characters; never
       emails or unrelated "@")
     - bare-name resolution ("bring Maya back")
     - the per-conversation active character store
     - reference selection for a scene
     - the identity-vs-scene edit instruction

   It is filesystem-agnostic: it returns filenames,
   and the caller resolves them to absolute paths.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');
const characterPresets = require('./character-presets');
const characterIdentity = require('./character-identity');

const DATA_DIR = path.join(__dirname, '..', 'data');
// An explicit path keeps the tests hermetic (they never touch data/).
const CONTEXT_PATH = process.env.CHARACTER_CONTEXT_PATH || path.join(DATA_DIR, 'character-context.json');

// Identity status the picker / chat surface. `basic` is the legacy state: the
// character has a portrait but no identity sheet yet.
const IDENTITY_STATUS = {
    READY: 'ready',
    GENERATING: 'generating',
    FAILED: 'failed',
    BASIC: 'basic',
    NONE: 'none'
};

// Explicit "do not use the character" wording. Clears the active character for
// the turn instead of quietly reusing it.
const REMOVE_RE = new RegExp(
    '\\b(?:without|no)\\s+(?:her|him|them|the\\s+character|the\\s+characters|any\\s+character|anyone|people|a\\s+person|the\\s+person)\\b' +
    '|\\bremove\\s+(?:the\\s+character|the\\s+characters|her|him|them)\\b' +
    '|\\b(?:don\'t|do\\s+not|dont)\\s+(?:include|use|add)\\s+(?:the\\s+character|her|him|them|any\\s+character)\\b' +
    '|\\b(?:just|only)\\s+the\\s+(?:scene|environment|background|place|landscape)\\b',
    'i'
);

// A continuation reference ("she", "her", "them", "the same character") lets the
// active character survive into a follow-up without repeating the mention.
const CONTINUE_RE = /\b(?:her|him|them|she|he|they|the\s+character|the\s+characters|same\s+character|same\s+person|this\s+character)\b/i;

let store = null;

function loadStore() {
    if (store) return store;
    try {
        const raw = fs.readFileSync(CONTEXT_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        store = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
        store = {};
    }
    return store;
}

function saveStore() {
    try {
        const parent = path.dirname(CONTEXT_PATH);
        if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
        fs.writeFileSync(CONTEXT_PATH, JSON.stringify(store || {}, null, 2), 'utf-8');
    } catch (err) {
        /* best-effort persistence; the in-memory context still works */
    }
}

function escapeRe(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Lookup -------------------------------------------------------------------

function getCharacter(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    return characterPresets.get(key);
}

function getCharacterIdentity(id) {
    const character = getCharacter(id);
    if (!character) return null;
    return characterPresets.getIdentitySheet(character.id);
}

// Every saved character's identity status + primary image, for the @ picker.
// Never exposes filesystem paths.
function listCharacterOptions() {
    return characterPresets.list().map((character) => {
        const sheet = characterPresets.getIdentitySheet(character.id);
        const base = characterIdentity.effectiveBaseImage(character, sheet);
        return {
            id: character.id,
            name: character.name || 'Character',
            identityStatus: identityStatusOf(character, sheet),
            hasIdentity: Boolean(sheet && sheet.status === characterIdentity.STATUS.READY),
            referenceCount: sheet ? characterIdentity.allReferences(sheet).length : 0,
            imageUrl: base && base.url ? base.url : ''
        };
    });
}

function identityStatusOf(character, sheet) {
    const s = sheet || (character && character.identitySheet) || null;
    if (s) {
        if (s.status === characterIdentity.STATUS.READY) return IDENTITY_STATUS.READY;
        if (s.status === characterIdentity.STATUS.GENERATING) return IDENTITY_STATUS.GENERATING;
        if (s.status === characterIdentity.STATUS.FAILED) return IDENTITY_STATUS.FAILED;
    }
    const base = characterIdentity.effectiveBaseImage(character, s);
    return base && (base.filename || base.url) ? IDENTITY_STATUS.BASIC : IDENTITY_STATUS.NONE;
}

function toRef(character) {
    if (!character) return null;
    return { id: character.id, name: character.name || 'Character' };
}

function uniqueRefs(list) {
    const out = [];
    for (const item of list) {
        const ref = item && item.id ? item : toRef(item);
        if (!ref || !ref.id) continue;
        if (out.some((r) => r.id === ref.id)) continue;
        out.push(ref);
    }
    return out;
}

// --- Mention parsing ----------------------------------------------------------

// Replace known `@Name` mentions with structured character refs and strip the
// token from the prompt. Only known characters match, so an email address or an
// unrelated "@" is left untouched. Longest names are matched first so
// "Maya 2" wins over "Maya".
function parseMentions(text, characters) {
    const original = String(text || '');
    const known = (Array.isArray(characters) ? characters : characterPresets.list())
        .filter((c) => c && c.name && String(c.name).trim());
    // Longest names first so "Maya 2" is claimed before "Maya"; the resulting
    // mentions are then ordered by where they appear in the text.
    const sorted = known.slice().sort((a, b) => String(b.name).length - String(a.name).length);
    const claims = [];
    for (const character of sorted) {
        const name = String(character.name).trim();
        // The `@` must not follow a word character, so an email local part
        // ("maya@example.com") is never read as a mention.
        const re = new RegExp('(^|[^\\w@])@' + escapeRe(name) + '(?![\\w@])', 'gi');
        let match;
        while ((match = re.exec(original)) !== null) {
            if (match[0].length === 0) { re.lastIndex += 1; continue; }
            const start = match.index + match[1].length;
            const end = start + 1 + name.length;
            if (claims.some((span) => start < span.end && end > span.start)) continue;
            claims.push({ start, end, ref: toRef(character) });
        }
    }
    claims.sort((a, b) => a.start - b.start);
    let prompt = original;
    for (let i = claims.length - 1; i >= 0; i--) {
        prompt = prompt.slice(0, claims[i].start) + prompt.slice(claims[i].end);
    }
    prompt = prompt.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
    return { characters: uniqueRefs(claims.map((span) => span.ref)), prompt };
}

// Bare-name resolution ("bring Maya back"). Conservative: a whole word, not
// inside an email or an @mention. Names are NOT stripped from the prompt — the
// reference-guided conditioning preserves the identity, and keeping the wording
// avoids mangling ordinary sentences.
function matchNames(text, characters) {
    const original = String(text || '');
    const known = (Array.isArray(characters) ? characters : characterPresets.list())
        .filter((c) => c && c.name && String(c.name).trim().length >= 3);
    // Longest names claim their span first, so "Maya 2" never also resolves
    // plain "Maya" (a name collision must not silently select the wrong one).
    const sorted = known.slice().sort((a, b) => String(b.name).length - String(a.name).length);
    const claims = [];
    for (const character of sorted) {
        const name = String(character.name).trim();
        const re = new RegExp('(^|[^\\w@])' + escapeRe(name) + '(?![\\w@])', 'gi');
        let match;
        while ((match = re.exec(original)) !== null) {
            if (match[0].length === 0) { re.lastIndex += 1; continue; }
            const start = match.index + match[1].length;
            const end = start + name.length;
            if (claims.some((span) => start < span.end && end > span.start)) continue;
            claims.push({ start, end, ref: toRef(character) });
        }
    }
    claims.sort((a, b) => a.start - b.start);
    return uniqueRefs(claims.map((span) => span.ref));
}

// Parse a message into explicit character refs + the cleaned prompt. Explicit
// picker selections (`explicitIds`) are merged with `@` mentions and bare names.
function parseCharacterMessage(message, options = {}) {
    const text = String(message || '');
    const explicitIds = Array.isArray(options.explicitIds)
        ? options.explicitIds
        : (options.explicitIds ? [options.explicitIds] : []);
    const mentioned = parseMentions(text, options.characters);
    const explicit = explicitIds.map(getCharacter).filter(Boolean).map(toRef);
    const named = matchNames(text, options.characters);
    return {
        characters: uniqueRefs(mentioned.characters.concat(explicit, named)),
        prompt: mentioned.prompt
    };
}

// --- Active character store ---------------------------------------------------

function getActiveCharacter(conversationId) {
    if (!conversationId) return { characters: [] };
    const entry = loadStore()[conversationId];
    if (!entry || !Array.isArray(entry.characters)) return { characters: [] };
    // Drop characters that have since been deleted.
    const characters = entry.characters.map((c) => getCharacter(c.id)).filter(Boolean).map(toRef);
    return { characters, updatedAt: entry.updatedAt || null };
}

function setActiveCharacter(conversationId, characters) {
    if (!conversationId) return { characters: [] };
    const refs = uniqueRefs(characters || []);
    const current = loadStore();
    if (!refs.length) {
        delete current[conversationId];
    } else {
        current[conversationId] = { characters: refs, updatedAt: new Date().toISOString() };
    }
    store = current;
    saveStore();
    return { characters: refs };
}

function clearActiveCharacter(conversationId) {
    return setActiveCharacter(conversationId, []);
}

// Decide the characters for a turn once the action is known:
//   - an explicit mention / picker selection switches the active character;
//   - explicit "without her" wording clears it for the turn (and the flow);
//   - otherwise a continuation reference ("she", "make her …") inherits the
//     active character, while a fresh generation does not.
function resolveActiveCharacters(options = {}) {
    const conversationId = options.conversationId;
    const explicit = uniqueRefs(options.explicit || []);
    const message = String(options.message || '');
    const isContinuation = options.continuation === true ||
        (options.action && options.action !== 'new_task' && options.action !== 'switch_task' && options.action !== 'generate') ||
        CONTINUE_RE.test(message);

    if (REMOVE_RE.test(message) && !explicit.length) {
        clearActiveCharacter(conversationId);
        return { characters: [], removed: true, inherited: false, explicit: false };
    }
    if (explicit.length) {
        setActiveCharacter(conversationId, explicit);
        return { characters: explicit, removed: false, inherited: false, explicit: true };
    }
    if (isContinuation) {
        const active = getActiveCharacter(conversationId);
        return { characters: active.characters, removed: false, inherited: active.characters.length > 0, explicit: false };
    }
    return { characters: [], removed: false, inherited: false, explicit: false };
}

// Convenience wrapper used by tests and single-shot callers.
function resolveCharacterContext(options = {}) {
    const parsed = parseCharacterMessage(options.message, {
        explicitIds: options.explicitIds,
        characters: options.characters
    });
    const active = resolveActiveCharacters({
        conversationId: options.conversationId,
        explicit: parsed.characters,
        message: options.message,
        action: options.action,
        continuation: options.continuation
    });
    return { characters: active.characters, prompt: parsed.prompt, removed: active.removed, inherited: active.inherited };
}

// --- Reference selection / conditioning ---------------------------------------

function getIdentityReferences(character, options = {}) {
    const record = typeof character === 'string' ? getCharacter(character) : character;
    if (!record) return null;
    const sheet = characterPresets.getIdentitySheet(record.id);
    const base = characterIdentity.effectiveBaseImage(record, sheet);
    if (!base || (!base.filename && !base.url)) return null;
    const source = base.filename || '';
    let references = [];
    if (sheet && sheet.status === characterIdentity.STATUS.READY) {
        const picked = characterIdentity.selectReferencesForRequest(sheet, {
            text: options.text || options.scenePrompt || '',
            kind: options.kind
        });
        references = picked.references.filter((name) => name && name !== source);
    }
    return { source, references };
}

function selectRelevantReferences(character, options = {}) {
    return getIdentityReferences(character, options);
}

// Build the multi-character identity-vs-scene instruction. Uses the identity
// system's own single-character instruction for the primary (so the wording
// stays canonical) and names the additional people so the editor can tell the
// positional references apart.
function buildSceneInstruction(characters, scenePrompt) {
    const list = characters.filter(Boolean);
    if (!list.length) return String(scenePrompt || '').trim();
    const primary = list[0];
    const sheet = characterPresets.getIdentitySheet(primary.id);
    let instruction;
    if (sheet && sheet.status === characterIdentity.STATUS.READY) {
        instruction = characterIdentity.buildSceneEditInstruction(sheet, scenePrompt);
    } else {
        instruction = 'IDENTITY: Keep the exact same approved person shown in image 1. ' +
            'Preserve their facial identity, hairstyle, skin tone, body proportions and distinctive features. ' +
            'SCENE (change only this): ' + String(scenePrompt || '').trim() + ' ' +
            'DO NOT: redesign the character, change facial structure, change the hairstyle unnecessarily, ' +
            'or introduce new accessories unless the scene explicitly asks for them.';
    }
    if (list.length > 1) {
        const names = list.map((c, i) => 'image ' + (i + 1) + ' is ' + (c.name || 'the character')).join('; ');
        instruction += ' Keep every supplied reference person consistent: ' + names +
            '. Do not merge or swap their identities.';
    }
    return instruction;
}

// The structured conditioning for a set of characters. Returns filenames; the
// caller resolves them to absolute paths. Returns null when no character has a
// usable base image (identity is optional — a characterless request never
// reaches here).
function buildConditioning(characters, scenePrompt, options = {}) {
    const list = uniqueRefs(characters).map((ref) => getCharacter(ref.id)).filter(Boolean);
    if (!list.length) return null;
    const sourceNames = [];
    const referenceFilenames = [];
    const constraints = [];
    const used = [];
    for (const character of list) {
        const refs = getIdentityReferences(character, { text: scenePrompt, kind: options.kind });
        if (!refs || !refs.source) continue;
        used.push(character);
        sourceNames.push(refs.source);
        if (!options.maxReferences || referenceFilenames.length < options.maxReferences) {
            for (const name of refs.references) {
                if (name && !sourceNames.includes(name) && !referenceFilenames.includes(name)) {
                    referenceFilenames.push(name);
                }
            }
        }
        const sheet = characterPresets.getIdentitySheet(character.id);
        if (sheet && sheet.status === characterIdentity.STATUS.READY) {
            for (const constraint of characterIdentity.buildIdentityConstraints(sheet)) {
                if (!constraints.includes(constraint)) constraints.push(constraint);
            }
        }
    }
    if (!sourceNames.length) return null;
    return {
        characters: used.map(toRef),
        names: used.map((c) => c.name || 'character').join(' and '),
        sourceFilename: sourceNames[0],
        // Extra base images (2nd+ characters) are positional references too.
        referenceFilenames: sourceNames.slice(1).concat(referenceFilenames),
        instruction: buildSceneInstruction(used, scenePrompt),
        constraints
    };
}

module.exports = {
    IDENTITY_STATUS,
    CONTEXT_PATH,
    REMOVE_RE,
    CONTINUE_RE,
    getCharacter,
    getCharacterIdentity,
    listCharacterOptions,
    identityStatusOf,
    parseMentions,
    matchNames,
    parseCharacterMessage,
    getActiveCharacter,
    setActiveCharacter,
    clearActiveCharacter,
    resolveActiveCharacters,
    resolveCharacterContext,
    getIdentityReferences,
    selectRelevantReferences,
    buildSceneInstruction,
    buildConditioning
};
