/* ============================================
   JARVIS — H3 Recast scene reference
   H3 Recast conditions on ONE edited frame of
   the clip that already shows every intended
   replacement. This module selects that frame,
   edits it with the configured Qwen Image 2.1
   editor against the character references, or
   accepts a user-supplied frame, and persists
   it inside the Character Swap project.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');

const imageGenerator = require('../image-generator');
const generatedHistory = require('../generated-history');
const promptBuilder = require('./prompt');
const h3Caption = require('./engines/h3-recast-caption');
const state = require('./state');
const media = require('./media');

const MAX_PEOPLE = 3;

function projectDir(projectId) {
    return state.projectDir(projectId);
}

function sceneDir(projectId) {
    const dir = path.join(projectDir(projectId), 'scene');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function rel(projectId, file) {
    return state.relative(projectId, file);
}

function abs(projectId, file) {
    return state.absolute(projectId, file);
}

// Everyone physically present in the shot, in the official left-to-right
// order. A detected track is a person even before it is bound to a card; a
// refs-only (or line-only) person without a track is appended in card order.
// A parked record (deselected but still holding its old track id) is not added
// again, because its track is already represented.
function shotSlots(project) {
    const people = (project && project.people) || [];
    const tracks = (project && project.selection && project.selection.tracks) || [];
    const width = Number(project && project.part && project.part.width) ||
        Number(project && project.selection && project.selection.width) || 0;
    if (tracks.length) {
        const used = new Set();
        const trackIds = new Set(tracks.map((track) => track.id));
        const slots = tracks.map((track) => {
            const person = people.find((item) => item.selectionId === track.id) || null;
            if (person) used.add(person.id);
            const bbox = track.bbox || {};
            const x = width > 0
                ? ((Number(bbox.x) || 0) + (Number(bbox.width) || 0) / 2) / width
                : (person ? Number(person.x) || 0.5 : 0.5);
            return { person, track, x };
        });
        for (const person of people) {
            if (used.has(person.id)) continue;
            if (!(person.refs || []).length && !person.h3Line) continue;
            if (person.lastSelectionId && trackIds.has(person.lastSelectionId)) continue;
            slots.push({ person, track: null, x: Number(person.x) || 0.5 });
        }
        slots.sort((a, b) => a.x - b.x);
        return slots.slice(0, MAX_PEOPLE);
    }
    return people
        .filter((person) => person.selectionId || (person.refs || []).length || person.h3Line)
        .slice(0, MAX_PEOPLE)
        .map((person) => ({ person, track: null, x: Number(person.x) || 0.5 }));
}

// The people being replaced, in shot order. A replacement target must have a
// character image; when the clip has been detected it must also be one of the
// currently selected tracks (a parked record is no longer a target).
function selectedPeople(project) {
    const tracks = (project && project.selection && project.selection.tracks) || [];
    const trackIds = new Set(tracks.map((track) => track.id));
    return shotSlots(project)
        .map((slot) => slot.person)
        .filter((person) => person && (person.refs || []).length &&
            (!tracks.length || (person.selectionId && trackIds.has(person.selectionId))))
        .slice(0, MAX_PEOPLE);
}

function placeFor(count, index) {
    if (count === 2) return ['on the left', 'on the right'][index] || 'in the shot';
    if (count === 3) return ['on the left', 'in the middle', 'on the right'][index] || 'in the shot';
    return 'in the shot';
}

// Assign each person their real position among everyone in the shot, so a
// single target in a three-person clip is described as "in the middle" rather
// than as the only target ("on the left").
function withShotPlaces(project, people) {
    const slots = shotSlots(project);
    const placeByPerson = new Map();
    slots.forEach((slot, index) => {
        if (slot.person) placeByPerson.set(slot.person.id, placeFor(slots.length, index));
    });
    return (people || []).map((person) => Object.assign({}, person, {
        place: placeByPerson.get(person.id) || person.place
    }));
}

function sceneFrame(project) {
    const tracks = (project && project.selection && project.selection.tracks) || [];
    // Include every selected track, even one without a character image yet, so
    // the chosen frame shows all the people in the shot.
    const targets = (project && project.people || []).filter((person) =>
        person.selectionId || (!tracks.length && (person.refs || []).length));
    const selected = tracks.filter((track) => targets.some((person) => person.selectionId === track.id));
    const usable = selected.length ? selected : tracks;
    if (usable.length) {
        const first = Math.max(...usable.map((track) => Math.max(0, Number(track.firstFrame) || 0)));
        const last = Math.min(...usable.map((track) => {
            const start = Math.max(0, Number(track.firstFrame) || 0);
            return Math.max(start, Number(track.lastFrame) || start);
        }));
        if (last >= first) {
            const frames = Math.max(1, Number(project.part && project.part.frames) || 1);
            return Math.max(0, Math.min(frames - 1, first));
        }
        const best = usable.find((track) => Number.isFinite(Number(track.thumbFrame)));
        if (best) return Math.max(0, Number(best.thumbFrame) || 0);
    }
    const frames = Math.max(1, Number(project.part && project.part.frames) || 1);
    return Math.max(0, Math.min(frames - 1, Math.round(frames * 0.2)));
}

function sourcePhrase(person, index, count) {
    const parsed = person && person.h3Line ? h3Caption.parsePersonLine(person.h3Line) : null;
    if (parsed && parsed.source) return parsed.source.replace(/\.$/, '');
    if (person && person.subjectSummary) return String(person.subjectSummary).replace(/\.$/, '');
    const place = (person && person.place) ? person.place : placeFor(count || 1, index);
    return 'the person ' + place;
}

// A concise, position-based label targets the right person in the edit. A long
// action description ("... stands facing right and gestures...") is not reliably
// matched by the editor and made it replace the wrong person or fill a blurred
// area instead. Keep the source phrase for the caption, use a short cue here.
function sceneLabel(person, index, count) {
    const place = (person && person.place) ? person.place : placeFor(count || 1, index);
    const parsed = person && person.h3Line ? h3Caption.parsePersonLine(person.h3Line) : null;
    let cue = parsed && parsed.source
        ? parsed.source
        : (person && person.subjectSummary ? person.subjectSummary : '');
    cue = String(cue).replace(/\s+/g, ' ').trim();
    cue = cue.split(/,?\s+(?:stands?|sits?|is\s+sitting|gestures?|looking|facing|holds?|while|and\s+holds?)\b/i)[0];
    if (cue.length > 110) cue = cue.slice(0, 110).replace(/[\s,;.]+$/, '');
    return 'the person ' + place + (cue ? ' (' + cue + ')' : '');
}

// Listing the structured outfit explicitly makes the editor replace the whole
// character. A generic "copy the clothing shown in image N" often keeps the
// source person's outfit and only transfers the face/hair.
function outfitClause(person) {
    const description = person && person.description && typeof person.description === 'object'
        ? person.description
        : null;
    if (!description) return '';
    const items = [description.clothing, description.footwear, description.accessories]
        .map((value) => String(value || '').trim())
        .filter(Boolean);
    return items.length ? ' Replace the clothing and accessories with exactly: ' + items.join(', ') + '.' : '';
}

// The editor tends to invent a new pose unless the source pose is spelled out.
// The guide owns the motion, so the scene reference must keep the clip's pose.
// A tall bounding box means standing; an explicit seated/crouch word wins.
function stanceFor(project, person) {
    const text = String((person && (person.subjectSummary || person.h3Line)) || '').toLowerCase();
    if (/\b(sits|sitting|seated|crouch|kneel|lying|reclin)\b/.test(text)) return '';
    const track = ((project && project.selection && project.selection.tracks) || [])
        .find((item) => item.id === (person && person.selectionId));
    const bbox = track && track.bbox;
    if (bbox && Number(bbox.height) > Number(bbox.width) * 1.6) return 'standing';
    return '';
}

function poseClause(project, person) {
    const text = String((person && (person.subjectSummary || person.h3Line)) || '').replace(/\s+/g, ' ').trim();
    const match = text.match(/,?\s+((?:stands?|sits?|is\s+sitting|gestures?|looking|facing|holds?|while|and\s+holds?)\b.*)$/i);
    if (!match) return '';
    const pose = match[1].replace(/^and\s+/i, '');
    const hasStanceVerb = /^(stands?|sits?|is\s+sitting|kneel|crouch)/i.test(pose);
    const stance = hasStanceVerb ? '' : stanceFor(project, person);
    return ' Keep the exact pose from image 1: the person ' +
        (stance ? 'is ' + stance + ' and ' : '') + pose + '.';
}

// The author's rule is that the scene reference is one frame of the clip with
// the same framing; only the people are edited. The reference image's pose used
// to leak into the edit, producing a re-posed target H3 could not map onto the
// guide frame. Keep the look transfer, but pin the source pose/position/framing.
function buildInstruction(project, rows) {
    const replacements = rows.map((person, index) => {
        const label = sceneLabel(person, index, rows.length);
        const reference = index + 2;
        return 'Replace ' + label + ' with the person in image ' + reference +
            '. Copy the ENTIRE look from image ' + reference + ': face, facial structure, hair, skin tone, body proportions, and exactly the clothing, shoes and accessories shown in image ' + reference + outfitClause(person) +
            '. Keep ' + label + '\'s exact body pose, head angle, gaze, hand positions, seated or standing position, size, scale, screen position and framing from image 1 unchanged' + poseClause(project, person) +
            '. Do not copy the reference image\'s pose, camera angle, framing, background or lighting.';
    });
    const lines = [
        'Use image 1 as the exact source frame. It is one frame of a real video.',
        ...replacements,
        'Keep the background, environment, camera, framing, lighting, shadows and every person who is not being replaced exactly as they are.',
        'Do not copy the reference image\'s background, pose, camera angle, framing or lighting.',
        'Output exactly one photographic frame with the same composition as image 1. Never create a collage, grid, contact sheet, multiple panels or multiple angles.'
    ];
    return lines.join(' ');
}

function current(projectId, project) {
    const record = project && project.engineSettings && project.engineSettings.h3
        ? project.engineSettings.h3.sceneReference
        : null;
    if (!record || !record.file) return null;
    const file = abs(projectId, record.file);
    if (!file || !fs.existsSync(file)) return null;
    return {
        absPath: file,
        file: record.file,
        filename: path.basename(file),
        record
    };
}

function cleanSceneDir(projectId, keep) {
    const dir = sceneDir(projectId);
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (keep && path.resolve(full) === path.resolve(keep)) continue;
        if (/^reference\./i.test(name) || /^source-frame\./i.test(name)) {
            try { fs.unlinkSync(full); } catch { /* next retry */ }
        }
    }
}

