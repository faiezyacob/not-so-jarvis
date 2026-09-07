/* ============================================
   JARVIS — ActiveTask State Store
   Holds the per-conversation active task /
   task context so a task can persist across
   multiple turns. Tasks are keyed by
   conversation id and live in memory for the
   lifetime of the server session.
   ============================================ */

const tasks = new Map();

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
    return task;
}

function clearTask(conversationId) {
    tasks.set(conversationId, createEmptyTask());
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
