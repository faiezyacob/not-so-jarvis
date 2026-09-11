/* ============================================
   JARVIS — Voice Output
   Speaks assistant replies via the browser
   SpeechSynthesis API (no dependencies).
   Toggle with the speaker button or the
   Chat > Voice settings. Off by default.
   ============================================ */

const VoiceOutput = (() => {
    const ENABLED_KEY = 'jarvis-voice-reply';
    const RATE_KEY = 'jarvis-voice-rate';
    const VOICE_KEY = 'jarvis-voice-name';

    let speakerBtn;
    let supported = false;
    let speaking = false;

    function isSupported() {
        return typeof window !== 'undefined' && 'speechSynthesis' in window;
    }

    function isEnabled() {
        try {
            return localStorage.getItem(ENABLED_KEY) === 'true';
        } catch {
            return false;
        }
    }

    function setEnabled(enabled) {
        try { localStorage.setItem(ENABLED_KEY, enabled ? 'true' : 'false'); } catch {}
        updateButton();
        syncSettingsToggle();
        if (!enabled) cancel();
    }

    function getRate() {
        try {
            const raw = parseFloat(localStorage.getItem(RATE_KEY));
            if (Number.isFinite(raw)) return Math.min(2, Math.max(0.5, raw));
        } catch {}
        return 1;
    }

    function setRate(rate) {
        try { localStorage.setItem(RATE_KEY, String(rate)); } catch {}
    }

    function getVoiceName() {
        try {
            return localStorage.getItem(VOICE_KEY) || '';
        } catch {
            return '';
        }
    }

    function setVoiceName(name) {
        try { localStorage.setItem(VOICE_KEY, name || ''); } catch {}
    }

    function pickVoice() {
        const voices = window.speechSynthesis.getVoices();
        if (!voices || !voices.length) return null;
        const wanted = getVoiceName();
        if (wanted) {
            const match = voices.find((v) => v.name === wanted || v.voiceURI === wanted);
            if (match) return match;
        }
        const lang = (navigator.language || 'en-US').split('-')[0].toLowerCase();
        return voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(lang) && v.localService) ||
            voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(lang)) ||
            voices.find((v) => v.default) ||
            voices[0];
    }

    // Strip markdown/images down to speakable plain text.
    function toSpeakable(markdown) {
        let text = String(markdown || '');
        text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
        text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
        text = text.replace(/```[\s\S]*?```/g, ' ');
        text = text.replace(/`([^`]*)`/g, '$1');
        text = text.replace(/^#{1,6}\s+/gm, '');
        text = text.replace(/^[>\-\*\+]\s+/gm, '');
        text = text.replace(/[*_~|]/g, '');
        text = text.replace(/^Original:\s*$/gim, ' ');
        text = text.replace(/^Upscaled:\s*$/gim, ' ');
        text = text.replace(/\s+/g, ' ').trim();
        return text;
    }

    function chunkText(text) {
        const chunks = [];
        let rest = text;
        while (rest.length > 220) {
            let cut = rest.lastIndexOf('. ', 220);
            if (cut === -1) cut = rest.lastIndexOf(' ', 220);
            if (cut === -1) cut = 220;
            chunks.push(rest.slice(0, cut + 1).trim());
            rest = rest.slice(cut + 1).trim();
        }
        if (rest) chunks.push(rest);
        return chunks.slice(0, 20);
    }

    function speak(markdown) {
        if (!supported || !isEnabled()) return;
        const text = toSpeakable(markdown);
        if (!text) return;
        try {
            window.speechSynthesis.cancel();
            const chunks = chunkText(text);
            chunks.forEach((part, i) => {
                const utter = new SpeechSynthesisUtterance(part);
                utter.rate = getRate();
                const voice = pickVoice();
                if (voice) utter.voice = voice;
                if (i === 0) utter.addEventListener('start', () => { speaking = true; updateButton(); });
                if (i === chunks.length - 1) {
                    utter.addEventListener('end', () => { speaking = false; updateButton(); });
                    utter.addEventListener('error', () => { speaking = false; updateButton(); });
                }
                window.speechSynthesis.speak(utter);
            });
        } catch {}
    }

    function cancel() {
        if (!supported) return;
        try { window.speechSynthesis.cancel(); } catch {}
        speaking = false;
        updateButton();
    }

    function toggle() {
        setEnabled(!isEnabled());
    }

    function updateButton() {
        if (!speakerBtn) return;
        const enabled = isEnabled();
        speakerBtn.classList.toggle('active', enabled);
        speakerBtn.classList.toggle('speaking', speaking);
        speakerBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        speakerBtn.setAttribute('aria-label', enabled ? 'Mute spoken replies' : 'Speak replies aloud');
        speakerBtn.title = enabled ? (speaking ? 'Speaking… click to mute' : 'Spoken replies on — click to mute') : 'Speak replies aloud';
    }

    function syncSettingsToggle() {
        const toggle = document.getElementById('voiceReplyToggle');
        if (toggle) toggle.checked = isEnabled();
    }

    function populateVoiceSelect() {
        const select = document.getElementById('voiceSelect');
        if (!select || !supported) return;
        const voices = window.speechSynthesis.getVoices();
        if (!voices || !voices.length) return;
        const current = getVoiceName() || (pickVoice() || {}).name || '';
        select.innerHTML = '';
        const auto = document.createElement('option');
        auto.value = '';
        auto.textContent = 'Auto (' + ((pickVoice() || {}).name || 'default') + ')';
        select.appendChild(auto);
        voices.forEach((v) => {
            const opt = document.createElement('option');
            opt.value = v.name;
            opt.textContent = v.name + ' — ' + v.lang;
            if (v.name === current) opt.selected = true;
            select.appendChild(opt);
        });
    }

    function init() {
        supported = isSupported();
        speakerBtn = document.getElementById('chatSpeaker');
        if (speakerBtn) {
            if (!supported) {
                speakerBtn.disabled = true;
                speakerBtn.title = 'Spoken replies not supported in this browser';
                speakerBtn.setAttribute('aria-label', 'Spoken replies not supported');
            } else {
                speakerBtn.addEventListener('click', () => {
                    if (speaking) {
                        cancel();
                        return;
                    }
                    toggle();
                });
                updateButton();
            }
        }
        syncSettingsToggle();
        if (supported) {
            populateVoiceSelect();
            if (typeof window.speechSynthesis.onvoiceschanged !== 'undefined') {
                window.speechSynthesis.onvoiceschanged = populateVoiceSelect;
            }
        }
    }

    return {
        init,
        speak,
        cancel,
        toggle,
        isEnabled,
        setEnabled,
        getRate,
        setRate,
        getVoiceName,
        setVoiceName,
        isSupported: () => supported,
        isSpeaking: () => speaking
    };
})();

if (typeof window !== 'undefined') window.VoiceOutput = VoiceOutput;
