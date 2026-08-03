'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CropStage, { type Crop } from './CropStage';
import Timeline from './Timeline';
import AudioBar from './AudioBar';
import { LIMITS, MAX_MB, formatBytes, formatTime } from '@/lib/limits';
import { encodeGif, encodeToFit, estimateFrames, getFFmpeg, type EncodeOptions, type EncodeResult } from '@/lib/ffmpeg';
import {
  MP3_BITRATES,
  audioDuration,
  encodeMp3,
  probeHasAudio,
  type AudioEncodeOptions,
  type AudioResult,
} from '@/lib/audio';
import type { ClipInfo } from '@/lib/twitch';

type Phase = 'idle' | 'resolving' | 'downloading' | 'ready' | 'error';

const ASPECTS: { label: string; value: number | null }[] = [
  { label: 'Free', value: null },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '16:9', value: 16 / 9 },
];

const DITHERS = [
  { label: 'Sierra (default)', value: 'sierra2_4a' },
  { label: 'Floyd–Steinberg', value: 'floyd_steinberg' },
  { label: 'Bayer (crisp, smaller)', value: 'bayer' },
  { label: 'None (flat / posterized)', value: 'none' },
];

export default function Editor({ initialSlug, initialName }: { initialSlug: string; initialName: string }) {
  /* ------------------------------- source -------------------------------- */
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [input, setInput] = useState(initialSlug);
  const [clip, setClip] = useState<ClipInfo | null>(null);
  const [quality, setQuality] = useState<string>('480');
  const [dlPct, setDlPct] = useState(0);
  const [srcBytes, setSrcBytes] = useState<Uint8Array | null>(null);
  const [srcUrl, setSrcUrl] = useState('');
  const [emoteName, setEmoteName] = useState(initialName);

  /* -------------------------------- video -------------------------------- */
  const videoRef = useRef<HTMLVideoElement>(null);
  const [nat, setNat] = useState({ w: 0, h: 0 });
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);

  /* --------------------------------- edit -------------------------------- */
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [crop, setCrop] = useState<Crop>({ x: 0, y: 0, w: 0, h: 0 });
  const [aspect, setAspect] = useState<number | null>(1);

  const [sizeMode, setSizeMode] = useState<'auto' | 'custom'>('auto');
  const [longEdge, setLongEdge] = useState(512);
  const [customW, setCustomW] = useState(512);
  const [customH, setCustomH] = useState(512);

  const [fps, setFps] = useState(24);
  const [colors, setColors] = useState(192);
  const [dither, setDither] = useState('sierra2_4a');
  const [bayerScale, setBayerScale] = useState(3);
  const [speed, setSpeed] = useState(1);
  const [direction, setDirection] = useState<'forward' | 'reverse' | 'boomerang'>('forward');
  const [sharpen, setSharpen] = useState(false);
  const [loop, setLoop] = useState(0);

  /* -------------------------------- encode ------------------------------- */
  const [engineReady, setEngineReady] = useState(false);
  const [engineMsg, setEngineMsg] = useState('');
  const [encoding, setEncoding] = useState(false);
  const [encPct, setEncPct] = useState(0);
  const [encStep, setEncStep] = useState('');
  const [result, setResult] = useState<EncodeResult | null>(null);
  const [resultUrl, setResultUrl] = useState('');

  /* -------------------------------- audio -------------------------------- */
  // Starts muted: browsers block unmuted autoplay, and nobody wants a clip
  // blasting the moment the editor opens.
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(0.8);
  const [hasAudio, setHasAudio] = useState<boolean | null>(null);

  const [mp3Bitrate, setMp3Bitrate] = useState(192);
  const [matchSpeed, setMatchSpeed] = useState(true);
  const [audioFade, setAudioFade] = useState(true);
  const [audioNormalize, setAudioNormalize] = useState(false);

  const [audioEncoding, setAudioEncoding] = useState(false);
  const [audioPct, setAudioPct] = useState(0);
  const [audioError, setAudioError] = useState('');
  const [audioResult, setAudioResult] = useState<AudioResult | null>(null);
  const [audioUrl, setAudioUrl] = useState('');

  /* ----------------------------- source loading -------------------------- */

  const loadClip = useCallback(async (value: string) => {
    setError('');
    setResult(null);
    setPhase('resolving');
    try {
      const res = await fetch(`/api/resolve?input=${encodeURIComponent(value)}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not resolve that clip');
      const info = json as ClipInfo;
      setClip(info);
      const preferred = info.qualities.find((q) => q.quality === '480') ?? info.qualities[info.qualities.length - 1];
      setQuality(preferred.quality);
      await downloadRendition(preferred.url);
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    }
  }, []);

  async function downloadRendition(url: string) {
    setPhase('downloading');
    setDlPct(0);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not download the clip (${res.status})`);

    const total = Number(res.headers.get('content-length')) || 0;
    const chunks: Uint8Array[] = [];
    let received = 0;

    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (total) setDlPct(Math.round((received / total) * 100));
      }
    } else {
      const buf = new Uint8Array(await res.arrayBuffer());
      chunks.push(buf);
      received = buf.length;
    }

    const bytes = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.length;
    }

    setSrcBytes(bytes);
    setSrcUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'video/mp4' }));
    });
    setDlPct(100);
    setPhase('ready');
  }

  async function switchQuality(q: string) {
    const target = clip?.qualities.find((x) => x.quality === q);
    if (!target) return;
    setQuality(q);
    try {
      await downloadRendition(target.url);
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    }
  }

  async function loadLocalFile(file: File) {
    setError('');
    setResult(null);
    setClip(null);
    setPhase('downloading');
    setDlPct(50);
    const bytes = new Uint8Array(await file.arrayBuffer());
    setSrcBytes(bytes);
    setSrcUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setDlPct(100);
    setPhase('ready');
  }

  useEffect(() => {
    if (initialSlug) loadClip(initialSlug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new source invalidates any previously extracted audio, and tells us up
  // front whether there's an audio track worth offering at all.
  useEffect(() => {
    setAudioResult(null);
    setAudioError('');
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return '';
    });
    setHasAudio(srcBytes ? probeHasAudio(srcBytes) : null);
  }, [srcBytes]);

  // Warm the encoder in the background so the first export isn't a cold start.
  useEffect(() => {
    let alive = true;
    getFFmpeg((pct, label) => {
      if (alive) setEngineMsg(pct < 100 ? label : '');
    })
      .then(() => alive && setEngineReady(true))
      .catch((e) => alive && setEngineMsg(`Encoder failed to load: ${e.message}`));
    return () => {
      alive = false;
    };
  }, []);

  /* ------------------------------ video events --------------------------- */

  function onLoadedMetadata() {
    const v = videoRef.current;
    if (!v) return;
    const w = v.videoWidth;
    const h = v.videoHeight;
    const d = isFinite(v.duration) ? v.duration : 0;
    setNat({ w, h });
    setDuration(d);
    setStart(0);
    setEnd(Math.min(d, 4));

    const side = Math.min(w, h);
    setCrop({ x: Math.round((w - side) / 2), y: Math.round((h - side) / 2), w: side, h: side });
    setLongEdge(Math.min(512, side));
    v.currentTime = 0;
  }

  function onTimeUpdate() {
    const v = videoRef.current;
    if (v) setCurrent(v.currentTime);
  }

  // Loop playback inside the trimmed range.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !playing) return;
    let raf = 0;
    const tick = () => {
      if (v.currentTime >= end - 0.02 || v.currentTime < start - 0.05) {
        v.currentTime = start;
      }
      setCurrent(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, start, end]);

  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(t, v.duration || 0));
    setCurrent(v.currentTime);
  }, []);

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime < start || v.currentTime > end) v.currentTime = start;
      v.play().catch(() => {
        // Some browsers still refuse unmuted playback in edge cases (autoplay
        // policy, no prior gesture on this document). Fall back to silent
        // playback rather than leaving the user with a dead play button.
        v.muted = true;
        setMuted(true);
        v.play().catch(() => setPlaying(false));
      });
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  }

  /* ------------------------------- shortcuts ----------------------------- */

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (phase !== 'ready') return;

      const frame = 1 / Math.max(1, fps);
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        seek(current - (e.shiftKey ? 1 : frame));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        seek(current + (e.shiftKey ? 1 : frame));
      } else if (e.key === 'i' || e.key === 'I') {
        setStart(Math.min(current, end - 0.05));
      } else if (e.key === 'o' || e.key === 'O') {
        setEnd(Math.max(current, start + 0.05));
      } else if (e.key === 'm' || e.key === 'M') {
        if (hasAudio === false) return;
        setVolume((v) => (muted && v === 0 ? 0.8 : v));
        setMuted((m) => !m);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, current, fps, start, end, seek, muted, hasAudio]);

  /* -------------------------------- derived ------------------------------ */

  const out = useMemo(() => {
    if (crop.w <= 0 || crop.h <= 0) return { w: 0, h: 0 };
    if (sizeMode === 'custom') {
      return {
        w: Math.max(16, Math.min(LIMITS.maxWidth, Math.round(customW))),
        h: Math.max(16, Math.min(LIMITS.maxHeight, Math.round(customH))),
      };
    }
    const ar = crop.w / crop.h;
    let w: number;
    let h: number;
    if (ar >= 1) {
      w = longEdge;
      h = Math.round(longEdge / ar);
    } else {
      h = longEdge;
      w = Math.round(longEdge * ar);
    }
    return {
      w: Math.max(16, Math.min(LIMITS.maxWidth, w)),
      h: Math.max(16, Math.min(LIMITS.maxHeight, h)),
    };
  }, [crop, sizeMode, longEdge, customW, customH]);

  const options: EncodeOptions = useMemo(
    () => ({
      start,
      end,
      crop,
      outWidth: out.w,
      outHeight: out.h,
      fps,
      speed,
      colors,
      dither,
      bayerScale,
      loop,
      direction,
      sharpen,
    }),
    [start, end, crop, out, fps, speed, colors, dither, bayerScale, loop, direction, sharpen],
  );

  const audioOptions: AudioEncodeOptions = useMemo(
    () => ({
      start,
      end,
      bitrate: mp3Bitrate,
      // Direction is deliberately ignored: a boomerang GIF still gets forward
      // audio, which is what people actually want out of a sound clip.
      speed: matchSpeed ? speed : 1,
      fade: audioFade,
      normalize: audioNormalize,
    }),
    [start, end, mp3Bitrate, matchSpeed, speed, audioFade, audioNormalize],
  );

  const audioSeconds = audioDuration(audioOptions);
  const audioStale = Boolean(
    audioResult &&
      (audioResult.options.start !== start ||
        audioResult.options.end !== end ||
        audioResult.options.bitrate !== mp3Bitrate ||
        audioResult.options.speed !== audioOptions.speed ||
        audioResult.options.fade !== audioFade ||
        audioResult.options.normalize !== audioNormalize),
  );

  const plannedFrames = estimateFrames(options);
  const framesOk = plannedFrames <= LIMITS.maxFrames;
  const dimsOk = out.w <= LIMITS.maxWidth && out.h <= LIMITS.maxHeight;
  const trimSeconds = Math.max(0, end - start);

  const sizeOk = result ? result.bytes <= LIMITS.maxBytes : null;
  const allOk = framesOk && dimsOk && sizeOk === true;

  /* --------------------------------- encode ------------------------------ */

  async function runEncode(autoFit: boolean) {
    if (!srcBytes) return;
    setEncoding(true);
    setEncPct(0);
    setEncStep(autoFit ? 'Preparing…' : 'Encoding…');
    setError('');
    try {
      const res = autoFit
        ? await encodeToFit(srcBytes, options, (_, msg) => setEncStep(msg), setEncPct)
        : await encodeGif(srcBytes, options, setEncPct);

      setResult(res);
      setResultUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(new Blob([res.data as unknown as BlobPart], { type: 'image/gif' }));
      });

      // Reflect any back-off the optimizer applied.
      if (autoFit) {
        setFps(res.options.fps);
        setColors(res.options.colors);
        if (res.options.outWidth !== out.w || res.options.outHeight !== out.h) {
          setSizeMode('custom');
          setCustomW(res.options.outWidth);
          setCustomH(res.options.outHeight);
        }
      }
      setEncStep('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setEncoding(false);
    }
  }

  async function runAudioEncode() {
    if (!srcBytes) return;
    setAudioEncoding(true);
    setAudioPct(0);
    setAudioError('');
    try {
      const res = await encodeMp3(srcBytes, audioOptions, setAudioPct);
      setAudioResult(res);
      setAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(new Blob([res.data as unknown as BlobPart], { type: 'audio/mpeg' }));
      });
      // The probe can only speak for MP4 containers; a successful export is
      // proof enough for everything else.
      setHasAudio(true);
    } catch (err) {
      setAudioError((err as Error).message);
    } finally {
      setAudioEncoding(false);
    }
  }

  function baseName() {
    return (emoteName || clip?.slug || 'emote').replace(/[^A-Za-z0-9_-]/g, '') || 'emote';
  }

  function saveAs(url: string, filename: string) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function download() {
    if (!resultUrl || !result) return;
    saveAs(resultUrl, `${baseName()}_${result.width}x${result.height}.gif`);
  }

  function downloadAudio() {
    if (!audioUrl || !audioResult) return;
    saveAs(audioUrl, `${baseName()}_${audioResult.seconds.toFixed(1)}s.mp3`);
  }

  /* --------------------------------- render ------------------------------ */

  if (phase === 'idle' || phase === 'error' || (!srcUrl && phase !== 'downloading' && phase !== 'resolving')) {
    return (
      <div style={{ maxWidth: 620, margin: '40px auto' }}>
        <div className="card">
          <div className="card-head">
            <h2>Load a clip</h2>
          </div>
          <div className="stack">
            <label className="field">
              Twitch clip link or slug
              <input
                type="text"
                placeholder="https://clips.twitch.tv/…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && input.trim() && loadClip(input)}
              />
            </label>
            <button className="btn primary" disabled={!input.trim()} onClick={() => loadClip(input)}>
              Load clip
            </button>
            <div className="divider" />
            <label className="field">
              …or use a local video / GIF
              <input
                type="file"
                accept="video/*,image/gif"
                onChange={(e) => e.target.files?.[0] && loadLocalFile(e.target.files[0])}
                style={{ padding: 8 }}
              />
            </label>
            {error && <div className="notice error">{error}</div>}
            {engineMsg && (
              <div className="row small faint">
                <span className="spinner" /> {engineMsg}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'resolving' || phase === 'downloading') {
    return (
      <div style={{ maxWidth: 620, margin: '60px auto' }} className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="spinner" />
          <strong>{phase === 'resolving' ? 'Looking up clip…' : 'Downloading clip…'}</strong>
        </div>
        <div className="meter">
          <div style={{ width: `${phase === 'resolving' ? 15 : dlPct}%` }} />
        </div>
        <p className="small faint" style={{ marginBottom: 0 }}>
          The clip goes straight from Twitch to your browser. Nothing is uploaded to this server.
        </p>
      </div>
    );
  }

  return (
    <div className="grid-2">
      <main className="stage">
        <div className="row row-wrap" style={{ gap: 8 }}>
          <strong style={{ fontSize: '0.95rem' }}>{clip?.title ?? 'Local file'}</strong>
          {clip && <span className="small faint">{clip.broadcaster}</span>}
          <span className="spacer" style={{ flex: 1 }} />
          {clip && clip.qualities.length > 1 && (
            <div className="seg">
              {clip.qualities.map((q) => (
                <button key={q.quality} aria-pressed={quality === q.quality} onClick={() => switchQuality(q.quality)}>
                  {q.quality}p
                </button>
              ))}
            </div>
          )}
        </div>

        <CropStage
          videoRef={videoRef}
          src={srcUrl}
          naturalWidth={nat.w}
          naturalHeight={nat.h}
          crop={crop}
          aspect={aspect}
          muted={muted || hasAudio === false}
          volume={volume}
          onCrop={setCrop}
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
        />

        <AudioBar
          muted={muted}
          volume={volume}
          hasAudio={hasAudio}
          onMuted={setMuted}
          onVolume={setVolume}
        />

        <Timeline
          duration={duration}
          start={start}
          end={end}
          current={current}
          onRange={(s, e) => {
            setStart(s);
            setEnd(e);
          }}
          onSeek={seek}
        />

        <div className="row row-wrap" style={{ gap: 8 }}>
          <button className="btn" onClick={togglePlay} style={{ width: 78 }}>
            {playing ? '❚❚ Pause' : '▶ Play'}
          </button>
          <button className="btn sm" onClick={() => setStart(Math.min(current, end - 0.05))} title="Set in point (I)">
            Set in
          </button>
          <button className="btn sm" onClick={() => setEnd(Math.max(current, start + 0.05))} title="Set out point (O)">
            Set out
          </button>
          <span className="mono faint" style={{ marginLeft: 6 }}>
            {formatTime(current)} / {formatTime(duration)}
          </span>

          <span className="spacer" style={{ flex: 1 }} />
          <span className="mono" style={{ color: 'var(--accent-hot)' }}>
            {trimSeconds.toFixed(2)}s selected
          </span>
        </div>

        <div className="two">
          <label className="field">
            In point (s)
            <input
              type="number"
              step={0.01}
              min={0}
              max={Math.max(0, end - 0.05)}
              value={start.toFixed(2)}
              onChange={(e) => setStart(Math.max(0, Math.min(Number(e.target.value), end - 0.05)))}
            />
          </label>
          <label className="field">
            Out point (s)
            <input
              type="number"
              step={0.01}
              min={start + 0.05}
              max={duration}
              value={end.toFixed(2)}
              onChange={(e) => setEnd(Math.min(duration, Math.max(Number(e.target.value), start + 0.05)))}
            />
          </label>
        </div>

        <p className="small faint" style={{ margin: 0 }}>
          <span className="kbd">Space</span> play · <span className="kbd">←</span>/<span className="kbd">→</span> step a
          frame · <span className="kbd">Shift</span>+arrows one second · <span className="kbd">I</span>/
          <span className="kbd">O</span> set in / out · <span className="kbd">M</span> mute
        </p>
      </main>

      <aside>
        {/* ------------------------------ export --------------------------- */}
        <div className="card">
          <div className="card-head">
            <h3>Export</h3>
            <span className="spacer" />
            {!engineReady && <span className="spinner" />}
          </div>

          <div className="checks" style={{ marginBottom: 14 }}>
            <div className={`check ${dimsOk ? 'ok' : 'bad'}`}>
              <span className="dot" />
              <span className="label">Resolution</span>
              <span className="value">
                {out.w}×{out.h}
              </span>
            </div>
            <div className={`check ${framesOk ? 'ok' : 'bad'}`}>
              <span className="dot" />
              <span className="label">Frames</span>
              <span className="value">
                {plannedFrames} / {LIMITS.maxFrames}
              </span>
            </div>
            <div className={`check ${sizeOk === null ? '' : sizeOk ? 'ok' : 'bad'}`}>
              <span className="dot" />
              <span className="label">File size</span>
              <span className="value">{result ? `${formatBytes(result.bytes)} / ${MAX_MB} MB` : '— encode to see'}</span>
            </div>
          </div>

          {result && (
            <div className={`meter ${sizeOk ? 'ok' : 'bad'}`} style={{ marginBottom: 14 }}>
              <div style={{ width: `${Math.min(100, (result.bytes / LIMITS.maxBytes) * 100)}%` }} />
            </div>
          )}

          {!framesOk && (
            <div className="notice error" style={{ marginBottom: 12 }}>
              {plannedFrames} frames exceeds the {LIMITS.maxFrames}-frame cap. Shorten the clip, lower the frame rate, or
              raise the speed.
            </div>
          )}

          {encoding ? (
            <>
              <div className="row small muted" style={{ marginBottom: 8 }}>
                <span className="spinner" />
                {encStep || 'Encoding…'} {encPct}%
              </div>
              <div className="meter">
                <div style={{ width: `${encPct}%` }} />
              </div>
            </>
          ) : (
            <div className="stack">
              <button
                className="btn primary block"
                disabled={!engineReady || !framesOk || audioEncoding}
                onClick={() => runEncode(false)}
              >
                {engineReady ? 'Encode GIF' : 'Loading encoder…'}
              </button>
              <button
                className="btn block"
                disabled={!engineReady || !framesOk || audioEncoding}
                onClick={() => runEncode(true)}
                title="Encodes repeatedly, backing off palette then frame rate then size until it fits"
              >
                Auto-fit under {MAX_MB} MB
              </button>
            </div>
          )}

          {error && (
            <div className="notice error" style={{ marginTop: 12 }}>
              {error}
            </div>
          )}

          {result && (
            <>
              <div className="divider" style={{ margin: '14px 0' }} />
              <div className="result-preview">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={resultUrl} alt="Encoded GIF preview" />
              </div>
              <div className="row small muted" style={{ marginTop: 10 }}>
                <span className="mono">
                  {result.width}×{result.height} · {result.frames} frames · {formatBytes(result.bytes)}
                </span>
              </div>
              <div className={`notice ${allOk ? 'ok' : 'warn'}`} style={{ marginTop: 10 }}>
                {allOk ? 'Fits every 7TV limit. Ready to upload.' : 'Over one or more 7TV limits — try Auto-fit.'}
              </div>
              <div className="two" style={{ marginTop: 10 }}>
                <input
                  type="text"
                  placeholder="emote name"
                  value={emoteName}
                  onChange={(e) => setEmoteName(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))}
                />
                <button className="btn primary" onClick={download}>
                  Download
                </button>
              </div>
            </>
          )}
        </div>

        {/* ------------------------------- audio --------------------------- */}
        <div className="card">
          <div className="card-head">
            <h3>Audio</h3>
            <span className="spacer" />
            <span className="mono faint">{audioSeconds.toFixed(2)}s</span>
          </div>

          {hasAudio === false ? (
            <div className="notice small">
              This clip has no audio track, so there's nothing to extract. Twitch clips captured from a silent source
              (or some re-uploads) come through video-only.
            </div>
          ) : (
            <div className="stack">
              <p className="small faint" style={{ margin: 0 }}>
                Extracts the same in/out selection as the GIF, straight from the source in your browser.
              </p>

              <label className="field">
                Bitrate
                <div className="seg" style={{ alignSelf: 'flex-start', flexWrap: 'wrap' }}>
                  {MP3_BITRATES.map((b) => (
                    <button key={b} aria-pressed={mp3Bitrate === b} onClick={() => setMp3Bitrate(b)}>
                      {b}k
                    </button>
                  ))}
                </div>
              </label>

              <div className="row row-wrap" style={{ gap: 16 }}>
                <label className="row small" style={{ gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={matchSpeed}
                    onChange={(e) => setMatchSpeed(e.target.checked)}
                    style={{ width: 'auto' }}
                  />
                  Match GIF speed
                </label>
                <label className="row small" style={{ gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={audioFade}
                    onChange={(e) => setAudioFade(e.target.checked)}
                    style={{ width: 'auto' }}
                  />
                  Fade edges
                </label>
                <label className="row small" style={{ gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={audioNormalize}
                    onChange={(e) => setAudioNormalize(e.target.checked)}
                    style={{ width: 'auto' }}
                  />
                  Normalize loudness
                </label>
              </div>

              {matchSpeed && speed !== 1 && (
                <div className="notice small">
                  Audio is pitch-corrected to {speed.toFixed(2)}× via <span className="mono">atempo</span>. Direction is
                  never applied — a boomerang GIF still gets forward audio.
                </div>
              )}

              {audioEncoding ? (
                <>
                  <div className="row small muted">
                    <span className="spinner" /> Extracting audio… {audioPct}%
                  </div>
                  <div className="meter">
                    <div style={{ width: `${audioPct}%` }} />
                  </div>
                </>
              ) : (
                <button
                  className="btn block"
                  disabled={!engineReady || audioSeconds <= 0 || encoding}
                  onClick={runAudioEncode}
                >
                  {engineReady ? (audioResult ? 'Re-extract MP3' : 'Extract MP3') : 'Loading encoder…'}
                </button>
              )}

              {audioError && <div className="notice error small">{audioError}</div>}

              {audioResult && (
                <>
                  <div className="divider" />
                  <audio className="audio-preview" src={audioUrl} controls preload="metadata" />
                  <div className="row small muted">
                    <span className="mono">
                      {audioResult.seconds.toFixed(2)}s · {audioResult.options.bitrate} kbps ·{' '}
                      {formatBytes(audioResult.bytes)}
                    </span>
                  </div>
                  {audioStale && (
                    <div className="notice warn small">
                      Settings changed since this was extracted. Re-extract to pick them up.
                    </div>
                  )}
                  <button className="btn primary block" onClick={downloadAudio}>
                    Download MP3
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* ------------------------------- crop ---------------------------- */}
        <div className="card">
          <div className="card-head">
            <h3>Crop</h3>
            <span className="spacer" />
            <button
              className="btn sm ghost"
              onClick={() => {
                const side = aspect === 1 ? Math.min(nat.w, nat.h) : 0;
                if (aspect === 1 && side) {
                  setCrop({ x: Math.round((nat.w - side) / 2), y: Math.round((nat.h - side) / 2), w: side, h: side });
                } else {
                  setCrop({ x: 0, y: 0, w: nat.w, h: nat.h });
                }
              }}
            >
              Reset
            </button>
          </div>
          <div className="stack">
            <div className="seg" style={{ alignSelf: 'flex-start', flexWrap: 'wrap' }}>
              {ASPECTS.map((a) => (
                <button
                  key={a.label}
                  aria-pressed={aspect === a.value}
                  onClick={() => {
                    setAspect(a.value);
                    if (a.value) {
                      // Snap the existing box to the new ratio, keeping its centre.
                      const cx = crop.x + crop.w / 2;
                      const cy = crop.y + crop.h / 2;
                      let w = crop.w;
                      let h = w / a.value;
                      if (h > nat.h) {
                        h = nat.h;
                        w = h * a.value;
                      }
                      if (w > nat.w) {
                        w = nat.w;
                        h = w / a.value;
                      }
                      setCrop({
                        x: Math.round(Math.max(0, Math.min(cx - w / 2, nat.w - w))),
                        y: Math.round(Math.max(0, Math.min(cy - h / 2, nat.h - h))),
                        w: Math.round(w),
                        h: Math.round(h),
                      });
                    }
                  }}
                >
                  {a.label}
                </button>
              ))}
            </div>
            <div className="two">
              <label className="field">
                X
                <input
                  type="number"
                  value={crop.x}
                  onChange={(e) => setCrop({ ...crop, x: clampInt(e.target.value, 0, nat.w - crop.w) })}
                />
              </label>
              <label className="field">
                Y
                <input
                  type="number"
                  value={crop.y}
                  onChange={(e) => setCrop({ ...crop, y: clampInt(e.target.value, 0, nat.h - crop.h) })}
                />
              </label>
              <label className="field">
                Width
                <input
                  type="number"
                  value={crop.w}
                  onChange={(e) => setCrop({ ...crop, w: clampInt(e.target.value, 16, nat.w - crop.x) })}
                />
              </label>
              <label className="field">
                Height
                <input
                  type="number"
                  value={crop.h}
                  onChange={(e) => setCrop({ ...crop, h: clampInt(e.target.value, 16, nat.h - crop.y) })}
                />
              </label>
            </div>
            <p className="small faint" style={{ margin: 0 }}>
              Source is {nat.w}×{nat.h}. Drag the box or its handles on the video.
            </p>
          </div>
        </div>

        {/* ------------------------------ output --------------------------- */}
        <div className="card">
          <div className="card-head">
            <h3>Output size</h3>
          </div>
          <div className="stack">
            <div className="seg" style={{ alignSelf: 'flex-start', flexWrap: 'wrap' }}>
              {[128, 256, 384, 512, 1000].map((s) => (
                <button
                  key={s}
                  aria-pressed={sizeMode === 'auto' && longEdge === s}
                  onClick={() => {
                    setSizeMode('auto');
                    setLongEdge(s);
                  }}
                >
                  {s}
                </button>
              ))}
              <button aria-pressed={sizeMode === 'custom'} onClick={() => setSizeMode('custom')}>
                Custom
              </button>
            </div>
            {sizeMode === 'custom' ? (
              <div className="two">
                <label className="field">
                  Width
                  <input
                    type="number"
                    value={customW}
                    onChange={(e) => setCustomW(clampInt(e.target.value, 16, LIMITS.maxWidth))}
                  />
                </label>
                <label className="field">
                  Height
                  <input
                    type="number"
                    value={customH}
                    onChange={(e) => setCustomH(clampInt(e.target.value, 16, LIMITS.maxHeight))}
                  />
                </label>
              </div>
            ) : (
              <p className="small faint" style={{ margin: 0 }}>
                Long edge {longEdge}px, aspect taken from the crop. 7TV downscales to 128px for chat, so 256–512 is
                usually plenty and saves a lot of bytes.
              </p>
            )}
          </div>
        </div>

        {/* ----------------------------- encoding -------------------------- */}
        <div className="card">
          <div className="card-head">
            <h3>Quality &amp; motion</h3>
          </div>
          <div className="stack">
            <label className="field">
              Frame rate — <span className="mono">{fps} fps</span>
              <input type="range" min={5} max={50} step={1} value={fps} onChange={(e) => setFps(Number(e.target.value))} />
            </label>

            <label className="field">
              Palette colors — <span className="mono">{colors}</span>
              <input
                type="range"
                min={8}
                max={256}
                step={8}
                value={colors}
                onChange={(e) => setColors(Number(e.target.value))}
              />
            </label>

            <label className="field">
              Speed — <span className="mono">{speed.toFixed(2)}×</span>
              <input
                type="range"
                min={0.25}
                max={4}
                step={0.05}
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
              />
            </label>

            <label className="field">
              Dithering
              <select value={dither} onChange={(e) => setDither(e.target.value)}>
                {DITHERS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>

            {dither === 'bayer' && (
              <label className="field">
                Bayer scale — <span className="mono">{bayerScale}</span>
                <input
                  type="range"
                  min={0}
                  max={5}
                  step={1}
                  value={bayerScale}
                  onChange={(e) => setBayerScale(Number(e.target.value))}
                />
              </label>
            )}

            <label className="field">
              Direction
              <div className="seg" style={{ alignSelf: 'flex-start' }}>
                {(['forward', 'reverse', 'boomerang'] as const).map((d) => (
                  <button key={d} aria-pressed={direction === d} onClick={() => setDirection(d)}>
                    {d[0].toUpperCase() + d.slice(1)}
                  </button>
                ))}
              </div>
            </label>

            <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
              <label className="row small" style={{ gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={sharpen}
                  onChange={(e) => setSharpen(e.target.checked)}
                  style={{ width: 'auto' }}
                />
                Sharpen after downscale
              </label>
              <label className="row small" style={{ gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={loop === 0}
                  onChange={(e) => setLoop(e.target.checked ? 0 : 1)}
                  style={{ width: 'auto' }}
                />
                Loop forever
              </label>
            </div>

            {direction !== 'forward' && trimSeconds > 6 && (
              <div className="notice warn small">
                Reverse and boomerang buffer every frame in memory. Keep the selection short or the encoder may run out
                of memory.
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

function clampInt(value: string, lo: number, hi: number) {
  const n = Math.round(Number(value));
  if (!isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
