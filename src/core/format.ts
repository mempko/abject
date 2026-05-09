/**
 * Value-formatting helpers used wherever we render unknown values into
 * LLM prompts, log lines, or other string contexts.
 *
 * The default JS pattern `JSON.stringify(v).slice(0, N)` looks innocent but
 * crashes for `v === undefined` (or functions / symbols), because
 * `JSON.stringify(undefined) === undefined` and `undefined.slice` throws.
 * `safeStringify` collapses every input — strings, primitives, plain
 * objects, undefined, non-serializable values — to a usable string.
 */

/**
 * Coerce an unknown value to a string, never throwing and never returning
 * `undefined`.
 *
 * - Strings are returned as-is.
 * - `undefined` becomes the literal `"<undefined>"`.
 * - Anything else is `JSON.stringify`'d; if that returns `undefined`
 *   (functions, symbols, BigInts, circular refs that throw, etc.), falls
 *   back to `String(v)`.
 *
 * When `maxLen` is provided, truncates with a trailing `"... [truncated]"`
 * marker so the consumer can tell the value was clipped.
 */
export function safeStringify(v: unknown, maxLen?: number): string {
  let s: string;
  if (typeof v === 'string') {
    s = v;
  } else if (v === undefined) {
    s = '<undefined>';
  } else {
    let json: string | undefined;
    try {
      json = JSON.stringify(v);
    } catch {
      json = undefined;
    }
    s = typeof json === 'string' ? json : String(v);
  }
  if (maxLen !== undefined && s.length > maxLen) {
    return s.slice(0, maxLen) + '... [truncated]';
  }
  return s;
}
