/* ============================================
   JARVIS — App Dialog
   In-UI replacements for window.prompt/confirm/alert
   so every dialog matches the dashboard styling.
   Reuses the shared .modal-* classes and supports
   promises: Dialog.prompt() -> string|null,
   Dialog.confirm() -> boolean, Dialog.alert() -> void.
   ============================================ */

const Dialog = (() => {
    let overlay;
    let headerEl;
    let bodyEl;
    let footerEl;
    let initialized = false;
    let active = null;

    function ready() {
        if (initialized) return !!overlay;
        initialized = true;
        overlay = document.getElementById('appDialogOverlay');
        if (!overlay) return false;
        headerEl = document.getElementById('appDialogHeader');
        bodyEl = document.getElementById('appDialogBody');
        footerEl = document.getElementById('appDialogFooter');

        overlay.addEventListener('mousedown', (e) => {
            if (e.target === overlay) settle(active ? active.cancelValue : null);
        });
        document.addEventListener('keydown', (e) => {
            if (!active || !overlay.classList.contains('open')) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                settle(active.cancelValue);
            }
        });
        return true;
    }

    function settle(value) {
        if (!active) return;
        const current = active;
        active = null;
        overlay.classList.remove('open');
        headerEl.textContent = '';
        bodyEl.textContent = '';
        footerEl.textContent = '';
        if (current.resolve) current.resolve(value);
    }

    function makeButton(label, className, onClick) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'modal-btn ' + className;
        btn.textContent = label;
        btn.addEventListener('click', onClick);
        return btn;
    }

    function show(options) {
        if (!ready()) {
            return Promise.resolve(options.cancelValue === undefined ? null : options.cancelValue);
        }
        if (active) settle(active.cancelValue);

        headerEl.textContent = '';
        const title = document.createElement('div');
        title.className = 'modal-title';
        title.textContent = options.title || '';
        headerEl.appendChild(title);

        bodyEl.textContent = '';
        if (options.message) {
            const message = document.createElement('div');
            message.className = 'dialog-message';
            message.textContent = options.message;
            bodyEl.appendChild(message);
        }

        let input = null;
        if (options.input) {
            input = document.createElement('input');
            input.type = 'text';
            input.className = 'dialog-input';
            input.value = options.value || '';
            input.placeholder = options.placeholder || '';
            input.autocomplete = 'off';
            input.spellcheck = false;
            bodyEl.appendChild(input);
        }

        footerEl.textContent = '';
        if (!options.hideCancel) {
            footerEl.appendChild(makeButton(options.cancelText || 'Cancel', 'modal-btn-cancel', () => {
                settle(options.cancelValue);
            }));
        }

        const confirmClass = options.danger
            ? 'modal-btn-danger'
            : (options.warning ? 'modal-btn-warning' : 'modal-btn-primary');
        const confirmBtn = makeButton(options.confirmText || 'OK', confirmClass, () => {
            settle(options.input ? input.value : true);
        });
        footerEl.appendChild(confirmBtn);

        overlay.classList.add('open');

        return new Promise((resolve) => {
            active = { resolve, cancelValue: options.cancelValue };
            if (input) {
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        settle(input.value);
                    }
                });
                setTimeout(() => {
                    input.focus();
                    input.select();
                }, 0);
            } else {
                setTimeout(() => confirmBtn.focus(), 0);
            }
        });
    }

    function prompt(options) {
        options = options || {};
        return show({
            title: options.title || 'Input',
            message: options.message || '',
            input: true,
            value: options.value || '',
            placeholder: options.placeholder || '',
            confirmText: options.confirmText || 'Save',
            cancelText: options.cancelText || 'Cancel',
            cancelValue: null
        });
    }

    function confirm(options) {
        if (typeof options === 'string') options = { message: options };
        options = options || {};
        return show({
            title: options.title || 'Confirm',
            message: options.message || '',
            confirmText: options.confirmText || 'Confirm',
            cancelText: options.cancelText || 'Cancel',
            danger: options.danger,
            warning: options.warning,
            cancelValue: false
        });
    }

    function alert(options) {
        if (typeof options === 'string') options = { message: options };
        options = options || {};
        return show({
            title: options.title || 'Notice',
            message: options.message || '',
            confirmText: options.confirmText || 'OK',
            hideCancel: true,
            cancelValue: null
        });
    }

    return { prompt, confirm, alert };
})();

window.Dialog = Dialog;
