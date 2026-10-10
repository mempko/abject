# site/src/scripts/ - Page Scripts

Browser scripts shared by every page. Component-specific scripts live inside
their components; this directory holds the one that belongs to the layout.

## Files

- **sigil-bg.js**: draws the site's background on the `#sigil-bg` canvas
  that `layouts/Layout.astro` puts behind every page: the same composition
  the Abject desktop paints behind its windows (an eclipse disc with a corona
  and a slit pupil, a diagonal bar, a red wedge, a brass square, tendrils, a
  construction grid, print grain, and drifting motes of light), all faint so
  the page stays the subject.
  - The static layers (ground, grid, rules, grain) render once into an
    offscreen canvas, rebuilt on resize.
  - The moving parts redraw at about 8 fps (`FRAME_MS = 125`) and pause while
    the tab is hidden.
  - Under `prefers-reduced-motion` the loop holds still and scrolling redraws
    a single frame.
  - The eclipse sinks slowly as the page scrolls, for a little depth.
  - Plain JavaScript in an IIFE; it does nothing if the canvas is missing.

## Gotchas

- Its palette (`P`) and opacities (`MUTE`) are hard-coded; they mirror the
  tokens in `styles/global.css`, so change both together.
- Keep it cheap: it runs on every page for as long as the page is open.

## Related

- [../layouts/README.md](../layouts/README.md): where the canvas and script are included
- [../styles/README.md](../styles/README.md): the palette it mirrors
