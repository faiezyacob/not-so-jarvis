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
    '- image_edit (Krea2 identity-edit LoRA). Edit a SOURCE image from a plain-language ' +
    'instruction while preserving the rest. Source is either an attached upload or a ' +
    'previously generated image. NOT for questions about an image.\n' +
    '- video_generation (MiniMax H3/ComfyUI local video pipeline). Generate or modify videos.\n' +
    '  Supports T2VA (text-to-video) and I2VA (image-to-video, using a reference image).\n' +
    '- image_upscale — upscale/enhance image resolution.\n' +
    '- video_upscale — upscale/enhance video resolution (SeedVR2 quality or fast RTX).\n\n' +
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
    'task (one of): "image_generation" | "image_edit" | "video_generation" | "image_upscale" | "video_upscale" | "chat" | null\n' +
    'action (one of): "generate" | "modify" | "edit" | "respond" | null\n' +
    'shouldExecuteTool: true ONLY when generation should actually run.\n' +
    'updatedPrompt: when the user modifies the active task, the new effective prompt ' +
    'built on top of the CURRENT PROMPT (do not restart from scratch). Otherwise empty string.\n' +
    'EXCEPTION — cross-modal switch (e.g. image task active, user asks for a video ' +
    'from that image): updatedPrompt must be ONLY the new motion/action request ' +
    '(e.g. "a woman walking through rain"), NOT the image prompt merged with motion ' +
    'words. The video director rebuilds the full prompt from the source image.\n\n' +
    'Rules:\n' +
    '- A message with an attached image that ASKS about it ("what is this?", ' +
    '"describe this photo", "what color is...") is task_question/unrelated with ' +
    'shouldExecuteTool false. It is NEVER image_edit — questions never execute.\n' +
    '- A message with an attached image that INSTRUCTS a visual change ("make the ' +
    'sky darker", "remove the car", "turn it into a watercolor") is new_task with ' +
    'task image_edit, action edit, and shouldExecuteTool true.\n' +
    '- "edit this image/photo", "retouch this" with no attachment edits the latest ' +
    'generated image: new_task with task image_edit, action edit, shouldExecuteTool true. ' +
    'The same applies to content-targeted edit phrasing ("replace the frog with a princess", ' +
    '"swap the car for a bike", "change the frog into a prince", "remove the car").\n' +
    '- An image task is active and the user asks to animate / bring it to life / ' +
    'turn it into a video / use the image for a video, OR describes motion for ' +
    'the pictured subject ("make her walk", "make it rain", "make him wave"), ' +
    'is switch_task with task video_generation and shouldExecuteTool true. ' +
    'It is NEVER an image modification.\n' +
    '- While a video task is active, a tweak ("make her walk faster", "now make ' +
    'it nighttime", "change it to rain") is continue_task with task ' +
    'video_generation and action modify; the same source image is reused.\n' +
    '- A still-image change while an image task is active ("make her wear a red ' +
    'dress", "change the background") is continue_task with task image_generation ' +
    'and action modify. (The server executes it as a full regen of the rewritten ' +
    'prompt — never report task image_edit for vague follow-up tweaks ("make her ' +
    'wear a red dress", "change the background to a beach"). image_edit is ' +
    'only for explicit edit phrasing ("edit this image", "replace X with Y", ' +
    '"swap X for Y", "change X into Y", "remove X") or an attached upload.)\n' +
    '- A still-image change while a VIDEO task is active ("change her dress", ' +
    '"make the background a beach") modifies the video, not the image: ' +
    'continue_task with task video_generation and action modify.\n' +
    '- A modification like "make her walk faster" while a video task is active is ' +
    'continue_task with action modify and shouldExecuteTool true; updatedPrompt extends the current prompt.\n' +
    '- A modification like "make her wear a red dress" while an image task is active is ' +
    'continue_task with action modify and shouldExecuteTool true.\n' +
    '- A bare regenerate ("generate the video again", "generate the image again", ' +
    '"do it again", "one more time", "redo it") re-runs the ACTIVE task with the ' +
    'SAME prompt (new random seed): continue_task with action generate, ' +
    'shouldExecuteTool true, updatedPrompt empty string.\n' +
    '- A regenerate with a change ("generate the video again but make her walk ' +
    'faster", "generate the image again with a red dress") is continue_task with ' +
    'action modify and shouldExecuteTool true; updatedPrompt must be ONLY the ' +
    'change ("make her walk faster"), never the "generate ... again" preamble.\n' +
    '- An anaphoric new generation ("generate me another image", "one more ' +
    'image", "generate another video") while any task is active is new_task ' +
    '(same medium) or switch_task (other medium) with shouldExecuteTool true — ' +
    'a fresh generation in the same lineage, never a question and never chat.\n' +
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

