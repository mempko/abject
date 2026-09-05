/**
 * The exposure predicate — the single question "may a remote caller see this
 * object?" — written once so that every consumer asks it identically.
 *
 * Curation used to be keyed on `AbjectId` alone. AbjectIds are ephemeral: an
 * object is re-spawned with a fresh id every time the host restarts, so a
 * whitelist recorded before a restart resolved to nothing afterwards and a
 * curated workspace silently published an empty catalog. Durable curation is
 * therefore keyed on the object's **registered name** and **typeId** as well,
 * both of which survive id churn.
 *
 * Two call sites have to agree by construction or curation drifts apart:
 *   - `Registry.isExposedToRemote` (the PULL side: what a remote caller may
 *     read out of this host's registry), and
 *   - `WorkspaceShareRegistry.applyCuration` (the PUSH side: what leaves this
 *     host in a catalog snapshot or delta).
 * Both import `matchesExposureSelectors` from here rather than restating it.
 */

/** Durable curation selectors. Any one of the three may match. */
export interface ExposureSelectorsInput {
  /** Ephemeral AbjectIds — still honoured, but only valid within one run. */
  ids?: readonly string[];
  /** Durable typeIds (`.../<Name>`), stable across restarts. */
  typeIds?: readonly string[];
  /** Durable registered names, stable across restarts. */
  names?: readonly string[];
}

/** Normalized selector sets, ready for repeated membership tests. */
export interface ExposureSelectors {
  ids: Set<string>;
  typeIds: Set<string>;
  names: Set<string>;
}

/** The shape the predicate needs from a registration. */
export interface ExposureCandidate {
  id: string;
  typeId?: string;
  manifest?: { name?: string } | undefined;
}

/** Build the normalized selector sets from a wire payload. */
export function normalizeExposureSelectors(input: ExposureSelectorsInput | undefined): ExposureSelectors {
  return {
    ids: new Set((input?.ids ?? []).filter(Boolean) as string[]),
    typeIds: new Set((input?.typeIds ?? []).filter(Boolean) as string[]),
    names: new Set((input?.names ?? []).filter(Boolean) as string[]),
  };
}

/** True when no selector at all was supplied — "nothing is curated". */
export function isExposureEmpty(sel: ExposureSelectors): boolean {
  return sel.ids.size === 0 && sel.typeIds.size === 0 && sel.names.size === 0;
}

/**
 * THE predicate. An object is exposed when its ephemeral id, its durable
 * typeId, or its durable registered name is on the curated list.
 */
export function matchesExposureSelectors(
  reg: ExposureCandidate | null | undefined,
  sel: ExposureSelectors,
): boolean {
  if (!reg) return false;
  if (sel.ids.has(reg.id)) return true;
  if (reg.typeId !== undefined && sel.typeIds.has(reg.typeId)) return true;
  const name = reg.manifest?.name;
  if (name !== undefined && sel.names.has(name)) return true;
  return false;
}

/**
 * A workspace typeId is `<workspace scope>/<ObjectName>` (see
 * `WorkspaceManager.computeTypeId`), so the registered name is recoverable
 * from it. This lets curation carry durable names without a second bookkeeping
 * map on every spawn path.
 */
export function nameFromTypeId(typeId: string | undefined): string | undefined {
  if (!typeId) return undefined;
  const idx = typeId.lastIndexOf('/');
  const name = idx >= 0 ? typeId.slice(idx + 1) : typeId;
  return name.length > 0 ? name : undefined;
}

/** Derive the durable name list that accompanies a set of typeIds. */
export function namesFromTypeIds(typeIds: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const t of typeIds ?? []) {
    const n = nameFromTypeId(t);
    if (n) out.add(n);
  }
  return [...out];
}
