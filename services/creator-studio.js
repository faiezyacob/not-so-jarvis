/* ============================================
   JARVIS — Creator Studio
   Conversation-first character-led scripts,
   performance beats and content sessions. This
   layer composes the shared Character, Face Action,
   Activity and video systems; it does not own a
   media-generation pipeline.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');
const faceActions = require('./playground/face-actions');
const activities = require('./playground/activities');
const characterModel = require('./playground/character');
const outfitPacks = require('./playground/outfit-packs');

const STORE_PATH = process.env.CREATOR_STUDIO_PATH || path.join(__dirname, '..', 'data', 'creator-studio.json');

const PERSONALITY_TRAITS = Object.freeze([
    'playful', 'confident', 'warm', 'cheeky', 'energetic', 'calm',
    'charming', 'funny', 'flirty', 'glamorous', 'casual', 'storyteller'
]);

const CONTENT_TYPES = Object.freeze([
    { id: 'talking', name: 'Talking to Camera', structure: ['hook', 'main_point', 'reaction', 'closing'] },
    { id: 'storytelling', name: 'Storytelling', structure: ['hook', 'setup', 'story', 'reaction', 'closing'] },
    { id: 'qa', name: 'Q&A', structure: ['question_hook', 'answer', 'personal_reaction', 'follow_up', 'closing'] },
    { id: 'reaction', name: 'Reaction', structure: ['hook', 'first_reaction', 'thought', 'final_reaction'] },
    { id: 'confession', name: 'Confession / Personal Story', structure: ['confessional_hook', 'context', 'reveal', 'reflection', 'closing'] },
    { id: 'audience_reply', name: 'Audience Reply', structure: ['address_viewer', 'respond', 'personal_take', 'closing'] },
    { id: 'lifestyle_update', name: 'Lifestyle Update', structure: ['greeting', 'update', 'small_detail', 'closing'] },
    { id: 'get_ready', name: 'Get Ready With Me', structure: ['hook', 'getting_ready', 'personal_story', 'final_look', 'closing'] },
    { id: 'outfit_talk', name: 'Outfit Talk', structure: ['hook', 'look_details', 'personal_note', 'closing'] },
    { id: 'advice', name: 'Advice', structure: ['hook', 'acknowledge', 'advice', 'encouragement', 'closing'] },
    { id: 'playful_monologue', name: 'Playful Monologue', structure: ['hook', 'setup', 'punchline', 'tag', 'closing'] }
]);

const DELIVERY_STYLES = Object.freeze([
    { id: 'natural', label: 'Natural', direction: 'Relaxed conversational delivery, natural pauses, easy facial movement and an unforced pace.' },
    { id: 'conversational', label: 'Conversational', direction: 'Speak to one viewer as a familiar person: fluid phrasing, responsive expressions and a comfortable pace.' },
    { id: 'playful', label: 'Playful', direction: 'Bright, playful phrasing, frequent genuine smiles, expressive reactions and occasional teasing pauses.' },
    { id: 'confident', label: 'Confident', direction: 'Clear, self-assured phrasing, steady energy, open posture and assured eye contact.' },
    { id: 'flirty', label: 'Flirty', direction: 'Suggestive but non-explicit creator delivery: confident eye contact, subtle smiles and smirks, playful pauses and relaxed confident posture.' },
    { id: 'teasing', label: 'Teasing', direction: 'Lightly mischievous delivery with a knowing smile, a brief anticipatory pause and a warm, playful payoff.' },
    { id: 'glamorous', label: 'Glamorous', direction: 'Polished, poised delivery, composed gestures, intentional eye contact and a refined lifestyle presence.' },
    { id: 'warm', label: 'Warm', direction: 'Kind, welcoming delivery with a soft smile, gentle gestures and attentive eye contact.' },
    { id: 'energetic', label: 'Energetic', direction: 'Upbeat, animated phrasing, lively but controlled gestures and bright expressions.' },
    { id: 'confessional', label: 'Confessional', direction: 'Intimate, candid delivery with thoughtful pauses, vulnerable warmth and direct personal connection.' },
    { id: 'seductive', label: 'Seductive', direction: 'Mature, glamorous and suggestive but non-explicit presentation: controlled eye contact, subtle smirks, slow deliberate delivery, confident posture and longer pauses.' }
]);

const SPEECH_BEHAVIORS = Object.freeze([
    { id: 'direct_to_camera', label: 'Direct-to-camera' },
    { id: 'conversational', label: 'Conversational' },
    { id: 'storytelling', label: 'Storytelling' },
    { id: 'confessional', label: 'Confessional' },
    { id: 'playful_teasing', label: 'Playful teasing' },
    { id: 'qa', label: 'Q&A' },
    { id: 'reacting', label: 'Reacting' }
]);

const CAMERA_PRESETS = Object.freeze([
    { id: 'talking_head', label: 'Talking Head', direction: 'stable eye-level talking-head framing' },
    { id: 'phone_selfie', label: 'Phone Selfie', direction: 'close, natural phone-selfie framing with only very subtle handheld movement' },
    { id: 'tripod', label: 'Tripod', direction: 'steady fixed tripod framing with natural subject movement' },
    { id: 'handheld_creator', label: 'Handheld Creator', direction: 'casual handheld creator framing with gentle natural reframing' },
    { id: 'desk_camera', label: 'Desk Camera', direction: 'comfortable desk-height camera framing, intimate and steady' },
    { id: 'bedroom_vlog', label: 'Bedroom Vlog', direction: 'casual bedroom-vlog framing at a natural conversational distance' },
    { id: 'close_talking_head', label: 'Close Talking Head', direction: 'close talking-head framing focused on face and lip-synced speech' },
    { id: 'medium_shot', label: 'Medium Shot', direction: 'steady medium shot showing expressive shoulders and natural hand gestures' }
]);

const CAMERA_MOTIONS = Object.freeze([
    { id: 'static', label: 'Static', direction: 'camera remains steady' },
    { id: 'subtle_handheld', label: 'Subtle handheld', direction: 'very subtle natural handheld movement' },
    { id: 'push_in', label: 'Small push-in', direction: 'a very gentle push-in, restrained and social-video natural' },
    { id: 'pull_back', label: 'Small pull-back', direction: 'a very gentle pull-back, restrained and social-video natural' },
    { id: 'reframe', label: 'Natural reframing', direction: 'slight natural reframing that keeps the creator comfortably in frame' }
]);

const EXPRESSION_ARCS = Object.freeze([
    { id: 'auto', label: 'Automatic', faceActionIds: [] },
    { id: 'smile_to_smirk', label: 'Smile → playful → smirk', faceActionIds: ['soft_smile', 'playful', 'amused', 'smirk', 'confident'] },
    { id: 'playful', label: 'Playful reactions', faceActionIds: ['soft_smile', 'playful', 'laughing', 'smirk', 'soft_smile'] },
    { id: 'storytelling', label: 'Storytelling arc', faceActionIds: ['soft_smile', 'thoughtful', 'curious', 'amused', 'warm'] },
    { id: 'warm', label: 'Warm connection', faceActionIds: ['soft_smile', 'natural', 'amused', 'soft_smile', 'warm'] }
]);

const BODY_ACTIONS = Object.freeze([
    { id: 'relaxed', label: 'Relaxed', phrase: 'comfortable relaxed posture, shoulders at ease and hands resting naturally' },
    { id: 'conversational_gesture', label: 'Conversational hand gestures', phrase: 'small, natural hand gestures that emphasize the spoken point' },
    { id: 'lean_in', label: 'Lean slightly toward camera', phrase: 'leans slightly toward the camera during the personal moment' },
    { id: 'lean_back', label: 'Lean back', phrase: 'settles back comfortably after the thought lands' },
    { id: 'shoulder_movement', label: 'Shoulder movement', phrase: 'a small natural shoulder movement accompanying the words' },
    { id: 'hair_adjustment', label: 'Hair adjustment', phrase: 'briefly adjusts a strand of hair, then returns attention to the viewer' },
    { id: 'hands_resting', label: 'Hands resting naturally', phrase: 'hands remain relaxed and naturally at rest' },
    { id: 'small_laugh', label: 'Small laugh movement', phrase: 'a small genuine laugh with a light shoulder bounce' },
    { id: 'look_and_return', label: 'Look away and return', phrase: 'briefly glances aside while thinking, then returns attention to the camera' }
]);

const VOICE_DEFAULTS = Object.freeze({ voiceId: '', tone: 'conversational', speed: 'natural', pitch: 'natural', energy: 'medium', emotion: 'warm' });

let store = null;

function loadStore() {
    if (store) return store;
    try {
        const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
        store = {
            sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {}
        };
        Object.values(store.sessions).forEach((session) => {
            if (!session || typeof session !== 'object') return;
            session.characterId = session.characterId || session.content && session.content.characterId || '';
            delete session.creatorId;
            if (session.content && typeof session.content === 'object') {
                session.content.characterId = session.content.characterId || session.characterId;
                delete session.content.creatorId;
            }
        });
    } catch (_) {
        store = { sessions: {} };
    }
    return store;
}

function saveStore() {
    const parent = path.dirname(STORE_PATH);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), sessions: loadStore().sessions }, null, 2), 'utf-8');
}

function clean(value, limit = 500) {
    return String(value === undefined || value === null ? '' : value).trim().slice(0, limit);
}

function normalizeVoice(input = {}) {
    const src = input && typeof input === 'object' ? input : {};
    return {
        voiceId: clean(src.voiceId, 100),
        tone: clean(src.tone || VOICE_DEFAULTS.tone, 60),
        speed: clean(src.speed || VOICE_DEFAULTS.speed, 40),
        pitch: clean(src.pitch || VOICE_DEFAULTS.pitch, 40),
        energy: clean(src.energy || VOICE_DEFAULTS.energy, 40),
        emotion: clean(src.emotion || VOICE_DEFAULTS.emotion, 60)
    };
}

function getSession(conversationId) {
    if (!conversationId) return null;
    return loadStore().sessions[String(conversationId)] || null;
}

function setSession(conversationId, session) {
    if (!conversationId || !session) return null;
    session.updatedAt = new Date().toISOString();
    loadStore().sessions[String(conversationId)] = session;
    saveStore();
    return session;
}

function clearSession(conversationId) {
    if (!conversationId) return false;
    const data = loadStore();
    const key = String(conversationId);
    if (!data.sessions[key]) return false;
    delete data.sessions[key];
    saveStore();
    return true;
}

function normalizeContentType(value) {
    const raw = clean(value, 80).toLowerCase().replace(/[\s/-]+/g, '_');
    if (CONTENT_TYPES.some((item) => item.id === raw)) return raw;
    const match = CONTENT_TYPES.find((item) => item.name.toLowerCase() === clean(value, 80).toLowerCase());
    return match ? match.id : 'talking';
}

function matchDeliveryStyle(text, fallback = 'natural') {
    const source = String(text || '').toLowerCase();
    const matches = [
        ['seductive', /\bseductive\b/], ['flirty', /\b(?:flirty|flirtatious)\b/],
        ['playful', /\b(?:playful|funny|cheeky)\b/], ['teasing', /\bteasing\b/],
        ['glamorous', /\bglamorous?\b/], ['confident', /\bconfident\b/],
        ['warm', /\bwarm\b/], ['energetic', /\benergetic\b/],
        ['confessional', /\bconfessional\b/], ['conversational', /\bconversational\b/],
        ['natural', /\b(?:natural|casual)\b/]
    ];
    const found = matches.find((entry) => entry[1].test(source));
    return found ? found[0] : (DELIVERY_STYLES.some((s) => s.id === fallback) ? fallback : 'natural');
}

function adultIsExplicit(character) {
    const identity = character && character.identity && typeof character.identity === 'object' ? character.identity : {};
    const ageMatch = String(identity.age || '').match(/\b(\d{2,})\s*[- ]year[- ]old\b/i);
    if (ageMatch) return Number(ageMatch[1]) >= 18;
    const group = String(identity.ageGroup || '').toLowerCase();
    const ageGroups = characterModel.AGE_GROUPS || {};
    return Boolean(ageGroups[group] && Number(ageGroups[group].min) >= 18);
}

function styleRequiresAdult(style) { return style === 'flirty' || style === 'seductive'; }

function inferContentType(text, fallback) {
    const source = String(text || '').toLowerCase();
    const rules = [
        ['storytelling', /\b(?:story|storytime|tell(?:s|ing)? .*story|funny story)\b/],
        ['qa', /\b(?:q\s*&\s*a|questions?|answer(?:s|ing)? .*question)\b/],
        ['reaction', /\b(?:react|reaction|respond(?:s|ing)? to)\b/],
        ['confession', /\b(?:confess|confession|personal story)\b/],
        ['audience_reply', /\b(?:reply|answer|respond) .*\b(?:audience|followers?|comment|viewer)\b/],
        ['lifestyle_update', /\b(?:update|weekend|day|morning|life lately)\b/],
        ['get_ready', /\b(?:get ready with me|grwm)\b/],
        ['outfit_talk', /\b(?:outfit|what i(?:'| a)m wearing)\b/],
        ['advice', /\b(?:advice|tip|recommendation)\b/],
        ['playful_monologue', /\b(?:monologue|playful rant)\b/]
    ];
    const match = rules.find((entry) => entry[1].test(source));
    return match ? match[0] : normalizeContentType(fallback);
}

function cleanConcept(value) {
    return clean(String(value || '').replace(/@[^\s,.;!?]+/g, '').replace(/\b(?:make|create|generate|record|have)\s+(?:a\s+)?(?:talking\s+)?(?:video|clip)\s+(?:for|of)\s*/i, ''), 500)
        .replace(/\s+/g, ' ');
}

