# packaging/ - Package-manager manifests for the `abject` command

Templates for installing the headless edition through package managers. Each
release's archives (`abject-<version>-<os>-<arch>.tar.gz|zip`, built by
`scripts/package-headless.mjs` in CI) come with `.sha256` files; fill the
templates from them:

```bash
gh release download v0.16.0 --pattern '*.sha256' --dir /tmp/sums
node scripts/fill-manifests.mjs 0.16.0 /tmp/sums     # -> packaging/out/0.16.0/
```

| Manager  | Template | Where the filled file goes |
|----------|----------|----------------------------|
| Homebrew | `homebrew/abject.rb.tmpl` | a tap repo, `mempko/homebrew-abject`, as `Formula/abject.rb` (`brew install mempko/abject/abject`) |
| Scoop    | `scoop/abject.json.tmpl` | a bucket repo, as `bucket/abject.json`; its `autoupdate` keeps it current after that |
| winget   | `winget/*.yaml.tmpl` | a pull request to `microsoft/winget-pkgs`, under `manifests/m/mempko/Abject/CLI/<version>/` |

The one-line installers (`site/public/install.sh`, `install.ps1`, served from
abject.world) and the Docker image (`Dockerfile`, pushed to GHCR by CI) need
no step here.
