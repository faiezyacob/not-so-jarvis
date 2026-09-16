/* ============================================
   JARVIS — Director Prompts
   LLM instructions and deterministic prompt
   composers used by the Director layer. The
   Director turns a production's canonical brief
   into the image and H3 video direction prompts
   so every stage reads from the same source of
   truth (never the raw user history).
   ============================================ */

// Extract a canonical creative brief from the user's production request.
const BRIEF_SYSTEM_PROMPT =
    'You are JARVIS\'s Director. The user asked for a multi-stage video production ' +
    '(an opening image followed by a short video). Extract a canonical creative brief ' +
    'that every later stage will be built from.\n\n' +
    'Respond with ONLY a single JSON object, no markdown, no commentary:\n' +
    '{"subject": "...", "setting": "...", "action": "...", "mood": "...", ' +
    '"visualStyle": "...", "camera": "...", "cameraMovement": "...", ' +
    '"temporal": "...", "sound": "...", "aspectRatio": "...", "shots": "1", ' +
    '"shotList": [], "explicitConstraints": [], "details": "..."}\n\n' +
    'Rules:\n' +
    '- Capture ONLY what the user asked for. Do not invent a different subject or setting.\n' +
    '- Preserve the user\'s own wording for every specific (nouns, names, wardrobe, props, ' +
    'colors, dialogue, on-screen text, named styles, brands, exact event order).\n' +
    '- "subject": who/what the production follows (e.g. "a young Asian woman").\n' +
    '- "setting": where it happens (e.g. "a Tokyo street at night").\n' +
    '- "action": what the subject does (e.g. "walking toward the camera").\n' +
    '- "mood": the emotional tone (e.g. "cinematic, moody").\n' +
    '- "visualStyle": the look (e.g. "photorealistic cinematic").\n' +
    '- "camera": the opening shot framing (e.g. "medium tracking shot").\n' +
    '- "cameraMovement": how the camera moves in the opening shot (e.g. "slow tracking forward").\n' +
    '- "temporal": how the action develops over the video — NOT the duration.\n' +
    '- "sound": diegetic ambience / music direction, or "" if unspecified.\n' +
    '- "aspectRatio": only when the user names one (e.g. "16:9"), else "".\n' +
    '- "shotList": the shot-by-shot plan of the sequence, as an array of short descriptive ' +
    'strings (one per shot, in order). Direct this like a real director: plan 3-5 distinct ' +
    'shots for a typical short production. Each shot must introduce new information (subject, ' +
    'space, state, viewpoint, or time) — never a cut that only changes distance or angle. ' +
    'Describe what the camera shows and how it moves, e.g. ' +
    '"Wide establishing shot of a woman stepping onto a rain-soaked Tokyo street (camera: slow push in)". ' +
    'Only return [] or a single entry when the user explicitly asks for one continuous shot. ' +
    'Never include timestamps in a shot description; the edit is expressed by the cut itself.\n' +
    '- "shots": the number of shots as a string, matching the "shotList" length.\n' +
    '- "explicitConstraints": array of hard constraints the user states, else [].\n' +
    '- "details": free-form, comma-separated list of every other specific the user gave ' +
    '(props, wardrobe, named styles, dialogue, on-screen text, exact sequence). This is ' +
    'the safety net — if a specific does not fit a field above, it MUST appear here. ' +
    'Never leave details empty when the user asked for specifics.\n' +
    '- Empty string for any field the user did not specify. Do not fill it with guesses.';

