/* ============================================
   JARVIS — Image Arena battle prompts
   Writes the single prompt a fresh battle
   renders on every engine. The configured local
   LLM composes a complex, layered scene prompt;
   a small deterministic pool stays as the
   fail-open fallback when the model is offline,
   busy or returns something unusable.

   Prompts are generated as a small batch and
   cached per device session, so repeated rolls
   cost one LLM call instead of one per click.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const CATEGORIES = [
    'portrait', 'cinematic', 'landscape', 'product', 'architecture', 'interior',
    'food', 'animal', 'action', 'fashion', 'illustration', 'painting', 'macro',
    'texture', 'night', 'still-life', 'weather', 'text', 'creative'
];

const CATEGORY_SET = new Set(CATEGORIES);

// Fallback pool: short, concrete, self-contained prompts that exercise different
// strengths (skin, texture, light, type). Deliberately local, so a roll still
// works with the chat model stopped or busy.
const PROMPTS = [
    { category: 'portrait', text: 'close-up portrait of a woman in her thirties, soft window light, 85mm lens, shallow depth of field, natural skin texture' },
    { category: 'portrait', text: 'studio portrait of an older man with a weathered face, hard side light, black background, fine skin detail' },
    { category: 'portrait', text: 'candid street portrait of a teenager laughing, overcast daylight, 35mm, slight motion blur' },
    { category: 'portrait', text: 'freckled redhead in a linen shirt, golden hour backlight, film grain, 50mm' },
    { category: 'product', text: 'black ceramic coffee cup on a concrete counter, single softbox, deep shadows, commercial product photography' },
    { category: 'product', text: 'amber glass perfume bottle on wet stone, water droplets, cool rim light, macro detail' },
    { category: 'product', text: 'white sneakers floating on a pale blue background, hard shadow, studio catalogue shot' },
    { category: 'product', text: 'rustic sourdough loaf on a wooden board, flour dust, warm side light, close-up' },
    { category: 'landscape', text: 'fog rolling over a pine ridge at first light, layered silhouettes, muted greens' },
    { category: 'landscape', text: 'empty desert highway at noon, heat shimmer, one telephone pole, wide angle' },
    { category: 'landscape', text: 'storm over a black sand beach, long exposure water, dramatic cloud structure' },
    { category: 'architecture', text: 'brutalist concrete stairwell, single shaft of daylight, dust in the air, wide angle' },
    { category: 'architecture', text: 'row of pastel houses in a narrow street, laundry lines, late afternoon shadows' },
    { category: 'interior', text: 'quiet reading corner in a small apartment, worn armchair, stack of books, warm lamp light' },
    { category: 'food', text: 'overhead shot of a bowl of ramen, steam rising, soft window light, dark wooden table' },
    { category: 'animal', text: 'grey cat sitting in a cardboard box, curious expression, soft indoor light, shallow depth of field' },
    { category: 'animal', text: 'fox crossing a snowy road at dusk, breath visible, cold blue light' },
    { category: 'cinematic', text: 'lone figure in a yellow raincoat on a wet city street at night, neon reflections, anamorphic flare' },
    { category: 'cinematic', text: 'wide shot of a small boat on a dark lake, thick fog, one warm light on board' },
    { category: 'cinematic', text: 'detective in a wool coat standing in a doorway, hard light from behind, smoke in the air' },
    { category: 'action', text: 'climber reaching for a hold on a limestone wall, chalk dust, hard daylight, tight framing' },
    { category: 'action', text: 'cyclist mid-turn on a wet road, water spray frozen, low angle, panning blur' },
    { category: 'fashion', text: 'editorial fashion shot, oversized wool coat, wind machine, grey seamless background, full body' },
    { category: 'fashion', text: 'high key beauty shot, dewy skin, single specular highlight, clean composition' },
    { category: 'illustration', text: 'flat vector illustration of a city skyline at dusk, limited palette, geometric shapes, no text' },
    { category: 'illustration', text: 'children book illustration of a fox and a lantern in a snowy forest, warm gouache texture' },
    { category: 'painting', text: 'oil painting of a shipwreck on a rocky shore, thick impasto, storm light, muted palette' },
    { category: 'macro', text: 'macro shot of a dew covered spiderweb, morning light, rainbow refraction, very shallow focus' },
    { category: 'texture', text: 'weathered turquoise painted wood, peeling layers, raking light, extreme detail' },
    { category: 'night', text: 'empty parking garage at night, fluorescent flicker, wet concrete, one red car' },
    { category: 'still-life', text: 'three pears on a dark table, single window light, chiaroscuro, Dutch still life mood' },
    { category: 'weather', text: 'heavy rain on a window with city lights blurred behind, condensation, close-up' },
    { category: 'text', text: 'a painted wooden sign that reads OPEN, hanging on a brick wall, morning light' },
    { category: 'text', text: 'a neon sign that reads NIGHT BUS above a dark doorway, wet pavement below' }
];

// Distinct creative angles. Sampling a handful per batch keeps successive sets
// from clustering around the same subject, light and camera.
const ANGLES = [
    'narrative tension, something has just happened',
    'an unexpected viewpoint, from above, below or through something',
    'a tactile material study where texture is the subject',
    'weather as a character in the frame',
    'a surreal element that still obeys the scene physics',
    'a documentary candid moment nobody posed for',
    'a miniature world built from ordinary objects',
    'reflection and symmetry doing the composing',
    'motion caught mid-gesture with the surroundings sharp',
    'quiet emptiness with one human trace',
    'hands at work, close and specific',
    'one colour dominating everything else',
    'a seasonal transition caught in a single frame',
    'extreme scale contrast inside one image',
    'ritual and repetition in an ordinary place',
    'light entering through one narrow opening',
    'something damaged and carefully repaired',
    'a tool or object left behind in a working space',
    'isolation inside a crowd',
    'the dawn shift change, tired and specific'
];

const BATCH_SIZE = 5;
// One batch buys five rolls; after this the cache is stale enough to rewrite.
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_SESSIONS = 24;
const DEFAULT_TIMEOUT_MS = Number(process.env.BENCHMARK_PROMPT_TIMEOUT_MS) || 25000;
const MIN_PROMPT_CHARS = 60;
const MAX_PROMPT_CHARS = 900;

const cache = new Map();

const SYSTEM_PROMPT = [
    'You are the prompt director for a blind image-model comparison arena. Each prompt you write is rendered unchanged by several different text-to-image models, and the resulting pictures are compared side by side. A prompt must therefore be visually complete on its own and reward careful looking.',
    '',
    'Write one complex, specific, self-contained scene. Every prompt must include:',
    '- a clear subject doing something specific, not a static catalogue pose',
    '- a precise moment or small narrative beat',
    '- a real environment with two or three concrete details that place it',
    '- directional light with a named source and a describable quality',
    '- camera language: framing, distance, lens or focal length, depth of field',
    '- material and texture detail a model can actually render',
    '- a restrained colour palette and a clear mood',
    '',
    'Aim for 60 to 100 words of flowing prose. Concrete nouns and verbs beat adjectives. Do not stack keywords or comma fragments. Do not repeat the same sentence shape across the batch.',
    '',
    'Never include: model names; quality spam such as "masterpiece", "8k", "best quality", "hyperrealistic" or "award winning"; watermark, logo or username requests; real celebrities or identifiable public figures; nudity or sexual content; gore; political or religious messaging; several unrelated scenes in one prompt; instructions to the viewer; or the word "prompt".',
    '',
    'Visible text: only when the concept is a sign, poster, label or book cover, and then state the exact short words.',
    '',
    'Return strict JSON only, with no prose and no code fences, in exactly this shape:',
    '{"prompts":[{"category":"portrait","prompt":"..."}]}',
    'Use only these category values: ' + CATEGORIES.join(', ') + '.'
].join('\n');

function clean(value, max) {
    return String(value === undefined || value === null ? '' : value).trim().slice(0, max || MAX_PROMPT_CHARS);
}

function normalizeKey(text) {
    return clean(text, MAX_PROMPT_CHARS).toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeExcludes(exclude) {
    const list = Array.isArray(exclude) ? exclude : (exclude ? [exclude] : []);
    const set = new Set();
    list.forEach((entry) => {
        const text = typeof entry === 'string' ? entry : (entry && (entry.prompt || entry.text));
        const key = normalizeKey(text);
        if (key) set.add(key);
    });
    return set;
}

function randomOf(list) {
    return list[Math.floor(Math.random() * list.length)];
}

// --- Deterministic fallback ---------------------------------------------------

function randomPrompt(options) {
    const opts = options || {};
    const excluded = normalizeExcludes(opts.exclude);
    const pool = PROMPTS.filter((entry) => !excluded.has(normalizeKey(entry.text)));
    const list = pool.length ? pool : PROMPTS;
    const pick = randomOf(list);
    return { prompt: pick.text, category: pick.category };
}

// --- Model output parsing -----------------------------------------------------

// Extract the first balanced JSON array or object from a reply. Tolerates code
// fences and surrounding prose; returns null when nothing parses.
function extractJson(text) {
    const value = String(text || '');
    const start = value.search(/[[{]/);
    if (start === -1) return null;
    const open = value[start];
    const close = open === '[' ? ']' : '}';
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
        if (ch === open) depth += 1;
        else if (ch === close) {
            depth -= 1;
            if (depth === 0) {
                try {
                    return JSON.parse(value.slice(start, i + 1));
                } catch (err) {
                    return null;
                }
            }
        }
    }
    return null;
}

function fitLength(text) {
    if (text.length <= MAX_PROMPT_CHARS) return text;
    const clipped = text.slice(0, MAX_PROMPT_CHARS);
    const end = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('; '), clipped.lastIndexOf(', '));
    const fitted = (end > MIN_PROMPT_CHARS ? clipped.slice(0, end + 1) : clipped).trim();
    return fitted.length >= MIN_PROMPT_CHARS ? fitted : '';
}

const META_PREFIX_RE = /^(?:image\s+)?(?:prompt|scene|description)\s*:\s*/i;
const QUALITY_SPAM_RE = /\b(?:masterpiece|best quality|ultra[- ]?detailed|hyper[- ]?realistic|8k|4k|award[- ]?winning|trending on artstation)\b/i;

