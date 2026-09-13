/* ============================================
   JARVIS — Generated Image Thumbnails
   The gallery used to load the full-resolution PNGs
   (1–10 MB each) as grid thumbnails, which made
   opening "View All" heavy. This module produces a
   small cached PNG thumbnail for each generated image
   so the grid only ever downloads a few KB per tile.

   It is written in pure JavaScript on top of Node's
   built-in `zlib` (the project is zero-dependency):
   it decodes 8/16-bit non-interlaced PNGs, box-downsamples
   them and re-encodes an RGB PNG. Unsupported PNG
   variants simply fail soft (no thumbnail, the gallery
   falls back to the original file).

   Thumbnails live in data/thumbnails and are generated
   on a background queue (once per file, at startup for
   existing files and right after each new generation)
   so serving a thumbnail never blocks the event loop.

   Videos get a poster frame too: if `ffmpeg` is available
   on PATH (or FFMPEG_PATH is set) the first frame is
   extracted into the same cache; otherwise the gallery
   keeps its play-icon placeholder.
   ============================================ */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');

const GENERATED_DIR = path.join(__dirname, '..', 'data', 'generated');
const THUMB_DIR = path.join(__dirname, '..', 'data', 'thumbnails');

const THUMB_MAX = 256;                 // longest edge of the cached thumbnail
const MAX_SOURCE_BYTES = 80 * 1024 * 1024;
// Optional external binary for video posters. It is not an npm dependency;
// when absent, video tiles simply fall back to the play-icon placeholder.
// The installer may repoint this at an absolute path (e.g. a fresh winget
// install not yet on this process's PATH).
let ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
let ffmpegVersion = null;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// --- PNG primitives ---

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([length, typeBuf, data, crc]);
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

function unfilterRow(row, prev, bpp, filter) {
    const len = row.length;
    if (filter === 0) return;
    if (filter === 1) {
        for (let i = bpp; i < len; i++) row[i] = (row[i] + row[i - bpp]) & 0xff;
        return;
    }
    if (filter === 2) {
        for (let i = 0; i < len; i++) row[i] = (row[i] + prev[i]) & 0xff;
        return;
    }
    if (filter === 3) {
        for (let i = 0; i < len; i++) {
            const a = i >= bpp ? row[i - bpp] : 0;
            row[i] = (row[i] + ((a + prev[i]) >> 1)) & 0xff;
        }
        return;
    }
    if (filter === 4) {
        for (let i = 0; i < len; i++) {
            const a = i >= bpp ? row[i - bpp] : 0;
            const b = prev[i];
            const c = i >= bpp ? prev[i - bpp] : 0;
            row[i] = (row[i] + paeth(a, b, c)) & 0xff;
        }
        return;
    }
    throw new Error('Unsupported PNG filter ' + filter);
}

// Parse the IHDR/PLTE/tRNS/IDAT chunks and inflate the pixel data. Returns
// null for anything we cannot decode (interlaced, <8-bit, unknown color type,
// missing header, corrupt data).
function parsePng(buffer) {
    if (!buffer || buffer.length < 8 || !buffer.slice(0, 8).equals(PNG_SIG)) return null;
    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    let palette = null;
    let trns = null;
    const idat = [];
    while (offset + 8 <= buffer.length) {
        const len = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const dataStart = offset + 8;
        if (dataStart + len + 4 > buffer.length) break;
        const data = buffer.slice(dataStart, dataStart + len);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === 'PLTE') {
            palette = data;
        } else if (type === 'tRNS') {
            trns = data;
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') {
            break;
        }
        offset = dataStart + len + 4;
    }
    if (!width || !height || interlace) return null;
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    if (!channels) return null;
    if (bitDepth !== 8 && bitDepth !== 16) return null;
    if (colorType === 3 && bitDepth !== 8) return null;
    let inflated;
    try {
        inflated = zlib.inflateSync(Buffer.concat(idat));
    } catch (err) {
        return null;
    }
    return { width, height, bitDepth, colorType, channels, palette, trns, inflated };
}

function nextTick() {
    return new Promise((resolve) => setImmediate(resolve));
}

