/**
 * Redaction of recorded text. Shared by everything that records what objects
 * say to each other (HttpClient's exchanges, ScriptableAbject's invocations),
 * so one rule decides what a credential looks like.
 *
 * Moved verbatim from objects/capabilities/http-client.ts, where it was
 * written for the traffic recorder (mempko/abject#12).
 */

/** Stem match on the NAME of a header, query param, or body field. Stems
 *  rather than exact names, so client_secret, refresh_token, x-amz-security-
 *  token, and whatever header a generated object invents all match; a false
 *  positive redacts something harmless, a false negative persists a live
 *  credential, so this errs toward matching. (`auth(?!or\b)` keeps
 *  authorization in while leaving author alone.) */
export const SECRET_NAME_STEM = /key|token|secret|passw|credential|session|signature|cookie|auth(?!or\b)/i;

/** Secret-bearing query params and headers are replaced, never dropped:
 *  the shape of the request stays visible, the credential does not. */
export function redactUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    let touched = false;
    for (const name of Array.from(u.searchParams.keys())) {
      if (SECRET_NAME_STEM.test(name)) {
        u.searchParams.set(name, 'REDACTED');
        touched = true;
      }
    }
    return touched ? u.toString() : rawUrl;
  } catch {
    return rawUrl.split('?')[0];
  }
}

export function redactHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SECRET_NAME_STEM.test(name) ? 'REDACTED' : value;
  }
  return out;
}

/** Field-level scrub of body TEXT: the value of any JSON string field or
 *  form-encoded field whose NAME matches the secret stems is replaced. No
 *  JSON.parse on this path, ever. Name-based, so it catches named fields
 *  (access_token, client_secret, password), not a secret embedded in free
 *  text under an innocent name. Only string VALUES are rewritten:
 *  `"pin": 1234` or `"token": null` pass through.
 *
 *  Linear in the body length, whatever its shape. This runs synchronously on
 *  a shared pool worker over bodies of any size, so a superlinear scrub
 *  stalls every object co-located with HttpClient. */
export function redactBodyText(body: string, headers?: Record<string, string>): string {
  const scrubbed = redactJsonStringFields(body);
  return isFormEncoded(scrubbed, headers) ? redactFormFields(scrubbed) : scrubbed;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;

/** One left-to-right pass over the unescaped quotes. Every quote is tried as
 *  the opening of a key, so a stray quote in non-JSON text does not hide the
 *  fields after it. Escaped quotes are never tried: a regex that retried
 *  from each `\"` rescanned to the end of the enclosing string every time,
 *  quadratic in bodies such as double-encoded JSON (seconds per 64 KB). */
function redactJsonStringFields(body: string): string {
  const parts: string[] = [];
  let copied = 0;
  // The last three unescaped quotes. With the next one they frame a candidate
  // "key" : "value" pair: key is (q0, q1), value is (q2, next).
  let q0 = -1;
  let q1 = -1;
  let q2 = -1;
  let colonBetweenQ1Q2 = false;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (c === BACKSLASH) { i++; continue; }
    if (c !== QUOTE) continue;
    if (q0 >= 0 && colonBetweenQ1Q2 && SECRET_NAME_STEM.test(body.slice(q0 + 1, q1))) {
      parts.push(body.slice(copied, q2 + 1), 'REDACTED');
      copied = i;
    }
    q0 = q1;
    q1 = q2;
    q2 = i;
    colonBetweenQ1Q2 = q1 >= 0 && isKeyValueSeparator(body, q1 + 1, q2);
  }
  if (copied === 0) return body;
  parts.push(body.slice(copied));
  return parts.join('');
}

/** True when body[from, to) is JSON whitespace around exactly one colon.
 *  Stops at the first other character, so each gap is walked at most once. */
function isKeyValueSeparator(body: string, from: number, to: number): boolean {
  let colon = false;
  for (let i = from; i < to; i++) {
    const c = body.charCodeAt(i);
    if (c === COLON && !colon) colon = true;
    else if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return false;
  }
  return colon;
}

/** Form fields are scrubbed only in form-encoded bodies. Run over JSON or
 *  HTML, a `name=value` pattern stretches across the markup and replaces
 *  everything up to the next `&`, truncating the recorded body. A body
 *  counts as form-encoded when its content-type says so, or when it has the
 *  shape: an `=`, and none of the characters encoding would have escaped. */
function isFormEncoded(body: string, headers?: Record<string, string>): boolean {
  const declared = Object.entries(headers ?? {}).some(([name, value]) =>
    name.toLowerCase() === 'content-type' && /application\/x-www-form-urlencoded/i.test(value));
  return declared || (body.includes('=') && !/[\s"<>{}[\]]/.test(body));
}

/** Anchored on `&` alone: each attempt scans one field, so the pass is linear.
 *  Query strings are not body text; redactUrl covers those. */
const FORM_FIELD = /(^|&)([^=&]*)=([^&]*)/g;

function redactFormFields(body: string): string {
  return body.replace(FORM_FIELD, (m, lead: string, name: string) =>
    SECRET_NAME_STEM.test(name) ? `${lead}${name}=REDACTED` : m);
}
