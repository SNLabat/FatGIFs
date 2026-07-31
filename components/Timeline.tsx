'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Props = {
  duration: number;
  start: number;
  end: number;
  current: number;
  minSpan?: number;
  onRange: (start: number, end: number) => void;
  onSeek: (t: number) => void;
};

type Drag = 'start' | 'end' | 'scrub' | null;

export default function Timeline({ duration, start, end, current, minSpan = 0.05, onRange, onSeek }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const dragRef = useRef<Drag>(null);
  dragRef.current = drag;

  const pct = (t: number) => (duration > 0 ? Math.max(0, Math.min(1, t / duration)) * 100 : 0);

  const timeAt = useCallback(
    (clientX: number) => {
      const el = ref.current;
      if (!el || duration <= 0) return 0;
      const r = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      return ratio * duration;
    },
    [duration],
  );

  useEffect(() => {
    if (!drag) return;

    const move = (e: PointerEvent) => {
      const t = timeAt(e.clientX);
      const mode = dragRef.current;
      if (mode === 'start') onRange(Math.min(t, end - minSpan), end);
      else if (mode === 'end') onRange(start, Math.max(t, start + minSpan));
      else if (mode === 'scrub') onSeek(t);
    };
    const up = () => setDrag(null);

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [drag, timeAt, onRange, onSeek, start, end, minSpan]);

  const ticks = [];
  if (duration > 0) {
    const step = duration > 60 ? 10 : duration > 20 ? 5 : 1;
    for (let t = step; t < duration; t += step) ticks.push(t);
  }

  return (
    <div
      ref={ref}
      className="timeline"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('.tl-handle')) return;
        onSeek(timeAt(e.clientX));
        setDrag('scrub');
      }}
    >
      <div className="tl-ticks">
        {ticks.map((t) => (
          <span key={t} style={{ left: `${pct(t)}%` }} />
        ))}
      </div>

      <div className="tl-sel" style={{ left: `${pct(start)}%`, width: `${Math.max(0, pct(end) - pct(start))}%` }} />

      <div
        className="tl-handle"
        style={{ left: `calc(${pct(start)}% - 7px)` }}
        onPointerDown={(e) => {
          e.stopPropagation();
          setDrag('start');
        }}
        title="Trim start"
      >
        <i />
      </div>
      <div
        className="tl-handle"
        style={{ left: `calc(${pct(end)}% - 7px)` }}
        onPointerDown={(e) => {
          e.stopPropagation();
          setDrag('end');
        }}
        title="Trim end"
      >
        <i />
      </div>

      <div className="tl-playhead" style={{ left: `${pct(current)}%` }} />
    </div>
  );
}
