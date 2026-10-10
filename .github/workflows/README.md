# .github/workflows/ - Release Workflow

GitHub Actions for Abject. There is one workflow, `release.yml`: pushing a
version tag builds every edition on its own platform and publishes a GitHub
Release, plus a container image. Nothing runs on ordinary pushes or pull
requests.

## Architecture

```
  pnpm release <version>  (release.mjs: notes, bump, commit, annotated tag, push)
        |
        v  push of tag v*
  release.yml
    build     (3 runners)  desktop app per OS  -> artifacts release-<platform>
    headless  (5 runners)  headless archives   -> artifacts headless-<target>
    docker    (1 runner)   multi-arch image    -> ghcr.io/<owner>/abject:<version>, :latest
    release   needs build + headless: download all artifacts, gh release create
```

## Jobs

Every build job checks out the tag and installs Node 24 and pnpm 10, then
`pnpm install`.

- **build**: the desktop app on `ubuntu-latest`, `windows-latest` and
  `macos-latest`, with `pnpm incarnate:linux`, `:win` or `:mac` (which also
  builds `dist-cli`, so the app carries the `abject` command). Uploads the
  AppImage and deb, the NSIS installer, the dmg and zip files, the
  `.blockmap` files and `latest*.yml` (the updater needs the last two).
- **headless**: `pnpm incarnate:headless` on five targets: `linux-x64`
  (`ubuntu-latest`), `linux-arm64` (`ubuntu-24.04-arm`), `mac-arm64`
  (`macos-latest`), `mac-x64` (`macos-15-intel`) and `win-x64`
  (`windows-latest`). Installs with `ELECTRON_SKIP_BINARY_DOWNLOAD=1` and
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. Uploads `abject-*.tar.gz` or `.zip`
  and their `.sha256` files.
- **docker**: QEMU and Buildx, a GHCR login with the workflow token, and a
  build of the root `Dockerfile` for `linux/amd64` and `linux/arm64`, pushed as
  `ghcr.io/<owner, lowercased>/abject:<version>` and `:latest`.
- **release**: after `build` and `headless`, downloads every artifact into one
  directory and runs `gh release create` with all of them, titled
  `Abject <tag>`. The body is the tag's annotation (which `release.mjs`
  writes), or GitHub's generated notes when the annotation is 40 bytes or
  less.

Permissions: `contents: write` (the release) and `packages: write` (GHCR).

## Adding a platform or an artifact

- A headless target is a new `include` entry in the `headless` matrix with a
  runner of that OS and architecture (the binary and native modules come from
  the runner), plus the matching archive in `scripts/fill-manifests.mjs` and
  the `packaging/` templates if package managers should get it.
- A new desktop artifact type needs its glob in the `build` job's upload step,
  or it never reaches the release (`if-no-files-found: error` only catches a
  job that uploads nothing).

## Gotchas

- The `release` job does not wait for `docker`; an image push can fail while
  the release still publishes, and the reverse.
- Package-manager manifests are not published here. After a release, fill
  them with `scripts/fill-manifests.mjs` and publish them by hand (see
  `packaging/README.md`).
- The macOS desktop builds are unsigned and the headless macOS binary is
  signed ad hoc only.
- The tag names the release and the image; the app and archive versions come
  from `package.json`. Tag the commit `release.mjs` made, so the two agree.

## Related

- [scripts/README.md](../../scripts/README.md): `package-headless.mjs`, `fill-manifests.mjs`, `release.mjs`
- [electron/README.md](../../electron/README.md): desktop packaging and updates
- [deploy/README.md](../../deploy/README.md): the Docker image
- [packaging/README.md](../../packaging/README.md): package managers
