# site/src/components/ui/ - Shared UI Kit

The small set of pieces every section draws with: a window card, a
screenshot frame, the section header, and the lightbox. They make the site
look like the Abject desktop (title bands with the eye sigil, ruled frames,
hard print shadows). Their base styles are in `../../styles/global.css`
(`.win`, `.win-bar`, `.shot`, `.section-head`, `.kicker`).

## Files

- **Win.astro**: a window card. Props: `title`, `focus` (red band and red
  shadow; at most one per group, it marks what to look at first), `plain`
  (no window buttons), `class`, `as` (`div`, `article`, `section` or `li`).
  The body is the default slot. Used by `BigIdea`.
- **Shot.astro**: a screenshot or clip in a window frame, from a slot in
  `../../data/shots.ts`. Props: `id` (a `ShotId`), `focus`, `caption`
  (overrides the slot's; `''` hides it), `bare` (no title band), `eager`
  (load immediately, high priority; for the hero), `still` (show the still
  even when the slot has a clip), `class`. A slot with `video` plays muted
  and looped only while on screen and never under reduced motion; a slot with
  no `src` renders a styled placeholder; an unknown id renders a placeholder
  and warns at build time. Clicking opens the image in the lightbox.
- **SectionHead.astro**: the standard section header. Props: `num`, `kicker`,
  `title`, `center`, `live` (the living-light mark, for live things), `as`
  (`h1`, `h2` or `h3`; default `h2`), `id`. The default slot is the lede.
- **Lightbox.astro**: one `<dialog>` per page. A click on any element with a
  `data-full` attribute opens that URL large; a click outside the image or the
  close button shuts it. `Layout.astro` includes it, so pages do not.

## Related

- [../README.md](../README.md): the section components
- [../../data/README.md](../../data/README.md): the shot list
- [../../../SCREENSHOTS.md](../../../SCREENSHOTS.md): making captures
