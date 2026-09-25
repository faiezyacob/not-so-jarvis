/* ============================================
   JARVIS — Character Identity Viewer
   The dedicated read-only view of a saved
   character's identity package: the ONE approved
   base image, the ONE consolidated Character
   Identity Sheet (a single composite image holding
   multiple reference panels), structured identity
   metadata, and regeneration / use controls.
   Reuses the shared modal + playground visual
   language; never invents a second system.
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

    const STATUS_LABELS = {
        candidate: 'Awaiting approval',
        approved: 'Approved \u2014 ready to create the identity sheet',
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

    function openImage(url) {
        if (url && window.Gallery && typeof window.Gallery.openFromUrl === 'function') {
            window.Gallery.openFromUrl(url);
        }
    }

    function imageFigure(url, label, className) {
        const figure = el('figure', className || 'identity-base');
        const img = el('img', (className || 'identity-base') + '-img');
        img.src = url;
        img.alt = label || 'Character';
        img.tabIndex = 0;
        img.setAttribute('role', 'button');
        img.addEventListener('click', () => openImage(url));
        img.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); img.click(); }
        });
        figure.appendChild(img);
        figure.appendChild(el('figcaption', 'identity-base-note', label || ''));
        return figure;
    }

    function renderMetadata(metadata) {
        const box = el('div', 'identity-metadata');
        const m = metadata || {};
        const rows = [];
        const face = m.face || {};
        const hair = m.hair || {};
        const skin = m.skin || {};
        const body = m.body || {};
        if (face.shape) rows.push(['Face', [face.shape, face.eyes].filter(Boolean).join(' \u00b7 ')]);
        if (face.nose) rows.push(['Nose', face.nose]);
        if (face.lips) rows.push(['Lips', face.lips]);
        const hairText = [hair.length, hair.style, hair.texture, hair.color].filter(Boolean).join(' \u00b7 ');
        if (hairText) rows.push(['Hair', hairText]);
        const skinText = [skin.tone || skin.baseTone, skin.undertone ? skin.undertone + ' undertone' : '', skin.complexion]
            .filter(Boolean).join(' \u00b7 ');
        if (skinText) rows.push(['Skin', skinText]);
        const bodyText = [body.heightDescription, body.build, body.proportions].filter(Boolean).join(' \u00b7 ');
        if (bodyText) rows.push(['Build', bodyText]);
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

    function renderProgress() {
        const box = el('div', 'identity-progress');
        box.setAttribute('role', 'status');
        box.appendChild(el('span', 'identity-progress-title', 'Creating Character Identity Sheet\u2026'));
        box.appendChild(el('span', 'identity-progress-sub', 'Rendering the consolidated reference sheet\u2026'));
        const bar = el('div', 'identity-progress-bar');
        const fill = el('div', 'identity-progress-fill identity-progress-fill--indeterminate');
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
            bodyEl.appendChild(renderProgress());
        }

        if (card.error) {
            bodyEl.appendChild(el('div', 'identity-error', card.error));
        }

        // Approved base image
        const baseSection = el('section', 'identity-section');
        baseSection.appendChild(el('h4', 'identity-section-title', 'Approved Character'));
        if (card.approvedBaseImage && card.approvedBaseImage.url) {
            baseSection.appendChild(imageFigure(
                card.approvedBaseImage.url,
                card.approvedBaseImage.approved ? 'Approved base image' : 'Candidate \u2014 awaiting approval',
                'identity-base'
            ));
        } else {
            baseSection.appendChild(el('div', 'identity-empty', 'No base image yet.'));
        }
        bodyEl.appendChild(baseSection);

        // The single consolidated identity sheet
        const sheetSection = el('section', 'identity-section');
        sheetSection.appendChild(el('h4', 'identity-section-title', 'Character Identity Sheet'));
        if (card.identitySheet && card.identitySheet.url) {
            sheetSection.appendChild(imageFigure(
                card.identitySheet.url,
                'Composite reference sheet \u00b7 v' + (card.identitySheet.version || 1) +
                (card.identitySheet.status === 'ready' ? '' : ' \u00b7 ' + card.identitySheet.status),
                'identity-sheet'
            ));
            sheetSection.appendChild(el('p', 'identity-sheet-note',
                'One image containing the full-body front, three-quarter, side profile, face close-up and any ' +
                'necessary detail panels. This single sheet is the character\'s visual identity reference.'));
        } else {
            sheetSection.appendChild(el('div', 'identity-empty',
                card.status === 'generating_identity'
                    ? 'The identity sheet is being generated\u2026'
                    : 'No identity sheet yet. Approve the character, then create its sheet.'));
        }
        bodyEl.appendChild(sheetSection);

        // Metadata
        const meta = renderMetadata(card.identityMetadata);
        if (meta) {
            const section = el('section', 'identity-section');
            section.appendChild(el('h4', 'identity-section-title', 'Identity Metadata'));
            section.appendChild(meta);
            bodyEl.appendChild(section);
        }

        if (card.identityPreservationInstructions) {
            const section = el('section', 'identity-section');
            section.appendChild(el('h4', 'identity-section-title', 'Identity Preservation'));
            section.appendChild(el('p', 'identity-preservation', card.identityPreservationInstructions));
            bodyEl.appendChild(section);
        }
    }

    // The viewer is read-only: no footer actions. Character actions live on the
    // Creative Playground card / chat.
    function renderFooter() {
        if (!footerEl) return;
        footerEl.innerHTML = '';
        footerEl.style.display = 'none';
    }

    function showError(message) {
        if (!bodyEl) return;
        const err = el('div', 'identity-error', message);
        bodyEl.insertBefore(err, bodyEl.firstChild);
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

    async function load(id) {
        if (!bodyEl) return;
        try {
            const res = await fetch('/api/characters/' + encodeURIComponent(id) + '/identity');
            if (!res.ok) {
                showError('That character could not be found.');
                return;
            }
            const data = await res.json();
            currentCard = data.card;
            if (titleEl) titleEl.textContent = (data.card && data.card.name ? data.card.name : 'Character') + ' \u2014 Identity';
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
        if (footerEl) footerEl.style.display = 'none';
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
