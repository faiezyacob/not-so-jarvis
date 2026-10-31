/* SPDX-License-Identifier: MIT */

/* ============================================
   JARVIS - Capability-Aware Router
   Chooses how ONE unified chat turn is handled:
     direct      - answer / generate immediately
     tool        - gather specific data, then respond
     agent       - plan + execute a sequence of permitted actions
     clarify     - ask only for essential missing information
     blocked     - explain a missing tool or permission
   Ordinary conversation, writing, prompt writing and
   media generation are deliberately left to the existing
   chat/router pipeline. This module NEVER executes a
   tool; it only classifies the turn.
   ============================================ */

const ACTIONS = Object.freeze({
    DIRECT: 'direct',
    TOOL: 'tool',
    AGENT: 'agent',
    CLARIFY: 'clarify',
    BLOCKED: 'blocked'
});

const FOLLOW_UP_ACTIONS = Object.freeze({
    NONE: 'none',
    CANCEL: 'cancel',
    APPROVE: 'approve',
    REJECT: 'reject',
    PAUSE: 'pause',
    RESUME: 'resume',
    CONTINUE: 'continue',
    RETRY: 'retry'
});

const MAX_GOAL_CHARS = 2000;
const MAX_CRITERIA = 6;

/* ============================================
   Guards: existing pipelines own these turns
   ============================================ */

// A generation / edit / prompt-writing request keeps the existing chat
// pipeline, even when it happens to mention a system noun ("ComfyUI image").
const MEDIA_VERB_RE = /\b(?:generate|create|make|draw|render|design|produce|animate|edit|upscale|refine|restyle|redraw|paint|illustrate)\b/i;
const MEDIA_NOUN_RE = /\b(?:image|images|picture|pictures|photo|photos|portrait|portraits|illustration|artwork|art|video|videos|clip|clips|animation|cinematic|prompt|prompts|movie|film|poster|logo|thumbnail)\b/i;
const PROMPT_WRITE_RE = /\b(?:write|draft|compose|craft|formulate|give|suggest|produce|create|generate|make|need|want|come\s+up\s+with|put\s+together)\b(?:\s+\w+){0,3}?\s+\bprompts?\b/i;
const QUESTION_LEAD_RE = /^(?:what|which|why|who|when|where|how|is|are|was|were|do|does|did|can|could|would|should|will|tell\s+me|describe|explain|show\s+me)\b/i;
const EXPLANATION_LEAD_RE = /^(?:how\s+(?:do|does|can|should|would)\s+(?:i|you|we)|what\s+is|what\s+are|explain|describe|tell\s+me\s+about|why)\b/i;

function looksLikeMediaRequest(message) {
    const text = String(message || '');
    if (!text.trim()) return false;
    if (!MEDIA_VERB_RE.test(text)) return false;
    return MEDIA_NOUN_RE.test(text);
}

function looksLikePromptWriting(message) {
    return PROMPT_WRITE_RE.test(String(message || ''));
}

function isExplanationQuestion(message) {
    const text = String(message || '').trim();
    if (!text) return false;
    if (!QUESTION_LEAD_RE.test(text) && !/\?\s*$/.test(text)) return false;
    if (EXPLANATION_LEAD_RE.test(text)) return true;
    return /\?\s*$/.test(text) && !INVESTIGATION_VERB_RE.test(text);
}

function shouldDeferToExistingPipeline(message) {
    return looksLikePromptWriting(message) || looksLikeMediaRequest(message);
}

/* ============================================
   Signal vocabulary
   ============================================ */

const INVESTIGATION_VERB_RE =
    /\b(?:investigate|diagnose|troubleshoot|audit|inspect|examine|scan|analyse|analyze|measure|benchmark|profile|look\s+into|find\s+out|figure\s+out|check|review|trace)\b/i;
const PERFORMANCE_RE =
    /\b(?:performance|slow|sluggish|lag|laggy|stutter|jank|bottleneck|throughput|latency|frozen|freezes|hang|hangs|timeout|timing)\b/i;
const SYSTEM_NOUN_RE =
    /\b(?:system|machine|pc|computer|pc|cpu|ram|memory|gpu|vram|disk|storage|drive|comfyui|ollama|jarvis|app|application|server|process(?:es)?|queue|model|models|log|logs|generation|generations|render|renders)\b/i;
