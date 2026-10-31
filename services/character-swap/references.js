/* ============================================
   JARVIS — Character Swap references
   View classification, structured identity
   descriptions and orientation-aware ordering.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');

const providers = require('../../server/providers');
const configManager = require('../../server/config-manager');
const companionExtraction = require('../companion/extraction');
const media = require('./media');

const CLASSIFY_SYSTEM =
    'You classify character reference photos for a video character-replacement tool. ' +
    'Reply with strict JSON only. Never describe the background, lighting, pose or camera.';

const CLASSIFY_USER =
    'For each image, in order, return a JSON array. Each item: ' +
    '{"view":"front|side|back|close_up|full_body|other","facing":"front|side|back|three_quarter",' +
    '"fullBody":true|false,"notes":""}. ' +
    'front means the face is visible and the person faces the camera. side means a profile. ' +
    'back means the person faces away. close_up means a head-and-shoulders portrait. ' +
    'full_body means head to toe is visible. notes is a short factual note about that photo.';

const DESCRIBE_SYSTEM =
    'You describe one fictional or consented character for a video model. ' +
    'Describe appearance only, never pose, expression, action, camera or background. ' +
    'Reply with strict JSON only, no prose.';

const DESCRIBE_USER =
    'These pictures show one person from several views. Return strict JSON with exactly these keys: ' +
    '{"identitySummary":"one short paragraph under 90 words covering face, hair, skin, body and distinguishing features",' +
    '"age":"","gender":"","skin":"","face":"","eyes":"","eyebrows":"","hair":"","build":"",' +
    '"clothing":"top to bottom including colours and materials","footwear":"","accessories":"",' +
    '"distinguishing":"","unlike":[]}. ' +
    'unlike is a list of common carry-over items the ORIGINAL performer might have but this character does not, ' +
    'from: glasses, sunglasses, rings, necklace, bracelet, watch, earrings, hat, headphones, tattoos, ' +
    'dreadlocks, braids, long hair. Only include an item when the pictures clearly show the character does not have it. ' +
    'Name colours and materials. Study close-ups for small details. Use short factual phrases; leave a value empty when not visible.';

const ORIENT_SYSTEM =
    'You classify the orientation of one person in a video frame. Reply with strict JSON only.';
const ORIENT_USER =
    'Return {"facing":"front|side|back|three_quarter"} for the main person in this image. ' +
    'front = facing the camera, back = facing away, side = profile, three_quarter = angled.';

const LOOK_SYSTEM =
    'You describe a performer\'s clothing in a video frame. Reply with strict JSON only.';
const LOOK_USER =
    'Return {"look":"in ..."} describing the main person\'s visible clothing in at most eight words, ' +
    'starting with "in", for example "in a red hoodie and blue jeans". No sentence.';

// Wan Animate 2 generates the background from text, so the exact source scene
// is captured once and reused as the Background section of the enhanced prompt.
// The caption ignores people and action on purpose: the preservation clause
// names the target, and the performance video owns all motion.
const SCENE_SYSTEM =
    'You describe the background of a video frame for a character-replacement model. ' +
    'Describe only the environment: location, set, architecture, furniture, props, materials, ' +
    'lighting, colour palette and camera framing. Never identify, describe, count or judge people; ' +
    'if people are present, say only that the existing people remain unchanged. ' +
    'Never describe action, motion or emotion. Reply with strict JSON only, no prose.';

const SCENE_USER =
    'Return strict JSON with exactly these keys: ' +
    '{"summary":"one factual paragraph under 70 words describing the location, set, props, lighting, ' +
    'colours and camera framing; ignore all people and action",' +
    '"viewpoint":"one short phrase for the camera angle and framing, for example front three-quarter medium shot",' +
    '"peoplePresent":true|false,"otherPeople":"one short factual phrase about any non-target people, or an empty string"}. ' +
    'Do not mention the foreground subject.';

function currentModel(ctx) {
    if (ctx && ctx.provider && ctx.model) return { provider: ctx.provider, model: ctx.model };
    const config = configManager.getConfig();
    return { provider: config.provider || 'ollama', model: config.model || '' };
}

function imageBase64(file) {
    return fs.readFileSync(file).toString('base64');
}

async function askVision(files, system, user, ctx, options = {}) {
    const { provider, model } = currentModel(ctx);
    const images = (Array.isArray(files) ? files : []).map(imageBase64);
    const raw = await providers.chat(provider, [
        { role: 'system', content: system },
        { role: 'user', content: user, images }
    ], model, { temperature: 0, think: false });
    if (options.array) {
        const start = raw.indexOf('[');
        const end = raw.lastIndexOf(']');
        if (start >= 0 && end > start) {
            try {
                const parsed = JSON.parse(raw.slice(start, end + 1));
                if (Array.isArray(parsed)) return parsed;
            } catch {
                // fall through to the object reader
            }
        }
        const wrapped = companionExtraction.extractJsonObject(raw);
        return wrapped && Array.isArray(wrapped.references) ? wrapped.references : [];
    }
    return companionExtraction.extractJsonObject(raw);
}

function clean(value, limit) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/\s+/g, ' ').trim().slice(0, limit || 240);
}

function cleanList(value) {
    return (Array.isArray(value) ? value : [])
        .map((item) => clean(item, 80).toLowerCase())
        .filter(Boolean)
        .slice(0, 8);
}

function normalizeDescription(value) {
    const src = value && typeof value === 'object' ? value : {};
    return {
        identitySummary: clean(src.identitySummary, 800),
        age: clean(src.age, 80),
        gender: clean(src.gender, 40),
        skin: clean(src.skin, 160),
        face: clean(src.face, 200),
        eyes: clean(src.eyes, 120),
        eyebrows: clean(src.eyebrows, 120),
        hair: clean(src.hair, 200),
        build: clean(src.build, 120),
        clothing: clean(src.clothing, 400),
        footwear: clean(src.footwear, 160),
        accessories: clean(src.accessories, 240),
        distinguishing: clean(src.distinguishing, 240),
        unlike: cleanList(src.unlike)
    };
}

function normalizeScene(value) {
    const src = value && typeof value === 'object' ? value : {};
    return {
        summary: clean(src.summary, 500),
        viewpoint: clean(src.viewpoint, 80),
        peoplePresent: src.peoplePresent === true,
        otherPeople: clean(src.otherPeople, 200)
    };
}

function normalizeRole(value) {    const role = String(value || '').toLowerCase().replace(/\s+/g, '_');
    if (role === 'closeup' || role === 'close-up' || role === 'face') return 'close_up';
    if (role === 'full' || role === 'full-body') return 'full_body';
    if (['front', 'side', 'back', 'close_up', 'full_body'].includes(role)) return role;
    return 'other';
}

function normalizeFacing(value) {
    const facing = String(value || '').toLowerCase();
    if (['front', 'side', 'back'].includes(facing)) return facing;
    return 'front';
}

async function classify(files, ctx) {
    if (!files.length) return [];
    const items = await askVision(files, CLASSIFY_SYSTEM, CLASSIFY_USER, ctx, { array: true });
    return files.map((file, index) => {
        const item = items[index] && typeof items[index] === 'object' ? items[index] : {};
        return {
            file,
            role: normalizeRole(item.view || item.role),
            facing: normalizeFacing(item.facing),
            fullBody: item.fullBody === true || item.view === 'full_body',
            notes: clean(item.notes, 200)
        };
    });
}

async function describe(files, ctx) {
    if (!files.length) return null;
    const value = await askVision(files, DESCRIBE_SYSTEM, DESCRIBE_USER, ctx);
    if (!value || typeof value !== 'object') return null;
    const description = normalizeDescription(value);
    const hasContent = Object.keys(description).some((key) => {
        if (key === 'unlike') return description.unlike.length > 0;
        return Boolean(description[key]);
    });
    return hasContent ? description : null;
}

async function describeScene(files, ctx) {
    if (!Array.isArray(files) || !files.length) return null;
    const value = await askVision(files, SCENE_SYSTEM, SCENE_USER, ctx);
    if (!value || typeof value !== 'object') return null;
    const scene = normalizeScene(value);
    return scene.summary ? scene : null;
}

async function cropForOrientation(partPath, anchor, maskPath, outDir) {
    const framePath = path.join(outDir, 'orientation-' + anchor.frame + '.png');
    await media.extractFrame(partPath, anchor.frame, framePath);
    const mask = await media.readMask(maskPath);
    const box = media.bbox(mask.values, mask.width, mask.height);
    if (!box) return framePath;
    const padX = Math.round(box.width * 0.15);
    const padY = Math.round(box.height * 0.15);
    const x = Math.max(0, box.x - padX);
    const y = Math.max(0, box.y - padY);
    const w = Math.max(2, Math.min(mask.width - x, box.width + padX * 2));
    const h = Math.max(2, Math.min(mask.height - y, box.height + padY * 2));
    const cropPath = path.join(outDir, 'orientation-crop-' + anchor.frame + '.png');
    await media.run([
        '-hide_banner', '-y', '-i', framePath,
        '-vf', 'crop=' + w + ':' + h + ':' + x + ':' + y, cropPath
    ], { code: 'character_swap_crop_failed' });
    return cropPath;
}

async function orientation(cropPath, ctx) {
    try {
        const value = await askVision([cropPath], ORIENT_SYSTEM, ORIENT_USER, ctx);
        return normalizeFacing(value && value.facing);
    } catch {
        return 'front';
    }
}

async function look(cropPath, ctx) {
    try {
        const value = await askVision([cropPath], LOOK_SYSTEM, LOOK_USER, ctx);
        const text = clean(value && value.look, 120);
        return text ? (/^(?:in|wearing)\b/i.test(text) ? text : 'in ' + text) : '';
    } catch {
        return '';
    }
}

async function generateSheet(sourceAbsPath, outputPath, ctx, options = {}) {
    const imageGenerator = require('../image-generator');
    const instruction =
        'Character reference sheet on a plain neutral studio background. The same exact person, ' +
        'shown four times: full-body front view, three-quarter view, full-body back view, and a face close-up. ' +
        'Keep the identical face, hair, skin tone, body proportions and clothing from the source image. ' +
        'Even, soft studio lighting. No text, no props, no extra people, no collage borders. ' +
        (options.extra ? String(options.extra).slice(0, 500) : '');
    const result = await imageGenerator.editImage(sourceAbsPath, instruction, {
        conversationId: options.conversationId || null,
        label: 'character swap reference sheet',
        kind: 'image_edit',
        hidden: true
    });
    const generatedDir = process.env.GENERATED_DIR || path.join(__dirname, '..', '..', 'data', 'generated');
    const source = path.join(generatedDir, result && result.filename ? result.filename : '');
    if (!source || !fs.existsSync(source)) throw new Error('The reference sheet was generated but its file could not be found.');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.copyFileSync(source, outputPath);
    return outputPath;
}

module.exports = {
    CLASSIFY_SYSTEM,
    DESCRIBE_SYSTEM,
    SCENE_SYSTEM,
    clean,
    normalizeDescription,
    normalizeScene,
    normalizeRole,
    normalizeFacing,
    classify,
    describe,
    describeScene,
    cropForOrientation,
    orientation,
    look,
    generateSheet
};
