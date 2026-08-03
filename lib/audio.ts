'use client';

/**
 * MP3 extraction from the same source buffer the GIF encoder uses.
 *
 * Shares the single ffmpeg.wasm instance (and its lock) with lib/ffmpeg.ts, so
 * an audio export and a GIF export can be kicked off in either order without
 * stepping on each other.
 *
 * The @ffmpeg/core build ships `--enable-libmp3lame`, so no extra assets are
 * needed beyond the core that is already warmed when the editor opens.
 */

import { getFFmpeg, withFFmpegLock } from './ffmpeg';

export const MP3_BITRATES = [96, 128, 192, 256, 320] as const;
export type Mp3Bitrate = (typeof MP3_BITRATES)[number];

export type AudioEncodeOptions = {
  start: number;
  end: number;
  bitrate: number; // kbps
  speed: number; // 1 = untouched; matches the GIF speed when "match speed" is on
  fade: boolean; // 20 ms taper on each end so cuts don't click
  normalize: boolean; // even out quiet vs. blown-out clip audio
};

export type AudioResult = {
  data: Uint8Array;
  bytes: number;
  seconds: number;
  options: AudioEncodeOptions;
};

const FADE = 0.02; // seconds

/** Output duration after the tempo change. */
export function audioDuration(o: Pick<AudioEncodeOptions, 'start' | 'end' | 'speed'>): number {
  return Math.max(0, o.end - o.start) / Math.max(0.05, o.speed);
}

/**
 * `atempo` is clamped to 0.5–2.0 per instance, but the editor's speed slider
 * goes 0.25–4, so anything outside that window has to be reached by chaining
 * filters whose factors multiply out to the requested rate.
 */
