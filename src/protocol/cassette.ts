/**
 * Cassette -- the evidence the fitness gate judges a candidate against.
 *
 * A cassette is one recorded truth: a request the object made, the response
 * the world gave, and the parsed answer the object produced from it. The
 * fitness gate replays cassettes against every candidate source; a candidate
 * that cannot reproduce recorded meaning does not deploy. Requests are
 * redacted before storage so a cassette can never leak a credential.
 */
import { canonicalJson, sha256 } from './canonical.js';

export interface CassetteRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface Cassette {
  method: string;
  args: Record<string, unknown>;
  request: CassetteRequest;
  /** Canonical hash of `request.body`, set by the store when the request
   *  carried one. Matching is symmetric on it: a body-less request matches
   *  only body-less recordings, so a caller cannot skip the body and pick up
   *  an answer that was recorded for a specific payload. */
  bodyHash?: string;
  response: { status: number; body: unknown };
  /** The response body EXACTLY as the world sent it, before any parsing.
   *  HttpClient's contract says `body` is always a raw string, so replay must
   *  hand back the same characters — `JSON.stringify(parsed)` is not the same
   *  text for a JSON string primitive, and the round-trip loses meaning. */
  rawBody: string;
  parsedOutput: unknown;
  recordedAt: number;
}

export const CASSETTE_CAP_PER_METHOD = 20;

/** The method name recorded for raw HTTP traffic. These cassettes are stubs
 *  for the object's own calls, never a method the fitness gate can replay. */
export const HTTP_CASSETTE_METHOD = '_http';

const REDACTED_HEADERS = new Set(['authorization', 'cookie', 'set-cookie']);
const SECRET_QUERY_PARAM = /^(key|api_key|token|access_token|secret|auth|apikey)$/i;

/** The canonical hash matching compares. `undefined` for a body-less
 *  request -- and only for one. */
export function requestBodyHash(body: unknown): string | undefined {
  return body === undefined ? undefined : sha256(canonicalJson(body));
}

export function redactRequest(req: CassetteRequest): CassetteRequest {
  let out = req;
  if (out.headers) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(out.headers)) {
      if (!REDACTED_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
    out = { ...out, headers };
  }
  // Credentials travel in query strings too (?api_key=...); a cassette must
  // never store one.
  try {
    const u = new URL(out.url);
    let touched = false;
    for (const name of [...u.searchParams.keys()]) {
      if (SECRET_QUERY_PARAM.test(name)) { u.searchParams.set(name, 'REDACTED'); touched = true; }
    }
    if (touched) out = { ...out, url: u.toString() };
  } catch { /* unparseable url -- store as given */ }
  return out;
}

function hostPath(url: string): string | undefined {
  try { const u = new URL(url); return `${u.host}${u.pathname}`; } catch { return undefined; }
}

/** Cassettes recorded before `rawBody` existed derive it from the parsed
 *  body. Lossy for a JSON string primitive, but honest and never undefined. */
function rawBodyOf(c: Cassette): string {
  return typeof c.rawBody === 'string' ? c.rawBody : (JSON.stringify(c.response.body) ?? '');
}

function isCassette(c: unknown): c is Cassette {
  if (c === null || typeof c !== 'object') return false;
  const x = c as Record<string, unknown>;
  return typeof x.method === 'string'
    && x.args !== null && typeof x.args === 'object'
    && x.request !== null && typeof x.request === 'object'
    && typeof (x.request as Record<string, unknown>).url === 'string'
    && x.response !== null && typeof x.response === 'object'
    && typeof x.recordedAt === 'number';
}

export class CassetteStore {
  private cassettes: Cassette[] = [];

  constructor(initial?: Cassette[]) {
    for (const c of initial ?? []) this.add(c);
  }

  add(c: Cassette): void {
    this.cassettes.push({ ...c, request: redactRequest(c.request), rawBody: rawBodyOf(c),
      bodyHash: c.bodyHash ?? requestBodyHash(c.request.body) });
    const forMethod = this.cassettes.filter(x => x.method === c.method);
    if (forMethod.length > CASSETTE_CAP_PER_METHOD) {
      const evict = forMethod
        .sort((a, b) => a.recordedAt - b.recordedAt)
        .slice(0, forMethod.length - CASSETTE_CAP_PER_METHOD);
      this.cassettes = this.cassettes.filter(x => !evict.includes(x));
    }
  }

  byMethod(method: string): Cassette[] {
    return this.cassettes
      .filter(c => c.method === method)
      .sort((a, b) => a.recordedAt - b.recordedAt);
  }

  all(): Cassette[] { return [...this.cassettes]; }

  /** Exact method+url+body. Replay is argument-dependent: `?q=1` and
   *  `?q=other` are different questions, and answering one with the other's
   *  recording would let a candidate "reproduce" traffic it never made. The
   *  body comparison is symmetric -- a body-less request matches only
   *  body-less recordings -- so omitting the body is a miss, never a
   *  wildcard. */
  matchRequest(req: CassetteRequest): Cassette | undefined {
    const hash = requestBodyHash(req.body);
    return this.cassettes.find(
      c => c.request.method === req.method && c.request.url === req.url
        && c.bodyHash === hash);
  }

  /** Exact match, else any recording of the same host+path. Deliberately NOT
   *  used by the replay seam — kept for callers that want a representative
   *  sample of an endpoint rather than an answer to a specific question. */
  matchRequestLoose(req: CassetteRequest): Cassette | undefined {
    const exact = this.matchRequest(req);
    if (exact) return exact;
    const hp = hostPath(req.url);
    if (!hp) return undefined;
    return this.cassettes.find(
      c => c.request.method === req.method && hostPath(c.request.url) === hp);
  }

  toJSON(): Cassette[] { return this.all(); }

  static fromJSON(json: unknown): CassetteStore {
    const arr = Array.isArray(json) ? json.filter(isCassette) : [];
    return new CassetteStore(arr);
  }
}
