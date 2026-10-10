/**
 * Electron main process entry point.
 *
 * Sets environment variables for the packaged context, then imports the
 * compiled server bootstrap (which auto-calls main()). Once the backend
 * WebSocket server is listening, opens a BrowserWindow that loads the
 * client via a local HTTP server (avoids file:// issues with fonts,
 * WebSocket, and localStorage).
 */

import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import * as path from 'node:path';
import * as http from 'node:http';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultDataDir } from '../server/data-dir.js';
import { liveInstance } from '../server/instance-file.js';
import { stopBackend } from '../cli/backend.js';
import { installCliCommand } from './cli-command.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Signal packaged mode so NodeWorkerAdapter loads compiled JS workers
process.env.ELECTRON_PACKAGED = '1';

// A closed stdout must not become a modal error dialog.
//
// Launch the app from a terminal, press Ctrl-C in that terminal, and the pipe
// goes away while the backend is still logging its way through shutdown. Every
// subsequent write raises EPIPE on the stream, and an 'error' event with no
// listener is an uncaught exception, which Electron shows as "A JavaScript
// error occurred in the main process" — one dialog per log line, on top of an
// app that is already trying to quit. Worker stdout is piped through here too,
// so this covers those writes as well.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') return;
    // Anything else is a real problem, but reporting it through the stream that
    // just failed would recurse.
  });
}

// One instance of the app (Electron's lock is per app, not per data directory;
// claimDataDir below and the backend's own instance.json check cover another
// backend on the same data directory).
//
// A second launch used to start a whole second backend against the same SQLite
// files and the same WebSocket port, which does not fail cleanly: the newcomer
// contends for the database and cannot bind its port, so its window opens and
// then sits there looking hung. Handing focus to the window that already exists
// is both what the user meant and the only outcome that leaves the data intact.
const holdsInstanceLock = app.requestSingleInstanceLock();
if (!holdsInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // WebBrowser drives this app's own Chromium rather than a bundled one.
  // Playwright attaches over CDP, on a port Chromium picks and records in
  // DevToolsActivePort in the user data directory (BrowserWindowHost reads it).
  // Only the instance holding the lock opens it: a second launch writing that
  // file on its way out would point WebBrowser at a port nobody listens on.
  app.commandLine.appendSwitch('remote-debugging-port', '0');
  // With a debugger port open, Chromium reports navigator.webdriver = true to
  // every page, which sites read as automation. Playwright's own launches
  // pass the same switch.
  app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
}

// Use the OS-standard data directory unless explicitly overridden: the same
// one the `abject` command uses, so the app and the terminal share workspaces.
if (!process.env.ABJECTS_DATA_DIR) {
  process.env.ABJECTS_DATA_DIR = defaultDataDir();
}

const WS_PORT = parseInt(process.env.WS_PORT ?? '7719', 10);
const CLIENT_PORT = 0; // OS assigns a free port

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

/**
 * Another backend already holding this data directory, before ours starts.
 *
 * The headless edition (`abject` in a terminal, or started at login) keeps
 * running after its terminal closes, so it is often still there when the
 * app opens. Two backends cannot share one data directory, so the person
 * chooses: stop that one and open the app (its agents resume from saved
 * state here), or quit. Returns false when the app should not start.
 */
async function claimDataDir(dataDir: string): Promise<boolean> {
  const other = await liveInstance(dataDir);
  if (!other) return true;
  if (other.edition !== 'headless') {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Abject',
      message: 'Another Abject is using this data',
      detail: `Abject ${other.version} (pid ${other.pid}) is running on ${dataDir}. Close it, then open the app again.`,
    });
    return false;
  }
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'Abject',
    buttons: ['Stop it and open Abject', 'Quit'],
    defaultId: 0,
    cancelId: 1,
    message: 'Abject is already running in the background',
    detail: `The terminal edition (pid ${other.pid}) is using ${dataDir}, and only one Abject can use it at a time. `
      + 'Stopping it pauses what its agents are doing; they pick up again here. '
      + 'The abject command connects to the app while it is open.',
  });
  if (response !== 0) return false;
  await stopBackend(dataDir);
  return !(await liveInstance(dataDir));
}

