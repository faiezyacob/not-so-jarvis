/* ============================================
   JARVIS — Character Swap non-SAM segmentation
   Person masks for the Wan engine built from
   a background-removal matte (BiRefNet) or a
   DWPose silhouette fallback. No SAM is used.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const comfyui = require('../comfyui');
const media = require('./media');
const characterState = require('./state');

const VERSION = 'wan-segmentation-v2';
const DEFAULT_MODEL = process.env.CHARACTER_SWAP_MATTE_MODEL || 'birefnet.safetensors';
const MATTE_NODES = ['LoadBackgroundRemovalModel', 'RemoveBackground', 'MaskToImage', 'CreateVideo', 'SaveVideo', 'VHS_LoadVideo'];
const CHUNK = Math.max(8, Math.min(64, Number(process.env.CHARACTER_SWAP_MATTE_CHUNK) || 32));
const MATTE_TIMEOUT_MS = Number(process.env.CHARACTER_SWAP_MATTE_TIMEOUT_MS) || 45 * 60 * 1000;
const SUPPORT_SCALE = 4;

function node(classType, inputs) {
    return { class_type: classType, inputs: inputs || {} };
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function projectPath(project, rel) {
    return characterState.absolute(project.id, rel);
}

function relative(project, file) {
    return path.relative(characterState.projectDir(project.id), file).split(path.sep).join('/');
}

function selectionSettings(project) {
    return project && project.maskSettings ? project.maskSettings : {};
}

function normalizeMethod(value, matteAvailable) {
    const name = String(value || '').toLowerCase();
    if (name === 'pose' || name === 'dwpose' || name === 'silhouette') return 'pose';
    if (name === 'birefnet' || name === 'matte' || name === 'auto') return matteAvailable ? 'birefnet' : 'pose';
    return matteAvailable ? 'birefnet' : 'pose';
}

function matteHash(project, method) {
    const payload = {
        version: VERSION,
        method,
        model: DEFAULT_MODEL,
        trim: project.trim || null,
        frames: project.part ? project.part.frames : null,
        width: project.part ? project.part.width : null,
        height: project.part ? project.part.height : null
    };
    return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

function hashFor(project, method, includeSettings) {
    const tracks = (project.selection && project.selection.tracks) || [];
    const people = (project.people || []).map((person) => {
        const track = tracks.find((item) => item.id === person.selectionId);
        return {
            id: person.id,
            track: person.selectionId || null,
            label: track ? track.label : null
        };
    });
    const payload = {
        version: VERSION,
        method,
        model: method === 'birefnet' ? DEFAULT_MODEL : null,
        trim: project.trim || null,
        frames: project.part ? project.part.frames : null,
        width: project.part ? project.part.width : null,
        height: project.part ? project.part.height : null,
        people
    };
    if (includeSettings) payload.settings = selectionSettings(project);
    return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

function loadKeypoints(project) {
    const file = projectPath(project, (project.selection && project.selection.keypointsFile) || 'selection/keypoints.json');
    if (!file || !fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function selectedPeople(project) {
    return (project.people || []).filter((person) => person.selectionId);
}

function personTrack(project, person) {
    return ((project.selection && project.selection.tracks) || []).find((track) => track.id === person.selectionId) || null;
}

// Availability is explicit: the Wan engine never silently imports SAM.
function availability(info) {
    const missing = [];
    if (!info || typeof info !== 'object') {
        return { matte: false, pose: true, method: 'pose', missing: ['ComfyUI is not reachable.'], model: DEFAULT_MODEL };
    }
    for (const name of MATTE_NODES) {
        if (!Object.prototype.hasOwnProperty.call(info, name)) missing.push('ComfyUI node "' + name + '"');
    }
    let choices = [];
    try {
        const spec = info.LoadBackgroundRemovalModel.input.required.bg_removal_name;
        if (Array.isArray(spec)) {
            if (Array.isArray(spec[0])) choices = spec[0].map(String);
            else if (spec[1] && Array.isArray(spec[1].options)) choices = spec[1].options.map(String);
        }
    } catch {
        choices = [];
    }
    if (!choices.some((name) => name.toLowerCase() === DEFAULT_MODEL.toLowerCase())) {
        missing.push('Background-removal model "' + DEFAULT_MODEL + '"');
    }
    const matte = missing.length === 0;
    return {
        matte,
        pose: true,
        method: matte ? 'birefnet' : 'pose',
        missing,
        model: DEFAULT_MODEL
    };
}

// --- Matte (BiRefNet) ---------------------------------------------------------

function matteGraph(opts) {
    const { sourceName, model, fps, skip, cap, prefix } = opts;
    return {
        load: node('VHS_LoadVideo', {
            video: sourceName,
            force_rate: 0,
            custom_width: 0,
            custom_height: 0,
            frame_load_cap: cap,
            skip_first_frames: skip,
            select_every_nth: 1
        }),
        bg: node('LoadBackgroundRemovalModel', { bg_removal_name: model }),
        remove: node('RemoveBackground', { bg_removal_model: ['bg', 0], image: ['load', 0] }),
        image: node('MaskToImage', { mask: ['remove', 0] }),
        video: node('CreateVideo', { images: ['image', 0], fps }),
        save: node('SaveVideo', {
            video: ['video', 0],
            filename_prefix: prefix,
            format: 'auto',
            codec: 'auto'
        })
    };
}

function outputEntryForNode(history, nodeId) {
    const output = history && history.outputs && history.outputs[nodeId];
    if (!output) return null;
    const files = comfyui.findOutputFiles(output, /\.(?:mp4|webm|mov|mkv)$/i);
    return files.length ? files[files.length - 1] : null;
}

async function buildMatte(project, method, options = {}) {
    const onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
    const baseDir = ensureDir(path.join(characterState.projectDir(project.id), 'segmentation'));
    const matteDir = ensureDir(path.join(baseDir, 'matte'));
    const partPath = projectPath(project, project.part.file);
    if (!partPath || !fs.existsSync(partPath)) throw new Error('The prepared clip is missing.');
    const frames = Math.max(1, Number(project.part.frames) || 1);
    const fps = Number(project.part.fps) || media.FPS;
    const token = crypto.randomBytes(4).toString('hex');
    const prefix = 'jarvis_cs/matte_' + token;
    const uploaded = [];
    try {
        const upload = await comfyui.uploadFile(fs.readFileSync(partPath), 'jarvis_cs_matte_' + token + '.mp4', {
            mime: 'video/mp4'
        });
        uploaded.push(upload.name);
        for (let offset = 0; offset < frames; offset += CHUNK) {
            const cap = Math.min(CHUNK, frames - offset);
            onStage('Segmenting people ' + (offset + 1) + '–' + (offset + cap) + ' of ' + frames);
            const graph = matteGraph({
                sourceName: upload.name,
                model: DEFAULT_MODEL,
                fps,
                skip: offset,
                cap,
                prefix: prefix + '_' + offset
            });
            const pid = await comfyui.queuePrompt(graph);
            const history = await comfyui.waitForPrompt(pid, { timeoutMs: MATTE_TIMEOUT_MS, signal: options.signal });
            const entry = outputEntryForNode(history, 'save');
            if (!entry) throw new Error('The background-removal matte produced no frames.');
            const buffer = await comfyui.downloadImage(entry);
            const chunkVideo = path.join(matteDir, 'chunk-' + offset + '.mp4');
            fs.writeFileSync(chunkVideo, buffer);
            await comfyui.deleteOutputFile(entry, { history: pid }).catch(() => {});
            const chunkDir = ensureDir(path.join(matteDir, 'chunk-' + offset));
            await media.extractFrames(chunkVideo, chunkDir);
            const files = media.listFrames(chunkDir);
            for (let i = 0; i < cap; i += 1) {
                const file = files[i];
                if (!file) continue;
                fs.copyFileSync(path.join(chunkDir, file), path.join(matteDir, media.frameName(offset + i)));
            }
            try { fs.unlinkSync(chunkVideo); } catch { /* optional */ }
            try { fs.rmSync(chunkDir, { recursive: true, force: true }); } catch { /* optional */ }
        }
        return {
            method,
            dir: relative(project, matteDir),
            frames,
            width: Number(project.part.width) || 0,
            height: Number(project.part.height) || 0,
            hash: matteHash(project, method),
            createdAt: new Date().toISOString()
        };
    } finally {
        for (const name of uploaded) await comfyui.deleteInputFile(name).catch(() => {});
    }
}

