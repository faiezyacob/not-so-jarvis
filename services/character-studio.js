/* JARVIS Character Studio domain boundary. SPDX-License-Identifier: MIT */

const character = require('./playground/character');
const presets = require('./character-presets');

function createRandomCharacter(options = {}) {
    const identity = character.generateUniqueIdentity(options.seed === undefined ? Math.random : options.seed, options.avoidSignatures, options.profile);
    return presets.create(Object.assign({}, options, {
        name: options.name || identity.name,
        identity,
        identityText: identity.identityText,
        identitySignature: identity.signature,
        provenance: { type: 'generated', seed: identity.seed }
    }));
}

function normalizeCharacter(value) {
    return character.normalizeCharacter(value);
}

function migrateCharacter(value) {
    return character.normalizeCharacter(value);
}

function saveCharacter(value) {
    return value && value.id ? presets.update(value.id, value) : presets.create(value);
}

function updateCharacter(id, patch, expectedRevision) {
    const current = presets.get(id);
    if (!current) return null;
    if (expectedRevision && Number(current.revision) !== Number(expectedRevision)) {
        const error = new Error('Character revision is stale.');
        error.code = 'stale_revision';
        throw error;
    }
    if (patch && (patch.profile || patch.characterProfile)) {
        const error = new Error('Profile changes create a new character variant; the saved character was not changed.');
        error.code = 'character_variant_required';
        throw error;
    }
    return presets.update(id, patch);
}

module.exports = {
    createRandomCharacter,
    normalizeCharacter,
    migrateCharacter,
    saveCharacter,
    updateCharacter,
    duplicateCharacter: presets.duplicate,
    resolveCharacter: presets.get,
    generatePortraitRequest(characterRecord) {
        const c = character.normalizeCharacter(characterRecord);
        if (!c.identity) return null;
        return {
            intent: 'image_generation',
            subject: { identityText: c.identityText, appearance: c.identity, identitySignature: c.identitySignature },
            scene: {},
            user_prompt: 'A neutral head-and-shoulders identity reference portrait of ' + c.identityText + ', plain studio background, soft even lighting, facing camera.',
            authoritativeConstraints: ['Show exactly this person: ' + c.identityText, 'Plain neutral studio background', 'Head-and-shoulders portrait framing'],
            explicit_constraints: ['Show exactly this person: ' + c.identityText, 'Plain neutral studio background', 'Head-and-shoulders portrait framing'],
            creativeHints: [],
            creative_mode: 'light',
            portrait: true
        };
    }
};
