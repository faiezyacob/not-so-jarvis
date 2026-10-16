/* ============================================
   JARVIS — Today's Playground tests
   Covers the daily idea engine: strict JSON
   validation, deterministic fallback, per-session
   daily persistence, refresh/variety, lifecycle
   updates and the idea -> Playground start mapping.
   The LLM is injected (no network) and every store
   path points at a temp dir so nothing in data/ is
   touched.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-today-'));
process.env.PLAYGROUND_TODAY_PATH = path.join(tmpDir, 'playground-today.json');
process.env.PLAYGROUND_STATE_PATH = path.join(tmpDir, 'playground-state.json');
process.env.CHARACTER_PRESETS_PATH = path.join(tmpDir, 'character-presets.json');
process.env.CHARACTER_CONTEXT_PATH = path.join(tmpDir, 'character-context.json');
process.env.SCENES_PATH = path.join(tmpDir, 'scenes.json');
process.env.GENERATED_HISTORY_PATH = path.join(tmpDir, 'generated-history.json');
process.env.GENERATED_DIR = path.join(tmpDir, 'generated');
process.env.ACTIVITY_LOG_PATH = path.join(tmpDir, 'activity-log.json');
fs.mkdirSync(process.env.GENERATED_DIR, { recursive: true });

const today = require('../services/playground/today');
const activities = require('../services/playground/activities');
const outfitPacks = require('../services/playground/outfit-packs');
const themes = require('../services/playground/themes');

function sessionId(name) {
    return 'today-test-' + name + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
}

function validJson() {
    return JSON.stringify([
        {
            tier: 'easy',
            title: 'Rainy cafe window',
            brief: 'A quiet coffee moment at a rain-speckled cafe window, warm practical light.',
            outputType: 'image',
            characterId: null,
            themeId: 'lifestyle-candid',
            activity: 'coffee-chat',
            scene: 'cafe',
            outfitPack: 'casual-everyday',
            direction: 'A candid coffee moment at a rain-speckled cafe window with warm practical light and a calm, natural expression.'
        },
        {
            tier: 'interesting',
            title: 'Neon street after rain',
            brief: 'A cinematic frame on a rain-slicked neon street, subject small against reflected signage.',
            outputType: 'image',
            characterId: null,
            themeId: 'cinematic-storytelling',
            activity: 'exploring-city',
            scene: 'street',
            outfitPack: 'casual-night-out',
            direction: 'A cinematic single frame on a rain-slicked neon street, the subject small against reflected signage and deep shadow.'
        },
        {
            tier: 'ambitious',
            title: 'Rooftop multi-shot',
            brief: 'A short multi-cut rooftop sequence at golden hour as the city glows.',
            outputType: 'video',
            characterId: null,
            themeId: 'cinematic-storytelling',
            activity: 'hanging-out',
            scene: 'rooftop',
            outfitPack: 'casual-smart',
            direction: 'A short multi-shot rooftop sequence at golden hour: a walk to the edge, a turn to camera, then a calm hold over the city.'
        }
    ]);
}

// --- Parsing / validation -----------------------------------------------------

test('extractJsonArray tolerates prose and code fences', () => {
    const wrapped = 'Sure! Here are the ideas:\n```json\n' + validJson() + '\n```';
    const parsed = today.extractJsonArray(wrapped);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].tier, 'easy');
});

test('parseModelIdeas rejects an incomplete set', () => {
    const onlyTwo = JSON.stringify([
        { tier: 'easy', title: 'A', outputType: 'image' },
        { tier: 'interesting', title: 'B', outputType: 'image' }
    ]);
    assert.equal(today.parseModelIdeas(onlyTwo), null);
});

test('parseModelIdeas returns all three tiers in order and coerces output', () => {
    const ideas = today.parseModelIdeas(validJson(), { date: '2026-01-01' });
    assert.equal(ideas.length, 3);
    assert.deepEqual(ideas.map((i) => i.tier), ['easy', 'interesting', 'ambitious']);
    // An ambitious idea may not be an image.
    assert.ok(['video', 'multi'].includes(ideas[2].outputType));
});

test('normalizeIdea repairs invalid references conservatively', () => {
    const idea = today.normalizeIdea({
        tier: 'easy',
        title: 'Test',
        brief: 'some brief',
        outputType: 'video', // not allowed for easy
        themeId: 'does-not-exist',
        characterId: 'char-not-real',
        activity: 'not-an-activity',
        scene: 'not-a-scene',
        outfitPack: 'not-a-pack'
    }, 'easy', {});
    assert.equal(idea.outputType, 'image');
    assert.equal(themes.getTheme(idea.themeId).id, idea.themeId);
    assert.ok(themes.listThemes().some((t) => t.id === idea.themeId));
    assert.equal(idea.characterId, null);
    assert.equal(idea.mode, 'none');
    assert.equal(idea.activityId, '');
    assert.equal(idea.sceneId, '');
    assert.equal(idea.outfitPack, '');
});

test('ensureVariety does not leave two ideas on the same theme+activity', () => {
    const ideas = [
        { tier: 'easy', themeId: 'lifestyle-candid', activityId: 'coffee-chat' },
        { tier: 'interesting', themeId: 'lifestyle-candid', activityId: 'coffee-chat' },
        { tier: 'ambitious', themeId: 'cinematic-storytelling', activityId: 'exploring-city' }
    ];
    today.ensureVariety(ideas);
    const keys = ideas.map((i) => i.themeId + '::' + i.activityId);
    assert.equal(new Set(keys).size, keys.length);
});

// --- Daily set + persistence --------------------------------------------------

test('getDailySet uses the injected LLM and persists one set per local date', async () => {
    const sid = sessionId('persist');
    let calls = 0;
    const generate = async () => { calls += 1; return validJson(); };
    const first = await today.getDailySet({ sessionId: sid, provider: 'ollama', model: 'test', generate });
    assert.equal(calls, 1);
    assert.equal(first.source, 'llm');
    assert.equal(first.ideas.length, 3);
    assert.equal(first.date, today.localDate());
    assert.deepEqual(first.ideas.map((i) => i.tier), ['easy', 'interesting', 'ambitious']);

    // A second call the same day must NOT re-run the LLM.
    const second = await today.getDailySet({ sessionId: sid, provider: 'ollama', model: 'test', generate });
    assert.equal(calls, 1);
    assert.deepEqual(second.ideas.map((i) => i.id), first.ideas.map((i) => i.id));

    // Persisted to disk (survives a cache reset / restart).
    today._reset();
    const reloaded = today.getDailySet({ sessionId: sid, provider: 'ollama', model: 'test', generate });
    assert.equal(calls, 1);
    const entry = await reloaded;
    assert.deepEqual(entry.ideas.map((i) => i.id), first.ideas.map((i) => i.id));
});

test('LLM failure falls back to a deterministic set and never throws', async () => {
    const sid = sessionId('fallback');
    const generate = async () => { throw new Error('Ollama offline'); };
    const entry = await today.getDailySet({ sessionId: sid, provider: 'ollama', model: 'test', generate });
    assert.equal(entry.source, 'fallback');
    assert.equal(entry.ideas.length, 3);
    assert.deepEqual(entry.ideas.map((i) => i.tier), ['easy', 'interesting', 'ambitious']);
    for (const idea of entry.ideas) {
        assert.ok(idea.title);
        assert.ok(['image', 'video', 'multi'].includes(idea.outputType));
    }
});

test('malformed LLM output falls back instead of persisting junk', async () => {
    const sid = sessionId('malformed');
    const generate = async () => 'I cannot help with that.';
    const entry = await today.getDailySet({ sessionId: sid, provider: 'ollama', model: 'test', generate });
    assert.equal(entry.source, 'fallback');
    assert.equal(entry.ideas.length, 3);
});

test('previewFallbackSet is transient, pending and never persisted', () => {
    const sid = sessionId('preview');
    const preview = today.previewFallbackSet({});
    assert.equal(preview.pending, true);
    assert.equal(preview.ideas.length, 3);
    assert.equal(today.peekDailySet(sid), null);
});

// --- Refresh / variety --------------------------------------------------------

test('refreshDailySet regenerates and remembers what was already shown', async () => {
    const sid = sessionId('refresh');
    const firstGenerate = async () => validJson();
    const first = await today.getDailySet({ sessionId: sid, provider: 'ollama', model: 'test', generate: firstGenerate });
    const firstTitles = first.ideas.map((i) => i.title);

    const secondJson = JSON.stringify([
        { tier: 'easy', title: 'Autumn park walk', brief: 'A leaf-strewn park walk in amber light.', outputType: 'image', themeId: 'seasonal-concepts', activity: 'walking-together', scene: 'park', outfitPack: 'casual-everyday' },
        { tier: 'interesting', title: 'Marble hallway editorial', brief: 'An editorial silhouette in a marble hallway.', outputType: 'image', themeId: 'fashion-editorial', activity: 'getting-ready', scene: 'studio', outfitPack: 'minimalist-neutral' },
        { tier: 'ambitious', title: 'Coastal travel film', brief: 'A short coastal travel film.', outputType: 'video', themeId: 'travel-adventure', activity: 'walking-together', scene: 'beach', outfitPack: 'vacation-summer' }
    ]);
    const refreshed = await today.refreshDailySet({ sessionId: sid, provider: 'ollama', model: 'test', generate: async () => secondJson });
    assert.equal(refreshed.source, 'llm');
    assert.notDeepEqual(refreshed.ideas.map((i) => i.title), firstTitles);
    // The day's history carries the previously shown ideas forward.
    const recentTitles = refreshed.recent.map((r) => r.title);
    assert.ok(firstTitles.every((t) => recentTitles.includes(t)));
    assert.ok(refreshed.ideas.every((i) => recentTitles.includes(i.title)));
});

// --- Lifecycle ----------------------------------------------------------------

test('markIdea updates status and resulting asset; findIdea looks it up', async () => {
    const sid = sessionId('lifecycle');
    const entry = await today.getDailySet({ sessionId: sid, provider: 'ollama', model: 'test', generate: async () => validJson() });
    const idea = entry.ideas[0];
    assert.equal(today.findIdea(sid, idea.id).status, 'new');

    today.markIdea(sid, idea.id, { status: 'selected' });
    assert.equal(today.findIdea(sid, idea.id).status, 'selected');

    today.markIdea(sid, idea.id, { status: 'completed', assetUrl: '/generated/x.png', generationId: '2026-01-01_0000_001' });
    const updated = today.findIdea(sid, idea.id);
    assert.equal(updated.status, 'completed');
    assert.equal(updated.assetUrl, '/generated/x.png');
    assert.equal(updated.generationId, '2026-01-01_0000_001');

    // Dismissal is a distinct, non-generating state.
    today.markIdea(sid, entry.ideas[1].id, { status: 'dismissed' });
    assert.equal(today.findIdea(sid, entry.ideas[1].id).status, 'dismissed');

    // The recent history reflects the acted-on status.
    today._reset();
    const reloaded = today.peekDailySet(sid);
    const row = reloaded.recent.find((r) => r.title === idea.title);
    assert.equal(row.status, 'completed');
});

test('markIdea clears a stale error on a fresh attempt or success', async () => {
    const sid = sessionId('clear-error');
    const entry = await today.getDailySet({ sessionId: sid, provider: 'ollama', model: 'test', generate: async () => validJson() });
    const idea = entry.ideas[0];
    today.markIdea(sid, idea.id, { status: 'new', lastError: 'boom' });
    assert.equal(today.findIdea(sid, idea.id).lastError, 'boom');
    today.markIdea(sid, idea.id, { status: 'selected' });
    assert.equal(today.findIdea(sid, idea.id).lastError, '');
    today.markIdea(sid, idea.id, { status: 'new', lastError: 'again' });
    today.markIdea(sid, idea.id, { status: 'completed', assetUrl: '/generated/a.png' });
    assert.equal(today.findIdea(sid, idea.id).lastError, '');
});

test('syncProductionOutcome resolves a video idea back to a terminal state', async () => {
    const sid = sessionId('prod');
    const entry = await today.getDailySet({ sessionId: sid, provider: 'ollama', model: 'test', generate: async () => validJson() });
    const idea = entry.ideas[2];
    assert.equal(today.isVideoIdea(idea), true);

    today.markIdea(sid, idea.id, { status: 'started', productionId: 'prod_123' });
    const found = today.findIdeaByProduction('prod_123');
    assert.equal(found.sessionId, sid);
    assert.equal(found.idea.id, idea.id);

    // A failed production returns the idea to new (retryable) with a reason.
    today.syncProductionOutcome('prod_123', 'failed', { message: 'render failed' });
    let updated = today.findIdea(sid, idea.id);
    assert.equal(updated.status, 'new');
    assert.equal(updated.lastError, 'render failed');

    // A completed production marks it completed with the asset and clears the error.
    today.markIdea(sid, idea.id, { status: 'started', productionId: 'prod_123' });
    today.syncProductionOutcome('prod_123', 'completed', { url: '/generated/v.mp4' });
    updated = today.findIdea(sid, idea.id);
    assert.equal(updated.status, 'completed');
    assert.equal(updated.assetUrl, '/generated/v.mp4');
    assert.equal(updated.lastError, '');
});

test('syncProductionOutcome ignores an unknown production', () => {
    assert.equal(today.syncProductionOutcome('does-not-exist', 'completed', {}), null);
    assert.equal(today.findIdeaByProduction('does-not-exist'), null);
});

// --- Idea -> Playground mapping ----------------------------------------------

test('buildIdeaStartInput maps a characterless image idea to a no-character Surprise', async () => {
    const sid = sessionId('map-image');
    const entry = await today.getDailySet({ sessionId: sid, provider: 'ollama', model: 'test', generate: async () => validJson() });
    const idea = entry.ideas[0];
    const input = today.buildIdeaStartInput(idea);
    assert.equal(input.themeId, 'lifestyle-candid');
    assert.equal(input.characterId, null);
    assert.equal(input.mode, 'none');
    assert.equal(input.activity, 'coffee-chat');
    assert.equal(input.sceneId, 'cafe');
    assert.equal(input.outfitPack, 'casual-everyday');
    // The direction is the creative brief, never the final prompt.
    assert.equal(input.customPrompt, idea.direction);
    assert.equal(today.isVideoIdea(idea), false);
});

test('buildIdeaStartInput uses character mode for a saved character idea', async () => {
    const sid = sessionId('map-character');
    const generate = async () => JSON.stringify([
        { tier: 'easy', title: 'A', brief: 'b', outputType: 'image', themeId: 'anything', activity: 'reading', scene: 'library', outfitPack: 'minimalist-neutral' },
        { tier: 'interesting', title: 'B', brief: 'b', outputType: 'image', themeId: 'anything', activity: 'coffee-chat', scene: 'cafe', outfitPack: 'casual-everyday' },
        { tier: 'ambitious', title: 'C', brief: 'b', outputType: 'video', themeId: 'anything', activity: 'walking-together', scene: 'park', outfitPack: 'casual-streetwear' }
    ]);
    const entry = await today.getDailySet({ sessionId: sid, provider: 'ollama', model: 'test', generate });
    const idea = entry.ideas[1];
    // Force a character onto the idea and remap.
    idea.characterId = 'char_example';
    idea.mode = 'character';
    const input = today.buildIdeaStartInput(idea);
    assert.equal(input.mode, 'character');
    assert.equal(input.characterId, 'char_example');
});

test('isVideoIdea is true for both video and multi-step ideas', () => {
    assert.equal(today.isVideoIdea({ outputType: 'video' }), true);
    assert.equal(today.isVideoIdea({ outputType: 'multi' }), true);
    assert.equal(today.isVideoIdea({ outputType: 'image' }), false);
});

// --- Client serialization -----------------------------------------------------

test('clientSet exposes labels, preview image and statuses', async () => {
    const sid = sessionId('client');
    const entry = await today.getDailySet({ sessionId: sid, provider: 'ollama', model: 'test', generate: async () => validJson() });
    const set = today.clientSet(entry);
    assert.equal(set.ideas.length, 3);
    const easy = set.ideas[0];
    assert.equal(easy.tierLabel, 'Easy');
    assert.equal(easy.outputLabel, 'Image');
    assert.equal(easy.themeLabel, 'Lifestyle & Candid');
    assert.equal(easy.activityLabel, activities.getActivity('coffee-chat').label);
    assert.equal(easy.sceneLabel, 'Caf\u00e9');
    assert.equal(easy.status, 'new');
    assert.equal(typeof easy.previewUrl, 'string');
});

test('the fallback set only names real catalog ids', () => {
    const ideas = today.fallbackIdeas('2026-05-05', '2026-05-05T09:00:00Z');
    assert.equal(ideas.length, 3);
    const activityIds = new Set(activities.listActivities({ groupSize: 1 }).map((a) => a.id));
    const packIds = new Set(outfitPacks.listPacks().map((p) => p.id));
    for (const idea of ideas) {
        assert.ok(idea.themeId && themes.listThemes().some((t) => t.id === idea.themeId));
        assert.ok(!idea.activityId || activityIds.has(idea.activityId));
        assert.ok(!idea.outfitPack || packIds.has(idea.outfitPack));
        assert.ok(idea.direction);
    }
});
