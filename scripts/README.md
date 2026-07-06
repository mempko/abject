# scripts/ - Development and Build Scripts

One-off tooling invoked through pnpm scripts. Application code never imports
from here.

## Scripts

- **forge-abject.ts** (`pnpm forge <dir>`): compile, validate, and install a
  WASM abject package. Runs the package's `build` command, checks the module
  against the ABI (exports + version), extracts its self-declared manifest,
  and installs into `$ABJECTS_DATA_DIR/extensions/`. With `--build-only`
  (`pnpm smelt` for the bundled packages in `native/`) it rebuilds in place
  and re-embeds the manifest into the package's `abject.json` instead of
  installing. See `docs/WASM_ABI.md` for the package format.

Root-level build scripts (`build-server.mjs`, `build-electron.mjs`,
`release.mjs`) are part of the Electron packaging pipeline, not this
directory.