// --- Silhouette / person ownership -------------------------------------------

function keypointsBBox(points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of points) {
        if (!point || !(point.c > 0.05)) continue;
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
    }
    if (!Number.isFinite(minX)) return null;
    return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

// Rasterise a coarse person silhouette from DWPose keypoints. Built at 1/4
// resolution (an assignment region, not a final boundary) and expanded back.
function capsuleSupport(keypoints, width, height, scale) {
    const s = Math.max(1, Math.round(scale) || 1);
    const sw = Math.max(1, Math.ceil(width / s));
    const sh = Math.max(1, Math.ceil(height / s));
    const small = new Uint8Array(sw * sh);
    const body = (keypoints || []).map((point) => ({
        x: (Number(point.x) || 0) / s,
        y: (Number(point.y) || 0) / s,
        c: point.c === undefined ? 1 : point.c
    }));
    const box = keypointsBBox(body);
    if (!box) return new Uint8Array(width * height);
    const personHeight = Math.max(8, box.height);
    const limbR = Math.max(1.2, personHeight * 0.075);
    const torsoR = Math.max(1.6, personHeight * 0.14);
    const headR = Math.max(1.8, personHeight * 0.13);
    const stamp = (cx, cy, radius) => {
        const r2 = radius * radius;
        const x0 = Math.max(0, Math.floor(cx - radius));
        const x1 = Math.min(sw - 1, Math.ceil(cx + radius));
        const y0 = Math.max(0, Math.floor(cy - radius));
        const y1 = Math.min(sh - 1, Math.ceil(cy + radius));
        for (let y = y0; y <= y1; y += 1) {
            for (let x = x0; x <= x1; x += 1) {
                const dx = x + 0.5 - cx;
                const dy = y + 0.5 - cy;
                if (dx * dx + dy * dy <= r2) small[y * sw + x] = 255;
            }
        }
    };
    const line = (a, b, radius) => {
        if (!a || !b) return;
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        const steps = Math.max(1, Math.ceil(length / Math.max(0.75, radius * 0.6)));
        for (let step = 0; step <= steps; step += 1) {
            const t = step / steps;
            stamp(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, radius);
        }
    };
    const at = (index) => {
        const point = body[index];
        return point && point.c > 0.05 ? point : null;
    };
    const pairs = [
        [1, 2, limbR], [1, 5, limbR], [2, 3, limbR], [3, 4, limbR],
        [5, 6, limbR], [6, 7, limbR], [1, 8, torsoR], [1, 11, torsoR],
        [8, 9, limbR], [9, 10, limbR], [11, 12, limbR], [12, 13, limbR],
        [8, 11, torsoR], [2, 11, torsoR], [5, 8, torsoR], [0, 1, limbR]
    ];
    for (const [a, b, radius] of pairs) line(at(a), at(b), radius);
    const head = [at(0), at(14), at(15), at(16), at(17)].filter(Boolean);
    if (head.length) {
        const cx = head.reduce((sum, point) => sum + point.x, 0) / head.length;
        const cy = head.reduce((sum, point) => sum + point.y, 0) / head.length;
        stamp(cx, cy, headR);
        for (const point of head) stamp(point.x, point.y, headR * 0.55);
    }
    for (const point of body.slice(18)) {
        if (point.c > 0.05) stamp(point.x, point.y, limbR * 0.8);
    }
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
        const sy = Math.min(sh - 1, Math.floor(y / s));
        const row = sy * sw;
        for (let x = 0; x < width; x += 1) {
            if (small[row + Math.min(sw - 1, Math.floor(x / s))]) out[y * width + x] = 255;
        }
    }
    return out;
}

