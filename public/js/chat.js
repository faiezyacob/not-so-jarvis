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
    let chatAttach;
    let chatFileInput;
    let chatAttachmentsEl;
    let conversationListEl;
    let chatMentionPopup;
    let pendingAttachments = [];
    let pendingReference = null;
    let mentionItems = [];
    let mentionIndex = 0;
    let mentionToken = 0;
    let generatedMetaCache = null;

    const ATTACH_MAX = 3;
    const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
    const ATTACH_MIME = {
        'image/png': true,
        'image/jpeg': true,
        'image/webp': true
    };

    function init() {
        chatMessagesEl = document.getElementById('chatMessages');
        chatInput = document.getElementById('chatInput');
        chatSend = document.getElementById('chatSend');
        chatAttach = document.getElementById('chatAttach');
        chatFileInput = document.getElementById('chatFileInput');
        chatAttachmentsEl = document.getElementById('chatAttachments');
        chatMentionPopup = document.getElementById('chatMentionPopup');
        conversationListEl = document.getElementById('conversationList');

        document.getElementById('newConversationBtn').addEventListener('click', onNewConversation);
        chatSend.addEventListener('click', onSendButton);
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
                if (activeStreamAbort) return;
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
            item.className = 'conv-item' + (conv.id === currentId ? ' active' : '');
            item.setAttribute('data-id', conv.id);

            const title = document.createElement('div');
            title.className = 'conv-title';
            title.textContent = conv.title || 'Untitled';
            title.title = conv.title || 'Untitled';

            const actions = document.createElement('div');
            actions.className = 'conv-actions';

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
        pendingReference = null;
        closeMentionPopup();
        renderAttachments();
    }

    async function onRename(conv) {
        const title = window.prompt('Rename conversation:', conv.title || '');
        if (title === null) return;
        await Conversations.rename(conv.id, title.trim() || conv.title);
    }

    async function onDelete(conv) {
        if (!window.confirm('Delete conversation "' + (conv.title || 'Untitled') + '" and all its messages?')) {
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
            if (file.size > ATTACH_MAX_BYTES || !file.size) continue;
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
        if (!pendingAttachments.length && !pendingReference) {
            chatAttachmentsEl.style.display = 'none';
            return;
        }
        chatAttachmentsEl.style.display = 'flex';

        if (pendingReference) {
            const item = document.createElement('div');
            item.className = 'chat-attachment chat-attachment--reference';
            const img = document.createElement('img');
            img.className = 'chat-attachment-thumb';
            img.src = pendingReference.url;
            img.alt = pendingReference.filename;
            const badge = document.createElement('span');
            badge.className = 'chat-attachment-badge';
            badge.textContent = '@';
            badge.title = 'Reference image';
            const btn = document.createElement('button');
            btn.className = 'chat-attachment-remove';
            btn.type = 'button';
            btn.textContent = '×';
            btn.title = 'Remove reference';
            btn.addEventListener('click', clearReference);
            item.appendChild(img);
            item.appendChild(badge);
            item.appendChild(btn);
            chatAttachmentsEl.appendChild(item);
        }

        pendingAttachments.forEach((a) => {
            const item = document.createElement('div');
            item.className = 'chat-attachment';
            const img = document.createElement('img');
            img.className = 'chat-attachment-thumb';
            img.src = a.dataUrl;
            img.alt = a.name;
            const btn = document.createElement('button');
            btn.className = 'chat-attachment-remove';
            btn.type = 'button';
            btn.textContent = '×';
            btn.title = 'Remove';
            btn.addEventListener('click', () => removeAttachment(a.id));
            item.appendChild(img);
            item.appendChild(btn);
            chatAttachmentsEl.appendChild(item);
        });
    }

    async function uploadAttachments() {
        const uploaded = [];
        for (const a of pendingAttachments) {
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

    // --- @ reference picker ---
    //
    // Typing "@" opens a picker of the images generated in the current
    // conversation. Selecting one attaches it as a reference chip that is sent
    // with the next message so the pipelines can use it as an edit source or
    // an I2VA first frame instead of the conversation's latest image.

    function onChatInput() {
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

    // Scan the rendered conversation for generated image links (newest first).
    function conversationImages() {
        if (!chatMessagesEl) return [];
        const seen = new Set();
        const list = [];
        chatMessagesEl.querySelectorAll('img.md-image').forEach((img) => {
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

    async function openMentionPopup(query) {
        const token = ++mentionToken;
        const images = conversationImages();
        if (!images.length) {
            closeMentionPopup();
            return;
        }
        const meta = await generatedMeta();
        if (token !== mentionToken) return;
        const q = String(query || '').toLowerCase();
        const enriched = images.map((img) => {
            const found = meta.find((m) => String(m.file || '').split('?')[0].endsWith('/' + img.filename));
            return Object.assign({}, img, { prompt: found ? (found.prompt || '') : '' });
        });
        mentionItems = q
            ? enriched.filter((img) => (img.filename + ' ' + img.prompt).toLowerCase().indexOf(q) !== -1)
            : enriched;
        if (!mentionItems.length) {
            closeMentionPopup();
            return;
        }
        mentionIndex = 0;
        renderMentionPopup();
    }

    function renderMentionPopup() {
        chatMentionPopup.innerHTML = '';
        mentionItems.forEach((item, i) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'chat-mention-item' + (i === mentionIndex ? ' active' : '');
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
                selectMention(i);
            });
            row.addEventListener('mouseenter', () => {
                mentionIndex = i;
                updateMentionActive();
            });
            chatMentionPopup.appendChild(row);
        });
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
        const caret = chatInput.selectionStart || 0;
        const before = chatInput.value.slice(0, caret).replace(/(?:^|\s)@[^\s@]*$/, ' ');
        const after = chatInput.value.slice(caret);
        chatInput.value = (before + after).replace(/^\s+/, '').replace(/\s{2,}/g, ' ');
        addReference(item);
        closeMentionPopup();
        chatInput.focus();
    }

    function addReference(item) {
        pendingReference = item;
        renderAttachments();
    }

    function clearReference() {
        pendingReference = null;
        renderAttachments();
    }

    // --- Message rendering ---

    // Group an upscaled image with its original so they render as a single
    // comparison card instead of two stacked images. Returns { original,
    // upscaled } when the two markdown image URLs look like an upscaled pair
    // (same hex prefix, exactly one carries the "_up_" marker), else null.
    // Image-only: video upscales replace the original file, so videos never pair.
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

    // Render assistant markdown into a content element and collapse any
    // original + upscaled image pairs (keeping just the upscaled image).
    // Videos are handed to the custom VideoPlayer synchronously so the
    // conversation message never depends on observer timing.
    function setAiContent(contentEl, markdown) {
        contentEl.innerHTML = Markdown.parse(markdown);
        collapseUpscalePairs(contentEl);
        if (window.VideoPlayer && typeof window.VideoPlayer.scan === 'function') {
            window.VideoPlayer.scan(contentEl);
        }
    }

    function renderMessages(messages) {
        chatMessagesEl.innerHTML = '';

        if (!messages || messages.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'chat-empty';
            empty.textContent = 'Start a conversation.';
            chatMessagesEl.appendChild(empty);
            return;
        }

        messages.forEach((m) => {
            addMessageDom(m.role, m.content);
        });

        chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    }

    function addMessageDom(role, content) {
        const el = document.createElement('div');
        el.className = 'message message--' + (role === 'assistant' ? 'ai' : 'user');

        const roleLabel = document.createElement('div');
        roleLabel.className = 'message-role';
        roleLabel.textContent = role === 'assistant' ? 'JARVIS' : 'USER';

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
        }

        el.appendChild(roleLabel);
        el.appendChild(contentEl);
        chatMessagesEl.appendChild(el);

        chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    }

    // --- Send flow ---

    let activeStreamAbort = null;
    let activeQueueId = null;
    let activeQueueActive = false;

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
        }
        if (activeStreamAbort) {
            try { activeStreamAbort.abort(); } catch (e) {}
        }
    }

    function onSendButton() {
        if (activeStreamAbort) {
            cancelActiveStream();
            return;
        }
        sendMessage();
    }

    async function sendMessage() {
        if (typeof VoiceInput !== 'undefined' && VoiceInput && typeof VoiceInput.stop === 'function') {
            VoiceInput.stop();
        }
        if (typeof VoiceOutput !== 'undefined' && VoiceOutput && typeof VoiceOutput.cancel === 'function') {
            VoiceOutput.cancel();
        }
        const text = chatInput.value.trim();
        const attachments = pendingAttachments.slice();
        const reference = pendingReference;
        if (!text && !attachments.length && !reference) return;

        let conversationId = Conversations.currentId();

        // Auto-create a conversation when none is active
        if (!conversationId) {
            const conv = await Conversations.create();
            conversationId = conv.id;
            chatMessagesEl.innerHTML = '';
        }

        const visionImages = attachments.map((a) => a.base64);
        const parts = [];
        if (text) parts.push(text);
        if (attachments.length) {
            setSendingState(true);
            try {
                const uploaded = await uploadAttachments();
                parts.push(uploaded.map((u) => '![upload](' + u.url + ')').join('\n'));
            } catch (e) {
                setSendingState(false);
                addMessageDom('ai', 'Upload failed: ' + e.message);
                return;
            }
        }
        if (reference) {
            parts.push('![reference](' + reference.url + ')');
        }
        const userText = parts.join('\n\n');

        addMessageDom('user', userText);
        chatInput.value = '';
        clearAttachments();
        clearReference();

        // Persist user message to backend (context builder source)
        let userMsg;
        try {
            userMsg = await Conversations.saveUserMessage(conversationId, userText);
        } catch (e) {
            addMessageDom('ai', 'Failed to save message: ' + e.message);
            return;
        }

        // Update list order/title
        renderConversationList();

        const provider = getChatProvider();
        const model = getChatModel();
        const think = typeof getReasoningEnabled === 'function' ? getReasoningEnabled() : true;

        setSendingState(true);
        showTypingIndicator();

        activeStreamAbort = new AbortController();
        activeQueueId = null;
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
                    references: reference ? [reference.filename] : []
                }),
                signal: activeStreamAbort.signal
            });

            if (!res.ok) {
                const errorData = await res.json().catch(() => ({}));
                removeTypingIndicator();
                addMessageDom('ai', 'Error: ' + (errorData.error || 'Unknown error'));
                return;
            }

            // Create the AI message element for streaming
            const aiMessageEl = document.createElement('div');
            aiMessageEl.className = 'message message--ai';

            const roleLabel = document.createElement('div');
            roleLabel.className = 'message-role';
            roleLabel.textContent = 'JARVIS';

            const contentEl = document.createElement('div');
            contentEl.className = 'message-content';

            aiMessageEl.appendChild(roleLabel);
            aiMessageEl.appendChild(contentEl);
            chatMessagesEl.appendChild(aiMessageEl);

            removeTypingIndicator();

            // Read the stream
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let fullReply = '';
            let hadError = false;
            let generatingEl = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = JSON.parse(line.slice(6));
                        if (data.error) {
                            if (generatingEl) { generatingEl.remove(); generatingEl = null; }
                            setAiContent(contentEl, data.error);
                            // An error is shown in place but must NOT be persisted
                            // or spoken — only real assistant replies are saved.
                            hadError = true;
                            aiMessageEl.classList.add('message--error');
                            continue;
                        }
                        if (data.generating) {
                            if (!generatingEl) {
                                generatingEl = document.createElement('div');
                                generatingEl.className = 'generating-status';
                                contentEl.appendChild(generatingEl);
                            }
                            generatingEl.textContent = data.generating;
                            activeQueueActive = true;
                            chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
                        }
                        if (data.queued) {
                            if (!generatingEl) {
                                generatingEl = document.createElement('div');
                                generatingEl.className = 'generating-status';
                                contentEl.appendChild(generatingEl);
                            }
                            activeQueueId = data.queued.queueId || null;
                            activeQueueActive = false;
                            const pos = data.queued.position || 1;
                            generatingEl.textContent = 'Queued #' + pos + ' — waiting for current generation… (press send to cancel)';
                            chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
                        }
                        if (data.image) {
                            fullReply = data.image.content;
                            if (generatingEl) generatingEl.remove();
                            setAiContent(contentEl, data.image.content);
                            chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
                            generatedMetaCache = null;
                            if (window.Gallery) window.Gallery.refresh();
                        }
                        if (data.video) {
                            fullReply = data.video.content;
                            if (generatingEl) generatingEl.remove();
                            setAiContent(contentEl, data.video.content);
                            chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
                            generatedMetaCache = null;
                            if (window.Gallery) window.Gallery.refresh();
                        }
                        if (data.chunk) {
                            if (generatingEl) generatingEl.remove();
                            fullReply += data.chunk;
                            setAiContent(contentEl, fullReply);
                            chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
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
                        if (data.done) {
                            fullReply = data.fullReply;
                        }
                    }
                }
            }

            // Save the complete message
            if (fullReply && !hadError) {
                await Conversations.saveAssistantMessage(conversationId, fullReply);
                renderConversationList();
                if (typeof VoiceOutput !== 'undefined' && VoiceOutput && typeof VoiceOutput.speak === 'function') {
                    VoiceOutput.speak(fullReply);
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
            if (err && err.name === 'AbortError') {
                addMessageDom('ai', 'Cancelled.');
            } else {
                addMessageDom('ai', 'Connection error: ' + err.message);
            }
        } finally {
            activeStreamAbort = null;
            activeQueueId = null;
            activeQueueActive = false;
            setSendingState(false);
        }
    }

    function setSendingState(active) {
        if (active) {
            // Keep the send button enabled so it acts as Cancel while streaming.
            chatSend.disabled = false;
            chatInput.disabled = true;
            chatSend.classList.add('sending');
            chatSend.setAttribute('aria-label', 'Cancel');
            chatSend.title = 'Cancel';
        } else {
            chatSend.disabled = false;
            chatInput.disabled = false;
            chatSend.classList.remove('sending');
            chatSend.setAttribute('aria-label', 'Send message');
            chatSend.title = '';
            chatInput.focus();
        }
    }

    // --- Typing Indicator ---

    function showTypingIndicator() {
        const existing = document.getElementById('typingIndicator');
        if (existing) return;

        const el = document.createElement('div');
        el.id = 'typingIndicator';
        el.className = 'message message--ai';

        const roleLabel = document.createElement('div');
        roleLabel.className = 'message-role';
        roleLabel.textContent = 'JARVIS';

        const dotsContainer = document.createElement('div');
        dotsContainer.className = 'typing-indicator';
        dotsContainer.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';

        el.appendChild(roleLabel);
        el.appendChild(dotsContainer);
        chatMessagesEl.appendChild(el);
        chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    }

    function removeTypingIndicator() {
        const el = document.getElementById('typingIndicator');
        if (el) el.remove();
    }

    return {
        init,
        refreshConversationList,
        addMessageDom,
        sendMessage,
        cancelActiveStream
    };
})();
