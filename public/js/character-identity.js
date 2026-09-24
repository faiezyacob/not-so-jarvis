/* ============================================
   JARVIS — Character Identity Viewer
   The dedicated read-only view of a saved
   character's identity package: approved base
   image, identity-sheet status and progress, the
   full-body / face / accessory reference categories,
   the derived identity metadata, and regeneration
   controls. Reuses the shared modal + playground
   visual language; never invents a second system.
   ============================================ */

const CharacterIdentityUI = (() => {
    let overlay = null;
    let bodyEl = null;
    let footerEl = null;
    let titleEl = null;
    let closeEl = null;

    let currentId = null;
    let currentCard = null;
    let pollTimer = null;

    const CATEGORY_LABELS = [
        { key: 'fullBody', title: 'Full-Body References' },
        { key: 'face', title: 'Face References' },
        { key: 'profile', title: 'Profile References' },
        { key: 'accessories', title: 'Accessories' },
        { key: 'distinctiveFeatures', title: 'Distinctive Features' }
    ];

    const STATUS_LABELS = {
        candidate: 'Awaiting approval',
        approved: 'Approved — generating references',
        generating_identity: 'Creating identity sheet',
        ready: 'Identity Ready',
        failed: 'Identity sheet failed'
    };

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function iconSvg(paths, size) {
        return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
    }

    const REFRESH_ICON = '<polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>';

    function openImage(url) {
        if (window.Gallery && typeof window.Gallery.openFromUrl === 'function') {
            window.Gallery.openFromUrl(url);
        }
    }

    function referenceTile(ref) {
        const tile = el('figure', 'identity-ref');
        const img = el('img', 'identity-ref-img');
        img.src = ref.url;
        img.alt = ref.label || ref.role;
        img.loading = 'lazy';
        img.tabIndex = 0;
        img.setAttribute('role', 'button');
        img.addEventListener('click', () => openImage(ref.url));
        img.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); img.click(); }
        });
        tile.appendChild(img);
        const cap = el('figcaption', 'identity-ref-label', ref.label || ref.role);
        tile.appendChild(cap);
        return tile;
    }

    function renderMetadata(metadata) {
        const box = el('div', 'identity-metadata');
        const m = metadata || {};
        const rows = [];
        if (m.ageRange) rows.push(['Age', m.ageRange]);
        if (m.genderPresentation) rows.push(['Gender presentation', m.genderPresentation]);
        if (m.skinTone) rows.push(['Skin tone', m.skinTone]);
        if (m.faceShape) rows.push(['Face shape', m.faceShape]);
        if (m.eyeColor) rows.push(['Eyes', m.eyeColor]);
        const hair = m.hair || {};
        const hairText = [hair.length, hair.style, hair.color].filter(Boolean).join(' · ');
        if (hairText) rows.push(['Hair', hairText]);
        if (m.bodyProportions) rows.push(['Build', m.bodyProportions]);
        if (m.distinctiveFeatures && m.distinctiveFeatures.length) rows.push(['Distinctive features', m.distinctiveFeatures.join(', ')]);
        if (m.signatureAccessories && m.signatureAccessories.length) rows.push(['Signature accessories', m.signatureAccessories.join(', ')]);
        if (!rows.length) return null;
        rows.forEach(([label, value]) => {
            const row = el('div', 'identity-meta-row');
            row.appendChild(el('span', 'identity-meta-label', label));
            row.appendChild(el('span', 'identity-meta-value', value));
            box.appendChild(row);
        });
        return box;
    }

    function renderProgress(card) {
        const box = el('div', 'identity-progress');
        const total = (card.progress && card.progress.total) || card.requiredTotal || 0;
        const done = (card.progress && card.progress.done) || 0;
        box.appendChild(el('span', 'identity-progress-title', 'Creating Character Identity Sheet…'));
        box.appendChild(el('span', 'identity-progress-sub',
            'Generating multiple reference images' + (total ? ' (' + done + '/' + total + ')' : '') + '…'));
        const bar = el('div', 'identity-progress-bar');
        const fill = el('div', 'identity-progress-fill');
        fill.style.width = (total ? Math.round((done / total) * 100) : 4) + '%';
        bar.appendChild(fill);
        box.appendChild(bar);
        return box;
    }

    function renderBody(card) {
        bodyEl.innerHTML = '';
        const status = el('div', 'identity-status identity-status--' + (card.status || ''));
        status.appendChild(el('span', 'identity-dot identity-dot--' + (card.status === 'ready' ? 'ready' : (card.status === 'failed' ? 'failed' : 'pending'))));
        status.appendChild(el('span', 'identity-status-label', STATUS_LABELS[card.status] || card.status || ''));
        if (card.createdAt) {
            status.appendChild(el('span', 'identity-status-meta', 'Created ' + new Date(card.createdAt).toLocaleDateString()));
        }
        bodyEl.appendChild(status);

        if (card.status === 'generating_identity') {
            bodyEl.appendChild(renderProgress(card));
        }

        if (card.error) {
            const err = el('div', 'identity-error');
            err.textContent = card.error;
            bodyEl.appendChild(err);
        }

        // Approved base image
        const baseSection = el('section', 'identity-section');
        baseSection.appendChild(el('h4', 'identity-section-title', 'Approved Base Image'));
        if (card.baseImage && card.baseImage.url) {
            const wrap = el('figure', 'identity-base');
            const img = el('img', 'identity-base-img');
            img.src = card.baseImage.url;
            img.alt = (card.name || 'Character') + ' — approved base image';
            img.tabIndex = 0;
            img.setAttribute('role', 'button');
            img.addEventListener('click', () => openImage(card.baseImage.url));
            img.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); img.click(); }
            });
            wrap.appendChild(img);
            if (!card.baseImage.approved) {
                wrap.appendChild(el('figcaption', 'identity-base-note',
                    card.hasLegacyBase ? 'Basic Reference (legacy character image)' : 'Approved base image'));
            } else {
                wrap.appendChild(el('figcaption', 'identity-base-note', 'Locked as the approved base image'));
            }
            baseSection.appendChild(wrap);
        } else {
            baseSection.appendChild(el('div', 'identity-empty', 'No base image yet.'));
        }
        bodyEl.appendChild(baseSection);

        // Reference categories
        const cats = card.categories || {};
        CATEGORY_LABELS.forEach(({ key, title }) => {
            const refs = Array.isArray(cats[key]) ? cats[key] : [];
            if (!refs.length) return;
            const section = el('section', 'identity-section');
            section.appendChild(el('h4', 'identity-section-title', title));
            const grid = el('div', 'identity-ref-grid');
            refs.forEach((ref) => grid.appendChild(referenceTile(ref)));
            section.appendChild(grid);
            bodyEl.appendChild(section);
        });

        const totalRefs = Number(card.referenceCount) || 0;
        if (!totalRefs && card.status !== 'generating_identity') {
            bodyEl.appendChild(el('div', 'identity-empty',
                card.hasLegacyBase
                    ? 'No identity sheet yet. An identity sheet can be generated from the existing character image.'
                    : 'No identity sheet yet. Generate one to create consistent character references.'));
        }

        // Metadata
        const meta = renderMetadata(card.metadata);
        if (meta) {
            const section = el('section', 'identity-section');
            section.appendChild(el('h4', 'identity-section-title', 'Identity Metadata'));
            section.appendChild(meta);
            bodyEl.appendChild(section);
        }

        if (card.consistencyNotes && card.consistencyNotes.length) {
            const section = el('section', 'identity-section');
            section.appendChild(el('h4', 'identity-section-title', 'Consistency Notes'));
            const notes = el('ul', 'identity-notes');
            card.consistencyNotes.forEach((note) => notes.appendChild(el('li', null, note)));
            section.appendChild(notes);
            bodyEl.appendChild(section);
        }
    }

    function renderFooter(card) {
        footerEl.innerHTML = '';
        const busy = card.status === 'generating_identity';
        if (!busy) {
            const regen = el('button', 'modal-btn modal-btn-primary identity-sheet-regenerate');
            regen.type = 'button';
            regen.innerHTML = iconSvg(REFRESH_ICON, 14) + '<span> Regenerate Identity Sheet</span>';
            regen.addEventListener('click', regenerateSheet);
            footerEl.appendChild(regen);
        } else {
            footerEl.appendChild(el('span', 'identity-footer-note', 'Generation is running — this view updates automatically.'));
        }
        if (card.referenceCount) {
            const del = el('button', 'modal-btn modal-btn-danger');
            del.type = 'button';
            del.textContent = 'Delete Identity Sheet';
            del.addEventListener('click', deleteSheet);
            footerEl.appendChild(del);
        }
    }

    async function regenerateSheet() {
        if (!currentId) return;
        let confirmed = true;
        if (typeof Dialog !== 'undefined' && Dialog.confirm) {
            confirmed = await Dialog.confirm({
                title: 'Regenerate Identity Sheet',
                message: "Regenerate this character's identity sheet? The approved base image will remain unchanged, and the current sheet is kept until the new one is ready.",
                confirmText: 'Regenerate'
            });
        }
        if (!confirmed) return;
        setBusy('Regenerating identity sheet…');
        try {
            const res = await fetch('/api/characters/' + encodeURIComponent(currentId) + '/identity/sheet', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: providerName(), model: modelName() })
            });
            await consumeStream(res);
        } catch (e) {
            showError('Could not start identity-sheet generation. Please try again.');
        }
    }

    async function deleteSheet() {
        if (!currentId) return;
        let confirmed = true;
        if (typeof Dialog !== 'undefined' && Dialog.confirm) {
            confirmed = await Dialog.confirm({
                title: 'Delete Identity Sheet',
                message: 'Delete this character\'s identity references? The character and its base image stay saved.',
                confirmText: 'Delete',
                danger: true
            });
        }
        if (!confirmed) return;
        try {
            await fetch('/api/characters/' + encodeURIComponent(currentId) + '/identity', { method: 'DELETE' });
            await load(currentId);
        } catch (e) {
            showError('Could not delete the identity sheet.');
        }
    }

    function setBusy(message) {
        if (!footerEl) return;
        footerEl.innerHTML = '';
        footerEl.appendChild(el('span', 'identity-footer-note', message || 'Working…'));
    }

    function showError(message) {
        if (!bodyEl) return;
        const err = el('div', 'identity-error', message);
        bodyEl.insertBefore(err, bodyEl.firstChild);
    }

    // Read the standalone identity-sheet SSE stream (the same shape the chat
    // stream uses) and refresh the view as progress arrives.
    async function consumeStream(res) {
        if (!res.ok || !res.body) {
            showError('Identity-sheet generation failed to start.');
            return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let card = null;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                let data;
                try { data = JSON.parse(line.slice(6)); } catch (e) { continue; }
                if (data.error) { showError(data.error); }
                if (data.identityProgress) {
                    if (currentCard) {
                        currentCard.status = 'generating_identity';
                        currentCard.identityStatus = data.identityProgress.status;
                        currentCard.progress = {
                            done: data.identityProgress.done,
                            total: data.identityProgress.total,
                            current: data.identityProgress.current
                        };
                        renderBody(currentCard);
                    }
                }
                if (data.identity && data.identity.card) card = data.identity.card;
            }
        }
        if (card) {
            currentCard = card;
            renderBody(card);
            renderFooter(card);
            refreshPlaygroundCards();
        } else {
            await load(currentId);
        }
    }

    // Refresh the persisted concept cards so the identity panel status follows
    // the viewer without a reload.
    function refreshPlaygroundCards() {
        const container = document.getElementById('chatMessages');
        const conversationId = (typeof Conversations !== 'undefined' && Conversations.currentId)
            ? Conversations.currentId()
            : '';
        if (container && conversationId && window.PlaygroundUI && typeof window.PlaygroundUI.hydrate === 'function') {
            window.PlaygroundUI.hydrate(container, conversationId);
        }
    }

    function providerName() {
        try { return typeof getChatProvider === 'function' ? getChatProvider() : 'ollama'; } catch (e) { return 'ollama'; }
    }
    function modelName() {
        try { return typeof getChatModel === 'function' ? getChatModel() : ''; } catch (e) { return ''; }
    }

    async function load(id) {
        if (!bodyEl) return;
        setBusy('Loading identity…');
        try {
            const res = await fetch('/api/characters/' + encodeURIComponent(id) + '/identity');
            if (!res.ok) {
                showError('That character could not be found.');
                return;
            }
            const data = await res.json();
            currentCard = data.card;
            if (titleEl) titleEl.textContent = (data.card && data.card.name ? data.card.name : 'Character') + ' — Identity';
            renderBody(currentCard);
            renderFooter(currentCard);
            schedulePoll();
        } catch (e) {
            showError('Could not load this character identity.');
        }
    }

    // Poll while a sheet is generating so progress survives a missed stream.
    function schedulePoll() {
        clearTimeout(pollTimer);
        if (!currentCard || currentCard.status !== 'generating_identity') return;
        pollTimer = setTimeout(async () => {
            try {
                const res = await fetch('/api/characters/' + encodeURIComponent(currentId) + '/identity');
                if (res.ok) {
                    const data = await res.json();
                    currentCard = data.card;
                    renderBody(currentCard);
                    renderFooter(currentCard);
                    if (currentCard.status === 'generating_identity') schedulePoll();
                    else refreshPlaygroundCards();
                }
            } catch (e) { /* keep polling on transient failures */ }
            if (currentCard && currentCard.status === 'generating_identity') schedulePoll();
        }, 4000);
    }

    function open(characterId) {
        if (!overlay || !characterId) return;
        currentId = characterId;
        overlay.classList.add('open');
        load(characterId);
    }

    function close() {
        if (!overlay) return;
        overlay.classList.remove('open');
        clearTimeout(pollTimer);
        currentId = null;
        currentCard = null;
    }

    // Called by chat.js when an identityProgress/identity event arrives while
    // the viewer is open for that character.
    function onProgress(progress) {
        if (!overlay || !overlay.classList.contains('open')) return;
        if (!currentId || progress.characterId !== currentId) return;
        if (currentCard) {
            currentCard.status = 'generating_identity';
            currentCard.identityStatus = progress.status;
            currentCard.progress = { done: progress.done, total: progress.total, current: progress.current };
            renderBody(currentCard);
        }
    }

    function onCard(card) {
        if (!overlay || !overlay.classList.contains('open')) return;
        if (!card || card.characterId !== currentId) return;
        currentCard = card;
        renderBody(card);
        renderFooter(card);
        refreshPlaygroundCards();
    }

    function init() {
        overlay = document.getElementById('identityOverlay');
        bodyEl = document.getElementById('identityModalBody');
        footerEl = document.getElementById('identityModalFooter');
        titleEl = document.getElementById('identityModalTitle');
        closeEl = document.getElementById('identityModalClose');
        if (!overlay) return;
        if (closeEl) closeEl.addEventListener('click', close);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (overlay.classList.contains('open')) close();
        });
    }

    return { init, open, close, onProgress, onCard };
})();

window.CharacterIdentityUI = CharacterIdentityUI;
