/* SPDX-License-Identifier: MIT */

/* ============================================
   JARVIS - Unified chat + capability routing
   Regression tests for the single-chat
   architecture: direct answers, tool-assisted
   responses, multi-step tasks, blocked requests,
   approval-gated cleanup, persistence, follow-ups
   and goal completion. No Ollama/ComfyUI/network.
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const capabilityRouter = require('../services/agent/capability-router');
const capabilities = require('../services/agent/capabilities');
const toolsModule = require('../services/agent/tools');
const taskStoreModule = require('../services/agent/task-store');
const engineModule = require('../services/agent/engine');
const planner = require('../services/agent/planner');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-unified-'));

test.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

let counter = 0;

function makeWorkspace() {
    counter++;
    const root = path.join(tempDir, 'workspace-' + counter);
    fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'keep'), { recursive: true });
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(path.join(root, 'cache', 'old.tmp'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(root, 'cache', 'old.log'), 'error line\n');
    fs.writeFileSync(path.join(root, 'logs', 'recent.log'), 'fresh\n');
    fs.writeFileSync(path.join(root, 'keep', 'notes.txt'), 'keep me');
    [path.join(root, 'cache', 'old.tmp'), path.join(root, 'cache', 'old.log')].forEach((file) => {
        fs.utimesSync(file, old / 1000, old / 1000);
    });
    return root;
}

function makeStore() {
    return taskStoreModule.createTaskStore({ filePath: path.join(tempDir, 'task-' + counter + '.json') });
}

function makeRegistry(root) {
    return toolsModule.createDefaultRegistry({
        allowedRoots: [root],
        deleteRoots: [root],
        logSources: []
    });
}

function capsFor(registry) {
    return capabilities.list(registry.names());
}

function makeEngine(options) {
    const opts = options || {};
    const limits = Object.assign({
        maxSteps: 6,
        maxToolCalls: 8,
        plannerTimeoutMs: 1000,
        stepTimeoutMs: 2000,
        summaryTimeoutMs: 1000,
        taskTimeoutMs: 5000,
        maxConcurrentPerSession: 2,
        maxRequestChars: 2000
    }, opts.limits || {});
    return engineModule.createEngine({
        store: opts.store,
        registry: opts.registry,
        llm: opts.llm,
        turnGate: false,
        vram: null,
        limits
    });
}

function makeLlm(planReply, summaryReply) {
    return async (messages) => {
        const text = (messages || []).map((message) => message.content).join('\n');
        if (/planning component/i.test(text)) return planReply;
        return summaryReply || JSON.stringify({ summary: 'Done.', suggestions: [] });
    };
}

function start(engine, input) {
    return engine.start(Object.assign({
        request: 'test goal',
        goal: 'test goal',
        completionCriteria: [],
        taskKind: 'agent',
        conversationId: 'conv-1',
        sessionId: 'session-1'
    }, input || {}));
}

async function waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 4000);
    while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for condition.');
}

function tempFilesRemaining(root) {
    return fs.readdirSync(path.join(root, 'cache')).filter((name) => /\.(tmp|log)$/.test(name));
}

/* ============================================
   1. Direct responses (existing pipelines)
   ============================================ */

test('image-prompt and ComfyUI generation requests stay direct responses', () => {
    const root = makeWorkspace();
    const registry = makeRegistry(root);
    const caps = capsFor(registry);

    const prompt = capabilityRouter.classify('Write an image prompt for a pretty Asian woman.', { capabilities: caps });
    assert.equal(prompt.action, capabilityRouter.ACTIONS.DIRECT);

    const generation = capabilityRouter.classify('Generate this image in ComfyUI.', { capabilities: caps });
    assert.equal(generation.action, capabilityRouter.ACTIONS.DIRECT);

    const ordinary = capabilityRouter.classify('Explain what a GPU does.', { capabilities: caps });
    assert.equal(ordinary.action, capabilityRouter.ACTIONS.DIRECT);

    const hello = capabilityRouter.classify('Hello there, how are you?', { capabilities: caps });
    assert.equal(hello.action, capabilityRouter.ACTIONS.DIRECT);
});

test('prompt writing is never hijacked even when it mentions a system noun', () => {
    assert.equal(capabilityRouter.shouldDeferToExistingPipeline('Write a prompt for a cinematic ComfyUI render'), true);
    const decision = capabilityRouter.classify('Write a video prompt for a slow-motion drone shot', {
        capabilities: []
    });
    assert.equal(decision.action, capabilityRouter.ACTIONS.DIRECT);
});

