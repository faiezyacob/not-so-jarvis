/* SPDX-License-Identifier: MIT */

/* ============================================
   JARVIS - Agent Tool Registry
   A small allowlisted registry. The model only
   ever names a tool and supplies schema-validated
   arguments; it can never provide a shell command,
   a script, an arbitrary filesystem path or a
   credential. Read tools are rooted in configured
   permissions; the single write tool deletes only
   an exact, task-scoped candidate list and always
   requires server-side approval.
   ============================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const systemMonitor = require('../system-monitor');
const providerManager = require('../../server/provider-manager');
const configManager = require('../../server/config-manager');
const conversationService = require('../../server/conversation-service');
const generatedHistory = require('../generated-history');
const comfyui = require('../comfyui');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const MAX_LOG_SOURCES = 10;
const MAX_LOG_BYTES = 64 * 1024;
const MAX_LOG_LINES = 200;
const MAX_OUTPUT_CHARS = 6000;
const MAX_SCAN_FILES = 20000;
const MAX_SCAN_MS = 6000;
const SCAN_SKIP_DIRS = new Set(['.git', '.kilo', 'node_modules', '__pycache__', '.venv', 'venv']);
const CANDIDATE_TTL_MS = 15 * 60 * 1000;
const CANDIDATE_SETS = new Map();
const TEMP_FILE_RE = /(?:\.tmp|\.temp|\.bak|\.old|\.orig|\.swp|\.swo|\.cache|\.log|\.dmp|\.chk|~\$.*)$/i;

class ToolError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ToolError';
        this.code = code;
    }
}

function toolError(code, message) {
    return new ToolError(code, message);
}

function round(value, digits) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const factor = Math.pow(10, digits === undefined ? 1 : digits);
    return Math.round(n * factor) / factor;
}

function toIso(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/* ============================================
   Output bounds
   ============================================ */

function boundValue(value, depth) {
    const level = depth || 0;
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value.length > 1200 ? value.slice(0, 1200) + '\u2026' : value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'boolean') return value;
    if (level >= 8) return null;
    if (Array.isArray(value)) {
        return value.slice(0, 40).map((item) => boundValue(item, level + 1));
    }
    if (typeof value === 'object') {
        const out = {};
        Object.keys(value).slice(0, 30).forEach((key) => {
            out[key] = boundValue(value[key], level + 1);
        });
        return out;
    }
    return null;
}

function boundedJson(value, maxChars) {
    const bounded = boundValue(value, 0);
    const text = JSON.stringify(bounded === undefined ? null : bounded);
    const limit = maxChars || MAX_OUTPUT_CHARS;
    if (text.length <= limit) return bounded === undefined ? null : bounded;
    return {
        truncated: true,
        preview: text.slice(0, limit - 40) + '\u2026'
    };
}

/* ============================================
   Argument schema validation
   ============================================ */

function validateSchema(schema, value, label) {
    if (!schema || typeof schema !== 'object') throw toolError('invalid_tool_arguments', label + ' is not allowed.');
    const type = schema.type;
    if (type === 'object') {
        if (value === undefined || value === null) value = {};
        if (typeof value !== 'object' || Array.isArray(value)) {
            throw toolError('invalid_tool_arguments', label + ' must be an object.');
        }
        const props = schema.properties || {};
        const required = Array.isArray(schema.required) ? schema.required : [];
        for (const key of required) {
            if (value[key] === undefined) {
                throw toolError('invalid_tool_arguments', label + '.' + key + ' is required.');
            }
        }
        if (schema.additionalProperties === false) {
            for (const key of Object.keys(value)) {
                if (!Object.prototype.hasOwnProperty.call(props, key)) {
                    throw toolError('invalid_tool_arguments', label + '.' + key + ' is not an allowed argument.');
                }
            }
        }
        const out = {};
        for (const [key, childSchema] of Object.entries(props)) {
            if (value[key] === undefined) {
                if (childSchema && childSchema.default !== undefined) out[key] = childSchema.default;
                continue;
            }
            out[key] = validateSchema(childSchema, value[key], label + '.' + key);
        }
        return out;
    }
    if (type === 'string') {
        if (typeof value !== 'string') throw toolError('invalid_tool_arguments', label + ' must be a string.');
        const maxLength = Number.isInteger(schema.maxLength) ? schema.maxLength : 200;
        if (value.length > maxLength) throw toolError('invalid_tool_arguments', label + ' is too long (max ' + maxLength + ').');
        if (Array.isArray(schema.enum) && schema.enum.indexOf(value) === -1) {
            throw toolError('invalid_tool_arguments', label + ' must be one of: ' + schema.enum.join(', ') + '.');
        }
        return value;
    }
    if (type === 'boolean') {
        if (typeof value !== 'boolean') throw toolError('invalid_tool_arguments', label + ' must be true or false.');
        return value;
    }
    if (type === 'array') {
        if (!Array.isArray(value)) throw toolError('invalid_tool_arguments', label + ' must be an array.');
        const minItems = Number.isInteger(schema.minItems) ? schema.minItems : 0;
        const maxItems = Number.isInteger(schema.maxItems) ? schema.maxItems : 50;
        if (value.length < minItems) throw toolError('invalid_tool_arguments', label + ' needs at least ' + minItems + ' item(s).');
        if (value.length > maxItems) throw toolError('invalid_tool_arguments', label + ' has too many items (max ' + maxItems + ').');
        if (!schema.items) return value.slice();
        return value.map((item, index) => validateSchema(schema.items, item, label + '[' + index + ']'));
    }
    if (type === 'integer' || type === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw toolError('invalid_tool_arguments', label + ' must be a number.');
        }
        if (type === 'integer' && !Number.isInteger(value)) {
            throw toolError('invalid_tool_arguments', label + ' must be an integer.');
        }
        if (schema.minimum !== undefined && value < schema.minimum) {
            throw toolError('invalid_tool_arguments', label + ' must be at least ' + schema.minimum + '.');
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
            throw toolError('invalid_tool_arguments', label + ' must be at most ' + schema.maximum + '.');
        }
        return value;
    }
    throw toolError('invalid_tool_arguments', label + ' has an unsupported type.');
}

