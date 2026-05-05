/**
 * Browser entry point for the thin rendering client.
 *
 * Decides which transport to use:
 *   1. `?pair=…` query param → WebRTC pairing mode (first-time pair).
 *   2. localStorage has a paired desktop AND we're configured for p2p →
 *      WebRTC reconnect mode.
 *   3. `VITE_DEFAULT_MODE=p2p` build (e.g. client.abject.world) with no
 *      paired desktop → render the "Scan QR" splash and wait.
 *   4. Otherwise → WebSocket (current local-dev behaviour).
 */

import { FrontendClient } from './frontend-client.js';
import { startAbyssBg } from './abyss-bg.js';
import { WebSocketClientTransport } from './ws-transport.js';
import { WebRTCClientTransport } from './webrtc-transport.js';
import { getPairingPayloadFromUrl, clearPairingParamFromUrl, type PairingPayload } from './pairing.js';
import { getMostRecentPairedDesktop } from './paired-desktops.js';
import type { ClientTransport } from './transport.js';
import { startQrScanner, type QrScannerHandle } from './qr-scanner.js';

const T0 = performance.now();
const clog = (msg: string) => console.log(`[CLIENT T+${Math.round(performance.now() - T0)}ms] ${msg}`);

function buildWsUrl(): string {
  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL as string;
  }
  if (location.protocol === 'https:') {
    return `wss://${location.host}/ws`;
  }
  const wsPort = import.meta.env.VITE_WS_PORT ?? '7719';
  return `ws://127.0.0.1:${wsPort}`;
}

function isP2PDefault(): boolean {
  return (import.meta.env.VITE_DEFAULT_MODE as string | undefined) === 'p2p';
}

function chooseTransport(): ClientTransport | null {
  // 1. Pairing mode — `?pair=…` in URL
  const payload = getPairingPayloadFromUrl();
  if (payload) {
    if (payload.expires < Date.now()) {
      console.warn('[CLIENT] Pairing token has expired');
      showPairingError('This pairing link has expired. Please generate a new QR code on your desktop.');
      return null;
    }
    clog(`pairing mode → ${payload.peerId.slice(0, 16)}…`);
    clearPairingParamFromUrl();
    const clientName = navigator.userAgent.includes('Mobile') ? 'Phone' : 'Browser';
    return new WebRTCClientTransport({ pairing: { payload, clientName } });
  }

  // 2. Reconnect mode — paired desktop in localStorage
  const desktop = getMostRecentPairedDesktop();
  if (desktop) {
    clog(`reconnect mode → ${desktop.peerId.slice(0, 16)}…`);
    return new WebRTCClientTransport({ reconnect: { desktop } });
  }

  // 3. P2P-default build with no pairing — show the pair prompt.
  if (isP2PDefault()) {
    clog('p2p-default build with no pairing → pair prompt');
    showPairPrompt();
    return null;
  }

  // 4. Default: WebSocket to local backend
  const url = buildWsUrl();
  clog(`websocket mode → ${url}`);
  return new WebSocketClientTransport(url);
}

let pendingClient: FrontendClient | undefined;
let activeScanner: QrScannerHandle | undefined;

function showPairPrompt(message?: string): void {
  // Hide the loading overlay; show the dedicated pairing prompt.
  const connecting = document.getElementById('connecting-overlay');
  if (connecting) connecting.classList.add('hidden');
  const overlay = document.getElementById('pair-prompt-overlay');
  if (overlay) overlay.classList.add('visible');
  const msg = document.getElementById('pair-prompt-message');
  if (msg) msg.textContent = message ?? '';

  // Wire (idempotently) the Scan button.
  const scanBtn = document.getElementById('pair-scan-btn') as HTMLButtonElement | null;
  if (scanBtn && !scanBtn.dataset.wired) {
    scanBtn.dataset.wired = '1';
    scanBtn.addEventListener('click', () => { void launchScanner(); });
  }
  const cancelBtn = document.getElementById('qr-scanner-cancel') as HTMLButtonElement | null;
  if (cancelBtn && !cancelBtn.dataset.wired) {
    cancelBtn.dataset.wired = '1';
    cancelBtn.addEventListener('click', () => stopScanner());
  }
}

