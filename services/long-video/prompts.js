/* ============================================
   JARVIS — Long Video Prompt Builders
   The LLM system prompts the Long Video
   Director uses (Story Bible, beat planning,
   storyboard updates), plus the deterministic
   helpers that guarantee a valid plan even when
   every LLM step fails.

   The director composes the LongVideos prompt
   from the Story Bible + beats; it never asks
   one giant prompt to do everything at once.
   ============================================ */

const motion = require('./motion');

// Deterministic beat segmentation. Uses the smallest number of beats that
// respects the per-beat cap, then spreads the remainder across the middle-most
// beats so the split stays balanced. Examples: 20 -> 10+10, 25 -> 13+12,
// 30 -> 15+15, 40 -> 13+14+13, 45 -> 15+15+15, 60 -> 15+15+15+15.
function segmentDuration(totalSeconds, maxBeatSeconds = 15) {
    const total = Number(totalSeconds);
    const cap = Math.max(1, Math.min(15, Number(maxBeatSeconds) || 15));
    if (!Number.isFinite(total) || total <= 0) return [cap];
    const count = Math.max(1, Math.ceil(total / cap));
    const base = Math.floor(total / count);
    const remainder = Math.max(0, Math.round(total - base * count));
    const durations = new Array(count).fill(base);
    const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => {
        const da = Math.abs(a - (count - 1) / 2);
        const db = Math.abs(b - (count - 1) / 2);
        return da === db ? a - b : da - db;
    });
    for (let i = 0; i < remainder; i++) {
        durations[order[i % count]] += 1;
    }
    return durations;
}

// Deterministic fallback Story Bible. Nothing is invented: it only carries the
// user's wording so a failed LLM step still produces a usable prompt.
function heuristicBible(request) {
    return {
        characters: [],
        environment: { location: '', timeOfDay: '', weather: '', lighting: '' },
        props: [],
        objectStates: [],
        completedActions: [],
        visualStyle: '',
        cameraStyle: '',
        continuityRules: [],
        storySummary: String(request || '').trim()
    };
}

// Deterministic fallback beats: one beat per segment, the user's request on the
// first beat (the model needs something to render), terse continuations after.
function heuristicBeats(bible, duration) {
    const durations = segmentDuration(duration, 15);
    let cursor = 0;
    return durations.map((seconds, index) => {
        const startTime = Number(cursor.toFixed(1));
        cursor += seconds;
        const endTime = Number(cursor.toFixed(1));
        return {
            id: index + 1,
            startTime,
            endTime,
            duration: seconds,
            purpose: index === 0 ? 'Establish the scene' : 'Continue the sequence',
            action: index === 0
                ? String((bible && bible.storySummary) || '').trim()
                : 'The scene continues from the previous beat.',
            camera: '',
            continuity: index === 0 ? '' : 'Continues directly from the previous beat.',
            transition_mode: 'continuous_transition',
            ending_motion_state: null,
            ending_world_state: null,
            transition_from_previous: null
        };
    });
}

