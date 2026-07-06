# site/ - Marketing / Landing Website

The public website for Abject, built with Astro. Self-contained pnpm
workspace (own `package.json` and lockfile), independent of the application
build.

- `astro.config.mjs`: Astro configuration.
- `nginx.conf`: deployment server config (also holds the TURN relay notes
  for the P2P infrastructure; the coturn config lives at
  `turnserver.conf`).
- `abject_demo.webm`: demo video asset (large files are gitignored).

Develop with `pnpm install && pnpm dev` inside this directory; `pnpm build`
outputs the static site to `dist/`.