// Update the canonical brief from a natural-language direction change.
const BRIEF_UPDATE_SYSTEM_PROMPT =
    'You are JARVIS\'s Director. You are given the CURRENT creative brief for a ' +
    'video production and a DIRECTION CHANGE from the user. Return the UPDATED brief.\n\n' +
    'Respond with ONLY the single JSON object, no markdown, no commentary, with the ' +
    'same keys as the current brief.\n\n' +
    'Rules:\n' +
    '- Apply the change as a real replacement of the affected field(s), not as an ' +
    'instruction appended to a value.\n' +
    '- Preserve every field the user did not ask to change.\n' +
    '- Changing a camera request replaces the old camera / cameraMovement values.\n' +
    '- Changing the look replaces visualStyle, not the subject.\n' +
    '- Never add unrelated creative details and never drop existing ones.\n' +
    '- A change to a specific that has no dedicated field (wardrobe, prop, color, ' +
    'dialogue, on-screen text) MUST be applied inside "details" (replace the old value, ' +
    'do not append a new one).\n' +
    '- Keep "details" as the free-form catch-all for every specific the structured fields ' +
    'do not cover. Never empty it out.\n' +
    '- A change to the pacing, structure, or number of shots replaces "shotList" (and its ' +
    'matching "shots") as a whole — do not append to the old list.\n' +
    '- Output the final brief, not a description of the edit.';

function cleanFragment(value) {
    return String(value === undefined || value === null ? '' : value)
        .trim()
        .replace(/^[,\s.;:]+|[,\s.;:]+$/g, '');
}

function joinFragments(parts) {
    return parts.map(cleanFragment).filter(Boolean).join('. ');
}

// deterministic sentence: ensure it ends with a period when non-empty
function sentence(text) {
    const t = cleanFragment(text);
    if (!t) return '';
    return /[.!?]$/.test(t) ? t : t + '.';
}

// Compose the opening-frame image concept from the brief. Used as the image
// pipeline's user prompt so the frame matches the production, not the raw text.
// `opts.authoritative` is the user's own wording (only while the brief is still
// unmodified) and is included so specifics the brief paraphrased away survive.
function composeImageConcept(brief, opts = {}) {
    const b = brief || {};
    const authoritative = cleanFragment(opts.authoritative);
    const subject = cleanFragment(b.subject) || 'a cinematic subject';
    const head = cleanFragment([subject, cleanFragment(b.action)].filter(Boolean).join(' '));
    const setting = cleanFragment(b.setting);
    const lines = [];
    lines.push(head + (setting ? ' in ' + setting : ''));
    if (cleanFragment(b.visualStyle)) lines.push(sentence('Visual style: ' + b.visualStyle));
    if (cleanFragment(b.mood)) lines.push(sentence('Mood: ' + b.mood));
    const camera = [cleanFragment(b.camera), cleanFragment(b.cameraMovement)]
        .filter(Boolean).join(', ');
    if (camera) lines.push(sentence('Camera: ' + camera));
    if (cleanFragment(b.aspectRatio)) lines.push(sentence('Aspect ratio: ' + b.aspectRatio));
    if (cleanFragment(b.details)) lines.push(sentence('Specific details: ' + b.details));
    if (Array.isArray(b.explicitConstraints) && b.explicitConstraints.length) {
        lines.push(sentence('Constraints: ' + b.explicitConstraints.join('; ')));
    }
    if (authoritative) {
        lines.push(sentence('Honor every specific in the user\'s request: "' + authoritative + '"'));
    }
    return lines.join(' ');
}

