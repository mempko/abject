# site/src/lib/ - Build-Time Helpers

Code the components call during the build. It runs in Node while Astro
renders, never in the browser.

## Files

- **releases.ts**: finds the latest release and sorts its files by platform.
  - `latestRelease()`: one lookup per build (the promise is cached). It asks
    the GitHub releases API for `mempko/abject` (with `GH_TOKEN` or
    `GITHUB_TOKEN` as a bearer token when set). If that fails it reads the
    electron-builder manifests (`latest-linux.yml`, `latest-mac.yml`,
    `latest.yml`) from the latest release for the version, date and desktop
    file names and sizes, and adds the headless archive names for that
    version. If both fail it returns no version and no assets, and every link
    falls back to `LATEST_URL`.
  - `platformAssets(info)`: picks each download by file name: Linux
    `.AppImage` and `.deb`, Windows `.exe`, macOS `.dmg` and `.zip` for
    `arm64` and Intel, and the headless archives
    `abject-<version>-<os>-<arch>.tar.gz|zip` for linux-x64, linux-arm64,
    mac-arm64, mac-x64 and win-x64. Desktop builds are named `Abject-...`,
    the headless archives `abject-...`; the macOS zip match excludes the
    headless names.
  - `headlessArchiveNames(version)`: the five headless archive names.
  - `fmtSize(bytes)` (`"237 MB"`) and `fmtDate(iso)` (`"11 Sep 2026"`), both
    `''` for unknown values.
  - Constants: `REPO`, `REPO_URL`, `LATEST_URL`.

Used by `components/Hero.astro`, `components/Downloads.astro`,
`components/WhatsNew.astro` (`fmtDate`) and `pages/install.astro`.

## Gotchas

- The build needs network access to show a version; offline builds succeed
  with generic links.
- The manifest fallback adds the headless archive names for any version
  without checking that the release has them (they ship from 0.16.0 on).
- A renamed release asset stops matching here. The names come from
  `electron-builder.yml` and `scripts/package-headless.mjs`.

## Related

- [../components/README.md](../components/README.md): where the downloads appear
- [../../README.md](../../README.md): release data and the installers
- [../../../packaging/README.md](../../../packaging/README.md): the headless archives
