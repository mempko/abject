# electron/ - Desktop App Shell

Electron main-process code for the packaged desktop app. The app embeds the
Node backend (built to `dist-server/` by `build-server.mjs`) and the browser
client (`dist-client/`); packaging is configured in `electron-builder.yml`
and driven by the `pnpm incarnate*` scripts.

## Files

- **main.ts**: the Electron main process. Sets `ELECTRON_PACKAGED=1`, points
  `ABJECTS_DATA_DIR` at the platform config dir, configures the bundled
  Playwright browser path, imports the compiled server from
  `dist-server/server/index.js`, and opens the client window. Bundled WASM
  system packages ship as `resources/native` (electron-builder
  `extraResources`) and are ingested at boot.
- **afterPack.cjs**: Linux-only electron-builder hook that wraps the Electron
  binary with a `--no-sandbox` launcher (AppImage cannot host SUID sandbox
  helpers; same technique VS Code uses).