// Compose the H3 video-direction request from the brief + duration. The H3
// director LLM expands this into a full H3 prompt following the official H3
// Video Prompt Writing Guide. Director productions are cut like a real film, so
// the direction carries an explicit shot plan and requires one [Shot N] per
// beat with strictly increasing cut times (unless the user asked for one take).
function composeVideoDirection(brief, duration, opts = {}) {
    const b = brief || {};
    const authoritative = cleanFragment(opts.authoritative);
    const seconds = Number(duration) > 0 ? Math.round(Number(duration)) : null;
    const subject = cleanFragment(b.subject) || 'the subject';
    const action = cleanFragment(b.action) || 'moves with natural, continuous motion';
    const setting = cleanFragment(b.setting);
    const shotList = Array.isArray(opts.shotList)
        ? opts.shotList.map(cleanFragment).filter(Boolean).slice(0, 8)
        : planShots(b, duration, { authoritative });
    const multiShot = shotList.length > 1;
    const lines = [];
    // The user's own wording leads so the H3 director cannot miss the intent;
    // the structured direction below then tells it how to develop that intent.
    if (authoritative) {
        lines.push('User\'s request (authoritative — honor every specific): "' + authoritative + '"');
    }
    if (multiShot) {
        lines.push(
            'Direct this as a cut sequence of ' + shotList.length + ' shots: ' + subject + ' ' + action +
            (setting ? ' in ' + setting : '') + '.'
        );
        lines.push(
            'Every cut must reveal new information (subject, space, state, viewpoint, or time); ' +
            'never cut only to change distance or a slight angle — move the camera for that.'
        );
    } else {
        lines.push(
            'Animate the reference image as a continuous shot: ' + subject + ' ' + action +
            (setting ? ' in ' + setting : '') + '.'
        );
    }
    if (cleanFragment(b.visualStyle)) lines.push(sentence('Visual style: ' + b.visualStyle));
    if (cleanFragment(b.mood)) lines.push(sentence('Mood: ' + b.mood));
    const camera = [cleanFragment(b.camera), cleanFragment(b.cameraMovement)]
        .filter(Boolean).join(', ');
    if (camera) lines.push(sentence('Camera: ' + camera));
    if (cleanFragment(b.details)) lines.push(sentence('Specific details: ' + b.details));
    if (cleanFragment(b.temporal)) lines.push(sentence('Temporal progression: ' + b.temporal));
    if (cleanFragment(b.sound)) lines.push(sentence('Sound: ' + b.sound));
    if (seconds) {
        lines.push(sentence(
            'Total duration ' + seconds + ' seconds, with the action developing naturally ' +
            'across the full ' + seconds + ' seconds'
        ));
    }
    if (multiShot) {
        lines.push('Shot plan (exactly these shots, in order):');
        shotList.forEach((desc, index) => {
            lines.push('[Shot ' + (index + 1) + '] ' + desc);
        });
        lines.push(
            'Start [Shot 1] with no timestamp. Begin each later shot with a strictly ' +
            'increasing cut time that falls within the duration, formatted exactly like ' +
            '"[Shot 2] At 00:03.500, the camera cuts to ...". Keep the subject, wardrobe, ' +
            'colors, key objects, and setting consistent across every shot.'
        );
    } else {
        lines.push('Use a single continuous shot ([Shot 1]) — do not cut to additional shots.');
    }
    return lines.join(' ');
}

// Phrasing that explicitly asks for one unbroken take; when present the Director
// honors it instead of planning a cut sequence.
const SINGLE_SHOT_RE =
    /\b(?:one|1|single)\s+(?:continuous\s+|unbroken\s+|long\s+|seamless\s+)?(?:take|shot)\b|\b(?:continuous|unbroken|seamless)\s+(?:single\s+)?shot\b|\bno\s+cuts?\b|\bwithout\s+(?:any\s+)?cuts?\b|\bsteadycam\b|\bsteadicam\b/i;

// Deterministic fallback shot plan when the LLM returns none. Builds a real
// cut sequence (establishing -> action -> detail -> cutaway -> resolution) from
// the structured brief so the H3 stage always gets distinct shots.
function buildDeterministicShots(brief, count) {
    const b = brief || {};
    const subject = cleanFragment(b.subject) || 'the subject';
    const action = cleanFragment(b.action);
    const setting = cleanFragment(b.setting);
    const details = cleanFragment(b.details);
    const mood = cleanFragment(b.mood);
    const style = cleanFragment(b.visualStyle);
    const camera = cleanFragment(b.camera);
    const movement = cleanFragment(b.cameraMovement);

    const beats = [];
    beats.push(
        'Wide establishing shot of ' + subject +
        (setting ? ' in ' + setting : '') +
        (style ? ', ' + style : '') +
        ' (camera: ' + (camera || 'static wide shot') + ')'
    );
    beats.push(
        (action ? 'Medium shot as ' + subject + ' ' + action : 'Medium shot following ' + subject) +
        (setting ? ' in ' + setting : '') +
        ' (camera: ' + (movement || 'tracking shot') + ')'
    );
    beats.push(
        'Close-up on ' + subject +
        (details ? ' revealing ' + details : '') +
        (mood ? ', ' + mood + ' tone' : '') +
        ' (camera: static shot)'
    );
    if (setting) beats.push('Cutaway wide shot of ' + setting + ' (camera: slow pan)');
    beats.push(
        'Final medium-wide shot as ' + subject +
        (action ? ' completes the action' : ' settles') +
        ' (camera: pull out)'
    );

    const out = [];
    for (let i = 0; i < count; i++) {
        if (i < beats.length) {
            out.push(beats[i]);
        } else {
            out.push(
                'Shot ' + (i + 1) + ' of ' + subject +
                (setting ? ' in ' + setting : '') +
                ' from a new angle (camera: ' + (movement || 'slow push in') + ')'
            );
        }
    }
    return out;
}