/* ============================================
   Log sources (explicitly configured paths only)
   ============================================ */

function defaultLogSources() {
    return [{
        id: 'comfyui-start',
        label: 'ComfyUI start log',
        path: path.join(DATA_DIR, 'comfyui-start.log')
    }];
}

function sanitizeLogId(value) {
    const id = String(value || '').trim().toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(id) ? id : null;
}

// AGENT_LOG_FILES = JSON array of { id, label, path }. When it is not set, a
// single permitted default (ComfyUI's launcher log inside data/) is exposed.
// A malformed explicit value yields no sources rather than silently falling
// back to an unexpected path.
function resolveLogSources(rawValue, projectRoot) {
    const raw = rawValue === undefined ? process.env.AGENT_LOG_FILES : rawValue;
    if (raw === undefined || raw === null || String(raw).trim() === '') return defaultLogSources();
    let parsed;
    try {
        parsed = JSON.parse(String(raw));
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    const root = path.resolve(projectRoot || path.join(__dirname, '..', '..'));
    const seen = new Set();
    const sources = [];
    for (const entry of parsed.slice(0, MAX_LOG_SOURCES)) {
        if (!entry || typeof entry !== 'object') continue;
        const id = sanitizeLogId(entry.id);
        const rawPath = String(entry.path || '').trim();
        if (!id || seen.has(id) || !rawPath) continue;
        const resolved = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(root, rawPath);
        if (!path.isAbsolute(resolved)) continue;
        seen.add(id);
        sources.push({
            id,
            label: String(entry.label || id).trim().slice(0, 80) || id,
            path: resolved
        });
    }
    return sources;
}

function redactLine(line) {
    let out = String(line);
    out = out.replace(/\bhf_[A-Za-z0-9]{6,}\b/g, 'hf_[redacted]');
    out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, 'sk-[redacted]');
    out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]');
    out = out.replace(/\b(api[_-]?key|access[_-]?token|token|secret|password|authorization)\b(\s*[:=]\s*)([^\s,;]+)/gi, '$1$2[redacted]');
    out = out.replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, '%USERPROFILE%');
    out = out.replace(/\/(?:home|Users)\/[^/\s"']+/g, '~');
    return out;
}

function readLogTail(source, wantedLines) {
    let stat;
    try {
        stat = fs.statSync(source.path);
    } catch {
        throw toolError('log_file_unavailable', 'The configured log "' + source.label + '" is not available.');
    }
    if (!stat.isFile()) {
        throw toolError('log_file_unavailable', 'The configured log "' + source.label + '" is not a file.');
    }
    const size = stat.size;
    const start = Math.max(0, size - MAX_LOG_BYTES);
    let text = '';
    if (size > 0) {
        const length = size - start;
        const buffer = Buffer.alloc(length);
        let fd = null;
        try {
            fd = fs.openSync(source.path, 'r');
            fs.readSync(fd, buffer, 0, length, start);
        } catch {
            throw toolError('log_file_unavailable', 'The configured log "' + source.label + '" could not be read.');
        } finally {
            if (fd !== null) {
                try { fs.closeSync(fd); } catch { /* ignore */ }
            }
        }
        text = buffer.toString('utf8');
    }
    const allLines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const selected = allLines.slice(-wantedLines);
    const lines = [];
    let used = 0;
    for (let i = selected.length - 1; i >= 0; i--) {
        const line = redactLine(selected[i]).slice(0, 400);
        if (used + line.length > 6000) break;
        lines.unshift(line);
        used += line.length + 1;
    }
    const errorPattern = /\b(error|exception|traceback|failed|failure|fatal|oom|out of memory)\b/i;
    return {
        source: source.label,
        logId: source.id,
        lines,
        lineCount: lines.length,
        errorLineCount: lines.filter((line) => errorPattern.test(line)).length,
        truncated: start > 0 || allLines.length > wantedLines || lines.length < selected.length
    };
}

/* ============================================
   Filesystem permissions
   ============================================ */

function parseRootList(rawValue) {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') return null;
    const text = String(rawValue).trim();
    let values = null;
    if (text.startsWith('[')) {
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) values = parsed;
        } catch {
            values = null;
        }
    }
    if (!values) {
        const separator = text.indexOf(';') !== -1 ? ';' : path.delimiter;
        values = text.split(separator);
    }
    return values.map((value) => String(value || '').trim()).filter(Boolean);
}

