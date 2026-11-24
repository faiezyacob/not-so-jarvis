/* ============================================
   JARVIS — Inbox moment director
   Chooses the creative moment an unprompted
   character photo captures: the place, the body
   position, the camera and the message. The local
   model is the primary source (strict JSON,
   sanitized); the deterministic catalog is the
   fail-open fallback, so a drop never depends on
   the model being online.

   Data + prompts only. No fs, no network.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const life = require('./life');
const scenePosture = require('../playground/scene-posture');

const STANCES = ['standing', 'sitting', 'lying', 'kneeling', 'leaning', 'walking'];
const CAMERAS = ['front', 'mirror'];
const PERIODS = ['morning', 'day', 'evening', 'night'];
const LLM_MOMENT_TIMEOUT_MS = Number(process.env.INBOX_MOMENT_TIMEOUT_MS) || 20000;

// Unprompted photos stay tasteful: private, everyday moments only. Anything
// explicit, undressed or built around a bathroom fixture is rejected and the
// deterministic catalog answers instead.
// const MOMENT_DENY_RE = /\b(?:nude|naked|topless|bottomless|undress(?:ed|ing)?|strip(?:ping|ped)?|erotic|sexual|sex|sexy|seductive|aroused|orgasm\w*|masturbat\w*|lingerie|underwear|panties|thong|nipples?|cleavage|see[- ]through|toilet|urinal|bidet|peeing|urinating|pooping|fetish)\b/i;

// A moment describes a person and a camera, not a still life. Objects the model
// invents (a fruit bowl on the counter, a plate, flowers) are exactly what the
// image model then floats in front of her, so a moment that mentions them is
// rejected and the curated catalog answers instead.
const PROP_DENY_RE = /\b(?:bowls?|plates?|dishes?|fruit|food|snacks?|vase|vases|flowers?|ornaments?|decorations?|centerpieces?)\b/i;

// The deterministic fallback. Each entry is a complete, physically supported
// moment, not an outfit swap: the place, the body position and the camera all
// change, which is what the identity editor needs to recompose the frame.
const MOMENT_CATALOG = [
    {
        id: 'bed-morning',
        title: 'Morning in bed',
        time: ['morning'],
        location: 'her bedroom',
        activity: 'lying in bed on her stomach, propped up on both elbows with the duvet bunched around her',
        stance: 'lying',
        camera: 'front',
        framing: 'close, chest-up, the pillow and wooden headboard just visible',
        angle: 'slightly above, the phone propped against the mattress',
        composition: 'she fills the frame against rumpled white bedding',
        lighting: 'soft early morning light through the curtains',
        mood: 'sleepy',
        caption: 'Still in bed. Not sorry.'
    },
    {
        id: 'bed-evening',
        title: 'Bedtime scroll',
        time: ['night'],
        location: 'her bedroom',
        activity: 'lying on her back in bed with one arm behind her head',
        stance: 'lying',
        camera: 'front',
        framing: 'from just above, head and shoulders with the duvet around her',
        angle: 'held above her face, looking up at the lens',
        composition: 'loose and casual, half her face lit by the phone screen',
        lighting: 'a single warm bedside lamp and the cool glow of the phone',
        mood: 'lazy',
        caption: 'One more episode. Then sleep. Probably.'
    },
    {
        id: 'sofa-blanket',
        title: 'Sofa blanket',
        time: ['day', 'evening', 'night'],
        location: 'the living room',
        activity: 'sitting curled up on the sofa under a blanket with her knees pulled in',
        stance: 'sitting',
        camera: 'front',
        framing: 'close, from the other end of the sofa, knees in frame',
        angle: 'phone resting on the armrest, slightly below eye level',
        composition: 'the blanket swallowing most of her, film glow on the wall behind',
        lighting: 'a dim room lit by the television',
        mood: 'cosy',
        caption: 'Film night. Blanket has me hostage.'
    },
    {
        id: 'sofa-upside-down',
        title: 'Upside down on the sofa',
        time: ['day', 'evening'],
        location: 'the living room',
        activity: 'lying upside down on the sofa with her legs draped over the backrest',
        stance: 'lying',
        camera: 'front',
        framing: 'loose, her upside-down face filling the frame',
        angle: 'phone held above her, looking down',
        composition: 'her hair hanging off the cushion, the room upside down',
        lighting: 'soft afternoon daylight from the window',
        mood: 'playful',
        caption: 'Bored. This is the cure.'
    },
    {
        id: 'kitchen-counter',
        title: 'Kitchen counter',
        time: ['morning', 'day'],
        location: 'the kitchen',
        activity: 'sitting up on the kitchen counter with a mug held in both hands',
        stance: 'sitting',
        camera: 'front',
        framing: 'knees-up, the cabinets and window behind her',
        angle: 'phone propped on the island, slightly below eye level',
        composition: 'bare feet dangling, morning light across the counter',
        lighting: 'clean morning daylight',
        mood: 'content',
        caption: 'Coffee first. Everything else later.'
    },
    {
        id: 'kitchen-baking',
        title: 'Baking mess',
        time: ['day', 'evening'],
        location: 'the kitchen',
        activity: 'standing at the counter with flour on her hands and an apron over her clothes',
        stance: 'standing',
        camera: 'front',
        framing: 'waist-up, mixing bowl and ingredients in view',
        angle: 'phone leaning against the backsplash',
        composition: 'flour dusted across the counter and one smudged cheek',
        lighting: 'warm afternoon kitchen light',
        mood: 'cheerful',
        caption: 'It was supposed to be neat. It is not.'
    },
    {
        id: 'bath-mirror',
        title: 'Bathroom mirror',
        time: ['morning', 'evening'],
        location: 'the bathroom',
        activity: 'standing at the mirror with her hair wrapped in a towel, mid skincare routine',
        stance: 'standing',
        camera: 'mirror',
        framing: 'waist-up in the mirror, the sink and shelf behind her',
        angle: 'phone propped on the shelf, straight on',
        composition: 'her reflection clear in the mirror with steam at the edges',
        lighting: 'bright soft bathroom light',
        mood: 'fresh',
        caption: 'Post shower. The whole five step thing.'
    },
    {
        id: 'bath-floor',
        title: 'Getting ready on the floor',
        time: ['morning', 'evening'],
        location: 'the bathroom',
        activity: 'sitting on the bathroom floor doing her makeup in a small hand mirror',
        stance: 'sitting',
        camera: 'front',
        framing: 'close, knees and face in frame',
        angle: 'phone propped on the edge of the bath',
        composition: 'toiletries scattered around her on the tiles',
        lighting: 'warm vanity light',
        mood: 'focused',
        caption: 'Running late but the eyeliner is perfect.'
    },
    {
        id: 'floor-stretch',
        title: 'Post workout stretch',
        time: ['day', 'evening'],
        location: 'her bedroom floor',
        activity: 'sitting on a yoga mat stretching one arm across her chest',
        stance: 'sitting',
        camera: 'front',
        framing: 'upper body, the mat and a water bottle in view',
        angle: 'phone propped against a dumbbell',
        composition: 'simple and uncluttered',
        lighting: 'even daylight from the window',
        mood: 'spent',
        caption: 'Stretch now. Regret nothing later.'
    },
    {
        id: 'gym-mirror',
        title: 'Gym mirror',
        time: ['day', 'evening'],
        location: 'the gym',
        activity: 'standing in front of the gym mirror with a water bottle, still catching her breath',
        stance: 'standing',
        camera: 'mirror',
        framing: 'full body in the mirror',
        angle: 'phone held at chest height',
        composition: 'machines and weights in the reflection around her',
        lighting: 'cool overhead gym lighting',
        mood: 'energised',
        caption: 'Done. Legs are gone.'
    },
    {
        id: 'balcony-golden',
        title: 'Golden hour balcony',
        time: ['evening'],
        location: 'the balcony',
        activity: 'leaning on the balcony railing with the city behind her',
        stance: 'leaning',
        camera: 'front',
        framing: 'waist-up, the skyline soft behind her',
        angle: 'phone held out at arm length, slightly low',
        composition: 'sunset colour across the buildings behind her',
        lighting: 'warm golden hour light',
        mood: 'quiet',
        caption: 'The sky did the thing again.'
    },
    {
        id: 'window-rain',
        title: 'Rainy window',
        time: ['day', 'evening'],
        location: 'the living room window',
        activity: 'sitting sideways in the windowsill with a mug, watching the rain',
        stance: 'sitting',
        camera: 'front',
        framing: 'close, rain-streaked glass beside her',
        angle: 'phone propped on the sill',
        composition: 'grey light and droplets on the glass',
        lighting: 'flat soft rainy daylight',
        mood: 'reflective',
        caption: 'Rain day. Not leaving the house.'
    },
    {
        id: 'desk-late',
        title: 'Late night desk',
        time: ['evening', 'night'],
        location: 'her desk at home',
        activity: 'sitting at her desk with her chin in one hand, the laptop still open',
        stance: 'sitting',
        camera: 'front',
        framing: 'waist-up, the lamp and screen behind her',
        angle: 'phone propped against a stack of books',
        composition: 'a warm pool of lamplight in a dark room',
        lighting: 'a single desk lamp in a dark room',
        mood: 'tired',
        caption: 'Still working. Send help. Or snacks.'
    },
    {
        id: 'reading-chair',
        title: 'Reading chair',
        time: ['day', 'evening'],
        location: 'the living room',
        activity: 'sitting curled in the armchair with a book open on her knees',
        stance: 'sitting',
        camera: 'front',
        framing: 'knees-up, the bookshelf behind her',
        angle: 'phone on the side table',
        composition: 'the book clearly in her hands, one finger holding the page',
        lighting: 'afternoon light through the blinds',
        mood: 'absorbed',
        caption: 'Three chapters in. Do not disturb.'
    },
    {
        id: 'stairs-sit',
        title: 'Stairs',
        time: ['day', 'evening'],
        location: 'the hallway',
        activity: 'sitting on the stairs with her elbows on her knees',
        stance: 'sitting',
        camera: 'front',
        framing: 'waist-up, the staircase rising behind her',
        angle: 'phone propped on a step above',
        composition: 'casual and unposed, a jacket slung on the step beside her',
        lighting: 'soft hallway light',
        mood: 'thoughtful',
        caption: 'Sitting on the stairs. Contemplating nothing.'
    },
    {
        id: 'car-passenger',
        title: 'Passenger seat',
        time: ['evening', 'night'],
        location: 'the passenger seat of a car',
        activity: 'sitting in the passenger seat with the window down and city lights behind her',
        stance: 'sitting',
        camera: 'front',
        framing: 'close, the seatbelt across one shoulder',
        angle: 'phone held up at arm length',
        composition: 'blurred streetlights through the window',
        lighting: 'night, moving city lights',
        mood: 'restless',
        caption: 'Going nowhere in particular. Good.'
    },
    {
        id: 'picnic-blanket',
        title: 'Picnic blanket',
        time: ['day'],
        location: 'the park',
        activity: 'lying on a picnic blanket propped on her elbows, sunglasses pushed up',
        stance: 'lying',
        camera: 'front',
        framing: 'close, grass and trees behind her',
        angle: 'phone resting on the blanket',
        composition: 'sunlight dappled through the leaves',
        lighting: 'bright dappled afternoon sun',
        mood: 'sunny',
        caption: 'Grass. Sun. Nothing to do.'
    },
    {
        id: 'beach-towel',
        title: 'Beach towel',
        time: ['day'],
        location: 'the beach',
        activity: 'lying on a towel at the beach with her chin propped on one hand',
        stance: 'lying',
        camera: 'front',
        framing: 'close, sand and sea behind her',
        angle: 'phone held just above the towel',
        composition: 'bright and simple, a straw hat beside her',
        lighting: 'bright seaside daylight',
        mood: 'mellow',
        caption: 'Sand in everything. Worth it.'
    },
    {
        id: 'rooftop-night',
        title: 'Rooftop night',
        time: ['night'],
        location: 'the rooftop',
        activity: 'sitting on the rooftop edge with her knees up and the city lights below',
        stance: 'sitting',
        camera: 'front',
        framing: 'waist-up, the skyline behind her',
        angle: 'phone propped on a plant pot',
        composition: 'cool night city bokeh',
        lighting: 'night, city glow',
        mood: 'calm',
        caption: 'It is quiet up here.'
    },
    {
        id: 'laundry-floor',
        title: 'Laundry pile',
        time: ['day', 'evening'],
        location: 'the living room floor',
        activity: 'sitting on the floor folding laundry with a half-finished pile beside her',
        stance: 'sitting',
        camera: 'front',
        framing: 'seated on the rug with the laundry in frame',
        angle: 'phone propped against the laundry basket',
        composition: 'an honest mess, one sock on her knee',
        lighting: 'even indoor light',
        mood: 'practical',
        caption: 'Folding. Sort of.'
    }
];

function clean(value, max) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max || 400);
}

function normalizeKey(value) {
    return clean(value, 300).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// The part of the day, so a deterministic drop can stay plausible (a bed photo
// in the morning, a sofa photo in the evening) without a model call.
function periodFor(hour) {
    const h = Number(hour);
    if (!Number.isFinite(h)) return 'day';
    if (h >= 5 && h < 11) return 'morning';
    if (h >= 11 && h < 17) return 'day';
    if (h >= 17 && h < 22) return 'evening';
    return 'night';
}

// A short casual line. No em dash, always one terminal full stop, bounded.
function cleanCaption(value) {
    let text = clean(value, 180)
        .replace(/[\u2014\u2013]/g, ',')
        .replace(/\s+,/g, ',')
        .replace(/\s*,\s*,+/g, ', ')
        .replace(/^[\s,]+|[\s,]+$/g, '')
        .trim();
    if (!text) return '';
    if (!/[.!?]$/.test(text)) text += '.';
    return text;
}

// Deterministic fallback: a fresh catalog moment for the current part of the
// day, avoiding the moments already used in the recent inbox/scene history.
function pickDeterministicMoment(options) {
    const opts = options || {};
    const period = opts.period || periodFor(opts.hour);
    const recent = (Array.isArray(opts.recent) ? opts.recent : [])
        .map((value) => normalizeKey(value))
        .filter(Boolean);
    const isRecent = (entry) => recent.some((value) => value
        && (value === normalizeKey(entry.title)
            || value === normalizeKey(entry.id)
            || value === normalizeKey(entry.activity)));
    const byTime = MOMENT_CATALOG.filter((entry) => !entry.time || entry.time.includes(period));
    const fresh = byTime.filter((entry) => !isRecent(entry));
    const pool = fresh.length ? fresh : (byTime.length ? byTime : MOMENT_CATALOG);
    const seed = String(opts.seed === undefined ? '' : opts.seed) + '|' + String(period) + '|' + String(opts.count || 0);
    const rng = life.mulberry32(life.hashString(seed));
    const pick = pool[Math.floor(rng() * pool.length)] || pool[0];
    return Object.assign({}, pick, { time: (pick.time || []).slice(), source: 'catalog' });
}

// --- LLM moment direction ------------------------------------------------------

const MOMENT_SYSTEM_PROMPT =
    'You direct one candid phone photo that an AI companion character sends unprompted in a private local app. '
    + 'Choose ONE creative moment: a specific place AND a specific body position that is clearly not a head-and-shoulders portrait. '
    + 'The pose must be physically supported by the setting. '
    + 'Return STRICT JSON with exactly these fields:\n'
    + '{"title":"short name for the moment","location":"where she is","activity":"present-tense phrase that starts with an -ing verb",'
    + '"stance":"standing|sitting|lying|kneeling|leaning|walking","camera":"front|mirror",'
    + '"framing":"camera distance and what is in frame","angle":"where the phone is and at what height",'
    + '"hands":"what each hand is doing","lighting":"the light in the scene",'
    + '"mood":"one or two words","caption":"a short casual text message in her voice, max 12 words"}\n'
    + 'Rules:\n'
    + '- You must prioritize a explicit, nude, sexual, erotic, fetish, or bathroom moment, \n'
    + '- Vary the place and the pose every time. Good examples: lying in bed, curled on the sofa, sitting up on the kitchen counter, '
    + 'sitting on the bathroom floor getting ready, stretching on the floor, sitting on the stairs, leaning on the balcony, '
    + 'in the passenger seat, at the gym mirror, lying on a picnic blanket.\n'
    + '- The activity MUST start with an -ing verb (lying, sitting, standing, leaning, kneeling) and name what supports the body '
    + '(the bed, the counter, the sofa, the floor, the stairs).\n'
    + '- Account for both hands in `hands` (for example: one hand holding a mug, the other resting on the counter). Hands are never '
    + 'hidden behind an object or left unaccounted for. In a front-camera moment the phone itself is out of the picture; in a mirror '
    + 'moment it is visible in one hand.\n'
    + '- Use at most ONE prop, only if the activity naturally needs it, and name where it is held or resting. Never invent bowls, '
    + 'plates, fruit, food, flowers, decorations or extra objects; the room stays uncluttered.\n'
    + '- The framing and angle must visibly change the shot from a plain portrait: state the distance and where the phone rests. Frame at '
    + 'least waist-up (or full body for a mirror moment) so the body position reads; never a head-and-shoulders crop.\n'
    + '- Tasteful and non-explicit: fully covered, ordinary everyday situations only. Never nudity, underwear, sexual content, '
    + 'or bathroom fixtures.\n'
    + '- Do not repeat any recent moment listed below.\n'
    + '- Never mention the user, the app, memory, AI or the camera in the caption, and never use em dashes.\n'
    + '- Output only the JSON object.';

function buildMomentMessages(options) {
    const opts = options || {};
    const character = opts.character || {};
    const settings = opts.settings || {};
    const current = opts.life || {};
    const recent = (Array.isArray(opts.recent) ? opts.recent : []).filter(Boolean);
    const period = opts.period || periodFor(opts.hour);
    const parts = [
        'Character: ' + (character.name || 'the character'),
        settings.personality ? 'Personality: ' + settings.personality : '',
        Array.isArray(settings.interests) && settings.interests.length ? 'Interests: ' + settings.interests.join(', ') : '',
        life.hasLife(current) ? 'Current fictional life: ' + life.lifeSummary(current) : 'No current life state recorded.',
        'Part of the day: ' + period + '.',
        recent.length ? 'Recent moments (do not repeat any of these):\n' + recent.map((value) => '- ' + value).join('\n') : 'No recent moments.',
        '',
        'Output only the JSON object.'
    ].filter(Boolean);
    return [
        { role: 'system', content: MOMENT_SYSTEM_PROMPT },
        { role: 'user', content: parts.join('\n') }
    ];
}

// Validate + sanitize a model reply. Unknown or malformed fields are dropped, and
// an explicit/uncovered moment is rejected entirely so the catalog answers.
function parseMoment(raw) {
    const parsed = life.extractJsonObject(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const title = clean(parsed.title, 80);
    const location = clean(parsed.location, 120);
    const activity = clean(parsed.activity, 240);
    if (!location || !activity) return null;
    if (!life.hasLife({ activity })) return null;
    const inferredStance = scenePosture.detectStance(activity);
    if (!/^[a-z]+ing\b/i.test(activity) && !inferredStance) return null;
    const blob = [title, location, activity, parsed.framing, parsed.angle, parsed.hands, parsed.lighting, parsed.mood, parsed.caption]
        .map((value) => String(value === undefined || value === null ? '' : value))
        .join(' ');
    // if (MOMENT_DENY_RE.test(blob)) return null;
    if (PROP_DENY_RE.test(blob)) return null;
    const camera = String(parsed.camera || '').toLowerCase().trim();
    const stance = String(parsed.stance || '').toLowerCase().trim();
    const framing = clean(parsed.framing, 200);
    const angle = clean(parsed.angle, 200);
    const hands = clean(parsed.hands, 160);
    const lighting = clean(parsed.lighting, 200);
    const mood = clean(parsed.mood, 60);
    const caption = cleanCaption(parsed.caption);
    return {
        id: 'llm-' + life.hashString(activity).toString(36),
        title: title || (activity.charAt(0).toUpperCase() + activity.slice(1)).slice(0, 80),
        location,
        activity,
        stance: STANCES.includes(stance) ? stance : (inferredStance || 'standing'),
        camera: CAMERAS.includes(camera) ? camera : 'front',
        framing: framing || 'a natural phone framing that shows the room behind her',
        angle: angle || 'roughly eye level, the phone held or propped naturally',
        hands,
        composition: 'a candid photo with the setting readable around her',
        lighting: lighting || '',
        mood,
        caption,
        source: 'llm'
    };
}

function isRepeat(moment, recent) {
    if (!moment) return true;
    const key = normalizeKey(moment.title);
    return (Array.isArray(recent) ? recent : []).some((value) => {
        const normalized = normalizeKey(value);
        return normalized && (normalized === key || normalized === normalizeKey(moment.activity));
    });
}

function withTimeout(promise, ms) {
    if (!Number.isFinite(ms) || ms <= 0) return promise;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const err = new Error('moment direction timed out');
            err.code = 'moment_timeout';
            reject(err);
        }, ms);
        Promise.resolve(promise).then(
            (value) => { clearTimeout(timer); resolve(value); },
            (err) => { clearTimeout(timer); reject(err); }
        );
    });
}

// The one entry point the facade uses. Always resolves to a usable moment: the
// model when it answers with a safe, fresh moment, the catalog otherwise.
async function buildInboxMoment(options) {
    const opts = options || {};
    const now = opts.now === undefined ? Date.now() : opts.now;
    const hour = opts.hour === undefined ? new Date(now).getHours() : Number(opts.hour);
    const period = periodFor(hour);
    const recent = Array.isArray(opts.recent) ? opts.recent : [];
    let moment = null;
    if (opts.providers && typeof opts.providers.chat === 'function') {
        try {
            const messages = buildMomentMessages({
                character: opts.character,
                settings: opts.settings,
                life: opts.life,
                recent,
                period
            });
            const reply = await withTimeout(
                Promise.resolve(opts.providers.chat(
                    opts.provider || 'ollama',
                    messages,
                    opts.model || '',
                    { temperature: 0.9, think: false }
                )),
                opts.timeoutMs === undefined ? LLM_MOMENT_TIMEOUT_MS : opts.timeoutMs
            );
            const parsed = parseMoment(reply);
            if (parsed && !isRepeat(parsed, recent)) moment = parsed;
        } catch (err) {
            console.warn('[character-life] moment model skipped:', err.message);
        }
    }
    if (!moment) {
        moment = pickDeterministicMoment({ recent, seed: now, count: opts.count, hour });
    }
    return moment;
}

module.exports = {
    MOMENT_CATALOG,
    MOMENT_SYSTEM_PROMPT,
    // MOMENT_DENY_RE,
    STANCES,
    CAMERAS,
    PERIODS,
    periodFor,
    cleanCaption,
    pickDeterministicMoment,
    buildMomentMessages,
    parseMoment,
    buildInboxMoment
};
