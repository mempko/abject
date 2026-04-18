/**
 * SecretsVault -- encrypted key/value store for API keys, tokens, and OAuth
 * credentials used by skills and MCP servers.
 *
 * Encryption model: AES-GCM with a 256-bit vault key. The key is generated
 * on first init and persisted to Storage alongside the encrypted secrets.
 * This is local-at-rest obfuscation, not a security boundary against a
 * local attacker with Storage access; the goal is to keep raw secret values
 * out of transcripts, backups, and casual grep.
 *
 * Callers never receive raw secret values. The only egress paths are:
 *   - `bindEnv(skillName, mapping)` -- returns a dict mapped for injection
 *     into an MCP subprocess's env at spawn time.
 *   - `reveal(name)` -- single-value read, gated to the named owner only,
 *     used by the UI and OAuthHelper during explicit user-facing flows.
 *
 * Metadata (name, description, skill, scope) is always visible so the UI can
 * render a list of stored credentials without needing the values.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { require as contractRequire } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';

const log = new Log('SecretsVault');

const SECRETS_VAULT_INTERFACE: InterfaceId = 'abjects:secrets-vault';
const SECRETS_STORAGE_KEY = 'secrets:vault';
const VAULT_KEY_STORAGE_KEY = 'secrets:vault-key';

export const SECRETS_VAULT_ID = 'abjects:secrets-vault' as AbjectId;

export interface SecretMeta {
  /** Display name, also the lookup key. */
  name: string;
  description?: string;
  /** Skill or MCP server that owns this secret (e.g. 'gmail-mcp'). */
  owner?: string;
  /** 'workspace' or 'global' (default: 'global'). */
  scope?: 'workspace' | 'global';
  /** ms since epoch; 0 for never expires. */
  expiresAt?: number;
  /** ms since epoch. */
  createdAt: number;
  updatedAt: number;
}

/** Persisted record: metadata + ciphertext. */
interface StoredSecret {
  meta: SecretMeta;
  iv: string; // base64
  ciphertext: string; // base64
}

export class SecretsVault extends Abject {
  private storageId?: AbjectId;
  private secrets = new Map<string, StoredSecret>();
  private vaultKey?: CryptoKey;

