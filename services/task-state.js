/* ============================================
   JARVIS — ActiveTask State Store
   Holds the per-conversation active task /
   task context so a task can persist across
   multiple turns. Tasks are keyed by
   conversation id and persisted to disk so
   they survive server restarts.
   ============================================ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'task-state.json');

function loadStore() {
    try {
        if (!fs.existsSync(DATA_FILE)) return {};
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
        console.error('Failed to load task state:', e.message);
        return {};
    }
}

function saveStore() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        const obj = {};
        for (const [id, task] of tasks) {
            obj[id] = task;
        }
        fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed to save task state:', e.message);
    }
}

const tasks = new Map(Object.entries(loadStore()));

function createEmptyTask() {
    return {
        type: null,                 // 'image' | 'video' | 'audio' | null
        operation: null,            // 'generate' | 'modify' | 'extend' | null
        prompt: '',                 // current / effective prompt
        originalPrompt: '',         // original concept (kept for the task)
        generatedAsset: null,       // last generated asset url/file
        parameters: {},             // relevant generation parameters
        lastAction: '',             // high level description of last action
        status: 'idle'              // 'idle' | 'running' | 'completed' | 'failed'
    };
}

function getTask(conversationId) {
    if (!conversationId) return createEmptyTask();
    if (!tasks.has(conversationId)) {
        tasks.set(conversationId, createEmptyTask());
    }
    return tasks.get(conversationId);
}

function setTask(conversationId, patch) {
    const task = getTask(conversationId);
    if (patch && typeof patch === 'object') {
        Object.assign(task, patch);
    }
    tasks.set(conversationId, task);
    saveStore();
    return task;
}

function clearTask(conversationId) {
    tasks.set(conversationId, createEmptyTask());
    saveStore();
    return tasks.get(conversationId);
}

function hasTask(conversationId) {
    if (!conversationId) return false;
    const task = tasks.get(conversationId);
    return Boolean(task && task.type);
}

module.exports = {
    createEmptyTask,
    getTask,
    setTask,
    clearTask,
    hasTask
};
