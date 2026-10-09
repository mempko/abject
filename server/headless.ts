/**
 * Abject backend, headless edition: everything but the display.
 *
 * No display server, no windows, no browser socket; the terminal gateway is
 * how a person reaches it (`abject`). The health endpoint stays on WS_PORT.
 * Started by `abject` in the background, or in the foreground by
 * `abject serve` (systemd, Docker). `pnpm awaken:headless` runs it from source.
 */

import { runServer } from './boot.js';

export { backendShutdown } from './boot.js';

runServer({
  edition: 'headless',
  p2pWorkerScript: new URL('../workers/p2p-worker-headless.ts', import.meta.url),
  workerScript: new URL('../workers/abject-worker-headless.ts', import.meta.url),
});
