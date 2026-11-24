/* ============================================
   JARVIS — Character photo inbox
   The tray where a character who shares photos on
   her own drops a selfie she took without being
   asked. Unread badge in the header, newest-first
   grid, a large viewer and a reply that opens her
   companion chat.
   SPDX-License-Identifier: MIT
   ============================================ */

const InboxUI = (() => {
    'use strict';

    const POLL_MS = 60000;

    let els = {};
    let items = [];
    let characters = [];
    let viewerItem = null;
    let busy = false;
    let pollTimer = null;
    let selectionMode = false;
    const selected = new Set();

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function clear(node) {
        if (node) node.innerHTML = '';
    }

    async function api(method, url, body) {
        const options = { method };
        if (body !== undefined) {
            options.headers = { 'Content-Type': 'application/json' };
            options.body = JSON.stringify(body);
        }
        const res = await fetch(url, options);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
    }

    function fmtWhen(value) {
        if (!value) return '';
        const at = Date.parse(value);
        if (!Number.isFinite(at)) return '';
        const diff = Date.now() - at;
        const mins = Math.round(diff / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return mins + 'm ago';
        const hours = Math.round(mins / 60);
        if (hours < 24) return hours + 'h ago';
        const days = Math.round(hours / 24);
        if (days < 7) return days + 'd ago';
        return new Date(at).toLocaleDateString();
    }

    function setStatus(text) {
        if (els.status) els.status.textContent = text || '';
    }

    // Keep the tray, badge and selection controls in sync from one server
    // payload so a delete/read/delivery can never leave a stale count behind.
    function applyPayload(data) {
        const payload = data || {};
        items = payload.items || [];
        characters = payload.characters || characters;
        renderBadge(payload.unread);
        const live = new Set(items.map((item) => item.id));
        Array.from(selected).forEach((id) => { if (!live.has(id)) selected.delete(id); });
        if (!items.length) selectionMode = false;
        if (els.overlay && !els.overlay.hidden) render();
        syncTools();
    }

    function syncTools() {
        if (els.select) {
            els.select.textContent = selectionMode ? 'Cancel' : 'Select';
            els.select.setAttribute('aria-pressed', selectionMode ? 'true' : 'false');
        }
        if (els.deleteSelected) {
            els.deleteSelected.hidden = !selectionMode;
            els.deleteSelected.disabled = selected.size === 0;
            els.deleteSelected.textContent = selected.size
                ? 'Delete selected (' + selected.size + ')'
                : 'Delete selected';
        }
        if (els.deleteAll) els.deleteAll.disabled = !items.length;
        if (els.selection) {
            els.selection.textContent = selectionMode
                ? selected.size + ' of ' + items.length + ' selected'
                : '';
        }
    }

    function setSelectionMode(on) {
        selectionMode = Boolean(on);
        if (!selectionMode) selected.clear();
        render();
        syncTools();
    }

    function toggleSelected(item) {
        if (!item || !item.id) return;
        if (selected.has(item.id)) selected.delete(item.id);
        else selected.add(item.id);
        render();
        syncTools();
    }

    function confirmAction(message) {
        if (window.Dialog) return window.Dialog.confirm(message);
        return Promise.resolve(window.confirm(message));
    }

    function renderBadge(unread) {
        if (!els.badge) return;
        const count = Number(unread) || 0;
        els.badge.textContent = count > 99 ? '99+' : String(count);
        els.badge.hidden = count === 0;
        if (els.trigger) {
            els.trigger.title = count ? count + ' new photo' + (count === 1 ? '' : 's') : 'Open the character photo inbox';
        }
    }

    function renderCharacters() {
        if (!els.characters) return;
        clear(els.characters);
        if (!characters.length) {
            els.characters.hidden = true;
            return;
        }
        els.characters.hidden = false;
        characters.forEach((character) => {
            const row = el('div', 'inbox-character');
            if (character.image) {
                const img = document.createElement('img');
                img.src = character.image;
                img.alt = '';
                img.loading = 'lazy';
                row.appendChild(img);
            } else {
                row.appendChild(el('span', 'inbox-character-blank', (character.name || '?').slice(0, 1)));
            }
            const meta = el('div', 'inbox-character-meta');
            meta.appendChild(el('strong', '', character.name || 'Character'));
            meta.appendChild(el('span', 'inbox-character-note',
                character.unread ? character.unread + ' unread' : 'No new photos'));
            row.appendChild(meta);
            const send = el('button', 'arena-link', 'Send one now');
            send.type = 'button';
            send.addEventListener('click', () => sendNow(character.id, send));
            row.appendChild(send);
            els.characters.appendChild(row);
        });
    }

    function card(item) {
        const isSelected = selected.has(item.id);
        const wrap = el('div', 'inbox-card-wrap'
            + (isSelected ? ' is-selected' : '')
            + (selectionMode ? ' is-selecting' : ''));
        const node = el('button', 'inbox-card' + (item.readAt ? '' : ' is-unread'));
        node.type = 'button';
        if (selectionMode) node.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
        const stage = el('div', 'inbox-card-stage');
        const img = document.createElement('img');
        img.src = item.url;
        img.alt = (item.characterName || 'Character') + ' photo';
        img.loading = 'lazy';
        img.draggable = false;
        stage.appendChild(img);
        if (selectionMode) {
            stage.appendChild(el('span', 'inbox-card-check' + (isSelected ? ' is-on' : '')));
        } else if (!item.readAt) {
            stage.appendChild(el('span', 'inbox-card-dot'));
        }
        node.appendChild(stage);
        const foot = el('div', 'inbox-card-foot');
        const who = el('div', 'inbox-card-who');
        who.appendChild(el('strong', '', item.characterName || 'Character'));
        who.appendChild(el('span', '', fmtWhen(item.createdAt)));
        foot.appendChild(who);
        node.appendChild(foot);
        if (item.caption) node.appendChild(el('p', 'inbox-card-caption', item.caption));
        node.addEventListener('click', () => {
            if (selectionMode) toggleSelected(item);
            else openViewer(item);
        });
        wrap.appendChild(node);
        // Delete straight from the box, without opening the photo first.
        const remove = el('button', 'inbox-card-delete', '\u00d7');
        remove.type = 'button';
        remove.title = 'Delete this photo';
        remove.setAttribute('aria-label', 'Delete this photo');
        remove.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            deleteOne(item);
        });
        wrap.appendChild(remove);
        return wrap;
    }

    function render() {
        if (!els.body) return;
        clear(els.body);
        renderCharacters();
        syncTools();
        if (!items.length) {
            els.body.appendChild(el('div', 'inbox-empty',
                'Nothing yet. Set a character to scheduled initiative with automatic photo sharing and she will start dropping photos here.'));
            return;
        }
        const grid = el('div', 'inbox-grid');
        items.forEach((item) => grid.appendChild(card(item)));
        els.body.appendChild(grid);
    }

    async function refresh() {
        try {
            applyPayload(await api('GET', '/api/inbox'));
        } catch (err) {
            setStatus(err.message);
        }
    }

    async function sendNow(characterId, button) {
        if (busy) return;
        busy = true;
        if (button) { button.disabled = true; button.textContent = 'Taking it…'; }
        setStatus('Taking a photo…');
        const newest = items
            .filter((item) => item.characterId === characterId)
            .map((item) => String(item.createdAt || ''))
            .sort()
            .pop() || '';
        try {
            await api('POST', '/api/inbox/' + encodeURIComponent(characterId) + '/deliver');
            const fresh = await waitForPhoto(characterId, newest);
            setStatus(fresh ? 'New photo' : 'Still working. It will appear here when it lands.');
            await refresh();
        } catch (err) {
            setStatus(err.message);
        } finally {
            busy = false;
            if (button) { button.disabled = false; button.textContent = 'Send one now'; }
        }
    }

    // The render is started server-side and answered immediately, so the tray
    // watches for the new item instead of holding one request open for minutes.
    function waitForPhoto(characterId, since) {
        return new Promise((resolve) => {
            let attempts = 0;
            const tick = async () => {
                attempts += 1;
                try {
                    applyPayload(await api('GET', '/api/inbox'));
                    const fresh = items.find((item) => item.characterId === characterId
                        && String(item.createdAt || '') > since);
                    if (fresh) return resolve(fresh);
                } catch (err) { /* keep waiting */ }
                if (attempts >= 60) return resolve(null);
                setTimeout(tick, 2500);
            };
            tick();
        });
    }

    function openViewer(item) {
        if (!item || !els.viewerOverlay) return;
        viewerItem = item;
        els.viewerImage.src = item.url;
        els.viewerImage.alt = (item.characterName || 'Character') + ' photo';
        els.viewerName.textContent = item.characterName || 'Character';
        const when = fmtWhen(item.createdAt);
        const place = [item.activity, item.location].filter(Boolean).join(' · ');
        els.viewerWhen.textContent = [when, place].filter(Boolean).join(' · ');
        els.viewerCaption.textContent = item.caption || '';
        els.viewerCaption.hidden = !item.caption;
        els.viewerOverlay.hidden = false;
        if (els.viewerClose) els.viewerClose.focus();
        if (!item.readAt) markRead(item);
    }

    function closeViewer() {
        if (els.viewerOverlay) els.viewerOverlay.hidden = true;
        viewerItem = null;
    }

    async function markRead(item) {
        try {
            applyPayload(await api('POST', '/api/inbox/' + encodeURIComponent(item.id) + '/read'));
        } catch (err) { /* the badge simply stays unread */ }
    }

    async function removeViewerItem() {
        if (!viewerItem) return;
        const item = viewerItem;
        if (!(await confirmAction('Delete this photo?'))) return;
        try {
            applyPayload(await api('DELETE', '/api/inbox/' + encodeURIComponent(item.id)));
            closeViewer();
            setStatus('Photo deleted');
        } catch (err) {
            setStatus(err.message);
        }
    }

    // Per-card delete: acts on one photo without opening the viewer.
    async function deleteOne(item) {
        if (busy || !item) return;
        if (!(await confirmAction('Delete this photo?'))) return;
        busy = true;
        try {
            if (viewerItem && viewerItem.id === item.id) closeViewer();
            applyPayload(await api('DELETE', '/api/inbox/' + encodeURIComponent(item.id)));
            setStatus('Photo deleted');
        } catch (err) {
            setStatus(err.message);
        } finally {
            busy = false;
        }
    }

    // Multi-select delete: one request for every checked photo.
    async function deleteSelected() {
        if (busy || !selected.size) return;
        const count = selected.size;
        const label = count === 1 ? 'photo' : 'photos';
        if (!(await confirmAction('Delete ' + count + ' selected ' + label + '?'))) return;
        busy = true;
        try {
            const data = await api('POST', '/api/inbox/delete', { ids: Array.from(selected) });
            selected.clear();
            selectionMode = false;
            applyPayload(data);
            setStatus(count + ' ' + label + ' deleted');
        } catch (err) {
            setStatus(err.message);
        } finally {
            busy = false;
        }
    }

    // Empty the whole tray, across every character.
    async function deleteAll() {
        if (busy || !items.length) return;
        const count = items.length;
        const label = count === 1 ? 'photo' : 'photos';
        if (!(await confirmAction('Delete all ' + count + ' ' + label + '?'))) return;
        busy = true;
        try {
            const data = await api('DELETE', '/api/inbox');
            selected.clear();
            selectionMode = false;
            applyPayload(data);
            setStatus(count + ' ' + label + ' deleted');
        } catch (err) {
            setStatus(err.message);
        } finally {
            busy = false;
        }
    }

    // Continue the conversation that photo belongs to: reuse her most recent
    // companion chat rather than starting a new one.
    async function replyInChat() {
        if (!viewerItem || !viewerItem.characterId) return;
        try {
            const data = await api('POST', '/api/companion/' + encodeURIComponent(viewerItem.characterId) + '/conversations', { new: false });
            const conversation = data.conversation;
            closeViewer();
            close();
            if (conversation && typeof Conversations !== 'undefined') {
                const messages = await Conversations.select(conversation.id);
                if (typeof Chat !== 'undefined') {
                    await Chat.refreshConversationList();
                    Chat.renderMessages(messages || []);
                }
                const input = document.getElementById('chatInput');
                if (input) input.focus();
            }
        } catch (err) {
            setStatus(err.message);
        }
    }

    async function open() {
        if (!els.overlay) return;
        selectionMode = false;
        selected.clear();
        els.overlay.hidden = false;
        requestAnimationFrame(() => els.overlay.classList.add('open'));
        if (window.StudioShell) window.StudioShell.open(els.overlay, { initial: '#inboxClose' });
        setStatus('Loading…');
        await refresh();
        syncTools();
        setStatus('');
    }

    function close() {
        if (!els.overlay) return;
        selectionMode = false;
        selected.clear();
        closeViewer();
        els.overlay.classList.remove('open');
        if (window.StudioShell) window.StudioShell.close();
        setTimeout(() => { els.overlay.hidden = true; }, 180);
    }

    function init() {
        els = {
            trigger: document.getElementById('inboxOpen'),
            badge: document.getElementById('inboxBadge'),
            overlay: document.getElementById('inboxOverlay'),
            close: document.getElementById('inboxClose'),
            body: document.getElementById('inboxBody'),
            characters: document.getElementById('inboxCharacters'),
            status: document.getElementById('inboxStatus'),
            refresh: document.getElementById('inboxRefresh'),
            select: document.getElementById('inboxSelect'),
            deleteSelected: document.getElementById('inboxDeleteSelected'),
            deleteAll: document.getElementById('inboxDeleteAll'),
            selection: document.getElementById('inboxSelection'),
            viewerOverlay: document.getElementById('inboxViewerOverlay'),
            viewerImage: document.getElementById('inboxViewerImage'),
            viewerName: document.getElementById('inboxViewerName'),
            viewerWhen: document.getElementById('inboxViewerWhen'),
            viewerCaption: document.getElementById('inboxViewerCaption'),
            viewerReply: document.getElementById('inboxViewerReply'),
            viewerDelete: document.getElementById('inboxViewerDelete'),
            viewerClose: document.getElementById('inboxViewerClose')
        };
        if (!els.overlay) return;
        if (els.trigger) els.trigger.addEventListener('click', open);
        if (els.close) els.close.addEventListener('click', close);
        if (els.refresh) els.refresh.addEventListener('click', () => { setStatus('Refreshing…'); refresh().then(() => setStatus('')); });
        if (els.select) els.select.addEventListener('click', () => setSelectionMode(!selectionMode));
        if (els.deleteSelected) els.deleteSelected.addEventListener('click', deleteSelected);
        if (els.deleteAll) els.deleteAll.addEventListener('click', deleteAll);
        els.overlay.addEventListener('click', (event) => { if (event.target === els.overlay) close(); });
        if (els.viewerClose) els.viewerClose.addEventListener('click', closeViewer);
        if (els.viewerOverlay) {
            els.viewerOverlay.addEventListener('click', (event) => {
                if (event.target === els.viewerOverlay) closeViewer();
            });
        }
        if (els.viewerReply) els.viewerReply.addEventListener('click', replyInChat);
        if (els.viewerDelete) els.viewerDelete.addEventListener('click', removeViewerItem);
        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            if (els.viewerOverlay && !els.viewerOverlay.hidden) { closeViewer(); return; }
            if (els.overlay && !els.overlay.hidden) close();
        });
        // The badge is the only sign a photo arrived, so keep it fresh without
        // ever interrupting what the user is doing.
        refresh();
        pollTimer = setInterval(refresh, POLL_MS);
        window.addEventListener('focus', () => { refresh(); });
    }

    return { init, open, close, refresh };
})();

if (typeof window !== 'undefined') window.InboxUI = InboxUI;