const DISK_CONSUME_RE =
    /\b(?:consum\w*|us(?:e|es|ed|ing)|takes?\s+up|taking\s+up|largest|biggest|huge|full|free\s+space|clean\s+up|cleanup|delete|remove|wasting|bloat)\b/i;
const FILE_RE = /\b(?:files?|folders?|director(?:y|ies)|cache|caches|temp|temporary|duplicates?|backups?|logs?)\b/i;
const TEMP_SCOPE_RE =
    /\b(?:temp|temporary|cache|caches|logs?|disk|storage|space|drive|duplicates?|backups?|\.tmp|\.log)\b/i;
const CLEANUP_RE =
    /\b(?:clean\s+up|cleanup|free\s+(?:up\s+)?(?:space|disk)|delete|remove|purge|clear|prune)\b/i;
const LOG_RE = /\b(?:logs?|errors?|exceptions?|traceback|crash(?:es|ed)?|faults?|failed|failures?|warnings?)\b/i;
const LOG_ACTION_RE = /\b(?:check|read|inspect|review|look\s+(?:at|into)|find|diagnose|why|show)\b/i;
const MODEL_RE = /\b(?:models?|ollama|llm|installed|loaded|running)\b/i;
const COMFY_RE = /\b(?:comfyui|comfy|queue|workflow|generation\s+server)\b/i;
const APP_RE = /\b(?:jarvis|app|application|conversation|chat|gallery|media|history|project|context|settings)\b/i;
const MULTI_STEP_RE =
    /\b(?:and\s+then|then|after\s+that|step\s+by\s+step|multiple\s+steps|first\b[\s\S]{1,120}\bthen|plan|workflow)\b/i;

const APPROVE_RE =
    /^(?:yes|yep|yeah|sure|ok(?:ay)?|approve|approved|do\s+it|go\s+ahead|proceed|confirm|apply\s+(?:it|the\s+fix)|sounds\s+good|please\s+do)\b/i;
