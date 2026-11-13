/* SPDX-License-Identifier: MIT */
/* ============================================================
   Theme — light / dark paper for the call-sheet shell.
   The head script resolves the ground before first paint; this
   only flips it and remembers the choice on this device.
   ============================================================ */

(() => {
    const KEY = 'jarvis-theme';
    const root = document.documentElement;
    const button = document.getElementById('themeToggle');
    if (!button) return;

    function current() {
        return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    }

    function apply(theme, persist) {
        root.setAttribute('data-theme', theme);
        button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
        button.title = theme === 'dark' ? 'Switch to light' : 'Switch to dark';
        if (!persist) return;
        try {
            localStorage.setItem(KEY, theme);
        } catch (e) {
            /* storage blocked: the session still flips */
        }
    }

    // Resolving the ground on load must not record a choice the operator never
    // made, or the OS preference stops being the default after one visit.
    apply(current(), false);

    button.addEventListener('click', () => {
        apply(current() === 'dark' ? 'light' : 'dark', true);
    });

    // Follow the OS only while the user has not chosen a side on this device.
    if (window.matchMedia) {
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = (event) => {
            let stored = null;
            try {
                stored = localStorage.getItem(KEY);
            } catch (e) {
                stored = null;
            }
            if (stored === 'light' || stored === 'dark') return;
            apply(event.matches ? 'dark' : 'light', false);
        };
        if (media.addEventListener) media.addEventListener('change', onChange);
        else if (media.addListener) media.addListener(onChange);
    }
})();
