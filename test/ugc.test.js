/* ============================================
   JARVIS — UGC Studio tests
   Covers intent detection, the product library,
   the workflow stage machine, brief/script/scene
   deterministic fallbacks, continuity, natural
   editing, the reference request, and the Director
   handoff. The LLM seam is stubbed and the state
   stores point at temp files so nothing in data/
   is touched.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ugc-'));
process.env.UGC_STATE_PATH = path.join(tmpDir, 'ugc-state.json');
process.env.UGC_PRODUCTS_PATH = path.join(tmpDir, 'ugc-products.json');
process.env.CHARACTER_PRESETS_PATH = path.join(tmpDir, 'character-presets.json');
process.env.PLAYGROUND_STATE_PATH = path.join(tmpDir, 'playground-state.json');

// Stub the LLM seam: every classifier/author call fails fast so the studio's
// deterministic fallbacks run. Individual tests override this to exercise the
// LLM path.
const providers = require('../server/providers');
providers.chat = async () => { throw new Error('offline (test)'); };

const studio = require('../services/ugc/studio');
const products = require('../services/ugc/products');
const catalog = require('../services/ugc/catalog');
const prompts = require('../services/ugc/prompts');
const characterPresets = require('../services/character-presets');

function conversationId(name) {
    return 'ugc-test-' + name + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
}

// A fully-populated project, built deterministically without the LLM.
function baseProject(overrides = {}) {
    const project = studio.normalizeProject(Object.assign({
        id: 'ugc_test',
        conversationId: conversationId('base'),
        status: 'active',
        stage: 'brief',
        request: 'Create a 15-second vertical UGC video for my skincare serum',
        product: { id: 'p1', name: 'Glow Serum', brand: 'Lumine', description: 'a lightweight vitamin serum', keyBenefits: ['hydrating'], claimsToAvoid: ['cures acne'] },
        creator: { characterId: null, source: 'random', name: 'Maya', identity: 'a 28-year-old woman with shoulder-length dark hair', appearance: 'warm brown eyes', hair: 'shoulder-length dark hair' },
        environment: { id: 'bathroom', label: 'Bathroom', description: 'a clean, modern bathroom' },
        contentType: { id: 'product-demo', label: 'Product Demo' },
        outfit: { packId: 'casual-everyday', label: 'Casual Everyday', outfit: 'a fitted white t-shirt and blue jeans' },
        brief: { objective: 'Show the morning routine', contentType: 'product-demo', platform: 'tiktok', duration: 15, aspectRatio: '9:16', tone: 'natural', keyMessage: 'Hydration that fits your morning', callToAction: 'Try it this week' }
    }, overrides));
    project.stage = studio.nextSetupStage(project);
    return project;
}

// --- Intent detection --------------------------------------------------------

test('detectUgcIntent recognises UGC requests', () => {
    assert.equal(studio.detectUgcIntent('Create a UGC video for my skincare product'), true);
    assert.equal(studio.detectUgcIntent('Make a TikTok ad for my brand'), true);
    assert.equal(studio.detectUgcIntent('Create an Instagram product video'), true);
    assert.equal(studio.detectUgcIntent('Make a product testimonial'), true);
    assert.equal(studio.detectUgcIntent('Create an unboxing video'), true);
    assert.equal(studio.detectUgcIntent('Create a product demonstration'), true);
    assert.equal(studio.detectUgcIntent('Make a creator-style advertisement'), true);
    assert.equal(studio.detectUgcIntent('Create lifestyle content for my brand'), true);
    assert.equal(studio.detectUgcIntent('Generate a skincare routine video featuring my product'), true);
    assert.equal(studio.detectUgcIntent('Write me a UGC script'), true);
});

test('detectUgcIntent ignores ordinary requests', () => {
    assert.equal(studio.detectUgcIntent('Generate a video of a cat'), false);
    assert.equal(studio.detectUgcIntent('Create an image of a forest'), false);
    assert.equal(studio.detectUgcIntent('What is image generation?'), false);
    assert.equal(studio.detectUgcIntent('make it rain'), false);
    assert.equal(studio.detectUgcIntent(''), false);
});

test('a UGC script request is detected as script-only', () => {
    assert.equal(studio.isScriptOnlyRequest('Write me a UGC script'), true);
    assert.equal(studio.isScriptOnlyRequest('Create a UGC video for my product'), false);
});

// --- Catalog -----------------------------------------------------------------

test('catalog exposes the content types, environments and platforms', () => {
    assert.ok(catalog.CONTENT_TYPES.length >= 10);
    assert.ok(catalog.ENVIRONMENTS.length >= 10);
    assert.ok(catalog.getContentType('product-demo'));
    assert.equal(catalog.getEnvironment('does-not-exist'), null);
    assert.equal(catalog.detectEnvironment('in a modern bathroom'), 'bathroom');
    assert.equal(catalog.detectContentType('an unboxing video'), 'unboxing');
    assert.equal(catalog.detectPlatform('post it on TikTok'), 'tiktok');
});

// --- Product library ---------------------------------------------------------

test('the product library creates, updates and removes products', () => {
    const created = products.create({ name: 'Test Serum', brand: 'Acme', keyBenefits: 'hydrating, lightweight', referenceImages: ['/images/abc.png', 'http://evil/x.png'] });
    assert.ok(created.id);
    assert.deepEqual(created.keyBenefits, ['hydrating', 'lightweight']);
    // Remote URLs are dropped; only local images survive.
    assert.deepEqual(created.referenceImages, ['/images/abc.png']);

    const updated = products.update(created.id, { description: 'A daily serum.' });
    assert.equal(updated.description, 'A daily serum.');

    assert.equal(products.findByName('test serum').id, created.id);
    assert.equal(products.remove(created.id), true);
    assert.equal(products.get(created.id), null);
});

test('a product with no name is rejected', () => {
    assert.throws(() => products.create({ brand: 'No Name' }), /name/);
});

// --- Project lifecycle -------------------------------------------------------

test('createProject extracts a heuristic brief and asks for the product first', async () => {
    const project = await studio.createProject({
        conversationId: conversationId('create'),
        message: 'Create a 15-second vertical UGC video for my Glow Serum. A young woman demonstrates her morning routine.',
        provider: 'ollama', model: ''
    });
    assert.equal(project.brief.duration, 15);
    assert.equal(project.brief.aspectRatio, '9:16');
    // No product in the library yet -> product selection is the next step.
    assert.equal(project.stage, studio.STAGES.PRODUCT_SELECTION);
    assert.equal(project.status, studio.STATUS.ACTIVE);
});

test('nextSetupStage walks product -> creator -> creative_direction -> brief', () => {
    const project = studio.normalizeProject({ conversationId: conversationId('setup'), status: 'active' });
    assert.equal(studio.nextSetupStage(project), studio.STAGES.PRODUCT_SELECTION);
    project.product = { name: 'Serum' };
    assert.equal(studio.nextSetupStage(project), studio.STAGES.CREATOR_SELECTION);
    project.creator = { name: 'Maya' };
    assert.equal(studio.nextSetupStage(project), studio.STAGES.CREATIVE_DIRECTION);
    project.contentType = { id: 'product-demo', label: 'Product Demo' };
    project.environment = { id: 'bathroom', label: 'Bathroom', description: 'a bathroom' };
    project.outfit = { packId: 'casual-everyday', label: 'Casual', outfit: 'jeans and a tee' };
    assert.equal(studio.nextSetupStage(project), studio.STAGES.BRIEF);
});

test('selections advance the stage and persist to disk', () => {
    const id = conversationId('selections');
    const project = studio.normalizeProject({ conversationId: id, status: 'active', stage: 'product_selection' });
    const product = products.create({ name: 'Selection Serum' });
    studio.save(project);
    studio.selectProduct(project, product.id);
    assert.equal(project.stage, studio.STAGES.CREATOR_SELECTION);

    const preset = characterPresets.create({ name: 'Maya', identity: 'a woman with dark hair', appearance: 'warm eyes', hair: 'dark hair' });
    studio.selectCreator(project, preset.id);
    assert.equal(project.creator.characterId, preset.id);
    assert.equal(project.stage, studio.STAGES.CREATIVE_DIRECTION);

    studio.selectContentType(project, 'product-demo');
    studio.selectEnvironment(project, 'bathroom');
    studio.selectOutfit(project, 'casual-everyday');
    assert.equal(project.stage, studio.STAGES.BRIEF);

    // Reload from disk and confirm the project survived.
    const reloaded = studio.getProject(id);
    assert.equal(reloaded.product.name, 'Selection Serum');
    assert.equal(reloaded.creator.characterId, preset.id);
    assert.ok(reloaded.outfit.outfit.length > 0);
});

test('random creator is generated and outfit packs resolve to a concrete outfit', () => {
    const project = baseProject({ creator: null, outfit: null });
    studio.randomCreator(project, { appearance: 'random', age: 'random', gender: 'gender.woman' });
    assert.ok(project.creator.identity);
    assert.equal(project.creator.source, 'random');
    studio.selectOutfit(project, 'casual-everyday');
    assert.ok(project.outfit.outfit.length > 5);
    assert.notEqual(project.outfit.outfit.toLowerCase(), 'casual everyday');
});

test('exit preserves the project as a draft and resume reactivates it', () => {
    const id = conversationId('draft');
    const project = baseProject({ conversationId: id });
    studio.save(project);
    studio.exitProject(project);
    const draft = studio.getProject(id);
    assert.equal(draft.status, studio.STATUS.DRAFT);
    assert.ok(studio.listProjects().some((p) => p.id === project.id && p.status === 'draft'));
    studio.resumeProject(draft);
    assert.equal(studio.getProject(id).status, studio.STATUS.ACTIVE);
});

// --- Script ------------------------------------------------------------------

test('script generation falls back to a facts-only deterministic script', async () => {
    const project = baseProject();
    await studio.generateScript(project, { provider: 'ollama', model: '' });
    assert.equal(project.stage, studio.STAGES.SCRIPT_REVIEW);
    assert.ok(project.script.fullText.length > 0);
    assert.ok(project.script.hook.length > 0);
    assert.equal(project.script.approved, false);
    assert.equal(project.script.source, 'fallback');
    // No invented claims: avoid-list wording must not leak into the script.
    assert.ok(!/cure/i.test(project.script.fullText));
});

test('the script can be edited field by field and approved', async () => {
    const project = baseProject();
    await studio.generateScript(project, { provider: 'ollama', model: '' });
    studio.editScriptField(project, 'hook', 'STOP scrolling if your skin feels tight.');
    assert.equal(project.script.hook, 'STOP scrolling if your skin feels tight.');
    assert.ok(project.script.fullText.includes('STOP scrolling'));
    assert.equal(project.script.approved, false);
    studio.approveScript(project);
    assert.equal(project.script.approved, true);
});

// --- Scenes ------------------------------------------------------------------

test('scene plan sums to exactly the requested duration', async () => {
    const project = baseProject({ brief: { duration: 15, aspectRatio: '9:16', platform: 'tiktok' } });
    await studio.generateScenes(project, { provider: 'ollama', model: '' });
    assert.equal(project.stage, studio.STAGES.SCENE_REVIEW);
    const total = project.scenes.reduce((sum, s) => sum + s.duration, 0);
    assert.equal(total, 15);
    assert.ok(project.scenes.length >= 2 && project.scenes.length <= 5);
    // Every scene carries the continuity defaults.
    project.scenes.forEach((s) => {
        assert.equal(s.environment, 'a clean, modern bathroom');
        assert.equal(s.outfit, 'a fitted white t-shirt and blue jeans');
    });
});

test('fitDurations repairs a mismatched plan', () => {
    const scenes = [{ duration: 8 }, { duration: 9 }, { duration: 8 }];
    studio.fitDurations(scenes, 15);
    assert.equal(scenes.reduce((sum, s) => sum + s.duration, 0), 15);
});

test('a single scene can be regenerated without touching the others', async () => {
    const project = baseProject();
    await studio.generateScenes(project, { provider: 'ollama', model: '' });
    const before = project.scenes.map((s) => ({ id: s.id, action: s.action }));
    const target = project.scenes[1];
    await studio.regenerateScene(project, target.id, { provider: 'ollama', model: '' });
    const after = project.scenes.map((s) => ({ id: s.id, action: s.action }));
    assert.equal(after.length, before.length);
    assert.deepEqual(after.map((s) => s.id), before.map((s) => s.id));
    assert.equal(project.scenes.reduce((sum, s) => sum + s.duration, 0), project.brief.duration);
});

test('scenes can be added, deleted and reordered', async () => {
    const project = baseProject();
    await studio.generateScenes(project, { provider: 'ollama', model: '' });
    const initial = project.scenes.length;
    studio.addScene(project);
    assert.equal(project.scenes.length, initial + 1);
    assert.equal(project.scenes.reduce((s, x) => s + x.duration, 0), project.brief.duration);
    const firstId = project.scenes[0].id;
    studio.moveScene(project, firstId, 'down');
    assert.equal(project.scenes[1].id, firstId);
    studio.deleteScene(project, firstId);
    assert.equal(project.scenes.length, initial);
    assert.ok(!project.scenes.some((s) => s.id === firstId));
});

// --- Classification & natural editing ----------------------------------------

test('classifyMessage maps approvals to the current stage', () => {
    const project = baseProject();
    project.stage = studio.STAGES.SCRIPT_REVIEW;
    assert.deepEqual(studio.classifyMessage('looks good', project), { action: 'approve_script' });
    project.stage = studio.STAGES.SCENE_REVIEW;
    assert.deepEqual(studio.classifyMessage('approve', project), { action: 'approve_scenes' });
    project.stage = studio.STAGES.REFERENCE_APPROVAL;
    assert.deepEqual(studio.classifyMessage('continue in director mode', project), { action: 'continue_director' });
    assert.equal(studio.classifyMessage('what is the weather today?', project), null);
});

test('classifyMessage detects a targeted scene regenerate (stage-aware)', () => {
    const project = baseProject();
    // At the scene plan a scene action targets the scene plan itself.
    project.stage = studio.STAGES.SCENE_REVIEW;
    let decision = studio.classifyMessage('regenerate only scene 2', project);
    assert.equal(decision.action, 'regenerate_scene');
    assert.equal(decision.sceneNumber, 2);
    // At the reference stages it targets that scene's frame.
    project.stage = studio.STAGES.REFERENCE_APPROVAL;
    decision = studio.classifyMessage('regenerate only scene 2', project);
    assert.equal(decision.action, 'regenerate_reference');
    assert.equal(decision.sceneNumber, 2);
    // "redo scene 2" is the same idea.
    project.stage = studio.STAGES.SCENE_REVIEW;
    assert.equal(studio.classifyMessage('redo scene 2', project).action, 'regenerate_scene');
});

test('classifyMessage leaves unrelated generation requests to the normal router', () => {
    const project = baseProject();
    project.stage = studio.STAGES.BRIEF;
    assert.equal(studio.classifyMessage('make a video of a cat', project), null);
    assert.equal(studio.classifyMessage('make a 20 second video of a dog', project), null);
    // A targeted UGC edit is still captured.
    assert.equal(studio.classifyMessage('make the video 20 seconds', project).action, 'edit');
    assert.equal(studio.classifyMessage('put Maya in the gym outfit', project).action, 'edit');
});

test('natural editing applies duration, outfit and environment changes', async () => {
    const project = baseProject();
    await studio.generateScenes(project, { provider: 'ollama', model: '' });
    await studio.applyNaturalEdit(project, 'make the video 20 seconds', { provider: 'ollama', model: '' });
    assert.equal(project.brief.duration, 20);
    assert.equal(project.scenes.reduce((s, x) => s + x.duration, 0), 20);

    await studio.applyNaturalEdit(project, 'change the environment to a modern bathroom', { provider: 'ollama', model: '' });
    assert.equal(project.environment.id, 'bathroom');

    await studio.applyNaturalEdit(project, 'change the outfit to something for the gym', { provider: 'ollama', model: '' });
    assert.ok(project.outfit.outfit.length > 0);
});

test('removing the CTA rewrites the script', async () => {
    const project = baseProject();
    await studio.generateScript(project, { provider: 'ollama', model: '' });
    const originalClosing = project.script.closing;
    await studio.applyNaturalEdit(project, 'remove the CTA', { provider: 'ollama', model: '' });
    assert.equal(project.script.closing, '');
    assert.ok(!project.script.fullText.includes(originalClosing));
});

test('keeping the same outfit in every scene updates continuity', async () => {
    const project = baseProject();
    await studio.generateScenes(project, { provider: 'ollama', model: '' });
    project.scenes[1].outfit = 'a different outfit';
    await studio.applyNaturalEdit(project, 'keep the same outfit in every scene', { provider: 'ollama', model: '' });
    project.scenes.forEach((s) => assert.equal(s.outfit, project.continuity.outfitState));
});

// --- Reference requests & Director handoff -----------------------------------

test('buildReferenceRequest combines creator, outfit, environment and product', () => {
    const project = baseProject();
    const scene = { id: 's1', order: 1, action: 'applies the serum', camera: { shotType: 'close-up' }, productVisibility: 'product in hand' };
    const request = studio.buildReferenceRequest(project, scene);
    assert.equal(request.intent, 'image_generation');
    assert.ok(request.user_prompt.includes('Glow Serum'));
    assert.ok(request.user_prompt.includes('a fitted white t-shirt and blue jeans'));
    assert.ok(request.user_prompt.includes('a clean, modern bathroom'));
    assert.ok(request.explicit_constraints.some((c) => /same creator identity/i.test(c)));
});

test('reference concept preserves the creator appearance category (ethnicity)', () => {
    const labeled = baseProject({
        creator: {
            characterId: null, source: 'random', name: 'Mei',
            identity: 'a 28-year-old woman with long black hair',
            appearance: 'fair skin, almond eyes', hair: 'long black hair',
            appearanceCategory: 'east_asian', appearanceCategoryLabel: 'East Asian'
        }
    });
    const request = studio.buildReferenceRequest(labeled, { id: 's1', order: 1, action: 'applies the serum', camera: { shotType: 'close-up' } });
    assert.ok(request.user_prompt.includes('East Asian'));
    assert.ok(request.explicit_constraints.some((c) => /East Asian/.test(c)));

    // A creator that stored only the category key still renders the label.
    const keyOnly = baseProject({
        creator: { characterId: null, source: 'random', name: 'Mei', identity: 'a woman', appearanceCategory: 'east_asian' }
    });
    const request2 = studio.buildReferenceRequest(keyOnly, { id: 's1', order: 1, action: 'applies the serum' });
    assert.ok(request2.user_prompt.includes('East Asian'));
});

test('directorProductionInput carries the scene plan as a structured shot list', () => {
    const project = baseProject();
    project.scenes = [
        { id: 's1', order: 1, duration: 7, objective: 'Hook', action: 'walks into the bathroom', camera: { shotType: 'medium', movement: 'handheld' } },
        { id: 's2', order: 2, duration: 8, objective: 'Demo', action: 'applies the serum', camera: { shotType: 'close-up', movement: 'push in' } }
    ];
    project.approvedReferences = [{ sceneId: 's1', order: 1, url: '/generated/ref.png', filename: 'ref.png' }];
    studio.reconcileContinuity(project);
    const input = studio.directorProductionInput(project);
    assert.ok(input.brief.shotList.length === 2);
    assert.ok(input.brief.shotList[0].includes('walks into the bathroom'));
    assert.equal(input.brief.aspectRatio, '9:16');
    assert.equal(input.openingFrame.filename, 'ref.png');
    assert.equal(input.duration, 15);
});

test('director.createUgcProduction seeds the approved frame and the shot list', () => {
    const director = require('../services/director/director');
    const project = baseProject();
    project.scenes = [
        { id: 's1', order: 1, duration: 7, action: 'applies the serum', camera: { shotType: 'close-up', movement: 'push in' } },
        { id: 's2', order: 2, duration: 8, action: 'smiles to camera', camera: { shotType: 'medium' } }
    ];
    project.approvedReferences = [{ sceneId: 's1', order: 1, url: '/generated/ref.png', filename: 'ref.png' }];
    const input = studio.directorProductionInput(project);
    const production = director.createUgcProduction({
        conversationId: conversationId('handoff'),
        brief: input.brief,
        duration: input.duration,
        openingFrame: input.openingFrame,
        originalRequest: input.originalRequest
    });
    assert.equal(production.brief.shotList.length, 2);
    assert.ok(production.brief.shotList[0].includes('applies the serum'));
    assert.equal(production.image.rawFilename, 'ref.png');
    assert.equal(production.status, director.STATUS.AWAITING_IMAGE_APPROVAL);
    assert.equal(production.video.duration, 15);
    director.removeProduction(production.conversationId);
});

test('directorBrief carries scene dialogue as on-screen H3 dialogue', () => {
    const project = baseProject();
    project.scenes = [
        { id: 's1', order: 1, duration: 7, action: 'walks into the bathroom', dialogue: 'Okay, you have to see this.', camera: { shotType: 'medium', movement: 'handheld' } },
        { id: 's2', order: 2, duration: 8, action: 'applies the serum', dialogue: '"It sinks in fast."', camera: { shotType: 'close-up', movement: 'push in' } }
    ];
    studio.reconcileContinuity(project);
    const input = studio.directorProductionInput(project);
    // Spoken lines stay with their shot, wrapped for H3 lip-sync and attributed
    // to the on-screen creator with a stable speaker ID.
    assert.ok(input.brief.shotList[0].includes('<d>[English] Okay, you have to see this.</d>'));
    assert.ok(input.brief.shotList[0].includes('(S1)'));
    assert.ok(input.brief.shotList[0].includes('on-screen'));
    assert.ok(input.brief.shotList[1].includes('<d>[English] It sinks in fast.</d>'));
    // Quotes are stripped so only the spoken words sit inside <d>.
    assert.ok(!input.brief.shotList[1].includes('"It sinks in fast."'));
    // The raw script is no longer dumped into details (which H3 read as voiceover).
    assert.ok(!/script:/i.test(input.brief.details));
    assert.ok(/lip-sync/i.test(input.brief.details));
});

test('directorProductionInput carries every approved reference frame', () => {
    const project = baseProject();
    project.scenes = [
        { id: 's1', order: 1, duration: 7, action: 'walks in', camera: {} },
        { id: 's2', order: 2, duration: 8, action: 'applies', camera: {} }
    ];
    project.approvedReferences = [
        { sceneId: 's1', order: 1, url: '/generated/a.png', filename: 'a.png' },
        { sceneId: 's2', order: 2, url: '/generated/b.png', filename: 'b.png' }
    ];
    const input = studio.directorProductionInput(project);
    assert.equal(input.references.length, 2);
    assert.deepEqual(input.references.map((r) => r.filename), ['a.png', 'b.png']);
    assert.equal(input.openingFrame.filename, 'a.png');
});

test('a UGC handoff renders the video reference-to-video from every scene frame', async () => {
    const director = require('../services/director/director');
    const project = baseProject();
    project.scenes = [
        { id: 's1', order: 1, duration: 7, action: 'walks in', dialogue: 'Hi there.', camera: {} },
        { id: 's2', order: 2, duration: 8, action: 'applies it', dialogue: 'It sinks in.', camera: {} }
    ];
    project.approvedReferences = [
        { sceneId: 's1', order: 1, url: '/generated/a.png', filename: 'a.png' },
        { sceneId: 's2', order: 2, url: '/generated/b.png', filename: 'b.png' }
    ];
    const input = studio.directorProductionInput(project);
    const production = director.createUgcProduction({
        conversationId: conversationId('refs'),
        brief: input.brief,
        duration: input.duration,
        openingFrame: input.openingFrame,
        originalRequest: input.originalRequest,
        references: input.references
    });
    assert.equal(production.references.length, 2);
    const stage = await director.buildVideoStageRequest(production, {
        provider: 'ollama', model: 'test-model', think: false
    });
    assert.equal(stage.videoMode, 'ref2va');
    assert.deepEqual(stage.referenceImages, ['a.png', 'b.png']);
    assert.deepEqual(stage.structuredRequest.reference_images, ['a.png', 'b.png']);
    assert.equal(stage.structuredRequest.has_reference_image, false);
    // Approved dialogue survives into the final H3 prompt with its language tag.
    assert.match(stage.videoPrompt, /<d>\[English\] Hi there\.<\/d>/);
    assert.match(stage.videoPrompt, /<d>\[English\] It sinks in\.<\/d>/);
    director.removeProduction(production.conversationId);
});

test('deterministicScenes distributes the script across scenes as dialogue', () => {
    const project = baseProject({
        script: { fullText: 'First line. Second line. Third line. Fourth line.' }
    });
    const scenes = prompts.deterministicScenes(project);
    const spoken = scenes.map((s) => s.dialogue).filter(Boolean).join(' ');
    assert.ok(spoken.includes('First line.'));
    assert.ok(spoken.includes('Fourth line.'));
    // The opening scene speaks the hook and the last scene lands the closing line.
    assert.ok(scenes[0].dialogue.includes('First line.'));
    assert.ok(scenes[scenes.length - 1].dialogue.includes('Fourth line.'));
});

test('dialogue is trimmed to a natural pace for its scene duration', () => {
    const long = 'Okay so I have been using this serum for a whole week now and honestly my ' +
        'skin has never felt this hydrated or looked this calm in the morning before.';
    const fitted = prompts.fitDialogueToBudget(long, 5);
    assert.ok(prompts.countWords(fitted) <= prompts.dialogueWordBudget(5), fitted);
    assert.ok(fitted.endsWith('.'));
    // A short line that already fits is left untouched.
    assert.equal(prompts.fitDialogueToBudget('It sinks in fast.', 5), 'It sinks in fast.');
    // The budget scales with the shot: twice the seconds, twice the words.
    assert.ok(prompts.dialogueWordBudget(10) > prompts.dialogueWordBudget(5));
});

test('deterministicScenes never assigns more words than a scene can hold', () => {
    const project = baseProject({
        script: { fullText: 'This opening hook is deliberately far too long for a five second scene and must be trimmed. It sinks in fast. Third line. Fourth line.' }
    });
    const scenes = prompts.deterministicScenes(project);
    scenes.forEach((scene) => {
        assert.ok(prompts.countWords(scene.dialogue) <= prompts.dialogueWordBudget(scene.duration),
            scene.duration + 's: ' + scene.dialogue);
    });
});

test('generateScenes trims an over-long LLM line to the scene budget', async () => {
    const original = providers.chat;
    providers.chat = async () => JSON.stringify({
        scenes: [
            { duration: 5, action: 'a', dialogue: 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour twentyfive twentysix.' },
            { duration: 5, action: 'b', dialogue: 'Short line.' }
        ]
    });
    try {
        const project = baseProject();
        await studio.generateScenes(project, { provider: 'ollama', model: 'test-model', think: false });
        project.scenes.forEach((scene) => {
            assert.ok(prompts.countWords(scene.dialogue) <= prompts.dialogueWordBudget(scene.duration),
                scene.duration + 's: ' + scene.dialogue);
        });
    } finally {
        providers.chat = original;
    }
});

test('script and scene generation use the LLM when it returns valid JSON', async () => {
    const original = providers.chat;
    providers.chat = async (provider, messages) => {
        const system = messages[0].content;
        if (system.includes('script')) {
            return JSON.stringify({ hook: 'Hook line', main: 'Main line', productInteraction: 'Shows the serum', closing: 'CTA line', fullText: 'Hook line Main line Shows the serum CTA line' });
        }
        if (system.includes('shot list')) {
            return JSON.stringify({ scenes: [
                { duration: 5, objective: 'Open', action: 'opens the bottle', camera: { shotType: 'close-up' } },
                { duration: 5, objective: 'Use', action: 'applies the serum', camera: { shotType: 'medium' } },
                { duration: 5, objective: 'Close', action: 'smiles to camera', camera: { shotType: 'medium' } }
            ] });
        }
        return '{}';
    };
    try {
        const project = baseProject();
        await studio.generateScript(project, { provider: 'ollama', model: '' });
        assert.equal(project.script.hook, 'Hook line');
        assert.equal(project.script.source, 'llm');
        await studio.generateScenes(project, { provider: 'ollama', model: '' });
        assert.equal(project.scenes[0].action, 'opens the bottle');
        assert.equal(project.scenes.reduce((s, x) => s + x.duration, 0), 15);
    } finally {
        providers.chat = original;
    }
});

test('brief extraction merges the LLM verdict over the heuristic', async () => {
    const original = providers.chat;
    providers.chat = async () => JSON.stringify({
        objective: 'Promote the serum', productName: 'Glow Serum', contentType: 'unboxing',
        platform: 'instagram-reels', duration: 20, aspectRatio: '4:5', tone: 'playful',
        environment: 'bedroom'
    });
    try {
        const brief = await studio.extractBrief('do something with my serum', { provider: 'ollama', model: '' });
        assert.equal(brief.contentType, 'unboxing');
        assert.equal(brief.platform, 'instagram-reels');
        assert.equal(brief.duration, 20);
        assert.equal(brief.aspectRatio, '4:5');
        assert.equal(brief.environment, 'bedroom');
    } finally {
        providers.chat = original;
    }
});

// --- Card / marker -----------------------------------------------------------

test('renderContent embeds a parseable ugc marker; card carries the catalogs', () => {
    const project = baseProject();
    project.stage = studio.STAGES.CREATIVE_DIRECTION;
    const content = studio.renderContent(project);
    const match = content.match(/\[\[ugc:(\{[^\n]*?\})\]\]/);
    assert.ok(match);
    const card = JSON.parse(match[1]);
    assert.equal(card.id, project.id);
    assert.equal(card.stage, studio.STAGES.CREATIVE_DIRECTION);
    assert.ok(Array.isArray(card.contentTypes));
    assert.ok(Array.isArray(card.outfitPacks));
    assert.ok(Array.isArray(card.environments));
});

test('normalizeAction accepts the card button payloads', () => {
    assert.deepEqual(studio.normalizeAction({ type: 'approve_brief', projectId: 'x' }), { type: 'approve_brief', projectId: 'x' });
    const outfit = studio.normalizeAction({ type: 'select_outfit', outfitPack: 'gym-activewear', outfitPackCustom: 'a tank top' });
    assert.equal(outfit.outfitPack, 'gym-activewear');
    assert.equal(outfit.outfitPackCustom, 'a tank top');
    assert.equal(studio.normalizeAction('not-an-action'), null);
    assert.equal(studio.normalizeAction(null), null);
});

// --- Canonical brief schema --------------------------------------------------

test('canonical brief preserves every supported field through normalize/save/reload', () => {
    const id = conversationId('brief-schema');
    const project = studio.normalizeProject({
        conversationId: id,
        status: 'active',
        stage: 'brief',
        brief: {
            objective: 'Show the morning routine', productName: 'Glow Serum', brand: 'Lumine',
            productCategory: 'skincare', contentType: 'product-demo', platform: 'tiktok',
            duration: 15, aspectRatio: '9:16', targetAudience: 'teens', tone: 'natural',
            keyMessage: 'Hydration that fits your morning', callToAction: 'Try it this week',
            environment: 'bathroom', dialogueLanguage: 'Spanish', creatorDescription: 'a young woman',
            additionalInstructions: 'keep it light'
        }
    });
    for (const field of studio.BRIEF_FIELDS) {
        assert.ok(field in project.brief, 'missing brief field: ' + field);
    }
    assert.equal(project.brief.productName, 'Glow Serum');
    assert.equal(project.brief.dialogueLanguage, 'Spanish');
    studio.save(project);
    const reloaded = studio.getProject(id);
    assert.equal(reloaded.brief.brand, 'Lumine');
    assert.equal(reloaded.brief.productCategory, 'skincare');
    assert.equal(reloaded.brief.dialogueLanguage, 'Spanish');
    assert.equal(reloaded.brief.environment, 'bathroom');
    assert.equal(reloaded.brief.creatorDescription, 'a young woman');
});

test('mergeBrief preserves product/brand/environment/dialogueLanguage from the LLM', () => {
    const out = studio.mergeBrief(prompts.heuristicBrief('make a ugc video'), {
        productName: 'Serum X', brand: 'Acme', productCategory: 'skincare',
        environment: 'kitchen', dialogueLanguage: 'French', creatorDescription: 'a man'
    });
    assert.equal(out.productName, 'Serum X');
    assert.equal(out.brand, 'Acme');
    assert.equal(out.productCategory, 'skincare');
    assert.equal(out.environment, 'kitchen');
    assert.equal(out.dialogueLanguage, 'French');
    assert.equal(out.creatorDescription, 'a man');
});

test('editBrief preserves canonical fields it does not touch and rejects bad durations', () => {
    const project = baseProject();
    project.brief.productName = 'Glow Serum';
    project.brief.brand = 'Lumine';
    studio.editBrief(project, { tone: 'upbeat' });
    assert.equal(project.brief.productName, 'Glow Serum');
    assert.equal(project.brief.brand, 'Lumine');
    assert.equal(project.brief.tone, 'upbeat');

    const result = studio.editBrief(project, { duration: 999 });
    assert.equal(result.durationInvalid, true);
    assert.equal(project.brief.duration, 15);
});

test('regenerateBrief preserves canonical fields the re-extraction leaves empty', async () => {
    const original = providers.chat;
    providers.chat = async () => JSON.stringify({ objective: 'New objective' });
    try {
        const project = baseProject();
        project.brief.brand = 'Lumine';
        project.brief.productCategory = 'skincare';
        project.brief.dialogueLanguage = 'French';
        studio.save(project);
        await studio.regenerateBrief(project, { provider: 'ollama', model: '' });
        assert.equal(project.brief.brand, 'Lumine');
        assert.equal(project.brief.productCategory, 'skincare');
        assert.equal(project.brief.dialogueLanguage, 'French');
    } finally {
        providers.chat = original;
    }
});

test('createProject binds an exact product name but only suggests a fuzzy one', async () => {
    const original = providers.chat;
    const exact = products.create({ name: 'Exact Glow Serum' });
    try {
        providers.chat = async () => JSON.stringify({ productName: 'Exact Glow Serum' });
        const bound = await studio.createProject({
            conversationId: conversationId('bind-exact'), message: 'ugc video for my product', provider: 'ollama', model: ''
        });
        assert.equal(bound.product && bound.product.name, 'Exact Glow Serum');

        providers.chat = async () => JSON.stringify({ productName: 'Glow Serum' });
        const fuzzy = await studio.createProject({
            conversationId: conversationId('bind-fuzzy'), message: 'ugc video for my product', provider: 'ollama', model: ''
        });
        assert.equal(fuzzy.product, null);
        assert.equal(fuzzy.suggestedProductName, 'Glow Serum');
    } finally {
        providers.chat = original;
        products.remove(exact.id);
    }
});

// --- Stage/action validation -------------------------------------------------

test('validateAction rejects out-of-order and completed-stage actions', () => {
    const project = baseProject();
    project.stage = studio.STAGES.BRIEF;
    assert.equal(studio.validateAction(project, studio.ACTIONS.APPROVE_BRIEF).ok, true);
    assert.equal(studio.validateAction(project, studio.ACTIONS.APPROVE_SCRIPT).ok, false);
    assert.equal(studio.validateAction(project, studio.ACTIONS.APPROVE_SCENES).ok, false);
    assert.equal(studio.validateAction(project, studio.ACTIONS.APPROVE_REFERENCES).ok, false);

    project.status = studio.STATUS.COMPLETED;
    assert.equal(studio.validateAction(project, studio.ACTIONS.APPROVE_BRIEF).ok, false);
    assert.equal(studio.validateAction(project, studio.ACTIONS.DISCARD).ok, true);
    assert.equal(studio.validateAction(project, studio.ACTIONS.NEW_PROJECT).ok, true);
    assert.equal(studio.validateAction(project, studio.ACTIONS.VIEW_BRIEF).ok, true);
});

test('isStaleAction rejects an old card version but accepts typed decisions', () => {
    const project = baseProject();
    studio.save(project);
    const version = project.version;
    assert.equal(studio.isStaleAction(project, { projectVersion: version }), false);
    assert.equal(studio.isStaleAction(project, { projectVersion: version - 1 }), true);
    assert.equal(studio.isStaleAction(project, { action: 'edit' }), false);
});

// --- Creator-free mode -------------------------------------------------------

test('creator-free mode is explicit and product-only prompts never invent a person', async () => {
    const project = baseProject({ creator: null });
    studio.skipCreator(project);
    assert.equal(project.creatorMode, 'none');
    assert.equal(project.creator, null);
    assert.equal(studio.nextSetupStage(project), studio.STAGES.BRIEF);

    const scenes = prompts.deterministicScenes(project);
    assert.ok(!/creator/i.test(scenes.map((s) => s.action).join(' ')));

    await studio.generateScript(project, { provider: 'ollama', model: '' });
    assert.ok(!/I have been using/i.test(project.script.fullText));

    const request = studio.buildReferenceRequest(project, scenes[0]);
    assert.ok(!/Creator:/i.test(request.user_prompt));

    const brief = prompts.directorBrief(project);
    assert.ok(!/relatable creator/i.test(brief.subject));
    assert.ok(/product-focused/i.test(brief.subject));
    assert.ok(!/on-screen creator/i.test(brief.shotList.join(' ')));
});

// --- Reference integrity -----------------------------------------------------

function twoSceneProject(overrides = {}) {
    const project = baseProject(overrides);
    project.scenes = [
        { id: 's1', order: 1, duration: 7, action: 'walks in', camera: { shotType: 'medium' } },
        { id: 's2', order: 2, duration: 8, action: 'applies it', camera: { shotType: 'close-up' } }
    ];
    studio.reconcileContinuity(project);
    return project;
}

test('visual edits invalidate approved references', async () => {
    const project = twoSceneProject();
    studio.recordReference(project, 's1', { url: '/generated/a.png', filename: 'a.png' });
    studio.recordReference(project, 's2', { url: '/generated/b.png', filename: 'b.png' });
    assert.equal(studio.referencesComplete(project), true);
    assert.equal(studio.approveReferences(project).ok, true);
    assert.equal(project.approvedReferences.length, 2);

    studio.editScene(project, 's1', { action: 'a completely different action' });
    assert.equal(project.approvedReferences.length, 0);
    assert.equal(studio.referencesComplete(project), false);
});

test('creator, outfit, environment and duration changes all invalidate references', async () => {
    const mutations = [
        (p) => studio.selectEnvironment(p, 'kitchen'),
        (p) => studio.selectOutfit(p, 'gym-activewear'),
        (p) => studio.randomCreator(p, { appearance: 'random', age: 'random', gender: 'random' }),
        (p) => studio.editBrief(p, { duration: 20 })
    ];
    for (const mutate of mutations) {
        const project = twoSceneProject();
        studio.recordReference(project, 's1', { url: '/generated/a.png', filename: 'a.png' });
        studio.recordReference(project, 's2', { url: '/generated/b.png', filename: 'b.png' });
        studio.approveReferences(project);
        mutate(project);
        assert.equal(project.approvedReferences.length, 0);
    }
});

test('approved references remain valid for a re-approval (duration-confirm path)', () => {
    const project = twoSceneProject();
    studio.recordReference(project, 's1', { url: '/generated/a.png', filename: 'a.png' });
    studio.recordReference(project, 's2', { url: '/generated/b.png', filename: 'b.png' });
    assert.equal(studio.approveReferences(project).ok, true);
    assert.equal(studio.referencesComplete(project), true);
    // Re-approving (e.g. after confirming a capped duration) must still succeed.
    project.stage = studio.STAGES.REFERENCE_APPROVAL;
    assert.equal(studio.approveReferences(project).ok, true);
});

test('approveReferences requires exactly one current frame per scene', () => {
    const project = twoSceneProject();
    studio.recordReference(project, 's1', { url: '/generated/a.png', filename: 'a.png' });
    let result = studio.approveReferences(project);
    assert.equal(result.ok, false);
    assert.match(result.error, /missing/i);

    // A stale frame (generated before a plan change) cannot be approved.
    studio.recordReference(project, 's2', { url: '/generated/b.png', filename: 'b.png' });
    studio.editScene(project, 's2', { action: 'changed action' });
    result = studio.approveReferences(project);
    assert.equal(result.ok, false);
    assert.equal(project.approvedReferences.length, 0);
});

test('partial reference generation keeps successes and reports failed scenes', () => {
    const project = twoSceneProject();
    project.scenes.push({ id: 's3', order: 3, duration: 5, action: 'closes', camera: {} });
    studio.reconcileContinuity(project);
    studio.recordReference(project, 's1', { url: '/generated/a.png', filename: 'a.png' });
    studio.recordReferenceFailure(project, 's2', 'out of memory');
    const pending = studio.pendingReferenceSceneIds(project).sort();
    assert.deepEqual(pending, ['s2', 's3']);
    assert.equal(studio.referencesComplete(project), false);
    const card = studio.buildCard(project);
    const failed = card.references.find((r) => r.sceneId === 's2');
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /memory/);
});

test('duplicate and malformed scene IDs are repaired deterministically', () => {
    const project = baseProject();
    const { scenes } = prompts.validateScenes(project, [
        { id: 'dup', duration: 5, action: 'a' },
        { id: 'dup', duration: 5, action: 'b' },
        { duration: 5, action: 'c' }
    ]);
    const ids = scenes.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every(Boolean));
});

test('a mid-workflow environment edit keeps the reference stage and invalidates frames', async () => {
    const project = twoSceneProject();
    studio.recordReference(project, 's1', { url: '/generated/a.png', filename: 'a.png' });
    studio.recordReference(project, 's2', { url: '/generated/b.png', filename: 'b.png' });
    studio.approveReferences(project);
    project.stage = studio.STAGES.REFERENCE_APPROVAL;
    await studio.applyNaturalEdit(project, 'change the environment to a kitchen', { provider: 'ollama', model: '' });
    assert.equal(project.environment.id, 'kitchen');
    assert.equal(project.stage, studio.STAGES.REFERENCE_APPROVAL);
    assert.equal(project.approvedReferences.length, 0);
});

// --- Duration handling -------------------------------------------------------

test('duration validation covers the boundaries', () => {
    assert.equal(prompts.validateDuration(1).valid, true);
    assert.equal(prompts.validateDuration(2).valid, true);
    assert.equal(prompts.validateDuration(5).valid, true);
    assert.equal(prompts.validateDuration(15).valid, true);
    assert.equal(prompts.validateDuration(15).capped, false);
    assert.equal(prompts.validateDuration(16).valid, true);
    assert.equal(prompts.validateDuration(16).capped, true);
    assert.equal(prompts.validateDuration(30).valid, true);
    assert.equal(prompts.validateDuration(60).valid, true);
    assert.equal(prompts.validateDuration(0).valid, false);
    assert.equal(prompts.validateDuration(61).valid, false);
});

test('a duration change recomputes the scene count and durations', () => {
    const project = twoSceneProject();
    studio.editBrief(project, { duration: 30 });
    const total = project.scenes.reduce((sum, s) => sum + s.duration, 0);
    assert.equal(total, 30);
    assert.ok(project.scenes.length >= 4);
});

test('a >15s brief is not silently clamped at handoff', () => {
    const project = twoSceneProject({ brief: { duration: 30, aspectRatio: '9:16' } });
    studio.approveReferences(project);
    const input = studio.directorProductionInput(project);
    assert.equal(input.durationCapped, true);
    assert.equal(input.requestedDuration, 30);
    assert.equal(input.duration, 15);
    // The cap is explained and requires an explicit confirmation.
    project.stage = studio.STAGES.REFERENCE_APPROVAL;
    assert.equal(studio.classifyMessage('continue at 15 seconds', project).action, 'confirm_duration');
    studio.confirmDuration(project);
    assert.equal(studio.getProject(project.conversationId).durationConfirmed, true);
});

// --- Facts-only fallbacks ----------------------------------------------------

test('deterministic script fallback is facts-only and never fakes experience', () => {
    const project = baseProject();
    const script = prompts.deterministicScript(project);
    assert.ok(!/I have been using/i.test(script.fullText));
    assert.ok(!/what I noticed/i.test(script.fullText));
    assert.ok(!/available now/i.test(script.fullText));
    assert.ok(!/cure/i.test(script.fullText));
    // A CTA is only ever the user's own words.
    assert.equal(script.closing, project.brief.callToAction);
});

test('a product with no CTA yields no invented CTA', () => {
    const project = baseProject({ brief: { duration: 15, callToAction: '' } });
    const script = prompts.deterministicScript(project);
    assert.equal(script.closing, '');
});

test('unsupported LLM claims are stripped and flagged', async () => {
    const original = providers.chat;
    providers.chat = async () => JSON.stringify({
        hook: 'This serum cures acne in 3 days.',
        main: 'It is clinically proven and costs $19.',
        productInteraction: 'Apply a few drops.',
        closing: 'Buy now, guaranteed.',
        fullText: 'ignored'
    });
    try {
        const project = baseProject();
        await studio.generateScript(project, { provider: 'ollama', model: '' });
        assert.ok(!/cures/i.test(project.script.fullText));
        assert.ok(!/\$19/.test(project.script.fullText));
        assert.ok(!/guaranteed/i.test(project.script.fullText));
        assert.equal(project.script.needsConfirmation, true);
    } finally {
        providers.chat = original;
    }
});

// --- Product references & ambiguity ------------------------------------------

test('product reference images reach the reference request, separate from scene frames', () => {
    const project = baseProject();
    project.product = Object.assign({}, project.product, { referenceImages: ['/images/p.png'] });
    const request = studio.buildReferenceRequest(project, { id: 's1', order: 1, action: 'applies the serum', camera: {} });
    assert.deepEqual(request.product_references, ['/images/p.png']);
    assert.ok(/reference image/i.test(request.user_prompt));
    assert.equal(request.referenceImages, undefined);
});

test('a saved product can be deleted from the library via the studio action', () => {
    const product = products.create({ name: 'Delete Me Serum' });
    const project = baseProject({ product: null, stage: 'product_selection' });
    assert.equal(studio.validateAction(project, studio.ACTIONS.DELETE_PRODUCT).ok, true);
    const result = studio.deleteProduct(project, product.id);
    assert.equal(result.ok, true);
    assert.equal(products.get(product.id), null);
    // Deleting an unknown product reports an error, not a crash.
    assert.equal(studio.deleteProduct(project, 'does-not-exist').ok, false);
});

test('fuzzy product names are not auto-bound; exact matches are', () => {
    const created = products.create({ name: 'Glow Serum Deluxe' });
    assert.equal(products.findByName('glow serum deluxe').id, created.id);
    assert.equal(products.findByName('glow serum'), null);
    const resolved = products.resolveByName('glow serum');
    assert.equal(resolved.product, null);
    assert.ok(resolved.candidates.some((p) => p.id === created.id));
    products.remove(created.id);
});

// --- Lifecycle ---------------------------------------------------------------

test('director success completes the linked UGC project and it stops intercepting', () => {
    const id = conversationId('lifecycle-ok');
    const project = baseProject({ conversationId: id });
    project.directorProductionId = 'prod_x';
    project.stage = studio.STAGES.VIDEO_GENERATION;
    studio.save(project);

    const done = studio.syncDirectorOutcome(id, 'prod_x', 'completed', { url: '/generated/v.mp4' });
    assert.equal(done.status, studio.STATUS.COMPLETED);
    assert.equal(done.stage, studio.STAGES.COMPLETED);
    assert.equal(done.videoUrl, '/generated/v.mp4');
    const reloaded = studio.getProject(id);
    assert.equal(studio.isActive(reloaded), false);
    assert.equal(studio.isOpen(reloaded), false);
    // A different production id is not linked.
    assert.equal(studio.syncDirectorOutcome(id, 'other', 'completed', {}), null);
});

test('director failure returns the project to the reference-approval retry stage', () => {
    const id = conversationId('lifecycle-fail');
    const project = baseProject({ conversationId: id });
    project.directorProductionId = 'prod_y';
    project.stage = studio.STAGES.VIDEO_GENERATION;
    studio.save(project);

    const failed = studio.syncDirectorOutcome(id, 'prod_y', 'failed', { message: 'out of memory' });
    assert.equal(failed.stage, studio.STAGES.REFERENCE_APPROVAL);
    assert.match(failed.lastError, /memory/);
    assert.equal(studio.isActive(studio.getProject(id)), true);
    assert.equal(studio.getProject(id).directorProductionId, 'prod_y');
});

// --- Natural-language editing ------------------------------------------------

test('classifyMessage handles approval and edit phrases', () => {
    const project = baseProject();
    project.stage = studio.STAGES.SCENE_REVIEW;
    assert.equal(studio.classifyMessage('approve the scenes', project).action, 'approve_scenes');
    project.stage = studio.STAGES.SCRIPT_REVIEW;
    assert.equal(studio.classifyMessage('approve the script', project).action, 'approve_script');
    project.stage = studio.STAGES.REFERENCE_APPROVAL;
    assert.equal(studio.classifyMessage('approve the references', project).action, 'approve_references');
    assert.equal(studio.classifyMessage('change the product shot', project).action, 'edit');
    assert.equal(studio.classifyMessage('make the hook shorter', project).action, 'edit');
    assert.equal(studio.classifyMessage('keep the outfit but change the environment', project).action, 'edit');
});

test('natural edits apply hook shortening and product-shot changes', async () => {
    const project = twoSceneProject();
    await studio.generateScript(project, { provider: 'ollama', model: '' });
    await studio.applyNaturalEdit(project, 'make the hook shorter', { provider: 'ollama', model: '' });
    assert.ok(prompts.countWords(project.script.hook) <= prompts.dialogueWordBudget(3));

    await studio.applyNaturalEdit(project, 'change the product shot', { provider: 'ollama', model: '' });
    assert.ok(project.scenes.every((s) => /product/i.test(s.productVisibility)));
});