function saveReference(projectId, sourcePath, meta) {
    const ext = path.extname(sourcePath).toLowerCase() || '.png';
    const target = path.join(sceneDir(projectId), 'reference' + ext);
    cleanSceneDir(projectId, target);
    fs.copyFileSync(sourcePath, target);
    const info = mediaImageInfo(target);
    let saved = null;
    state.update(projectId, (currentProject) => {
        currentProject.engineSettings.h3.sceneReference = Object.assign({
            file: rel(projectId, target),
            source: 'upload',
            frame: null,
            prompt: '',
            width: info.width,
            height: info.height,
            createdAt: new Date().toISOString()
        }, meta || {}, { file: rel(projectId, target) });
        saved = currentProject.engineSettings.h3.sceneReference;
    });
    return saved;
}

function mediaImageInfo(file) {
    try {
        const { readStillImageDimensions } = require('../video-generator');
        const dims = typeof readStillImageDimensions === 'function' ? readStillImageDimensions(file) : null;
        return dims || { width: 0, height: 0 };
    } catch {
        return { width: 0, height: 0 };
    }
}

// The reference-guided editor can pick the wrong person and re-poses the one it
// edits. Mask the SELECTED target person(s) and inpaint from the source image's
// own latent, so only the target changes: the clip's pose, background and every
// other person stay exactly as they are (the author's "one frame of the clip"
// rule). The mask is generous enough to include the new hair/outfit.
function targetMaskBoxes(project, rows) {
    const editedTracks = new Set((rows || []).map((person) => person.selectionId).filter(Boolean));
    if (!editedTracks.size) return [];
    const tracks = (project.selection && project.selection.tracks) || [];
    return tracks
        .filter((track) => editedTracks.has(track.id))
        .map((track) => track.bbox)
        .filter((bbox) => bbox && Number(bbox.width) > 0 && Number(bbox.height) > 0);
}

