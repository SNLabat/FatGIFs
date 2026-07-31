'use client';

import { useEffect, useRef, useState } from 'react';

export type Crop = { x: number; y: number; w: number; h: number };

type Props = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  crop: Crop;
  aspect: number | null; // width / height, null = free
  onCrop: (c: Crop) => void;
  onLoadedMetadata: () => void;
  onTimeUpdate: () => void;
};

type Mode = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Mode[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const MIN = 16;

export default function CropStage({
  videoRef,
  src,
  naturalWidth,
  naturalHeight,
  crop,
  aspect,
  onCrop,
  onLoadedMetadata,
  onTimeUpdate,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const drag = useRef<{ mode: Mode; px: number; py: number; start: Crop } | null>(null);

  // Keep the display-to-source scale factor in sync with layout.
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !naturalWidth) return;
    const update = () => setScale(el.clientWidth / naturalWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [naturalWidth]);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || !scale) return;
      e.preventDefault();

      const dx = (e.clientX - d.px) / scale;
      const dy = (e.clientY - d.py) / scale;
      const s = d.start;
      let { x, y, w, h } = s;

      if (d.mode === 'move') {
        x = clamp(s.x + dx, 0, naturalWidth - s.w);
        y = clamp(s.y + dy, 0, naturalHeight - s.h);
      } else {
        const west = d.mode.includes('w');
        const east = d.mode.includes('e');
        const north = d.mode.startsWith('n');
        const south = d.mode.startsWith('s');

        if (east) w = clamp(s.w + dx, MIN, naturalWidth - s.x);
        if (west) {
          const nx = clamp(s.x + dx, 0, s.x + s.w - MIN);
          w = s.w + (s.x - nx);
          x = nx;
        }
        if (south) h = clamp(s.h + dy, MIN, naturalHeight - s.y);
        if (north) {
          const ny = clamp(s.y + dy, 0, s.y + s.h - MIN);
          h = s.h + (s.y - ny);
          y = ny;
        }

        if (aspect) {
          // Drive the locked dimension from whichever edge the pointer moved.
          const horizontalDrag = east || west;
          if (horizontalDrag) {
            let nh = w / aspect;
            if (nh > naturalHeight) {
              nh = naturalHeight;
              w = nh * aspect;
            }
            if (north) y = clamp(s.y + s.h - nh, 0, naturalHeight - nh);
            else y = clamp(y, 0, naturalHeight - nh);
            h = nh;
          } else {
            let nw = h * aspect;
            if (nw > naturalWidth) {
              nw = naturalWidth;
              h = nw / aspect;
            }
            if (west) x = clamp(s.x + s.w - nw, 0, naturalWidth - nw);
            else x = clamp(x, 0, naturalWidth - nw);
            w = nw;
          }
          if (x + w > naturalWidth) w = naturalWidth - x;
          if (y + h > naturalHeight) h = naturalHeight - y;
        }
      }

      onCrop({
        x: Math.round(clamp(x, 0, naturalWidth - MIN)),
        y: Math.round(clamp(y, 0, naturalHeight - MIN)),
        w: Math.round(clamp(w, MIN, naturalWidth - x)),
        h: Math.round(clamp(h, MIN, naturalHeight - y)),
      });
    };

    const up = () => {
      drag.current = null;
    };

    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [scale, aspect, naturalWidth, naturalHeight, onCrop]);

  function begin(mode: Mode, e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { mode, px: e.clientX, py: e.clientY, start: { ...crop } };
  }

  const box = {
    left: crop.x * scale,
    top: crop.y * scale,
    width: crop.w * scale,
    height: crop.h * scale,
  };

  return (
    <div className="viewport" ref={boxRef}>
      <video
        ref={videoRef}
        src={src}
        playsInline
        muted
        preload="auto"
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
      />

      {naturalWidth > 0 && (
        <>
          <div className="crop-shade">
            <div style={{ left: 0, top: 0, right: 0, height: box.top }} />
            <div style={{ left: 0, top: box.top + box.height, right: 0, bottom: 0 }} />
            <div style={{ left: 0, top: box.top, width: box.left, height: box.height }} />
            <div style={{ left: box.left + box.width, top: box.top, right: 0, height: box.height }} />
          </div>

          <div className="crop-box" style={box} onPointerDown={(e) => begin('move', e)}>
            {HANDLES.map((h) => (
              <span key={h} className={`handle ${h}`} onPointerDown={(e) => begin(h, e)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
