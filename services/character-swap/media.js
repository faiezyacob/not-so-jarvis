/* ============================================
   JARVIS — Character Swap media helpers
   ffmpeg conforming, frame extraction, mask
   PNG IO and deterministic mask refinement.

   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const thumbnail = require('../thumbnail');

const FPS = 24;
const MAX_SIDE = 1280;

let ffmpegBin = null;

async function resolveFfmpeg() {
    if (ffmpegBin) return ffmpegBin;
    const status = await thumbnail.getFfmpegStatus();
    if (!status.available || !status.bin) {
        const err = new Error('ffmpeg is required for Character Swap. Install it from Settings > Setup.');
        err.code = 'character_swap_ffmpeg_missing';
        throw err;
    }
    ffmpegBin = status.bin;
    return ffmpegBin;
}

function run(args, options = {}) {
    return new Promise((resolve, reject) => {
        resolveFfmpeg().then((bin) => {
            const child = spawn(bin, args, { windowsHide: true });
            let stderr = '';
            let stdout = '';
            child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
            child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
            child.on('error', reject);
            child.on('close', (code) => {
                if (code === 0 || options.allowFailure) {
                    resolve({ stdout, stderr, code });
                    return;
                }
                const err = new Error('ffmpeg failed: ' + (stderr.trim().split(/\r?\n/).slice(-4).join(' ') || ('exit ' + code)));
                err.code = options.code || 'character_swap_ffmpeg_failed';
                reject(err);
            });
        }).catch(reject);
    });
}

function parseDuration(text) {
    const match = String(text || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match) return 0;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function probeVideo(file) {
    if (!file || !fs.existsSync(file)) throw new Error('The video file could not be found.');
    const { stderr } = await run(['-hide_banner', '-i', file], { allowFailure: true });
    if (!/Duration|Stream #\d+:\d+/.test(stderr)) {
        throw new Error('Could not read the video. Use a standard MP4, WebM or MOV file.');
    }
    const duration = parseDuration(stderr);
    let width = 0;
    let height = 0;
    let fps = 0;
    const videoLine = stderr.split(/\r?\n/).find((line) => /Stream #\d+:\d+.*Video:/.test(line)) || '';
    const dims = videoLine.match(/(\d{2,5})x(\d{2,5})/);
    if (dims) {
        width = Number(dims[1]);
        height = Number(dims[2]);
    }
    const rate = videoLine.match(/(\d+(?:\.\d+)?)\s+(?:fps|tbr)/);
    if (rate) fps = Number(rate[1]);
    const hasAudio = /Stream #\d+:\d+.*Audio:/.test(stderr);
    return {
        duration,
        width,
        height,
        fps: fps || FPS,
        frames: Math.max(1, Math.round(duration * (fps || FPS))),
        hasAudio
    };
}

function conformFilter(maxSide) {
    return [
        'fps=' + FPS,
        "scale=w='if(gte(iw,ih),min(" + maxSide + ",iw),-2)':h='if(gte(iw,ih),-2,min(" + maxSide + ",ih))'",
        'scale=trunc(iw/2)*2:trunc(ih/2)*2'
    ].join(',');
}

async function conform(input, output, options = {}) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const start = Math.max(0, Number(options.start) || 0);
    const duration = Number(options.duration);
    const args = ['-hide_banner', '-y'];
    if (start > 0) args.push('-ss', String(start));
    args.push('-i', input);
    if (Number.isFinite(duration) && duration > 0) args.push('-t', String(duration));
    args.push(
        '-vf', conformFilter(options.maxSide || MAX_SIDE),
        '-map', '0:v:0', '-map', '0:a?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart', output
    );
    await run(args, { code: 'character_swap_conform_failed' });
    return probeVideo(output);
}

async function extractFrame(video, frame, output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const index = Math.max(0, Math.round(Number(frame) || 0));
    await run([
        '-hide_banner', '-y', '-i', video,
        '-vf', "select='eq(n," + index + ")'",
        '-fps_mode', 'passthrough', '-frames:v', '1', output
    ], { code: 'character_swap_frame_failed' });
    if (!fs.existsSync(output)) throw new Error('That frame could not be read from the video.');
    return output;
}

async function extractFrames(video, outputDir, options = {}) {
    fs.mkdirSync(outputDir, { recursive: true });
    for (const name of fs.readdirSync(outputDir)) {
        if (/^frame-\d+\.png$/i.test(name)) fs.unlinkSync(path.join(outputDir, name));
    }
    const pattern = path.join(outputDir, 'frame-%06d.png');
    await run([
        '-hide_banner', '-y', '-i', video,
        '-fps_mode', 'passthrough', '-start_number', '1', pattern
    ], { code: 'character_swap_mask_extract_failed' });
    return listFrames(outputDir).length;
}

async function encodeFrames(dir, output, fps = FPS) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const pattern = path.join(dir, 'frame-%06d.png');
    await run([
        '-hide_banner', '-y', '-framerate', String(fps),
        '-i', pattern, '-c:v', 'libx264', '-preset', 'veryfast',
        '-crf', '12', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output
    ], { code: 'character_swap_mask_encode_failed' });
    return output;
}

async function padTo(input, output, seconds) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    await run([
        '-hide_banner', '-y', '-i', input,
        '-vf', 'tpad=stop_mode=clone:stop_duration=' + Number(seconds),
        '-t', String(Number(seconds)),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12',
        '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', output
    ], { code: 'character_swap_mask_pad_failed' });
    return output;
}

async function reverse(input, output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    await run([
        '-hide_banner', '-y', '-i', input, '-an',
        '-vf', 'reverse', '-c:v', 'libx264', '-preset', 'veryfast',
        '-crf', '12', '-pix_fmt', 'yuv420p', output
    ], { code: 'character_swap_reverse_failed' });
    return output;
}

// Conform to an exact frame rate and canvas. Used by the Wan Animate 2
// preparation (24 fps, multiple-of-16 canvas, optional letterbox padding) and
// the H3 mask pipeline so video_frame_offset stays aligned across windows.
async function conformExact(input, output, options = {}) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const fps = Math.max(1, Number(options.fps) || FPS);
    const width = Math.max(2, Math.round(Number(options.width) || 0));
    const height = Math.max(2, Math.round(Number(options.height) || 0));
    if (!width || !height) throw new Error('A target width and height are required.');
    const start = Math.max(0, Number(options.start) || 0);
    const duration = Number(options.duration);
    const flags = options.neighbor ? 'neighbor' : 'bicubic';
    const pad = options.fit === 'pad';
    const filter = [
        'fps=' + fps,
        'scale=' + width + ':' + height + ':force_original_aspect_ratio=' + (pad ? 'decrease' : 'increase') + ':flags=' + flags,
        pad ? 'pad=' + width + ':' + height + ':(ow-iw)/2:(oh-ih)/2:color=black' : 'crop=' + width + ':' + height,
        'scale=trunc(iw/2)*2:trunc(ih/2)*2'
    ].join(',');
    const args = ['-hide_banner', '-y'];
    if (start > 0) args.push('-ss', String(start));
    args.push('-i', input);
    if (Number.isFinite(duration) && duration > 0) args.push('-t', String(duration));
    args.push('-vf', filter);
    if (options.audio === false) {
        args.push('-an');
    } else {
        args.push('-map', '0:v:0', '-map', '0:a?', '-c:a', 'aac', '-b:a', '160k');
    }
    args.push(
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(options.crf || 16),
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output
    );
    await run(args, { code: options.code || 'character_swap_conform_exact_failed' });
    return probeVideo(output);
}

// Scope a DWPose face render to one tracked person: multiply the face-control
// video by that person's (dilated) mask so facial landmarks belonging to other
// people in the frame are dropped. The source frames are never touched — only
// the face_video conditioning WanAnimateToVideo receives.
async function scopeFaceVideo(faceVideo, maskVideo, output, options = {}) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const rings = Math.max(0, Math.min(16, Math.round(Number(options.grow) || 4)));
    const dilation = new Array(rings).fill('dilation').join(',');
    const maskChain = 'format=rgb24' + (dilation ? ',' + dilation : '');
    const filter = '[1:v]' + maskChain + '[m];[0:v]format=rgb24[f];[f][m]blend=all_mode=multiply:all_opacity=1[o]';
    await run([
        '-hide_banner', '-y', '-i', faceVideo, '-i', maskVideo,
        '-filter_complex', filter, '-map', '[o]', '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output
    ], { code: options.code || 'character_swap_face_scope_failed' });
    return output;
}

// Per-frame peak luma of the DWPose face render. A usable facial-control video
// carries bright landmark pixels; a failed detection produces near-black
// frames. Used to prove facial conditioning is real, not just a non-empty file.
async function videoBrightnessStats(file) {
    const { stderr } = await run([
        '-hide_banner', '-nostats', '-i', file,
        '-vf', 'signalstats,metadata=print', '-an', '-f', 'null', '-'
    ], { allowFailure: true, code: 'character_swap_face_stats_failed' });
    const values = [];
    const re = /lavfi\.signalstats\.YMAX=([0-9.]+)/g;
    let match;
    while ((match = re.exec(String(stderr || '')))) values.push(Number(match[1]));
    const frames = values.length;
    const bright = values.filter((value) => value >= 120).length;
    return { frames, bright, ratio: frames ? bright / frames : 0 };
}

// Hold the final frame for extra seconds so a short last window still gives
// WanAnimateToVideo a full-length pose/face/mask/source batch.
async function padVideo(input, output, seconds, options = {}) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const hold = Math.max(0, Number(seconds) || 0);
    const filter = 'tpad=stop_mode=clone:stop_duration=' + hold;
    await run([
        '-hide_banner', '-y', '-i', input,
        '-vf', filter,
        '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(options.crf || 16),
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output
    ], { code: options.code || 'character_swap_pad_failed' });
    return probeVideo(output);
}

async function concatVideos(files, output, options = {}) {
    const list = Array.isArray(files) ? files.filter(Boolean) : [];
    if (!list.length) throw new Error('There are no video windows to stitch.');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const listPath = output + '.concat.txt';
    const body = list.map((file) => "file '" + String(file).replace(/'/g, "'\\''").replace(/\\/g, '/') + "'").join('\n');
    fs.writeFileSync(listPath, body + '\n');
    try {
        await run([
            '-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
            '-an',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(options.crf || 16),
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output
        ], { code: options.code || 'character_swap_concat_failed' });
    } finally {
        try { fs.unlinkSync(listPath); } catch { /* next cleanup */ }
    }
    return probeVideo(output);
}

