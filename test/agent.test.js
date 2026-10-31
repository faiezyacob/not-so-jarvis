/* SPDX-License-Identifier: MIT */

/* ============================================
   JARVIS - Agent Mode tests
   The task engine is exercised with an in-memory
   LLM stub, a stub tool registry and a temp task
   store. No Ollama/ComfyUI/network calls run.
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-agent-'));

const taskStoreModule = require('../services/agent/task-store');
const toolsModule = require('../services/agent/tools');
const planner = require('../services/agent/planner');
const engineModule = require('../services/agent/engine');

test.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

let counter = 0;

function makeStore() {
    counter++;
    return taskStoreModule.createTaskStore({ filePath: path.join(tempDir, 'tasks-' + counter + '.json') });
}

function argsSchema(properties, required) {
    return {
        type: 'object',
        properties: properties || {},
        required: required || [],
        additionalProperties: false
    };
}

function makeRegistry(options) {
    const opts = options || {};
    const calls = { metrics: 0, models: 0, comfy: 0, log: 0, context: 0, write: 0, slow: 0, second: 0 };
    const definitions = [
        {
            name: 'system_metrics',
            description: 'Read system metrics',
            schema: argsSchema({}),
            handler: async () => {
                calls.metrics++;
                return {
                    cpu: { usagePercent: 12.5, cores: 16, clock: '4.2 GHz', name: 'Test CPU' },
                    ram: { usagePercent: 40, usedGB: 12.8, totalGB: 32, freeGB: 19.2 },
                    gpu: { name: 'Test GPU', utilizationPercent: 7, temperatureC: 45 },
                    vram: { available: true, usagePercent: 25, usedGB: 6, totalGB: 24, freeGB: 18 }
                };
            }
        },
        {
            name: 'list_models',
            description: 'List models',
            schema: argsSchema({ loadedOnly: { type: 'boolean', default: false } }),
            handler: async () => {
                calls.models++;
                return {
                    provider: 'ollama',
                    online: true,
                    installedCount: 2,
                    models: [{ name: 'llama3.2', sizeGB: 2 }, { name: 'qwen2.5', sizeGB: 4 }],
                    running: [{ name: 'llama3.2', vramGB: 2 }]
                };
            }
        },
        {
            name: 'comfyui_status',
            description: 'Read ComfyUI status',
            schema: argsSchema({}),
            handler: async () => {
                calls.comfy++;
                return { available: true, queue: { running: 0, pending: 0 }, devices: [], system: null };
            }
        },
        {
            name: 'read_log',
            description: 'Read a configured log',
            schema: argsSchema({
                logId: { type: 'string', maxLength: 32, enum: ['app'] },
                lines: { type: 'integer', minimum: 1, maximum: 200, default: 10 }
            }, ['logId']),
            outputLimit: 4000,
            handler: async () => {
                calls.log++;
                return { source: 'App log', logId: 'app', lines: [], lineCount: 0, errorLineCount: 0, truncated: false };
            }
        },
        {
            name: 'app_context',
            description: 'Read app context',
            schema: argsSchema({ section: { type: 'string', enum: ['overview', 'conversation', 'media'], default: 'overview' } }),
            handler: async (args, ctx) => {
                calls.context++;
                return { section: args.section, provider: 'ollama', model: 'llama3.2', hasConversation: Boolean(ctx.conversationId) };
            }
        },
        {
            name: 'slow_tool',
            description: 'A slow read',
            schema: argsSchema({}),
            handler: () => new Promise((resolve) => setTimeout(() => {
                calls.slow++;
                resolve({ ok: true });
            }, opts.slowDelay || 250))
        },
        {
            name: 'second_tool',
            description: 'Second read',
            schema: argsSchema({}),
            handler: async () => {
                calls.second++;
                return { ok: true };
            }
        },
        {
            name: 'write_file',
            description: 'Test-only write tool (requires approval)',
            schema: argsSchema({ value: { type: 'string', maxLength: 20 } }),
            requiresApproval: true,
            write: true,
            handler: async () => {
                calls.write++;
                return { written: true };
            }
        }
    ];
    return { registry: toolsModule.createRegistry(definitions), calls };
}

function makeLlm(planReply, summaryReply) {
    const state = { planCalls: 0, summaryCalls: 0 };
    const llm = async (messages) => {
        const text = (messages || []).map((message) => message.content).join('\n');
        if (/planning component/i.test(text)) {
            state.planCalls++;
            if (typeof planReply === 'function') return planReply(state.planCalls);
            if (planReply instanceof Error) throw planReply;
            return planReply;
        }
        state.summaryCalls++;
        if (typeof summaryReply === 'function') return summaryReply(state.summaryCalls);
        if (summaryReply instanceof Error) throw summaryReply;
        return summaryReply || JSON.stringify({ summary: 'Done.', suggestions: [] });
    };
    return { llm, state };
}

function makeEngine(options) {
    const opts = options || {};
    return engineModule.createEngine({
        store: opts.store,
        registry: opts.registry,
        llm: opts.llm,
        turnGate: opts.turnGate === undefined ? false : opts.turnGate,
        vram: opts.vram === undefined ? null : opts.vram,
        limits: Object.assign({
            maxSteps: 6,
            maxToolCalls: 8,
            plannerTimeoutMs: 1000,
            stepTimeoutMs: 1000,
            summaryTimeoutMs: 1000,
            taskTimeoutMs: 5000,
            maxConcurrentPerSession: 2,
            maxRequestChars: 2000
        }, opts.limits || {})
    });
}

function start(engine, request, extra) {
    return engine.start(Object.assign({
        request: request || 'Check my system metrics',
        conversationId: 'conv-1',
        sessionId: 'session-1'
    }, extra || {}));
}

async function waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 3000);
    while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for condition.');
}

const METRICS_PLAN = JSON.stringify({
    understanding: 'Check CPU and RAM usage.',
    steps: [{ title: 'Read system metrics', tool: 'system_metrics', args: {} }]
});

const DONE_SUMMARY = JSON.stringify({
    summary: 'The machine is idle and healthy.',
    suggestions: ['Run this again later.']
});

test('task lifecycle completes with ordered events and grounded facts', async () => {
    const store = makeStore();
    const { registry, calls } = makeRegistry();
    const { llm } = makeLlm(METRICS_PLAN, DONE_SUMMARY);
    const engine = makeEngine({ store, registry, llm });

    const { task } = start(engine);
    assert.equal(task.status, 'queued');
    const finished = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'completed' ? current : null;
    });
    assert.equal(calls.metrics, 1);
    assert.equal(finished.plan.steps.length, 1);
    assert.equal(finished.plan.steps[0].status, 'completed');
    assert.equal(finished.result.summary, 'The machine is idle and healthy.');
    assert.equal(finished.result.summarySource, 'model');
    assert.ok(finished.result.verifiedFacts.some((fact) => /CPU usage: 12\.5%/.test(fact)));
    assert.ok(finished.result.verifiedFacts.some((fact) => /RAM usage: 12\.8 GB/.test(fact)));
    assert.doesNotThrow(() => JSON.stringify(finished));
    assert.equal(finished.sessionId, undefined);

    const seqs = finished.events.map((event) => event.seq);
    assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length);
    assert.equal(finished.events[0].type, 'status');
    assert.equal(finished.events[finished.events.length - 1].type, 'result');
});

test('verified facts stay tool-derived even if the model summary invents a number', async () => {
    const store = makeStore();
    const { registry } = makeRegistry();
    const Invented = JSON.stringify({ summary: 'CPU is at 99% and needs attention.', suggestions: [] });
    const { llm } = makeLlm(METRICS_PLAN, Invented);
    const engine = makeEngine({ store, registry, llm });

    const { task } = start(engine);
    const finished = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'completed' ? current : null;
    });
    assert.ok(finished.result.verifiedFacts.every((fact) => !/99%/.test(fact)));
    assert.ok(finished.result.verifiedFacts.some((fact) => /12\.5%/.test(fact)));
    assert.equal(finished.result.summarySource, 'deterministic');
    assert.ok(!/99%/.test(finished.result.summary));
    assert.ok(finished.result.warnings.some((warning) => /values not present in tool results/i.test(warning)));
});

test('invalid tool arguments are rejected before the handler runs', async () => {
    const store = makeStore();
    const { registry, calls } = makeRegistry();
    const badPlan = JSON.stringify({
        understanding: 'Read a log.',
        steps: [{ title: 'Read log', tool: 'read_log', args: { logId: 'app', path: 'C:\\Windows\\win.ini' } }]
    });
    const { llm } = makeLlm(badPlan, DONE_SUMMARY);
    const engine = makeEngine({ store, registry, llm });

    const { task } = start(engine, 'read the app log');
    const finished = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'failed' ? current : null;
    });
    assert.equal(calls.log, 0);
    assert.equal(finished.error.code, 'all_steps_failed');
    assert.equal(finished.plan.steps[0].status, 'failed');
    assert.equal(finished.plan.steps[0].error.code, 'invalid_tool_arguments');
});

test('a malformed first plan is retried once and then succeeds', async () => {
    const store = makeStore();
    const { registry } = makeRegistry();
    const { llm, state } = makeLlm((call) => call === 1 ? 'I cannot do JSON.' : METRICS_PLAN, DONE_SUMMARY);
    const engine = makeEngine({ store, registry, llm });

    const { task } = start(engine);
    const finished = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'completed' ? current : null;
    });
    assert.equal(state.planCalls, 2);
    assert.equal(finished.plan.source, 'model');
    assert.ok(finished.events.some((event) => event.type === 'retry'));
});

test('an unavailable model falls back to a deterministic read-only plan', async () => {
    const store = makeStore();
    const { registry, calls } = makeRegistry();
    const { llm } = makeLlm(new Error('Ollama is offline'), new Error('Ollama is offline'));
    const engine = makeEngine({ store, registry, llm });

    const { task } = start(engine, 'Check the CPU and GPU usage');
    const finished = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'completed' ? current : null;
    });
    assert.equal(finished.plan.source, 'fallback');
    assert.ok(finished.warnings.some((warning) => /model was unavailable/i.test(warning)));
    assert.ok(calls.metrics >= 1);
    assert.equal(finished.result.summarySource, 'deterministic');
});

test('a model that never returns a valid plan falls back after one retry', async () => {
    const store = makeStore();
    const { registry } = makeRegistry();
    const { llm, state } = makeLlm('{"steps": "nope"}', 'not json');
    const engine = makeEngine({ store, registry, llm });

    const { task } = start(engine, 'Check the application context');
    const finished = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'completed' ? current : null;
    });
    assert.equal(state.planCalls, 2);
    assert.equal(finished.plan.source, 'fallback');
    assert.ok(finished.warnings.some((warning) => /could not produce a valid plan/i.test(warning)));
});

test('cancellation prevents later steps from running', async () => {
    const store = makeStore();
    const { registry, calls } = makeRegistry({ slowDelay: 400 });
    const plan = JSON.stringify({
        understanding: 'Two reads.',
        steps: [
            { title: 'Slow read', tool: 'slow_tool', args: {} },
            { title: 'Second read', tool: 'second_tool', args: {} }
        ]
    });
    const { llm } = makeLlm(plan, DONE_SUMMARY);
    const engine = makeEngine({ store, registry, llm });

    const { task } = start(engine, 'run both reads');
    await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.plan && current.currentStep === 'step-1' ? current : null;
    });
    engine.cancel(task.id, 'session-1');
    const finished = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'cancelled' ? current : null;
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(calls.second, 0);
    assert.equal(finished.currentStep, null);
});

test('an agent task waits for the shared turn slot and releases it', async () => {
    const store = makeStore();
    const { registry } = makeRegistry();
    const { llm } = makeLlm(METRICS_PLAN, DONE_SUMMARY);
    const gate = { released: false, acquireCalls: 0, acquired: null };
    gate.acquire = (opts) => {
        gate.acquireCalls++;
        gate.acquired = opts;
        const promise = new Promise((resolve) => {
            gate.resolve = (release) => resolve({ id: 42, release });
        });
        promise.turnId = 42;
        if (typeof opts.onQueued === 'function') opts.onQueued(1, 42);
        return promise;
    };
    gate.cancelQueued = () => true;
    const engine = makeEngine({ store, registry, llm, turnGate: gate });

    const { task } = start(engine);
    await waitFor(() => gate.acquireCalls === 1 && gate.resolve ? true : null);
    assert.equal(store.snapshot(task.id).status, 'queued');
    gate.resolve(() => { gate.released = true; });
    const finished = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'completed' ? current : null;
    });
    assert.equal(finished.status, 'completed');
    assert.equal(gate.released, true);
    assert.ok(finished.events.some((event) => /Waiting for the current local task/.test(event.message)));
});

test('cancelling a queued agent task removes it from the turn queue', async () => {
    const store = makeStore();
    const { registry } = makeRegistry();
    const { llm } = makeLlm(METRICS_PLAN, DONE_SUMMARY);
    const gate = { cancelled: [], acquireCalls: 0 };
    gate.acquire = () => {
        gate.acquireCalls++;
        const promise = new Promise(() => {});
        promise.turnId = 77;
        return promise;
    };
    gate.cancelQueued = (id) => {
        gate.cancelled.push(id);
        return true;
    };
    const engine = makeEngine({ store, registry, llm, turnGate: gate });

    const { task } = start(engine);
    await waitFor(() => gate.acquireCalls === 1 ? true : null);
    engine.cancel(task.id, 'session-1');
    const finished = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'cancelled' ? current : null;
    });
    await waitFor(() => gate.cancelled.indexOf(77) !== -1 ? true : null);
    assert.equal(finished.status, 'cancelled');
    assert.deepEqual(gate.cancelled, [77]);
});

test('a tool timeout fails the step and the task safely', async () => {
    const store = makeStore();
    const { registry } = makeRegistry();
    const hanging = toolsModule.createRegistry([{
        name: 'hang',
        description: 'Never resolves',
        schema: argsSchema({}),
        handler: () => new Promise(() => {})
    }]);
    const plan = JSON.stringify({
        understanding: 'Hang.',
        steps: [{ title: 'Hang', tool: 'hang', args: {} }]
    });
    const { llm } = makeLlm(plan, DONE_SUMMARY);
    const engine = makeEngine({ store, registry: hanging, llm, limits: { stepTimeoutMs: 50, taskTimeoutMs: 1000 } });

    const { task } = start(engine, 'hang please');
    const finished = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'failed' ? current : null;
    });
    const failedEvent = finished.events.find((event) => event.type === 'step_failed');
    assert.equal(failedEvent.data.error.code, 'tool_timeout');
    assert.equal(finished.error.code, 'all_steps_failed');
    assert.equal(registry.names().length >= 1, true);
});

test('the tool-call limit stops the task before extra tools run', async () => {
    const store = makeStore();
    const { registry, calls } = makeRegistry();
    const plan = JSON.stringify({
        understanding: 'Three reads.',
        steps: [
            { title: 'Metrics', tool: 'system_metrics', args: {} },
            { title: 'Models', tool: 'list_models', args: {} },
            { title: 'Comfy', tool: 'comfyui_status', args: {} }
        ]
    });
    const { llm } = makeLlm(plan, DONE_SUMMARY);
    const engine = makeEngine({ store, registry, llm, limits: { maxToolCalls: 1 } });

    const { task } = start(engine, 'run three reads');
    const finished = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'failed' ? current : null;
    });
    assert.equal(calls.metrics, 1);
    assert.equal(calls.models, 0);
    assert.equal(calls.comfy, 0);
    assert.equal(finished.error.code, 'tool_limit_reached');
});

test('approval is required and executes the write tool exactly once', async () => {
    const store = makeStore();
    const { registry, calls } = makeRegistry();
    const plan = JSON.stringify({
        understanding: 'Write a value.',
        steps: [{ title: 'Write value', tool: 'write_file', args: { value: 'hello' } }]
    });
    const { llm } = makeLlm(plan, DONE_SUMMARY);
    const engine = makeEngine({ store, registry, llm });

    const { task } = start(engine, 'write hello');
    const waiting = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'awaiting_approval' ? current : null;
    });
    assert.equal(waiting.approval.status, 'pending');
    assert.equal(calls.write, 0);

    engine.decideApproval(task.id, 'approve', 'session-1');
    const finished = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'completed' ? current : null;
    });
    assert.equal(calls.write, 1);
    assert.equal(finished.approval.status, 'approved');
    assert.throws(() => engine.decideApproval(task.id, 'approve', 'session-1'), /no pending approval/i);
});

test('a rejected pending action never executes', async () => {
    const store = makeStore();
    const { registry, calls } = makeRegistry();
    const plan = JSON.stringify({
        understanding: 'Write a value.',
        steps: [{ title: 'Write value', tool: 'write_file', args: { value: 'hello' } }]
    });
    const { llm } = makeLlm(plan, DONE_SUMMARY);
    const engine = makeEngine({ store, registry, llm });

    const { task } = start(engine, 'write hello');
    await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'awaiting_approval' ? current : null;
    });
    engine.decideApproval(task.id, 'reject', 'session-1');
    const finished = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'failed' ? current : null;
    });
    assert.equal(calls.write, 0);
    assert.equal(finished.error.code, 'approval_rejected');
    assert.equal(finished.plan.steps[0].status, 'failed');
});

test('an unapproved action times out and never runs', async () => {
    const store = makeStore();
    const { registry, calls } = makeRegistry();
    const plan = JSON.stringify({
        understanding: 'Write a value.',
        steps: [{ title: 'Write value', tool: 'write_file', args: { value: 'hello' } }]
    });
    const { llm } = makeLlm(plan, DONE_SUMMARY);
    const engine = makeEngine({ store, registry, llm, limits: { taskTimeoutMs: 150 } });

    const { task } = start(engine, 'write hello');
    const finished = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'failed' ? current : null;
    }, 3000);
    assert.equal(calls.write, 0);
    assert.equal(finished.error.code, 'approval_timeout');
    assert.equal(finished.approval.status, 'timed_out');
});

test('duplicate client requests return the same task', async () => {
    const store = makeStore();
    const { registry } = makeRegistry({ slowDelay: 300 });
    const plan = JSON.stringify({
        understanding: 'Slow read.',
        steps: [{ title: 'Slow', tool: 'slow_tool', args: {} }]
    });
    const { llm } = makeLlm(plan, DONE_SUMMARY);
    const engine = makeEngine({ store, registry, llm });

    const first = start(engine, 'slow read', { clientRequestId: 'req-abc' });
    const second = start(engine, 'slow read', { clientRequestId: 'req-abc' });
    assert.equal(second.deduped, true);
    assert.equal(second.task.id, first.task.id);
    engine.cancel(first.task.id, 'session-1');
});

test('per-session concurrency is bounded', async () => {
    const store = makeStore();
    const { registry } = makeRegistry({ slowDelay: 300 });
    const plan = JSON.stringify({
        understanding: 'Slow read.',
        steps: [{ title: 'Slow', tool: 'slow_tool', args: {} }]
    });
    const { llm } = makeLlm(plan, DONE_SUMMARY);
    const engine = makeEngine({ store, registry, llm, limits: { maxConcurrentPerSession: 1 } });

    const first = start(engine, 'slow read');
    assert.throws(() => start(engine, 'another read'), (err) => err.code === 'agent_busy');
    engine.cancel(first.task.id, 'session-1');
});

test('request validation rejects missing/oversized goals', () => {
    const store = makeStore();
    const { registry } = makeRegistry();
    const { llm } = makeLlm(METRICS_PLAN, DONE_SUMMARY);
    const engine = makeEngine({ store, registry, llm, limits: { maxRequestChars: 20 } });

    assert.throws(() => start(engine, ''), (err) => err.code === 'invalid_request');
    assert.throws(() => start(engine, 'x'.repeat(40)), (err) => err.code === 'invalid_request');
    assert.throws(() => start(engine, 'goal', { conversationId: '' }), (err) => err.code === 'invalid_request');
    assert.throws(() => start(engine, 'goal', { sessionId: '' }), (err) => err.code === 'invalid_request');
});

test('tasks persist across a store reload and interrupted tasks reconcile', () => {
    const filePath = path.join(tempDir, 'persist.json');
    const storeA = taskStoreModule.createTaskStore({ filePath });
    const created = storeA.create({ sessionId: 'session-1', conversationId: 'conv-1', request: 'persisted goal' });
    storeA.update(created.id, { status: 'completed', result: { summary: 'kept' } });
    storeA.addEvent(created.id, { type: 'result', status: 'completed', message: 'kept' });

    const storeB = taskStoreModule.createTaskStore({ filePath });
    const reloaded = storeB.snapshot(created.id);
    assert.equal(reloaded.status, 'completed');
    assert.equal(reloaded.result.summary, 'kept');
    assert.equal(reloaded.events.length, 1);

    const orphan = storeB.create({ sessionId: 'session-1', conversationId: 'conv-1', request: 'running goal' });
    storeB.update(orphan.id, { status: 'running' });
    const storeC = taskStoreModule.createTaskStore({ filePath });
    assert.equal(storeC.reconcileOrphans(), true);
    const reconciled = storeC.snapshot(orphan.id);
    assert.equal(reconciled.status, 'failed');
    assert.equal(reconciled.error.code, 'task_interrupted');
    assert.ok(reconciled.events.some((event) => event.type === 'error'));
});

test('read-only tool registry rejects unlisted arguments and unknown tools', () => {
    const { registry } = makeRegistry();
    assert.throws(() => registry.validateArgs('read_log', { logId: 'app', path: 'C:\\Windows' }),
        (err) => err.code === 'invalid_tool_arguments');
    assert.throws(() => registry.validateArgs('shell', { command: 'whoami' }),
        (err) => err.code === 'unknown_tool');
    assert.throws(() => registry.validateArgs('read_log', { logId: 'other' }),
        (err) => err.code === 'invalid_tool_arguments');
    assert.throws(() => registry.validateArgs('read_log', { logId: 'app', lines: 5000 }),
        (err) => err.code === 'invalid_tool_arguments');
    assert.throws(() => toolsModule.createRegistry([{
        name: 'unsafe_write',
        description: 'Missing the approval flag',
        write: true,
        schema: argsSchema({}),
        handler: async () => ({ ok: true })
    }]), /must require approval/i);
});

test('configured log reading redacts secrets and user paths', async () => {
    const logPath = path.join(tempDir, 'agent-test.log');
    fs.writeFileSync(logPath, [
        'booting',
        'Error: failed with token hf_secretsecret123 and api_key=supersecret',
        'C:\\Users\\Alice\\private.txt',
        'Exception: something broke'
    ].join('\n'), 'utf-8');

    const sources = toolsModule.resolveLogSources(JSON.stringify([
        { id: 'test-log', label: 'Test log', path: logPath }
    ]));
    assert.equal(sources.length, 1);
    const registry = toolsModule.createDefaultRegistry({ logSources: sources });
    const result = await registry.execute('read_log', { logId: 'test-log', lines: 10 }, {});
    const text = result.lines.join('\n');
    assert.ok(!text.includes('secretsecret123'));
    assert.ok(!text.includes('supersecret'));
    assert.ok(!text.includes('Alice'));
    assert.ok(text.includes('hf_[redacted]'));
    assert.equal(result.errorLineCount, 2);
    assert.equal(result.truncated, false);

    assert.deepEqual(toolsModule.resolveLogSources('not json'), []);
    assert.deepEqual(toolsModule.resolveLogSources(JSON.stringify([{ id: 'bad id!', path: logPath }])), []);
});

test('the planner fallback only uses tools that exist in the catalog', () => {
    const catalog = [{
        name: 'system_metrics',
        description: 'Read metrics',
        arguments: argsSchema({})
    }];
    const plan = planner.fallbackPlan('read the error log and check metrics', catalog);
    assert.ok(plan.steps.length >= 1);
    assert.ok(plan.steps.every((step) => step.tool === 'system_metrics'));
    assert.equal(plan.source, 'fallback');
});

test('deleting a conversation removes its agent task records', () => {
    const store = makeStore();
    const { registry } = makeRegistry();
    const { llm } = makeLlm(METRICS_PLAN, DONE_SUMMARY);
    const engine = makeEngine({ store, registry, llm });
    const a = store.create({ sessionId: 'session-1', conversationId: 'conv-a', request: 'a' });
    const b = store.create({ sessionId: 'session-1', conversationId: 'conv-b', request: 'b' });
    assert.equal(store.list({ sessionId: 'session-1' }).length, 2);
    assert.equal(engine.removeForConversation('conv-a', 'session-1'), 1);
    const remaining = store.list({ sessionId: 'session-1' });
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, b.id);
    assert.equal(store.snapshot(a.id), null);
});

test('engine event replay returns events after a sequence number', async () => {
    const store = makeStore();
    const { registry } = makeRegistry();
    const { llm } = makeLlm(METRICS_PLAN, DONE_SUMMARY);
    const engine = makeEngine({ store, registry, llm });

    const { task } = start(engine);
    const finished = await waitFor(() => {
        const current = store.snapshot(task.id);
        return current && current.status === 'completed' ? current : null;
    });
    const middle = finished.events[Math.floor(finished.events.length / 2)].seq;
    const after = engine.eventsAfter(task.id, middle);
    assert.ok(after.length > 0);
    assert.ok(after.every((event) => event.seq > middle));
    assert.equal(engine.eventsAfter(task.id, finished.events[finished.events.length - 1].seq).length, 0);
});
