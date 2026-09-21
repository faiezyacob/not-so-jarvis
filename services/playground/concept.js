/* ============================================
   JARVIS — Creative Playground Concept Engine
   Pure, deterministic concept assembly for the
   Creative Playground. Draws a compatible scenario
   from a theme, preserves the selected character,
   honors locked attributes, and builds the creative
   direction that the existing image prompt builder
   turns into the final Krea2 prompt.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const { getTheme, pickScenario, pickAspectRatio, outfitSignature } = require('./themes');
const identityGen = require('./character');
const outfitPacks = require('./outfit-packs');

// Lockable attribute groups. Each group maps to the concept/character field it
// freezes during randomization.
const LOCKABLE = ['identity', 'appearance', 'hair', 'outfit', 'style', 'environment'];

const MODES = ['character', 'random_character', 'none'];

function rngOf(input) {
    return typeof input === 'function' ? input : Math.random;
}

function normalizeLocks(value) {
    const src = value && typeof value === 'object' ? value : {};
    const out = {};
    for (const key of LOCKABLE) out[key] = src[key] === true || src[key] === 'true' || src[key] === 1;
    return out;
}

// Backwards-compatible helper: returns just the formatted identity sentence.
function randomIdentity(rng = Math.random) {
    return identityGen.formatIdentity(identityGen.generateRandomIdentity(rng));
}

function firstWords(text, count) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .slice(0, count)
        .join(' ')
        .replace(/[.,;:]+$/, '')
        .trim();
}

function capitalize(text) {
    const t = String(text || '').trim();
    if (!t) return '';
    return t.charAt(0).toUpperCase() + t.slice(1);
}

function titleFor(concept, theme) {
    const base = firstWords(concept.activity || concept.scene || '', 5);
    return capitalize(base) || capitalize(theme.label);
}

function describe(concept, theme) {
    const who = concept.subject ? concept.subject : 'the subject';
    const mood = concept.mood ? concept.mood + ' ' : '';
    let text = 'A ' + mood + theme.label.toLowerCase() + ' image: ' + who;
    if (concept.activity) text += ' ' + concept.activity;
    if (concept.environment) text += ' in ' + concept.environment;
    if (concept.lighting) text += ', under ' + concept.lighting;
    if (concept.camera) text += ', framed ' + concept.camera;
    return text.replace(/\s+/g, ' ').trim() + '.';
}

function sceneLine(concept) {
    const activity = String(concept.activity || '').trim();
    const environment = String(concept.environment || '').trim();
    if (activity && environment) return activity + ' \u2014 ' + environment;
    return activity || environment;
}

function finalize(concept, theme) {
    concept.scene = sceneLine(concept);
    concept.title = titleFor(concept, theme);
    concept.description = describe(concept, theme);
    return concept;
}

// --- Outfit Packs ------------------------------------------------------------
//
// An Outfit Pack is a first-class, replaceable wardrobe attribute: selecting one
// composes a fresh, specific outfit from the pack's wardrobe space (replacing,
// never appending to, any previous clothing) while identity / face / hair /
// body / skin stay untouched. A locked outfit is the exception — the exact
// clothing is preserved and only the pack metadata is recorded.

function conceptGender(concept, character) {
    if (concept && concept.identity && concept.identity.gender) return concept.identity.gender;
    if (character && character.gender) return character.gender;
    return '';
}

function applyOutfitPack(concept, options = {}) {
    if (!concept) return concept;
    const packId = outfitPacks.normalizePackId(options.packId);
    if (!packId) return concept;
    const custom = packId === outfitPacks.CUSTOM_PACK_ID;
    const customText = String(options.customText || '').trim();
    if (custom && !customText) return concept;
    const pack = custom ? null : outfitPacks.getPack(packId);
    if (!custom && !pack) return concept;

    concept.outfitPack = packId;
    concept.outfitPackLabel = custom ? outfitPacks.CUSTOM_PACK_LABEL : pack.label;
    concept.outfitPackCustom = custom ? customText : '';

    // A locked outfit is already the source of truth; keep the exact clothing.
    if (options.preserve && concept.outfit) return concept;

    if (custom) {
        concept.outfit = customText;
        concept.outfitComponents = null;
        concept.outfitArchetype = 'custom';
        concept.outfitSilhouette = '';
        concept.outfitSignature = outfitSignature(customText);
        return concept;
    }

    const composed = outfitPacks.composeFromPack(packId, options.rng || Math.random, {
        avoidSignatures: options.avoidSignatures,
        previousArchetype: options.previousArchetype,
        gender: options.gender,
        avoidLayers: options.avoidLayers
    });
    if (!composed.outfit) return concept;
    concept.outfit = composed.outfit;
    concept.outfitSignature = composed.signature;
    concept.outfitArchetype = composed.archetype;
    concept.outfitSilhouette = composed.silhouette;
    concept.outfitComponents = composed.components;
    return concept;
}

// Resolve which pack (if any) a concept should use. Explicit selection wins,
// then the character preset's wardrobe personality, then context wording.
function resolveOutfitPack(input = {}, character) {
    let packId = outfitPacks.normalizePackId(input.outfitPack);
    let customText = String(input.outfitPackCustom || input.customOutfit || '').trim();
    if (!packId && character) {
        const characterPack = outfitPacks.normalizePackId(character.outfitPack);
        if (characterPack) {
            packId = characterPack;
            customText = String(character.outfitPackCustom || '').trim();
        }
    }
    if (!packId && input.contextText) {
        const detected = outfitPacks.detectOutfitPackFromText(input.contextText);
        if (detected) packId = detected;
    }
    return { packId, customText };
}

// Assemble a fresh concept from a theme + character + locks. Randomization
// never alters a locked group: locked values are copied from the character
// preset when present, otherwise from the previous concept.
function assembleConcept(input = {}) {
    const rng = rngOf(input.rng);
    const theme = input.theme || getTheme(input.themeId);
    const mode = MODES.includes(input.mode) ? input.mode : 'none';
    const character = input.character && typeof input.character === 'object' ? input.character : null;
    const locks = normalizeLocks(input.locks);
    const previous = input.previous && typeof input.previous === 'object' ? input.previous : null;
    // Independent character controls (appearance/age/gender). `random` in every
    // field reproduces the general random-character behaviour.
    const profile = identityGen.normalizeProfile(input.profile);
    const scenario = pickScenario(theme, rng, input.category, {
        avoidOutfitSignatures: input.avoidOutfitSignatures,
        previousOutfitArchetype: input.previousOutfitArchetype
    });

    const concept = {
        subject: '',
        appearance: '',
        hair: '',
        // Display name (a saved character's name, or a temporary random one) and
        // the structured random identity that produced `subject`/`appearance`/
        // `hair`. Kept so a random character can be reasoned about and saved.
        name: '',
        identity: null,
        identitySeed: null,
        identitySignature: null,
        // The resolved generator controls and the deterministic seed that
        // produced the random identity (same seed + same profile = same person).
        characterProfile: null,
        characterSeed: null,
        // The demographic appearance category the identity was drawn from, and
        // its human label, so the prompt builder can render the intended person.
        appearanceCategory: '',
        appearanceCategoryLabel: '',
        category: scenario.category || '',
        categoryId: scenario.categoryId || '',
        outfit: scenario.outfit || '',
        // Normalized outfit identity + structural shape, used to avoid repeating
        // an exact look across consecutive Surprises in one conversation.
        outfitSignature: scenario.outfitSignature || '',
        outfitArchetype: scenario.outfitArchetype || '',
        outfitSilhouette: scenario.outfitSilhouette || '',
        // The Outfit Pack (wardrobe personality) that produced the clothing, the
        // composed pieces, and the user-defined outfit when the pack is Custom.
        outfitPack: '',
        outfitPackLabel: '',
        outfitPackCustom: '',
        outfitComponents: null,
        environment: scenario.environment || '',
        activity: scenario.activity || '',
        lighting: scenario.lighting || '',
        camera: scenario.camera || '',
        composition: scenario.composition || '',
        mood: scenario.mood || '',
        style: scenario.style || '',
        // Technique-driven themes (Experimental Photography) surface the single
        // dominant technique and its supporting material; other themes leave them
        // empty. They never stack: one technique is chosen per concept.
        technique: scenario.technique || '',
        techniqueLabel: scenario.techniqueLabel || '',
        texture: scenario.texture || '',
        aspectRatio: pickAspectRatio(theme, rng)
    };

    // Character identity is preserved whenever a character is selected; the
    // identity/appearance/hair locks additionally carry a character (or the
    // previous concept in the other modes) across randomizations.
    if (mode === 'character' && character) {
        concept.subject = character.identity || '';
        concept.appearance = character.appearance || '';
        concept.hair = character.hair || '';
        concept.name = character.name || '';
        // Carry the saved demographic back so the prompt builder renders the
        // intended person instead of a generic one.
        concept.appearanceCategory = character.appearanceCategory || '';
        concept.appearanceCategoryLabel = character.appearanceCategoryLabel
            || identityGen.appearanceCategoryLabel(character.appearanceCategory);
    } else if (mode === 'random_character') {
        // `freshIdentity` is set on a brand-new Surprise so "Random new
        // character" always casts a new person; a re-roll ("Surprise Me Again")
        // keeps the current one while the identity lock is set.
        const keepIdentity = !input.freshIdentity && previous && locks.identity && previous.subject;
        if (keepIdentity) {
            concept.subject = previous.subject;
            concept.appearance = previous.appearance || '';
            concept.hair = previous.hair || '';
            concept.name = previous.name || '';
            concept.identity = previous.identity || null;
            concept.identitySeed = previous.identitySeed || null;
            concept.identitySignature = previous.identitySignature || null;
            concept.characterProfile = previous.characterProfile || profile;
            concept.characterSeed = previous.characterSeed || previous.identitySeed || null;
            concept.appearanceCategory = previous.appearanceCategory || '';
            concept.appearanceCategoryLabel = previous.appearanceCategoryLabel || '';
        } else {
            // Avoid immediately repeating an identity already seen in this
            // session; the caller supplies the session's recent signatures.
            const avoid = (Array.isArray(input.avoidSignatures) ? input.avoidSignatures : []).slice();
            if (previous && previous.identitySignature) avoid.push(previous.identitySignature);
            const generated = identityGen.generateUniqueIdentity(rng, avoid, profile);
            concept.subject = generated.identityText;
            concept.appearance = identityGen.formatAppearance(generated);
            concept.hair = identityGen.formatHair(generated);
            concept.name = generated.name || '';
            concept.identity = generated;
            concept.identitySeed = generated.seed;
            concept.identitySignature = generated.signature;
            concept.characterProfile = generated.characterProfile || profile;
            concept.characterSeed = generated.characterSeed || generated.seed;
            concept.appearanceCategory = generated.appearanceCategory || '';
            concept.appearanceCategoryLabel = identityGen.appearanceCategoryLabel(generated.appearanceCategory);
        }
        // A fresh identity must not inherit the previous person's face/hair;
        // those locks only matter when carrying an identity forward.
        if (!input.freshIdentity && previous && locks.appearance) concept.appearance = previous.appearance || concept.appearance;
        if (!input.freshIdentity && previous && locks.hair) concept.hair = previous.hair || concept.hair;
    } else {
        if (previous && locks.identity) concept.subject = previous.subject || '';
        if (previous && locks.appearance) concept.appearance = previous.appearance || '';
        if (previous && locks.hair) concept.hair = previous.hair || '';
        if (previous && locks.environment) concept.environment = previous.environment || concept.environment;
    }

    if (locks.outfit) {
        if (character && character.outfit) concept.outfit = character.outfit;
        else if (previous && previous.outfit) concept.outfit = previous.outfit;
        // The locked outfit is not a fresh random look, so drop the composed
        // archetype/silhouette and recompute the signature from the actual outfit.
        concept.outfitArchetype = '';
        concept.outfitSilhouette = '';
    }
    if (locks.style) {
        if (character && character.style) concept.style = character.style;
        else if (previous && previous.style) concept.style = previous.style;
    }
    if (locks.environment && previous && previous.environment) {
        concept.environment = previous.environment;
    }

    // Outfit Pack: compose the specific outfit from the selected pack's wardrobe
    // space. A locked outfit wins, so only the pack metadata is recorded then.
    const resolvedPack = resolveOutfitPack(input, character);
    if (resolvedPack.packId) {
        const context = input.contextText ? outfitPacks.contextModifiers(input.contextText) : null;
        applyOutfitPack(concept, {
            packId: resolvedPack.packId,
            customText: resolvedPack.customText,
            preserve: Boolean(locks.outfit && concept.outfit),
            rng,
            gender: conceptGender(concept, character),
            avoidSignatures: input.avoidOutfitSignatures,
            previousArchetype: input.previousOutfitArchetype,
            avoidLayers: Boolean(context && context.warm && !context.cold)
        });
    }
    concept.outfitSignature = concept.outfit ? outfitSignature(concept.outfit) : (concept.outfitSignature || '');

    return finalize(concept, theme);
}

// Apply an explicit modification. Explicit fields win even over a lock (the
// user asked for the change); untouched fields are preserved exactly.
const CONCEPT_FIELDS = [
    'subject', 'appearance', 'hair', 'outfit', 'environment',
    'activity', 'lighting', 'camera', 'composition', 'mood', 'style', 'aspectRatio'
];

function applyChanges(concept, changes) {
    const next = Object.assign({}, concept || {});
    const src = changes && typeof changes === 'object' ? changes : {};
    for (const field of CONCEPT_FIELDS) {
        const value = src[field];
        if (typeof value === 'string' && value.trim()) next[field] = value.trim();
    }
    if (typeof src.outfit === 'string' && src.outfit.trim()) {
        // An explicitly named outfit is a custom replacement: the user defined
        // the clothing, so it overrides any pack composition.
        next.outfitSignature = outfitSignature(next.outfit);
        next.outfitArchetype = 'custom';
        next.outfitSilhouette = '';
        next.outfitComponents = null;
        next.outfitPack = outfitPacks.CUSTOM_PACK_ID;
        next.outfitPackLabel = outfitPacks.CUSTOM_PACK_LABEL;
        next.outfitPackCustom = next.outfit;
    }
    if (typeof src.customDirection === 'string' && src.customDirection.trim()) {
        next.customDirection = src.customDirection.trim();
    }
    return next;
}

// --- Context interpretation ----------------------------------------------------
//
// Maps a free-text follow-up onto a concept action. "try another one" re-rolls
// with the same character/settings; "keep the outfit but make it a beach scene"
// adds a lock and applies only the requested change.

const AGAIN_RE =
    /\b(?:try\s+another|another\s+(?:one|concept|idea|look)|one\s+more|surprise\s+me\s+again|next\s+(?:one|concept)|something\s+(?:else|different)|different\s+(?:one|concept|idea)|once\s+more|again)\b/i;

const KEEP_HINTS = [
    { lock: 'outfit', re: /\b(?:outfit|clothes|clothing|dress|wardrobe|bottoms?|top)\b/i },
    { lock: 'hair', re: /\bhair\b/i },
    { lock: 'appearance', re: /\b(?:face|facial|appearance|features)\b/i },
    { lock: 'identity', re: /\b(?:character|identity|person|subject|same\s+(?:woman|man|guy|girl|person))\b/i },
    { lock: 'style', re: /\b(?:style|look|aesthetic|vibe)\b/i },
    { lock: 'environment', re: /\b(?:environment|setting|background|scene|place|location|backdrop)\b/i }
];

const CHANGE_HINTS = [
    { field: 'environment', value: 'a wide sunlit sandy beach with the ocean behind', re: /\bbeach\b|\bshore\b|\bcoastline\b|\bcoast\b/i },
    { field: 'environment', value: 'a misty forest clearing among tall trees', re: /\bforest\b|\bwoods\b|\bwoodland\b/i },
    { field: 'environment', value: 'a vibrant city street with layered signage', re: /\bcity\b|\bstreet\b|\burban\b|\bdowntown\b/i },
    { field: 'environment', value: 'a vast desert of rippled dunes', re: /\bdesert\b|\bdunes?\b/i },
    { field: 'environment', value: 'a dramatic mountain landscape', re: /\bmountains?\b|\balps?\b/i },
    { field: 'environment', value: 'a clean professional studio set', re: /\bstudio\b/i },
    { field: 'environment', value: 'a warm neighbourhood café', re: /\bcaf[eé]\b|\bcoffee\s+shop\b/i },
    { field: 'environment', value: 'a city rooftop above the skyline', re: /\brooftop\b/i },
    { field: 'environment', value: 'a snow-covered landscape', re: /\bsnow\b|\bwinter\b|\bsnowy\b/i },
    { field: 'environment', value: 'a rain-soaked street reflecting the lights', re: /\brain\b|\brainy\b|\bstorm\b|\bstormy\b/i },
    { field: 'environment', value: 'a bright, lived-in home kitchen', re: /\bkitchen\b/i },
    { field: 'environment', value: 'a lush private garden in bloom', re: /\bgarden\b/i },
    { field: 'environment', value: 'a bustling open-air market', re: /\bmarket\b/i },

    { field: 'lighting', value: 'warm golden-hour light', re: /\bgolden\s+hour\b|\bsunset\b|\bsunrise\b|\bdusk\b/i },
    { field: 'lighting', value: 'glowing neon signage light', re: /\bneon\b/i },
    { field: 'lighting', value: 'cool moonlight', re: /\bmoonlight\b|\bmoonlit\b|\bat\s+night\b|\bnight\b/i },
    { field: 'lighting', value: 'warm candlelight', re: /\bcandle/i },
    { field: 'lighting', value: 'clean studio lighting', re: /\bstudio\s+light/i },
    { field: 'lighting', value: 'soft overcast daylight', re: /\bovercast\b|\bcloudy\b/i },
    { field: 'lighting', value: 'low-key moody lighting', re: /\bmoody\b|\bdim\b|\bdark\b|\blow[- ]key\b/i },

    { field: 'mood', value: 'moody', re: /\bmoody\b/i },
    { field: 'mood', value: 'joyful', re: /\bjoyful\b|\bhappy\b|\bcheerful\b/i },
    { field: 'mood', value: 'serene', re: /\bserene\b|\bcalm\b|\bpeaceful\b|\btranquil\b/i },
    { field: 'mood', value: 'dramatic', re: /\bdramatic\b/i },
    { field: 'mood', value: 'epic', re: /\bepic\b/i },
    { field: 'mood', value: 'romantic', re: /\bromantic\b|\bromance\b/i },
    { field: 'mood', value: 'playful', re: /\bplayful\b/i },

    { field: 'activity', value: 'dancing freely', re: /\bdanc/i },
    { field: 'activity', value: 'running with purpose', re: /\brunn?ing\b|\bjogging\b|\bsprint/i },
    { field: 'activity', value: 'sitting in a relaxed pose', re: /\bsitting\b|\bseated\b/i },
    { field: 'activity', value: 'reading quietly', re: /\breading\b/i },
    { field: 'activity', value: 'walking with an easy stride', re: /\bwalking\b|\bstrolling\b/i },
    { field: 'activity', value: 'jumping mid-air', re: /\bjumping\b|\bleaping\b/i },
    { field: 'activity', value: 'resting and lying down', re: /\blying\b|\bsleeping\b|\bresting\b/i },
    { field: 'activity', value: 'wading through the water', re: /\bswimming\b|\bwading\b/i },

    { field: 'outfit', value: 'a striking red dress', re: /\bred\s+dress\b/i },
    { field: 'outfit', value: 'a tailored suit', re: /\bsuit\b/i },
    { field: 'outfit', value: 'a patterned kimono', re: /\bkimono\b/i },
    { field: 'outfit', value: 'swimwear', re: /\bswim(?:suit|wear|shorts)?\b|\bbikini\b/i },
    { field: 'outfit', value: 'a heavy winter coat', re: /\bwinter\s+coat\b|\bovercoat\b/i },
    { field: 'outfit', value: 'jeans and a simple top', re: /\bjeans\b/i },
    { field: 'outfit', value: 'a casual hoodie', re: /\bhoodie\b/i },

    { field: 'style', value: 'pencil sketch style', re: /\bsketch\b/i },
    { field: 'style', value: 'watercolour painting style', re: /\bwatercolou?r\b/i },
    { field: 'style', value: 'anime illustration style', re: /\banime\b/i },
    { field: 'style', value: 'a stylised 3D render', re: /\b3d\b|\brender(?:ed)?\b/i },
    { field: 'style', value: 'high-contrast black and white photography', re: /\bblack\s+and\s+white\b|\bmonochrome\b|\bgreyscale\b|\bgrayscale\b/i },

    { field: 'composition', value: 'the reflection framed in a mirror', re: /\bmirror\b/i },
    { field: 'composition', value: 'a candid moment caught mid-activity', re: /\bcandid\b|\bspontaneous\b/i },
    { field: 'composition', value: 'looking into the camera with a natural expression', re: /\blooking (?:at|into) the camera\b/i },
    { field: 'composition', value: 'looking at the phone screen', re: /\blooking at the phone\b/i }
];

// Lifestyle & Candid subcategory keywords. These are only consulted for that
// theme (the vocabulary does not map onto other themes); they let a typed
// follow-up pin the subcategory, e.g. "make it a mirror selfie".
const CATEGORY_THEME_ID = 'lifestyle-candid';
const CATEGORY_HINTS = [
    { id: 'mirror-selfie', re: /\bmirror\s+(?:selfie|photo|pic)\b/i },
    { id: 'outfit-check', re: /\boutfit\s+(?:check|post|photo)\b/i },
    { id: 'instagram-story', re: /\b(?:instagram\s+)?stor(?:y|ies)\b/i },
    { id: 'casual-selfie', re: /\bselfie\b/i },
    { id: 'cafe-coffee', re: /\b(?:caf[eé]|coffee)\b/i },
    { id: 'beauty-skincare', re: /\b(?:skincare|skin care|makeup|beauty)\b/i },
    { id: 'gym-fitness', re: /\b(?:gym|workout|fitness)\b/i },
    { id: 'shopping', re: /\b(?:shopping|mall|boutique)\b/i },
    { id: 'travel', re: /\b(?:travel|vacation|beach|hotel|airport|sightseeing)\b/i },
    { id: 'morning-routine', re: /\bmorning\b/i },
    { id: 'night-out', re: /\bnight\s+out\b/i },
    { id: 'bedroom-home', re: /\b(?:bedroom|at\s+home|home\s+post)\b/i },
    { id: 'street-city', re: /\b(?:street|city)\b/i },
    { id: 'candid-social', re: /\bcandid\b/i }
];

const THEME_HINTS = [
    { id: 'fashion-editorial', re: /\bfashion\b|\beditorial\b|\brunway\b/i },
    { id: 'lifestyle-candid', re: /\blifestyle\b|\bcandid\b/i },
    { id: 'travel-adventure', re: /\btravel\b|\badventure\b|\bwander\b/i },
    { id: 'cinematic-storytelling', re: /\bcinematic\b|\bfilm\s+still\b|\bstorytelling\b|\bnoir\b/i },
    { id: 'fantasy-character-worlds', re: /\bfantasy\b|\bmagic(?:al)?\b|\bmythic\b|\benchanted\b/i },
    { id: 'seasonal-concepts', re: /\bseason(?:al)?\b|\bchristmas\b|\bholiday\b|\bsummer\b|\bautumn\b|\bfall\b|\bspring\b|\bhalloween\b/i },
    { id: 'experimental-photography', re: /\bexperimental\b|\babstract\b|\bsurreal\b|\blong\s+exposure\b/i }
];

const CUSTOM_DIRECTION_RE =
    /\b(?:make\s+(?:it|her|him|them)|change|turn\s+(?:it|her|him|them)|set\s+(?:it|the)|add|remove|put\s+(?:her|him|them)|give\s+(?:her|him|them))\b/i;

function lockedGroupsFromText(text) {
    const locks = {};
    for (const hint of KEEP_HINTS) {
        if (hint.re.test(text)) locks[hint.lock] = true;
    }
    return locks;
}

function detectChanges(text, options = {}) {
    const changes = {};
    for (const hint of CHANGE_HINTS) {
        if (typeof changes[hint.field] === 'string') continue;
        if (hint.re.test(text)) changes[hint.field] = hint.value;
    }
    for (const hint of THEME_HINTS) {
        if (hint.re.test(text)) {
            changes.themeId = hint.id;
            break;
        }
    }
    // Subcategory keywords only apply to the Lifestyle & Candid theme.
    if (options.themeId === CATEGORY_THEME_ID) {
        for (const hint of CATEGORY_HINTS) {
            if (hint.re.test(text)) {
                changes.category = hint.id;
                break;
            }
        }
    }
    // Outfit Pack changes: "custom outfit: <text>" names an exact outfit; any
    // other contextual wording (gym, beach, office, night out …) selects a pack.
    const customMatch = text.match(/\bcustom\s+outfit\b\s*[:\-]?\s*(.+)$/i);
    if (customMatch && customMatch[1].trim()) {
        changes.outfitPack = outfitPacks.CUSTOM_PACK_ID;
        changes.outfitPackCustom = customMatch[1].trim();
    } else if (changes.outfit) {
        // Explicitly named clothing (e.g. "a red dress") is a custom replacement.
        changes.outfitPack = outfitPacks.CUSTOM_PACK_ID;
        changes.outfitPackCustom = changes.outfit;
    } else {
        const pack = outfitPacks.detectOutfitPackFromText(text);
        if (pack) changes.outfitPack = pack;
    }
    return changes;
}

// Interpret a follow-up message against the open concept. Returns
// { action, locks, changes } or null when the message is unrelated chat.
function interpretContextMessage(message, options = {}) {
    const text = String(message || '').trim();
    if (!text) return null;
    const open = Boolean(options.open);

    const keepClauseMatch = text.match(/\bkeep\b([\s\S]*?)(?=\bbut\b|\bthen\b|,|$)/i);
    const keepLocks = keepClauseMatch ? lockedGroupsFromText(keepClauseMatch[1]) : {};
    const changeClause = keepClauseMatch
        ? text.slice(text.toLowerCase().indexOf(keepClauseMatch[0].toLowerCase()) + keepClauseMatch[0].length)
        : text;

    const changes = detectChanges(changeClause, { themeId: options.themeId });
    const hasChanges = Object.keys(changes).length > 0;
    const hasKeeps = Object.keys(keepLocks).length > 0;
    const again = AGAIN_RE.test(text);

    if (!open) return null;

    if (hasKeeps || hasChanges) {
        if (!hasChanges && CUSTOM_DIRECTION_RE.test(changeClause)) {
            const direction = changeClause.replace(/^\s*(?:but|and|then|,)\s*/i, '').trim();
            if (direction) changes.customDirection = direction;
        }
        return { action: 'modify', locks: keepLocks, changes, reroll: again };
    }
    if (again) return { action: 'again', locks: {}, changes: {} };
    return null;
}

