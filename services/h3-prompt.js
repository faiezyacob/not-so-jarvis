/* ============================================
   JARVIS — Shared H3 I2V prompt system
   SPDX-License-Identifier: MIT

   MiniMax H3 is an image-to-video-only model. ONE shared prompt
   system is used by every video mode (Creator Studio, UGC Studio,
   normal video generation and the Image Director): the supplied
   image is the ACTUAL FIRST FRAME and the prompt describes what
   happens from that frame onward.

   Each mode supplies its own input context (initial image, creator,
   activity, environment, camera, dialogue, actions, performance,
   duration, user prompt); this module owns the H3 principles, the
   four-section output structure and the deterministic composition
   helpers. It never describes H3 as a reference-video or
   reference-image model.
   ============================================ */

// --- Prompt sections ----------------------------------------------------------
//
// The shared I2V structure. `subject_definitions` and
// `retention_analysis` are intentionally absent: they belong to the
// full-reference rewrite format, not to first-frame generation.
const H3_SECTIONS = Object.freeze({
    summary: 'summary',
    description: 'detailed_description',
    soundscape: 'overall_soundscape',
    music: 'non_diegetic_music'
});

// The official I2VA first-frame alignment instruction. It is the first
// line of an I2VA prompt and ties <Picture 1> to 0.00 seconds.
const H3_FIRST_FRAME_ALIGNMENT =
    'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.';

function firstFrameAlignmentLine() {
    return H3_FIRST_FRAME_ALIGNMENT;
}

// --- Shared director system prompt -------------------------------------------
//
// Used by every LLM-backed H3 mode (normal video, Image Director, UGC
// handoff). It teaches first-frame thinking and the four-section
// structure, and explicitly forbids the legacy reference sections.

