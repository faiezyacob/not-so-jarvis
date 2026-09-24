/* ============================================
   JARVIS — Character Context Layer
   The single place that turns a user message into
   structured character context. `@Maya` is never
   treated as ordinary prompt text: it is resolved
   to a saved Character Identity Package, the active
   character is scoped to the conversation's
   generation flow, and every media pipeline receives
   the same conditioning (one consolidated identity
   sheet per character + structured metadata)
   instead of parsing mentions itself.

   One character contributes exactly ONE identity
   image. A scene with three characters passes three
   images, never fifteen.
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

// Identity status the picker / chat surface. `basic` means the character has an
// approved base image but no consolidated identity sheet yet.
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
    return characterPresets.getIdentityPackage(character.id);
}

// Every saved character's identity status + its single primary image, for the
// @ picker. Never exposes filesystem paths.
function listCharacterOptions() {
    return characterPresets.list().map((character) => {
        const pkg = characterPresets.getIdentityPackage(character.id);
        const image = pkg ? characterIdentity.selectIdentityImage(pkg) : null;
        return {
            id: character.id,
            name: character.name || 'Character',
            identityStatus: identityStatusOf(character, pkg),
            hasIdentity: Boolean(pkg && pkg.identitySheet && pkg.identitySheet.status === characterIdentity.SHEET_STATUS.READY),
            imageUrl: image && image.url ? image.url : ''
        };
    });
}

// Every generated-media filename owned by a saved character's identity package
// (the approved base image plus the single identity sheet). These files are
// hidden and never linked from chat messages, so a conversation delete must
// never remove them — the character preset still points at them. Returns a Set
// of basenames.
function characterMediaFilenames() {
    const names = new Set();
    for (const character of characterPresets.list()) {
        const pkg = characterPresets.getIdentityPackage(character.id);
        if (!pkg) continue;
        for (const name of characterIdentity.mediaFilenames(pkg)) {
            if (name) names.add(path.basename(String(name)));
        }
    }
    return names;
}

function identityStatusOf(character, pkg) {
    const p = pkg || (character ? characterPresets.getIdentityPackage(character.id) : null);
    if (p) {
        if (p.identitySheet && p.identitySheet.status === characterIdentity.SHEET_STATUS.READY) return IDENTITY_STATUS.READY;
        if (p.identitySheet && p.identitySheet.status === characterIdentity.SHEET_STATUS.GENERATING) return IDENTITY_STATUS.GENERATING;
        if (p.identitySheet && p.identitySheet.status === characterIdentity.SHEET_STATUS.FAILED) return IDENTITY_STATUS.FAILED;
        if (p.approvedBaseImage && (p.approvedBaseImage.filename || p.approvedBaseImage.url)) return IDENTITY_STATUS.BASIC;
    }
    return IDENTITY_STATUS.NONE;
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
// inside an email or an @mention. Names are NOT stripped from the prompt.
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

// Spec-facing alias.
function resolveCharacterMentions(message, options = {}) {
    return parseCharacterMessage(message, options);
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

// The single image a character contributes to generation: the consolidated
// identity sheet when ready, otherwise the approved base image.
function getIdentityReferences(character) {
    const record = typeof character === 'string' ? getCharacter(character) : character;
    if (!record) return null;
    const pkg = characterPresets.getIdentityPackage(record.id);
    const image = characterIdentity.selectIdentityImage(pkg);
    if (!image || !image.filename) return null;
    return { source: image.filename, references: [], kind: image.kind };
}

function selectRelevantReferences(character) {
    return getIdentityReferences(character);
}

// Every character's structured identity context, or an empty array.
function getCharactersForGeneration(characters) {
    const list = (Array.isArray(characters) ? characters : (characters ? [characters] : []))
        .map((c) => (typeof c === 'string' ? getCharacter(c) : c))
        .filter(Boolean);
    return list.map((c) => characterIdentity.buildCharacterContextEntry(c)).filter(Boolean);
}

// The structured, multi-character identity-vs-scene instruction. It names every
// character, maps each to its positional reference image and keeps identity
// separate from the scene. Identities are explicitly not blended.
function buildSceneInstruction(characters, scenePrompt) {
    const list = (characters || []).filter(Boolean);
    if (!list.length) return String(scenePrompt || '').trim();
    const scene = String(scenePrompt || '').trim();
    if (list.length === 1) {
        const pkg = characterPresets.getIdentityPackage(list[0].id);
        return characterIdentity.buildSceneEditInstruction(pkg, scene, list[0].name || 'the character');
    }
    const blocks = list.map((c, i) => {
        const pkg = characterPresets.getIdentityPackage(c.id);
        const image = characterIdentity.selectIdentityImage(pkg);
        const kind = image && image.kind === 'identity_sheet' ? 'identity sheet' : 'approved character image';
        const meta = pkg ? characterIdentity.summary(pkg.identityMetadata) : '';
        return 'CHARACTER ' + (i + 1) + ' \u2014 ' + String(c.name || 'Character').toUpperCase() +
            ' (reference image ' + (i + 1) + ')\n' +
            'Use ' + (c.name || 'this character') + '\'s ' + kind + ' to preserve their facial identity, hair, ' +
            'skin tone, body proportions, and distinctive features' + (meta ? ' (' + meta + ')' : '') + '.';
    });
    const output = 'OUTPUT: Generate ONE new standalone scene image containing the characters above. ' +
        'Each reference image is an identity reference, never the requested output and never a scene to copy. ' +
        'Never return an identity sheet or base image, a modified or recreated version of it, a collage, a ' +
        'contact sheet, a multi-panel reference sheet, a character turnaround, or a collection of character ' +
        'views. Do not copy any reference\'s panel layout, camera angle, framing, background, pose, lighting, ' +
        'composition, text, borders or labels into the new image. Unless the user explicitly asks for a ' +
        'character sheet or turnaround, the output is a single conventional frame.';
    const separation = 'CHARACTER SEPARATION\nDo not merge, swap, or blend the identities of ' +
        list.map((c) => c.name || 'Character').join(', ') + '. Each supplied reference image is a different person.';
    return blocks.join('\n\n') + '\n\nSCENE\n' + scene + '\n\n' + output + '\n\n' + separation;
}

// The structured conditioning for a set of characters. Returns filenames; the
// caller resolves them to absolute paths. Returns null when no character has a
// usable identity image. Exactly one image per character.
function buildConditioning(characters, scenePrompt, options = {}) {
    const records = uniqueRefs(characters)
        .map((ref) => (typeof ref === 'string' ? getCharacter(ref) : ref))
        .map((ref) => (ref && ref.identity ? ref : getCharacter(ref && ref.id)))
        .filter(Boolean);
    const entries = records.map((c) => characterIdentity.buildCharacterContextEntry(c)).filter(Boolean);
    if (!entries.length) return null;
    const constraints = [];
    for (const character of records) {
        const pkg = characterPresets.getIdentityPackage(character.id);
        if (!pkg) continue;
        for (const constraint of characterIdentity.buildIdentityConstraints(pkg)) {
            if (!constraints.includes(constraint)) constraints.push(constraint);
        }
    }
    const sourceFilename = entries[0].identityImage;
    const referenceFilenames = entries.slice(1).map((e) => e.identityImage)
        .filter((name) => name && name !== sourceFilename);
    return {
        characters: records.map(toRef),
        names: records.map((c) => c.name || 'character').join(' and '),
        entries,
        sourceFilename,
        referenceFilenames,
        instruction: buildSceneInstruction(records, scenePrompt),
        constraints
    };
}

// Spec-facing alias.
function buildCharacterIdentityContext(characters, scenePrompt, options = {}) {
    return buildConditioning(characters, scenePrompt, options);
}

// Compose the ordered reference filenames for a character conditioning plus the
// user's @-picker image references. The first character's identity image stays
// the edit source (image_1); other characters' identity images and the user's
// references are positional references that follow.
function combineReferenceFilenames(conditioning, options = {}) {
    if (!conditioning) return { base: '', references: [], userIndexes: [] };
    const base = conditioning.sourceFilename || '';
    const userReferences = (Array.isArray(options.userReferences) ? options.userReferences : [])
        .map((n) => String(n || '').trim())
        .filter((n) => n && n !== base);
    const sourceImages = (Array.isArray(options.sourceImages) ? options.sourceImages : [])
        .map((n) => String(n || '').trim())
        .filter((n) => n && n !== base && !userReferences.includes(n));
    const identityReferences = Array.isArray(conditioning.referenceFilenames)
        ? conditioning.referenceFilenames
        : [];
    const ordered = sourceImages.concat(userReferences, identityReferences)
        .filter((name, index, arr) => name && arr.indexOf(name) === index);
    const all = [base].concat(sourceImages, userReferences, identityReferences);
    return {
        base,
        references: ordered,
        userIndexes: userReferences.map((name) => all.indexOf(name))
    };
}

module.exports = {
    IDENTITY_STATUS,
    CONTEXT_PATH,
    REMOVE_RE,
    CONTINUE_RE,
    combineReferenceFilenames,
    getCharacter,
    getCharacterIdentity,
    listCharacterOptions,
    characterMediaFilenames,
    identityStatusOf,
    parseMentions,
    matchNames,
    parseCharacterMessage,
    resolveCharacterMentions,
    getActiveCharacter,
    setActiveCharacter,
    clearActiveCharacter,
    resolveActiveCharacters,
    resolveCharacterContext,
    getIdentityReferences,
    getCharactersForGeneration,
    selectRelevantReferences,
    buildSceneInstruction,
    buildConditioning,
    buildCharacterIdentityContext
};