function normalizeEntry(item) {
    const raw = typeof item === 'string'
        ? item
        : (item && (item.prompt || item.text || item.description) || '');
    let text = String(raw)
        .replace(/^```[a-z]*\s*/i, '')
        .replace(/\s*```$/i, '')
        .replace(META_PREFIX_RE, '')
        .replace(/^["'`\s]+|["'`\s]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return null;
    if (/[{}]/.test(text)) return null;
    if (/\b(?:json|category)\s*:/i.test(text)) return null;
    if (QUALITY_SPAM_RE.test(text)) return null;
    text = fitLength(text);
    if (text.length < MIN_PROMPT_CHARS) return null;
    const label = typeof item === 'object' && item ? clean(item.category, 40).toLowerCase() : '';
    const category = CATEGORY_SET.has(label) ? label : 'creative';
    return { prompt: text, category };
}

function parsePrompts(text, options) {
    const opts = options || {};
    const parsed = extractJson(text);
    if (!parsed) return [];
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.prompts) ? parsed.prompts : []);
    const excluded = normalizeExcludes(opts.exclude);
    const seen = new Set();
    const prompts = [];
    for (const item of list) {
        const entry = normalizeEntry(item);
        if (!entry) continue;
        const key = normalizeKey(entry.prompt);
        if (excluded.has(key) || seen.has(key)) continue;
        seen.add(key);
        prompts.push(entry);
        if (prompts.length >= (opts.limit || BATCH_SIZE)) break;
    }
    return prompts;
}

