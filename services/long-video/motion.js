/* ============================================
   JARVIS — Long Video Motion/WORLD State
   Explicit motion-state continuity for the Long
   Video Director. Every beat carries an ending
   motion state and ending world state; every beat
   after the first carries a transition from the
   previous beat. This module owns the schema, the
   normalizers and the deterministic reconciliation
   that guarantees a continuous chain even when the
   planner LLM omits or contradicts it.

   The installed H3 LongVideos node still performs
   the actual temporal conditioning. This module
   only plans the higher-level story/world/motion
   state the node's prompt is written against.
   ============================================ */

const TRANSITION_MODES = Object.freeze(['continuous_transition', 'abrupt_transition']);

// A deliberate hard cut / jump / sudden change is requested. Everything else
// defaults to continuous motion.
const ABRUPT_RE =
    /\b(?:hard\s+cut|jump\s*cut|smash\s+cut|cuts?\s+to|cuts?\s+away|suddenly|abrupt(?:ly)?|snap(?:s)?\s+to|whip\s*pan|instantly\s+(?:cut|jump|switch|change)|immediately\s+(?:cut|jump|switch)|new\s+shot|different\s+(?:shot|scene)|time\s+jump|flash\s+cut)\b/i;

function str(value) {
    return String(value === undefined || value === null ? '' : value).trim();
}

function naturalToken(value) {
    return str(value).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function listPhrase(items) {
    const arr = (Array.isArray(items) ? items : []).map(str).filter(Boolean);
    if (!arr.length) return '';
    if (arr.length === 1) return arr[0];
    if (arr.length === 2) return arr[0] + ' and ' + arr[1];
    return arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];
}

function ensurePeriod(text) {
    const t = str(text);
    if (!t) return '';
    return /[.!?]$/.test(t) ? t : t + '.';
}

