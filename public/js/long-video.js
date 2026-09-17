/* ============================================
   JARVIS — Long Video Director UI
   Renders the >15s storyboard approval card
   (planned beats + stage progress) inside a chat
   message and wires its actions back through the
   normal chat stream. The persisted message
   carries a [[longvideo:{...}]] marker, so the
   card survives reloads.
   ============================================ */

const LongVideoUI = (() => {
    const MARKER_RE = /\[\[longvideo:(\{[^\n]*?\})\]\]/g;

    const ICONS = {
        film: '<rect x="2" y="3" width="20" height="18" rx="2"></rect><line x1="7" y1="3" x2="7" y2="21"></line><line x1="17" y1="3" x2="17" y2="21"></line><line x1="2" y1="9" x2="22" y2="9"></line><line x1="2" y1="15" x2="22" y2="15"></line>',
        check: '<polyline points="20 6 9 17 4 12"></polyline>',
        play: '<polygon points="6 3 20 12 6 21 6 3"></polygon>',
        pencil: '<path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>',
        refresh: '<polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>',
        x: '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>'
    };

    function iconSvg(name, size) {
        return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            (ICONS[name] || '') + '</svg>';
    }

    const STAGE_LABELS = {
        planning: 'Planning',
        storyboard: 'Storyboard approved',
        preparing: 'Preparing H3 LongVideos',
        generating: 'Generating sequence',
        finalizing: 'Finalizing'
    };

    const BUTTONS = {
        awaiting_storyboard_approval: [
            { type: 'approve', label: 'Generate Video', icon: 'play', variant: 'primary' },
            { type: 'modify_plan', label: 'Modify Plan', icon: 'pencil', variant: '' },
            { type: 'cancel', label: 'Cancel', icon: 'x', variant: 'danger' }
        ],
        generating_long_video: [
            { type: 'cancel', label: 'Cancel', icon: 'x', variant: 'danger' }
        ],
        failed_long_video: [
            { type: 'retry', label: 'Retry', icon: 'refresh', variant: 'primary' },
            { type: 'modify_plan', label: 'Modify Plan', icon: 'pencil', variant: '' },
            { type: 'cancel', label: 'Cancel', icon: 'x', variant: 'danger' }
        ]
    };

    function stageLabel(status) {
        switch (status) {
            case 'awaiting_storyboard_approval': return 'Storyboard ready';
            case 'generating_long_video': return 'Rendering long video\u2026';
            case 'completed': return 'Long video complete';
            case 'failed_long_video': return 'Long video failed';
            case 'cancelled': return 'Long video cancelled';
            default: return 'Long Video Director';
        }
    }

    function extract(markdown) {
        const cards = [];
        const text = String(markdown === undefined || markdown === null ? '' : markdown)
            .replace(MARKER_RE, (match, json) => {
                try {
                    const data = JSON.parse(json);
                    if (data && data.id) cards.push(data);
                } catch (e) { /* ignore malformed markers */ }
                return '';
            });
        return { text, cards };
    }

    function strip(markdown) {
        return extract(markdown).text;
    }

    function beatList(card) {
        const beats = Array.isArray(card.beats) ? card.beats : [];
        const wrap = document.createElement('ol');
        wrap.className = 'longvideo-beats';
        beats.forEach((beat, index) => {
            const li = document.createElement('li');
            li.className = 'longvideo-beat';

            const head = document.createElement('div');
            head.className = 'longvideo-beat-head';

            const num = document.createElement('span');
            num.className = 'longvideo-beat-num';
            num.textContent = String(index + 1).padStart(2, '0');

            const dur = document.createElement('span');
            dur.className = 'longvideo-beat-dur';
            dur.textContent = beat.duration + 's';

            head.appendChild(num);
            head.appendChild(dur);

            const action = document.createElement('p');
            action.className = 'longvideo-beat-action';
            action.textContent = String(beat.action || beat.purpose || 'Continues the sequence.').trim();

            li.appendChild(head);
            li.appendChild(action);

            // Motion continuity cue: how this beat opens relative to the previous
            // one (continues the established motion, or a deliberate hard cut).
            if (index > 0) {
                const cue = document.createElement('p');
                if (beat.mode === 'abrupt_transition') {
                    cue.className = 'longvideo-beat-cont longvideo-beat-cont--cut';
                    cue.textContent = 'hard cut from the previous beat';
                } else if (beat.continuation) {
                    cue.className = 'longvideo-beat-cont';
                    const text = String(beat.continuation).trim();
                    cue.textContent = 'continues: ' + (text.length > 140 ? text.slice(0, 137) + '\u2026' : text);
                }
                if (cue.className) li.appendChild(cue);
            }

            wrap.appendChild(li);
        });
        return wrap;
    }

    function stageList(card) {
        const stages = Array.isArray(card.stages) ? card.stages : [];
        const wrap = document.createElement('div');
        wrap.className = 'longvideo-stages';
        stages.forEach((stage) => {
            const row = document.createElement('div');
            row.className = 'longvideo-stage longvideo-stage--' + (stage.status || 'pending');
            const marker = document.createElement('span');
            marker.className = 'longvideo-stage-mark';
            marker.textContent = stage.status === 'completed' ? '\u2713'
                : stage.status === 'running' ? '\u25cf' : '\u25cb';
            const label = document.createElement('span');
            label.className = 'longvideo-stage-label';
            label.textContent = STAGE_LABELS[stage.id] || stage.id;
            row.appendChild(marker);
            row.appendChild(label);
            wrap.appendChild(row);
        });
        return wrap;
    }

    function render(contentEl, card) {
        const el = document.createElement('div');
        el.className = 'longvideo-card longvideo-card--' + (card.status || 'unknown');
        el.setAttribute('data-plan-id', card.id);
        el.setAttribute('data-status', card.status || '');

        const head = document.createElement('div');
        head.className = 'longvideo-card-head';

        const icon = document.createElement('span');
        icon.className = 'longvideo-card-icon';
        icon.innerHTML = iconSvg('film', 15);

        const title = document.createElement('span');
        title.className = 'longvideo-card-title';
        title.textContent = 'Long Video Director';

        const stage = document.createElement('span');
        stage.className = 'longvideo-card-stage';
        const shots = Number(card.shots);
        stage.textContent = stageLabel(card.status) +
            (Number.isFinite(shots) && shots > 0 ? ' \u00b7 ' + shots + ' beats' : '') +
            (card.duration ? ' \u00b7 ' + card.duration + 's' : '');

        head.appendChild(icon);
        head.appendChild(title);
        head.appendChild(stage);
        el.appendChild(head);

        if (Array.isArray(card.beats) && card.beats.length) {
            el.appendChild(beatList(card));
        }
        if (Array.isArray(card.stages) && card.stages.length) {
            el.appendChild(stageList(card));
        }

        const buttons = BUTTONS[card.status] || [];
        if (buttons.length) {
            const actions = document.createElement('div');
            actions.className = 'longvideo-card-actions';
            buttons.forEach((spec) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'longvideo-btn' +
                    (spec.variant ? ' longvideo-btn--' + spec.variant : '');
                btn.innerHTML = iconSvg(spec.icon, 14) +
                    '<span class="longvideo-btn-label">' + spec.label + '</span>';
                btn.addEventListener('click', () => onAction(btn, card.id, spec.type));
                actions.appendChild(btn);
            });
            el.appendChild(actions);
        }

        contentEl.appendChild(el);
    }

    function onAction(button, planId, type) {
        const card = button.closest('.longvideo-card');
        if (type === 'modify_plan') {
            Dialog.prompt({
                title: 'Modify Plan',
                message: 'Describe how the storyboard should change.',
                placeholder: 'e.g. Make the final scene rainy, or make her wear a red kimono.',
                confirmText: 'Update Plan'
            }).then((text) => {
                const feedback = String(text === null || text === undefined ? '' : text).trim();
                if (!feedback) return;
                lock(card);
                send(feedback, { type: 'modify_plan', planId, direction: feedback });
            });
            return;
        }
        lock(card);
        const labels = {
            approve: 'Generate the long video',
            retry: 'Retry the long video',
            cancel: 'Cancel the long video'
        };
        send(labels[type] || type, { type, planId });
    }

    function send(text, longVideoAction) {
        if (typeof Chat !== 'undefined' && Chat && typeof Chat.sendMessage === 'function') {
            Chat.sendMessage({ text, longVideoAction });
        }
    }

    function lock(card) {
        if (!card) return;
        card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    }

    function applyState(container, plan) {
        if (!container) return;
        const actionable = Boolean(plan && (
            plan.status === 'awaiting_storyboard_approval' ||
            plan.status === 'failed_long_video' ||
            plan.status === 'generating_long_video'
        ));
        container.querySelectorAll('.longvideo-card').forEach((el) => {
            const matches = actionable && el.getAttribute('data-plan-id') === plan.id;
            el.classList.toggle('longvideo-card--static', !matches);
            el.querySelectorAll('button').forEach((b) => { b.disabled = !matches; });
        });
    }

    async function hydrate(container, conversationId) {
        if (!container) return;
        if (!conversationId) {
            applyState(container, null);
            return;
        }
        try {
            const res = await fetch('/api/longvideo/state?conversationId=' + encodeURIComponent(conversationId));
            const data = await res.json();
            applyState(container, data.plan || null);
        } catch (e) {
            applyState(container, null);
        }
    }

    return { extract, strip, render, applyState, hydrate, stageLabel };
})();

window.LongVideoUI = LongVideoUI;