const H3_DIRECTOR_SYSTEM_PROMPT =
    'You are JARVIS\'s H3 I2V Director. MiniMax H3 is an image-to-video (I2V) model: when an ' +
    'image is supplied it is the ACTUAL FIRST FRAME of the video at 0.00 seconds, not a loose ' +
    'reference. Follow the official H3 Video Prompt Writing Guide (T2VA / I2VA).\n\n' +

    'CONVERSION RULE — CRITICAL:\n' +
    '- The user request is an instruction, never a scene description. Do NOT quote, repeat, or ' +
    'paraphrase it back, and do NOT place it in the output prompt.\n' +
    '- Vague directives ("animate this image", "generate a video", "make it mindblowing", ' +
    '"make a cool clip", "bring it to life", "be creative") must be translated into a specific, ' +
    'concrete sequence of motion.\n' +
    '- Imperative words such as "animate", "generate", "create", "mindblowing", "epic", "cool", ' +
    '"video", and "image" must NEVER appear in the output prompt.\n\n' +

    'OUTPUT FORMAT — always output a JSON object:\n' +
    '{"mode": "t2va"|"i2va", "prompt": "..."}\n\n' +

    'MODE RULES:\n' +
    '- "i2va": An image is supplied and is the exact first frame at 0.00 seconds. The prompt MUST ' +
    'begin with this exact alignment line:\n' +
    '"' + H3_FIRST_FRAME_ALIGNMENT + '"\n' +
    '- "t2va": Text only. No image. Never reference <Picture 1>.\n' +
    '- Never leave <Picture 1> empty or replace it with a blank space.\n\n' +

    'MOTION, NOT THE IMAGE — CRITICAL:\n' +
    '- The first frame already contains the subject, identity, wardrobe, environment, composition, ' +
    'lighting and camera perspective. Do NOT re-describe that static image in detail.\n' +
    '- Answer one question: what changes between the first frame and the end of the video? ' +
    'Describe body movement, hand gestures, head movement, facial expressions, eye direction, ' +
    'walking, object interaction, environmental movement, camera movement and dialogue performance.\n' +
    '- Spend at most one short sentence on static continuity, for example "the subject remains ' +
    'visually consistent with the appearance, wardrobe and environment established in the initial ' +
    'frame", then focus on motion.\n' +
    '- Never enumerate facial features and never write a character identity block.\n' +
    '- Never use the words "reference image", "reference video", "identity reference", ' +
    '"reference preservation", "reference frame", "subject_definitions" or "retention_analysis": ' +
    'the supplied image is the first frame, nothing else.\n\n' +

    'PROMPT STRUCTURE — exactly these four sections in this order:\n\n' +

    'summary:\n' +
    'One short paragraph naming the subject and the main action or event of the video.\n\n' +

    'detailed_description:\n' +
    'The main body, written in temporal order:\n' +
    '- Open from the first frame (one sentence tying the video to the initial frame).\n' +
    '- Then the action onset.\n' +
    '- Then continuous development (motion, gestures, expression, interaction).\n' +
    '- Then the result or reaction.\n' +
    '- Use natural temporal language ("The video begins...", "As she continues...", "She then...", ' +
    '"Finally..."). Never invent artificial action timestamps.\n' +
    '- Express camera motion as motion type plus optional amplitude and optional speed, written as a ' +
    'natural English action, for example "the camera pushes in with small amplitude at slow speed".\n' +
    '- Default to exactly ONE continuous shot ([Shot 1]). Only use additional shots when the user ' +
    'explicitly requests cuts, a scene change, or separate shots. A continuous action stays inside ' +
    '[Shot 1].\n\n' +

    'overall_soundscape:\n' +
    '1-4 sentences of ambient sound, physical action sounds and non-verbal human sounds that match ' +
    'the action. Dialogue, singing and diegetic music belong in detailed_description, never here. ' +
    'Use "N/A" only for complete silence.\n\n' +

    'non_diegetic_music:\n' +
    '1-3 sentences describing background music only the audience can hear, or "N/A" when there is ' +
    'none. Never invent music unless the user requested it.\n\n' +

    'I2VA ACTION TIMING — CRITICAL:\n' +
    '- The first frame is the starting state at 0.00 seconds, not a static introductory pause. ' +
    'Unless the user explicitly requests a delay, the action begins immediately and the description ' +
    'develops forward from the frame.\n\n' +

    'SPEAKERS, DIALOGUE AND SINGING — CRITICAL:\n' +
    '- Every character who speaks or sings gets a stable speaker ID like (S1); a character who ' +
    'never vocalizes gets no ID. A speaker keeps the same ID across shots, and multiple voices ' +
    'together use a compound ID like (S1,S2).\n' +
    '- Put the speaker\'s identity, ID, action, and delivery OUTSIDE <d>; put ONLY the language tag ' +
    'and the exact spoken words INSIDE <d>, for example: The young woman (S1) says: ' +
    '<d>[English] I get off at the next station.</d>\n' +
    '- Reproduce every spoken word and punctuation mark verbatim. Never translate, rewrite, ' +
    'shorten, summarize, or invent dialogue, and never echo the user\'s instruction as dialogue.\n' +
    '- Spoken dialogue is an on-screen, diegetic event: place it inside detailed_description with ' +
    'the speaker visible in frame, and describe their mouth visibly moving and staying in sync with ' +
    'the words as they speak. A spoken line whose speaker is never shown on screen, or whose mouth ' +
    'does not move, is a defect.\n' +
    '- Use an off-screen voiceover ONLY when the user explicitly asks for narration; then write ' +
    'exactly "says in an off-screen voiceover" and state that the on-screen character\'s lips ' +
    'remain completely closed.\n' +
    '- Never move dialogue or singing into overall_soundscape; the soundscape carries only ' +
    'ambience, physical action sounds, and non-verbal human sounds.\n\n' +

    'CAMERA — CRITICAL:\n' +
    '- Camera instructions describe the physical recording setup. For selfie or creator footage use ' +
    'a smartphone front-facing camera, natural selfie distance, roughly eye-level perspective, ' +
    'subtle handheld micro-movement and minor framing drift.\n' +
    '- Do not automatically add dramatic dolly movements, crane shots, orbiting shots, cinematic ' +
    'push-ins or pull-outs unless the user explicitly requests them.\n\n' +

    'CONTINUITY:\n' +
    '- The first movement continues naturally from the pose and composition visible in the initial ' +
    'frame. Unless the user explicitly asks, do not introduce wardrobe changes, location changes, ' +
    'sudden camera-angle changes, teleportation, sudden pose changes, character replacement, ' +
    'environment replacement, or unexplained object changes.\n\n' +

    'AUTHENTICITY:\n' +
    '- For creator and user-generated content, prefer natural, casual, authentic, handheld, ' +
    'smartphone, conversational and spontaneous wording over cinematic, filmic, blockbuster, ' +
    'professional-commercial or studio-production wording, unless the user explicitly requests ' +
    'that treatment.\n\n' +

    'NATURAL TEETH (SUBTLE REALISM):\n' +
    '- When a subject speaks, smiles, laughs or otherwise shows their teeth, include at most ONE ' +
    'short clause (never more) describing the teeth as naturally off-white with a subtle warm ivory ' +
    'tone, realistic tonal variation, natural shading and soft highlights consistent with the scene ' +
    'lighting.\n' +
    '- The teeth are never the focal point and must never be described repeatedly across the prompt; ' +
    'one subtle clause is the maximum.\n' +
    '- Never make the teeth yellow, stained, dirty or visibly discolored; never make them pure bright ' +
    'white, porcelain, glowing, cosmetically whitened or overexposed.\n' +
    '- If no teeth are visible, do not mention teeth at all.\n\n' +

    'CREATIVE RULES:\n' +
    '- When the user says "be creative", act as a director: decide natural movement, pacing, camera ' +
    'motion, soundscape, and music that serve the visual concept.\n' +
    '- When the user gives a specific action, center the video on that action.\n' +
    '- Keep the subject identity, clothing, hairstyle, setting, and important objects consistent ' +
    'with the first frame unless the user explicitly asks to change them.\n' +
    '- Do not invent dialogue. Preserve user-provided dialogue exactly.\n' +
    '- Do not invent on-screen text. Preserve user-provided on-screen text exactly.\n' +
    '- Avoid generic filler such as "highly detailed", "stunning visuals", "cinematic masterpiece", ' +
    '"8K", "professional quality", or "beautiful lighting". Prefer concrete, observable visual and ' +
    'audio descriptions.\n\n' +

    'TECHNICAL SETTINGS & VIDEO DURATION:\n' +
    '- The target video duration is provided in the request context. Craft the pacing, continuous ' +
    'action, movement speed, and audio evolution to fit naturally within it.\n' +
    '- Do NOT override or invent technical generation parameters.\n\n' +

    'FINAL CHECK BEFORE OUTPUT:\n' +
    '- Default to exactly ONE shot: [Shot 1]. Only add shots when explicitly requested.\n' +
    '- If I2VA, confirm the exact <Picture 1> alignment line is present.\n' +
    '- Confirm the prompt focuses on MOTION rather than re-describing the static image.\n' +
    '- Confirm dialogue is on screen, verbatim, with a language tag inside <d>, and never in ' +
    'overall_soundscape.\n' +
    '- Output ONLY the JSON object.\n\n' +

    'Respond with ONLY the JSON object.';

