# packaging/homebrew/ - Homebrew Formula

The Homebrew formula template for the headless edition, for macOS and Linux
on arm64 and x64.

## Files

- **abject.rb.tmpl**: class `Abject`. Picks the release archive for the OS and
  CPU (`on_macos`/`on_linux`, `on_arm`/`on_intel`) with its SHA-256, installs
  the whole unpacked directory into `libexec` (the binary finds `lib/` beside
  itself) and links `abject` into `bin`. Its caveats explain that the backend
  keeps running in the background and how to stop, start at login and
  upgrade; its test checks that `abject version` prints the formula's
  version. Placeholders: `{{version}}`, `{{license}}`, `{{sha256_mac_arm64}}`,
  `{{sha256_mac_x64}}`, `{{sha256_linux_arm64}}`, `{{sha256_linux_x64}}`.

## Publishing

Fill it with `scripts/fill-manifests.mjs` (see
[packaging/README.md](../README.md)), then commit
`packaging/out/<version>/abject.rb` to the tap repository
`mempko/homebrew-abject` as `Formula/abject.rb`. People install with
`brew install mempko/abject/abject` and update with `brew upgrade abject`.

## Related

- [packaging/README.md](../README.md): filling and publishing every manifest