function buildMessages(options) {
    const opts = options || {};
    const count = Math.max(1, Math.min(BATCH_SIZE, Number(opts.count) || BATCH_SIZE));
    const angles = [];
    const available = ANGLES.slice();
    while (angles.length < count && available.length) {
        angles.push(available.splice(Math.floor(Math.random() * available.length), 1)[0]);
    }
    const excluded = Array.isArray(opts.exclude)
        ? opts.exclude.map((entry) => clean(entry, MAX_PROMPT_CHARS)).filter(Boolean).slice(0, 12)
        : [];
    const lines = [
        'Write ' + count + ' new prompts for one battle set.',
        'Give each prompt a different angle: ' + angles.join('; ') + '.',
        'Vary subject, environment, light and camera across the batch so no two read the same.',
        'Each category must match its prompt.'
    ];
    if (excluded.length) {
        lines.push('', 'Do not reuse or lightly reword any of these prompts already shown:');
        excluded.forEach((entry) => lines.push('- ' + entry));
    }
    return [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: lines.join('\n') }
    ];
}

// --- Cache --------------------------------------------------------------------

function pruneCache(now) {
    for (const [key, entry] of cache) {
        if (!entry || now - entry.createdAt > CACHE_TTL_MS) cache.delete(key);
    }
    while (cache.size > MAX_SESSIONS) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
}

