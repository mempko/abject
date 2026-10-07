/**
 * Browser entry point for the thin rendering client.
 *
 * The `VITE_DEFAULT_MODE=p2p` build (client.abject.world) knows several
 * instances and connects to the selected one (startP2P below): a `?pair=…`
 * link pairs a new desktop, a saved desktop is reached over WebRTC, a saved
 * server address over WebSocket, and with nothing selected it shows the
 * instance picker (or the "Pair this device" splash when there are none).
 *
 * Every other build decides once:
 *   1. `?pair=…` query param → WebRTC pairing mode (first-time pair).
 *   2. localStorage has a paired desktop → WebRTC reconnect mode.
 *   3. Otherwise → WebSocket (current local-dev behaviour).
 */

import { FrontendClient } from './frontend-client.js';
import { startBackdrop } from './backdrop.js';
import { WebSocketClientTransport } from './ws-transport.js';
import { WebRTCClientTransport } from './webrtc-transport.js';
import { getPairingPayloadFromUrl, clearPairingParamFromUrl, parsePairingText, type PairingPayload } from './pairing.js';
import { getMostRecentPairedDesktop, clearAllPairedDesktops } from './paired-desktops.js';
import { clearBrowserIdentity } from './identity-store.js';
import type { ClientTransport } from './transport.js';
import { startQrScanner, type QrScannerHandle } from './qr-scanner.js';
import { InstanceSwitcher } from './instance-switcher.js';
import {
  authTokenKey,
  clearAllInstances,
  getSelectedInstance,
  migrateInstances,
  savePairedInstance,
  selectInstance,
} from './instances.js';

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

/** True when this client session is or could be P2P (pairing URL, an
 *  existing paired desktop, or a p2p-default build). The Reset/re-pair
 *  button is only meaningful in these cases; plain WebSocket clients
 *  have no pairing to reset. */
function isP2PMode(): boolean {
  if (getPairingPayloadFromUrl()) return true;
  if (getMostRecentPairedDesktop()) return true;
  return isP2PDefault();
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
    return new WebRTCClientTransport({ pairing: { payload, clientName: clientName() } });
  }

  // 2. Reconnect mode — paired desktop in localStorage
  const desktop = getMostRecentPairedDesktop();
  if (desktop) {
    clog(`reconnect mode → ${desktop.peerId.slice(0, 16)}…`);
    return new WebRTCClientTransport({ reconnect: { desktop } });
  }

  // 3. Default: WebSocket to local backend
  const url = buildWsUrl();
  clog(`websocket mode → ${url}`);
  return new WebSocketClientTransport(url);
}

let pendingClient: FrontendClient | undefined;
let activeScanner: QrScannerHandle | undefined;
/** What the splash's Scan button does; the p2p client routes scans through its instance list. */
let splashScan: () => void = () => { void launchScanner(); };

function clientName(): string {
  return navigator.userAgent.includes('Mobile') ? 'Phone' : 'Browser';
}

/**
 * The p2p client: connect to the selected instance, or show the picker.
 * Switching instances writes the choice and reloads, landing back here.
 */
function startP2P(client: FrontendClient): void {
  migrateInstances();
  const switcher = new InstanceSwitcher({
    client,
    showPairSplash: (message) => showPairPrompt(message),
    scanQr: (onText, onProblem) => { void launchScanner(onText, onProblem); },
  });
  splashScan = () => switcher.scanFromSplash();

  const connect = (transport: ClientTransport) => {
    clog('Calling connect()...');
    client.connect(transport).catch((err) => {
      // A refused or expired pairing has already been reported by the switcher.
      console.error('[Frontend] connect failed:', err);
      switcher.connectFailed();
    });
  };

  // A pairing link adds a desktop, saved and selected once it accepts.
  if (new URLSearchParams(location.search).has('pair')) {
    const payload = getPairingPayloadFromUrl();
    clearPairingParamFromUrl();
    if (!payload) {
      switcher.showPicker('That pairing link is not valid. Copy it again from your desktop.');
      return;
    }
    if (payload.expires < Date.now()) {
      switcher.showPicker('This pairing link has expired. Make a new one on your desktop.');
      return;
    }
    clog(`pairing mode → ${payload.peerId.slice(0, 16)}…`);
    switcher.beginSession({ kind: 'pairing', name: payload.name });
    connect(new WebRTCClientTransport({
      pairing: { payload, clientName: clientName() },
      events: {
        onPaired: (desktop) => {
          const instance = savePairedInstance(desktop);
          selectInstance(instance.id);
          switcher.setInstance(instance);
        },
        onAccepted: () => switcher.noteAccepted(),
        onPairingFailed: (reason) => switcher.pairingFailed(reason),
        onRetry: (info) => switcher.noteRetry(info),
      },
    }));
    return;
  }

  const instance = getSelectedInstance();
  if (!instance) {
    clog('no instance selected → picker');
    switcher.showPicker();
    return;
  }
  switcher.beginSession({ kind: 'instance', instance });
  if (instance.kind === 'paired') {
    clog(`reconnect mode → ${instance.desktop.peerId.slice(0, 16)}…`);
    connect(new WebRTCClientTransport({
      reconnect: { desktop: instance.desktop },
      events: {
        onAccepted: () => switcher.noteAccepted(),
        onRetry: (info) => switcher.noteRetry(info),
      },
    }));
  } else {
    clog(`websocket mode → ${instance.url}`);
    client.setAuthTokenKey(authTokenKey(instance.id));
    connect(new WebSocketClientTransport(instance.url));
  }
}

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
    scanBtn.addEventListener('click', () => splashScan());
  }
  wireScannerCancel();
}

