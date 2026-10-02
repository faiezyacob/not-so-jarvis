/* ============================================
   JARVIS — Shared Scene / Location Library tests
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-scenes-'));
process.env.SCENES_PATH = path.join(tmp, 'scenes.json');
process.env.UGC_STATE_PATH = path.join(tmp, 'ugc-state.json');
process.env.CHARACTER_PRESETS_PATH = path.join(tmp, 'characters.json');
process.env.CHARACTER_CONTEXT_PATH = path.join(tmp, 'character-context.json');
process.env.UGC_PRODUCTS_PATH = path.join(tmp, 'ugc-products.json');

// Seed one legacy UGC project with a custom environment so migration is
// exercised without touching real runtime data.
fs.writeFileSync(process.env.UGC_STATE_PATH, JSON.stringify({
    projects: {
        convo1: {
            id: 'ugc_1',
            conversationId: 'convo1',
            environment: { id: 'rooftop-loft', label: 'Rooftop Loft', description: 'a sunlit rooftop loft with plants' },
            scenes: []
        }
    }
}), 'utf-8');

const sceneLibrary = require('../services/scene-library');
const studio = require('../services/ugc/studio');
const creatorStudio = require('../services/creator-studio');

test('built-in scenes retain the original UGC ids, names and descriptions', () => {
    const bathroom = sceneLibrary.get('bathroom');
    assert.ok(bathroom);
    assert.equal(bathroom.name, 'Bathroom');
    assert.equal(bathroom.description, 'a clean, modern bathroom');
    assert.ok(sceneLibrary.get('cafe'));
    assert.equal(sceneLibrary.get('cafe').name, 'Caf\u00e9');
    assert.ok(sceneLibrary.get('modern-apartment'));
});

test('existing UGC environments are migrated into the shared library', () => {
    const migrated = sceneLibrary.get('rooftop-loft');
    assert.ok(migrated, 'the custom UGC environment is available');
    assert.equal(migrated.name, 'Rooftop Loft');
    assert.equal(migrated.description, 'a sunlit rooftop loft with plants');
});

test('buildSceneContext composes summary, structured detail and prompt once', () => {
    const context = sceneLibrary.buildSceneContext({
        id: 'loft',
        name: 'Design Loft',
        category: 'home',
        description: 'a bright industrial loft',
        environment: { furniture: 'a low linen sofa', materials: 'concrete and pale oak' },
        lighting: { description: 'soft window light', timeOfDay: 'morning' },
        atmosphere: ['calm', 'airy']
    });
    assert.equal(context.summary, 'a bright industrial loft');
    assert.match(context.prompt, /bright industrial loft/);
    assert.match(context.prompt, /furniture: a low linen sofa/);
    assert.match(context.prompt, /lighting: soft window light \(morning\)/);
    assert.match(context.prompt, /atmosphere: calm, airy/);
});

test('buildSceneContext accepts free-text and absent scenes safely', () => {
    assert.equal(sceneLibrary.buildSceneContext('a cosy corner').summary, 'a cosy corner');
    assert.equal(sceneLibrary.buildSceneContext(null).prompt, '');
});

test('scenes resolve by id, name and free-text mention', () => {
    assert.equal(sceneLibrary.resolve('cafe').id, 'cafe');
    assert.equal(sceneLibrary.resolve('Caf\u00e9').id, 'cafe');
    assert.equal(sceneLibrary.detectFromText('a modern bathroom').id, 'bathroom');
    assert.equal(sceneLibrary.detectFromText('working out at the gym').id, 'gym');
});

test('an activity recommends compatible scenes without blocking explicit choices', () => {
    const recommended = sceneLibrary.recommendForActivity('taking-selfie', { limit: 8 }).map((s) => s.id);
    assert.ok(recommended.includes('bedroom'), 'bedroom is recommended for a selfie');
    assert.ok(recommended.includes('cafe'), 'cafe is recommended for a selfie');
    // An explicit selection is always resolvable regardless of recommendations.
    assert.equal(sceneLibrary.resolve('airport').id, 'airport');
});

test('selectSceneForActivity is deterministic for a given rng', () => {
    const first = sceneLibrary.selectSceneForActivity('cooking', { rng: () => 0.42 });
    const second = sceneLibrary.selectSceneForActivity('cooking', { rng: () => 0.42 });
    assert.ok(first && first.id);
    assert.equal(first.id, second.id);
    const cookingScenes = sceneLibrary.recommendForActivity('cooking', { limit: 12 }).map((s) => s.id);
    assert.ok(cookingScenes.includes('kitchen'), 'cooking recommends the kitchen');
    assert.ok(cookingScenes.includes(first.id), 'the pick is one of the recommendations');
});

test('scenes can be created, updated, duplicated and removed', () => {
    const created = sceneLibrary.create({ name: 'Test Nook', category: 'home', description: 'a quiet nook' });
    assert.ok(created.id);
    const updated = sceneLibrary.update(created.id, { description: 'a very quiet nook' });
    assert.equal(updated.description, 'a very quiet nook');
    const copy = sceneLibrary.duplicate(created.id);
    assert.notEqual(copy.id, created.id);
    assert.match(copy.name, /copy/);
    assert.equal(sceneLibrary.remove(created.id), true);
    assert.equal(sceneLibrary.get(created.id), null);
    assert.equal(sceneLibrary.remove(copy.id), true);
});

test('UGC Studio Environment reads from the shared Scene library', () => {
    const project = studio.normalizeProject({
        id: 'ugc_test',
        conversationId: 'convo_test',
        request: 'a UGC video',
        stage: 'creative_direction',
        brief: { duration: 15 },
        environment: { id: 'bathroom', label: 'Bathroom', description: 'a clean, modern bathroom' }
    });
    studio.selectEnvironment(project, 'gym');
    assert.equal(project.environment.id, 'gym');
    assert.equal(project.environment.description, 'an energetic gym or fitness studio');
    const options = studio.listEnvironments();
    assert.ok(options.some((e) => e.id === 'bathroom'));
    assert.ok(options.some((e) => e.id === 'rooftop-loft'));
});

test('UGC Studio preserves a legacy custom environment', () => {
    const project = studio.normalizeProject({ id: 'ugc_c', conversationId: 'convo_c', stage: 'creative_direction', brief: {} });
    studio.selectEnvironment(project, 'custom', 'a sunlit bathroom');
    assert.equal(project.environment.id, 'custom');
    assert.equal(project.environment.description, 'a sunlit bathroom');
});

test('Creator Studio resolves a shared Scene into its shot environment', () => {
    const character = {
        id: 'char_scene_test',
        name: 'Nora',
        identity: { identityText: 'a woman with short dark hair', age: 29 },
        identityText: 'a woman with short dark hair'
    };
    const content = creatorStudio.buildContentDefaults(
        { sceneId: 'cafe', concept: 'a quick update', contentType: 'talking' },
        character,
        null
    );
    assert.equal(content.sceneId, 'cafe');
    assert.equal(content.scene, 'a warm neighbourhood caf\u00e9');
});

test('Creator Studio keeps free-text scenes when no shared Scene is selected', () => {
    const character = { id: 'char_scene_test2', name: 'Iris', identity: { identityText: 'a woman', age: 30 }, identityText: 'a woman' };
    const content = creatorStudio.buildContentDefaults(
        { scene: 'a sunny balcony', concept: 'a quick update' },
        character,
        null
    );
    assert.equal(content.sceneId, '');
    assert.equal(content.scene, 'a sunny balcony');
});

test.after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});