// Lightweight question detector for @-reference turns: a question about the
// referenced image must stay chat, not trigger an identity edit.
const QUESTION_LEAD_RE = /^(?:what|which|why|who|when|where|how|is|are|was|were|do|does|did|can|could|would|should|will|tell\s+me|describe|explain|show\s+me)\b/i;

function looksLikeQuestion(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (QUESTION_LEAD_RE.test(t)) return true;
    return /\?\s*$/.test(t);
}

// --- Deterministic regenerate handling ---------------------------------------
// "generate the video again" / "generate the image again" must always execute
// (same prompt, new seed), and "generate the video again but make her ..."
// must execute as a modification whose delta excludes the regenerate preamble.
// The LLM router is not trusted with these: "again" would otherwise leak into
// the rewritten prompt ("a woman walking, generate again") or be misread as
// chat. This gate runs before the LLM router whenever an active task exists.

const REGENERATE_WORD_RE = /\b(?:again|redo|redone|retry|retake|remake|regenerat\w*|repeat|one more time|same\s+(?:one|thing|prompt|video|image|picture|photo))\b/i;
const REGENERATE_VERB_RE = /\b(?:generat|regenerat|creat|recreat|mak|remak|render|rerender|produc|reproduc|do|redo|shoot|record)\w*\b/i;
// Local image-noun matcher (mirrors image-generator's IMAGE_MEDIA_WORDS so this
// module stays dependency-free for the gate).
const REGEN_IMAGE_NOUN_RE = /\b(?:images?|pictures?|photos?|photographs?|portraits?|art(?:work)?|illustrations?|drawings?|paintings?|comics?|shots?|scenes?|views?|screenshots?|wallpapers?|posters?|logos?|avatars?|memes?|graphics?|landscapes?|interiors?)\b/i;

