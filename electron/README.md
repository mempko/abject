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

## Software updates

Packaged builds update themselves (`app.isPackaged`; dev runs, the headless
server and an unpackaged Electron never spawn the updater). `AppUpdater`
(`src/objects/app-updater.ts`, main thread) wraps `electron-updater` and reads
the feed from `resources/app-update.yml`, which electron-builder writes from
the `publish` block in `electron-builder.yml` (GitHub releases). Its UI is the
Updates tab of the Settings window (GlobalSettings shows the tab only when
AppUpdater exists), plus a notification in the active workspace when a new
version is ready (or found, when it will not download by itself). Help →
Check for Updates… opens Settings on that tab.

- **Windows (NSIS)** and **Linux AppImage** download in the background and
  install on restart or quit. The AppImage is replaced at its own path, so
  shortcuts keep working.
- **Linux .deb** installs only on an explicit restart (dpkg asks for a password).
- **macOS** builds are unsigned, so Squirrel.Mac cannot apply an update: the
  window offers the DMG as a download instead. Once builds are signed, switch
  `detectInstallKind()` in `app-updater.ts` to install in place.

A release must carry `latest*.yml` and the `.blockmap` files next to the
installers (the release workflow uploads them). To try an update end to end
without publishing, build two versions (`-c.extraMetadata.version=X` on the
second), serve the newer one's output directory over HTTP, and start the older
one with `ABJECTS_UPDATE_FEED_URL=http://host:port`. The first check runs a
minute after boot. The client's WebSocket port is baked in at build time
(`VITE_WS_PORT`, default 7719), so build test copies with another port when a
real instance is running.