function cachedEntry(sessionId) {
    const now = Date.now();
    pruneCache(now);
    const entry = cache.get(sessionId);
    if (!entry) return null;
    return entry;
}

function takeCached(entry, excluded) {
    if (!entry) return null;
    const index = entry.prompts.findIndex((item) => !excluded.has(normalizeKey(item.prompt)));
    if (index === -1) return null;
    const [pick] = entry.prompts.splice(index, 1);
    return pick;
}

// --- LLM generation -----------------------------------------------------------

function withTimeout(promise, ms) {
    if (!Number.isFinite(ms) || ms <= 0) return promise;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const err = new Error('prompt generation timed out');
            err.code = 'benchmark_prompt_timeout';
            reject(err);
        }, ms);
        Promise.resolve(promise).then(
            (value) => { clearTimeout(timer); resolve(value); },
            (err) => { clearTimeout(timer); reject(err); }
        );
    });
}

function defaultGenerate(messages, model) {
    const providers = require('../../server/providers');
    return providers.chat('ollama', messages, model, { temperature: 0.95, think: false });
}

async function generateBatch(options) {
    const opts = options || {};
    const generate = typeof opts.generate === 'function' ? opts.generate : defaultGenerate;
    const model = opts.model || 'llama3.2';
    const messages = buildMessages(opts);
    const reply = await withTimeout(Promise.resolve(generate(messages, model, opts)), opts.timeoutMs);
    return parsePrompts(reply, { exclude: opts.exclude, limit: opts.count || BATCH_SIZE });
}

// --- Public API ---------------------------------------------------------------

// The next prompt for a battle roll. Serves a cached batch first, otherwise asks
// the configured chat model for a fresh batch. Never throws: any failure falls
// back to the deterministic pool so the arena stays usable offline.
async function nextPrompt(options) {
    const opts = options || {};
    const sessionId = String(opts.sessionId || 'shared');
    const excluded = normalizeExcludes(opts.exclude);

    const cached = takeCached(cachedEntry(sessionId), excluded);
    if (cached) return Object.assign({}, cached, { source: 'llm' });

    if (opts.generate !== null) {
        try {
            const prompts = await generateBatch(Object.assign({}, opts, { timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS }));
            if (prompts.length) {
                const [first, ...rest] = prompts;
                if (rest.length) {
                    cache.set(sessionId, {
                        createdAt: Date.now(),
                        prompts: rest.map((item) => ({ prompt: item.prompt, category: item.category }))
                    });
                } else {
                    cache.delete(sessionId);
                }
                return Object.assign({}, first, { source: 'llm' });
            }
        } catch (err) {
            // Fail-open: the pool keeps Generate all available.
        }
    }

    const fallback = randomPrompt({ exclude: Array.from(excluded) });
    return Object.assign({}, fallback, { source: 'pool' });
}

function clearSession(sessionId) {
    if (sessionId === undefined) cache.clear();
    else cache.delete(String(sessionId));
}

module.exports = {
    CATEGORIES,
    PROMPTS,
    ANGLES,
    SYSTEM_PROMPT,
    BATCH_SIZE,
    DEFAULT_TIMEOUT_MS,
    randomPrompt,
    nextPrompt,
    buildMessages,
    parsePrompts,
    normalizeEntry,
    extractJson,
    clearSession,
    _reset: () => cache.clear()
};