// Decode to a tightly packed RGBA buffer, yielding to the event loop every
// few hundred rows so a large upscale cannot stall the whole server.
async function decodePng(buffer) {
    const parsed = parsePng(buffer);
    if (!parsed) return null;
    const { width, height, bitDepth, colorType, channels, palette, trns, inflated } = parsed;
    const sampleBytes = bitDepth / 8;
    const bpp = channels * sampleBytes;
    const rowBytes = width * bpp;
    if (inflated.length < (rowBytes + 1) * height) return null;

    const out = Buffer.alloc(width * height * 4);
    let prev = Buffer.alloc(rowBytes);
    let pos = 0;
    for (let y = 0; y < height; y++) {
        const filter = inflated[pos++];
        const row = inflated.slice(pos, pos + rowBytes);
        pos += rowBytes;
        unfilterRow(row, prev, bpp, filter);
        prev = row;
        const rowOut = y * width * 4;
        for (let x = 0; x < width; x++) {
            const si = x * channels * sampleBytes;
            const di = rowOut + x * 4;
            if (colorType === 0) {
                const g = row[si];
                out[di] = g; out[di + 1] = g; out[di + 2] = g; out[di + 3] = 255;
            } else if (colorType === 2) {
                out[di] = row[si];
                out[di + 1] = row[si + sampleBytes];
                out[di + 2] = row[si + 2 * sampleBytes];
                out[di + 3] = 255;
            } else if (colorType === 3) {
                const p = row[si] * 3;
                out[di] = palette[p];
                out[di + 1] = palette[p + 1];
                out[di + 2] = palette[p + 2];
                out[di + 3] = trns && row[si] < trns.length ? trns[row[si]] : 255;
            } else if (colorType === 4) {
                const g = row[si];
                out[di] = g; out[di + 1] = g; out[di + 2] = g;
                out[di + 3] = row[si + sampleBytes];
            } else {
                out[di] = row[si];
                out[di + 1] = row[si + sampleBytes];
                out[di + 2] = row[si + 2 * sampleBytes];
                out[di + 3] = row[si + 3 * sampleBytes];
            }
        }
        if ((y & 127) === 127) await nextTick();
    }
    return { width, height, data: out };
}

// Box-filter downscale. Only ever shrinks (images already smaller than the
// target pass through untouched), so the result stays crisp and cheap.
async function downscaleRgba(rgba, width, height, maxDim) {
    const scale = Math.min(1, maxDim / Math.max(width, height));
    if (scale >= 1) return { width, height, data: rgba };
    const tw = Math.max(1, Math.round(width * scale));
    const th = Math.max(1, Math.round(height * scale));
    const out = Buffer.alloc(tw * th * 4);
    for (let ty = 0; ty < th; ty++) {
        const y0 = Math.floor((ty * height) / th);
        const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / th));
        for (let tx = 0; tx < tw; tx++) {
            const x0 = Math.floor((tx * width) / tw);
            const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / tw));
            let r = 0, g = 0, b = 0, a = 0, n = 0;
            for (let y = y0; y < y1; y++) {
                let idx = (y * width + x0) * 4;
                for (let x = x0; x < x1; x++) {
                    r += rgba[idx]; g += rgba[idx + 1]; b += rgba[idx + 2]; a += rgba[idx + 3];
                    idx += 4; n++;
                }
            }
            const di = (ty * tw + tx) * 4;
            out[di] = Math.round(r / n);
            out[di + 1] = Math.round(g / n);
            out[di + 2] = Math.round(b / n);
            out[di + 3] = Math.round(a / n);
        }
        if ((ty & 63) === 63) await nextTick();
    }
    return { width: tw, height: th, data: out };
}

// Encode an RGBA buffer as an 8-bit RGB (color type 2) PNG. Generated images
// are opaque, so dropping the alpha channel keeps the thumbnail smaller.
function encodePng(rgba, width, height) {
    const rowBytes = width * 3;
    const raw = Buffer.alloc((rowBytes + 1) * height);
    for (let y = 0; y < height; y++) {
        const rowStart = y * (rowBytes + 1);
        raw[rowStart] = 0;
        let src = y * width * 4;
        let dst = rowStart + 1;
        for (let x = 0; x < width; x++) {
            raw[dst++] = rgba[src];
            raw[dst++] = rgba[src + 1];
            raw[dst++] = rgba[src + 2];
            src += 4;
        }
    }
    const idat = zlib.deflateSync(raw, { level: 9 });
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 2;   // color type: truecolor RGB
    return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// --- Cache + background queue ---

function isPngName(name) {
    return /\.png$/i.test(String(name || ''));
}

function isVideoName(name) {
    return /\.(?:mp4|webm|mov)$/i.test(String(name || ''));
}

// Sources we can mint a thumbnail for: PNG images (pure-JS codec) and videos
// (ffmpeg poster, when available).
function isThumbSource(name) {
    return isPngName(name) || isVideoName(name);
}

// Images cache as "<stem>.png"; videos as "<full name>.png" so a video and an
// image can never collide on the same thumbnail file.
function thumbPath(rawFilename) {
    const base = path.basename(String(rawFilename || ''));
    const stem = isVideoName(base) ? base : base.replace(/\.[^.]+$/, '');
    return path.join(THUMB_DIR, stem + '.png');
}

function has(rawFilename) {
    return fs.existsSync(thumbPath(rawFilename));
}

function read(rawFilename) {
    try {
        return fs.readFileSync(thumbPath(rawFilename));
    } catch (err) {
        return null;
    }
}

// --- Optional ffmpeg poster extraction ---

let ffmpegUsable = null;   // null = untested, true/false after first probe

function runFfmpeg(args, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (ok) => {
            if (settled) return;
            settled = true;
            resolve(ok);
        };
        let child;
        try {
            child = spawn(ffmpegBin, args, { stdio: 'ignore', windowsHide: true });
        } catch (err) {
            done(false);
            return;
        }
        const timer = setTimeout(() => {
            try { child.kill(); } catch (err) { /* ignore */ }
            done(false);
        }, timeoutMs || 20000);
        child.on('error', () => {
            clearTimeout(timer);
            done(false);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            done(code === 0);
        });
    });
}