// Mux the original soundtrack back onto a rendered (silent) replacement.
async function muxAudio(video, audioSource, output, options = {}) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    if (!options.hasAudio || !audioSource || !fs.existsSync(audioSource)) {
        await run([
            '-hide_banner', '-y', '-i', video,
            '-c:v', 'copy', '-an', '-movflags', '+faststart', output
        ], { code: 'character_swap_mux_failed' });
        return probeVideo(output);
    }
    // Do NOT use -shortest here: stream-copied H.264 with AAC priming can
    // make ffmpeg drop the final video packets, shortening the replacement by
    // a frame or more. The video is authoritative; the muxed audio is the
    // source track and already matches the clip duration.
    await run([
        '-hide_banner', '-y', '-i', video, '-i', audioSource,
        '-map', '0:v:0', '-map', '1:a:0?',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart', output
    ], { code: 'character_swap_mux_failed' });
    return probeVideo(output);
}

function listFrames(dir) {
    try {
        return fs.readdirSync(dir)
            .filter((name) => /^frame-\d+\.png$/i.test(name))
            .sort((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }
}

function frameName(index) {
    return 'frame-' + String(index + 1).padStart(6, '0') + '.png';
}

async function readMask(file) {
    const decoded = await thumbnail.decodePng(fs.readFileSync(file));
    if (!decoded) throw new Error('The mask frame could not be decoded.');
    const values = new Uint8Array(decoded.width * decoded.height);
    for (let i = 0; i < values.length; i += 1) values[i] = decoded.data[i * 4];
    return { width: decoded.width, height: decoded.height, values };
}

function writeMask(file, values, width, height) {
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < values.length; i += 1) {
        const value = values[i];
        rgba[i * 4] = value;
        rgba[i * 4 + 1] = value;
        rgba[i * 4 + 2] = value;
        rgba[i * 4 + 3] = 255;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, thumbnail.encodePng(rgba, width, height));
}

function emptyMask(width, height) {
    return new Uint8Array(width * height);
}

// Remove tiny isolated islands (SAM occasionally leaves a speck on the far
// side of the frame). A speck otherwise survives GrowMask and becomes a
// visible replacement blob.
function removeSpecks(values, width, height, minArea) {
    const threshold = Math.max(32, Math.round(Number(minArea) || width * height * 0.0003));
    const seen = new Uint8Array(values.length);
    const stack = new Int32Array(values.length);
    const component = new Int32Array(values.length);
    const out = new Uint8Array(values);
    for (let start = 0; start < values.length; start += 1) {
        if (values[start] < 128 || seen[start]) continue;
        let top = 0;
        let count = 0;
        stack[top++] = start;
        seen[start] = 1;
        while (top > 0) {
            const index = stack[--top];
            component[count++] = index;
            const x = index % width;
            const y = (index - x) / width;
            if (x > 0) {
                const next = index - 1;
                if (!seen[next] && values[next] >= 128) { seen[next] = 1; stack[top++] = next; }
            }
            if (x + 1 < width) {
                const next = index + 1;
                if (!seen[next] && values[next] >= 128) { seen[next] = 1; stack[top++] = next; }
            }
            if (y > 0) {
                const next = index - width;
                if (!seen[next] && values[next] >= 128) { seen[next] = 1; stack[top++] = next; }
            }
            if (y + 1 < height) {
                const next = index + width;
                if (!seen[next] && values[next] >= 128) { seen[next] = 1; stack[top++] = next; }
            }
        }
        if (count < threshold) {
            for (let i = 0; i < count; i += 1) out[component[i]] = 0;
        }
    }
    return out;
}

function bbox(values, width, height) {
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
        const row = y * width;
        for (let x = 0; x < width; x += 1) {
            if (values[row + x] < 128) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function centroid(values, width, height) {
    let sum = 0;
    let weighted = 0;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const value = values[y * width + x];
            if (value < 128) continue;
            sum += 1;
            weighted += x;
        }
    }
    return sum ? weighted / sum / Math.max(1, width) : 0.5;
}

function maxFilter1D(source, length, radius) {
    const out = new Uint8Array(length);
    const deque = new Int32Array(length);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < length + radius; i += 1) {
        if (i < length) {
            while (tail > head && source[deque[tail - 1]] <= source[i]) tail -= 1;
            deque[tail++] = i;
        }
        const center = i - radius;
        if (center < 0) continue;
        while (tail > head && deque[head] < center - radius) head += 1;
        out[center] = source[deque[head]];
    }
    return { out };
}

