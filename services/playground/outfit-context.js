/* ============================================
   JARVIS — Creative Playground Outfit Context
   The central environment/outfit compatibility
   resolver. An Outfit Pack describes a wardrobe
   personality; the environment and the actual scene
   describe contextual constraints. This module
   reconciles the two so a composed outfit makes
   sense for where the character is and what they are
   doing, without ever overriding an explicit user
   instruction or a locked/continuity outfit.

   Clothing metadata is lightweight and mostly
   inferred from the garment wording; only a few
   pieces carry explicit `contexts`/`avoidContexts`.
   No LLM, no GPU, no dependencies.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const themes = require('./themes');

// --- Environment context catalog ---------------------------------------------
//
// Each context exposes lightweight tags plus a soft policy: the footwear that
// makes sense, whether heavy outerwear is expected, and whether accessories
// should be kept minimal. These guide selection; they are not absolute rules.

const CONTEXT_CATALOG = {
    bedroom: {
        label: 'Bedroom',
        tags: ['indoor', 'private', 'relaxed', 'home', 'casual', 'barefoot-friendly'],
        allowedFootwear: ['barefoot', 'socks', 'slippers'],
        removeOuterwear: 'heavy',
        minimizeAccessories: true,
        formality: 'relaxed'
    },
    living_room: {
        label: 'Living Room',
        tags: ['indoor', 'private', 'relaxed', 'home', 'casual', 'barefoot-friendly'],
        allowedFootwear: ['barefoot', 'socks', 'slippers', 'flats'],
        removeOuterwear: 'heavy',
        minimizeAccessories: true,
        formality: 'relaxed'
    },
    bathroom: {
        label: 'Bathroom',
        tags: ['indoor', 'private', 'relaxed', 'home', 'barefoot-friendly', 'wet'],
        allowedFootwear: ['barefoot', 'slippers'],
        removeOuterwear: 'all',
        minimizeAccessories: true,
        formality: 'relaxed'
    },
    sleeping: {
        label: 'Sleeping',
        tags: ['indoor', 'private', 'relaxed', 'home', 'sleeping', 'barefoot-friendly'],
        allowedFootwear: ['barefoot', 'socks'],
        removeOuterwear: 'all',
        minimizeAccessories: true,
        formality: 'relaxed'
    },
    kitchen: {
        label: 'Kitchen',
        tags: ['indoor', 'private', 'home', 'casual', 'barefoot-friendly'],
        allowedFootwear: ['barefoot', 'socks', 'slippers', 'flats', 'trainers'],
        removeOuterwear: 'heavy',
        minimizeAccessories: true,
        formality: 'casual'
    },
    cafe: {
        label: 'Cafe',
        tags: ['indoor', 'social', 'casual', 'public', 'walking', 'streetwear-friendly'],
        allowedFootwear: ['trainers', 'flats', 'sandals', 'boots'],
        removeOuterwear: 'none',
        formality: 'casual'
    },
    restaurant: {
        label: 'Restaurant',
        tags: ['indoor', 'social', 'public', 'smart', 'evening'],
        allowedFootwear: ['flats', 'formal', 'heels', 'boots', 'sandals'],
        removeOuterwear: 'none',
        formality: 'smart'
    },
    bar: {
        label: 'Bar',
        tags: ['indoor', 'social', 'public', 'evening', 'fashionable'],
        allowedFootwear: ['boots', 'heels', 'formal', 'sandals'],
        removeOuterwear: 'none',
        formality: 'evening'
    },
    office: {
        label: 'Office',
        tags: ['indoor', 'professional', 'public', 'formal'],
        allowedFootwear: ['formal', 'flats', 'heels', 'boots'],
        removeOuterwear: 'none',
        formality: 'professional'
    },
    gym: {
        label: 'Gym',
        tags: ['active', 'indoor', 'exercise', 'athletic'],
        allowedFootwear: ['trainers'],
        removeOuterwear: 'all',
        minimizeAccessories: true,
        formality: 'athletic'
    },
    hiking: {
        label: 'Hiking',
        tags: ['outdoor', 'active', 'rugged', 'walking'],
        allowedFootwear: ['boots', 'trainers'],
        removeOuterwear: 'none',
        formality: 'practical'
    },
    beach: {
        label: 'Beach',
        tags: ['outdoor', 'hot', 'warm', 'relaxed', 'water', 'barefoot-friendly'],
        allowedFootwear: ['barefoot', 'sandals', 'slides'],
        removeOuterwear: 'all',
        formality: 'relaxed'
    },
    mall: {
        label: 'Shopping Mall',
        tags: ['indoor', 'public', 'social', 'walking', 'streetwear-friendly'],
        allowedFootwear: ['trainers', 'flats', 'sandals', 'boots'],
        removeOuterwear: 'none',
        formality: 'casual'
    },
    street: {
        label: 'Street',
        tags: ['outdoor', 'public', 'urban', 'walking', 'streetwear-friendly'],
        allowedFootwear: ['trainers', 'flats', 'sandals', 'boots'],
        removeOuterwear: 'none',
        formality: 'casual'
    },
    park: {
        label: 'Park',
        tags: ['outdoor', 'public', 'relaxed', 'walking'],
        allowedFootwear: ['trainers', 'sandals', 'flats', 'boots'],
        removeOuterwear: 'none',
        formality: 'casual'
    },
    party: {
        label: 'Party',
        tags: ['indoor', 'social', 'evening', 'fashionable', 'public'],
        allowedFootwear: ['heels', 'boots', 'sandals', 'formal'],
        removeOuterwear: 'none',
        formality: 'evening'
    },
    date_night: {
        label: 'Date Night',
        tags: ['social', 'evening', 'fashionable', 'public'],
        allowedFootwear: ['heels', 'sandals', 'boots', 'pumps'],
        removeOuterwear: 'none',
        formality: 'evening'
    },
    wedding: {
        label: 'Wedding',
        tags: ['indoor', 'formal', 'social', 'evening'],
        allowedFootwear: ['heels', 'formal', 'flats'],
        removeOuterwear: 'none',
        formality: 'formal'
    },
    resort: {
        label: 'Resort',
        tags: ['outdoor', 'hot', 'warm', 'relaxed', 'vacation', 'water', 'barefoot-friendly'],
        allowedFootwear: ['sandals', 'slides', 'barefoot'],
        removeOuterwear: 'all',
        formality: 'relaxed'
    },
    studio: {
        label: 'Studio',
        tags: ['indoor', 'neutral'],
        allowedFootwear: ['heels', 'formal', 'flats', 'trainers'],
        removeOuterwear: 'none',
        formality: 'neutral'
    }
};

// Ordered environment hints. Specific places come before broad ones so a
// keyword never collapses onto a generic context by accident.
const ENVIRONMENT_HINTS = [
    { id: 'bedroom', re: /\b(?:bedroom|in bed|on (?:the|her|his) bed|lying on bed|bedroom mirror|sitting on the bed)\b/i },
    { id: 'sleeping', re: /\b(?:sleeping|asleep|taking a nap|napping|just woke|waking up)\b/i },
    { id: 'bathroom', re: /\b(?:bathroom|shower|bathtub|at the vanity|bathroom mirror)\b/i },
    { id: 'living_room', re: /\b(?:living room|lounge room|lounge|on the sofa|on the couch|sofa|couch)\b/i },
    { id: 'kitchen', re: /\b(?:kitchen|cooking|at the stove|making coffee)\b/i },
    { id: 'cafe', re: /\b(?:caf[eé]|coffee shop|coffeehouse|coffee house|bakery|brunch)\b/i },
    { id: 'restaurant', re: /\b(?:restaurant|bistro|dining room|dinner table)\b/i },
    { id: 'bar', re: /\b(?:bar|pub|cocktail lounge|nightclub|night club|clubbing)\b/i },
    { id: 'office', re: /\b(?:office|workplace|cubicle|boardroom|meeting room|at work|at the office)\b/i },
    { id: 'gym', re: /\b(?:gym|workout|work[- ]out|fitness|training|weight room|exercise)\b/i },
    { id: 'hiking', re: /\b(?:hiking|trail|trek|backpacking|mountain|ridge)\b/i },
    { id: 'beach', re: /\b(?:beach|shore|seaside|coastline|lagoon|poolside|by the pool)\b/i },
    { id: 'mall', re: /\b(?:mall|shopping cent(?:er|re)|shopping|boutique|department store)\b/i },
    { id: 'street', re: /\b(?:street|sidewalk|crosswalk|downtown|city street|urban|plaza)\b/i },
    { id: 'park', re: /\b(?:park|garden|meadow|field)\b/i },
    { id: 'party', re: /\b(?:party|celebration|festival|rave)\b/i },
    { id: 'date_night', re: /\b(?:date night|on a date|romantic dinner)\b/i },
    { id: 'wedding', re: /\b(?:wedding|ceremony|gala|black tie)\b/i },
    { id: 'resort', re: /\b(?:resort|vacation|holiday|tropical|island)\b/i },
    { id: 'studio', re: /\b(?:studio|backdrop|seamless backdrop)\b/i }
];

// Activity cues that change what an environment means. "Getting ready for a
// date in her bedroom" is a date-night preparation, not a relaxed bedroom scene.
const ACTIVITY_TARGETS = [
    { id: 'date_night', re: /\b(?:date|romantic dinner)\b/i },
    { id: 'party', re: /\b(?:party|celebration|night out|clubbing)\b/i },
    { id: 'restaurant', re: /\b(?:dinner|restaurant)\b/i },
    { id: 'gym', re: /\b(?:gym|workout|work[- ]out|training|exercise)\b/i },
    { id: 'wedding', re: /\b(?:wedding|ceremony)\b/i },
    { id: 'beach', re: /\b(?:swim|swimming|beach)\b/i },
    { id: 'office', re: /\b(?:office|work)\b/i }
];

const GETTING_READY_RE =
    /\b(?:getting ready|get ready|preparing (?:for|to)|dressing (?:up )?for|about to (?:go|leave)|ready for)\b/i;

// Activity compatibility policy. An activity is a soft styling cue: it can
// allow footwear the place alone would forbid (comfort), restrict to practical
// footwear, minimize accessories, or ask for comfortable clothing in a private
// setting. Matched by activity id (the shared Activity Library) or by the
// scene wording, so both the Playground and raw Chat text resolve. This is the
// ONE place activity affects clothing; explicit user garments are never touched.
const ACTIVITY_MODIFIERS = [
    {
        ids: ['reading', 'studying'],
        re: /\b(?:reading|read(?:ing)?\b|book|novel|studying|homework|revising)\b/i,
        footwear: ['barefoot', 'socks', 'slippers'],
        minimizeAccessories: true,
        comfort: true
    },
    {
        ids: ['relaxing', 'listening-to-music', 'watching-tv', 'hanging-out'],
        re: /\b(?:relax(?:ing|ed)?|unwind(?:ing)?|loung(?:e|ing)|lying (?:on|in)|chilling|listening to music|headphones|watching (?:tv|television|a movie|a show)|netflix)\b/i,
        footwear: ['barefoot', 'socks', 'slippers'],
        minimizeAccessories: true,
        comfort: true
    },
    {
        ids: ['exercising'],
        re: /\b(?:exercis(?:e|ing)|work(?:ing)? ?out|workout|training|lifting weights|jogging|running|stretching|yoga)\b/i,
        footwear: ['trainers'],
        minimizeAccessories: true,
        active: true
    },
    {
        ids: ['cooking'],
        re: /\b(?:cooking|baking|preparing (?:a meal|food|dinner)|making (?:dinner|lunch|breakfast))\b/i,
        footwear: ['barefoot', 'socks', 'slippers', 'flats'],
        minimizeAccessories: true
    },
    {
        ids: ['getting-ready'],
        re: /\b(?:getting[- ]ready|getting dressed|putting on makeup|doing (?:her|his|their|my) makeup|applying makeup)\b/i,
        allowDressy: true
    },
    {
        ids: ['working-on-laptop', 'working'],
        re: /\b(?:working on (?:a|the|her|his|their|my)?\s*laptop|typing|laptop|working|at work)\b/i,
        footwear: ['flats', 'trainers', 'formal', 'boots']
    },
    {
        ids: ['walking-together', 'sightseeing', 'exploring-city', 'shopping', 'taking-photos'],
        re: /\b(?:walking|strolling|sightseeing|exploring|shopping|browsing|taking (?:photos|pictures|photographs))\b/i,
        footwear: ['trainers', 'flats', 'sandals', 'boots']
    },
    {
        ids: ['coffee-chat', 'casual-conversation', 'laughing-together'],
        re: /\b(?:coffee|conversation|chatting|talking|catching up|laughing|drinks)\b/i,
        footwear: ['trainers', 'flats', 'sandals', 'boots', 'heels']
    },
    {
        ids: ['waiting-for-transport'],
        re: /\b(?:waiting for (?:the )?(?:train|bus|subway|metro|flight)|at the (?:station|bus stop|airport)|waiting to board)\b/i,
        footwear: ['trainers', 'flats', 'sandals', 'boots']
    }
];

// Comfortable bottoms used when a relaxed/home activity replaces a structured
// garment in a private setting. Data only; substitution is deterministic.
const COMFORT_BOTTOMS = [
    'soft lounge shorts',
    'comfy knit shorts',
    'soft cotton shorts',
    'relaxed lounge pants',
    'soft joggers'
];

const STRUCTURED_BOTTOM_RE = /\b(?:jeans|trousers|chinos|slacks|tailored|pencil skirt|culottes|cargo|corduroy|cigarette)\b/i;

const WARM_RE = /\b(?:beach|summer|tropical|pool|hot|warm|sunny|seaside|coastal|resort|desert|palm|sunlit)\b/i;
const COLD_RE = /\b(?:winter|snow|snowy|cold|chilly|freezing|arctic|frost|blizzard)\b/i;

const FOOTWEAR_PHRASES = {
    barefoot: 'barefoot',
    socks: 'soft socks',
    slippers: 'house slippers',
    trainers: 'clean sneakers',
    heels: 'elegant heels',
    boots: 'ankle boots',
    sandals: 'simple sandals',
    slides: 'slip-on slides',
    flats: 'simple flats',
    formal: 'leather loafers',
    pumps: 'pointed-toe pumps'
};

// --- Clothing metadata --------------------------------------------------------

// Category inference. Ordered so a compound name resolves to its dominant part
// ("shirt dress" is a dress, "denim jacket" is outerwear, "silk camisole" a top).
const CATEGORY_RULES = [
    { category: 'footwear', re: /\b(?:shoes?|sneakers?|trainers?|heels?|pumps?|boots?|sandals?|slides?|flats?|loafers?|slippers?|socks?|espadrilles|mules|stilettos?|derbies|oxfords?|barefoot|bare feet)\b/i },
    { category: 'onePiece', re: /\b(?:dress|gown|frock|jumpsuit|romper|sundress|bodycon|kaftan|kilt)\b/i },
    { category: 'bottom', re: /\b(?:jeans|trousers|pants|shorts|skirt|leggings|joggers|chinos|tights|culottes|cargo|slacks)\b/i },
    { category: 'outerwear', re: /\b(?:coat|jacket|blazer|parka|overcoat|trench|cardigan|hoodie|sweatshirt|sweater|jumper|bomber|fleece|windbreaker|overshirt|vest|robe|mantle|poncho|shawl|raincoat)\b/i },
    { category: 'top', re: /\b(?:top|t-?shirt|tee|shirt|blouse|tank|camisole|bustier|corset|polo|henley|turtleneck|bodysuit|crop)\b/i },
    { category: 'accessory', re: /\b(?:hat|cap|scarf|sunglasses|gloves|bag|handbag|clutch|necklace|earrings?|bracelet|watch|belt|jewell?ery|purse|backpack|beanie|headband|ribbon)\b/i }
];

const FOOTWEAR_RULES = [
    { category: 'trainers', re: /\b(?:sneakers?|trainers?|running shoes|training shoes|skate shoes|high[- ]?tops?|cross[- ]?training)\b/i },
    { category: 'pumps', re: /\b(?:pumps?|slingback)\b/i },
    { category: 'heels', re: /\b(?:stilettos?|heels?|heeled sandals?|ankle[- ]strap heels?)\b/i },
    { category: 'boots', re: /\b(?:boots?|ankle boots?|combat boots?|platform boots?|over[- ]the[- ]knee boots?)\b/i },
    { category: 'slides', re: /\b(?:slides?|flip[- ]?flops)\b/i },
    { category: 'sandals', re: /\b(?:sandals?|espadrilles|mules)\b/i },
    { category: 'formal', re: /\b(?:loafers?|derbies|oxfords?|formal shoes?|brogues|dress shoes?)\b/i },
    { category: 'flats', re: /\b(?:flats?|ballet|mary jane|slip[- ]?ons?)\b/i },
    { category: 'slippers', re: /\b(?:slippers?|house shoes?|shower slippers)\b/i },
    { category: 'socks', re: /\b(?:socks?)\b/i },
    { category: 'barefoot', re: /\b(?:barefoot|bare feet|no shoes)\b/i }
];

// Keyword metadata. Contexts are soft preferences; avoidContexts are the
// incompatibilities that let composition and the resolver steer away.
const AVOID_RULES = [
    { re: FOOTWEAR_RULES[0].re, avoidContexts: ['bedroom', 'bathroom', 'sleeping', 'beach', 'resort'] },
    { re: FOOTWEAR_RULES[1].re, avoidContexts: ['bedroom', 'bathroom', 'sleeping', 'beach', 'resort', 'gym', 'hiking', 'park', 'street', 'mall'] },
    { re: FOOTWEAR_RULES[2].re, avoidContexts: ['bedroom', 'bathroom', 'sleeping', 'beach', 'resort', 'gym', 'hiking', 'park', 'street', 'mall'] },
    { re: FOOTWEAR_RULES[3].re, avoidContexts: ['bedroom', 'bathroom', 'sleeping', 'beach', 'resort', 'gym'] },
    { re: FOOTWEAR_RULES[4].re, avoidContexts: ['gym', 'hiking', 'office', 'wedding'] },
    { re: FOOTWEAR_RULES[5].re, avoidContexts: ['gym', 'hiking', 'office', 'wedding'] },
    { re: FOOTWEAR_RULES[6].re, avoidContexts: ['gym', 'hiking'] },
    { re: FOOTWEAR_RULES[7].re, avoidContexts: ['gym', 'hiking'] },
    { re: FOOTWEAR_RULES[8].re, avoidContexts: ['street', 'mall', 'office', 'gym', 'hiking', 'cafe', 'restaurant', 'bar', 'party', 'date_night', 'wedding'] },
    { re: /\b(?:wool coat|overcoat|trench|parka|puffer|down|quilted|insulated|fur[- ]lined|mantle)\b/i, avoidContexts: ['bedroom', 'living_room', 'kitchen', 'bathroom', 'sleeping', 'gym', 'beach', 'resort'] },
    { re: /\b(?:blazer|structured coat|tailored coat)\b/i, avoidContexts: ['bedroom', 'bathroom', 'sleeping', 'gym', 'beach', 'resort'] },
    { re: /\b(?:hoodie|sweatshirt)\b/i, avoidContexts: ['office', 'wedding', 'party', 'date_night', 'restaurant'] },
    { re: /\b(?:crop top|camisole|bustier|corset|off[- ]shoulder)\b/i, avoidContexts: ['office', 'gym', 'hiking'] },
    { re: /\b(?:shorts?)\b/i, avoidContexts: ['office', 'wedding'] },
    { re: /\b(?:jeans|trousers|pants|chinos|slacks)\b/i, avoidContexts: ['gym', 'sleeping', 'beach'] },
    { re: /\b(?:joggers|sweatpants|leggings|lounge pants)\b/i, avoidContexts: ['office', 'wedding', 'restaurant', 'party', 'date_night'] },
    { re: /\b(?:bag|tote|clutch|purse|handbag|backpack|satchel|duffel)\b/i, avoidContexts: ['bedroom', 'bathroom', 'sleeping', 'gym'] },
    { re: /\b(?:sunglasses?)\b/i, avoidContexts: ['bedroom', 'bathroom', 'sleeping'] },
    { re: /\b(?:hat|cap|beanie)\b/i, avoidContexts: ['bedroom', 'bathroom', 'sleeping'] }
];

// The named example from the spec, kept as explicit metadata for reference.
const CLOTHING_METADATA = {
    'white sneakers': {
        category: 'footwear',
        contexts: ['street', 'cafe', 'mall', 'casual-outdoor', 'gym'],
        compatibleContexts: ['casual', 'urban', 'social'],
        avoidContexts: ['bedroom', 'bathroom', 'sleeping'],
        substitutes: ['barefoot', 'ankle socks', 'house slippers']
    }
};

const HEAVY_OUTERWEAR_RE =
    /\b(?:wool coat|overcoat|trench|parka|puffer|down|quilted|insulated|fur[- ]lined|mantle|blazer|tailored coat|structured coat|heavy)\b/i;

const DROP_ACCESSORY_RE =
    /\b(?:bag|tote|clutch|purse|handbag|backpack|satchel|duffel|sunglasses|hat|cap|beanie|scarf|belt|watch)\b/i;

// Contexts whose clothing budget favors relaxed/home styling. Used for
// accessory minimization even when a slot is not explicitly tagged.
const HOME_CONTEXTS = new Set(['bedroom', 'living_room', 'bathroom', 'sleeping', 'kitchen']);

function inferCategory(value) {
    const text = String(value || '');
    for (const rule of CATEGORY_RULES) {
        if (rule.re.test(text)) return rule.category;
    }
    return '';
}

function footwearCategory(value) {
    const text = String(value || '');
    for (const rule of FOOTWEAR_RULES) {
        if (rule.re.test(text)) return rule.category;
    }
    return '';
}

function inferAvoidContexts(value) {
    const text = String(value || '');
    const avoid = [];
    for (const rule of AVOID_RULES) {
        if (rule.re.test(text)) {
            for (const tag of rule.avoidContexts) if (!avoid.includes(tag)) avoid.push(tag);
        }
    }
    return avoid;
}

// The lightweight metadata for a single piece. Explicit registry entries win;
// otherwise the category and avoid-contexts are inferred from the wording.
function pieceMetadata(value) {
    const text = String(value || '');
    const explicit = CLOTHING_METADATA[text.trim().toLowerCase()] || CLOTHING_METADATA[text.trim()];
    const category = (explicit && explicit.category) || inferCategory(text);
    return {
        value: text,
        category,
        contexts: (explicit && explicit.contexts) ? explicit.contexts.slice() : [],
        compatibleContexts: (explicit && explicit.compatibleContexts) ? explicit.compatibleContexts.slice() : [],
        avoidContexts: (explicit && explicit.avoidContexts) ? explicit.avoidContexts.slice() : inferAvoidContexts(text),
        substitutes: (explicit && explicit.substitutes) ? explicit.substitutes.slice() : []
    };
}

function contextTagSet(ctx) {
    const tags = new Set();
    if (ctx && ctx.id) tags.add(ctx.id);
    for (const tag of (ctx && ctx.tags) || []) tags.add(tag);
    return tags;
}

function entryAvoidsContext(entry, ctx) {
    if (!entry) return false;
    const tags = contextTagSet(ctx);
    const explicit = Array.isArray(entry.avoidContexts) ? entry.avoidContexts : [];
    if (explicit.some((tag) => tags.has(tag))) return true;
    return pieceMetadata(entry.value).avoidContexts.some((tag) => tags.has(tag));
}

// Drop pieces that are clearly incompatible with the environment, keeping the
// pool unchanged when every piece would be filtered out (so a pack is never
// left without a slot).
function compatiblePieces(list, ctx) {
    const entries = Array.isArray(list) ? list.filter(Boolean) : [];
    if (!ctx || !ctx.id) return entries;
    const filtered = entries.filter((entry) => !entryAvoidsContext(entry, ctx));
    return filtered.length ? filtered : entries;
}

// --- Environment classification ----------------------------------------------

function matchContext(text) {
    const value = String(text || '');
    for (const hint of ENVIRONMENT_HINTS) {
        if (hint.re.test(value)) return hint.id;
    }
    return '';
}

function activityTarget(activity) {
    const value = String(activity || '');
    for (const target of ACTIVITY_TARGETS) {
        if (target.re.test(value)) return target.id;
    }
    return '';
}

// Merge the activity compatibility rules that match an activity id or wording.
// Returns null when nothing matches so the resolver stays a no-op.
function activityModifiers(activity) {
    const text = String(activity || '').trim();
    if (!text) return null;
    const key = text.toLowerCase();
    const merged = {
        matched: [],
        footwear: [],
        minimizeAccessories: false,
        comfort: false,
        active: false,
        allowDressy: false
    };
    let any = false;
    for (const rule of ACTIVITY_MODIFIERS) {
        const idHit = Array.isArray(rule.ids) && rule.ids.includes(key);
        const reHit = rule.re && rule.re.test(text);
        if (!idHit && !reHit) continue;
        any = true;
        if (rule.ids && rule.ids[0]) merged.matched.push(rule.ids[0]);
        for (const value of rule.footwear || []) {
            if (!merged.footwear.includes(value)) merged.footwear.push(value);
        }
        if (rule.minimizeAccessories) merged.minimizeAccessories = true;
        if (rule.comfort) merged.comfort = true;
        if (rule.active) merged.active = true;
        if (rule.allowDressy) merged.allowDressy = true;
    }
    return any ? merged : null;
}

// Resolve an environment + activity into a context descriptor. Deterministic and
// pure; returns null when nothing environment-like is present so the resolver
// stays a no-op for abstract scenes.
function classifyEnvironment(environment, activity) {
    const envText = String(environment || '').trim();
    const actText = String(activity || '').trim();
    const combined = (envText + ' ' + actText).trim();
    if (!combined) return null;
    let id = matchContext(envText) || matchContext(combined);
    const target = activityTarget(actText || combined);
    const gettingReady = GETTING_READY_RE.test(combined);
    if (gettingReady && target) id = target;
    if (!id && target) id = target;
    // Without a recognized place/activity the resolver stays a no-op, so an
    // abstract scene never gets clothing "corrected" toward a guessed context.
    if (!id || !CONTEXT_CATALOG[id]) return null;
    const base = CONTEXT_CATALOG[id];
    const tags = (base.tags || []).slice();
    if (WARM_RE.test(combined) && !tags.includes('warm')) tags.push('warm');
    if (COLD_RE.test(combined) && !tags.includes('cold')) tags.push('cold');
    return {
        id: id || '',
        label: base.label,
        tags,
        allowedFootwear: (base.allowedFootwear || []).slice(),
        removeOuterwear: base.removeOuterwear || 'none',
        minimizeAccessories: Boolean(base.minimizeAccessories) || HOME_CONTEXTS.has(id),
        formality: base.formality || 'casual',
        warm: tags.includes('warm'),
        cold: tags.includes('cold'),
        // Activity styling cues (soft; applied on top of the environment policy).
        activityModifiers: activityModifiers(actText)
    };
}

// --- Outfit parsing / rebuilding ---------------------------------------------

const COMPONENT_KEYS = ['onePiece', 'outerwear', 'top', 'bottom', 'shoes', 'accessories'];

// Map an explicit-slot name to the component slot it owns.
const SLOT_COMPONENT_KEYS = {
    dress: 'onePiece',
    onePiece: 'onePiece',
    outerwear: 'outerwear',
    top: 'top',
    bottom: 'bottom',
    footwear: 'shoes',
    accessory: 'accessories'
};

function joinPhrases(parts) {
    const list = (Array.isArray(parts) ? parts : []).map((p) => String(p || '').trim()).filter(Boolean);
    if (!list.length) return '';
    if (list.length === 1) return list[0];
    if (list.length === 2) return list[0] + ' and ' + list[1];
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

function emptyComponents() {
    return { top: '', bottom: '', onePiece: '', outerwear: '', shoes: '', accessories: '' };
}

// Best-effort decomposition of an outfit sentence. The composer's own output is
// already structured; this path exists so the public resolver signature also
// accepts a plain string.
function decomposeOutfit(text) {
    const components = emptyComponents();
    const value = String(text || '').trim();
    if (!value) return components;
    const phrases = value.split(/\s*,\s*|\s+and\s+|\s+with\s+|\s+over\s+/i)
        .map((phrase) => phrase.trim())
        .filter(Boolean);
    for (const phrase of phrases) {
        const category = inferCategory(phrase);
        if (category === 'onePiece' && !components.onePiece) components.onePiece = phrase;
        else if (category === 'outerwear' && !components.outerwear) components.outerwear = phrase;
        else if (category === 'top' && !components.top) components.top = phrase;
        else if (category === 'bottom' && !components.bottom) components.bottom = phrase;
        else if (category === 'footwear' && !components.shoes) components.shoes = phrase;
        else if (category === 'accessory' && !components.accessories) components.accessories = phrase;
    }
    return components;
}

// Rebuild a natural-language outfit from its components, preserving the
// layered "X over Y with Z" phrasing the composer uses.
function describeOutfit(components) {
    const c = components || {};
    const parts = [];
    if (c.outerwear && c.onePiece) parts.push(c.outerwear + ' over ' + c.onePiece);
    else if (c.outerwear && c.top && c.bottom) parts.push(c.outerwear + ' over ' + c.top + ' with ' + c.bottom);
    else if (c.outerwear && c.top) parts.push(c.outerwear + ' over ' + c.top);
    else if (c.outerwear && c.bottom) parts.push(c.outerwear + ' with ' + c.bottom);
    else {
        if (c.onePiece) parts.push(c.onePiece);
        if (c.top && c.bottom) parts.push(c.top + ' with ' + c.bottom);
        else if (c.top) parts.push(c.top);
        else if (c.bottom) parts.push(c.bottom);
    }
    if (c.shoes) parts.push(c.shoes);
    if (c.accessories) parts.push(c.accessories);
    return joinPhrases(parts);
}

// Remove the slots the user explicitly specified so only the missing pieces are
// auto-filled (partial outfit instructions).
function stripSlots(components, slots) {
    const c = Object.assign(emptyComponents(), components || {});
    if (!slots) return c;
    for (const key of Object.keys(SLOT_COMPONENT_KEYS)) {
        if (slots[key]) c[SLOT_COMPONENT_KEYS[key]] = '';
    }
    if (slots.full) {
        c.onePiece = '';
        c.top = '';
        c.bottom = '';
    }
    return c;
}

// --- Explicitness -------------------------------------------------------------

// The garment slots a free-text instruction already decided. Used to preserve
// user control and to fill only the pieces the user left unspecified.
const SLOT_RULES = [
    { slot: 'full', re: /\b(?:suit|tuxedo|tux|jumpsuit|romper|two[- ]piece|co-?ord(?:\s+set)?|matching set|full outfit|complete outfit)\b/i },
    { slot: 'dress', re: /\b(?:dress|gown|frock|sundress|bodycon|slip dress)\b/i },
    { slot: 'outerwear', re: /\b(?:jacket|coat|blazer|parka|overcoat|trench|cardigan|hoodie|sweatshirt|sweater|jumper|robe|bomber|vest|overshirt|fleece|windbreaker|poncho|shawl)\b/i },
    { slot: 'top', re: /\b(?:top|t-?shirt|tee|shirt|blouse|tank|camisole|bustier|corset|polo|henley|turtleneck|bodysuit|crop)\b/i },
    { slot: 'bottom', re: /\b(?:jeans|trousers|pants|shorts|skirt|leggings|joggers|chinos|tights|culottes|cargo)\b/i },
    { slot: 'footwear', re: /\b(?:shoes|sneakers?|trainers?|heels?|boots?|sandals?|flats?|loafers?|pumps?|slippers?|socks?|barefoot|bare feet|espadrilles|mules)\b/i },
    { slot: 'accessory', re: /\b(?:hat|cap|scarf|sunglasses|gloves|bag|handbag|clutch|purse|necklace|earrings?|bracelet|watch|belt|jewell?ery|backpack|beanie)\b/i }
];

// The explicit garment slots in a message. `full` means the user described a
// complete outfit (or a one-piece/suit), so no auto-fill is warranted.
function detectClothingSlots(text) {
    const value = String(text || '');
    const slots = {
        any: false, full: false, dress: false, top: false, bottom: false,
        outerwear: false, footwear: false, accessory: false
    };
    if (!value) return slots;
    for (const rule of SLOT_RULES) {
        if (rule.re.test(value)) slots[rule.slot] = true;
    }
    slots.any = ['full', 'dress', 'top', 'bottom', 'outerwear', 'footwear', 'accessory']
        .some((key) => slots[key]);
    return slots;
}

// Explicit slots are the ones the resolver must never touch.
function explicitSlotsFrom(slots) {
    const explicit = {};
    for (const key of Object.keys(SLOT_COMPONENT_KEYS)) {
        if (slots && slots[key]) explicit[key === 'dress' ? 'dress' : key] = true;
    }
    if (slots && slots.full) {
        explicit.top = true;
        explicit.bottom = true;
        explicit.dress = true;
    }
    return explicit;
}

// --- Resolution ---------------------------------------------------------------

function pickIndex(len, rng) {
    if (len <= 1) return 0;
    const raw = typeof rng === 'function' ? Number(rng()) : 0;
    const base = Number.isFinite(raw) ? ((raw % 1) + 1) % 1 : 0;
    return Math.floor(base * len) % len;
}

function substituteFootwear(ctx, currentCategory, rng) {
    const options = (ctx.allowedFootwear || []).filter((category) => category !== currentCategory);
    if (!options.length) return '';
    const category = options[pickIndex(options.length, rng)];
    return FOOTWEAR_PHRASES[category] || category;
}

// Adapt a structured outfit to the environment. It inspects the complete outfit
// and only changes what is genuinely incompatible: heavy outerwear indoors,
// indoor footwear outdoors (and vice versa), and accessories that do not suit a
// private/exercise setting. An explicit user slot is never touched.
function adaptComponents(components, ctx, options = {}) {
    const c = Object.assign(emptyComponents(), components || {});
    const explicit = options.explicit || {};
    const protect = options.protect || {};
    const rng = options.rng;
    const adaptations = [];
    const activity = ctx.activityModifiers || null;
    // The activity can widen the footwear that is acceptable in a place (e.g.
    // barefoot while reading indoors) and call for minimal accessories.
    const allowedFootwear = (ctx.allowedFootwear || []).slice();
    if (activity && activity.footwear) {
        for (const category of activity.footwear) {
            if (!allowedFootwear.includes(category)) allowedFootwear.push(category);
        }
    }
    const minimizeAccessories = Boolean(ctx.minimizeAccessories) || Boolean(activity && activity.minimizeAccessories);

    if (c.outerwear && !explicit.outerwear && !protect.outerwear) {
        const heavy = HEAVY_OUTERWEAR_RE.test(c.outerwear);
        const removeAll = ctx.removeOuterwear === 'all';
        const removeHeavy = ctx.removeOuterwear === 'heavy' && heavy;
        const removeWarm = ctx.warm && heavy;
        if (removeAll || removeHeavy || removeWarm) {
            adaptations.push({
                slot: 'outerwear',
                from: c.outerwear,
                to: '',
                reason: ctx.warm
                    ? 'the warm ' + (ctx.label || 'setting') + ' does not need heavy outerwear'
                    : 'outerwear is not worn in ' + (ctx.label || 'this setting').toLowerCase()
            });
            c.outerwear = '';
        }
    }

    // A relaxed activity in a private setting replaces structured bottoms with
    // comfortable ones (reading in a bedroom, lounging at home).
    if (activity && activity.comfort && HOME_CONTEXTS.has(ctx.id)
        && c.bottom && !explicit.bottom && !protect.bottom && STRUCTURED_BOTTOM_RE.test(c.bottom)) {
        const next = COMFORT_BOTTOMS[pickIndex(COMFORT_BOTTOMS.length, rng)];
        adaptations.push({
            slot: 'bottom',
            from: c.bottom,
            to: next,
            reason: 'a relaxed activity in ' + (ctx.label || 'this setting').toLowerCase() + ' calls for comfortable clothing'
        });
        c.bottom = next;
    }

    if (c.shoes && !explicit.footwear && !protect.footwear && allowedFootwear.length) {
        const category = footwearCategory(c.shoes);
        if (category && !allowedFootwear.includes(category)) {
            const next = substituteFootwear(Object.assign({}, ctx, { allowedFootwear }), category, rng);
            if (next) {
                adaptations.push({
                    slot: 'shoes',
                    from: c.shoes,
                    to: next,
                    reason: (ctx.label || 'this environment') + ' is not suited to ' + category
                });
                c.shoes = next;
            }
        }
    }

    if (c.accessories && !explicit.accessory && !protect.accessories && minimizeAccessories) {
        if (DROP_ACCESSORY_RE.test(c.accessories)) {
            adaptations.push({
                slot: 'accessories',
                from: c.accessories,
                to: '',
                reason: 'accessories are kept minimal in ' + (ctx.label || 'this setting').toLowerCase()
            });
            c.accessories = '';
        }
    }

    return { components: c, adaptations };
}

// The central compatibility resolver. Accepts either a composed outfit
// (`{ outfit, components }`), a plain components object, or an outfit string,
// plus an environment (string or a classified context) and a context object
// (`{ activity, scene, rng, explicit, protect, packLabel }`). Deterministic for
// the same input + rng, and a no-op for an unknown environment.
function resolveOutfitForEnvironment(outfit, environment, context = {}) {
    const ctx = (environment && typeof environment === 'object' && Array.isArray(environment.tags))
        ? environment
        : classifyEnvironment(environment, context.activity || context.scene);

    let components;
    let initialOutfit;
    if (outfit && typeof outfit === 'object') {
        components = Object.assign(emptyComponents(), outfit.components || outfit);
        initialOutfit = outfit.outfit || describeOutfit(components);
    } else {
        initialOutfit = String(outfit || '').trim();
        components = decomposeOutfit(initialOutfit);
    }

    const resolution = {
        environment: ctx ? (ctx.id || '') : '',
        environmentLabel: ctx ? ctx.label : '',
        contextTags: ctx ? ctx.tags.slice() : [],
        scene: String(context.scene || context.activity || ''),
        packLabel: String(context.packLabel || ''),
        initialOutfit,
        adaptations: [],
        finalOutfit: initialOutfit
    };

    if (!ctx || !ctx.id) {
        return { outfit: initialOutfit, components, adaptations: [], resolution };
    }

    const adapted = adaptComponents(components, ctx, context);
    components = adapted.components;
    resolution.adaptations = adapted.adaptations;

    if (!adapted.adaptations.length) {
        resolution.finalOutfit = initialOutfit;
        return { outfit: initialOutfit, components, adaptations: [], resolution };
    }

    const finalOutfit = describeOutfit(components) || initialOutfit;
    resolution.finalOutfit = finalOutfit;
    return { outfit: finalOutfit, components, adaptations: adapted.adaptations, resolution };
}

// Activity-aware entry point. `activity` may be an Activity Library id, a
// scene phrase, or an activity definition object; the environment policy and
// the activity styling cues are resolved together. This is the signature the
// Playground and (later) the Chat Creative Director call.
function resolveOutfitForContext(outfit, environment, activity, context = {}) {
    const act = (activity && typeof activity === 'object')
        ? (activity.phrase || activity.id || '')
        : activity;
    const merged = Object.assign({}, context, {
        activity: act !== undefined && act !== null ? act : context.activity
    });
    return resolveOutfitForEnvironment(outfit, environment, merged);
}

// --- Debug --------------------------------------------------------------------

function debugEnabled(options = {}) {
    if (options.debug === true) return true;
    return String(process.env.JARVIS_PLAYGROUND_DEBUG || '') === '1';
}

// The readable resolution block requested for Playground debug mode. Never
// rendered into an image prompt.
function formatResolution(resolution) {
    if (!resolution) return '';
    const lines = [];
    lines.push('Selected Outfit Pack: ' + (resolution.packLabel || '(none)'));
    lines.push('Environment: ' + (resolution.environmentLabel || '(unknown)'));
    lines.push('Scene: ' + (resolution.scene || '(none)'));
    lines.push('Initial Outfit: ' + (resolution.initialOutfit || '(none)'));
    if (resolution.adaptations && resolution.adaptations.length) {
        for (const adaptation of resolution.adaptations) {
            lines.push('Adaptations: ' + adaptation.from + ' \u2192 ' + (adaptation.to || '(removed)'));
        }
    } else {
        lines.push('Adaptations: none');
    }
    lines.push('Final Outfit: ' + (resolution.finalOutfit || '(none)'));
    return lines.join('\n');
}

function logResolution(stage, resolution, options = {}) {
    if (!debugEnabled(options) || !resolution) return;
    console.log('[playground-debug] ' + stage + '\n' + formatResolution(resolution));
}

module.exports = {
    CONTEXT_CATALOG,
    ENVIRONMENT_HINTS,
    CLOTHING_METADATA,
    FOOTWEAR_PHRASES,
    COMPONENT_KEYS,
    SLOT_COMPONENT_KEYS,
    classifyEnvironment,
    matchContext,
    activityTarget,
    activityModifiers,
    inferCategory,
    footwearCategory,
    pieceMetadata,
    entryAvoidsContext,
    compatiblePieces,
    detectClothingSlots,
    explicitSlotsFrom,
    decomposeOutfit,
    describeOutfit,
    stripSlots,
    adaptComponents,
    resolveOutfitForEnvironment,
    resolveOutfitForContext,
    debugEnabled,
    formatResolution,
    logResolution
};
