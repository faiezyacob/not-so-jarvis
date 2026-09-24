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
const characterIdentity = require('../character-identity');
const state = require('./state');
const themes = require('./themes');
const conceptEngine = require('./concept');
const outfitPacks = require('./outfit-packs');
const characterStudio = require('../character-studio');

const ACTIONS = {
    SURPRISE: 'surprise',
    AGAIN: 'again',
    MODIFY: 'modify',
    GENERATE: 'generate',
    SAVE: 'save',
    USE_CONTEXT: 'use_context',
    RETRY_PORTRAIT: 'retry_portrait',
    // Character Identity System actions. A candidate base image must be
    // explicitly approved before an identity sheet is generated.
    IDENTITY_START: 'identity_start',
    IDENTITY_REGENERATE: 'identity_regenerate',
    IDENTITY_APPROVE: 'identity_approve',
    IDENTITY_SHEET_REGENERATE: 'identity_sheet_regenerate',
    // Save the concept as a named character AND create its identity sheet in
    // the same turn (the character preview becomes the approved base).
    SAVE_CHARACTER: 'save_character'
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

// The identity a face image belongs to. Same key => the same person, so a
// scene-only re-roll can reuse the existing portrait instead of re-rendering it.
function characterIdentityKey(session) {
    const concept = session && session.concept ? session.concept : {};
    return concept.identitySignature || concept.subject || '';
}

// Compact identity summary for the concept card. The full identity package is
// fetched through GET /api/characters/:id/identity by the viewer, so the marker
// stays small. Null until the character has an identity sheet attached.
function identitySummary(session, character) {
    const record = character || resolveCharacter(session && session.characterId);
    if (!record) return null;
    const sheet = characterPresets.getIdentitySheet(record.id);
    if (!sheet) return null;
    return {
        characterId: record.id,
        name: record.name || 'Character',
        status: sheet.status,
        identityStatus: sheet.identity.status,
        referenceCount: characterIdentity.allReferences(sheet).length,
        requiredTotal: characterIdentity.planReferences(record).filter((e) => e.required !== false).length,
        baseImageUrl: characterIdentity.effectiveBaseImage(record, sheet)
            ? characterIdentity.effectiveBaseImage(record, sheet).url
            : '',
        hasLegacyBase: characterIdentity.hasLegacyBase(record, sheet)
    };
}

function buildCard(session, character) {
    const concept = session.concept || {};
    return {
        id: session.id,
        revision: session.revision || 1,
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
        // The pre-rendered face of a random character, shown in the card before
        // the full scene is generated. Null until the face stage runs.
        characterImage: session.characterImage && session.characterImage.url
            ? {
                url: session.characterImage.url,
                width: session.characterImage.width,
                height: session.characterImage.height,
                seed: session.characterImage.seed
            }
            : null,
        // Character Identity System: the approved/identity-sheet state for the
        // selected (or session-created) character, so the card can show the
        // approval gate and a "View Identity" entry point.
        identity: identitySummary(session, character),
        // The active Outfit Pack (wardrobe personality) and any custom outfit, so
        // the Surprise Me popover can reflect the open concept's wardrobe.
        outfitPack: concept.outfitPack || '',
        outfitPackLabel: concept.outfitPackLabel || '',
        outfitPackCustom: concept.outfitPackCustom || '',
        title: concept.title || '',
        description: concept.description || '',
        concept: {
            characterProfile: concept.characterProfile || session.characterProfile || null,
            characterSeed: concept.characterSeed || null,
             subject: concept.subject || '',
             identity: concept.identity || null,
             identitySignature: concept.identitySignature || '',
            appearanceCategory: concept.appearanceCategory || '',
            appearanceCategoryLabel: concept.appearanceCategoryLabel || '',
            appearance: concept.appearance || '',
            hair: concept.hair || '',
            name: concept.name || '',
            userPrompt: concept.userPrompt || '',
            category: concept.category || '',
            outfit: concept.outfit || '',
            outfitPack: concept.outfitPack || '',
            outfitPackLabel: concept.outfitPackLabel || '',
            outfitPackCustom: concept.outfitPackCustom || '',
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
    if (c.userPrompt) lines.push('Prompt: ' + c.userPrompt);
    if (c.outfit) lines.push('Outfit: ' + c.outfit);
    if (c.outfitPackLabel) lines.push('Outfit pack: ' + c.outfitPackLabel);
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
        // The Outfit Pack is a character attribute; it composes the specific
        // outfit from the pack's wardrobe space.
        outfitPack: input.outfitPack,
        outfitPackCustom: input.outfitPackCustom,
        contextText: input.contextText,
        // A user's own prompt (with a saved or random character) replaces the
        // theme's randomised scene; the character identity is untouched.
        userPrompt: input.customPrompt,
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
        outfitPack: concept.outfitPack || '',
        outfitPackCustom: concept.outfitPackCustom || '',
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
    const characterSnapshot = character
        ? characterStudio.normalizeCharacter(character)
        : (concept.identity ? characterStudio.normalizeCharacter({
            name: concept.name,
            identity: concept.identity,
            identityText: concept.subject,
            identitySignature: concept.identitySignature,
            appearance: concept.appearance,
            hair: concept.hair,
            provenance: { type: 'session-generated' }
        }) : null);
    session.revision = 1;
    session.characterRef = character ? { id: character.id, revision: character.revision || 1 } : null;
    session.characterSnapshot = characterSnapshot;
    session.scene = createScene(concept, theme);
    session.composition = createCompositionSnapshot(session);
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
        // The pack persists across "Surprise Me Again" (it is a wardrobe
        // personality) and recomposes a new specific outfit from it.
        outfitPack: session.outfitPack,
        outfitPackCustom: session.outfitPackCustom,
        contextText: options.contextText,
        // A user prompt is preserved: "Surprise Me Again" re-runs the same
        // prompt instead of silently dropping the user's own wording.
        userPrompt: session.concept && session.concept.userPrompt,
        avoidSignatures,
        avoidOutfitSignatures,
        previousOutfitArchetype: session.concept && session.concept.outfitArchetype ? session.concept.outfitArchetype : '',
        rng: options.rng
    });
    session.concept = concept;
    session.scene = createScene(concept, theme);
    session.revision = (Number(session.revision) || 1) + 1;
    session.composition = createCompositionSnapshot(session);
    session.outfitPack = concept.outfitPack || '';
    session.outfitPackCustom = concept.outfitPackCustom || '';
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

    // Outfit Pack changes arrive either from the popover (`action.outfitPack`)
    // or from typed context ("make the outfit suitable for the gym"). A new pack
    // is a true replacement: a complete outfit is composed from the new pack's
    // wardrobe, never appended to the previous clothing.
    const explicitPack = Object.prototype.hasOwnProperty.call(action, 'outfitPack') ? action.outfitPack : undefined;
    const changePack = Object.prototype.hasOwnProperty.call(changes, 'outfitPack') ? changes.outfitPack : undefined;
    const explicitCustom = action.outfitPackCustom;
    const changeCustom = changes.outfitPackCustom;
    delete changes.outfitPack;
    delete changes.outfitPackCustom;
    const packProvided = explicitPack !== undefined || changePack !== undefined;
    const requestedPack = String(explicitPack !== undefined ? explicitPack : (changePack !== undefined ? changePack : '')).trim();
    const requestedCustom = String(explicitCustom || changeCustom || '').trim();
    const effectivePack = packProvided ? requestedPack : (session.outfitPack || '');
    const effectiveCustom = packProvided ? requestedCustom : (session.outfitPackCustom || '');

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
    // A precise one-field re-roll never re-runs the scenario roll; it is a
    // surgical change to the current concept only.
    const fieldReroll = String(action.rerollField || '').trim().toLowerCase();
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
            // Preserve an existing user prompt unless the action replaces it.
            userPrompt: action.customPrompt !== undefined
                ? action.customPrompt
                : (session.concept && session.concept.userPrompt),
            rng: action.rng
        });
        concept = conceptEngine.applyChanges(concept, changes);
        rememberIdentity(session, concept);
    } else {
        concept = conceptEngine.applyChanges(session.concept, changes);
    }
    // Recompose only when the pack actually changed or the scenario was
    // re-rolled — a scene-only tweak keeps the exact outfit (applyChanges).
    // An Outfit field re-roll recomposes from the same pack (never appends to
    // the previous look); a locked outfit still wins.
    if (effectivePack && (packProvided || reroll || fieldReroll === 'outfit')) {
        concept = conceptEngine.applyOutfitPack(concept, {
            packId: effectivePack,
            customText: effectiveCustom,
            rng: action.rng,
            // A locked outfit is preserved; the pack is recorded as metadata only.
            preserve: Boolean(locks.outfit && concept.outfit),
            gender: concept.identity && concept.identity.gender ? concept.identity.gender : '',
            avoidSignatures: Array.isArray(session.outfitSignatures) ? session.outfitSignatures : [],
            previousArchetype: concept.outfitArchetype || '',
            avoidLayers: (() => {
                const context = action.direction ? outfitPacks.contextModifiers(action.direction) : null;
                return Boolean(context && context.warm && !context.cold);
            })()
        });
    } else if (packProvided && !effectivePack) {
        // The pack was explicitly cleared; keep the clothing but drop the metadata.
        concept.outfitPack = '';
        concept.outfitPackLabel = '';
        concept.outfitPackCustom = '';
    }
    // A surgical field re-roll draws the new value from the same theme pool the
    // scenario was drawn from. An Outfit re-roll with no pack falls through to
    // the theme's flat outfit pool; other fields reroll directly.
    if (fieldReroll && fieldReroll !== 'outfit' && !reroll) {
        concept = conceptEngine.rerollField(concept, theme, fieldReroll, action.rng);
    } else if (fieldReroll === 'outfit' && !effectivePack && !reroll && concept.outfit) {
        // A user prompt owns the clothing too — never invent some when the
        // prompt blanked it (rerollField is guarded downstream by this check).
        concept = conceptEngine.rerollField(concept, theme, 'outfit', action.rng);
    }
    rememberOutfit(session, concept);
    session.locks = locks;
    session.characterProfile = requestedProfile;
    session.outfitPack = concept.outfitPack || '';
    session.outfitPackCustom = concept.outfitPackCustom || '';
    session.concept = concept;
    session.scene = createScene(concept, theme);
    session.revision = (Number(session.revision) || 1) + 1;
    session.composition = createCompositionSnapshot(session);
    session.status = STATUS.PREVIEW;
    session.updatedAt = new Date().toISOString();
    state.setSession(session.conversationId, session);
    return session;
}

