/* ============================================
   JARVIS — Task Router
   Context-aware intent / action router. It
   decides, before any tool runs, whether the
   current message should start a new task,
   continue / modify the active task, answer a
   question about the active task, or is simply
   unrelated conversation.

   The router is NOT allowed to let the LLM's
   natural-language response decide whether a
   tool executes. Instead it returns a structured
   decision the application uses to run (or not
   run) the tool, then the LLM describes the
   actual result.
   ============================================ */

const taskState = require('./task-state');
const imageGenerator = require('./image-generator');
const providers = require('../server/providers');
const conversationService = require('../server/conversation-service');

const RECENT_MESSAGES_FOR_ROUTER = 4;

const ROUTER_SYSTEM_PROMPT =
    'You are JARVIS\'s task router. Decide, from the active task context and the ' +
    'user\'s latest message, whether a tool should execute. You are an internal ' +
    'router — you never reply to the user and the user does not see your JSON. ' +
    'You are the ONLY authority on tool execution; the chat model is not.\n\n' +
    'Available tool: image_generation (Krea2/ComfyUI local image pipeline). ' +
    'It can generate a brand-new image or modify the current image concept.\n\n' +
    'Respond with ONLY a single JSON object, no markdown, no commentary:\n' +
    '{"intent": "...", "task": "...", "action": "...", "shouldExecuteTool": bool, ' +
    '"updatedPrompt": "..."}\n\n' +
    'intent (one of):\n' +
    '- "new_task": user starts a brand new generation or unrelated task that should execute.\n' +
    '- "continue_task": user continues the active task, e.g. a follow-up modification ' +
    '("make her wear a red dress", "make it nighttime", "okay, use that camera"). Executes the tool.\n' +
    '- "task_question": user asks a factual / advisory question ABOUT the active task ' +
    '("what camera works best for this?", "which lighting style would look best?"). Does NOT execute the tool.\n' +
    '- "unrelated": user message is ordinary conversation unrelated to any tool. Does not execute.\n' +
    '- "switch_task": user explicitly starts a different task/workflow while one is active. Executes if that is a generation.\n\n' +
    'task (one of): "image_generation" | "chat" | null\n' +
    'action (one of): "generate" | "modify" | "respond" | null\n' +
    'shouldExecuteTool: true ONLY when image generation should actually run.\n' +
    'updatedPrompt: when the user modifies the active image task, the new effective image ' +
    'concept built on top of the CURRENT PROMPT (do not restart from scratch). Otherwise empty string.\n\n' +
    'Rules:\n' +
    '- A modification like "make her wear a red dress" while an image task is active is ' +
    'continue_task with action modify and shouldExecuteTool true; updatedPrompt extends the current prompt.\n' +
    '- A question about the active task is task_question with shouldExecuteTool false — ' +
    'even if it is phrased as an offer or suggestion. Example: after generating an image, ' +
    '"which lighting style would look best?" is task_question, NOT a generation.' +
    '- If there is an active image task and the user references "it"/"that"/"this" or makes ' +
    'an incremental change, treat it as continuing the task.\n' +
    '- Follow-up phrases like "okay, do it", "use that camera", "yes exactly" that reference ' +
    'the active task continue it when the prior turn implied a generation action.\n' +
    '- Only set shouldExecuteTool true when an actual generation/modification should occur. ' +
    'Pure questions never execute.';

const ROUTER_FALLBACK = {
    intent: 'unrelated',
    task: 'chat',
    action: 'respond',
    shouldExecuteTool: false,
    updatedPrompt: ''
};

// Build a token-efficient compact context for the router: current active task,
// effective prompt, last generated asset, parameters, and a few recent messages.
function buildRouterContext(activeTask, recentMessages) {
    if (!recentMessages || recentMessages.length === 0) return '(no recent messages)';
    return recentMessages
        .map((m) => (m.role === 'assistant' ? 'Assistant' : 'User') + ': ' + m.content)
        .join('\n');
}

function activeTaskSummary(task) {
    if (!task || !task.type) return 'none';
    return JSON.stringify({
        type: task.type,
        operation: task.operation,
        prompt: task.prompt,
        originalPrompt: task.originalPrompt || '',
        generatedAsset: task.generatedAsset,
        parameters: task.parameters || {},
        lastAction: task.lastAction || '',
        status: task.status
    });
}

// Compact human-readable block for injecting the active task into the main chat
// context (e.g. when the user asks a question about the active task).
function renderActiveTaskContext(task) {
    if (!task || !task.type) return '';
    return 'Active task context:\n' + activeTaskSummary(task);
}

function parseRouterJson(raw) {
    if (!raw) return null;
    let text = String(raw).trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) text = fenced[1].trim();
    const braceStart = text.indexOf('{');
    const braceEnd = text.lastIndexOf('}');
    if (braceStart === -1 || braceEnd === -1 || braceEnd <= braceStart) return null;
    text = text.slice(braceStart, braceEnd + 1);
    try {
        return JSON.parse(text);
    } catch (err) {
        return null;
    }
}