function parseRegenerateRequest(message, activeTaskType) {
    const text = String(message || '');
    if (!text.trim() || !REGENERATE_WORD_RE.test(text)) return null;
    // Questions/exclamations about repetition ("what again?", "not again!",
    // "stop repeating") are chat, not regenerate commands.
    if (looksLikeQuestion(text)) return null;
    if (/^\s*(?:no|not|never|stop|don'?t)\b/i.test(text)) return null;
    const hasVideoNoun = videoGenerator.VIDEO_WORD_RE.test(text);
    const hasImageNoun = REGEN_IMAGE_NOUN_RE.test(text);
    let media = null;
    if (hasVideoNoun && !hasImageNoun) media = 'video';
    else if (hasImageNoun && !hasVideoNoun) media = 'image';
    else if (hasVideoNoun && hasImageNoun) {
        // Both nouns present ("regenerate the image as a video again"):
        // the LAST media noun wins — it names the requested output.
        const videoIdx = text.search(videoGenerator.VIDEO_WORD_RE);
        const imageIdx = text.search(REGEN_IMAGE_NOUN_RE);
        media = videoIdx > imageIdx ? 'video' : 'image';
    } else if (activeTaskType === 'video' || activeTaskType === 'image') {
        // Pronoun-only ("do it again", "again", "one more time"): only a
        // regenerate when a generation verb or a bare-again turn is present.
        if (!REGENERATE_VERB_RE.test(text) && text.trim().length > 24) return null;
        media = activeTaskType;
    } else {
        return null;
    }
    // Media mismatch (e.g. "generate the video again ..." while an image task
    // is active) is a cross-modal regenerate — still extract the delta so the
    // caller can build an I2VA video from the last image with the change.
    const crossModal = Boolean(activeTaskType && media !== activeTaskType);
    const match = text.match(REGENERATE_WORD_RE);
    let after = match ? text.slice(match.index + match[0].length) : '';
    // Strip the connectors between "again" and the actual change.
    for (let i = 0; i < 3; i++) {
        const next = after.replace(/^\s*(?:[,.!;:]+|\b(?:but|and|with|where|except|though|however|now|please|just|also)\b|\b(?:change(?:s|d)?|chang(?:e|ing)\s+(?:it|that|this|her|him|them)?(?:\s+to)?|to)\b)+\s*/i, '');
        if (next === after) break;
        after = next;
    }
    after = after.replace(/^(?:it|this|that)\s+(?:to\s+)?/i, '').trim();
    if (!after || /^(?:please|thanks|thank\s*you)[.!]*$/i.test(after)) {
        return { media, crossModal, bare: true, delta: '' };
    }
    return { media, crossModal, bare: false, delta: after };
}

// Build a token-efficient compact context for the router: current active task,
// effective prompt, last generated asset, parameters, and a few recent messages.
function buildRouterContext(activeTask, recentMessages) {
    if (!recentMessages || recentMessages.length === 0) return '(no recent messages)';
    return recentMessages
        .map((m) => {
            const role = m.role === 'assistant' ? 'Assistant' : 'User';
            const content = String(m.content || '').replace(/\s+/g, ' ').trim();
            return role + ': ' + (content.length > 500 ? content.slice(0, 500) + '…' : content);
        })
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

// Infer the conversation's media type from its message history when no
// ActiveTask is stored (e.g. after returning to an older conversation whose
// task entry was never persisted). Scans assistant messages for the last
// /generated/ link: a video extension means video, otherwise image.
function inferMediaTypeFromHistory(conversationId) {
    try {
        if (!conversationId) return null;
        const messages = conversationService.getMessages(conversationId) || [];
        const urlRe = /\/generated\/([^\s)\]}"']+)/g;
        let last = null;
        for (const m of messages) {
            if (!m || m.role !== 'assistant') continue;
            const content = String(m.content || '');
            let match;
            urlRe.lastIndex = 0;
            while ((match = urlRe.exec(content))) last = match[1];
        }
        if (!last) return null;
        const name = String(last).split('?')[0];
        if (/\.(?:mp4|webm|avi|mov)$/i.test(name)) return 'video';
        if (/\.(?:png|jpe?g|webp|gif)$/i.test(name)) return 'image';
        return null;
    } catch (err) {
        return null;
    }
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
        if (rawTask === 'video_generation') task = 'video_generation';
        else if (rawTask === 'image_edit') task = 'image_edit';
        else if (rawTask === 'image_generation') task = 'image_generation';
        else if (rawTask === 'video_upscale') task = 'video_upscale';
        else if (rawTask === 'image_upscale') task = 'image_upscale';
        // Unknown/missing task stays null: a malformed router reply must never
        // be guessed into image_generation (which would trigger a real render).
        if (task === 'video_upscale' || task === 'image_upscale') {
            action = 'upscale';
            shouldExecuteTool = parsed.shouldExecuteTool !== false;
        } else if (task === 'image_edit' && intent === 'continue_task') {
            // Follow-up tweaks are always a full-regen modify; an identity edit
            // only runs for an explicit new/switch image_edit decision.
            task = 'image_generation';
            action = 'modify';
            shouldExecuteTool = parsed.shouldExecuteTool !== false;
        } else if (task === 'image_edit') {
            action = 'edit';
            shouldExecuteTool = parsed.shouldExecuteTool !== false;
        } else if (task) {
            action = intent === 'new_task' ? String(parsed.action || 'generate')
                : String(parsed.action || 'modify');
            shouldExecuteTool = parsed.shouldExecuteTool !== false;
        }
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
// fetch recent messages for the compact context. hasAttachedImage marks a
// freshly uploaded photo on this message (vision source for image_edit).
async function routeMessage({ message, provider, model, conversationId, hasAttachedImage, referenceImage, think }) {
    // Upscale requests are narrow, deterministic intents. Detect them with
    // heuristics before the LLM router so "upscale this video" always routes
    // to the video upscale pipeline and "upscale this image" always routes to
    // the image pipeline, regardless of the active task. Video is checked
    // first because its phrases are a superset ("upscale this video").
    if (videoGenerator.detectVideoUpscaleIntent(message)) {
        return {
            intent: 'new_task',
            task: 'video_upscale',
            action: 'upscale',
            shouldExecuteTool: true,
            updatedPrompt: ''
        };
    }
    if (imageGenerator.detectUpscaleIntent(message)) {
        // Pronoun-only upscale ("upscale this", "upscale it") while a video
        // task is active means the video — same rule the image pipeline uses
        // for image tasks. Explicit image nouns always stay on image. When
        // the ActiveTask is missing (fresh restart, imported history), infer
        // the media type from the conversation's last generated asset so
        // returning to an older conversation still routes pronoun upscales
        // to the right pipeline.
        const activeTaskForUpscale = taskState.getTask(conversationId);
        const effectiveUpscaleType = activeTaskForUpscale.type || inferMediaTypeFromHistory(conversationId);
        if (effectiveUpscaleType === 'video' &&
            !/\b(?:image|picture|photo|artwork|illustration|painting|render|screenshot|wallpaper|poster|logo|avatar|graphic)\w*\b/i.test(String(message || ''))) {
            return {
                intent: 'new_task',
                task: 'video_upscale',
                action: 'upscale',
                shouldExecuteTool: true,
                updatedPrompt: ''
            };
        }
        return {
            intent: 'new_task',
            task: 'image_upscale',
            action: 'upscale',
            shouldExecuteTool: true,
            updatedPrompt: ''
        };
    }

    // Explicit @-picker reference: the user chose a generated image from the
    // current conversation and wants to act on that exact file. This governs
    // the turn regardless of the active task:
    //   - a video request turns it into the I2VA first frame;
    //   - a question about it stays chat;
    //   - any other instruction is an identity edit of the referenced image.
    if (referenceImage) {
        const refText = String(message || '')
            .replace(/!\[[^\]]*\]\(\/generated\/[^)]+\)/g, '')
            .replace(/!\[[^\]]*\]\(\/images\/[^)]+\)/g, '')
            .trim();

        if (videoGenerator.VIDEO_WORD_RE.test(refText) || videoGenerator.I2V_REF_RE.test(refText)) {
            try {
                const videoIntent = await videoGenerator.detectVideoIntent(refText, providers, provider, model, think);
                if (videoIntent && videoIntent.intent === 'video_generation') {
                    videoIntent.has_reference_image = true;
                    videoIntent.videoMode = 'i2va';
                    videoIntent.sourceImageRawFilename = referenceImage;
                    if (!videoIntent.user_prompt) videoIntent.user_prompt = refText || 'animate this image';
                    return {
                        intent: 'new_task',
                        task: 'video_generation',
                        action: 'generate',
                        shouldExecuteTool: true,
                        updatedPrompt: videoIntent.user_prompt,
                        structuredRequest: videoIntent
                    };
                }
            } catch (err) {
                console.warn('[task-router] Reference video gate failed:', err.message);
            }
        }

        if (refText && !looksLikeQuestion(refText)) {
            return {
                intent: 'new_task',
                task: 'image_edit',
                action: 'edit',
                shouldExecuteTool: true,
                updatedPrompt: refText
            };
        }
        return ROUTER_FALLBACK;
    }

    const activeTask = taskState.getTask(conversationId);
    // The caller persists the current user turn before routing, so the latest
    // stored message duplicates `message` — drop it to avoid the router seeing
    // the turn twice and losing a real prior turn.
    const stored = conversationService.getMessages(conversationId);
    const lastStored = stored[stored.length - 1];
    const history = (lastStored && String(lastStored.content || '') === String(message || ''))
        ? stored.slice(0, -1)
        : stored;
    const messages = history.slice(-RECENT_MESSAGES_FOR_ROUTER);

    // Deterministic regenerate gate: "generate the video/image again" re-runs
    // the active task verbatim; "... again but <change>" runs it as a
    // modification with ONLY the change as the delta. Runs before the edit
    // gate and the LLM router so "again" never leaks into a rewritten prompt.
    if (activeTask.type === 'video' || activeTask.type === 'image') {
        const regen = parseRegenerateRequest(message, activeTask.type);
        if (regen && !regen.crossModal && activeTask.prompt) {
            if (regen.media === 'video' && activeTask.type === 'video') {
                if (regen.bare) {
                    return {
                        intent: 'continue_task',
                        task: 'video_generation',
                        action: 'generate',
                        shouldExecuteTool: true,
                        updatedPrompt: ''
                    };
                }
                return {
                    intent: 'continue_task',
                    task: 'video_generation',
                    action: 'modify',
                    shouldExecuteTool: true,
                    updatedPrompt: regen.delta
                };
            }
            if (regen.media === 'image' && activeTask.type === 'image') {
                if (regen.bare) {
                    return {
                        intent: 'continue_task',
                        task: 'image_generation',
                        action: 'generate',
                        shouldExecuteTool: true,
                        updatedPrompt: ''
                    };
                }
                return {
                    intent: 'continue_task',
                    task: 'image_generation',
                    action: 'modify',
                    shouldExecuteTool: true,
                    updatedPrompt: regen.delta
                };
            }
        }
        // Cross-modal regenerate ("generate the video again ..." while an
        // image task is active): build an I2VA video from the last generated
        // image, applying the delta when one is present. This is what lets
        // "generate the video again but make her wave" refer back to the last
        // image instead of starting from text alone.
        if (regen && regen.crossModal && regen.media === 'video' && activeTask.type === 'image') {
            const sourceImage = videoGenerator.resolveVideoSourceImage(conversationId);
            if (sourceImage) {
                const userPrompt = regen.bare
                    ? ('animate this image: ' + String(activeTask.prompt || message))
                    : regen.delta;
                const structuredRequest = {
                    intent: 'video_generation',
                    action: 'generate',
                    user_prompt: userPrompt,
                    previous_prompt: activeTask.prompt || '',
                    creative_mode: 'none',
                    has_reference_image: true,
                    requested_duration: typeof videoGenerator.parseRequestedVideoDuration === 'function'
                        ? videoGenerator.parseRequestedVideoDuration(message)
                        : null,
                    explicit_constraints: [],
                    parameters: {}
                };
                const modeInfo = videoGenerator.resolveVideoMode(conversationId, message, structuredRequest);
                structuredRequest.videoMode = modeInfo.videoMode;
                structuredRequest.sourceImageRawFilename = modeInfo.sourceImage
                    ? modeInfo.sourceImage.rawFilename
                    : sourceImage.rawFilename;
                return {
                    intent: 'switch_task',
                    task: 'video_generation',
                    action: 'generate',
                    shouldExecuteTool: true,
                    updatedPrompt: userPrompt,
                    structuredRequest
                };
            }
        }
    }

    // Anaphoric new image ("generate me another image", "one more image"):
    // an explicit new generation in the image lineage — never a modification
    // and never chat. Routed deterministically (with the intent classifier's
    // structured request) so the tool always executes: the LLM router tends
    // to downgrade this vague wording to a question/unrelated turn that merely
    // echoes a prompt back without running anything.
    if ((activeTask.type === 'image' || activeTask.type === 'video') &&
        !hasAttachedImage &&
        !videoGenerator.VIDEO_WORD_RE.test(message) &&
        /\banother\b|\bone\s+more\b/i.test(message) &&
        imageGenerator.imageRequestStrength(message)) {
        try {
            const anaphoricIntent = await imageGenerator.detectIntent(message, providers, provider, model, think);
            if (anaphoricIntent.intent === 'image_generation') {
                return {
                    intent: activeTask.type === 'video' ? 'switch_task' : 'new_task',
                    task: 'image_generation',
                    action: 'generate',
                    shouldExecuteTool: true,
                    updatedPrompt: anaphoricIntent.user_prompt,
                    structuredRequest: anaphoricIntent
                };
            }
        } catch (err) {
            console.warn('[task-router] Anaphoric image gate failed:', err.message);
        }
    }

    // Explicit new image request ("generate an image of a forest", "create a
    // picture of a dog", "draw me a portrait") while any task is active: honor
    // the dedicated image classifier directly instead of letting the generic
    // LLM router downgrade clear wording to chat. Only the classifier's
    // generate verdict executes — a modify verdict (tweaks the phrasing gate
    // let through) and questions fall through to the router as before.
    if (activeTask.type &&
        !hasAttachedImage &&
        !videoGenerator.VIDEO_WORD_RE.test(message) &&
        imageGenerator.isExplicitNewImageRequest(message)) {
        try {
            const explicitIntent = await imageGenerator.detectIntent(message, providers, provider, model, think);
            if (explicitIntent.intent === 'image_generation' && explicitIntent.action !== 'modify') {
                return {
                    intent: activeTask.type === 'image' ? 'new_task' : 'switch_task',
                    task: 'image_generation',
                    action: 'generate',
                    shouldExecuteTool: true,
                    updatedPrompt: explicitIntent.user_prompt,
                    structuredRequest: explicitIntent
                };
            }
        } catch (err) {
            console.warn('[task-router] Explicit image gate failed:', err.message);
        }
    }

    // Explicit new video request ("generate a video of a dog") while a video
    // task is active: the cross-task I2VA gate below only covers switches
    // away from other task types, so same-type follow-ups get their own
    // deterministic path with the video classifier as authority.
    if (activeTask.type === 'video' &&
        !hasAttachedImage &&
        videoGenerator.VIDEO_REQUEST_RE.test(message)) {
        try {
            const explicitVideoIntent = await videoGenerator.detectVideoIntent(message, providers, provider, model, think);
            if (explicitVideoIntent.intent === 'video_generation' && explicitVideoIntent.action !== 'modify') {
                const modeInfo = videoGenerator.resolveVideoMode(conversationId, message, explicitVideoIntent);
                explicitVideoIntent.videoMode = modeInfo.videoMode;
                explicitVideoIntent.sourceImageRawFilename = modeInfo.sourceImage ? modeInfo.sourceImage.rawFilename : null;
                return {
                    intent: 'new_task',
                    task: 'video_generation',
                    action: 'generate',
                    shouldExecuteTool: true,
                    updatedPrompt: explicitVideoIntent.user_prompt,
                    structuredRequest: explicitVideoIntent
                };
            }
        } catch (err) {
            console.warn('[task-router] Explicit video gate failed:', err.message);
        }
    }

    // Explicit "edit this image" phrasing without an upload edits the latest
    // generated image. Skipped for video tasks and video requests (the video
    // pipeline owns those) — the LLM router handles everything vaguer.
    if (activeTask.type !== 'video' && !videoGenerator.VIDEO_WORD_RE.test(message)) {
        if (imageGenerator.detectEditIntent(message, activeTask.type === 'image')) {
            return {
                intent: 'new_task',
                task: 'image_edit',
                action: 'edit',
                shouldExecuteTool: true,
                updatedPrompt: message
            };
        }
    }

    // Vague follow-up tweaks while an image task is active ("change her
    // bottom to ripped blue jeans", "make her wear a red dress", "change the
    // background"). These carry no generation verb so the intent classifier
    // would read them as chat — route them deterministically to a full-regen
    // modify before the LLM router so a small model can't downgrade them to
    // chat (where the chat model then leaks a tool-call JSON blob like
    // {"action": "image_generation", ...} instead of generating anything).
    // Explicit edits stay above; video nouns stay on the video pipeline.
    if (activeTask.type === 'image' && activeTask.prompt &&
        !hasAttachedImage && !videoGenerator.VIDEO_WORD_RE.test(message)) {
        try {
            if (imageGenerator.detectImageModifyIntent(message, true)) {
                return {
                    intent: 'continue_task',
                    task: 'image_generation',
                    action: 'modify',
                    shouldExecuteTool: true,
                    updatedPrompt: message
                };
            }
        } catch (err) {
            console.warn('[task-router] Image modify gate failed:', err.message);
        }
    }

    // Cross-task I2VA: when a non-video task is active (e.g. a just-generated
    // image) and the user asks for a video made from an existing image, route
    // deterministically to the video pipeline so "use this image to generate a
    // video" is always I2VA, never misread as an image modification or T2VA.
    // The gate reuses the video pipeline's own matchers (VIDEO_WORD_RE for
    // explicit video nouns plus the full I2V_REF_RE free-form phrasings:
    // "use this image", "make it rain", "make her walk", ...); the LLM
    // intent classifier remains the final authority on whether it is a video.
    // Falling through on a non-video verdict is safe: still-image tweaks like
    // "make her wear a red dress" no longer match the pronoun+motion gate at
    // all (the motion verb is required) and are rejected by the classifier and
    // continue to the LLM router as image modifications. As defense-in-depth,
    // still-image-only clothing/appearance changes skip the video gate
    // entirely even if a broad matcher fires.
    if (activeTask.type && activeTask.type !== 'video' &&
        typeof videoGenerator.isStillImageOnlyChange === 'function' &&
        videoGenerator.isStillImageOnlyChange(message)) {
        // Skip the cross-task I2VA gate — fall through to the LLM router.
    } else if (activeTask.type && activeTask.type !== 'video' &&
        (videoGenerator.VIDEO_WORD_RE.test(message) || videoGenerator.I2V_REF_RE.test(message))) {
        const videoIntent = await videoGenerator.detectVideoIntent(message, providers, provider, model, think);
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
        // Attached photo: the LLM router decides question (chat) vs edit
        // instruction (image_edit). Anything else falls back to chat —
        // video-from-upload is not supported yet.
        if (hasAttachedImage) {
            const uploadPrompt =
                'ACTIVE TASK:\nnone\n\n' +
                'ATTACHED IMAGE:\nyes (a photo the user just uploaded)\n\n' +
                'RECENT CONVERSATION:\n' + buildRouterContext(activeTask, messages) + '\n\n' +
                'USER LATEST MESSAGE:\n"' + message + '"\n\n' +
                'Output the JSON classification only.';
            const uploadDecision = normalizeDecision(await askRouter(uploadPrompt, provider, model, think));
            if (uploadDecision.task === 'image_edit' && uploadDecision.shouldExecuteTool) {
                uploadDecision.updatedPrompt = message;
                return uploadDecision;
            }
            return ROUTER_FALLBACK;
        }
        // Check video intent first — video requests are a superset of image
        // requests (both use generation verbs), so video should take priority
        // when the user clearly asks for a video.
        const videoIntent = await videoGenerator.detectVideoIntent(message, providers, provider, model, think);
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

        const intent = await imageGenerator.detectIntent(message, providers, provider, model, think);
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
        'ATTACHED IMAGE:\n' + (hasAttachedImage ? 'yes (a photo the user just uploaded)' : 'no') + '\n\n' +
        'RECENT CONVERSATION:\n' + buildRouterContext(activeTask, messages) + '\n\n' +
        'USER LATEST MESSAGE:\n"' + message + '"\n\n' +
        'Output the JSON classification only.';

    const parsed = await askRouter(routerPrompt, provider, model, think);

    // Router LLM returned garbage twice — consult the focused intent
    // classifiers before surrendering to chat, mirroring the no-task path.
    // Attachments stay router-owned: without its verdict a question about an
    // upload could be misread as an edit instruction.
    if (!parsed && !hasAttachedImage) {
        try {
            const fallbackVideo = await videoGenerator.detectVideoIntent(message, providers, provider, model, think);
            if (fallbackVideo.intent === 'video_generation') {
                const modeInfo = videoGenerator.resolveVideoMode(conversationId, message, fallbackVideo);
                fallbackVideo.videoMode = modeInfo.videoMode;
                fallbackVideo.sourceImageRawFilename = modeInfo.sourceImage ? modeInfo.sourceImage.rawFilename : null;
                return {
                    intent: 'switch_task',
                    task: 'video_generation',
                    action: fallbackVideo.action,
                    shouldExecuteTool: true,
                    updatedPrompt: fallbackVideo.user_prompt,
                    structuredRequest: fallbackVideo
                };
            }
        } catch (err) {
            console.warn('[task-router] Fallback video intent failed:', err.message);
        }
        try {
            const fallbackImage = await imageGenerator.detectIntent(message, providers, provider, model, think);
            if (fallbackImage.intent === 'image_generation') {
                return {
                    intent: activeTask.type === 'image' ? 'new_task' : 'switch_task',
                    task: 'image_generation',
                    action: fallbackImage.action,
                    shouldExecuteTool: true,
                    updatedPrompt: fallbackImage.user_prompt,
                    structuredRequest: fallbackImage
                };
            }
        } catch (err) {
            console.warn('[task-router] Fallback image intent failed:', err.message);
        }
    }

    const decision = normalizeDecision(parsed);

    // Only keep an updated prompt for generation executions.
    if (!(decision.shouldExecuteTool && (decision.task === 'image_generation' || decision.task === 'video_generation' || decision.task === 'image_edit'))) {
        decision.updatedPrompt = '';
    }

    // Enrich cross-modal switches that the LLM router caught but the
    // deterministic gate above did not (e.g. an indirect "now animate it"
    // the gate's classifier rejected, or a video->image switch back). The
    // router's updatedPrompt is modality-biased (built on the CURRENT prompt),
    // so replace it with the dedicated intent classifier's user_prompt plus a
    // resolved source image — the same structuredRequest shape the gate and
    // no-task paths return, which server.js prefers over the stub fallback.
    if (decision.shouldExecuteTool && (decision.intent === 'switch_task' || decision.intent === 'new_task')) {
        if (decision.task === 'video_generation' && activeTask.type !== 'video') {
            try {
        const videoIntent = await videoGenerator.detectVideoIntent(message, providers, provider, model, think);
                if (videoIntent.intent === 'video_generation') {
                    const modeInfo = videoGenerator.resolveVideoMode(conversationId, message, videoIntent);
                    videoIntent.videoMode = modeInfo.videoMode;
                    videoIntent.sourceImageRawFilename = modeInfo.sourceImage ? modeInfo.sourceImage.rawFilename : null;
                    if (videoIntent.user_prompt) decision.updatedPrompt = videoIntent.user_prompt;
                    decision.structuredRequest = videoIntent;
                }
            } catch (err) {
                console.warn('[task-router] Switch enrichment (video) failed:', err.message);
            }
        } else if (decision.task === 'image_generation' && activeTask.type === 'video') {
            try {
                const imgIntent = await imageGenerator.detectIntent(message, providers, provider, model, think);
                if (imgIntent.intent === 'image_generation') {
                    if (imgIntent.user_prompt) decision.updatedPrompt = imgIntent.user_prompt;
                    decision.structuredRequest = imgIntent;
                }
            } catch (err) {
                console.warn('[task-router] Switch enrichment (image) failed:', err.message);
            }
        }
    }

    return decision;
}