function fallbackScript({ name, concept, contentType, personality, deliveryStyle }) {
    const subject = concept || 'what has been happening lately';
    const topic = subject.replace(/^(?:about|on|regarding)\s+/i, '').replace(/[.!?]+$/, '').split(/\s+/).slice(0, 3).join(' ');
    const title = CONTENT_TYPES.find((item) => item.id === contentType);
    const isStory = contentType === 'storytelling' || contentType === 'confession';
    const traits = new Set(Array.isArray(personality) ? personality : []);
    const playful = deliveryStyle === 'playful' || deliveryStyle === 'teasing' || traits.has('playful') || traits.has('funny') || traits.has('cheeky');
    const warm = deliveryStyle === 'warm' || traits.has('warm') || traits.has('charming');
    const confident = deliveryStyle === 'confident' || traits.has('confident');
    const hook = playful
        ? (isStory ? 'Okay, this ' + topic + ' got funny.' : 'Okay, quick update: ' + topic + '.')
        : warm
            ? 'Hey, I wanted to share ' + topic + ' with you.'
            : confident
                ? 'Quick update: ' + topic + '. Here is what happened.'
                : (isStory ? 'Quick story about ' + topic + '.' : 'Quick update about ' + topic + '.');
    const beats = playful
        ? [
            { text: 'I thought I had this completely under control.' },
            { text: 'Then the day decided to surprise me.' },
            { text: 'I was laughing before I could even react.' }
        ]
        : warm
            ? [
                { text: 'It turned into a moment I wanted to share.' },
                { text: 'The little details made it feel special.' },
                { text: 'I am glad I got to tell you about it.' }
            ]
            : [
                { text: 'I have been thinking about it all day.' },
                { text: 'The best part was how unexpectedly fun it got.' },
                { text: 'Would you have done the same?' }
            ];
    const closing = playful ? 'Tell me you would laugh too.' : 'Tell me what you think.';
    return { hook, beats, closing, contentTypeName: title ? title.name : 'Talking to Camera' };
}