// Look for a not-yet-on-PATH install (winget/choco/homebrew/system dirs) so a
// poster works right after the Setup installer finishes, without a restart.
function scanWinGetFfmpeg(pkgsDir) {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(pkgsDir); } catch (err) { return out; }
    for (const name of entries) {
        if (!/^Gyan\.FFmpeg/i.test(name)) continue;
        const base = path.join(pkgsDir, name);
        let subs = [];
        try { subs = fs.readdirSync(base); } catch (err) { continue; }
        for (const sub of subs) out.push(path.join(base, sub, 'bin', 'ffmpeg.exe'));
        out.push(path.join(base, 'ffmpeg.exe'));
    }
    return out;
}

function locateFfmpegBinary() {
    const candidates = [];
    if (process.platform === 'win32') {
        const local = process.env.LOCALAPPDATA;
        if (local) candidates.push(...scanWinGetFfmpeg(path.join(local, 'Microsoft', 'WinGet', 'Packages')));
        candidates.push('C:\\ffmpeg\\bin\\ffmpeg.exe');
        candidates.push('C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe');
    } else {
        candidates.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', '/snap/bin/ffmpeg');
    }
    for (const candidate of candidates) {
        try {
            if (candidate && fs.statSync(candidate).isFile()) return candidate;
        } catch (err) { /* try next */ }
    }
    return null;
}

function probeFfmpeg() {
    return new Promise((resolve) => {
        let out = '';
        let child;
        try {
            child = spawn(ffmpegBin, ['-version'], { windowsHide: true });
        } catch (err) {
            resolve({ available: false, error: String((err && err.message) || err) });
            return;
        }
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { out += d.toString(); });
        child.on('error', (err) => {
            resolve({ available: false, error: err && err.code === 'ENOENT' ? 'not found on PATH' : String((err && err.message) || err) });
        });
        child.on('close', (code) => {
            if (code === 0) resolve({ available: true, version: (out.split('\n')[0] || '').trim() });
            else resolve({ available: false, error: 'ffmpeg exited with code ' + code });
        });
    });
}

// Resolve whether a usable ffmpeg exists (PATH, FFMPEG_PATH, or a located
// install). Cached after the first success; call resetFfmpeg() after install.
async function ensureFfmpeg() {
    if (ffmpegUsable === true) return true;
    if (ffmpegUsable === false) return false;
    let probe = await probeFfmpeg();
    if (!probe.available) {
        const located = locateFfmpegBinary();
        if (located && located !== ffmpegBin) {
            ffmpegBin = located;
            probe = await probeFfmpeg();
        }
    }
    ffmpegUsable = probe.available;
    ffmpegVersion = probe.available ? probe.version : null;
    return probe.available;
}

function resetFfmpeg() {
    ffmpegUsable = null;
    ffmpegVersion = null;
    if (!process.env.FFMPEG_PATH) ffmpegBin = 'ffmpeg';
}

// Grab a single frame with ffmpeg, scaled to fit THUMB_MAX. Tries a small
// offset first (more representative than a possibly-black first frame) and
// falls back to the very first frame for very short clips.
async function generateVideoPoster(src, dest) {
    if (!(await ensureFfmpeg())) return null;
    if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });
    const scale = 'scale=' + THUMB_MAX + ':' + THUMB_MAX + ':force_original_aspect_ratio=decrease';
    for (const seek of ['0.5', null]) {
        try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (err) { /* ignore */ }
        const args = ['-hide_banner', '-loglevel', 'error', '-y'];
        if (seek) args.push('-ss', seek);
        args.push('-i', src, '-frames:v', '1', '-vf', scale, dest);
        const ok = await runFfmpeg(args);
        try {
            if (ok && fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
        } catch (err) { /* try next */ }
    }
    return null;
}