const REJECT_RE = /^(?:no|nope|reject|rejected|don'?t|do\s+not|stop|cancel|never\s*mind)\b/i;
const CANCEL_RE =
    /\b(?:cancel|stop|abort|kill|end|never\s*mind|nevermind)\b[\s\S]{0,40}\b(?:task|it|that|this|agent|operation|investigation|run|job)\b/i;
const PAUSE_RE = /\b(?:pause|hold\s+on|hold\s+that|wait\s+a\s+(?:moment|sec|second|minute))\b/i;
const RESUME_RE = /\b(?:resume|unpause|continue|carry\s+on|keep\s+going|go\s+on|proceed)\b/i;
const RETRY_RE =
    /\b(?:retry|try\s+again|try\s+(?:the\s+)?(?:other|another)\s+(?:approach|way|method)|another\s+approach|start\s+over)\b/i;
const CONTINUE_RE = /^(?:continue|go\s+on|keep\s+going|next|proceed)\b/i;

/* ============================================
   Blocked capabilities
   ============================================ */

const BLOCKED_RULES = [
    {
        id: 'shell',
        re: /\b(?:run|execute|invoke|spawn)\b[\s\S]{0,40}\b(?:command|commands|powershell|cmd(?:\.exe)?|bash|shell|script|terminal|whoami|curl\s+https?)\b/i,
        reason: 'JARVIS does not execute shell commands, scripts or the terminal. No command was run.'
    },
    {
        id: 'shell',
        re: /(?:^|\s)(?:powershell|cmd(?:\.exe)?|bash|zsh|whoami|sudo)(?:\s|$)/i,
        reason: 'JARVIS does not execute shell commands, scripts or the terminal. No command was run.'
    },
    {
        id: 'browser_research',
        re: /\b(?:search|browse|google|look\s+up|research)\b[\s\S]{0,40}\b(?:the\s+)?(?:web|internet|online|google)\b/i,
        reason: 'Browser research is not available: no web-search or browsing tool is installed. I will not invent sources or results.'
    },
    {
        id: 'browser_research',
        re: /\b(?:open|visit|fetch)\b[\s\S]{0,20}\b(?:https?:\/\/|url|website|web\s?page|link)\b/i,
        reason: 'Browser research is not available: JARVIS cannot open URLs. No page was fetched.'
    },
    {
        id: 'software_install',
        re: /\b(?:install|uninstall|reinstall|update|upgrade|download)\b[\s\S]{0,40}\b(?:software|program|app|package|dependency|dependencies|driver|comfyui|python|node\.?js|node|pip|npm|winget|brew|apt)\b/i,
        reason: 'Software installation is not an agent action. Use the Setup panel or install it yourself; nothing was installed.'
    },
    {
        id: 'model_management',
        re: /\b(?:delete|remove|uninstall|install|download)\b[\s\S]{0,30}\b(?:models?|llms?|checkpoints?|weights?)\b/i,
        reason: 'Installing or deleting local models is not an agent action. Use the Model Library; nothing was changed.'
    },
    {
        id: 'config_changes',
        re: /\b(?:change|set|update|edit|modify|reset)\b[\s\S]{0,40}\b(?:settings?|config(?:uration)?|preferences?|options?)\b/i,
        reason: 'Changing configuration is done in the Settings panel, not through a model tool. Nothing was changed.'
    },
    {
        id: 'external_actions',
        re: /\b(?:send\s+(?:an?\s+)?(?:email|message|text)|post\s+(?:on|to)\s+(?:twitter|x|facebook|instagram|social)|purchase|buy|order|checkout)\b/i,
        reason: 'Externally consequential actions are not implemented. Nothing was sent, posted or purchased.'
    }
];

function blockedCapability(message) {
    const text = String(message || '');
    for (const rule of BLOCKED_RULES) {
        if (rule.re.test(text)) {
            return { id: rule.id, reason: rule.reason };
        }
    }
    return null;
}

const CAPABILITY_ALIASES = {
    system_telemetry: 'system_telemetry',
    model_inventory: 'model_inventory',
    comfyui_diagnostics: 'comfyui_diagnostics',
    log_inspection: 'log_inspection',
    app_context: 'app_context',
    media_history: 'media_history',
    disk_inspection: 'disk_inspection',
    file_cleanup: 'file_cleanup'
};

function normalizeCapabilityIds(ids) {
    if (!Array.isArray(ids)) return [];
    const out = [];
    ids.forEach((raw) => {
        const id = CAPABILITY_ALIASES[String(raw || '').trim()];
        if (id && out.indexOf(id) === -1) out.push(id);
    });
    return out;
}

/* ============================================
   Criteria
   ============================================ */

function buildCriteria(kind, capabilityIds, message) {
    const ids = normalizeCapabilityIds(capabilityIds);
    const criteria = [];
    const add = (text) => {
        if (!text || criteria.indexOf(text) !== -1 || criteria.length >= MAX_CRITERIA) return;
        criteria.push(text);
    };

    if (ids.indexOf('disk_inspection') !== -1) {
        add('Measure disk usage inside the permitted local roots.');
        add('Report the largest directories and files with sizes.');
    }
    if (ids.indexOf('file_cleanup') !== -1) {
        add('Prepare an exact list of temporary-file candidates with sizes.');
        if (/\b(?:delete|remove|clean|purge|prune|clear)\b/i.test(String(message || ''))) {
            add('Delete only the approved candidates and report a receipt for each file.');
        }
    }
    if (ids.indexOf('comfyui_diagnostics') !== -1) {
        add('Collect ComfyUI availability, queue and device evidence.');
    }
    if (ids.indexOf('system_telemetry') !== -1) {
        add('Collect current CPU, RAM, GPU and VRAM telemetry.');
    }
    if (ids.indexOf('log_inspection') !== -1) {
        add('Inspect the configured log tail for relevant errors.');
    }
    if (ids.indexOf('media_history') !== -1) {
        add('Review recent generation metadata for performance evidence.');
    }
    if (ids.indexOf('app_context') !== -1) {
        add('Read the relevant application or conversation metadata.');
    }
    if (ids.indexOf('model_inventory') !== -1) {
        add('List installed and loaded local models.');
    }
    if (!criteria.length) {
        add(kind === ACTIONS.TOOL
            ? 'Return the requested information gathered from tool results.'
            : 'Return a verified outcome with evidence for the original goal.');
    }
    return criteria.slice(0, MAX_CRITERIA);
}

/* ============================================
   Capability selection
   ============================================ */

function selectCapabilities(message, availableIds) {
    const text = String(message || '');
    const available = new Set(availableIds || []);
    const ids = [];
    const add = (id) => {
        if (!available.has(id) || ids.indexOf(id) !== -1) return;
        ids.push(id);
    };

    const cleanup = CLEANUP_RE.test(text) && FILE_RE.test(text) && TEMP_SCOPE_RE.test(text);
    const explicitDiskSpace = /\b(?:disk|storage|space|drive)\b/i.test(text);
    const diskish = explicitDiskSpace && DISK_CONSUME_RE.test(text);
    const comfy = COMFY_RE.test(text);
    const performance = PERFORMANCE_RE.test(text);
    const investigation = INVESTIGATION_VERB_RE.test(text);
    const logSignal = LOG_RE.test(text) && (LOG_ACTION_RE.test(text) || investigation);
    const modelSignal = MODEL_RE.test(text) && investigation;
    const appSignal = APP_RE.test(text) && investigation;

    if (cleanup) {
        add('file_cleanup');
        if (diskish) add('disk_inspection');
    } else if (diskish) {
        add('disk_inspection');
    }

    if (comfy) {
        add('comfyui_diagnostics');
        if (performance || investigation) {
            add('system_telemetry');
            add('log_inspection');
            add('media_history');
        }
    } else if (performance && investigation) {
        add('system_telemetry');
        if (modelSignal) add('model_inventory');
        if (appSignal) add('app_context');
    }

    if (logSignal) add('log_inspection');
    if (modelSignal && !performance) add('model_inventory');
    if (appSignal && !comfy && !performance) add('app_context');

    if (!ids.length && diskish) add('disk_inspection');
    if (!ids.length && logSignal) add('log_inspection');
    return ids;
}

function isAgentGoal(message, capabilityIds) {
    const text = String(message || '');
    if (!capabilityIds.length) return false;
    if (capabilityIds.indexOf('file_cleanup') !== -1) return true;
    if (MULTI_STEP_RE.test(text)) return true;
    if (CLEANUP_RE.test(text) && FILE_RE.test(text)) return true;
    return capabilityIds.length > 1;
}

function buildQuestion(message, capabilityIds) {
    const text = String(message || '');
    if (!text.trim()) {
        return 'What would you like me to investigate?';
    }
    if (/\b(?:fix|repair|apply)\b[\s\S]{0,30}\b(?:it|this|that|fix)\b/i.test(text)) {
        return 'I do not have a concrete fix to apply yet. Which issue or file should I work on, and what change do you want?';
    }
    if (/\b(?:clean|delete|remove|purge|prune)\b/i.test(text) && !FILE_RE.test(text)) {
        return 'Which files or folder should I clean up? I will prepare an exact candidate list before anything is deleted.';
    }
    if (capabilityIds.length) {
        return 'Which specific area should I check first?';
    }
    return 'What exactly would you like me to find out?';
}

/* ============================================
   Classifier
   ============================================ */

function cleanText(value, max) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max || MAX_GOAL_CHARS);
}

