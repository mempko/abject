/**
 * Canonical JSON for comparing values that crossed a serialization boundary.
 * Two readings of the same value must compare equal regardless of property
 * insertion order: element order is meaning, key order is accident.
 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v as object).sort();
    return `{${keys.map(k =>
      `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Canonical form of a JSON TEXT; text that does not parse compares as itself. */
export function canonicalText(text: string): string {
  try { return canonicalJson(JSON.parse(text)); } catch { return text; }
}
