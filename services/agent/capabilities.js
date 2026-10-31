/* SPDX-License-Identifier: MIT */

/* ============================================
   JARVIS - Capability Registry
   The ONE description of what the local
   assistant can actually do. A capability is
   only advertised as available when its
   implementation is registered in the live tool
   registry; missing capabilities carry a real
   blocker explanation instead of pretending.
   ============================================ */

const AVAILABLE = [
    {
        id: 'system_telemetry',
        label: 'System telemetry',
        description: 'CPU, RAM, GPU and VRAM usage from the local system monitor.',
        tools: ['system_metrics'],
        kind: 'read'
    },
    {
        id: 'model_inventory',
        label: 'Local model inventory',
        description: 'Installed and loaded local chat models.',
        tools: ['list_models'],
        kind: 'read'
    },
    {
        id: 'comfyui_diagnostics',
        label: 'ComfyUI diagnostics',
        description: 'ComfyUI availability, queue and device state.',
        tools: ['comfyui_status'],
        kind: 'read'
    },
    {
        id: 'log_inspection',
        label: 'Log inspection',
        description: 'Read the tail of explicitly configured local logs.',
        tools: ['read_log'],
        kind: 'read'
    },
    {
        id: 'app_context',
        label: 'Application context',
        description: 'Read-only application, conversation and media metadata.',
        tools: ['app_context'],
        kind: 'read'
    },
    {
        id: 'media_history',
        label: 'Generation history',
        description: 'Recent image/video generation metadata for performance evidence.',
        tools: ['recent_generations'],
        kind: 'read'
    },
    {
        id: 'disk_inspection',
        label: 'Disk inspection',
        description: 'Measure disk usage inside explicitly permitted local roots.',
        tools: ['disk_usage'],
        kind: 'read'
    },
    {
        id: 'file_cleanup',
        label: 'Temporary-file cleanup',
        description: 'List exact temporary-file candidates and delete only approved files.',
        tools: ['find_temp_files', 'delete_files'],
        kind: 'write',
        requiresApproval: true
    }
];

const UNAVAILABLE = [
    {
        id: 'browser_research',
        label: 'Browser research',
        tools: [],
        reason: 'No browser or web-research tool is installed. JARVIS will not invent web results.'
    },
    {
        id: 'shell',
        label: 'Shell command execution',
        tools: [],
        reason: 'JARVIS never exposes a shell, PowerShell, terminal or arbitrary script execution.'
    },
    {
        id: 'software_install',
        label: 'Software installation',
        tools: [],
        reason: 'Installing software or dependencies is not available as an agent action. Use the Setup panel.'
    },
    {
        id: 'model_management',
        label: 'Model install/remove',
        tools: [],
        reason: 'Downloading or deleting local models is not an agent action. Use the Model Library.'
    },
    {
        id: 'config_changes',
        label: 'Configuration changes',
        tools: [],
        reason: 'Changing settings is done in the Settings panel, not through a model tool.'
    },
    {
        id: 'external_actions',
        label: 'External actions',
        tools: [],
        reason: 'Sending messages, posting to services or purchasing is not implemented.'
    }
];

function clone(entry) {
    return Object.assign({}, entry, {
        tools: Array.isArray(entry.tools) ? entry.tools.slice() : []
    });
}

/* ============================================
   Live availability
   ============================================ */

function normalizeToolNames(toolNames) {
    if (!Array.isArray(toolNames)) return [];
    return toolNames.map((name) => String(name || '').trim()).filter(Boolean);
}

function availableFor(toolNames) {
    const names = new Set(normalizeToolNames(toolNames));
    return AVAILABLE
        .filter((capability) => capability.tools.length && capability.tools.some((tool) => names.has(tool)))
        .map((capability) => {
            const entry = clone(capability);
            entry.missingTools = entry.tools.filter((tool) => !names.has(tool));
            entry.available = entry.missingTools.length === 0;
            if (!entry.available) {
                entry.reason = 'The backing tool is not registered: ' + entry.missingTools.join(', ') + '.';
            }
            return entry;
        });
}

function unavailableList(reasonOverrides) {
    const overrides = reasonOverrides || {};
    return UNAVAILABLE.map((entry) => Object.assign(clone(entry), {
        available: false,
        reason: overrides[entry.id] || entry.reason
    }));
}

/**
 * Build the capability catalog for the given live tool names.
 * `mode: 'read_only'` is derived from the registry; `writeEnabled` reflects
 * whether an approval-gated write capability is actually registered.
 */
function list(toolNames, options) {
    const opts = options || {};
    const capabilities = availableFor(toolNames).concat(unavailableList(opts.reasons));
    const known = new Set(capabilities.map((capability) => capability.id));
    const extra = Array.isArray(opts.extra) ? opts.extra : [];
    extra.forEach((entry) => {
        if (!entry || !entry.id || known.has(entry.id)) return;
        capabilities.push(clone(entry));
        known.add(entry.id);
    });
    return capabilities;
}

function get(id, toolNames, options) {
    const key = String(id || '').trim();
    if (!key) return null;
    return list(toolNames, options).find((capability) => capability.id === key) || null;
}

function availableIds(toolNames, options) {
    return list(toolNames, options)
        .filter((capability) => capability.available)
        .map((capability) => capability.id);
}

function has(id, toolNames) {
    const capability = get(id, toolNames);
    return Boolean(capability && capability.available);
}

function capByTool(toolName) {
    const tool = String(toolName || '').trim();
    if (!tool) return null;
    const match = AVAILABLE.find((capability) => capability.tools.indexOf(tool) !== -1);
    return match ? match.id : null;
}

function summary(toolNames) {
    const capabilities = list(toolNames);
    return {
        available: capabilities.filter((capability) => capability.available).map((capability) => capability.id),
        unavailable: capabilities.filter((capability) => !capability.available).map((capability) => capability.id),
        writeEnabled: capabilities.some((capability) => capability.available && capability.kind === 'write'),
        capabilities
    };
}

module.exports = {
    AVAILABLE,
    UNAVAILABLE,
    list,
    get,
    has,
    availableIds,
    capByTool,
    summary
};