function makeDecision(action, extra) {
    return Object.assign({
        action,
        kind: action === ACTIONS.AGENT ? 'agent' : (action === ACTIONS.TOOL ? 'tool' : action),
        goal: '',
        completionCriteria: [],
        capabilities: [],
        missing: [],
        blockedReason: null,
        question: null,
        confidence: 0.5,
        source: 'signal'
    }, extra || {});
}

/**
 * Classify one chat turn.
 * opts:
 *   capabilities  - live capability entries or ids (required for agent/tool)
 *   hasActiveTask - an agent task already owns this conversation
 *   context       - optional recent conversation context string
 *   llm           - optional async classifier (LLM fallback; not used by default)
 */
function classify(message, options) {
    const opts = options || {};
    const text = cleanText(message, MAX_GOAL_CHARS);
    if (!text) return makeDecision(ACTIONS.DIRECT, { confidence: 0.9 });

    // Existing media / prompt pipeline always owns these turns.
    if (shouldDeferToExistingPipeline(text)) {
        return makeDecision(ACTIONS.DIRECT, {
            reason: 'Media or prompt-writing request; handled by the existing pipeline.',
            confidence: 0.98
        });
    }

    // Explanations about a topic are conversation, not investigation.
    const blocked = blockedCapability(text);
    if (blocked) {
        return makeDecision(ACTIONS.BLOCKED, {
            capabilities: [blocked.id],
            missing: [blocked.id],
            blockedReason: blocked.reason,
            reason: 'The required capability is not implemented.',
            confidence: 0.95
        });
    }

    const declarations = Array.isArray(opts.capabilities) ? opts.capabilities : [];
    const availableIds = declarations
        .filter((capability) => capability && capability.available)
        .map((capability) => capability.id);
    const availableIdSet = new Set(availableIds);

    const capabilityIds = selectCapabilities(text, availableIds);
    const missing = capabilityIds.filter((id) => !availableIdSet.has(id));

    const questionOnly = isExplanationQuestion(text);
    const investigation = INVESTIGATION_VERB_RE.test(text);
    const domain = SYSTEM_NOUN_RE.test(text) || DOMAIN_NOUN_RE.test(text);
    const explicitGoal = /\b(?:investigate|diagnose|troubleshoot|audit|scan|find\s+(?:out|what|which)|figure\s+out|look\s+into|what'?s|what\s+is|which)\b/i.test(text);

    // A pure how-to question with no explicit investigation verb stays chat.
    if (questionOnly && !explicitGoal) {
        return makeDecision(ACTIONS.DIRECT, {
            reason: 'Explanation question; answered directly.',
            confidence: 0.8
        });
    }

    if (!capabilityIds.length) {
        if (missing.length) {
            return makeDecision(ACTIONS.BLOCKED, {
                capabilities: missing,
                missing,
                blockedReason: 'No implemented local tool can perform that request.',
                confidence: 0.6
            });
        }
        if (/\b(?:fix|repair|apply\s+the\s+fix)\b/i.test(text) && /\b(?:it|this|that)\b/i.test(text)) {
            return makeDecision(ACTIONS.CLARIFY, {
                question: 'I do not have a concrete fix to apply. Which issue should I work on, and what change do you want?',
                confidence: 0.7
            });
        }
        if (opts.hasActiveTask && CONTINUE_RE.test(text)) {
            return makeDecision(ACTIONS.DIRECT, {
                reason: 'Follow-up to the active task; handled by the task flow.',
                confidence: 0.8
            });
        }
        return makeDecision(ACTIONS.DIRECT, {
            reason: investigation || domain ? 'No concrete tool-backed action matched.' : 'Ordinary conversation.',
            confidence: investigation ? 0.55 : 0.85
        });
    }

    // Guard against stray keywords in ordinary prose: an investigation needs a
    // verb or an unmistakable diagnostic noun, never just "disk" or "logs".
    if (!investigation && !PERFORMANCE_RE.test(text) && !CLEANUP_RE.test(text) &&
        !/\b(?:what'?s|what\s+is|which)\b[\s\S]{0,40}\b(?:using|consuming|taking|large|big)\b/i.test(text)) {
        return makeDecision(ACTIONS.DIRECT, {
            reason: 'Capability nouns appeared without an actionable request.',
            confidence: 0.7
        });
    }

    if (questionOnly && !explicitGoal && !CLEANUP_RE.test(text)) {
        return makeDecision(ACTIONS.DIRECT, { reason: 'Explanation question.', confidence: 0.75 });
    }

    const kind = isAgentGoal(text, capabilityIds) ? ACTIONS.AGENT : ACTIONS.TOOL;
    const blockedIds = capabilityIds.filter((id) => !availableIdSet.has(id));
    if (blockedIds.length && blockedIds.length === capabilityIds.length) {
        const declaration = declarations.find((capability) => capability && capability.id === blockedIds[0]) || {};
        return makeDecision(ACTIONS.BLOCKED, {
            capabilities: capabilityIds,
            missing: blockedIds,
            blockedReason: declaration.reason || 'That capability is not available.',
            confidence: 0.85
        });
    }

    return makeDecision(kind, {
        goal: text,
        completionCriteria: buildCriteria(kind, capabilityIds, text),
        capabilities: capabilityIds,
        missing: blockedIds,
        reason: kind === ACTIONS.AGENT
            ? 'A multi-step local investigation is needed.'
            : 'A specific local tool can answer this.',
        confidence: 0.8
    });
}

const DOMAIN_NOUN_RE =
    /\b(?:performance|health|status|usage|utilization|utilisation|temperature|space|cleanup|errors?|crash(?:es)?|diagnostics?)\b/i;

/* ============================================
   Follow-up classification
   ============================================ */

function taskIsActive(task) {
    return Boolean(task && ['queued', 'running', 'paused', 'awaiting_approval'].indexOf(task.status) !== -1);
}

function taskIsPendingApproval(task) {
    return Boolean(task && task.status === 'awaiting_approval' && task.approval && task.approval.status === 'pending');
}

/**
 * Resolve a short message against the conversation's active/last agent task.
 * Returns FOLLOW_UP_ACTIONS.NONE when the message is unrelated.
 */
function classifyFollowUp(message, task) {
    const text = cleanText(message, 400);
    if (!text || !task) return { action: FOLLOW_UP_ACTIONS.NONE, reason: 'No agent task.' };

    const pendingApproval = taskIsPendingApproval(task);
    const active = taskIsActive(task);
    const paused = task.status === 'paused';
    const terminal = ['completed', 'failed', 'cancelled'].indexOf(task.status) !== -1;

    if (CANCEL_RE.test(text)) {
        if (active) return { action: FOLLOW_UP_ACTIONS.CANCEL, reason: 'Cancel the running task.' };
        return { action: FOLLOW_UP_ACTIONS.NONE, reason: 'No active task to cancel.' };
    }

    if (pendingApproval) {
        if (APPROVE_RE.test(text)) return { action: FOLLOW_UP_ACTIONS.APPROVE, reason: 'Approve the pending action.' };
        if (REJECT_RE.test(text)) return { action: FOLLOW_UP_ACTIONS.REJECT, reason: 'Reject the pending action.' };
    }

    if (RETRY_RE.test(text) && terminal) {
        return { action: FOLLOW_UP_ACTIONS.RETRY, reason: 'Retry the same goal.' };
    }

    if (paused && (RESUME_RE.test(text) || CONTINUE_RE.test(text))) {
        return { action: FOLLOW_UP_ACTIONS.RESUME, reason: 'Resume the paused task.' };
    }
    if (PAUSE_RE.test(text) && (task.status === 'running' || task.status === 'queued')) {
        return { action: FOLLOW_UP_ACTIONS.PAUSE, reason: 'Pause the running task.' };
    }
    if (active && (RESUME_RE.test(text) || CONTINUE_RE.test(text))) {
        return { action: FOLLOW_UP_ACTIONS.CONTINUE, guidance: text, reason: 'Continue the running task.' };
    }
    if (terminal && /^(?:continue|go\s+on|keep\s+going|next|proceed)\b/i.test(text)) {
        return { action: FOLLOW_UP_ACTIONS.RETRY, reason: 'Continue the finished goal.' };
    }

    return { action: FOLLOW_UP_ACTIONS.NONE, reason: 'Unrelated to the task.' };
}

/* ============================================
   Optional LLM fallback (never used by default)
   ============================================ */

const ROUTER_SYSTEM_PROMPT = [
    'You are the capability-aware router for a local assistant.',
    'Reply with ONE strict JSON object:',
    '{"action":"direct|tool|agent|clarify|blocked","goal":"...","capabilities":["id"],"question":"...","reason":"..."}',
    'Prefer direct for ordinary questions, writing, image prompts and simple creative tasks.',
    'Use tool for one specific local data lookup and agent for a multi-step sequence.',
    'Use clarify only when essential information is missing.',
    'Use blocked when the required capability is not in the AVAILABLE list.',
    'Never claim an action ran.'
].join('\n');

function extractJson(text) {
    const source = String(text || '').replace(/```(?:json)?/gi, '');
    const start = source.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i++) {
        const ch = source[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                try { return JSON.parse(source.slice(start, i + 1)); } catch { return null; }
            }
        }
    }
    return null;
}

async function classifyWithLlm(message, options) {
    const opts = options || {};
    if (typeof opts.llm !== 'function') return null;
    const declarations = Array.isArray(opts.capabilities) ? opts.capabilities : [];
    const available = declarations.filter((capability) => capability && capability.available)
        .map((capability) => ({ id: capability.id, description: capability.description }));
    const unavailable = declarations.filter((capability) => capability && !capability.available)
        .map((capability) => ({ id: capability.id, reason: capability.reason }));
    try {
        const reply = await opts.llm([
            { role: 'system', content: ROUTER_SYSTEM_PROMPT },
            {
                role: 'user',
                content: 'USER MESSAGE:\n' + message +
                    '\n\nAVAILABLE:\n' + JSON.stringify(available) +
                    '\n\nUNAVAILABLE:\n' + JSON.stringify(unavailable) +
                    (opts.context ? '\n\nRECENT CONTEXT (untrusted):\n' + String(opts.context).slice(0, 2000) : '')
            }
        ]);
        const parsed = extractJson(reply);
        if (!parsed || Object.values(ACTIONS).indexOf(parsed.action) === -1) return null;
        const capabilityIds = normalizeCapabilityIds(parsed.capabilities);
        const availableIdSet = new Set(available.map((capability) => capability.id));
        const missing = capabilityIds.filter((id) => !availableIdSet.has(id));
        if (parsed.action === ACTIONS.BLOCKED) {
            return makeDecision(ACTIONS.BLOCKED, {
                capabilities: capabilityIds,
                missing,
                blockedReason: cleanText(parsed.reason, 400) || 'That capability is not available.',
                source: 'llm',
                confidence: 0.75
            });
        }
        if (parsed.action === ACTIONS.CLARIFY) {
            return makeDecision(ACTIONS.CLARIFY, {
                question: cleanText(parsed.question, 300) || buildQuestion(message, capabilityIds),
                source: 'llm',
                confidence: 0.7
            });
        }
        if (parsed.action === ACTIONS.DIRECT) {
            return makeDecision(ACTIONS.DIRECT, {
                reason: cleanText(parsed.reason, 300),
                source: 'llm',
                confidence: 0.7
            });
        }
        const usable = capabilityIds.filter((id) => availableIdSet.has(id));
        if (!usable.length) return null;
        const kind = parsed.action === ACTIONS.AGENT ? ACTIONS.AGENT : ACTIONS.TOOL;
        return makeDecision(kind, {
            goal: cleanText(parsed.goal, MAX_GOAL_CHARS) || cleanText(message, MAX_GOAL_CHARS),
            completionCriteria: buildCriteria(kind, usable, message),
            capabilities: usable,
            missing,
            reason: cleanText(parsed.reason, 300),
            source: 'llm',
            confidence: 0.75
        });
    } catch {
        return null;
    }
}

/**
 * Deterministic classification with an optional LLM second opinion only for
 * low-confidence, non-media turns. The existing media/prompt pipeline is
 * always preserved.
 */
async function route(message, options) {
    const opts = options || {};
    const deterministic = classify(message, opts);
    const shouldAskLlm = typeof opts.llm === 'function' &&
        deterministic.action === ACTIONS.DIRECT &&
        deterministic.confidence < 0.9 &&
        !shouldDeferToExistingPipeline(message) &&
        INVESTIGATION_VERB_RE.test(String(message || ''));
    if (!shouldAskLlm) return deterministic;
    const llmDecision = await classifyWithLlm(message, opts);
    return llmDecision || deterministic;
}

module.exports = {
    ACTIONS,
    FOLLOW_UP_ACTIONS,
    MAX_GOAL_CHARS,
    classify,
    classifyFollowUp,
    classifyWithLlm,
    route,
    buildCriteria,
    selectCapabilities,
    blockedCapability,
    looksLikeMediaRequest,
    looksLikePromptWriting,
    shouldDeferToExistingPipeline,
    isExplanationQuestion,
    normalizeCapabilityIds
};
