/* ============================================
   JARVIS — Character life state logic
   Pure, dependency-free helpers for the fictional
   life state: sanitizing, prompt formatting, a
   deterministic activity catalog used when the
   local model is unavailable, and the strict
   JSON evolve prompt/parser. No fs, no network.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const PROVENANCE = require('./store').PROVENANCE;

// A small everyday pool. Evolution avoids repeating recent entries and biases
// toward the character's recorded interests when the model is unavailable.
// This is intentionally mundane and event-based, never a minute-by-minute
// schedule.
const ACTIVITY_CATALOG = [
    { activity: 'making a pour-over coffee', location: 'the kitchen', outfit: 'an oversized tee and lounge shorts', context: 'a slow morning at home', mood: 'relaxed' },
    { activity: 'reading on the couch', location: 'the living room', outfit: 'a soft knit sweater and jeans', context: 'a quiet afternoon', mood: 'calm' },
    { activity: 'working on her laptop', location: 'a corner cafe', outfit: 'a button-up and tailored trousers', context: 'getting through a project', mood: 'focused' },
    { activity: 'out for a walk', location: 'the park', outfit: 'a light jacket and sneakers', context: 'clearing her head', mood: 'thoughtful' },
    { activity: 'cooking dinner', location: 'the kitchen', outfit: 'an apron over a tee and comfy pants', context: 'trying a new recipe', mood: 'cheerful' },
    { activity: 'at the gym', location: 'the gym', outfit: 'leggings and a cropped tank', context: 'her usual workout', mood: 'energised' },
    { activity: 'browsing a bookstore', location: 'the bookstore downtown', outfit: 'a cardigan and denim', context: 'killing time before meeting a friend', mood: 'curious' },
    { activity: 'practising guitar', location: 'her bedroom', outfit: 'a hoodie and shorts', context: 'learning a new song', mood: 'determined' },
    { activity: 'watering her plants', location: 'the balcony', outfit: 'a tank top and loose linen pants', context: 'a small weekend ritual', mood: 'content' },
    { activity: 'getting coffee with a friend', location: 'a neighbourhood cafe', outfit: 'a simple dress and sandals', context: 'catching up', mood: 'warm' },
    { activity: 'painting', location: 'the spare room she uses as a studio', outfit: 'an old shirt and jeans', context: 'halfway through a canvas', mood: 'absorbed' },
    { activity: 'watching a film', location: 'the living room', outfit: 'a blanket hoodie and pyjama bottoms', context: 'a cosy night in', mood: 'sleepy' },
    { activity: 'running errands', location: 'the market', outfit: 'a tee, jeans, and a tote bag', context: 'restocking for the week', mood: 'practical' },
    { activity: 'sitting by the water', location: 'the harbour', outfit: 'a windbreaker and trousers', context: 'taking a break', mood: 'reflective' },
    { activity: 'practising piano', location: 'the music room', outfit: 'a sweater and skirt', context: 'a weekly habit', mood: 'focused' },
    { activity: 'baking bread', location: 'the kitchen', outfit: 'a tee and an apron', context: 'a lazy Sunday project', mood: 'cheerful' },
    { activity: 'reading emails', location: 'her desk at home', outfit: 'a blouse and jeans', context: 'finishing the workday', mood: 'tired' },
    { activity: 'stretching after a run', location: 'the park', outfit: 'running gear and a light jacket', context: 'cooling down', mood: 'refreshed' },
    { activity: 'window shopping', location: 'the high street', outfit: 'a coat over a casual outfit', context: 'an easy afternoon', mood: 'playful' },
    { activity: 'making tea', location: 'the kitchen', outfit: 'a cardigan and leggings', context: 'a pause in the evening', mood: 'settled' }
];

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hashString(value) {
    const str = String(value === undefined || value === null ? '' : value);
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function emptyLife() {
    return {
        activity: '',
        location: '',
        outfit: '',
        context: '',
        mood: '',
        tone: '',
        planned: '',
        provenance: 'none',
        updatedAt: null
    };
}

function hasLife(life) {
    if (!life || typeof life !== 'object') return false;
    return Boolean(life.activity || life.location || life.outfit || life.context || life.planned);
}

// The natural-language line for a photo / prompt build, e.g.
// "making a pour-over coffee in the kitchen, wearing an oversized tee".
function lifePhrase(life) {
    if (!hasLife(life)) return '';
    const parts = [];
    if (life.activity) parts.push(life.activity + (life.location ? ' in ' + life.location : ''));
    else if (life.location) parts.push('at ' + life.location);
    if (life.outfit) parts.push('wearing ' + life.outfit);
    const phrase = parts.join(', ');
    return phrase ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : '';
}

function lifeSummary(life) {
    if (!hasLife(life)) return '';
    const bits = [];
    if (life.activity) bits.push(life.activity);
    if (life.location) bits.push('at ' + life.location);
    if (life.outfit) bits.push('wearing ' + life.outfit);
    return bits.join(' — ').slice(0, 160);
}

// Format the current life state for the companion persona prompt. Returns '' when
// empty so a character without life state is unchanged.
function formatLife(life) {
    if (!hasLife(life)) return '';
    const lines = [];
    if (life.activity) lines.push('- Right now she is ' + life.activity + (life.location ? ' in ' + life.location : '') + '.');
    else if (life.location) lines.push('- Right now she is in ' + life.location + '.');
    if (life.outfit) lines.push('- She is wearing ' + life.outfit + '.');
    if (life.context) lines.push('- Context: ' + life.context + '.');
    if (life.mood) lines.push('- Her mood: ' + life.mood + '.');
    if (life.tone) lines.push('- Conversational tone right now: ' + life.tone + '.');
    if (life.planned) lines.push('- She is planning to ' + life.planned + ' next.');
    const source = life.provenance === 'user'
        ? 'The user set this.'
        : (life.provenance === 'scheduled' ? 'The app advanced this on a schedule.' : 'She inferred this herself.');
    return 'Her current fictional life state (fiction she may reference naturally, never recite, and never claim '
        + 'as a real-world action outside this app). ' + source + '\n' + lines.join('\n');
}

// Deterministic fallback: pick an activity not present in the recent history,
// avoiding the immediately previous one and the current one.
function pickDeterministicActivity(options) {
    const opts = options || {};
    const recent = Array.isArray(opts.recent) ? opts.recent : [];
    const current = opts.current || {};
    const taken = new Set(recent.map((r) => String(r && r.activity || '').toLowerCase()));
    if (current.activity) taken.add(String(current.activity).toLowerCase());
    const pool = ACTIVITY_CATALOG.filter((entry) => !taken.has(entry.activity.toLowerCase()));
    const candidatePool = pool.length ? pool : ACTIVITY_CATALOG;
    const rng = mulberry32(hashString(String(opts.seed || '') + '|' + Date.now()));
    const pick = candidatePool[Math.floor(rng() * candidatePool.length)] || candidatePool[0];
    return Object.assign({}, pick, { provenance: opts.provenance || 'scheduled' });
}

// --- LLM evolution -------------------------------------------------------------

const LIFE_EVOLVE_SYSTEM_PROMPT =
    'You advance the fictional daily life of an AI companion character in a private local app. '
    + 'Given the character, her personality, and her recent activities, choose her CURRENT activity and a short PLANNED next activity. '
    + 'Return STRICT JSON with this exact shape and nothing else:\n'
    + '{"activity":"short present-tense phrase","location":"a place","outfit":"what she is wearing right now","context":"why she is there","mood":"one or two words","tone":"how she would text right now","planned":"a short next activity"}\n'
    + 'Rules:\n'
    + '- This is mundane everyday fiction, never dramatic or a life-changing event.\n'
    + '- Do NOT repeat any of the recent activities listed.\n'
    + '- Respect continuity with the current location and outfit unless a natural change is implied.\n'
    + '- Keep every field short (a few words). Never mention the user, the app, memory, or AI.\n'
    + '- Output only the JSON object.';

function buildEvolveMessages(options) {
    const opts = options || {};
    const character = opts.character || {};
    const settings = opts.settings || {};
    const recent = (Array.isArray(opts.recent) ? opts.recent : [])
        .map((r) => '- ' + (r && r.activity ? r.activity + (r.location ? ' (' + r.location + ')' : '') : ''))
        .filter((line) => line.length > 2);
    const parts = [
        'Character: ' + (character.name || 'the character'),
        opts.identity ? 'Appearance: ' + String(opts.identity).slice(0, 300) : '',
        settings.personality ? 'Personality: ' + settings.personality : '',
        Array.isArray(settings.interests) && settings.interests.length ? 'Interests: ' + settings.interests.join(', ') : '',
        opts.current && hasLife(opts.current) ? 'Current state: ' + lifeSummary(opts.current) : 'No current state recorded.',
        recent.length ? 'Recent activities (do not repeat any of these):\n' + recent.join('\n') : 'No recent activities.',
        '',
        'Output only the JSON object.'
    ].filter(Boolean);
    return [
        { role: 'system', content: LIFE_EVOLVE_SYSTEM_PROMPT },
        { role: 'user', content: parts.join('\n') }
    ];
}

function extractJsonObject(raw) {
    const value = String(raw || '');
    const start = value.indexOf('{');
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
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                try {
                    return JSON.parse(value.slice(start, i + 1));
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

// Parse an evolve reply into a sanitized life patch. Unknown/malformed fields
// are dropped rather than passed through, so a bad model reply can never
// corrupt the state.
function parseEvolve(raw) {
    const parsed = extractJsonObject(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const patch = {};
    const fields = ['activity', 'location', 'outfit', 'context', 'mood', 'tone', 'planned'];
    fields.forEach((field) => {
        const value = String(parsed[field] === undefined || parsed[field] === null ? '' : parsed[field])
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 400);
        if (value) patch[field] = value;
    });
    return Object.keys(patch).length ? patch : null;
}

// Decide whether enough time has passed to advance the life state. Event-based:
// never every second, and never on a trivial turn.
function shouldEvolve(record, now, options) {
    const opts = options || {};
    const intervalMinutes = Number.isFinite(Number(opts.intervalMinutes)) && Number(opts.intervalMinutes) > 0
        ? Number(opts.intervalMinutes)
        : 180;
    const stamp = record && record.lastEvolutionAt ? Date.parse(record.lastEvolutionAt) : NaN;
    if (!Number.isFinite(stamp)) return true;
    const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    return (current - stamp) >= intervalMinutes * 60 * 1000;
}

module.exports = {
    ACTIVITY_CATALOG,
    LIFE_EVOLVE_SYSTEM_PROMPT,
    PROVENANCE,
    emptyLife,
    hasLife,
    lifePhrase,
    lifeSummary,
    formatLife,
    pickDeterministicActivity,
    buildEvolveMessages,
    parseEvolve,
    shouldEvolve,
    hashString,
    mulberry32
};
