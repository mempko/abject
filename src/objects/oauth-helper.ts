/**
 * OAuthHelper -- browser-based OAuth 2.0 + PKCE flow for connecting the
 * vault to external providers (Google, GitHub, Microsoft, anything that
 * speaks standard OAuth 2.0 + PKCE).
 *
 * The flow:
 *   1. Caller invokes `authorize(providerConfig)`.
 *   2. We generate a PKCE verifier, open a one-shot localhost listener on
 *      a random port, launch the user's default browser at the provider's
 *      authorize URL, and wait for the callback.
 *   3. On callback we exchange the code for tokens using HttpClient.
 *   4. Tokens (access_token, refresh_token, expires_at) land in SecretsVault
 *      under well-defined names scoped to the provider.
 *
 * No client IDs ship with the product. Each user registers their own
 * OAuth app for each provider and configures it here. This keeps Abjects
 * out of the loop as a credential-issuing party.
 */

import * as http from 'http';
import { spawn } from 'child_process';
import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { require as contractRequire } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';

const log = new Log('OAuthHelper');

const OAUTH_HELPER_INTERFACE: InterfaceId = 'abjects:oauth-helper';
const ACCOUNTS_STORAGE_KEY = 'oauth:accounts';
const FLOW_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes to complete a flow

export const OAUTH_HELPER_ID = 'abjects:oauth-helper' as AbjectId;

export interface OAuthProviderConfig {
  /** Stable identifier. Secrets land under `oauth:{provider}:access_token`, etc. */
  provider: string;
  /** Optional: display name of the account (e.g. the email). If userinfoEndpoint
   *  is set we'll try to fetch it; otherwise the caller can pass `accountLabel`. */
  accountLabel?: string;
  clientId: string;
  /** Some providers (GitHub web app) require a secret even with PKCE. */
  clientSecret?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Optional endpoint returning {email}/{name} so we can label the account. */
  userinfoEndpoint?: string;
  scopes: string[];
  /** Extra params to append to the authorize URL (e.g. `access_type=offline`). */
  extraAuthorizeParams?: Record<string, string>;
}

export interface ConnectedAccount {
  provider: string;
  account: string;
  scopes: string[];
  connectedAt: number;
  expiresAt?: number;
}

