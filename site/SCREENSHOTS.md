# Screenshots and clips for abject.world

Every image and clip on the site comes from one list, `src/data/shots.ts`.
The current captures are from a real desktop in the Red Sigil theme
(September 2026). A slot marked `retake: true` still wants a better capture;
a slot with no `src` shows a styled placeholder.

## How to add or replace a capture

1. Capture in the theme you want shown (Red Sigil is the default; a space with
   its own palette shows that palette).
2. Stills: save as WebP (quality about 84) in `public/gallery/`. Crops are
   fine and often better than full desktops for small tiles.
3. Clips: save to `public/media/` as MP4 (H.264, `-movflags +faststart`) and,
   optionally, WebM (VP9), no audio, plus a poster still. Short loops (4 to 6
   seconds) work best for tiles; they play only while on screen and never under
   reduced motion. The commands used for the current clips:

   ```
   ffmpeg -ss START -to END -i in.webm -an -vf "crop=W:H:X:Y,scale=800:-2" \
     -c:v libx264 -crf 25 -preset slow -pix_fmt yuv420p -movflags +faststart out.mp4
   ffmpeg -ss START -to END -i in.webm -an -vf "crop=W:H:X:Y,scale=800:-2" \
     -c:v libvpx-vp9 -b:v 0 -crf 34 -row-mt 1 -pix_fmt yuv420p out.webm
   ```

4. In `src/data/shots.ts`, set the slot's `src` (and `video`), update `alt`
   and `caption` to describe what the capture actually shows, and set `retake`
   to `false`.
5. For the social card: `node tools/render-og.mjs public/gallery/desktop.webp`.

## Slots

| Slot | Files | Where | Status |
|---|---|---|---|
| `hero` | `gallery/desktop.webp` | Home hero, social card | Captured |
| `tour` | `media/desktop-tour.{mp4,webm}` + poster | Home 01 Sightings | Captured (67 s edit of abjectprop2) |
| `nasa`, `tasks`, `breakout`, `mapdraw`, `recorder` | `gallery/*.webp` | Home 01 Sightings | Captured |
| `scene3d` | `gallery/pong.webp` + `media/pong-loop.*` | Home 02 | Captured |
| `expose` | `gallery/expose.webp` + `media/expose-loop.*` | Home 02 | Captured |
| `maps` | `gallery/agents-map.webp` | Home 02 | Captured (still) |
| `fishtank`, `mapdrawLive`, `mindmap` | `gallery/*.webp` + `media/*-loop.*` | Home 01 to 03 | Captured |
| `materials` | `gallery/materials.webp` | Home 02 | Retake: a headless render of the Scene Showcase; a capture from the desktop app would be sharper |
| `wikigraph`, `chat` | `gallery/*.webp` (crops) | Where a section needs them | Captured |
| `phone` | none | Home 02 (text tile for now) | Wanted: a phone screenshot in portrait (the desktop view, or focus mode on a window) |

## Recording tips

The first screencast looked choppy because only about 3 of every 30 recorded
frames were new (the recorder or the desktop could not keep up). Check a
recording before cutting it: count the frames that differ from the previous
one (`scratchpad` scripts used PIL; any frame-diff works). Recording a smaller
region, pausing running goals, and Kooha's MP4 format all help.
