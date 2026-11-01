/* ============================================
   JARVIS — SCAIL-2 Character Swap engine
   Graph wiring, replacement-mode masks, prompt
   composer and registry migration.
   Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-scail2-'));
process.env.CHARACTER_SWAP_PATH = path.join(TMP, 'character-swap.json');
process.env.CHARACTER_SWAP_DIR = path.join(TMP, 'projects');

const scailGraph = require('../services/character-swap/engines/scail2-graph');
const scailPrompt = require('../services/character-swap/engines/scail2-prompt');
const scail2 = require('../services/character-swap/engines/scail2');
const engines = require('../services/character-swap/engines');
const characterState = require('../services/character-swap/state');

const SETTINGS = {
    unet: 'SCAIL-2-Q4_K_M.gguf',
    gguf: true,
    loadWithGguf: true,
    samModel: 'sam3.1_multiplex_fp16.safetensors',
    textEncoder: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
    vae: 'wan_2.1_vae.safetensors',
    clipVision: 'clip_vision_h.safetensors',
    accelerationLora: 'Wan21_I2V_14B_lightx2v_cfg_step_distill_lora_rank64.safetensors',
    accelerationStrength: 0.8,
    relight: true,
    relightLora: 'wan2.1_SCAIL_2_relight_lora_bf16.safetensors',
    relightStrength: 1,
    dpo: false,
    dpoLora: 'wan2.1_SCAIL_2_DPO_lora_bf16.safetensors',
    dpoStrength: 1,
    steps: 6,
    cfg: 1,
    shift: 5,
    sampler: 'euler',
    scheduler: 'simple',
    poseStrength: 1,
    poseStart: 0,
    poseEnd: 1,
    chunkFeedForward: true,
    chunkFeedForwardChunks: 4,
    chunkFeedForwardDim: 4096
};

function graphFor(frames, overrides = {}) {
    return scailGraph.buildGraph(Object.assign({
        settings: SETTINGS,
        width: 832,
        height: 480,
        frames,
        positive: 'A realistic video.',
        negative: 'blurry',
        seed: 7,
        performanceName: 'drive.mp4',
        referenceName: 'ref.png',
        points: { positive: [{ x: 10, y: 20 }], negative: [] },
        anchorFrame: 0,
        relightLora: SETTINGS.relightLora,
        dpoLora: null,
        chunkFeedForward: true
    }, overrides));
}

test('SCAIL-2 plans 81-frame windows with the trained 5-frame anchor', () => {
    assert.equal(scailGraph.WINDOW_FRAMES, 81);
    assert.equal(scailGraph.PREVIOUS_FRAMES, 5);
    const short = scailGraph.windowPlan(60);
    assert.equal(short.mode, 'infinity');
    assert.equal(short.windows, 1);
    const long = scailGraph.windowPlan(240);
    assert.equal(long.windows, 4);
    assert.equal(scailGraph.snapFrameLength(60), 57);
    assert.equal(scailGraph.snapFrameLength(81), 81);
});

test('SCAIL-2 graph uses official replacement conditioning, never WanAnimate2ToVideo', () => {
    const { graph, plan } = graphFor(240);
    assert.equal(plan.mode, 'infinity');
    assert.equal(graph.colored.class_type, 'SCAIL2ColoredMask');
    assert.equal(graph.colored.inputs.replacement_mode, true);
    assert.equal(graph.colored.inputs.driving_track_data[0], 'driving_track');
    assert.equal(graph.colored.inputs.ref_track_data[0], 'reference_detect');
    assert.equal(graph.conditioning.class_type, 'WanSCAILInfinity');
    assert.equal(graph.conditioning.inputs.replacement_mode, true);
    assert.deepEqual(graph.conditioning.inputs.pose_video_mask, ['colored', 0]);
    assert.deepEqual(graph.conditioning.inputs.reference_image_mask, ['colored', 1]);
    assert.deepEqual(graph.conditioning.inputs.reference_image, ['reference', 0]);
    assert.deepEqual(graph.conditioning.inputs.pose_video, ['performance_parts', 0]);
    assert.equal(graph.driving_track.class_type, 'SAM3_VideoTrack');
    assert.equal(graph.driving_track.inputs.max_objects, 1);
    assert.deepEqual(graph.driving_track.inputs.initial_mask, ['anchor_detect', 0]);
    assert.equal(graph.anchor_detect.class_type, 'SAM3_Detect');
    assert.match(graph.anchor_detect.inputs.positive_coords, /"x":10,"y":20/);
    assert.equal(graph.anchor_detect.inputs.conditioning, undefined);
    assert.equal(graph.driving_track.inputs.conditioning, undefined);
    assert.equal(graph.unet.class_type, 'UnetLoaderGGUF');
    assert.equal(graph.lora_accel.class_type, 'LoraLoaderModelOnly');
    assert.equal(graph.lora_relight.class_type, 'LoraLoaderModelOnly');
    assert.equal(graph.lora_dpo, undefined);
    assert.equal(graph.save.class_type, 'SaveVideo');
    assert.ok(!Object.values(graph).some((entry) => entry.class_type === 'WanAnimate2ToVideo'));
});

test('SCAIL-2 graph uses UNETLoader for the full-precision safetensors', () => {
    const { graph } = graphFor(60, {
        settings: Object.assign({}, SETTINGS, {
            unet: 'wan2.1_14B_SCAIL_2_fp16.safetensors',
            gguf: false,
            loadWithGguf: false
        })
    });
    assert.equal(graph.unet.class_type, 'UNETLoader');
    assert.equal(graph.unet.inputs.unet_name, 'wan2.1_14B_SCAIL_2_fp16.safetensors');
    assert.equal(graph.unet.inputs.weight_dtype, 'default');
});

test('SCAIL-2 graph omits optional LoRAs and chunk padding when disabled', () => {
    const { graph } = graphFor(60, {
        relightLora: null,
        dpoLora: null,
        chunkFeedForward: false
    });
    assert.equal(graph.lora_relight, undefined);
    assert.equal(graph.lora_dpo, undefined);
    assert.equal(graph.chunk_ff, undefined);
    assert.equal(graph.conditioning.class_type, 'WanSCAILInfinity');
});

test('SCAIL-2 prompt names the source character and maps the uploaded image', () => {
    const text = scailPrompt.buildScailPrompt({
        userPrompt: 'replace the person on the left with the reference character',
        subject: {
            version: 2,
            gender: 'female',
            age: 'young adult',
            outfit: 'a blue outfit and white sneakers'
        },
        description: {
            age: 'adult',
            gender: 'woman',
            face: 'oval face with freckles',
            hair: 'short red hair',
            skin: 'medium beige',
            build: 'slim build',
            clothing: 'a green coat and black boots',
            footwear: 'black boots',
            accessories: 'a small silver necklace',
            distinguishing: 'a mole on the left cheek'
        },
        scene: {
            summary: 'a bright cafe with wooden tables, large windows and soft daylight',
            viewpoint: 'front three-quarter medium shot',
            otherPeople: 'a barista behind the counter'
        }
    });
    assert.match(text, /^Replace a young adult female wearing a blue outfit and white sneakers in the video with the character in reference image 1\./);
    assert.match(text, /short red hair/);
    assert.match(text, /green coat/);
    assert.match(text, /a bright cafe/);
    assert.match(text, /front three-quarter medium shot/);
    assert.match(text, /barista/);
});

test('SCAIL-2 prompt uses the selected subject action before the user direction', () => {
    const text = scailPrompt.buildScailPrompt({
        userPrompt: 'make it feel like a cosy afternoon',
        subject: {
            version: 2,
            gender: 'woman',
            outfit: 'a blue outfit',
            action: 'sitting at a cafe table',
            position: 'centred in the frame',
            objects: 'a coffee cup, a paperback book'
        }
    });
    const actionAt = text.indexOf('The character is sitting at a cafe table, centred in the frame, interacting with a coffee cup, a paperback book.');
    const directionAt = text.indexOf('Additional visible detail: make it feel like a cosy afternoon');
    assert.ok(actionAt >= 0, 'subject action is present');
    assert.ok(directionAt >= 0, 'user direction is present');
    assert.ok(actionAt < directionAt, 'subject action precedes the user direction');
    assert.match(text, /Replace a woman wearing a blue outfit in the video/);
});

test('SCAIL-2 prompt still replaces the person when no subject was described', () => {
    const text = scailPrompt.buildScailPrompt({ userPrompt: 'a calm cafe' });
    assert.match(text, /^Replace the person in the video with the character in reference image 1\./);
    assert.equal(scailPrompt.subjectLine(null), '');
});

test('SCAIL-2 combines several selected characters into one prompt with an image per character', () => {
    const text = scailPrompt.buildScailPrompt({
        userPrompt: 'make it look like a sunny afternoon',
        people: [
            {
                place: 'on the left',
                sourceLabel: 'a young woman wearing a green coat',
                description: { clothing: 'a green coat', footwear: 'black boots' },
                subjectDescription: {
                    version: 2, gender: 'woman', outfit: 'a green coat',
                    action: 'playing the violin', objects: 'a violin, a bow'
                }
            },
            {
                place: 'on the right',
                sourceLabel: 'an older man wearing a blue suit',
                description: { clothing: 'a blue suit' },
                subjectDescription: { version: 2, gender: 'man', outfit: 'a blue suit', action: 'clapping along' }
            }
        ]
    });
    assert.match(text, /^Replace a young woman wearing a green coat with reference image 1 and an older man wearing a blue suit with reference image 2 in the video\./);
    assert.match(text, /The person on the left wears a green coat/);
    assert.match(text, /The person on the right wears a blue suit/);
    assert.match(text, /The character is playing the violin, interacting with a violin, a bow\./);
    assert.ok(
        text.indexOf('The person on the right wears') < text.indexOf('Additional visible detail:'),
        'both characters precede the user direction'
    );
});

test('SCAIL-2 availability lists missing nodes, models and the Infinity pack', () => {
    const missing = scail2.availability({}, SETTINGS);
    assert.equal(missing.available, false);
    assert.ok(missing.missing.some((item) => /WanSCAILToVideo/.test(item)));
    assert.ok(missing.missing.some((item) => /WanSCAILInfinity/.test(item)));
});

test('SCAIL-2 settings default to the GGUF 6-step replacement configuration', () => {
    const settings = scail2.normalizeSettings({});
    assert.equal(settings.gguf, true);
    assert.equal(settings.unet, 'SCAIL-2-Q4_K_M.gguf');
    assert.equal(settings.modelVariant, 'q4_k_m');
    assert.equal(settings.steps, 6);
    assert.equal(settings.cfg, 1);
    assert.equal(settings.relight, true);
    assert.equal(settings.dpo, false);
    assert.equal(settings.accelerationStrength, 0.8);
});

test('SCAIL-2 offers GGUF quant variants and full-precision safetensors', () => {
    const ids = scail2.MODEL_VARIANTS.map((variant) => variant.id);
    assert.deepEqual(ids, ['q2_k', 'q3_k_m', 'q4_k_m', 'q5_k_m', 'q6_k', 'q8_0', 'fp16']);
    assert.equal(scail2.DEFAULT_MODEL_FILE, 'SCAIL-2-Q4_K_M.gguf');
    const fp16 = scail2.MODEL_VARIANTS.find((variant) => variant.id === 'fp16');
    assert.equal(fp16.file, 'wan2.1_14B_SCAIL_2_fp16.safetensors');
    assert.equal(fp16.loader, 'safetensors');
    assert.match(fp16.description, /diffusion_models/);
    for (const variant of scail2.MODEL_VARIANTS) {
        if (variant.id === 'fp16') continue;
        assert.match(variant.file, /\.gguf$/);
        assert.equal(variant.loader, 'gguf');
    }
});

test('SCAIL-2 variant list reports which checkpoints are installed', () => {
    const info = {
        UnetLoaderGGUF: { input: { required: { unet_name: [['SCAIL-2-Q4_K_M.gguf']] } } },
        UNETLoader: { input: { required: { unet_name: [['wan2.1_14B_SCAIL_2_fp16.safetensors']] } } }
    };
    const list = scail2.listVariants(info);
    const byId = Object.fromEntries(list.map((variant) => [variant.id, variant]));
    assert.equal(byId.q4_k_m.installed, true);
    assert.equal(byId.q2_k.installed, false);
    assert.equal(byId.fp16.installed, true);
});

test('SCAIL-2 switches loader automatically between GGUF and safetensors', () => {
    const gguf = scail2.normalizeSettings({ unet: 'SCAIL-2-Q8_0.gguf' });
    assert.equal(gguf.gguf, true);
    assert.equal(gguf.loadWithGguf, true);
    assert.equal(gguf.modelVariant, 'q8_0');

    const full = scail2.normalizeSettings({ unet: 'wan2.1_14B_SCAIL_2_fp16.safetensors' });
    assert.equal(full.gguf, false);
    assert.equal(full.loadWithGguf, false);
    assert.equal(full.modelVariant, 'fp16');

    const custom = scail2.normalizeSettings({ unet: 'my-scail-custom.gguf' });
    assert.equal(custom.gguf, true);
    assert.equal(custom.modelVariant, null);
    assert.match(custom.modelLabel, /my-scail-custom/);
});

test('SCAIL-2 model choice persists in project engine settings', () => {
    const source = path.join(TMP, 'variant-source.mp4');
    fs.writeFileSync(source, 'dummy');
    const project = characterState.createProject({ sourcePath: source, title: 'variant', engine: 'scail2' });
    const updated = characterState.setEngine(project.id, 'scail2', {
        scail2: { unet: 'SCAIL-2-Q8_0.gguf' }
    });
    assert.equal(updated.engineSettings.scail2.unet, 'SCAIL-2-Q8_0.gguf');
    const reloaded = characterState.get(project.id);
    assert.equal(reloaded.engineSettings.scail2.unet, 'SCAIL-2-Q8_0.gguf');
});

test('Wan Animate 2 is gone and its aliases resolve to SCAIL-2', () => {
    assert.equal(engines.DEFAULT_ENGINE, 'scail2');
    assert.deepEqual(engines.ORDER, ['scail2', 'h3']);
    assert.equal(engines.normalizeEngine('wan_animate'), 'scail2');
    assert.equal(engines.normalizeEngine('wan_animate2'), 'scail2');
    assert.equal(engines.normalizeEngine('move'), 'scail2');
    assert.equal(engines.normalizeEngine('scail-2'), 'scail2');
    assert.equal(engines.normalizeEngine('wan_animate_mix'), 'scail2');
    assert.equal(engines.normalizeEngine('mix'), 'scail2');
    assert.equal(engines.getEngine('wan_animate').id, 'scail2');
    assert.equal(characterState.DEFAULT_ENGINE, 'scail2');
    assert.equal(characterState.defaultEngineSettings().wanAnimate, undefined);
    assert.equal(characterState.defaultEngineSettings().wanAnimateMix, undefined);
    assert.ok(characterState.defaultEngineSettings().scail2);
});
