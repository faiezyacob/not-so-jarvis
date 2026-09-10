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
const videoGenerator = require('./video-generator');
const providers = require('../server/providers');
const conversationService = require('../server/conversation-service');

const RECENT_MESSAGES_FOR_ROUTER = 4;

const ROUTER_SYSTEM_PROMPT =
    'You are JARVIS\'s task router. Decide, from the active task context and the ' +
    'user\'s latest message, whether a tool should execute. You are an internal ' +
    'router — you never reply to the user and the user does not see your JSON. ' +
    'You are the ONLY authority on tool execution; the chat model is not.\n\n' +
    'Available tools:\n' +
    '- image_generation (Krea2/ComfyUI local image pipeline). Generate or modify images.\n' +
    '- video_generation (MiniMax H3/ComfyUI local video pipeline). Generate or modify videos.\n' +
    '  Supports T2VA (text-to-video) and I2VA (image-to-video, using a reference image).\n' +
    '- image_upscale — upscale/enhance image resolution.\n\n' +
    'Respond with ONLY a single JSON object, no markdown, no commentary:\n' +
    '{"intent": "...", "task": "...", "action": "...", "shouldExecuteTool": bool, ' +
    '"updatedPrompt": "..."}\n\n' +
    'intent (one of):\n' +
    '- "new_task": user starts a brand new generation or unrelated task that should execute.\n' +
    '- "continue_task": user continues the active task, e.g. a follow-up modification ' +
    '("make her walk faster", "make it nighttime", "okay, use that"). Executes the tool.\n' +
    '- "task_question": user asks a factual / advisory question ABOUT the active task ' +
    '("what camera works best for this?", "which lighting style would look best?"). Does NOT execute the tool.\n' +
    '- "unrelated": user message is ordinary conversation unrelated to any tool. Does not execute.\n' +
    '- "switch_task": user explicitly starts a different task/workflow while one is active. Executes if that is a generation.\n\n' +
    'task (one of): "image_generation" | "video_generation" | "chat" | null\n' +
    'action (one of): "generate" | "modify" | "respond" | null\n' +
    'shouldExecuteTool: true ONLY when generation should actually run.\n' +
    'updatedPrompt: when the user modifies the active task, the new effective prompt ' +
    'built on top of the CURRENT PROMPT (do not restart from scratch). Otherwise empty string.\n\n' +
    'Rules:\n' +
    '- A modification like "make her walk faster" while a video task is active is ' +
    'continue_task with action modify and shouldExecuteTool true; updatedPrompt extends the current prompt.\n' +
    '- A modification like "make her wear a red dress" while an image task is active is ' +
    'continue_task with action modify and shouldExecuteTool true.\n' +
    '- A question about the active task is task_question with shouldExecuteTool false — ' +
    'even if it is phrased as an offer or suggestion.\n' +
    '- If there is an active task and the user references "it"/"that"/"this" or makes ' +
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
        const rawTask = String(parsed.task || '').toLowerCase();
        task = (rawTask === 'video_generation') ? 'video_generation' : (rawTask === 'image_generation' ? 'image_generation' : 'image_generation');
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
    // Upscale requests are a narrow, deterministic intent. Detect them with a
    // heuristic before the LLM router so "upscale this image" always routes to
    // the upscale pipeline regardless of the active task.
    if (imageGenerator.detectUpscaleIntent(message)) {
        return {
            intent: 'new_task',
            task: 'image_upscale',
            action: 'upscale',
            shouldExecuteTool: true,
            updatedPrompt: ''
        };
    }

    const activeTask = taskState.getTask(conversationId);
    const messages = conversationService.getMessages(conversationId)
        .slice(-RECENT_MESSAGES_FOR_ROUTER);

    // Cross-task I2VA: when a non-video task is active (e.g. a just-generated
    // image) and the user asks for a video made from an existing image, route
    // deterministically to the video pipeline so "use this image to generate a
    // video" is always I2VA, never misread as an image modification or T2VA.
    // The gate covers explicit video words plus the free-form I2V phrasings from
    // the spec ("use this image", "make it rain", "make her walk", ...); the LLM
    // intent classifier remains the final authority on whether it is a video.
    if (activeTask.type && activeTask.type !== 'video' &&
        /\b(?:video|film|clip|movie|animation|to\s+life|turn\s+.{0,24}into|animat\w*|use\s+(?:this|that|the)\s+image)\b/i.test(message)) {
        const videoIntent = await videoGenerator.detectVideoIntent(message, providers, provider, model);
        if (videoIntent.intent === 'video_generation') {
            const modeInfo = videoGenerator.resolveVideoMode(conversationId, message, videoIntent);
            videoIntent.videoMode = modeInfo.videoMode;
            videoIntent.sourceImageRawFilename = modeInfo.sourceImage ? modeInfo.sourceImage.rawFilename : null;
            return {
                intent: 'switch_task',
                task: 'video_generation',
                action: 'generate',
                shouldExecuteTool: true,
                updatedPrompt: videoIntent.user_prompt,
                structuredRequest: videoIntent
            };
        }
    }

    // No active task: detect whether this is a new image or video request.
    if (!activeTask.type) {
        // Check video intent first — video requests are a superset of image
        // requests (both use generation verbs), so video should take priority
        // when the user clearly asks for a video.
        const videoIntent = await videoGenerator.detectVideoIntent(message, providers, provider, model);
        if (videoIntent.intent === 'video_generation') {
            const modeInfo = videoGenerator.resolveVideoMode(conversationId, message, videoIntent);
            videoIntent.videoMode = modeInfo.videoMode;
            videoIntent.sourceImageRawFilename = modeInfo.sourceImage ? modeInfo.sourceImage.rawFilename : null;
            return {
                intent: 'new_task',
                task: 'video_generation',
                action: videoIntent.action,
                shouldExecuteTool: true,
                updatedPrompt: videoIntent.user_prompt,
                structuredRequest: videoIntent
            };
        }

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

    // Only keep an updated prompt for generation executions.
    if (!(decision.shouldExecuteTool && (decision.task === 'image_generation' || decision.task === 'video_generation'))) {
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
    'You are an image prompt editor. You are given the CURRENT image prompt and a USER MODIFICATION. ' +
    'Rewrite the current prompt into a NEW complete image prompt that applies the requested change.\n\n' +

    'IMPORTANT RULES:\n' +
    '- Apply the user modification as an actual replacement or update, not as an instruction appended to the prompt.\n' +
    '- Preserve every existing detail that the user did not ask to change.\n' +
    '- If the user changes clothing, replace the old clothing with the new clothing. Do not mention both.\n' +
    '- If the user changes the pose, replace the old pose with the new pose.\n' +
    '- If the user changes the setting, replace the old setting with the new setting.\n' +
    '- If the user changes the expression, replace the old expression with the new expression.\n' +
    '- If the user changes the time or lighting, update only those elements.\n' +
    '- Do not literally include phrases such as "change her outfit to..." or "make her..." in the resulting prompt.\n' +
    '- Do not add unrelated creative details.\n' +
    '- Do not remove existing details unless the user explicitly changes them.\n' +
    '- The result must describe the final image, not describe the editing operation.\n\n' +

    'EXAMPLE:\n' +
    'CURRENT PROMPT: A young Korean woman with long wavy black hair, wearing an emerald green silk blouse and tailored trousers, walking through a cherry blossom garden in golden hour sunlight.\n' +
    'USER MODIFICATION: change her outfit to a traditional kimono\n' +
    'CORRECT RESULT: A young Korean woman with long wavy black hair, wearing a traditional kimono, walking through a cherry blossom garden in golden hour sunlight.\n\n' +

    'Another example:\n' +
    'CURRENT PROMPT: A young Korean woman with long black hair, wearing a cream sweater and blue jeans, standing on a Seoul street in the afternoon.\n' +
    'USER MODIFICATION: change her pose to sitting on a bench\n' +
    'CORRECT RESULT: A young Korean woman with long black hair, wearing a cream sweater and blue jeans, sitting on a bench on a Seoul street in the afternoon.\n\n' +

    'Output ONLY the new full image prompt. No explanations, no quotes, no markdown.';


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
    if (currentPrompt) {
        console.warn('[task-router] Prompt modifier failed; keeping current prompt unchanged.');
        return String(currentPrompt).trim();
    }

    return String(userMessage).trim();
}

// --- Reporting ---------------------------------------------------------------

const SUCCESS_REPLY_SYSTEM_PROMPT =
    'You are JARVIS. The user\'s task just completed successfully in the local ' +
    'pipeline. Write ONE short, natural assistant message (1-2 sentences) that ' +
    'confirms the result and summarizes what was generated. Do not claim ' +
    'anything that did not happen. Refer to the actual task. Output ONLY the message text.';

// Generate a concise, truthful assistant confirmation based on the actual result.
async function buildSuccessReply({ action, prompt, previousPrompt, provider, model, taskType }) {
    const isVideo = taskType === 'video';
    const mediaType = isVideo ? 'video' : 'image';
    const change = action === 'modify'
        ? ('You updated the ' + mediaType + '.' + (previousPrompt && previousPrompt !== prompt ? ' You changed the prompt from "' + previousPrompt + '" to "' + prompt + '".' : ''))
        : ('Your ' + mediaType + ' was generated.');
    try {
        const raw = await providers.chat(provider, [
            { role: 'system', content: SUCCESS_REPLY_SYSTEM_PROMPT },
            { role: 'user', content: 'Action: ' + action + '\nType: ' + mediaType + '\nPrompt: "' + prompt + '"\n' + change }
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