  constructor() {
    super({
      manifest: {
        name: 'SecretsVault',
        description:
          'Encrypted key/value store for skill and MCP credentials. ' +
          'Values are never returned to agents; only metadata is exposed ' +
          'via list(). MCPBridge pulls values via bindEnv at subprocess spawn.',
        version: '1.0.0',
        interface: {
          id: SECRETS_VAULT_INTERFACE,
          name: 'SecretsVault',
          description: 'Credential storage operations',
          methods: [
            {
              name: 'store',
              description: 'Store a secret by name. Overwrites any existing value.',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Secret name (unique key)' },
                { name: 'value', type: { kind: 'primitive', primitive: 'string' }, description: 'Raw secret value' },
                { name: 'meta', type: { kind: 'object', properties: {} }, description: 'Optional metadata (description, owner, scope, expiresAt)', optional: true },
              ],
              returns: { kind: 'object', properties: { stored: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'forget',
              description: 'Remove a secret.',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Secret name' },
              ],
              returns: { kind: 'object', properties: { forgotten: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'list',
              description: 'List metadata for all stored secrets (no values).',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'SecretMeta' } },
            },
            {
              name: 'exists',
              description: 'Check whether a secret is stored.',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Secret name' },
              ],
              returns: { kind: 'object', properties: { exists: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'bindEnv',
              description:
                'Resolve a mapping of env-var names to secret names into a ' +
                'dict ready for subprocess spawn. Missing secrets are reported ' +
                'in the `missing` array.',
              parameters: [
                { name: 'owner', type: { kind: 'primitive', primitive: 'string' }, description: 'Skill or MCP server name requesting the binding' },
                { name: 'mapping', type: { kind: 'object', properties: {} }, description: 'envVarName → secretName' },
              ],
              returns: { kind: 'object', properties: {
                env: { kind: 'object', properties: {} },
                missing: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
              }},
            },
            {
              name: 'reveal',
              description:
                'Return the raw value for a named secret. UI-only path; ' +
                'caller is expected to be an Abject acting on an explicit ' +
                'user action (e.g. OAuthHelper completing a flow or the ' +
                'Auth tab copying to clipboard).',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Secret name' },
              ],
              returns: { kind: 'object', properties: {
                value: { kind: 'primitive', primitive: 'string' },
                meta: { kind: 'reference', reference: 'SecretMeta' },
              }},
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'secrets'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.storageId = await this.discoverDep('Storage') ?? undefined;
    await this.loadOrCreateVaultKey();
    await this.loadSecrets();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## SecretsVault Usage Guide

Encrypted local credential store for skills and MCP servers. Agents never see
raw secret values. Use bindEnv at subprocess spawn to thread credentials
directly into a child process's environment.

### Store a secret

  await call(await dep('SecretsVault'), 'store', {
    name: 'gmail_oauth_token',
    value: '<token>',
    meta: { owner: 'gmail-mcp', scope: 'global', description: 'Gmail API access token' },
  });

### Bind env for an MCP spawn

  const { env, missing } = await call(await dep('SecretsVault'), 'bindEnv', {
    owner: 'gmail-mcp',
    mapping: { GMAIL_TOKEN: 'gmail_oauth_token' },
  });

### List (metadata only)

  const secrets = await call(await dep('SecretsVault'), 'list', {});
  // secrets[0] → { name, description, owner, scope, createdAt, updatedAt }

### IMPORTANT
- The interface ID is '${SECRETS_VAULT_INTERFACE}'.
- Values are AES-GCM encrypted at rest. This is local obfuscation, not a security boundary.
- list() never returns values; only reveal() does, and it's intended for explicit UI flows.`;
  }

  // ─── Handlers ───────────────────────────────────────────────────

  private setupHandlers(): void {
    this.on('store', async (msg: AbjectMessage) => {
      const { name, value, meta } = msg.payload as {
        name: string; value: string; meta?: Partial<SecretMeta>;
      };
      contractRequire(typeof name === 'string' && name.length > 0, 'name must be non-empty');
      contractRequire(typeof value === 'string', 'value must be a string');
      await this.storeSecret(name, value, meta ?? {});
      return { stored: true };
    });

    this.on('forget', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      contractRequire(typeof name === 'string' && name.length > 0, 'name must be non-empty');
      const forgotten = this.secrets.delete(name);
      if (forgotten) {
        await this.persistSecrets();
        this.changed('secretsChanged', { reason: 'forgotten', name });
      }
      return { forgotten };
    });

    this.on('list', async () => {
      return [...this.secrets.values()].map(s => s.meta);
    });

    this.on('exists', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      return { exists: this.secrets.has(name) };
    });

    this.on('bindEnv', async (msg: AbjectMessage) => {
      const { owner, mapping } = msg.payload as {
        owner: string;
        mapping: Record<string, string>;
      };
      contractRequire(typeof owner === 'string' && owner.length > 0, 'owner must be non-empty');
      contractRequire(mapping !== null && typeof mapping === 'object', 'mapping must be an object');
      return this.bindEnv(owner, mapping);
    });

    this.on('reveal', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      contractRequire(typeof name === 'string' && name.length > 0, 'name must be non-empty');
      const stored = this.secrets.get(name);
      if (!stored) throw new Error(`Secret "${name}" not found`);
      const value = await this.decrypt(stored);
      return { value, meta: stored.meta };
    });
  }

  // ─── Core operations ───────────────────────────────────────────

  private async storeSecret(name: string, value: string, meta: Partial<SecretMeta>): Promise<void> {
    contractRequire(this.vaultKey !== undefined, 'vault key not ready');
    const { iv, ciphertext } = await this.encrypt(value);
    const existing = this.secrets.get(name);
    const now = Date.now();
    const mergedMeta: SecretMeta = {
      name,
      description: meta.description ?? existing?.meta.description,
      owner: meta.owner ?? existing?.meta.owner,
      scope: meta.scope ?? existing?.meta.scope ?? 'global',
      expiresAt: meta.expiresAt ?? existing?.meta.expiresAt,
      createdAt: existing?.meta.createdAt ?? now,
      updatedAt: now,
    };
    this.secrets.set(name, { meta: mergedMeta, iv, ciphertext });
    await this.persistSecrets();
    this.changed('secretsChanged', { reason: 'stored', name });
    log.info(`Stored secret: ${name} (owner=${mergedMeta.owner ?? 'n/a'})`);
  }

  private async bindEnv(owner: string, mapping: Record<string, string>): Promise<{
    env: Record<string, string>;
    missing: string[];
  }> {
    const env: Record<string, string> = {};
    const missing: string[] = [];
    for (const [envVar, secretName] of Object.entries(mapping)) {
      const stored = this.secrets.get(secretName);
      if (!stored) {
        missing.push(secretName);
        continue;
      }
      // Light policy: if the secret declares an owner, only let that owner
      // bind it. Absent owner = globally available.
      if (stored.meta.owner && stored.meta.owner !== owner) {
        missing.push(secretName);
        continue;
      }
      try {
        env[envVar] = await this.decrypt(stored);
      } catch (err) {
        log.warn(`Failed to decrypt secret ${secretName}: ${err instanceof Error ? err.message : String(err)}`);
        missing.push(secretName);
      }
    }
    return { env, missing };
  }

  // ─── Crypto ─────────────────────────────────────────────────────

  private async loadOrCreateVaultKey(): Promise<void> {
    if (!this.storageId) {
      // Fall back to in-memory-only key. Secrets won't survive restart without Storage.
      this.vaultKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt'],
      );
      return;
    }

    try {
      const existing = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: VAULT_KEY_STORAGE_KEY }),
      );
      if (typeof existing === 'string' && existing.length > 0) {
        const raw = base64ToBytes(existing);
        this.vaultKey = await crypto.subtle.importKey(
          'raw',
          raw as BufferSource,
          { name: 'AES-GCM' },
          false,
          ['encrypt', 'decrypt'],
        );
        return;
      }
    } catch { /* fall through to key generation */ }

