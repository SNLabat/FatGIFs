import { NextRequest, NextResponse } from 'next/server';
import { parseClipSlug, resolveClip } from '@/lib/twitch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const input = req.nextUrl.searchParams.get('input') ?? '';
  const slug = parseClipSlug(input);

  if (!slug) {
    return NextResponse.json(
      { error: 'Not a Twitch clip link. Try https://clips.twitch.tv/… or twitch.tv/<channel>/clip/…' },
      { status: 400 },
    );
  }

  try {
    const clip = await resolveClip(slug);
    return NextResponse.json(clip, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
