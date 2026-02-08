/**
 * Browser entry point for the thin rendering client.
 *
 * Creates a canvas, instantiates FrontendClient, and connects to the
 * backend WebSocket server.
 */

import { FrontendClient } from './frontend-client.js';

const WS_URL = `ws://${location.hostname}:7719`;

function start(): void {
  const container = document.querySelector('#app');
  if (!container) {
    console.error('[Frontend] #app container not found');
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  container.appendChild(canvas);

  const client = new FrontendClient(canvas);
  client.connect(WS_URL);

  // Make available for debugging
  (window as unknown as Record<string, unknown>).frontendClient = client;
}

if (document.readyState !== 'loading') {
  start();
} else {
  document.addEventListener('DOMContentLoaded', start);
}
