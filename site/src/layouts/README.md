# site/src/layouts/ - Page Layout

The one layout every page renders inside.

## Files

- **Layout.astro**: the HTML document. Props: `title`, `description`
  (defaults to the site's pitch) and `ogImage` (defaults to `/og-card.png`).
  It writes:
  - the `<head>`: description, `theme-color`, a canonical URL built from
    `site` in `astro.config.mjs`, the favicons, Google Fonts (Oswald, PT Sans,
    JetBrains Mono), and Open Graph and Twitter card tags with absolute URLs;
  - the `<body>`: the `#sigil-bg` canvas behind everything, the page's slot,
    the shared `Lightbox`, and `../scripts/sigil-bg.js`;
  - the global stylesheet, imported in an `is:global` style block from
    `../styles/global.css`.

Pages use it as
`<Layout title="Install - Abject" description="...">...</Layout>` and add
their own `<Header />` and `<Footer />` inside.

## Gotchas

- The favicon links carry `?v=2` to get past CDN and browser caches, since
  files in `public/` keep their names. Bump it whenever
  `tools/gen-favicons.sh` runs again.
- `title` is the whole `<title>` and social-card title; pages append
  ` - Abject` themselves.

## Related

- [../README.md](../README.md): how pages are put together
- [../styles/README.md](../styles/README.md): the stylesheet it imports
- [../scripts/README.md](../scripts/README.md): the background it starts
- [../../tools/README.md](../../tools/README.md): the favicons and the social card
