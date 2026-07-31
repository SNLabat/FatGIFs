'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { LIMITS, MAX_MB } from '@/lib/limits';

/**
 * Landing page. Deliberately thin: paste a link, go straight to the editor.
 * There is no queue, no database and no accounts -- a GIF is made and
 * downloaded in one sitting, so there is nothing worth persisting.
 */
export default function HomePage() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [emoteName, setEmoteName] = useState('');
  const [error, setError] = useState('');

  function go(e: React.FormEvent) {
    e.preventDefault();
    const raw = url.trim();
    if (!raw) return;

    // Cheap client-side shape check. Anything subtler (deleted clip, typo in
    // the slug) surfaces in the editor with a real message from Twitch.
    const looksRight = /twitch\.tv/i.test(raw) || /^[A-Za-z0-9_-]{8,}$/.test(raw);
    if (!looksRight) {
      setError('That does not look like a Twitch clip link. Try a clips.twitch.tv/… URL.');
      return;
    }

    const qs = new URLSearchParams({ slug: raw });
    if (emoteName.trim()) qs.set('name', emoteName.trim());
    router.push(`/edit?${qs.toString()}`);
  }

  return (
    <>
      <section className="hero">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/fatgifs.png" alt="" className="hero-mark" width={84} height={84} />
        <h1>
          Turn a Twitch clip into a <span className="brand-accent">7TV emote</span>
        </h1>
        <p>
          Paste a clip, pick your moment, crop it, and export a GIF that already fits every 7TV limit. Encoding happens
          in your browser, so nothing is ever uploaded.
        </p>

        <form onSubmit={go} className="paste">
          <input
            type="text"
            autoFocus
            placeholder="https://clips.twitch.tv/…"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError('');
            }}
            aria-label="Twitch clip link"
          />
          <input
            type="text"
            className="name-input"
            placeholder="emote name"
            value={emoteName}
            onChange={(e) => setEmoteName(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))}
            aria-label="Emote name (optional)"
          />
          <button className="btn primary" disabled={!url.trim()}>
            Make GIF
          </button>
        </form>

        {error && (
          <div className="notice error" style={{ maxWidth: 720, margin: '14px auto 0', textAlign: 'left' }}>
            {error}
          </div>
        )}

        <p className="small faint" style={{ marginTop: 14 }}>
          Working from a file instead? <Link href="/edit">Open the editor</Link> and drop in any video or GIF.
        </p>
      </section>

      <section className="features">
        <article className="feature">
          <h3>Trim &amp; crop</h3>
          <p>
            Frame-accurate in and out points, a draggable crop box with aspect locks, and a looped preview of only the
            part you selected.
          </p>
        </article>
        <article className="feature">
          <h3>Fits every limit</h3>
          <p>
            {MAX_MB} MB, {LIMITS.maxWidth}×{LIMITS.maxHeight}, {LIMITS.maxFrames} frames. Checked against the real
            encoded file, not an estimate. Auto-fit shrinks quality in the order you would notice least.
          </p>
        </article>
        <article className="feature">
          <h3>Nothing leaves your machine</h3>
          <p>
            The clip streams from Twitch straight to your browser and a full copy of FFmpeg does the work locally. No
            uploads, no accounts, no queue.
          </p>
        </article>
      </section>
    </>
  );
}
