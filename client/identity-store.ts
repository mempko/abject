/**
 * Browser identity store — owns this browser's ECDSA + ECDH keypair.
 *
 * Private keys are non-extractable and live in IndexedDB; only the public
 * JWKs and the derived peerId are mirrored into localStorage for fast access.
 * This is significantly safer than serialising private JWKs into localStorage
 * where any same-origin script could read them.
 */

import {
  PeerId,
  derivePeerId,
  exportKeyToJwk,
} from '../src/core/identity.js';

const DB_NAME = 'abjects-remote-ui';
const DB_VERSION = 1;
const STORE_KEYS = 'keys';
const KEY_SIGNING = 'signing-keypair';
const KEY_EXCHANGE = 'exchange-keypair';
const LS_PEER_ID = 'remote-ui:peer-id';
const LS_SIGNING_PUB = 'remote-ui:signing-pub';
const LS_EXCHANGE_PUB = 'remote-ui:exchange-pub';

export interface BrowserIdentity {
  peerId: PeerId;
  signingKeyPair: CryptoKeyPair;
  exchangeKeyPair: CryptoKeyPair;
  publicSigningKeyJwk: string;
  publicExchangeKeyJwk: string;
}

let cached: BrowserIdentity | undefined;

export async function getBrowserIdentity(): Promise<BrowserIdentity> {
  if (cached) return cached;
  const loaded = await loadIdentity();
  if (loaded) {
    cached = loaded;
    return loaded;
  }
  const generated = await generateIdentity();
  await persistIdentity(generated);
  cached = generated;
  return generated;
}

async function loadIdentity(): Promise<BrowserIdentity | null> {
  try {
    const db = await openDb();
    const signing = await idbGet<CryptoKeyPair>(db, KEY_SIGNING);
    const exchange = await idbGet<CryptoKeyPair>(db, KEY_EXCHANGE);
    db.close();
    if (!signing || !exchange) return null;
    const publicSigningKeyJwk = await exportKeyToJwk(signing.publicKey);
    const publicExchangeKeyJwk = await exportKeyToJwk(exchange.publicKey);
    const peerId = await derivePeerId(signing.publicKey);
    // Refresh localStorage cache (cheap)
    localStorage.setItem(LS_PEER_ID, peerId);
    localStorage.setItem(LS_SIGNING_PUB, publicSigningKeyJwk);
    localStorage.setItem(LS_EXCHANGE_PUB, publicExchangeKeyJwk);
    return {
      peerId,
      signingKeyPair: signing,
      exchangeKeyPair: exchange,
      publicSigningKeyJwk,
      publicExchangeKeyJwk,
    };
  } catch (err) {
    console.warn('[identity-store] loadIdentity failed:', err);
    return null;
  }
}

async function generateIdentity(): Promise<BrowserIdentity> {
  // Private keys are NOT extractable — they live in the browser keystore
  // and can never be serialised by JavaScript.
  const signingKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  );
  const exchangeKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits', 'deriveKey'],
  );
  // Public keys ARE extractable so we can advertise them on the wire.
  const publicSigningKeyJwk = await exportKeyToJwk(signingKeyPair.publicKey);
  const publicExchangeKeyJwk = await exportKeyToJwk(exchangeKeyPair.publicKey);
  const peerId = await derivePeerId(signingKeyPair.publicKey);
  console.log(`[identity-store] generated browser identity ${peerId.slice(0, 16)}…`);
  return { peerId, signingKeyPair, exchangeKeyPair, publicSigningKeyJwk, publicExchangeKeyJwk };
}

/**
 * Wipe the browser's signing/exchange keypair (IndexedDB) and the localStorage
 * mirrors. After this, the next getBrowserIdentity() call generates a fresh
 * peerId. Use when the user explicitly resets — the desktop will see a
 * different peer next time and the user must re-pair via QR.
 */
export async function clearBrowserIdentity(): Promise<void> {
  cached = undefined;
  localStorage.removeItem(LS_PEER_ID);
  localStorage.removeItem(LS_SIGNING_PUB);
  localStorage.removeItem(LS_EXCHANGE_PUB);
  try {
    const db = await openDb();
    await idbDelete(db, KEY_SIGNING);
    await idbDelete(db, KEY_EXCHANGE);
    db.close();
  } catch (err) {
    console.warn('[identity-store] clearBrowserIdentity failed:', err);
  }
}

async function persistIdentity(identity: BrowserIdentity): Promise<void> {
  const db = await openDb();
  await idbPut(db, KEY_SIGNING, identity.signingKeyPair);
  await idbPut(db, KEY_EXCHANGE, identity.exchangeKeyPair);
  db.close();
  localStorage.setItem(LS_PEER_ID, identity.peerId);
  localStorage.setItem(LS_SIGNING_PUB, identity.publicSigningKeyJwk);
  localStorage.setItem(LS_EXCHANGE_PUB, identity.publicExchangeKeyJwk);
}

// ── IndexedDB plumbing ─────────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_KEYS)) {
        db.createObjectStore(STORE_KEYS);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_KEYS, 'readonly');
    const store = tx.objectStore(STORE_KEYS);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut<T>(db: IDBDatabase, key: string, value: T): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_KEYS, 'readwrite');
    const store = tx.objectStore(STORE_KEYS);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_KEYS, 'readwrite');
    const store = tx.objectStore(STORE_KEYS);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
