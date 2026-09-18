/* ============================================
   JARVIS — Director Mode toggle
   A composer toggle that pre-selects Director Mode
   for the next video request, skipping the
   "Direct video or Director mode?" question. The
   state persists across turns (localStorage) and is
   sent as `forceDirector` on /api/chat/stream.
   ============================================ */

const ChatDirector = (() => {
    const STORAGE_KEY = 'jarvis-force-director';
    let buttonEl = null;
    let on = false;

    function read() {
        try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch (e) { return false; }
    }

    function persist() {
        try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch (e) {}
    }

    function render() {
        if (!buttonEl) return;
        buttonEl.classList.toggle('active', on);
        buttonEl.setAttribute('aria-pressed', on ? 'true' : 'false');
        buttonEl.title = on
            ? 'Director Mode on — video requests skip the workflow question'
            : 'Force Director Mode for the next video request';
    }

    function set(value) {
        on = Boolean(value);
        persist();
        render();
    }

    function toggle() {
        set(!on);
    }

    function isOn() {
        return on;
    }

    function init() {
        buttonEl = document.getElementById('chatDirector');
        if (!buttonEl) return;
        on = read();
        render();
        buttonEl.addEventListener('click', (e) => {
            e.stopPropagation();
            toggle();
        });
    }

    return { init, isOn, set, toggle };
})();

window.ChatDirector = ChatDirector;
