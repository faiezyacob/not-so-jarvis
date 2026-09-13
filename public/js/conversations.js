/* ============================================
   JARVIS — Conversation Manager
   Handles conversation CRUD, IndexedDB mirroring,
   backend sync, and the conversation list UI.
   ============================================ */

const Conversations = (() => {
    let currentConversationId = null;
    const listeners = [];

    // Remember the last conversation opened so a page reload (including the
    // server's restart flow, which reloads) reopens it instead of the newest.
    const LAST_ACTIVE_KEY = 'jarvis-last-conversation';

    function readLastActive() {
        try { return localStorage.getItem(LAST_ACTIVE_KEY) || null; } catch { return null; }
    }

    function writeLastActive(id) {
        try {
            if (id) localStorage.setItem(LAST_ACTIVE_KEY, id);
            else localStorage.removeItem(LAST_ACTIVE_KEY);
        } catch {}
    }

    function onChange(fn) {
        listeners.push(fn);
    }

    function notify() {
        listeners.forEach((fn) => fn());
    }

    function currentId() {
        return currentConversationId;
    }

    function lastActiveId() {
        return readLastActive();
    }

    // --- Backend sync (source of truth for context building) ---

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

    // --- IndexedDB mirroring ---

    async function saveConversationToDB(conv) {
        try { await DB.conversations.put(conv); } catch (e) { console.warn('DB save failed', e); }
    }

    async function saveMessageToDB(message) {
        try { await DB.messages.put(message); } catch (e) { console.warn('DB save failed', e); }
    }

    async function syncConversationsToDB(list) {
        try {
            for (const c of list) await DB.conversations.put(c);
        } catch (e) { console.warn('DB sync failed', e); }
    }

    async function syncMessagesToDB(conversationId, messages) {
        try {
            for (const m of messages) await DB.messages.put(m);
        } catch (e) { console.warn('DB sync failed', e); }
    }

    // --- Public operations ---

    async function list() {
        try {
            const data = await api('GET', '/api/conversations');
            const conversations = data.conversations || [];
            syncConversationsToDB(conversations);
            return conversations;
        } catch (e) {
            // Fall back to IndexedDB if backend unavailable
            try { return await DB.conversations.getAll(); } catch { return []; }
        }
    }

    async function create() {
        const data = await api('POST', '/api/conversations', { title: 'New Conversation' });
        await saveConversationToDB(data);
        currentConversationId = data.id;
        writeLastActive(currentConversationId);
        notify();
        return data;
    }

    async function select(id) {
        currentConversationId = id;
        writeLastActive(id);
        notify();
        return await loadMessages(id);
    }

    async function loadMessages(id) {
        try {
            const data = await api('GET', '/api/conversations/' + id + '/messages');
            const messages = data.messages || [];
            syncMessagesToDB(id, messages);
            return messages;
        } catch (e) {
            try { return await DB.messages.byConversation(id); } catch { return []; }
        }
    }

    async function rename(id, title) {
        const data = await api('PATCH', '/api/conversations/' + id, { title });
        await saveConversationToDB(data);
        notify();
        return data;
    }

    // Toggle a conversation's private/locked state. Private conversations
    // keep their generated media out of the shared gallery widget.
    async function setPrivate(id, isPrivate) {
        const data = await api('PATCH', '/api/conversations/' + id, { private: Boolean(isPrivate) });
        await saveConversationToDB(data);
        notify();
        return data;
    }

    async function remove(id) {
        await api('DELETE', '/api/conversations/' + id);
        try {
            await DB.conversations.remove(id);
            await DB.messages.removeByConversation(id);
        } catch (e) { console.warn('DB remove failed', e); }
        if (currentConversationId === id) {
            currentConversationId = null;
            writeLastActive(null);
        }
        notify();
    }

    async function saveUserMessage(conversationId, content) {
        const message = await api('POST', '/api/conversations/' + conversationId + '/messages', {
            role: 'user',
            content
        });
        await saveMessageToDB(message);

        // Keep local title in sync with backend's auto-title
        try {
            const convData = await api('GET', '/api/conversations/' + conversationId);
            await saveConversationToDB(convData);
        } catch (e) {}
        notify();
        return message;
    }

    async function saveAssistantMessage(conversationId, content) {
        const message = await api('POST', '/api/conversations/' + conversationId + '/messages', {
            role: 'assistant',
            content
        });
        await saveMessageToDB(message);
        notify();
        return message;
    }

    return {
        onChange,
        currentId,
        lastActiveId,
        list,
        create,
        select,
        loadMessages,
        rename,
        setPrivate,
        remove,
        saveUserMessage,
        saveAssistantMessage
    };
})();