function normalizeRoots(values, projectRoot) {
    const root = path.resolve(projectRoot || PROJECT_ROOT);
    const out = [];
    const seen = new Set();
    (Array.isArray(values) ? values : []).forEach((value) => {
        const resolved = path.isAbsolute(String(value))
            ? path.normalize(String(value))
            : path.resolve(root, String(value));
        const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(resolved);
    });
    return out;
}

function resolveAllowedRoots(rawValue, projectRoot) {
    const explicit = parseRootList(rawValue === undefined ? process.env.AGENT_ALLOWED_ROOTS : rawValue);
    const roots = explicit && explicit.length
        ? normalizeRoots(explicit, projectRoot)
        : [path.resolve(projectRoot || PROJECT_ROOT)];
    return roots.length ? roots : [path.resolve(projectRoot || PROJECT_ROOT)];
}

// Deletion roots are deliberately narrower: an allowed read root is not
// automatically a deletion root, and a deletion root must live inside one.
function resolveDeleteRoots(allowedRoots, rawValue) {
    const roots = Array.isArray(allowedRoots) ? allowedRoots : [];
    const explicit = parseRootList(rawValue === undefined ? process.env.AGENT_DELETE_ROOTS : rawValue);
    if (!explicit || !explicit.length) return roots.slice();
    return normalizeRoots(explicit, PROJECT_ROOT).filter((candidate) =>
        roots.some((root) => isWithin(root, candidate)));
}

