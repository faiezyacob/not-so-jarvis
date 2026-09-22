/* ============================================
   JARVIS — @ Reference Mention Picker
   A reusable "@" picker that lists the current
   conversation's generated images (newest first)
   and hands the chosen image to a caller. Used by
   the UGC Studio product form (and available to any
   input that wants to reference a generated image).
   Reuses the .chat-mention-* styles.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const MentionPicker = (() => {
    let popup = null;
    let metaCache = null;
    let active = null;
    let openToken = 0;

    function ensurePopup() {
        if (popup) return popup;
        popup = document.createElement('div');
        popup.className = 'chat-mention-popup mention-picker-popup';
        popup.hidden = true;
        document.body.appendChild(popup);
        return popup;
    }

    // Scan the rendered conversation for generated image links (newest first).
    function collect() {
        const messages = document.getElementById('chatMessages');
        if (!messages) return [];
        const seen = new Set();
        const list = [];
        messages.querySelectorAll('img.md-image').forEach((img) => {
            const src = String(img.getAttribute('src') || '');
            if (src.indexOf('/generated/') === -1) return;
            const decoded = decodeURIComponent(src.split('?')[0]);
            const idx = decoded.lastIndexOf('/');
            const filename = idx === -1 ? decoded : decoded.slice(idx + 1);
            if (!/\.(?:png|jpe?g|webp)$/i.test(filename)) return;
            if (seen.has(filename)) return;
            seen.add(filename);
            list.push({ filename, url: '/generated/' + encodeURIComponent(filename) });
        });
        return list.reverse();
    }

    async function generatedMeta() {
        if (metaCache) return metaCache;
        try {
            const res = await fetch('/api/generated');
            const data = await res.json();
            metaCache = Array.isArray(data.images) ? data.images : [];
        } catch (e) {
            metaCache = [];
        }
        return metaCache;
    }

    function position(input) {
        if (!popup || !input) return;
        const rect = input.getBoundingClientRect();
        const width = Math.min(420, Math.max(240, rect.width));
        const maxH = 280;
        let top = rect.top - maxH - 8;
        if (top < 8) top = rect.bottom + 8;
        let left = rect.left;
        if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
        popup.style.position = 'fixed';
        popup.style.left = Math.max(8, left) + 'px';
        popup.style.top = Math.max(8, top) + 'px';
        popup.style.width = width + 'px';
        popup.style.bottom = 'auto';
        popup.style.right = 'auto';
    }

    function reposition() {
        if (isOpen()) position(active.input);
    }

    async function open(input, query, onSelect) {
        const myToken = ++openToken;
        const images = collect();
        if (!images.length) {
            close();
            return;
        }
        const meta = await generatedMeta();
        if (myToken !== openToken) return;
        const q = String(query || '').toLowerCase();
        const enriched = images.map((img) => {
            const found = meta.find((m) => String(m.file || '').split('?')[0].endsWith('/' + img.filename));
            return Object.assign({}, img, { prompt: found ? (found.prompt || '') : '' });
        });
        const items = q
            ? enriched.filter((img) => (img.filename + ' ' + img.prompt).toLowerCase().indexOf(q) !== -1)
            : enriched;
        if (!items.length) {
            close();
            return;
        }
        active = { input, onSelect, items, index: 0 };
        ensurePopup();
        render();
        position(input);
        popup.hidden = false;
    }

    function render() {
        if (!popup || !active) return;
        popup.innerHTML = '';
        active.items.forEach((item, i) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'chat-mention-item' + (i === active.index ? ' active' : '');
            const thumb = document.createElement('img');
            thumb.className = 'chat-mention-thumb';
            thumb.src = item.url;
            thumb.alt = item.filename;
            const meta = document.createElement('div');
            meta.className = 'chat-mention-meta';
            const name = document.createElement('div');
            name.className = 'chat-mention-name';
            name.textContent = item.filename;
            const prompt = document.createElement('div');
            prompt.className = 'chat-mention-prompt';
            prompt.textContent = item.prompt || 'Generated image';
            meta.appendChild(name);
            meta.appendChild(prompt);
            row.appendChild(thumb);
            row.appendChild(meta);
            row.addEventListener('mousedown', (e) => {
                e.preventDefault();
                select(i);
            });
            row.addEventListener('mouseenter', () => {
                if (!active) return;
                active.index = i;
                updateActive();
            });
            popup.appendChild(row);
        });
        updateActive();
    }

    function updateActive() {
        if (!popup || !active) return;
        const rows = popup.querySelectorAll('.chat-mention-item');
        rows.forEach((row, i) => row.classList.toggle('active', i === active.index));
        const el = rows[active.index];
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    }

    function move(delta) {
        if (!active || !active.items.length) return;
        active.index = (active.index + delta + active.items.length) % active.items.length;
        updateActive();
    }

    function select(index) {
        if (!active) return;
        const item = active.items[index];
        if (!item) return;
        const cb = active.onSelect;
        close();
        if (typeof cb === 'function') cb(item);
    }

    function isOpen() {
        return Boolean(popup && !popup.hidden && active && active.items.length);
    }

    function close() {
        openToken += 1;
        active = null;
        if (popup) {
            popup.hidden = true;
            popup.innerHTML = '';
        }
    }

    // Remove the in-progress "@query" token from the input, leaving the caret
    // where the token began.
    function removeTrigger(input) {
        const caret = input.selectionStart;
        if (caret === null || caret === undefined) return;
        const before = input.value
            .slice(0, caret)
            .replace(/(?:^|\s)@[^\s@]*$/, (match) => (match.charAt(0) === '@' ? '' : ' '));
        const after = input.value.slice(caret);
        input.value = before + after;
        const pos = before.length;
        if (typeof input.setSelectionRange === 'function') input.setSelectionRange(pos, pos);
    }

    // Wire an input/textarea so typing "@" opens the picker. `onSelect(item)` is
    // called with { filename, url, prompt } once an image is chosen.
    function attach(input, onSelect) {
        if (!input) return;

        function trigger() {
            const caret = input.selectionStart;
            if (caret === null || caret === undefined) return;
            const before = input.value.slice(0, caret);
            const match = before.match(/(?:^|\s)@([^\s@]*)$/);
            if (!match) {
                if (isOpen()) close();
                return;
            }
            open(input, match[1], (item) => {
                removeTrigger(input);
                onSelect(item);
            });
        }

        input.addEventListener('input', trigger);
        input.addEventListener('blur', () => setTimeout(() => { if (isOpen()) close(); }, 120));
        input.addEventListener('keydown', (e) => {
            if (!isOpen() || active.input !== input) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                select(active.index);
                return;
            }
            if (e.key === 'Escape') { e.preventDefault(); close(); }
        });
    }

    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);

    return { attach, open, close, isOpen, collect };
})();

window.MentionPicker = MentionPicker;
