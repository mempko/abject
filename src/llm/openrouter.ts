/**
 * OpenRouter API integration.
 *
 * OpenRouter is a meta-provider: a single API key and endpoint routes requests
 * to dozens of underlying models (Anthropic, OpenAI, Google, DeepSeek, Meta,
 * Qwen, etc.). The wire protocol is OpenAI-compatible, so we subclass
 * OpenAIProvider and override the base URL, tier models, and attribution
 * headers.
 */

import { FetchDelegate, ModelTier, ModelInfo, LLMProviderDescription, LLMCompletionOptions, EffortLevel } from './provider.js';
import { OpenAIProvider, OpenAIRequest, OpenAIReasoningProfile } from './openai.js';
import { Log } from '../core/timed-log.js';

const log = new Log('OPENROUTER');

/**
 * Per-model reasoning override, matched against the resolved model id.
 * OpenRouter normalizes the unified `reasoning` knob, but individual models
 * respond to effort differently (or pathologically) — this lets a deployment
 * force or disable reasoning for a model family without code changes.
 */
export interface OpenRouterReasoningOverride {
  /** Matched against the resolved model id (e.g. /^moonshotai\//). */
  match: RegExp;
  /** Effort forced for matching models; 'none' omits the reasoning field entirely. */
  effort: EffortLevel;
}

export interface OpenRouterConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchFn?: FetchDelegate;
  siteUrl?: string;
  appTitle?: string;
  /**
   * Routing preferences sent as the request's `provider` field — OpenRouter's
   * order / allow_fallbacks / ignore / sort / require_parameters object.
   * Lets a deployment steer around a flaky upstream.
   */
  providerPreferences?: Record<string, unknown>;
  /** Per-model reasoning overrides, first match wins. */
  reasoningOverrides?: OpenRouterReasoningOverride[];
}

const DEFAULT_TIER_MODELS: Record<ModelTier, string> = {
  smart: 'anthropic/claude-opus-4.8',
  balanced: 'openai/gpt-5.4-mini',
  fast: 'meta-llama/llama-3.3-70b-instruct',
  code: 'anthropic/claude-opus-4.8',
};

interface OpenRouterModelsResponse {
  data: Array<{ id: string; name?: string; architecture?: { input_modalities?: string[] } }>;
}

export class OpenRouterProvider extends OpenAIProvider {
  private readonly providerPreferences?: Record<string, unknown>;
  private readonly reasoningOverrides: OpenRouterReasoningOverride[];

  constructor(config: OpenRouterConfig) {
    super({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl ?? 'https://openrouter.ai/api',
      fetchFn: config.fetchFn,
      tierModels: DEFAULT_TIER_MODELS,
      extraHeaders: {
        'HTTP-Referer': config.siteUrl ?? 'https://abjects.local',
        'X-Title': config.appTitle ?? 'Abjects',
      },
    });
    this.name = 'openrouter';
    this.providerPreferences = config.providerPreferences;
    this.reasoningOverrides = config.reasoningOverrides ?? [];
  }

  // OpenRouter normalizes ONE unified `reasoning: { effort }` across every
  // underlying model family (effort for OpenAI/Grok, a max_tokens budget for
  // Claude/Gemini) and silently ignores it for non-reasoning models — so it is
  // the safe single knob. Underlying models vary in ceiling; 64k is a safe cap.
  protected override reasoningProfile(_model: string): OpenAIReasoningProfile {
    return { supportsEffort: false, reasons: true, maxOutput: 64000 };
  }

  protected override applyReasoning(request: OpenAIRequest, model: string, options: LLMCompletionOptions): { reasoningActive: boolean } {
    // A configured per-model override beats the tier/explicit effort.
    const override = this.reasoningOverrides.find(o => o.match.test(model));
    const effort = override?.effort ?? this.resolveEffort(options);
    if (effort && effort !== 'none') {
      request.reasoning = { effort };
      return { reasoningActive: true };
    }
    return { reasoningActive: false };
  }

  protected override applyRequestExtras(request: OpenAIRequest, _model: string, _options: LLMCompletionOptions, stream: boolean): void {
    // Ask for token accounting (incl. the reasoning-token breakdown) — with
    // `include` the final SSE chunk carries `usage`. Non-streaming responses
    // always carry usage, so only ask on streams.
    if (stream) request.usage = { include: true };
    if (this.providerPreferences) request.provider = this.providerPreferences;
  }

  override async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
      });
      const data = JSON.parse(response.body) as OpenRouterModelsResponse;
      return data.data.map(m => ({
        id: m.id,
        name: m.name ?? m.id,
        // OpenRouter publishes real modality data per model; missing means unknown
        vision: m.architecture?.input_modalities
          ? m.architecture.input_modalities.includes('image')
          : undefined,
      }));
    } catch (err) {
      log.warn(`Failed to fetch models: ${err instanceof Error ? err.message : String(err)}`);
      return Object.values(DEFAULT_TIER_MODELS).map(id => ({ id, name: id }));
    }
  }

  override describe(): LLMProviderDescription {
    return {
      id: 'openrouter',
      label: 'OpenRouter',
      storageSuffix: 'openrouterApiKey',
      credentialMode: 'apiKey',
      credentialLabel: 'OpenRouter API Key',
      credentialPlaceholder: 'sk-or-...',
      models: Object.values(DEFAULT_TIER_MODELS).map(id => ({ id, name: id })),
      defaultTierModels: DEFAULT_TIER_MODELS,
    };
  }
}

export function createOpenRouterProvider(): OpenRouterProvider | undefined {
  const apiKey = (globalThis as Record<string, unknown>).OPENROUTER_API_KEY as string | undefined;
  if (!apiKey) {
    log.warn('No API key found');
    return undefined;
  }
  // Optional routing preferences as a JSON string, e.g.
  // OPENROUTER_PROVIDER_PREFERENCES='{"allow_fallbacks":true,"sort":"latency"}'
  let providerPreferences: Record<string, unknown> | undefined;
  const prefsJson = (globalThis as Record<string, unknown>).OPENROUTER_PROVIDER_PREFERENCES as string | undefined;
  if (prefsJson) {
    try {
      providerPreferences = JSON.parse(prefsJson) as Record<string, unknown>;
    } catch {
      log.warn('OPENROUTER_PROVIDER_PREFERENCES is not valid JSON — ignoring');
    }
  }
  return new OpenRouterProvider({ apiKey, providerPreferences });
}
