/* SPDX-License-Identifier: MIT */
/* ============================================
   JARVIS — H3 Long-Take consistency layer
   Integration of the temporal-continuation
   strategy from xyzDist/H3-LongTakeNoCuts (MIT)
   into the EXISTING long-video pipeline.

   The reference fixes MiniMax H3's "photocopy"
   degradation by (1) adding an extra low-denoise
   Resample (Refine) pass over the accumulated
   latent and (2) blending the refined latent back
   in by frames so the continuity-critical frames
   are preserved. Degradation starts around
   segments 5-6 because each continuation trusts
   the previous segment as ground truth and the
   drift compounds.

   JARVIS delegates the actual frame-to-frame
   chaining to the H3LongVideos AIO node, which
   owns its internal latents and exposes no
   conditioning to re-sample, so the reference's
   refine+blend pass cannot be injected into the
   chain without replacing that node. Its operative
   PRINCIPLE does apply, and this module applies it:
   never let a continuation trust only the degraded
   previous segment — re-establish the pristine,
   drift-free reference on every shot.

   The AIO node exposes exactly two mid-chain
   re-anchoring channels:
     * anchor           — scene / style / lighting,
                          prepended to every shot.
     * character_memory — who is in it and what they
                          wear, carried across the whole
                          chain and the only channel that
                          can change mid-chain.
   Feeding both from the Story Bible pins identity,
   appearance, wardrobe, environment and lighting
   across every continuation. That is the LongTake
   re-anchor, adapted to this architecture.

   The reference's own parameters are kept here for
   parity and debugging even though the AIO node
   owns the equivalent internal sampling:
     refine denoise   0.5-0.6
     refine steps     a few
     blend keyframes  0:0, 22:0, 44:1
   ============================================ */

const LONGTAKE_TECHNIQUE = Object.freeze({
    source: 'xyzDist/H3-LongTakeNoCuts',
    license: 'MIT',
    refineDenoise: 0.55,
    refineSteps: 4,
    blendKeyframes: '0:0, 22:0, 44:1',
    appliedMechanism: 'per-shot re-anchor (anchor + character_memory)'
});

function str(value) {
    return String(value === undefined || value === null ? '' : value).trim();
}

function truthy(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const s = String(value).trim().toLowerCase();
    if (s === 'false' || s === '0' || s === 'off' || s === 'no' || s === 'none') return false;
    if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true;
    return fallback;
}

// The scene / style re-anchor: environment, lighting, visual style and camera
// language the node re-asserts on every shot. Empty when the Story Bible
// carries nothing — never invented.
function buildAnchor(bible) {
    const b = bible && typeof bible === 'object' ? bible : {};
    const env = b.environment && typeof b.environment === 'object' ? b.environment : {};
    const parts = [];
    const envLine = [env.timeOfDay, env.weather, env.location]
        .map(str).filter(Boolean).join(', ');
    if (envLine) {
        parts.push(envLine + (str(env.lighting) ? ', ' + str(env.lighting) : ''));
    }
    if (str(b.visualStyle)) parts.push(str(b.visualStyle));
    if (str(b.cameraStyle)) parts.push(str(b.cameraStyle));
    return parts.join('. ');
}

// The identity / wardrobe re-anchor for the node's only mid-chain channel:
// who is in it and what they wear, carried across the whole chain so the
// decode/handoff cannot let identity, appearance or clothing drift.
function buildCharacterMemory(bible) {
    const b = bible && typeof bible === 'object' ? bible : {};
    const characters = Array.isArray(b.characters) ? b.characters : [];
    const lines = characters.map((character) => {
        if (!character || typeof character !== 'object') return '';
        const name = str(character.name || character.id);
        const bits = [str(character.appearance), str(character.clothing)]
            .filter(Boolean).join(', ');
        const attributes = Array.isArray(character.persistentAttributes)
            ? character.persistentAttributes.map(str).filter(Boolean)
            : [];
        let line = bits;
        if (name) line = bits ? name + ': ' + bits : name;
        if (attributes.length) line = (line ? line + ' ' : '') + '(' + attributes.join('; ') + ')';
        return line;
    }).filter(Boolean);
    return lines.join('. ');
}

// Re-anchor is on by default (it only reinforces what the user already asked
// for). H3_LONGTAKE_REANCHOR=false / settings.longTake.reanchor=false disables
// it for a faithful "before" comparison.
function normalizeLongTakeSettings(settings = {}) {
    const stored = settings && typeof settings.longTake === 'object' && settings.longTake
        ? settings.longTake
        : {};
    const reanchor = stored.reanchor !== undefined
        ? truthy(stored.reanchor, true)
        : truthy(process.env.H3_LONGTAKE_REANCHOR, true);
    return { reanchor: reanchor !== false };
}

// Resolve the two re-anchor wires for one long-video run from the approved
// Story Bible.
function buildLongTakeContext({ bible, settings } = {}) {
    const config = normalizeLongTakeSettings(settings || {});
    const anchor = config.reanchor ? buildAnchor(bible) : '';
    const characterMemory = config.reanchor ? buildCharacterMemory(bible) : '';
    return {
        enabled: config.reanchor,
        anchor,
        characterMemory,
        identityLocked: Boolean(characterMemory),
        sceneLocked: Boolean(anchor)
    };
}

// Compact telemetry for generated-history metadata / logs.
function describeLongTake(context) {
    const ctx = context && typeof context === 'object' ? context : {};
    return {
        technique: LONGTAKE_TECHNIQUE.source,
        reanchor: Boolean(ctx.enabled),
        identityLocked: Boolean(ctx.identityLocked),
        sceneLocked: Boolean(ctx.sceneLocked)
    };
}

module.exports = {
    LONGTAKE_TECHNIQUE,
    buildAnchor,
    buildCharacterMemory,
    normalizeLongTakeSettings,
    buildLongTakeContext,
    describeLongTake
};
