/**
 * Cryptographic identity helpers.
 *
 * PeerId is the hex-encoded SHA-256 hash of the peer's public signing key (SPKI).
 * Keys are ECDSA P-256 for signing and ECDH P-256 for key agreement.
 */

import { require as precondition } from './contracts.js';

export type PeerId = string;

export interface PeerIdentity {
  peerId: PeerId;
  publicSigningKey: string;   // JWK-encoded ECDSA P-256 public key
  publicExchangeKey: string;  // JWK-encoded ECDH P-256 public key
  name: string;
}

export interface PeerContact {
  identity: PeerIdentity;
  state: PeerConnectionState;
  addresses: string[];        // signaling server URLs where this peer can be found
  addedAt: number;
  lastSeen?: number;
}

export type PeerConnectionState = 'offline' | 'connecting' | 'connected';

// =============================================================================
// Key Serialization
// =============================================================================

/**
 * Export a CryptoKey to JWK string.
 */
export async function exportKeyToJwk(key: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey('jwk', key);
  return JSON.stringify(jwk);
}

/**
 * Import a JWK string as an ECDSA P-256 public key.
 */
export async function importSigningPublicKey(jwkString: string): Promise<CryptoKey> {
  precondition(jwkString !== '', 'JWK string must not be empty');
  const jwk = JSON.parse(jwkString) as JsonWebKey;
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
}

/**
 * Import a JWK string as an ECDSA P-256 private key.
 */
export async function importSigningPrivateKey(jwkString: string): Promise<CryptoKey> {
  precondition(jwkString !== '', 'JWK string must not be empty');
  const jwk = JSON.parse(jwkString) as JsonWebKey;
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign'],
  );
}

/**
 * Import a JWK string as an ECDH P-256 public key.
 */
export async function importExchangePublicKey(jwkString: string): Promise<CryptoKey> {
  precondition(jwkString !== '', 'JWK string must not be empty');
  const jwk = JSON.parse(jwkString) as JsonWebKey;
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
}

/**
 * Import a JWK string as an ECDH P-256 private key.
 */
export async function importExchangePrivateKey(jwkString: string): Promise<CryptoKey> {
  precondition(jwkString !== '', 'JWK string must not be empty');
  const jwk = JSON.parse(jwkString) as JsonWebKey;
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits', 'deriveKey'],
  );
}

// =============================================================================
// PeerId Derivation
// =============================================================================

/**
 * Derive a PeerId from a public signing key.
 * PeerId = hex(SHA-256(SPKI-encoded public key)).
 */
export async function derivePeerId(publicSigningKey: CryptoKey): Promise<PeerId> {
  const spki = await crypto.subtle.exportKey('raw', publicSigningKey);
  const hash = await crypto.subtle.digest('SHA-256', spki);
  return bufferToHex(hash);
}

/**
 * Derive a PeerId from a JWK-encoded public signing key string.
 */
export async function derivePeerIdFromJwk(jwkString: string): Promise<PeerId> {
  const key = await importSigningPublicKey(jwkString);
  return derivePeerId(key);
}

// =============================================================================
// Encryption Helpers
// =============================================================================

/**
 * Derive an AES-256-GCM session key from ECDH key agreement.
 */
export async function deriveSessionKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt data with AES-256-GCM.
 * Returns { iv, ciphertext } both as base64.
 */
export async function aesEncrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return {
    iv: bufferToBase64(iv),
    ciphertext: bufferToBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * Decrypt data with AES-256-GCM.
 */
export async function aesDecrypt(
  key: CryptoKey,
  iv: string,
  ciphertext: string,
): Promise<Uint8Array> {
  const ivBytes = base64ToBuffer(iv);
  const ctBytes = base64ToBuffer(ciphertext);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes as BufferSource },
    key,
    ctBytes as BufferSource,
  );
  return new Uint8Array(plaintext);
}

// =============================================================================
// Encoding Helpers
// =============================================================================

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function bufferToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