// Build the creative direction handed to the image prompt builder. This is
// direction, not the final prompt: the builder turns it into the Krea2 prompt.
function conceptToDirection(concept) {
    const c = concept || {};
    const lines = [];
    lines.push('Creative direction: ' + (c.title || 'an original concept') + '. ' + (c.description || ''));
    if (c.subject) lines.push('Character: ' + c.subject + '.');
    if (c.appearanceCategoryLabel) lines.push('Character appearance category: ' + c.appearanceCategoryLabel + '.');
    if (c.appearance) lines.push('Facial appearance: ' + c.appearance + '.');
    if (c.hair) lines.push('Hair and physical appearance: ' + c.hair + '.');
    if (c.outfit) lines.push('Outfit: ' + c.outfit + '.');
    if (c.outfitPackLabel) lines.push('Outfit pack (wardrobe personality): ' + c.outfitPackLabel + '.');
    if (c.outfitPackCustom) lines.push('Requested custom outfit: ' + c.outfitPackCustom + '.');
    if (c.activity) lines.push('Character activity: ' + c.activity + '.');
    if (c.environment) lines.push('Environment: ' + c.environment + '.');
    if (c.category) lines.push('Social-media category: ' + c.category + '.');
    if (c.lighting) lines.push('Lighting: ' + c.lighting + '.');
    if (c.techniqueLabel) lines.push('Primary experimental technique: ' + c.techniqueLabel + '.');
    if (c.texture) lines.push('Texture or material element: ' + c.texture + '.');
    const camera = [c.camera, c.composition].filter(Boolean).join(', ');
    if (camera) lines.push('Camera and composition: ' + camera + '.');
    if (c.mood) lines.push('Mood: ' + c.mood + '.');
    if (c.style) lines.push('Visual style: ' + c.style + '.');
    if (c.aspectRatio) lines.push('Suggested aspect ratio: ' + c.aspectRatio + '.');
    if (c.customDirection) lines.push('Additional direction: ' + c.customDirection + '.');
    lines.push('Produce one complete, concrete image that follows this direction.');
    return lines.join(' ');
}

