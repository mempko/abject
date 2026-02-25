/**
 * Identity object — manages cryptographic keypairs, signing, verification,
 * and key agreement for peer identity.
 *
 * Uses Web Crypto API: ECDSA P-256 for signing, ECDH P-256 for key exchange.
 * Keys are persisted via the Storage object as exported JWK.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { Capabilities } from '../core/capability.js';
import { require as precondition, invariant } from '../core/contracts.js';
import { request as createRequest } from '../core/message.js';
import {
  PeerId,
  PeerIdentity,
  exportKeyToJwk,
  importSigningPublicKey,
  importSigningPrivateKey,
  importExchangePublicKey,
  importExchangePrivateKey,
  derivePeerId,
  derivePeerIdFromJwk,
  deriveSessionKey,
  aesEncrypt,
  aesDecrypt,
} from '../core/identity.js';

const IDENTITY_INTERFACE = 'abjects:identity';
const STORAGE_INTERFACE = 'abjects:storage' as InterfaceId;
const STORAGE_KEY_SIGNING = 'identity:signing-keypair';
const STORAGE_KEY_EXCHANGE = 'identity:exchange-keypair';
const STORAGE_KEY_NAME = 'identity:name';

export const IDENTITY_ID = 'abjects:identity' as AbjectId;

export class IdentityObject extends Abject {
  private signingKeyPair?: CryptoKeyPair;
  private exchangeKeyPair?: CryptoKeyPair;
  private peerId?: PeerId;
  private peerName = '';
  private storageId?: AbjectId;

  // Cache of imported contact public keys
  private contactKeys: Map<PeerId, { signing: CryptoKey; exchange: CryptoKey }> = new Map();

  constructor() {
    super({
      manifest: {
        name: 'Identity',
        description:
          'Cryptographic identity for this peer. Manages ECDSA P-256 signing keys and ECDH P-256 exchange keys. PeerId is the SHA-256 hash of the public signing key.',
        version: '1.0.0',
        interfaces: [
          {
            id: IDENTITY_INTERFACE,
            name: 'Identity',
            description: 'Peer identity and cryptographic operations',
            methods: [
              {
                name: 'getIdentity',
                description: 'Get this peer\'s identity (peerId, public keys, name)',
                parameters: [],
                returns: { kind: 'reference', reference: 'PeerIdentity' },
              },
              {
                name: 'sign',
                description: 'Sign data with this peer\'s signing key',
                parameters: [
                  {
                    name: 'data',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Data to sign (will be UTF-8 encoded)',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'verify',
                description: 'Verify a signature against a peer\'s public key',
                parameters: [
                  {
                    name: 'peerId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'PeerId of the signer',
                  },
                  {
                    name: 'data',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Original data',
                  },
                  {
                    name: 'signature',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Base64-encoded signature',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'encrypt',
                description: 'Encrypt data for a specific peer using ECDH key agreement + AES-256-GCM',
                parameters: [
                  {
                    name: 'peerId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Recipient PeerId',
                  },
                  {
                    name: 'data',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Data to encrypt',
                  },
                ],
                returns: { kind: 'reference', reference: 'EncryptedPayload' },
              },
              {
                name: 'decrypt',
                description: 'Decrypt data from a specific peer',
                parameters: [
                  {
                    name: 'peerId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Sender PeerId',
                  },
                  {
                    name: 'iv',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Base64-encoded IV',
                  },
                  {
                    name: 'ciphertext',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Base64-encoded ciphertext',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'exportPublicKeys',
                description: 'Export public keys as JWK strings for sharing with other peers',
                parameters: [],
                returns: { kind: 'reference', reference: 'PublicKeyExport' },
              },
              {
                name: 'importContact',
                description: 'Import a contact\'s public keys for verification and encryption',
                parameters: [
                  {
                    name: 'peerId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The contact\'s PeerId',
                  },
                  {
                    name: 'publicSigningKey',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'JWK-encoded ECDSA public key',
                  },
                  {
                    name: 'publicExchangeKey',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'JWK-encoded ECDH public key',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'setName',
                description: 'Set this peer\'s display name',
                parameters: [
                  {
                    name: 'name',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Display name',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'deriveSessionKey',
                description: 'Derive an AES-256-GCM session key with a remote peer via ECDH',
                parameters: [
                  {
                    name: 'peerId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Remote peer\'s PeerId',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
            ],
          },
        ],
        requiredCapabilities: [],
        providedCapabilities: [
          Capabilities.IDENTITY_SIGN,
          Capabilities.IDENTITY_VERIFY,
        ],
        tags: ['system', 'identity'],
      },
    });
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('getIdentity', async () => {
      precondition(this.peerId !== undefined, 'Identity not initialized');
      return this.exportPublicKeysImpl();
    });

    this.on('sign', async (msg: AbjectMessage) => {
      const { data } = msg.payload as { data: string };
      precondition(typeof data === 'string', 'data must be a string');
      return this.signData(data);
    });

    this.on('verify', async (msg: AbjectMessage) => {
      const { peerId, data, signature } = msg.payload as {
        peerId: string; data: string; signature: string;
      };
      return this.verifySignature(peerId, data, signature);
    });

    this.on('encrypt', async (msg: AbjectMessage) => {
      const { peerId, data } = msg.payload as { peerId: string; data: string };
      return this.encryptFor(peerId, data);
    });

    this.on('decrypt', async (msg: AbjectMessage) => {
      const { peerId, iv, ciphertext } = msg.payload as {
        peerId: string; iv: string; ciphertext: string;
      };
      return this.decryptFrom(peerId, iv, ciphertext);
    });

    this.on('exportPublicKeys', async () => {
      return this.exportPublicKeysImpl();
    });

    this.on('importContact', async (msg: AbjectMessage) => {
      const { peerId, publicSigningKey, publicExchangeKey } = msg.payload as {
        peerId: string; publicSigningKey: string; publicExchangeKey: string;
      };
      return this.importContactKeys(peerId, publicSigningKey, publicExchangeKey);
    });

    this.on('setName', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      precondition(typeof name === 'string', 'name must be a string');
      this.peerName = name;
      await this.persistName();
      return true;
    });

    this.on('deriveSessionKey', async (msg: AbjectMessage) => {
      const { peerId } = msg.payload as { peerId: string };
      return this.deriveSessionKeyForPeer(peerId);
    });
  }

  protected override async onInit(): Promise<void> {
    // Discover storage via registry
    this.storageId = (await this.discoverDep('Storage')) ?? undefined;

    // Try to load existing keys from storage
    const loaded = await this.loadKeys();
    if (!loaded) {
      await this.generateKeys();
      await this.persistKeys();
    }

    // Load name
    await this.loadName();

    this.checkInvariants();
  }

  // ==========================================================================
  // Key Management
  // ==========================================================================

  private async generateKeys(): Promise<void> {
    this.signingKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    this.exchangeKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits', 'deriveKey'],
    );
    this.peerId = await derivePeerId(this.signingKeyPair.publicKey);
    console.log(`[Identity] Generated new identity: ${this.peerId.slice(0, 16)}...`);
  }

  private async loadKeys(): Promise<boolean> {
    if (!this.storageId) return false;

    try {
      const signingData = await this.request<{ value: unknown }>(
        createRequest(this.id, this.storageId, STORAGE_INTERFACE, 'get', { key: STORAGE_KEY_SIGNING }),
      );
      const exchangeData = await this.request<{ value: unknown }>(
        createRequest(this.id, this.storageId, STORAGE_INTERFACE, 'get', { key: STORAGE_KEY_EXCHANGE }),
      );

      if (!signingData?.value || !exchangeData?.value) return false;

      const signingJwk = signingData.value as { publicKey: string; privateKey: string };
      const exchangeJwk = exchangeData.value as { publicKey: string; privateKey: string };

      this.signingKeyPair = {
        publicKey: await importSigningPublicKey(signingJwk.publicKey),
        privateKey: await importSigningPrivateKey(signingJwk.privateKey),
      };
      this.exchangeKeyPair = {
        publicKey: await importExchangePublicKey(exchangeJwk.publicKey),
        privateKey: await importExchangePrivateKey(exchangeJwk.privateKey),
      };
      this.peerId = await derivePeerId(this.signingKeyPair.publicKey);
      console.log(`[Identity] Loaded existing identity: ${this.peerId.slice(0, 16)}...`);
      return true;
    } catch {
      return false;
    }
  }

  private async persistKeys(): Promise<void> {
    if (!this.storageId || !this.signingKeyPair || !this.exchangeKeyPair) return;

    const signingJwk = {
      publicKey: await exportKeyToJwk(this.signingKeyPair.publicKey),
      privateKey: await exportKeyToJwk(this.signingKeyPair.privateKey),
    };
    const exchangeJwk = {
      publicKey: await exportKeyToJwk(this.exchangeKeyPair.publicKey),
      privateKey: await exportKeyToJwk(this.exchangeKeyPair.privateKey),
    };

    await this.request(
      createRequest(this.id, this.storageId, STORAGE_INTERFACE, 'set',
        { key: STORAGE_KEY_SIGNING, value: signingJwk }),
    );
    await this.request(
      createRequest(this.id, this.storageId, STORAGE_INTERFACE, 'set',
        { key: STORAGE_KEY_EXCHANGE, value: exchangeJwk }),
    );
  }

  private async loadName(): Promise<void> {
    if (!this.storageId) return;
    try {
      const result = await this.request<{ value: unknown }>(
        createRequest(this.id, this.storageId, STORAGE_INTERFACE, 'get', { key: STORAGE_KEY_NAME }),
      );
      if (result?.value && typeof result.value === 'string') {
        this.peerName = result.value;
      }
    } catch {
      // Name not set yet
    }
  }

  private async persistName(): Promise<void> {
    if (!this.storageId) return;
    await this.request(
      createRequest(this.id, this.storageId, STORAGE_INTERFACE, 'set',
        { key: STORAGE_KEY_NAME, value: this.peerName }),
    );
  }

  // ==========================================================================
  // Identity Operations
  // ==========================================================================

  private async exportPublicKeysImpl(): Promise<PeerIdentity> {
    precondition(this.signingKeyPair !== undefined, 'Signing key not initialized');
    precondition(this.exchangeKeyPair !== undefined, 'Exchange key not initialized');

    return {
      peerId: this.peerId!,
      publicSigningKey: await exportKeyToJwk(this.signingKeyPair!.publicKey),
      publicExchangeKey: await exportKeyToJwk(this.exchangeKeyPair!.publicKey),
      name: this.peerName,
    };
  }

  private async signData(data: string): Promise<string> {
    precondition(this.signingKeyPair !== undefined, 'Signing key not initialized');

    const encoder = new TextEncoder();
    const dataBytes = encoder.encode(data);
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      this.signingKeyPair!.privateKey,
      dataBytes,
    );
    return bufferToBase64(new Uint8Array(signature));
  }

  private async verifySignature(
    peerId: string,
    data: string,
    signature: string,
  ): Promise<boolean> {
    const contact = this.contactKeys.get(peerId);
    precondition(contact !== undefined, `Unknown contact: ${peerId.slice(0, 16)}`);

    const encoder = new TextEncoder();
    const dataBytes = encoder.encode(data);
    const sigBytes = base64ToBuffer(signature);

    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      contact!.signing,
      sigBytes as BufferSource,
      dataBytes as BufferSource,
    );
  }

  private async encryptFor(peerId: string, data: string): Promise<{ iv: string; ciphertext: string }> {
    precondition(this.exchangeKeyPair !== undefined, 'Exchange key not initialized');
    const contact = this.contactKeys.get(peerId);
    precondition(contact !== undefined, `Unknown contact: ${peerId.slice(0, 16)}`);

    const sessionKey = await deriveSessionKey(
      this.exchangeKeyPair!.privateKey,
      contact!.exchange,
    );
    const encoder = new TextEncoder();
    return aesEncrypt(sessionKey, encoder.encode(data));
  }

  private async decryptFrom(peerId: string, iv: string, ciphertext: string): Promise<string> {
    precondition(this.exchangeKeyPair !== undefined, 'Exchange key not initialized');
    const contact = this.contactKeys.get(peerId);
    precondition(contact !== undefined, `Unknown contact: ${peerId.slice(0, 16)}`);

    const sessionKey = await deriveSessionKey(
      this.exchangeKeyPair!.privateKey,
      contact!.exchange,
    );
    const plaintext = await aesDecrypt(sessionKey, iv, ciphertext);
    const decoder = new TextDecoder();
    return decoder.decode(plaintext);
  }

  private async importContactKeys(
    peerId: string,
    publicSigningKeyJwk: string,
    publicExchangeKeyJwk: string,
  ): Promise<boolean> {
    // Verify that the peerId matches the signing key
    const computedPeerId = await derivePeerIdFromJwk(publicSigningKeyJwk);
    precondition(
      computedPeerId === peerId,
      `PeerId mismatch: expected ${peerId.slice(0, 16)}, computed ${computedPeerId.slice(0, 16)}`,
    );

    const signingKey = await importSigningPublicKey(publicSigningKeyJwk);
    const exchangeKey = await importExchangePublicKey(publicExchangeKeyJwk);

    this.contactKeys.set(peerId, { signing: signingKey, exchange: exchangeKey });
    return true;
  }

  private async deriveSessionKeyForPeer(peerId: string): Promise<string> {
    precondition(this.exchangeKeyPair !== undefined, 'Exchange key not initialized');
    const contact = this.contactKeys.get(peerId);
    precondition(contact !== undefined, `Unknown contact: ${peerId.slice(0, 16)}`);

    const sessionKey = await deriveSessionKey(
      this.exchangeKeyPair!.privateKey,
      contact!.exchange,
    );
    // Export raw key bits and hash for verification fingerprint
    const rawBits = await crypto.subtle.exportKey('raw', sessionKey);
    const hash = await crypto.subtle.digest('SHA-256', rawBits);
    return bufferToHex(new Uint8Array(hash));
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    if (this.signingKeyPair) {
      invariant(this.peerId !== undefined, 'peerId must be set when signing keys exist');
    }
    if (this.exchangeKeyPair) {
      invariant(this.signingKeyPair !== undefined, 'signing keys must exist when exchange keys exist');
    }
  }
}

// =============================================================================
// Encoding Helpers
// =============================================================================

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

function bufferToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}