export function atempoChain(speed: number): string[] {
  if (!isFinite(speed) || speed <= 0) return [];
  const out: string[] = [];
  let s = speed;
  while (s > 2) {
    out.push('atempo=2.0');
    s /= 2;
  }
  while (s < 0.5) {
    out.push('atempo=0.5');
    s *= 2;
  }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${s.toFixed(6)}`);
  return out;
}

function buildAudioFilter(o: AudioEncodeOptions): string {
  const chain: string[] = [];

  if (o.speed !== 1) chain.push(...atempoChain(o.speed));

  // loudnorm before the fade so the taper isn't itself normalised away.
  if (o.normalize) chain.push('loudnorm=I=-16:TP=-1.5:LRA=11');

  const dur = audioDuration(o);
  if (o.fade && dur > FADE * 3) {
    chain.push(`afade=t=in:st=0:d=${FADE}`);
    chain.push(`afade=t=out:st=${(dur - FADE).toFixed(3)}:d=${FADE}`);
  }

  return chain.join(',');
}

/* ------------------------------- probing -------------------------------- */

function boxType(b: Uint8Array, p: number): string {
  return String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
}

function u32(b: Uint8Array, p: number): number {
  return b[p] * 0x1000000 + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
}

const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta']);

function scanForSoundHandler(b: Uint8Array, from: number, to: number, depth: number): boolean {
  let p = from;
  while (p + 8 <= to) {
    let size = u32(b, p);
    const type = boxType(b, p + 4);
    let header = 8;

    if (size === 1) {
      // 64-bit largesize; the high word is always 0 for anything a browser holds in memory.
      if (p + 16 > to) return false;
      size = u32(b, p + 8) * 0x100000000 + u32(b, p + 12);
      header = 16;
    } else if (size === 0) {
      size = to - p; // box runs to the end of its parent
    }
    if (size < header) return false; // malformed — stop rather than loop forever

    if (type === 'hdlr') {
      // FullBox(4) + pre_defined(4) then the four-char handler type
      const hp = p + header + 8;
      if (hp + 4 <= to && boxType(b, hp) === 'soun') return true;
    }

    if (CONTAINER_BOXES.has(type) && depth < 8) {
      if (scanForSoundHandler(b, p + header, Math.min(to, p + size), depth + 1)) return true;
    }

    p += size;
  }
  return false;
}

/**
 * Walks the MP4 box tree looking for a track with a `soun` handler.
 *
 * Returns `null` when the answer is genuinely unknown — a local WebM upload,
 * a fragmented file with no `moov`, anything that isn't ISO base media. Callers
 * should treat `null` as "let the user try" rather than "no audio", since
 * guessing wrong in that direction hides a working button.
 */
export function probeHasAudio(bytes: Uint8Array): boolean | null {
  try {
    if (bytes.length < 16) return null;
    if (boxType(bytes, 4) !== 'ftyp') return null; // not ISOBMFF

    let p = 0;
    let sawMoov = false;
    while (p + 8 <= bytes.length) {
      let size = u32(bytes, p);
      const type = boxType(bytes, p + 4);
      let header = 8;
      if (size === 1) {
        if (p + 16 > bytes.length) break;
        size = u32(bytes, p + 8) * 0x100000000 + u32(bytes, p + 12);
        header = 16;
      } else if (size === 0) {
        size = bytes.length - p;
      }
      if (size < header) break;

      if (type === 'moov') {
        sawMoov = true;
        if (scanForSoundHandler(bytes, p + header, Math.min(bytes.length, p + size), 1)) return true;
      }
      p += size;
    }

    return sawMoov ? false : null;
  } catch {
    return null;
  }
}

/* ------------------------------- encoding -------------------------------- */

export function encodeMp3(
  source: Uint8Array,
  o: AudioEncodeOptions,
  onProgress?: (pct: number) => void,
): Promise<AudioResult> {
  return withFFmpegLock(() => runMp3Encode(source, o, onProgress));
}

async function runMp3Encode(
  source: Uint8Array,
  o: AudioEncodeOptions,
  onProgress?: (pct: number) => void,
): Promise<AudioResult> {
  const ff = await getFFmpeg();

  const handler = (e: any) => {
    onProgress?.(Math.max(0, Math.min(100, Math.round((e?.progress ?? 0) * 100))));
  };
  ff.on('progress', handler);

  // ffmpeg writes decode failures to the log rather than rejecting, so keep the
  // last few lines around to turn "empty output" into something actionable.
  const logLines: string[] = [];
  const logHandler = (e: any) => {
    const m = String(e?.message ?? '');
    if (m) logLines.push(m);
    if (logLines.length > 40) logLines.shift();
  };
  ff.on('log', logHandler);

  const inName = 'audio-in.mp4';
  const outName = 'audio-out.mp3';

  try {
    if (source.byteLength === 0) {
      throw new Error('The source video is no longer in memory. Reload the clip and try again.');
    }

    const duration = Math.max(0.05, o.end - o.start);
    const filter = buildAudioFilter(o);

    // Same detachment hazard as the GIF path: writeFile transfers the buffer to
    // the worker, so hand it a copy and keep `source` intact for the next export.
    await ff.writeFile(inName, new Uint8Array(source));

    const args = [
      '-ss', o.start.toFixed(3),
      '-t', duration.toFixed(3),
      '-i', inName,
      '-vn',
      '-map', '0:a:0',
      ...(filter ? ['-af', filter] : []),
      '-c:a', 'libmp3lame',
      '-b:a', `${o.bitrate}k`,
      '-ar', '44100',
      '-ac', '2',
      '-write_xing', '1',
      '-id3v2_version', '3',
      '-f', 'mp3',
      '-y', outName,
    ];

    await ff.exec(args);

    let out: Uint8Array;
    try {
      out = (await ff.readFile(outName)) as Uint8Array;
    } catch {
      throw new Error(describeFailure(logLines));
    }
    if (!out || out.length === 0) throw new Error(describeFailure(logLines));

    return {
      data: out,
      bytes: out.length,
      seconds: audioDuration(o),
      options: o,
    };
  } finally {
    ff.off('progress', handler);
    ff.off('log', logHandler);
    try { await ff.deleteFile(inName); } catch {}
    try { await ff.deleteFile(outName); } catch {}
  }
}

function describeFailure(logLines: string[]): string {
  const joined = logLines.join('\n');
  if (/Stream map .* matches no streams|does not contain any stream|Output file .* does not contain any stream/i.test(joined)) {
    return 'This clip has no audio track, so there is nothing to extract.';
  }
  const err = logLines.filter((l) => /error|invalid|failed/i.test(l)).pop();
  return err ? `Audio export failed: ${err.trim()}` : 'Audio export produced an empty file.';
}
