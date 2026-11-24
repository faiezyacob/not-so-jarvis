/* ============================================
   JARVIS — Image Arena battle tests
   Blind pairing, Elo movement, tie handling,
   device scoping and leaderboard reset. Pure
   metadata: no ComfyUI call and no image file.
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-battle-'));
process.env.BENCHMARK_PATH = path.join(TMP, 'benchmark-sessions.json');
process.env.BENCHMARK_RATINGS_PATH = path.join(TMP, 'benchmark-ratings.json');
process.env.BENCHMARK_AUTORESUME = 'false';

const store = require('../services/benchmark/store');
const battle = require('../services/benchmark/battle');

function job(id, modelId, status) {
    return {
        id,
        modelId,
        modelLabel: modelId.toUpperCase() + ' Model',
        status: status || 'completed',
        result: status === 'failed' ? null : { url: '/generated/' + id + '.png', width: 1024, height: 1024 },
        config: { width: 1024, height: 1024 },
        error: status === 'failed' ? { code: 'x', message: 'failed' } : null,
        createdAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:01.000Z'
    };
}

function seedSession(options) {
    const opts = options || {};
    const session = {
        id: opts.id || 'bm_one',
        sessionId: opts.sessionId === undefined ? 'dev1' : opts.sessionId,
        prompt: opts.prompt || 'a quiet harbour at dawn',
        mode: 'native',
        status: 'completed',
        jobs: opts.jobs || [
            job('job_a', 'qwen'),
            job('job_b', 'krea2'),
            job('job_c', 'moss')
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:02.000Z'
    };
    store.upsert(session);
    return session;
}

function fresh() {
    // Drop both the session cache and the ratings cache so each test starts clean.
    store.reset();
    battle._reset();
    try { fs.unlinkSync(process.env.BENCHMARK_PATH); } catch (err) { /* first run */ }
    try { fs.unlinkSync(process.env.BENCHMARK_RATINGS_PATH); } catch (err) { /* first run */ }
    store.reset();
    battle._reset();
}

test('a pair never reveals which model produced which side', () => {
    fresh();
    seedSession();
    const state = battle.getBattle('dev1');
    assert.ok(state.pair, 'expected a pair');
    assert.equal(state.pair.left.url.indexOf('qwen'), -1);
    assert.equal(state.pair.right.url.indexOf('qwen'), -1);
    assert.deepEqual(Object.keys(state.pair.left).sort(), ['height', 'prompt', 'url', 'width']);
    assert.equal(state.pair.left.modelId, undefined);
    assert.equal(state.pair.left.modelLabel, undefined);
    assert.equal(state.stats.results, 3);
});

test('a vote moves both ratings by the same amount and conserves the total', () => {
    fresh();
    seedSession();
    const state = battle.getBattle('dev1');
    const out = battle.submitVote('dev1', state.pair.token, 'left');
    const { left, right } = out.result;
    assert.equal(left.rating + right.rating, 2400);
    assert.equal(Math.abs(left.delta), Math.abs(right.delta));
    assert.ok(left.delta > 0, 'the winner gains rating');
    assert.ok(right.delta < 0, 'the loser drops rating');
    assert.equal(out.leaderboard.length, 2);
    assert.equal(out.leaderboard[0].label, left.label);
});

test('a tie leaves equal ratings unchanged', () => {
    fresh();
    seedSession();
    const state = battle.getBattle('dev1');
    const out = battle.submitVote('dev1', state.pair.token, 'tie');
    assert.equal(out.result.left.delta, 0);
    assert.equal(out.result.right.delta, 0);
    assert.equal(out.leaderboard[0].ties, 1);
    assert.equal(out.leaderboard[0].rating, 1200);
});

test('an already voted pair is not offered again while fresh pairs remain', () => {
    fresh();
    seedSession();
    const first = battle.getBattle('dev1');
    battle.submitVote('dev1', first.pair.token, 'left');
    const second = battle.getBattle('dev1');
    assert.ok(second.pair);
    assert.notEqual(second.pair.token, first.pair.token);
    assert.equal(second.stats.votes, 1, 'one vote counted');
    // With three models there are three pairs; the third draw must also be new.
    battle.submitVote('dev1', second.pair.token, 'right');
    const third = battle.getBattle('dev1');
    assert.ok(third.pair);
    assert.equal(third.stats.votes, 2);
    assert.equal(third.stats.pairs, 2);
    const seen = new Set([first.pair.token, second.pair.token]);
    assert.equal(seen.has(third.pair.token), false);
});

