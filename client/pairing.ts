/**
 * Pairing helpers — parse the `?pair=<base64url>` query payload that the
 * desktop's QR encodes.
 */

import { base64UrlToUtf8, utf8ToBase64Url } from '../src/core/encoding.js';

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
  const raw = new URLSearchParams(location.search).get('pair');
  return raw ? decodePairingParam(raw) : null;
}

/** A `pair` param (base64url JSON) as a payload, or null if it is not a complete one. */
function decodePairingParam(raw: string): PairingPayload | null {
  try {
    const parsed = JSON.parse(base64UrlToUtf8(raw.trim()));
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

/** Extract a pairing payload from a scanned QR string or a pasted link. The
 *  QR encodes a full URL (`https://client.abject.world/?pair=…`); we only
 *  need the `pair` query param. */
export function parsePairingText(text: string): PairingPayload | null {
  try {
    const raw = new URL(text.trim()).searchParams.get('pair');
    return raw ? decodePairingParam(raw) : null;
  } catch {
    // Maybe the QR encoded just the base64 payload itself.
    return decodePairingParam(text);
  }
}

/** This page's address carrying `payload` as its `?pair=` param. */
export function pairingPageUrl(payload: PairingPayload): string {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('pair', utf8ToBase64Url(JSON.stringify(payload)));
  return url.toString();
}
