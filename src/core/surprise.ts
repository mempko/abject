/**
 * Surprise: the shared vocabulary of the predict, judge, blame, update loop.
 *
 * A system that states what it expects can measure how surprised it was, and
 * surprise is where its model needs updating. Every prediction an agent makes
 * carries a confidence; a goal states its assumptions about what the person
 * wants, with a confidence and a cost of being wrong; and the person's own
 * reactions to a result (a correction, a redirect, "that's not what I
 * wanted") are recorded as the most valuable surprise of all.
 *
 * This module holds the shapes and the arithmetic those objects share:
 * AgentAbject records confidence on predictions, ScrumMaster states and asks
 * about assumptions, Chat classifies reactions, GoalManager keeps them and
 * the learning curve, TaskReviewer blames misses on beliefs, and the
 * KnowledgeBase keeps evidence counters on entries. The objects still talk
 * only by messages; this is the vocabulary those messages carry.
 */

import { require as contractRequire } from './contracts.js';

// ── Confidence ───────────────────────────────────────────────────────────

/**
 * How sure a prediction or an assumption is. Three words rather than a
 * number: models are poor at raw probabilities and fair at buckets, and each
 * word maps to the probability the arithmetic below uses.
 */
export type Confidence = 'sure' | 'likely' | 'guess';

export const CONFIDENCE_LEVELS: readonly Confidence[] = ['sure', 'likely', 'guess'];

/** The probability each word stands for: that the claim holds. */
export const CONFIDENCE_P: Record<Confidence, number> = { sure: 0.95, likely: 0.75, guess: 0.5 };

/** A confidence word read from untrusted input, or undefined. */
export function confidenceOf(raw: unknown): Confidence | undefined {
  if (typeof raw !== 'string') return undefined;
  const word = raw.trim().toLowerCase();
  return (CONFIDENCE_LEVELS as readonly string[]).includes(word) ? word as Confidence : undefined;
}

/**
 * Surprise in bits: how unlikely the outcome was by the stated confidence.
 * A sure prediction that held is about 0.07 bits; a sure one that missed is
 * about 4.3 bits; a guess costs 1 bit either way.
 */
export function surpriseBits(confidence: Confidence, held: boolean): number {
  const p = CONFIDENCE_P[confidence];
  const bits = -Math.log2(held ? p : 1 - p);
  return Math.round(bits * 1000) / 1000;
}

/** Brier score of one prediction: squared distance from the outcome, 0 is perfect. */
export function brier(confidence: Confidence, held: boolean): number {
  const p = CONFIDENCE_P[confidence];
  const score = (p - (held ? 1 : 0)) ** 2;
  return Math.round(score * 10000) / 10000;
}

// ── Blame ────────────────────────────────────────────────────────────────

/**
 * Which belief a missed prediction traced back to: the model's own prior, a
 * knowledge entry or a pattern it rested on, the link between two patterns,
 * a world that changed under it, the runtime itself (which teaches the world
 * model nothing), an assumption the goal made about what the person wanted,
 * or `unassigned` when no one could tell. Unassigned is recorded and counted
 * rather than refused, so the funnel shows how much blame goes missing.
 */
export type AttributionSource = 'prior' | 'entry' | 'pattern' | 'link' | 'world' | 'runtime' | 'assumption' | 'unassigned';

export const ATTRIBUTION_SOURCES: readonly AttributionSource[] = ['prior', 'entry', 'pattern', 'link', 'world', 'runtime', 'assumption', 'unassigned'];

/** Sources that name a belief the system holds and can correct. */
export const BELIEF_SOURCES: readonly AttributionSource[] = ['entry', 'pattern', 'link', 'assumption'];

// ── Assumptions about what the person wants ──────────────────────────────

/**
 * What an assumption is about. Intent, scope and preference are claims about
 * the person and are settled by asking; world is a claim about the
 * environment and is settled by a read-only check.
 */
export type AssumptionAbout = 'intent' | 'scope' | 'preference' | 'world';