test('once every pair is rated the game keeps going and says so', () => {
    fresh();
    seedSession({
        jobs: [job('job_a', 'qwen'), job('job_b', 'krea2')]
    });
    const only = battle.getBattle('dev1');
    battle.submitVote('dev1', only.pair.token, 'left');
    const again = battle.getBattle('dev1');
    assert.ok(again.pair);
    assert.equal(again.pair.repeated, true);
});

test('votes and ratings are scoped to the owning device', () => {
    fresh();
    seedSession();
    const mine = battle.getBattle('dev1');
    battle.submitVote('dev1', mine.pair.token, 'left');
    assert.equal(battle.getBattle('dev1').stats.votes, 1);
    const other = battle.getBattle('someone-else');
    assert.equal(other.pair, null);
    assert.equal(other.reason, 'not_enough_results');
    assert.deepEqual(other.leaderboard, []);
});

test('a failed job never enters a battle', () => {
    fresh();
    seedSession({
        jobs: [job('job_a', 'qwen'), job('job_b', 'krea2', 'failed')]
    });
    const state = battle.getBattle('dev1');
    assert.equal(state.pair, null);
    assert.equal(state.reason, 'not_enough_results');
});

test('a single-engine session has nothing to compare', () => {
    fresh();
    seedSession({ jobs: [job('job_a', 'qwen')] });
    const state = battle.getBattle('dev1');
    assert.equal(state.pair, null);
    assert.equal(state.reason, 'not_enough_results');
});

test('cross-session pairs only match results that share the prompt', () => {
    fresh();
    seedSession({ id: 'bm_one', jobs: [job('job_a', 'qwen')] });
    seedSession({ id: 'bm_two', jobs: [job('job_b', 'krea2')], prompt: 'a quiet harbour at dawn' });
    const state = battle.getBattle('dev1');
    assert.ok(state.pair, 'a shared prompt makes two sessions comparable');
    assert.equal(state.pair.left.prompt, state.pair.right.prompt);
});

test('a stale or malformed token is rejected', () => {
    fresh();
    seedSession();
    assert.throws(() => battle.submitVote('dev1', 'nope', 'left'), /no longer valid/);
    assert.throws(() => battle.submitVote('dev1', 'bm_one:job_a|bm_one:job_zzz', 'left'), /no longer exists/);
    const state = battle.getBattle('dev1');
    assert.throws(() => battle.submitVote('dev1', state.pair.token, 'sideways'), /Pick a winner/);
});

test('reset clears every vote and rating for the device', () => {
    fresh();
    seedSession();
    const state = battle.getBattle('dev1');
    battle.submitVote('dev1', state.pair.token, 'left');
    const out = battle.resetBattle('dev1');
    assert.deepEqual(out.leaderboard, []);
    assert.equal(out.stats.votes, 0);
    const after = battle.getBattle('dev1');
    assert.deepEqual(after.leaderboard, []);
    assert.equal(after.stats.votes, 0);
});

test('the K factor settles after ten games', () => {
    assert.equal(battle.kFactor(0), 32);
    assert.equal(battle.kFactor(9), 16 + 16);
    assert.equal(battle.kFactor(10), 16);
    assert.equal(battle.expectedScore(1200, 1200), 0.5);
    assert.ok(Math.abs(battle.expectedScore(1400, 1200) - (1 - battle.expectedScore(1200, 1400))) < 1e-12);
});

test('the pair key is order independent', () => {
    const a = { sessionId: 'bm_one', jobId: 'job_a' };
    const b = { sessionId: 'bm_one', jobId: 'job_b' };
    assert.equal(battle.pairKey(a, b), battle.pairKey(b, a));
});

test('a scoped battle only pairs the results of that one session', () => {
    fresh();
    seedSession({ id: 'bm_one', jobs: [job('job_a', 'qwen'), job('job_b', 'krea2')] });
    seedSession({ id: 'bm_two', jobs: [job('job_c', 'moss'), job('job_d', 'minimax_h3_image')] });
    const scoped = battle.getBattle('dev1', { session: 'bm_two' });
    assert.ok(scoped.pair);
    assert.equal(scoped.sessionId, 'bm_two');
    assert.equal(scoped.pair.token.indexOf('bm_two:'), 0);
    assert.equal(scoped.stats.results, 2);
});