// Resolve the production's shot plan from the brief. Priority: the brief's own
// shot list, then an explicit multi-shot count, then an explicit one-take
// request, then a duration-derived Director default (roughly one cut per three
// seconds, capped at five, never a single continuous take).
function planShots(brief, duration, opts = {}) {
    const b = brief || {};
    const list = Array.isArray(b.shotList)
        ? b.shotList.map(cleanFragment).filter(Boolean).slice(0, 8)
        : [];
    if (list.length >= 2) return list;
    if (list.length === 1) return list;
    const text = [
        cleanFragment(opts.authoritative),
        cleanFragment(b.originalRequest),
        cleanFragment(b.details),
        cleanFragment(b.temporal)
    ].filter(Boolean).join(' ');
    if (SINGLE_SHOT_RE.test(text)) return [];
    const explicitCount = Number(b.shots);
    if (Number.isFinite(explicitCount) && explicitCount >= 2) {
        return buildDeterministicShots(b, Math.min(8, Math.round(explicitCount)));
    }
    const seconds = Number(duration) > 0 ? Number(duration) : 5;
    const count = Math.max(2, Math.min(5, Math.round(seconds / 3) || 2));
    return buildDeterministicShots(b, count);
}

// Heuristic fallback brief when the LLM is unavailable. Strips obvious
// production scaffolding so the subject/setting survive sensibly.
function heuristicBrief(message, duration) {
    const raw = String(message || '').trim();
    let subject = raw
        .replace(/^\s*(?:please\s+)?(?:can\s+you\s+)?(?:generate|create|make|render|produce|shoot|direct)\s+(?:me\s+)?/i, '')
        .replace(/\b(?:a|an|the)\s+(\d+(?:\.\d+)?)(?:\s*(?:-|to)\s*\d+)?\s*(?:second|sec|seconds|secs|minute|minutes)[\s-]*(?:long\s+)?(?:movie|film|video|clip|commercial|animation|short film)?\b/gi, '')
        .replace(/\b\d+(?:\.\d+)?\s*(?:second|sec|seconds|secs)[\s-]*(?:long\s+)?(?:movie|film|video|clip|commercial|animation|short film)?\b/gi, '')
        .replace(/\b(?:movie|film|short film|commercial|cinematic video|cinematic|trailer|teaser)\b/gi, '')
        .replace(/^\s*(?:of|about|showing|featuring)\s+/i, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[,\s.;:]+|[,\s.;:]+$/g, '')
        .trim();
    if (!subject) subject = raw || 'a cinematic subject';
    return {
        originalRequest: raw,
        subject,
        setting: '',
        action: '',
        mood: '',
        visualStyle: 'cinematic photorealistic',
        camera: '',
        cameraMovement: '',
        temporal: '',
        sound: '',
        aspectRatio: '',
        shots: '1',
        shotList: [],
        explicitConstraints: [],
        details: '',
        creativeMode: 'none'
    };
}

module.exports = {
    BRIEF_SYSTEM_PROMPT,
    BRIEF_UPDATE_SYSTEM_PROMPT,
    composeImageConcept,
    composeVideoDirection,
    planShots,
    buildDeterministicShots,
    heuristicBrief
};
