/* ============================================
   JARVIS — Character Swap service facade
   Project lifecycle, SAM tracking, mask
   refinement, references and H3 handoff.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const comfyui = require('../comfyui');
const vramManager = require('../vram-manager');
const generatedHistory = require('../generated-history');
const characterState = require('./state');
const media = require('./media');
const tracking = require('./tracking');
const selection = require('./selection');
const segmentation = require('./segmentation');
const references = require('./references');
const promptBuilder = require('./prompt');
const sheets = require('./sheets');
const engines = require('./engines');

const busy = new Map();
const MAX_SECONDS = characterState.H3_MAX_SECONDS;
const WAN_MAX_SECONDS = characterState.WAN_MAX_SECONDS;

function projectDir(projectId) {
    return characterState.projectDir(projectId);
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function rel(projectId, file) {
    return characterState.relative(projectId, file);
}

function abs(projectId, file) {
    return characterState.absolute(projectId, file);
}

function clamp(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function personById(project, personId) {
    return characterState.getPerson(project, personId);
}

function removeTakeWorkspace(project, take) {
    const id = take && (take.takeId || take.id);
    if (!id) return;
    try {
        fs.rmSync(path.join(projectDir(project.id), 'takes', String(id)), { recursive: true, force: true });
    } catch {
        // Windows may still hold a file; the project cleanup retries later.
    }
}

function dropTakes(project) {
    for (const take of project.takes || []) {
        if (take.filename) {
            try { generatedHistory.removeByFilename(take.filename); } catch { /* ignore */ }
        }
        removeTakeWorkspace(project, take);
    }
    project.takes = [];
    project.bestTake = null;
}

function clearWanCache(project) {
    project.wan = { preprocess: null, cacheKey: null };
    for (const folder of ['wan', 'wan-animate2']) {
        try {
            fs.rmSync(path.join(projectDir(project.id), folder), { recursive: true, force: true });
        } catch {
            // The next prepare recreates it.
        }
    }
}

function clearSelectionState(project) {
    project.selection = { method: null, version: null, tracks: [], corrections: [], keypointsFile: null, createdAt: null };
    project.segmentation = { method: null, people: {}, createdAt: null };
    (project.people || []).forEach((person) => {
        person.selectionId = person.selectionId || null;
    });
    for (const folder of ['selection', 'segmentation']) {
        try { fs.rmSync(path.join(projectDir(project.id), folder), { recursive: true, force: true }); } catch { /* next retry */ }
    }
    clearWanCache(project);
}

function clearSegmentationExports(project) {
    if (!project.segmentation) return;
    project.segmentation.hash = null;
    for (const meta of Object.values(project.segmentation.people || {})) {
        meta.hash = null;
    }
}

function clearTracked(project) {
    for (const person of project.people) {
        person.masks = null;
        person.status = person.anchors.length ? 'anchored' : 'new';
        const dir = path.join(projectDir(project.id), 'masks', person.id);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* next retry */ }
    }
    project.maskExport = null;
    project.maskExports = { union: null, people: {}, settings: null, createdAt: null };
    clearWanCache(project);
    dropTakes(project);
}

function clearMasksOnly(project) {
    project.maskExport = null;
    project.maskExports = { union: null, people: {}, settings: null, createdAt: null };
    clearWanCache(project);
    dropTakes(project);
}

async function createProject(input = {}) {
    if (!input.sourcePath || !fs.existsSync(input.sourcePath)) {
        const err = new Error('Upload a video first.');
        err.status = 400;
        throw err;
    }
    const project = characterState.createProject(input);
    try {
        const dir = ensureDir(projectDir(project.id));
        const ext = path.extname(input.sourcePath).toLowerCase() || '.mp4';
        const stored = path.join(dir, 'inputs', 'source' + ext);
        fs.copyFileSync(input.sourcePath, stored);
        const probed = await media.probeVideo(stored);
        if (!probed.duration) throw new Error('That video has no readable duration.');
        const duration = Math.min(probed.duration, 120);
        const selection = Math.min(duration, WAN_MAX_SECONDS);
        const footagePath = path.join(dir, 'footage.mp4');
        const footage = await media.conform(stored, footagePath, {
            start: 0,
            duration,
            maxSide: characterState.MAX_SIDE
        });
        const partPath = path.join(dir, 'part.mp4');
        const part = await media.conform(footagePath, partPath, {
            start: 0,
            duration: Math.min(footage.duration, selection)
        });
        characterState.update(project.id, (current) => {
            current.source.filename = input.filename || path.basename(stored);
            current.source.stored = rel(project.id, stored);
            current.source.duration = duration;
            current.source.fps = probed.fps;
            current.source.width = probed.width;
            current.source.height = probed.height;
            current.footage = {
                file: rel(project.id, footagePath),
                width: footage.width,
                height: footage.height,
                fps: media.FPS,
                frames: Math.round(footage.duration * media.FPS)
            };
            current.part = {
                file: rel(project.id, partPath),
                width: part.width,
                height: part.height,
                fps: media.FPS,
                frames: Math.max(1, Math.round(part.duration * media.FPS))
            };
            current.trim = { start: 0, end: Math.min(selection, part.duration) };
            current.status = 'ready';
            current.activity = null;
        });
        return characterState.get(project.id);
    } catch (err) {
        characterState.remove(project.id);
        throw err;
    }
}

async function setTrim(projectId, start, end) {
    const project = characterState.requireProject(projectId);
    const footagePath = abs(projectId, project.footage && project.footage.file);
    if (!footagePath || !fs.existsSync(footagePath)) throw new Error('The prepared footage is missing.');
    const available = Math.min(project.source.duration || project.footage.frames / media.FPS, WAN_MAX_SECONDS);
    const from = clamp(start, 0, Math.max(0, available - 1 / media.FPS), 0);
    const to = clamp(end, from + 1 / media.FPS, available, available);
    const partPath = path.join(projectDir(projectId), 'part.mp4');
    const part = await media.conform(footagePath, partPath, { start: from, duration: to - from });
    return characterState.update(projectId, (current) => {
        current.part = {
            file: rel(projectId, partPath),
            width: part.width,
            height: part.height,
            fps: media.FPS,
            frames: Math.max(1, Math.round(part.duration * media.FPS))
        };
        current.trim = { start: from, end: from + part.duration };
        current.people.forEach((person) => { person.anchors = []; person.selectionId = null; });
        current.sceneDescription = null;
        clearTracked(current);
        clearSelectionState(current);
        current.status = 'ready';
        current.error = null;
        current.activity = null;
    });
}

