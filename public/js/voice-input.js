/* ============================================
   JARVIS — Voice Input
   Push-to-talk dictation for the chat input using
   the browser Web Speech API (no dependencies).
   Click the mic to start/stop. Interim results
   stream into #chatInput; the final transcript is
   left for review — press send (or Enter) to submit,
   or enable auto-send in Chat > Voice settings.
   ============================================ */

const VoiceInput = (() => {
    const AUTOSEND_KEY = 'jarvis-voice-autosend';

    let micBtn;
    let chatInput;
    let recognition;
    let listening = false;
    let baseText = '';
    let hasFinal = false;
    let supported = false;

    function isAutoSend() {
        try {
            return localStorage.getItem(AUTOSEND_KEY) === 'true';
        } catch {
            return false;
        }
    }

    function setAutoSend(enabled) {
        try { localStorage.setItem(AUTOSEND_KEY, enabled ? 'true' : 'false'); } catch {}
        const toggle = document.getElementById('voiceAutoSendToggle');
        if (toggle) toggle.checked = enabled;
    }

    function getRecognitionCtor() {
        if (typeof window === 'undefined') return null;
        return window.SpeechRecognition || window.webkitSpeechRecognition || null;
    }

    function init() {
        micBtn = document.getElementById('chatMic');
        chatInput = document.getElementById('chatInput');
        if (!micBtn || !chatInput) return;

        const Ctor = getRecognitionCtor();
        supported = Boolean(Ctor);
        if (!supported) {
            micBtn.disabled = true;
            micBtn.title = 'Voice input not supported in this browser (try Chrome or Edge)';
            micBtn.setAttribute('aria-label', 'Voice input not supported');
            micBtn.classList.add('chat-mic--unsupported');
            return;
        }

        recognition = new Ctor();
        recognition.lang = navigator.language || 'en-US';
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.continuous = false;

        recognition.addEventListener('result', onResult);
        recognition.addEventListener('end', onEnd);
        recognition.addEventListener('error', onError);

        micBtn.addEventListener('click', toggle);
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && listening) stop();
        });
    }

    function toggle() {
        if (!supported || !recognition) return;
        if (listening) {
            stop();
        } else {
            start();
        }
    }

    function start() {
        if (listening) return;
        if (chatInput && chatInput.disabled) return;
        if (window.VoiceOutput && typeof window.VoiceOutput.cancel === 'function') window.VoiceOutput.cancel();
        baseText = chatInput ? chatInput.value : '';
        hasFinal = false;
        try {
            recognition.start();
        } catch (e) {
            return;
        }
        listening = true;
        updateButton();
        if (chatInput) chatInput.focus();
    }

    function stop() {
        if (!listening) return;
        try {
            recognition.stop();
        } catch (e) {
            listening = false;
            updateButton();
        }
    }

    function onResult(e) {
        if (!chatInput) return;
        let interim = '';
        let finalText = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const transcript = e.results[i][0].transcript;
            if (e.results[i].isFinal) {
                finalText += transcript;
                hasFinal = true;
            } else {
                interim += transcript;
            }
        }
        const spoken = (finalText || interim).trim();
        const prefix = baseText && baseText.trim() ? baseText.replace(/\s+$/, '') + ' ' : '';
        chatInput.value = spoken ? prefix + spoken : baseText;
        chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function onEnd() {
        listening = false;
        updateButton();
        if (chatInput) chatInput.focus();
        if (hasFinal && isAutoSend() && chatInput && chatInput.value.trim() &&
            typeof Chat !== 'undefined' && Chat && typeof Chat.sendMessage === 'function') {
            Chat.sendMessage();
        }
    }

    function onError(e) {
        if (!e || !e.error) return;
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            if (micBtn) micBtn.title = 'Microphone blocked — allow mic access in the browser address bar';
        }
    }

    function updateButton() {
        if (!micBtn) return;
        micBtn.classList.toggle('listening', listening);
        micBtn.setAttribute('aria-label', listening ? 'Stop voice input' : 'Start voice input');
        micBtn.title = listening ? 'Stop listening' : 'Voice input';
        micBtn.setAttribute('aria-pressed', listening ? 'true' : 'false');
    }

    return {
        init,
        toggle,
        stop,
        isListening: () => listening,
        isSupported: () => supported,
        isAutoSend,
        setAutoSend
    };
})();

if (typeof window !== 'undefined') window.VoiceInput = VoiceInput;
