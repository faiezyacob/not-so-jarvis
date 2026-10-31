/* ============================================
   JARVIS — Chat Controller
   Renders conversation list, loads messages,
   and drives the send/receive flow. Messages
   are handed off to Conversations (IndexedDB +
   backend) and the AI is called via /api/chat.
   ============================================ */

const Chat = (() => {
    let chatMessagesEl;
    let chatInput;
    let chatSend;
    let chatStop;
    let chatAttach;
    let chatFileInput;
    let chatAttachmentsEl;
    let chatQueueStatusEl;
    let chatQueueLabelEl;
    let chatQueueClearEl;
    let conversationListEl;
    let chatMentionPopup;
    let pendingAttachments = [];
    let pendingReferences = [];
    // Replacement source videos chosen from the @ picker this turn (`@videoN`).
    // Each is sent as a structured filename; the token is display only.
    let pendingVideoReferences = [];
    // Characters chosen from the @ picker this turn. Each is sent as a
    // structured id; the "@Name" token in the text is display only.
    let pendingCharacters = [];
    let mentionItems = [];
    let mentionIndex = 0;
    let mentionToken = 0;
    let generatedMetaCache = null;
    let charactersMetaCache = null;
    let charactersMetaCacheAt = 0;
    // The picker re-reads the character list after this window so a character
    // created from the Playground shows up without a reload.
    const CHARACTERS_CACHE_MS = 8000;

    const BASE_TITLE = document.title || 'NOT-SO-JARVIS';

    // The assistant label shown in the chat. Companion conversations (linked to
    // a character) show the character's name instead of JARVIS.
    let assistantDisplayName = 'JARVIS';

    function setProgressTitle(text) {
        document.title = text ? text + ' · ' + BASE_TITLE : BASE_TITLE;
    }

    const ATTACH_MAX = 3;
    const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
    const ATTACH_VIDEO_MAX_BYTES = 64 * 1024 * 1024;
    const ATTACH_MIME = {
        'image/png': true,
        'image/jpeg': true,
        'image/webp': true,
        'video/mp4': true,
        'video/webm': true,
        'video/quicktime': true
    };
    function isVideoMime(mime) {
        return /^video\//i.test(String(mime || ''));
    }
    function attachMaxBytes(mime) {
        return isVideoMime(mime) ? ATTACH_VIDEO_MAX_BYTES : ATTACH_MAX_BYTES;
    }

    function init() {
        chatMessagesEl = document.getElementById('chatMessages');
        chatInput = document.getElementById('chatInput');
        chatSend = document.getElementById('chatSend');
        chatStop = document.getElementById('chatStop');
        chatAttach = document.getElementById('chatAttach');
        chatFileInput = document.getElementById('chatFileInput');
        chatAttachmentsEl = document.getElementById('chatAttachments');
        chatQueueStatusEl = document.getElementById('chatQueueStatus');
        chatQueueLabelEl = document.getElementById('chatQueueLabel');
        chatQueueClearEl = document.getElementById('chatQueueClear');
        chatMentionPopup = document.getElementById('chatMentionPopup');
        conversationListEl = document.getElementById('conversationList');

        document.getElementById('newConversationBtn').addEventListener('click', onNewConversation);
        chatSend.addEventListener('click', onSendButton);
        if (chatStop) chatStop.addEventListener('click', cancelActiveStream);
        if (chatQueueClearEl) chatQueueClearEl.addEventListener('click', clearQueuedTurn);
        document.addEventListener('click', (e) => {
            const toolButton = e.target.closest('.chat-tool-row button');
            const tools = toolButton && toolButton.closest('.chat-tools');
            if (!tools) return;
            setTimeout(() => {
                tools.open = false;
                const summary = tools.querySelector('summary');
                if (summary) summary.focus();
            }, 0);
        });
        if (chatAttach && chatFileInput) {
            chatAttach.addEventListener('click', () => chatFileInput.click());
            chatFileInput.addEventListener('change', () => {
                addFiles(chatFileInput.files);
                chatFileInput.value = '';
            });
        }
        chatInput.addEventListener('paste', (e) => {
            const files = [];
            if (e.clipboardData && e.clipboardData.files) {
                for (const f of e.clipboardData.files) files.push(f);
            }
            if (files.length) addFiles(files);
        });
        chatInput.addEventListener('input', onChatInput);
        chatInput.addEventListener('blur', () => {
            setTimeout(closeMentionPopup, 120);
        });
        chatInput.addEventListener('keydown', (e) => {
            if (mentionIsOpen()) {
                if (e.key === 'ArrowDown') { e.preventDefault(); moveMention(1); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); moveMention(-1); return; }
                if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    selectMention(mentionIndex);
                    return;
                }
                if (e.key === 'Escape') { e.preventDefault(); closeMentionPopup(); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (chatSend.disabled) return;
                sendMessage();
            }
        });

        // Clicking an image inside a chat message opens the same preview
        // lightbox as clicking a thumbnail in the GENERATED widget. Videos
        // use the custom player (play on canvas click, preview via the
        // open-preview button), so player clicks never open the lightbox.
        chatMessagesEl.addEventListener('click', (e) => {
            if (e.target.closest('.jv-player')) return;
            const imgEl = e.target.closest('.md-image');
            if (!imgEl) return;
            if (window.Gallery && typeof window.Gallery.openFromUrl === 'function') {
                e.preventDefault();
                window.Gallery.openFromUrl(imgEl.getAttribute('src'));
            }
        });

        Conversations.onChange(() => {
            renderConversationList();
        });

        autoGrowInput();
    }

    // --- Conversation list rendering ---

    async function refreshConversationList() {
        const conversations = await Conversations.list();
        renderList(conversations);
    }

    function renderConversationList() {
        Conversations.list().then(renderList);
    }

    function renderList(conversations) {
        if (!conversationListEl) return;
        conversationListEl.innerHTML = '';

        const currentId = Conversations.currentId();

        conversations.forEach((conv) => {
            const item = document.createElement('div');
            item.className = 'conv-item' + (conv.id === currentId ? ' active' : '') +
                (conv.private ? ' conv-item--private' : '');
            item.setAttribute('data-id', conv.id);

            const title = document.createElement('div');
            title.className = 'conv-title' + (conv.private ? ' conv-title--blurred' : '');
            title.textContent = conv.title || 'Untitled';
            title.title = conv.private ? 'Private conversation' : (conv.title || 'Untitled');

            // Companion chats (linked to a character) are marked with a small
            // badge so they are distinguishable from ordinary conversations.
            if (conv.characterId) {
                const badge = document.createElement('span');
                badge.className = 'conv-companion-badge';
                badge.textContent = '◆ companion';
                badge.title = 'Companion chat';
                title.appendChild(badge);
            }

            const actions = document.createElement('div');
            actions.className = 'conv-actions';

            const memoryBtn = document.createElement('button');
            memoryBtn.className = 'conv-action conv-action--memory';
            memoryBtn.type = 'button';
            memoryBtn.textContent = '✦';
            memoryBtn.title = 'Manage conversation memory';
            memoryBtn.setAttribute('aria-label', 'Manage conversation memory');
            memoryBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                onManageMemory(conv);
            });

            const lockBtn = document.createElement('button');
            lockBtn.className = 'conv-action conv-action--lock' + (conv.private ? ' active' : '');
            lockBtn.title = conv.private
                ? 'Private — generated media hidden from the gallery'
                : 'Make private — hide generated media from the gallery';
            lockBtn.innerHTML = conv.private
                ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>'
                : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>';
            lockBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                onTogglePrivate(conv);
            });

            const renameBtn = document.createElement('button');
            renameBtn.className = 'conv-action';
            renameBtn.title = 'Rename';
            renameBtn.textContent = '✎';
            renameBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                onRename(conv);
            });

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'conv-action conv-action--danger';
            deleteBtn.title = 'Delete';
            deleteBtn.textContent = '×';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                onDelete(conv);
            });

            actions.appendChild(memoryBtn);
            actions.appendChild(lockBtn);
            actions.appendChild(renameBtn);
            actions.appendChild(deleteBtn);

            item.appendChild(title);
            item.appendChild(actions);
            item.addEventListener('click', () => onSelect(conv.id));

            conversationListEl.appendChild(item);
        });
    }

    async function onSelect(id) {
        if (id === Conversations.currentId()) return;
        const messages = await Conversations.select(id);
        resetReferenceState();
        renderMessages(messages);
    }

    async function onNewConversation() {
        const conv = await Conversations.create();
        resetReferenceState();
        renderMessages([]);
    }

    function resetReferenceState() {
        generatedMetaCache = null;
        charactersMetaCache = null;
        charactersMetaCacheAt = 0;
        pendingReferences = [];
        pendingCharacters = [];
        closeMentionPopup();
        renderAttachments();
    }

    async function onRename(conv) {
        const title = await Dialog.prompt({
            title: 'Rename Conversation',
            value: conv.title || '',
            placeholder: 'Conversation title',
            confirmText: 'Rename'
        });
        if (title === null) return;
        await Conversations.rename(conv.id, title.trim() || conv.title);
    }

    async function onManageMemory(conv) {
        try {
            const response = await fetch('/api/conversations/' + encodeURIComponent(conv.id));
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || 'Could not load conversation memory.');
            const memory = await Dialog.prompt({
                title: 'Conversation Memory',
                message: 'JARVIS keeps a short local memory of useful details as this chat grows. Review, edit, or clear it here. Press Ctrl+Enter to save.',
                value: typeof data.summary === 'string' ? data.summary : '',
                placeholder: 'No saved memory yet',
                multiline: true,
                confirmText: 'Save memory'
            });
            if (memory === null) return;
            const saved = await fetch('/api/conversations/' + encodeURIComponent(conv.id), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ summary: memory })
            });
            const result = await saved.json().catch(() => ({}));
            if (!saved.ok) throw new Error(result.error || 'Could not save conversation memory.');
        } catch (err) {
            await Dialog.alert({ title: 'Conversation Memory', message: err.message });
        }
    }

    // Toggle the conversation's private/locked state; private conversations
    // hide their generated media from the shared gallery widget.
    async function onTogglePrivate(conv) {
        await Conversations.setPrivate(conv.id, !conv.private);
        if (window.Gallery && window.Gallery.refresh) window.Gallery.refresh();
    }

    async function onDelete(conv) {
        const confirmed = await Dialog.confirm({
            title: 'Delete Conversation',
            message: 'Delete "' + (conv.title || 'Untitled') + '" and all its messages?',
            confirmText: 'Delete',
            danger: true
        });
        if (!confirmed) {
            return;
        }
        await Conversations.remove(conv.id);
        if (window.Gallery && window.Gallery.refresh) window.Gallery.refresh();
        const conversations = await Conversations.list();
        if (conversations.length > 0) {
            const messages = await Conversations.select(conversations[0].id);
            renderMessages(messages);
        } else {
            renderMessages([]);
        }
    }

    // --- Attachments ---

    function addFiles(fileList) {
        const files = Array.from(fileList || []);
        for (const file of files) {
            if (pendingAttachments.length >= ATTACH_MAX) break;
            if (!ATTACH_MIME[file.type]) continue;
            if (file.size > attachMaxBytes(file.type) || !file.size) continue;
            readFileAsAttachment(file);
        }
    }

    function readFileAsAttachment(file) {
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = String(reader.result || '');
            const comma = dataUrl.indexOf(',');
            const base64 = comma === -1 ? '' : dataUrl.slice(comma + 1);
            if (!base64) return;
            if (pendingAttachments.length >= ATTACH_MAX) return;
            pendingAttachments.push({
                id: 'att-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8),
                name: file.name || 'image',
                mime: file.type,
                dataUrl,
                base64
            });
            renderAttachments();
        };
        reader.readAsDataURL(file);
    }

    function removeAttachment(id) {
        pendingAttachments = pendingAttachments.filter((a) => a.id !== id);
        renderAttachments();
    }

    function clearAttachments() {
        pendingAttachments = [];
        renderAttachments();
    }

    function renderAttachments() {
        if (!chatAttachmentsEl) return;
        chatAttachmentsEl.innerHTML = '';
        if (!pendingAttachments.length && !pendingReferences.length && !pendingVideoReferences.length && !pendingCharacters.length) {
            chatAttachmentsEl.style.display = 'none';
            return;
        }
        chatAttachmentsEl.style.display = 'flex';

        // Character chips come first: they are the identity, not a file
        // reference. Removing one also removes its "@Name" token from the input.
        pendingCharacters.forEach((character, index) => {
            const item = document.createElement('div');
            item.className = 'chat-attachment chat-attachment--character';
            if (character.imageUrl) {
                const img = document.createElement('img');
                img.className = 'chat-attachment-thumb chat-attachment-thumb--round';
                img.src = character.imageUrl;
                img.alt = character.name;
                item.appendChild(img);
            }
            const badge = document.createElement('span');
            badge.className = 'chat-attachment-badge chat-attachment-badge--char';
            badge.textContent = '@' + character.name;
            badge.title = 'Character: ' + character.name;
            const btn = document.createElement('button');
            btn.className = 'chat-attachment-remove';
            btn.type = 'button';
            btn.textContent = '×';
            btn.title = 'Remove character';
            btn.addEventListener('click', () => removeCharacter(index + 1));
            item.appendChild(badge);
            item.appendChild(btn);
            chatAttachmentsEl.appendChild(item);
        });

        pendingReferences.forEach((reference, index) => {
            const item = document.createElement('div');
            item.className = 'chat-attachment chat-attachment--reference';
            const img = document.createElement('img');
            img.className = 'chat-attachment-thumb';
            img.src = reference.url;
            img.alt = reference.filename;
            const badge = document.createElement('span');
            badge.className = 'chat-attachment-badge';
            badge.textContent = '@' + (index + 1);
            badge.title = 'Reference image ' + (index + 1);
            const btn = document.createElement('button');
            btn.className = 'chat-attachment-remove';
            btn.type = 'button';
            btn.textContent = '×';
            btn.title = 'Remove reference';
            btn.addEventListener('click', () => removeReference(index + 1));
            item.appendChild(img);
            item.appendChild(badge);
            item.appendChild(btn);
            chatAttachmentsEl.appendChild(item);
        });

        // Video references follow image references: each is a replacement source
        // clip, rendered with a play glyph instead of a thumbnail image.
        pendingVideoReferences.forEach((reference, index) => {
            const item = document.createElement('div');
            item.className = 'chat-attachment chat-attachment--reference';
            const thumb = document.createElement('span');
            thumb.className = 'chat-attachment-thumb chat-attachment-thumb--video';
            thumb.textContent = '▶';
            const badge = document.createElement('span');
            badge.className = 'chat-attachment-badge';
            badge.textContent = '@video' + (index + 1);
            badge.title = 'Source video ' + (index + 1) + ' for replacement';
            const btn = document.createElement('button');
            btn.className = 'chat-attachment-remove';
            btn.type = 'button';
            btn.textContent = '×';
            btn.title = 'Remove video reference';
            btn.addEventListener('click', () => removeVideoReference(index + 1));
            item.appendChild(thumb);
            item.appendChild(badge);
            item.appendChild(btn);
            chatAttachmentsEl.appendChild(item);
        });

        pendingAttachments.forEach((a) => {
            const item = document.createElement('div');
            item.className = 'chat-attachment';
            if (isVideoMime(a.mime)) {
                const thumb = document.createElement('span');
                thumb.className = 'chat-attachment-thumb chat-attachment-thumb--video';
                thumb.textContent = '▶';
                item.appendChild(thumb);
                const badge = document.createElement('span');
                badge.className = 'chat-attachment-badge';
                badge.textContent = 'video';
                badge.title = 'Attached source video for replacement';
                item.appendChild(badge);
            } else {
                const img = document.createElement('img');
                img.className = 'chat-attachment-thumb';
                img.src = a.dataUrl;
                img.alt = a.name;
                item.appendChild(img);
            }
            const btn = document.createElement('button');
            btn.className = 'chat-attachment-remove';
            btn.type = 'button';
            btn.textContent = '×';
            btn.title = 'Remove';
            btn.addEventListener('click', () => removeAttachment(a.id));
            item.appendChild(btn);
            chatAttachmentsEl.appendChild(item);
        });

        // A staged source video with no replacement image yet: nudge the user
        // toward the next step of the replacement flow.
        const hasSourceVideo = pendingVideoReferences.length +
            pendingAttachments.filter((a) => isVideoMime(a.mime)).length;
        if (hasSourceVideo && !pendingReferences.length) {
            const hint = document.createElement('div');
            hint.className = 'chat-attachment-hint';
            hint.textContent = pendingVideoReferences.length
                ? 'Add replacement image(s) with @'
                : 'Attached as the source video — add replacement image(s) with @';
            chatAttachmentsEl.appendChild(hint);
        }
    }

    async function uploadAttachments(attachments) {
        const uploaded = [];
        for (const a of attachments || pendingAttachments) {
            const res = await fetch('/api/uploads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: a.name, mime: a.mime, data: a.base64 })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Upload failed');
            uploaded.push(data);
        }
        return uploaded;
    }

    // --- @ character / image picker ---
    //
    // Typing "@" opens a picker of the saved characters (each resolving to its
    // Character Identity Package) followed by the images generated in the
    // current conversation. Selecting a character inserts an "@Name" mention and
    // a chip; the character is sent as a structured id, never as plain prompt
    // text. Selecting an image inserts a numbered @imageN reference, so a prompt
    // can position several references ("make @image1 hold @image2 at @image3").
    // "Create New Character" opens the existing Creative Playground — there is
    // no second character-creation workflow.

    const IDENTITY_STATUS_LABELS = {
        ready: 'Identity Ready',
        generating: 'Identity Generating',
        failed: 'Identity Failed',
        basic: 'Basic Reference',
        none: 'Identity Not Created'
    };

    function autoGrowInput() {
        if (!chatInput) return;
        chatInput.style.height = 'auto';
        const max = 200;
        const next = Math.min(chatInput.scrollHeight, max);
        chatInput.style.height = next + 'px';
        chatInput.style.overflowY = chatInput.scrollHeight > max ? 'auto' : 'hidden';
        if (chatMentionPopup) {
            const bar = chatInput.closest('.chat-input-bar');
            const barH = bar ? bar.offsetHeight : chatInput.offsetHeight + 28;
            chatMentionPopup.style.bottom = (barH + 2) + 'px';
        }
    }

    function onChatInput() {
        autoGrowInput();
        const caret = chatInput.selectionStart;
        if (caret === null || caret === undefined) return;
        const before = chatInput.value.slice(0, caret);
        const match = before.match(/(?:^|\s)@([^\s@]*)$/);
        if (!match) {
            closeMentionPopup();
            return;
        }
        openMentionPopup(match[1]);
    }

    function mentionIsOpen() {
        return chatMentionPopup && !chatMentionPopup.hidden && mentionItems.length > 0;
    }

    function closeMentionPopup() {
        mentionToken += 1;
        mentionItems = [];
        mentionIndex = 0;
        if (chatMentionPopup) {
            chatMentionPopup.hidden = true;
            chatMentionPopup.innerHTML = '';
        }
    }

    // Scan the rendered conversation for generated/uploaded image + video links
    // (newest first) as a fallback when the asset-registry endpoint is
    // unavailable.
    function domConversationAssets() {
        if (!chatMessagesEl) return [];
        const seen = new Set();
        const list = [];
        const add = (filename, origin, type) => {
            if (!filename || seen.has(filename)) return;
            seen.add(filename);
            list.push({
                filename,
                origin,
                type,
                url: (origin === 'upload' ? '/images/' : '/generated/') + encodeURIComponent(filename),
                displayName: filename,
                prompt: ''
            });
        };
        chatMessagesEl.querySelectorAll('img.md-image').forEach((img) => {
            const src = String(img.getAttribute('src') || '');
            const isGenerated = src.indexOf('/generated/') !== -1;
            const isUpload = src.indexOf('/images/') !== -1;
            if (!isGenerated && !isUpload) return;
            const decoded = decodeURIComponent(src.split('?')[0]);
            const idx = decoded.lastIndexOf('/');
            const filename = idx === -1 ? decoded : decoded.slice(idx + 1);
            if (!/\.(?:png|jpe?g|webp)$/i.test(filename)) return;
            add(filename, isGenerated ? 'generated' : 'upload', 'image');
        });
        chatMessagesEl.querySelectorAll('video.md-video').forEach((video) => {
            const src = String(video.getAttribute('src') || '');
            const isGenerated = src.indexOf('/generated/') !== -1;
            const isUpload = src.indexOf('/images/') !== -1;
            if (!isGenerated && !isUpload) return;
            const decoded = decodeURIComponent(src.split('?')[0]);
            const idx = decoded.lastIndexOf('/');
            const filename = idx === -1 ? decoded : decoded.slice(idx + 1);
            if (!/\.(?:mp4|webm|mov|m4v|avi|mkv)$/i.test(filename)) return;
            add(filename, isGenerated ? 'generated' : 'upload', 'video');
        });
        return list.reverse();
    }

    // The conversation's media registry (generated + uploaded images/videos),
    // newest first. Prefers the server-side registry so assets are referenced by
    // stable filename (never the label or upload position).
    async function conversationAssets() {
        const currentId = typeof Conversations !== 'undefined' && Conversations.currentId
            ? Conversations.currentId() : null;
        if (currentId) {
            try {
                const res = await fetch('/api/conversations/' + encodeURIComponent(currentId) + '/assets');
                if (res.ok) {
                    const data = await res.json();
                    if (Array.isArray(data.assets) && data.assets.length) {
                        return data.assets.slice().reverse();
                    }
                }
            } catch (e) { /* fall back to the DOM scan */ }
        }
        return domConversationAssets();
    }

    function videoThumbUrl(item) {
        if (item.origin === 'generated') return '/generated/thumb/' + encodeURIComponent(item.filename);
        return '';
    }

    async function generatedMeta() {
        if (generatedMetaCache) return generatedMetaCache;
        try {
            const res = await fetch('/api/generated');
            const data = await res.json();
            generatedMetaCache = data.images || [];
        } catch (e) {
            generatedMetaCache = [];
        }
        return generatedMetaCache;
    }

    // Apply the assistant display name (character name for companion chats) to
    // the composer placeholder, the conversation header and any rendered AI
    // message labels.
    function applyAssistantName(name) {
        assistantDisplayName = name || 'JARVIS';
        if (chatInput) chatInput.placeholder = 'Message ' + assistantDisplayName + '...';
        document.querySelectorAll('.message--ai .message-role').forEach((node) => {
            node.textContent = assistantDisplayName;
        });
    }

    // Resolve the current conversation's character (if any) and update the label.
    async function resolveAssistantName() {
        let name = 'JARVIS';
        try {
            const conversations = await Conversations.list();
            const currentId = Conversations.currentId();
            const conv = conversations.find((c) => c.id === currentId);
            if (conv && conv.characterId) {
                const options = await characterOptions();
                const match = options.find((c) => c.id === conv.characterId);
                if (match && match.name) name = match.name;
            }
        } catch (e) {
            name = 'JARVIS';
        }
        applyAssistantName(name);
    }

    async function characterOptions() {
        if (charactersMetaCache && (Date.now() - charactersMetaCacheAt) < CHARACTERS_CACHE_MS) {
            return charactersMetaCache;
        }
        try {
            const res = await fetch('/api/characters/options');
            const data = await res.json();
            charactersMetaCache = data.characters || [];
        } catch (e) {
            charactersMetaCache = [];
        }
        charactersMetaCacheAt = Date.now();
        return charactersMetaCache;
    }

    async function openMentionPopup(query) {
        const token = ++mentionToken;
        const q = String(query || '').toLowerCase();
        const [characters, meta, assets] = await Promise.all([characterOptions(), generatedMeta(), conversationAssets()]);
        if (token !== mentionToken) return;

        const characterItems = characters
            .filter((c) => !q || String(c.name || '').toLowerCase().indexOf(q) !== -1)
            .map((c) => ({
                kind: 'character',
                id: c.id,
                name: c.name || 'Character',
                url: c.imageUrl || '',
                identityStatus: c.identityStatus || 'none'
            }));

        const enriched = assets.map((a) => {
            let prompt = a.prompt || '';
            if (!prompt && a.type === 'image') {
                const found = meta.find((m) => String(m.file || '').split('?')[0].endsWith('/' + a.filename));
                if (found) prompt = found.prompt || '';
            }
            return Object.assign({}, a, { prompt });
        });
        const matches = (a) => !q || (a.filename + ' ' + a.type + ' ' + (a.prompt || '')).toLowerCase().indexOf(q) !== -1;
        const imageItems = enriched
            .filter((a) => a.type === 'image' && matches(a))
            .map((a) => ({ kind: 'image', filename: a.filename, url: a.url, prompt: a.prompt, origin: a.origin }));
        const videoItems = enriched
            .filter((a) => a.type === 'video' && matches(a))
            .map((a) => ({ kind: 'video', filename: a.filename, url: a.url, prompt: a.prompt, origin: a.origin }));

        mentionItems = characterItems.concat(imageItems, videoItems);
        // "Create New Character" is always offered unless the query clearly
        // filters it out.
        if (!q || 'create new character'.indexOf(q) !== -1 || 'new character'.indexOf(q) !== -1) {
            mentionItems.push({ kind: 'create', name: 'Create New Character' });
        }
        if (!mentionItems.length) {
            closeMentionPopup();
            return;
        }
        mentionIndex = 0;
        renderMentionPopup();
    }

    function renderMentionPopup() {
        chatMentionPopup.innerHTML = '';
        let lastKind = null;
        mentionItems.forEach((item, i) => {
            if (item.kind !== lastKind) {
                const label = item.kind === 'character' ? 'Characters'
                    : (item.kind === 'image' ? 'Images · references'
                        : (item.kind === 'video' ? 'Videos · source' : ''));
                if (label) {
                    const header = document.createElement('div');
                    header.className = 'chat-mention-header';
                    header.textContent = label;
                    chatMentionPopup.appendChild(header);
                }
                lastKind = item.kind;
            }
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'chat-mention-item chat-mention-item--' + item.kind + (i === mentionIndex ? ' active' : '');
            if (item.kind === 'character') {
                row.className = 'chat-mention-character-select';
                row.setAttribute('aria-label', 'Use character ' + item.name);
            }
            if (item.kind === 'create') {
                const plus = document.createElement('span');
                plus.className = 'chat-mention-plus';
                plus.textContent = '+';
                const name = document.createElement('div');
                name.className = 'chat-mention-name';
                name.textContent = 'Create New Character';
                row.appendChild(plus);
                row.appendChild(name);
            } else {
                if (item.kind === 'video') {
                    const thumbUrl = videoThumbUrl(item);
                    if (thumbUrl) {
                        const thumb = document.createElement('img');
                        thumb.className = 'chat-mention-thumb';
                        thumb.src = thumbUrl;
                        thumb.alt = item.filename;
                        thumb.addEventListener('error', () => {
                            const ph = document.createElement('span');
                            ph.className = 'chat-mention-thumb chat-mention-thumb--placeholder';
                            ph.textContent = '▶';
                            thumb.replaceWith(ph);
                        }, { once: true });
                        row.appendChild(thumb);
                    } else {
                        const ph = document.createElement('span');
                        ph.className = 'chat-mention-thumb chat-mention-thumb--placeholder chat-mention-thumb--video';
                        ph.textContent = '▶';
                        row.appendChild(ph);
                    }
                } else if (item.url) {
                    const thumb = document.createElement('img');
                    thumb.className = 'chat-mention-thumb' + (item.kind === 'character' ? ' chat-mention-thumb--round' : '');
                    thumb.src = item.url;
                    thumb.alt = item.name || item.filename;
                    // A missing/unreachable preview falls back to the neutral
                    // avatar placeholder instead of a broken-image icon.
                    thumb.addEventListener('error', () => {
                        const ph = document.createElement('span');
                        ph.className = 'chat-mention-thumb chat-mention-thumb--placeholder';
                        ph.textContent = (item.name || '?').charAt(0).toUpperCase();
                        thumb.replaceWith(ph);
                    }, { once: true });
                    row.appendChild(thumb);
                } else if (item.kind === 'character') {
                    const ph = document.createElement('span');
                    ph.className = 'chat-mention-thumb chat-mention-thumb--placeholder';
                    ph.textContent = (item.name || '?').charAt(0).toUpperCase();
                    row.appendChild(ph);
                }
                const meta = document.createElement('div');
                meta.className = 'chat-mention-meta';
                const name = document.createElement('div');
                name.className = 'chat-mention-name';
                name.textContent = item.kind === 'character' ? item.name : item.filename;
                meta.appendChild(name);
                if (item.kind === 'character') {
                    const status = document.createElement('div');
                    status.className = 'chat-mention-status chat-mention-status--' + (item.identityStatus || 'none');
                    status.textContent = IDENTITY_STATUS_LABELS[item.identityStatus] || 'Identity Not Created';
                    meta.appendChild(status);
                } else {
                    const prompt = document.createElement('div');
                    prompt.className = 'chat-mention-prompt';
                    prompt.textContent = item.prompt || (item.kind === 'video'
                        ? 'Source video · add replacement image(s) with @'
                        : (item.origin === 'upload' ? 'Uploaded image' : 'Generated image'));
                    meta.appendChild(prompt);
                }
                row.appendChild(meta);
            }
            row.addEventListener('mousedown', (e) => {
                e.preventDefault();
                selectMention(i);
            });
            row.addEventListener('mouseenter', () => {
                mentionIndex = i;
                updateMentionActive();
            });
            if (item.kind === 'character') {
                const group = document.createElement('div');
                group.className = 'chat-mention-item chat-mention-item--character chat-mention-character-row' + (i === mentionIndex ? ' active' : '');
                group.addEventListener('mouseenter', () => {
                    mentionIndex = i;
                    updateMentionActive();
                });
                const sheet = document.createElement('button');
                sheet.type = 'button';
                sheet.className = 'chat-mention-sheet';
                sheet.textContent = 'Sheet';
                sheet.title = 'Open ' + item.name + ' Character Sheet';
                sheet.setAttribute('aria-label', 'Open ' + item.name + ' Character Sheet');
                sheet.addEventListener('mousedown', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                });
                sheet.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    mentionToken += 1;
                    closeMentionPopup();
                    if (window.CharacterIdentityUI && typeof window.CharacterIdentityUI.open === 'function') {
                        window.CharacterIdentityUI.open(item.id);
                    }
                });
                group.appendChild(row);
                group.appendChild(sheet);
                chatMentionPopup.appendChild(group);
            } else {
                chatMentionPopup.appendChild(row);
            }
        });
        // When the conversation has video(s), explain the replacement flow
        // inline so the feature is discoverable from the picker itself.
        if (mentionItems.some((entry) => entry.kind === 'video')) {
            const tip = document.createElement('div');
            tip.className = 'chat-mention-tip';
            tip.textContent = 'To edit a video: select the video, then the replacement image(s), and say "replace the people".';
            chatMentionPopup.appendChild(tip);
        }
        chatMentionPopup.hidden = false;
        updateMentionActive();
        if (mentionItems.length) {
            requestAnimationFrame(() => chatInput.focus());
        }
    }

    function updateMentionActive() {
        if (!chatMentionPopup) return;
        const rows = chatMentionPopup.querySelectorAll('.chat-mention-item');
        rows.forEach((row, i) => row.classList.toggle('active', i === mentionIndex));
        const active = rows[mentionIndex];
        if (active && typeof active.scrollIntoView === 'function') {
            active.scrollIntoView({ block: 'nearest' });
        }
    }

    function moveMention(delta) {
        if (!mentionItems.length) return;
        mentionIndex = (mentionIndex + delta + mentionItems.length) % mentionItems.length;
        updateMentionActive();
    }

    function selectMention(index) {
        const item = mentionItems[index];
        if (!item) return;
        if (item.kind === 'create') {
            closeMentionPopup();
            if (window.PlaygroundUI && typeof window.PlaygroundUI.open === 'function') {
                window.PlaygroundUI.open();
            }
            return;
        }
        const caret = chatInput.selectionStart || 0;
        // Replace the in-progress "@query" token with the chosen mention. A
        // character becomes "@Name"; an image becomes a numbered @imageN token
        // so the prompt keeps the reference's position.
        const before = chatInput.value
            .slice(0, caret)
            .replace(/(?:^|\s)@[^\s@]*$/, (match) => (match.charAt(0) === '@' ? '' : ' '));
        const after = chatInput.value.slice(caret);
        const token = item.kind === 'character'
            ? '@' + item.name
            : (item.kind === 'video'
                ? '@video' + (pendingVideoReferences.length + 1)
                : '@image' + (pendingReferences.length + 1));
        // Follow the inserted mention with a space so the user can keep typing,
        // unless the text already starts with whitespace.
        const spacer = after && /^\s/.test(after) ? '' : ' ';
        chatInput.value = before + token + spacer + after;
        const pos = before.length + token.length + spacer.length;
        if (typeof chatInput.setSelectionRange === 'function') chatInput.setSelectionRange(pos, pos);
        autoGrowInput();
        if (item.kind === 'character') addCharacter(item);
        else if (item.kind === 'video') addVideoReference(item);
        else addReference(item);
        closeMentionPopup();
        chatInput.focus();
    }

    function addReference(item) {
        pendingReferences.push(item);
        renderAttachments();
    }

    function addVideoReference(item) {
        pendingVideoReferences.push(item);
        renderAttachments();
    }

    // --- Guided media-reference staging -------------------------------------
    //
    // Used by the per-asset "Replace People" action and by "Use as Replacement"
    // so a video edit can be built up in the composer without the user manually
    // typing @ tokens: the source video reference is inserted with a starting
    // instruction, then replacement images are added with the picker.

    function referenceUrlOf(item) {
        const filename = item && item.filename;
        if (!filename) return '';
        if (item.url) return item.url;
        const origin = item.origin === 'upload' ? 'images' : 'generated';
        return '/' + origin + '/' + encodeURIComponent(filename);
    }

    function ensureVideoReference(item) {
        const filename = item && item.filename;
        if (!filename) return -1;
        let idx = pendingVideoReferences.findIndex((v) => v.filename === filename);
        if (idx === -1) {
            const url = referenceUrlOf(item);
            pendingVideoReferences.push({
                kind: 'video',
                filename,
                url,
                origin: item.origin || (url.indexOf('/images/') === 0 ? 'upload' : 'generated')
            });
            idx = pendingVideoReferences.length - 1;
        }
        return idx;
    }

    function ensureImageReference(item) {
        const filename = item && item.filename;
        if (!filename) return -1;
        let idx = pendingReferences.findIndex((r) => r.filename === filename);
        if (idx === -1) {
            const url = referenceUrlOf(item);
            pendingReferences.push({
                kind: 'image',
                filename,
                url,
                origin: item.origin || (url.indexOf('/images/') === 0 ? 'upload' : 'generated'),
                prompt: item.prompt || ''
            });
            idx = pendingReferences.length - 1;
        }
        return idx;
    }

    // Insert a token at the end of the composer, seeding a starting phrase on
    // an empty input so the user always sees the intended shape of the request.
    function insertTokenAtEnd(token, seedPhrase) {
        const existing = String(chatInput.value || '');
        const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const already = new RegExp('(^|\\s)' + escaped + '(?![\\w])').test(' ' + existing);
        if (!already) {
            if (!existing.trim()) {
                chatInput.value = (seedPhrase || '') + token + (seedPhrase ? ' with ' : ' ');
            } else {
                chatInput.value = existing.replace(/\s+$/, '') + ' ' + token + ' ';
            }
        }
        autoGrowInput();
        renderAttachments();
        chatInput.focus();
        const pos = chatInput.value.length;
        if (typeof chatInput.setSelectionRange === 'function') chatInput.setSelectionRange(pos, pos);
    }

    // Stage a source video for a character-replacement edit.
    function stageReplacement(item) {
        const idx = ensureVideoReference(item);
        if (idx === -1) return;
        insertTokenAtEnd('@video' + (idx + 1), 'Replace the people in ');
    }

    // Stage an image as a replacement identity for an in-progress edit.
    function stageReplacementImage(item) {
        const idx = ensureImageReference(item);
        if (idx === -1) return;
        insertTokenAtEnd('@image' + (idx + 1), '');
    }

    function addCharacter(item) {
        if (!item || !item.id) return;
        if (pendingCharacters.some((c) => c.id === item.id)) return;
        pendingCharacters.push({ id: item.id, name: item.name || 'Character', imageUrl: item.url || '' });
        renderAttachments();
    }

    function escapeRegExp(value) {
        return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Remove a character chip and its "@Name" token from the input. The name is
    // matched exactly (case-insensitive) so a partial word is never mangled.
    function removeCharacter(n) {
        if (n < 1 || n > pendingCharacters.length) return;
        const removed = pendingCharacters.splice(n - 1, 1)[0];
        if (removed && removed.name) {
            chatInput.value = chatInput.value
                .replace(new RegExp('\\s*@' + escapeRegExp(removed.name) + '(?![\\w@])', 'i'), ' ')
                .replace(/[ \t]{2,}/g, ' ')
                .replace(/^\s+/, '');
        }
        autoGrowInput();
        renderAttachments();
    }

    function removeReference(n) {
        if (n < 1 || n > pendingReferences.length) return;
        pendingReferences.splice(n - 1, 1);
        // Drop the token and renumber the ones that followed it so the
        // remaining @imageN tokens stay contiguous.
        chatInput.value = chatInput.value
            .replace(new RegExp('\\s*@image' + n + '\\b', 'gi'), '')
            .replace(/@image\s*(\d+)\b/gi, (match, d) => (Number(d) > n ? '@image' + (Number(d) - 1) : match));
        autoGrowInput();
        renderAttachments();
    }

    function removeVideoReference(n) {
        if (n < 1 || n > pendingVideoReferences.length) return;
        pendingVideoReferences.splice(n - 1, 1);
        // Drop the token and renumber the ones that followed it.
        chatInput.value = chatInput.value
            .replace(new RegExp('\\s*@video' + n + '\\b', 'gi'), '')
            .replace(/@video\s*(\d+)\b/gi, (match, d) => (Number(d) > n ? '@video' + (Number(d) - 1) : match));
        autoGrowInput();
        renderAttachments();
    }

    function clearReferences() {
        pendingReferences = [];
        pendingVideoReferences = [];
        pendingCharacters = [];
        renderAttachments();
    }

    // Replace inline @imageN tokens with numbered markdown images so the
    // reference order survives into the persisted message. The backend rewrites
    // them back to positional wording ("image 1", "image 2") for the editor.
    // A single reference keeps the legacy shape (plain instruction + the image
    // appended as an unnumbered `![reference]`), so the editor is not told to
    // "edit image 1" unnecessarily. Numbered positions are only used for 2+.
    function materializeReferenceText(text, references) {
        if (!references.length) return text;
        if (references.length === 1) {
            const ref = references[0];
            const plain = String(text || '')
                .replace(/@image\s*\d+\b/gi, ' ')
                .replace(/\s{2,}/g, ' ')
                .trim();
            return plain
                ? plain + '\n\n![reference](' + ref.url + ')'
                : '![reference](' + ref.url + ')';
        }
        const used = new Set();
        let out = String(text || '').replace(/@image\s*(\d+)\b/gi, (match, n) => {
            const idx = Number(n) - 1;
            const ref = references[idx];
            if (!ref) return match;
            used.add(idx);
            return '![reference ' + (idx + 1) + '](' + ref.url + ')';
        });
        references.forEach((ref, idx) => {
            if (used.has(idx)) return;
            out += (out ? '\n\n' : '') + '![reference ' + (idx + 1) + '](' + ref.url + ')';
        });
        return out;
    }

    // --- Message rendering ---

    // Group an upscaled image with its original so they render as a single
    // comparison card instead of two stacked images. Returns { original,
    // upscaled } when the two markdown image URLs look like an upscaled pair
    // (same hex prefix, exactly one carries the "_up_" marker), else null.
    // Image-only: a video upscale reply embeds just the upscaled clip (the
    // original stays in the gallery for side-by-side video comparison), so
    // videos never pair in chat.
    function pairMatch(a, b) {
        if (/\.(mp4|webm|mov|avi)(\?.*)?$/i.test(String(a || '')) ||
            /\.(mp4|webm|mov|avi)(\?.*)?$/i.test(String(b || ''))) return null;
        const nameA = lastSegment(a);
        const nameB = lastSegment(b);
        let up, orig;
        if (nameA.indexOf('_up_') !== -1 && nameB.indexOf('_up_') === -1) {
            up = nameA; orig = nameB;
        } else if (nameB.indexOf('_up_') !== -1 && nameA.indexOf('_up_') === -1) {
            up = nameB; orig = nameA;
        } else {
            return null;
        }
        const ext = (n) => n.lastIndexOf('.') === -1 ? '' : n.slice(n.lastIndexOf('.')).toLowerCase();
        if (ext(nameA) !== ext(nameB)) return null;
        if (up.split('_up_')[0] !== orig.split('_')[0]) return null;
        const originalUrl = up === nameA ? b : a;
        const upscaledUrl = up === nameA ? a : b;
        return { original: originalUrl, upscaled: upscaledUrl };
    }

    function lastSegment(src) {
        const decoded = decodeURIComponent(String(src || ''));
        const idx = decoded.lastIndexOf('/');
        return idx === -1 ? decoded : decoded.slice(idx + 1);
    }

    // When an original + upscaled pair is rendered, keep only the upscaled image
    // and drop its original so it shows exactly like any other chat image (same
    // md-image styling, no compare container). The original is only reachable
    // through the compare overlay opened from the image's preview lightbox.
    function collapseUpscalePairs(container) {
        const images = Array.from(container.querySelectorAll('img.md-image'));
        if (images.length < 2) return;

        const used = new Set();
        for (let i = 0; i < images.length; i++) {
            const imgA = images[i];
            if (used.has(imgA)) continue;
            for (let j = i + 1; j < images.length; j++) {
                const imgB = images[j];
                if (used.has(imgB)) continue;
                const pair = pairMatch(imgA.getAttribute('src'), imgB.getAttribute('src'));
                if (!pair) continue;

                const upscaledImg = (pair.upscaled === imgA.getAttribute('src')) ? imgA : imgB;
                const originalImg = (upscaledImg === imgA) ? imgB : imgA;

                const originalP = originalImg.closest('p');
                if (originalP) originalP.remove();

                // Drop now-empty paragraphs (blank separators) left behind.
                Array.from(container.querySelectorAll('p')).forEach((p) => {
                    if (!p.textContent.trim() && p !== upscaledImg.closest('p')) p.remove();
                });
                // Drop the "Original:" / "Upscaled:" label paragraphs around the pair.
                Array.from(container.querySelectorAll('p')).forEach((p) => {
                    if (/^(Original|Upscaled|Before|After):\s*$/i.test(p.textContent) && !p.querySelector('img')) p.remove();
                });
                used.add(imgA);
                used.add(imgB);
                break;
            }
        }
    }

    // Collapse a generated prompt to a couple of lines with a "Show more"
    // toggle, exactly like image prompts — video prompts (H3 / Creator Studio)
    // included. A long prompt can span several markdown paragraphs because blank
    // lines each become a paragraph, so the whole block from the "**Prompt:**"
    // label up to the generated media is collapsed together.
    function attachGeneratedPromptDisclosure(container) {
        if (!container.querySelector('img.md-image, video')) return;
        const paragraphs = Array.from(container.querySelectorAll('p.md-paragraph'));
        paragraphs.forEach((paragraph) => {
            const label = paragraph.querySelector('strong');
            if (!label || label.textContent.trim().toLowerCase() !== 'prompt:') return;
            const siblings = Array.from(paragraph.parentNode.children);
            const startIndex = siblings.indexOf(paragraph);
            const block = [];
            let followsMedia = false;
            for (let i = startIndex; i < siblings.length; i++) {
                const element = siblings[i];
                const isMedia = element !== paragraph && element.querySelector
                    && (element.querySelector('img.md-image') || element.matches('video'));
                if (isMedia) { followsMedia = true; break; }
                // Everything from the label up to the media belongs to the
                // prompt, including markdown lists and code blocks.
                block.push(element);
            }
            if (!followsMedia || !block.length) return;

            // Wrap the whole prompt block so the height limit applies to the
            // block as a whole (a few lines), not a couple of lines per paragraph.
            const wrapper = document.createElement('div');
            wrapper.className = 'chat-generated-prompt chat-generated-prompt--collapsed';
            block[0].parentNode.insertBefore(wrapper, block[0]);
            block.forEach((element) => wrapper.appendChild(element));

            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'chat-generated-prompt-toggle';
            toggle.textContent = 'Show more';
            toggle.setAttribute('aria-expanded', 'false');
            toggle.addEventListener('click', () => {
                const expanded = !wrapper.classList.contains('chat-generated-prompt--expanded');
                wrapper.classList.toggle('chat-generated-prompt--expanded', expanded);
                wrapper.classList.toggle('chat-generated-prompt--collapsed', !expanded);
                toggle.textContent = expanded ? 'Show less' : 'Show more';
                toggle.setAttribute('aria-expanded', String(expanded));
            });
            wrapper.insertAdjacentElement('afterend', toggle);
            if (wrapper.scrollHeight <= wrapper.clientHeight + 1) toggle.hidden = true;
        });
    }

    // Render assistant markdown into a content element and collapse any
    // original + upscaled image pairs (keeping just the upscaled image).
    // Videos are handed to the custom VideoPlayer synchronously so the
    // conversation message never depends on observer timing.
    // options.streaming: a partial reply being streamed token-by-token. The
    // markdown is rendered, but the expensive DOM passes (upscale-pair pairing,
    // video scanning, card/suggestion attachment) are skipped — they only matter
    // for a complete message and, run on every frame, saturate the main thread.
    function setAiContent(contentEl, markdown, options) {
        const streaming = Boolean(options && options.streaming);
        // Director cards are persisted as a [[director:{...}]] marker inside the
        // markdown. Pull them out before parsing, then render the interactive
        // card after the content (image/video) so it behaves across reloads.
        const parsed = (window.DirectorUI && typeof window.DirectorUI.extract === 'function')
            ? window.DirectorUI.extract(markdown)
            : { text: markdown, cards: [] };
        // Long Video Director storyboards persist as a [[longvideo:{...}]] marker
        // and render as their own card with the beat list + stage progress.
        const longParsed = (window.LongVideoUI && typeof window.LongVideoUI.extract === 'function')
            ? window.LongVideoUI.extract(parsed.text)
            : { text: parsed.text, cards: [] };
        // A suggested prompt (prompt-writing / ideation reply) is persisted with
        // a [[prompt-suggestion]] marker. Strip it, then offer quick generation
        // cards beneath the code block that holds the prompt.
        const suggestion = (window.ChatSuggestions && typeof window.ChatSuggestions.extract === 'function')
            ? window.ChatSuggestions.extract(longParsed.text)
            : { text: longParsed.text, suggested: false };
        // Creative Playground concepts persist as a [[playground:{...}]] marker
        // and render as an interactive concept card.
        const playgroundParsed = (window.PlaygroundUI && typeof window.PlaygroundUI.extract === 'function')
            ? window.PlaygroundUI.extract(suggestion.text)
            : { text: suggestion.text, cards: [] };
        // UGC Studio projects persist as a [[ugc:{...}]] marker and render as the
        // interactive workflow card (product/creator/brief/script/scenes/refs).
        const ugcParsed = (window.UGCUI && typeof window.UGCUI.extract === 'function')
            ? window.UGCUI.extract(playgroundParsed.text)
            : { text: playgroundParsed.text, cards: [] };
        // Creator Studio opening-frame approval persists as a [[creator-frame:...]]
        // marker and renders as an interactive card (Create Video / Regenerate).
        const creatorFrameParsed = (window.CreatorStudioUI && typeof window.CreatorStudioUI.extract === 'function')
            ? window.CreatorStudioUI.extract(ugcParsed.text)
            : { text: ugcParsed.text, cards: [] };
        // A video-replacement confirmation persists as a [[replacement:{...}]]
        // marker and renders as a one-click mapping card.
        const replacementParsed = (window.ReplacementUI && typeof window.ReplacementUI.extract === 'function')
            ? window.ReplacementUI.extract(creatorFrameParsed.text)
            : { text: creatorFrameParsed.text, cards: [] };
        // Companion photos persist a [[photo-actions]] marker; strip it, then
        // attach follow-up actions (another photo / back camera / video) below.
        const photoParsed = (window.PhotoActions && typeof window.PhotoActions.extract === 'function')
            ? window.PhotoActions.extract(replacementParsed.text)
            : { text: replacementParsed.text, active: false };
        contentEl.innerHTML = Markdown.parse(photoParsed.text);
        if (streaming) return;
        collapseUpscalePairs(contentEl);
        attachGeneratedPromptDisclosure(contentEl);
        if (window.VideoPlayer && typeof window.VideoPlayer.scan === 'function') {
            window.VideoPlayer.scan(contentEl);
        }
        if (suggestion.suggested && window.ChatSuggestions && typeof window.ChatSuggestions.attach === 'function') {
            window.ChatSuggestions.attach(contentEl);
        }
        if (window.DirectorUI && typeof window.DirectorUI.render === 'function') {
            parsed.cards.forEach((card) => window.DirectorUI.render(contentEl, card));
        }
        if (window.LongVideoUI && typeof window.LongVideoUI.render === 'function') {
            longParsed.cards.forEach((card) => window.LongVideoUI.render(contentEl, card));
        }
        if (window.PlaygroundUI && typeof window.PlaygroundUI.render === 'function') {
            playgroundParsed.cards.forEach((card) => window.PlaygroundUI.render(contentEl, card));
        }
        if (window.UGCUI && typeof window.UGCUI.render === 'function') {
            ugcParsed.cards.forEach((card) => window.UGCUI.render(contentEl, card));
        }
        if (window.CreatorStudioUI && typeof window.CreatorStudioUI.render === 'function') {
            creatorFrameParsed.cards.forEach((card) => window.CreatorStudioUI.render(contentEl, card));
        }
        if (window.ReplacementUI && typeof window.ReplacementUI.render === 'function') {
            replacementParsed.cards.forEach((card) => window.ReplacementUI.render(contentEl, card));
        }
        if (photoParsed.active && window.PhotoActions && typeof window.PhotoActions.attach === 'function') {
            window.PhotoActions.attach(contentEl);
        }
        // Each generated asset gets its own next-action card (upscale / modify /
        // generate video). Companion photos already carry their own action row,
        // so the generic card skips the duplicate video action for them.
        if (window.AssetActions && typeof window.AssetActions.attach === 'function') {
            window.AssetActions.attach(contentEl, { companion: photoParsed.active });
        }
    }

    // Scroll the message pane only when the streaming element actually belongs
    // to the conversation on screen, so a background stream can never scroll
    // (or render into) a different conversation. Respect the user's position:
    // once they scroll up to read, stop pinning them to the bottom (and skip the
    // layout-forcing write entirely).
    function scrollActiveStream(el) {
        if (!el || !chatMessagesEl.contains(el)) return;
        const distance = chatMessagesEl.scrollHeight - chatMessagesEl.scrollTop - chatMessagesEl.clientHeight;
        if (distance > 120) return;
        chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    }

    // Coalesce streamed-token renders to at most one every STREAM_RENDER_MIN_MS
    // (trailing edge). The old path rebuilt the entire message (Markdown.parse +
    // innerHTML + media rescan + forced reflow) for every token, which is O(n^2)
    // and froze the tab on long replies. Only the latest pending state is
    // rendered, and the rate cap keeps the main thread responsive on any reply
    // length. Works in background tabs too (the final `done` render is exact).
    const STREAM_RENDER_MIN_MS = 80;
    let streamRenderHandle = null;
    let streamRenderState = null;
    let streamRenderLastAt = 0;

    function applyStreamRender() {
        const state = streamRenderState;
        streamRenderState = null;
        if (!state) return;
        setAiContent(state.contentEl, state.markdown, { streaming: true });
        scrollActiveStream(state.el);
    }

    function scheduleStreamRender(contentEl, markdown, el) {
        streamRenderState = { contentEl, markdown, el };
        if (streamRenderHandle !== null) return;
        const delay = Math.max(0, STREAM_RENDER_MIN_MS - (Date.now() - streamRenderLastAt));
        streamRenderHandle = setTimeout(() => {
            streamRenderHandle = null;
            streamRenderLastAt = Date.now();
            applyStreamRender();
        }, delay);
    }

    function flushStreamRender() {
        if (streamRenderHandle !== null) {
            clearTimeout(streamRenderHandle);
            streamRenderHandle = null;
        }
        applyStreamRender();
    }

    function cancelStreamRender() {
        if (streamRenderHandle !== null) {
            clearTimeout(streamRenderHandle);
            streamRenderHandle = null;
        }
        streamRenderState = null;
    }

    function renderMessages(messages) {
        chatMessagesEl.innerHTML = '';

        // Keep the assistant label in sync with the conversation (companion vs
        // ordinary chat). Fire-and-forget; applyAssistantName updates the DOM.
        resolveAssistantName();

        if (!messages || messages.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'chat-empty';
            const title = document.createElement('h2');
            title.textContent = 'What would you like to work on?';
            const hint = document.createElement('p');
            hint.textContent = 'Chat naturally, ask about your system, or create something.';
            const suggestions = document.createElement('div');
            suggestions.className = 'chat-starters';
            [
                'What can you help me with?',
                'How is my GPU doing?',
                'Generate an image of a tiny cabin in a snowy forest'
            ].forEach((text) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'chat-starter';
                button.textContent = text;
                button.addEventListener('click', () => {
                    chatInput.value = text;
                    autoGrowInput();
                    chatInput.focus();
                });
                suggestions.appendChild(button);
            });
            empty.appendChild(title);
            empty.appendChild(hint);
            empty.appendChild(suggestions);
            chatMessagesEl.appendChild(empty);
        } else {
            messages.forEach((m) => {
                addMessageDom(m.role, m.content, m.id);
            });
        }

        // Re-attach the live streaming message when its conversation is
        // re-opened mid-generation, so the "generating" status and any
        // streamed content survive a conversation switch.
        if (activeMessageEl && activeMessageConversationId === Conversations.currentId()) {
            const empty = chatMessagesEl.querySelector('.chat-empty');
            if (empty) empty.remove();
            chatMessagesEl.appendChild(activeMessageEl);
        }

        if (window.DirectorUI && typeof window.DirectorUI.hydrate === 'function') {
            window.DirectorUI.hydrate(chatMessagesEl, Conversations.currentId());
        }
        if (window.LongVideoUI && typeof window.LongVideoUI.hydrate === 'function') {
            window.LongVideoUI.hydrate(chatMessagesEl, Conversations.currentId());
        }
        if (window.PlaygroundUI && typeof window.PlaygroundUI.hydrate === 'function') {
            window.PlaygroundUI.hydrate(chatMessagesEl, Conversations.currentId());
        }
        if (window.UGCUI && typeof window.UGCUI.hydrate === 'function') {
            window.UGCUI.hydrate(chatMessagesEl, Conversations.currentId());
        }
        if (window.CreatorStudioUI && typeof window.CreatorStudioUI.hydrate === 'function') {
            window.CreatorStudioUI.hydrate(chatMessagesEl, Conversations.currentId());
        }
        if (window.AgentUI && typeof window.AgentUI.hydrate === 'function') {
            window.AgentUI.hydrate(chatMessagesEl, Conversations.currentId());
        }

        chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    }

    function addMessageDom(role, content, messageId) {
        const el = document.createElement('div');
        el.className = 'message message--' + (role === 'assistant' ? 'ai' : 'user');
        if (messageId) el.dataset.messageId = messageId;

        const head = document.createElement('div');
        head.className = 'message-head';

        const roleLabel = document.createElement('div');
        roleLabel.className = 'message-role';
        roleLabel.textContent = role === 'assistant' ? assistantDisplayName : 'USER';
        head.appendChild(roleLabel);

        const contentEl = document.createElement('div');
        contentEl.className = 'message-content';

        // Markdown for AI messages; user messages render as markdown too so
        // attached /images/ uploads display inline (plain text has no images).
        // Escape raw HTML first so pasted markup can't inject elements.
        if (role === 'assistant') {
            setAiContent(contentEl, content);
        } else {
            const esc = document.createElement('div');
            esc.textContent = content;
            contentEl.innerHTML = Markdown.parse(esc.innerHTML);
            // An uploaded video embeds as a real <video>; give it the same
            // custom player the assistant messages use.
            if (window.VideoPlayer && typeof window.VideoPlayer.scan === 'function') {
                window.VideoPlayer.scan(contentEl);
            }
        }

        el.appendChild(head);
        el.appendChild(contentEl);
        chatMessagesEl.appendChild(el);
        if (role === 'assistant' && messageId) attachMessageDelete(head, messageId);

        chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
        return el;
    }

    // --- Delete one assistant response -------------------------------------
    //
    // The server removes the message and, for any generated media only that
    // response referenced, the gallery entry + file. It returns the removed
    // filenames so matching composer @ reference chips are dropped too.

    function attachMessageDelete(head, messageId) {
        if (!head || !messageId || head.querySelector('.message-delete')) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'message-delete';
        button.title = 'Delete response';
        button.setAttribute('aria-label', 'Delete response');
        button.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<polyline points="3 6 5 6 21 6"></polyline>'
            + '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>'
            + '<path d="M10 11v6"></path><path d="M14 11v6"></path>'
            + '<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>';
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            deleteResponse(button, messageId);
        });
        head.appendChild(button);
    }

    async function deleteResponse(button, messageId) {
        const conversationId = Conversations.currentId();
        if (!conversationId || !messageId) return;
        const el = button.closest('.message');
        const hasGenerated = Boolean(el && el.querySelector(
            'img.md-image[src*="/generated/"], video[src*="/generated/"]'
        ));
        const confirmed = typeof Dialog !== 'undefined' && Dialog.confirm
            ? await Dialog.confirm({
                title: 'Delete response',
                message: hasGenerated
                    ? 'Delete this response? Any image or video only this response generated is removed from the gallery.'
                    : 'Delete this response?',
                confirmText: 'Delete',
                danger: true
            })
            : true;
        if (!confirmed) return;
        button.disabled = true;
        let data;
        try {
            data = await Conversations.deleteMessage(conversationId, messageId);
        } catch (err) {
            button.disabled = false;
            if (typeof Dialog !== 'undefined' && Dialog.alert) {
                Dialog.alert({ title: 'Could not delete response', message: err.message || 'Please try again.' });
            }
            return;
        }
        if (el && el.parentNode) el.remove();
        const removedMedia = Array.isArray(data && data.removedMedia) ? data.removedMedia : [];
        if (removedMedia.length) {
            removeReferencesForFiles(removedMedia);
            stripMediaFromMessages(removedMedia);
        }
        generatedMetaCache = null;
        if (window.Gallery) window.Gallery.refresh();
        if (window.AssetActions) {
            if (typeof window.AssetActions.invalidate === 'function') window.AssetActions.invalidate();
            if (typeof window.AssetActions.refresh === 'function') window.AssetActions.refresh();
        }
    }

    // Remove any rendered image/video (and its next-action row) that points at
    // a file the server just deleted, so another message's reference never
    // shows a broken asset. The server drops the same links from persistence.
    function stripMediaFromMessages(filenames) {
        const names = new Set((filenames || []).filter(Boolean));
        if (!names.size) return;
        chatMessagesEl.querySelectorAll('.message-content').forEach((contentEl) => {
            contentEl.querySelectorAll('img.md-image, video').forEach((media) => {
                const src = String(media.getAttribute('src') || media.currentSrc || '');
                let name = src.split('?')[0];
                name = name.slice(name.lastIndexOf('/') + 1);
                try { name = decodeURIComponent(name); } catch (err) { /* keep raw */ }
                if (!names.has(name)) return;
                const holder = media.closest('.jv-player') || media;
                const paragraph = holder.closest('p');
                holder.remove();
                if (paragraph && !paragraph.textContent.trim() && !paragraph.querySelector('img, video')) {
                    paragraph.remove();
                }
            });
            contentEl.querySelectorAll('.asset-action-row').forEach((row) => {
                if (names.has(row.getAttribute('data-asset'))) row.remove();
            });
        });
    }

    // Drop composer @ image/video chips that point at a now-deleted file,
    // renumbering the remaining tokens through the existing remove paths.
    function removeReferencesForFiles(filenames) {
        const names = new Set((filenames || []).filter(Boolean));
        if (!names.size) return;
        for (let i = pendingReferences.length - 1; i >= 0; i -= 1) {
            if (pendingReferences[i] && names.has(pendingReferences[i].filename)) {
                removeReference(i + 1);
            }
        }
        for (let i = pendingVideoReferences.length - 1; i >= 0; i -= 1) {
            if (pendingVideoReferences[i] && names.has(pendingVideoReferences[i].filename)) {
                removeVideoReference(i + 1);
            }
        }
    }

    // --- Send flow ---

    let activeStreamAbort = null;
    let activeQueueId = null;
    let activeTurnId = null;
    let activeQueueActive = false;
    let activeMessageEl = null;
    let activeMessageConversationId = null;
    let queuedTurn = null;

    async function cancelActiveStream() {
        if (typeof VoiceOutput !== 'undefined' && VoiceOutput && typeof VoiceOutput.cancel === 'function') {
            VoiceOutput.cancel();
        }
        if (activeQueueId) {
            try {
                await fetch('/api/queue/cancel', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ queueId: activeQueueId, active: activeQueueActive })
                });
            } catch (e) {}
        } else if (activeTurnId) {
            try {
                await fetch('/api/queue/cancel', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ turnId: activeTurnId })
                });
            } catch (e) {}
        }
        if (activeStreamAbort) {
            try { activeStreamAbort.abort(); } catch (e) {}
        }
    }

    function onSendButton() {
        sendMessage();
    }

    function renderQueuedTurn() {
        if (!chatQueueStatusEl || !chatQueueLabelEl) return;
        chatQueueStatusEl.hidden = !queuedTurn;
        if (!queuedTurn) {
            chatQueueLabelEl.textContent = '';
            if (activeStreamAbort) setSendingState(true);
            return;
        }
        const text = String(queuedTurn.text || 'Message with attachments').replace(/\s+/g, ' ').trim();
        chatQueueLabelEl.textContent = 'Next message: ' + (text.length > 100 ? text.slice(0, 97) + '…' : text);
        if (activeStreamAbort) setSendingState(true);
    }

    function clearQueuedTurn() {
        queuedTurn = null;
        renderQueuedTurn();
    }

    function queueNextTurn(text, attachments, references, videos, characters) {
        if (queuedTurn) {
            if (chatQueueLabelEl) chatQueueLabelEl.textContent = 'A follow-up is already queued. Clear it before adding another.';
            return;
        }
        if (!text && !attachments.length && !references.length && !videos.length && !characters.length) return;
        queuedTurn = {
            text,
            attachments,
            references,
            videos,
            characters,
            conversationId: Conversations.currentId()
        };
        renderQueuedTurn();
        chatInput.value = '';
        autoGrowInput();
        clearAttachments();
        clearReferences();
        chatInput.focus();
    }

    async function sendMessage(options) {
        const override = options && typeof options === 'object' ? options : null;
        if (typeof VoiceInput !== 'undefined' && VoiceInput && typeof VoiceInput.stop === 'function') {
            VoiceInput.stop();
        }
        if (typeof VoiceOutput !== 'undefined' && VoiceOutput && typeof VoiceOutput.cancel === 'function') {
            VoiceOutput.cancel();
        }
        const text = override && typeof override.text === 'string'
            ? override.text.trim()
            : chatInput.value.trim();
        // A Director action is a self-contained turn: drafts are ignored so a
        // pending attachment can never leak into an approval click.
        const attachments = override && Array.isArray(override.attachments)
            ? override.attachments.slice()
            : (override ? [] : pendingAttachments.slice());
        const references = override && Array.isArray(override.references)
            ? override.references.slice()
            : (override ? [] : pendingReferences.slice());
        const videos = override && Array.isArray(override.videos)
            ? override.videos.slice()
            : (override ? [] : pendingVideoReferences.slice());
        const characters = override && Array.isArray(override.characters)
            ? override.characters.slice()
            : (override ? [] : pendingCharacters.slice());
        if (!text && !attachments.length && !references.length && !videos.length && !characters.length) return;

        if (activeStreamAbort) {
            if (override) return;
            queueNextTurn(text, attachments, references, videos, characters);
            return;
        }

        let conversationId = override && override.conversationId
            ? override.conversationId
            : Conversations.currentId();

        // Auto-create a conversation when none is active
        if (!conversationId) {
            const conv = await Conversations.create();
            conversationId = conv.id;
            chatMessagesEl.innerHTML = '';
        }

        // Only image attachments are vision sources; an uploaded video is a
        // media reference (the source clip for character replacement), never a
        // base64 chat image.
        const visionImages = attachments.filter((a) => !isVideoMime(a.mime)).map((a) => a.base64);
        const parts = [];
        // Inline the @imageN tokens as numbered markdown references so the
        // prompt keeps each reference's position for the editor.
        const outgoingText = references.length ? materializeReferenceText(text, references) : text;
        if (outgoingText) parts.push(outgoingText);
        let uploadedVideoFilenames = [];
        if (attachments.length) {
            setSendingState(true);
            try {
                const uploaded = await uploadAttachments(attachments);
                uploaded.forEach((u, i) => {
                    if (u && u.filename && isVideoMime(attachments[i] && attachments[i].mime)) {
                        uploadedVideoFilenames.push(u.filename);
                    }
                });
                parts.push(uploaded.map((u) => '![upload](' + u.url + ')').join('\n'));
            } catch (e) {
                setSendingState(false);
                addMessageDom('ai', 'Upload failed: ' + e.message);
                return;
            }
        }
        const userText = parts.join('\n\n');

        if (Conversations.currentId() === conversationId) addMessageDom('user', userText);
        if (!override) {
            chatInput.value = '';
            autoGrowInput();
            clearAttachments();
            clearReferences();
        }

        // Persist user message to backend (context builder source)
        let userMsg;
        try {
            userMsg = await Conversations.saveUserMessage(conversationId, userText);
        } catch (e) {
            if (Conversations.currentId() === conversationId) addMessageDom('ai', 'Failed to save message: ' + e.message);
            return;
        }

        // Update list order/title
        renderConversationList();

        const provider = getChatProvider();
        const model = getChatModel();
        const think = typeof getReasoningEnabled === 'function' ? getReasoningEnabled() : true;

        setSendingState(true);
        showTypingIndicator(conversationId);

        activeStreamAbort = new AbortController();
        setSendingState(true);
        activeQueueId = null;
        activeTurnId = null;
        activeQueueActive = false;

        try {
            const res = await fetch('/api/chat/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    conversationId,
                    provider,
                    model,
                    think,
                    message: userText || text,
                    images: visionImages,
                    references: references.map((r) => r.filename),
                    videos: videos.map((v) => v.filename).concat(uploadedVideoFilenames),
                    upscaleSource: override && override.upscaleSource ? override.upscaleSource : undefined,
                    characters: characters.map((c) => c.id),
                    directorAction: override && override.directorAction ? override.directorAction : undefined,
                    longVideoAction: override && override.longVideoAction ? override.longVideoAction : undefined,
                    playgroundAction: override && override.playgroundAction ? override.playgroundAction : undefined,
                    ugcAction: override && override.ugcAction ? override.ugcAction : undefined,
                    creatorStudioAction: override && override.creatorStudioAction ? override.creatorStudioAction : undefined,
                    replacementAction: override && override.replacementAction ? override.replacementAction : undefined,
                    forceDirector: (typeof ChatDirector !== 'undefined' && ChatDirector && ChatDirector.isOn()) ? true : undefined
                }),
                signal: activeStreamAbort.signal
            });

            if (!res.ok) {
                const errorData = await res.json().catch(() => ({}));
                removeTypingIndicator();
                if (Conversations.currentId() === conversationId) {
                    addMessageDom('ai', 'Error: ' + (errorData.error || 'Unknown error'));
                }
                return;
            }

            // Create the AI message element for streaming
            const aiMessageEl = document.createElement('div');
            aiMessageEl.className = 'message message--ai';

            const headEl = document.createElement('div');
            headEl.className = 'message-head';

            const roleLabel = document.createElement('div');
            roleLabel.className = 'message-role';
            roleLabel.textContent = assistantDisplayName;
            headEl.appendChild(roleLabel);

            const contentEl = document.createElement('div');
            contentEl.className = 'message-content';

            aiMessageEl.appendChild(headEl);
            aiMessageEl.appendChild(contentEl);

            // Register the live element before attaching so a conversation
            // switch always has a reference to re-attach it later.
            activeMessageEl = aiMessageEl;
            activeMessageConversationId = conversationId;

            removeTypingIndicator();

            // Only render into the conversation that owns this stream. If the
            // user switched conversations while the server was routing, leave
            // the element detached; it is re-attached live (or re-rendered from
            // persistence) when that conversation is re-opened.
            if (Conversations.currentId() === conversationId) {
                chatMessagesEl.appendChild(aiMessageEl);
            }

            // Read the stream
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let fullReply = '';
            let hadError = false;
            let generatingEl = null;
            let generatingLabel = '';
            const reportCreatorProgress = (detail) => {
                if (typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent('creator-studio-progress', {
                        detail: Object.assign({ conversationId }, detail || {})
                    }));
                }
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = JSON.parse(line.slice(6));
                        if (data.creatorStudioProgress) reportCreatorProgress(Object.assign({ stage: true }, data.creatorStudioProgress));
                        if (data.creatorStudioFrame) reportCreatorProgress({ frameReady: true });
                        if (data.queued) reportCreatorProgress({ queued: data.queued });
                        if (data.generating) reportCreatorProgress({ generating: data.generating });
                        if (data.progress) reportCreatorProgress({ progress: data.progress });
                        if (data.chunk) reportCreatorProgress({ message: data.chunk });
                        if (data.video) reportCreatorProgress({ complete: true });
                        if (data.error) {
                            reportCreatorProgress({ error: data.error });
                            if (generatingEl) { generatingEl.remove(); generatingEl = null; }
                            setAiContent(contentEl, data.error);
                            // An error is shown in place but must NOT be persisted
                            // or spoken — only real assistant replies are saved.
                            hadError = true;
                            aiMessageEl.classList.add('message--error');
                            // A failed upscale/modify must make its asset action
                            // available again, so re-check the optimistic state.
                            if (window.AssetActions) window.AssetActions.refresh();
                            continue;
                        }
                        if (data.generating) {
                            if (!generatingEl) {
                                generatingEl = document.createElement('div');
                                generatingEl.className = 'generating-status';
                                contentEl.appendChild(generatingEl);
                            }
                            generatingLabel = data.generating;
                            generatingEl.textContent = data.generating;
                            setProgressTitle(data.generating);
                            activeQueueActive = true;
                            activeTurnId = null;
                            scrollActiveStream(aiMessageEl);
                        }
                        if (data.queued) {
                            if (!generatingEl) {
                                generatingEl = document.createElement('div');
                                generatingEl.className = 'generating-status';
                                contentEl.appendChild(generatingEl);
                            }
                            activeQueueId = data.queued.queueId || null;
                            activeTurnId = data.queued.turnId || null;
                            activeQueueActive = false;
                            const pos = data.queued.position || 1;
                            generatingEl.textContent = activeTurnId
                                ? 'Waiting for another device… (# ' + pos + ', press send to cancel)'
                                : 'Queued #' + pos + ' — waiting for current generation… (press send to cancel)';
                            setProgressTitle(activeTurnId ? 'Waiting for another device' : 'Queued #' + pos);
                            scrollActiveStream(aiMessageEl);
                        }
                        if (data.progress && generatingEl) {
                            // Live ComfyUI step percentage for the running job.
                            if (data.progress.idle) {
                                generatingEl.textContent = generatingLabel || 'Finishing…';
                                setProgressTitle(generatingLabel || 'Finishing…');
                            } else if (data.progress.max > 0) {
                                const pct = Math.max(0, Math.min(100, Math.round((data.progress.value / data.progress.max) * 100)));
                                generatingEl.textContent = (generatingLabel || 'Generating') + ' ' + pct + '%';
                                setProgressTitle((generatingLabel || 'Generating') + ' ' + pct + '%');
                            }
                        }
                        if (data.image) {
                            cancelStreamRender();
                            fullReply = data.image.content;
                            if (generatingEl) generatingEl.remove();
                            setProgressTitle('');
                            setAiContent(contentEl, data.image.content);
                            scrollActiveStream(aiMessageEl);
                            generatedMetaCache = null;
                            if (window.Gallery) window.Gallery.refresh();
                            if (window.AssetActions) window.AssetActions.refresh();
                        }
                        if (data.video) {
                            cancelStreamRender();
                            fullReply = data.video.content;
                            if (generatingEl) generatingEl.remove();
                            setProgressTitle('');
                            setAiContent(contentEl, data.video.content);
                            scrollActiveStream(aiMessageEl);
                            generatedMetaCache = null;
                            if (window.Gallery) window.Gallery.refresh();
                            if (window.AssetActions) window.AssetActions.refresh();
                        }
                        if (data.replacement) {
                            cancelStreamRender();
                            fullReply = data.replacement.content;
                            if (generatingEl) generatingEl.remove();
                            setProgressTitle('');
                            setAiContent(contentEl, data.replacement.content);
                            scrollActiveStream(aiMessageEl);
                        }
                        if (data.director) {
                            cancelStreamRender();
                            fullReply = data.director.content;
                            if (generatingEl) generatingEl.remove();
                            setProgressTitle('');
                            setAiContent(contentEl, data.director.content);
                            scrollActiveStream(aiMessageEl);
                            generatedMetaCache = null;
                            if (window.Gallery) window.Gallery.refresh();
                            if (window.AssetActions) window.AssetActions.refresh();
                            if (window.DirectorUI && typeof window.DirectorUI.hydrate === 'function') {
                                window.DirectorUI.hydrate(chatMessagesEl, conversationId);
                            }
                        }
                        if (data.longvideo) {
                            cancelStreamRender();
                            fullReply = data.longvideo.content;
                            setProgressTitle('');
                            setAiContent(contentEl, data.longvideo.content);
                            // While the sequence renders, keep a status line so the
                            // live ComfyUI step percentage (data.progress) has
                            // somewhere to land beneath the stage checklist.
                            if (data.longvideo.status === 'generating_long_video') {
                                generatingEl = document.createElement('div');
                                generatingEl.className = 'generating-status';
                                generatingEl.textContent = generatingLabel || 'Generating sequence\u2026';
                                contentEl.appendChild(generatingEl);
                                activeQueueActive = true;
                            } else {
                                generatingEl = null;
                            }
                            scrollActiveStream(aiMessageEl);
                            generatedMetaCache = null;
                            if (window.Gallery) window.Gallery.refresh();
                            if (window.AssetActions) window.AssetActions.refresh();
                            if (window.LongVideoUI && typeof window.LongVideoUI.hydrate === 'function') {
                                window.LongVideoUI.hydrate(chatMessagesEl, conversationId);
                            }
                        }
                        if (data.playground) {
                            cancelStreamRender();
                            fullReply = data.playground.content;
                            if (generatingEl) generatingEl.remove();
                            setProgressTitle('');
                            setAiContent(contentEl, data.playground.content);
                            scrollActiveStream(aiMessageEl);
                            if (window.PlaygroundUI && typeof window.PlaygroundUI.hydrate === 'function') {
                                window.PlaygroundUI.hydrate(chatMessagesEl, conversationId);
                            }
                        }
                        if (data.identityProgress) {
                            // The consolidated identity sheet is a single
                            // image; if the viewer is open for this character,
                            // let it refresh its progress live.
                            if (window.CharacterIdentityUI && typeof window.CharacterIdentityUI.onProgress === 'function') {
                                window.CharacterIdentityUI.onProgress(data.identityProgress);
                            }
                            if (generatingEl) {
                                generatingEl.textContent = 'Creating Character Identity Sheet\u2026 Rendering the reference sheet.';
                            }
                        }
                        if (data.identity) {
                            // The standalone identity-sheet endpoint emits the
                            // finished card instead of a chat bubble.
                            cancelStreamRender();
                            if (generatingEl) generatingEl.remove();
                            setProgressTitle('');
                            if (window.CharacterIdentityUI && typeof window.CharacterIdentityUI.onCard === 'function') {
                                window.CharacterIdentityUI.onCard(data.identity.card);
                            }
                        }
                        if (data.characterCreated) {
                            // A generated image was promoted into a saved
                            // character: open the identity viewer on the new
                            // character so its sheet and metadata are shown. The
                            // promoted image is now character identity media, so
                            // refresh the gallery to drop it from the grid.
                            if (generatingEl) generatingEl.remove();
                            setProgressTitle('');
                            generatedMetaCache = null;
                            if (window.Gallery) window.Gallery.refresh();
                            if (window.AssetActions) window.AssetActions.refresh();
                            if (window.CharacterIdentityUI && typeof window.CharacterIdentityUI.open === 'function') {
                                window.CharacterIdentityUI.open(data.characterCreated.characterId);
                            }
                        }
                        if (data.ugc) {
                            cancelStreamRender();
                            fullReply = data.ugc.content;
                            if (generatingEl) generatingEl.remove();
                            setProgressTitle('');
                            setAiContent(contentEl, data.ugc.content);
                            scrollActiveStream(aiMessageEl);
                            generatedMetaCache = null;
                            if (window.Gallery) window.Gallery.refresh();
                            if (window.AssetActions) window.AssetActions.refresh();
                            if (window.UGCUI && typeof window.UGCUI.hydrate === 'function') {
                                // A card action just emitted the next active card;
                                // bring it into view smoothly instead of leaving the
                                // previous card on screen.
                                window.UGCUI.hydrate(chatMessagesEl, conversationId, { scroll: true });
                            }
                        }
                        if (data.chunk) {
                            if (generatingEl) generatingEl.remove();
                            setProgressTitle('');
                            fullReply += data.chunk;
                            scheduleStreamRender(contentEl, fullReply, aiMessageEl);
                        }
                        if (data.stats) {
                            let statsEl = aiMessageEl.querySelector('.message-stats');
                            if (!statsEl) {
                                statsEl = document.createElement('div');
                                statsEl.className = 'message-stats';
                                aiMessageEl.appendChild(statsEl);
                            }
                            statsEl.textContent = data.stats.tokensPerSec + ' tok/s · ' + data.stats.totalTokens + ' tokens · ' + data.stats.durationMs + 'ms';
                        }
                        if (data.agentTask) {
                            // The turn became a durable server task. Remove the
                            // empty chat bubble; the task renders its own card
                            // and streams progress into this conversation.
                            cancelStreamRender();
                            if (generatingEl) { generatingEl.remove(); generatingEl = null; }
                            setProgressTitle('');
                            if (aiMessageEl && aiMessageEl.parentNode) aiMessageEl.remove();
                            fullReply = '';
                            if (window.AgentUI && typeof window.AgentUI.adopt === 'function' &&
                                Conversations.currentId() === conversationId) {
                                window.AgentUI.adopt(data.agentTask);
                            }
                        }
                        if (data.done) {
                            cancelStreamRender();
                            fullReply = data.fullReply;
                            // Re-render so a persisted marker (suggested prompt)
                            // can attach its generation cards.
                            setAiContent(contentEl, fullReply);
                            scrollActiveStream(aiMessageEl);
                        }
                    }
                }
            }

            // Flush any render still queued from the last token (a stream that
            // ended without a `done` event) so the final text is never lost.
            flushStreamRender();

            // Save the complete message
            if (fullReply && !hadError) {
                const savedMessage = await Conversations.saveAssistantMessage(conversationId, fullReply);
                if (savedMessage && savedMessage.id) {
                    aiMessageEl.dataset.messageId = savedMessage.id;
                    attachMessageDelete(headEl, savedMessage.id);
                }
                renderConversationList();
                if (typeof VoiceOutput !== 'undefined' && VoiceOutput && typeof VoiceOutput.speak === 'function') {
                    let spoken = (window.DirectorUI && typeof window.DirectorUI.strip === 'function')
                        ? window.DirectorUI.strip(fullReply)
                        : fullReply;
                    if (window.LongVideoUI && typeof window.LongVideoUI.strip === 'function') {
                        spoken = window.LongVideoUI.strip(spoken);
                    }
                    if (window.PlaygroundUI && typeof window.PlaygroundUI.strip === 'function') {
                        spoken = window.PlaygroundUI.strip(spoken);
                    }
                    if (window.UGCUI && typeof window.UGCUI.strip === 'function') {
                        spoken = window.UGCUI.strip(spoken);
                    }
                    if (window.CreatorStudioUI && typeof window.CreatorStudioUI.strip === 'function') {
                        spoken = window.CreatorStudioUI.strip(spoken);
                    }
                    if (window.ReplacementUI && typeof window.ReplacementUI.strip === 'function') {
                        spoken = window.ReplacementUI.strip(spoken);
                    }
                    if (window.ChatSuggestions && typeof window.ChatSuggestions.strip === 'function') {
                        spoken = window.ChatSuggestions.strip(spoken);
                    }
                    VoiceOutput.speak(spoken);
                }
            }

            // If the conversation is open but the live stream element was
            // detached by a tab switch during generation, re-render from
            // persistence so the finished reply/image shows up automatically.
            if (fullReply && !hadError && Conversations.currentId() === conversationId && !chatMessagesEl.contains(aiMessageEl)) {
                const messages = await Conversations.loadMessages(conversationId);
                renderMessages(messages);
            }
        } catch (err) {
            removeTypingIndicator();
            if (Conversations.currentId() === conversationId) {
                if (err && err.name === 'AbortError') {
                    addMessageDom('ai', 'Cancelled.');
                } else {
                    addMessageDom('ai', 'Connection error: ' + err.message);
                }
            }
        } finally {
            cancelStreamRender();
            activeStreamAbort = null;
            activeQueueId = null;
            activeTurnId = null;
            activeQueueActive = false;
            activeMessageEl = null;
            activeMessageConversationId = null;
            setProgressTitle('');
            setSendingState(false);
            const nextTurn = queuedTurn;
            if (nextTurn) {
                queuedTurn = null;
                renderQueuedTurn();
                setTimeout(() => sendMessage(Object.assign({ queuedRequest: true }, nextTurn)), 0);
            }
            // A concept card disables its buttons while an action is running.
            // Re-apply the active concept after the turn settles so a card that
            // just generated its image (or failed) becomes clickable again —
            // e.g. to "Save as Character" once the result is visible.
            if (window.PlaygroundUI && typeof window.PlaygroundUI.hydrate === 'function'
                && chatMessagesEl.querySelector('.playground-card')) {
                window.PlaygroundUI.hydrate(chatMessagesEl, conversationId);
            }
            // Keep the UGC Studio mode bar in sync with the project state after
            // every turn (start, selection, exit, resume).
            if (window.UGCUI && typeof window.UGCUI.refreshBar === 'function') {
                window.UGCUI.refreshBar();
            }
        }
    }

    function setSendingState(active) {
        if (active) {
            chatSend.disabled = !activeStreamAbort;
            chatSend.classList.add('sending');
            chatSend.setAttribute('aria-label', queuedTurn ? 'Follow-up already queued' : 'Queue next message');
            chatSend.title = queuedTurn ? 'A follow-up is already queued' : 'Queue this message after the current turn';
            if (chatStop) chatStop.hidden = !activeStreamAbort;
        } else {
            chatSend.disabled = false;
            chatSend.classList.remove('sending');
            chatSend.setAttribute('aria-label', 'Send message');
            chatSend.title = 'Send message';
            if (chatStop) chatStop.hidden = true;
            chatInput.focus();
        }
    }

    // --- Typing Indicator ---

    let typingConversationId = null;

    function showTypingIndicator(conversationId) {
        if (Conversations.currentId() !== conversationId) return;
        const existing = document.getElementById('typingIndicator');
        if (existing) return;

        const el = document.createElement('div');
        el.id = 'typingIndicator';
        el.className = 'message message--ai';

        const roleLabel = document.createElement('div');
        roleLabel.className = 'message-role';
        roleLabel.textContent = assistantDisplayName;

        const dotsContainer = document.createElement('div');
        dotsContainer.className = 'typing-indicator';
        dotsContainer.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';

        el.appendChild(roleLabel);
        el.appendChild(dotsContainer);
        chatMessagesEl.appendChild(el);
        typingConversationId = conversationId;
        chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    }

    function removeTypingIndicator() {
        if (typingConversationId && Conversations.currentId() !== typingConversationId) {
            typingConversationId = null;
            return;
        }
        const el = document.getElementById('typingIndicator');
        if (el) el.remove();
        typingConversationId = null;
    }

    return {
        init,
        refreshConversationList,
        addMessageDom,
        renderMessages,
        sendMessage,
        stageReplacement,
        stageReplacementImage,
        cancelActiveStream
    };
})();