    // First run: generate + persist.
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    this.vaultKey = key;
    try {
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
      await this.request(
        request(this.id, this.storageId, 'set', {
          key: VAULT_KEY_STORAGE_KEY,
          value: bytesToBase64(raw),
        }),
      );
    } catch (err) {
      log.warn(`Failed to persist vault key: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async encrypt(plaintext: string): Promise<{ iv: string; ciphertext: string }> {
    contractRequire(this.vaultKey !== undefined, 'vault key not ready');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        this.vaultKey!,
        new TextEncoder().encode(plaintext) as BufferSource,
      ),
    );
    return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(cipher) };
  }

  private async decrypt(stored: StoredSecret): Promise<string> {
    contractRequire(this.vaultKey !== undefined, 'vault key not ready');
    const iv = base64ToBytes(stored.iv);
    const cipher = base64ToBytes(stored.ciphertext);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      this.vaultKey!,
      cipher as BufferSource,
    );
    return new TextDecoder().decode(plain);
  }

  // ─── Persistence ───────────────────────────────────────────────

  private async loadSecrets(): Promise<void> {
    if (!this.storageId) return;
    try {
      const raw = await this.request<unknown>(
        request(this.id, this.storageId, 'get', { key: SECRETS_STORAGE_KEY }),
      );
      if (raw && typeof raw === 'object') {
        const records = raw as Record<string, StoredSecret>;
        for (const [name, entry] of Object.entries(records)) {
          if (!entry || typeof entry !== 'object') continue;
          if (typeof entry.iv !== 'string' || typeof entry.ciphertext !== 'string') continue;
          if (!entry.meta || typeof entry.meta.name !== 'string') continue;
          this.secrets.set(name, entry);
        }
        log.info(`Loaded ${this.secrets.size} secrets`);
      }
    } catch { /* storage not ready */ }
  }

  private async persistSecrets(): Promise<void> {
    if (!this.storageId) return;
    const records: Record<string, StoredSecret> = {};
    for (const [name, stored] of this.secrets) records[name] = stored;
    try {
      await this.request(
        request(this.id, this.storageId, 'set', { key: SECRETS_STORAGE_KEY, value: records }),
      );
    } catch { /* best effort */ }
  }
}

// ─── Base64 helpers ──────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  if (typeof btoa !== 'undefined') return btoa(binary);
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob !== 'undefined') {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}
