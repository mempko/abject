/**
 * Optional WebSocket authentication & session management.
 *
 * Enabled only when both ABJECTS_AUTH_USER and ABJECTS_AUTH_PASSWORD
 * environment variables are set. When enabled, incoming WebSocket
 * connections must authenticate before any messages reach BackendUI.
 */

import crypto from 'node:crypto';
import type { WebSocket } from 'ws';

// =============================================================================
// Configuration
// =============================================================================

export interface AuthConfig {
  enabled: boolean;
  username: string;
  password: string;
}

/**
 * Load auth config from environment variables.
 * Auth is enabled only when both ABJECTS_AUTH_USER and ABJECTS_AUTH_PASSWORD are set.
 */
export function loadAuthConfig(): AuthConfig {
  const username = process.env.ABJECTS_AUTH_USER ?? '';
  const password = process.env.ABJECTS_AUTH_PASSWORD ?? '';
  const enabled = username.length > 0 && password.length > 0;
  return { enabled, username, password };
}

// =============================================================================
// Session Store
// =============================================================================

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface Session {
  token: string;
  createdAt: number;
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  createSession(): string {
    const token = crypto.randomUUID();
    this.sessions.set(token, { token, createdAt: Date.now() });
    return token;
  }

  validateSession(token: string): boolean {
    const session = this.sessions.get(token);
    if (!session) return false;
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  clearAll(): void {
    this.sessions.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (now - session.createdAt > SESSION_TTL_MS) {
        this.sessions.delete(token);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.sessions.clear();
  }
}

// =============================================================================
// Credential validation (timing-safe)
// =============================================================================

function timingSafeCompare(a: string, b: string): boolean {
  // Pad to equal length to avoid leaking length info
  const maxLen = Math.max(a.length, b.length);
  const bufA = Buffer.alloc(maxLen);
  const bufB = Buffer.alloc(maxLen);
  bufA.write(a);
  bufB.write(b);
  return crypto.timingSafeEqual(bufA, bufB) && a.length === b.length;
}

function validateCredentials(
  username: string,
  password: string,
  config: AuthConfig
): boolean {
  return (
    timingSafeCompare(username, config.username) &&
    timingSafeCompare(password, config.password)
  );
}

// =============================================================================
// Connection authenticator
// =============================================================================

const AUTH_TIMEOUT_MS = 30_000; // 30 seconds

export type AuthResult = 'authenticated' | 'rejected' | 'timeout';

/**
 * Run the auth handshake on a raw WebSocket connection.
 *
 * Sends `authRequired`, then waits for the client to send either
 * `{ type: 'auth', token }` or `{ type: 'auth', username, password }`.
 * Returns a promise that resolves when auth succeeds, fails, or times out.
 * On success, resolves with the session token.
 */
export function authenticateConnection(
  ws: WebSocket,
  config: AuthConfig,
  sessions: SessionStore,
): Promise<{ result: AuthResult; token?: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve({ result: 'timeout' });
    }, AUTH_TIMEOUT_MS);

    function cleanup(): void {
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      ws.removeListener('close', onClose);
    }

    function onClose(): void {
      cleanup();
      resolve({ result: 'rejected' });
    }

    function onMessage(data: unknown): void {
      try {
        const raw = typeof data === 'string' ? data : String(data);
        const msg = JSON.parse(raw);

        if (msg.type !== 'auth') {
          // Silently drop non-auth messages during handshake
          return;
        }

        // Token-based session resume
        if (msg.token && typeof msg.token === 'string') {
          if (sessions.validateSession(msg.token)) {
            cleanup();
            ws.send(JSON.stringify({ type: 'authResult', success: true, token: msg.token }));
            resolve({ result: 'authenticated', token: msg.token });
            return;
          }
          // Invalid token — tell client, allow retry
          ws.send(JSON.stringify({ type: 'authResult', success: false, error: 'Invalid or expired session' }));
          return;
        }

        // Username/password login
        if (msg.username && msg.password) {
          if (validateCredentials(msg.username, msg.password, config)) {
            cleanup();
            const token = sessions.createSession();
            ws.send(JSON.stringify({ type: 'authResult', success: true, token }));
            resolve({ result: 'authenticated', token });
            return;
          }
          // Bad credentials — allow retry
          ws.send(JSON.stringify({ type: 'authResult', success: false, error: 'Invalid credentials' }));
          return;
        }

        // Malformed auth message
        ws.send(JSON.stringify({ type: 'authResult', success: false, error: 'Invalid auth message' }));
      } catch {
        // Ignore unparseable messages
      }
    }

    ws.on('message', onMessage);
    ws.on('close', onClose);

    // Kick off the handshake
    ws.send(JSON.stringify({ type: 'authRequired' }));
  });
}