// --- Optional ffmpeg install (Settings > Setup) ---

// Pure plan builder so the platform commands stay testable without spawning.
function installPlanFor(platform) {
    if (platform === 'win32') {
        return {
            manager: 'winget',
            cmd: 'winget',
            args: ['install', '--id', 'Gyan.FFmpeg', '-e', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'],
            manual: 'Install ffmpeg from https://www.gyan.dev/ffmpeg/builds/ (or run: winget install Gyan.FFmpeg) and make sure ffmpeg.exe is on PATH.'
        };
    }
    if (platform === 'darwin') {
        return {
            manager: 'brew',
            cmd: 'brew',
            args: ['install', 'ffmpeg'],
            manual: 'Install ffmpeg with Homebrew: brew install ffmpeg'
        };
    }
    return {
        manager: 'apt/dnf/pacman',
        cmd: 'apt-get',
        args: ['install', '-y', 'ffmpeg'],
        manual: 'Install ffmpeg with your package manager (e.g. sudo apt install ffmpeg, sudo dnf install ffmpeg, sudo pacman -S ffmpeg).'
    };
}

const ffmpegJob = {
    running: false,
    done: false,
    ok: false,
    error: null,
    warn: null,
    log: [],
    startedAt: null,
    finishedAt: null
};

function ffLogLine(text) {
    const line = String(text || '');
    ffmpegJob.log.push(line);
    if (ffmpegJob.log.length > 200) ffmpegJob.log.splice(0, ffmpegJob.log.length - 200);
    console.log('[thumbnail] ' + line);
}

function ffmpegJobState() {
    return {
        running: ffmpegJob.running,
        done: ffmpegJob.done,
        ok: ffmpegJob.ok,
        error: ffmpegJob.error,
        warn: ffmpegJob.warn,
        log: ffmpegJob.log.slice(-40),
        startedAt: ffmpegJob.startedAt,
        finishedAt: ffmpegJob.finishedAt
    };
}

function runCommand(exe, args, timeoutMs) {
    const res = spawnSync(exe, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    return {
        ok: res.status === 0,
        error: res.error ? String(res.error.message || res.error) : null,
        stdout: String(res.stdout || '').slice(-2000),
        stderr: String(res.stderr || '').slice(-2000)
    };
}

async function runFfmpegInstall() {
    ffmpegJob.running = true;
    ffmpegJob.done = false;
    ffmpegJob.ok = false;
    ffmpegJob.error = null;
    ffmpegJob.warn = null;
    ffmpegJob.startedAt = new Date().toISOString();
    ffmpegJob.finishedAt = null;
    try {
        const plan = installPlanFor(process.platform);
        ffLogLine('Installing ffmpeg via ' + plan.manager + ' ...');
        let result = runCommand(plan.cmd, plan.args, 20 * 60 * 1000);

        // Linux: apt may need root or the distro may use dnf/pacman instead.
        if (!result.ok && process.platform === 'linux') {
            for (const fallback of [['sudo', ['-n', 'apt-get', 'install', '-y', 'ffmpeg']], ['dnf', ['install', '-y', 'ffmpeg']], ['pacman', ['-S', '--noconfirm', 'ffmpeg']]]) {
                ffLogLine('Trying ' + fallback[0] + ' ...');
                result = runCommand(fallback[0], fallback[1], 20 * 60 * 1000);
                if (result.ok) break;
            }
        }

        if (!result.ok) {
            const detail = (result.stderr || result.error || '').trim().split('\n').slice(-3).join(' ');
            throw new Error((detail ? detail + ' — ' : '') + plan.manual);
        }
        ffLogLine('Package manager reported success.');

        resetFfmpeg();
        const available = await ensureFfmpeg();
        if (available) {
            ffmpegJob.ok = true;
            ffLogLine('ffmpeg detected: ' + (ffmpegVersion || ffmpegBin));
            warm();
        } else {
            ffmpegJob.ok = true;
            ffmpegJob.warn = 'ffmpeg was installed but is not visible yet — restart JARVIS if posters do not appear.';
            ffLogLine(ffmpegJob.warn);
        }
    } catch (err) {
        ffmpegJob.ok = false;
        ffmpegJob.error = err.message || String(err);
        ffLogLine('FAILED: ' + ffmpegJob.error);
    } finally {
        ffmpegJob.running = false;
        ffmpegJob.done = true;
        ffmpegJob.finishedAt = new Date().toISOString();
    }
}

function startFfmpegInstall() {
    if (ffmpegJob.running) return { started: false, reason: 'already running', job: ffmpegJobState() };
    setImmediate(() => { runFfmpegInstall().catch(() => {}); });
    return { started: true, job: ffmpegJobState() };
}

// Shape consumed by the Settings > Setup guide (mirrors model-setup's rows).
// Always re-probes so "Re-check" reflects an ffmpeg installed outside JARVIS.
async function getFfmpegStatus() {
    resetFfmpeg();
    const available = await ensureFfmpeg();
    const plan = installPlanFor(process.platform);
    return {
        id: 'ffmpeg',
        label: 'Video thumbnails (ffmpeg)',
        required: false,
        available,
        version: ffmpegVersion,
        bin: available ? ffmpegBin : null,
        source: process.env.FFMPEG_PATH ? 'FFMPEG_PATH' : (available ? 'PATH' : null),
        installable: process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux',
        manager: plan.manager,
        manual: plan.manual,
        note: 'Extracts poster frames for generated videos in the gallery. Without it, video tiles show a play icon only.',
        job: ffmpegJobState()
    };
}

// Produce (or refresh) the cached thumbnail for one generated file. Returns
// the thumbnail path, or null when the source is missing/unsupported.
async function generate(rawFilename) {
    const name = path.basename(String(rawFilename || ''));
    if (!isThumbSource(name)) return null;
    const src = path.join(GENERATED_DIR, name);
    const dest = thumbPath(name);
    let stat;
    try {
        stat = fs.statSync(src);
    } catch (err) {
        return null;
    }
    if (stat.size > MAX_SOURCE_BYTES) return null;
    if (fs.existsSync(dest)) {
        try {
            if (fs.statSync(dest).mtimeMs >= stat.mtimeMs) return dest;
        } catch (err) { /* regenerate below */ }
    }
    if (isVideoName(name)) return generateVideoPoster(src, dest);
    let buffer;
    try {
        buffer = fs.readFileSync(src);
    } catch (err) {
        return null;
    }
    const decoded = await decodePng(buffer);
    if (!decoded) return null;
    const scaled = await downscaleRgba(decoded.data, decoded.width, decoded.height, THUMB_MAX);
    const encoded = encodePng(scaled.data, scaled.width, scaled.height);
    try {
        if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });
        fs.writeFileSync(dest, encoded);
    } catch (err) {
        console.warn('[thumbnail] Write failed for ' + name + ':', err.message);
        return null;
    }
    return dest;
}