// Compose the paragraph-based LongVideos prompt:
//   paragraph 1 = common scene, every later paragraph = one beat/shot.
// The node prepends the scene paragraph to every shot, so persistent details
// (characters, wardrobe, style, camera) live THERE and are never repeated.
function composeLongVideoPrompt(bible, beats, opts = {}) {
    const b = bible && typeof bible === 'object' ? bible : heuristicBible('');
    const sceneParts = [];

    const characters = Array.isArray(b.characters)
        ? b.characters.map((c) => {
            const name = String(c.name || c.id || '').trim();
            const bits = [String(c.appearance || '').trim(), String(c.clothing || '').trim()]
                .filter(Boolean).join(', ');
            if (!name) return bits;
            return bits ? name + ': ' + bits : name;
        }).filter(Boolean)
        : [];
    if (characters.length) sceneParts.push(characters.join('. '));

    const env = b.environment && typeof b.environment === 'object' ? b.environment : {};
    const envLine = [env.timeOfDay, env.weather, env.location]
        .map((part) => String(part || '').trim())
        .filter(Boolean).join(', ');
    if (envLine) sceneParts.push(envLine + (env.lighting ? ', ' + String(env.lighting).trim() : ''));

    if (String(b.visualStyle || '').trim()) sceneParts.push(String(b.visualStyle).trim());
    if (String(b.cameraStyle || '').trim()) sceneParts.push(String(b.cameraStyle).trim());
    if (b.props && b.props.length) sceneParts.push('Props: ' + b.props.join(', '));

    const summary = String(b.storySummary || '').trim();
    const request = String(opts.request || '').trim();
    if (summary) sceneParts.push(summary);
    else if (request) sceneParts.push(request);

    const scene = motion.capitalizeSentences(
        sceneParts.join('. ').replace(/\.\s*\./g, '.').replace(/\s+/g, ' ').trim()
    ) || request || 'A single continuous scene.';

    const beatParagraphs = (Array.isArray(beats) ? beats : []).map((beat, index) => {
        const b = beat && typeof beat === 'object' ? beat : {};
        const action = String(b.action || '').trim();
        const camera = String(b.camera || '').trim();
        const abrupt = String(b.transition_mode || '').toLowerCase() === 'abrupt_transition';
        const transition = b.transition_from_previous && typeof b.transition_from_previous === 'object'
            ? b.transition_from_previous
            : null;

        let paragraph;
        if (index > 0 && !abrupt && transition) {
            // Continuation beats open with the previous beat's motion, bridge it,
            // then play the new action and state the resulting motion. Plain
            // cinematic prose — no schema terminology ever reaches H3.
            paragraph = [
                transition.initial_continuation,
                transition.transition,
                transition.new_action || action,
                transition.resulting_motion_state
            ].map((part) => motion.capitalizeFirst(String(part || '').trim())).filter(Boolean).join(' ');
            const framing = String(((b.ending_motion_state || {}).camera || {}).framing || '').trim();
            if (framing && !paragraph.toLowerCase().includes(framing.toLowerCase())) {
                paragraph += ' Framed as ' + framing + '.';
            }
        } else {
            paragraph = action || String(b.purpose || '').trim() || 'The scene continues from the previous beat.';
            if (camera && !paragraph.toLowerCase().includes(camera.toLowerCase())) {
                paragraph = paragraph.replace(/[.\s]+$/, '') + '. ' + camera;
            }
        }

        // Legacy continuity clause — only when no motion transition already
        // carries it (beat 1, an explicitly abrupt cut, or a raw fallback beat).
        const continuity = String(b.continuity || '').trim();
        if ((index === 0 || abrupt || !transition) && continuity &&
            !paragraph.toLowerCase().includes(continuity.toLowerCase())) {
            paragraph = paragraph.replace(/[.\s]+$/, '') + '. ' + continuity;
        }

        return motion.capitalizeSentences(motion.ensurePeriod(paragraph));
    }).filter(Boolean);

    if (!beatParagraphs.length) {
        beatParagraphs.push(scene);
    }

    // NOTE: deliberately NO [Shot N] markers — the installed LongVideos node
    // expects paragraph-per-beat, and it owns the cut/continuity syntax.
    return [scene].concat(beatParagraphs).join('\n\n');
}

// --- LLM system prompts -------------------------------------------------------