function dilate(values, width, height, radius) {
    const px = Math.max(0, Math.round(radius));
    if (!px) return values;
    const rows = new Uint8Array(values.length);
    const rowBuf = new Uint8Array(width);
    for (let y = 0; y < height; y += 1) {
        rowBuf.set(values.subarray(y * width, (y + 1) * width));
        rows.set(maxFilter1D(rowBuf, width, px).out, y * width);
    }
    const out = new Uint8Array(values.length);
    const colBuf = new Uint8Array(height);
    for (let x = 0; x < width; x += 1) {
        for (let y = 0; y < height; y += 1) colBuf[y] = rows[y * width + x];
        const filtered = maxFilter1D(colBuf, height, px).out;
        for (let y = 0; y < height; y += 1) out[y * width + x] = filtered[y];
    }
    return out;
}

function contract(values, width, height, radius) {
    const inverted = new Uint8Array(values.length);
    for (let i = 0; i < values.length; i += 1) inverted[i] = 255 - values[i];
    const expanded = dilate(inverted, width, height, radius);
    const out = new Uint8Array(values.length);
    for (let i = 0; i < values.length; i += 1) out[i] = 255 - expanded[i];
    return out;
}

function boxBlur(values, width, height, radius) {
    const px = Math.max(0, Math.round(radius));
    if (!px) return values;
    const out = new Uint8Array(values.length);
    const rowOut = new Uint8Array(width);
    for (let y = 0; y < height; y += 1) {
        const base = y * width;
        let sum = 0;
        for (let x = 0; x <= px && x < width; x += 1) sum += values[base + x];
        for (let x = 0; x < width; x += 1) {
            const start = Math.max(0, x - px);
            const end = Math.min(width - 1, x + px);
            rowOut[x] = Math.round(sum / (end - start + 1));
            if (x + px + 1 < width) sum += values[base + x + px + 1];
            if (x - px >= 0) sum -= values[base + x - px];
        }
        out.set(rowOut, base);
    }
    const col = new Uint8Array(height);
    const colOut = new Uint8Array(height);
    for (let x = 0; x < width; x += 1) {
        for (let y = 0; y < height; y += 1) col[y] = out[y * width + x];
        let sum = 0;
        for (let y = 0; y <= px && y < height; y += 1) sum += col[y];
        for (let y = 0; y < height; y += 1) {
            const start = Math.max(0, y - px);
            const end = Math.min(height - 1, y + px);
            colOut[y] = Math.round(sum / (end - start + 1));
            if (y + px + 1 < height) sum += col[y + px + 1];
            if (y - px >= 0) sum -= col[y - px];
        }
        for (let y = 0; y < height; y += 1) out[y * width + x] = colOut[y];
    }
    return out;
}

