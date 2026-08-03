'use client';

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { LIMITS } from './limits';

const CORE_VERSION = '0.12.10';
const CORE_BASE = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd`;

let instance: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;

export type LoadProgress = (pct: number, label: string) => void;

/** Single-threaded core: no SharedArrayBuffer, so no COOP/COEP headers needed. */
export async function getFFmpeg(onProgress?: LoadProgress): Promise<FFmpeg> {
  if (instance) return instance;
  if (loading) return loading;

  loading = (async () => {
    onProgress?.(5, 'Fetching encoder…');
    const ff = new FFmpeg();

    const [coreURL, wasmURL] = await Promise.all([
      toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
      toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
    ]);

    onProgress?.(60, 'Starting encoder…');
    await ff.load({ coreURL, wasmURL });
    onProgress?.(100, 'Encoder ready');

    instance = ff;
    return ff;
  })();

  try {
    return await loading;
  } catch (e) {
    loading = null;
    throw e;
  }
}

/**
 * There is exactly one ffmpeg instance and it is single-threaded, so two jobs
 * must never overlap — the GIF and MP3 exports would clobber each other's files
 * in the virtual FS and interleave their `progress` events. Every job runs
 * through this queue.
 *
 * Only leaf jobs (encodeGif, encodeMp3) take the lock. Anything that composes
 * them — encodeToFit, for instance — must NOT, or it deadlocks itself.
 */
let queue: Promise<unknown> = Promise.resolve();

export function withFFmpegLock<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

export type Crop = { x: number; y: number; w: number; h: number };

export type EncodeOptions = {
  start: number;
  end: number;
  crop: Crop;
  outWidth: number;
  outHeight: number;
  fps: number;
  speed: number; // 1 = normal, 2 = twice as fast
  colors: number; // palette size, 2-256
  dither: string; // 'sierra2_4a' | 'bayer' | 'floyd_steinberg' | 'none'
  bayerScale: number; // 0-5, only used when dither === 'bayer'
  loop: number; // 0 = infinite
  direction: 'forward' | 'reverse' | 'boomerang';
  sharpen: boolean;
};

export type EncodeResult = {
  data: Uint8Array;
  bytes: number;
  width: number;
  height: number;
  frames: number;
  options: EncodeOptions;
};

export function estimateFrames(o: Pick<EncodeOptions, 'start' | 'end' | 'fps' | 'speed' | 'direction'>): number {
  const dur = Math.max(0, o.end - o.start) / Math.max(0.05, o.speed);
  const base = Math.max(1, Math.round(dur * o.fps));
  return o.direction === 'boomerang' ? base * 2 : base;
}

function buildFilter(o: EncodeOptions): string {
  const chain: string[] = [];

  // Crop in source pixels, then resample.
  chain.push(
    `crop=${Math.round(o.crop.w)}:${Math.round(o.crop.h)}:${Math.round(o.crop.x)}:${Math.round(o.crop.y)}`,
  );

  if (o.speed !== 1) chain.push(`setpts=${(1 / o.speed).toFixed(6)}*PTS`);
  chain.push(`fps=${o.fps}`);
  chain.push(`scale=${o.outWidth}:${o.outHeight}:flags=lanczos`);
  if (o.sharpen) chain.push('unsharp=5:5:0.6:5:5:0.0');

  let pre = chain.join(',');

  // Direction handling happens before palette generation so the palette sees
  // every frame that will actually be written.
  if (o.direction === 'reverse') {
    pre += ',reverse';
  } else if (o.direction === 'boomerang') {
    // trim the duplicated seam frame off the reversed half
    pre = `${pre},split[fwd][rev];[rev]reverse,trim=start_frame=1,setpts=PTS-STARTPTS[revt];[fwd][revt]concat=n=2:v=1:a=0`;
  }

  const dither =
    o.dither === 'bayer' ? `bayer:bayer_scale=${o.bayerScale}` : o.dither === 'none' ? 'none' : o.dither;

  return (
    `[0:v]${pre}[src];` +
    `[src]split[a][b];` +
    `[a]palettegen=max_colors=${o.colors}:stats_mode=diff[pal];` +
    `[b][pal]paletteuse=dither=${dither}:diff_mode=rectangle`
  );
}

/**
 * Counts image descriptor blocks in a GIF so the 1000-frame check reflects the
 * real output rather than an estimate.
 */
export function countGifFrames(buf: Uint8Array): number {
  try {
    let p = 6; // "GIF89a"
    const packed = buf[p + 4];
    p += 7; // logical screen descriptor
    if (packed & 0x80) p += 3 * (1 << ((packed & 0x07) + 1)); // global color table

    const skipSubBlocks = () => {
      while (p < buf.length) {
        const size = buf[p++];
        if (size === 0) return;
        p += size;
      }
    };

    let frames = 0;
    while (p < buf.length) {
      const b = buf[p++];
      if (b === 0x3b) break; // trailer
      if (b === 0x21) {
        p++; // extension label
        skipSubBlocks();
      } else if (b === 0x2c) {
        const lp = buf[p + 8];
        p += 9; // image descriptor
        if (lp & 0x80) p += 3 * (1 << ((lp & 0x07) + 1)); // local color table
        p++; // LZW minimum code size
        skipSubBlocks();
        frames++;
      } else {
        break;
      }
    }
    return frames;
  } catch {
    return 0;
  }
}

export function encodeGif(
  source: Uint8Array,
  o: EncodeOptions,
  onProgress?: (pct: number) => void,
): Promise<EncodeResult> {
  return withFFmpegLock(() => runGifEncode(source, o, onProgress));
}

async function runGifEncode(
  source: Uint8Array,
  o: EncodeOptions,
  onProgress?: (pct: number) => void,
): Promise<EncodeResult> {
  const ff = await getFFmpeg();

  const handler = (e: any) => {
    const pct = Math.max(0, Math.min(100, Math.round((e?.progress ?? 0) * 100)));
    onProgress?.(pct);
  };
  ff.on('progress', handler);

  const inName = 'in.mp4';
  const outName = 'out.gif';

  try {
    if (source.byteLength === 0) {
      throw new Error('The source video is no longer in memory. Reload the clip and try again.');
    }

    // ffmpeg.wasm postMessages the Uint8Array to its worker with the underlying
    // ArrayBuffer in the transfer list, which DETACHES it on this side. Handing
    // it `source` directly would make the caller's copy unusable, so every
    // subsequent encode (i.e. every rung of the auto-fit ladder) would fail with
    // "An ArrayBuffer is detached and could not be cloned." Always give the
    // worker a throwaway copy and keep `source` pristine.
    await ff.writeFile(inName, new Uint8Array(source));

    const duration = Math.max(0.02, o.end - o.start);

    const args = [
      '-ss', o.start.toFixed(3),
      '-t', duration.toFixed(3),
      '-i', inName,
      '-an',
      '-filter_complex', buildFilter(o),
      '-loop', String(o.loop),
      '-f', 'gif',
      '-y', outName,
    ];

    await ff.exec(args);

    const out = (await ff.readFile(outName)) as Uint8Array;
    if (!out || out.length === 0) throw new Error('Encoder produced an empty file.');

    const actualFrames = countGifFrames(out);

    return {
      data: out,
      bytes: out.length,
      width: o.outWidth,
      height: o.outHeight,
      frames: actualFrames || estimateFrames(o),
      options: o,
    };
  } finally {
    ff.off('progress', handler);
    try { await ff.deleteFile(inName); } catch {}
    try { await ff.deleteFile(outName); } catch {}
  }
}

/**
 * Encode, then progressively back off quality until the result fits under the
 * 7TV byte limit. Backs off in the order that costs the least visual quality:
 * palette size first, then frame rate, then resolution.
 */
export async function encodeToFit(
  source: Uint8Array,
  base: EncodeOptions,
  onStep: (attempt: number, message: string) => void,
  onProgress?: (pct: number) => void,
): Promise<EncodeResult> {
  const colorLadder = [256, 192, 128, 96, 64, 48, 32];
  const fpsLadder = [base.fps, 30, 24, 20, 16, 12, 10];

  let opts: EncodeOptions = { ...base };
  let attempt = 0;
  let last: EncodeResult | null = null;

  // Candidate ladder: shrink palette, then fps, then dimensions.
  const plans: EncodeOptions[] = [];
  plans.push({ ...opts });

  for (const c of colorLadder.filter((c) => c < opts.colors)) {
    plans.push({ ...opts, colors: c });
  }
  for (const f of fpsLadder.filter((f) => f < opts.fps)) {
    plans.push({ ...opts, colors: 128, fps: f });
  }
  for (const shrink of [0.85, 0.7, 0.55, 0.45]) {
    plans.push({
      ...opts,
      colors: 128,
      fps: Math.min(opts.fps, 20),
      outWidth: Math.max(32, Math.round((opts.outWidth * shrink) / 2) * 2),
      outHeight: Math.max(32, Math.round((opts.outHeight * shrink) / 2) * 2),
    });
  }

  for (const plan of plans) {
    attempt += 1;
    if (estimateFrames(plan) > LIMITS.maxFrames) continue;

    onStep(attempt, `Attempt ${attempt}: ${plan.outWidth}×${plan.outHeight}, ${plan.fps} fps, ${plan.colors} colors`);
    const res = await encodeGif(source, plan, onProgress);
    last = res;
    if (res.bytes <= LIMITS.maxBytes) return res;
  }

  if (!last) throw new Error('Could not produce a GIF within the frame limit. Shorten the clip.');
  return last;
}
