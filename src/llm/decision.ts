/**
 * Decision models: typed questions in, calibrated answers out.
 *
 * A decision model (TypeSafe's Jev is the first "System One" model) reads a
 * `state` and answers typed questions about it with probabilities instead of
 * text: pick one of N options (choice), a yes/no probability (noul), or a
 * place on an ordered scale (score). It cannot write prose or fill free-form
 * arguments; it judges. Several questions about one state go in one request.
 *
 * The System One wire schema is the contract here because TypeSafe,
 * OpenRouter, other gateways and the open reproductions all speak it. When no
 * decision model is configured, a chat model emulates one
 * (decision-emulator.ts) and returns this same shape, flagged `emulated`.
 */

import { require as contractRequire } from '../core/contracts.js';
import type { DecisionMode } from '../core/decision-sites.js';
import type { ModelInfo } from './provider.js';

/** Instructions and criteria accept prose or structured JSON (named fields, examples). */
export type DecisionText = string | Record<string, unknown> | unknown[];

/** The material judged: text, a JSON object, or an array of text. */
export type DecisionState = string | Record<string, unknown> | unknown[];

/** "Is this true?": answered with the probability of yes. */
export interface NoulQuestion {
  type: 'noul';
  instructions: DecisionText;
  /** What yes and no each mean, when the instructions alone leave room. */
  criteria?: { true?: DecisionText; false?: DecisionText };
}

/** "Which of these?": option key → what the option means. */
export interface ChoiceQuestion {
  type: 'choice';
  instructions: DecisionText;
  criteria: Record<string, DecisionText>;
}

/** "Which level?": ordered levels, lowest first. */
export interface ScoreQuestion {
  type: 'score';
  instructions: DecisionText;
  criteria: DecisionText[];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface DecisionRequest {
  state: DecisionState;
  /** Question id → question. Ids are the answer keys; the model never sees them as content. */
  questions: Record<string, DecisionQuestion>;
}

export interface NoulAnswer { type: 'noul'; noul: number }

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  /** How decisively the distribution picks its winner (top probability minus runner-up). */
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: 'score';
  /** Probability-weighted level position, 0-based (1.21 = mostly level 1, leaning to 2). */
  score: number;
  confidence: number;
  /** Level index → level text. */
  legend: Record<string, string>;
  /** Level index → probability. */
  probabilities: Record<string, number>;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionUsage { inputTokens: number; outputTokens: number; costUsd?: number }

export interface DecisionResult {
  /** The model version that answered (for emulation: `<model> (emulated)`). */
  model: string;
  provider: string;
  answers: Record<string, DecisionAnswer>;
  usage?: DecisionUsage;
  /** True when a chat model emulated the decision instead of a decision model answering it. */
  emulated: boolean;
  /**
   * Whether the probabilities are trained to be calibrated (decision models)
   * or merely stated by a chat model. Threshold on uncalibrated numbers with care.
   */
  calibrated: boolean;
  /** Question ids the emulator could not answer. A native result answers every question. */
  missing?: string[];
  /** Question ids the emulator answered as a bare pick, without probabilities. */
  unscored?: string[];
}

/** A decision answer plus what its site's policy lets the caller do with it. */
export type DecisionOutcome = DecisionResult & { site?: string; mode: Exclude<DecisionMode, 'off'> };

export interface DecisionOptions {
  /** Decision model id; the provider's default when omitted. */
  model?: string;
  timeoutMs?: number;
}

/** A provider that serves decision models (the System One API or a compatible one). */
export interface DecisionProvider {
  readonly name: string;
  decide(request: DecisionRequest, options?: DecisionOptions): Promise<DecisionResult>;
  listDecisionModels(): Promise<ModelInfo[]>;
  /** The decision model used when a request names none. */
  defaultDecisionModel(): string;
}

/** Whether a provider instance also serves decisions. */
export function isDecisionProvider(p: unknown): p is DecisionProvider {
  return !!p && typeof (p as DecisionProvider).decide === 'function'
    && typeof (p as DecisionProvider).listDecisionModels === 'function';
}

/** Limits of the System One schema, checked before a request leaves this process. */
export const DECISION_LIMITS = {
  minChoiceOptions: 2,
  maxChoiceOptions: 255,
  minScoreLevels: 2,
  maxScoreLevels: 10,
  maxQuestions: 64,
  /** Serialized state budget: the API allows ~32k tokens for state plus the longest question. */
  maxStateChars: 96_000,
} as const;

/** Serialized length of the state as a model will see it. */
export function stateChars(state: DecisionState): number {
  return typeof state === 'string' ? state.length : JSON.stringify(state).length;
}

/**
 * Contract check for a request. A request that breaks the schema is a caller
 * bug, so it fails here, before any provider spends a call on a 422.
 */
export function validateDecisionRequest(request: DecisionRequest): void {
  contractRequire(!!request && typeof request === 'object', 'decision request must be an object');
  contractRequire(request.state !== undefined && request.state !== null, 'decision request needs a state');
  const ids = Object.keys(request.questions ?? {});
  contractRequire(ids.length > 0, 'decision request needs at least one question');
  contractRequire(ids.length <= DECISION_LIMITS.maxQuestions, `decision request allows at most ${DECISION_LIMITS.maxQuestions} questions`);
  contractRequire(stateChars(request.state) <= DECISION_LIMITS.maxStateChars,
    `decision state exceeds ${DECISION_LIMITS.maxStateChars} chars; bound it (boundDecisionState) before asking`);
  for (const id of ids) {
    const q = request.questions[id];
    contractRequire(!!q && typeof q === 'object', `question ${id} must be an object`);
    contractRequire(q.instructions !== undefined && q.instructions !== '', `question ${id} needs instructions`);
    if (q.type === 'choice') {
      const n = Object.keys(q.criteria ?? {}).length;
      contractRequire(n >= DECISION_LIMITS.minChoiceOptions && n <= DECISION_LIMITS.maxChoiceOptions,
        `choice ${id} needs ${DECISION_LIMITS.minChoiceOptions}..${DECISION_LIMITS.maxChoiceOptions} options (got ${n})`);
    } else if (q.type === 'score') {
      const n = Array.isArray(q.criteria) ? q.criteria.length : 0;
      contractRequire(n >= DECISION_LIMITS.minScoreLevels && n <= DECISION_LIMITS.maxScoreLevels,
        `score ${id} needs ${DECISION_LIMITS.minScoreLevels}..${DECISION_LIMITS.maxScoreLevels} levels (got ${n})`);
    } else {
      contractRequire(q.type === 'noul', `question ${id} has unknown type ${(q as { type?: unknown }).type}`);
    }
  }
}

/**
 * Bound a state to a character budget by clipping its longest strings first,
 * so the structure (the field names a question points at) always survives.
 */
export function boundDecisionState(state: DecisionState, maxChars: number = DECISION_LIMITS.maxStateChars): DecisionState {
  if (stateChars(state) <= maxChars) return state;
  if (typeof state === 'string') return `${state.slice(0, Math.max(0, maxChars - 40))}… [clipped ${state.length - maxChars + 40} chars]`;
  let cap = 4000;
  let bounded: DecisionState = state;
  while (cap >= 40) {
    bounded = clipStrings(state, cap) as DecisionState;
    if (stateChars(bounded) <= maxChars) return bounded;
    cap = Math.floor(cap / 2);
  }
  // Still over budget: the bulk is structure, not text. Keep a clipped JSON rendering.
  const json = JSON.stringify(bounded);
  return `${json.slice(0, Math.max(0, maxChars - 40))}… [clipped]`;
}

function clipStrings(value: unknown, cap: number): unknown {
  if (typeof value === 'string') return value.length > cap ? `${value.slice(0, cap)}… [+${value.length - cap} chars]` : value;
  if (Array.isArray(value)) return value.map(v => clipStrings(v, cap));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, clipStrings(v, cap)]));
  }
  return value;
}

