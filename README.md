# FatGIFs

Paste a Twitch clip, trim and crop it, export a GIF that fits 7TV's limits — and pull the audio out as an MP3 while you're there.

No accounts, no database, no queue. A clip goes in and a GIF comes out in one sitting.

## How it works

1. **Paste** — a Twitch clip link on the home page. A shape check runs client-side, then you land in the editor.
2. **Resolve** — the server calls Twitch's public web GraphQL endpoint (the same one twitch.tv's own player uses, no API key required) and returns signed MP4 URLs for each rendition. Those URLs expire in about a day, so they're always fetched fresh.
3. **Download** — the browser pulls the MP4 **directly from Twitch's CDN**. Twitch sends `access-control-allow-origin: *` on clip assets, so no proxy is needed and no video bandwidth touches this server.
4. **Edit** — trim, crop, and quality settings are just numbers in React state. Nothing is applied until you export.
5. **Encode** — `ffmpeg.wasm` runs a two-pass `palettegen`/`paletteuse` graph in your browser and hands back GIF bytes. The same source buffer feeds the MP3 path, so audio costs no extra download.

## 7TV limits

Defined once in `lib/limits.ts`:

| Limit | Value |
| --- | --- |
| File size | 7 MB |
| Resolution | 1000 × 1000 |
| Frames | 1000 |

Frame count is read back out of the encoded GIF by parsing its image descriptor blocks, so the check reflects the real file rather than `duration × fps`.

## Editor features

- Frame-accurate trim with draggable in/out handles, playhead scrubbing, and a looped preview of only the selection
- Drag-and-resize crop overlay with free / 1:1 / 4:3 / 3:4 / 16:9 locks, plus numeric X/Y/W/H
- Output size presets (128 / 256 / 384 / 512 / 1000 long edge) or explicit dimensions
- Frame rate, palette size, speed, four dithering modes, optional post-downscale sharpen
- Forward / reverse / boomerang
- Source rendition picker (1080p down to 360p) — lower is faster to download and usually plenty for an emote
- **Auto-fit under 7 MB**: re-encodes down a ladder, backing off palette size first, then frame rate, then resolution, stopping at the first result that fits
- Local file fallback — any video or GIF instead of a Twitch clip
- Keyboard: `Space` play/pause, `←`/`→` step one frame, `Shift`+arrows one second, `I`/`O` set in/out, `M` mute

## Audio

The preview player has sound. It starts **muted** — browsers block unmuted autoplay, and a clip blasting on load is nobody's idea of a good time — so there's a sound bar sat between the video and the timeline, plus `M` to toggle it.

That bar is deliberately loud for a volume widget. It's the only signal that a clip has sound at all, and the MP3 export below only makes sense once you know that, so it fills the stage width, lights up in accent purple when live, and says "No audio track" outright when there's nothing to hear.

The **Audio** card extracts the current in/out selection to MP3 via `libmp3lame`, which the ffmpeg core already ships. Nothing extra is downloaded; the MP3 comes out of the same source buffer the GIF encoder uses.

| Control | Effect |
| --- | --- |
| Bitrate | 96 / 128 / 192 / 256 / 320 kbps, CBR, 44.1 kHz stereo |
| Match GIF speed | Applies the speed slider through `atempo` (pitch-corrected) |
| Fade edges | 20 ms taper on each end so the cut doesn't click |
| Normalize loudness | Single-pass `loudnorm` at −16 LUFS, for clips recorded too quiet or too hot |

Two deliberate choices:

- **Direction is never applied to audio.** A boomerang GIF still gets forward audio, because reversed speech is a novelty and forward sound is what people actually want out of a clip.
- **Speed above 2× or below 0.5×** can't be done in one `atempo` — the filter clamps to that window — so `atempoChain()` emits several whose factors multiply out to the requested rate (4× becomes `atempo=2.0,atempo=2.0`).

Clips with no audio track are detected before you press anything: `probeHasAudio()` walks the MP4 box tree for a `soun` handler and the card explains itself instead of offering a button that would fail. The walk returns `null` rather than `false` for containers it can't read (a local WebM, say), and `null` means "let the user try" — guessing "no audio" there would hide a button that works.

The GIF and MP3 jobs share one single-threaded ffmpeg instance, so both run through `withFFmpegLock()`. Only leaf jobs take the lock; anything composing them — `encodeToFit`, which calls `encodeGif` down a ladder — must not, or it deadlocks against itself.

## Running locally

```bash
npm install
npm run dev
```

No environment variables. Nothing to configure.

## Notes and caveats

- **Twitch resolution is unofficial.** It relies on the client ID the twitch.tv web player ships with. Stable for years and used by most clip downloaders, but it is not a supported API and could break. If clips stop resolving, look here first.
- **Encoding is single-threaded.** The single-threaded ffmpeg core needs no `SharedArrayBuffer`, and therefore no COOP/COEP headers — one less thing to misconfigure. A 2–4 second emote takes a few seconds; a 20 second 1080p source will be slow, so trim before you encode.
- **Reverse and boomerang buffer every frame in memory.** Keep those selections short.
- **`ffmpeg.wasm` transfers buffers rather than copying them.** `writeFile` puts the source `ArrayBuffer` in the worker's transfer list, which detaches it on the main thread. `encodeGif` always hands over a throwaway copy — remove that and the second encode of any session dies with "An ArrayBuffer is detached and could not be cloned."
- The first export fetches ~32 MB of ffmpeg core from unpkg. It's warmed in the background when the editor opens and cached by the browser afterwards.

## Layout

```
app/
  page.tsx                landing: paste a link, go to the editor
  edit/page.tsx           editor route
  api/resolve/route.ts    clip slug -> signed MP4 renditions (the only server route)
components/
  Editor.tsx              editor shell and all controls
  CropStage.tsx           video + draggable crop overlay
  Timeline.tsx            trim range and playhead
  AudioBar.tsx            preview mute / volume strip
lib/
  twitch.ts               GraphQL clip resolution
  ffmpeg.ts               core loader, job lock, GIF pipeline, auto-fit ladder, frame counter
  audio.ts                MP3 extraction, atempo chaining, MP4 audio-track probe
  limits.ts               7TV constraints
```
