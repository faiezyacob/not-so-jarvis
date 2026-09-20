/* ============================================
   JARVIS — Creative Playground Service
   Orchestrates the Creative Playground: builds a
   concept from a theme + character preset + locks,
   persists the per-conversation session, renders
   the persisted concept card, and translates the
   concept into a request for the existing image
   prompt builder. The concept is creative direction,
   never the final Krea2 prompt.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const characterPresets = require('../character-presets');
const characterGen = require('./character');
const state = require('./state');
const themes = require('./themes');
const conceptEngine = require('./concept');

const ACTIONS = {
    SURPRISE: 'surprise',
    AGAIN: 'again',
    MODIFY: 'modify',
    GENERATE: 'generate',
    SAVE: 'save',
    USE_CONTEXT: 'use_context'
};

const STATUS = {
    PREVIEW: 'preview',
    SAVED: 'saved',
    USED: 'used'
};

const MARKER_RE = /\[\[playground:(\{[^\n]*?\})\]\]/g;

function markerLine(card) {
    return '[[playground:' + JSON.stringify(card) + ']]';
}

function themeLabel(themeId) {
    return themes.getTheme(themeId).label;
}

function resolveCharacter(characterId) {
    if (!characterId) return null;
    return characterPresets.get(characterId);
}

function makeId() {
    return 'pg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

// Track the signatures of random identities already used in this session so a
// re-roll does not immediately repeat one. Bounded to the recent window.
function rememberIdentity(session, concept) {
    const list = Array.isArray(session.identitySignatures) ? session.identitySignatures.slice() : [];
    const signature = concept && concept.identitySignature;
    if (signature && !list.includes(signature)) list.push(signature);
    session.identitySignatures = list.slice(-12);
}

// Track the outfit signatures already used in this session so consecutive
// Surprises don't repeat the exact same look. Like identity tracking this never
// touches the character, only the wardrobe.
function rememberOutfit(session, concept) {
    const list = Array.isArray(session.outfitSignatures) ? session.outfitSignatures.slice() : [];
    const signature = concept && concept.outfitSignature;
    if (signature && !list.includes(signature)) list.push(signature);
    session.outfitSignatures = list.slice(-12);
}

function previousOutfitArchetype(previous) {
    const concept = previous && previous.concept;
    return concept && concept.outfitArchetype ? concept.outfitArchetype : '';
}

function buildCard(session, character) {
    const concept = session.concept || {};
    return {
        id: session.id,
        status: session.status || STATUS.PREVIEW,
        themeId: session.themeId,
        theme: themeLabel(session.themeId),
        mode: session.mode,
        character: character ? { id: character.id, name: character.name || 'Character' } : null,
        // A saved character's name, or the temporary name of a random one.
        characterName: character ? (character.name || 'Character') : (concept.name || ''),
        locks: conceptEngine.normalizeLocks(session.locks),
        // The independent generator controls that produced a random character
        // (null for saved characters) and the deterministic seed, so the person
        // can be shown and reproduced.
        characterProfile: concept.characterProfile || session.characterProfile || null,
        characterSeed: concept.characterSeed || null,
        title: concept.title || '',
        description: concept.description || '',
        concept: {
            characterProfile: concept.characterProfile || session.characterProfile || null,
            characterSeed: concept.characterSeed || null,
            subject: concept.subject || '',
            appearanceCategory: concept.appearanceCategory || '',
            appearanceCategoryLabel: concept.appearanceCategoryLabel || '',
            appearance: concept.appearance || '',
            hair: concept.hair || '',
            name: concept.name || '',
            category: concept.category || '',
            outfit: concept.outfit || '',
            environment: concept.environment || '',
            activity: concept.activity || '',
            lighting: concept.lighting || '',
            camera: concept.camera || '',
            composition: concept.composition || '',
            mood: concept.mood || '',
            style: concept.style || '',
            technique: concept.technique || '',
            techniqueLabel: concept.techniqueLabel || '',
            texture: concept.texture || '',
            aspectRatio: concept.aspectRatio || ''
        }
    };
}

function renderContent(session, character) {
    const card = buildCard(session, character);
    const title = card.title || 'Creative concept';
    return '**Creative Playground \u2014 ' + title + '**\n\n' + markerLine(card);
}

// The concept's human-readable text. Used by "Use as Chat Context" so the
// concept becomes part of the conversation the model can talk about.
function conceptText(session, character) {
    const card = buildCard(session, character);
    const c = card.concept;
    const lines = ['Creative Playground concept \u2014 ' + card.title, '', card.description, ''];
    if (card.character) lines.push('Character: ' + card.character.name);
    else if (c.name) lines.push('Character: ' + c.name);
    if (c.subject) lines.push('Identity: ' + c.subject);
    if (c.appearanceCategoryLabel) lines.push('Appearance category: ' + c.appearanceCategoryLabel);
    if (c.appearance) lines.push('Appearance: ' + c.appearance);
    if (c.hair) lines.push('Hair: ' + c.hair);
    if (c.outfit) lines.push('Outfit: ' + c.outfit);
    if (c.category) lines.push('Category: ' + c.category);
    if (c.activity) lines.push('Activity: ' + c.activity);
    if (c.environment) lines.push('Environment: ' + c.environment);
    if (c.lighting) lines.push('Lighting: ' + c.lighting);
    if (c.camera) lines.push('Camera: ' + c.camera);
    if (c.composition) lines.push('Composition: ' + c.composition);
    if (c.techniqueLabel) lines.push('Technique: ' + c.techniqueLabel);
    if (c.texture) lines.push('Texture / material: ' + c.texture);
    if (c.mood) lines.push('Mood: ' + c.mood);
    if (c.style) lines.push('Style: ' + c.style);
    if (c.aspectRatio) lines.push('Suggested aspect ratio: ' + c.aspectRatio);
    return lines.join('\n');
}

// Build (or re-roll) the active concept session for a conversation.
function start(input = {}) {
    const conversationId = String(input.conversationId || '').trim();
    const theme = themes.getTheme(input.themeId);
    const character = resolveCharacter(input.characterId);
    let mode = character ? 'character' : (conceptEngine.MODES.includes(input.mode) ? input.mode : 'none');
    const previous = state.getSession(conversationId);
    const avoidSignatures = previous && Array.isArray(previous.identitySignatures) ? previous.identitySignatures : [];
    const avoidOutfitSignatures = previous && Array.isArray(previous.outfitSignatures) ? previous.outfitSignatures : [];
    // Explicit controls, or the previous session's, or fully random.
    const profile = characterGen.normalizeProfile(
        input.profile || (previous && previous.characterProfile)
    );
    // A constrained profile is a character request: never let "general
    // exploration" silently drop the appearance/age/gender controls.
    if (mode === 'none' && !characterGen.isRandomProfile(profile)) mode = 'random_character';
    const concept = conceptEngine.assembleConcept({
        theme,
        mode,
        character,
        locks: conceptEngine.normalizeLocks(input.locks),
        previous: previous && previous.concept,
        category: input.category,
        profile,
        // A new Surprise with "Random new character" always casts a new person.
        freshIdentity: mode === 'random_character',
        avoidSignatures,
        avoidOutfitSignatures,
        previousOutfitArchetype: previousOutfitArchetype(previous),
        rng: input.rng
    });
    const now = new Date().toISOString();
    const session = {
        id: makeId(),
        conversationId,
        themeId: theme.id,
        mode,
        characterId: character ? character.id : null,
        characterProfile: profile,
        locks: conceptEngine.normalizeLocks(input.locks),
        concept,
        status: STATUS.PREVIEW,
        createdAt: now,
        updatedAt: now,
        // Carry the recent identity/outfit history forward so repeated Surprises
        // in one conversation don't cycle back through the same few people/looks.
        identitySignatures: avoidSignatures.slice(-12),
        outfitSignatures: avoidOutfitSignatures.slice(-12)
    };
    rememberIdentity(session, concept);
    rememberOutfit(session, concept);
    state.setSession(conversationId, session);
    return session;
}

function again(session, options = {}) {
    if (!session) return null;
    const theme = themes.getTheme(session.themeId);
    const character = resolveCharacter(session.characterId);
    const avoidSignatures = Array.isArray(session.identitySignatures) ? session.identitySignatures : [];
    const avoidOutfitSignatures = Array.isArray(session.outfitSignatures) ? session.outfitSignatures : [];
    // "Surprise Me Again" keeps the theme and builds a new scene/outfit. The
    // character is preserved while the Identity lock is set; otherwise a new
    // person is cast from the same appearance/age/gender controls. (A saved
    // character is always preserved.)
    const profile = characterGen.normalizeProfile(session.characterProfile);
    const concept = conceptEngine.assembleConcept({
        theme,
        mode: session.mode,
        character,
        locks: session.locks,
        previous: session.concept,
        profile,
        avoidSignatures,
        avoidOutfitSignatures,
        previousOutfitArchetype: session.concept && session.concept.outfitArchetype ? session.concept.outfitArchetype : '',
        rng: options.rng
    });
    session.concept = concept;
    rememberIdentity(session, concept);
    rememberOutfit(session, concept);
    session.status = STATUS.PREVIEW;
    session.updatedAt = new Date().toISOString();
    state.setSession(session.conversationId, session);
    return session;
}

// Apply a modify action: merge any newly discovered locks, optionally re-roll
// the scenario, then apply the requested field changes on top.
function modify(session, action = {}) {
    if (!session) return null;
    // Merge only the locks the action explicitly names, so a modify that adds
    // one lock never silently clears the others carried by the session.
    const locks = Object.assign({}, session.locks);
    if (action.locks && typeof action.locks === 'object') {
        const provided = conceptEngine.normalizeLocks(action.locks);
        for (const key of conceptEngine.LOCKABLE) {
            if (Object.prototype.hasOwnProperty.call(action.locks, key)) locks[key] = provided[key];
        }
    }
    const changes = Object.assign({}, action.changes);
    // A named subcategory forces a re-roll inside that category; the rest of
    // the explicit changes are layered on top. `action.category` is an explicit
    // override (used by the API); `changes.category` comes from typed follow-ups.
    let category = String(action.category || changes.category || '').trim();
    delete changes.category;
    let themeChanged = false;
    if (changes.themeId && themes.getTheme(changes.themeId).id !== session.themeId) {
        session.themeId = themes.getTheme(changes.themeId).id;
        themeChanged = true;
        // The category belonged to the old theme; only keep it if the new theme
        // actually has it.
        if (category && !themes.resolveCategory(themes.getTheme(session.themeId), category)) category = '';
    }
    delete changes.themeId;

    // Explicit character-control changes merge onto the session's profile. A
    // changed profile invalidates the current identity (the person no longer
    // matches the constraints) and casts a new one; untouched controls never
    // regenerate the character.
    const baseProfile = characterGen.normalizeProfile(session.characterProfile);
    const requestedProfile = action.profile
        ? characterGen.normalizeProfile(Object.assign({}, baseProfile, action.profile))
        : baseProfile;
    const profileChanged = action.profile ? !characterGen.sameProfile(requestedProfile, baseProfile) : false;

    const theme = themes.getTheme(session.themeId);
    const character = resolveCharacter(session.characterId);
    const reroll = Boolean(action.reroll || category || themeChanged || profileChanged);
    let concept;
    if (reroll) {
        concept = conceptEngine.assembleConcept({
            theme,
            mode: session.mode,
            character,
            locks,
            previous: session.concept,
            category,
            profile: requestedProfile,
            freshIdentity: profileChanged,
            avoidSignatures: Array.isArray(session.identitySignatures) ? session.identitySignatures : [],
            avoidOutfitSignatures: Array.isArray(session.outfitSignatures) ? session.outfitSignatures : [],
            previousOutfitArchetype: session.concept && session.concept.outfitArchetype ? session.concept.outfitArchetype : '',
            rng: action.rng
        });
        concept = conceptEngine.applyChanges(concept, changes);
        rememberIdentity(session, concept);
    } else {
        concept = conceptEngine.applyChanges(session.concept, changes);
    }
    rememberOutfit(session, concept);
    session.locks = locks;
    session.characterProfile = requestedProfile;
    session.concept = concept;
    session.status = STATUS.PREVIEW;
    session.updatedAt = new Date().toISOString();
    state.setSession(session.conversationId, session);
    return session;
}

function save(session, character) {
    if (!session) return null;
    const card = buildCard(session, character);
    const record = {
        id: session.id,
        title: card.title,
        description: card.description,
        themeId: session.themeId,
        theme: card.theme,
        mode: session.mode,
        characterId: session.characterId,
        characterName: card.characterName,
        locks: card.locks,
        concept: card.concept,
        createdAt: new Date().toISOString()
    };
    state.addSaved(record);
    session.status = STATUS.SAVED;
    session.updatedAt = new Date().toISOString();
    state.setSession(session.conversationId, session);
    return session;
}

function markUsed(session) {
    if (!session) return null;
    session.status = STATUS.USED;
    session.updatedAt = new Date().toISOString();
    state.setSession(session.conversationId, session);
    return session;
}

// Translate the concept into the structured request consumed by
// imageGenerator.buildImagePrompt. The builder owns the final prompt wording.
function buildImageRequest(session) {
    if (!session) return null;
    const theme = themes.getTheme(session.themeId);
    const constraints = conceptEngine.conceptToConstraints(session.concept, {
        locks: session.locks,
        mode: session.mode
    });
    // Theme-level guidance (e.g. Instagram's casual, unposed direction) is
    // appended as explicit constraints so the prompt builder honors it.
    if (Array.isArray(theme.constraints)) {
        for (const value of theme.constraints) {
            const text = String(value || '').trim();
            if (text) constraints.push(text);
        }
    }
    return {
        intent: 'image_generation',
        user_prompt: conceptEngine.conceptToDirection(session.concept),
        previous_prompt: '',
        creative_mode: 'light',
        explicit_constraints: constraints
    };
}

// A concept is "open" only while it is an untouched preview. Once it is saved
// or used, typed follow-ups flow to the normal router so an active image task
// is never shadowed by a parked concept. Explicit card actions still work.
function isOpen(session) {
    return Boolean(session && session.status === STATUS.PREVIEW);
}

function classifyMessage(message, session) {
    return conceptEngine.interpretContextMessage(message, {
        open: Boolean(session),
        themeId: session ? session.themeId : ''
    });
}

function normalizeAction(value) {
    if (!value) return null;
    const type = typeof value === 'string' ? value : (value.type || value.action);
    const key = String(type || '').trim().toLowerCase();
    if (!Object.values(ACTIONS).includes(key)) return null;
    const out = { type: key };
    if (value && typeof value === 'object') {
        if (value.conceptId) out.conceptId = String(value.conceptId);
        if (value.direction) out.direction = String(value.direction);
        if (value.themeId) out.themeId = String(value.themeId);
        if (value.category) out.category = String(value.category);
        if (value.characterId) out.characterId = String(value.characterId);
        if (value.mode) out.mode = String(value.mode);
        if (value.locks) out.locks = value.locks;
        if (value.changes) out.changes = value.changes;
        if (value.reroll) out.reroll = true;
        // Character controls may arrive nested or flat; merge both shapes.
        const profile = {};
        if (value.profile && typeof value.profile === 'object') Object.assign(profile, value.profile);
        for (const key2 of ['appearance', 'age', 'gender']) {
            if (value[key2]) profile[key2] = value[key2];
        }
        if (Object.keys(profile).length) out.profile = profile;
    }
    return out;
}

module.exports = {
    ACTIONS,
    STATUS,
    MARKER_RE,
    markerLine,
    buildCard,
    renderContent,
    conceptText,
    themeLabel,
    listThemes: themes.listThemes,
    getSession: state.getSession,
    removeSession: state.removeSession,
    listSaved: state.listSaved,
    isOpen,
    save,
    markUsed,
    start,
    again,
    modify,
    buildImageRequest,
    classifyMessage,
    normalizeAction,
    resolveCharacter,
    listCharacterOptions: characterGen.listProfileOptions
};
