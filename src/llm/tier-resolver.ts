/**
 * Recommended models per tier, picked from a provider's live catalog.
 *
 * Pinned model ids go stale with every release, so a provider instead
 * declares how to find each tier's model (`tierRules` on its description):
 * a moving alias the vendor maintains, else the newest model of a line, else
 * its pinned default. Catalogs that publish one moving alias per model line
 * (OpenRouter's `~vendor/line-latest`) also yield one ladder per vendor,
 * ranked by price, so a new vendor or a renamed line needs no code change.
 *
 * Everything here is a pure function of (description, catalog).
 */

import type { LLMProviderDescription, ModelInfo, ModelTier, TierRule } from './provider.js';

/** What resolution reads from a catalog entry; any model list carrying these fields will do. */
export type CatalogModel = Pick<ModelInfo, 'id' | 'name' | 'vision' | 'created' | 'pricing'>;

/** Tier routing model value meaning "the recommended model, re-resolved from the catalog". */
export const LATEST_MODEL = 'latest';

export const MODEL_TIERS: readonly ModelTier[] = ['smart', 'balanced', 'fast', 'code'];

export interface ResolvedTier {
  model: string;
  /** How it was found: a moving alias, the newest of a line, or the provider's pinned default. */
  source: 'alias' | 'family' | 'pinned';
}

export interface VendorLadder {
  /** Vendor slug from the alias ids (e.g. 'anthropic'). */
  vendor: string;
  /** Display name (e.g. 'Anthropic'), from the catalog's model names. */
  label: string;
  tiers: Record<ModelTier, string>;
  /** First vision-capable model of the ladder, smart down to fast. */
  vision?: string;
}

/** Variants never recommended: batch-only and rate-limited free routes. */
const NEVER = /:(batch|free)$/i;
/** Picked only when nothing else in the line matches. */
const LAST_RESORT = /(-preview|-exp)(\b|$)/i;

/**
 * Version numbers in an id, for ordering a line when the catalog has no
 * dates. An eight-digit number is a snapshot date, not a version: it only
 * breaks ties (dateKey), so `claude-haiku-4-5` and its dated snapshot rank
 * as the same release.
 */
function versionKey(id: string): number[] {
  return (id.match(/\d+/g) ?? []).filter(n => n.length < 8).map(Number);
}