function hidePairPrompt(): void {
  const overlay = document.getElementById('pair-prompt-overlay');
  if (overlay) overlay.classList.remove('visible');
}

function showPairingError(text: string): void {
  showPairPrompt(text);
}

function showScanner(): void {
  const overlay = document.getElementById('qr-scanner-overlay');
  if (overlay) overlay.classList.add('visible');
}

function hideScanner(): void {
  const overlay = document.getElementById('qr-scanner-overlay');
  if (overlay) overlay.classList.remove('visible');
}

function stopScanner(): void {
  if (activeScanner) {
    activeScanner.stop();
    activeScanner = undefined;
  }
  hideScanner();
}

async function launchScanner(): Promise<void> {
  const video = document.getElementById('qr-scanner-video') as HTMLVideoElement | null;
  if (!video) return;
  showScanner();
  try {
    activeScanner = await startQrScanner({
      video,
      onResult: (text) => {
        stopScanner();
        const payload = parseScannedQr(text);
        if (!payload) {
          showPairingError('That QR code is not a valid pairing link.');
          return;
        }
        if (payload.expires < Date.now()) {
          showPairingError('Pairing link has expired. Generate a new QR on your desktop.');
          return;
        }
        beginPairing(payload);
      },
      onError: (err) => {
        stopScanner();
        const msg = (err.name === 'NotAllowedError' || err.name === 'SecurityError')
          ? 'Camera permission denied. You can also scan with your phone\'s native camera app.'
          : `Camera unavailable: ${err.message}`;
        showPairingError(msg);
      },
    });
  } catch (err) {
    stopScanner();
    const e = err instanceof Error ? err : new Error(String(err));
    const msg = (e.name === 'NotAllowedError' || e.name === 'SecurityError')
      ? 'Camera permission denied.'
      : `Camera unavailable: ${e.message}`;
    showPairingError(msg);
  }
}

/** Extract a pairing payload from a scanned QR string. The QR encodes a
 *  full URL (`https://client.abject.world/?pair=…`); we only need the
 *  `pair` query param. */
function parseScannedQr(text: string): PairingPayload | null {
  try {
    const url = new URL(text);
    const raw = url.searchParams.get('pair');
    if (!raw) return null;
    return decodePairPayload(raw);
  } catch {
    // Maybe the QR encoded just the base64 payload itself.
    return decodePairPayload(text);
  }
}

function decodePairPayload(raw: string): PairingPayload | null {
  try {
    const pad = raw.length % 4 === 0 ? '' : '='.repeat(4 - (raw.length % 4));
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/') + pad;
    const json = decodeURIComponent(escape(atob(b64)));
    const parsed = JSON.parse(json);
    if (!parsed || parsed.v !== 1 || typeof parsed.peerId !== 'string') return null;
    return parsed as PairingPayload;
  } catch {
    return null;
  }
}

function beginPairing(payload: PairingPayload): void {
  hidePairPrompt();
  const connecting = document.getElementById('connecting-overlay');
  if (connecting) connecting.classList.remove('hidden');
  const clientName = navigator.userAgent.includes('Mobile') ? 'Phone' : 'Browser';
  const transport = new WebRTCClientTransport({ pairing: { payload, clientName } });
  if (!pendingClient) {
    console.error('[client] no FrontendClient available');
    return;
  }
  pendingClient.connect(transport).catch((err) => {
    console.error('[Frontend] connect failed:', err);
    showPairingError('Failed to connect. Please try again.');
  });
}

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

  const abyssBg = document.getElementById('abyss-bg') as HTMLCanvasElement | null;
  const abyssControl = abyssBg ? startAbyssBg(abyssBg) : undefined;

  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  container.appendChild(canvas);

  const client = new FrontendClient(canvas, abyssControl);
  pendingClient = client;
  (window as unknown as Record<string, unknown>).frontendClient = client;

  const transport = chooseTransport();
  if (!transport) {
    // Splash already shown by chooseTransport; nothing else to do.
    return;
  }

  clog('Calling connect()...');
  client.connect(transport).catch((err) => {
    console.error('[Frontend] connect failed:', err);
    showPairingError('Failed to connect. Please try again.');
  });
}

if (document.readyState !== 'loading') {
  start();
} else {
  document.addEventListener('DOMContentLoaded', start);
}
