# packaging/winget/ - winget Manifests

The Windows Package Manager manifests for the headless edition, package
identifier `mempko.Abject.CLI`, manifest schema 1.6.0. winget takes the three
files together.

## Files

- **mempko.Abject.CLI.yaml.tmpl**: the version manifest (default locale en-US).
- **mempko.Abject.CLI.installer.yaml.tmpl**: the installer manifest. The x64
  release zip as a portable install: the nested `abject.exe` (inside the
  archive's `abject-<version>-win-x64` directory) is exposed as the command
  `abject`. Uses `{{SHA256_WIN_X64}}`, the uppercase form of the hash.
- **mempko.Abject.CLI.locale.en-US.yaml.tmpl**: the default locale: publisher,
  name, license, descriptions, moniker `abject` and tags.

## Publishing

Fill them with `scripts/fill-manifests.mjs` (see
[packaging/README.md](../README.md)), then open a pull request to
`microsoft/winget-pkgs` adding the three filled files under
`manifests/m/mempko/Abject/CLI/<version>/`.

## Related

- [packaging/README.md](../README.md): filling and publishing every manifest
