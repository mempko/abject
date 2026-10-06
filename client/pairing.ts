/**
 * Pairing helpers — parse the `?pair=<base64url>` query payload that the
 * desktop's QR encodes.
 */

import { base64UrlToUtf8 } from '../src/core/encoding.js';

export interface PairingPayload {
  v: number;
  peerId: string;
  signKey: string;
  exKey: string;
  signalingUrl: string;
  token: string;
  expires: number;
  name: string;
}

export function getPairingPayloadFromUrl(): PairingPayload | null {
  try {
    const params = new URLSearchParams(location.search);
    const raw = params.get('pair');
    if (!raw) return null;
    const json = base64UrlToUtf8(raw);
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.v !== 1) return null;
    if (typeof parsed.peerId !== 'string' || parsed.peerId.length === 0) return null;
    if (typeof parsed.signKey !== 'string' || typeof parsed.exKey !== 'string') return null;
    if (typeof parsed.signalingUrl !== 'string') return null;
    if (typeof parsed.token !== 'string' || parsed.token.length === 0) return null;
    if (typeof parsed.expires !== 'number') return null;
    return parsed as PairingPayload;
  } catch {
    return null;
  }
}

/**
 * Strip the `pair` query param from the URL after consuming it. Avoids
 * leaving the (single-use) token in the address bar / history.
 */
export function clearPairingParamFromUrl(): void {
  try {
    const url = new URL(location.href);
    url.searchParams.delete('pair');
    history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
  } catch { /* ignore */ }
}