/** Pending flow state. */
interface PendingFlow {
  config: OAuthProviderConfig;
  verifier: string;
  state: string;
  redirectUri: string;
  server: http.Server;
  resolve: (account: ConnectedAccount) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class OAuthHelper extends Abject {
  private httpClientId?: AbjectId;
  private secretsVaultId?: AbjectId;
  private storageId?: AbjectId;
  private accounts = new Map<string, ConnectedAccount>();
  /** Keyed by state param so the callback can resolve the right flow. */
  private flows = new Map<string, PendingFlow>();

  constructor() {
    super({
      manifest: {
        name: 'OAuthHelper',
        description:
          'Runs OAuth 2.0 + PKCE flows in the user\'s default browser, ' +
          'captures the callback on a one-shot localhost listener, and ' +
          'stores resulting tokens in SecretsVault. User supplies their own ' +
          'OAuth client credentials; no client IDs ship with the product.',
        version: '1.0.0',
        interface: {
          id: OAUTH_HELPER_INTERFACE,
          name: 'OAuthHelper',
          description: 'Interactive OAuth flows',
          methods: [
            {
              name: 'authorize',
              description: 'Start an OAuth authorization flow. Opens the user\'s default browser and waits for the callback.',
              parameters: [
                { name: 'config', type: { kind: 'reference', reference: 'OAuthProviderConfig' }, description: 'Provider configuration' },
              ],
              returns: { kind: 'reference', reference: 'ConnectedAccount' },
            },
            {
              name: 'disconnect',
              description: 'Remove a connected account and forget its tokens.',
              parameters: [
                { name: 'provider', type: { kind: 'primitive', primitive: 'string' }, description: 'Provider id' },
              ],
              returns: { kind: 'object', properties: { disconnected: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'listConnected',
              description: 'List all currently connected accounts (metadata only).',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'ConnectedAccount' } },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'auth', 'oauth'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.httpClientId = await this.discoverDep('HttpClient') ?? undefined;
    this.secretsVaultId = await this.discoverDep('SecretsVault') ?? undefined;
    this.storageId = await this.discoverDep('Storage') ?? undefined;
    await this.loadAccounts();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## OAuthHelper Usage Guide

Runs OAuth 2.0 + PKCE flows interactively. User must supply their own
OAuth client credentials; no secrets ship with Abjects.

### Connect a provider

  const account = await call(await dep('OAuthHelper'), 'authorize', {
    config: {
      provider: 'google',
      clientId: '<user-registered-client-id>',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      userinfoEndpoint: 'https://www.googleapis.com/oauth2/v2/userinfo',
      scopes: ['openid', 'email', 'profile'],
      extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
    },
  });
  // account: { provider, account, scopes, connectedAt, expiresAt? }

### List connected accounts

  const accounts = await call(await dep('OAuthHelper'), 'listConnected', {});

### Disconnect

  await call(await dep('OAuthHelper'), 'disconnect', { provider: 'google' });

### Token storage

Tokens land in SecretsVault under:
  - oauth:{provider}:access_token
  - oauth:{provider}:refresh_token (if provider issues one)

MCPs and skills can pull them via SecretsVault.bindEnv mappings.

### IMPORTANT
- The interface ID is '${OAUTH_HELPER_INTERFACE}'.
- Opens the user's default browser; flow times out after 5 minutes.
- PKCE is always used; clientSecret only sent if the config includes one.`;
  }

  // ─── Handlers ───────────────────────────────────────────────────

  private setupHandlers(): void {
    this.on('authorize', async (msg: AbjectMessage) => {
      const { config } = msg.payload as { config: OAuthProviderConfig };
      return this.authorize(config);
    });

    this.on('disconnect', async (msg: AbjectMessage) => {
      const { provider } = msg.payload as { provider: string };
      contractRequire(typeof provider === 'string' && provider.length > 0, 'provider must be non-empty');
      return this.disconnect(provider);
    });

    this.on('listConnected', async () => {
      return [...this.accounts.values()];
    });
  }

  // ─── Flow ──────────────────────────────────────────────────────

  private async authorize(config: OAuthProviderConfig): Promise<ConnectedAccount> {
    validateConfig(config);

    const verifier = randomUrlSafe(64);
    const challenge = await sha256Base64Url(verifier);
    const state = randomUrlSafe(24);

    // Spin up a one-shot listener on an ephemeral port.
    const { server, port } = await listenEphemeral((req, res) => this.handleCallback(req, res, state));
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    const params = new URLSearchParams();
    params.set('response_type', 'code');
    params.set('client_id', config.clientId);
    params.set('redirect_uri', redirectUri);
    params.set('scope', config.scopes.join(' '));
    params.set('state', state);
    params.set('code_challenge', challenge);
    params.set('code_challenge_method', 'S256');
    for (const [k, v] of Object.entries(config.extraAuthorizeParams ?? {})) {
      params.set(k, v);
    }
    const authUrl = `${config.authorizationEndpoint}?${params.toString()}`;

    return new Promise<ConnectedAccount>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finishFlow(state, new Error('OAuth flow timed out'));
      }, FLOW_TIMEOUT_MS);

      this.flows.set(state, {
        config,
        verifier,
        state,
        redirectUri,
        server,
        resolve,
        reject,
        timer,
      });

      openBrowser(authUrl).catch(err => {
        log.warn(`Failed to launch browser: ${err.message}. URL: ${authUrl}`);
        // Don't reject; user can paste the URL manually. Log it so they can.
        log.info(`Authorize URL: ${authUrl}`);
      });
    });
  }

  private async handleCallback(req: http.IncomingMessage, res: http.ServerResponse, expectedState: string): Promise<void> {
    const fullUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!fullUrl.pathname.startsWith('/callback')) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    const params = fullUrl.searchParams;
    const state = params.get('state');
    if (!state || state !== expectedState) {
      res.statusCode = 400;
      res.end('Invalid state');
      return;
    }

    const pending = this.flows.get(state);
    if (!pending) {
      res.statusCode = 400;
      res.end('No pending flow for this state');
      return;
    }

    const error = params.get('error');
    if (error) {
      const description = params.get('error_description') ?? '';
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html(`<h1>Authorization failed</h1><p>${escapeHtml(error)}: ${escapeHtml(description)}</p>`));
      this.finishFlow(state, new Error(`OAuth error: ${error} (${description})`));
      return;
    }

    const code = params.get('code');
    if (!code) {
      res.statusCode = 400;
      res.end('Missing code');
      return;
    }

    try {
      const account = await this.completeFlow(pending, code);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html(`<h1>${escapeHtml(account.provider)} connected</h1><p>Account: ${escapeHtml(account.account)}</p><p>You can close this tab.</p>`));
      this.finishFlow(state, null, account);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html(`<h1>Token exchange failed</h1><p>${escapeHtml(msg)}</p>`));
      this.finishFlow(state, new Error(msg));
    }
  }

  private async completeFlow(pending: PendingFlow, code: string): Promise<ConnectedAccount> {
    contractRequire(this.httpClientId !== undefined, 'HttpClient not available');

    const { config, verifier, redirectUri } = pending;

    const form = new URLSearchParams();
    form.set('grant_type', 'authorization_code');
    form.set('code', code);
    form.set('redirect_uri', redirectUri);
    form.set('client_id', config.clientId);
    form.set('code_verifier', verifier);
    if (config.clientSecret) form.set('client_secret', config.clientSecret);

    const tokenRes = await this.request<{ ok: boolean; status: number; body: string }>(
      request(this.id, this.httpClientId!, 'post', {
        url: config.tokenEndpoint,
        body: form.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
      }),
      20000,
    );
    if (!tokenRes.ok) {
      throw new Error(`Token endpoint ${tokenRes.status}: ${tokenRes.body.slice(0, 200)}`);
    }

    let tokens: Record<string, unknown>;
    try {
      tokens = JSON.parse(tokenRes.body) as Record<string, unknown>;
    } catch {
      throw new Error('Token endpoint returned non-JSON');
    }

    const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : undefined;
    if (!accessToken) throw new Error('Token response missing access_token');
    const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined;
    const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : undefined;
    const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : undefined;

    // Optional account label via userinfo.
    let accountLabel = config.accountLabel ?? config.provider;
    if (config.userinfoEndpoint) {
      try {
        const info = await this.request<{ ok: boolean; status: number; body: string }>(
          request(this.id, this.httpClientId!, 'get', {
            url: config.userinfoEndpoint,
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
          }),
          15000,
        );
        if (info.ok) {
          const parsed = JSON.parse(info.body) as Record<string, unknown>;
          accountLabel = typeof parsed.email === 'string' ? parsed.email
            : typeof parsed.login === 'string' ? parsed.login
            : typeof parsed.name === 'string' ? parsed.name
            : accountLabel;
        }
      } catch { /* non-fatal */ }
    }

    // Store tokens in SecretsVault.
    await this.storeToken(config.provider, 'access_token', accessToken, expiresAt);
    if (refreshToken) {
      await this.storeToken(config.provider, 'refresh_token', refreshToken);
    }

    const account: ConnectedAccount = {
      provider: config.provider,
      account: accountLabel,
      scopes: config.scopes,
      connectedAt: Date.now(),
      expiresAt,
    };
    this.accounts.set(config.provider, account);
    await this.persistAccounts();
    this.changed('accountsChanged', { reason: 'connected', provider: config.provider });
    log.info(`Connected ${config.provider} as ${accountLabel}`);
    return account;
  }

  private async storeToken(provider: string, kind: 'access_token' | 'refresh_token', value: string, expiresAt?: number): Promise<void> {
    if (!this.secretsVaultId) {
      log.warn('SecretsVault not available; dropping token');
      return;
    }
    const name = `oauth:${provider}:${kind}`;
    await this.request(
      request(this.id, this.secretsVaultId, 'store', {
        name,
        value,
        meta: {
          owner: `oauth:${provider}`,
          description: `${provider} ${kind}`,
          scope: 'global',
          expiresAt,
        },
      }),
    );
  }

  private async disconnect(provider: string): Promise<{ disconnected: boolean }> {
    if (!this.accounts.has(provider)) return { disconnected: false };
    this.accounts.delete(provider);
    await this.persistAccounts();
    if (this.secretsVaultId) {
      for (const kind of ['access_token', 'refresh_token'] as const) {
        try {
          await this.request(
            request(this.id, this.secretsVaultId, 'forget', { name: `oauth:${provider}:${kind}` }),
          );
        } catch { /* best effort */ }
      }
    }
    this.changed('accountsChanged', { reason: 'disconnected', provider });
    log.info(`Disconnected ${provider}`);
    return { disconnected: true };
  }

  private finishFlow(state: string, err: Error | null, account?: ConnectedAccount): void {
    const pending = this.flows.get(state);
    if (!pending) return;
    this.flows.delete(state);
    clearTimeout(pending.timer);
    try { pending.server.close(); } catch { /* already closing */ }
    if (err) pending.reject(err);
    else if (account) pending.resolve(account);
  }

  // ─── Storage ────────────────────────────────────────────────────

  private async loadAccounts(): Promise<void> {
    if (!this.storageId) return;
    try {
      const raw = await this.request<unknown>(
        request(this.id, this.storageId, 'get', { key: ACCOUNTS_STORAGE_KEY }),
      );
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (!item || typeof item !== 'object') continue;
          const a = item as ConnectedAccount;
          if (typeof a.provider === 'string' && typeof a.account === 'string') {
            this.accounts.set(a.provider, a);
          }
        }
      }
    } catch { /* not available */ }
  }

  private async persistAccounts(): Promise<void> {
    if (!this.storageId) return;
    const list = [...this.accounts.values()];
    try {
      await this.request(
        request(this.id, this.storageId, 'set', { key: ACCOUNTS_STORAGE_KEY, value: list }),
      );
    } catch { /* best effort */ }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function validateConfig(config: OAuthProviderConfig): void {
  contractRequire(typeof config === 'object' && config !== null, 'config must be an object');
  contractRequire(typeof config.provider === 'string' && config.provider.length > 0, 'provider required');
  contractRequire(typeof config.clientId === 'string' && config.clientId.length > 0, 'clientId required');
  contractRequire(typeof config.authorizationEndpoint === 'string' && /^https?:\/\//.test(config.authorizationEndpoint), 'authorizationEndpoint must be http(s)');
  contractRequire(typeof config.tokenEndpoint === 'string' && /^https?:\/\//.test(config.tokenEndpoint), 'tokenEndpoint must be http(s)');
  contractRequire(Array.isArray(config.scopes) && config.scopes.every(s => typeof s === 'string'), 'scopes must be string[]');
}

function randomUrlSafe(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToBase64Url(buf);
}

async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
  return bytesToBase64Url(hash);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = typeof btoa !== 'undefined' ? btoa(binary) : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function listenEphemeral(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try { handler(req, res); } catch (err) {
        log.warn(`Callback handler threw: ${err instanceof Error ? err.message : String(err)}`);
        try { res.statusCode = 500; res.end('Internal error'); } catch { /* socket gone */ }
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve({ server, port: addr.port });
      } else {
        reject(new Error('Failed to bind listener'));
      }
    });
  });
}

function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    const cmd = platform === 'darwin' ? 'open'
      : platform === 'win32' ? 'start'
      : 'xdg-open';
    const args = platform === 'win32' ? ['', url] : [url];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, shell: platform === 'win32' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function html(body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>OAuth</title>
<style>body{font:14px/1.5 system-ui,sans-serif;padding:40px;max-width:540px;margin:0 auto}h1{font-size:18px}p{color:#555}</style>
${body}`;
}