async function askRouter(routerPrompt, provider, model, think) {
    // Two attempts: small local models often wrap the verdict in commentary
    // on the first try. Classification runs at temperature 0 so the verdict
    // is deterministic, not creative.
    const messages = [
        { role: 'system', content: ROUTER_SYSTEM_PROMPT },
        { role: 'user', content: routerPrompt }
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const raw = await providers.chat(provider, messages, model, { think, temperature: 0 });
            const parsed = parseRouterJson(raw);
            if (parsed) return parsed;
            console.warn('[task-router] Unparseable router JSON (attempt ' + (attempt + 1) + '), retrying.');
            messages.push({ role: 'user', content: 'That was not valid JSON. Respond with ONLY the single JSON object, no other text.' });
        } catch (err) {
            console.warn('[task-router] LLM routing failed, using fallback:', err.message);
            return null;
        }
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
    'CURRENT PROMPT: A misty mountain lake at dawn, still water reflecting jagged peaks, soft fog drifting above the surface.\n' +
    'USER MODIFICATION: change it to sunset\n' +
    'CORRECT RESULT: A mountain lake at sunset, still water reflecting jagged peaks glowing orange, soft fog drifting above the surface.\n\n' +

    'Output ONLY the new full image prompt. No explanations, no quotes, no markdown.';


// Apply the user's modification to the current effective prompt. Falls back to
// a simple append of the raw message on failure.
async function applyPromptModification(currentPrompt, userMessage, provider, model, think) {
    const modifierMessage =
        'CURRENT PROMPT:\n"' + currentPrompt + '"\n\n' +
        'USER MODIFICATION:\n"' + userMessage + '"\n\n' +
        'Output ONLY the new full prompt text.';

    try {
        const raw = await providers.chat(provider, [
            { role: 'system', content: PROMPT_MODIFIER_SYSTEM_PROMPT },
            { role: 'user', content: modifierMessage }
        ], model, { think });
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
async function buildSuccessReply({ action, prompt, previousPrompt, provider, model, taskType, think }) {
    const isVideo = taskType === 'video';
    const mediaType = isVideo ? 'video' : 'image';
    const change = action === 'modify'
        ? ('You updated the ' + mediaType + '.' + (previousPrompt && previousPrompt !== prompt ? ' You changed the prompt from "' + previousPrompt + '" to "' + prompt + '".' : ''))
        : ('Your ' + mediaType + ' was generated.');
    try {
        const raw = await providers.chat(provider, [
            { role: 'system', content: SUCCESS_REPLY_SYSTEM_PROMPT },
            { role: 'user', content: 'Action: ' + action + '\nType: ' + mediaType + '\nPrompt: "' + prompt + '"\n' + change }
        ], model, { think });
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
    parseRegenerateRequest,
    ROUTER_SYSTEM_PROMPT
};