// ── Building answers from distributions ───────────────────────────────────

/** Normalize non-negative weights to sum 1; an all-zero map becomes uniform. */
export function normalize(weights: Record<string, number>): Record<string, number> {
  const keys = Object.keys(weights);
  const clean = keys.map(k => (Number.isFinite(weights[k]) && weights[k] > 0 ? weights[k] : 0));
  const total = clean.reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  keys.forEach((k, i) => { out[k] = total > 0 ? round(clean[i] / total) : round(1 / keys.length); });
  return out;
}

/** Decisiveness of a distribution: top probability minus the runner-up. */
export function marginConfidence(probabilities: number[]): number {
  const sorted = [...probabilities].sort((a, b) => b - a);
  return round(Math.max(0, (sorted[0] ?? 0) - (sorted[1] ?? 0)));
}

export function choiceFromDistribution(probabilities: Record<string, number>): ChoiceAnswer {
  const p = normalize(probabilities);
  const keys = Object.keys(p);
  const choice = keys.reduce((best, k) => (p[k] > p[best] ? k : best), keys[0]);
  return { type: 'choice', choice, confidence: marginConfidence(Object.values(p)), probabilities: p };
}

export function scoreFromDistribution(levels: string[], probabilities: number[]): ScoreAnswer {
  const weights: Record<string, number> = {};
  levels.forEach((_, i) => { weights[String(i)] = probabilities[i] ?? 0; });
  const p = normalize(weights);
  const score = round(levels.reduce((sum, _, i) => sum + i * p[String(i)], 0));
  const legend: Record<string, string> = {};
  levels.forEach((level, i) => { legend[String(i)] = level; });
  return { type: 'score', score, confidence: marginConfidence(Object.values(p)), legend, probabilities: p };
}

function round(n: number): number { return Math.round(n * 1000) / 1000; }

// ── Reading answers at call sites ─────────────────────────────────────────

/** The choice answer for a question id, when it came back. */
export function choiceOf(result: DecisionResult | null | undefined, id: string): ChoiceAnswer | undefined {
  const a = result?.answers[id];
  return a?.type === 'choice' ? a : undefined;
}

/** Probability of yes for a noul question id, when it came back. */
export function noulOf(result: DecisionResult | null | undefined, id: string): number | undefined {
  const a = result?.answers[id];
  return a?.type === 'noul' ? a.noul : undefined;
}

/** The score answer for a question id, when it came back. */
export function scoreOf(result: DecisionResult | null | undefined, id: string): ScoreAnswer | undefined {
  const a = result?.answers[id];
  return a?.type === 'score' ? a : undefined;
}

/** The most likely level index of a score answer. */
export function topLevel(answer: ScoreAnswer): number {
  let best = 0;
  for (const [k, v] of Object.entries(answer.probabilities)) if (v > (answer.probabilities[String(best)] ?? -1)) best = Number(k);
  return best;
}

/** A compact one-line rendering of every answer, for logs and the ledger. */
export function summarizeAnswers(result: DecisionResult): string {
  return Object.entries(result.answers).map(([id, a]) => {
    if (a.type === 'noul') return `${id}=yes@${a.noul}`;
    if (a.type === 'choice') return `${id}=${a.choice}@${a.confidence}`;
    return `${id}=${a.score}@${a.confidence}`;
  }).join(' ');
}