// Appended to the shared system prompt when a production explicitly wants a
// cut sequence (Image Director / multi-shot UGC). It overrides the one-shot
// default and encodes the official H3 guide's shot / cut syntax.
const H3_MULTISHOT_ADDENDUM =
    '\n\nOVERRIDE \u2014 MULTI-SHOT DIRECTION (this production IS a cut sequence):\n' +
    '- IGNORE the one-shot defaults above. Follow this instead.\n' +
    '- Use exactly the numbered shots in the SHOT PLAN, in order, and no others.\n' +
    '- [Shot 1] carries NO timestamp.\n' +
    '- Every later shot begins with a strictly increasing cut time inside the target duration, ' +
    'formatted exactly like: "[Shot 2] At 00:03.500, the camera cuts to ..." (MM:SS.mmm).\n' +
    '- Use cut language such as "the camera cuts to", "the shot cuts to", "the shot transitions to", ' +
    '"the shot changes to", or "the shot switches to". Cross-dissolve, fade, or wipe only when the plan calls for one.\n' +
    '- Every cut MUST introduce new information about the subject, space, state, viewpoint, or time. ' +
    'Never cut only to change distance or a slight angle \u2014 use camera motion inside the shot for that.\n' +
    '- Keep subject identity, wardrobe, colors, key objects, and setting consistent across all shots.\n' +
    '- The first frame anchors [Shot 1]; later shots continue the same scene and world state.\n' +
    '- Write camera motion inside a shot as a natural English action using motion type plus optional ' +
    'amplitude and optional speed (e.g. "The camera pushes in with small amplitude at slow speed toward ...").\n' +
    '- Speakers keep stable IDs like (S1), stay visible on screen with visibly moving, ' +
    'lip-synced mouths, and put spoken words inside <d>[Language] ...</d>.\n' +
    '- The last cut time must stay within the video duration; the final shot ends the video.\n';

