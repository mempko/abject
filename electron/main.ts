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

// The backend spawns worker threads and a WebSocket server that keep the
// process alive after Electron closes. Force exit after a brief grace period.
app.on('will-quit', () => {
  setTimeout(() => process.exit(0), 500);
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
  // which starts the WebSocket server on WS_PORT.
  await import(path.join(__dirname, '..', 'dist-server', 'server', 'index.js'));

  // Give the server time to fully bootstrap before opening the window.
  setTimeout(() => createWindow(port), 2500);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(port);
    }
  });
});