// A neutral head-and-shoulders studio portrait of the concept's person, shown to
// the user before the full scene is generated so a random character has a face.
// Like conceptToDirection this is creative direction only — the image prompt
// builder still owns the final Krea2 prompt. Face-reference constraints are
// identity-only: scene, outfit, style and environment must not leak in.
function conceptToPortraitDirection(concept) {
    const c = concept || {};
    const lines = [];
    lines.push('Creative direction: a head-and-shoulders studio portrait of the character.');
    if (c.subject) lines.push('Character: ' + c.subject + '.');
    if (c.appearanceCategoryLabel) lines.push('Character appearance category: ' + c.appearanceCategoryLabel + '.');
    if (c.appearance) lines.push('Facial appearance: ' + c.appearance + '.');
    if (c.hair) lines.push('Hair and physical appearance: ' + c.hair + '.');
    lines.push('Head and shoulders framing, facing the camera with a natural relaxed expression.');
    lines.push('Plain neutral studio background, soft even lighting, sharp focus on the face.');
    lines.push('A clean identity reference portrait, not a scene.');
    return lines.join(' ');
}

function conceptToPortraitConstraints(concept) {
    const c = concept || {};
    const constraints = [];
    if (c.subject) constraints.push('Show exactly this person: ' + c.subject);
    if (c.appearance) constraints.push('Show this facial appearance: ' + c.appearance);
    if (c.hair) constraints.push('Show this hair and physical appearance: ' + c.hair);
    if (c.appearanceCategoryLabel) constraints.push('Character demographic appearance: ' + c.appearanceCategoryLabel);
    constraints.push('Head-and-shoulders portrait framing');
    constraints.push('Plain neutral studio background');
    return constraints;
}

