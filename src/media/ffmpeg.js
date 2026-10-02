import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * ffmpeg/ffprobe are optional. When they are missing Posterly still validates,
 * stores and publishes — it just forwards the source file instead of
 * producing per-platform reframed variants.
 */
export function resolveBinaries(config = {}) {
  const ffmpeg = config.ffmpegPath || process.env.FFMPEG_PATH || findOnPath('ffmpeg');
  const ffprobe = config.ffprobePath || process.env.FFPROBE_PATH || findOnPath('ffprobe');
  return { ffmpeg, ffprobe, available: Boolean(ffmpeg && ffprobe) };
}

function findOnPath(binary) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Pure: parse `ffprobe -print_format json -show_format -show_streams` output. */
export function parseProbe(stdout) {
  const data = JSON.parse(stdout);
  const video = (data.streams || []).find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = (data.streams || []).find((s) => s.codec_type === 'audio');
  const durationRaw = video?.duration ?? data.format?.duration;
  const durationSec = Number(durationRaw);

  let fps;
  if (video?.avg_frame_rate && video.avg_frame_rate !== '0/0') {
    const [num, den] = video.avg_frame_rate.split('/').map(Number);
    fps = den ? num / den : undefined;
  }

  return {
    durationMs: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: Number.isFinite(fps) ? Math.round(fps * 100) / 100 : null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    bitrate: Number(data.format?.bit_rate) || null,
    size: Number(data.format?.size) || null,
    format: data.format?.format_name ?? null,
  };
}

/**
 * Pure: build the ffmpeg argument list for a reframed variant.
 * Uses cover-crop (scale up, then centre-crop) so no letterboxing is added.
 */
export function buildTranscodeArgs({ input, output, settings }) {
  const { width, height, videoBitrateK = 5000, audioBitrateK = 128, fps = 30 } = settings;
  const vf = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    'setsar=1',
    `fps=${fps}`,
  ].join(',');

  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-vf',
    vf,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    `${videoBitrateK}k`,
    '-maxrate',
    `${Math.round(videoBitrateK * 1.3)}k`,
    '-bufsize',
    `${videoBitrateK * 2}k`,
    '-c:a',
    'aac',
    '-b:a',
    `${audioBitrateK}k`,
    '-ar',
    '44100',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    output,
  ];
}

export async function probe(filePath, binaries = resolveBinaries()) {
  if (!binaries.ffprobe) return { available: false };
  const { stdout } = await execFileAsync(
    binaries.ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  return { available: true, ...parseProbe(stdout) };
}

/** Run a transcode; rejects with stderr on failure. */
export function transcode({ input, output, settings, binaries = resolveBinaries() }) {
  return new Promise((resolve, reject) => {
    if (!binaries.ffmpeg) {
      reject(new Error('ffmpeg is not available'));
      return;
    }
    const args = buildTranscodeArgs({ input, output, settings });
    const child = spawn(binaries.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ output, args });
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().slice(-2000)}`));
    });
  });
}

export function sniffContainer(filePath) {
  const buffer = Buffer.alloc(12);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  const brand = buffer.subarray(4, 8).toString('ascii');
  if (['ftyp', 'moov', 'mdat'].includes(brand)) return 'mp4';
  if (buffer.subarray(0, 4).toString('hex') === '1a45dfa3') return 'webm';
  if (buffer.subarray(0, 3).toString('ascii') === 'FLV') return 'flv';
  return null;
}