async function buildTargetMask(boxes, W, H, dir) {
    const mask = path.join(dir, 'target-mask.png');
    const draw = boxes.map((bbox) => {
        const margin = Math.max(48, Math.round(Math.min(Number(bbox.width), Number(bbox.height)) * 0.35));
        const x = Math.max(0, Math.round(Number(bbox.x) - margin));
        const y = Math.max(0, Math.round(Number(bbox.y) - margin));
        const w = Math.max(1, Math.min(W - x, Math.round(Number(bbox.width) + margin * 2)));
        const h = Math.max(1, Math.min(H - y, Math.round(Number(bbox.height) + margin * 2)));
        return 'drawbox=x=' + x + ':y=' + y + ':w=' + w + ':h=' + h + ':color=white:t=fill';
    }).join(',');
    await media.run([
        '-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=' + W + 'x' + H + ':d=1',
        '-vf', draw + ',gblur=sigma=18,format=gray', '-frames:v', '1', mask
    ], { code: 'character_swap_scene_mask_failed' });
    return mask;
}

async function build(projectId, options = {}) {
    const project = state.requireProject(projectId);
    if (!project.part || !project.part.file) throw new Error('The clip is still being prepared.');
    const targets = selectedPeople(project);
    const hasFrame = options.frame !== null && options.frame !== undefined && options.frame !== '' &&
        Number.isInteger(Number(options.frame));
    const frame = hasFrame
        ? Math.max(0, Math.min((Number(project.part.frames) || 1) - 1, Number(options.frame)))
        : sceneFrame(project);
    const sourceFrame = path.join(sceneDir(projectId), 'source-frame.png');
    await media.extractFrame(abs(projectId, project.part.file), frame, sourceFrame);

    // Only people with a usable character image can be edited. Anyone selected
    // without one stays exactly as they are in the clip, so the scene reference
    // can always be built from the clip itself.
    const rows = [];
    const refs = [];
    for (const person of withShotPlaces(project, targets)) {
        const reference = promptBuilder.selectIdentityReference(person) || (person.refs || [])[0];
        const referencePath = reference ? abs(projectId, reference.file) : '';
        if (!referencePath || !fs.existsSync(referencePath)) continue;
        rows.push(person);
        refs.push(referencePath);
    }

    if (!rows.length) {
        // No character images yet: the scene reference is the clip frame
        // itself, unchanged. The user can build from the clip and add images
        // later without being blocked.
        const clipFrame = path.join(sceneDir(projectId), 'clip-frame.png');
        fs.copyFileSync(sourceFrame, clipFrame);
        const saved = saveReference(projectId, clipFrame, {
            source: 'clip',
            frame,
            prompt: '',
            createdAt: new Date().toISOString()
        });
        try { fs.unlinkSync(clipFrame); } catch { /* best-effort */ }
        try { fs.unlinkSync(sourceFrame); } catch { /* best-effort */ }
        return saved;
    }

    let instruction = buildInstruction(project, rows);
    const frameWidth = Number(project.part.width) || 0;
    const frameHeight = Number(project.part.height) || 0;
    const boxes = targetMaskBoxes(project, rows);
    let maskPath = null;
    if (boxes.length && frameWidth > 0 && frameHeight > 0) {
        try {
            maskPath = await buildTargetMask(boxes, frameWidth, frameHeight, sceneDir(projectId));
        } catch {
            // ffmpeg unavailable: fall back to the full-frame edit.
            maskPath = null;
        }
    }
    if (maskPath) {
        instruction += ' Keep everything outside the masked area exactly as it is in image 1.';
    }
    const result = await imageGenerator.editImage(sourceFrame, instruction, {
        references: refs,
        maskPath: maskPath || undefined,
        editEngine: 'qwen',
        hidden: true,
        conversationId: project.conversationId || null,
        label: 'H3 Recast scene reference',
        kind: 'image_edit'
    });
    const generatedDir = process.env.GENERATED_DIR || path.join(__dirname, '..', '..', 'data', 'generated');
    const sourcePath = path.join(generatedDir, result.filename);
    if (!sourcePath || !fs.existsSync(sourcePath)) {
        const error = new Error('The scene reference was generated but its file could not be found.');
        error.code = 'h3_recast_scene_reference_missing';
        throw error;
    }
    const saved = saveReference(projectId, sourcePath, {
        source: 'generated',
        frame,
        prompt: instruction,
        width: result.width,
        height: result.height,
        createdAt: new Date().toISOString()
    });
    try { generatedHistory.removeByFilename(result.filename); } catch { /* best-effort */ }
    try { fs.unlinkSync(sourcePath); } catch { /* best-effort */ }
    try { fs.unlinkSync(sourceFrame); } catch { /* best-effort */ }
    try { fs.unlinkSync(path.join(sceneDir(projectId), 'target-mask.png')); } catch { /* best-effort */ }
    return saved;
}