let mainWindow: BrowserWindow | null = null;
let clientServer: http.Server | null = null;
/** The embedded backend's module namespace, once it has been imported. */
let serverModule: { backendShutdown?: () => Promise<void> } | undefined;

/** Serve dist-client/ over HTTP so the renderer avoids file:// issues. */
function startClientServer(): Promise<number> {
  const clientDir = path.join(__dirname, '..', 'dist-client');

  return new Promise((resolve) => {
    clientServer = http.createServer((req, res) => {
      let urlPath = new URL(req.url ?? '/', `http://localhost`).pathname;
      if (urlPath === '/') urlPath = '/index.html';
      const filePath = path.join(clientDir, urlPath);
      const ext = path.extname(filePath);

      try {
        const data = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    clientServer.listen(CLIENT_PORT, '127.0.0.1', () => {
      const addr = clientServer!.address();
      resolve(typeof addr === 'object' && addr ? addr.port : CLIENT_PORT);
    });
  });
}

function createWindow(port: number): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Abject',
    backgroundColor: '#06070a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Load via HTTP so Google Fonts, WebSocket, and localStorage all work
  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Closing the desktop is quitting, even while WebBrowser still has pages
    // open: those are windows too (offscreen ones included), so waiting for
    // 'window-all-closed' would leave the app running with nothing to show.
    app.quit();
  });
}

app.on('window-all-closed', () => {
  clientServer?.close();
  app.quit();
});

/**
 * Release the embedded backend before Electron tears itself down.
 *
 * Closing the last window sends no signal, so the backend never learned it
 * was over: its WebSocket server and worker pool kept the event loop alive,
 * and the process sat there. The fix for that used to be a hard
 * `process.exit(0)` half a second into `will-quit`, which worked on the
 * symptom and caused a worse one — Node's exit is not Electron's, so the
 * browser process died before it had reaped its own children. A zygote and a
 * network service were left running, holding the AppImage mount open, and the
 * next update failed with "Text file busy" against a window the user had
 * closed days earlier.
 *
 * So: tear the backend down for real, then let Electron do its own shutdown,
 * and force only as a genuine last resort — through `app.exit`, which goes out
 * the way Electron came in and takes its children with it.
 */
/**
 * Kill Electron's own child processes before we do anything that might stop us
 * from doing it later.
 *
 * The process does not always get to exit cleanly: libdatachannel aborts in a
 * global destructor at exit, and a SIGABRT runs no cleanup at all. Anything
 * still alive at that moment is orphaned — a zygote and a network service
 * holding the AppImage mount open, which is how a closed window ends up
 * blocking an update days later.
 *
 * Doing this first, while we are still a healthy process, makes the shutdown
 * path's own failure survivable. The window is already gone by here, and the
 * backend talks over Node's own sockets rather than Chromium's network
 * service, so nothing left to run needs them.
 */
function killChildProcesses(): void {
  try {
    for (const metric of app.getAppMetrics()) {
      if (metric.type === 'Browser') continue; // that is this process
      try {
        process.kill(metric.pid, 'SIGKILL');
      } catch { /* already gone */ }
    }
  } catch (err) {
    console.error('[Abject] could not enumerate child processes:', err);
  }
}

/**
 * Write the sessions of every open window to disk.
 *
 * Pages WebBrowser still has open may hold a login that Chromium has not
 * written yet, and it writes through the very network and storage services
 * that killChildProcesses ends. So they are flushed first, briefly: a flush
 * that hangs must not hold up quitting.
 */