/* ============================================
   2. Tool-assisted vs multi-step
   ============================================ */

test('disk space search routes to the disk inspection tool', () => {
    const root = makeWorkspace();
    const registry = makeRegistry(root);
    const decision = capabilityRouter.classify('Find what is consuming disk space.', {
        capabilities: capsFor(registry)
    });
    assert.equal(decision.action, capabilityRouter.ACTIONS.TOOL);
    assert.deepEqual(decision.capabilities, ['disk_inspection']);
    assert.ok(decision.completionCriteria.some((criterion) => /largest/i.test(criterion)));
});

test('ComfyUI performance investigation plans evidence tools', () => {
    const root = makeWorkspace();
    const registry = makeRegistry(root);
    const decision = capabilityRouter.classify('Investigate my ComfyUI performance.', {
        capabilities: capsFor(registry)
    });
    assert.equal(decision.action, capabilityRouter.ACTIONS.AGENT);
    assert.ok(decision.capabilities.indexOf('comfyui_diagnostics') !== -1);
    assert.ok(decision.capabilities.indexOf('system_telemetry') !== -1);
    assert.ok(decision.capabilities.indexOf('log_inspection') !== -1);
    assert.ok(decision.capabilities.indexOf('media_history') !== -1);
});

test('disk usage only reports permitted roots and relative paths', async () => {
    const root = makeWorkspace();
    const registry = makeRegistry(root);
    const usage = await registry.execute('disk_usage', { top: 5 }, {});
    assert.equal(usage.permittedRoots.length, 1);
    assert.equal(usage.usage[0].accessible, true);
    const topFiles = usage.usage[0].topFiles;
    assert.ok(topFiles.length >= 1);
    assert.ok(topFiles.every((file) => !path.isAbsolute(file.path)));
    assert.ok(topFiles.some((file) => file.path === 'cache/old.tmp'));
});

/* ============================================
   3. Approval-gated deletion
   ============================================ */

test('temporary-file cleanup prepares exact candidates and never deletes before approval', async () => {
    const root = makeWorkspace();
    const registry = makeRegistry(root);
    const store = makeStore();
    const plan = JSON.stringify({
        understanding: 'Find and remove old temporary files.',
        steps: [
            { title: 'Scan temporary files', tool: 'find_temp_files', args: { olderThanDays: 7, maxCandidates: 10 } },
            { title: 'Delete candidates', tool: 'delete_files', args: {} }
        ]
    });
    const llm = makeLlm(plan, JSON.stringify({
        summary: 'Removed two approved temporary files.',
        suggestions: []
    }));
    const engine = makeEngine({ store, registry, llm });
    const decision = capabilityRouter.classify('Delete these temporary files.', { capabilities: capsFor(registry) });

    const { task } = start(engine, {
        request: 'Delete these temporary files.',
        goal: 'Delete these temporary files.',
        completionCriteria: decision.completionCriteria
    });

    const waiting = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'awaiting_approval' ? current : null;
    });
    assert.equal(waiting.approval.status, 'pending');
    assert.equal(waiting.approval.tool, 'delete_files');
    assert.equal(waiting.approval.stepId, 'step-2');
    assert.equal(tempFilesRemaining(root).length, 2, 'nothing may be deleted before approval');

    const approvalEvent = waiting.events.find((event) => event.type === 'approval');
    assert.ok(approvalEvent);
    assert.equal(approvalEvent.data.step.preview.candidateCount, 2);

    engine.decideApproval(task.id, 'approve', 'session-1');
    const finished = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && ['completed', 'failed'].indexOf(current.status) !== -1 ? current : null;
    });
    assert.equal(finished.status, 'completed');
    assert.equal(tempFilesRemaining(root).length, 0);
    assert.equal(finished.result.receipts.length, 1);
    assert.equal(finished.result.receipts[0].deletedCount, 2);
    assert.ok(finished.result.criteriaMet.every((entry) => entry.met));
    assert.ok(finished.result.verifiedFacts.some((fact) => /Deleted 2 approved file/.test(fact)));
});

test('a rejected cleanup deletes nothing and the task fails safely', async () => {
    const root = makeWorkspace();
    const registry = makeRegistry(root);
    const store = makeStore();
    const plan = JSON.stringify({
        understanding: 'Scan then delete.',
        steps: [
            { title: 'Scan', tool: 'find_temp_files', args: { olderThanDays: 7 } },
            { title: 'Delete', tool: 'delete_files', args: {} }
        ]
    });
    const engine = makeEngine({ store, registry, llm: makeLlm(plan) });
    const { task } = start(engine, { request: 'Delete the old temporary files.' });
    await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'awaiting_approval';
    });
    engine.decideApproval(task.id, 'reject', 'session-1');
    const finished = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'failed' ? current : null;
    });
    assert.equal(finished.error.code, 'approval_rejected');
    assert.equal(tempFilesRemaining(root).length, 2);
});

