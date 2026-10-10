# site/ - abject.world Website

The public website, abject.world: a static site built with Astro. It is its
own pnpm package (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`),
independent of the application build; nothing in the app imports it. It wears
the app's default theme, Red Sigil.

## Develop and build

```bash
cd site
pnpm install
pnpm dev        # astro dev, with live reload
pnpm build      # static site into dist/ (hashed assets in dist/assets/)
pnpm preview    # serve the built dist/
pnpm favicons   # tools/gen-favicons.sh: regenerate every copy of the mark
```

The build reads release data over the network (`src/lib/releases.ts`): the
GitHub releases API first (set `GH_TOKEN` or `GITHUB_TOKEN` to avoid rate
limits), then the electron-builder `latest*.yml` manifests. With neither, the
site still builds and every download link points at the latest-release page.
So rebuild and redeploy after a release to show its version and file sizes.

## How it is put together

- **src/**: pages, components, the shared layout, data, and the build-time
  release lookup. See [src/README.md](src/README.md) for the page and
  component map.
- **public/**: copied to the site root as is, under the same names.
  - `gallery/`: WebP screenshots, and `media/`: MP4/WebM loops and a poster.
    Every one is referenced from the shot list in `src/data/shots.ts`; see
    [SCREENSHOTS.md](SCREENSHOTS.md).
  - `install.sh` and `install.ps1`: the one-line installers for the `abject`
    command (below).
  - `favicon.svg` (the source of the mark), `favicon.ico`,
    `apple-touch-icon.png`, `apple-touch-icon-precomposed.png`: made from
    `favicon.svg` by `tools/gen-favicons.sh`.
  - `og-card.png`: the social card, rendered by `tools/render-og.mjs`.
  - `robots.txt`: allows everything and names the sitemap that
    `@astrojs/sitemap` writes (`sitemap-index.xml`).
- **tools/**: scripts for the social card and the favicons. See
  [tools/README.md](tools/README.md).

## Pages

| Route | What it is |
|---|---|
| `/` | The landing page: hero, 00 the big idea (every object answers `ask`), 01 make, 02 the team, 03 learning, 04 yours, 05 get it (downloads) |
| `/why` | The long answer: comparisons, the Ask Protocol in brief, sprints, architecture, capabilities, the mesh, lineage |
| `/install` | From download to running: requirements, first launch per platform, picking a model, phone pairing, the command line, data locations, network use, updating, building from source, troubleshooting |
| `/ask-protocol` | The Ask Protocol specification |
| `/theory` | The ideas behind it (messaging, compression, Naur, Alexander, DCI) |
| `/about` | Why it exists and who made it |
| `/changelog` | Every release, from `src/data/changelog.json` |
| `/links` | QR codes for the site, the source and the author |

## Release data

`src/lib/releases.ts` finds the latest release once per build and sorts its
assets by platform:

- desktop builds: Linux `.AppImage` and `.deb`, Windows `.exe`, macOS `.dmg`
  and `.zip` for Apple Silicon and Intel;
- the headless edition's archives, `abject-<version>-<os>-<arch>.tar.gz`
  (`.zip` on Windows) for linux-x64, linux-arm64, mac-arm64, mac-x64 and
  win-x64, built by `scripts/package-headless.mjs` in CI.

The hero's download button, the Downloads block and the install page use it.
The Downloads block shows the command-line card only when the release has
headless archives.

## The changelog

`src/data/changelog.json` is a list of releases, newest first. `pnpm release
<version>` (the repo's `release.mjs`) drafts the entry and adds it at the top,
or replaces the top entry when it is the same version. `/changelog` renders it
and groups entries by minor version.

## The one-line installers

`public/install.sh` (Linux and macOS) and `public/install.ps1` (Windows)
install the headless edition, the `abject` command, without root:

```bash
curl -fsSL https://abject.world/install.sh | sh
irm https://abject.world/install.ps1 | iex       # PowerShell
```

- **install.sh** detects the OS (`linux`, `mac`) and architecture (`x64`,
  `arm64`), asks the GitHub API for the latest tag, downloads
  `abject-<version>-<os>-<arch>.tar.gz` and its `.sha256`, checks the hash,
  and unpacks into `~/.abject/versions/<version>`. It points
  `~/.abject/current` at that version, links `~/.abject/bin/abject` to
  `../current/abject` and `~/.local/bin/abject` to that, and says how to add
  the directory to `PATH` if it is missing. It needs `curl` or `wget`.
  Overrides: `ABJECT_VERSION`, `ABJECT_INSTALL_DIR`, `ABJECT_BIN_DIR`,
  `ABJECT_DOWNLOAD_URL` (a mirror serving `v<version>/<archive>`).
- **install.ps1** downloads `abject-<version>-win-x64.zip` (Windows on ARM
  runs it under emulation), checks the hash, and installs into
  `%LOCALAPPDATA%\abject\versions\<version>` with a `current` junction, a
  `bin\abject.cmd` shim, and `bin` added to the user `PATH`. Overrides:
  `ABJECT_VERSION`, `ABJECT_INSTALL_DIR`.

`abject update` (`cli/update.ts`) relies on this layout: it unpacks a newer
version beside the others and repoints `current`. Changing the layout means
changing both.

## Deployment

- **nginx.conf**: the server blocks for `abject.world` (this site, served from
  `/var/abject.world`; `/assets/` cached for a year, other static files
  revalidated hourly), `max.abject.world` (a dev instance: proxies to the
  Vite client and the backend WebSocket), `client.abject.world` (the static
  thin P2P client), `signal.abject.world` (the signaling server, `pnpm
  whisper`, on :7720), and a catch-all default server that refuses unknown
  hosts. Copying `dist/` to the server is not scripted in this repo.
- **turnserver.conf**: the coturn config for the TURN relay on
  `signal.abject.world`. Its `static-auth-secret` must match `TURN_SECRET` in
  the signaling server's environment.

## Files

- **astro.config.mjs**: site URL `https://abject.world`, the sitemap
  integration, built assets under `assets/`.
- **package.json**, **pnpm-lock.yaml**, **pnpm-workspace.yaml**: the package,
  its lockfile, and the build scripts pnpm may run (esbuild, sharp).
- **tsconfig.json**: extends Astro's strict config.
- **SCREENSHOTS.md**: how captures are made and which shot slots exist.
- **nginx.conf**, **turnserver.conf**: deployment configs (above).
- **abject_demo.webm**: a demo video kept locally; gitignored and not used by
  the pages.
- `dist/`, `node_modules/`, `.astro/`: build output and caches, gitignored.

## Gotchas

- **Everything in `public/` is published** under its own name, and every file
  in `src/pages/` becomes a route, Markdown included. Keep notes and READMEs
  out of both; this README and `src/README.md` document them.
- **`public/` files keep their names across deploys**, so CDNs and browsers
  cache them. The layout links the favicons with `?v=2`; bump it when
  `tools/gen-favicons.sh` runs again. New screenshots are safest under new
  file names.
- **The installers are live once deployed.** They are fetched from
  abject.world by every `curl | sh`, and they expect each release to carry
  the archives and their `.sha256` files.
- `fromManifests()` in `releases.ts` (the fallback when the GitHub API fails)
  adds headless archive links for every version without checking that they
  exist.

## Related

- [src/README.md](src/README.md): pages, components and data
- [SCREENSHOTS.md](SCREENSHOTS.md): captures and the shot list
- [tools/README.md](tools/README.md): social card and favicons
- [../packaging/README.md](../packaging/README.md): package-manager manifests for the `abject` command
- [../deploy/README.md](../deploy/README.md): running the headless server as a service
