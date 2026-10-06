/**
 * Byte encodings shared by the server, the workers and the browser client:
 * base64, base64url, hex, UTF-8 text as base64url, and random tokens.
 *
 * Runs everywhere: it needs only btoa/atob, TextEncoder/TextDecoder and
 * crypto.getRandomValues. Under Node it encodes base64 with Buffer, which is
 * far faster than btoa on large inputs (an image is megabytes).
 */

import { require as precondition } from './contracts.js';

/** Node's Buffer when present; the browser has none. */
const NodeBuffer: typeof Buffer | undefined = (globalThis as { Buffer?: typeof Buffer }).Buffer;

/** String.fromCharCode takes its bytes as arguments, so feed it in slices. */
const CHUNK = 0x8000;

/** Largest request crypto.getRandomValues accepts. */
const MAX_RANDOM_BYTES = 65536;

export function bytesToBase64(bytes: Uint8Array): string {
  if (NodeBuffer) return NodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** URL-safe base64 without padding (RFC 4648 §5), as JWTs and PKCE use. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  return base64ToBytes(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
}

/** Lowercase hex, two digits per byte. */
export function bytesToHex(bytes: Uint8Array | ArrayBuffer): string {
  const view = ArrayBuffer.isView(bytes) ? bytes : new Uint8Array(bytes);
  let hex = '';
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, '0');
  return hex;
}

/** The UTF-8 bytes of text, as base64url. */
export function utf8ToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

/** Inverse of utf8ToBase64Url. Throws on bytes that are not valid UTF-8. */
export function base64UrlToUtf8(base64url: string): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(base64UrlToBytes(base64url));
}

/**
 * A secret from `byteLength` cryptographically secure random bytes, as
 * base64url: session ids, pairing tokens, OAuth state, PKCE verifiers.
 */
export function randomToken(byteLength: number): string {
  precondition(Number.isInteger(byteLength) && byteLength >= 1 && byteLength <= MAX_RANDOM_BYTES,
    `byteLength must be an integer from 1 to ${MAX_RANDOM_BYTES}`);
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}
