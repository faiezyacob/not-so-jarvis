/* ============================================
   JARVIS — Replacement confirmation card
   When a @video character-replacement request
   supplies more than one identity image without an
   explicit order, the server shows the assumed
   mapping in this inline card so the user can
   confirm (or reverse) it in one click instead of
   retyping the instruction.
   The card is carried by a persisted
   [[replacement:{...}]] marker; on reload it is
   re-rendered from the message content.
   ============================================ */

const ReplacementUI = (() => {
    const MARKER_RE = /\[\[replacement:(\{[\s\S]*?\})\]\]/;

    function extract(text) {
        const source = String(text || '');
        const match = source.match(MARKER_RE);
        if (!match) return { text: source, cards: [] };
        let card = null;
        try { card = JSON.parse(match[1]); } catch (err) { card = null; }
        const clean = source.replace(MARKER_RE, '').replace(/\n{3,}/g, '\n\n').trim();
        return { text: clean, cards: card ? [card] : [] };
    }

    function strip(text) {
        return extract(text).text;
    }

    function sendAction(type, card) {
        if (typeof Chat === 'undefined' || !Chat || typeof Chat.sendMessage !== 'function') return;
        const text = type === 'confirm' ? 'Create the replacement video'
            : type === 'reverse' ? 'Reverse the replacement order'
                : 'Cancel the replacement';
        Chat.sendMessage({ text, replacementAction: { type, plan: card } });
    }

    function makeButton(label, actionId, onClick) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chat-suggestion asset-action replacement-action';
        btn.setAttribute('data-replacement-action', actionId);
        const text = document.createElement('span');
        text.className = 'chat-suggestion-label';
        text.textContent = label;
        btn.appendChild(text);
        btn.addEventListener('click', onClick);
        return btn;
    }

    function render(contentEl, card) {
        if (!contentEl || !card) return;
        const wrap = document.createElement('div');
        wrap.className = 'replacement-card';

        const head = document.createElement('div');
        head.className = 'replacement-head';
        head.textContent = 'Confirm replacement';
        wrap.appendChild(head);

        const media = document.createElement('div');
        media.className = 'replacement-media';
        if (card.sourceVideo && card.sourceVideo.url) {
            const fig = document.createElement('figure');
            fig.className = 'replacement-figure replacement-figure--source';
            const video = document.createElement('video');
            video.className = 'replacement-thumb';
            video.src = card.sourceVideo.url;
            if (card.sourceVideo.origin === 'generated' && card.sourceVideo.filename) {
                video.poster = '/generated/thumb/' + encodeURIComponent(card.sourceVideo.filename);
            }
            video.muted = true;
            video.playsInline = true;
            video.preload = 'metadata';
            const cap = document.createElement('figcaption');
            cap.textContent = 'Source video';
            fig.appendChild(video);
            fig.appendChild(cap);
            media.appendChild(fig);
        }
        const targets = Array.isArray(card.targets) ? card.targets : [];
        (card.replacements || []).forEach((ref, i) => {
            const fig = document.createElement('figure');
            fig.className = 'replacement-figure';
            const img = document.createElement('img');
            img.className = 'replacement-thumb';
            img.src = ref.url;
            img.alt = 'Replacement image ' + (i + 1);
            const cap = document.createElement('figcaption');
            const target = targets[i];
            const label = target && target.description
                ? target.description
                : 'Person ' + (target && target.referenceIndex ? target.referenceIndex : (i + 1));
            cap.textContent = '→ ' + label;
            fig.appendChild(img);
            fig.appendChild(cap);
            media.appendChild(fig);
        });
        wrap.appendChild(media);

        const note = document.createElement('div');
        note.className = 'replacement-note';
        if (targets.length) {
            note.textContent = targets.map((t, i) =>
                (t.description || ('Person ' + (i + 1))) + ' → image ' + (t.referenceIndex || (i + 1))).join('  ·  ');
        } else {
            note.textContent = 'Image 1 replaces the first person, image 2 the second, and so on.';
        }
        wrap.appendChild(note);

        if (card.countAdjusted && Array.isArray(card.ignoredReferences) && card.ignoredReferences.length) {
            const extra = document.createElement('div');
            extra.className = 'replacement-note replacement-note--warning';
            extra.textContent = 'Only the first ' + (card.replacements || []).length + ' image(s) will be used; ' +
                card.ignoredReferences.length + ' extra image(s) will be ignored.';
            wrap.appendChild(extra);
        }

        const actions = document.createElement('div');
        actions.className = 'chat-suggestion-row replacement-actions';
        actions.appendChild(makeButton('Create Video', 'confirm', () => sendAction('confirm', card)));
        if ((card.replacements || []).length > 1) {
            actions.appendChild(makeButton('Reverse order', 'reverse', () => sendAction('reverse', card)));
        }
        actions.appendChild(makeButton('Cancel', 'cancel', () => sendAction('cancel', card)));
        wrap.appendChild(actions);

        contentEl.appendChild(wrap);
    }

    return { extract, strip, render };
})();

window.ReplacementUI = ReplacementUI;
