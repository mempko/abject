# site/tools/ - Social Card and Favicon Tools

Scripts run by hand to regenerate the images in `public/` that are made from
other sources: the social card and every copy of the Abject mark. Neither
runs during `pnpm build`; their output is committed.

## Files

- **og-card.html**: the social card (`public/og-card.png`, 1200x630), a Red
  Sigil poster drawn in HTML and CSS. A `?shot=<url>` query puts a screenshot
  in the frame on the right; without one the frame shows drawn windows.
- **render-og.mjs**: renders `og-card.html` to `public/og-card.png` at 2x
  (2400x1260) with Playwright and a local Chrome. Run it from `site/`:

  ```bash
  node tools/render-og.mjs                              # drawn windows
  node tools/render-og.mjs public/gallery/desktop.webp  # a screenshot in the frame
  ```

  It imports Playwright from the repository root's `node_modules` (the app's
  dependency, not the site's), so run `pnpm conjure` at the root first. It
  launches `/usr/bin/google-chrome` unless `CHROME` names another binary.
- **gen-favicons.sh** (`pnpm favicons`): regenerates every copy of the mark
  from `public/favicon.svg`: `public/favicon.ico` (16, 32 and 48 px),
  `public/apple-touch-icon.png` and `apple-touch-icon-precomposed.png`
  (180 px), the thin client's `../client/favicon.svg`, and the desktop app
  icon `../build/icon.png` (512 px, which electron-builder reads). Needs
  `inkscape` and ImageMagick (`magick`).

## Gotchas

- `gen-favicons.sh` writes outside `site/` (`client/` and `build/`), on
  purpose: `favicon.svg` is the single source for the site, the client and
  the app. Review those changes too.
- After regenerating the favicons, bump the `?v=` on the favicon links in
  `src/layouts/Layout.astro`, or caches keep serving the old ones.
- The card loads Google Fonts; render with network access or the type falls
  back.

## Related

- [../README.md](../README.md): the site, `public/` and deployment
- [../SCREENSHOTS.md](../SCREENSHOTS.md): the screenshots the card can frame
- [../src/layouts/README.md](../src/layouts/README.md): where the card and favicons are linked