function isWithin(root, target) {
    const base = path.resolve(root);
    const candidate = path.resolve(target);
    const a = process.platform === 'win32' ? base.toLowerCase() : base;
    const b = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

function relativeDisplay(root, absolute) {
    const rel = path.relative(root, absolute);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : path.basename(absolute);
}

function labelRoots(roots) {
    return roots.map((root, index) => ({
        id: 'root-' + (index + 1),
        label: 'root-' + (index + 1),
        path: root
    }));
}

function safeStat(target) {
    try {
        return fs.lstatSync(target);
    } catch {
        return null;
    }
}

/* ============================================
   Disk scanning (permitted roots only)
   ============================================ */

function scanRoots(roots, options) {
    const opts = options || {};
    const maxFiles = Number.isInteger(opts.maxFiles) ? opts.maxFiles : MAX_SCAN_FILES;
    const maxMs = Number.isInteger(opts.maxMs) ? opts.maxMs : MAX_SCAN_MS;
    const deadline = Date.now() + maxMs;
    const maxDepth = Number.isInteger(opts.maxDepth) ? opts.maxDepth : 6;
    const matches = typeof opts.matches === 'function' ? opts.matches : () => true;
    const results = [];

    roots.forEach((root, rootIndex) => {
        const label = 'root-' + (rootIndex + 1);
        const rootStat = safeStat(root);
        if (!rootStat || !rootStat.isDirectory()) {
            results.push({ root: label, accessible: false, files: [], truncated: false });
            return;
        }
        const files = [];
        const stack = [{ dir: root, depth: 0 }];
        let seen = 0;
        let truncated = false;
        while (stack.length) {
            if (Date.now() > deadline || seen >= maxFiles) {
                truncated = true;
                break;
            }
            const current = stack.pop();
            let entries;
            try {
                entries = fs.readdirSync(current.dir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                if (Date.now() > deadline || seen >= maxFiles) {
                    truncated = true;
                    break;
                }
                const abs = path.join(current.dir, entry.name);
                if (entry.isSymbolicLink()) continue;
                if (entry.isDirectory()) {
                    if (SCAN_SKIP_DIRS.has(entry.name)) continue;
                    if (current.depth < maxDepth) stack.push({ dir: abs, depth: current.depth + 1 });
                    continue;
                }
                if (!entry.isFile()) continue;
                seen++;
                let stat;
                try {
                    stat = fs.statSync(abs);
                } catch {
                    continue;
                }
                const record = {
                    root: label,
                    relPath: relativeDisplay(root, abs),
                    absPath: abs,
                    sizeBytes: stat.size,
                    modifiedAt: stat.mtimeMs
                };
                if (matches(record)) files.push(record);
            }
        }
        results.push({ root: label, accessible: true, files, truncated });
    });
    return { roots: results, truncated: results.some((entry) => entry.truncated) };
}

function aggregateUsage(scan, topN) {
    const limit = Number.isInteger(topN) ? topN : 10;
    return scan.roots.map((entry) => {
        if (!entry.accessible) {
            return { root: entry.root, accessible: false, totalBytes: 0, topDirectories: [], topFiles: [], truncated: false };
        }
        let totalBytes = 0;
        const dirTotals = new Map();
        entry.files.forEach((file) => {
            totalBytes += file.sizeBytes;
            const parts = file.relPath.split('/');
            if (parts.length > 1) {
                const top = parts.slice(0, Math.min(2, parts.length - 1)).join('/');
                dirTotals.set(top, (dirTotals.get(top) || 0) + file.sizeBytes);
            }
        });
        const topDirectories = Array.from(dirTotals.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([dir, bytes]) => ({ path: dir, bytes, mb: round(bytes / (1024 * 1024), 2) }));
        const topFiles = entry.files.slice()
            .sort((a, b) => b.sizeBytes - a.sizeBytes)
            .slice(0, limit)
            .map((file) => ({
                path: file.relPath,
                bytes: file.sizeBytes,
                mb: round(file.sizeBytes / (1024 * 1024), 2),
                modifiedAt: toIso(file.modifiedAt)
            }));
        return {
            root: entry.root,
            accessible: true,
            totalBytes,
            totalMB: round(totalBytes / (1024 * 1024), 2),
            topDirectories,
            topFiles,
            truncated: entry.truncated
        };
    });
}

function isTempCandidate(record) {
    const name = path.basename(record.absPath);
    if (TEMP_FILE_RE.test(name)) return true;
    return /(?:^|[\\/])(?:temp|tmp|cache|caches|logs?)(?:[\\/]|$)/i.test(record.relPath);
}

function ownerKey(ctx) {
    const context = ctx || {};
    if (context.taskId) return 'task:' + context.taskId;
    if (context.conversationId) return 'conv:' + context.conversationId;
    return 'global';
}

function pruneCandidateSets() {
    const now = Date.now();
    Array.from(CANDIDATE_SETS.entries()).forEach(([key, set]) => {
        if (!set || now - set.createdAt > CANDIDATE_TTL_MS) CANDIDATE_SETS.delete(key);
    });
}

function storeCandidates(key, candidates, meta) {
    pruneCandidateSets();
    const setId = crypto.randomUUID();
    CANDIDATE_SETS.set(key, {
        id: setId,
        createdAt: Date.now(),
        candidates,
        meta: meta || null
    });
    return setId;
}

function getCandidateSet(key, setId) {
    pruneCandidateSets();
    const set = CANDIDATE_SETS.get(key);
    if (!set || set.id !== setId) return null;
    return set;
}

function resetCandidateSets() {
    CANDIDATE_SETS.clear();
}

/* ============================================
   Filesystem tools
   ============================================ */

function diskUsageTool(roots) {
    return {
        name: 'disk_usage',
        description: 'Measure disk usage inside the explicitly permitted local roots. Returns the largest directories and files with sizes. Never accepts a path from the model.',
        schema: {
            type: 'object',
            properties: {
                top: { type: 'integer', minimum: 1, maximum: 25, default: 10 }
            },
            required: [],
            additionalProperties: false
        },
        outputLimit: 6000,
        handler: async (args) => {
            const scan = scanRoots(roots);
            return {
                permittedRoots: labelRoots(roots).map((entry) => entry.label),
                usage: aggregateUsage(scan, args.top || 10),
                truncated: scan.truncated,
                excludedDirectories: Array.from(SCAN_SKIP_DIRS)
            };
        }
    };
}

function findTempFilesTool(roots) {
    return {
        name: 'find_temp_files',
        description: 'Find exact temporary/cache/log file candidates inside the permitted roots. Returns a candidate set id and a bounded list; use delete_files with that id after approval.',
        schema: {
            type: 'object',
            properties: {
                olderThanDays: { type: 'integer', minimum: 0, maximum: 365, default: 7 },
                maxCandidates: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
            },
            required: [],
            additionalProperties: false
        },
        outputLimit: 6000,
        handler: async (args, ctx) => {
            const olderThanDays = Number.isInteger(args.olderThanDays) ? args.olderThanDays : 7;
            const maxCandidates = Number.isInteger(args.maxCandidates) ? args.maxCandidates : 50;
            const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
            const scan = scanRoots(roots, {
                maxDepth: 8,
                matches: (record) => isTempCandidate(record) && record.modifiedAt <= cutoff
            });
            const all = [];
            scan.roots.forEach((entry) => {
                if (!entry.accessible) return;
                entry.files.forEach((file) => all.push(file));
            });
            all.sort((a, b) => b.sizeBytes - a.sizeBytes);
            const selected = all.slice(0, maxCandidates);
            const setId = selected.length
                ? storeCandidates(ownerKey(ctx), selected, { olderThanDays })
                : null;
            const candidates = selected.map((file, index) => ({
                id: 'c' + (index + 1),
                root: file.root,
                path: file.relPath,
                sizeBytes: file.sizeBytes,
                sizeMB: round(file.sizeBytes / (1024 * 1024), 2),
                modifiedAt: toIso(file.modifiedAt)
            }));
            const totalBytes = selected.reduce((sum, file) => sum + file.sizeBytes, 0);
            return {
                candidateSetId: setId,
                olderThanDays,
                candidates,
                candidateCount: candidates.length,
                totalCandidateBytes: totalBytes,
                totalCandidateMB: round(totalBytes / (1024 * 1024), 2),
                availableCandidates: all.length,
                truncated: scan.truncated || all.length > selected.length,
                message: candidates.length
                    ? 'Review the candidates. Deleting requires explicit approval.'
                    : 'No matching temporary files were found in the permitted roots.'
            };
        }
    };
}

function deleteFilesTool(deleteRoots) {
    return {
        name: 'delete_files',
        description: 'Delete ONLY the exact temporary-file candidates from a find_temp_files candidate set after explicit approval. Every target is revalidated immediately before deletion.',
        schema: {
            type: 'object',
            properties: {
                candidateSetId: { type: 'string', maxLength: 80 },
                candidateIds: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 100,
                    items: { type: 'string', maxLength: 10 }
                }
            },
            required: ['candidateSetId', 'candidateIds'],
            additionalProperties: false
        },
        outputLimit: 6000,
        requiresApproval: true,
        write: true,
        handler: async (args, ctx) => {
            const key = ownerKey(ctx);
            const set = getCandidateSet(key, args.candidateSetId);
            if (!set) {
                throw toolError('candidate_set_unavailable', 'That candidate list has expired or belongs to a different task. Run the temporary-file scan again.');
            }
            const wanted = new Set(args.candidateIds);
            const targets = set.candidates.filter((candidate, index) =>
                wanted.has('c' + (index + 1)));
            if (!targets.length) {
                throw toolError('candidate_not_found', 'None of the requested candidates are in that candidate list.');
            }
            const deleted = [];
            const failed = [];
            let freedBytes = 0;
            targets.forEach((candidate) => {
                const abs = candidate.absPath;
                if (!deleteRoots.some((root) => isWithin(root, abs))) {
                    failed.push({ path: candidate.relPath, error: 'outside_permitted_delete_roots' });
                    return;
                }
                const stat = safeStat(abs);
                if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
                    failed.push({ path: candidate.relPath, error: 'not_a_regular_file' });
                    return;
                }
                if (!isTempCandidate({ absPath: abs, relPath: candidate.relPath })) {
                    failed.push({ path: candidate.relPath, error: 'no_longer_matches_temporary_pattern' });
                    return;
                }
                if (stat.size > candidate.sizeBytes * 4 + 1024 * 1024) {
                    failed.push({ path: candidate.relPath, error: 'file_changed_since_scan' });
                    return;
                }
                try {
                    fs.unlinkSync(abs);
                    deleted.push({ path: candidate.relPath, bytes: stat.size });
                    freedBytes += stat.size;
                } catch (err) {
                    failed.push({ path: candidate.relPath, error: 'delete_failed' });
                }
            });
            CANDIDATE_SETS.delete(key);
            return {
                candidateSetId: args.candidateSetId,
                deleted,
                deletedCount: deleted.length,
                failed,
                failedCount: failed.length,
                freedBytes,
                freedMB: round(freedBytes / (1024 * 1024), 2),
                message: deleted.length
                    ? 'Deleted ' + deleted.length + ' approved file(s).'
                    : 'No files were deleted.'
            };
        }
    };
}

