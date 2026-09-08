/** JSON persistence for agent-owned Maps and Sets. Promises/deferred replies are not continuations. */
export function encodeAgentState(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, v) => {
    if (key === 'deferredMsg' || v instanceof Promise || typeof v === 'function') return undefined;
    if (v instanceof Map) return { $abjectMap: [...v] };
    if (v instanceof Set) return { $abjectSet: [...v] };
    return v;
  }));
}
export function decodeAgentState<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value), (_key, v) => {
    if (v && typeof v === 'object' && Object.keys(v).length === 1) {
      if (Array.isArray(v.$abjectMap)) return new Map(v.$abjectMap);
      if (Array.isArray(v.$abjectSet)) return new Set(v.$abjectSet);
    }
    return v;
  }) as T;
}