function temporalSmooth(frames, width, height, radius) {
    const px = Math.max(0, Math.round(radius));
    if (!px || frames.length < 2) return frames;
    const out = [];
    for (let index = 0; index < frames.length; index += 1) {
        const sums = new Uint32Array(width * height);
        let count = 0;
        for (let offset = -px; offset <= px; offset += 1) {
            const frame = frames[index + offset];
            if (!frame) continue;
            count += 1;
            for (let i = 0; i < sums.length; i += 1) sums[i] += frame[i];
        }
        const values = new Uint8Array(width * height);
        for (let i = 0; i < values.length; i += 1) values[i] = sums[i] / count >= 128 ? 255 : 0;
        out.push(values);
    }
    return out;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
    const x = ax + t * dx;
    const y = ay + t * dy;
    return Math.hypot(px - x, py - y);
}

function applyStrokes(values, width, height, strokes) {
    const out = new Uint8Array(values);
    for (const stroke of Array.isArray(strokes) ? strokes : []) {
        if (!stroke || !Array.isArray(stroke.points) || !stroke.points.length) continue;
        const radius = Math.max(1, Math.round(Number(stroke.radius) || 14));
        const add = stroke.tool !== 'erase';
        const points = stroke.points.map((p) => ({
            x: Math.max(0, Math.min(width - 1, Number(p.x))),
            y: Math.max(0, Math.min(height - 1, Number(p.y)))
        }));
        if (points.length === 1) points.push(points[0]);
        for (let i = 1; i < points.length; i += 1) {
            const a = points[i - 1];
            const b = points[i];
            const minX = Math.max(0, Math.floor(Math.min(a.x, b.x) - radius));
            const maxX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x) + radius));
            const minY = Math.max(0, Math.floor(Math.min(a.y, b.y) - radius));
            const maxY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y) + radius));
            for (let y = minY; y <= maxY; y += 1) {
                for (let x = minX; x <= maxX; x += 1) {
                    if (distanceToSegment(x, y, a.x, a.y, b.x, b.y) > radius) continue;
                    out[y * width + x] = add ? 255 : 0;
                }
            }
        }
    }
    return out;
}

