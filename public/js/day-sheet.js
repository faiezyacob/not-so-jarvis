/* SPDX-License-Identifier: MIT */
/* ============================================================
   Day sheet — the header above the log.
   Reads state that already exists in the DOM (active roll, the
   model pill, the queue strip, the log's own entries) and writes
   it as a ruled sheet. It never owns state of its own.
   ============================================================ */

(() => {
    const sheet = document.getElementById('daySheet');
    if (!sheet) return;

    const els = {
        title: document.getElementById('daySheetTitle'),
        sub: document.getElementById('daySheetSub'),
        stamp: document.getElementById('daySheetStamp'),
        model: document.getElementById('dayFieldModel'),
        queue: document.getElementById('dayFieldQueue'),
        elapsed: document.getElementById('dayFieldElapsed'),
        frames: document.getElementById('dayFieldFrames')
    };
    const messagesEl = document.getElementById('chatMessages');
    const listEl = document.getElementById('conversationList');
    const queueEl = document.getElementById('chatQueueStatus');
    const pillEl = document.getElementById('modelPillName');
    const chatAreaEl = messagesEl ? messagesEl.closest('.chat-area') : null;

    let startedAt = 0;
    let lastActiveId = null;

    function pad(value) {
        return String(value).padStart(2, '0');
    }

    // On a phone the roll rail is one horizontal strip: keep the open roll in
    // view rather than showing the oldest one beside a header naming another.
    function revealActive(item) {
        if (!listEl || !item) return;
        const id = item.getAttribute('data-id') || '';
        if (id === lastActiveId) return;
        lastActiveId = id;
        if (listEl.scrollWidth <= listEl.clientWidth + 4) return;
        const left = item.offsetLeft;
        const right = left + item.offsetWidth;
        if (left < listEl.scrollLeft || right > listEl.scrollLeft + listEl.clientWidth) {
            listEl.scrollLeft = Math.max(0, left - 8);
        }
    }

    function isRunning() {
        if (!messagesEl) return false;
        return !!messagesEl.querySelector('.generating-status, .typing-indicator, .agent-task--running');
    }

    function isQueued() {
        return !!queueEl && !queueEl.hidden;
    }

    // chat.js mirrors the server's turn-queue position onto the chat area, so
    // the figure reports a real wait rather than a boolean.
    function serverQueuePosition() {
        if (!chatAreaEl) return 0;
        const value = Number(chatAreaEl.dataset.queuePosition);
        return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
    }

    function elapsedLabel() {
        if (!isRunning()) return '—';
        const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
        return pad(Math.floor(seconds / 60)) + ':' + pad(seconds % 60);
    }

    function activeItem() {
        return listEl ? listEl.querySelector('.conv-item.active') : null;
    }

    function rollLabel(item) {
        if (!listEl || !item) return 'Roll —';
        const items = Array.from(listEl.querySelectorAll('.conv-item'));
        const index = items.indexOf(item);
        if (index < 0) return 'Roll —';
        return 'Roll ' + pad(index + 1);
    }

    function frameCount() {
        if (!messagesEl) return 0;
        return messagesEl.querySelectorAll('img.md-image, video').length;
    }

    function entryCount() {
        return messagesEl ? messagesEl.querySelectorAll('.message').length : 0;
    }

    function lastWrite() {
        if (!messagesEl) return '';
        const times = messagesEl.querySelectorAll('.message-time');
        for (let i = times.length - 1; i >= 0; i -= 1) {
            const text = times[i].textContent.trim();
            if (text) return text;
        }
        return '';
    }

    function update() {
        const item = activeItem();
        const running = isRunning();
        const queued = isQueued();

        if (running && !startedAt) startedAt = Date.now();
        if (!running) startedAt = 0;

        if (els.title) {
            const raw = item ? item.querySelector('.conv-title') : null;
            const text = raw ? raw.textContent.replace(/◆\s*companion/i, '').trim() : '';
            els.title.textContent = text || 'New roll';
            els.title.title = text || 'New roll';
        }

        if (els.sub) {
            const parts = [rollLabel(item)];
            const entries = entryCount();
            parts.push(entries === 1 ? '1 entry' : entries + ' entries');
            const written = lastWrite();
            if (written) parts.push('last ' + written);
            els.sub.textContent = parts.join(' · ');
        }

        if (els.stamp) {
            els.stamp.textContent = running ? 'Live' : (queued ? 'Queued' : 'Open');
            els.stamp.classList.toggle('is-live', running);
            els.stamp.classList.toggle('is-queued', !running && queued);
        }

        if (els.model) {
            const model = pillEl ? pillEl.textContent.trim() : '';
            els.model.textContent = model && model !== 'No model' ? model : '—';
            els.model.title = els.model.textContent;
        }

        // A blocked model is the one state worth the stamp colour on the
        // composer: nothing will generate until it is chosen.
        const pill = document.getElementById('modelPill');
        if (pill) {
            const model = pillEl ? pillEl.textContent.trim() : '';
            pill.classList.toggle('is-blocked', !model || model === 'No model');
        }

        if (els.queue) els.queue.textContent = String(Math.max(serverQueuePosition(), queued ? 1 : 0));
        if (els.elapsed) els.elapsed.textContent = elapsedLabel();
        if (els.frames) els.frames.textContent = String(frameCount());

        // The empty sheet is a state of the log, not a sibling guess: a comment
        // node or whitespace would defeat a :empty selector here.
        const area = messagesEl ? messagesEl.closest('.chat-area') : null;
        if (area) area.classList.toggle('is-empty', entryCount() === 0);

        revealActive(item);
    }

    function watch(node) {
        if (!node || typeof MutationObserver === 'undefined') return;
        const observer = new MutationObserver(update);
        observer.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
    }

    watch(messagesEl);
    watch(listEl);
    watch(queueEl);
    watch(pillEl);
    if (chatAreaEl && typeof MutationObserver !== 'undefined') {
        new MutationObserver(update).observe(chatAreaEl, { attributes: true, attributeFilter: ['data-queue-position'] });
    }

    if (listEl) listEl.addEventListener('click', () => setTimeout(update, 0));

    // Empty-log starters fill the composer rather than sending blind.
    document.querySelectorAll('.chat-empty-starter').forEach((button) => {
        button.addEventListener('click', () => {
            const input = document.getElementById('chatInput');
            if (!input) return;
            input.value = button.textContent.trim();
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
        });
    });

    setInterval(update, 1000);
    update();
})();
