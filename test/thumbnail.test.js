const test = require('node:test');
const assert = require('node:assert');

const thumbnail = require('../services/thumbnail');

function solid(width, height, r, g, b, a) {
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data[i * 4] = r;
        data[i * 4 + 1] = g;
        data[i * 4 + 2] = b;
        data[i * 4 + 3] = a === undefined ? 255 : a;
    }
    return data;
}

test('encodePng/decodePng round-trips dimensions and pixels', async () => {
    const rgba = Buffer.alloc(2 * 2 * 4);
    const pixels = [
        [255, 0, 0], [0, 255, 0],
        [0, 0, 255], [255, 255, 0]
    ];
    pixels.forEach((p, i) => {
        rgba[i * 4] = p[0];
        rgba[i * 4 + 1] = p[1];
        rgba[i * 4 + 2] = p[2];
        rgba[i * 4 + 3] = 255;
    });

    const png = thumbnail.encodePng(rgba, 2, 2);
    assert.ok(png.length > 8);
    assert.deepStrictEqual(Array.from(png.slice(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const decoded = await thumbnail.decodePng(png);
    assert.ok(decoded);
    assert.strictEqual(decoded.width, 2);
    assert.strictEqual(decoded.height, 2);
    assert.deepStrictEqual(Array.from(decoded.data), Array.from(rgba));
});

test('decodePng rejects non-PNG buffers', async () => {
    assert.strictEqual(await thumbnail.decodePng(Buffer.from('not a png at all')), null);
    assert.strictEqual(await thumbnail.decodePng(Buffer.alloc(0)), null);
});

test('downscaleRgba box-filters to the target size and averages colors', async () => {
    const width = 8;
    const height = 8;
    const data = solid(width, height, 10, 20, 30, 255);

    const scaled = await thumbnail.downscaleRgba(data, width, height, 4);
    assert.strictEqual(scaled.width, 4);
    assert.strictEqual(scaled.height, 4);
    assert.strictEqual(scaled.data.length, 4 * 4 * 4);
    assert.strictEqual(scaled.data[0], 10);
    assert.strictEqual(scaled.data[1], 20);
    assert.strictEqual(scaled.data[2], 30);
    assert.strictEqual(scaled.data[3], 255);
});

test('downscaleRgba leaves smaller images untouched', async () => {
    const data = solid(4, 4, 1, 2, 3, 255);
    const scaled = await thumbnail.downscaleRgba(data, 4, 4, 320);
    assert.strictEqual(scaled.width, 4);
    assert.strictEqual(scaled.height, 4);
    assert.strictEqual(scaled.data, data);
});

test('thumbPath keeps image names unique and lives under THUMB_DIR', () => {
    const p = thumbnail.thumbPath('89504e47_2026-09-13T07-49-22-320Z.png');
    assert.ok(p.startsWith(thumbnail.THUMB_DIR));
    assert.ok(p.endsWith('89504e47_2026-09-13T07-49-22-320Z.png'));
});

test('thumbPath keeps video posters distinct from images', () => {
    const img = thumbnail.thumbPath('clip_2026.png');
    const vid = thumbnail.thumbPath('clip_2026.mp4');
    assert.notStrictEqual(img, vid);
    assert.ok(vid.endsWith('clip_2026.mp4.png'));
});

test('installPlanFor chooses a per-platform package manager', () => {
    const win = thumbnail.installPlanFor('win32');
    assert.strictEqual(win.manager, 'winget');
    assert.strictEqual(win.cmd, 'winget');
    assert.ok(win.args.includes('Gyan.FFmpeg'));
    assert.ok(win.manual.toLowerCase().includes('ffmpeg'));

    const mac = thumbnail.installPlanFor('darwin');
    assert.strictEqual(mac.cmd, 'brew');
    assert.deepStrictEqual(mac.args, ['install', 'ffmpeg']);

    const linux = thumbnail.installPlanFor('linux');
    assert.strictEqual(linux.cmd, 'apt-get');
    assert.ok(linux.manual.toLowerCase().includes('ffmpeg'));
});

test('isThumbSource recognises images and videos only', () => {
    assert.strictEqual(thumbnail.isThumbSource('a.png'), true);
    assert.strictEqual(thumbnail.isThumbSource('a.mp4'), true);
    assert.strictEqual(thumbnail.isThumbSource('a.webm'), true);
    assert.strictEqual(thumbnail.isThumbSource('a.mov'), true);
    assert.strictEqual(thumbnail.isThumbSource('a.jpg'), false);
    assert.strictEqual(thumbnail.isThumbSource('a.txt'), false);
});