function parseJsonObject(value) {
    const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(text); } catch (_) {}
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try { return JSON.parse(text.slice(start, end + 1)); } catch (_) {}
    }
    return null;
}

async function generateScript(input, providers, provider, model) {
    const base = fallbackScript(input);
    if (!providers || typeof providers.chat !== 'function') return fitScriptWordBudget(base, input.duration);
    const traits = input.personality.join(', ') || 'warm and natural';
    const style = DELIVERY_STYLES.find((s) => s.id === input.deliveryStyle) || DELIVERY_STYLES[0];
    const type = CONTENT_TYPES.find((t) => t.id === input.contentType) || CONTENT_TYPES[0];
    const budget = Math.max(8, Math.round(input.duration * 2.15));
    const prompt = 'Write a short, original direct-to-camera creator script as JSON with keys hook (string), beats (array of 2 to 4 short strings), closing (string). ' +
        'Content recipe: ' + type.name + ' (' + type.structure.join(' -> ') + '). Topic: ' + input.concept + '. Creator: ' + input.name + '. ' +
        'Personality traits: ' + traits + '. The traits must change word choice, sentence length, humor, pauses and audience connection; do not merely list traits. ' +
        'Delivery: ' + style.direction + ' Speak naturally to followers, not like an ad or a generic narration. Avoid invented factual claims. ' +
        'Keep the full script under ' + budget + ' words for ' + input.duration + ' seconds. Each beat should be a concise spoken thought. Return JSON only.';
    try {
        const raw = await providers.chat(provider, [
            { role: 'system', content: 'You are a dialogue writer for the supplied fictional virtual creator. Write natural, conversational, concise on-camera speech. Return only valid JSON.' },
            { role: 'user', content: prompt }
        ], model, { think: false });
        const parsed = parseJsonObject(raw);
        if (!parsed || !Array.isArray(parsed.beats) || !parsed.beats.length) return fitScriptWordBudget(base, input.duration);
        const hook = clean(parsed.hook || base.hook, 300);
        const beats = parsed.beats.slice(0, 4).map((beat) => clean(typeof beat === 'string' ? beat : beat && beat.text, 300)).filter(Boolean);
        const closing = clean(parsed.closing || base.closing, 300);
        return fitScriptWordBudget({ hook, beats, closing }, input.duration);
    } catch (_) {
        return fitScriptWordBudget(base, input.duration);
    }
}

