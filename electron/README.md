# electron/ - Desktop App Shell

Electron main-process code for the packaged desktop app. The app embeds the
desktop edition of the Node backend (compiled to `dist-server/` by
`build-server.mjs`) in its main process, serves the browser client
(`dist-client/`) to its own window over local HTTP, and carries a copy of the
`abject` command (`resources/cli`). Packaging is configured in
`electron-builder.yml` at the repository root and driven by the
`pnpm incarnate*` scripts.

## Architecture

```
  Electron main process (dist-electron/main.js, built from main.ts)
    |
    |-- single-instance lock; a second launch focuses the first window
    |-- ABJECTS_DATA_DIR := OS per-user directory (server/data-dir.ts)
    |-- claimDataDir(): a headless backend already on that directory?
    |       stop it (cli/backend.ts stopBackend) or quit
    |-- client HTTP server on 127.0.0.1:<random>  -> ABJECTS_CLIENT_ORIGIN
    |-- import dist-server/server/index.js  (the desktop backend boots here,
    |       UI WebSocket on WS_PORT, CLI gateway, workers)
    '-- BrowserWindow -> http://127.0.0.1:<random>  (client connects to WS_PORT)

  resources/cli/abject[.cmd]  ->  the app binary as Node (ELECTRON_RUN_AS_NODE=1,
                                  ABJECT_EDITION=desktop) running abject.mjs
```

## Files

- **main.ts**: the main process.
  - Sets `ELECTRON_PACKAGED=1` (compiled workers, no dev-client origin), and
    `ABJECTS_DATA_DIR` to `defaultDataDir()` unless set, the same directory
    the `abject` command uses, so the app and the terminal share workspaces.
  - Swallows `EPIPE` on stdout and stderr, so a closed terminal does not turn
    every log line into an error dialog.
  - Takes the single-instance lock. Only the holder opens a remote debugging
    port (`remote-debugging-port=0`, read back by BrowserWindowHost from
    `DevToolsActivePort`) so WebBrowser can drive the app's own Chromium
    through Playwright, and turns off the `AutomationControlled` blink
    feature.
  - Builds the menu: File, Edit, View, Window, and Help (Abject Website; in a
    packaged app, Check for Updates, which emits `abjects:check-for-updates`
    on `app` for AppUpdater, and Install the abject Command).
  - `claimDataDir()`: when `instance.json` names a live headless backend on
    the data directory, asks whether to stop it and open the app, or quit;
    another desktop backend is an error.
  - Serves `dist-client/` from 127.0.0.1 on a free port, puts that origin in
    `ABJECTS_CLIENT_ORIGIN` (the UI socket refuses other pages), imports the
    compiled server, replaces its SIGINT and SIGTERM handlers with
    `app.quit()`, and opens the window 2.5 s later. Closing the window quits.
  - Quitting: flush the open windows' sessions (at most 1 s), kill Electron's
    own child processes, run the backend's `backendShutdown` (at most 5 s),
    then let Electron quit; `will-quit` kills children again and calls
    `app.exit(0)` after 1.5 s.
- **cli-command.ts**: `installCliCommand()`, behind Help, Install the abject
  Command. Linux: a script in `~/.local/bin/abject` (for an AppImage it
  re-enters the AppImage with `ABJECT_DESKTOP_CLI=1`, since the mount path
  changes on every launch). macOS: a link in `/usr/local/bin`, with an
  administrator prompt when needed. Windows: `resources\cli` added to the
  user's PATH. A command already there that the app did not write (the
  headless edition's) is left alone; it talks to the app too.
- **afterPack.cjs**: the electron-builder hook. On every platform it writes
  the command's launcher beside `resources/cli/abject.mjs` (`abject`, or
  `abject.cmd` on Windows), which runs the app's binary with
  `ELECTRON_RUN_AS_NODE=1` and `ABJECT_EDITION=desktop`. For the Linux package
  formats it also removes `chrome-sandbox`, renames the Electron binary to
  `<name>.bin`, and puts a shell wrapper in its place that passes
  `--no-sandbox` (AppImage cannot host the SUID sandbox helper, and recent
  Ubuntu blocks unprivileged user namespaces; the same technique VS Code
  uses) and that runs the `abject` command instead when `ABJECT_DESKTOP_CLI`
  is set. An unpacked `dir` build keeps the bare binary.

## Packaging