test('delete revalidates exact candidates and never deletes a changed or foreign target', async () => {
    const root = makeWorkspace();
    const registry = makeRegistry(root);
    const found = await registry.execute('find_temp_files', { olderThanDays: 7 }, { taskId: 'task-a' });
    assert.equal(found.candidateCount, 2);

    // A file that grows dramatically after the scan must be refused instead of
    // blindly deleting whatever is now at that path.
    fs.writeFileSync(path.join(root, 'cache', 'old.tmp'), 'x'.repeat(5 * 1024 * 1024));
    const result = await registry.execute('delete_files', {
        candidateSetId: found.candidateSetId,
        candidateIds: found.candidates.map((candidate) => candidate.id)
    }, { taskId: 'task-a' });
    assert.equal(result.deletedCount, 1);
    assert.equal(result.failedCount, 1);
    assert.ok(result.failed.some((entry) => /changed/.test(entry.error)));

    // A candidate set is scoped to the task that created it.
    await assert.rejects(registry.execute('delete_files', {
        candidateSetId: found.candidateSetId,
        candidateIds: ['c1']
    }, { taskId: 'task-b' }), (err) => err.code === 'candidate_set_unavailable');
});

test('delete tool rejects paths, extra arguments and unlisted candidate ids', () => {
    const root = makeWorkspace();
    const registry = makeRegistry(root);
    assert.throws(() => registry.validateArgs('delete_files', {
        candidateSetId: 'set',
        candidateIds: ['c1'],
        path: 'C:\\Windows\\win.ini'
    }), (err) => err.code === 'invalid_tool_arguments');
    assert.throws(() => registry.validateArgs('delete_files', {
        candidateSetId: 'set',
        candidateIds: 'c1'
    }), (err) => err.code === 'invalid_tool_arguments');
    assert.throws(() => registry.validateArgs('disk_usage', { path: root }), (err) => err.code === 'invalid_tool_arguments');
});

/* ============================================
   4. Blocked capabilities
   ============================================ */

test('unavailable capabilities explain the blocker instead of pretending', () => {
    const root = makeWorkspace();
    const registry = makeRegistry(root);
    const caps = capsFor(registry);

    const web = capabilityRouter.classify('Search the web for the latest GPU reviews.', { capabilities: caps });
    assert.equal(web.action, capabilityRouter.ACTIONS.BLOCKED);
    assert.match(web.blockedReason, /browser research is not available/i);

    const shell = capabilityRouter.classify('Run powershell whoami', { capabilities: caps });
    assert.equal(shell.action, capabilityRouter.ACTIONS.BLOCKED);
    assert.match(shell.blockedReason, /does not execute shell/i);

    const install = capabilityRouter.classify('Install a new dependency for ComfyUI.', { capabilities: caps });
    assert.equal(install.action, capabilityRouter.ACTIONS.BLOCKED);

    assert.ok(capabilities.summary(registry.names()).capabilities
        .some((capability) => capability.id === 'browser_research' && !capability.available));
});

test('a clarification is requested only when essential information is missing', () => {
    const root = makeWorkspace();
    const registry = makeRegistry(root);
    const decision = capabilityRouter.classify('Apply the fix to it.', { capabilities: capsFor(registry) });
    assert.equal(decision.action, capabilityRouter.ACTIONS.CLARIFY);
    assert.match(decision.question, /fix/i);
});

/* ============================================
   5. Failures, criteria and persistence
   ============================================ */

test('a failed tool never completes the task or invents a result', async () => {
    const root = makeWorkspace();
    const store = makeStore();
    const registry = toolsModule.createRegistry([{
        name: 'broken_tool',
        description: 'Always fails',
        schema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => { throw new Error('disk exploded'); }
    }]);
    const plan = JSON.stringify({
        understanding: 'Try the broken tool.',
        steps: [{ title: 'Broken', tool: 'broken_tool', args: {} }]
    });
    const engine = makeEngine({ store, registry, llm: makeLlm(plan) });
    const { task } = start(engine, { request: 'Check the broken thing.' });
    const finished = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'failed' ? current : null;
    });
    assert.equal(finished.error.code, 'all_steps_failed');
    assert.equal(finished.result, null);
    assert.equal(finished.plan.steps[0].status, 'failed');
    assert.equal(root.length > 0, true);
});

