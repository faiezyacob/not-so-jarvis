/* SPDX-License-Identifier: MIT */

/* ============================================
   JARVIS - Agent Task Store
   Durable, server-side persistence for unified
   agent tasks. Tasks are owned by a device
   session and survive server restarts (the
   JSON file is rewritten on every change).
   ============================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DEFAULT_FILE = process.env.AGENT_TASKS_PATH || path.join(DATA_DIR, 'agent-tasks.json');
const MAX_TASKS = 60;
const MAX_EVENTS = 150;
const EVENT_MESSAGE_MAX = 400;

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];
const ACTIVE_STATUSES = ['queued', 'running', 'paused', 'awaiting_approval'];

function nowIso() {
    return new Date().toISOString();
}

function truncate(value, max) {
    const text = String(value === undefined || value === null ? '' : value);
    if (text.length <= max) return text;
    return text.slice(0, max - 1) + '\u2026';
}

function jsonClone(value) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return null;
    }
}

function isTerminal(task) {
    return Boolean(task && TERMINAL_STATUSES.indexOf(task.status) !== -1);
}

function isActive(task) {
    return Boolean(task && ACTIVE_STATUSES.indexOf(task.status) !== -1);
}

// The public shape sent to the browser. Internal ownership (sessionId) is
// never exposed; tool outputs are already bounded before they reach the store.
function publicTask(task) {
    if (!task) return null;
    const clone = jsonClone(task);
    if (!clone) return null;
    delete clone.sessionId;
    return clone;
}

function normalizeTask(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !raw.id.trim()) return null;
    const task = jsonClone(raw) || {};
    task.request = truncate(task.request, 4000);
    task.goal = truncate(task.goal || task.request, 4000);
    task.taskKind = task.taskKind === 'tool' ? 'tool' : 'agent';
    task.origin = task.origin === 'chat' ? 'chat' : (task.origin || null);
    task.parentTaskId = task.parentTaskId || null;
    task.completionCriteria = Array.isArray(task.completionCriteria)
        ? task.completionCriteria.map((item) => truncate(item, 200)).filter(Boolean).slice(0, 6)
        : [];
    task.guidance = Array.isArray(task.guidance)
        ? task.guidance.filter((entry) => entry && entry.text).slice(-5)
        : [];
    task.receipts = Array.isArray(task.receipts) ? task.receipts.slice(-20) : [];
    task.status = typeof task.status === 'string' ? task.status : 'failed';
    task.plan = task.plan && typeof task.plan === 'object' ? task.plan : null;
    if (task.plan && !Array.isArray(task.plan.steps)) task.plan.steps = [];
    if (task.plan) {
        task.plan.steps = task.plan.steps.filter((step) => step && typeof step === 'object');
    }
    task.events = Array.isArray(task.events) ? task.events.slice(-MAX_EVENTS) : [];
    task.events.forEach((event, index) => {
        event.seq = Number.isInteger(event.seq) ? event.seq : index + 1;
        event.message = truncate(event.message, EVENT_MESSAGE_MAX);
    });
    task.createdAt = task.createdAt || nowIso();
    task.updatedAt = task.updatedAt || task.createdAt;
    task.currentStep = task.currentStep || null;
    task.result = task.result || null;
    task.error = task.error || null;
    task.approval = task.approval || null;
    return task;
}

/* ============================================
   Store factory
   ============================================ */