function expandBox(box, width, height, fraction) {
    const padX = Math.max(2, Math.round(box.width * fraction));
    const padY = Math.max(2, Math.round(box.height * fraction));
    const x = Math.max(0, Math.floor(box.x - padX));
    const y = Math.max(0, Math.floor(box.y - padY));
    return {
        x,
        y,
        width: Math.max(1, Math.min(width - x, Math.ceil(box.width + padX * 2))),
        height: Math.max(1, Math.min(height - y, Math.ceil(box.height + padY * 2)))
    };
}

function framePerson(keypointFrames, trackId, frame) {
    const entry = keypointFrames && keypointFrames[frame];
    if (!entry) return null;
    return (entry.people || []).find((item) => item.trackId === trackId) || null;
}

function knownPerson(keypointFrames, trackId, frame) {
    for (let index = frame; index >= 0; index -= 1) {
        const person = framePerson(keypointFrames, trackId, index);
        if (person) return person;
    }
    return null;
}

function personPoints(person) {
    if (!person) return null;
    return (person.body || []).concat(person.leftHand || [], person.rightHand || []);
}

// Build one raw mask per selected person. The matte supplies the silhouette
// (hair, clothing, limbs); the DWPose capsules only decide which matte pixels
// belong to which person. Without the matte the capsules are the mask.
async function buildRawMasks(project, matte, method, keypointFrames) {
    const width = Number(project.part.width) || (matte && matte.width) || 0;
    const height = Number(project.part.height) || (matte && matte.height) || 0;
    const frames = Math.max(1, Number(project.part.frames) || (matte && matte.frames) || 1);
    const people = selectedPeople(project);
    const warnings = [];
    const result = {};
    const matteDir = matte && matte.dir ? projectPath(project, matte.dir) : null;
    for (const person of people) {
        const track = personTrack(project, person);
        if (!track) {
            warnings.push(person.label + ' is not linked to a detected person; skip it or detect again.');
            continue;
        }
        const dir = ensureDir(path.join(characterState.projectDir(project.id), 'segmentation', person.id));
        result[person.id] = {
            dir: relative(project, dir),
            width,
            height,
            frames,
            trackId: track.id,
            editedFrames: []
        };
    }
    const entries = people
        .map((person) => ({ person, meta: result[person.id] }))
        .filter((entry) => entry.meta);
    if (!entries.length) return { people: result, warnings };

    for (let frame = 0; frame < frames; frame += 1) {
        let matteValues = null;
        if (method === 'birefnet' && matteDir) {
            const file = path.join(matteDir, media.frameName(frame));
            if (fs.existsSync(file)) {
                try { matteValues = (await media.readMask(file)).values; } catch { matteValues = null; }
            }
        }
        const supports = entries.map((entry) => {
            const known = knownPerson(keypointFrames, entry.meta.trackId, frame);
            const points = personPoints(known);
            const box = (framePerson(keypointFrames, entry.meta.trackId, frame) || known || {}).bbox;
            if (points) return { support: capsuleSupport(points, width, height, SUPPORT_SCALE), box: (known && known.bbox) || box || null };
            if (box) {
                const region = expandBox(box, width, height, 0.08);
                const support = new Uint8Array(width * height);
                for (let y = region.y; y < region.y + region.height; y += 1) {
                    support.fill(255, y * width + region.x, y * width + region.x + region.width);
                }
                return { support, box };
            }
            return { support: null, box: null };
        });
        const centres = supports.map(({ box }) => box
            ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
            : null);
        for (let index = 0; index < entries.length; index += 1) {
            const { support, box } = supports[index];
            const values = new Uint8Array(width * height);
            if (matteValues && support) {
                const centre = centres[index];
                for (let i = 0; i < values.length; i += 1) {
                    if (matteValues[i] < 128 || support[i] < 128) continue;
                    let owner = index;
                    if (centre) {
                        const x = i % width;
                        const y = Math.floor(i / width);
                        let bestDistance = Math.hypot(x - centre.x, y - centre.y);
                        for (let other = 0; other < supports.length; other += 1) {
                            if (other === index || !supports[other].support || supports[other].support[i] < 128) continue;
                            const otherCentre = centres[other];
                            if (!otherCentre) continue;
                            const distance = Math.hypot(x - otherCentre.x, y - otherCentre.y);
                            if (distance < bestDistance || (distance === bestDistance && other < owner)) {
                                bestDistance = distance;
                                owner = other;
                            }
                        }
                    }
                    if (owner !== index) continue;
                    values[i] = 255;
                }
            }
            if (!values.some((value) => value >= 128)) {
                if (support) {
                    values.set(support);
                } else if (box) {
                    const region = expandBox(box, width, height, 0.08);
                    for (let y = region.y; y < region.y + region.height; y += 1) {
                        values.fill(255, y * width + region.x, y * width + region.x + region.width);
                    }
                }
            }
            const out = path.join(characterState.projectDir(project.id), result[entries[index].person.id].dir, media.frameName(frame));
            media.writeMask(out, values, width, height);
        }
    }
    return { people: result, warnings };
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

async function exportPerson(project, person, meta) {
    const settings = selectionSettings(project);
    const sourceDir = projectPath(project, meta.dir);
    const frames = Math.max(1, Number(meta.frames) || 1);
    const width = Number(meta.width) || 0;
    const height = Number(meta.height) || 0;
    const accumulated = [];
    for (let frame = 0; frame < frames; frame += 1) {
        const file = path.join(sourceDir, media.frameName(frame));
        if (!fs.existsSync(file)) {
            accumulated.push(media.emptyMask(width, height));
            continue;
        }
        accumulated.push((await media.readMask(file)).values);
    }
    const refined = refineMaskFrames(accumulated, width, height, settings);
    const finalDir = ensureDir(path.join(characterState.projectDir(project.id), 'segmentation', person.id, 'final'));
    refined.forEach((values, frame) => {
        media.writeMask(path.join(finalDir, media.frameName(frame)), values, width, height);
    });
    const videoPath = path.join(characterState.projectDir(project.id), 'segmentation', person.id, person.id + '-mask.mp4');
    await media.encodeFrames(finalDir, videoPath, Number(project.part.fps) || media.FPS);
    return {
        dir: meta.dir,
        finalDir: relative(project, finalDir),
        video: relative(project, videoPath),
        width,
        height,
        frames,
        settings: Object.assign({}, settings),
        editedFrames: meta.editedFrames || []
    };
}

async function finalize(project, method, matte, fullHash, rawHash, peopleMeta, warnings, onStage) {
    onStage('Refining the person masks');
    const exported = {};
    for (const person of selectedPeople(project)) {
        const meta = peopleMeta[person.id];
        if (!meta) continue;
        const out = await exportPerson(project, person, meta);
        exported[person.id] = Object.assign({}, meta, out, { hash: fullHash, rawHash });
    }
    return {
        method,
        matte,
        hash: fullHash,
        rawHash,
        people: exported,
        warnings,
        createdAt: new Date().toISOString()
    };
}

async function generate(project, options = {}) {
    const onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
    const tracks = (project.selection && project.selection.tracks) || [];
    if (!tracks.length) throw new Error('Detect people before building masks.');
    const people = selectedPeople(project);
    if (!people.length) throw new Error('Select at least one detected person first.');
    for (const person of people) {
        if (!personTrack(project, person)) {
            throw new Error(person.label + ' is not linked to a detected person. Select a detected person again.');
        }
    }
    const info = options.info || await comfyui.getObjectInfo().catch(() => null);
    const status = availability(info);
    const requested = options.method
        || (project.engineSettings && project.engineSettings.wanAnimate && project.engineSettings.wanAnimate.segmenter)
        || 'auto';
    const method = normalizeMethod(requested, status.matte);
    const rawHash = hashFor(project, method, false);
    const fullHash = hashFor(project, method, true);
    const previous = project.segmentation && project.segmentation.method === method ? project.segmentation : null;
    const keypoints = loadKeypoints(project);
    if (!keypoints) throw new Error('The person tracking data is missing. Detect people again.');
    const keypointFrames = keypoints.map((frame) => ({
        frame: frame.frame,
        people: (frame.people || []).map((person) => ({
            trackId: person.trackId,
            bbox: person.bbox,
            body: person.body || [],
            leftHand: person.leftHand || [],
            rightHand: person.rightHand || []
        }))
    }));

    let matte = previous && previous.matte ? previous.matte : null;
    const matteFile = matte ? projectPath(project, matte.dir) : null;
    const needsMatte = method === 'birefnet' &&
        (!matte || matte.hash !== matteHash(project, method) || !matteFile || !fs.existsSync(matteFile));
    if (needsMatte) {
        onStage('Removing the background to build person silhouettes');
        matte = await buildMatte(project, method, options);
    }
    if (method !== 'birefnet') matte = null;

    const missingRaw = !previous || people.some((person) => {
        const meta = previous.people ? previous.people[person.id] : null;
        if (!meta || meta.trackId !== person.selectionId || meta.rawHash !== rawHash) return true;
        const dir = projectPath(project, meta.dir);
        if (!dir || !fs.existsSync(dir)) return true;
        return !fs.existsSync(path.join(dir, media.frameName(0)));
    });
    if (needsMatte || missingRaw) {
        onStage('Building person masks');
        const built = await buildRawMasks(project, matte, method, keypointFrames);
        const merged = {};
        for (const person of people) {
            const meta = built.people[person.id];
            if (!meta) continue;
            const prior = previous && previous.people ? previous.people[person.id] : null;
            meta.rawHash = rawHash;
            meta.hash = fullHash;
            meta.editedFrames = prior && prior.trackId === person.selectionId ? (prior.editedFrames || []) : [];
            merged[person.id] = meta;
        }
        return finalize(project, method, matte, fullHash, rawHash, merged, built.warnings, onStage);
    }

    const stale = people.some((person) => {
        const meta = previous.people ? previous.people[person.id] : null;
        if (!meta || meta.hash !== fullHash) return true;
        const video = projectPath(project, meta.video);
        return !video || !fs.existsSync(video);
    });
    if (!stale) {
        return {
            method,
            matte,
            hash: fullHash,
            rawHash,
            people: previous.people,
            warnings: previous.warnings || [],
            createdAt: previous.createdAt || new Date().toISOString()
        };
    }
    return finalize(project, method, matte, fullHash, rawHash, previous.people, previous.warnings || [], onStage);
}

module.exports = {
    VERSION,
    DEFAULT_MODEL,
    MATTE_NODES,
    availability,
    normalizeMethod,
    matteHash,
    hashFor,
    loadKeypoints,
    matteGraph,
    buildMatte,
    capsuleSupport,
    buildRawMasks,
    refineMaskFrames,
    exportPerson,
    generate,
    selectedPeople,
    personTrack
};