// Explicit constraints that reinforce locked/identity details for the builder.
function conceptToConstraints(concept, options = {}) {
    const c = concept || {};
    const locks = normalizeLocks(options.locks);
    const constraints = [];
    if (options.mode === 'character') {
        if (c.subject) constraints.push('Keep the exact same character identity: ' + c.subject);
        if (c.appearance) constraints.push('Keep the facial appearance: ' + c.appearance);
        if (c.hair) constraints.push('Keep the hair and physical appearance: ' + c.hair);
    }
    if (c.appearanceCategoryLabel) constraints.push('Character demographic appearance: ' + c.appearanceCategoryLabel);
    if (locks.identity && c.subject) constraints.push('Preserve the character identity: ' + c.subject);
    if (locks.appearance && c.appearance) constraints.push('Preserve the facial appearance: ' + c.appearance);
    if (locks.hair && c.hair) constraints.push('Preserve the hair: ' + c.hair);
    if (locks.outfit && c.outfit) constraints.push('Preserve the outfit exactly: ' + c.outfit);
    if (locks.style && c.style) constraints.push('Preserve the visual style: ' + c.style);
    if (locks.environment && c.environment) constraints.push('Preserve the environment: ' + c.environment);
    if (c.aspectRatio) constraints.push('Frame for a ' + c.aspectRatio + ' aspect ratio');
    return constraints;
}

module.exports = {
    LOCKABLE,
    MODES,
    CONCEPT_FIELDS,
    normalizeLocks,
    randomIdentity,
    assembleConcept,
    applyChanges,
    applyOutfitPack,
    resolveOutfitPack,
    interpretContextMessage,
    detectChanges,
    conceptToDirection,
    conceptToPortraitDirection,
    conceptToPortraitConstraints,
    conceptToConstraints
};