// Single-flight queue: one thumbnail is decoded at a time so the CPU cost is
// spread out, and duplicate requests for the same file collapse into one job.
const queue = [];
const queued = new Set();
let pumping = false;

function schedule(rawFilename) {
    const name = path.basename(String(rawFilename || ''));
    if (!isThumbSource(name) || queued.has(name) || has(name)) return;
    queued.add(name);
    queue.push(name);
    pump();
}

async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.length) {
        const name = queue.shift();
        try {
            await generate(name);
        } catch (err) {
            console.warn('[thumbnail] Generation failed for ' + name + ':', err.message);
        } finally {
            queued.delete(name);
        }
    }
    pumping = false;
}

// Queue thumbnails for every image and video already on disk, newest first, so
// the first gallery open after a server start has them ready without blocking.
function warm() {
    let files = [];
    try {
        files = fs.readdirSync(GENERATED_DIR);
    } catch (err) {
        return;
    }
    const sources = files.filter(isThumbSource).map((name) => {
        let mtime = 0;
        try { mtime = fs.statSync(path.join(GENERATED_DIR, name)).mtimeMs; } catch (err) { /* skip */ }
        return { name, mtime };
    }).sort((a, b) => b.mtime - a.mtime);
    sources.forEach((item) => schedule(item.name));
}

// Drop a thumbnail when its source image is deleted.
function remove(rawFilename) {
    const dest = thumbPath(rawFilename);
    try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
    } catch (err) {
        console.warn('[thumbnail] Delete failed for ' + path.basename(dest) + ':', err.message);
    }
}

module.exports = {
    GENERATED_DIR,
    THUMB_DIR,
    THUMB_MAX,
    thumbPath,
    has,
    read,
    generate,
    schedule,
    warm,
    remove,
    isPngName,
    isVideoName,
    isThumbSource,
    getFfmpegStatus,
    startFfmpegInstall,
    ffmpegJobState,
    // Codec/plan internals exposed for tests.
    installPlanFor,
    decodePng,
    downscaleRgba,
    encodePng,
    crc32
};
