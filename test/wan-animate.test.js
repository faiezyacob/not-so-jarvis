/* ============================================
   JARVIS — Wan Animate 2 engine
   Continuation math, canvas sizing, graph
   wiring, settings and availability.
   Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-wan2-'));
process.env.CHARACTER_SWAP_PATH = path.join(TMP, 'character-swap.json');
process.env.CHARACTER_SWAP_DIR = path.join(TMP, 'projects');

const wanWorkflow = require('../services/character-swap/engines/wan-animate2');
const wanAnimate = require('../services/character-swap/engines/wan-animate');
const engines = require('../services/character-swap/engines');
const characterState = require('../services/character-swap/state');

function infoFor(overrides = {}) {
    const info = {
        UNETLoader: { input: { required: { unet_name: [['wan_animate_2_int8_convrot.safetensors', 'Wan2_2-Animate-14B_fp8_scaled_e4m3fn_KJ_v2.safetensors']] } } },
        CLIPLoader: { input: { required: { clip_name: [['umt5_xxl_fp8_e4m3fn_scaled.safetensors']], type: [['wan', 'sdxl']] } } },
        VAELoader: { input: { required: { vae_name: [['wan_2.1_vae.safetensors']] } } },
        CLIPVisionLoader: { input: { required: { clip_name: [['clip_vision_h.safetensors']] } } },
        LoraLoaderModelOnly: { input: { required: { lora_name: [['lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors']] } } },
        KSamplerSelect: { input: { required: { sampler_name: [['euler', 'lcm']] } } }
    };
    for (const node of wanAnimate.REQUIRED_NODES) {
        if (!info[node]) info[node] = { input: { required: {} } };
    }
    return Object.assign(info, overrides);
}

test('Wan Animate 2 plans 81-frame continuation windows on a 24 fps timeline', () => {
    assert.equal(wanWorkflow.WINDOW_FRAMES, 81);
    assert.equal(wanWorkflow.FRAME_ADVANCE, 80);
    const plan = wanWorkflow.continuationPlan({ sourceFrames: 240, sourceFps: 30, requestedSeconds: 8 });
    assert.equal(plan.fps, 24);
    assert.equal(plan.outputFrames, 192);
    assert.equal(plan.windowCount, 3);
    assert.deepEqual(plan.segments.map((segment) => segment.videoFrameOffset), [0, 81, 161]);
    assert.deepEqual(plan.segments.map((segment) => segment.keepFrames), [81, 80, 31]);
    assert.equal(plan.segments.reduce((total, segment) => total + segment.keepFrames, 0), 192);

    const capped = wanWorkflow.continuationPlan({ sourceFrames: 900, sourceFps: 30, requestedSeconds: 30 });
    assert.equal(capped.outputFrames, 360);
    assert.equal(capped.seconds, 15);
    assert.equal(capped.windowCount, 5);
});

test('Wan Animate 2 sizes the canvas near a 480p or 720p pixel budget', () => {
    const sd = wanWorkflow.dimensionsFor(1920, 1080, { resolution: '480p' });
    assert.equal(sd.width % 16, 0);
    assert.equal(sd.height % 16, 0);
    assert.ok(Math.abs(sd.width / sd.height - 16 / 9) < 0.03);

    const portrait = wanWorkflow.dimensionsFor(1080, 1920, { resolution: '480p' });
    assert.ok(portrait.height > portrait.width);

    const hd = wanWorkflow.dimensionsFor(1920, 1080, { resolution: '720p' });
    assert.ok(hd.width * hd.height > sd.width * sd.height);
    assert.equal(hd.width % 16, 0);
    assert.equal(hd.height % 16, 0);
});

test('Wan Animate 2 scene prompt falls back to a neutral description', () => {
    assert.match(wanWorkflow.scenePrompt('replace the person on the left'), /^Character and background description:/);
    assert.match(wanWorkflow.scenePrompt(''), /Match the reference image exactly/);
});

test('normalizeSettings enforces the Wan Animate 2 sampling and duration bounds', () => {
    const settings = wanAnimate.normalizeSettings({ preset: 'quality', steps: 99, cfg: 9, shift: 20, length: 77, overlap: 5 });
    assert.equal(settings.preset, 'quality');
    assert.equal(settings.steps, 30);
    assert.equal(settings.cfg, 1);
    assert.equal(settings.shift, 5);
    assert.equal(settings.length, 81);
    assert.equal(settings.overlap, 1);
    assert.equal(settings.fps, 24);
    assert.equal(settings.durationMode, 'match');
    assert.equal(settings.durationSeconds, null);
    assert.equal(settings.resolution, '480p');
    assert.equal(wanAnimate.normalizeSettings({ resolution: '720p' }).resolution, '720p');
    assert.equal(wanAnimate.normalizeSettings({ resolution: 'nope' }).resolution, '480p');
    const fixed = wanAnimate.normalizeSettings({ durationMode: 'fixed', durationSeconds: 99 });
    assert.equal(fixed.durationMode, 'fixed');
    assert.equal(fixed.durationSeconds, 15);
    const prompt = wanAnimate.normalizeSettings({ positive: 'replace the person on the left' });
    assert.equal(prompt.positive, 'replace the person on the left');
});

test('buildGraph wires WanAnimate2ToVideo and never uses masks or DWPose', () => {
    const settings = wanAnimate.normalizeSettings({ preset: 'standard' });
    const segment = wanWorkflow.continuationPlan({ sourceFrames: 240, sourceFps: 24, requestedSeconds: 8 }).segments[1];
    const graph = wanWorkflow.buildGraph({
        settings,
        width: 832,
        height: 480,
        positive: 'replace the person on the left',
        negative: 'blurry',
        referenceName: 'ref.png',
        performanceName: 'performance.mp4',
        continuationImageName: 'previous.png',
        segment,
        seed: 42
    });
    assert.equal(graph.conditioning.class_type, 'WanAnimate2ToVideo');
    assert.equal(graph.conditioning.inputs.width, 832);
    assert.equal(graph.conditioning.inputs.height, 480);
    assert.equal(graph.conditioning.inputs.length, 81);
    assert.equal(graph.conditioning.inputs.batch_size, 1);
    assert.equal(graph.conditioning.inputs.video_frame_offset, 81);
    assert.deepEqual(graph.conditioning.inputs.reference_image, ['reference_resize', 0]);
    assert.deepEqual(graph.conditioning.inputs.pose_video, ['performance_parts', 0]);
    assert.deepEqual(graph.conditioning.inputs.continue_motion, ['continuation_load', 0]);
    assert.deepEqual(graph.conditioning.inputs.positive_pose, ['pose_prompt', 0]);
    assert.equal(graph.sampling.inputs.shift, 5);
    assert.equal(graph.scheduler.inputs.steps, 6);
    assert.equal(graph.sampler_select.inputs.sampler_name, 'lcm');
    assert.deepEqual(graph.trim.inputs.trim_amount, ['conditioning', 3]);
    assert.equal(graph.video.inputs.fps, 24);
    assert.equal(graph.reference_resize.inputs['resize_type.width'], 832);
    assert.equal(graph.reference_resize.inputs['resize_type.height'], 480);
    assert.equal(graph.reference_resize.inputs['resize_type.crop'], 'center');
    assert.equal(Object.values(graph).some((node) => node.class_type === 'DWPreprocessor'), false);
    assert.equal(Object.values(graph).some((node) => node.class_type === 'BlockifyMask'), false);
    assert.equal(graph.conditioning.inputs.character_mask, undefined);
});

test('buildGraph omits continue_motion on the first window and trims the tail', () => {
    const settings = wanAnimate.normalizeSettings({});
    const plan = wanWorkflow.continuationPlan({ sourceFrames: 240, sourceFps: 24, requestedSeconds: 8 });
    const first = wanWorkflow.buildGraph({
        settings,
        width: 832,
        height: 480,
        positive: 'p',
        negative: 'n',
        referenceName: 'ref.png',
        performanceName: 'performance.mp4',
        continuationImageName: null,
        segment: plan.segments[0],
        seed: 1
    });
    assert.equal(first.conditioning.inputs.continue_motion, undefined);
    assert.equal(first.continuation_load, undefined);
    assert.equal(first.output_trim, undefined);

    const last = wanWorkflow.buildGraph({
        settings,
        width: 832,
        height: 480,
        positive: 'p',
        negative: 'n',
        referenceName: 'ref.png',
        performanceName: 'performance.mp4',
        continuationImageName: 'previous.png',
        segment: plan.segments[2],
        seed: 2
    });
    assert.deepEqual(last.overlap_trim.inputs, {
        image: ['decode', 0],
        batch_index: ['conditioning', 4],
        length: 81
    });
    assert.deepEqual(last.output_trim.inputs, {
        image: ['overlap_trim', 0],
        batch_index: 0,
        length: 31
    });
});

test('availability requires Wan Animate 2 and reports real missing assets', () => {
    const settings = wanAnimate.normalizeSettings({});
    const ok = wanAnimate.availability(infoFor(), settings);
    assert.equal(ok.available, true);
    assert.deepEqual(ok.missing, []);

    const noNode = infoFor();
    delete noNode.WanAnimate2ToVideo;
    const missingNode = wanAnimate.availability(noNode, settings);
    assert.equal(missingNode.available, false);
    assert.ok(missingNode.missing.some((item) => item.includes('WanAnimate2ToVideo')));

    const oldModel = infoFor({
        UNETLoader: { input: { required: { unet_name: [['Wan2_2-Animate-14B_fp8_scaled_e4m3fn_KJ_v2.safetensors']] } } }
    });
    const wrong = wanAnimate.availability(oldModel, wanAnimate.normalizeSettings({ unet: 'Wan2_2-Animate-14B_fp8_scaled_e4m3fn_KJ_v2.safetensors' }));
    assert.equal(wrong.available, false);
    assert.ok(wrong.missing.some((item) => /not Wan Animate 2/i.test(item)));
});

test('engine registry defaults to Wan and keeps H3 available', () => {
    assert.equal(engines.DEFAULT_ENGINE, 'wan_animate');
    assert.equal(engines.normalizeEngine(''), 'wan_animate');
    assert.equal(engines.normalizeEngine('wan'), 'wan_animate');
    assert.equal(engines.normalizeEngine('minimax'), 'h3');
    assert.equal(engines.getEngine('h3').id, 'h3');
    assert.equal(engines.getEngine('nope').id, 'wan_animate');
    assert.equal(engines.getEngine('wan').label, 'Wan Animate 2');
});

test('new projects default to Wan Animate 2 and legacy projects migrate safely', () => {
    const project = characterState.createProject({ sessionId: 's1', filename: 'clip.mp4' });
    assert.equal(project.engine, 'wan_animate');
    assert.equal(project.engineSettings.wanAnimate.length, 81);
    assert.equal(project.engineSettings.wanAnimate.overlap, 1);
    assert.equal(project.engineSettings.wanAnimate.steps, 6);
    assert.equal(project.engineSettings.wanAnimate.durationMode, 'match');
    assert.equal(project.engineSettings.wanAnimate.durationSeconds, null);
    assert.equal(project.engineSettings.wanAnimate.resolution, '480p');
    assert.equal(project.engineSettings.wanAnimate.positive, '');

    characterState.update(project.id, (current) => {
        delete current.engine;
        delete current.engineSettings;
        delete current.maskExports;
        current.maskExport = { video: 'old.mp4' };
    });
    const migrated = characterState.get(project.id);
    assert.equal(migrated.engine, 'wan_animate');
    assert.ok(migrated.engineSettings.wanAnimate);
    assert.equal(migrated.maskExports.union.video, 'old.mp4');
    assert.equal(migrated.maskExport.video, 'old.mp4');
});

test('setEngine persists both engines settings without touching the project source', () => {
    const project = characterState.createProject({ sessionId: 's2', filename: 'clip.mp4' });
    const updated = characterState.setEngine(project.id, 'h3', {
        wanAnimate: { preset: 'draft', steps: 4, positive: 'a prompt' },
        h3: { quality: 'draft' }
    });
    assert.equal(updated.engine, 'h3');
    assert.equal(updated.engineSettings.h3.quality, 'draft');
    assert.equal(updated.engineSettings.wanAnimate.preset, 'draft');
    assert.equal(updated.engineSettings.wanAnimate.steps, 4);
    assert.equal(updated.engineSettings.wanAnimate.positive, 'a prompt');
    assert.equal(updated.source.filename, 'clip.mp4');
});
