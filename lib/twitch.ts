/**
 * Resolves a Twitch clip to direct MP4 renditions.
 *
 * Uses Twitch's public web GraphQL endpoint with the client ID the twitch.tv
 * site itself ships. No API registration or secrets required.
 *
 * The returned CDN URLs are signed and expire (roughly 24h), so always resolve
 * fresh at edit time rather than persisting the media URL.
 */

const GQL_ENDPOINT = 'https://gql.twitch.tv/gql';
const WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

export type ClipQuality = {
  quality: string; // "1080", "720", "480", "360"
  frameRate: number;
  url: string;
};

export type ClipInfo = {
  slug: string;
  title: string;
  broadcaster: string;
  creator: string | null;
  game: string | null;
  durationSeconds: number;
  createdAt: string;
  thumbnailUrl: string | null;
  viewCount: number | null;
  qualities: ClipQuality[];
};

/**
 * Accepts any of:
 *   https://clips.twitch.tv/SlugHere
 *   https://www.twitch.tv/channel/clip/SlugHere
 *   https://m.twitch.tv/clip/SlugHere
 *   SlugHere
 */
export function parseClipSlug(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  const bare = /^[A-Za-z0-9_-]+$/;
  if (bare.test(raw) && !raw.includes('.')) return raw;

  let u: URL;
  try {
    u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  if (!/(^|\.)twitch\.tv$/i.test(u.hostname)) return null;

  const parts = u.pathname.split('/').filter(Boolean);
  if (u.hostname.toLowerCase().startsWith('clips.')) {
    // clips.twitch.tv/<slug>  or  clips.twitch.tv/embed?clip=<slug>
    const embed = u.searchParams.get('clip');
    if (embed) return embed;
    return parts[0] ?? null;
  }
  const i = parts.indexOf('clip');
  if (i !== -1 && parts[i + 1]) return parts[i + 1];

  const embed = u.searchParams.get('clip');
  if (embed) return embed;

  return null;
}

const CLIP_QUERY = `
query FatGifs($slug: ID!) {
  clip(slug: $slug) {
    id
    slug
    title
    durationSeconds
    createdAt
    thumbnailURL
    viewCount
    game { displayName }
    broadcaster { displayName }
    curator { displayName }
    videoQualities { frameRate quality sourceURL }
    playbackAccessToken(params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) {
      signature
      value
    }
  }
}`;

export async function resolveClip(slug: string): Promise<ClipInfo> {
  const res = await fetch(GQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Client-ID': WEB_CLIENT_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: CLIP_QUERY, variables: { slug } }),
    cache: 'no-store',
  });

  if (!res.ok) throw new Error(`Twitch responded ${res.status}`);

  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0]?.message || 'Twitch GraphQL error');

  const clip = json?.data?.clip;
  if (!clip) throw new Error('Clip not found. Check the link, or the clip may have been deleted.');

  const token = clip.playbackAccessToken;
  const sig = token?.signature ?? '';
  const value = token?.value ?? '';
  const qs = sig && value ? `?sig=${sig}&token=${encodeURIComponent(value)}` : '';

  const qualities: ClipQuality[] = (clip.videoQualities ?? [])
    .map((q: any) => ({
      quality: String(q.quality),
      frameRate: Math.round(Number(q.frameRate) || 30),
      url: `${q.sourceURL}${qs}`,
    }))
    .sort((a: ClipQuality, b: ClipQuality) => Number(b.quality) - Number(a.quality));

  if (!qualities.length) throw new Error('No downloadable renditions for this clip.');

  return {
    slug: clip.slug,
    title: clip.title ?? 'Untitled clip',
    broadcaster: clip.broadcaster?.displayName ?? 'unknown',
    creator: clip.curator?.displayName ?? null,
    game: clip.game?.displayName ?? null,
    durationSeconds: Number(clip.durationSeconds) || 0,
    createdAt: clip.createdAt ?? '',
    thumbnailUrl: clip.thumbnailURL ?? null,
    viewCount: typeof clip.viewCount === 'number' ? clip.viewCount : null,
    qualities,
  };
}
