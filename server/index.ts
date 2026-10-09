/**
 * Abject backend, desktop edition.
 *
 * The shared bootstrap (boot.ts) plus the display layer (ui-layer.ts): the
 * display server and its browser socket, the window system, and the desktop's
 * windows. The Electron app imports this module (its compiled form) and calls
 * `backendShutdown` at quit; `pnpm awaken` runs it directly. The headless
 * edition is server/headless.ts.
 */

import { runServer } from './boot.js';
import { createDesktopUi } from './ui-layer.js';

export { backendShutdown } from './boot.js';

runServer({
  edition: 'desktop',
  p2pWorkerScript: new URL('../workers/p2p-worker-node.ts', import.meta.url),
  workerScript: new URL('../workers/abject-worker-node.ts', import.meta.url),
  ui: createDesktopUi(),
});