function capitalizeFirst(text) {
    const t = str(text);
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

// Capitalize the first letter of every sentence so assembled prose reads
// cleanly regardless of which fragment a sentence came from.
function capitalizeSentences(text) {
    const t = str(text);
    if (!t) return t;
    return t.replace(/(^\s*|[.!?]\s+)([a-z])/g, (match, prefix, letter) => prefix + letter.toUpperCase());
}

function toGerund(phrase) {
    const words = naturalToken(phrase).split(' ').filter(Boolean);
    if (!words.length) return '';
    const first = words[0];
    let gerund;
    if (/ie$/i.test(first)) gerund = first.slice(0, -2) + 'ying';
    else if (/[^aeiou]e$/i.test(first) && !/ee$/i.test(first)) gerund = first.slice(0, -1) + 'ing';
    else gerund = first + 'ing';
    return [gerund].concat(words.slice(1)).join(' ');
}

function normalizeStringArray(value, max) {
    if (!Array.isArray(value)) return [];
    return value.map((s) => str(s)).filter(Boolean).slice(0, max || 16);
}

function unionStrings(...lists) {
    const seen = new Set();
    const out = [];
    for (const list of lists) {
        for (const item of (Array.isArray(list) ? list : [])) {
            const value = str(item);
            if (!value) continue;
            const key = value.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(value);
        }
    }
    return out;
}

// --- Motion state schema ------------------------------------------------------

function emptyCameraState() {
    return {
        movement: '',
        direction: '',
        speed: '',
        acceleration: '',
        momentum: '',
        orientation: '',
        framing: '',
        screenPosition: ''
    };
}

function emptySubjectState() {
    return {
        movement: '',
        direction: '',
        speed: '',
        acceleration: '',
        pose: '',
        gaze: '',
        hands: ''
    };
}

function emptyMotionState() {
    return {
        camera: emptyCameraState(),
        subject: emptySubjectState(),
        objects: [],
        environment: ''
    };
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCameraState(value) {
    const base = emptyCameraState();
    if (!isPlainObject(value)) return base;
    for (const key of Object.keys(base)) {
        base[key] = naturalToken(value[key]);
    }
    return base;
}

function normalizeSubjectState(value) {
    const base = emptySubjectState();
    if (!isPlainObject(value)) return base;
    for (const key of Object.keys(base)) {
        base[key] = naturalToken(value[key]);
    }
    return base;
}

function normalizeMotionState(value) {
    const base = emptyMotionState();
    if (!isPlainObject(value)) return base;
    base.camera = normalizeCameraState(value.camera);
    base.subject = normalizeSubjectState(value.subject);
    base.objects = normalizeStringArray(value.objects, 12);
    base.environment = str(value.environment);
    return base;
}

// --- World state schema -------------------------------------------------------

function emptyWorldState() {
    return {
        clothing: '',
        appearance: '',
        location: '',
        props: [],
        objectStates: [],
        completedActions: []
    };
}

function normalizeWorldState(value) {
    const base = emptyWorldState();
    if (!isPlainObject(value)) return base;
    for (const key of ['clothing', 'appearance', 'location']) {
        base[key] = str(value[key]);
    }
    base.props = normalizeStringArray(value.props, 16);
    base.objectStates = normalizeStringArray(value.objectStates, 16);
    base.completedActions = normalizeStringArray(value.completedActions, 16);
    return base;
}

// --- Transition schema --------------------------------------------------------

function emptyTransition() {
    return {
        initial_continuation: '',
        transition: '',
        new_action: '',
        resulting_motion_state: ''
    };
}

function normalizeTransition(value) {
    const base = emptyTransition();
    if (!isPlainObject(value)) return base;
    for (const key of Object.keys(base)) {
        base[key] = str(value[key]);
    }
    return base;
}

// --- Camera vocabulary --------------------------------------------------------

const CAMERA_MOVES = {
    pan: { verb: 'pan', gerund: 'panning' },
    tilt: { verb: 'tilt', gerund: 'tilting' },
    dolly: { verb: 'dolly', gerund: 'dollying' },
    truck: { verb: 'truck', gerund: 'trucking' },
    track: { verb: 'track', gerund: 'tracking' },
    orbit: { verb: 'orbit', gerund: 'orbiting' },
    arc: { verb: 'arc', gerund: 'arcing' },
    crane: { verb: 'crane', gerund: 'craning' },
    push_in: { verb: 'push in', gerund: 'pushing in' },
    pull_out: { verb: 'pull out', gerund: 'pulling out' },
    zoom_in: { verb: 'zoom in', gerund: 'zooming in' },
    zoom_out: { verb: 'zoom out', gerund: 'zooming out' },
    handheld: { verb: 'drift handheld', gerund: 'drifting handheld' },
    static: { verb: 'hold still', gerund: 'holding still', still: true }
};

const CAMERA_ALIASES = {
    'push in': 'push_in', pushin: 'push_in', push: 'push_in', 'dolly in': 'push_in',
    'pull out': 'pull_out', pullout: 'pull_out', pull: 'pull_out', 'dolly out': 'pull_out',
    'zoom in': 'zoom_in', zoomin: 'zoom_in', zoom: 'zoom_in',
    'zoom out': 'zoom_out', zoomout: 'zoom_out',
    fixed: 'static', locked: 'static', still: 'static', 'hold still': 'static', stationary: 'static',
    tracking: 'track', dolly: 'dolly', truck: 'truck', panning: 'pan', tilting: 'tilt'
};

function cameraEntry(movement) {
    const raw = naturalToken(movement).toLowerCase();
    if (!raw) return null;
    const key = CAMERA_ALIASES[raw] || raw.replace(/\s+/g, '_');
    const entry = CAMERA_MOVES[key] || { verb: raw, gerund: toGerund(raw) };
    return { key, entry };
}

const SPEED_ADVERB = {
    slow: 'slowly', slowly: 'slowly', gentle: 'gently', gently: 'gently',
    medium: 'steadily', moderate: 'steadily', steady: 'steadily', normal: 'steadily',
    fast: 'quickly', quick: 'quickly', rapid: 'rapidly', rapidly: 'rapidly'
};

const SPEED_ADJECTIVE = {
    slow: 'slow', slowly: 'slow', gentle: 'gentle', gently: 'gentle',
    medium: 'steady', moderate: 'steady', steady: 'steady', normal: 'steady',
    fast: 'quick', quick: 'quick', rapid: 'rapid', rapidly: 'rapid'
};

const SPEED_RANK = { slow: 1, slowly: 1, gentle: 1, gently: 1, medium: 2, moderate: 2, steady: 2, normal: 2, fast: 3, quick: 3, rapid: 3 };

function speedRank(value) {
    const key = naturalToken(value).toLowerCase();
    return SPEED_RANK[key] || 0;
}

// Push-ins / pull-outs / zooms already imply their direction; only add a
// direction phrase when the model asked for something non-obvious.
const IMPLIED_DIRECTION_MOVES = new Set(['push_in', 'pull_out', 'zoom_in', 'zoom_out']);
const GENERIC_DIRECTIONS = new Set(['forward', 'backward', 'in', 'out', 'toward', 'away']);

function cameraDirectionForPhrase(key, direction) {
    const d = naturalToken(direction).toLowerCase();
    if (!d) return '';
    if (IMPLIED_DIRECTION_MOVES.has(key) && GENERIC_DIRECTIONS.has(d)) return '';
    return directionPhrase(direction);
}

function directionPhrase(direction) {
    const t = naturalToken(direction);
    if (!t) return '';
    const toward = t.match(/^toward\s+(.+)$/i);
    if (toward) {
        const rest = toward[1];
        return 'toward ' + (/^the\b/i.test(rest) ? rest : 'the ' + rest);
    }
    const away = t.match(/^away from\s+(.+)$/i);
    if (away) {
        const rest = away[1];
        return 'away from ' + (/^the\b/i.test(rest) ? rest : 'the ' + rest);
    }
    return t;
}

const REVERSE_PAIRS = [
    ['right to left', 'left to right'],
    ['left', 'right'],
    ['up', 'down'],
    ['in', 'out'],
    ['forward', 'backward'],
    ['inward', 'outward'],
    ['clockwise', 'counterclockwise'],
    ['toward', 'away']
];

function isReverseDirection(a, b) {
    const x = naturalToken(a).toLowerCase();
    const y = naturalToken(b).toLowerCase();
    if (!x || !y || x === y) return false;
    for (const [p, q] of REVERSE_PAIRS) {
        if ((x.includes(p) && y.includes(q)) || (x.includes(q) && y.includes(p))) return true;
    }
    const sa = x.split(' to ');
    const sb = y.split(' to ');
    if (sa.length === 2 && sb.length === 2 && sa[0] === sb[1] && sa[1] === sb[0]) return true;
    return false;
}

function describeNextCamera(camera) {
    const cam = normalizeCameraState(camera);
    const resolved = cameraEntry(cam.movement);
    if (!resolved) return 'new camera move';
    if (resolved.entry.still) return 'still frame';
    const bits = [
        SPEED_ADJECTIVE[cam.speed.toLowerCase()] || cam.speed,
        resolved.entry.verb,
        cameraDirectionForPhrase(resolved.key, cam.direction)
    ].filter(Boolean);
    return bits.join(' ');
}

function cameraPhrase(camera, tense) {
    const resolved = cameraEntry(camera && camera.movement);
    if (!resolved) return '';
    if (resolved.entry.still) {
        return tense === 'continuous' ? 'the camera is holding still' : 'the camera holds still';
    }
    const speed = SPEED_ADVERB[str(camera.speed).toLowerCase()] || str(camera.speed);
    const dir = cameraDirectionForPhrase(resolved.key, camera.direction);
    if (tense === 'continuous') {
        const core = [speed, resolved.entry.gerund, dir].filter(Boolean).join(' ');
        return 'the camera is ' + core;
    }
    const core = [speed, resolved.entry.verb, dir].filter(Boolean).join(' ');
    return 'the camera ' + core;
}

function gerundOf(key) {
    const entry = CAMERA_MOVES[key];
    return entry ? entry.gerund : toGerund(key);
}

// --- Subject vocabulary -------------------------------------------------------

const SUBJECT_MOVES = {
    walk: 'walking', walking: 'walking', stroll: 'strolling', striding: 'striding',
    run: 'running', running: 'running', sprint: 'sprinting', jog: 'jogging',
    sit: 'sitting', sitting: 'sitting', stand: 'standing', standing: 'standing',
    turn: 'turning', turning: 'turning', spin: 'spinning', spinaround: 'spinning around',
    reach: 'reaching', reaching: 'reaching', pick_up: 'picking up', grasp: 'grasping',
    crouch: 'crouching', kneel: 'kneeling', lean: 'leaning', lie: 'lying', lying: 'lying',
    dance: 'dancing', jump: 'jumping', climb: 'climbing', fall: 'falling', step: 'stepping',
    stagger: 'staggering', swim: 'swimming', ride: 'riding', drive: 'driving',
    crawl: 'crawling', approach: 'approaching', retreat: 'retreating'
};

function subjectMovementPhrase(movement) {
    const raw = naturalToken(movement).toLowerCase();
    if (!raw) return '';
    return SUBJECT_MOVES[raw] || toGerund(raw);
}

// Posture verbs already ARE the pose; appending the pose field would read as a
// duplicate ("sitting, seated").
const POSTURE_MOVES = new Set(['sitting', 'standing', 'lying', 'kneeling', 'crouching', 'seated']);

function subjectPhrase(subject, name, tense) {
    const sub = normalizeSubjectState(subject);
    const who = str(name) || 'the subject';
    const movement = subjectMovementPhrase(sub.movement);
    const speed = SPEED_ADVERB[sub.speed.toLowerCase()] || sub.speed;
    const dir = directionPhrase(sub.direction);
    let sentence;
    if (movement) {
        const core = [speed, movement, dir].filter(Boolean).join(' ');
        sentence = who + (tense === 'continuous' ? ' is ' : ' ') + core;
    } else if (sub.pose) {
        sentence = who + (tense === 'continuous' ? ' is ' + naturalToken(sub.pose) : ' ' + naturalToken(sub.pose));
    } else {
        return '';
    }
    if (sub.pose && movement && !POSTURE_MOVES.has(movement)) sentence += ', ' + naturalToken(sub.pose);
    if (sub.gaze) sentence += ', looking ' + directionPhrase(sub.gaze);
    if (sub.hands) sentence += ', ' + naturalToken(sub.hands);
    return sentence;
}

// --- Narrative builders -------------------------------------------------------

// The state the NEXT beat inherits: what is already happening at the first frame.
function describeStartingState(beat, name) {
    const parts = [];
    const cam = cameraPhrase(beat.ending_motion_state && beat.ending_motion_state.camera, 'continuous');
    if (cam) {
        const momentum = str(beat.ending_motion_state.camera.momentum).toLowerCase();
        parts.push(momentum === 'continuing' ? cam + ', still moving' : cam);
    }
    const sub = subjectPhrase(beat.ending_motion_state && beat.ending_motion_state.subject, name, 'continuous');
    if (sub) parts.push(sub);
    const objects = (beat.ending_motion_state && beat.ending_motion_state.objects) || [];
    if (objects.length) parts.push('still moving in frame: ' + listPhrase(objects));
    const env = beat.ending_motion_state && beat.ending_motion_state.environment;
    if (env) parts.push(str(env));

    const states = (beat.ending_world_state && beat.ending_world_state.objectStates) || [];
    if (states.length) parts.push('already in effect: ' + listPhrase(states));

    if (!parts.length) return '';
    return ensurePeriod(parts.join('. '));
}

// The state at the end of THIS beat.
function describeEndingState(beat, name) {
    const parts = [];
    const cam = cameraPhrase(beat.ending_motion_state && beat.ending_motion_state.camera, 'continuous');
    if (cam) parts.push(cam);
    const sub = subjectPhrase(beat.ending_motion_state && beat.ending_motion_state.subject, name, 'continuous');
    if (sub) parts.push(sub);
    if (!parts.length) return '';
    return ensurePeriod(parts.join('. '));
}

// How the camera bridges from the previous movement into this beat's movement:
// continue -> decelerate/transition -> new movement. Never an instantaneous
// reset or reversal.
function describeMotionBridge(previousCamera, nextCamera) {
    const prev = normalizeCameraState(previousCamera);
    const next = normalizeCameraState(nextCamera);
    const pResolved = cameraEntry(prev.movement);
    const nResolved = cameraEntry(next.movement);
    const pStill = !pResolved || pResolved.entry.still;
    const nStill = !nResolved || nResolved.entry.still;

    if (pStill && nStill) return '';
    if (!pStill && nStill) {
        return 'The ' + pResolved.entry.verb + ' gradually slows and the camera settles to a natural stop.';
    }
    if (pStill && !nStill) {
        return 'The camera begins a ' + describeNextCamera(next) + '.';
    }

    if (pResolved.key === nResolved.key) {
        const sameDirection = naturalToken(prev.direction).toLowerCase() === naturalToken(next.direction).toLowerCase();
        const pRank = speedRank(prev.speed);
        const nRank = speedRank(next.speed);
        if (sameDirection && naturalToken(prev.direction)) {
            const dir = directionPhrase(prev.direction);
            if (pRank && nRank && nRank < pRank) {
                return 'The camera continues its ' + pResolved.entry.gerund + ' ' + dir + ' as it gradually slows.';
            }
            if (pRank && nRank && nRank > pRank) {
                return 'The camera continues its ' + pResolved.entry.gerund + ' ' + dir + ' and builds speed.';
            }
            return 'The camera continues its ' + pResolved.entry.gerund + ' ' + dir + ' without a break.';
        }
        if (naturalToken(next.direction) && isReverseDirection(prev.direction, next.direction)) {
            return 'The camera carries its ' + pResolved.entry.gerund + ' briefly, gradually slows, then ' +
                'smoothly reverses direction and begins ' + pResolved.entry.gerund + ' ' + directionPhrase(next.direction) + '.';
        }
        if (naturalToken(next.direction)) {
            const from = naturalToken(prev.direction) ? directionPhrase(prev.direction) : 'current direction';
            return 'The camera eases out of its ' + from + ' ' + pResolved.entry.gerund +
                ' and transitions into a ' + describeNextCamera(next) + '.';
        }
        return 'The camera transitions into a ' + describeNextCamera(next) + '.';
    }

    // Different movement type: settle the old one first, then start the new one.
    return 'The existing ' + pResolved.entry.verb + ' gradually slows and settles; once the camera has ' +
        'settled it begins a ' + describeNextCamera(next) + '.';
}

// --- Reconciliation -----------------------------------------------------------

// A deliberate cut may only skip continuity when the user asked for one, or the
// planner explicitly marked the beat abrupt.
function resolveTransitionMode(beat) {
    const explicit = str(beat && beat.transition_mode).toLowerCase();
    if (TRANSITION_MODES.includes(explicit)) return explicit;
    const haystack = [beat && beat.action, beat && beat.camera, beat && beat.continuity]
        .map(str).filter(Boolean).join(' ');
    return ABRUPT_RE.test(haystack) ? 'abrupt_transition' : 'continuous_transition';
}

function inheritWorldState(beat, previous) {
    const prev = previous.ending_world_state;
    const ws = beat.ending_world_state;
    if (!ws.clothing && prev.clothing) ws.clothing = prev.clothing;
    if (!ws.appearance && prev.appearance) ws.appearance = prev.appearance;
    if (!ws.location && prev.location) ws.location = prev.location;
    if (!ws.props.length) ws.props = prev.props.slice();
    ws.objectStates = unionStrings(prev.objectStates, ws.objectStates);
    ws.completedActions = unionStrings(prev.completedActions, ws.completedActions);
    beat.ending_world_state = ws;
}

function buildContinuousTransition(previous, beat, name, rawTransition) {
    const provided = normalizeTransition(rawTransition);
    return {
        initial_continuation: provided.initial_continuation || describeStartingState(previous, name),
        transition: provided.transition ||
            describeMotionBridge(previous.ending_motion_state.camera, beat.ending_motion_state.camera),
        new_action: provided.new_action || str(beat.action),
        resulting_motion_state: provided.resulting_motion_state || describeEndingState(beat, name)
    };
}

// Ensure every beat carries a normalized ending state and that every beat after
// the first carries a transition that starts from the previous beat's ACTUAL
// ending state (priority 1), not from zero. Planner-provided transitions are
// preserved; gaps are filled deterministically.
function reconcileMotionChain(beats, opts = {}) {
    const name = str(opts.subjectName);
    const list = Array.isArray(beats) ? beats : [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const raw = isPlainObject(list[i]) ? list[i] : {};
        const beat = Object.assign({}, raw);
        beat.ending_motion_state = normalizeMotionState(raw.ending_motion_state);
        beat.ending_world_state = normalizeWorldState(raw.ending_world_state);
        beat.transition_mode = resolveTransitionMode(raw);

        if (i === 0) {
            beat.transition_from_previous = null;
        } else {
            const previous = out[i - 1];
            inheritWorldState(beat, previous);
            if (beat.transition_mode === 'abrupt_transition') {
                // A deliberate cut: keep the planner's transition if any, but do
                // not fabricate continuity.
                const provided = normalizeTransition(raw.transition_from_previous);
                beat.transition_from_previous = Object.assign(emptyTransition(), provided, {
                    new_action: provided.new_action || str(beat.action)
                });
            } else {
                beat.transition_from_previous = buildContinuousTransition(
                    previous, beat, name, raw.transition_from_previous
                );
            }
        }
        out.push(beat);
    }
    return out;
}

module.exports = {
    TRANSITION_MODES,
    ABRUPT_RE,
    emptyCameraState,
    emptySubjectState,
    emptyMotionState,
    emptyWorldState,
    emptyTransition,
    normalizeCameraState,
    normalizeSubjectState,
    normalizeMotionState,
    normalizeWorldState,
    normalizeTransition,
    reconcileMotionChain,
    resolveTransitionMode,
    describeStartingState,
    describeEndingState,
    describeMotionBridge,
    describeNextCamera,
    cameraPhrase,
    subjectPhrase,
    directionPhrase,
    isReverseDirection,
    listPhrase,
    naturalToken,
    toGerund,
    capitalizeFirst,
    capitalizeSentences,
    ensurePeriod
};
