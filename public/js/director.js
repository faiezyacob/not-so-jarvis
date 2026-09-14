/* ============================================
   JARVIS — Director UI
   Renders the Director approval checkpoint
   inside a chat message and wires its actions
   (Approve / Regenerate / Modify / Cancel) back
   through the normal chat stream. The persisted
   message carries a [[director:{...}]] marker
   that this module turns into the interactive
   card, so it survives reloads.
   ============================================ */

const DirectorUI = (() => {
    const MARKER_RE = /\[\[director:(\{[^\n]*?\})\]\]/g;

    // Inline stroke icons matching the rest of the dashboard (24x24 viewBox,
    // currentColor, round caps).
    const ICONS = {
        film: '<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1-.3 2.2.3 2.5 1.3Z"></path><path d="m6.2 5.3 3.1 3.9"></path><path d="m12.4 3.4 3.1 4"></path><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path><path d="m8 11 3 4"></path><path d="m14 11 3 4"></path>',
        check: '<polyline points="20 6 9 17 4 12"></polyline>',
        refresh: '<polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>',
        pencil: '<path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>',
        zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>',
        x: '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>'
    };

    function iconSvg(name, size) {
        const inner = ICONS[name] || '';
        return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            inner + '</svg>';
    }

    const BUTTONS = {
        awaiting_mode_choice: [
            { type: 'choose_director', label: 'Director Mode', icon: 'film', variant: 'primary' },
            { type: 'choose_direct', label: 'Generate Directly', icon: 'zap', variant: '' },
            { type: 'cancel', label: 'Cancel', icon: 'x', variant: 'danger' }
        ],
        awaiting_image_approval: [
            { type: 'approve', label: 'Approve & Generate', icon: 'check', variant: 'primary' },
            { type: 'regenerate_image', label: 'Regenerate', icon: 'refresh', variant: '' },
            { type: 'modify_direction', label: 'Modify Direction', icon: 'pencil', variant: '' },
            { type: 'cancel', label: 'Cancel', icon: 'x', variant: 'danger' }
        ],
        failed_image: [
            { type: 'regenerate_image', label: 'Retry Frame', icon: 'refresh', variant: 'primary' },
            { type: 'modify_direction', label: 'Modify Direction', icon: 'pencil', variant: '' },
            { type: 'cancel', label: 'Cancel', icon: 'x', variant: 'danger' }
        ],
        failed_video: [
            { type: 'approve', label: 'Retry Video', icon: 'refresh', variant: 'primary' },
            { type: 'cancel', label: 'Cancel', icon: 'x', variant: 'danger' }
        ]
    };

    function stageLabel(status) {
        switch (status) {
            case 'awaiting_mode_choice': return 'Choose a workflow';
            case 'generating_image': return 'Creating opening frame\u2026';
            case 'awaiting_image_approval': return 'Awaiting your approval';
            case 'generating_video': return 'Creating video\u2026';
            case 'completed': return 'Video complete';
            case 'failed_image': return 'Opening frame failed';
            case 'failed_video': return 'Video failed';
            case 'cancelled': return 'Production cancelled';
            default: return 'Director';
        }
    }

    // Pull [[director:{...}]] markers out of persisted markdown. Returns the
    // cleaned markdown plus the parsed card payloads, in order.
    function extract(markdown) {
        const cards = [];
        const text = String(markdown === undefined || markdown === null ? '' : markdown)
            .replace(MARKER_RE, (match, json) => {
                try {
                    const data = JSON.parse(json);
                    if (data && data.id) cards.push(data);
                } catch (e) {
                    // ignore malformed markers
                }
                return '';
            });
        return { text, cards };
    }

    function strip(markdown) {
        return extract(markdown).text;
    }

    function render(contentEl, card) {
        const el = document.createElement('div');
        el.className = 'director-card director-card--' + (card.status || 'unknown');
        el.setAttribute('data-production-id', card.id);
        el.setAttribute('data-status', card.status || '');

        const head = document.createElement('div');
        head.className = 'director-card-head';

        const icon = document.createElement('span');
        icon.className = 'director-card-icon';
        icon.innerHTML = iconSvg('film', 15);

        const title = document.createElement('span');
        title.className = 'director-card-title';
        title.textContent = 'Director';

        const stage = document.createElement('span');
        stage.className = 'director-card-stage';
        stage.textContent = stageLabel(card.status);

        head.appendChild(icon);
        head.appendChild(title);
        head.appendChild(stage);
        el.appendChild(head);

        const buttons = BUTTONS[card.status] || [];
        if (buttons.length) {
            const actions = document.createElement('div');
            actions.className = 'director-card-actions';
            buttons.forEach((spec) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'director-btn' +
                    (spec.variant ? ' director-btn--' + spec.variant : '');
                btn.innerHTML = iconSvg(spec.icon, 14) +
                    '<span class="director-btn-label">' + spec.label + '</span>';
                btn.addEventListener('click', () => onAction(btn, card.id, spec.type));
                actions.appendChild(btn);
            });
            el.appendChild(actions);
        }

        contentEl.appendChild(el);
    }

    function onAction(button, productionId, type) {
        const card = button.closest('.director-card');
        if (type === 'modify_direction') {
            Dialog.prompt({
                title: 'Modify Direction',
                message: 'Describe how the opening frame should change.',
                placeholder: 'e.g. Make her look more elegant and move the camera further away.',
                confirmText: 'Regenerate'
            }).then((text) => {
                const feedback = String(text === null || text === undefined ? '' : text).trim();
                if (!feedback) return;
                lock(card);
                send(feedback, { type: 'modify_direction', productionId, direction: feedback });
            });
            return;
        }
        lock(card);
        const labels = {
            approve: 'Approve & generate video',
            regenerate_image: 'Regenerate the opening frame',
            choose_direct: 'Generate the video directly',
            choose_director: 'Use Director mode',
            cancel: 'Cancel the production'
        };
        send(labels[type] || type, { type, productionId });
    }

    function send(text, directorAction) {
        // `Chat` is a top-level `const`, so it is a global lexical binding, not
        // a window property — reference it bare like voice-input.js does.
        if (typeof Chat !== 'undefined' && Chat && typeof Chat.sendMessage === 'function') {
            Chat.sendMessage({ text, directorAction });
        }
    }

    function lock(card) {
        if (!card) return;
        card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    }

    // Restore interactivity from the server's current production. Only the card
    // whose production is still actionable keeps working buttons; every other
    // card (stale, completed, cancelled) becomes a static record.
    function applyState(container, production) {
        if (!container) return;
        const actionable = Boolean(production && (
            production.status === 'awaiting_mode_choice' ||
            production.status === 'awaiting_image_approval' ||
            production.status === 'failed_image' ||
            production.status === 'failed_video'
        ));
        container.querySelectorAll('.director-card').forEach((el) => {
            const matches = actionable && el.getAttribute('data-production-id') === production.id;
            el.classList.toggle('director-card--static', !matches);
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
            const res = await fetch('/api/director/state?conversationId=' + encodeURIComponent(conversationId));
            const data = await res.json();
            applyState(container, data.production || null);
        } catch (e) {
            applyState(container, null);
        }
    }

    return { extract, strip, render, applyState, hydrate, stageLabel };
})();

window.DirectorUI = DirectorUI;
