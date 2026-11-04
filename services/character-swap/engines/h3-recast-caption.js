/* ============================================
   JARVIS — H3 Recast caption composer
   The official "People (1-3)" caption templates
   from Bambushu/h3-recast (MIT), filled in
   deterministically from the structured
   Character Swap people.

   The templates are the BFS character-swap
   LoRA's trained caption. Do not paraphrase
   them; the adapter is trained on this shape.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const TEMPLATES = {
    1: 'body_swap:  subject_definitions: <Subject 1> is {d1} shown in <Picture 1>, whose identity, face, head, hair or fur, skin, body shape, proportions and clothing define the character in the target video. The guide video provides the scene and the performance: its background, environment, lighting, camera, framing, body pose, hand and arm movement, head rotation, gaze direction, lip movement and facial expression, frame by frame; only {t1} is replaced: its face, hair, body and clothing become <Subject 1>.  summary: [video generation + reference] Replace {t1} with <Subject 1>, keeping the scene, camera and the complete motion and performance of the guide video.  detailed_description: [Shot 1] <Subject 1> takes the exact place of {t1} and moves with the same timing, body pose, gestures, head motion, gaze, speech and facial expressions, while keeping the complete look from <Picture 1>: head, face, skin, hair, body shape and clothing stay stable in every frame, with no trace of the original subjects\' faces, hair or clothing. The background, lighting, colors and camera of the guide video are preserved. Prevent identity drift, clothing changes, texture crawling and flicker. The result is a real, photographic video.',
    2: 'body_swap:  subject_definitions: <Subject 1> is {d1} shown on the left of <Picture 1>, and <Subject 2> is {d2} shown on the right of <Picture 1>; their identity, face, head, hair, skin, body shape, proportions and clothing define the two characters in the target video. The guide video provides the scene and the performance: its background, environment, lighting, camera, framing, body pose, hand and arm movement, head rotation, gaze direction, lip movement and facial expression, frame by frame; only the two people are replaced: {t1} on the left becomes <Subject 1> and {t2} on the right becomes <Subject 2>, their face, hair, body and clothing.  summary: [video generation + reference] Replace {t1} with <Subject 1> and {t2} with <Subject 2> in the guide video, keeping the scene, camera and the complete motion and performance of the guide video.  detailed_description: [Shot 1] <Subject 1> takes the exact place of {t1} and <Subject 2> takes the exact place of {t2}; all both move with the same timing, body pose, gestures, head motion, gaze, speech and facial expressions as the person they replace, while keeping the complete look from <Picture 1>: head, face, skin, hair, body shape and clothing stay stable in every frame, with no trace of the original subjects\' faces, hair or clothing. The background, lighting, colors and camera of the guide video are preserved. Prevent identity drift, clothing changes, texture crawling and flicker. The result is a real, photographic video.',
    3: 'body_swap:  subject_definitions: <Subject 1> is {d1} shown on the left of <Picture 1>, <Subject 2> is {d2} shown in the middle of <Picture 1>, and <Subject 3> is {d3} shown on the right of <Picture 1>; their identity, face, head, hair, skin, body shape, proportions and clothing define the three characters in the target video. The guide video provides the scene and the performance: its background, environment, lighting, camera, framing, body pose, hand and arm movement, head rotation, gaze direction, lip movement and facial expression, frame by frame; only the three people are replaced: {t1} on the left becomes <Subject 1>, {t2} in the middle becomes <Subject 2> and {t3} on the right becomes <Subject 3>, their face, hair, body and clothing.  summary: [video generation + reference] Replace {t1} with <Subject 1>, {t2} with <Subject 2> and {t3} with <Subject 3> in the guide video, keeping the scene, camera and the complete motion and performance of the guide video.  detailed_description: [Shot 1] <Subject 1> takes the exact place of {t1}, <Subject 2> takes the exact place of {t2} and <Subject 3> takes the exact place of {t3}; all three move with the same timing, body pose, gestures, head motion, gaze, speech and facial expressions as the person they replace, while keeping the complete look from <Picture 1>: head, face, skin, hair, body shape and clothing stay stable in every frame, with no trace of the original subjects\' faces, hair or clothing. The background, lighting, colors and camera of the guide video are preserved. Prevent identity drift, clothing changes, texture crawling and flicker. The result is a real, photographic video.'
};

const PERSON_LINE_RE = /^\s*(.+?)\s+(?:becomes|turns into|->|→|=)\s+(.+?)[\s.]*$/i;
const ARTICLE_RE = /^(the|a|an|this|that|these|those)\b/i;

function cleanPhrase(value, limit) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^["'`]+|["'`]+$/g, '')
        .slice(0, limit || 600);
}

function withArticle(value, fallback) {
    const text = cleanPhrase(value);
    if (!text) return cleanPhrase(fallback);
    if (ARTICLE_RE.test(text)) return text;
    return (text.startsWith('a') || text.startsWith('e') || text.startsWith('i') ||
        text.startsWith('o') || text.startsWith('u') ? 'an ' : 'a ') + text;
}

// The official line format: "<who they are now> becomes <new look>".
function parsePersonLine(line) {
    // Parse the whole line first: truncating the raw line before the split cut
    // long target descriptions mid-sentence, dropping the identity/clothing.
    const text = String(line === undefined || line === null ? '' : line)
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^["'`]+|["'`]+$/g, '');
    if (!text) return null;
    const match = PERSON_LINE_RE.exec(text);
    if (!match) return null;
    return {
        source: cleanPhrase(match[1]),
        target: cleanPhrase(match[2])
    };
}

// rows: [{ source, target, replaced }] in left-to-right order, 1-3 entries.
// A person who is not being replaced keeps their current description as the
// target, which the trained caption reads as "stays the same".
function buildCaption(rows) {
    const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
    if (!list.length) {
        const error = new Error('H3 Recast needs at least one person line.');
        error.code = 'h3_recast_caption_empty';
        throw error;
    }
    if (list.length > 3) {
        const error = new Error('H3 Recast supports at most three people in the shot.');
        error.code = 'h3_recast_people_limit';
        throw error;
    }
    let caption = TEMPLATES[list.length];
    list.forEach((row, index) => {
        const n = index + 1;
        const target = withArticle(row.target, row.source);
        const source = withArticle(row.source, row.target);
        if (!target || !source) {
            const error = new Error('H3 Recast person ' + n + ' has no usable description.');
            error.code = 'h3_recast_caption_empty';
            throw error;
        }
        caption = caption.split('{d' + n + '}').join(target);
        caption = caption.split('{t' + n + '}').join(source);
    });
    if (/\{[td]\d\}/.test(caption)) {
        const error = new Error('H3 Recast caption could not be filled for every person.');
        error.code = 'h3_recast_caption_incomplete';
        throw error;
    }
    return {
        caption,
        count: list.length,
        rows: list.map((row, index) => ({
            person: index + 1,
            source: withArticle(row.source, row.target),
            target: withArticle(row.target, row.source),
            replaced: row.replaced !== false
        }))
    };
}

module.exports = {
    TEMPLATES,
    PERSON_LINE_RE,
    parsePersonLine,
    buildCaption,
    withArticle,
    cleanPhrase
};