function fitScriptWordBudget(script, duration) {
    const budget = Math.max(8, Math.round((Number(duration) || 15) * 2.15));
    const beatLines = (script.beats || []).map((beat) => typeof beat === 'string' ? beat : beat.text).filter(Boolean);
    const lineCount = beatLines.length + 2;
    const perLine = Math.max(2, Math.floor(budget / lineCount));
    const fitLine = (line) => {
        const words = String(line || '').trim().split(/\s+/).filter(Boolean);
        return words.slice(0, perLine).join(' ');
    };
    return {
        hook: fitLine(script.hook),
        beats: beatLines.map((line) => fitLine(line)).filter(Boolean).map((text) => ({ text })),
        closing: fitLine(script.closing)
    };
}

function bodyActionFor(index, requested) {
    const raw = String(requested || '').toLowerCase();
    if (/\b(?:hair|adjust(?:s|ing)? her hair)\b/.test(raw)) return BODY_ACTIONS.find((item) => item.id === 'hair_adjustment');
    if (/\blook(?:ing)? away|glance away|return(?:s|ing)? to (?:the )?camera\b/.test(raw)) return BODY_ACTIONS.find((item) => item.id === 'look_and_return');
    if (/\blean(?:s|ing)?\s+(?:slightly\s+)?in\b/.test(raw)) return BODY_ACTIONS.find((item) => item.id === 'lean_in');
    if (/\blean(?:s|ing)?\s+back\b/.test(raw)) return BODY_ACTIONS.find((item) => item.id === 'lean_back');
    if (/\bhand gesture|gestur(?:e|es|ing)\b/.test(raw)) return BODY_ACTIONS.find((item) => item.id === 'conversational_gesture');
    const explicit = BODY_ACTIONS.find((item) => raw.includes(item.id) || raw.includes(item.label.toLowerCase()));
    if (explicit && explicit.id !== 'conversational_gesture') return explicit;
    const catalog = activities.getActivity('casual-conversation');
    if (explicit && explicit.id === 'conversational_gesture' && catalog && Array.isArray(catalog.actions) && catalog.actions.length) {
        const phrase = catalog.actions[index % catalog.actions.length];
        return { id: 'activity_action_' + index, label: 'Conversational hand gestures', phrase };
    }
    const shared = catalog && catalog.actions && catalog.actions.length ? catalog.actions[index % catalog.actions.length] : '';
    const phrases = [
        { id: 'conversational_gesture', label: 'Conversational hand gestures', phrase: shared || BODY_ACTIONS[1].phrase },
        BODY_ACTIONS[0], BODY_ACTIONS[1], BODY_ACTIONS[7], BODY_ACTIONS[8]
    ];
    return phrases[index % phrases.length];
}

function resolveBeatFaceAction(id, context) {
    const resolved = faceActions.resolveFaceActionValue(id, context || {});
    return resolved || faceActions.getFaceAction('natural');
}

