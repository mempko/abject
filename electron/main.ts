/**
 * Electron main process entry point.
 *
 * Sets environment variables for the packaged context, then imports the
 * compiled server bootstrap (which auto-calls main()). Once the backend
 * WebSocket server is listening, opens a BrowserWindow that loads the
 * client via a local HTTP server (avoids file:// issues with fonts,
 * WebSocket, and localStorage).
 */

import { app, BrowserWindow, Menu, shell } from 'electron';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

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

// One instance per data directory.
//
// A second launch used to start a whole second backend against the same SQLite
// files and the same WebSocket port, which does not fail cleanly: the newcomer
// contends for the database and cannot bind its port, so its window opens and
// then sits there looking hung. Handing focus to the window that already exists
// is both what the user meant and the only outcome that leaves the data intact.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Use OS-standard data directory unless explicitly overridden
if (!process.env.ABJECTS_DATA_DIR) {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    process.env.ABJECTS_DATA_DIR = path.join(home, 'Library', 'Application Support', 'abject');
  } else if (process.platform === 'win32') {
    process.env.ABJECTS_DATA_DIR = path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'abject');
  } else {
    process.env.ABJECTS_DATA_DIR = path.join(home, '.config', 'abject');
  }
}

// Point Playwright at the bundled headless shell (unpacked from asar)
const resourcesDir = path.dirname(app.getAppPath());
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(
  resourcesDir, 'app.asar.unpacked', 'playwright-browsers'
);

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
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Load via HTTP so Google Fonts, WebSocket, and localStorage all work
  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
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

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();

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
});

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
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);

  // Start the client HTTP server
  const port = await startClientServer();

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
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(port);
    }
  });
});
