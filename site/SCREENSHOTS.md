# Screenshots and clips for abject.world

Every image and clip on the site comes from one list, `src/data/shots.ts`,
and is placed with `<Shot id="..." />` (`src/components/ui/Shot.astro`). The
current captures are from a real desktop in the Red Sigil theme (September
2026). A slot marked `retake: true` still wants a better capture; a slot with
no `src` shows a styled placeholder.

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

4. In `src/data/shots.ts`, set the slot's `src` (and `video`), set `aspect` to
   the capture's width over height, update `alt` and `caption` to describe
   what the capture actually shows, and set `retake` to `false`. For a new
   slot, add an entry and place it in a component with `<Shot id="..." />`.
5. For the social card: `node tools/render-og.mjs public/gallery/desktop.webp`
   (see `tools/README.md`).

Files in `public/` keep their names across deploys and are cached; a replaced
capture under the same name can show stale for a while. A new file name
avoids that.

## Slots on the pages

| Slot | Files | Where |
|---|---|---|
| `hero` | `gallery/desktop.webp` | `/` hero (`Hero.astro`); also the social card's screenshot |
| `tour` | `media/desktop-tour.{mp4,webm}`, poster `media/desktop-tour-poster.jpg` | `/` 01 Make (`SayIt.astro`), the live desktop clip |
| `nasaViewer`, `tasksPair`, `wikigraph` | `gallery/nasa-viewer.webp`, `tasks-pair.webp`, `wikigraph.webp` | `/` 01 Make, beside the requests that produced them |
| `scene3d` | `gallery/pong.webp` + `media/pong-loop.*` | `/` 01 Make, "Make it look like anything" |
| `materials` | `gallery/materials.webp` | same strip. Retake: a headless render of the Scene Showcase; a capture from the desktop app would be sharper |
| `expose` | `gallery/expose.webp` + `media/expose-loop.*` | same strip |
| `patterns` | `gallery/knowledge.webp` | `/` 03 Learns (`Learns.astro`) |

## Slots in the list but not placed

Captured and ready for a section that needs them:

| Slot | Files | Notes |
|---|---|---|
| `nasa`, `tasks`, `breakout`, `mapdraw`, `recorder` | `gallery/*.webp` | Full-desktop captures |
| `breakoutSpace`, `mapdrawWindow`, `recorderNews` | `gallery/breakout-space.webp`, `mapdraw-window.webp`, `recorder-news.webp` | Tight crops of the captures above (`nasaViewer` is one too); each slot's `want` gives the crop box |
| `fishtank`, `mapdrawLive`, `mindmap` | `gallery/*.webp` + `media/*-loop.*` | Still plus loop |
| `maps` | `gallery/agents-map.webp` | The Agents window's Map tab |
| `patternMap`, `patternCard`, `patternList` | `gallery/pattern-*.webp` | Parts of the Knowledge window's Patterns tab |
| `chat` | `gallery/chat.webp` | The Chat window mid-goal |
| `phone` | none | Wanted: a phone screenshot in portrait (the desktop view zoomed out, or focus mode on a window) |

## Recording tips

The first screencast looked choppy because only about 3 of every 30 recorded
frames were new (the recorder or the desktop could not keep up). Check a
recording before cutting it: count the frames that differ from the previous
one (any frame-diff tool works). Recording a smaller region, pausing running
goals, and Kooha's MP4 format all help.