const STORY_BIBLE_SYSTEM_PROMPT =
    'You are JARVIS\'s Long Video Director. Extract a persistent Story Bible from the ' +
    'user\'s video request so later beats stay visually consistent.\n\n' +
    'Respond with ONLY a JSON object, no markdown, no commentary, exactly this shape:\n' +
    '{\n' +
    '  "characters": [\n' +
    '    {"id":"character_1","name":"","appearance":"","clothing":"","persistentAttributes":[]}\n' +
    '  ],\n' +
    '  "environment": {"location":"","timeOfDay":"","weather":"","lighting":""},\n' +
    '  "props": [],\n' +
    '  "objectStates": [],\n' +
    '  "completedActions": [],\n' +
    '  "visualStyle": "",\n' +
    '  "cameraStyle": "",\n' +
    '  "continuityRules": [],\n' +
    '  "storySummary": ""\n' +
    '}\n\n' +
    'RULES:\n' +
    '- Use ONLY details present in the request or that follow necessarily from it. Never invent names, wardrobe or places the user did not imply.\n' +
    '- Keep each field to one short concrete phrase. Empty strings and empty arrays are allowed and preferred over guesses.\n' +
    '- persistentAttributes are things that must never drift (scars, a signature prop, a hairstyle).\n' +
    '- objectStates are the durable state of things at the START of the video ("door closed", "glass on the table").\n' +
    '- completedActions are actions that are already finished before the video begins (usually none).\n' +
    '- storySummary is one sentence describing the entire requested video.\n' +
    '- Output ONLY the JSON object.';

const BEAT_PLAN_SYSTEM_PROMPT =
    'You are JARVIS\'s Long Video Director. Divide a video request into sequential ' +
    'beats — one beat per MiniMax H3 shot — and plan the MOTION CONTINUITY between them.\n\n' +
    'Respond with ONLY a JSON object, no markdown, no commentary:\n' +
    '{\n' +
    '  "beats": [\n' +
    '    {\n' +
    '      "id": 1,\n' +
    '      "startTime": 0, "endTime": 10, "duration": 10,\n' +
    '      "purpose": "",\n' +
    '      "action": "",\n' +
    '      "camera": "",\n' +
    '      "continuity": "",\n' +
    '      "transition_mode": "continuous_transition",\n' +
    '      "ending_world_state": {"clothing":"","appearance":"","location":"","props":[],"objectStates":[],"completedActions":[]},\n' +
    '      "ending_motion_state": {\n' +
    '        "camera": {"movement":"","direction":"","speed":"","acceleration":"","momentum":"","orientation":"","framing":"","screenPosition":""},\n' +
    '        "subject": {"movement":"","direction":"","speed":"","acceleration":"","pose":"","gaze":"","hands":""},\n' +
    '        "objects": [], "environment": ""\n' +
    '      },\n' +
    '      "transition_from_previous": null\n' +
    '    }\n' +
    '  ]\n' +
    '}\n\n' +
    'RULES:\n' +
    '- Each beat is one shot of at most 15 seconds. Prefer FEWER, LONGER beats.\n' +
    '- The provided beat lengths are the budget. Durations must sum to the requested total; never exceed 15s per beat.\n' +
    '- Split at a meaningful story boundary only: location change, major action change, camera transition, a character interaction, an important reveal, or the ending. When no boundary exists, keep one longer beat.\n\n' +
    'ACTION FIELDS:\n' +
    '- "action" is the concrete on-screen action for that beat, written as a film direction (no timestamps, no [Shot N] labels).\n' +
    '- "camera" is the shot framing and movement for that beat (e.g. "wide establishing shot, slow push in").\n' +
    '- Put spoken dialogue in double quotes inside "action" exactly as the user wrote it. Never invent dialogue.\n\n' +
    'ENDING STATE (EVERY BEAT):\n' +
    '- "ending_motion_state" is the motion AT THE END of the beat. This is what the next beat inherits. Describe camera movement/direction/speed/momentum, subject movement/direction/speed/pose/gaze, any important moving objects, and environmental movement (rain, wind, traffic) when relevant.\n' +
    '- "movement" uses short tokens: pan, tilt, dolly, track, orbit, crane, push_in, pull_out, zoom_in, zoom_out, handheld, static; subject movement uses walk, run, turn, reach, sit, stand, etc.\n' +
    '- "direction" uses short tokens: right_to_left, left_to_right, up, down, toward_window, away, forward, backward, clockwise.\n' +
    '- "speed" is slow, medium or fast. "acceleration" is accelerating, decelerating, constant or still. "momentum" is continuing, settling, stopped or starting.\n' +
    '- "ending_world_state" is what is true at the end of the beat (clothing, location, objectStates like "door open", completedActions like "picked up the letter"). Carry state forward: a thing done in an earlier beat stays done.\n\n' +
    'TRANSITION (EVERY BEAT AFTER THE FIRST):\n' +
    '- "transition_from_previous" must be present on beat 2+ with:\n' +
    '    initial_continuation — what is already happening at the first frame, continuing the previous beat\'s ending state, in natural prose.\n' +
    '    transition — how that motion bridges to this beat: continue, then decelerate/reverse/settle if needed, then begin the new motion. Never an instantaneous reset or reversal.\n' +
    '    new_action — the new action for this beat.\n' +
    '    resulting_motion_state — the motion state at the end of this beat.\n' +
    '- Motion has momentum: continue the previous movement first, then gradually change it. Pan → push_in must pass through "the pan slows and settles, then a gentle push in begins". Walk → sit must pass through approach, slow down, turn, sit. Run → stop must decelerate. A turn completes before facing a new way.\n' +
    '- The previous beat\'s ending state is authoritative. Do not repeat a completed action (do not remove the garment again, re-open the door, sit down again). Start from its result and describe the new state.\n' +
    '- Set "transition_mode" to "abrupt_transition" ONLY when the user explicitly asks for a cut, jump, sudden change or a completely different shot. Otherwise use "continuous_transition" (the default).\n' +
    '- For an abrupt beat, the transition may be brief and the new shot starts fresh.\n\n' +
    'GENERAL:\n' +
    '- Write plain cinematic prose in the transition fields. Never write schema words like ending_motion_state, transition_from_previous or resulting_motion_state into the prose.\n' +
    '- Preserve every explicit fact, prop, wardrobe detail and constraint from the request and the Story Bible.\n' +
    '- Do NOT describe the editing operation; describe the finished video.\n' +
    '- Output ONLY the JSON object.';

