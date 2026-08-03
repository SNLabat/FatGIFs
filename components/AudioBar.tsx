'use client';

type Props = {
  muted: boolean;
  volume: number; // 0-1
  hasAudio: boolean | null; // null = unknown container, treat as "probably fine"
  onMuted: (m: boolean) => void;
  onVolume: (v: number) => void;
};

/**
 * Preview sound control, sat between the video and the timeline.
 *
 * Deliberately loud for a volume widget: this is the only signal that a clip
 * has sound at all, and the MP3 export downstream only makes sense once you
 * know that. A small icon tucked into the transport row got missed.
 */
export default function AudioBar({ muted, volume, hasAudio, onMuted, onVolume }: Props) {
  const silent = hasAudio === false;
  const off = silent || muted || volume === 0;
  const shown = off ? 0 : volume;
  const pct = Math.round(shown * 100);

  function toggle() {
    if (silent) return;
    // Un-muting a slider that's already at zero should actually make noise.
    if (muted && volume === 0) onVolume(0.8);
    onMuted(!muted);
  }

  return (
    <div className={`audiobar ${off ? 'off' : 'on'} ${silent ? 'silent' : ''}`}>
      <button
        type="button"
        className="audiobar-toggle"
        onClick={toggle}
        disabled={silent}
        aria-pressed={!off}
        aria-label={muted ? 'Unmute preview' : 'Mute preview'}
        title={silent ? 'This clip has no audio track' : muted ? 'Unmute (M)' : 'Mute (M)'}
      >
        <SpeakerIcon level={silent ? 'none' : off ? 'muted' : shown > 0.5 ? 'high' : 'low'} />
      </button>

      <span className="audiobar-label">{silent ? 'No audio track' : 'Sound'}</span>

      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={shown}
        disabled={silent}
        aria-label="Preview volume"
        style={{ ['--fill' as string]: `${pct}%` }}
        onChange={(e) => {
          const v = Number(e.target.value);
          onVolume(v);
          onMuted(v === 0);
        }}
      />

      <span className="audiobar-pct mono">{silent ? '—' : `${pct}%`}</span>
    </div>
  );
}

function SpeakerIcon({ level }: { level: 'none' | 'muted' | 'low' | 'high' }) {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5 6 9H3v6h3l5 4V5z" fill="currentColor" stroke="none" />
      {level === 'low' && <path d="M15.5 8.5a5 5 0 0 1 0 7" />}
      {level === 'high' && (
        <>
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M18.5 5.5a9 9 0 0 1 0 13" />
        </>
      )}
      {(level === 'muted' || level === 'none') && (
        <>
          <path d="M16 9.5l5 5" />
          <path d="M21 9.5l-5 5" />
        </>
      )}
    </svg>
  );
}