function performanceSequence(script, options) {
    const lines = [script.hook].concat((script.beats || []).map((beat) => typeof beat === 'string' ? beat : beat && beat.text), [script.closing]).filter(Boolean);
    const duration = Number(options.duration) || 15;
    const style = options.deliveryStyle;
    const arc = EXPRESSION_ARCS.find((item) => item.id === options.expressionArc);
    const sequence = arc && arc.faceActionIds.length ? arc.faceActionIds : style === 'flirty' || style === 'seductive'
        ? ['confident', 'soft_smile', 'playful', 'smirk', 'soft_smile']
        : style === 'playful' || style === 'teasing'
            ? ['soft_smile', 'playful', 'laughing', 'smirk', 'soft_smile']
            : style === 'confessional'
                ? ['soft_smile', 'thoughtful', 'natural', 'soft_smile', 'warm']
                : ['soft_smile', 'natural', 'amused', 'soft_smile', 'warm'];
    const weights = lines.map((_, index) => index === 0 ? 1.1 : index === lines.length - 1 ? 0.9 : 1);
    const total = weights.reduce((sum, n) => sum + n, 0);
    let cursor = 0;
    return lines.map((speech, index) => {
        const seconds = duration * weights[index] / total;
        const start = cursor;
        cursor += seconds;
        const faceAction = resolveBeatFaceAction(sequence[Math.min(index, sequence.length - 1)], { contexts: [style, 'lifestyle'] });
        const bodyAction = bodyActionFor(index, options.bodyAction);
        const gaze = options.eyeContact === 'strong' || style === 'flirty' || style === 'seductive'
            ? (index === 1 ? 'briefly glance aside, then return to the lens' : 'hold direct eye contact with the viewer')
            : options.eyeContact === 'low' ? 'natural intermittent eye contact with a brief thoughtful glance away' : 'natural direct-to-camera eye contact';
        return {
            speech,
            expression: faceAction.expression,
            mouth: faceAction.mouth,
            eyes: faceAction.eyes,
            gaze,
            head: faceAction.head,
            faceActionId: faceAction.id,
            faceAction: faceAction.prompt || faceActions.describeComponents(faceAction),
            bodyAction: bodyAction.id,
            gesture: bodyAction.phrase,
            camera: options.cameraDirection,
            timing: { start: Number(start.toFixed(2)), end: Number((start + seconds).toFixed(2)) },
            delivery: options.deliveryDirection
        };
    });
}

function resolveDimension(text) {
    const value = String(text || '').toLowerCase();
    if (/\b(?:script|what she says|dialogue|words|story|hook)\b/.test(value)) return 'script';
    if (/\b(?:voice|pitch|speed|speaking voice)\b/.test(value)) return 'voice';
    if (/\b(?:smile|smirk|expression|face|eye contact|gaze|facial)\b/.test(value)) return 'facial_performance';
    if (/\b(?:gesture|body language|pose|movement|hands|lean|shoulder)\b/.test(value)) return 'body_performance';
    if (/\b(?:camera|framing|handheld|tripod|close[- ]up)\b/.test(value)) return 'camera';
    if (/\b(?:outfit|clothes|wearing|wardrobe)\b/.test(value)) return 'outfit';
    if (/\b(?:scene|room|background|environment|bedroom|cafe|studio)\b/.test(value)) return 'scene';
    if (/\b(?:talk directly|direct[- ]to[- ]camera|address the audience|talk to (?:the )?(?:audience|camera|viewers)|followers|speech behavior)\b/.test(value)) return 'speech_behavior';
    if (/\b(?:delivery|playful|flirty|seductive|confident|glamorous|natural|warm|energy|pacing)\b/.test(value)) return 'delivery';
    if (/\b(?:everything|all of it|whole thing)\b/.test(value)) return 'everything';
    return '';
}

function classifyMessage(message, session) {
    if (!session || !session.content || !session.characterId) return null;
    const text = String(message || '').trim();
    if (!text || /\?\s*$/.test(text)) return null;
    if (/\b(?:new creator session|start a new creator session)\b/i.test(text)) return { type: 'new_session' };
    const dimension = resolveDimension(text);
    if (!dimension) return null;
    const hasChange = /\b(?:make|change|more|less|regenerate|redo|update|switch|keep|give|have|set|turn)\b/i.test(text);
    if (!hasChange) return null;
    return { type: 'generate', dimension, message: text };
}

function inferScene(value) {
    const text = String(value || '').toLowerCase();
    if (/\b(?:bedroom|getting ready)\b/.test(text)) return 'a relaxed bedroom creator setup';
    if (/\b(?:morning|wake up|breakfast)\b/.test(text)) return 'a bright, relaxed morning room';
    if (/\b(?:cafe|coffee shop|coffee)\b/.test(text)) return 'a quiet cafe table with a natural creator-video background';
    if (/\b(?:desk|work|office|study)\b/.test(text)) return 'a comfortable desk-side creator setup';
    if (/\b(?:outdoors|park|walk|outside)\b/.test(text)) return 'a calm outdoor creator setting with soft natural activity behind her';
    return 'a relaxed, uncluttered everyday creator setting';
}

