/**
 * Which web pages may open a WebSocket to a local gateway.
 *
 * Browsers put the page's origin on every WebSocket handshake, and a page can
 * neither change nor drop it. The UI socket (WS_PORT) and the CLI gateway bind
 * loopback (the CLI gateway unless CLI_BIND says otherwise) and, unless a
 * login is set (ABJECTS_AUTH_USER/PASSWORD or one saved in Settings),
 * authenticate nothing, so without this check any site open in any browser on the machine
 * could connect to them and drive the desktop: send chat messages to agents,
 * answer the permission dialogs those agents raise.
 *
 * The policy is an exact allowlist. Accepting any page whose origin matches
 * the Host header is not enough: a page that rebinds its own DNS name to
 * 127.0.0.1 is same-origin by that test.
 *
 * Clients that are not browsers (the `abject` command, scripts, health probes) send no
 * Origin and are not judged here. They are local processes; keeping other
 * local users out is a job for authentication, not for this check.
 */

import { require as contractRequire } from '../core/contracts.js';

/** Decides whether a page of this origin may open the socket. */
export type OriginPolicy = (origin: string) => boolean;

/** For gateways no browser client uses, such as the CLI gateway. */
export const refuseAllOrigins: OriginPolicy = () => false;

/** Port of the Vite dev client (`pnpm scry`) when VITE_CLIENT_PORT is unset. */
export const DEFAULT_DEV_CLIENT_PORT = 5174;

/**
 * An origin in canonical form (lowercase scheme and host, default port
 * dropped, no path), or undefined when it is not an http(s) origin. The
 * opaque origin `null` (sandboxed frames, file: pages) is never an origin
 * anyone can be allowed as.
 */
export function canonicalOrigin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return url.origin;
}

/** Allow pages of exactly these origins and no others. */
export function allowOrigins(origins: Iterable<string>): OriginPolicy {
  const allowed = new Set<string>();
  for (const origin of origins) {
    const canonical = canonicalOrigin(origin);
    contractRequire(canonical !== undefined, `not an http(s) origin: ${origin}`);
    allowed.add(canonical);
  }
  return (origin) => {
    const canonical = canonicalOrigin(origin);
    return canonical !== undefined && allowed.has(canonical);
  };
}

/** The origins the browser client is served from, and the entries refused. */
export interface ClientOrigins {
  origins: string[];
  /** ABJECTS_ALLOWED_ORIGINS entries that are not http(s) origins. */
  ignored: string[];
}

/**
 * The origins the UI socket accepts pages from:
 *
 * - `ABJECTS_CLIENT_ORIGIN`: the desktop app's own client server, whose port
 *   is chosen at launch (set by electron/main.ts before the backend starts).
 * - The Vite dev client (`pnpm scry`): 127.0.0.1 and localhost on
 *   VITE_CLIENT_PORT, default 5174. Not in the packaged desktop app, which
 *   has no dev client. A second instance gives its backend the port of its
 *   own dev client (see the awaken2/awaken3 scripts).
 * - `ABJECTS_ALLOWED_ORIGINS`: anything else, such as a client served over
 *   HTTPS from a reverse proxy that forwards /ws to this backend. Entries are
 *   separated by commas or spaces.
 */
export function clientOriginsFromEnv(env: Record<string, string | undefined>): ClientOrigins {
  const origins: string[] = [];
  const ignored: string[] = [];

  const desktop = env.ABJECTS_CLIENT_ORIGIN ? canonicalOrigin(env.ABJECTS_CLIENT_ORIGIN) : undefined;
  if (desktop) origins.push(desktop);

  if (env.ELECTRON_PACKAGED !== '1') {
    const port = parseInt(env.VITE_CLIENT_PORT ?? String(DEFAULT_DEV_CLIENT_PORT), 10);
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      origins.push(`http://127.0.0.1:${port}`, `http://localhost:${port}`);
    }
  }

  for (const entry of (env.ABJECTS_ALLOWED_ORIGINS ?? '').split(/[\s,]+/).filter(Boolean)) {
    const canonical = canonicalOrigin(entry);
    if (canonical) origins.push(canonical);
    else ignored.push(entry);
  }

  return { origins: [...new Set(origins)], ignored };
}
