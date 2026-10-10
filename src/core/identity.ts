/**
 * Cryptographic identity helpers.
 *
 * PeerId is the hex-encoded SHA-256 hash of the peer's public signing key in
 * its 'raw' export (the uncompressed P-256 point, 0x04 || X || Y; not SPKI).
 * Keys are ECDSA P-256 for signing and ECDH P-256 for key agreement.
 */

import { require as precondition } from './contracts.js';
import { base64ToBytes, bytesToBase64, bytesToHex } from './encoding.js';

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
 * PeerId = hex(SHA-256(raw public key)), the key exported as 'raw' (the
 * uncompressed point), not SPKI.
 */
export async function derivePeerId(publicSigningKey: CryptoKey): Promise<PeerId> {
  const raw = await crypto.subtle.exportKey('raw', publicSigningKey);
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return bytesToHex(hash);
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
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
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
  const ivBytes = base64ToBytes(iv);
  const ctBytes = base64ToBytes(ciphertext);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes as BufferSource },
    key,
    ctBytes as BufferSource,
  );
  return new Uint8Array(plaintext);
}

/**
 * AES-256-GCM encrypt returning the IV and ciphertext as raw bytes. Avoids
 * the base64 round-trip in `aesEncrypt`/`aesDecrypt` on hot paths (e.g. the
 * binary frame protocol in PeerTransport).
 */
export async function aesEncryptBytes(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return { iv, ciphertext: new Uint8Array(ciphertext) };
}

export async function aesDecryptBytes(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return new Uint8Array(plaintext);
}
