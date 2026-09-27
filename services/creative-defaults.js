/* ============================================
   JARVIS — Creative Defaults
   Fills in the creative detail a user leaves
   unspecified: per-character clothing and a coherent
   image-style package. Explicit user instructions
   ALWAYS win — this module only supplies what is
   missing, never overrides, and never asks the user.

   Clothing reuses the existing Outfit Pack / theme
   wardrobe system (no second clothing pool). Style
   defaults are scene-driven, so a casual social
   scene reads as an authentic modern smartphone photo
   while an illustration, product or studio portrait
   request keeps its own treatment. No LLM, no GPU,
   no dependencies.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const outfitPacks = require('./playground/outfit-packs');
const outfitContext = require('./playground/outfit-context');
const themes = require('./playground/themes');

// --- Scene classification -----------------------------------------------------

// Styles that must never be replaced by the smartphone default. The scene type
// decides the default treatment; an explicit user style wins over everything.
const STYLE_SPECIFICS = [
    { id: 'painting', re: /\b(?:oil\s+painting|oil\s+on\s+canvas|painting|watercolou?r|acrylic|impressionist|renaissance|baroque|canvas)\b/i },
    { id: 'anime', re: /\b(?:anime|manga|ghibli|cel[- ]shaded)\b/i },
    { id: 'illustration', re: /\b(?:illustrat(?:ion|ed)|drawing|sketch|comic|graphic\s+novel|concept\s+art|digital\s+art|cartoon|pixar|3d\s+render|render|vector|poster\s+art)\b/i },
    { id: 'film', re: /\b(?:film\s+photograph|photographed\s+on\s+film|shot\s+on\s+film|on\s+film|35mm|analog(?:ue)?|kodak|portra|fuji(?:film)?|lomography|film\s+grain|polaroid)\b/i },
    { id: 'cinematic', re: /\b(?:cinematic|movie\s+still|film\s+still|anamorphic|hollywood|blockbuster)\b/i },
    { id: 'editorial', re: /\b(?:editorial|fashion\s+shoot|vogue|high\s+fashion|runway|magazine\s+cover|lookbook)\b/i },
    { id: 'studio', re: /\b(?:studio|seamless\s+backdrop|backdrop|strobe|softbox|headshot|corporate\s+portrait|professional\s+portrait)\b/i },
    { id: 'product', re: /\b(?:product\s+(?:photo|shot|photography)|product\s+on|packshot|e-?commerce|tabletop)\b/i },
    { id: 'documentary', re: /\b(?:documentary|reportage|photojournalis|street\s+photography|candid\s+documentary)\b/i }
];

// A nightlife *scene* cue (not an explicit user style): it selects the low-light
// social treatment instead of the plain everyday default.
const NIGHT_SCENE_RE = /\b(?:night\s+club|nightclub|club\s+lighting|club|neon\s+light|after[- ]dark|dark\s+club|nightlife|party|rave)\b/i;

// Scene cues that make the authentic smartphone treatment the right default:
// casual personal / social / everyday-life photography.
const CASUAL_CUES = new RegExp(
    '\\b(?:selfie|casual|candid|everyday|snapshot|photo\\s+with|instagram|social\\s+media|mirror|' +
    'bedroom|bed|couch|sofa|lounge|living\\s+room|kitchen|cafe|coffee|brunch|restaurant|bar|' +
    'street|walking|travel|trip|vacation|holiday|beach|park|garden|hanging\\s+out|friends|' +
    'sitting\\s+together|lying|standing\\s+together|hugging|smiling\\s+at)\\b', 'i'
);

// Product / still-life cues: use a product-photo treatment, never a phone photo.
const PRODUCT_CUES = /\b(?:product|packshot|e-?commerce|tabletop|still\s+life|merchandise|item\s+on\s+a\s+table)\b/i;

function detectExplicitStyle(text) {
    const value = String(text || '');
    for (const specific of STYLE_SPECIFICS) {
        if (specific.re.test(value)) return specific.id;
    }
    return '';
}

function classifySceneStyle(text) {
    const value = String(text || '');
    const explicit = detectExplicitStyle(value);
    if (explicit) return { id: explicit, source: 'explicit' };
    if (PRODUCT_CUES.test(value)) return { id: 'product', source: 'scene' };
    if (NIGHT_SCENE_RE.test(value)) return { id: 'night', source: 'scene' };
    if (CASUAL_CUES.test(value)) return { id: 'smartphone', source: 'scene' };
    // A plain scene with no strong cue still defaults to the authentic everyday
    // treatment — not cinematic or studio polish.
    return { id: 'smartphone', source: 'default' };
}

// --- Clothing detection -------------------------------------------------------

// Wording that means the user has already decided what a character wears.
const CLOTHING_RE = new RegExp(
    '\\b(?:wearing|wears|wore|dressed\\s+in|dress(?:ed)?\\s+(?:in|as)|outfit|clothes|clothing|' +
    'wardrobe|uniform|costume|suit|blazer|jacket|coat|shirt|t-?shirt|tee|top|blouse|sweater|hoodie|' +
    'cardigan|jumper|dress|skirt|jeans|trousers|pants|shorts|leggings|joggers|sneakers|shoes|heels|' +
    'boots|sneaker|loafer|sandals|hat|cap|scarf|gloves|sunglasses|loungewear|pyjamas|pajamas|' +
    'lingerie|bikini|swimsuit|swimwear|robe|apron)\\b', 'i'
);

// User wording that explicitly names a visual style, so the default must stand
// down even when it is not one of the STYLE_SPECIFICS presets.
const STYLE_WORD_RE = /\b(?:style|styled|aesthetic|look|vibe|photograph(?:ed|y)?|portrait|render|painting|illustration|anime|cartoon|cinematic|editorial|studio|film|polaroid|watercolou?r)\b/i;

function specifiesClothing(text) {
    return CLOTHING_RE.test(String(text || ''));
}

function specifiesStyle(text) {
    const value = String(text || '');
    return detectExplicitStyle(value) !== '' || STYLE_WORD_RE.test(value);
}

// --- Scene cues for clothing --------------------------------------------------

function sceneText(options = {}) {
    const parts = [
        options.rawPrompt,
        options.scenePrompt,
        options.environment,
        options.activity,
        options.timeOfDay,
        options.weather
    ];
    return parts.map((p) => String(p || '').trim()).filter(Boolean).join(' ');
}

function sceneModifiers(text) {
    const value = String(text || '');
    return {
        warm: /\b(?:beach|summer|tropical|pool|warm|hot|sunny|seaside|coastal|resort)\b/i.test(value),
        cold: /\b(?:winter|snow|cold|chilly|freezing|arctic)\b/i.test(value),
        gym: /\b(?:gym|workout|training|fitness|exercise|running|jogging)\b/i.test(value),
        evening: /\b(?:evening|night|club|party|dinner|drinks|date\s+night|date|going\s+out|getting\s+ready)\b/i.test(value),
        bedroom: /\b(?:bedroom|bed|lounge|lounging|pyjamas|pajamas|in\s+bed)\b/i.test(value),
        outdoor: /\b(?:outdoor|street|park|city|hiking|trail|mountain|walking)\b/i.test(value)
    };
}

// --- Clothing composition -----------------------------------------------------

// A deterministic PRNG seeded per (character, scene) so each character in a
// multi-character scene gets an independently varied but stable outfit, and the
// same request does not silently reshuffle between the prompt build and a retry.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function rng() {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hashString(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function firstName(character, index) {
    const name = character && character.name && character.name !== 'Character'
        ? String(character.name).trim()
        : '';
    return name || ('Character ' + (index + 1));
}

function genderOf(character) {
    if (!character) return '';
    if (character.identity && typeof character.identity === 'object' && character.identity.gender) {
        return String(character.identity.gender);
    }
    return '';
}

// Compose this character's clothing. Priority:
//   1. an explicit user clothing instruction (handled by the caller),
//   2. the character's assigned Outfit Pack (or a pack detected from the scene),
//   3. the shared theme wardrobe pools (Lifestyle casual system),
// so there is never a second clothing pool.
function composeCharacterOutfit(character, options = {}) {
    const seed = options.seed;
    const rng = mulberry32((seed >>> 0) ^ hashString(firstName(character, options.index) + '|' + String(options.avoid || '')));
    const gender = genderOf(character) || options.gender || '';
    const sceneText = String(options.environment || options.sceneText || '');
    const mods = sceneModifiers(options.sceneText || sceneText);
    // A male character uses separates/layered looks from any pack, since most
    // packs are not gender-tagged. A partial instruction that names a top
    // excludes one-piece and layered looks (an outer layer could obscure the
    // user's own top); a named bottom excludes one-piece looks only, so a light
    // layer remains possible.
    let archetypes = gender === 'man' ? ['separates', 'layered'] : undefined;
    if (options.explicit && options.explicit.top) archetypes = ['separates'];
    else if (options.explicit && options.explicit.bottom) archetypes = ['separates', 'layered'];
    const packOptions = {
        gender,
        avoidLayers: mods.warm,
        avoidSignatures: Array.isArray(options.avoidSignatures) ? options.avoidSignatures : [],
        previousArchetype: options.previousArchetype || '',
        // The environment + activity drive the central compatibility resolver
        // (footwear, heavy outerwear, accessories) so the composed outfit suits
        // where the character is and what they are doing.
        environment: sceneText,
        activity: options.activity || '',
        scene: options.activity || options.sceneText || '',
        explicit: options.explicit,
        protect: options.protect,
        archetypes
    };

    // 1. An assigned pack (character preset, then an explicit pack, then a pack
    //    the scene wording implies). "Getting ready for a date" in a bedroom is
    //    an occasion cue, so it outranks the room's own wardrobe hint.
    let packId = outfitPacks.normalizePackId(character && character.outfitPack);
    if (!packId && options.outfitPack) packId = outfitPacks.normalizePackId(options.outfitPack);
    if (!packId) packId = occasionPack(sceneText);
    if (!packId) packId = outfitPacks.detectOutfitPackFromText(options.sceneText || '');
    if (packId === outfitPacks.CUSTOM_PACK_ID && character && character.outfitPackCustom) {
        return { outfit: String(character.outfitPackCustom).trim(), source: 'custom', packId, components: null, resolution: null };
    }
    // No pack assigned: fall back to a scene-appropriate wardrobe personality
    // from the SAME pack catalog (gender-aware), never a second clothing pool.
    if (!packId) packId = defaultPackForScene(options.sceneText || '', gender, mods);
    if (packId) {
        const composed = outfitPacks.composeFromPack(packId, rng, packOptions);
        if (composed && composed.outfit) {
            return {
                outfit: composed.outfit,
                source: 'pack',
                packId,
                components: composed.components,
                resolution: composed.resolution || null
            };
        }
    }

    // 2. Last resort: the shared Lifestyle casual wardrobe (the same component
    //    system the Playground uses), tagged by the scene so the look fits the
    //    setting. The environment resolver still applies.
    const theme = themes.getTheme('lifestyle-candid') || themes.getTheme('anything');
    if (theme && theme.outfitSystem) {
        const sceneTags = themes.classifyScene({ environment: options.environment, activity: options.activity }) || [];
        const composed = themes.composeOutfit(theme.outfitSystem, null, rng, {
            tags: sceneTags.length ? sceneTags : (theme.outfitSystem.defaultTags || []),
            avoidSignatures: packOptions.avoidSignatures,
            previousArchetype: packOptions.previousArchetype
        });
        if (composed && composed.outfit) {
            const resolved = outfitContext.resolveOutfitForEnvironment(
                { outfit: composed.outfit, components: composed.components },
                sceneText,
                { rng, activity: options.activity, explicit: options.explicit, protect: options.protect }
            );
            return {
                outfit: resolved.outfit || composed.outfit,
                source: 'wardrobe',
                components: resolved.components || composed.components,
                resolution: resolved.resolution || null
            };
        }
    }

    return { outfit: '', source: '', components: null, resolution: null };
}

// "Getting ready" wording is an occasion cue: a bedroom becomes date-night (or
// work / party) preparation rather than a relaxed lounging scene. Returns a pack
// id or '' when the scene has no occasion cue.
const GETTING_READY_RE =
    /\b(?:getting ready|get ready|preparing (?:for|to)|dressing (?:up )?for|about to (?:go|leave)|ready for)\b/i;

function occasionPack(text) {
    const value = String(text || '');
    if (!GETTING_READY_RE.test(value)) return '';
    if (/\b(?:date|romantic)\b/i.test(value)) return 'casual-night-out';
    if (/\b(?:party|celebration|club|night\s+out|evening\s+out)\b/i.test(value)) return 'casual-night-out';
    if (/\b(?:work|office|interview|meeting)\b/i.test(value)) return 'casual-smart';
    if (/\b(?:gym|workout|work[- ]out|training)\b/i.test(value)) return 'gym-activewear';
    if (/\b(?:wedding|ceremony|gala)\b/i.test(value)) return 'glam-boudoir';
    if (/\b(?:beach|pool|vacation|resort)\b/i.test(value)) return 'vacation-summer';
    return '';
}

// The wardrobe personality a scene implies when the character has no assigned
// pack. Reuses the existing pack catalog (all packs are gender-aware); the
// everyday casual pack is the safe default for a neutral scene.
function defaultPackForScene(text, gender, mods) {
    const value = String(text || '');
    const detected = outfitPacks.detectOutfitPackFromText(value);
    if (detected) return detected;
    const m = mods || sceneModifiers(value);
    if (m.gym) return 'gym-activewear';
    if (m.evening) return 'casual-night-out';
    if (m.bedroom) return 'lounge-home';
    if (m.warm) return 'vacation-summer';
    if (m.outdoor) return 'casual-streetwear';
    if (m.cold) return 'casual-everyday';
    return 'casual-everyday';
}

// --- Style packages -----------------------------------------------------------

// Coherent visual treatments. Each package is a complete direction (capture
// medium, camera behaviour, lighting, colour, image characteristics), never a
// bag of disconnected keywords.
const STYLE_PACKAGES = {
    smartphone: {
        label: 'Natural modern smartphone photography',
        direction: 'Natural modern smartphone photography, authentic handheld capture, believable ' +
            'everyday framing, realistic computational exposure, natural skin rendering, subtle ' +
            'phone-camera sharpening, realistic dynamic range, natural white balance, and authentic ' +
            'everyday lighting. A real photo casually captured on a modern phone, not a polished studio shot.'
    },
    selfie: {
        label: 'Handheld smartphone selfie',
        direction: 'Believable handheld smartphone selfie, front-facing phone lens with close camera ' +
            'distance and a natural arm\'s-length perspective, mild wide-lens perspective distortion, ' +
            'realistic phone-camera exposure, natural skin rendering, slightly imperfect centering, and ' +
            'an authentic foreground relationship with the background. A casual phone selfie, not a ' +
            'professional photographer\'s portrait.'
    },
    film: {
        label: 'Film photography',
        direction: 'Authentic analog film photography, gentle grain, natural highlight roll-off, ' +
            'believable colour rendition, and a timeless documentary feel.'
    },
    cinematic: {
        label: 'Cinematic film still',
        direction: 'Cinematic film still, deliberate composition, controlled depth of field, shaped ' +
            'motivated lighting, and a film-grade colour grade.'
    },
    editorial: {
        label: 'Fashion editorial',
        direction: 'Fashion editorial photograph, confident styling, considered composition, clean ' +
            'shaping light, and a refined magazine colour grade.'
    },
    studio: {
        label: 'Studio portrait',
        direction: 'Professional studio portrait, seamless backdrop, controlled softbox lighting, ' +
            'crisp focus, and clean colour.'
    },
    product: {
        label: 'Product photography',
        direction: 'Professional product photography, clean controlled lighting, precise focus, true ' +
            'colour, and a considered commercial composition.'
    },
    illustration: {
        label: 'Illustration',
        direction: 'Illustrated artwork, deliberate drawn line and shape language, coherent artistic ' +
            'colour, and a consistent illustration style.'
    },
    painting: {
        label: 'Painting',
        direction: 'Painting with visible brush work, layered pigment, and a coherent painterly ' +
            'colour treatment.'
    },
    anime: {
        label: 'Anime style',
        direction: 'Anime illustration, clean cel-shaded colour, expressive line work, and a coherent ' +
            'anime aesthetic.'
    },
    documentary: {
        label: 'Documentary photography',
        direction: 'Documentary photography, natural available light, honest observation, and ' +
            'authentic framing.'
    },
    night: {
        label: 'Night social photography',
        direction: 'Natural low-light social photography, realistic colour under mixed club or neon ' +
            'lighting, believable phone-camera exposure, and genuine nightlife atmosphere.'
    }
};

// Selfie wording is a stronger cue than the general casual default.
const SELFIE_RE = /\b(?:selfie|self-portrait|front[- ]facing|taking\s+a\s+photo\s+of\s+(?:my|her|him)self|mirror\s+selfie)\b/i;

function selectStylePackage(options = {}) {
    const text = sceneText(options);
    if (options.explicitStyleId && STYLE_PACKAGES[options.explicitStyleId]) {
        return { id: options.explicitStyleId, package: STYLE_PACKAGES[options.explicitStyleId], source: 'explicit' };
    }
    const classified = classifySceneStyle(text);
    if (classified.id === 'smartphone' && SELFIE_RE.test(text)) {
        return { id: 'selfie', package: STYLE_PACKAGES.selfie, source: 'scene' };
    }
    const pkg = STYLE_PACKAGES[classified.id] || STYLE_PACKAGES.smartphone;
    return { id: classified.id, package: pkg, source: classified.source };
}

// --- Section builder ----------------------------------------------------------

// Decide which garment slots an instruction already covers. `full` marks a
// complete outfit (one-piece, suit, or a named top + bottom), which suppresses
// auto-fill entirely; any other named slot is a partial instruction.
function decideClothingSlots(rawPrompt, contextText) {
    const explicit = outfitContext.detectClothingSlots(rawPrompt);
    const context = outfitContext.detectClothingSlots(contextText);
    const slots = explicit.any ? explicit : context;
    const full = Boolean(slots.full || slots.dress || (slots.top && slots.bottom));
    return { explicit, context, slots, full, any: explicit.any || context.any };
}

// Build the creative-defaults contribution for a set of characters. Only fills
// what the user left unspecified; an explicit instruction in `rawPrompt` always
// wins and the corresponding slot is omitted from the section.
function buildCreativeDefaults(characters, options = {}) {
    const list = Array.isArray(characters) ? characters.filter(Boolean) : [];
    if (!list.length) return null;
    const rawPrompt = String(options.rawPrompt || '');
    const context = sceneText(options);
    // Continuity: a follow-up/edit keeps the previous automatic clothing and
    // style unless the user explicitly asks to change them. A new standalone
    // scene generates fresh defaults.
    const continuity = options.continuity === true;

    // Which garment slots the user already decided. A complete outfit (a
    // one-piece, a suit, or a top + bottom) suppresses auto-fill entirely; a
    // partial instruction only fills the missing pieces. Multi-character scenes
    // keep the conservative "any explicit clothing suppresses auto-fill" rule
    // because per-character ownership cannot be inferred reliably.
    const decision = decideClothingSlots(rawPrompt, context);
    const slots = decision.slots;
    const fullExplicit = decision.full;
    const hasExplicitClothing = specifiesClothing(rawPrompt) || specifiesClothing(context) || decision.any;
    const hasExplicitStyle = specifiesStyle(rawPrompt);
    const singlePartial = list.length === 1 && hasExplicitClothing && slots.any && !fullExplicit;
    const previousClothing = Array.isArray(options.previousClothing) ? options.previousClothing : [];
    const previousStyle = options.previousStyle && typeof options.previousStyle === 'object'
        ? options.previousStyle
        : null;

    const seedBase = Number.isFinite(Number(options.seed)) && Number(options.seed) >= 0
        ? Number(options.seed)
        : hashString(context + '|' + list.map((c) => firstName(c, 0)).join(','));

    const clothing = [];
    // Preserve previously established clothing on a continuation. A user
    // clothing instruction overrides it; a genuinely different occasion can be
    // signalled by passing `newOccasion: true`.
    if (continuity && !hasExplicitClothing && previousClothing.length && !options.newOccasion) {
        for (const item of previousClothing) {
            const name = String(item && item.name || '').trim();
            const outfit = String(item && item.outfit || '').trim();
            if (name && outfit) clothing.push({ name, outfit, source: item.source || 'continuity', packId: item.packId || '' });
        }
    }
    if ((!hasExplicitClothing || singlePartial) && !clothing.length) {
        const usedSignatures = [];
        list.forEach((character, index) => {
            const composed = composeCharacterOutfit(character, {
                index,
                seed: seedBase,
                gender: options.gender,
                sceneText: context,
                environment: options.environment,
                activity: options.activity,
                outfitPack: options.outfitPack,
                avoidSignatures: usedSignatures,
                previousArchetype: index > 0 ? 'separates' : '',
                // Only a partial instruction needs the explicit slot map; it
                // keeps the resolver off the user's own garments.
                explicit: singlePartial ? outfitContext.explicitSlotsFrom(slots) : undefined
            });
            let outfit = composed.outfit;
            let components = composed.components || null;
            let resolution = composed.resolution || null;
            // Partial instruction: drop the slots the user already named, keep
            // (and re-resolve) only the pieces we are filling in. The explicit
            // garments stay in the scene wording, untouched by the resolver.
            if (singlePartial && components) {
                const stripped = outfitContext.stripSlots(components, slots);
                const rebuilt = outfitContext.describeOutfit(stripped);
                if (!rebuilt) return;
                const resolved = outfitContext.resolveOutfitForEnvironment(
                    { outfit: rebuilt, components: stripped },
                    options.environment || context,
                    { activity: options.activity, seed: seedBase }
                );
                outfit = resolved.outfit || rebuilt;
                components = resolved.components || stripped;
                resolution = resolved.resolution || resolution;
            }
            if (outfit) {
                usedSignatures.push(themes.outfitSignature(outfit));
                clothing.push({
                    name: firstName(character, index),
                    outfit,
                    source: composed.source,
                    packId: composed.packId || '',
                    components: components || null,
                    resolution: resolution || null
                });
            }
        });
    }

    let style;
    if (hasExplicitStyle) {
        style = { id: '', package: null, source: 'explicit' };
    } else if (continuity && previousStyle && previousStyle.id && STYLE_PACKAGES[previousStyle.id] && !options.newOccasion) {
        style = { id: previousStyle.id, package: STYLE_PACKAGES[previousStyle.id], source: 'continuity' };
    } else {
        style = selectStylePackage({
            rawPrompt,
            scenePrompt: options.scenePrompt,
            environment: options.environment,
            activity: options.activity
        });
    }

    const lines = [];
    if (clothing.length) {
        lines.push('CLOTHING (automatically selected to suit the scene; keep each outfit independent)');
        for (const item of clothing) {
            lines.push(item.name + ' wears ' + item.outfit + '.');
        }
    }
    if (style.package) {
        lines.push('IMAGE STYLE\n' + style.package.direction);
    }
    const section = lines.join('\n');
    return {
        clothing,
        style,
        hasExplicitClothing,
        hasExplicitStyle,
        explicitSlots: slots,
        partial: singlePartial,
        section
    };
}

module.exports = {
    STYLE_PACKAGES,
    STYLE_SPECIFICS,
    detectExplicitStyle,
    classifySceneStyle,
    specifiesClothing,
    specifiesStyle,
    selectStylePackage,
    explicitClothingSlots: outfitContext.detectClothingSlots,
    decideClothingSlots,
    composeCharacterOutfit,
    buildCreativeDefaults,
    sceneText,
    sceneModifiers,
    hashString,
    mulberry32
};