test('unmet completion criteria fail the task instead of claiming success', async () => {
    const root = makeWorkspace();
    const registry = makeRegistry(root);
    const store = makeStore();
    const plan = JSON.stringify({
        understanding: 'Only scan, do not delete.',
        steps: [{ title: 'Scan only', tool: 'find_temp_files', args: { olderThanDays: 7 } }]
    });
    const engine = makeEngine({ store, registry, llm: makeLlm(plan) });
    const decision = capabilityRouter.classify('Delete these temporary files.', { capabilities: capsFor(registry) });
    const { task } = start(engine, {
        request: 'Delete these temporary files.',
        goal: 'Delete these temporary files.',
        completionCriteria: decision.completionCriteria
    });
    const finished = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'failed' ? current : null;
    });
    assert.equal(finished.error.code, 'goal_unmet');
    assert.equal(tempFilesRemaining(root).length, 2);
    assert.ok(finished.result.criteriaMet.some((entry) => !entry.met));
});

test('task history survives a store reload and interrupted tasks reconcile', () => {
    const filePath = path.join(tempDir, 'history.json');
    const first = taskStoreModule.createTaskStore({ filePath });
    const created = first.create({
        sessionId: 'session-1',
        conversationId: 'conv-1',
        request: 'Investigate disk usage',
        goal: 'Find disk consumers',
        completionCriteria: ['Report the largest files.'],
        taskKind: 'agent'
    });
    first.update(created.id, {
        status: 'completed',
        result: { summary: 'Found them.', verifiedFacts: ['cache is large'] }
    });
    first.addEvent(created.id, { type: 'result', status: 'completed', message: 'Found them.' });

    const second = taskStoreModule.createTaskStore({ filePath });
    const reloaded = second.snapshot(created.id);
    assert.equal(reloaded.status, 'completed');
    assert.equal(reloaded.goal, 'Find disk consumers');
    assert.deepEqual(reloaded.completionCriteria, ['Report the largest files.']);
    assert.equal(reloaded.result.summary, 'Found them.');

    const orphan = second.create({ sessionId: 'session-1', conversationId: 'conv-1', request: 'running' });
    second.update(orphan.id, { status: 'running' });
    const third = taskStoreModule.createTaskStore({ filePath });
    assert.equal(third.reconcileOrphans(), true);
    assert.equal(third.snapshot(orphan.id).error.code, 'task_interrupted');
});

/* ============================================
   6. Follow-ups and lifecycle
   ============================================ */

test('follow-ups resolve against the active task instead of starting a new workflow', () => {
    const running = { id: 't1', status: 'running', approval: null, taskKind: 'agent' };
    assert.equal(capabilityRouter.classifyFollowUp('Cancel that task.', running).action,
        capabilityRouter.FOLLOW_UP_ACTIONS.CANCEL);
    assert.equal(capabilityRouter.classifyFollowUp('Pause for a moment.', running).action,
        capabilityRouter.FOLLOW_UP_ACTIONS.PAUSE);
    assert.equal(capabilityRouter.classifyFollowUp('Continue.', running).action,
        capabilityRouter.FOLLOW_UP_ACTIONS.CONTINUE);
    assert.equal(capabilityRouter.classifyFollowUp('What is a GPU?', running).action,
        capabilityRouter.FOLLOW_UP_ACTIONS.NONE);

    const paused = { id: 't2', status: 'paused', approval: null };
    assert.equal(capabilityRouter.classifyFollowUp('Keep going.', paused).action,
        capabilityRouter.FOLLOW_UP_ACTIONS.RESUME);

    const approval = { id: 't3', status: 'awaiting_approval', approval: { status: 'pending' } };
    assert.equal(capabilityRouter.classifyFollowUp('Yes, do it.', approval).action,
        capabilityRouter.FOLLOW_UP_ACTIONS.APPROVE);
    assert.equal(capabilityRouter.classifyFollowUp('No, reject that.', approval).action,
        capabilityRouter.FOLLOW_UP_ACTIONS.REJECT);

    const failed = { id: 't4', status: 'failed' };
    assert.equal(capabilityRouter.classifyFollowUp('Try the other approach.', failed).action,
        capabilityRouter.FOLLOW_UP_ACTIONS.RETRY);
});

