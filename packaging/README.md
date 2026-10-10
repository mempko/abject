# packaging/ - Package-Manager Manifests for the `abject` Command

Templates for installing the headless edition (the `abject` command with its
own backend) through package managers. Each release's archives
(`abject-<version>-<os>-<arch>.tar.gz|zip`, built by
`scripts/package-headless.mjs` in CI) come with `.sha256` files; the templates
are filled from those and published by hand, one manager at a time.

## Architecture

```
  GitHub release v<version>
    abject-<version>-{linux-x64,linux-arm64,mac-arm64,mac-x64}.tar.gz(.sha256)
    abject-<version>-win-x64.zip(.sha256)
        |
        |  gh release download v<version> --pattern '*.sha256' --dir /tmp/sums
        v
  node scripts/fill-manifests.mjs <version> /tmp/sums
        |  every *.tmpl below packaging/ (out/ excluded)
        v
  packaging/out/<version>/   (git-ignored, one flat directory)
    abject.rb   abject.json   mempko.Abject.CLI*.yaml
        |
        +-> Homebrew tap     +-> Scoop bucket     +-> winget-pkgs pull request
```

```bash
gh release download v0.16.0 --pattern '*.sha256' --dir /tmp/sums
node scripts/fill-manifests.mjs 0.16.0 /tmp/sums     # -> packaging/out/0.16.0/
```

## Files

| Manager | Template | Where the filled file goes |
|---------|----------|----------------------------|
| Homebrew | [homebrew/abject.rb.tmpl](homebrew/README.md) | a tap repo, `mempko/homebrew-abject`, as `Formula/abject.rb` (`brew install mempko/abject/abject`) |
| Scoop | [scoop/abject.json.tmpl](scoop/README.md) | a bucket repo, as `bucket/abject.json` |
| winget | [winget/*.yaml.tmpl](winget/README.md) | a pull request to `microsoft/winget-pkgs`, under `manifests/m/mempko/Abject/CLI/<version>/` |

Placeholders, filled by `fill-manifests.mjs`: `{{version}}`, `{{license}}`
(`GPL-3.0-or-later`), `{{sha256_<target>}}` in lowercase hex and
`{{SHA256_<TARGET>}}` in uppercase, for the targets `linux_x64`,
`linux_arm64`, `mac_arm64`, `mac_x64` and `win_x64`. A placeholder with no
value is an error.

## Adding a package manager

1. Put its template in a directory of its own here, named `<file>.tmpl`; the
   filled file is written as `<file>` into `packaging/out/<version>/`.
2. Use only the placeholders above, or add the value to `values` in
   `scripts/fill-manifests.mjs`.
3. Point it at the release asset URLs
   (`https://github.com/mempko/abject/releases/download/v<version>/<archive>`)
   and keep the whole directory together: the binary finds `lib/` beside
   itself.
4. Say where the filled file goes in the table above.

## Gotchas

- `fill-manifests.mjs` needs all five `.sha256` files, even to publish to one
  manager.
- Filled files land in one flat directory under their base names, so two
  templates must not share a file name.
- An install from a package manager updates through that manager; `abject
  update` only moves installs made by the install scripts and says so
  otherwise.
- Nothing in CI publishes these. The release workflow builds the archives and
  the Docker image only.

The one-line installers (`site/public/install.sh` and `install.ps1`, served
from abject.world, which install into `~/.abject` or `%LOCALAPPDATA%\abject`
with a `versions/` and `current` layout) and the Docker image (`Dockerfile`,
pushed to GHCR by CI) need no step here.

## Related

- [homebrew/README.md](homebrew/README.md), [scoop/README.md](scoop/README.md), [winget/README.md](winget/README.md)
- [scripts/README.md](../scripts/README.md): `package-headless.mjs`, `fill-manifests.mjs`
- [cli/README.md](../cli/README.md): the command these install, and `abject update`
- [.github/workflows/README.md](../.github/workflows/README.md): the release that produces the archives
