/* ============================================
   JARVIS — Quick LoRA Picker
   A compact popover beside the chat mic button that
   edits the global IMAGE and VIDEO LoRA stacks without
   opening Settings. It reuses the Settings-panel stack
   helpers (initLoraStack / renderLoraStack / saveLoraStack)
   so both surfaces behave identically and persist through
   the same /api/settings/image and /api/settings/video
   endpoints.
   ============================================ */

const ChatLora = (() => {
    let buttonEl;
    let countEl;
    let popupEl;
    let activeKind = 'image';

    const states = {};

    function stateFor(kind) {
        if (states[kind]) return states[kind];
        const isImage = kind === 'image';
        states[kind] = initLoraStack({
            endpoint: isImage ? '/api/settings/image' : '/api/settings/video',
            listId: isImage ? 'chatLoraImageList' : 'chatLoraVideoList',
            addSelectId: isImage ? 'chatLoraImageAdd' : 'chatLoraVideoAdd',
            statusId: 'chatLoraStatus'
        });
        return states[kind];
    }

    function activeCount(state) {
        return (state.loras || []).filter((l) => l && l.on !== false && l.name).length;
    }

    function updateButton() {
        if (!buttonEl) return;
        let total = 0;
        Object.keys(states).forEach((kind) => { total += activeCount(states[kind]); });
        buttonEl.classList.toggle('chat-lora--active', total > 0);
        buttonEl.title = total
            ? total + ' LoRA' + (total > 1 ? 's' : '') + ' active — quick LoRA selection'
            : 'Quick LoRA selection';
        if (countEl) {
            countEl.textContent = total ? String(total) : '';
            countEl.hidden = total === 0;
        }
    }

    async function load(kind) {
        const state = stateFor(kind);
        loraStatus(state, '');
        try {
            const res = await fetch(state.endpoint);
            const data = await res.json().catch(() => ({}));
            const settings = data.settings || {};
            const choices = data.choices || {};
            state.available = Array.isArray(choices.loras) ? choices.loras : [];
            state.triggerMemory = (settings.loraTriggerWords && typeof settings.loraTriggerWords === 'object')
                ? settings.loraTriggerWords
                : {};
            state.loras = Array.isArray(settings.loras)
                ? settings.loras.map((l) => ({
                    name: String((l && l.name) || ''),
                    strength: (typeof (l && l.strength) === 'number' ? l.strength : 1),
                    on: !(l && l.on === false),
                    triggerWord: (l && l.triggerWord) || ''
                })).filter((l) => l.name)
                : [];
            renderLoraStack(state);
            if (!data.comfyAvailable) {
                loraStatus(state, 'ComfyUI unreachable — saved stack shown', true);
            }
        } catch (e) {
            loraStatus(state, 'Could not load LoRA stack', true);
        }
        updateButton();
    }

    function selectKind(kind) {
        activeKind = kind;
        if (!popupEl) return;
        popupEl.querySelectorAll('.chat-lora-tab').forEach((tab) => {
            tab.classList.toggle('active', tab.dataset.kind === kind);
        });
        popupEl.querySelectorAll('.chat-lora-panel').forEach((panel) => {
            panel.hidden = panel.dataset.kind !== kind;
        });
        load(kind);
    }

    function open() {
        if (!popupEl) return;
        popupEl.hidden = false;
        if (buttonEl) buttonEl.setAttribute('aria-expanded', 'true');
        selectKind(activeKind);
    }

    function close() {
        if (!popupEl) return;
        popupEl.hidden = true;
        if (buttonEl) buttonEl.setAttribute('aria-expanded', 'false');
    }

    function isOpen() {
        return !!popupEl && !popupEl.hidden;
    }

    function init() {
        buttonEl = document.getElementById('chatLora');
        popupEl = document.getElementById('chatLoraPopup');
        if (!buttonEl || !popupEl) return;
        countEl = document.getElementById('chatLoraCount');

        // Bind each stack's add dropdown once; their list/status elements
        // are resolved from the popover markup.
        initLoraSettings(stateFor('image'));
        initLoraSettings(stateFor('video'));

        buttonEl.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isOpen()) close(); else open();
        });

        popupEl.addEventListener('click', (e) => e.stopPropagation());

        popupEl.querySelectorAll('.chat-lora-tab').forEach((tab) => {
            tab.addEventListener('click', () => selectKind(tab.dataset.kind));
        });

        document.addEventListener('click', (e) => {
            if (!isOpen()) return;
            if (popupEl.contains(e.target) || buttonEl.contains(e.target)) return;
            close();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && isOpen()) close();
        });

        // Warm the button indicator with the persisted stacks.
        load('image');
        load('video');
    }

    return { init, open, close, isOpen, reload: load };
})();

window.ChatLora = ChatLora;