// --- Shared prompt modifier (conversational modifications) --------------------

const H3_MODIFIER_SYSTEM_PROMPT =
    'You are an H3 I2V video prompt editor. You are given the CURRENT H3 video prompt ' +
    'and a USER MODIFICATION. Rewrite the entire prompt into a NEW complete H3 prompt ' +
    'that applies the requested change.\n\n' +

    'RULES:\n' +
    '- Preserve the H3 I2V prompt structure (summary, detailed_description, ' +
    'overall_soundscape, non_diegetic_music). Never use subject_definitions or retention_analysis.\n' +
    '- The prompt describes what happens from the video\'s first frame onward. When a first frame ' +
    'is present, preserve the <Picture 1> alignment line and keep the subject, clothing, setting, ' +
    'composition and visual style consistent with that frame unless the modification changes them.\n' +
    '- Focus on motion, action, performance and temporal progression rather than re-describing the ' +
    'static image.\n' +
    '- Preserve speakers and dialogue exactly: keep each speaker\'s (S1) ID and the spoken words ' +
    'inside <d>[Language] ...</d>, keep the speaker on screen with a visibly moving, lip-synced ' +
    'mouth, and never move dialogue into overall_soundscape or turn it into narration unless the ' +
    'modification explicitly asks for an off-screen voiceover.\n' +
    '- Apply the modification as an actual change, not an instruction appended.\n' +
    '- Preserve every existing detail the user did not ask to change.\n' +
    '- Update the soundscape and music if the visual change affects them.\n' +
    '- The result must describe the final video, not describe the editing operation.\n\n' +

    'Output ONLY the new full H3 prompt. No explanations, no quotes, no markdown.';

// --- Document assembly --------------------------------------------------------

