/**
 * TypeSafe System One API (Jev): a decision-model provider.
 *
 * Jev answers typed questions about a state with calibrated probabilities
 * (see decision.ts). It serves no chat completions, so this provider is
 * decision-only: it appears in Settings for its API key and in the Decision
 * row, never in the chat tier rows.
 *
 * The System One wire client below is shared: any endpoint speaking the
 * same schema (OpenRouter's /api/v1/systemone, a self-hosted open model)
 * is the same call against a different base URL.
 */

import { withRetries, type FetchDelegate, type LLMProviderDescription, type ModelInfo } from './provider.js';
import {
  validateDecisionRequest,
  type DecisionAnswer, type DecisionOptions, type DecisionProvider, type DecisionRequest, type DecisionResult,
} from './decision.js';
import { requireNonEmpty } from '../core/contracts.js';

export const TYPESAFE_BASE_URL = 'https://api.typesafe.ai';
export const TYPESAFE_DEFAULT_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 15_000;

const TYPESAFE_MODELS: ModelInfo[] = [
  { id: 'jev-latest', name: 'Jev (latest)' },
  { id: 'jev-preview', name: 'Jev (preview)' },
];

export interface SystemOneEndpoint {
  /** Full URL of the System One endpoint (e.g. https://api.typesafe.ai/v1/systemone). */
  url: string;
  apiKey: string;
  fetchFn?: FetchDelegate;
  /** Extra headers (attribution for gateways). */
  headers?: Record<string, string>;
  /** Label for retry logs. */
  label: string;
}

interface SystemOneResponse {
  model?: string;
  answers?: Record<string, DecisionAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
}

async function postJson(endpoint: SystemOneEndpoint, body: unknown, timeoutMs: number): Promise<string> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.apiKey}`, ...(endpoint.headers ?? {}) },
    body: JSON.stringify(body),
  };
  if (endpoint.fetchFn) {
    const r = await endpoint.fetchFn(endpoint.url, init, { timeout: timeoutMs });
    if (!r.ok) throw new Error(`Decision API error (${r.status}): ${r.body.slice(0, 500)}`);
    return r.body;
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const r = await fetch(endpoint.url, { ...init, signal: abort.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`Decision API error (${r.status}): ${text.slice(0, 500)}`);
    return text;
  } catch (err) {
    if (abort.signal.aborted) throw new Error(`Decision API request timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One System One call. 429/529/5xx and timeouts retry with backoff; other
 * 4xx (bad key, unknown model, invalid request) fail at once.
 */
export async function callSystemOne(
  endpoint: SystemOneEndpoint, model: string, request: DecisionRequest, providerName: string, timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<DecisionResult> {
  validateDecisionRequest(request);
  requireNonEmpty(model, 'decision model');
  const text = await withRetries(
    () => postJson(endpoint, { model, state: request.state, questions: request.questions }, timeoutMs),
    { label: endpoint.label, maxAttempts: 3, initialDelayMs: 300, maxDelayMs: 2000 },
  );
  let parsed: SystemOneResponse;
  try { parsed = JSON.parse(text) as SystemOneResponse; }
  catch { throw new Error(`Decision API returned non-JSON: ${text.slice(0, 200)}`); }
  const answers = parsed.answers ?? {};
  const missing = Object.keys(request.questions).filter(id => !answers[id]);
  return {
    model: parsed.model ?? model,
    provider: providerName,
    answers,
    usage: {
      inputTokens: parsed.usage?.input_tokens ?? 0,
      outputTokens: parsed.usage?.output_tokens ?? 0,
      ...(typeof parsed.usage?.cost === 'number' ? { costUsd: parsed.usage.cost } : {}),
    },
    emulated: false,
    calibrated: true,
    ...(missing.length ? { missing } : {}),
  };
}

export interface TypeSafeConfig {
  apiKey: string;
  baseUrl?: string;
  fetchFn?: FetchDelegate;
}

export class TypeSafeProvider implements DecisionProvider {
  readonly name = 'typesafe';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn?: FetchDelegate;

  constructor(config: TypeSafeConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? TYPESAFE_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = config.fetchFn;
  }

  defaultDecisionModel(): string { return TYPESAFE_DEFAULT_MODEL; }

  async decide(request: DecisionRequest, options: DecisionOptions = {}): Promise<DecisionResult> {
    requireNonEmpty(this.apiKey, 'TypeSafe API key');
    return callSystemOne(
      { url: `${this.baseUrl}/v1/systemone`, apiKey: this.apiKey, fetchFn: this.fetchFn, label: this.name },
      options.model ?? TYPESAFE_DEFAULT_MODEL, request, this.name, options.timeoutMs,
    );
  }

  /** Live model list from GET /v1/models; the static list when that fails. */
  async listDecisionModels(): Promise<ModelInfo[]> {
    if (!this.apiKey) return TYPESAFE_MODELS;
    try {
      const init: RequestInit = { method: 'GET', headers: { Authorization: `Bearer ${this.apiKey}` } };
      const url = `${this.baseUrl}/v1/models`;
      const body = this.fetchFn
        ? (await this.fetchFn(url, init, { timeout: 10_000 })).body
        : await (await fetch(url, init)).text();
      const data = JSON.parse(body) as { models?: Array<{ name: string; description?: string }> };
      const models = (data.models ?? []).map(m => ({ id: m.name, name: m.name }));
      return models.length > 0 ? models : TYPESAFE_MODELS;
    } catch {
      return TYPESAFE_MODELS;
    }
  }

  describe(): LLMProviderDescription {
    return {
      id: this.name,
      label: 'TypeSafe (Jev)',
      storageSuffix: 'typesafeApiKey',
      credentialMode: 'apiKey',
      credentialLabel: 'TypeSafe API Key',
      credentialPlaceholder: 'apikey_...',
      models: [],
      decisionModels: TYPESAFE_MODELS,
      capabilities: { chat: false, decide: true },
      // Decision-only: no chat tiers. Empty ids keep it out of tier presets.
      defaultTierModels: { smart: '', balanced: '', fast: '', code: '' },
    };
  }
}