export const ASSUMPTION_ABOUT: readonly AssumptionAbout[] = ['intent', 'scope', 'preference', 'world'];

/**
 * What being wrong would cost. Undo makes a wrong guess cheap: a change the
 * person can take back with Ctrl+Z rarely deserves a question.
 */
export type CostIfWrong = 'undoable' | 'costly' | 'irreversible';

export const COSTS_IF_WRONG: readonly CostIfWrong[] = ['undoable', 'costly', 'irreversible'];

/**
 * Where an assumption stands. `acted` means the goal went ahead on it without
 * asking (the result names it); `confirmed` / `corrected` come from the
 * person's answer; `held` / `missed` from a read-only check.
 */
export type AssumptionStatus = 'open' | 'asked' | 'acted' | 'confirmed' | 'corrected' | 'held' | 'missed';

export interface Assumption {
  /** Short id within its goal, `A1`, `A2`, ... */
  id: string;
  claim: string;
  about: AssumptionAbout;
  confidence: Confidence;
  costIfWrong: CostIfWrong;
  /** Knowledge entry ids the assumption rests on (preferences, profile facts). */
  basis?: string[];
  status: AssumptionStatus;
  /** The person's answer, or the check's finding, in their words. */
  answer?: string;
  /** What the person actually wants, when the answer corrected the claim. */
  wanted?: string;
  at: number;
  resolvedAt?: number;
}

export const MAX_ASSUMPTIONS_PER_GOAL = 8;

/** One assumption read from untrusted planner output, or undefined when malformed. */
export function parseAssumption(raw: unknown, index: number, now = Date.now()): Assumption | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const claim = typeof r.claim === 'string' ? r.claim.trim().slice(0, 400) : '';
  if (!claim) return undefined;
  const about = (ASSUMPTION_ABOUT as readonly string[]).includes(String(r.about)) ? r.about as AssumptionAbout : 'intent';
  const confidence = confidenceOf(r.confidence) ?? 'likely';
  const costIfWrong = (COSTS_IF_WRONG as readonly string[]).includes(String(r.costIfWrong)) ? r.costIfWrong as CostIfWrong : 'costly';
  const basis = Array.isArray(r.basis) ? r.basis.filter((b): b is string => typeof b === 'string' && !!b.trim()).slice(0, 5) : [];
  return {
    id: `A${index + 1}`, claim, about, confidence, costIfWrong,
    ...(basis.length ? { basis } : {}),
    status: 'open', at: now,
  };
}

/**
 * Whether an assumption about the person should be put to them before the
 * goal acts on it: a guess, or a merely likely claim where being wrong cannot
 * be taken back. Everything else is acted on and named in the result.
 */
export function needsAsking(a: Assumption): boolean {
  if (a.about === 'world' || a.status !== 'open') return false;
  return a.confidence === 'guess' || (a.confidence === 'likely' && a.costIfWrong === 'irreversible');
}

/**
 * Whether a claim about the world deserves a read-only check before the step
 * that relies on it: a guess that is not cheap to get wrong, or a likely
 * claim where being wrong cannot be taken back.
 */
export function needsCheck(a: Assumption): boolean {
  if (a.about !== 'world' || a.status !== 'open') return false;
  return (a.confidence === 'guess' && a.costIfWrong !== 'undoable')
    || (a.confidence === 'likely' && a.costIfWrong === 'irreversible');
}

/** Questions a goal may put to the person: one batched at the start, one more while it runs. */
export const QUESTION_BUDGET = { atStart: 1, duringGoal: 1 } as const;

/** Read-only check tasks one goal may stage. */
export const CHECK_TASKS_PER_GOAL = 2;

// ── The person's reactions ───────────────────────────────────────────────

/**
 * How the person reacted to a result or to the work in flight. A correction
 * says the result is wrong; a redirect changes what they want done; unhappy
 * says it fell short without saying how; satisfied and neutral teach little.
 */
