/* ============================================
   JARVIS — Today's Playground
   A daily set of three personalized creative
   ideas (Easy / Interesting / Ambitious) attached
   to the existing Creative Playground.

   The idea engine asks the configured local LLM for
   concrete, visually distinct concepts, validates the
   strict JSON strictly, and falls back to a small
   deterministic set when the model is unavailable or
   returns malformed output. It NEVER generates an
   image/video: an idea only carries creative
   direction, and a selected idea is handed to the
   existing Playground / Director pipelines through
   `buildIdeaStartInput`.

   Ideas are persisted per device session and rotate
   on the user's LOCAL date. Re-opening Playground on
   the same day restores the existing set.

   No framework, no dependencies.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');

const themes = require('./themes');
const activities = require('./activities');
const outfitPacks = require('./outfit-packs');
const sceneLibrary = require('../scene-library');
const characterContext = require('../character-context');
const generatedHistory = require('../generated-history');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
// An explicit path keeps the tests hermetic (they never touch data/).
const STORE_PATH = process.env.PLAYGROUND_TODAY_PATH || path.join(DATA_DIR, 'playground-today.json');

const TIERS = ['easy', 'interesting', 'ambitious'];
const TIER_LABELS = { easy: 'Easy', interesting: 'Interesting', ambitious: 'Ambitious' };
// Output type allowed per tier. Easy is always a single image; Interesting may
// be a single image or a multi-step creation; Ambitious is a video or a
// multi-step creation. This keeps the promise of each tier honest.
const TIER_OUTPUTS = {
    easy: ['image'],
    interesting: ['image', 'multi'],
    ambitious: ['video', 'multi']
};
const OUTPUT_LABELS = { image: 'Image', video: 'Video', multi: 'Multi-step' };

const IDEAS_PER_DAY = 3;
const LLM_IDEA_TIMEOUT_MS = Number(process.env.PLAYGROUND_TODAY_TIMEOUT_MS) || 20000;
const RECENT_LIMIT = 24;
const DEFAULT_SESSION = 'default';

let store = null;

// --- Storage -----------------------------------------------------------------

function loadStore() {
    if (store) return store;
    try {
        const raw = fs.readFileSync(STORE_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        store = {
            sessions: (parsed && typeof parsed.sessions === 'object' && parsed.sessions) || {}
        };
    } catch (err) {
        store = { sessions: {} };
    }
    return store;
}

function saveStore() {
    const data = loadStore();
    const parent = path.dirname(STORE_PATH);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify({
        updatedAt: new Date().toISOString(),
        sessions: data.sessions
    }, null, 2), 'utf-8');
}

// --- Helpers -----------------------------------------------------------------

function nowIso(now) {
    return (now ? new Date(now) : new Date()).toISOString();
}

// The user's LOCAL calendar date (not UTC) so the set rotates at local midnight.
function localDate(now) {
    const d = now ? new Date(now) : new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function clean(value, max) {
    return String(value === undefined || value === null ? '' : value).trim().slice(0, max || 400);
}

function normalizeKey(text) {
    return clean(text, 200).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function hashString(text) {
    let hash = 2166136261;
    const str = String(text || '');
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function makeIdeaId(tier, seed) {
    return 'idea_' + tier + '_' + Math.abs(hashString(seed)).toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

const THEME_IDS = new Set(themes.listThemes().map((t) => t.id));

function resolveThemeId(value, fallbackText) {
    const key = clean(value, 60).toLowerCase();
    if (THEME_IDS.has(key)) return key;
    const text = clean(fallbackText, 400).toLowerCase();
    // A soft keyword match against the theme catalog.
    if (/\bfashion|editorial|runway\b/.test(text)) return 'fashion-editorial';
    if (/\btravel|adventure|wander|journey\b/.test(text)) return 'travel-adventure';
    if (/\bcinematic|film still|noir|storytelling|moody\b/.test(text)) return 'cinematic-storytelling';
    if (/\bfantasy|magic|mythic|enchanted\b/.test(text)) return 'fantasy-character-worlds';
    if (/\bseason|christmas|holiday|summer|autumn|winter\b/.test(text)) return 'seasonal-concepts';
    if (/\bexperimental|abstract|surreal|long exposure\b/.test(text)) return 'experimental-photography';
    if (/\bcandid|lifestyle|selfie|everyday\b/.test(text)) return 'lifestyle-candid';
    return 'anything';
}

// Resolve a character from an explicit id or a name mentioned in the idea.
function resolveIdeaCharacter(idValue, nameValue) {
    const characters = characterContext.listCharacterOptions();
    const byId = clean(idValue, 80);
    if (byId) {
        const found = characters.find((c) => c.id === byId);
        if (found) return found;
    }
    const name = clean(nameValue, 80).toLowerCase();
    if (name) {
        const found = characters.find((c) => String(c.name || '').toLowerCase() === name);
        if (found) return found;
    }
    return null;
}

function detectActivityId(value, brief) {
    const explicit = activities.normalizeActivityId(value);
    if (explicit) return explicit;
    const matched = activities.matchActivityFromText(brief);
    return matched.confident ? matched.id : '';
}

function detectSceneId(value, brief) {
    const key = clean(value, 80);
    if (key && sceneLibrary.get(key)) return key;
    const byName = key ? sceneLibrary.getByName(key) : null;
    if (byName) return byName.id;
    const scene = sceneLibrary.detectFromText(brief);
    return scene ? scene.id : '';
}

function detectOutfitPack(value, brief) {
    const key = clean(value, 60).toLowerCase();
    if (key && outfitPacks.getPack(key)) return key;
    return outfitPacks.detectOutfitPackFromText(brief) || '';
}

function normalizeOutputType(value, tier) {
    const allowed = TIER_OUTPUTS[tier] || ['image'];
    const key = clean(value, 20).toLowerCase();
    return allowed.includes(key) ? key : allowed[0];
}

// --- Idea normalization -------------------------------------------------------

function normalizeIdea(raw, tier, options = {}) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const title = clean(src.title, 80) || clean(src.brief, 80) || TIER_LABELS[tier] + ' idea';
    const brief = clean(src.brief || src.description || src.direction, 400) || title;
    const direction = clean(src.direction || src.brief || src.description, 600) || brief;
    const outputType = normalizeOutputType(src.outputType || src.output, tier);
    const themeId = resolveThemeId(src.themeId || src.theme, brief + ' ' + direction);
    const character = resolveIdeaCharacter(src.characterId, src.character || src.characterName);
    const activityId = detectActivityId(src.activity, brief + ' ' + direction);
    const sceneId = detectSceneId(src.scene || src.sceneId || src.location, brief + ' ' + direction);
    const outfitPack = detectOutfitPack(src.outfitPack || src.wardrobe, direction);
    // Mode is a character-selection option: a saved character, a fresh random
    // character, or no character (a scene/idea that works without one).
    let mode = 'none';
    if (character) mode = 'character';
    else if (clean(src.mode, 20).toLowerCase() === 'random_character') mode = 'random_character';
    const idea = {
        id: makeIdeaId(tier, options.seed || (title + '|' + tier + '|' + themeId)),
        tier,
        title,
        brief,
        outputType,
        mode,
        characterId: character ? character.id : null,
        characterName: character ? character.name : '',
        themeId,
        activityId,
        sceneId,
        outfitPack,
        // The creative brief handed to the ONLY prompt owner when the user
        // selects Create. It is never the final image/video prompt.
        direction,
        status: 'new',
        createdAt: options.now || nowIso()
    };
    return idea;
}

// Soft variety: successive ideas in one set should not repeat the same
// theme + activity pair. Only repairs (never invents) so a genuinely distinct
// idea is untouched.
function ensureVariety(ideas) {
    const usedThemeActivity = new Set();
    for (const idea of ideas) {
        let key = idea.themeId + '::' + idea.activityId;
        if (!usedThemeActivity.has(key)) {
            usedThemeActivity.add(key);
            continue;
        }
        const alternatives = activities.listActivities({ groupSize: 1 });
        const swap = alternatives.find((a) => a.id !== idea.activityId
            && !usedThemeActivity.has(idea.themeId + '::' + a.id));
        if (swap) {
            idea.activityId = swap.id;
            key = idea.themeId + '::' + swap.id;
        } else {
            const themeList = themes.listThemes();
            const themeSwap = themeList.find((t) => t.id !== idea.themeId
                && !usedThemeActivity.has(t.id + '::' + idea.activityId));
            if (themeSwap) {
                idea.themeId = themeSwap.id;
                key = themeSwap.id + '::' + idea.activityId;
            }
        }
        usedThemeActivity.add(key);
    }
    return ideas;
}

// --- Deterministic fallback ---------------------------------------------------
//
// A small, concrete local set used when the LLM is unavailable or returns
// malformed output. The pools rotate by local date so consecutive days differ.
// None of these reference a character: a characterless idea is always valid.

const FALLBACK_POOLS = {
    easy: [
        {
            title: 'Window-light morning portrait',
            brief: 'A quiet getting-ready moment by a bright bedroom window, soft daylight and a candid half-smile.',
            themeId: 'lifestyle-candid', activity: 'getting-ready', scene: 'bedroom', outfitPack: 'lounge-home'
        },
        {
            title: 'Coffee at the corner caf\u00e9',
            brief: 'A relaxed coffee-and-conversation moment at a rain-speckled caf\u00e9 window, warm practical light.',
            themeId: 'lifestyle-candid', activity: 'coffee-chat', scene: 'cafe', outfitPack: 'casual-everyday'
        },
        {
            title: 'Golden-hour balcony',
            brief: 'A sunlit balcony portrait at golden hour with rooftops behind and a calm, natural expression.',
            themeId: 'lifestyle-candid', activity: 'relaxing', scene: 'balcony', outfitPack: 'casual-everyday'
        },
        {
            title: 'Bookshop aisle portrait',
            brief: 'Reading in a hushed bookshop aisle between tall wooden shelves, soft window light and rich texture.',
            themeId: 'lifestyle-candid', activity: 'reading', scene: 'library', outfitPack: 'minimalist-neutral'
        }
    ],
    interesting: [
        {
            title: 'Neon reflections after rain',
            brief: 'A cinematic single frame on a rain-slicked neon street, the subject small against reflected signage.',
            themeId: 'cinematic-storytelling', activity: 'exploring-city', scene: 'street', outfitPack: 'casual-night-out'
        },
        {
            title: 'Portal in the studio fog',
            brief: 'An experimental projection experiment: one hard beam of light cutting through haze, subject half-silhouetted.',
            themeId: 'experimental-photography', activity: 'taking-photos', scene: 'studio', outfitPack: 'edgy-alternative'
        },
        {
            title: 'Misty mountain ridge at dawn',
            brief: 'A wind-swept ridge above a sea of clouds, cold blue-hour light and a strong sense of scale.',
            themeId: 'travel-adventure', activity: 'sightseeing', scene: 'mountain', outfitPack: 'casual-streetwear'
        },
        {
            title: 'Editorial sculptural silhouette',
            brief: 'A high-fashion sculptural silhouette on a stark cyclorama, single hard key light and deep negative space.',
            themeId: 'fashion-editorial', activity: 'getting-ready', scene: 'studio', outfitPack: 'minimalist-neutral'
        }
    ],
    ambitious: [
        {
            title: 'The multi-cut city night',
            brief: 'A short multi-shot night sequence through a neon city street: a walk, a turn to camera, then a ride away.',
            themeId: 'cinematic-storytelling', activity: 'exploring-city', scene: 'street', outfitPack: 'casual-night-out', outputType: 'video'
        },
        {
            title: 'Caf\u00e9 scene, start to finish',
            brief: 'A sequential mini-story in one caf\u00e9: ordering, a sip, then laughing off-camera in three connected beats.',
            themeId: 'lifestyle-candid', activity: 'coffee-chat', scene: 'cafe', outfitPack: 'casual-everyday', outputType: 'multi'
        },
        {
            title: 'Coastal travel film',
            brief: 'A short travel film on a sunlit coast: a walk to the water, a look back, then a calm horizon hold.',
            themeId: 'travel-adventure', activity: 'walking-together', scene: 'beach', outfitPack: 'vacation-summer', outputType: 'video'
        },
        {
            title: 'Rooftop golden-hour take',
            brief: 'A single continuous creator take on a rooftop at golden hour, walking to the edge as the city glows.',
            themeId: 'cinematic-storytelling', activity: 'hang-out', scene: 'rooftop', outfitPack: 'casual-smart', outputType: 'video'
        }
    ]
};

function fallbackIdeas(date, now) {
    const byTier = {};
    for (const tier of TIERS) {
        const pool = FALLBACK_POOLS[tier] || [];
        const index = pool.length ? hashString(date + '|' + tier) % pool.length : 0;
        const template = pool[index] || { title: TIER_LABELS[tier] + ' idea', brief: TIER_LABELS[tier] + ' creative concept' };
        byTier[tier] = normalizeIdea({
            title: template.title,
            brief: template.brief,
            direction: template.brief,
            outputType: template.outputType || (tier === 'ambitious' ? 'video' : 'image'),
            themeId: template.themeId,
            activity: template.activity,
            scene: template.scene,
            outfitPack: template.outfitPack
        }, tier, { now, seed: date + '|' + tier });
    }
    return [byTier.easy, byTier.interesting, byTier.ambitious];
}

// --- LLM idea generation ------------------------------------------------------

function buildContext({ sessionId, entry, now }) {
    const characters = characterContext.listCharacterOptions().map((c) => ({
        id: c.id,
        name: c.name,
        identity: c.identityStatus,
        hasImage: Boolean(c.imageUrl)
    }));
    const themeList = themes.listThemes().map((t) => ({ id: t.id, label: t.label, description: t.description }));
    const activityList = activities.listActivities({ groupSize: 1 }).map((a) => ({
        id: a.id, label: a.label, description: a.description
    }));
    const scenes = sceneLibrary.listOptions().map((s) => ({ id: s.id, name: s.name, category: s.category }));
    const outfitList = outfitPacks.listPacks().map((p) => ({ id: p.id, label: p.label, description: p.description }));
    const recentGenerations = generatedHistory.listRecent(10, sessionId)
        .map((e) => clean(e.prompt, 140)).filter(Boolean);
    const recentIdeas = (entry && Array.isArray(entry.recent) ? entry.recent : [])
        .slice(0, RECENT_LIMIT)
        .map((r) => ({ title: r.title, themeId: r.themeId, activityId: r.activityId, status: r.status }));
    const todaysIdeas = (entry && Array.isArray(entry.ideas) ? entry.ideas : [])
        .map((i) => ({ title: i.title, themeId: i.themeId, activityId: i.activityId, status: i.status }));
    return {
        date: localDate(now),
        characters,
        themes: themeList,
        activities: activityList,
        scenes,
        outfitPacks: outfitList,
        workflows: [
            { id: 'image', label: 'Image', description: 'A single still image generated by the existing image pipeline.' },
            { id: 'video', label: 'Video', description: 'A short H3 video via Director Mode (opening frame approval, then animation).' },
            { id: 'multi', label: 'Multi-step', description: 'A sequential / multi-beat creation via Director Mode.' }
        ],
        recentGenerations,
        recentIdeas,
        todaysIdeas
    };
}

function buildMessages(context) {
    const system = [
        'You are the creative director for a local AI image/video studio.',
        'Propose exactly three distinctive creative ideas for a single theme day, one per tier:',
        '  easy (a single image), interesting (a single image or a multi-step creation),',
        '  ambitious (a video or a multi-step creation).',
        'Each idea must have a clear visual hook, a specific activity, a concrete location,',
        'and a believable photographic or cinematic treatment. Never write generic prompts like',
        '"a woman standing in a cafe" - name the moment, the light and the composition.',
        'Prefer variety across the three ideas: different themes, activities and locations.',
        'Avoid repeating the recently shown, selected or completed ideas listed in the input.',
        'You may suggest a saved character by id when it genuinely fits, otherwise leave',
        'characterId null - not every idea needs a person.',
        'Respond with ONLY a JSON array of exactly three objects, no prose, no code fences.',
        'Each object uses exactly these keys:',
        '  "tier": "easy" | "interesting" | "ambitious",',
        '  "title": short distinctive title (<= 70 chars),',
        '  "brief": one or two sentences (<= 240 chars),',
        '  "outputType": "image" | "video" | "multi",',
        '  "characterId": a saved character id or null,',
        '  "themeId": one of the listed theme ids,',
        '  "activity": one of the listed activity ids,',
        '  "scene": one of the listed scene ids,',
        '  "outfitPack": one of the listed outfit pack ids,',
        '  "direction": a concrete creative brief (2-4 sentences) describing the scene, subject action, lighting and framing.'
    ].join('\n');
    const user = 'CREATIVE CONTEXT (JSON):\n' + JSON.stringify(context, null, 2) +
        '\n\nReturn the JSON array of exactly three ideas now.';
    return [
        { role: 'system', content: system },
        { role: 'user', content: user }
    ];
}

// Extract the first balanced JSON array from a model reply. Tolerates code
// fences and surrounding prose; returns null when nothing parses.
function extractJsonArray(text) {
    const value = String(text || '');
    const start = value.indexOf('[');
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < value.length; i++) {
        const ch = value[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '[') depth += 1;
        else if (ch === ']') {
            depth -= 1;
            if (depth === 0) {
                const slice = value.slice(start, i + 1);
                try {
                    const parsed = JSON.parse(slice);
                    return Array.isArray(parsed) ? parsed : null;
                } catch (err) {
                    return null;
                }
            }
        }
    }
    return null;
}

function parseModelIdeas(text, options = {}) {
    const parsed = extractJsonArray(text);
    if (!parsed || !parsed.length) return null;
    const byTier = {};
    // First pass: honor the model's own tier assignment.
    for (const item of parsed) {
        const tier = TIERS.includes(String(item && item.tier || '').toLowerCase())
            ? String(item.tier).toLowerCase() : null;
        if (tier && !byTier[tier]) byTier[tier] = item;
    }
    // Second pass: fill any missing tier from the surplus entries in order.
    const leftovers = parsed.filter((item) => !TIERS.includes(String(item && item.tier || '').toLowerCase()));
    for (const tier of TIERS) {
        if (!byTier[tier] && leftovers.length) byTier[tier] = leftovers.shift();
    }
    if (!TIERS.every((tier) => byTier[tier])) return null;
    const ideas = TIERS.map((tier) => normalizeIdea(byTier[tier], tier, {
        now: options.now,
        seed: (byTier[tier] && (byTier[tier].title || '')) + '|' + tier + '|' + (options.date || '')
    }));
    return ensureVariety(ideas);
}

function withTimeout(promise, ms) {
    if (!Number.isFinite(ms) || ms <= 0) return promise;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const err = new Error('idea generation timed out');
            err.code = 'today_timeout';
            reject(err);
        }, ms);
        Promise.resolve(promise).then(
            (value) => { clearTimeout(timer); resolve(value); },
            (err) => { clearTimeout(timer); reject(err); }
        );
    });
}

// Default generator: the configured local LLM. Exposed for injection in tests.
function defaultGenerate(messages, model) {
    const providers = require('../../server/providers');
    return providers.chat('ollama', messages, model, { temperature: 0.85, think: false });
}

async function generateWithLlm(context, options) {
    const generate = typeof options.generate === 'function' ? options.generate : defaultGenerate;
    const model = options.model || 'llama3.2';
    const messages = buildMessages(context);
    const reply = await withTimeout(Promise.resolve(generate(messages, model, options)), options.timeoutMs);
    return parseModelIdeas(reply, { now: options.now, date: context.date });
}

// --- Day assembly -------------------------------------------------------------

function mergeRecent(entry, ideas, now) {
    const recent = Array.isArray(entry && entry.recent) ? entry.recent.slice() : [];
    const seen = new Set(recent.map((r) => normalizeKey(r.title)));
    for (const idea of ideas) {
        const key = normalizeKey(idea.title);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        recent.unshift({
            key,
            title: idea.title,
            themeId: idea.themeId,
            activityId: idea.activityId,
            status: idea.status || 'new',
            at: now || nowIso()
        });
    }
    return recent.slice(0, RECENT_LIMIT);
}

async function buildDay(options = {}) {
    const now = options.now || nowIso();
    const date = localDate(options.now);
    const sessionId = String(options.sessionId || DEFAULT_SESSION);
    const previous = options.previous || null;
    const context = buildContext({ sessionId, entry: previous, now });
    let ideas = null;
    let source = 'fallback';
    if (options.generate !== null) {
        try {
            ideas = await generateWithLlm(context, options);
            if (ideas && ideas.length) source = 'llm';
        } catch (err) {
            // Fail-open: the deterministic set keeps Playground usable.
            ideas = null;
        }
    }
    if (!ideas || !ideas.length) {
        ideas = fallbackIdeas(date, now);
        source = 'fallback';
    }
    ideas = ensureVariety(ideas).slice(0, IDEAS_PER_DAY);
    return {
        date,
        generatedAt: nowIso(options.now),
        source,
        ideas,
        recent: mergeRecent(previous, ideas, nowIso(options.now))
    };
}

// --- Public API ---------------------------------------------------------------

// The day's set, generating once per local date. Never throws: an LLM failure
// falls back to the deterministic set.
async function getDailySet(options = {}) {
    const sessionId = String(options.sessionId || DEFAULT_SESSION);
    const date = localDate(options.now);
    const data = loadStore();
    const entry = data.sessions[sessionId];
    if (entry && entry.date === date) return entry;
    const built = await buildDay(Object.assign({}, options, { sessionId, previous: entry }));
    data.sessions[sessionId] = built;
    saveStore();
    return built;
}

// Manual refresh: generate a fresh set for today, considering the day's (and
// recent) history so the same ideas are not repeated. Keeps the date.
async function refreshDailySet(options = {}) {
    const sessionId = String(options.sessionId || DEFAULT_SESSION);
    const data = loadStore();
    const existing = data.sessions[sessionId];
    // Carry the previous set (recent history) forward so a refresh avoids the
    // ideas already shown, even across a date boundary.
    const built = await buildDay(Object.assign({}, options, { sessionId, previous: existing }));
    data.sessions[sessionId] = built;
    saveStore();
    return built;
}

// A transient fallback set used when the LLM cannot run right now (e.g. another
// turn is active). It is NEVER persisted, so a later open/refresh still gets a
// chance to produce the LLM set.
function previewFallbackSet(options = {}) {
    const now = options.now || nowIso();
    return {
        date: localDate(options.now),
        generatedAt: nowIso(options.now),
        source: 'fallback',
        pending: true,
        ideas: ensureVariety(fallbackIdeas(localDate(options.now), now)).slice(0, IDEAS_PER_DAY),
        recent: []
    };
}

// The stored set without generating (used by the create/dismiss actions which
// must not trigger an LLM call).
function peekDailySet(sessionId, now) {
    const data = loadStore();
    const entry = data.sessions[String(sessionId || DEFAULT_SESSION)];
    if (!entry) return null;
    if (entry.date !== localDate(now)) return null;
    return entry;
}

function findIdea(sessionId, ideaId) {
    const entry = peekDailySet(sessionId);
    if (!entry) return null;
    return entry.ideas.find((i) => i.id === String(ideaId || '')) || null;
}

// Persist an idea's lifecycle status (new / selected / dismissed / completed)
// and any resulting asset reference. Best-effort: a missing day or idea is a
// no-op so it can never break a generation turn.
function markIdea(sessionId, ideaId, patch = {}) {
    const data = loadStore();
    const entry = data.sessions[String(sessionId || DEFAULT_SESSION)];
    if (!entry) return null;
    const idea = entry.ideas.find((i) => i.id === String(ideaId || ''));
    if (!idea) return null;
    if (patch.status) idea.status = String(patch.status);
    if (patch.assetUrl !== undefined) idea.assetUrl = patch.assetUrl || '';
    if (patch.generationId !== undefined) idea.generationId = patch.generationId || '';
    if (patch.productionId !== undefined) idea.productionId = patch.productionId || '';
    if (patch.playgroundId !== undefined) idea.playgroundId = patch.playgroundId || '';
    // A fresh attempt / success clears any previous error; an explicit
    // lastError (a failed or cancelled attempt) records why.
    if (patch.lastError !== undefined) idea.lastError = String(patch.lastError || '');
    else if (patch.status === 'selected' || patch.status === 'completed') idea.lastError = '';
    idea.updatedAt = nowIso();
    entry.updatedAt = idea.updatedAt;
    // Reflect the status in the recent history so the LLM avoids re-proposing
    // an idea the user has already acted on.
    if (Array.isArray(entry.recent)) {
        const key = normalizeKey(idea.title);
        const row = entry.recent.find((r) => r.key === key);
        if (row) row.status = idea.status;
    }
    saveStore();
    return idea;
}

// Find the idea linked to a Director production, across every session. Used to
// resolve the idea when the production's video stage later completes, fails or
// is cancelled, so a video/multi idea never stays stuck "In production".
function findIdeaByProduction(productionId) {
    const key = String(productionId || '');
    if (!key) return null;
    const data = loadStore();
    for (const sessionId of Object.keys(data.sessions)) {
        const ideas = (data.sessions[sessionId] && data.sessions[sessionId].ideas) || [];
        const idea = ideas.find((i) => i.productionId === key);
        if (idea) return { sessionId, idea };
    }
    return null;
}

// Resolve the idea linked to a finished/closed Director production. A completed
// production marks the idea completed with the resulting video; a failed or
// cancelled one returns it to `new` (retryable) with the reason.
function syncProductionOutcome(productionId, status, options = {}) {
    const found = findIdeaByProduction(productionId);
    if (!found) return null;
    const key = String(status || '').toLowerCase();
    if (key === 'completed') {
        return markIdea(found.sessionId, found.idea.id, {
            status: 'completed',
            assetUrl: options.url || ''
        });
    }
    if (key === 'failed' || key === 'cancelled') {
        return markIdea(found.sessionId, found.idea.id, {
            status: 'new',
            lastError: options.message || (key === 'cancelled' ? 'Production cancelled.' : 'Production failed.')
        });
    }
    return null;
}

// The Creative Playground `start()` input that reproduces a selected idea. The
// direction is creative brief text, never the final prompt - it passes through
// the SAME `imageGenerator.buildImagePrompt` / Director pipeline as any
// Surprise.
function buildIdeaStartInput(idea) {
    if (!idea) return null;
    const characterId = idea.characterId || null;
    const mode = characterId ? 'character' : (idea.mode === 'random_character' ? 'random_character' : 'none');
    return {
        themeId: idea.themeId || 'anything',
        characterId,
        mode,
        // An explicit activity id is passed through; it is dropped by the
        // concept engine when the direction owns the scene (exactly like a
        // user-prompt Surprise), so it never contradicts the brief.
        activity: idea.activityId || 'auto',
        sceneId: idea.sceneId || '',
        outfitPack: idea.outfitPack || '',
        customPrompt: idea.direction || idea.brief || idea.title
    };
}

function isVideoIdea(idea) {
    return Boolean(idea && (idea.outputType === 'video' || idea.outputType === 'multi'));
}

// Serialize one idea for the client (labels + a preview image when the idea is
// about a saved character).
function clientIdea(idea) {
    const character = idea.characterId ? resolveIdeaCharacter(idea.characterId, idea.characterName) : null;
    const activity = idea.activityId ? activities.getActivity(idea.activityId) : null;
    const scene = idea.sceneId ? sceneLibrary.get(idea.sceneId) : null;
    return {
        id: idea.id,
        tier: idea.tier,
        tierLabel: TIER_LABELS[idea.tier] || idea.tier,
        title: idea.title,
        brief: idea.brief,
        outputType: idea.outputType,
        outputLabel: OUTPUT_LABELS[idea.outputType] || idea.outputType,
        mode: idea.mode,
        characterId: idea.characterId || null,
        characterName: idea.characterName || (character ? character.name : ''),
        characterImage: character ? character.imageUrl : '',
        themeId: idea.themeId,
        themeLabel: (themes.getTheme(idea.themeId) || {}).label || '',
        activityId: idea.activityId || '',
        activityLabel: activity ? activity.label : '',
        sceneId: idea.sceneId || '',
        sceneLabel: scene ? (scene.name || scene.label || idea.sceneId) : '',
        outfitPack: idea.outfitPack || '',
        direction: idea.direction,
        previewUrl: character ? character.imageUrl : '',
        status: idea.status || 'new',
        assetUrl: idea.assetUrl || '',
        lastError: idea.lastError || '',
        createdAt: idea.createdAt || ''
    };
}

function clientSet(entry) {
    if (!entry) return null;
    return {
        date: entry.date,
        generatedAt: entry.generatedAt,
        source: entry.source,
        pending: entry.pending === true,
        ideas: (entry.ideas || []).map(clientIdea)
    };
}

// Test seam: reset the in-memory cache (tests point STORE_PATH at temp files).
function _reset() {
    store = null;
}

module.exports = {
    TIERS,
    TIER_LABELS,
    TIER_OUTPUTS,
    OUTPUT_LABELS,
    IDEAS_PER_DAY,
    DEFAULT_SESSION,
    STORE_PATH,
    localDate,
    getDailySet,
    refreshDailySet,
    previewFallbackSet,
    peekDailySet,
    findIdea,
    findIdeaByProduction,
    markIdea,
    syncProductionOutcome,
    buildIdeaStartInput,
    isVideoIdea,
    clientIdea,
    clientSet,
    normalizeIdea,
    parseModelIdeas,
    extractJsonArray,
    ensureVariety,
    fallbackIdeas,
    buildContext,
    selectGenerate: defaultGenerate,
    _reset
};
