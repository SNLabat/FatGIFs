import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'FatGIFs — Twitch clips to 7TV emotes',
  description:
    'Paste a Twitch clip, trim and crop it, and export a GIF that fits 7TV limits. Everything encodes in your browser.',
  icons: {
    icon: [{ url: '/fatgifs.png', type: 'image/png' }],
    shortcut: '/fatgifs.png',
    apple: '/fatgifs.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <Link href="/" className="brand">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/fatgifs.png" alt="" className="brand-mark" width={30} height={30} />
              <span>
                Fat<span className="brand-accent">GIFs</span>
              </span>
            </Link>
            <span className="spacer" />
            <nav>
              <Link href="/edit">Open editor</Link>
            </nav>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