test('a scoped battle explains that the fresh pair is not ready yet', () => {
    fresh();
    seedSession({
        id: 'bm_new',
        jobs: [
            Object.assign(job('job_a', 'qwen'), { status: 'generating', result: null }),
            Object.assign(job('job_b', 'krea2'), { status: 'queued', result: null })
        ]
    });
    const scoped = battle.getBattle('dev1', { session: 'bm_new' });
    assert.equal(scoped.pair, null);
    assert.equal(scoped.reason, 'session_not_ready');
});

test('the local prompt pool is usable and can avoid the previous pick', () => {
    assert.ok(battle.PROMPTS.length >= 20);
    const pick = battle.randomPrompt();
    assert.ok(pick.prompt && pick.prompt.length > 10);
    assert.ok(pick.category);
    const texts = battle.PROMPTS.map((entry) => entry.text);
    assert.equal(new Set(texts).size, texts.length, 'no duplicate prompts');
    // Excluding everything but one must return that one.
    const only = battle.PROMPTS[0].text;
    const excluded = texts.filter((text) => text !== only);
    const forced = battle.randomPrompt({ exclude: excluded });
    assert.equal(forced.prompt, only);
    // Excluding the entire pool still returns a prompt rather than nothing.
    assert.ok(battle.randomPrompt({ exclude: texts }).prompt);
});

test('a fresh battle rosters every ready engine when no fighter is pinned', () => {
    const discovered = [
        { id: 'qwen', label: 'Qwen Image 2.1', available: true },
        { id: 'krea2', label: 'Krea 2', available: true },
        { id: 'moss', label: 'MOSS-Image', available: false, reason: 'model files missing' },
        { id: 'minimax_h3_image', label: 'MiniMax H3 Image', available: true }
    ];
    const roster = battle.resolveRoster(discovered);
    assert.deepEqual(roster.models, ['qwen', 'krea2', 'minimax_h3_image']);
    assert.equal(roster.pinned, false);
    assert.equal(roster.readyCount, 3);
    assert.deepEqual(roster.unavailable, []);
});

test('a pinned roster is respected and unready ids are reported, not dropped silently', () => {
    const discovered = [
        { id: 'qwen', label: 'Qwen Image 2.1', available: true },
        { id: 'krea2', label: 'Krea 2', available: true },
        { id: 'moss', label: 'MOSS-Image', available: false, reason: 'model files missing' }
    ];
    const ok = battle.resolveRoster(discovered, ['krea2', 'qwen', 'krea2']);
    assert.deepEqual(ok.models, ['krea2', 'qwen'], 'duplicates collapse');
    assert.equal(ok.pinned, true);

    const bad = battle.resolveRoster(discovered, ['qwen', 'moss', 'ghost']);
    assert.deepEqual(bad.models, ['qwen']);
    assert.deepEqual(bad.unavailable.map((model) => model.id), ['moss', 'ghost']);
    assert.equal(bad.unavailable[1].reason, 'not registered');
});

test('a roster with fewer than two ready engines cannot start a battle', () => {
    const roster = battle.resolveRoster([{ id: 'qwen', label: 'Qwen', available: true }]);
    assert.equal(roster.models.length, 1);
    assert.equal(roster.readyCount, 1);
});

test('the finished lineup names the model behind every image, after the set is judged', () => {
    fresh();
    seedSession({
        id: 'bm_set',
        jobs: [job('job_a', 'qwen'), job('job_b', 'krea2'), job('job_c', 'moss')]
    });
    const line = battle.getLineup('dev1', { session: 'bm_set' });
    assert.equal(line.sessionId, 'bm_set');
    assert.equal(line.prompt, 'a quiet harbour at dawn');
    assert.equal(line.completed, 3);
    assert.deepEqual(line.lineup.map((entry) => entry.modelLabel).sort(),
        ['KREA2 Model', 'MOSS Model', 'QWEN Model']);
    line.lineup.forEach((entry) => {
        assert.ok(entry.url.indexOf('/generated/') === 0);
        assert.equal(entry.rating, 1200);
    });
});

test('the lineup only includes completed results and never another device', () => {
    fresh();
    seedSession({
        id: 'bm_set',
        jobs: [job('job_a', 'qwen'), job('job_b', 'krea2', 'failed')]
    });
    const line = battle.getLineup('dev1', { session: 'bm_set' });
    assert.equal(line.completed, 1);
    assert.deepEqual(line.lineup.map((entry) => entry.modelId), ['qwen']);
    assert.throws(() => battle.getLineup('someone-else', { session: 'bm_set' }), /not found/);
    assert.throws(() => battle.getLineup('dev1', { session: 'missing' }), /not found/);
});