test('pause stops later steps and resume continues the same task', async () => {
    const store = makeStore();
    const calls = [];
    const registry = toolsModule.createRegistry([
        {
            name: 'slow_read',
            description: 'Slow read',
            schema: { type: 'object', properties: {}, additionalProperties: false },
            handler: () => new Promise((resolve) => setTimeout(() => {
                calls.push('slow');
                resolve({ ok: true, value: 1 });
            }, 120))
        },
        {
            name: 'second_read',
            description: 'Second read',
            schema: { type: 'object', properties: {}, additionalProperties: false },
            handler: async () => { calls.push('second'); return { ok: true }; }
        }
    ]);
    const plan = JSON.stringify({
        understanding: 'Two reads',
        steps: [
            { title: 'Slow read', tool: 'slow_read', args: {} },
            { title: 'Second read', tool: 'second_read', args: {} }
        ]
    });
    const engine = makeEngine({ store, registry, llm: makeLlm(plan) });
    const { task } = start(engine, { request: 'Run both reads.' });

    await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.currentStep === 'step-1' ? current : null;
    });
    engine.pause(task.id, 'session-1');
    await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'paused' ? current : null;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(calls, ['slow'], 'the second step must not run while paused');

    engine.resume(task.id, 'session-1');
    const finished = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'completed' ? current : null;
    });
    assert.deepEqual(calls, ['slow', 'second']);
    assert.equal(finished.status, 'completed');
});

test('guidance is recorded on the running task and included in the result', async () => {
    const store = makeStore();
    const registry = toolsModule.createRegistry([{
        name: 'slow_read',
        description: 'Slow read',
        schema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 120))
    }]);
    const plan = JSON.stringify({
        understanding: 'Read once.',
        steps: [{ title: 'Read', tool: 'slow_read', args: {} }]
    });
    let summaryPrompt = '';
    const llm = async (messages) => {
        const text = messages.map((message) => message.content).join('\n');
        if (/planning component/i.test(text)) return plan;
        summaryPrompt = text;
        return JSON.stringify({ summary: 'Read one value.', suggestions: [] });
    };
    const engine = makeEngine({ store, registry, llm });
    const { task } = start(engine, { request: 'Read the value.' });
    await waitFor(() => store.snapshot(task.id).status === 'running');
    engine.addGuidance(task.id, 'Focus on the cache folder.', 'session-1');
    const finished = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'completed' ? current : null;
    });
    assert.equal(finished.guidance.length, 1);
    assert.equal(finished.guidance[0].text, 'Focus on the cache folder.');
    assert.ok(finished.events.some((event) => event.type === 'guidance'));
    assert.match(summaryPrompt, /Focus on the cache folder\./);
});

test('a finished task can be retried while keeping the original goal', async () => {
    const store = makeStore();
    const registry = toolsModule.createRegistry([{
        name: 'ok_tool',
        description: 'A safe read',
        schema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => ({ ok: true })
    }]);
    const plan = JSON.stringify({
        understanding: 'Read once.',
        steps: [{ title: 'Read', tool: 'ok_tool', args: {} }]
    });
    const engine = makeEngine({ store, registry, llm: makeLlm(plan) });
    const { task } = start(engine, {
        request: 'List local models.',
        goal: 'List local models.',
        completionCriteria: []
    });
    await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'completed' ? current : null;
    });
    const retried = engine.retry(task.id, 'session-1', { note: 'Try the other approach.' });
    assert.ok(retried.task.id !== task.id);
    assert.equal(retried.task.parentTaskId, task.id);
    assert.equal(retried.task.goal, 'List local models.');
    engine.cancel(retried.task.id, 'session-1');
});

/* ============================================
   7. Planner compatibility
   ============================================ */

test('the planner accepts completion criteria and never invents tools', () => {
    const catalog = [{
        name: 'disk_usage',
        description: 'Measure disk usage',
        arguments: { type: 'object', properties: {}, additionalProperties: false }
    }];
    const plan = planner.validatePlan({
        understanding: 'Measure disk usage.',
        completionCriteria: ['Report the largest directories.'],
        steps: [{ title: 'Measure', tool: 'disk_usage', args: {} }]
    }, catalog, 6);
    assert.deepEqual(plan.completionCriteria, ['Report the largest directories.']);
    assert.equal(plan.steps[0].status, 'pending');
    assert.throws(() => planner.validatePlan({
        steps: [{ title: 'Shell', tool: 'shell', args: {} }]
    }, catalog, 6), /unknown tool/i);

    const fallback = planner.fallbackPlan('Find what is consuming disk space', catalog);
    assert.equal(fallback.steps[0].tool, 'disk_usage');
});