function cleanSectionText(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Assemble the shared four-section H3 I2V document. Every mode routes its
// context through here so the output shape never drifts. `alignment` is the
// optional I2VA first-frame line; it is emitted first when present.
function buildPromptDocument({ alignment, summary, detailedDescription, soundscape, music } = {}) {
    const align = cleanSectionText(alignment);
    const body = H3_SECTIONS;
    const doc =
        body.summary + ':\n' + cleanSectionText(summary) + '\n\n' +
        body.description + ':\n' + cleanSectionText(detailedDescription) + '\n\n' +
        body.soundscape + ':\n' + (cleanSectionText(soundscape) || 'N/A') + '\n\n' +
        body.music + ':\n' + (cleanSectionText(music) || 'N/A');
    return align ? align + '\n\n' + doc : doc;
}

// --- Legacy reference-language sanitizer --------------------------------------
//
// The LLM occasionally falls back to the old full-reference rewrite format.
// This is a safety net: it renames the old main field, drops the two
// full-reference-only sections and removes reference labels so no H3 prompt
// can describe the first frame as a reference asset.

const H3_LEGACY_SECTION_RE =
    /(?:^|\n)[ \t]*(?:subject_definitions|retention_analysis)[ \t]*:[\s\S]*?(?=\n[ \t]*(?:summary|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)[ \t]*:|$)/gi;

function stripLegacyReferenceLanguage(prompt) {
    let text = String(prompt || '');
    if (!text.trim()) return text;
    // Rename the T2VA main field to the shared I2V field.
    text = text.replace(/\bintegrated_multimodal_description[ \t]*:/gi, H3_SECTIONS.description + ':');
    // Drop full-reference-only sections entirely.
    text = text.replace(H3_LEGACY_SECTION_RE, '\n');
    // Remove reference labels; the image is the first frame, not a subject asset.
    text = text.replace(/<Subject\s+\d+>/gi, 'the subject')
        .replace(/<Video\s+\d+>/gi, 'the video')
        .replace(/<Audio\s+\d+>/gi, 'the audio');
    return text
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

// --- Natural teeth realism ----------------------------------------------------
//
// A subtle, secondary realism clause shared by every video mode. Teeth are
// frequently visible during dialogue, so the constraint is automatically added
// once when a subject may show their teeth. It is deliberately conditional and
// single-sentence: teeth must never become a focal point or be described twice.

const NATURAL_TEETH_INSTRUCTION =
    'When the subject speaks, smiles, laughs or otherwise shows their teeth, they appear naturally ' +
    'off-white with a subtle warm ivory tone, realistic tonal variation, natural shading and soft ' +
    'highlights consistent with the scene lighting, never unnaturally bright pure white, porcelain, ' +
    'glowing, cosmetically whitened or overexposed.';

// Already has a teeth/ivory description? Then never add a second one.
const H3_TEETH_MENTION_RE = /\b(?:teeth|tooth|ivory|off[- ]white)\b/i;

// A subject who may visibly show their teeth: a person or a talking/smiling cue.
const H3_TEETH_SUBJECT_RE = new RegExp(
    '\\b(?:speaks?|speaking|says?|said|tells?|telling|talks?|talking|smil\\w*|laugh\\w*|grin\\w*|' +
    'dialogue|conversation|creator|presenter|vlogger|selfie|portrait|face|facial|mouth|' +
    'woman|man|girl|boy|person|people|character|subject)\\b',
    'i'
);

function mentionsTeeth(text) {
    return H3_TEETH_MENTION_RE.test(String(text || ''));
}

function shouldIncludeTeeth(text) {
    return H3_TEETH_SUBJECT_RE.test(String(text || ''));
}

// Insert the clause exactly once at the end of the description body. Idempotent
// and a no-op when there is no description section or teeth are already
// described. Teeth never land in overall_soundscape.
function ensureTeethRealism(prompt) {
    const text = String(prompt || '');
    if (!text.trim() || mentionsTeeth(text)) return text;
    const header = /(?:detailed_description|integrated_multimodal_description)\s*:/i.exec(text);
    if (!header) {
        // A bare prompt with no named sections: append only when no trailing
        // sound sections exist, so teeth can never land in overall_soundscape.
        if (/overall_soundscape\s*:|non_diegetic_music\s*:/i.test(text)) return text;
        return text.replace(/\s+$/, '') + ' ' + NATURAL_TEETH_INSTRUCTION;
    }
    const bodyStart = header.index + header[0].length;
    const rest = text.slice(bodyStart);
    const cut = rest.search(/\n\s*\n(?=[a-z_]+\s*:)/i);
    const bodyEnd = cut === -1 ? text.length : bodyStart + cut;
    const body = text.slice(bodyStart, bodyEnd).replace(/\s+$/, '');
    return text.slice(0, bodyStart) + body + ' ' + NATURAL_TEETH_INSTRUCTION + text.slice(bodyEnd);
}

// --- Deterministic Creator Studio prompt --------------------------------------
//
// Creator Studio is assembled without an LLM: the canonical dialogue is the
// authoritative speech and H3 owns all timing. The camera style is resolved by
// the caller (services/creator-studio.js owns the registry), keeping this
// module dependency-free.

const CREATOR_DEFAULT_POSE =
    'standing naturally with an even weight balance, a tall but relaxed spine, shoulders down and hands resting comfortably at the sides';

const FALLBACK_CAMERA_STYLE = Object.freeze({
    id: 'SELFIE_SMARTPHONE_FRONT_CAMERA',
    concept: 'A casual social-media creator video recorded by the creator herself using a smartphone\'s front-facing selfie camera.',
    camera: 'This is a casual smartphone selfie video recorded by the creator using the phone\'s front-facing camera. The creator looks directly into the front-facing phone lens while speaking.',
    handheld: 'The camera has subtle natural handheld micro-movement, with minor framing drift and no cinematic camera movement.',
    framing: 'Keep the creator naturally within selfie-camera framing at a comfortable selfie distance.',
    distance: 'The creator maintains a natural selfie distance from the phone throughout the recording.',
    grounded: 'The creator remains naturally grounded and comfortable while recording herself and does not suddenly approach, lunge, fly, float or rush toward the camera.',
    gesturesHandheld: 'The creator naturally gestures with the free hand while speaking.',
    gesturesSupported: 'With the phone supported rather than held, both hands are free for small, natural conversational gestures.',
    authenticity: 'The video should feel like authentic creator-generated social-media content rather than a commercial or cinematic production.'
});

function creatorStageName(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function creatorStageLabel(value) {
    return String(value || '').replace(/_/g, ' ').trim();
}

function uniqueStages(stages) {
    const out = [];
    (Array.isArray(stages) ? stages : []).forEach((stage) => {
        const name = creatorStageName(stage);
        if (name && !out.includes(name)) out.push(name);
    });
    return out;
}

function buildCreatorStudioPrompt(canonical, resolveCameraStyle) {
    const c = canonical && typeof canonical === 'object' ? canonical : {};
    const guide = c.guide && typeof c.guide === 'object' ? c.guide : {};
    const creator = c.creator && typeof c.creator === 'object' ? c.creator : {};
    const shot = c.shot && typeof c.shot === 'object' ? c.shot : {};
    const dialogue = c.dialogue && typeof c.dialogue === 'object' ? c.dialogue : {};
    const lines = Array.isArray(dialogue.lines) ? dialogue.lines : [];
    const performance = Array.isArray(c.performance) ? c.performance : [];
    const language = String(c.language || 'English').trim() || 'English';
    const name = String(creator.name || 'the creator').trim() || 'the creator';
    const cameraStyle = (typeof resolveCameraStyle === 'function'
        ? resolveCameraStyle(shot.cameraStyle)
        : null) || FALLBACK_CAMERA_STYLE;
    const camera = String(shot.cameraDirection || '').trim();
    const environment = String(shot.environment || 'a relaxed, uncluttered everyday creator setting').trim();
    const wardrobe = String(shot.wardrobe || 'natural, scene-appropriate clothing').trim();
    const onCameraAction = String(shot.action || '').trim();
    const pose = String(shot.pose || '').trim() || CREATOR_DEFAULT_POSE;
    const guideName = String(guide.name || 'Creator Studio').trim();
    const guideStages = Array.isArray(guide.stages) && guide.stages.length
        ? guide.stages
        : uniqueStages(guide.structure).map(creatorStageLabel);
    const scriptText = String(dialogue.text || lines.map((line) => line.speech).filter(Boolean).join(' ')).trim();
    // A supported phone (tripod/stand/mount/hands-free) frees both hands; a
    // handheld selfie means one hand holds the phone. Never force a specific
    // holding pose when the scene does not call for one.
    const phoneSupported = /\b(?:tripod|stand|mount|propped|hands[- ]?free|supported)\b/i
        .test([camera, environment, onCameraAction, pose].filter(Boolean).join(' '));
    const gestureRule = phoneSupported ? cameraStyle.gesturesSupported : cameraStyle.gesturesHandheld;

    const summary =
        'A personality-led social creator video in [Shot 1]: ' + name + ' is a creator recording herself with a ' +
        'smartphone front-facing selfie camera and speaks the complete script on screen in one continuous take. ' +
        'Every line is performed on camera with visible, natural lip synchronization; the dialogue is never ' +
        'narrated or turned into voice-over.';

    const firstFrameLine =
        'The video begins from the supplied initial frame, showing ' + name + ' in ' + environment + ', wearing ' +
        wardrobe + ', ' + pose + '. ' + name + ' remains visually consistent with the appearance, wardrobe, ' +
        'environment, framing and lighting established in that first frame; the recording animates that exact frame.';

    const cameraBlock = 'Creator Studio camera style: ' + cameraStyle.id + '. ' + cameraStyle.concept + ' ' +
        cameraStyle.camera + (camera ? ' Framing: ' + camera + (/[.!?]$/.test(camera) ? '' : '.') + ' ' : '') +
        cameraStyle.handheld + ' ' + cameraStyle.framing;

    const groundedBlock = cameraStyle.grounded + ' ' + gestureRule;

    const continuityRule = 'This is one continuous recording with no cuts, scene changes, camera-angle changes or ' +
        'wardrobe or location changes.';

    const dialogueBlock = 'Dialogue (the complete script ' + name + ' speaks — every word below is spoken on screen with ' +
        'visible, natural lip synchronization):\n' +
        name + ' (S1) says: <d>[' + language + '] ' + scriptText + '</d>';

    const performanceLines = (performance.length ? performance : lines).map((beat) => {
        const label = String(beat.label || creatorStageLabel(beat.stage) || 'beat').trim();
        const detail = [beat.expression, beat.gaze, beat.body].map((part) => String(part || '').trim()).filter(Boolean).join('; ');
        return '- ' + label + ': ' + (detail || 'continues the performance naturally') + '.';
    });
    const performanceBlock = 'Performance (natural expression and body-language progression for the ' + guideName + ' ' +
        'structure' + (guideStages.length ? ' — ' + guideStages.join(' → ') : '') + '; timing comes from the spoken dialogue, not from timestamps):\n' +
        performanceLines.join('\n') + '\n' +
        'All expression and body-language transitions happen naturally while the complete dialogue is spoken.';

    const timingRule = 'TIMING (H3): The creator must speak the complete dialogue from beginning to end. Do not skip, ' +
        'shorten, summarize, paraphrase, reorder or omit any dialogue. Use natural conversational pacing and pauses. ' +
        'Determine the timing of speech, pauses and performance naturally from the dialogue. Expression changes occur ' +
        'naturally at appropriate moments in the spoken performance rather than at predetermined timestamps.';

    const actionDirection = onCameraAction
        ? 'On-camera action (visual direction only; this is NOT dialogue and must never be spoken): ' + onCameraAction + '\n'
        : '';

    const detailed = firstFrameLine + ' ' + cameraBlock + ' ' + groundedBlock + ' ' +
        cameraStyle.distance + ' ' + continuityRule + ' ' + cameraStyle.authenticity + '\n' +
        actionDirection + '[Shot 1] ' + name + ' begins speaking directly to the camera.\n' + dialogueBlock +
        '\n\n' + performanceBlock + '\n\n' + NATURAL_TEETH_INSTRUCTION + '\n\n' + timingRule;

    const soundscape = 'Natural room tone and the creator\'s on-screen voice with exact, lip-synced delivery; ' +
        'ambient environmental sounds matching the scene.';

    return buildPromptDocument({
        alignment: firstFrameAlignmentLine(),
        summary,
        detailedDescription: detailed,
        soundscape,
        music: 'N/A'
    });
}

module.exports = {
    H3_SECTIONS,
    H3_FIRST_FRAME_ALIGNMENT,
    firstFrameAlignmentLine,
    H3_DIRECTOR_SYSTEM_PROMPT,
    H3_MULTISHOT_ADDENDUM,
    H3_MODIFIER_SYSTEM_PROMPT,
    buildPromptDocument,
    stripLegacyReferenceLanguage,
    NATURAL_TEETH_INSTRUCTION,
    mentionsTeeth,
    shouldIncludeTeeth,
    ensureTeethRealism,
    creatorStageName,
    creatorStageLabel,
    uniqueStages,
    CREATOR_DEFAULT_POSE,
    buildCreatorStudioPrompt
};
