/* ============================================
   JARVIS — IndexedDB Layer
   Local persistent store for conversations
   and messages.
   ============================================ */

const DB_NAME = 'jarvisDB';
const DB_VERSION = 1;

const STORES = {
    conversations: 'conversations',
    messages: 'messages'
};

let dbPromise = null;

// --- UUID helper ---

function uuid() {
    if (window.crypto && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            reject(new Error('IndexedDB not supported'));
            return;
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (e) => {
            const db = e.target.result;

            if (!db.objectStoreNames.contains(STORES.conversations)) {
                const convStore = db.createObjectStore(STORES.conversations, { keyPath: 'id' });
                convStore.createIndex('updatedAt', 'updatedAt', { unique: false });
                convStore.createIndex('createdAt', 'createdAt', { unique: false });
            }

            if (!db.objectStoreNames.contains(STORES.messages)) {
                const msgStore = db.createObjectStore(STORES.messages, { keyPath: 'id' });
                msgStore.createIndex('conversationId', 'conversationId', { unique: false });
                msgStore.createIndex('createdAt', 'createdAt', { unique: false });
            }
        };

        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
        request.onblocked = () => reject(new Error('Database blocked'));
    });

    return dbPromise;
}

// --- Generic helpers ---

function tx(storeName, mode, fn) {
    return openDB().then((db) => {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, mode);
            const store = transaction.objectStore(storeName);
            const result = fn(store);
            transaction.oncomplete = () => resolve(result);
            transaction.onerror = (e) => reject(e.target.error);
            transaction.onabort = (e) => reject(e.target.error);
        });
    });
}

function reqToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// --- Conversation operations ---

function getAllConversations() {
    return tx(STORES.conversations, 'readonly', (store) => {
        return reqToPromise(store.getAll());
    }).then((items) => {
        return (items || []).sort((a, b) => b.updatedAt - a.updatedAt);
    });
}

function getConversation(id) {
    return tx(STORES.conversations, 'readonly', (store) => {
        return reqToPromise(store.get(id));
    }).then((item) => item || null);
}

function putConversation(conversation) {
    return tx(STORES.conversations, 'readwrite', (store) => {
        return reqToPromise(store.put(conversation));
    });
}

function deleteConversation(id) {
    return tx(STORES.conversations, 'readwrite', (store) => {
        return reqToPromise(store.delete(id));
    });
}

// --- Message operations ---

function getMessagesByConversation(conversationId) {
    return tx(STORES.messages, 'readonly', (store) => {
        const index = store.index('conversationId');
        return reqToPromise(index.getAll(conversationId));
    }).then((items) => {
        return (items || []).sort((a, b) => a.createdAt - b.createdAt);
    });
}

function getAllMessages() {
    return tx(STORES.messages, 'readonly', (store) => {
        return reqToPromise(store.getAll());
    });
}

function putMessage(message) {
    return tx(STORES.messages, 'readwrite', (store) => {
        return reqToPromise(store.put(message));
    });
}

function deleteMessagesByConversation(conversationId) {
    return tx(STORES.messages, 'readwrite', (store) => {
        const index = store.index('conversationId');
        return reqToPromise(index.openCursor(conversationId)).then(function deleteNext(cursor) {
            if (!cursor) return;
            cursor.delete();
            return reqToPromise(cursor.continue()).then(deleteNext);
        });
    });
}

// --- Public API ---

const DB = {
    ready: openDB,
    uuid,
    conversations: {
        getAll: getAllConversations,
        get: getConversation,
        put: putConversation,
        remove: deleteConversation
    },
    messages: {
        byConversation: getMessagesByConversation,
        all: getAllMessages,
        put: putMessage,
        removeByConversation: deleteMessagesByConversation
    }
};
