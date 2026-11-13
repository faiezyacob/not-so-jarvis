/* ============================================================
   studio-shell.js — the shared dialog contract for the four
   studio surfaces (UGC, Creator, Character Swap, Companions).
   Opens on the sheet, keeps Tab inside it, restores focus on close.
   ============================================================ */

(function () {
    'use strict';

    const FOCUSABLE = [
        'a[href]',
        'button:not([disabled])',
        'input:not([disabled]):not([type="hidden"])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])'
    ].join(',');

    let current = null;
    let returnTo = null;

    function visibleFocusables(root) {
        return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), (node) => {
            if (node.closest('[hidden]')) return false;
            if (node.getAttribute('aria-hidden') === 'true') return false;
            if (!node.getClientRects().length) return false;
            return true;
        });
    }

    function open(overlay, options) {
        if (!overlay) return;
        const opts = options || {};
        const sheet = overlay.querySelector('[role="dialog"]') || overlay;
        current = sheet;
        returnTo = document.activeElement;
        document.body.classList.add('studio-open');

        let target = null;
        if (opts.initial) target = sheet.querySelector(opts.initial);
        if (!target) target = visibleFocusables(sheet)[0];
        if (!target) {
            if (!sheet.hasAttribute('tabindex')) sheet.setAttribute('tabindex', '-1');
            target = sheet;
        }
        window.requestAnimationFrame(() => {
            try {
                target.focus({ preventScroll: true });
            } catch (error) {
                target.focus();
            }
        });
    }

    function close() {
        current = null;
        document.body.classList.remove('studio-open');
        if (returnTo && document.contains(returnTo) && typeof returnTo.focus === 'function') {
            try {
                returnTo.focus({ preventScroll: true });
            } catch (error) {
                returnTo.focus();
            }
        }
        returnTo = null;
    }

    document.addEventListener('keydown', (event) => {
        if (!current || event.key !== 'Tab') return;
        // A nested dialog (identity sheet, media picker) owns the Tab order
        // while it is open; the studio only traps when focus is inside it.
        if (!current.contains(document.activeElement)) return;
        const items = visibleFocusables(current);
        if (!items.length) {
            event.preventDefault();
            return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });

    window.StudioShell = { open, close };
})();
