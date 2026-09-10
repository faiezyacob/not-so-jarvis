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
    let conversationListEl;

    function init() {
        chatMessagesEl = document.getElementById('chatMessages');
        chatInput = document.getElementById('chatInput');
        chatSend = document.getElementById('chatSend');
        conversationListEl = document.getElementById('conversationList');

        document.getElementById('newConversationBtn').addEventListener('click', onNewConversation);
        chatSend.addEventListener('click', sendMessage);
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // Clicking an image inside a chat message opens the same preview
        // lightbox as clicking a thumbnail in the GENERATED widget.
        chatMessagesEl.addEventListener('click', (e) => {
            const imgEl = e.target.closest('.md-image');
            const vidEl = e.target.closest('.md-video');
            const el = imgEl || vidEl;
            if (!el) return;
            if (window.Gallery && typeof window.Gallery.openFromUrl === 'function') {
                e.preventDefault();
                window.Gallery.openFromUrl(el.getAttribute('src'));
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
        renderMessages(messages);
    }

    async function onNewConversation() {
        const conv = await Conversations.create();
        renderMessages([]);
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

    // --- Message rendering ---

    // Group an upscaled image with its original so they render as a single
    // comparison card instead of two stacked images. Returns { original,
    // upscaled } when the two markdown image URLs look like an upscaled pair
    // (same hex prefix, exactly one carries the "_up_" marker), else null.
    function pairMatch(a, b) {
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
    function setAiContent(contentEl, markdown) {
        contentEl.innerHTML = Markdown.parse(markdown);
        collapseUpscalePairs(contentEl);
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

        // Use markdown parser for AI messages, plain text for user messages
        if (role === 'assistant') {
            setAiContent(contentEl, content);
        } else {
            contentEl.textContent = content;
        }

        el.appendChild(roleLabel);
        el.appendChild(contentEl);
        chatMessagesEl.appendChild(el);

        chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    }

    // --- Send flow ---

    async function sendMessage() {
        const text = chatInput.value.trim();
        if (!text) return;

        let conversationId = Conversations.currentId();

        // Auto-create a conversation when none is active
        if (!conversationId) {
            const conv = await Conversations.create();
            conversationId = conv.id;
            chatMessagesEl.innerHTML = '';
        }

        addMessageDom('user', text);
        chatInput.value = '';

        // Persist user message to backend (context builder source)
        let userMsg;
        try {
            userMsg = await Conversations.saveUserMessage(conversationId, text);
        } catch (e) {
            addMessageDom('ai', 'Failed to save message: ' + e.message);
            return;
        }

        // Update list order/title
        renderConversationList();

        const provider = getChatProvider();
        const model = getChatModel();

        setSendingState(true);
        showTypingIndicator();

        try {
            const res = await fetch('/api/chat/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    conversationId,
                    provider,
                    model,
                    message: text
                })
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
                            fullReply = data.error;
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
                            chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
                        }
                        if (data.image) {
                            fullReply = data.image.content;
                            if (generatingEl) generatingEl.remove();
                            setAiContent(contentEl, data.image.content);
                            chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
                            if (window.Gallery) window.Gallery.refresh();
                        }
                        if (data.video) {
                            fullReply = data.video.content;
                            if (generatingEl) generatingEl.remove();
                            setAiContent(contentEl, data.video.content);
                            chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
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
            if (fullReply) {
                await Conversations.saveAssistantMessage(conversationId, fullReply);
                renderConversationList();
            }

            // If the conversation is open but the live stream element was
            // detached by a tab switch during generation, re-render from
            // persistence so the finished reply/image shows up automatically.
            if (fullReply && Conversations.currentId() === conversationId && !chatMessagesEl.contains(aiMessageEl)) {
                const messages = await Conversations.loadMessages(conversationId);
                renderMessages(messages);
            }
        } catch (err) {
            removeTypingIndicator();
            addMessageDom('ai', 'Connection error: ' + err.message);
        } finally {
            setSendingState(false);
        }
    }

    function setSendingState(active) {
        if (active) {
            chatSend.disabled = true;
            chatInput.disabled = true;
            chatSend.classList.add('sending');
        } else {
            chatSend.disabled = false;
            chatInput.disabled = false;
            chatSend.classList.remove('sending');
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
        addMessageDom
    };
})();