async function addAnchor(projectId, personId, anchor) {
    const project = characterState.requireProject(projectId);
    const person = personById(project, personId);
    const frames = project.part && project.part.frames;
    if (!frames) throw new Error('The clip is still being prepared.');
    const frame = Math.round(Number(anchor.frame));
    if (!Number.isFinite(frame) || frame < 0 || frame >= frames) throw new Error('That frame is outside the trimmed clip.');
    const positive = (Array.isArray(anchor.positive) ? anchor.positive : []).slice(0, 24)
        .map((point) => ({ x: Math.round(Number(point.x)), y: Math.round(Number(point.y)) }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    const negative = (Array.isArray(anchor.negative) ? anchor.negative : []).slice(0, 24)
        .map((point) => ({ x: Math.round(Number(point.x)), y: Math.round(Number(point.y)) }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (!positive.length) throw new Error('Tap on the person first.');
    const existing = person.anchors.find((item) => item.frame === frame);
    const mergedPositive = positive.concat(existing ? existing.positive : []);
    const mergedNegative = negative.concat(existing ? existing.negative : []);
    const partPath = abs(projectId, project.part.file);
    const selectionDir = ensureDir(path.join(projectDir(projectId), 'selection'));
    const result = await tracking.detectAnchor(projectId, partPath, {
        frame,
        positive: mergedPositive,
        negative: mergedNegative
    }, selectionDir);
    const anchorPath = path.join(selectionDir, 'anchor-' + frame + '-' + Date.now() + '.png');
    fs.copyFileSync(result.maskPath, anchorPath);
    const storedPositive = result.positive && result.positive.length ? result.positive : mergedPositive;
    return characterState.update(projectId, (current) => {
        const target = personById(current, personId);
        const kept = target.anchors.filter((item) => item.frame !== frame);
        target.anchors = kept.concat([{
            frame,
            positive: storedPositive,
            negative: mergedNegative,
            maskFile: rel(projectId, anchorPath)
        }]).sort((a, b) => a.frame - b.frame);
        target.status = 'anchored';
        clearTracked(current);
        current.status = 'ready';
        current.error = null;
    });
}

function removeAnchor(projectId, personId, frame) {
    return characterState.update(projectId, (current) => {
        const target = personById(current, personId);
        target.anchors = frame === undefined || frame === null || frame === ''
            ? []
            : target.anchors.filter((anchor) => anchor.frame !== Number(frame));
        target.status = target.anchors.length ? 'anchored' : 'new';
        clearTracked(current);
    });
}

async function runTrack(projectId) {
    if (busy.get(projectId)) throw new Error('This project is already working.');
    busy.set(projectId, 'track');
    const uploaded = [];
    try {
        const project = characterState.requireProject(projectId);
        const partPath = abs(projectId, project.part.file);
        if (!partPath) throw new Error('The clip is not ready.');
        characterState.update(projectId, (current) => {
            current.status = 'tracking';
            current.activity = 'Tracking the selected people';
            current.error = null;
        });
        // Older anchors may hold only a head tap. Add the body points from the
        // saved anchor mask before tracking so an existing project also gets a
        // full-body mask without making the user tap everything again.
        let anchorsExpanded = false;
        for (const person of project.people) {
            for (const anchor of person.anchors) {
                const anchorMask = abs(projectId, anchor.maskFile);
                if (!anchorMask || !fs.existsSync(anchorMask)) continue;
                try {
                    const mask = await media.readMask(anchorMask);
                    const extra = tracking.bodyPoints(mask, anchor.positive || []);
                    if (!extra.length) continue;
                    anchor.positive = (anchor.positive || []).concat(extra);
                    anchorsExpanded = true;
                } catch {
                    // Keep the original tap if the cached anchor mask is unreadable.
                }
            }
        }
        if (anchorsExpanded) {
            characterState.update(projectId, (current) => {
                current.people.forEach((person, index) => {
                    const source = project.people[index];
                    if (source) person.anchors = source.anchors;
                });
            });
        }
        await tracking.assertSamReady();
        const buffer = fs.readFileSync(partPath);
        const sourceUpload = await comfyui.uploadFile(buffer, tracking.temporaryName('jarvis_cs_source') + '.mp4', { mime: 'video/mp4' });
        uploaded.push(sourceUpload.name);
        const needsReverse = project.people.some((person) => person.anchors.some((anchor) => anchor.frame > 0));
        let reversedName = null;
        if (needsReverse) {
            const reversedPath = path.join(projectDir(projectId), 'reversed.mp4');
            await media.reverse(partPath, reversedPath);
            const reversedUpload = await comfyui.uploadFile(fs.readFileSync(reversedPath), tracking.temporaryName('jarvis_cs_reversed') + '.mp4', { mime: 'video/mp4' });
            reversedName = reversedUpload.name;
            uploaded.push(reversedName);
        }
        for (const person of project.people) {
            if (!person.anchors.length) continue;
            characterState.update(projectId, (current) => {
                current.activity = 'Tracking ' + person.label;
            });
            const workDir = path.join(projectDir(projectId), 'masks', person.id);
            fs.rmSync(workDir, { recursive: true, force: true });
            ensureDir(workDir);
            const result = await tracking.trackPerson({
                projectId,
                person,
                sourceName: sourceUpload.name,
                reversedName,
                frames: project.part.frames,
                workDir
            });
            characterState.update(projectId, (current) => {
                const target = personById(current, person.id);
                target.masks = {
                    dir: rel(projectId, result.dir),
                    width: result.width,
                    height: result.height,
                    lostSpans: result.lostSpans,
                    x: result.x,
                    editedFrames: []
                };
                target.x = result.x;
                target.status = 'tracked';
            });
        }
        await vramManager.freeComfyModels('character swap tracking').catch(() => {});
        characterState.update(projectId, (current) => {
            current.status = 'ready';
            current.activity = null;
            current.error = null;
            current.maskExport = null;
            dropTakes(current);
        });
        return characterState.get(projectId);
    } catch (err) {
        const message = /out of memory|oom|allocation/i.test(String(err.message || ''))
            ? 'ComfyUI ran out of memory while tracking. Close other GPU apps, shorten the trim, and try again.'
            : (err.message || String(err));
        await comfyui.softFreeMemory().catch(() => {});
        characterState.update(projectId, (current) => {
            current.status = 'failed';
            current.activity = null;
            current.error = message;
        });
        err.message = message;
        throw err;
    } finally {
        busy.delete(projectId);
        for (const name of uploaded) await comfyui.deleteInputFile(name).catch(() => {});
    }
}

function startTrack(projectId) {
    const project = characterState.requireProject(projectId);
    if (project.engine === 'wan_animate') {
        const err = new Error('Wan Animate 2 does not use tracking or masks. Upload one character image and use the prompt instead.');
        err.status = 400;
        throw err;
    }
    if (busy.get(projectId)) {
        const err = new Error('This project is already working.');
        err.status = 409;
        throw err;
    }
    if (!project.people.some((person) => person.anchors.length)) {
        const err = new Error('Add an anchor on a person first.');
        err.status = 400;
        throw err;
    }
    busy.set(projectId, 'queued');
    characterState.update(projectId, (current) => {
        current.status = 'tracking';
        current.activity = 'Waiting to track';
        current.error = null;
    });
    setImmediate(() => {
        busy.delete(projectId);
        runTrack(projectId).catch((err) => {
            console.warn('[character-swap] tracking failed:', err.message);
        });
    });
    return characterState.get(projectId);
}

// --- Wan person selection (DWPose, no SAM) -----------------------------------

function selectionError(err) {
    const message = /out of memory|oom|allocation/i.test(String(err.message || ''))
        ? 'ComfyUI ran out of memory while detecting people. Close other GPU apps and try again.'
        : (err.message || String(err));
    return message;
}

function startSelection(projectId) {
    if (busy.get(projectId)) {
        const err = new Error('This project is already working.');
        err.status = 409;
        throw err;
    }
    const project = characterState.requireProject(projectId);
    if (!project.part) {
        const err = new Error('The clip is still being prepared.');
        err.status = 400;
        throw err;
    }
    busy.set(projectId, 'queued');
    characterState.update(projectId, (current) => {
        current.status = 'tracking';
        current.activity = 'Waiting to detect people';
        current.error = null;
    });
    setImmediate(() => {
        busy.delete(projectId);
        runSelection(projectId).catch((err) => {
            console.warn('[character-swap] selection failed:', err.message);
        });
    });
    return characterState.get(projectId);
}

async function runSelection(projectId) {
    if (busy.get(projectId)) {
        const err = new Error('This project is already working.');
        err.status = 409;
        throw err;
    }
    busy.set(projectId, 'selection');
    try {
        const project = characterState.requireProject(projectId);
        const fps = Number(project.part.fps) || media.FPS;
        characterState.update(projectId, (current) => {
            current.status = 'tracking';
            current.activity = 'Detecting people';
        });
        const result = await selection.detect(project, {
            signal: undefined,
            onStage: (text) => characterState.update(projectId, (current) => { current.activity = text; })
        });
        const selectionDir = ensureDir(path.join(projectDir(projectId), 'selection'));
        const keypointFile = path.join(selectionDir, 'keypoints.json');
        fs.writeFileSync(keypointFile, JSON.stringify(result.frames));
        const thumbDir = ensureDir(path.join(selectionDir, 'thumbs'));
        await selection.makeThumbnails(project, result.tracks, thumbDir);
        const tracks = result.tracks.map((track) => ({
            id: track.id,
            label: track.label,
            sourceIndex: track.sourceIndex,
            firstFrame: track.firstFrame,
            lastFrame: track.lastFrame,
            frames: track.frames,
            score: track.score,
            bbox: track.bbox,
            thumbFrame: track.thumbFrame,
            lostSpans: track.lostSpans || [],
            thumb: track.thumb && fs.existsSync(track.thumb) ? rel(projectId, track.thumb) : null
        }));
        characterState.update(projectId, (current) => {
            current.selection = {
                method: selection.METHOD,
                version: selection.VERSION,
                width: result.width,
                height: result.height,
                frames: result.frames.length,
                fps,
                tracks,
                corrections: [],
                keypointsFile: rel(projectId, keypointFile),
                createdAt: new Date().toISOString()
            };
            const ids = new Set(tracks.map((track) => track.id));
            (current.people || []).forEach((person) => {
                if (person.selectionId && !ids.has(person.selectionId)) {
                    person.selectionId = null;
                    person.status = 'new';
                }
            });
            current.segmentation = { method: null, people: {}, createdAt: null };
            try { fs.rmSync(path.join(projectDir(projectId), 'segmentation'), { recursive: true, force: true }); } catch { /* next retry */ }
            clearWanCache(current);
            dropTakes(current);
            current.status = 'ready';
            current.activity = null;
            current.error = null;
            current.maskExport = null;
        });
        await vramManager.freeComfyModels('character swap selection').catch(() => {});
        return characterState.get(projectId);
    } catch (err) {
        await comfyui.softFreeMemory().catch(() => {});
        const message = selectionError(err);
        characterState.update(projectId, (current) => {
            current.status = 'failed';
            current.activity = null;
            current.error = message;
        });
        err.message = message;
        throw err;
    } finally {
        busy.delete(projectId);
    }
}

function selectTracks(projectId, trackIds) {
    const project = characterState.requireProject(projectId);
    const ids = Array.from(new Set((Array.isArray(trackIds) ? trackIds : []).map(String)));
    const known = new Set(((project.selection && project.selection.tracks) || []).map((track) => track.id));
    const valid = ids.filter((id) => known.has(id));
    if (!valid.length) {
        const err = new Error('Select at least one detected person.');
        err.status = 400;
        throw err;
    }
    if (valid.length > characterState.MAX_PEOPLE) {
        const err = new Error('Character Swap supports up to ' + characterState.MAX_PEOPLE + ' people per video.');
        err.status = 400;
        throw err;
    }
    return characterState.update(projectId, (current) => {
        const tracks = (current.selection && current.selection.tracks) || [];
        const byId = new Map(tracks.map((track) => [track.id, track]));
        (current.people || []).forEach((person) => {
            if (person.selectionId && !valid.includes(person.selectionId)) {
                person.selectionId = null;
                person.status = 'new';
            }
        });
        const unbound = () => (current.people || []).find((person) => !person.selectionId);
        for (const id of valid) {
            const track = byId.get(id);
            if (!track) continue;
            let person = (current.people || []).find((item) => item.selectionId === id);
            if (!person) person = unbound();
            if (!person) {
                if (current.people.length >= characterState.MAX_PEOPLE) {
                    const err = new Error('Character Swap supports up to ' + characterState.MAX_PEOPLE + ' people per video.');
                    err.status = 400;
                    throw err;
                }
                person = characterState.newPerson(current.people.length);
                current.people.push(person);
            }
            person.selectionId = id;
            person.label = track.label;
            person.status = 'selected';
        }
        (current.segmentation || {}).hash = null;
        clearWanCache(current);
        dropTakes(current);
    });
}

async function applySelectionCorrection(projectId, correction) {
    const project = characterState.requireProject(projectId);
    if (!project.selection || !project.selection.keypointsFile) throw new Error('Detect people before correcting the tracking.');
    const file = abs(projectId, project.selection.keypointsFile);
    if (!file || !fs.existsSync(file)) throw new Error('The person tracking data is missing. Detect people again.');
    const frames = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entry = {
        frame: Math.round(Number(correction.frame) || 0),
        trackId: correction.trackId ? String(correction.trackId) : null,
        x: Number(correction.x),
        y: Number(correction.y),
        detectionIndex: Number.isInteger(correction.detectionIndex) ? correction.detectionIndex : undefined
    };
    if (!entry.trackId) throw new Error('Choose which person this detection belongs to.');
    const corrections = ((project.selection && project.selection.corrections) || []).concat([entry]);
    const fps = Number(project.part.fps) || media.FPS;
    const tracks = selection.summarize(frames, corrections, fps);
    fs.writeFileSync(file, JSON.stringify(frames));
    const thumbDir = ensureDir(path.join(projectDir(projectId), 'selection', 'thumbs'));
    await selection.makeThumbnails(project, tracks, thumbDir);
    const previous = new Map(((project.selection && project.selection.tracks) || []).map((track) => [track.id, track]));
    const nextTracks = tracks.map((track) => ({
        id: track.id,
        label: track.label,
        sourceIndex: track.sourceIndex,
        firstFrame: track.firstFrame,
        lastFrame: track.lastFrame,
        frames: track.frames,
        score: track.score,
        bbox: track.bbox,
        thumbFrame: track.thumbFrame,
        lostSpans: track.lostSpans || [],
        thumb: track.thumb && fs.existsSync(track.thumb) ? rel(projectId, track.thumb) : (previous.get(track.id) || {}).thumb || null
    }));
    characterState.update(projectId, (current) => {
        current.selection.tracks = nextTracks;
        current.selection.corrections = corrections;
        const ids = new Set(nextTracks.map((track) => track.id));
        (current.people || []).forEach((person) => {
            if (person.selectionId && !ids.has(person.selectionId)) {
                person.selectionId = null;
                person.status = 'new';
            }
        });
        // A track correction does not change the frame-level matte, so keep it
        // and rebuild only the per-person masks from the corrected tracking.
        const previousSegmentation = current.segmentation || {};
        current.segmentation = {
            method: previousSegmentation.method || null,
            matte: previousSegmentation.matte || null,
            people: {},
            hash: null,
            rawHash: null,
            warnings: previousSegmentation.warnings || [],
            createdAt: previousSegmentation.createdAt || null
        };
        for (const person of current.people || []) {
            try { fs.rmSync(path.join(projectDir(projectId), 'segmentation', person.id), { recursive: true, force: true }); } catch { /* next retry */ }
        }
        clearWanCache(current);
        dropTakes(current);
    });
    return characterState.get(projectId);
}

function startSegment(projectId) {
    if (busy.get(projectId)) {
        const err = new Error('This project is already working.');
        err.status = 409;
        throw err;
    }
    const project = characterState.requireProject(projectId);
    if (!project.selection || !project.selection.tracks.length) {
        const err = new Error('Detect and select people before building masks.');
        err.status = 400;
        throw err;
    }
    if (!(project.people || []).some((person) => person.selectionId)) {
        const err = new Error('Select at least one detected person before building masks.');
        err.status = 400;
        throw err;
    }
    busy.set(projectId, 'queued');
    characterState.update(projectId, (current) => {
        current.status = 'tracking';
        current.activity = 'Waiting to build masks';
        current.error = null;
    });
    setImmediate(() => {
        busy.delete(projectId);
        runSegment(projectId).catch((err) => {
            console.warn('[character-swap] segmentation failed:', err.message);
        });
    });
    return characterState.get(projectId);
}

async function runSegment(projectId) {
    if (busy.get(projectId)) {
        const err = new Error('This project is already working.');
        err.status = 409;
        throw err;
    }
    busy.set(projectId, 'segment');
    try {
        const project = characterState.requireProject(projectId);
        characterState.update(projectId, (current) => {
            current.status = 'tracking';
            current.activity = 'Building person masks';
        });
        const info = await comfyui.getObjectInfo().catch(() => null);
        const result = await segmentation.generate(project, {
            info,
            onStage: (text) => characterState.update(projectId, (current) => { current.activity = text; })
        });
        characterState.update(projectId, (current) => {
            current.segmentation = result;
            (current.people || []).forEach((person) => {
                if (result.people[person.id]) person.status = 'segmented';
            });
            clearWanCache(current);
            dropTakes(current);
            current.status = 'ready';
            current.activity = null;
            current.error = null;
        });
        await vramManager.freeComfyModels('character swap segmentation').catch(() => {});
        return characterState.get(projectId);
    } catch (err) {
        await comfyui.softFreeMemory().catch(() => {});
        const message = selectionError(err);
        characterState.update(projectId, (current) => {
            current.status = 'failed';
            current.activity = null;
            current.error = message;
        });
        err.message = message;
        throw err;
    } finally {
        busy.delete(projectId);
    }
}

function needsSelection(project) {
    if (!project || project.engine !== 'wan_animate') return false;
    return !project.selection || project.selection.version !== selection.VERSION || !(project.selection.tracks || []).length;
}

function needsSegmentation(project) {
    if (!project || project.engine !== 'wan_animate') return false;
    if (!project.selection || !(project.selection.tracks || []).length) return true;
    const selected = (project.people || []).filter((person) => person.selectionId);
    if (!selected.length) return true;
    const seg = project.segmentation;
    if (!seg || !seg.method) return true;
    const hash = segmentation.hashFor(project, seg.method, true);
    if (seg.hash !== hash) return true;
    return selected.some((person) => {
        const meta = seg.people && seg.people[person.id];
        const file = meta ? abs(project.id, meta.video) : null;
        return !meta || !file || !fs.existsSync(file);
    });
}

function maskSourceFor(project, person) {
    if (!person) return null;
    if (project.engine === 'wan_animate') {
        const meta = project.segmentation && project.segmentation.people
            ? project.segmentation.people[person.id]
            : null;
        if (!meta) return null;
        return {
            dir: meta.dir,
            width: meta.width,
            height: meta.height,
            editedFrames: meta.editedFrames || []
        };
    }
    return person.masks || null;
}

function maskFramePath(projectId, personId, frame) {
    const project = characterState.requireProject(projectId);
    const person = personById(project, personId);
    const source = maskSourceFor(project, person);
    if (!source || !source.dir) return null;
    return abs(projectId, source.dir + '/' + media.frameName(Number(frame)));
}

async function sourceFrame(projectId, frame) {
    const project = characterState.requireProject(projectId);
    const partPath = abs(projectId, project.part.file);
    const index = clamp(frame, 0, Math.max(0, project.part.frames - 1), 0);
    const output = path.join(projectDir(projectId), 'frames', media.frameName(index));
    if (!fs.existsSync(output)) await media.extractFrame(partPath, index, output);
    return output;
}

async function editMask(projectId, personId, frame, strokes) {
    const project = characterState.requireProject(projectId);
    const person = personById(project, personId);
    const source = maskSourceFor(project, person);
    if (!source) {
        throw new Error(project.engine === 'wan_animate'
            ? 'Build the person mask before editing it.'
            : 'Track the person before editing the mask.');
    }
    const file = maskFramePath(projectId, personId, frame);
    if (!file || !fs.existsSync(file)) throw new Error('That mask frame is not available.');
    const mask = await media.readMask(file);
    const next = media.applyStrokes(mask.values, mask.width, mask.height, strokes);
    media.writeMask(file, next, mask.width, mask.height);
    return characterState.update(projectId, (current) => {
        const target = personById(current, personId);
        if (current.engine === 'wan_animate') {
            const meta = current.segmentation && current.segmentation.people
                ? current.segmentation.people[target.id]
                : null;
            if (meta) {
                const edited = new Set(meta.editedFrames || []);
                edited.add(Number(frame));
                meta.editedFrames = Array.from(edited).sort((a, b) => a - b);
                meta.x = media.centroid(next, mask.width, mask.height);
            }
            clearSegmentationExports(current);
            clearWanCache(current);
            dropTakes(current);
            return;
        }
        const edited = new Set(target.masks.editedFrames || []);
        edited.add(Number(frame));
        target.masks.editedFrames = Array.from(edited).sort((a, b) => a - b);
        target.masks.x = media.centroid(next, mask.width, mask.height);
        clearMasksOnly(current);
    });
}

function updateMaskSettings(projectId, settings) {
    return characterState.update(projectId, (current) => {
        current.maskSettings.grow = clamp(settings.grow, -128, 128, current.maskSettings.grow);
        current.maskSettings.feather = clamp(settings.feather, 0, 32, current.maskSettings.feather);
        current.maskSettings.temporal = clamp(settings.temporal, 0, 9, current.maskSettings.temporal);
        current.maskSettings.opacity = clamp(settings.opacity, 0.1, 1, current.maskSettings.opacity);
        clearMasksOnly(current);
        clearSegmentationExports(current);
        clearWanCache(current);
        dropTakes(current);
    });
}

function addReference(projectId, personId, filePath, role) {
    const project = characterState.requireProject(projectId);
    const person = personById(project, personId);
    if (!filePath || !fs.existsSync(filePath)) throw new Error('The reference image could not be found.');
    if (person.refs.length >= characterState.MAX_REFERENCES) {
        throw new Error('A character can have up to ' + characterState.MAX_REFERENCES + ' reference images.');
    }
    const dir = ensureDir(path.join(projectDir(projectId), 'refs', person.id));
    const ext = path.extname(filePath).toLowerCase() || '.png';
    const id = 'ref_' + crypto.randomBytes(5).toString('hex');
    const stored = path.join(dir, id + ext);
    fs.copyFileSync(filePath, stored);
    return characterState.update(projectId, (current) => {
        const target = personById(current, personId);
        target.refs.push({
            id,
            file: rel(projectId, stored),
            originalName: path.basename(filePath),
            role: references.normalizeRole(role),
            facing: 'front'
        });
        target.description = null;
        target.identitySummary = '';
    });
}

async function addReferenceImage(projectId, personId, filePath, role) {
    const project = characterState.requireProject(projectId);
    const person = personById(project, personId);
    const remaining = characterState.MAX_REFERENCES - person.refs.length;
    if (remaining <= 0) throw new Error('A character can have up to ' + characterState.MAX_REFERENCES + ' reference images.');
    const splitDir = ensureDir(path.join(projectDir(projectId), 'refs', person.id, 'split-' + Date.now()));
    let splitSource = filePath;
    if (!/\.png$/i.test(filePath)) {
        splitSource = path.join(splitDir, 'source.png');
        await media.run(['-hide_banner', '-y', '-i', filePath, splitSource], { code: 'character_swap_reference_convert_failed' });
    }
    const views = await sheets.splitSheet(splitSource, splitDir);
    let updated = project;
    for (const view of views.slice(0, remaining)) {
        updated = addReference(projectId, personId, view, views.length > 1 ? 'other' : role);
    }
    return updated;
}

function removeReference(projectId, personId, referenceId) {
    return characterState.update(projectId, (current) => {
        const target = personById(current, personId);
        const ref = target.refs.find((item) => item.id === referenceId);
        target.refs = target.refs.filter((item) => item.id !== referenceId);
        target.description = null;
        target.identitySummary = '';
        if (ref) {
            const file = abs(projectId, ref.file);
            try { fs.unlinkSync(file); } catch { /* next cleanup */ }
        }
    });
}

function setReferenceRole(projectId, personId, referenceId, role) {
    return characterState.update(projectId, (current) => {
        const target = personById(current, personId);
        const ref = target.refs.find((item) => item.id === referenceId);
        if (ref) ref.role = references.normalizeRole(role);
        target.referenceOrder = promptBuilder.orderReferences(target).map((item) => item.id);
    });
}

async function describeProject(projectId, ctx) {
    const project = characterState.requireProject(projectId);
    for (const person of project.people) {
        if (!person.refs.length) continue;
        const files = person.refs.map((ref) => abs(projectId, ref.file)).filter(Boolean);
        const unclassified = person.refs.filter((ref) => !ref.role || ref.role === 'other');
        if (unclassified.length) {
            try {
                const unclassifiedFiles = unclassified.map((ref) => abs(projectId, ref.file)).filter(Boolean);
                const classified = await references.classify(unclassifiedFiles, ctx);
                characterState.update(projectId, (current) => {
                    const target = personById(current, person.id);
                    classified.forEach((item, index) => {
                        const ref = target.refs.find((entry) => entry.id === unclassified[index].id);
                        if (ref) {
                            ref.role = references.normalizeRole(item.role);
                            ref.facing = item.facing;
                        }
                    });
                });
            } catch (err) {
                // Manual roles remain usable when the vision model is unavailable.
            }
        }
        let description = null;
        try {
            description = await references.describe(files, ctx);
        } catch (err) {
            description = null;
        }
        let facing = 'front';
        let look = '';
        const anchor = person.anchors[0];
        if (anchor && person.masks) {
            try {
                const work = ensureDir(path.join(projectDir(projectId), 'describe', person.id));
                const anchorMask = abs(projectId, anchor.maskFile);
                const crop = await references.cropForOrientation(abs(projectId, project.part.file), anchor, anchorMask, work);
                facing = await references.orientation(crop, ctx);
                if (project.people.length > 1) look = await references.look(crop, ctx);
            } catch {
                facing = 'front';
            }
        }
        characterState.update(projectId, (current) => {
            const target = personById(current, person.id);
            target.description = description;
            target.identitySummary = description ? promptBuilder.structuredSummary(description) : '';
            target.facing = facing;
            target.look = look;
            target.referenceOrder = promptBuilder.orderReferences(target).map((item) => item.id);
        });
    }
    const updated = characterState.get(projectId);
    promptBuilder.assignPlaces(updated.people);
    return characterState.update(projectId, (current) => {
        promptBuilder.assignPlaces(current.people);
    });
}

// Wan Animate 2 generates its background from text, so the source scene is
// captioned once and reused as the Background section of the swap prompt.
// A stuck or unavailable vision model is fail-open: the deterministic
// preservation wording in the prompt builder still keeps the render usable.
function hasSceneDescription(project) {
    if (!project || !project.sceneDescription || !project.sceneDescription.summary) return false;
    return project.sceneDescription.sourceFile === (project.part && project.part.file);
}

async function describeSourceScene(projectId, ctx) {
    const project = characterState.requireProject(projectId);
    if (!project.part) throw new Error('The clip is still being prepared.');
    if (hasSceneDescription(project)) return project.sceneDescription;
    const partPath = abs(projectId, project.part.file);
    if (!partPath || !fs.existsSync(partPath)) throw new Error('The prepared clip is missing.');
    const frames = Math.max(1, Number(project.part.frames) || 1);
    const frame = Math.max(0, Math.min(frames - 1, Math.round(frames * 0.2)));
    const sceneDir = ensureDir(path.join(projectDir(projectId), 'scene'));
    const framePath = path.join(sceneDir, 'frame-' + frame + '.png');
    await media.extractFrame(partPath, frame, framePath);
    let scene = null;
    try {
        scene = await references.describeScene([framePath], ctx);
    } finally {
        try { fs.unlinkSync(framePath); } catch { /* next retry */ }
    }
    if (!scene || !scene.summary) return null;
    let saved = null;
    characterState.update(projectId, (current) => {
        current.sceneDescription = Object.assign({}, scene, {
            sourceFile: current.part.file,
            frame,
            createdAt: new Date().toISOString()
        });
        saved = current.sceneDescription;
    });
    return saved;
}

async function generateView(projectId, personId, view, ctx, options = {}) {    const project = characterState.requireProject(projectId);
    const person = personById(project, personId);
    if (!person.refs.length) throw new Error('Add at least one reference image first.');
    const ordered = promptBuilder.orderReferences(person);
    const source = ordered[0] || person.refs[0];
    const sourcePath = abs(projectId, source.file);
    const imageGenerator = require('../image-generator');
    const viewPrompts = {
        front: 'a full-body front view, facing the camera, head to toe, arms slightly away from the body',
        side: 'a full-body side profile view, head to toe',
        back: 'a full-body back view, head to toe',
        close_up: 'a head-and-shoulders close-up of the face, front on',
        full_body: 'a full-body front view, facing the camera, head to toe'
    };
    const instruction =
        'Character reference photo on a plain neutral studio background. Show the same exact person ' +
        'as ' + (viewPrompts[view] || viewPrompts.front) + '. Keep the identical face, hair, skin tone, ' +
        'body proportions and clothing from the source image. Even soft studio lighting. No text, no props, ' +
        'no extra people, no collage. ' + (options.extra ? String(options.extra).slice(0, 400) : '');
    const result = await imageGenerator.editImage(sourcePath, instruction, {
        conversationId: options.conversationId || null,
        label: 'character swap reference view',
        kind: 'image_edit',
        hidden: true
    });
    const generatedDir = process.env.GENERATED_DIR || path.join(__dirname, '..', '..', 'data', 'generated');
    const generated = path.join(generatedDir, result.filename || '');
    if (!fs.existsSync(generated)) throw new Error('The reference view was generated but could not be found.');
    const updated = addReference(projectId, personId, generated, view);
    characterState.update(projectId, (current) => {
        const target = personById(current, personId);
        const added = target.refs[target.refs.length - 1];
        if (added) added.role = references.normalizeRole(view);
        target.referenceOrder = promptBuilder.orderReferences(target).map((item) => item.id);
    });
    return updated;
}

async function generateSheet(projectId, personId, ctx, options = {}) {
    const project = characterState.requireProject(projectId);
    const person = personById(project, personId);
    if (!person.refs.length) throw new Error('Add at least one reference image first.');
    const ordered = promptBuilder.orderReferences(person);
    const source = ordered[0] || person.refs[0];
    const sourcePath = abs(projectId, source.file);
    const outDir = ensureDir(path.join(projectDir(projectId), 'refs', person.id));
    const output = path.join(outDir, 'sheet-' + Date.now() + '.png');
    await references.generateSheet(sourcePath, output, ctx, {
        conversationId: options.conversationId || null,
        extra: options.extra
    });
    const splitDir = ensureDir(path.join(outDir, 'sheet-views-' + Date.now()));
    const views = await sheets.splitSheet(output, splitDir);
    let updated = project;
    for (const view of views) {
        updated = addReference(projectId, personId, view, 'other');
    }
    characterState.update(projectId, (current) => {
        const target = personById(current, personId);
        target.description = null;
        target.identitySummary = '';
    });
    return updated;
}

function refineMaskFrames(accumulated, width, height, settings) {
    const smoothed = media.temporalSmooth(accumulated, width, height, settings.temporal);
    return smoothed.map((frameValues) => {
        let values = frameValues;
        const grow = Math.round(settings.grow);
        if (grow > 0) values = media.dilate(values, width, height, grow);
        else if (grow < 0) values = media.contract(values, width, height, -grow);
        if (settings.feather > 0) values = media.boxBlur(values, width, height, settings.feather);
        return values;
    });
}

// Export two mask products from the SAME tracked frames:
//   union  — every selected person, padded for the H3 17n+5 frame grid;
//   people — one tight mask per person, used by Wan's sequential passes so a
//            later pass can never repaint an earlier replacement.
async function exportMasks(projectId) {
    const project = characterState.requireProject(projectId);
    const tracked = project.people.filter((person) => person.masks);
    if (!tracked.length) {
        throw new Error('No tracking masks yet. Choose Select, click directly on the person, then press Track.');
    }
    if (tracked.length !== project.people.length) {
        throw new Error('Track every selected person before generating, or remove the untracked person.');
    }
    const frames = project.part.frames;
    const width = tracked[0].masks.width;
    const height = tracked[0].masks.height;
    const outDir = path.join(projectDir(projectId), 'mask-export');
    fs.rmSync(outDir, { recursive: true, force: true });

    const perPerson = {};
    const unionFrames = new Array(frames);
    for (const person of tracked) {
        const frameDir = ensureDir(path.join(outDir, person.id));
        const accumulated = [];
        for (let frame = 0; frame < frames; frame += 1) {
            const file = abs(projectId, person.masks.dir + '/' + media.frameName(frame));
            if (!file || !fs.existsSync(file)) {
                accumulated.push(media.emptyMask(width, height));
                continue;
            }
            accumulated.push((await media.readMask(file)).values);
        }
        const refined = refineMaskFrames(accumulated, width, height, project.maskSettings);
        refined.forEach((values, frame) => {
            media.writeMask(path.join(frameDir, media.frameName(frame)), values, width, height);
            if (!unionFrames[frame]) unionFrames[frame] = new Uint8Array(width * height);
            const union = unionFrames[frame];
            for (let i = 0; i < union.length; i += 1) {
                if (values[i] > union[i]) union[i] = values[i];
            }
        });
        const videoPath = path.join(outDir, person.id + '-mask.mp4');
        await media.encodeFrames(frameDir, videoPath, media.FPS);
        perPerson[person.id] = {
            dir: rel(projectId, frameDir),
            video: rel(projectId, videoPath),
            width,
            height,
            frames,
            settings: Object.assign({}, project.maskSettings),
            createdAt: new Date().toISOString()
        };
    }

    const unionDir = ensureDir(path.join(outDir, 'union'));
    unionFrames.forEach((values, frame) => {
        media.writeMask(path.join(unionDir, media.frameName(frame)), values || media.emptyMask(width, height), width, height);
    });
    const unionVideo = path.join(outDir, 'mask.mp4');
    const paddedPath = path.join(outDir, 'mask-padded.mp4');
    await media.encodeFrames(unionDir, unionVideo, media.FPS);
    // H3 rounds a request to its 17n+5 frame grid and may ask for more frames
    // than the trimmed source. Pad the mask with its final state so the graph
    // can trim it to the exact generation length without desynchronising.
    await media.padTo(unionVideo, paddedPath, 15.25);
    const union = {
        dir: rel(projectId, unionDir),
        video: rel(projectId, paddedPath),
        width,
        height,
        frames,
        settings: Object.assign({}, project.maskSettings),
        createdAt: new Date().toISOString()
    };
    const updated = characterState.update(projectId, (current) => {
        current.maskExport = union;
        current.maskExports = {
            union,
            people: perPerson,
            settings: Object.assign({}, current.maskSettings),
            createdAt: new Date().toISOString()
        };
        promptBuilder.assignPlaces(current.people);
    });
    return updated.maskExports;
}

async function exportMask(projectId) {
    const exports = await exportMasks(projectId);
    return exports.union;
}

function allocateReferences(people, max) {
    const shares = people.map(() => 0);
    let remaining = max;
    const ordered = people.map((person) => promptBuilder.orderReferences(person));
    let added = true;
    while (remaining > 0 && added) {
        added = false;
        for (let i = 0; i < people.length && remaining > 0; i += 1) {
            if (shares[i] >= ordered[i].length) continue;
            shares[i] += 1;
            remaining -= 1;
            added = true;
        }
    }
    return ordered.map((refs, index) => refs.slice(0, shares[index]));
}

function buildH3Plan(projectId, project) {
    if (project.part.frames / media.FPS > MAX_SECONDS + 0.2) {
        throw new Error('MiniMax H3 replacement supports up to ' + MAX_SECONDS + ' seconds. Trim the clip and re-track before generating with H3, or switch to Wan Animate 2.');
    }
    if (!project.maskExport) throw new Error('Build the refined mask before generating.');
    if (project.people.some((person) => !person.masks)) {
        throw new Error('Track every selected person before generating, or remove the untracked person.');
    }
    const peopleWithRefs = project.people.filter((person) => person.refs.length);
    if (peopleWithRefs.length !== project.people.length) throw new Error('Add reference images for every selected person.');
    promptBuilder.assignPlaces(project.people);
    const allocated = allocateReferences(project.people, characterState.MAX_REFERENCES);
    const replacements = [];
    const targets = [];
    let cursor = 1;
    project.people.forEach((person, index) => {
        const refs = allocated[index];
        refs.forEach((ref) => {
            const file = abs(projectId, ref.file);
            replacements.push({ absPath: file, filename: path.basename(file), type: 'image' });
        });
        targets.push({
            description: person.label + (person.place ? ' ' + person.place : ''),
            referenceIndex: cursor,
            referenceCount: refs.length
        });
        cursor += refs.length;
    });
    const promptText = promptBuilder.buildPrompt(project.people, project.description || '');
    return {
        engine: 'h3',
        projectId,
        sourceVideo: {
            absPath: abs(projectId, project.part.file),
            filename: project.source.filename || 'source.mp4',
            type: 'video'
        },
        replacements,
        targets,
        requestedDuration: project.part.frames / media.FPS,
        audioPolicy: 'preserve',
        replaceMode: 'identity_and_outfit',
        replacementMode: 'identity_and_outfit',
        replaceCount: project.people.length,
        preserve: {
            background: true,
            camera: true,
            lighting: true,
            otherPeople: true,
            audio: true,
            motion: true,
            clothing: true
        },
        promptText,
        maskVideoPath: abs(projectId, project.maskExport.video),
        maskExport: project.maskExport
    };
}

function buildWanPlan(projectId, project) {
    if (!project.part) throw new Error('The clip is still being prepared.');
    const referencePerson = (project.people || []).find((person) => (person.refs || []).length);
    if (!referencePerson) {
        throw new Error('Upload one character reference image before generating with Wan Animate 2.');
    }
    const reference = promptBuilder.selectIdentityReference(referencePerson) || referencePerson.refs[0];
    if (!reference) {
        throw new Error('Upload one character reference image before generating with Wan Animate 2.');
    }
    const settings = engines.wanAnimate.normalizeSettings(project.engineSettings && project.engineSettings.wanAnimate);
    if (!String(settings.positive || '').trim()) {
        throw new Error('Describe the shot (for example "replace the person on the left") before rendering with Wan Animate 2.');
    }
    const dims = engines.wanAnimate.dimensionsFor(project.part.width, project.part.height, settings);
    settings.width = dims.width;
    settings.height = dims.height;
    const sourceSeconds = project.part.frames / media.FPS;
    const capSeconds = Math.min(sourceSeconds, characterState.WAN_MAX_SECONDS);
    const requested = settings.durationMode === 'fixed' && settings.durationSeconds
        ? settings.durationSeconds
        : capSeconds;
    const durationSeconds = Math.max(1 / media.FPS, Math.min(capSeconds, requested));
    settings.durationSeconds = durationSeconds;
    const targetFrames = Math.max(1, Math.round(durationSeconds * media.FPS));
    return {
        engine: 'wan_animate',
        projectId,
        projectDir: projectDir(projectId),
        sourceVideoPath: abs(projectId, project.part.file),
        sourceFilename: project.source.filename || 'source.mp4',
        frames: targetFrames,
        duration: durationSeconds,
        durationSeconds,
        prompt: settings.positive,
        notes: settings.positive,
        rawPrompt: settings.positive,
        sceneDescription: project.sceneDescription || null,
        settings,
        people: [{
            id: referencePerson.id,
            label: referencePerson.label,
            referencePath: abs(projectId, reference.file),
            referenceRole: promptBuilder.roleOf(reference),
            description: referencePerson.description,
            identitySummary: referencePerson.identitySummary
        }],
        preset: settings.preset
    };
}

function buildRenderPlan(projectId, engine) {
    const project = characterState.requireProject(projectId);
    const id = engines.normalizeEngine(engine || project.engine);
    if (id === 'h3') return buildH3Plan(projectId, project);
    return buildWanPlan(projectId, project);
}

function takeRecord(projectId, plan, engine, options, seed, startedAt, extra) {
    const project = characterState.requireProject(projectId);
    return Object.assign({
        takeId: extra && extra.takeId || (String(engine) + '_' + Date.now().toString(36)),
        engine,
        seed,
        quality: engine === 'h3' ? (options.quality || 'full') : (plan.settings && plan.settings.preset) || 'standard',
        status: 'failed',
        url: null,
        filename: null,
        createdAt: new Date().toISOString(),
        prompt: extra && extra.prompt || plan.prompt || plan.promptText || '',
        width: null,
        height: null,
        duration: null,
        fps: engine === 'wan_animate' ? (plan.settings && plan.settings.fps) || 24 : null,
        generationMs: Date.now() - startedAt,
        mask: plan.maskExport ? plan.maskExport.settings : (project.maskSettings || null),
        windows: [],
        passes: [],
        metrics: null,
        error: null
    }, extra || {});
}

// The auto-upscale pass runs in the server AFTER the render's generation lock
// has been released. Fold its result back onto the persisted take so the UI
// shows the upscaled clip while the original stays in the gallery as the
// compare source.
function markTakeUpscaled(projectId, seed, result) {
    if (!result) return null;
    let updated = null;
    characterState.update(projectId, (current) => {
        const take = (current.takes || []).find((item) => item.seed === seed);
        if (!take) return;
        take.url = result.url || take.url;
        take.filename = result.filename || take.filename;
        take.width = result.width || take.width;
        take.height = result.height || take.height;
        take.generationMs = result.generationMs || take.generationMs;
        take.meta = result.meta || take.meta;
        take.upscale = result.upscale || take.upscale || null;
        take.upscaled = Boolean(result.upscaled);
        take.upscaleError = result.upscaleError || null;
        if (current.bestTake && current.bestTake.seed === seed) current.bestTake = take;
        updated = JSON.parse(JSON.stringify(take));
    });
    return updated;
}

async function renderTake(projectId, options = {}) {
    const project = characterState.requireProject(projectId);
    const engine = engines.normalizeEngine(options.engine || project.engine);
    const plan = buildRenderPlan(projectId, engine);
    const adapter = engines.getEngine(engine);
    const settings = engine === 'wan_animate' && plan.settings ? plan.settings : null;
    const seed = settings && settings.seedMode === 'fixed' && settings.seed !== null
        ? settings.seed
        : (Number.isInteger(options.seed) ? options.seed : Math.floor(Math.random() * 2 ** 32));
    const startedAt = Date.now();
    let result;
    try {
        if (engine === 'h3') {
            result = await adapter.render(plan, {
                conversationId: options.conversationId || null,
                promptOverride: plan.promptText,
                maskVideoPath: plan.maskVideoPath,
                h3Size: options.h3Size,
                seed,
                label: 'character swap',
                kind: 'video_generation',
                onQueued: options.onQueued,
                onStart: options.onStart,
                onProgress: options.onProgress,
                timeoutMs: options.timeoutMs
            });
        } else {
            result = await adapter.render(plan, {
                conversationId: options.conversationId || null,
                seed,
                takeId: options.takeId,
                resume: options.resume,
                onQueued: options.onQueued,
                onStart: options.onStart,
                onStage: options.onStage,
                settings: settings || undefined
            });
        }
    } catch (err) {
        const failed = takeRecord(projectId, plan, engine, options, seed, startedAt, {
            prompt: plan.prompt || plan.promptText || '',
            status: 'failed',
            error: err.message || String(err),
            windows: err.windows || [],
            passes: err.passes || [],
            takeId: err.takeId || options.takeId || (engine + '_' + Date.now().toString(36))
        });
        characterState.update(projectId, (current) => {
            current.takes = (current.takes || []).filter((item) => item.seed !== seed).concat([failed]);
            current.status = 'ready';
            current.error = failed.error;
        });
        err.take = failed;
        throw err;
    }
    const take = {
        takeId: result.takeId || (engine + '_' + Date.now().toString(36)),
        engine,
        seed,
        quality: engine === 'h3' ? (options.quality || 'full') : plan.settings.preset,
        status: 'done',
        url: result.url,
        filename: result.filename,
        createdAt: new Date().toISOString(),
        prompt: result.prompt,
        width: result.width,
        height: result.height,
        duration: result.duration,
        fps: result.fps || null,
        generationMs: Date.now() - startedAt,
        mask: plan.maskExport ? plan.maskExport.settings : null,
        windows: result.windows || [],
        passes: result.passes || [],
        metrics: result.metrics || null,
        error: null
    };
    characterState.update(projectId, (current) => {
        current.takes = (current.takes || []).filter((item) => item.seed !== seed).concat([take]);
        current.bestTake = take;
        current.status = 'ready';
        current.error = null;
    });
    return take;
}

async function needsRetrack(projectId) {
    const project = characterState.requireProject(projectId);
    for (const person of project.people) {
        if ((person.anchors || []).length && !person.masks) return true;
        if (!person.masks) continue;
        const checks = [0].concat((person.anchors || []).map((anchor) => anchor.frame));
        for (const frame of Array.from(new Set(checks))) {
            const file = abs(projectId, person.masks.dir + '/' + media.frameName(frame));
            if (!file || !fs.existsSync(file)) return true;
            try {
                const mask = await media.readMask(file);
                if (tracking.bodyPoints(mask, person.anchors[0] ? person.anchors[0].positive : []).length) {
                    return true;
                }
            } catch {
                return true;
            }
        }
    }
    return false;
}

function takeFilenames(take) {
    const names = new Set();
    if (!take) return names;
    const add = (value) => {
        const name = path.basename(String(value || '').split('?')[0]);
        if (name) names.add(name);
    };
    add(take.filename);
    if (take.upscale) {
        add(take.upscale.originalFilename);
        add(take.upscale.upscaledFilename);
    }
    return names;
}

function dropTakeRecord(project, take) {
    if (!take) return false;
    project.takes = (project.takes || []).filter((item) =>
        item !== take && (!take.takeId || item.takeId !== take.takeId));
    if (project.bestTake && (project.bestTake === take || (take.takeId && project.bestTake.takeId === take.takeId))) {
        project.bestTake = project.takes.length ? project.takes[project.takes.length - 1] : null;
    }
    removeTakeWorkspace(project, take);
    return true;
}

// Delete one rendered take: its final video (and the upscale partner when the
// take was upscaled) leaves the gallery, and its window workspace is removed.
function removeTake(projectId, takeId) {
    const project = characterState.requireProject(projectId);
    const take = (project.takes || []).find((item) => item.takeId === takeId);
    if (!take) {
        const err = new Error('Take not found.');
        err.status = 404;
        throw err;
    }
    for (const name of takeFilenames(take)) {
        generatedHistory.removeByFilename(name, project.sessionId || undefined);
    }
    characterState.update(projectId, (current) => {
        const target = (current.takes || []).find((item) => item.takeId === takeId);
        dropTakeRecord(current, target);
        current.error = null;
    });
    return characterState.get(projectId);
}

// Gallery -> Character Swap direction: when a generated file is deleted from
// the gallery, drop any take that owns it (including the upscale partner).
function removeTakeByFilename(filename, sessionId) {
    const name = path.basename(String(filename || '').split('?')[0]);
    if (!name) return 0;
    let removed = 0;
    for (const project of characterState.list(sessionId)) {
        const matches = (project.takes || []).filter((take) => takeFilenames(take).has(name));
        if (!matches.length) continue;
        characterState.update(project.id, (current) => {
            for (const take of matches) {
                const target = (current.takes || []).find((item) => item.takeId === take.takeId);
                if (dropTakeRecord(current, target)) removed += 1;
            }
            current.error = null;
        });
    }
    return removed;
}

function removePerson(projectId, personId) {
    const project = characterState.get(projectId);
    if (project) {
        for (const take of project.takes || []) {
            if (take.filename) {
                try { generatedHistory.removeByFilename(take.filename); } catch { /* ignore */ }
            }
        }
    }
    return characterState.removePerson(projectId, personId);
}

function setEngine(projectId, engine, settings) {
    const before = characterState.requireProject(projectId);
    const next = engines.normalizeEngine(engine);
    const changed = before.engine !== next;
    const updated = characterState.setEngine(projectId, next, settings);
    if (changed) {
        vramManager.freeComfyModels('character swap engine switch').catch(() => {});
    }
    return updated;
}

function engineStatus(project, info) {
    const settings = project && project.engineSettings ? project.engineSettings : {};
    return engines.listEngines(info, {
        wan_animate: settings.wanAnimate || {},
        h3: settings.h3 || {}
    });
}

function segmentationStatus(info) {
    return segmentation.availability(info);
}

function remove(projectId) {
    const project = characterState.get(projectId);
    if (project) {
        for (const take of project.takes || []) {
            if (take.filename) {
                try { generatedHistory.removeByFilename(take.filename); } catch { /* ignore */ }
            }
        }
    }
    return characterState.remove(projectId);
}

function publicProject(projectId) {
    const project = characterState.requireProject(projectId);
    return JSON.parse(JSON.stringify(project));
}

function list(sessionId) {
    return characterState.list(sessionId);
}

function recover() {
    characterState.recover();
}

function removeForConversation(conversationId) {
    if (!conversationId) return;
    for (const project of characterState.list()) {
        if (project.conversationId !== conversationId) continue;
        for (const take of project.takes || []) {
            if (take.filename) {
                try { generatedHistory.removeByFilename(take.filename); } catch { /* ignore */ }
            }
        }
        characterState.remove(project.id);
    }
}

function projectFilePath(projectId, relativePath) {
    return abs(projectId, relativePath);
}

module.exports = {
    FPS: media.FPS,
    MAX_SECONDS,
    WAN_MAX_SECONDS,
    DEFAULT_ENGINE: engines.DEFAULT_ENGINE,
    get: characterState.get,
    setEngine,
    engineStatus,
    segmentationStatus,
    listEngines: engines.listEngines,
    getEngine: engines.getEngine,
    createProject,
    setTrim,
    addPerson: characterState.addPerson,
    removePerson,
    addAnchor,
    removeAnchor,
    startTrack,
    runTrack,
    startSelection,
    runSelection,
    selectTracks,
    applySelectionCorrection,
    startSegment,
    runSegment,
    needsSelection,
    needsSegmentation,
    maskSourceFor,
    needsRetrack,
    sourceFrame,
    maskFramePath,
    editMask,
    updateMaskSettings,
    addReferenceImage,
    removeReference,
    setReferenceRole,
    describeProject,
    describeSourceScene,
    hasSceneDescription,
    generateView,
    generateSheet,
    exportMask,
    exportMasks,
    buildRenderPlan,
    renderTake,
    markTakeUpscaled,
    removeTake,
    removeTakeByFilename,
    remove,
    publicProject,
    list,
    recover,
    removeForConversation,
    projectFilePath,
    isBusy: (projectId) => Boolean(busy.get(projectId))
};
