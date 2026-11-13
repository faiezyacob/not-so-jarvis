/* ============================================
   JARVIS — MOSS-Image provider (text-to-image + edit)
   Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const imageGenerator = require('../services/image-generator');
const imageProviders = require('../services/image-providers');

const MOSS_INFO = {
    UNETLoader: { input: { required: { unet_name: [['moss_image_sft_int8_convrot.safetensors']] } } },
    CLIPLoader: {
        input: {
            required: {
                clip_name: [['qwen3.5_9b_w4a8_gptq.safetensors']],
                type: [['moss_image', 'qwen_image']]
            }
        }
    },
    VAELoader: { input: { required: { vae_name: [['flux2-vae_small.safetensors']] } } },
    LoraLoaderModelOnly: { input: { required: { lora_name: [['moss_image_edit_lora_rank_64_bf16.safetensors']] } } },
    TextEncodeMOSSImageEdit: {},
    EmptyFlux2LatentImage: {},
    SkipLayerGuidanceDiTSimple: {},
    ImageScaleToTotalPixels: {},
    GetImageSize: {},
    TextGenerate: {}
};

function mossSettings(extra = {}) {
    return Object.assign({}, imageGenerator.getDefaults(), { model: 'moss' }, extra);
}

test('provider registry: MOSS is registered with its own capabilities', () => {
    const moss = imageProviders.providerById('moss');
    assert.ok(moss);
    assert.equal(moss.editId, 'moss');
    assert.equal(moss.label, 'MOSS-Image');
    assert.equal(moss.editLabel, 'MOSS-Image Edit');
    assert.equal(moss.capabilities.textToImage, true);
    assert.equal(moss.capabilities.imageEdit, true);
    assert.equal(moss.capabilities.multipleReferences, true);
    assert.equal(moss.capabilities.promptEnhancement, true);
    assert.equal(moss.capabilities.maxReferences, 4);
    assert.equal(moss.requirements.comfyuiEditVersion, '0.43.0');
    assert.equal(imageProviders.providerByEditId('moss').id, 'moss');
});

test('normalizeImageModel / normalizeEditEngine: MOSS aliases', () => {
    for (const alias of ['moss', 'moss_image', 'moss-image', 'Moss Image', 'MOSS-Image']) {
        assert.equal(imageGenerator.normalizeImageModel(alias), 'moss', alias);
    }
    for (const alias of ['moss', 'moss_image', 'moss_edit', 'MOSS-Image Edit']) {
        assert.equal(imageGenerator.normalizeEditEngine(alias), 'moss', alias);
    }
    assert.ok(imageGenerator.IMAGE_MODELS.includes('moss'));
    assert.ok(imageGenerator.EDIT_ENGINES.includes('moss'));
});

test('imageModelLabel / editEngineLabel: readable MOSS labels', () => {
    assert.equal(imageGenerator.imageModelLabel('moss'), 'MOSS-Image');
    assert.equal(imageGenerator.editEngineLabel('moss'), 'MOSS-Image Edit');
});

test('defaults: MOSS files, sampling and edit format match the official templates', () => {
    const defaults = imageGenerator.getDefaults();
    assert.equal(defaults.mossUnet, 'moss_image_sft_int8_convrot.safetensors');
    assert.equal(defaults.mossClip, 'qwen3.5_9b_w4a8_gptq.safetensors');
    assert.equal(defaults.mossVae, 'flux2-vae_small.safetensors');
    assert.equal(defaults.mossEditLora, 'moss_image_edit_lora_rank_64_bf16.safetensors');
    assert.equal(defaults.mossSteps, 25);
    assert.equal(defaults.mossCfg, 2.5);
    assert.equal(defaults.mossSampler, 'er_sde');
    assert.equal(defaults.mossScheduler, 'simple');
    assert.equal(defaults.mossPromptEnhancer, true);
    assert.equal(defaults.mossEditSteps, 30);
    assert.equal(defaults.mossEditCfg, 4);
    assert.equal(defaults.mossEditFormat, 'Moss-Image-Edit');
    assert.equal(defaults.mossEditLoraStrength, 1);
    assert.equal(defaults.mossEditMegapixels, 1);
});

test('sanitizeSettings: MOSS values are validated and clamped', () => {
    assert.deepEqual(imageGenerator.sanitizeSettings({ model: 'MOSS-Image' }), { model: 'moss' });
    assert.deepEqual(imageGenerator.sanitizeSettings({ editEngine: 'moss' }), { editEngine: 'moss' });
    assert.deepEqual(imageGenerator.sanitizeSettings({ mossPromptEnhancer: false }), { mossPromptEnhancer: false });
    assert.deepEqual(imageGenerator.sanitizeSettings({ mossPromptEnhancer: true }), { mossPromptEnhancer: true });
    assert.deepEqual(imageGenerator.sanitizeSettings({ mossEditFormat: 'bogus' }), {});
    assert.deepEqual(imageGenerator.sanitizeSettings({ mossEditFormat: 'ai-toolkit' }), { mossEditFormat: 'ai-toolkit' });
    assert.deepEqual(imageGenerator.sanitizeSettings({ mossEditMegapixels: 9 }), { mossEditMegapixels: 4 });
    assert.deepEqual(imageGenerator.sanitizeSettings({ mossEditMegapixels: 0.1 }), { mossEditMegapixels: 0.25 });
    assert.deepEqual(imageGenerator.sanitizeSettings({ mossEditLoraStrength: 5 }), { mossEditLoraStrength: 2 });
    assert.deepEqual(imageGenerator.sanitizeSettings({ mossSteps: 0 }), {});
    assert.deepEqual(imageGenerator.sanitizeSettings({ mossCfg: -1 }), {});
});

test('resolveBaseModels: MOSS uses the moss slots and the moss_image clip type', () => {
    const defaults = imageGenerator.getDefaults();
    const moss = imageGenerator.resolveBaseModels(Object.assign({}, defaults, { model: 'moss' }));
    assert.equal(moss.unet, defaults.mossUnet);
    assert.equal(moss.clip, defaults.mossClip);
    assert.equal(moss.vae, defaults.mossVae);
    assert.equal(moss.clipType, 'moss_image');
});

test('resolveDimensions: MOSS keeps the Qwen/Krea tiers and snaps to a 16 px multiple', () => {
    for (const size of ['S', 'M', 'L', 'XL']) {
        const dims = imageGenerator.resolveDimensions({ model: 'moss', imageSize: size, aspectRatio: '3:4' });
        assert.equal(dims.width % 16, 0, size);
        assert.equal(dims.height % 16, 0, size);
    }
    const custom = imageGenerator.resolveDimensions({ model: 'moss', imageSize: 'CUSTOM', width: 1000, height: 1500 });
    assert.equal(custom.width, 992);
    assert.equal(custom.height, 1504);
});

test('buildMossImageT2IGraph: official text-to-image graph, no edit LoRA', () => {
    const settings = mossSettings({ mossPromptEnhancer: false, mossNegativePrompt: 'blurry, watermark' });
    const graph = imageGenerator.buildMossImageT2IGraph('a red fox', {
        seed: 7, settings, width: 1000, height: 1500
    });

    assert.equal(graph.clip.class_type, 'CLIPLoader');
    assert.equal(graph.clip.inputs.type, 'moss_image');
    assert.equal(graph.clip.inputs.clip_name, settings.mossClip);
    assert.equal(graph.unet.class_type, 'UNETLoader');
    assert.equal(graph.unet.inputs.unet_name, settings.mossUnet);
    assert.equal(graph.vae.inputs.vae_name, settings.mossVae);
    assert.equal(graph.edit_lora, undefined);

    assert.equal(graph.positive.class_type, 'CLIPTextEncode');
    assert.equal(graph.positive.inputs.text, 'a red fox');
    assert.equal(graph.negative.class_type, 'CLIPTextEncode');
    assert.equal(graph.negative.inputs.text, 'blurry, watermark');

    assert.equal(graph.canvas.class_type, 'EmptyFlux2LatentImage');
    assert.equal(graph.canvas.inputs.width, 1008);
    assert.equal(graph.canvas.inputs.height, 1504);
    assert.equal(graph.canvas.inputs.width % 16, 0);
    assert.equal(graph.canvas.inputs.height % 16, 0);

    assert.equal(graph.sampler.inputs.seed, 7);
    assert.equal(graph.sampler.inputs.steps, 25);
    assert.equal(graph.sampler.inputs.cfg, 2.5);
    assert.equal(graph.sampler.inputs.sampler_name, 'er_sde');
    assert.equal(graph.sampler.inputs.scheduler, 'simple');
    assert.equal(graph.sampler.inputs.denoise, 1);
    assert.equal(graph.save.inputs.filename_prefix, 'not-so-jarvis/gen');
});

test('buildMossImageT2IGraph: honours mossSteps / mossCfg / sampler / scheduler', () => {
    const settings = mossSettings({ mossSteps: 40, mossCfg: 3, mossSampler: 'euler', mossScheduler: 'normal', mossPromptEnhancer: false });
    const graph = imageGenerator.buildMossImageT2IGraph('a red fox', { seed: 1, settings, width: 1024, height: 1024 });
    assert.equal(graph.sampler.inputs.steps, 40);
    assert.equal(graph.sampler.inputs.cfg, 3);
    assert.equal(graph.sampler.inputs.sampler_name, 'euler');
    assert.equal(graph.sampler.inputs.scheduler, 'normal');
});

test('buildMossImageT2IGraph: prompt enhancer feeds the enhanced caption, and can be disabled', () => {
    const settings = mossSettings({ mossPromptEnhancer: true });
    const graph = imageGenerator.buildMossImageT2IGraph('a red fox', {
        seed: 7, settings, enhancerNode: 'TextGenerate', enhancerSeed: 11
    });

    assert.equal(graph.enhancer.class_type, 'TextGenerate');
    assert.deepEqual(graph.positive.inputs.text, ['enhancer', 0]);
    assert.deepEqual(graph.enhancer.inputs.clip, ['clip', 0]);
    assert.equal(graph.enhancer.inputs.prompt, 'a red fox');
    assert.equal(graph.enhancer.inputs.sampling_mode, 'on');
    assert.equal(graph.enhancer.inputs['sampling_mode.seed'], 11);
    assert.equal(graph.enhancer.inputs.thinking, false);
    assert.equal(graph.enhancer.inputs.use_default_template, true);
    assert.match(graph.enhancer.inputs.system_prompt, /caption/i);
    assert.equal(graph.enhancer.inputs.image, undefined);

    // Disabled: the raw prompt goes straight to the encoder, no enhancer node.
    const raw = imageGenerator.buildMossImageT2IGraph('a red fox', {
        seed: 7, settings, promptEnhancer: false, enhancerNode: 'TextGenerate'
    });
    assert.equal(raw.enhancer, undefined);
    assert.equal(raw.positive.inputs.text, 'a red fox');
});

test('buildMossImageT2IGraph: optional enhancer reference is uploaded and wired to the enhancer only', () => {
    const settings = mossSettings({ mossPromptEnhancer: true });
    const graph = imageGenerator.buildMossImageT2IGraph('a red fox', {
        seed: 7, settings, enhancerNode: 'TextGenerate', enhancerReferenceLoadName: 'jarvis_moss_ref.png'
    });
    assert.equal(graph.enhancer_reference.class_type, 'LoadImage');
    assert.equal(graph.enhancer_reference.inputs.image, 'jarvis_moss_ref.png');
    assert.deepEqual(graph.enhancer.inputs.image, ['enhancer_reference', 0]);
    // The model itself never receives the reference.
    assert.equal(graph.sampler.inputs.latent_image[0], 'canvas');

    const v2 = imageGenerator.buildMossImageT2IGraph('a red fox', {
        seed: 7, settings, enhancerNode: 'TextGenerateV2', enhancerReferenceLoadName: 'jarvis_moss_ref.png'
    });
    assert.deepEqual(v2.enhancer.inputs['images.image1'], ['enhancer_reference', 0]);
    assert.equal(v2.enhancer.inputs.image, undefined);
});

test('buildMossImageEditGraph: source is scaled once, LoRA + skip layer + official sampling', () => {
    const settings = mossSettings();
    const graph = imageGenerator.buildMossImageEditGraph(
        "Change only the woman's jacket to black leather. Keep everything else unchanged.",
        'source.png',
        { seed: 42, settings }
    );

    assert.equal(graph.unet.inputs.unet_name, settings.mossUnet);
    assert.equal(graph.clip.inputs.type, 'moss_image');
    assert.equal(graph.vae.inputs.vae_name, settings.mossVae);

    assert.equal(graph.edit_lora.class_type, 'LoraLoaderModelOnly');
    assert.equal(graph.edit_lora.inputs.lora_name, settings.mossEditLora);
    assert.equal(graph.edit_lora.inputs.strength_model, 1);
    assert.deepEqual(graph.edit_lora.inputs.model, ['unet', 0]);

    assert.equal(graph.skip_layer.class_type, 'SkipLayerGuidanceDiTSimple');
    assert.deepEqual(graph.skip_layer.inputs.model, ['edit_lora', 0]);
    assert.equal(graph.skip_layer.inputs.single_layers, '22');
    assert.equal(graph.skip_layer.inputs.start_percent, 0);
    assert.equal(graph.skip_layer.inputs.end_percent, 1);

    assert.equal(graph.load_image.inputs.image, 'source.png');
    assert.equal(graph.scale_reference.class_type, 'ImageScaleToTotalPixels');
    assert.equal(graph.scale_reference.inputs.upscale_method, 'lanczos');
    assert.equal(graph.scale_reference.inputs.megapixels, 1);
    assert.equal(graph.scale_reference.inputs.resolution_steps, 16);
    assert.deepEqual(graph.scale_reference.inputs.image, ['load_image', 0]);

    assert.equal(graph.source_size.class_type, 'GetImageSize');
    assert.deepEqual(graph.source_size.inputs.image, ['scale_reference', 0]);
    assert.equal(graph.canvas.class_type, 'EmptyFlux2LatentImage');
    assert.deepEqual(graph.canvas.inputs.width, ['source_size', 0]);
    assert.deepEqual(graph.canvas.inputs.height, ['source_size', 1]);
    assert.deepEqual(graph.sampler.inputs.latent_image, ['canvas', 0]);

    assert.equal(graph.positive.class_type, 'TextEncodeMOSSImageEdit');
    assert.equal(graph.negative.class_type, 'TextEncodeMOSSImageEdit');
    assert.equal(graph.positive.inputs.edit_format, 'Moss-Image-Edit');
    assert.equal(graph.negative.inputs.edit_format, graph.positive.inputs.edit_format);
    assert.equal(graph.positive.inputs.image_strength, 1);
    assert.equal(graph.negative.inputs.image_strength, 1);
    assert.deepEqual(graph.positive.inputs['images.image_0'], ['scale_reference', 0]);
    assert.deepEqual(graph.negative.inputs['images.image_0'], ['scale_reference', 0]);
    assert.deepEqual(graph.positive.inputs.vae, ['vae', 0]);

    assert.equal(graph.sampler.inputs.seed, 42);
    assert.equal(graph.sampler.inputs.steps, 30);
    assert.equal(graph.sampler.inputs.cfg, 4);
    assert.equal(graph.sampler.inputs.sampler_name, 'euler');
    assert.equal(graph.sampler.inputs.scheduler, 'normal');
    assert.equal(graph.sampler.inputs.denoise, 1);
    assert.equal(graph.save.inputs.filename_prefix, 'not-so-jarvis/edit');
});

test('buildMossImageEditGraph: up to four extra references on both encoders', () => {
    const settings = mossSettings();
    const graph = imageGenerator.buildMossImageEditGraph('use the jacket in image 2', 'source.png', {
        seed: 1,
        settings,
        referenceLoadNames: ['ref1.png', 'ref2.png', 'ref3.png', 'ref4.png', 'ref5.png']
    });

    assert.equal(graph.load_image_1.inputs.image, 'ref1.png');
    assert.equal(graph.load_image_4.inputs.image, 'ref4.png');
    assert.equal(graph.load_image_5, undefined);
    for (let i = 1; i <= 4; i++) {
        assert.deepEqual(graph.positive.inputs['images.image_' + i], ['load_image_' + i, 0]);
        assert.deepEqual(graph.negative.inputs['images.image_' + i], ['load_image_' + i, 0]);
    }
});

test('buildMossImageEditGraph: pinned canvas for character scenes, source still scaled', () => {
    const graph = imageGenerator.buildMossImageEditGraph('x', 'portrait.png', {
        seed: 1,
        settings: mossSettings(),
        width: 896,
        height: 1120
    });
    assert.equal(graph.source_size, undefined);
    assert.equal(graph.canvas.inputs.width, 896);
    assert.equal(graph.canvas.inputs.height, 1120);
    assert.deepEqual(graph.positive.inputs['images.image_0'], ['scale_reference', 0]);
});

test('buildMossImageEditGraph: misses fail with actionable codes', () => {
    assert.throws(
        () => imageGenerator.buildMossImageEditGraph('x', '', { settings: mossSettings() }),
        (err) => err.code === 'edit_source_missing'
    );
    assert.throws(
        () => imageGenerator.buildMossImageEditGraph('x', 'a.png', { settings: mossSettings({ mossEditLora: '' }) }),
        (err) => err.code === 'moss_edit_lora_missing'
    );
});

test('assertMossImageModels: reports exactly which files are missing', () => {
    const base = {
        unet: 'moss_image_sft_int8_convrot.safetensors',
        clip: 'qwen3.5_9b_w4a8_gptq.safetensors',
        vae: 'flux2-vae_small.safetensors'
    };
    assert.doesNotThrow(() => imageGenerator.assertMossImageModels(MOSS_INFO, base));
    assert.throws(
        () => imageGenerator.assertMossImageModels(MOSS_INFO, Object.assign({}, base, { unet: 'missing.safetensors' })),
        (err) => err.code === 'comfyui_missing_model' && /diffusion model/.test(err.message)
    );
    assert.doesNotThrow(() => imageGenerator.assertMossImageModels(MOSS_INFO, base, {
        editLora: 'moss_image_edit_lora_rank_64_bf16.safetensors'
    }));
    assert.throws(
        () => imageGenerator.assertMossImageModels(MOSS_INFO, base, { editLora: 'missing_lora.safetensors' }),
        (err) => err.code === 'comfyui_missing_model' && /edit LoRA/.test(err.message)
    );
});

test('assertMossEditSupport: requires the 0.43.0+ edit node, else a clear version error', () => {
    const stats = { system: { comfyui_version: '0.45.3' } };
    assert.doesNotThrow(() => imageGenerator.assertMossEditSupport(MOSS_INFO, stats));

    const older = { system: { comfyui_version: '0.42.1' } };
    assert.throws(
        () => imageGenerator.assertMossEditSupport(MOSS_INFO, older),
        (err) => err.code === 'comfyui_version_unsupported' && /0\.43\.0/.test(err.message)
    );

    const withoutNode = Object.assign({}, MOSS_INFO);
    delete withoutNode.TextEncodeMOSSImageEdit;
    assert.throws(
        () => imageGenerator.assertMossEditSupport(withoutNode, null),
        (err) => err.code === 'comfyui_version_unsupported' && /0\.43\.0/.test(err.message)
    );

    const otherMissing = Object.assign({}, MOSS_INFO);
    delete otherMissing.SkipLayerGuidanceDiTSimple;
    assert.throws(
        () => imageGenerator.assertMossEditSupport(otherMissing, stats),
        (err) => err.code === 'comfyui_missing_nodes' && err.missingNodes.includes('SkipLayerGuidanceDiTSimple')
    );
});

test('normalizeMossEditFormat: unknown layouts fall back to the LoRA-trained format', () => {
    assert.equal(imageGenerator.normalizeMossEditFormat('Moss-Image-Edit'), 'Moss-Image-Edit');
    assert.equal(imageGenerator.normalizeMossEditFormat('ai-toolkit'), 'ai-toolkit');
    assert.equal(imageGenerator.normalizeMossEditFormat('bogus'), 'Moss-Image-Edit');
    assert.equal(imageGenerator.normalizeMossEditFormat(''), 'Moss-Image-Edit');
});

test('resolveMossEnhancerNode: prefers the official TextGenerate, falls back to V2', () => {
    assert.equal(imageGenerator.resolveMossEnhancerNode(MOSS_INFO), 'TextGenerate');
    assert.equal(imageGenerator.resolveMossEnhancerNode({ TextGenerateV2: {} }), 'TextGenerateV2');
    assert.equal(imageGenerator.resolveMossEnhancerNode({}), null);
});
