/* ============================================
   JARVIS — ComfyUI execution phase labels
   Run with: npm test
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const comfyui = require('../services/comfyui');

test('stageLabelForClass: video pipeline phases are ordered correctly', () => {
    assert.equal(comfyui.stageLabelForClass('MiniMaxH3ReferenceToVideo'), 'Encoding reference video…');
    assert.equal(comfyui.stageLabelForClass('MiniMaxH3ImageToVideo'), 'Encoding first frame…');
    assert.equal(comfyui.stageLabelForClass('SamplerCustomAdvanced'), 'Sampling…');
    assert.equal(comfyui.stageLabelForClass('MiniMaxH3TurboSampler'), 'Sampling…');
    assert.equal(comfyui.stageLabelForClass('KSampler'), 'Sampling…');
    assert.equal(comfyui.stageLabelForClass('KSamplerSelect'), '');
    assert.equal(comfyui.stageLabelForClass('VAEDecodeAudio'), 'Decoding audio…');
    assert.equal(comfyui.stageLabelForClass('VAEDecode'), 'Decoding video…');
    assert.equal(comfyui.stageLabelForClass('CreateVideo'), 'Encoding video file…');
    assert.equal(comfyui.stageLabelForClass('SaveVideo'), 'Encoding video file…');
    assert.equal(comfyui.stageLabelForClass('VHS_LoadVideo'), 'Loading input…');
    assert.equal(comfyui.stageLabelForClass('LoadImage'), 'Loading input…');
});

test('stageLabelForClass: model + face + interp phases', () => {
    assert.equal(comfyui.stageLabelForClass('UNETLoader'), 'Loading model…');
    assert.equal(comfyui.stageLabelForClass('PathchSageAttentionKJ'), 'Loading model…');
    assert.equal(comfyui.stageLabelForClass('H3FaceTrackCrop'), 'Refining faces…');
    assert.equal(comfyui.stageLabelForClass('RIFE VFI'), 'Interpolating frames…');
});

test('stageLabelForClass: unknown / empty nodes yield no label', () => {
    assert.equal(comfyui.stageLabelForClass(''), '');
    assert.equal(comfyui.stageLabelForClass(null), '');
    assert.equal(comfyui.stageLabelForClass('SomeUnknownNode'), '');
});

test('stageProgressPercent: sampler steps map into the total job progress', () => {
    assert.equal(comfyui.stageProgressPercent('Loading model…', 0, 1), 0);
    assert.equal(comfyui.stageProgressPercent('Sampling…', 0, 25), 25);
    assert.equal(comfyui.stageProgressPercent('Sampling…', 25, 25), 85);
    assert.equal(comfyui.stageProgressPercent('VAEDecode', 0, 1), null);
    assert.equal(comfyui.stageProgressPercent('Decoding video…', 0, 1), 88);
    assert.equal(comfyui.stageProgressPercent('Encoding video file…', 1, 1), 99);
});

test('stageProgressPercent: total progress never regresses across the video pipeline', () => {
    const phases = [
        ['Loading model…', 0],
        ['Loading input…', 0],
        ['Encoding first frame…', 0],
        ['Sampling…', 0],
        ['Sampling…', 25],
        ['Decoding video…', 0],
        ['Encoding video file…', 0],
        ['Encoding video file…', 1]
    ];
    let previous = -1;
    phases.forEach(([label, value]) => {
        const max = label === 'Sampling…' ? 25 : 1;
        const pct = comfyui.stageProgressPercent(label, value, max);
        assert.ok(pct !== null, label + ' should have a progress band');
        assert.ok(pct >= previous, label + ' should not move the bar backwards');
        previous = pct;
    });
    assert.ok(previous <= 99);
});