const STORYBOARD_UPDATE_SYSTEM_PROMPT =
    'You are JARVIS\'s Long Video Director. You are given the CURRENT Story Bible and ' +
    'the CURRENT beats for a long video, plus a CHANGE the user asked for.\n\n' +
    'Respond with ONLY a JSON object, no markdown, no commentary:\n' +
    '{"storyBible":{...},"beats":[...]}\n\n' +
    'RULES:\n' +
    '- Apply the change to the Story Bible and only the beats it affects. If the change is about the ending, edit the ending beat and leave the rest untouched.\n' +
    '- Never append contradictory text: rewrite the affected fields so the final description is internally consistent.\n' +
    '- Keep the beat count and durations unless the change explicitly changes the video length; durations must still sum to the total and stay <= 15s.\n' +
    '- Preserve the full beat shape: action, camera, continuity, transition_mode, ending_world_state, ending_motion_state and transition_from_previous.\n' +
    '- Keep motion continuity intact across the chain. If you edit a beat\'s ending motion, update the NEXT beat\'s transition_from_previous so it still starts from the new ending state. Do not repeat completed actions; a state changed in an earlier beat stays changed.\n' +
    '- When the user asks for an abrupt cut, set that beat\'s transition_mode to "abrupt_transition"; otherwise keep "continuous_transition".\n' +
    '- Preserve every detail the user did not ask to change, including wardrobe, props, dialogue and continuity.\n' +
    '- Write natural cinematic prose in the transition fields — never the schema field names.\n' +
    '- Output ONLY the JSON object.';

module.exports = {
    segmentDuration,
    heuristicBible,
    heuristicBeats,
    composeLongVideoPrompt,
    STORY_BIBLE_SYSTEM_PROMPT,
    BEAT_PLAN_SYSTEM_PROMPT,
    STORYBOARD_UPDATE_SYSTEM_PROMPT
};