function wireScannerCancel(): void {
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

async function launchScanner(
  onText: (text: string) => void = pairFromScannedText,
  onProblem: (message: string) => void = showPairingError,
): Promise<void> {
  const video = document.getElementById('qr-scanner-video') as HTMLVideoElement | null;
  if (!video) return;
  wireScannerCancel();
  showScanner();
  try {
    activeScanner = await startQrScanner({
      video,
      onResult: (text) => {
        stopScanner();
        onText(text);
      },
      onError: (err) => {
        stopScanner();
        const msg = (err.name === 'NotAllowedError' || err.name === 'SecurityError')
          ? 'Camera permission denied. You can also scan with your phone\'s native camera app.'
          : `Camera unavailable: ${err.message}`;
        onProblem(msg);
      },
    });
  } catch (err) {
    stopScanner();
    const e = err instanceof Error ? err : new Error(String(err));
    const msg = (e.name === 'NotAllowedError' || e.name === 'SecurityError')
      ? 'Camera permission denied.'
      : `Camera unavailable: ${e.message}`;
    onProblem(msg);
  }
}

function pairFromScannedText(text: string): void {
  const payload = parsePairingText(text);
  if (!payload) {
    showPairingError('That QR code is not a valid pairing link.');
    return;
  }
  if (payload.expires < Date.now()) {
    showPairingError('Pairing link has expired. Generate a new QR on your desktop.');
    return;
  }
  beginPairing(payload);
}

function beginPairing(payload: PairingPayload): void {
  hidePairPrompt();
  const connecting = document.getElementById('connecting-overlay');
  if (connecting) connecting.classList.remove('hidden');
  const transport = new WebRTCClientTransport({ pairing: { payload, clientName: clientName() } });
  if (!pendingClient) {
    console.error('[client] no FrontendClient available');
    return;
  }
  pendingClient.connect(transport).catch((err) => {
    console.error('[Frontend] connect failed:', err);
    showPairingError('Failed to connect. Please try again.');
  });
}

async function resetClientState(): Promise<void> {
  clog('reset: clearing keys and paired desktops');
  try {
    await clearBrowserIdentity();
  } catch (err) {
    console.warn('[Frontend] clearBrowserIdentity failed:', err);
  }
  if (isP2PDefault()) clearAllInstances();
  clearAllPairedDesktops();
  try { localStorage.removeItem('abjects_auth_token'); } catch { /* ignore */ }
  // Drop any ?pair=… so reload lands on the clean splash.
  const url = new URL(window.location.href);
  url.search = '';
  window.location.replace(url.toString());
}

function wireResetButton(): void {
  const btn = document.getElementById('connecting-reset-btn') as HTMLButtonElement | null;
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => { void resetClientState(); });

  // Reveal the reset button after a few seconds of being on the connecting
  // overlay — quick successful connects never see it. If the overlay is
  // already hidden (we connected fast), do nothing.
  setTimeout(() => {
    const overlay = document.getElementById('connecting-overlay');
    if (overlay && !overlay.classList.contains('hidden')) {
      btn.hidden = false;
      requestAnimationFrame(() => btn.classList.add('visible'));
    }
  }, 5000);
}

function start(): void {
  const container = document.querySelector('#app');
  if (!container) {
    console.error('[Frontend] #app container not found');
    return;
  }

  // Reset/re-pair only applies to P2P clients; WebSocket clients have
  // nothing to reset.
  if (isP2PMode()) wireResetButton();

  // Guard against double initialization (HMR or module re-execution)
  const existing = container.querySelector('canvas');
  if (existing) {
    console.warn('[Frontend] Canvas already exists — skipping re-init');
    return;
  }

  const abyssBg = document.getElementById('abyss-bg') as HTMLCanvasElement | null;
  const backdropControl = abyssBg ? startBackdrop(abyssBg) : undefined;

  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  container.appendChild(canvas);

  const client = new FrontendClient(canvas, backdropControl);
  pendingClient = client;
  (window as unknown as Record<string, unknown>).frontendClient = client;

  if (isP2PDefault()) {
    startP2P(client);
    return;
  }

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