function save(session, character) {
    if (!session) return null;
    if (session.mode === 'none' || (!session.characterSnapshot && !character)) {
        const error = new Error('A scene without a character cannot be saved as a character.');
        error.code = 'characterless_scene';
        throw error;
    }
    const card = buildCard(session, character);
    const record = {
        id: session.id,
        schemaVersion: 1,
        revision: session.revision || 1,
        conversationId: session.conversationId,
        title: card.title,
        description: card.description,
        themeId: session.themeId,
        theme: card.theme,
        mode: session.mode,
        characterId: session.characterId,
        characterName: card.characterName,
        locks: card.locks,
        concept: card.concept,
        scene: session.scene || null,
        characterRef: session.characterRef || null,
        characterSnapshot: session.characterSnapshot || null,
        promptRequest: session.promptRequest || null,
        generatedPrompt: session.generatedPrompt || null,
        composition: Object.assign(createCompositionSnapshot(session), { status: STATUS.SAVED }),
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
    const c = session.concept || {};
    const userPrompt = String(c.userPrompt || '').trim();
    // Theme-level guidance (e.g. Instagram's casual, unposed direction) is
    // appended as explicit constraints so the prompt builder honors it. A user
    // prompt is authoritative, so the theme's scene guidance is skipped then.
    if (!userPrompt && Array.isArray(theme.constraints)) {
        for (const value of theme.constraints) {
            const text = String(value || '').trim();
            if (text) constraints.push(text);
        }
    }
    const identity = session.characterSnapshot && session.characterSnapshot.identity;
    const request = {
        intent: 'image_generation',
        subject: {
            identityText: (session.characterSnapshot && session.characterSnapshot.identityText) || c.subject || '',
            appearance: c.appearance || '',
            hair: c.hair || '',
            age: identity && identity.age,
            gender: identity && identity.gender,
            appearanceCategory: c.appearanceCategory || (identity && identity.appearanceCategory) || '',
            identitySignature: (session.characterSnapshot && session.characterSnapshot.identitySignature) || c.identitySignature || ''
        },
        scene: {
            activity: c.activity || '', environment: c.environment || '', outfit: c.outfit || '',
            lighting: c.lighting || '', camera: c.camera || '', composition: c.composition || '',
            mood: c.mood || '', style: c.style || '', technique: c.technique || '', texture: c.texture || '',
            customDirection: userPrompt || c.customDirection || ''
        },
        user_prompt: conceptEngine.conceptToDirection(session.concept),
        previous_prompt: '',
        creative_mode: 'light',
        explicit_constraints: constraints,
        authoritativeConstraints: constraints,
        creativeHints: Array.isArray(theme.constraints) ? theme.constraints : [],
        characterRevision: session.characterRef && session.characterRef.revision,
        sceneRevision: session.revision
    };
    session.promptRequest = request;
    session.composition = createCompositionSnapshot(session);
    state.setSession(session.conversationId, session);
    return request;
}

// The pre-rendered face request: identity-only creative direction handed to the
// same prompt builder as the full concept. The builder owns the final prompt.
function buildPortraitRequest(session) {
    if (!session) return null;
    const concept = session.concept || {};
    if (!concept.subject && !concept.appearance && !concept.hair) return null;
    const request = {
        intent: 'image_generation',
        subject: {
            identityText: concept.subject,
            appearance: concept.appearance,
            hair: concept.hair,
            appearanceCategory: concept.appearanceCategory,
            identitySignature: concept.identitySignature
        },
        scene: {},
        user_prompt: conceptEngine.conceptToPortraitDirection(concept),
        previous_prompt: '',
        creative_mode: 'light',
        explicit_constraints: conceptEngine.conceptToPortraitConstraints(concept),
        authoritativeConstraints: conceptEngine.conceptToPortraitConstraints(concept),
        creativeHints: [],
        portrait: true
    };
    return request;
}

function createScene(concept, theme) {
    const c = concept || {};
    return {
        id: 'scene_' + Date.now().toString(36), schemaVersion: 1,
        themeId: theme && theme.id || '', categoryId: c.categoryId || '', activity: c.activity || '',
        environment: c.environment || '', outfit: c.outfit || '', outfitPack: c.outfitPack || '',
        lighting: c.lighting || '', camera: c.camera || '', composition: c.composition || '', mood: c.mood || '',
        style: c.style || '', technique: c.technique || '', texture: c.texture || '', aspectRatio: c.aspectRatio || '',
        customDirection: c.customDirection || '', userPrompt: c.userPrompt || '',
        locks: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 1
    };
}

function createCompositionSnapshot(session) {
    return {
        id: session.id, conversationId: session.conversationId, revision: session.revision || 1,
        characterRef: session.characterRef || null,
        characterSnapshot: session.characterSnapshot || null,
        scene: session.scene || null, promptRequest: session.promptRequest || null,
        generatedPrompt: session.generatedPrompt || null,
        characterReferenceImage: session.characterSnapshot && session.characterSnapshot.portraitReference || session.characterImage || null,
        status: session.status || STATUS.PREVIEW, createdAt: session.createdAt, updatedAt: session.updatedAt
    };
}

// Only a freshly cast random character pre-renders a face: a saved character's
// identity is already known and a no-character concept has nobody to show. A
// portrait is regenerated only when the identity actually changed — a re-roll
// that keeps the person via the Identity lock reuses the existing face.
function needsCharacterImage(session) {
    if (!session || session.mode !== 'random_character') return false;
    const key = characterIdentityKey(session);
    if (!key) return false;
    const image = session.characterImage;
    if (!image || !image.url) return true;
    return image.identitySignature !== key;
}

function setCharacterImage(session, image) {
    if (!session) return session;
    if (!image || !image.url) return session;
    const portrait = {
        url: image.url,
        filename: image.filename || '',
        prompt: image.prompt || '',
        seed: image.seed,
        width: image.width,
        height: image.height,
        identitySignature: characterIdentityKey(session),
        characterRevision: session.characterSnapshot && session.characterSnapshot.revision || 1,
        createdAt: new Date().toISOString()
    };
    session.characterImage = portrait;
    if (session.characterSnapshot) session.characterSnapshot.portraitReference = Object.assign({}, portrait);
    if (session.characterId) characterPresets.setPortrait(session.characterId, portrait);
    session.composition = createCompositionSnapshot(session);
    session.updatedAt = new Date().toISOString();
    state.setSession(session.conversationId, session);
    return session;
}

// A concept is "open" only while it is an untouched preview. Once it is saved
// or used, typed follow-ups flow to the normal router so an active image task
// is never shadowed by a parked concept. Explicit card actions still work.
// Attach the Character Identity package to the open session. A candidate
// character created by the identity flow is bound to the session so the card
// (and later actions) can resolve it.
function setIdentityCharacter(session, characterId) {
    if (!session) return session;
    session.identityCharacterId = characterId || null;
    session.updatedAt = new Date().toISOString();
    state.setSession(session.conversationId, session);
    return session;
}

// Resolve the character record the identity flow operates on: an explicit
// session character (saved preset or identity candidate), or a fresh snapshot
// of a random concept that can be materialized into a candidate preset.
function identityCharacterSource(session, explicitCharacter) {
    if (explicitCharacter) return explicitCharacter;
    const bound = session && session.identityCharacterId ? resolveCharacter(session.identityCharacterId) : null;
    if (bound) return bound;
    return null;
}

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
        if (value.expectedRevision !== undefined) out.expectedRevision = Number(value.expectedRevision);
        if (value.direction) out.direction = String(value.direction);
        if (typeof value.customPrompt === 'string') out.customPrompt = value.customPrompt;
        else if (typeof value.userPrompt === 'string') out.customPrompt = value.userPrompt;
        if (value.themeId) out.themeId = String(value.themeId);
        if (value.category) out.category = String(value.category);
        if (value.characterId) out.characterId = String(value.characterId);
        // The character name supplied when saving a concept as a character.
        if (typeof value.name === 'string' && value.name.trim()) out.name = value.name.trim();
        if (value.mode) out.mode = String(value.mode);
        if (value.locks) out.locks = value.locks;
        if (value.changes) out.changes = value.changes;
        if (value.reroll) out.reroll = true;
        // A precise one-field re-roll (the concept card's per-attribute dice).
        if (value.rerollField) out.rerollField = String(value.rerollField);
        // Outfit Pack selection (a pack id, or `custom` with a text override).
        if (typeof value.outfitPack === 'string') out.outfitPack = value.outfitPack;
        if (typeof value.outfitPackCustom === 'string') out.outfitPackCustom = value.outfitPackCustom;
        else if (typeof value.customOutfit === 'string') out.outfitPackCustom = value.customOutfit;
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

function listScenes() {
    return state.listScenes();
}

function getComposition(id) {
    return state.getComposition(id);
}

function cloneComposition(id) {
    const source = state.getComposition(id);
    if (!source) return null;
    const copy = JSON.parse(JSON.stringify(source));
    copy.id = makeId();
    copy.revision = 1;
    copy.status = STATUS.PREVIEW;
    copy.createdAt = new Date().toISOString();
    copy.updatedAt = copy.createdAt;
    state.addSaved(copy);
    return copy;
}

function saveScene(scene) {
    const now = new Date().toISOString();
    const record = Object.assign({
        id: 'scene_' + Date.now().toString(36), schemaVersion: 1, revision: 1,
        createdAt: now, updatedAt: now, status: STATUS.SAVED
    }, scene || {});
    state.addSaved(record);
    return record;
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
    listOutfitPacks: outfitPacks.listPacks,
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
    buildPortraitRequest,
    needsCharacterImage,
    setCharacterImage,
    setIdentityCharacter,
    identityCharacterSource,
    classifyMessage,
    normalizeAction,
    resolveCharacter,
    listScenes,
    getComposition,
    cloneComposition,
    saveScene,
    listCharacterOptions: characterGen.listProfileOptions
};