function upload(projectId, sourcePath, meta) {
    const absPath = String(sourcePath || '');
    if (!absPath || !fs.existsSync(absPath) || !fs.statSync(absPath).size) {
        const error = new Error('The scene reference image could not be found.');
        error.status = 400;
        throw error;
    }
    if (!/\.(?:png|jpe?g|webp)$/i.test(absPath)) {
        const error = new Error('The scene reference must be a PNG, JPEG or WebP image.');
        error.status = 400;
        throw error;
    }
    return saveReference(projectId, absPath, Object.assign({ source: 'upload' }, meta || {}));
}

function clear(projectId) {
    const project = state.requireProject(projectId);
    if (project.engineSettings && project.engineSettings.h3 && project.engineSettings.h3.sceneReference) {
        const file = abs(projectId, project.engineSettings.h3.sceneReference.file);
        if (file) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
    }
    state.update(projectId, (currentProject) => {
        currentProject.engineSettings.h3.sceneReference = null;
    });
}

function urlFor(projectId, project) {
    const reference = current(projectId, project);
    return reference ? '/api/character-swap/projects/' + encodeURIComponent(projectId) + '/scene' : null;
}

module.exports = {
    shotSlots,
    withShotPlaces,
    selectedPeople,
    sceneFrame,
    sourcePhrase,
    buildInstruction,
    current,
    build,
    upload,
    clear,
    urlFor
};