function createTaskStore(options = {}) {
    const filePath = options.filePath || DEFAULT_FILE;
    const bus = new EventEmitter();
    bus.setMaxListeners(60);

    let tasks = null;

    function load() {
        if (tasks) return tasks;
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(raw);
            const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.tasks) ? parsed.tasks : []);
            tasks = list.map(normalizeTask).filter(Boolean);
            tasks.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
            if (tasks.length > MAX_TASKS) tasks.length = MAX_TASKS;
        } catch {
            tasks = [];
        }
        return tasks;
    }

    function save() {
        try {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, JSON.stringify({ updatedAt: nowIso(), tasks }, null, 2), 'utf-8');
        } catch (err) {
            console.warn('[agent] Could not persist tasks:', err.message);
        }
    }

    function prune() {
        if (tasks.length <= MAX_TASKS) return;
        // Only terminal tasks are pruned so an active task is never dropped
        // while it is still running.
        for (let i = tasks.length - 1; i >= 0 && tasks.length > MAX_TASKS; i--) {
            if (isTerminal(tasks[i])) tasks.splice(i, 1);
        }
        if (tasks.length > MAX_TASKS) tasks.length = MAX_TASKS;
    }

    function notify(task, event) {
        const snapshot = publicTask(task);
        try {
            if (event) bus.emit('event:' + task.id, event, snapshot);
            bus.emit('update:' + task.id, snapshot);
            bus.emit('update', snapshot);
        } catch (err) {
            console.warn('[agent] Task listener failed:', err.message);
        }
    }

    function getInternal(id) {
        load();
        if (!id) return null;
        return tasks.find((task) => task.id === id) || null;
    }

    function get(id) {
        return publicTask(getInternal(id));
    }

    function findByClientRequestId(conversationId, clientRequestId) {
        if (!clientRequestId) return null;
        load();
        const task = tasks.find((item) => item.clientRequestId === clientRequestId &&
            (!conversationId || item.conversationId === conversationId));
        return publicTask(task);
    }

    function create(input) {
        load();
        const data = input || {};
        const task = {
            id: crypto.randomUUID(),
            sessionId: data.sessionId || null,
            conversationId: data.conversationId || null,
            clientRequestId: data.clientRequestId || null,
            request: truncate(data.request, 4000),
            goal: truncate(data.goal || data.request, 4000),
            taskKind: data.taskKind === 'tool' ? 'tool' : 'agent',
            origin: data.origin || null,
            parentTaskId: data.parentTaskId || null,
            completionCriteria: Array.isArray(data.completionCriteria)
                ? data.completionCriteria.map((item) => truncate(item, 200)).filter(Boolean).slice(0, 6)
                : [],
            guidance: [],
            receipts: [],
            status: 'queued',
            plan: null,
            currentStep: null,
            events: [],
            result: null,
            error: null,
            approval: null,
            limits: jsonClone(data.limits) || null,
            planSource: null,
            warnings: [],
            createdAt: nowIso(),
            updatedAt: nowIso(),
            startedAt: null,
            completedAt: null,
            cancelledAt: null
        };
        tasks.unshift(task);
        prune();
        save();
        notify(task);
        return publicTask(task);
    }

    function update(id, patch) {
        const task = getInternal(id);
        if (!task) return null;
        const changes = patch || {};
        for (const [key, value] of Object.entries(changes)) {
            if (key === 'sessionId' || key === 'id' || key === 'events') continue;
            task[key] = value;
        }
        task.updatedAt = nowIso();
        save();
        notify(task);
        return publicTask(task);
    }

    function addEvent(id, input) {
        const task = getInternal(id);
        if (!task) return null;
        const last = task.events.length ? task.events[task.events.length - 1].seq : 0;
        const data = input || {};
        const event = {
            seq: (Number.isInteger(data.seq) ? data.seq : last + 1),
            at: nowIso(),
            type: truncate(data.type || 'log', 40),
            status: data.status ? truncate(data.status, 40) : task.status,
            stepId: data.stepId || null,
            title: data.title ? truncate(data.title, 160) : null,
            message: truncate(data.message, EVENT_MESSAGE_MAX),
            data: data.data === undefined ? null : data.data
        };
        task.events.push(event);
        if (task.events.length > MAX_EVENTS) task.events.splice(0, task.events.length - MAX_EVENTS);
        task.updatedAt = nowIso();
        save();
        notify(task, jsonClone(event));
        return jsonClone(event);
    }

    function list(filter) {
        load();
        const opts = filter || {};
        let out = tasks.slice();
        if (opts.sessionId) out = out.filter((task) => task.sessionId === opts.sessionId);
        if (opts.conversationId) out = out.filter((task) => task.conversationId === opts.conversationId);
        if (typeof opts.limit === 'number' && opts.limit > 0) out = out.slice(0, opts.limit);
        return out.map(publicTask);
    }

    function snapshot(id) {
        return publicTask(getInternal(id));
    }

    function subscribe(id, handler) {
        const key = 'event:' + id;
        bus.on(key, handler);
        return () => bus.removeListener(key, handler);
    }

    function subscribeUpdate(id, handler) {
        const key = 'update:' + id;
        bus.on(key, handler);
        return () => bus.removeListener(key, handler);
    }

    // After a server restart a task that was mid-run can no longer continue.
    // Mark it failed (history is kept) instead of leaving a zombie "running"
    // task forever. Pending approvals are also closed, because the engine
    // that owned the paused step is gone.
    function reconcileOrphans() {
        load();
        let changed = false;
        tasks.forEach((task) => {
            if (!isActive(task)) return;
            const previous = task.status;
            task.status = 'failed';
            task.error = {
                code: 'task_interrupted',
                message: 'The server restarted before this task finished.'
            };
            task.completedAt = nowIso();
            task.approval = task.approval && task.approval.status === 'pending'
                ? Object.assign({}, task.approval, { status: 'cancelled', decidedAt: nowIso() })
                : task.approval;
            task.updatedAt = nowIso();
            task.events.push({
                seq: (task.events.length ? task.events[task.events.length - 1].seq : 0) + 1,
                at: nowIso(),
                type: 'error',
                status: 'failed',
                stepId: task.currentStep || null,
                title: 'Task interrupted',
                message: 'Server restarted while the task was ' + previous + '.',
                data: { code: 'task_interrupted' }
            });
            changed = true;
        });
        if (changed) save();
        return changed;
    }

    function activeCount(sessionId) {
        load();
        return tasks.filter((task) => isActive(task) && (!sessionId || task.sessionId === sessionId)).length;
    }

    // Delete every task owned by a conversation for this session (used when the
    // conversation itself is deleted). Returns the number removed.
    function removeForConversation(conversationId, sessionId) {
        load();
        if (!conversationId) return 0;
        const before = tasks.length;
        tasks = tasks.filter((task) => !(task.conversationId === conversationId &&
            (!sessionId || task.sessionId === sessionId)));
        const removed = before - tasks.length;
        if (removed) save();
        return removed;
    }

    return {
        filePath,
        load,
        get,
        snapshot,
        publicTask,
        findByClientRequestId,
        create,
        update,
        addEvent,
        list,
        activeCount,
        removeForConversation,
        reconcileOrphans,
        subscribe,
        subscribeUpdate,
        isTerminal,
        isActive
    };
}

const defaultStore = createTaskStore();

module.exports = Object.assign(defaultStore, {
    createTaskStore,
    publicTask,
    isTerminal,
    isActive,
    TERMINAL_STATUSES,
    ACTIVE_STATUSES,
    MAX_TASKS,
    MAX_EVENTS
});