function recentGenerationsTool() {
    return {
        name: 'recent_generations',
        description: 'Read recent image/video generation metadata (model, type, timing, dimensions) for evidence-based performance review. No prompts or file paths.',
        schema: {
            type: 'object',
            properties: {
                limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }
            },
            required: [],
            additionalProperties: false
        },
        outputLimit: 5000,
        handler: async (args, ctx) => {
            const items = generatedHistory.listPublic(ctx.sessionId);
            const limit = args.limit || 20;
            const records = items.slice(0, limit).map((item) => {
                const video = item.video || {};
                return {
                    type: item.video ? 'video' : (String(item.file || '').includes('_edit_') ? 'edit' : 'image'),
                    model: item.model || null,
                    width: item.width || null,
                    height: item.height || null,
                    generationMs: item.generationMs || null,
                    createdAt: toIso(item.createdAt),
                    videoPipeline: video.pipeline || video.pipelineName || null,
                    attentionBackend: video.attentionBackend || null,
                    turbo: video.turbo === true,
                    upscaled: Boolean(item.upscale),
                    durationSeconds: Number.isFinite(Number(video.durationSeconds)) ? Number(video.durationSeconds) : null
                };
            });
            return { totalRecorded: items.length, count: records.length, items: records };
        }
    };
}

