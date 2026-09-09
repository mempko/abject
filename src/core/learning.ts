/** Durable learning protocol. Identities and versions belong to receivers, not prompts. */
export type LearningState = 'proposed' | 'applied' | 'needs_repair' | 'waiting' | 'abandoned';
export interface LearningEffect {
  id: string;
  input: Record<string, unknown>;
  original: unknown;
  state: LearningState;
  attempts: number;
  dependsOn?: string[];
  repairClaimed?: boolean;
  nextAttemptAt: number;
  error?: string;
  receipt?: unknown;
  history: unknown[];
}
export interface LearningDecision {
  version: 1;
  id: string;
  goalId: string;
  operationId: string;
  reviewTaskId: string;
  createdAt: number;
  updatedAt: number;
  context: Record<string, unknown>;
  /** Owner snapshots retain evidence even after task sessions are released. */
  evidence: Record<string, unknown>;
  effects: LearningEffect[];
  repairAttempts: number;
  paused?: boolean;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export async function learningFingerprint(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export interface KnowledgeLearning {
  revision: number;
  history: Array<{ effectId: string; decisionId: string; goalId: string; revision: number; at: number; before: unknown; input: unknown; evidence: Record<string, unknown> }>;
  supersessions: Array<{ replacementId: string; scope: string; effectId: string }>;
  disputes: Array<{ explanation: string; scope: string; effectId: string }>;
  scope?: string;
}
export function knowledgeRef(entry: { id: string; updatedAt: number; learning?: KnowledgeLearning }): string {
  return JSON.stringify([entry.id, entry.updatedAt, entry.learning?.revision ?? 0]);
}
export function preservesLearning(local?: KnowledgeLearning, remote?: KnowledgeLearning): boolean {
  return !local || (!!remote && remote.revision >= local.revision && local.history.every(h => remote.history.some(r => r.effectId === h.effectId && canonical(r) === canonical(h))));
}
/** Scope is an explicit identity, never inferred from overlapping query words. */
export function applicable(entry: { archived: boolean; learning?: KnowledgeLearning }, scope?: string): boolean {
  return !entry.archived && (!scope || !entry.learning?.scope || entry.learning.scope === scope)
    && !entry.learning?.supersessions.some(s => !s.scope || s.scope === scope);
}
/** A replacement changed in this decision must still be at the acknowledged revision. */
export function replacementEffect(decision: LearningDecision, effect: LearningEffect): LearningEffect | undefined {
  return decision.effects.filter(e => e !== effect && e.input.id === effect.input.replacementId
    && ['save_entry', 'update_entry', 'confirm_entry'].includes(String(e.input.action))).at(-1);
}
export function validateLearningEffect(decision: LearningDecision, effect: LearningEffect): string | undefined {
  if (decision.paused) return 'Learning paused; explicit resumption required';
  if (effect.dependsOn?.some(id => decision.effects.find(e => e.id === id)?.state !== 'applied')) return 'Waiting for acknowledged replacement effects';
  const p = effect.input;
  if (!['save_entry', 'update_entry', 'archive_entry', 'supersede_entry', 'dispute_entry', 'confirm_entry', 'narrow_entry', 'record_pattern_application', 'no_change'].includes(String(p.action))) return 'Unknown knowledge disposition';
  if (typeof p.evidence !== 'string' || !p.evidence.trim()) return 'Explain what the evidence establishes (or the remaining uncertainty)';
  if (p.action === 'no_change') return;
  if (!Object.keys(decision.evidence).length) return 'Missing explicit references to recorded episode evidence';
  for (const refs of [decision.context.evidenceRefs, p.evidenceRefs]) {
    if (refs !== undefined && (!Array.isArray(refs) || refs.some(ref => typeof ref !== 'string' || !(ref in decision.evidence)))) return 'An explicit evidence reference is unavailable';
  }
  if (typeof p.id !== 'string' || !p.id) return 'Knowledge target is missing';
  if (p.action === 'record_pattern_application') {
    if (typeof p.applicationRef !== 'string' || !p.applicationRef) return 'Unresolved application reference';
    if (!['helpful','harmful','inconclusive'].includes(String(p.verdict))) return 'Invalid pattern usefulness verdict';
    if (p.outcome === 'unknown' && p.verdict !== 'inconclusive') return 'Unobserved application effects remain inconclusive';
  } else if (p.action === 'save_entry') {
    if (typeof p.title !== 'string' || !p.title.trim() || typeof p.content !== 'string' || !p.content.trim()) return 'New knowledge needs title and content';
    if (p.type !== undefined && !['fact', 'learned', 'insight', 'reference', 'pattern'].includes(String(p.type))) return 'Invalid knowledge type';
  } else if (typeof p.knowledgeRef !== 'string') return 'Missing selected version; reread the affected claim';
  if (p.action === 'update_entry' && !['title', 'content', 'tags'].some(k => p[k] !== undefined)) return 'Revision has no proposed changes';
  for (const k of ['title', 'content']) if (p[k] !== undefined && (typeof p[k] !== 'string' || !(p[k] as string).trim())) return `Invalid ${k}`;
  if (p.tags !== undefined && (!Array.isArray(p.tags) || !p.tags.every(t => typeof t === 'string'))) return 'Invalid tags';
  if (p.scope !== undefined && typeof p.scope !== 'string') return 'Scope must be a string identity';
  if (p.action === 'narrow_entry' && !p.scope) return 'Narrowing requires an explicit scope';
  if (p.action === 'supersede_entry' && (typeof p.replacementId !== 'string' || !p.replacementId || p.replacementId === p.id)) return 'Supersession requires a distinct replacement';
  if (p.action === 'supersede_entry') {
    const replacement = replacementEffect(decision, effect);
    if (replacement) {
      if (replacement.state !== 'applied') return 'Waiting for acknowledged replacement effects';
    } else if (typeof p.replacementRef !== 'string' || typeof p.replacementEvidence !== 'string' || !p.replacementEvidence.trim()) {
      return 'Read the full replacement and explain how its claims agree with episode evidence using replacementEvidence, or revise/confirm it in this decision';
    }
  }
}
