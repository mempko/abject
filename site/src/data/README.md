# site/src/data/ - Site Data

The two lists the site renders from: the release history and every
screenshot and clip. Both are read at build time.

## Files

- **changelog.json**: every release, newest first. Each entry is
  `{ version, date, title, summary, highlights[], fixes[] }`, with `date` as
  `YYYY-MM-DD`. `pnpm release <version>` (`release.mjs` at the repo root)
  drafts the notes and adds the entry at the top, or replaces the top entry
  when it has the same version; the same notes become the release tag's
  annotation. Rendered by `pages/changelog.astro` (grouped by minor version)
  and, when placed, `components/WhatsNew.astro`.
- **shots.ts**: `SHOTS`, every screenshot and clip on the site, keyed by slot
  id, and the `ShotSlot` and `ShotId` types. A slot has:
  - `src`: the still under `public/` (`/gallery/x.webp`); without it the slot
    renders a placeholder;
  - `video`: optional `{ mp4, webm?, poster? }` under `/media/`, played as a
    muted loop;
  - `file`, `title` (the frame's title band), `alt`, `caption`;
  - `aspect`: width over height, so the frame reserves its space before the
    image loads;
  - `retake` and `want`: whether the slot still wants a better capture, and
    what it should show.

  Components place a slot with `<Shot id="..." />` (`components/ui/Shot.astro`).
  The object is checked with `satisfies Record<string, ShotSlot>`, so a slot id
  used in a component that is missing here is a type error in an editor and a
  placeholder with a warning at build time.

## Gotchas

- Not every slot is placed on a page; `../../SCREENSHOTS.md` lists which ones
  are. An unplaced slot costs nothing, but its files in `public/` are still
  published.
- Edit `changelog.json` by hand only to fix an entry; new entries come from
  the release script, which expects the newest entry first.

## Related

- [../../SCREENSHOTS.md](../../SCREENSHOTS.md): capture, encode, add a slot
- [../components/ui/README.md](../components/ui/README.md): `Shot`
- [../../README.md](../../README.md): the site, its build and the changelog