/* ============================================
   Tool definitions
   ============================================ */

function buildDefinitions(logSources, options) {
    const opts = options || {};
    const allowedRoots = Array.isArray(opts.allowedRoots) ? opts.allowedRoots : resolveAllowedRoots();
    const deleteRoots = Array.isArray(opts.deleteRoots) ? opts.deleteRoots : resolveDeleteRoots(allowedRoots);
    return [
        {
            name: 'system_metrics',
            description: 'Read the current CPU, RAM, GPU and VRAM telemetry from the local system monitor. No arguments.',
            schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
            outputLimit: 3000,
            handler: async () => {
                const stats = systemMonitor.getStats() || {};
                const cpu = stats.cpu || {};
                const ram = stats.ram || {};
                const gpu = stats.gpu || {};
                const vram = stats.vram || {};
                return {
                    cpu: {
                        usagePercent: round(cpu.usage, 1),
                        cores: Number.isInteger(cpu.cores) ? cpu.cores : null,
                        clock: cpu.clock || null,
                        name: cpu.name ? String(cpu.name).trim() : null
                    },
                    ram: {
                        usagePercent: round(ram.usage, 1),
                        usedGB: round(ram.used, 2),
                        totalGB: round(ram.total, 2),
                        freeGB: round(ram.free, 2)
                    },
                    gpu: {
                        name: gpu.name ? String(gpu.name).trim() : null,
                        utilizationPercent: round(gpu.usage, 1),
                        temperatureC: Number.isFinite(gpu.temperature) ? gpu.temperature : null
                    },
                    vram: {
                        available: Boolean(vram.available),
                        usagePercent: round(vram.usage, 1),
                        usedGB: round(vram.used, 2),
                        totalGB: round(vram.total, 2),
                        freeGB: round(vram.free, 2)
                    }
                };
            }
        },
        {
            name: 'list_models',
            description: 'List installed local chat models and the models currently loaded in memory. Optional loadedOnly=true narrows it to loaded models.',
            schema: {
                type: 'object',
                properties: {
                    loadedOnly: { type: 'boolean', default: false }
                },
                required: [],
                additionalProperties: false
            },
            outputLimit: 4000,
            handler: async (args) => {
                const status = await providerManager.getOllamaStatus();
                const running = (status.running || []).slice(0, 50).map((model) => ({
                    name: model.name,
                    vramGB: round((model.vramBytes || 0) / (1024 * 1024 * 1024), 2)
                }));
                if (args.loadedOnly) {
                    return {
                        provider: 'ollama',
                        online: Boolean(status.online),
                        loadedOnly: true,
                        running
                    };
                }
                const installed = await providerManager.getAllInstalledModels();
                const models = (installed || []).slice(0, 50).map((model) => ({
                    name: model.id,
                    sizeGB: round((model.sizeBytes || 0) / (1024 * 1024 * 1024), 2)
                }));
                return {
                    provider: 'ollama',
                    online: Boolean(status.online),
                    installedCount: models.length,
                    models,
                    running
                };
            }
        },
        {
            name: 'comfyui_status',
            description: 'Read ComfyUI availability, queue counts and device information through the existing ComfyUI integration. No arguments.',
            schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
            outputLimit: 3500,
            handler: async () => {
                const available = await comfyui.isAvailable();
                if (!available) {
                    return { available: false, queue: null, devices: [], system: null };
                }
                const [queueResult, statsResult] = await Promise.allSettled([
                    comfyui.getQueue(),
                    comfyui.getSystemStats()
                ]);
                let queue = null;
                if (queueResult.status === 'fulfilled' && queueResult.value) {
                    queue = {
                        running: Array.isArray(queueResult.value.queue_running) ? queueResult.value.queue_running.length : 0,
                        pending: Array.isArray(queueResult.value.queue_pending) ? queueResult.value.queue_pending.length : 0
                    };
                }
                let devices = [];
                let system = null;
                if (statsResult.status === 'fulfilled' && statsResult.value) {
                    const stats = statsResult.value;
                    devices = (Array.isArray(stats.devices) ? stats.devices : []).slice(0, 4).map((device) => ({
                        name: device.name || null,
                        type: device.type || null,
                        vramTotalMB: Number.isFinite(device.vram_total) ? Math.round(device.vram_total) : null,
                        vramFreeMB: Number.isFinite(device.vram_free) ? Math.round(device.vram_free) : null
                    }));
                    const sys = stats.system || {};
                    system = {
                        os: sys.os || null,
                        comfyuiVersion: sys.comfyui_version || null,
                        pythonVersion: sys.python_version || null
                    };
                }
                return { available: true, queue, devices, system };
            }
        },
        {
            name: 'read_log',
            description: 'Read the tail of an explicitly configured local log file (never a path provided by the model). Use loaded/model/ComfyUI logs to diagnose problems.',
            schema: {
                type: 'object',
                properties: {
                    logId: {
                        type: 'string',
                        maxLength: 32,
                        enum: logSources.length ? logSources.map((source) => source.id) : ['none-configured']
                    },
                    lines: { type: 'integer', minimum: 1, maximum: MAX_LOG_LINES, default: 80 }
                },
                required: ['logId'],
                additionalProperties: false
            },
            outputLimit: 8000,
            handler: async (args) => {
                const source = logSources.find((item) => item.id === args.logId);
                if (!source) {
                    throw toolError('log_source_not_configured', 'That log is not configured. Configured logs: ' +
                        (logSources.length ? logSources.map((item) => item.id).join(', ') : 'none') + '.');
                }
                return readLogTail(source, args.lines || 80);
            }
        },
        {
            name: 'app_context',
            description: 'Read a narrow, read-only snapshot of the running application: provider/model, the current conversation metadata, or generated-media counts. It never returns message bodies, file paths, environment variables or secrets.',
            schema: {
                type: 'object',
                properties: {
                    section: {
                        type: 'string',
                        maxLength: 20,
                        enum: ['overview', 'conversation', 'media'],
                        default: 'overview'
                    }
                },
                required: [],
                additionalProperties: false
            },
            outputLimit: 3000,
            handler: async (args, ctx) => {
                const section = args.section || 'overview';
                if (section === 'conversation') {
                    if (!ctx.conversationId) {
                        throw toolError('tool_context_missing', 'No conversation is attached to this task.');
                    }
                    const conversation = conversationService.getConversation(ctx.conversationId);
                    if (!conversation) {
                        throw toolError('conversation_not_found', 'The conversation is not available.');
                    }
                    const messages = conversationService.getMessages(ctx.conversationId);
                    return {
                        section: 'conversation',
                        title: conversation.title || 'Untitled conversation',
                        messageCount: messages.length,
                        memorySummaryPresent: Boolean(conversation.summary),
                        private: Boolean(conversation.private),
                        linkedToCharacter: Boolean(conversation.characterId),
                        createdAt: toIso(conversation.createdAt),
                        updatedAt: toIso(conversation.updatedAt)
                    };
                }
                if (section === 'media') {
                    const items = generatedHistory.listPublic(ctx.sessionId);
                    const counts = { image: 0, video: 0, other: 0 };
                    const typeOf = (item) => {
                        const ext = path.extname(item.file || '').toLowerCase();
                        if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].indexOf(ext) !== -1) return 'image';
                        if (['.mp4', '.webm', '.mov'].indexOf(ext) !== -1) return 'video';
                        return 'other';
                    };
                    items.forEach((item) => { counts[typeOf(item)]++; });
                    return {
                        section: 'media',
                        total: items.length,
                        counts,
                        recent: items.slice(0, 10).map((item) => ({
                            type: typeOf(item),
                            createdAt: toIso(item.createdAt)
                        }))
                    };
                }
                const config = configManager.getConfig();
                return {
                    section: 'overview',
                    provider: config.provider || 'ollama',
                    model: config.model || null,
                    reasoningEnabled: configManager.getReasoningEnabled(),
                    uptimeSeconds: Math.round(process.uptime()),
                    hasConversation: Boolean(ctx.conversationId)
                };
            }
        },
        diskUsageTool(allowedRoots),
        findTempFilesTool(allowedRoots),
        deleteFilesTool(deleteRoots),
        recentGenerationsTool()
    ];
}

