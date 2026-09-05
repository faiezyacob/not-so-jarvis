/* ============================================
   JARVIS — Conversation Service (Backend)
   Stores conversations and messages in a local
   JSON file. The browser's IndexedDB mirrors
   this store so the UI stays durable.
   ============================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'conversations.json');

const CONFIG = {
    MAX_CONTEXT_MESSAGES: 50,
    RECENT_MESSAGE_LIMIT: 20
};

function uuid() {
    return crypto.randomUUID();
}

// --- Persistence ---

function loadStore() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            return { conversations: [], messages: [] };
        }
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
        console.error('Failed to load conversation store:', e.message);
        return { conversations: [], messages: [] };
    }
}

let store = loadStore();

function saveStore() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed to save conversation store:', e.message);
    }
}

// --- Helpers ---

function sortConversations(list) {
    return list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function sortMessages(list) {
    return list.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

// --- Conversation CRUD ---

function createConversation(data) {
    const now = Date.now();
    const conversation = {
        id: uuid(),
        title: (data && data.title) || 'New Conversation',
        summary: '',
        createdAt: now,
        updatedAt: now
    };
    store.conversations.push(conversation);
    saveStore();
    return conversation;
}

function getConversation(id) {
    return store.conversations.find((c) => c.id === id) || null;
}

function getAllConversations() {
    return sortConversations(store.conversations);
}

function renameConversation(id, title) {
    const conv = getConversation(id);
    if (!conv) return null;
    conv.title = (title || '').trim() || conv.title;
    conv.updatedAt = Date.now();
    saveStore();
    return conv;
}

function deleteConversation(id) {
    const before = store.conversations.length;
    store.conversations = store.conversations.filter((c) => c.id !== id);
    store.messages = store.messages.filter((m) => m.conversationId !== id);
    const removed = before !== store.conversations.length;
    if (removed) saveStore();
    return removed;
}

// --- Message operations ---

function addMessage(conversationId, role, content) {
    const conv = getConversation(conversationId);
    if (!conv) return null;

    const message = {
        id: uuid(),
        conversationId,
        role,
        content,
        createdAt: Date.now()
    };
    store.messages.push(message);
    conv.updatedAt = Date.now();

    // Auto-title from first user message
    if (conv.title === 'New Conversation' && role === 'user') {
        conv.title = content.trim().slice(0, 60) || conv.title;
    }

    saveStore();
    return message;
}

function getMessages(id) {
    return sortMessages(store.messages.filter((m) => m.conversationId === id));
}

// --- Context building ---

function buildMessages(id) {
    const conv = getConversation(id);
    const messages = getMessages(id);
    if (!conv) return { messages: [] };

    const recent = messages.slice(-CONFIG.RECENT_MESSAGE_LIMIT);

    const aiMessages = [];

    if (conv.summary) {
        aiMessages.push({
            role: 'system',
            content: 'Conversation summary:\n' + conv.summary
        });
    }

    recent.forEach((m) => {
        aiMessages.push({ role: m.role, content: m.content });
    });

    return { messages: aiMessages };
}

function setSummary(id, summary) {
    const conv = getConversation(id);
    if (!conv) return null;
    conv.summary = summary || '';
    conv.updatedAt = Date.now();
    saveStore();
    return conv;
}

module.exports = {
    CONFIG,
    uuid,
    createConversation,
    getConversation,
    getAllConversations,
    renameConversation,
    deleteConversation,
    addMessage,
    getMessages,
    buildMessages,
    setSummary
};
