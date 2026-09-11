/**
 * Canonical serialization for hashing. Two readings of the same value must
 * hash identically regardless of property insertion order, or digests start
 * disagreeing about facts that have not changed.
 */
import { createHash } from 'node:crypto';

/** JSON with object keys sorted recursively; array order is preserved
 *  (element order is meaning, key order is accident). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v as object).sort();
    return `{${keys.map(k =>
      `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
