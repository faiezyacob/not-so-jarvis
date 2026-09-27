/* ============================================
   JARVIS — Shared Activity Library
   A reusable creative vocabulary of what a subject is
   doing: "reading", "coffee-chat", "taking-selfie".
   Activities describe creative intent only — actions,
   composition and camera hints, environment
   compatibility and group sizes — never final image
   prompt text. This library is UI-independent so the
   Creative Playground (single character) and, later,
   the Chat Creative Director (multi-character) can
   consume the SAME definitions.
   No LLM, no GPU, no dependencies.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const outfitContext = require('./outfit-context');

// --- Environment vocabulary ---------------------------------------------------
//
// Environment compatibility is expressed with lightweight tokens. Tokens that
// match the central environment resolver (bedroom, cafe, gym, …) are recognized
// by its classification; extra tokens (library, transit, …) are matched from
// the scene wording so an activity still resolves against an environment the
// resolver does not model.

const ENVIRONMENT_PATTERNS = [
    { id: 'bedroom', re: /\b(?:bedroom|in bed|on the bed|bedside|dressing table|bedroom mirror)\b/i },
    { id: 'living_room', re: /\b(?:living room|lounge room|lounge|sofa|couch|on the couch)\b/i },
    { id: 'bathroom', re: /\b(?:bathroom|shower|bathtub|vanity|bathroom mirror)\b/i },
    { id: 'sleeping', re: /\b(?:sleeping|asleep|taking a nap|napping)\b/i },
    { id: 'kitchen', re: /\b(?:kitchen|stove|kitchen counter|making coffee)\b/i },
    { id: 'cafe', re: /\b(?:caf[eé]|coffee shop|coffeehouse|bakery|brunch)\b/i },
    { id: 'restaurant', re: /\b(?:restaurant|bistro|dining room|dinner table)\b/i },
    { id: 'bar', re: /\b(?:bar|pub|cocktail lounge|nightclub|night club)\b/i },
    { id: 'office', re: /\b(?:office|workplace|cubicle|boardroom|meeting room|desk)\b/i },
    { id: 'gym', re: /\b(?:gym|workout|work[- ]out|fitness|weight room|training)\b/i },
    { id: 'hiking', re: /\b(?:hiking|trail|trek|backpacking|mountain|ridge)\b/i },
    { id: 'beach', re: /\b(?:beach|shore|seaside|coastline|lagoon|poolside|by the pool)\b/i },
    { id: 'mall', re: /\b(?:mall|shopping cent(?:er|re)|boutique|department store)\b/i },
    { id: 'street', re: /\b(?:street|sidewalk|crosswalk|downtown|urban|city street)\b/i },
    { id: 'city', re: /\b(?:city|town|plaza)\b/i },
    { id: 'park', re: /\b(?:park|garden|meadow|field)\b/i },
    { id: 'party', re: /\b(?:party|celebration|festival|rave)\b/i },
    { id: 'date_night', re: /\b(?:date night|on a date|romantic dinner)\b/i },
    { id: 'wedding', re: /\b(?:wedding|ceremony|gala)\b/i },
    { id: 'resort', re: /\b(?:resort|vacation|holiday|tropical|island)\b/i },
    { id: 'studio', re: /\b(?:studio|backdrop|cyclorama)\b/i },
    { id: 'library', re: /\b(?:library|reading room|bookshop|bookstore|study room)\b/i },
    { id: 'balcony', re: /\b(?:balcony|terrace|veranda)\b/i },
    { id: 'transit', re: /\b(?:train|subway|metro|bus|tram|in transit|commuting|platform)\b/i },
    { id: 'station', re: /\b(?:station|train station|bus station)\b/i },
    { id: 'airport', re: /\b(?:airport|terminal|departure gate|boarding)\b/i },
    { id: 'bus_stop', re: /\b(?:bus stop|bus shelter)\b/i },
    { id: 'train_platform', re: /\b(?:train platform|platform)\b/i },
    { id: 'market', re: /\b(?:market|street market|farmers market|bazaar)\b/i },
    { id: 'museum', re: /\b(?:museum|gallery|exhibition)\b/i },
    { id: 'rooftop', re: /\b(?:rooftop|roof terrace)\b/i },
    { id: 'hotel', re: /\b(?:hotel|suite|lobby)\b/i },
    { id: 'mountain', re: /\b(?:mountain|summit|peak|cliff)\b/i },
    { id: 'travel', re: /\b(?:travel|trip|travelling|traveling|journey|wander|sightseeing)\b/i }
];

// --- Activity catalog ---------------------------------------------------------
//
// Each activity is lightweight structured metadata:
//   phrase             natural present-tense description (creative intent)
//   categories         social / home / lifestyle / travel
//   environments       preferred + compatible environment tokens
//   groupSizes         participant counts the activity supports
//   actions            believable character actions
//   compositionHints   framing / posture guidance
//   cameraHints        camera preferences (soft, never forced)

const ACTIVITIES = [
    // --- SOCIAL ---------------------------------------------------------------
    {
        id: 'coffee-chat',
        label: 'Coffee & Conversation',
        description: 'Relaxed conversation while having coffee or another drink.',
        phrase: 'having coffee and chatting',
        categories: ['social', 'lifestyle'],
        environments: { preferred: ['cafe', 'restaurant', 'kitchen', 'living_room'], compatible: ['office', 'park', 'mall', 'hotel'] },
        groupSizes: [1, 2, 3, 4],
        actions: ['holding a coffee cup', 'taking a sip', 'talking casually', 'listening to the other person', 'gesturing naturally'],
        compositionHints: ['seated naturally across a table', 'relaxed conversational framing', 'natural eye contact'],
        cameraHints: ['natural lifestyle framing', 'medium shot at table height', 'casual handheld perspective']
    },
    {
        id: 'casual-conversation',
        label: 'Casual Conversation',
        description: 'Relaxed everyday conversation.',
        phrase: 'chatting casually',
        categories: ['social'],
        environments: { preferred: ['living_room', 'cafe', 'kitchen', 'park', 'street'], compatible: ['office', 'mall', 'restaurant', 'transit'] },
        groupSizes: [1, 2, 3, 4],
        actions: ['talking with relaxed body language', 'listening attentively', 'smiling mid-conversation', 'leaning in slightly'],
        compositionHints: ['natural conversational grouping', 'relaxed eye contact', 'candid framing'],
        cameraHints: ['environmental medium shot', 'natural lifestyle framing']
    },
    {
        id: 'hanging-out',
        label: 'Hanging Out',
        description: 'Unwinding and spending relaxed time in a place.',
        phrase: 'hanging out and unwinding',
        categories: ['social', 'lifestyle'],
        environments: { preferred: ['living_room', 'bedroom', 'park', 'cafe'], compatible: ['street', 'mall', 'bar', 'balcony'] },
        groupSizes: [1, 2, 3, 4],
        actions: ['lounging comfortably', 'relaxed posture', 'leaning back casually', 'holding a drink'],
        compositionHints: ['casual relaxed framing', 'subject at ease', 'environment visible around them'],
        cameraHints: ['casual handheld framing', 'natural lifestyle photography']
    },
    {
        id: 'laughing-together',
        label: 'Laughing Together',
        description: 'A light, shared moment of laughter.',
        phrase: 'laughing together in a light moment',
        categories: ['social'],
        environments: { preferred: ['cafe', 'living_room', 'park', 'street'], compatible: ['restaurant', 'bar', 'party', 'kitchen'] },
        groupSizes: [2, 3, 4],
        actions: ['laughing genuinely', 'head tilted back slightly', 'one hand raised mid-gesture', 'eyes crinkled with laughter'],
        compositionHints: ['two or more subjects sharing the moment', 'spontaneous candid framing', 'dynamic natural grouping'],
        cameraHints: ['candid handheld framing', 'natural lifestyle photography']
    },
    {
        id: 'taking-selfie',
        label: 'Taking a Selfie',
        description: 'A phone selfie held at arm\u2019s length.',
        phrase: 'taking a selfie',
        categories: ['social', 'lifestyle'],
        environments: { preferred: ['street', 'cafe', 'bedroom', 'living_room', 'mall'], compatible: ['park', 'beach', 'gym', 'restaurant', 'party'] },
        groupSizes: [1, 2, 3],
        actions: ['holding a phone up with an extended arm', 'looking at the phone screen', 'tilting the head slightly', 'smiling at the camera'],
        compositionHints: ['phone held naturally', 'arm extended toward the camera', 'subject(s) positioned for selfie framing'],
        cameraHints: ['front-facing smartphone lens', 'arm\u2019s-length perspective', 'slightly wide perspective', 'handheld framing']
    },
    {
        id: 'walking-together',
        label: 'Walking',
        description: 'Walking at an easy, natural pace.',
        phrase: 'walking at an easy pace',
        categories: ['social', 'lifestyle'],
        environments: { preferred: ['street', 'park', 'mall', 'travel'], compatible: ['beach', 'hiking', 'resort', 'market'] },
        groupSizes: [1, 2, 3],
        actions: ['walking with a natural stride', 'moving in the same direction', 'hands relaxed at the sides', 'looking ahead'],
        compositionHints: ['natural walking posture', 'environmental space around the subject', 'sense of forward motion'],
        cameraHints: ['handheld smartphone perspective', 'environmental framing', 'candid walking shot']
    },

    // --- HOME ------------------------------------------------------------------
    {
        id: 'relaxing',
        label: 'Relaxing',
        description: 'Resting and unwinding in a comfortable setting.',
        phrase: 'relaxing comfortably',
        categories: ['home', 'lifestyle'],
        environments: { preferred: ['bedroom', 'living_room', 'balcony', 'resort'], compatible: ['park', 'beach', 'hotel'] },
        groupSizes: [1, 2],
        actions: ['lying back comfortably', 'resting with eyes half closed', 'breathing slow and easy', 'one arm tucked behind the head'],
        compositionHints: ['subject seated or reclining', 'relaxed posture', 'quiet unposed framing'],
        cameraHints: ['natural lifestyle framing', 'medium or environmental framing']
    },
    {
        id: 'reading',
        label: 'Reading',
        description: 'Reading a book or magazine in a quiet moment.',
        phrase: 'reading a paperback book while relaxing',
        categories: ['home', 'lifestyle'],
        environments: { preferred: ['bedroom', 'living_room', 'cafe', 'library'], compatible: ['park', 'balcony', 'beach', 'transit'] },
        groupSizes: [1, 2],
        actions: ['holding an open book', 'turning a page', 'eyes directed at the page', 'one knee drawn up'],
        compositionHints: ['subject seated or reclining', 'attention directed toward the book', 'relaxed posture'],
        cameraHints: ['natural lifestyle framing', 'medium or environmental portrait']
    },
    {
        id: 'watching-tv',
        label: 'Watching TV',
        description: 'Watching television from a sofa or bed.',
        phrase: 'watching television from the sofa',
        categories: ['home'],
        environments: { preferred: ['living_room', 'bedroom'], compatible: ['hotel'] },
        groupSizes: [1, 2, 3, 4],
        actions: ['sitting back on the sofa', 'gaze directed toward the television', 'remote in hand', 'legs tucked to one side'],
        compositionHints: ['subject seated facing the screen', 'screen glow on the surroundings', 'relaxed living-room framing'],
        cameraHints: ['natural lifestyle framing', 'candid indoor shot']
    },
    {
        id: 'listening-to-music',
        label: 'Listening to Music',
        description: 'Listening to music, often through headphones.',
        phrase: 'listening to music through headphones',
        categories: ['home', 'lifestyle'],
        environments: { preferred: ['bedroom', 'living_room', 'transit', 'street'], compatible: ['cafe', 'park', 'studio'] },
        groupSizes: [1, 2],
        actions: ['wearing headphones', 'eyes closed enjoying the music', 'nodding gently to the beat', 'holding a phone'],
        compositionHints: ['calm private moment', 'relaxed posture', 'attention turned inward'],
        cameraHints: ['natural lifestyle framing', 'medium shot']
    },
    {
        id: 'getting-ready',
        label: 'Getting Ready',
        description: 'Preparing appearance and outfit to go out.',
        phrase: 'getting ready to go out',
        categories: ['home', 'lifestyle'],
        environments: { preferred: ['bedroom', 'bathroom'], compatible: ['living_room', 'hotel'] },
        groupSizes: [1, 2],
        actions: ['adjusting an outfit in the mirror', 'applying makeup', 'checking a reflection', 'putting on jewellery'],
        compositionHints: ['mirror or vanity framing', 'attention on the reflection', 'a preparation moment'],
        cameraHints: ['casual smartphone framing', 'mirror shot', 'environmental indoor framing']
    },
    {
        id: 'cooking',
        label: 'Cooking',
        description: 'Preparing food in a kitchen.',
        phrase: 'cooking a meal in the kitchen',
        categories: ['home', 'lifestyle'],
        environments: { preferred: ['kitchen'], compatible: ['living_room', 'restaurant'] },
        groupSizes: [1, 2, 3],
        actions: ['stirring a pan', 'chopping ingredients', 'tasting from a spoon', 'reaching for a utensil'],
        compositionHints: ['hands and food visible', 'subject at the counter', 'warm domestic framing'],
        cameraHints: ['natural lifestyle framing', 'medium shot with hands in frame']
    },
    {
        id: 'working-on-laptop',
        label: 'Working on a Laptop',
        description: 'Working at a laptop with focused attention.',
        phrase: 'working on a laptop',
        categories: ['home', 'lifestyle'],
        environments: { preferred: ['office', 'cafe', 'living_room', 'bedroom', 'library'], compatible: ['kitchen', 'transit', 'hotel'] },
        groupSizes: [1, 2],
        actions: ['typing on a laptop', 'looking at the screen', 'one hand resting on the trackpad', 'pausing in thought'],
        compositionHints: ['laptop clearly visible', 'seated at a desk or table', 'attention toward the screen'],
        cameraHints: ['natural lifestyle framing', 'over-the-shoulder or three-quarter view']
    },

    // --- LIFESTYLE -------------------------------------------------------------
    {
        id: 'shopping',
        label: 'Shopping',
        description: 'Browsing shops and buying things.',
        phrase: 'browsing and shopping',
        categories: ['lifestyle', 'social'],
        environments: { preferred: ['mall', 'street', 'market'], compatible: ['boutique', 'city', 'plaza', 'store'] },
        groupSizes: [1, 2, 3],
        actions: ['carrying shopping bags', 'browsing a rack', 'holding up a garment', 'checking a price tag'],
        compositionHints: ['environmental retail framing', 'subject among displays', 'natural walking pose'],
        cameraHints: ['casual handheld framing', 'environmental medium shot']
    },
    {
        id: 'studying',
        label: 'Studying',
        description: 'Focused study with books and notes.',
        phrase: 'studying with focused attention',
        categories: ['lifestyle'],
        environments: { preferred: ['library', 'cafe', 'bedroom', 'office'], compatible: ['living_room', 'park', 'transit'] },
        groupSizes: [1, 2, 3],
        actions: ['reading notes', 'writing in a notebook', 'highlighting a page', 'resting a chin on one hand'],
        compositionHints: ['books and notes visible', 'subject focused downward', 'seated at a table'],
        cameraHints: ['natural lifestyle framing', 'medium shot from across the table']
    },
    {
        id: 'working',
        label: 'Working',
        description: 'Working with purpose, generally not at a laptop.',
        phrase: 'working with focused attention',
        categories: ['lifestyle'],
        environments: { preferred: ['office', 'cafe', 'living_room'], compatible: ['library', 'kitchen', 'studio'] },
        groupSizes: [1, 2, 3, 4],
        actions: ['working at a desk', 'reviewing papers', 'talking through a plan', 'focused expression'],
        compositionHints: ['subject engaged with the task', 'workspace visible', 'purposeful framing'],
        cameraHints: ['natural documentary framing', 'medium shot']
    },
    {
        id: 'exercising',
        label: 'Exercising',
        description: 'Active exercise with visible movement.',
        phrase: 'exercising with an active posture',
        categories: ['lifestyle'],
        environments: { preferred: ['gym', 'park', 'beach', 'hiking', 'studio'], compatible: ['living_room', 'bedroom', 'resort'] },
        groupSizes: [1, 2, 3],
        actions: ['mid-workout motion', 'stretching', 'lifting a weight', 'wiping away sweat'],
        compositionHints: ['dynamic active posture', 'movement visible', 'full-body or three-quarter framing'],
        cameraHints: ['natural action framing', 'handheld candid shot']
    },
    {
        id: 'taking-photos',
        label: 'Taking Photos',
        description: 'Photographing a place or moment.',
        phrase: 'taking photographs',
        categories: ['lifestyle', 'travel'],
        environments: { preferred: ['street', 'park', 'beach', 'travel', 'market'], compatible: ['cafe', 'mall', 'rooftop', 'museum'] },
        groupSizes: [1, 2],
        actions: ['holding a camera to the eye', 'framing a shot', 'checking the viewfinder', 'pointing the camera'],
        compositionHints: ['camera held up to the face', 'subject engaged with the scene', 'environmental context'],
        cameraHints: ['candid behind-the-scenes framing', 'medium shot']
    },

    // --- TRAVEL ----------------------------------------------------------------
    {
        id: 'sightseeing',
        label: 'Sightseeing',
        description: 'Taking in landmarks and views while travelling.',
        phrase: 'taking in the sights',
        categories: ['travel', 'lifestyle'],
        environments: { preferred: ['travel', 'street', 'museum', 'market'], compatible: ['beach', 'park', 'mountain', 'plaza', 'hiking'] },
        groupSizes: [1, 2, 3],
        actions: ['looking up at a landmark', 'taking in the view', 'holding a guide or phone', 'pointing something out'],
        compositionHints: ['landmark visible behind or beside the subject', 'environmental wide framing', 'a strong sense of place'],
        cameraHints: ['travel documentary framing', 'wide environmental shot']
    },
    {
        id: 'exploring-city',
        label: 'Exploring the City',
        description: 'Walking and discovering a city.',
        phrase: 'exploring the city on foot',
        categories: ['travel', 'lifestyle'],
        environments: { preferred: ['street', 'city', 'plaza', 'market'], compatible: ['park', 'mall', 'transit', 'rooftop'] },
        groupSizes: [1, 2, 3],
        actions: ['walking purposefully', 'glancing around the street', 'crossing at a corner', 'pausing to look at something'],
        compositionHints: ['urban environment visible', 'natural walking posture', 'a sense of movement'],
        cameraHints: ['handheld smartphone framing', 'environmental street shot']
    },
    {
        id: 'waiting-for-transport',
        label: 'Waiting for Transport',
        description: 'Waiting at a station, stop or terminal.',
        phrase: 'waiting for transport',
        categories: ['travel', 'lifestyle'],
        environments: { preferred: ['transit', 'station', 'airport', 'bus_stop', 'train_platform'], compatible: ['street', 'hotel', 'mall'] },
        groupSizes: [1, 2],
        actions: ['checking a phone or departure board', 'standing with luggage nearby', 'looking down the platform', 'leaning against a railing'],
        compositionHints: ['transit setting visible', 'relaxed waiting posture', 'environmental framing'],
        cameraHints: ['candid documentary framing', 'medium shot']
    }
];

const ACTIVITY_BY_ID = {};
for (const activity of ACTIVITIES) ACTIVITY_BY_ID[activity.id] = activity;

const CATEGORY_LABELS = {
    social: 'Social',
    home: 'Home',
    lifestyle: 'Lifestyle',
    travel: 'Travel'
};

const CATEGORY_ORDER = ['social', 'home', 'lifestyle', 'travel'];

// --- Environment matching ------------------------------------------------------

function environmentTokens(environment) {
    const text = String(environment || '');
    const tokens = new Set();
    if (!text) return tokens;
    // Reuse the central resolver when it recognizes the place (bedroom, cafe,
    // gym, …) so activity compatibility and clothing compatibility agree.
    const ctx = outfitContext.classifyEnvironment(text);
    if (ctx && ctx.id) tokens.add(ctx.id);
    for (const pattern of ENVIRONMENT_PATTERNS) {
        if (pattern.re.test(text)) tokens.add(pattern.id);
    }
    return tokens;
}

function supportsGroup(activity, groupSize) {
    if (groupSize === undefined || groupSize === null || groupSize === '') return true;
    const size = Number(groupSize);
    if (!Number.isFinite(size)) return true;
    const sizes = Array.isArray(activity.groupSizes) ? activity.groupSizes : [];
    return !sizes.length || sizes.includes(size);
}

// 3 = preferred place, 2 = compatible, 0 = no environment signal.
function activityEnvironmentScore(activity, tokens) {
    if (!tokens || !tokens.size) return 0;
    const preferred = (activity.environments && activity.environments.preferred) || [];
    const compatible = (activity.environments && activity.environments.compatible) || [];
    if (preferred.some((token) => tokens.has(token))) return 3;
    if (compatible.some((token) => tokens.has(token))) return 2;
    return 0;
}

function isUniversal(activity) {
    const preferred = (activity.environments && activity.environments.preferred) || [];
    const compatible = (activity.environments && activity.environments.compatible) || [];
    return !preferred.length && !compatible.length;
}

// Activities that suit an environment (preferred before compatible), optionally
// limited to a group size. Deterministic order; no RNG.
function getActivitiesForEnvironment(environment, options = {}) {
    const tokens = environmentTokens(environment);
    const groupSize = options.groupSize;
    const scored = ACTIVITIES.filter((activity) => supportsGroup(activity, groupSize))
        .map((activity) => ({ activity, score: activityEnvironmentScore(activity, tokens) }))
        .filter((entry) => entry.score > 0 || isUniversal(entry.activity))
        .sort((a, b) => b.score - a.score);
    return scored.map((entry) => entry.activity);
}

// --- Context-aware selection ---------------------------------------------------

// A light preference of activity categories per theme. It only biases ordering;
// environment compatibility remains the strongest signal.
const THEME_ACTIVITY_CATEGORIES = {
    'lifestyle-candid': ['social', 'home', 'lifestyle'],
    'travel-adventure': ['travel', 'lifestyle'],
    'seasonal-concepts': ['home', 'lifestyle'],
    'fantasy-character-worlds': [],
    'fashion-editorial': [],
    'cinematic-storytelling': [],
    'experimental-photography': []
};

// A character's wardrobe personality hints at what they are doing, so a
// gym-activewear character is more likely to be exercising than shopping.
const PACK_ACTIVITY_BIAS = {
    'gym-activewear': ['exercising'],
    'lounge-home': ['relaxing', 'reading', 'watching-tv', 'listening-to-music'],
    'vacation-summer': ['sightseeing', 'exploring-city', 'walking-together', 'taking-photos', 'relaxing'],
    'casual-night-out': ['getting-ready', 'hanging-out'],
    'glam-boudoir': ['getting-ready'],
    'confident-seductive': ['getting-ready'],
    'casual-smart': ['working-on-laptop', 'studying', 'working'],
    'minimalist-neutral': ['working-on-laptop', 'studying', 'reading'],
    'casual-streetwear': ['walking-together', 'exploring-city', 'shopping', 'taking-photos'],
    'soft-feminine-casual': ['coffee-chat', 'shopping']
};

function normalizeIdList(value) {
    if (Array.isArray(value)) return value.map((v) => String(v || '').trim()).filter(Boolean);
    const text = String(value || '').trim();
    return text ? [text] : [];
}

function themeIdOf(theme) {
    if (!theme) return '';
    return typeof theme === 'string' ? theme : String(theme.id || '');
}

function activityContextScore(activity, context = {}) {
    const tokens = context.tokens instanceof Set ? context.tokens : environmentTokens(context.environment);
    let score = activityEnvironmentScore(activity, tokens);
    if (!score && context.allowUniversal !== false && isUniversal(activity)) score = 1;

    const themeCategories = normalizeIdList(THEME_ACTIVITY_CATEGORIES[themeIdOf(context.theme)]);
    if (themeCategories.length && Array.isArray(activity.categories)
        && activity.categories.some((category) => themeCategories.includes(category))) {
        score += 0.5;
    }

    const packBiased = normalizeIdList(PACK_ACTIVITY_BIAS[String(context.outfitPack || '')]);
    if (packBiased.includes(activity.id)) score += 1.5;

    return score;
}

function scoredActivities(context = {}) {
    const tokens = environmentTokens(context.environment);
    const scoring = Object.assign({}, context, { tokens });
    const groupSize = context.groupSize === undefined ? null : context.groupSize;
    return ACTIVITIES.filter((activity) => supportsGroup(activity, groupSize))
        .map((activity) => ({ activity, score: activityContextScore(activity, scoring) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);
}

// Activities that suit an environment/theme/character, best first.
function getActivitiesForContext(environment, theme, character, options = {}) {
    const outfitPack = (options.outfitPack) || (character && character.outfitPack) || '';
    return scoredActivities({
        environment,
        theme,
        outfitPack,
        groupSize: options.groupSize
    }).map((entry) => entry.activity);
}

// Deterministic weighted pick over already-scored activities. Avoided ids are
// filtered out first so a re-roll does not immediately repeat.
function weightedActivityPick(scored, rng, avoid) {
    const avoidSet = new Set(avoid || []);
    const filtered = scored.filter((entry) => !avoidSet.has(entry.activity.id));
    const pool = filtered.length ? filtered : scored;
    if (!pool.length) return null;
    const weights = pool.map((entry) => Math.max(Number(entry.score) || 0, 0.25));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const raw = typeof rng === 'function' ? Number(rng()) : Math.random();
    const base = Number.isFinite(raw) ? ((raw % 1) + 1) % 1 : 0;
    let target = base * total;
    for (let i = 0; i < pool.length; i++) {
        target -= weights[i];
        if (target < 0) return pool[i].activity;
    }
    return pool[pool.length - 1].activity;
}

// Select one activity for a context. `mode` is 'auto' (fit the scene) or
// 'random' (any activity compatible with the group size). Deterministic for a
// given rng, so a seeded Surprise stays reproducible.
function selectActivity(context = {}) {
    const rng = typeof context.rng === 'function' ? context.rng : Math.random;
    const groupSize = context.groupSize === undefined ? 1 : context.groupSize;
    const avoid = Array.isArray(context.avoidActivityIds) ? context.avoidActivityIds.slice() : [];
    if (String(context.mode || 'auto') === 'random') {
        const pool = ACTIVITIES.filter((activity) => supportsGroup(activity, groupSize))
            .map((activity) => ({ activity, score: 1 }));
        return weightedActivityPick(pool, rng, avoid);
    }
    const scored = scoredActivities({
        environment: context.environment,
        theme: context.themeId || context.theme,
        outfitPack: context.outfitPack,
        groupSize
    });
    const pool = scored.length
        ? scored
        : ACTIVITIES.filter((activity) => supportsGroup(activity, groupSize)).map((activity) => ({ activity, score: 1 }));
    return weightedActivityPick(pool, rng, avoid);
}

// --- Natural-language matching -------------------------------------------------
//
// Ordered so a more specific phrase wins ("working on her laptop" before
// "working"; "walking around the city" before "walking"). No LLM required.
// Returns { id, label, confidence, activity, confident }; an uncertain match
// leaves the activity unspecified.

const ACTIVITY_KEYWORDS = [
    { id: 'taking-selfie', re: /\b(?:selfie|self[- ]portrait|mirror selfie)\b/i, confidence: 0.95 },
    { id: 'working-on-laptop', re: /\b(?:working|typing|on) (?:on )?(?:a|the|her|his|their|my)?\s*laptop\b|\blaptop\b/i, confidence: 0.85 },
    { id: 'studying', re: /\b(?:studying|doing homework|revising|exam prep|studying for)\b/i, confidence: 0.9 },
    { id: 'watching-tv', re: /\b(?:watching (?:tv|television|a show|a movie|a film|netflix)|binge-watching)\b/i, confidence: 0.9 },
    { id: 'listening-to-music', re: /\b(?:listening to music|headphones|earbuds|listening to a song)\b/i, confidence: 0.9 },
    { id: 'getting-ready', re: /\b(?:getting ready|getting dressed|putting on makeup|doing (?:her|his|their|my) makeup|applying makeup)\b/i, confidence: 0.85 },
    { id: 'taking-photos', re: /\b(?:taking (?:photos|pictures|photographs)|photographing|snapping (?:photos|pictures))\b/i, confidence: 0.85 },
    { id: 'exploring-city', re: /\b(?:exploring (?:the )?(?:city|town)|wandering the streets|walking around the city)\b/i, confidence: 0.85 },
    { id: 'sightseeing', re: /\b(?:sightseeing|seeing the sights|tourist|checking out the landmarks)\b/i, confidence: 0.85 },
    { id: 'waiting-for-transport', re: /\b(?:waiting for (?:the )?(?:train|bus|subway|metro|flight|plane)|at the (?:train station|bus stop|airport)|waiting to board)\b/i, confidence: 0.85 },
    { id: 'exercising', re: /\b(?:exercising|working out|workout|training|lifting weights|jogging|going for a run|doing yoga|stretching)\b/i, confidence: 0.85 },
    { id: 'shopping', re: /\b(?:shopping|browsing (?:shops|stores|the mall)|buying clothes|trying on clothes)\b/i, confidence: 0.9 },
    { id: 'reading', re: /\b(?:reading|read(?:ing)? a book|reading a novel|with a book)\b/i, confidence: 0.9 },
    { id: 'cooking', re: /\b(?:cooking|baking|preparing (?:a meal|food|dinner)|making (?:dinner|lunch|breakfast))\b/i, confidence: 0.85 },
    { id: 'hanging-out', re: /\b(?:hanging out|hang out|chilling|unwinding|relaxing with)\b/i, confidence: 0.85 },
    { id: 'laughing-together', re: /\b(?:laughing|laugh|giggling)\b/i, confidence: 0.75 },
    { id: 'walking-together', re: /\b(?:walking|strolling|taking a walk|going for a walk|on a walk)\b/i, confidence: 0.7 },
    { id: 'relaxing', re: /\b(?:relaxing|lounging|lying down|resting|taking it easy|unwinding)\b/i, confidence: 0.75 },
    { id: 'coffee-chat', re: /\b(?:coffee|espresso|latte|cappuccino|having a drink|over drinks|brunch)\b/i, confidence: 0.85 },
    { id: 'casual-conversation', re: /\b(?:chatting|talking|conversation|catching up|having a chat)\b/i, confidence: 0.7 },
    { id: 'working', re: /\b(?:working|at work)\b/i, confidence: 0.6 }
];

const MATCH_THRESHOLD = 0.6;

function matchActivityFromText(text) {
    const value = String(text || '').trim();
    if (!value) return { id: '', label: '', confidence: 0, activity: null, confident: false };
    let best = null;
    for (const keyword of ACTIVITY_KEYWORDS) {
        if (!keyword.re.test(value)) continue;
        const activity = ACTIVITY_BY_ID[keyword.id];
        if (!activity) continue;
        if (!best || keyword.confidence > best.confidence) {
            best = { id: activity.id, label: activity.label, confidence: keyword.confidence, activity };
        }
    }
    if (!best) return { id: '', label: '', confidence: 0, activity: null, confident: false };
    const confident = best.confidence >= MATCH_THRESHOLD;
    return {
        id: confident ? best.id : '',
        label: confident ? best.label : '',
        confidence: best.confidence,
        activity: confident ? best.activity : null,
        confident
    };
}

// --- Introspection / helpers ---------------------------------------------------

function normalizeActivityId(value) {
    const key = String(value || '').trim().toLowerCase();
    if (!key) return '';
    if (ACTIVITY_BY_ID[key]) return key;
    // Accept a label ("Coffee & Conversation") as well as an id.
    const lower = String(value || '').trim().toLowerCase();
    const found = ACTIVITIES.find((activity) => String(activity.label).toLowerCase() === lower);
    return found ? found.id : '';
}

function getActivity(id) {
    const key = normalizeActivityId(id);
    return key ? ACTIVITY_BY_ID[key] : null;
}

function activityLabel(id) {
    const activity = getActivity(id);
    return activity ? activity.label : '';
}

// Resolve a raw selection value from the UI or a caller. Returns
// { mode: 'none'|'auto'|'random'|'explicit', id }.
function resolveActivitySelection(value) {
    const raw = String(value || '').trim();
    const key = raw.toLowerCase();
    if (!key || key === 'none') return { mode: 'none', id: '' };
    if (key === 'auto') return { mode: 'auto', id: '' };
    if (key === 'random') return { mode: 'random', id: '' };
    const id = normalizeActivityId(raw);
    if (id) return { mode: 'explicit', id };
    return { mode: 'none', id: '' };
}

// Compact catalog for the API/UI (no need to ship the full definition).
function listActivities(options = {}) {
    return ACTIVITIES
        .filter((activity) => supportsGroup(activity, options.groupSize))
        .map((activity) => ({
            id: activity.id,
            label: activity.label,
            description: activity.description,
            phrase: activity.phrase,
            categories: (activity.categories || []).slice(),
            category: (activity.categories || [])[0] || '',
            groupSizes: (activity.groupSizes || []).slice()
        }));
}

// The categories present in the catalog, in display order, for the UI.
function listActivityCategories() {
    return CATEGORY_ORDER
        .filter((id) => ACTIVITIES.some((activity) => (activity.categories || []).includes(id)))
        .map((id) => ({ id, label: CATEGORY_LABELS[id] || id }));
}

// Name-owned action sentence: "Yara is reading a paperback book while relaxing."
function formatActivityAction(activity, name) {
    const act = typeof activity === 'string' ? getActivity(activity) : activity;
    if (!act) return '';
    const who = name && String(name).trim() ? String(name).trim() : 'The character';
    const phrase = act.phrase || act.label || '';
    return phrase ? who + ' is ' + phrase + '.' : '';
}

module.exports = {
    ACTIVITIES,
    ENVIRONMENT_PATTERNS,
    CATEGORY_LABELS,
    CATEGORY_ORDER,
    ACTIVITY_KEYWORDS,
    MATCH_THRESHOLD,
    listActivities,
    listActivityCategories,
    getActivity,
    getActivityById: getActivity,
    activityLabel,
    normalizeActivityId,
    resolveActivitySelection,
    environmentTokens,
    supportsGroup,
    getActivitiesForEnvironment,
    getActivitiesForContext,
    selectActivity,
    matchActivityFromText,
    formatActivityAction
};