function normalizeDecision(parsed) {
    const intent = parsed && parsed.intent ? String(parsed.intent) : '';
    let task = null;
    let action = null;
    let shouldExecuteTool = false;

    if (intent === 'new_task' || intent === 'continue_task' || intent === 'switch_task') {
        task = String(parsed.task || 'image_generation');
        action = intent === 'new_task' ? String(parsed.action || 'generate')
            : String(parsed.action || 'modify');
        shouldExecuteTool = parsed.shouldExecuteTool !== false;
    } else {
        // question / unrelated — never execute a tool
        task = 'chat';
        action = 'respond';
        shouldExecuteTool = false;
    }

    if (task === 'chat') {
        task = null;
        shouldExecuteTool = false;
        action = 'respond';
    }

    return {
        intent: intent || 'unrelated',
        task,
        action: action || 'respond',
        shouldExecuteTool: Boolean(shouldExecuteTool),
        updatedPrompt: String((parsed && parsed.updatedPrompt) || '').trim()
    };
}

// --- Public: route a message ---------------------------------------------------

// activeTask can be null to indicate no active task; conversationId is used to
// fetch recent messages for the compact context.
async function routeMessage({ message, provider, model, conversationId }) {
    const activeTask = taskState.getTask(conversationId);
    const messages = conversationService.getMessages(conversationId)
        .slice(-RECENT_MESSAGES_FOR_ROUTER);

    // No active task: fall back to the existing new-task detector.
    if (!activeTask.type) {
        const intent = await imageGenerator.detectIntent(message, providers, provider, model);
        if (intent.intent === 'image_generation') {
            return {
                intent: 'new_task',
                task: 'image_generation',
                action: 'generate',
                shouldExecuteTool: true,
                updatedPrompt: intent.user_prompt,
                structuredRequest: intent
            };
        }
        return ROUTER_FALLBACK;
    }

    const routerPrompt =
        'ACTIVE TASK:\n' + activeTaskSummary(activeTask) + '\n\n' +
        'RECENT CONVERSATION:\n' + buildRouterContext(activeTask, messages) + '\n\n' +
        'USER LATEST MESSAGE:\n"' + message + '"\n\n' +
        'Output the JSON classification only.';

    const parsed = await askRouter(routerPrompt, provider, model);

    const decision = normalizeDecision(parsed);

    // Only keep an updated prompt for image-generation executions.
    if (!(decision.shouldExecuteTool && decision.task === 'image_generation')) {
        decision.updatedPrompt = '';
    }

    return decision;
}

async function askRouter(routerPrompt, provider, model) {
    try {
        const raw = await providers.chat(provider, [
            { role: 'system', content: ROUTER_SYSTEM_PROMPT },
            { role: 'user', content: routerPrompt }
        ], model);
        const parsed = parseRouterJson(raw);
        if (parsed) return parsed;
    } catch (err) {
        console.warn('[task-router] LLM routing failed, using fallback:', err.message);
    }
    return null;
}

// --- Prompt modification ---------------------------------------------------------

const PROMPT_MODIFIER_SYSTEM_PROMPT =
    'You are an image prompt editor. You are given the CURRENT image prompt and a user\'s ' +
    'modification request. Produce the NEW full image prompt that incorporates ONLY the ' +
    'requested change, preserving everything else (subject, style, location, existing details).\n' +
    'Do not drop prior details unless the user explicitly changes them. Append the new detail ' +
    'naturally to the existing prompt.\n' +
    'Output ONLY the new prompt text. No explanations, no quotes, no markdown.';

// Apply the user's modification to the current effective prompt. Falls back to
// a simple append of the raw message on failure.
async function applyPromptModification(currentPrompt, userMessage, provider, model) {
    const modifierMessage =
        'CURRENT PROMPT:\n"' + currentPrompt + '"\n\n' +
        'USER MODIFICATION:\n"' + userMessage + '"\n\n' +
        'Output ONLY the new full prompt text.';

    try {
        const raw = await providers.chat(provider, [
            { role: 'system', content: PROMPT_MODIFIER_SYSTEM_PROMPT },
            { role: 'user', content: modifierMessage }
        ], model);
        const updated = String(raw || '').trim();
        if (updated) return updated;
    } catch (err) {
        console.warn('[task-router] Prompt modifier failed, appending:', err.message);
    }
    return currentPrompt
        ? String(currentPrompt).trim() + ', ' + String(userMessage).trim()
        : String(userMessage).trim();
}

// --- Reporting ---------------------------------------------------------------

const SUCCESS_REPLY_SYSTEM_PROMPT =
    'You are JARVIS. The user\'s image task just completed successfully in the local ' +
    'image pipeline. Write ONE short, natural assistant message (1-2 sentences) that ' +
    'confirms the image was generated and summarizes what changed/showed. Do not claim ' +
    'anything that did not happen. Refer to the actual task. Output ONLY the message text.';

// Generate a concise, truthful assistant confirmation based on the actual result.
async function buildSuccessReply({ action, prompt, previousPrompt, provider, model }) {
    const change = action === 'modify'
        ? ('You updated the image.' + (previousPrompt && previousPrompt !== prompt ? ' You changed the prompt from "' + previousPrompt + '" to "' + prompt + '".' : ''))
        : 'Your image was generated.';
    try {
        const raw = await providers.chat(provider, [
            { role: 'system', content: SUCCESS_REPLY_SYSTEM_PROMPT },
            { role: 'user', content: 'Action: ' + action + '\nPrompt: "' + prompt + '"\n' + change }
        ], model);
        const text = String(raw || '').trim();
        if (text) return text;
    } catch (err) {
        console.warn('[task-router] Success reply failed, using template:', err.message);
    }
    return change;
}

module.exports = {
    routeMessage,
    applyPromptModification,
    buildSuccessReply,
    buildRouterContext,
    renderActiveTaskContext,
    ROUTER_SYSTEM_PROMPT
};