async function flushOpenSessions(): Promise<void> {
  const sessions = new Set(
    BrowserWindow.getAllWindows()
      .filter(w => !w.isDestroyed())
      .map(w => w.webContents.session),
  );
  const flushed = Promise.all([...sessions].map(async (ses) => {
    try {
      ses.flushStorageData();
      await ses.cookies.flushStore();
    } catch { /* best effort */ }
  }));
  await Promise.race([flushed, new Promise<void>(resolve => setTimeout(resolve, 1000))]);
}

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  void flushOpenSessions().finally(releaseAndQuit);
});

function releaseAndQuit(): void {
  killChildProcesses();

  const backend = serverModule?.backendShutdown;
  const released = backend
    ? backend().catch((err: unknown) => {
        console.error('[Abject] backend shutdown failed:', err);
      })
    : Promise.resolve();

  // Long enough for a worker pool to stop, short enough that a wedged teardown
  // does not strand the user with a window that will not close.
  const deadline = new Promise<void>(resolve => setTimeout(resolve, 5000));
  Promise.race([released, deadline]).finally(() => app.quit());
}

app.on('will-quit', () => {
  // Anything spawned since, and a second chance if the metrics call failed
  // the first time.
  killChildProcesses();
  // Whatever is still holding the loop open, leave. Two MessagePorts survive
  // the backend teardown, so this fires on a normal quit rather than only in
  // trouble.
  setTimeout(() => app.exit(0), 1500);
});

app.setName('Abject');

app.whenReady().then(async () => {
  // A second launch is quitting (above); 'ready' can still fire on its way out,
  // and it must not start a backend first.
  if (!holdsInstanceLock) return;

  // Set up application menu
  const menu = Menu.buildFromTemplate([
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Abject Website',
          click: () => shell.openExternal('https://abject.world'),
        },
        // AppUpdater (in the backend, packaged builds only) listens for this
        // event on app; the name is CHECK_FOR_UPDATES_EVENT in app-updater.ts.
        ...(app.isPackaged ? [{
          label: 'Check for Updates…',
          click: () => { app.emit('abjects:check-for-updates'); },
        }, {
          // The app's own copy of the `abject` command (resources/cli).
          label: 'Install the abject Command…',
          click: () => {
            const result = installCliCommand();
            void dialog.showMessageBox({
              type: result.ok ? 'info' : 'warning',
              title: 'abject command',
              message: result.ok ? 'The abject command is ready' : 'The abject command was not installed',
              detail: result.message,
            });
          },
        }] : []),
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);

  if (!(await claimDataDir(process.env.ABJECTS_DATA_DIR!))) {
    app.exit(0);
    return;
  }

  // Start the client HTTP server
  const port = await startClientServer();

  // The window loads the client from this origin, and the backend's UI socket
  // refuses pages of any origin it was not told about. The port is only
  // known now, so it travels in the environment the backend reads at boot.
  process.env.ABJECTS_CLIENT_ORIGIN = `http://127.0.0.1:${port}`;

  // Import the compiled server -- this triggers its top-level main() call,
  // which starts the WebSocket server on WS_PORT. The namespace is kept so
  // shutdown can reach the backend's own teardown at window close.
  serverModule = await import(path.join(__dirname, '..', 'dist-server', 'server', 'index.js'));

  // The backend installs its own SIGINT/SIGTERM handlers, and they end in
  // `process.exit()` — correct when it owns the process, wrong here for the
  // same reason the old window-close path was wrong: Node's exit leaves
  // Electron's child processes running. Route every exit through Electron
  // instead, so a Ctrl-C and a closed window take the same way out.
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  process.on('SIGINT', () => app.quit());
  process.on('SIGTERM', () => app.quit());

  // Give the server time to fully bootstrap before opening the window.
  setTimeout(() => createWindow(port), 2500);

  app.on('activate', () => {
    // Not getAllWindows(): WebBrowser's page windows are not the desktop.
    if (!mainWindow) {
      createWindow(port);
    }
  });
});
