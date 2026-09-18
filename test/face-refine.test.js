/* ============================================
   JARVIS — FaceRefine detector name resolution
   ComfyUI's H3FaceTrackCrop lists detectors as
   subfolder-relative names ("bbox\face_yolov8m.pt"),
   so a bare filename from settings must be matched
   to the listed entry or ComfyUI rejects it with
   "Value not in list". Run with: npm test
   SPDX-License-Identifier: MIT
   ============================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const videoGenerator = require('../services/video-generator');

function detectorInfo(list) {
    return { H3FaceTrackCrop: { input: { required: { detector: [list] } } } };
}

test('resolveFaceRefineDetector matches the ComfyUI subfolder name by basename', () => {
    const info = detectorInfo(['bbox\\face_yolov8m.pt']);
    assert.equal(
        videoGenerator.resolveFaceRefineDetector(info, 'face_yolov8m.pt'),
        'bbox\\face_yolov8m.pt'
    );
});

test('resolveFaceRefineDetector keeps an exact match', () => {
    const info = detectorInfo(['bbox\\face_yolov8m.pt', 'custom.pt']);
    assert.equal(videoGenerator.resolveFaceRefineDetector(info, 'custom.pt'), 'custom.pt');
    assert.equal(
        videoGenerator.resolveFaceRefineDetector(info, 'bbox\\face_yolov8m.pt'),
        'bbox\\face_yolov8m.pt'
    );
});

test('resolveFaceRefineDetector reads a COMBO { options } shape too', () => {
    const info = { H3FaceTrackCrop: { input: { required: { detector: [null, { options: ['segm\\face_yolov8m.pt'] }] } } } };
    assert.equal(
        videoGenerator.resolveFaceRefineDetector(info, 'face_yolov8m.pt'),
        'segm\\face_yolov8m.pt'
    );
});

test('resolveFaceRefineDetector is a no-op without a list and falls back when unmatched', () => {
    assert.equal(videoGenerator.resolveFaceRefineDetector({}, 'face_yolov8m.pt'), 'face_yolov8m.pt');
    const info = detectorInfo(['bbox\\other.pt']);
    assert.equal(videoGenerator.resolveFaceRefineDetector(info, 'face_yolov8m.pt'), 'face_yolov8m.pt');
});
