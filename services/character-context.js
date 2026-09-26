/* ============================================
   JARVIS — Character Context Layer
   The single place that turns a user message into
   structured character context. `@Maya` is never
   treated as ordinary prompt text: it is resolved
   to a saved Character Identity Package, the active
   character is scoped to the conversation's
   generation flow, and every media pipeline receives
   the same conditioning (one approved base portrait
   plus structured identity metadata) instead of parsing
   mentions itself.

   One character contributes exactly ONE primary
   identity image (the approved portrait). The
   multi-panel sheet is display/archive-only and is
   never sent to a generation model. A scene with three
   characters passes three portraits, never fifteen views.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');
const characterPresets = require('./character-presets');
const characterIdentity = require('./character-identity');
const creativeDefaults = require('./creative-defaults');

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

// True when the turn explicitly invokes a saved character — an `@Name` mention
// or an explicit picker selection, never a bare name or an inherited
// continuation. An explicit invocation means the saved character package, not
// any prior conversation/playground context, describes the person.
function hasExplicitCharacterReference(message, explicitIds) {
    const explicit = Array.isArray(explicitIds) ? explicitIds : (explicitIds ? [explicitIds] : []);
    if (explicit.some((id) => String(id || '').trim())) return true;
    return parseMentions(message).characters.length > 0;
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

// The single image a character contributes to generation: the approved base
// portrait. The multi-panel identity sheet is never sent to a model.
function getIdentityReferences(character) {
    const record = typeof character === 'string' ? getCharacter(character) : character;
    if (!record) return null;
    const pkg = characterPresets.getIdentityPackage(record.id);
    const reference = characterIdentity.selectIdentityReference(pkg);
    if (!reference || !reference.primary || !reference.primary.filename) return null;
    return {
        source: reference.primary.filename,
        references: [],
        kind: reference.primary.kind
    };
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

// --- Multi-character identity mode --------------------------------------------
//
// Two or more referenced characters need explicit ownership: every reference
// maps to exactly one named character, attributes never transfer, and every
// action/position is assigned to a named character. This is a dedicated prompt
// section built from the same identity primitives as the single-character path
// (metadata + one approved portrait each) — never a concatenation of generic
// character descriptions into one paragraph.

// A possessive/object/count join that reads naturally without a library.
function listJoin(items) {
    const list = (items || []).map((s) => String(s || '').trim()).filter(Boolean);
    if (list.length <= 1) return list[0] || '';
    if (list.length === 2) return list[0] + ' and ' + list[1];
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

function countWord(n) {
    return ({ 2: 'two', 3: 'three', 4: 'four', 5: 'five' })[n] || String(n);
}

// Drop an imperative preamble ("make an image of …") so the action section
// reads as a scene description, never as a meta instruction to the model.
function stripScenePreamble(text) {
    return String(text || '')
        .replace(/^\s*(?:please\s+)?(?:can\s+you\s+)?(?:generate|create|make|draw|render|paint|produce|show)\b[^.!?]*?\b(?:image|photo|photograph|picture|portrait|illustration|render|scene)\b\s*(?:of|with|showing|featuring|that\s+shows)?\s*/i, '')
        .replace(/^[\s:,\u2014-]+/, '')
        .replace(/\s+please\s*$/i, '')
        .trim();
}