function dateKey(id: string): number {
  return Math.max(0, ...(id.match(/\d{8,}/g) ?? []).map(Number));
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Newest first: catalog date when both have one, else version; then the
 * undated alias over its dated snapshot (the alias moves with fixes), then
 * the later snapshot.
 */
function newestFirst(a: CatalogModel, b: CatalogModel): number {
  if (a.created !== undefined && b.created !== undefined && a.created !== b.created) return b.created - a.created;
  const v = compareVersions(versionKey(b.id), versionKey(a.id));
  if (v !== 0) return v;
  const aDated = dateKey(a.id) > 0, bDated = dateKey(b.id) > 0;
  if (aDated !== bDated) return aDated ? 1 : -1;
  return dateKey(b.id) - dateKey(a.id) || a.id.localeCompare(b.id);
}

function applyRule(rule: TierRule, catalog: CatalogModel[]): ResolvedTier | undefined {
  const exclude = rule.exclude ? new RegExp(rule.exclude, 'i') : undefined;
  const allowed = (m: CatalogModel) => !NEVER.test(m.id) && !(exclude?.test(m.id));
  for (const alias of rule.aliases ?? []) {
    if (catalog.some(m => m.id === alias && allowed(m))) return { model: alias, source: 'alias' };
  }
  if (rule.family) {
    const family = new RegExp(rule.family, 'i');
    const line = catalog.filter(m => family.test(m.id) && allowed(m));
    const preferred = line.filter(m => !LAST_RESORT.test(m.id));
    const pool = preferred.length > 0 ? preferred : line;
    const pick = [...pool].sort(newestFirst)[0];
    if (pick) return { model: pick.id, source: 'family' };
  }
  return undefined;
}

/** The recommended model for one tier; never empty unless the provider has no default either. */
export function resolveTier(desc: LLMProviderDescription, catalog: CatalogModel[], tier: ModelTier): ResolvedTier {
  // The code tier rides smart's rules when the provider gives it none.
  const rules = desc.tierRules?.tiers[tier] ?? (tier === 'code' ? desc.tierRules?.tiers.smart : undefined) ?? [];
  for (const rule of rules) {
    const hit = applyRule(rule, catalog);
    if (hit) return hit;
  }
  return { model: desc.defaultTierModels[tier] || desc.defaultTierModels.smart || '', source: 'pinned' };
}

export function resolveTierModels(desc: LLMProviderDescription, catalog: CatalogModel[]): Record<ModelTier, ResolvedTier> {
  const out = {} as Record<ModelTier, ResolvedTier>;
  for (const tier of MODEL_TIERS) out[tier] = resolveTier(desc, catalog, tier);
  return out;
}

/** Whether the provider can recommend a tier from its catalog (and so offers "Latest"). */
export function hasTierRules(desc: LLMProviderDescription, tier: ModelTier): boolean {
  const rules = desc.tierRules?.tiers[tier] ?? (tier === 'code' ? desc.tierRules?.tiers.smart : undefined);
  return !!rules && rules.length > 0;
}

/**
 * Ranks lines dearest first by input price, then output price. Input leads:
 * it tracks a model's size most steadily across vendors, and an agent's
 * long prompts make it most of the bill (output prices swing with promos
 * and cache-miss quirks).
 */
function dearestFirst(a: CatalogModel, b: CatalogModel): number {
  return (b.pricing!.inputPerMTok - a.pricing!.inputPerMTok)
    || (b.pricing!.outputPerMTok - a.pricing!.outputPerMTok)
    || a.id.localeCompare(b.id);
}

function priced(m: CatalogModel): boolean {
  const p = m.pricing;
  return !!p && p.inputPerMTok > 0 && p.outputPerMTok >= 0;
}

/**
 * One tier ladder per vendor, from a catalog's moving aliases ranked by
 * price: the dearest line is smart (and code), the cheapest is fast, and
 * balanced is the middle line, the cheaper of the two middles when the
 * count is even (with two lines, the cheaper one). Sorted alphabetically
 * by vendor name.
 */
export function aliasLadders(desc: LLMProviderDescription, catalog: CatalogModel[]): VendorLadder[] {
  const source = desc.tierRules?.aliasLadders;
  if (!source) return [];
  const pattern = new RegExp(source, 'i');
  const byVendor = new Map<string, CatalogModel[]>();
  for (const m of catalog) {
    const vendor = pattern.exec(m.id)?.[1];
    if (!vendor || NEVER.test(m.id) || !priced(m)) continue;
    (byVendor.get(vendor) ?? byVendor.set(vendor, []).get(vendor)!).push(m);
  }
  const ladders: VendorLadder[] = [];
  for (const [vendor, lines] of byVendor) {
    const ranked = [...lines].sort(dearestFirst);
    const smart = ranked[0];
    const fast = ranked[ranked.length - 1];
    const balanced = ranked[Math.ceil((ranked.length - 1) / 2)];
    const tiers: Record<ModelTier, string> = { smart: smart.id, balanced: balanced.id, fast: fast.id, code: smart.id };
    const vision = [smart, balanced, fast].find(m => m.vision === true)?.id;
    // "Anthropic: Claude Opus Latest" names the vendor before the colon.
    const named = lines.map(l => l.name).find(n => n.includes(':'))?.split(':')[0].trim();
    ladders.push({ vendor, label: named || vendor, tiers, ...(vision ? { vision } : {}) });
  }
  return ladders.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

/**
 * The id to store when freezing a selection: "Latest" becomes today's
 * recommendation; anything else stays as chosen. A catalog's own moving
 * alias (OpenRouter's `~vendor/line-latest`) stays an alias: catalogs do not
 * say which model an alias points at, and a guess from names or prices
 * would freeze the wrong release.
 */
export function freezeModel(desc: LLMProviderDescription, catalog: CatalogModel[], tier: ModelTier, model: string): string {
  if (model === LATEST_MODEL) return resolveTier(desc, catalog, tier).model || model;
  return model;
}
