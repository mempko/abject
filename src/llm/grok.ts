/**
 * xAI Grok API integration.
 *
 * xAI exposes an OpenAI-compatible chat-completions endpoint at api.x.ai, so
 * we subclass OpenAIProvider with different base URL and tier models.
 */

import { FetchDelegate, ModelTier, ModelInfo, LLMProviderDescription, LLMCompletionOptions, CacheProfile } from './provider.js';
import { OpenAIProvider, OpenAIRequest, OpenAIReasoningProfile } from './openai.js';
import { Log } from '../core/timed-log.js';

const log = new Log('GROK');

export interface GrokConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchFn?: FetchDelegate;
}

// Grok 4.3 is the current flagship and accepts `reasoning_effort` (unlike the
// original grok-4, which 400s on it). `grok-4-mini` never existed and
// `grok-4-fast` is retired. We tier grok-4.3 by effort (high/medium/low); swap
// the fast tier to a cheaper verified slug once xAI's /v1/models confirms one.
const DEFAULT_TIER_MODELS: Record<ModelTier, string> = {
  smart: 'grok-4.3',
  balanced: 'grok-4.3',
  fast: 'grok-4.3',
  code: 'grok-4.3',
};

/** grok-4.1 and newer accept reasoning_effort; grok-4 / grok-4-0709 / grok-4-fast reject it. */
function grokAcceptsEffort(model: string): boolean {
  return /grok-(4\.[1-9]|4\.\d\d|[5-9])/.test(model.toLowerCase());
}

interface GrokModelsResponse {
  data: Array<{ id: string; object?: string }>;
}

export class GrokProvider extends OpenAIProvider {
  constructor(config: GrokConfig) {
    super({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl ?? 'https://api.x.ai',
      fetchFn: config.fetchFn,
      tierModels: DEFAULT_TIER_MODELS,
    });
    this.name = 'grok';
  }


  /** Cache economics through this vendor are unverified — no keepalive. */
  override cacheProfile(_modelId: string): CacheProfile | undefined {
    return undefined;
  }

  protected override reasoningProfile(model: string): OpenAIReasoningProfile {
    return { supportsEffort: grokAcceptsEffort(model), reasons: true, maxOutput: 64000 };
  }

  protected override applyReasoning(request: OpenAIRequest, model: string, options: LLMCompletionOptions): { reasoningActive: boolean } {
    // The grok-4 family rejects `stop`, `presence_penalty`, `frequency_penalty`,
    // and `verbosity`; strip them. Only 4.1+ accept reasoning_effort.
    delete request.stop;
    if (!grokAcceptsEffort(model)) return { reasoningActive: true };
    const effort = this.resolveEffort(options);
    if (effort) request.reasoning_effort = effort;
    return { reasoningActive: effort !== 'none' };
  }

  // Grok 4 and later are multimodal; grok-3 and earlier chat models are text-only
  protected override modelVision(modelId: string): boolean | undefined {
    if (/vision/i.test(modelId)) return true;
    if (/^grok-([4-9]|\d{2})/i.test(modelId)) return true;
    if (/^grok-[123]/i.test(modelId)) return false;
    return undefined;
  }

  override async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
      });
      const data = JSON.parse(response.body) as GrokModelsResponse;
      return data.data.map(m => ({ id: m.id, name: m.id, vision: this.modelVision(m.id), efforts: this.supportedEfforts(m.id) }));
    } catch (err) {
      log.warn(`Failed to fetch models: ${err instanceof Error ? err.message : String(err)}`);
      return [
        { id: 'grok-4.3', name: 'Grok 4.3', vision: true },
        { id: 'grok-4', name: 'Grok 4', vision: true },
      ];
    }
  }

  override describe(): LLMProviderDescription {
    return {
      id: 'grok',
      label: 'Grok',
      storageSuffix: 'grokApiKey',
      credentialMode: 'apiKey',
      credentialLabel: 'xAI Grok API Key',
      credentialPlaceholder: 'xai-...',
      models: [
        { id: 'grok-4', name: 'Grok 4', vision: true },
        { id: 'grok-4-mini', name: 'Grok 4 Mini', vision: true },
        { id: 'grok-4-fast', name: 'Grok 4 Fast', vision: true },
      ],
      defaultTierModels: DEFAULT_TIER_MODELS,
    };
  }
}

export function createGrokProvider(): GrokProvider | undefined {
  const apiKey = (globalThis as Record<string, unknown>).XAI_API_KEY as string | undefined;
  if (!apiKey) {
    log.warn('No API key found');
    return undefined;
  }
  return new GrokProvider({ apiKey });
}
