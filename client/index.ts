/**
 * Browser entry point for the thin rendering client.
 *
 * Creates a canvas, instantiates FrontendClient, and connects to the
 * backend WebSocket server.
 */

import { FrontendClient } from './frontend-client.js';
import { startAbyssBg } from './abyss-bg.js';

const T0 = performance.now();
const clog = (msg: string) => console.log(`[CLIENT T+${Math.round(performance.now() - T0)}ms] ${msg}`);

function buildWsUrl(): string {
  // Explicit override takes precedence
  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL as string;
  }
  // Behind HTTPS/nginx: use wss:// on same host via /ws path
  if (location.protocol === 'https:') {
    return `wss://${location.host}/ws`;
  }
  // Local dev: direct connection to backend port — use 127.0.0.1 to avoid
  // IPv6/IPv4 DNS ambiguity with "localhost"
  const wsPort = import.meta.env.VITE_WS_PORT ?? '7719';
  return `ws://127.0.0.1:${wsPort}`;
}

const WS_URL = buildWsUrl();
clog(`Script loaded, WS_URL=${WS_URL}`);

function start(): void {
  const container = document.querySelector('#app');
  if (!container) {
    console.error('[Frontend] #app container not found');
    return;
  }

  // Guard against double initialization (HMR or module re-execution)
  const existing = container.querySelector('canvas');
  if (existing) {
    console.warn('[Frontend] Canvas already exists — skipping re-init');
    return;
  }

  // Start abyss background animation (descending while connecting)
  const abyssBg = document.getElementById('abyss-bg') as HTMLCanvasElement | null;
  const abyssControl = abyssBg ? startAbyssBg(abyssBg) : undefined;

  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  container.appendChild(canvas);

  const client = new FrontendClient(canvas, abyssControl);
  clog('Calling connect()...');
  client.connect(WS_URL);

  // Make available for debugging
  (window as unknown as Record<string, unknown>).frontendClient = client;
}

if (document.readyState !== 'loading') {
  start();
} else {
  document.addEventListener('DOMContentLoaded', start);
}
