/* ============================================
   JARVIS — Image provider registry
   SPDX-License-Identifier: MIT
   ============================================ */

// The single place that declares which image pipelines JARVIS can run and what
// each one supports. Workflow construction stays in services/image-generator.js
// (one builder per provider); this module is data only so the settings API and
// the UI can present capabilities without knowing node IDs or graph details.
//
// `id` is the persisted text-to-image value (imageGeneration.model), and
// `editId` is the persisted editor value (imageGeneration.editEngine). A
// provider may contribute each capability independently.

const IMAGE_PROVIDERS = Object.freeze([
    {
        id: 'qwen_image_2_1',
        editId: 'qwen',
        label: 'Qwen Image 2.1',
        editLabel: 'Qwen Image 2.1 Edit',
        capabilities: {
            textToImage: true,
            imageEdit: true,
            multipleReferences: true,
            maxReferences: 5,
            promptEnhancement: false,
            negativePrompt: true,
            skipLayerGuidance: false
        },
        models: ['diffusion_models', 'text_encoders', 'vae']
    },
    {
        id: 'krea2',
        editId: 'krea2',
        label: 'Krea2',
        editLabel: 'Krea 2 Edit',
        capabilities: {
            textToImage: true,
            imageEdit: true,
            multipleReferences: false,
            maxReferences: 1,
            promptEnhancement: false,
            negativePrompt: true,
            skipLayerGuidance: false
        },
        models: ['diffusion_models', 'text_encoders', 'vae', 'loras']
    },
    {
        id: 'minimax_h3_image',
        editId: 'minimax_h3',
        label: 'MiniMax H3 Image',
        editLabel: 'MiniMax H3 Image Edit',
        capabilities: {
            textToImage: true,
            imageEdit: true,
            multipleReferences: true,
            maxReferences: 8,
            promptEnhancement: false,
            negativePrompt: false,
            skipLayerGuidance: false
        },
        models: ['diffusion_models', 'text_encoders', 'vae']
    },
    {
        // MOSS-Image (Comfy-Org/MOSS-Image). One diffusion model + one Qwen3.5
        // 9B text encoder (CLIPLoader type `moss_image`) + FLUX.2 small VAE.
        // Text-to-image uses the prompt enhancer (TextGenerate on the same text
        // encoder); editing adds the dedicated edit LoRA and the core
        // TextEncodeMOSSImageEdit node (ComfyUI 0.43.0+).
        id: 'moss',
        editId: 'moss',
        label: 'MOSS-Image',
        editLabel: 'MOSS-Image Edit',
        capabilities: {
            textToImage: true,
            imageEdit: true,
            multipleReferences: true,
            maxReferences: 4,
            promptEnhancement: true,
            negativePrompt: true,
            skipLayerGuidance: true
        },
        models: ['diffusion_models', 'text_encoders', 'vae', 'loras'],
        requirements: {
            comfyuiEditVersion: '0.43.0',
            editNodes: ['TextEncodeMOSSImageEdit']
        }
    }
]);

function providerById(value) {
    const wanted = String(value == null ? '' : value).trim().toLowerCase();
    return IMAGE_PROVIDERS.find((p) => p.id === wanted) || null;
}

function providerByEditId(value) {
    const wanted = String(value == null ? '' : value).trim().toLowerCase();
    return IMAGE_PROVIDERS.find((p) => p.editId === wanted) || null;
}

function providerLabel(value) {
    const provider = providerById(value);
    return provider ? provider.label : IMAGE_PROVIDERS[0].label;
}

function editProviderLabel(value) {
    const provider = providerByEditId(value);
    return provider ? provider.editLabel : IMAGE_PROVIDERS[0].editLabel;
}

function listImageProviders() {
    return IMAGE_PROVIDERS.map((p) => ({
        id: p.id,
        editId: p.editId,
        label: p.label,
        editLabel: p.editLabel,
        capabilities: { ...p.capabilities },
        models: p.models.slice(),
        requirements: p.requirements ? { ...p.requirements } : null
    }));
}

function imageProvidersJson() {
    return {
        textToImage: listImageProviders(),
        imageEdit: listImageProviders().filter((p) => p.capabilities.imageEdit)
    };
}

module.exports = {
    IMAGE_PROVIDERS,
    providerById,
    providerByEditId,
    providerLabel,
    editProviderLabel,
    listImageProviders,
    imageProvidersJson
};