function union(frames) {
    if (!frames.length) return null;
    const width = frames[0].width;
    const height = frames[0].height;
    const out = new Uint8Array(width * height);
    for (const frame of frames) {
        for (let i = 0; i < out.length; i += 1) {
            if (frame[i] > out[i]) out[i] = frame[i];
        }
    }
    return { width, height, values: out };
}

function fillGaps(frames) {
    if (!frames.length) return frames;
    const filled = frames.slice();
    let last = null;
    let firstIndex = -1;
    for (let i = 0; i < filled.length; i += 1) {
        if (filled[i] && filled[i].some((v) => v >= 128)) {
            if (firstIndex < 0) firstIndex = i;
            last = filled[i];
            continue;
        }
        if (last) {
            filled[i] = last;
        }
    }
    if (firstIndex > 0 && last) {
        for (let i = 0; i < firstIndex; i += 1) filled[i] = filled[firstIndex];
    }
    return filled;
}

module.exports = {
    FPS,
    MAX_SIDE,
    resolveFfmpeg,
    run,
    probeVideo,
    conform,
    conformExact,
    padVideo,
    scopeFaceVideo,
    videoBrightnessStats,
    concatVideos,
    muxAudio,
    extractFrame,
    extractFrames,
    encodeFrames,
    padTo,
    reverse,
    listFrames,
    frameName,
    readMask,
    writeMask,
    emptyMask,
    removeSpecks,
    bbox,
    centroid,
    dilate,
    contract,
    boxBlur,
    temporalSmooth,
    applyStrokes,
    union,
    fillGaps
};
