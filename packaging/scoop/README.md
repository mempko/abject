# packaging/scoop/ - Scoop Manifest

The Scoop manifest template for the headless edition on Windows x64.

## Files

- **abject.json.tmpl**: the 64-bit release zip, its hash, and `extract_dir`
  (the archive's top directory, `abject-<version>-win-x64`), with `abject.exe`
  as the command. `checkver` follows GitHub releases, and `autoupdate` gives
  the URL, hash (`$url.sha256`) and directory patterns for later versions.
  Placeholders: `{{version}}`, `{{license}}`, `{{sha256_win_x64}}`.

## Publishing

Fill it with `scripts/fill-manifests.mjs` (see
[packaging/README.md](../README.md)), then commit
`packaging/out/<version>/abject.json` to a bucket repository as
`bucket/abject.json`. After that the bucket's update tooling can move it to
new releases through `checkver` and `autoupdate`. People update with
`scoop update abject`.

## Related

- [packaging/README.md](../README.md): filling and publishing every manifest