export type ReactionKind = 'satisfied' | 'correction' | 'redirect' | 'unhappy' | 'neutral';

export const REACTION_KINDS: readonly ReactionKind[] = ['satisfied', 'correction', 'redirect', 'unhappy', 'neutral'];

/** Reactions that are surprises worth a review of their own. */
export const NEGATIVE_REACTIONS: readonly ReactionKind[] = ['correction', 'redirect', 'unhappy'];

export function isNegativeReaction(kind: ReactionKind): boolean {
  return (NEGATIVE_REACTIONS as readonly string[]).includes(kind);
}

export interface Reaction {
  kind: ReactionKind;
  /** The person's words. */
  text: string;
  /** What they wanted instead, as the classifier read it. */
  wanted?: string;
  /** After the result (`chat`) or while the goal ran (`interjection`). */
  source: 'chat' | 'interjection';
  at: number;
}

export function reactionKindOf(raw: unknown): ReactionKind | undefined {
  return typeof raw === 'string' && (REACTION_KINDS as readonly string[]).includes(raw) ? raw as ReactionKind : undefined;
}

// ── Contexts and the learning curve ──────────────────────────────────────

/**
 * The context a prediction was made in, for the learning curve: the agent,
 * the action, and for a call the target object and method. Surprise per
 * context, by how often the context has been seen, is the measure of
 * "surprised less in repeated contexts".
 */
export function contextKey(parts: { agent?: string; action: string; target?: string; method?: string }): string {
  contractRequire(typeof parts.action === 'string' && parts.action.length > 0, 'contextKey needs an action');
  const clean = (s: string | undefined) => (s ?? '').replace(/[|\s]+/g, '_').slice(0, 60);
  return [clean(parts.agent) || '?', clean(parts.action), clean(parts.target), clean(parts.method)].join('|');
}

/** Occurrence buckets for the learning curve: the first sighting, then doubling ranges. */
export type OccurrenceBucket = '1' | '2-3' | '4-7' | '8-15' | '16+';

export const OCCURRENCE_BUCKETS: readonly OccurrenceBucket[] = ['1', '2-3', '4-7', '8-15', '16+'];

export function occurrenceBucket(n: number): OccurrenceBucket {
  contractRequire(Number.isFinite(n) && n >= 1, 'occurrence counts start at 1');
  return n === 1 ? '1' : n <= 3 ? '2-3' : n <= 7 ? '4-7' : n <= 15 ? '8-15' : '16+';
}

/** The ISO date (UTC) of the Monday starting the week that holds `ms`. */
export function weekOf(ms: number): string {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// ── Read-only operations, for check tasks ────────────────────────────────

/**
 * Method names that read without changing anything. A check task (a step the
 * planner stages to test a belief before acting on it) may only make calls
 * whose method, or for a tool bridge whose tool, matches. `ask` is left out:
 * a question to another agent can set that agent to work.
 */
const READ_OPERATION = /^(read|list|get|find|search|discover|describe|inspect|recall|query|count|peek|show|view|lookup|stat|exists|has|check|preview|capture|screenshot|snapshot)(?:$|[_A-Z\-])/;

/** HTTP verbs that only read. */
const READ_HTTP = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether a call reads only. `method` is the message method; `args` its
 * payload, consulted for tool bridges (`callTool` with a tool `name`) and
 * HTTP (`request` with a `method`).
 */
export function isReadOperation(method: string, args?: Record<string, unknown>): boolean {
  if (typeof method !== 'string' || !method) return false;
  if (method === 'callTool' || method === 'call_tool') {
    const tool = typeof args?.name === 'string' ? args.name : typeof args?.tool === 'string' ? args.tool : '';
    return !!tool && READ_OPERATION.test(tool);
  }
  if (method === 'request' || method === 'fetch') {
    const verb = typeof args?.method === 'string' ? args.method.toUpperCase() : 'GET';
    return READ_HTTP.has(verb);
  }
  if (method === 'head' || method === 'options') return true;
  return READ_OPERATION.test(method);
}