// Names mentioned in a sentence, in first-mention order.
function mentionedNamesInOrder(sentence, names) {
    return (names || [])
        .map((name) => {
            const match = new RegExp('\\b' + escapeRe(name) + '\\b', 'i').exec(sentence);
            return match ? { name, index: match.index } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.index - b.index)
        .map((entry) => entry.name);
}

// Resolve ambiguous person references to the owning character's name. Only
// resolves when a named character appears in the same sentence as the pronoun;
// when the antecedent is genuinely unknown the user's wording is preserved.
function resolveCharacterPronouns(text, names) {
    const source = String(text || '');
    if (!names.length || !/\b(?:she|he|her|him|his|hers|they|them|their|theirs)\b/i.test(source)) {
        return source;
    }
    return source
        .split(/(?<=[.!?])\s+/)
        .map((sentence) => {
            const mentioned = mentionedNamesInOrder(sentence, names);
            if (!mentioned.length) return sentence;
            // The first-mentioned character is the clause subject; pronouns in a
            // "with/beside <other>" phrase resolve back to that subject.
            const subject = mentioned[0];
            const plural = listJoin(mentioned);
            let out = sentence;
            out = out.replace(/\b(?:she|he)\b/gi, subject);
            out = out.replace(/\b(?:her|him|his|hers)\b/gi, (match, offset, whole) => {
                const rest = whole.slice(offset + match.length);
                const next = /^\s+([A-Za-z][A-Za-z'’-]*)/.exec(rest);
                const possessive = (/^(?:her|his)$/i.test(match) && next &&
                    !/^(?:and|or|with|beside|next|near|while|when|who|that|to|in|on|at|is|was|are|were|as|has|had)\b/i.test(next[1]));
                return possessive ? subject + '\'s' : subject;
            });
            if (mentioned.length > 1) {
                out = out.replace(/\bthey\b/gi, plural);
                out = out.replace(/\bthem\b/gi, plural);
                out = out.replace(/\btheirs\b/gi, plural + '\'s');
                out = out.replace(/\btheir\b/gi, plural + '\'s');
            }
            return out;
        })
        .join(' ');
}

// Turn the user's own wording into an explicit, name-owned action text. Returns
// an empty string when no character is named (an ambiguous multi-character
// scene is preserved rather than guessed at).
function resolveActionText(characters, rawPrompt) {
    const names = (characters || []).map((c, i) => String(c.name || ('Character ' + (i + 1))));
    let text = stripScenePreamble(String(rawPrompt || '').replace(/@image\s*\d+/gi, ' '));
    if (!text) return '';
    names.forEach((name) => {
        text = text.replace(new RegExp('@' + escapeRe(name) + '\\b', 'gi'), name);
    });
    text = text.replace(/\s{2,}/g, ' ').replace(/\s+([.,!?;])/g, '$1').trim();
    if (!names.some((name) => new RegExp('\\b' + escapeRe(name) + '\\b', 'i').test(text))) return '';
    return resolveCharacterPronouns(text, names);
}

function buildCharacterActionSection(characters, rawPrompt) {
    const resolved = resolveActionText(characters, rawPrompt);
    if (!resolved) return '';
    return 'CHARACTER-SPECIFIC ACTIONS / POSITIONS\n' + resolved;
}

// Choose the best scene wording. The scene prompt usually has `@Name` stripped,
// which can leave a pronoun ("her") with no named antecedent; when the user's
// own resolved wording contains the scene text, prefer the resolved form so the
// SCENE section stays unambiguous too.
function resolveSceneText(characters, scenePrompt, options = {}) {
    const scene = String(scenePrompt || '').trim();
    const names = (characters || []).map((c, i) => String(c.name || ('Character ' + (i + 1))));
    const resolved = resolveActionText(characters, options.rawPrompt);
    if (!resolved) return resolveCharacterPronouns(scene, names);
    if (!scene) return resolved;
    // The scene prompt is usually the user's request with the `@Name` tokens
    // stripped, and may end in a pronoun ("… while Quinn lies beside her").
    // When the resolved, name-owned action text already covers the scene
    // wording, use it so the SCENE section is unambiguous too.
    const content = (s) => String(s || '')
        .toLowerCase()
        .replace(/\b(?:she|he|her|him|his|hers|they|them|their|theirs)\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    const sceneWords = content(scene).split(' ').filter(Boolean);
    const resolvedContent = content(resolved);
    const covered = sceneWords.length > 0 && sceneWords.every((word) => resolvedContent.includes(word));
    if (covered) return resolved;
    return resolveCharacterPronouns(scene, names);
}

// The dedicated multi-character instruction. Order follows the identity
// priority hierarchy: identity -> separation -> scene -> assigned actions ->
// skin-tone continuity -> output constraints.
function buildMultiCharacterInstruction(characters, scenePrompt, options = {}) {
    const list = (characters || []).filter(Boolean);
    const names = list.map((c, i) => String(c.name || ('Character ' + (i + 1))));
    // Creative defaults fill clothing/style only when the user left them
    // unspecified. They never touch identity, and every character gets its own
    // independent outfit (see SERVICES/creative-defaults.js).
    const defaults = creativeDefaults.buildCreativeDefaults(list, {
        rawPrompt: options.rawPrompt,
        scenePrompt,
        environment: options.environment,
        activity: options.activity,
        seed: options.seed,
        outfitPack: options.outfitPack,
        continuity: options.continuity,
        previousClothing: options.previousClothing,
        previousStyle: options.previousStyle,
        newOccasion: options.newOccasion
    });

    const clothingByName = new Map(
        ((defaults && defaults.clothing) || []).map((item) => [item.name, item.outfit])
    );

    const identityBlocks = list.map((c, i) => {
        const pkg = characterPresets.getIdentityPackage(c.id);
        const meta = pkg ? characterIdentity.summary(pkg.identityMetadata) : '';
        const clothing = clothingByName.get(names[i]);
        return 'CHARACTER ' + (i + 1) + ' \u2014 ' + names[i].toUpperCase() + '\n' +
            'Reference image ' + (i + 1) + ' is ' + names[i] + '\'s identity reference.\n' +
            'Preserve ' + names[i] + '\'s facial identity, distinctive facial features, hair, natural skin tone ' +
            'and undertone, body proportions, and established physical appearance' +
            (meta ? ' (' + meta + ')' : '') + '.' +
            (clothing ? '\n' + names[i] + ' wears ' + clothing + '.' : '');
    });

    const isolation = 'CHARACTER ATTRIBUTE ISOLATION\n' +
        'Each character is a separate individual. Attributes belonging to one character must never be ' +
        'transferred to another character. This applies to face shape, eyes, nose, mouth, facial structure, ' +
        'freckles and marks, hair colour, hairstyle, skin tone, skin undertone, body proportions, body build ' +
        'and complexion.';

    const separation = 'CHARACTER SEPARATION\n' +
        listJoin(names) + ' are ' + countWord(names.length) + ' distinct individuals. Keep their identities ' +
        'completely separate. Do not merge, swap, or blend their facial features, hair, skin tone, body ' +
        'proportions, or other physical characteristics. Each supplied reference image is a different person; ' +
        'do not cross-assign one character\'s attributes to another.';

    const roles = 'REFERENCE IMAGE ROLES\n' +
        names.map((name, i) => 'Reference image ' + (i + 1) + ' = ' + name + ' only.').join(' ') + ' ' +
        'Each reference is an identity source, not a scene reference. Never copy a reference\'s composition, ' +
        'pose, background, lighting, framing, or panel layout into the generated image.';

    // Resolve pronouns in the scene description itself when a named character
    // is its antecedent, so the final prompt never leaves ownership ambiguous.
    // The user's raw wording is the wider context: when the scene prompt has
    // already had the `@Name` tokens stripped, the raw prompt still names who
    // "her"/"him" refers to.
    const scene = 'SCENE\n' + resolveSceneText(list, scenePrompt, options);

    const skinLines = list.map((c, i) => {
        const pkg = characterPresets.getIdentityPackage(c.id);
        const skin = pkg && pkg.identityMetadata ? (pkg.identityMetadata.skin || {}) : {};
        const descriptor = characterIdentity.skinDescriptor(skin);
        return names[i] + ' retains ' + names[i] + '\'s natural complexion' +
            (descriptor ? ' (' + descriptor + ')' : '') + '.';
    });
    const skinLighting = 'SKIN-TONE CONTINUITY ACROSS CHARACTERS\n' + skinLines.join(' ') + ' ' +
        'Each character keeps their own underlying natural skin tone and undertone; do not normalise, swap, or ' +
        'blend one character\'s complexion into another. Apply the scene\'s lighting to every character equally: ' +
        'warm, cool, bright, or low light changes how each person\'s skin appears, but must not change their ' +
        'underlying complexion. Within each character, the face, ears, neck, shoulders, chest, arms, hands and ' +
        'legs all share that character\'s own complexion, and the neck must visually connect the face and body ' +
        'without a colour boundary.';

    const output = 'OUTPUT CONSTRAINT\n' +
        'Generate exactly ONE new standalone scene image containing the characters above. ' +
        'Each reference image is an identity reference, never the requested output and never a scene to copy. ' +
        'Never return an identity sheet or base image, a modified or recreated version of it, a collage, a ' +
        'contact sheet, a multi-panel reference sheet, a character turnaround, or a collection of character ' +
        'views. Do not copy any reference\'s panel layout, camera angle, framing, background, pose, lighting, ' +
        'composition, text, borders or labels into the new image. Unless the user explicitly asks for a ' +
        'character sheet or turnaround, the output is a single conventional frame.';

    const sections = [identityBlocks.length ? 'CHARACTER IDENTITY\n' + identityBlocks.join('\n\n') : '', isolation, separation, roles, scene];
    const actions = buildCharacterActionSection(list, options.rawPrompt);
    if (actions) sections.push(actions);
    if (defaults && defaults.section) sections.push(defaults.section);
    sections.push(skinLighting, output);
    return sections.filter(Boolean).join('\n\n');
}

// Append the creative defaults (auto clothing + coherent style) to the existing
// single-character instruction. The instruction itself is unchanged: the
// defaults are an additive section, so identity wording stays byte-for-byte and
// an explicit user clothing/style instruction simply suppresses that slot.
function appendCreativeDefaults(instruction, characters, scenePrompt, options = {}) {
    const list = (characters || []).filter(Boolean);
    if (!list.length) return instruction;
    const defaults = creativeDefaults.buildCreativeDefaults(list, {
        rawPrompt: options.rawPrompt,
        scenePrompt,
        environment: options.environment,
        activity: options.activity,
        seed: options.seed,
        outfitPack: options.outfitPack,
        gender: options.gender,
        continuity: options.continuity,
        previousClothing: options.previousClothing,
        previousStyle: options.previousStyle,
        newOccasion: options.newOccasion
    });
    if (!defaults || !defaults.section) return instruction;
    const clothing = defaults.clothing || [];
    const lines = [];
    if (clothing.length && clothing[0].outfit) {
        const name = list[0].name || 'the character';
        lines.push('CLOTHING (automatically selected to suit the scene)\n' + name + ' wears ' + clothing[0].outfit + '.');
    }
    if (defaults.style && defaults.style.package) {
        lines.push('IMAGE STYLE\n' + defaults.style.package.direction);
    }
    if (!lines.length) return instruction;
    return instruction + ' ' + lines.join(' ');
}

// The structured, multi-character identity-vs-scene instruction. A single
// character keeps the existing reference-guided instruction byte-for-byte; two
// or more use the dedicated multi-character mode.
function buildSceneInstruction(characters, scenePrompt, options = {}) {
    const list = (characters || []).filter(Boolean);
    if (!list.length) return String(scenePrompt || '').trim();
    const scene = String(scenePrompt || '').trim();
    if (list.length === 1) {
        const pkg = characterPresets.getIdentityPackage(list[0].id);
        const base = characterIdentity.buildSceneEditInstruction(pkg, scene, list[0].name || 'the character');
        // Creative defaults are additive: identity wording is untouched, the
        // resolved clothing/style only fill what the user left unspecified.
        return creativeDefaultsEnabled(options)
            ? appendCreativeDefaults(base, list, scene, options)
            : base;
    }
    return buildMultiCharacterInstruction(list, scene, options);
}

// The defaults are skipped for the video/portrait paths (which pass
// `defaults: false`) and when a caller opts out.
function creativeDefaultsEnabled(options = {}) {
    return options.defaults !== false;
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
    // The options the creative-defaults layer needs: the raw user wording (to
    // detect explicit clothing/style) plus the scene context and a seed.
    const sceneOptions = {
        rawPrompt: options.rawPrompt,
        scenePrompt,
        environment: options.environment,
        activity: options.activity,
        timeOfDay: options.timeOfDay,
        weather: options.weather,
        seed: options.seed,
        outfitPack: options.outfitPack,
        gender: options.gender,
        defaults: options.defaults,
        // Continuity: preserve the previous automatic clothing/style on a
        // follow-up unless the user asks to change them.
        continuity: options.continuity,
        previousClothing: options.previousClothing,
        previousStyle: options.previousStyle,
        newOccasion: options.newOccasion
    };
    const multiCharacter = records.length >= 2 ? {
        count: records.length,
        names: records.map((c) => c.name || 'character'),
        section: buildMultiCharacterInstruction(records, scenePrompt, sceneOptions)
    } : null;
    const defaults = options.defaults === false
        ? null
        : creativeDefaults.buildCreativeDefaults(records, sceneOptions);
    return {
        characters: records.map(toRef),
        names: records.map((c) => c.name || 'character').join(' and '),
        entries,
        sourceFilename,
        referenceFilenames,
        sheetFilenames: [],
        instruction: buildSceneInstruction(records, scenePrompt, sceneOptions),
        constraints,
        multiCharacter,
        creativeDefaults: defaults
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
    const identityReferences = (Array.isArray(conditioning.referenceFilenames)
        ? conditioning.referenceFilenames
        : [])
        .map((n) => String(n || '').trim())
        .filter((n) => n && n !== base);
    // Identity sheets are intentionally not generation references. Qwen can
    // reproduce their grid even when they are supplied as secondary images.
    const userReferences = (Array.isArray(options.userReferences) ? options.userReferences : [])
        .map((n) => String(n || '').trim())
        .filter((n) => n && n !== base);
    const sourceImages = (Array.isArray(options.sourceImages) ? options.sourceImages : [])
        .map((n) => String(n || '').trim())
        .filter((n) => n && n !== base && !userReferences.includes(n)
            && !identityReferences.includes(n));
    // Character portraits lead (so "reference image N" stays character-accurate),
    // followed by explicit sources and the user's @-picker references.
    const ordered = identityReferences.concat(sourceImages, userReferences)
        .filter((name, index, arr) => name && arr.indexOf(name) === index);
    const all = [base].concat(identityReferences, sourceImages, userReferences);
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
    hasExplicitCharacterReference,
    getActiveCharacter,
    setActiveCharacter,
    clearActiveCharacter,
    resolveActiveCharacters,
    resolveCharacterContext,
    getIdentityReferences,
    getCharactersForGeneration,
    selectRelevantReferences,
    buildSceneInstruction,
    buildMultiCharacterInstruction,
    buildCharacterActionSection,
    appendCreativeDefaults,
    resolveCharacterPronouns,
    resolveActionText,
    resolveSceneText,
    buildConditioning,
    buildCharacterIdentityContext
};
