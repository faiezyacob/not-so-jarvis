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