- **`electron-builder.yml`** (repository root): app id `world.abject.app`,
  product name Abject, output in `release/`. Its `files` list names
  `dist-electron`, `dist-server`, `dist-client`, `package.json`, and the
  modules node-datachannel, `@lydell` (node-pty), ws, uuid, ajv and yaml. Extra resources:
  `native/` (each package's `abject.json`, `.wasm` and `.md`), ingested at boot
  from `resources/native`, and `dist-cli/abject.mjs` as `resources/cli/abject.mjs`.
  Workers and native addons are unpacked from asar (worker threads and
  `dlopen` cannot load from inside it). Targets: Linux AppImage and deb,
  Windows NSIS (artifact name without spaces, so the updater can find it),
  macOS dmg and zip for arm64 and x64. The `publish` block (GitHub,
  `mempko/abject`) is what the updater reads.
- **`build-electron.mjs`** (root): bundles `main.ts` to `dist-electron/main.js`
  (ESM; `electron` and `ws` external, `ws` shipping in the app's
  node_modules), which `package.json` names as `main`.
- **Scripts**: `pnpm incarnate` builds everything the app loads
  (`build-electron.mjs`, `pnpm bind`, `pnpm etch`, `pnpm distill`);
  `pnpm incarnate:linux`, `:win`, `:mac` add `electron-builder --publish never`
  for that platform. The release workflow runs them on each OS
  (`.github/workflows/`).
- The app icon is `build/icon.png`, electron-builder's default build-resources
  location.

## Software updates

Packaged builds update themselves (`app.isPackaged`; dev runs, the headless
server and an unpackaged Electron never spawn the updater). `AppUpdater`
(`src/objects/app-updater.ts`, main thread) wraps `electron-updater` and reads
the feed from `resources/app-update.yml`, which electron-builder writes from
the `publish` block in `electron-builder.yml` (GitHub releases). Its UI is the
Updates tab of the Settings window (GlobalSettings shows the tab only when
AppUpdater exists), plus a notification in the active workspace when a new
version is ready (or found, when it will not download by itself). Help, Check
for Updates opens Settings on that tab. Terminals reach it through `/update`
(CliServer's `getUpdateStatus` and `updateAction`).

- **Linux AppImage** downloads in the background and replaces itself, at its
  own path (shortcuts keep working), as soon as the download is verified; the
  new version starts with the next launch or a restart.
- **Windows (NSIS)** downloads in the background; the installer starts when
  the user restarts to update or as the app begins to quit, and installs once
  the app has exited.
- Installs never wait for the end of shutdown, which a native crash or the
  exit watchdog can cut short. A restart relaunches from a detached waiter
  that starts the new version once the old process is gone.
- **Linux .deb** installs only on an explicit restart (dpkg asks for a password).
- **macOS** builds are unsigned, so Squirrel.Mac cannot apply an update: the
  window offers the DMG as a download instead. Once builds are signed, switch
  `detectInstallKind()` in `app-updater.ts` to install in place.

A release must carry `latest*.yml` and the `.blockmap` files next to the
installers (the release workflow uploads them). To try an update end to end
without publishing, build two versions (`-c.extraMetadata.version=X` on the
second), serve the newer one's output directory over HTTP, and start the older
one with `ABJECTS_UPDATE_FEED_URL=http://host:port`. The first check runs a
minute after boot.

## Gotchas

- **The client's WebSocket port is baked in at build time** (`VITE_WS_PORT`,
  default 7719). The backend reads `WS_PORT` at boot, but the bundled client
  does not follow it, so build test copies with another port when a real
  instance is running.
- **One backend per data directory.** The app and a headless backend share
  the default data directory; the app asks before stopping a headless one, and
  refuses to start beside another desktop backend.
- **Exit through Electron.** The backend's own signal handlers end in
  `process.exit()`, which would orphan Electron's zygote and network service
  (holding the AppImage mount and blocking the next update), so `main.ts`
  replaces them and calls `backendShutdown`, which releases without exiting.
- **`ws` is external.** `main.ts` imports `cli/backend.ts` (to stop a
  headless backend), which reaches the CLI gateway with `ws`; it must stay in
  the files list of `electron-builder.yml`.
- **The dev client cannot reach a packaged app's socket.** With
  `ELECTRON_PACKAGED=1` the origin policy drops the Vite client's origin.

## Related

- [server/README.md](../server/README.md): the backend the app embeds
- [cli/README.md](../cli/README.md): the `abject` command and its desktop edition
- [build/README.md](../build/README.md): the app icon
- [.github/workflows/README.md](../.github/workflows/README.md): the release builds