/* ============================================
   Registry
   ============================================ */

function createRegistry(definitions) {
    const map = new Map();
    for (const definition of definitions || []) {
        const def = definition || {};
        if (!/^[a-z][a-z0-9_]{1,40}$/.test(String(def.name || ''))) {
            throw new Error('Invalid agent tool name: ' + def.name);
        }
        if (typeof def.handler !== 'function') {
            throw new Error('Agent tool has no handler: ' + def.name);
        }
        if (def.write === true && def.requiresApproval !== true) {
            throw new Error('A write-capable agent tool must require approval: ' + def.name);
        }
        if (map.has(def.name)) throw new Error('Duplicate agent tool: ' + def.name);
        map.set(def.name, {
            name: def.name,
            description: String(def.description || ''),
            schema: def.schema || { type: 'object', properties: {}, additionalProperties: false },
            outputLimit: Number.isInteger(def.outputLimit) ? def.outputLimit : MAX_OUTPUT_CHARS,
            requiresApproval: def.requiresApproval === true,
            write: def.write === true,
            handler: def.handler
        });
    }

    function get(name) {
        return map.get(name) || null;
    }

    function list() {
        return Array.from(map.values()).map((def) => ({
            name: def.name,
            description: def.description,
            schema: def.schema,
            requiresApproval: def.requiresApproval,
            write: def.write
        }));
    }

    function describe() {
        return list().map((def) => ({
            name: def.name,
            description: def.description,
            arguments: def.schema,
            requiresApproval: def.requiresApproval,
            write: def.write
        }));
    }

    function names() {
        return Array.from(map.keys());
    }

    function validateArgs(name, args) {
        const def = get(name);
        if (!def) throw toolError('unknown_tool', 'Unknown tool: ' + name);
        return validateSchema(def.schema, args === undefined ? {} : args, name + ' arguments');
    }

    async function execute(name, args, ctx) {
        const def = get(name);
        if (!def) throw toolError('unknown_tool', 'Unknown tool: ' + name);
        const validated = validateArgs(name, args);
        const result = await def.handler(validated, ctx || {});
        return boundedJson(result, def.outputLimit);
    }

    return { get, list, describe, names, validateArgs, execute, size: map.size };
}

function createDefaultRegistry(options) {
    const opts = options || {};
    const sources = Array.isArray(opts.logSources) ? opts.logSources : resolveLogSources();
    const allowedRoots = Array.isArray(opts.allowedRoots) ? opts.allowedRoots : resolveAllowedRoots();
    const deleteRoots = Array.isArray(opts.deleteRoots) ? opts.deleteRoots : resolveDeleteRoots(allowedRoots);
    return createRegistry(buildDefinitions(sources, { allowedRoots, deleteRoots }));
}

const defaultRegistry = createDefaultRegistry();

module.exports = {
    MAX_OUTPUT_CHARS,
    MAX_LOG_LINES,
    MAX_SCAN_FILES,
    ToolError,
    toolError,
    validateSchema,
    boundedJson,
    resolveLogSources,
    resolveAllowedRoots,
    resolveDeleteRoots,
    isWithin,
    redactLine,
    resetCandidateSets,
    createRegistry,
    createDefaultRegistry,
    defaultRegistry
};
