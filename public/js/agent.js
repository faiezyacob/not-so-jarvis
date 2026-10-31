/* SPDX-License-Identifier: MIT */

/* ============================================
   JARVIS - Unified Agent Cards
   Progress, tool status, approvals, recovery
   and results for server-owned tasks - rendered
   inline in the ONE main chat. There is no
   separate agent interface or mode switch.
   ============================================ */

const AgentUI = (() => {
    const HISTORY_LIMIT = 50;
    const EVENT_LIMIT = 140;

    const state = {
        conversationId: null,
        tasks: new Map(),
        sources: new Map(),
        pendingActions: new Set(),
        actionErrors: new Map(),
        hydrateToken: 0
    };

    let chatMessagesEl = null;

    const STATUS_LABELS = {
        queued: 'QUEUED',
        running: 'RUNNING',
        paused: 'PAUSED',
        awaiting_approval: 'NEEDS APPROVAL',
        completed: 'COMPLETE',
        failed: 'FAILED',
        cancelled: 'CANCELLED'
    };

    const EVENT_LABELS = {
        status: 'STATUS',
        plan: 'PLAN',
        step_start: 'START',
        step_complete: 'DONE',
        step_failed: 'FAIL',
        approval: 'APPROVAL',
        warning: 'WARN',
        retry: 'RETRY',
        guidance: 'GUIDANCE',
        cancel: 'CANCEL',
        result: 'RESULT',
        error: 'ERROR',
        tool: 'TOOL'
    };

    const TERMINAL = ['completed', 'failed', 'cancelled'];

    function isActiveStatus(status) {
        return status === 'queued' || status === 'running' || status === 'paused' || status === 'awaiting_approval';
    }

    function isTerminalStatus(status) {
        return TERMINAL.indexOf(status) !== -1;
    }

    async function api(method, url, body) {
        const res = await fetch(url, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(data.error || ('Request failed (' + res.status + ')'));
            err.status = res.status;
            err.code = data.code || null;
            throw err;
        }
        return data;
    }

    /* ============================================
       Lifecycle
       ============================================ */

    function init() {
        chatMessagesEl = document.getElementById('chatMessages');
    }

    // Compatibility shims for older callers; unified chat has no mode.
    function isActive() {
        return false;
    }

    function setMode() {
        /* no separate mode */
    }

    function adopt(task) {
        if (!task || !task.id) return;
        state.conversationId = task.conversationId || state.conversationId;
        rememberTask(task);
        renderTask(task, { scroll: true });
        ensureStream(task);
    }

    /* ============================================
       Hydrate (reload / conversation switch)
       ============================================ */

    async function hydrate(messagesEl, conversationId) {
        if (!messagesEl) return;
        chatMessagesEl = messagesEl;
        state.conversationId = conversationId || null;
        const token = ++state.hydrateToken;
        messagesEl.querySelectorAll('.agent-task').forEach((node) => node.remove());

        Array.from(state.sources.values()).forEach((source) => {
            try { source.close(); } catch {}
        });
        state.sources.clear();

        if (!state.conversationId) return;
        let tasks = [];
        try {
            const data = await api('GET', '/api/agent/tasks?conversationId=' + encodeURIComponent(state.conversationId));
            tasks = Array.isArray(data.tasks) ? data.tasks : [];
        } catch {
            return;
        }
        if (token !== state.hydrateToken) return;
        tasks = tasks.slice(0, HISTORY_LIMIT).reverse();
        tasks.forEach((task) => {
            rememberTask(task);
            renderTask(task, { scroll: false });
            ensureStream(task);
        });
        if (tasks.length && messagesEl) {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }
    }

    function rememberTask(task) {
        if (!task || !task.id) return null;
        const existing = state.tasks.get(task.id) || {};
        const merged = Object.assign({}, existing, task);
        if (!Array.isArray(merged.events)) merged.events = existing.events || [];
        merged._lastSeq = typeof existing._lastSeq === 'number' ? existing._lastSeq : maxSeq(merged.events);
        state.tasks.set(merged.id, merged);
        return merged;
    }

    function maxSeq(events) {
        return (Array.isArray(events) ? events : []).reduce((max, event) => {
            return Number.isInteger(event.seq) && event.seq > max ? event.seq : max;
        }, 0);
    }

    /* ============================================
       Task card
       ============================================ */

    function taskCard(task) {
        if (!chatMessagesEl) return null;
        return chatMessagesEl.querySelector('.agent-task[data-task-id="' + String(task.id).replace(/["\\]/g, '') + '"]');
    }

    function renderTask(task, options) {
        if (!chatMessagesEl || !task) return;
        if (task.conversationId && state.conversationId && task.conversationId !== state.conversationId) return;
        const opts = options || {};
        let card = taskCard(task);
        const isNew = !card;
        if (!card) {
            card = document.createElement('article');
            card.className = 'agent-task';
            card.setAttribute('data-task-id', task.id);
            chatMessagesEl.appendChild(card);
        }

        card.className = 'agent-task agent-task--' + (task.status || 'queued');
        card.innerHTML = '';
        card.appendChild(cardHeader(task));

        const goal = document.createElement('p');
        goal.className = 'agent-task-goal';
        goal.textContent = task.goal || task.request || '';
        card.appendChild(goal);

        if (Array.isArray(task.guidance) && task.guidance.length) {
            const guidance = document.createElement('div');
            guidance.className = 'agent-task-guidance';
            task.guidance.slice(-3).forEach((entry) => {
                const line = document.createElement('div');
                line.textContent = 'Guidance: ' + entry.text;
                guidance.appendChild(line);
            });
            card.appendChild(guidance);
        }

        if (task.plan && Array.isArray(task.plan.steps) && task.plan.steps.length) {
            card.appendChild(stepsBlock(task));
        } else if (isActiveStatus(task.status)) {
            const planning = document.createElement('div');
            planning.className = 'agent-task-planning';
            planning.textContent = task.taskKind === 'tool'
                ? 'Gathering the requested information...'
                : 'Planning the needed steps...';
            card.appendChild(planning);
        }

        const activity = activityBlock(task);
        if (activity) card.appendChild(activity);

        if (task._reconnecting) {
            const note = document.createElement('div');
            note.className = 'agent-task-note agent-task-note--reconnect';
            note.textContent = 'Live connection interrupted - reconnecting...';
            card.appendChild(note);
        }

        if (task.status === 'awaiting_approval' && task.approval && task.approval.status === 'pending') {
            card.appendChild(approvalBlock(task));
        }

        if (task.error) card.appendChild(errorBlock(task));
        if (task.result) card.appendChild(resultBlock(task));
        const actions = actionsBlock(task);
        if (actions) card.appendChild(actions);

        if (opts.scroll && isNew) {
            chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
        } else if (isNew && isActiveStatus(task.status)) {
            chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
        }
    }

    function cardHeader(task) {
        const head = document.createElement('header');
        head.className = 'agent-task-head';

        const kicker = document.createElement('span');
        kicker.className = 'agent-task-kicker';
        kicker.textContent = 'TASK';
        head.appendChild(kicker);

        const status = document.createElement('span');
        status.className = 'agent-task-status agent-task-status--' + (task.status || 'queued');
        status.textContent = STATUS_LABELS[task.status] || String(task.status || '').toUpperCase();
        if (isActiveStatus(task.status)) {
            const dot = document.createElement('span');
            dot.className = 'agent-task-dot';
            status.prepend(dot);
        }
        head.appendChild(status);

        if (task.planSource === 'fallback') {
            const warn = document.createElement('span');
            warn.className = 'agent-task-tag';
            warn.textContent = 'DETERMINISTIC PLAN';
            warn.title = 'The local model did not return a valid plan; safe tools were used.';
            head.appendChild(warn);
        }
        if (task.parentTaskId) {
            const tag = document.createElement('span');
            tag.className = 'agent-task-tag';
            tag.textContent = 'RETRY';
            tag.title = 'This task continues an earlier goal.';
            head.appendChild(tag);
        }

        const time = document.createElement('span');
        time.className = 'agent-task-time';
        const date = task.createdAt ? new Date(task.createdAt) : new Date();
        time.textContent = Number.isNaN(date.getTime())
            ? ''
            : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        head.appendChild(time);
        return head;
    }

    function stepsBlock(task) {
        const block = document.createElement('div');
        block.className = 'agent-task-plan';

        const label = document.createElement('div');
        label.className = 'agent-task-plan-label';
        label.textContent = 'PLAN' + (task.plan.understanding ? ' - ' + task.plan.understanding : '');
        block.appendChild(label);

        const list = document.createElement('ol');
        list.className = 'agent-task-steps';
        task.plan.steps.forEach((step, index) => {
            const item = document.createElement('li');
            item.className = 'agent-task-step agent-task-step--' + (step.status || 'pending');

            const marker = document.createElement('span');
            marker.className = 'agent-task-step-marker';
            marker.textContent = step.status === 'completed' ? '\u2713'
                : step.status === 'failed' ? '\u00d7'
                : step.status === 'skipped' ? '\u2013'
                : (step.status === 'running' ? '' : String(index + 1));
            if (step.status === 'running') marker.classList.add('agent-task-step-marker--spin');
            item.appendChild(marker);

            const body = document.createElement('div');
            body.className = 'agent-task-step-body';
            const title = document.createElement('div');
            title.className = 'agent-task-step-title';
            title.textContent = step.title || step.tool || 'Step';
            body.appendChild(title);

            const meta = document.createElement('div');
            meta.className = 'agent-task-step-meta';
            meta.textContent = step.tool || '';
            if (step.status === 'running') meta.textContent += ' \u00b7 running';
            else if (step.status === 'completed') meta.textContent += ' \u00b7 complete';
            else if (step.status === 'failed') meta.textContent += ' \u00b7 failed';
            else if (step.status === 'skipped') meta.textContent += ' \u00b7 skipped';
            body.appendChild(meta);
            if (step.error && step.error.message) {
                const err = document.createElement('div');
                err.className = 'agent-task-step-error';
                err.textContent = step.error.message;
                body.appendChild(err);
            }
            item.appendChild(body);
            list.appendChild(item);
        });
        block.appendChild(list);
        return block;
    }

    function activityBlock(task) {
        const events = Array.isArray(task.events) ? task.events : [];
        const visible = events.filter((event) => EVENT_LABELS[event.type] && event.message);
        if (!visible.length) return null;

        const block = document.createElement('div');
        block.className = 'agent-task-activity';
        const heading = document.createElement('div');
        heading.className = 'agent-task-plan-label';
        heading.textContent = 'ACTIVITY';
        block.appendChild(heading);

        const compact = visible.slice(-3);
        compact.forEach((event) => block.appendChild(activityLine(event)));

        if (visible.length > compact.length) {
            const details = document.createElement('details');
            details.className = 'agent-task-trace';
            const summary = document.createElement('summary');
            summary.textContent = 'Full execution trace (' + visible.length + ' events)';
            details.appendChild(summary);
            visible.forEach((event) => details.appendChild(activityLine(event)));
            block.appendChild(details);
        }
        return block;
    }

    function activityLine(event) {
        const line = document.createElement('div');
        line.className = 'agent-task-activity-line agent-task-activity-line--' + event.type;
        const tag = document.createElement('span');
        tag.className = 'agent-task-activity-tag';
        tag.textContent = EVENT_LABELS[event.type] || String(event.type || '').toUpperCase();
        line.appendChild(tag);
        const text = document.createElement('span');
        text.textContent = event.message;
        line.appendChild(text);
        return line;
    }

    function approvalBlock(task) {
        const block = document.createElement('div');
        block.className = 'agent-task-approval';
        const text = document.createElement('div');
        text.className = 'agent-task-approval-text';
        text.textContent = 'This action needs your approval before it can run. Nothing has been executed yet.';
        block.appendChild(text);

        const preview = task.approval && task.approval.preview;
        if (preview && preview.candidateCount) {
            const details = document.createElement('details');
            details.className = 'agent-task-trace';
            const summary = document.createElement('summary');
            summary.textContent = 'Exact candidates (' + preview.candidateCount + ' files, ' +
                (preview.totalMB || 0) + ' MB)';
            details.appendChild(summary);
            const list = document.createElement('ul');
            list.className = 'agent-task-facts';
            (preview.candidates || []).forEach((path) => {
                const item = document.createElement('li');
                item.textContent = path;
                list.appendChild(item);
            });
            details.appendChild(list);
            block.appendChild(details);
        }

        const row = document.createElement('div');
        row.className = 'agent-task-actions';
        const pending = state.pendingActions.has(task.id);
        row.appendChild(actionButton('Approve', 'agent-task-btn agent-task-btn--approve', pending, () => {
            submitApproval(task.id, 'approve');
        }));
        row.appendChild(actionButton('Reject', 'agent-task-btn agent-task-btn--reject', pending, () => {
            submitApproval(task.id, 'reject');
        }));
        row.appendChild(actionButton('Cancel task', 'agent-task-btn agent-task-btn--cancel', pending, () => {
            cancelTask(task.id);
        }));
        block.appendChild(row);

        const err = state.actionErrors.get(task.id);
        if (err) {
            const line = document.createElement('div');
            line.className = 'agent-task-action-error';
            line.textContent = err;
            block.appendChild(line);
        }
        return block;
    }

    function errorBlock(task) {
        const block = document.createElement('div');
        block.className = 'agent-task-error';
        const code = document.createElement('span');
        code.className = 'agent-task-error-code';
        code.textContent = (task.error && task.error.code) || 'error';
        block.appendChild(code);
        const text = document.createElement('span');
        text.textContent = (task.error && task.error.message) || 'The task failed.';
        block.appendChild(text);
        return block;
    }

    function resultBlock(task) {
        const block = document.createElement('div');
        block.className = 'agent-task-result';
        const result = task.result || {};

        const heading = document.createElement('div');
        heading.className = 'agent-task-plan-label';
        heading.textContent = 'RESULT';
        block.appendChild(heading);

        const summary = document.createElement('p');
        summary.className = 'agent-task-summary';
        summary.textContent = result.summary || '';
        block.appendChild(summary);

        if (Array.isArray(result.receipts) && result.receipts.length) {
            const label = document.createElement('div');
            label.className = 'agent-task-result-label';
            label.textContent = 'ACTION RECEIPTS';
            block.appendChild(label);
            const list = document.createElement('ul');
            list.className = 'agent-task-facts';
            result.receipts.forEach((receipt) => {
                const item = document.createElement('li');
                item.textContent = receipt.summary || receipt.title || receipt.tool;
                list.appendChild(item);
            });
            block.appendChild(list);
        }

        if (Array.isArray(result.criteriaMet) && result.criteriaMet.length) {
            const label = document.createElement('div');
            label.className = 'agent-task-result-label';
            label.textContent = 'COMPLETION CRITERIA';
            block.appendChild(label);
            const list = document.createElement('ul');
            list.className = 'agent-task-criteria';
            result.criteriaMet.forEach((entry) => {
                const item = document.createElement('li');
                item.className = entry.met ? 'is-met' : 'is-unmet';
                item.textContent = (entry.met ? '\u2713 ' : '\u00d7 ') + entry.criterion;
                list.appendChild(item);
            });
            block.appendChild(list);
        }

        if (Array.isArray(result.verifiedFacts) && result.verifiedFacts.length) {
            const label = document.createElement('div');
            label.className = 'agent-task-result-label';
            label.textContent = 'VERIFIED FROM TOOLS';
            block.appendChild(label);
            const list = document.createElement('ul');
            list.className = 'agent-task-facts';
            result.verifiedFacts.forEach((fact) => {
                const item = document.createElement('li');
                item.textContent = fact;
                list.appendChild(item);
            });
            block.appendChild(list);
        }

        if (Array.isArray(result.logExcerpts) && result.logExcerpts.length) {
            result.logExcerpts.forEach((excerpt) => {
                const details = document.createElement('details');
                details.className = 'agent-task-log';
                const summaryEl = document.createElement('summary');
                summaryEl.textContent = 'LOG EXCERPT - ' + (excerpt.source || 'log') + ' (' +
                    (excerpt.lineCount || 0) + ' lines, ' + (excerpt.errorLineCount || 0) + ' error matches)';
                details.appendChild(summaryEl);
                const pre = document.createElement('pre');
                pre.textContent = (excerpt.lines || []).join('\n');
                details.appendChild(pre);
                block.appendChild(details);
            });
        }

        if (Array.isArray(result.suggestions) && result.suggestions.length) {
            const label = document.createElement('div');
            label.className = 'agent-task-result-label';
            label.textContent = 'SUGGESTED NEXT STEPS (NOT EXECUTED)';
            block.appendChild(label);
            const list = document.createElement('ul');
            list.className = 'agent-task-suggestions';
            result.suggestions.forEach((suggestion) => {
                const item = document.createElement('li');
                item.textContent = suggestion;
                list.appendChild(item);
            });
            block.appendChild(list);
        }

        const warnings = Array.isArray(result.warnings) ? result.warnings : [];
        if (warnings.length) {
            const list = document.createElement('ul');
            list.className = 'agent-task-warnings';
            warnings.forEach((warning) => {
                const item = document.createElement('li');
                item.textContent = warning;
                list.appendChild(item);
            });
            block.appendChild(list);
        }

        if (result.summarySource === 'deterministic') {
            const note = document.createElement('div');
            note.className = 'agent-task-note';
            note.textContent = 'Summary generated deterministically from tool output.';
            block.appendChild(note);
        }

        const download = document.createElement('button');
        download.type = 'button';
        download.className = 'agent-task-btn agent-task-btn--download';
        download.textContent = 'Download report';
        download.addEventListener('click', () => downloadReport(task));
        block.appendChild(download);
        return block;
    }

    function downloadReport(task) {
        const result = task.result || {};
        const lines = [
            'JARVIS TASK REPORT',
            '==================',
            '',
            'Goal: ' + (task.goal || task.request || ''),
            'Status: ' + (task.status || ''),
            'Started: ' + (task.startedAt || task.createdAt || ''),
            'Completed: ' + (task.completedAt || ''),
            '',
            'Summary',
            '-------',
            result.summary || '(none)',
            ''
        ];
        if (Array.isArray(result.criteriaMet) && result.criteriaMet.length) {
            lines.push('Completion criteria', '-------------------');
            result.criteriaMet.forEach((entry) => {
                lines.push((entry.met ? '[MET] ' : '[UNMET] ') + entry.criterion);
            });
            lines.push('');
        }
        if (Array.isArray(result.receipts) && result.receipts.length) {
            lines.push('Action receipts', '---------------');
            result.receipts.forEach((receipt) => lines.push('- ' + (receipt.summary || receipt.title || '')));
            lines.push('');
        }
        if (Array.isArray(result.verifiedFacts) && result.verifiedFacts.length) {
            lines.push('Verified from tools', '-------------------');
            result.verifiedFacts.forEach((fact) => lines.push('- ' + fact));
            lines.push('');
        }
        if (Array.isArray(result.tools) && result.tools.length) {
            lines.push('Tool results', '------------');
            result.tools.forEach((entry) => {
                lines.push('- [' + (entry.ok ? 'ok' : 'failed') + '] ' + entry.tool + ': ' + entry.summary);
            });
            lines.push('');
        }
        if (result.error || task.error) {
            lines.push('Error', '-----', (result.error || task.error).code + ': ' +
                (result.error || task.error).message, '');
        }
        lines.push('Generated by Not-so-Jarvis. Evidence above came from server-side tool results.');

        const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'jarvis-task-' + String(task.id).slice(0, 8) + '.md';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function actionsBlock(task) {
        const row = document.createElement('div');
        row.className = 'agent-task-actions';
        const pending = state.pendingActions.has(task.id);
        let hasAction = false;

        if (task.status === 'paused') {
            row.appendChild(actionButton('Resume', 'agent-task-btn', pending, () => lifecycle(task.id, 'resume')));
            hasAction = true;
        } else if (task.status === 'running') {
            row.appendChild(actionButton('Pause', 'agent-task-btn', pending, () => lifecycle(task.id, 'pause')));
            hasAction = true;
        }

        if (isActiveStatus(task.status)) {
            row.appendChild(actionButton('Cancel task', 'agent-task-btn agent-task-btn--cancel', pending, () => cancelTask(task.id)));
            hasAction = true;
        } else if (isTerminalStatus(task.status)) {
            row.appendChild(actionButton('Retry', 'agent-task-btn', pending, () => retryTask(task.id)));
            hasAction = true;
        }

        const err = state.actionErrors.get(task.id);
        if (err) {
            const line = document.createElement('div');
            line.className = 'agent-task-action-error';
            line.textContent = err;
            row.appendChild(line);
            hasAction = true;
        }
        return hasAction ? row : null;
    }

    function actionButton(text, className, disabled, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = disabled ? 'Working...' : text;
        button.disabled = Boolean(disabled);
        button.addEventListener('click', () => {
            if (button.disabled) return;
            onClick();
        });
        return button;
    }

    /* ============================================
       Actions
       ============================================ */

    function setPending(taskId, pending) {
        if (pending) state.pendingActions.add(taskId);
        else state.pendingActions.delete(taskId);
        const task = state.tasks.get(taskId);
        if (task) renderTask(task);
    }

    async function cancelTask(taskId) {
        if (state.pendingActions.has(taskId)) return;
        state.actionErrors.delete(taskId);
        setPending(taskId, true);
        try {
            const data = await api('POST', '/api/agent/tasks/' + encodeURIComponent(taskId) + '/cancel', {});
            if (data.task) applySnapshot(data.task);
        } catch (err) {
            state.actionErrors.set(taskId, err.message);
        } finally {
            setPending(taskId, false);
        }
    }

    async function submitApproval(taskId, decision) {
        if (state.pendingActions.has(taskId)) return;
        state.actionErrors.delete(taskId);
        setPending(taskId, true);
        try {
            const data = await api('POST', '/api/agent/tasks/' + encodeURIComponent(taskId) + '/approval', { decision });
            if (data.task) applySnapshot(data.task);
        } catch (err) {
            state.actionErrors.set(taskId, err.message);
        } finally {
            setPending(taskId, false);
        }
    }

    async function lifecycle(taskId, action) {
        if (state.pendingActions.has(taskId)) return;
        state.actionErrors.delete(taskId);
        setPending(taskId, true);
        try {
            const data = await api('POST', '/api/agent/tasks/' + encodeURIComponent(taskId) + '/' + action, {});
            if (data.task) applySnapshot(data.task);
        } catch (err) {
            state.actionErrors.set(taskId, err.message);
        } finally {
            setPending(taskId, false);
        }
    }

    async function retryTask(taskId) {
        if (state.pendingActions.has(taskId)) return;
        state.actionErrors.delete(taskId);
        setPending(taskId, true);
        try {
            const data = await api('POST', '/api/agent/tasks/' + encodeURIComponent(taskId) + '/retry', {});
            if (data.task) adopt(data.task);
        } catch (err) {
            state.actionErrors.set(taskId, err.message);
        } finally {
            setPending(taskId, false);
        }
    }

    /* ============================================
       Streaming
       ============================================ */

    function applySnapshot(snapshot) {
        if (!snapshot || !snapshot.id) return;
        const task = rememberTask(snapshot);
        task._reconnecting = false;
        if (Array.isArray(snapshot.events)) {
            task.events = snapshot.events.slice(-EVENT_LIMIT);
            task._lastSeq = maxSeq(task.events);
        }
        renderTask(task);
        if (isActiveStatus(task.status)) ensureStream(task);
    }

    function applyEvent(taskId, event) {
        const task = state.tasks.get(taskId);
        if (!task || !event) return;
        if (Number.isInteger(event.seq) && event.seq <= (task._lastSeq || 0)) return;
        if (Number.isInteger(event.seq)) task._lastSeq = event.seq;
        task.events = Array.isArray(task.events) ? task.events : [];
        task.events.push(event);
        if (task.events.length > EVENT_LIMIT) task.events.splice(0, task.events.length - EVENT_LIMIT);

        const data = event.data || {};
        switch (event.type) {
            case 'status':
                task.status = event.status || task.status;
                break;
            case 'plan':
                task.plan = {
                    understanding: data.understanding || '',
                    source: data.source || 'model',
                    warnings: task.plan && Array.isArray(task.plan.warnings) ? task.plan.warnings : [],
                    steps: (Array.isArray(data.steps) ? data.steps : []).map((step) => Object.assign({}, step, {
                        status: 'pending',
                        error: null
                    }))
                };
                task.planSource = data.source || task.planSource;
                break;
            case 'step_start':
                updateStep(task, event.stepId, { status: 'running', error: null });
                break;
            case 'step_complete':
                updateStep(task, event.stepId, { status: 'completed', error: null });
                break;
            case 'step_failed':
                updateStep(task, event.stepId, { status: 'failed', error: data.error || { message: event.message } });
                break;
            case 'approval':
                task.status = event.status || task.status;
                if (data.approval) task.approval = data.approval;
                else if (event.status === 'awaiting_approval') {
                    task.approval = {
                        status: 'pending',
                        stepId: event.stepId,
                        preview: data.step ? data.step.preview || null : null
                    };
                }
                break;
            case 'guidance':
                if (Array.isArray(data.guidance)) task.guidance = data.guidance;
                break;
            case 'warning':
                task.warnings = Array.isArray(task.warnings) ? task.warnings : [];
                if (task.warnings.indexOf(event.message) === -1) task.warnings.push(event.message);
                break;
            case 'result':
                task.status = 'completed';
                task.result = data.result || task.result;
                task.completedAt = event.at;
                break;
            case 'error':
                task.status = 'failed';
                task.error = data.error || { code: 'task_failed', message: event.message };
                task.completedAt = event.at;
                break;
            case 'cancel':
                task.status = 'cancelled';
                task.completedAt = event.at;
                break;
            default:
                break;
        }
        afterEvent(task, event);
    }

    function updateStep(task, stepId, patch) {
        if (!task.plan || !Array.isArray(task.plan.steps)) return;
        const step = task.plan.steps.find((item) => item.id === stepId);
        if (step) Object.assign(step, patch);
    }

    function afterEvent(task, event) {
        renderTask(task);
        if (isTerminalStatus(task.status)) {
            const source = state.sources.get(task.id);
            if (source) {
                try { source.close(); } catch {}
                state.sources.delete(task.id);
            }
            refreshTask(task.id);
        } else if (event.type === 'status' || event.status === 'awaiting_approval') {
            renderTask(task);
        }
    }

    function ensureStream(task) {
        if (!task || !task.id) return;
        if (!isActiveStatus(task.status)) return;
        if (state.sources.has(task.id)) return;
        if (typeof EventSource === 'undefined') return;
        const after = Number.isInteger(task._lastSeq) ? task._lastSeq : 0;
        const source = new EventSource('/api/agent/tasks/' + encodeURIComponent(task.id) + '/events?after=' + after);

        source.onopen = () => {
            if (state.sources.get(task.id) !== source) return;
            const current = state.tasks.get(task.id) || task;
            current._reconnecting = false;
            renderTask(current);
        };

        source.addEventListener('snapshot', (e) => {
            if (state.sources.get(task.id) !== source) return;
            let snapshot;
            try { snapshot = JSON.parse(e.data); } catch { return; }
            if (!snapshot || !snapshot.id) return;
            state.tasks.set(snapshot.id, Object.assign({}, state.tasks.get(snapshot.id) || {}, snapshot));
            const current = state.tasks.get(snapshot.id);
            current._reconnecting = false;
            if (Array.isArray(snapshot.events)) {
                current.events = snapshot.events.slice(-EVENT_LIMIT);
                current._lastSeq = Math.max(current._lastSeq || 0, maxSeq(current.events));
            }
            renderTask(current);
        });

        source.addEventListener('agent', (e) => {
            if (state.sources.get(task.id) !== source) return;
            let event;
            try { event = JSON.parse(e.data); } catch { return; }
            const current = state.tasks.get(task.id);
            if (current) current._reconnecting = false;
            applyEvent(task.id, event);
        });

        source.addEventListener('end', () => {
            if (state.sources.get(task.id) !== source) return;
            state.sources.delete(task.id);
            const current = state.tasks.get(task.id);
            if (current) current._reconnecting = false;
            try { source.close(); } catch {}
            refreshTask(task.id);
        });

        source.onerror = () => {
            if (state.sources.get(task.id) !== source) return;
            const taskState = state.tasks.get(task.id);
            if (!taskState || isTerminalStatus(taskState.status)) {
                try { source.close(); } catch {}
                state.sources.delete(task.id);
                return;
            }
            if (source.readyState === EventSource.CLOSED) {
                state.sources.delete(task.id);
                taskState._reconnecting = true;
                renderTask(taskState);
                setTimeout(() => {
                    if (state.conversationId === taskState.conversationId && isActiveStatus(taskState.status)) {
                        refreshTask(task.id);
                    }
                }, 2500);
            } else {
                taskState._reconnecting = true;
                renderTask(taskState);
            }
        };

        state.sources.set(task.id, source);
    }

    async function refreshTask(taskId) {
        try {
            const data = await api('GET', '/api/agent/tasks/' + encodeURIComponent(taskId));
            if (data.task) applySnapshot(data.task);
        } catch {
            /* keep the last known state */
        }
    }

    function tasksForConversation(conversationId) {
        return Array.from(state.tasks.values()).filter((task) => !conversationId || task.conversationId === conversationId);
    }

    return {
        init,
        isActive,
        setMode,
        adopt,
        hydrate,
        refreshTask,
        tasksForConversation,
        _debug: { state }
    };
})();

window.AgentUI = AgentUI;