function seededRandom(seed) {
    let state = Number(seed) >>> 0;
    return function () {
        state = (state + 0x6D2B79F5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function stableSeed(text) {
    let hash = 2166136261;
    for (const ch of String(text || '')) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
    return hash >>> 0;
}

function detectCreatorIntent(message, characters = []) {
    const text = String(message || '');
    const contentRequest = /\b(?:talk(?:ing)?|speak(?:ing)?|tell(?:ing)?|storytime|storytelling|q\s*&\s*a|answer(?:ing)? questions|react(?:ing)?|monologue|audience|followers?|vlog|creator video|talk to camera|direct[- ]to[- ]camera)\b/i.test(text);
    if (!contentRequest) return false;
    const explicitStudio = /\bcreator studio\b/i.test(text);
    if (/\b(?:write|draft|brainstorm|suggest)\b[\s\S]{0,35}\b(?:prompt|idea|script outline)\b/i.test(text)) return false;
    if (/\?\s*$/.test(text) && !/^(?:please|can you|could you|would you|create|make|generate|record|shoot|film)\b/i.test(text.trim())) return false;
    const asksForStill = /\b(?:image|picture|photo|photograph|portrait|illustration)\b/i.test(text) &&
        /\b(?:generate|create|draw|render|make)\b/i.test(text) && !/\b(?:video|clip|vlog|record|shoot|film)\b/i.test(text);
    if (asksForStill) return false;
    const namedCharacter = characters.length > 0 || /@[-a-zA-Z0-9_-]+/.test(text);
    return explicitStudio || characters.length > 0 || /@[^\s@]+/.test(text);
}

function buildContentDefaults(input, character, previousSession) {
    const previous = previousSession && previousSession.content || {};
    const merged = Object.assign({}, previous, input || {});
    const styleId = matchDeliveryStyle(merged.deliveryStyle || merged.message || merged.concept, previous.deliveryStyle || 'natural');
    const contentType = inferContentType(merged.message || merged.concept || '', merged.contentType || previous.contentType || 'talking');
    const duration = Math.max(3, Math.min(15, Math.round(Number(merged.duration) || Number(previous.duration) || 15)));
    const cameraPreset = CAMERA_PRESETS.find((x) => x.id === merged.camera || x.id === previous.camera) || CAMERA_PRESETS[0];
    const cameraMotion = CAMERA_MOTIONS.find((x) => x.id === merged.cameraMotion || x.id === previous.cameraMotion) || CAMERA_MOTIONS[0];
    const rawTraits = merged.personality || previous.personality || [];
    const personality = [...new Set((Array.isArray(rawTraits) ? rawTraits : []).map((x) => clean(x, 40).toLowerCase()).filter((x) => PERSONALITY_TRAITS.includes(x)))].slice(0, 6);
    const style = DELIVERY_STYLES.find((s) => s.id === styleId) || DELIVERY_STYLES[0];
    const voice = normalizeVoice(merged.voice || previous.voice);
    const behavior = SPEECH_BEHAVIORS.find((item) => item.id === merged.speechBehavior) || SPEECH_BEHAVIORS[0];
    const eyeContact = ['low', 'natural', 'strong'].includes(merged.eyeContact) ? merged.eyeContact : styleId === 'flirty' || styleId === 'seductive' ? 'strong' : 'natural';
    const energy = ['low', 'medium', 'high'].includes(merged.energy) ? merged.energy : 'medium';
    const pacing = ['slow', 'natural', 'fast'].includes(merged.pacing) ? merged.pacing : 'natural';
    const cameraDirection = cameraPreset.direction + '; ' + cameraMotion.direction + '.';
    const dimension = clean(merged.dimension || '', 50);
    const requestedOutfitPack = clean(merged.outfitPack || previous.outfitPack || character.outfitPack || '', 80);
    const outfitPackChanged = Boolean(previous.outfitPack && requestedOutfitPack && previous.outfitPack !== requestedOutfitPack);
    const rawScene = clean(merged.scene || previous.scene || 'Auto', 200);
    const rawOutfit = clean(merged.outfit || previous.outfit || 'Auto', 200);
    const scene = rawScene.toLowerCase() === 'auto'
        ? (dimension !== 'scene' && previous.scene && previous.scene.toLowerCase() !== 'auto' ? previous.scene : inferScene(merged.concept || merged.message))
        : rawScene;
    const outfit = rawOutfit.toLowerCase() === 'auto'
        ? (dimension !== 'outfit' && !outfitPackChanged && previous.outfit && previous.outfit.toLowerCase() !== 'auto' ? previous.outfit : 'Auto')
        : rawOutfit;
    const outfitSource = rawOutfit.toLowerCase() === 'auto'
        ? (outfitPackChanged ? 'automatic' : previous.outfitSource || 'automatic')
        : 'explicit';
    return {
        id: merged.id || previous.id || ('content_' + Date.now().toString(36)),
        characterId: character.id,
        creatorName: clean(character.name, 80) || 'Creator',
        contentType,
        concept: cleanConcept(merged.concept || merged.message || previous.concept) || 'a personal update for the audience',
        deliveryStyle: styleId,
        deliveryDirection: style.direction,
        personality,
        speechBehavior: behavior.id,
        energy,
        pacing,
        pauseFrequency: ['low', 'medium', 'high'].includes(merged.pauseFrequency) ? merged.pauseFrequency : (styleId === 'flirty' || styleId === 'seductive' ? 'high' : 'medium'),
        eyeContact,
        duration,
        voice,
        scene,
        outfit,
        outfitSource,
        outfitPack: requestedOutfitPack,
        camera: cameraPreset.id,
        cameraMotion: cameraMotion.id,
        cameraDirection,
        bodyAction: clean(merged.bodyAction || previous.bodyAction, 80),
        expressionArc: EXPRESSION_ARCS.some((arc) => arc.id === merged.expressionArc) ? merged.expressionArc : 'auto',
        expressionVariation: ['low', 'medium', 'high'].includes(merged.expressionVariation) ? merged.expressionVariation : 'high',
        modifiedDimension: dimension,
        existing: previous
    };
}

async function buildCreatorContent(input, character, options = {}) {
    if (!character || !character.id) {
        const error = new Error('Creator Studio requires a saved Character. Choose or create one in the Character System first.');
        error.code = 'creator_character_required';
        throw error;
    }
    const content = buildContentDefaults(input, character, options.previousSession);
    if (styleRequiresAdult(content.deliveryStyle) && !adultIsExplicit(character)) {
        const error = new Error('Flirty and seductive delivery require a Character whose structured identity explicitly records an adult age. Update the Character profile first.');
        error.code = 'creator_adult_required';
        throw error;
    }

    if (!content.outfit || content.outfit.toLowerCase() === 'auto') {
        const detectedPack = outfitPacks.detectOutfitPackFromText(content.concept + ' ' + content.scene);
        const packId = content.outfitPack || character.outfitPack || detectedPack || 'casual-everyday';
        if (outfitPacks.isCustomPack(packId)) {
            content.outfit = clean(character.outfitPackCustom, 200) || 'a comfortable outfit suitable for the creator setting';
        } else {
            const identity = character.identity && typeof character.identity === 'object' ? character.identity : {};
            const composed = outfitPacks.composeFromPack(packId, seededRandom(stableSeed(content.characterId + '|' + content.id)), {
                environment: content.scene,
                scene: content.concept,
                gender: identity.gender || '',
                seed: content.id
            });
            content.outfit = composed.outfit || 'a simple, comfortable everyday outfit';
            content.outfitPack = composed.packId || packId;
            content.outfitSource = 'automatic';
        }
    }
    if (content.modifiedDimension === 'scene' && content.outfitSource === 'automatic' && content.outfit && content.outfit.toLowerCase() !== 'auto') {
        const adapted = outfitPacks.resolveOutfitForEnvironment(content.outfit, content.scene, { scene: content.concept });
        if (adapted && adapted.outfit) content.outfit = adapted.outfit;
    }

    const previousContent = content.existing || {};
    const dimension = content.modifiedDimension;
    if (dimension && dimension !== 'everything' && previousContent.script && dimension !== 'script') {
        content.script = previousContent.script;
    } else {
        content.script = await generateScript({
            name: content.creatorName,
            concept: content.concept,
            contentType: content.contentType,
            personality: content.personality,
            deliveryStyle: content.deliveryStyle,
            duration: content.duration
        }, options.providers, options.provider, options.model);
    }

    const beats = performanceSequence(content.script, content);
    if (dimension && dimension !== 'everything' && previousContent.performanceBeats && dimension !== 'script') {
        if (dimension === 'facial_performance') {
            const requestedAction = faceActions.matchFaceActionFromText(input.message || '');
            const text = String(input.message || '');
            const startPhrase = text.match(/(?:smil\w*|grinn?\w*|smirk\w*|laugh\w*|wink\w*|playful)[^.!?]*(?:beginning|start|opening)|(?:beginning|start|opening)[^.!?]*(?:smil\w*|grinn?\w*|smirk\w*|laugh\w*|wink\w*|playful)/i);
            const endPhrase = text.match(/(?:smil\w*|grinn?\w*|smirk\w*|laugh\w*|wink\w*|playful)[^.!?]*(?:near|at|toward|by)?\s*(?:the\s+)?end|(?:end|finish|closing)[^.!?]*(?:smil\w*|grinn?\w*|smirk\w*|laugh\w*|wink\w*|playful)/i);
            const startAction = startPhrase && faceActions.matchFaceActionFromText(startPhrase[0]);
            const endAction = endPhrase && faceActions.matchFaceActionFromText(endPhrase[0]);
            content.performanceBeats = previousContent.performanceBeats.map((beat, index) => {
                const isStartOrEnd = index === 0 || index === previousContent.performanceBeats.length - 1;
                const selectedAction = index === 0 && startAction && startAction.confident
                    ? startAction
                    : index === previousContent.performanceBeats.length - 1 && endAction && endAction.confident
                        ? endAction
                        : null;
                const face = selectedAction
                    ? faceActions.composeFaceAction(selectedAction.action)
                    : requestedAction && requestedAction.confident && isStartOrEnd
                        ? faceActions.composeFaceAction(requestedAction.action)
                    : resolveBeatFaceAction(index === 0 ? 'soft_smile' : index === previousContent.performanceBeats.length - 1 ? 'smirk' : 'playful');
                return Object.assign({}, beat, {
                    expression: face.expression, mouth: face.mouth, eyes: face.eyes, head: face.head,
                    faceActionId: face.id, faceAction: face.prompt || faceActions.describeComponents(face)
                });
            });
        } else if (dimension === 'body_performance') {
            content.performanceBeats = previousContent.performanceBeats.map((beat, index) =>
                Object.assign({}, beat, { bodyAction: bodyActionFor(index, input.message).id, gesture: bodyActionFor(index, input.message).phrase }));
        } else {
            content.performanceBeats = previousContent.performanceBeats.map((beat) => Object.assign({}, beat));
        }
        if (dimension === 'camera') content.performanceBeats = content.performanceBeats.map((beat) => Object.assign({}, beat, { camera: content.cameraDirection }));
    } else {
        content.performanceBeats = beats;
    }

    content.script = content.script || fallbackScript(content);
    content.recipe = CONTENT_TYPES.find((item) => item.id === content.contentType) || CONTENT_TYPES[0];
    content.identity = {
        characterId: character.id,
        characterName: character.name,
        age: character.identity && character.identity.age || '',
        ageGroup: character.identity && character.identity.ageGroup || ''
    };
    content.voiceDirection = [
        'Voice profile: ' + (content.voice.voiceId || 'default creator voice') + ', ' + content.voice.tone + ' tone, ' + content.voice.speed + ' pace, ' + content.voice.pitch + ' pitch, ' + content.voice.energy + ' energy, ' + content.voice.emotion + ' emotion.',
        'Speech behavior: ' + content.speechBehavior.replace(/_/g, ' ') + '; energy ' + content.energy + '; pacing ' + content.pacing + '; pauses ' + content.pauseFrequency + '; eye contact ' + content.eyeContact + '.'
    ].join(' ');
    content.shotPlan = content.performanceBeats.map((beat, index) => {
        const time = beat.timing;
        return 'Creator beat ' + (index + 1) + ' (' + time.start.toFixed(1) + '–' + time.end.toFixed(1) + ' seconds): ' +
            'The on-screen creator (S1), ' + content.creatorName + ', speaks directly to the audience with visible natural lip synchronization; exact dialogue: <d>[English] ' + beat.speech + '</d> ' +
            'Facial performance: ' + beat.faceAction + '. Expression may change this beat without changing facial identity. Gaze: ' + beat.gaze + '. ' +
            'Body performance: ' + beat.gesture + '. Camera: ' + beat.camera + '. Delivery: ' + beat.delivery;
    });
    content.userPrompt = [
        'Creator content: ' + content.recipe.name + '. Concept: ' + content.concept + '.',
        'IDENTITY: use the supplied existing Character identity reference as the same person throughout. Preserve facial identity and proportions, eye shape and colour, nose, lips, hair and hairstyle, complexion and undertone, age and distinctive features. Personality, expression, wardrobe, lighting and camera never alter identity.',
        'PERFORMANCE: ' + content.deliveryDirection + ' Traits shape spoken vocabulary, sentence rhythm, pauses, facial transitions, gestures and audience connection; do not render trait words as identity descriptors.',
        'ENVIRONMENT: ' + content.scene + '. Wardrobe: ' + content.outfit + '.',
        'CAMERA: ' + content.cameraDirection + ' Avoid aggressive cinematic moves; preserve authentic creator-video framing.',
        content.voiceDirection,
        'Perform these ordered talking beats with varied facial expression and supportive body language: ' + content.shotPlan.join(' ')
    ].join('\n\n');
    delete content.existing;
    return content;
}

function normalizeAction(input) {
    const src = input && typeof input === 'object' ? input : {};
    return src.type === 'generate' || src.type === 'new_session' ? src : null;
}

function identityReferenceFilenames(identity) {
    if (!identity) return [];
    const source = identity.sourceAbs ? path.basename(identity.sourceAbs) : '';
    const references = Array.isArray(identity.references)
        ? identity.references.map((filename) => path.basename(String(filename || '')))
        : [];
    return [...new Set([source, ...references].filter(Boolean))].slice(0, 9);
}

function recordVideo(session, content, video) {
    const result = session || { id: 'creator_session_' + Date.now().toString(36), videos: [] };
    result.characterId = content.characterId;
    result.content = content;
    result.status = 'ready';
    result.videos = Array.isArray(result.videos) ? result.videos : [];
    result.videos.push({ id: 'creator_video_' + Date.now().toString(36), title: content.concept, url: video.url, prompt: video.prompt || '', createdAt: new Date().toISOString(), contentType: content.contentType });
    result.updatedAt = new Date().toISOString();
    return result;
}

function catalog() {
    return {
        personalityTraits: PERSONALITY_TRAITS.slice(),
        contentTypes: CONTENT_TYPES.map((x) => ({ id: x.id, name: x.name, structure: x.structure.slice() })),
        deliveryStyles: DELIVERY_STYLES.map((x) => ({ id: x.id, label: x.label, direction: x.direction })),
        speechBehaviors: SPEECH_BEHAVIORS.map((x) => ({ ...x })),
        cameraPresets: CAMERA_PRESETS.map((x) => ({ ...x })),
        cameraMotions: CAMERA_MOTIONS.map((x) => ({ ...x })),
        expressionArcs: EXPRESSION_ARCS.map((x) => ({ id: x.id, label: x.label })),
        bodyActions: BODY_ACTIONS.map((x) => ({ id: x.id, label: x.label })),
        outfitPacks: outfitPacks.listPacks().map((pack) => ({ id: pack.id, label: pack.label })),
        faceActions: faceActions.listFaceActions(),
        voiceDefaults: { ...VOICE_DEFAULTS }
    };
}

module.exports = {
    STORE_PATH,
    PERSONALITY_TRAITS,
    CONTENT_TYPES,
    DELIVERY_STYLES,
    SPEECH_BEHAVIORS,
    CAMERA_PRESETS,
    CAMERA_MOTIONS,
    EXPRESSION_ARCS,
    BODY_ACTIONS,
    loadStore,
    getSession,
    setSession,
    clearSession,
    normalizeVoice,
    normalizeContentType,
    matchDeliveryStyle,
    adultIsExplicit,
    styleRequiresAdult,
    inferContentType,
    classifyMessage,
    detectCreatorIntent,
    resolveDimension,
    fallbackScript,
    fitScriptWordBudget,
    generateScript,
    performanceSequence,
    buildCreatorContent,
    normalizeAction,
    identityReferenceFilenames,
    recordVideo,
    catalog
};
