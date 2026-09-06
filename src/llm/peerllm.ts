/**
 * PeerLLM API integration.
 *
 * PeerLLM exposes OpenAI-compatible chat completions and model discovery,
 * with a smaller request schema than OpenAI. The provider normalizes shared
 * OpenAI requests to the fields PeerLLM documents.
 */

import {
  CacheProfile,
  FetchDelegate,
  LLMCompletionOptions,
  LLMProviderDescription,
  ModelInfo,
  ModelTier,
} from './provider.js';
import { OpenAIProvider, OpenAIReasoningProfile, OpenAIRequest } from './openai.js';
import { Log } from '../core/timed-log.js';

const log = new Log('PEERLLM');

export interface PeerLLMConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchFn?: FetchDelegate;
}

const DEFAULT_MODEL = 'LLooMA1.0';

const DEFAULT_TIER_MODELS: Record<ModelTier, string> = {
  smart: DEFAULT_MODEL,
  balanced: DEFAULT_MODEL,
  fast: DEFAULT_MODEL,
  code: DEFAULT_MODEL,
};

const FALLBACK_MODELS: ModelInfo[] = [
  {
    id: DEFAULT_MODEL,
    name: 'LLooMA 1.0 (Orchestration)',
    vision: false,
    efforts: [],
  },
];

interface PeerLLMModelsResponse {
  data?: Array<{ id: string }>;
}

export class PeerLLMProvider extends OpenAIProvider {
  constructor(config: PeerLLMConfig) {
    super({
      apiKey: config.apiKey,
      model: config.model ?? DEFAULT_MODEL,
      baseUrl: config.baseUrl ?? 'https://api.peerllm.com',
      fetchFn: config.fetchFn,
      tierModels: DEFAULT_TIER_MODELS,
    });
    this.name = 'peerllm';
  }

  protected override reasoningProfile(_model: string): OpenAIReasoningProfile {
    return { supportsEffort: false, reasons: false, maxOutput: 128000 };
  }

  protected override modelVision(_modelId: string): boolean {
    return false;
  }

  override cacheProfile(_modelId: string): CacheProfile | undefined {
    return undefined;
  }

  protected override applyRequestExtras(
    request: OpenAIRequest,
    _model: string,
    _options: LLMCompletionOptions,
    stream: boolean,
  ): void {
    const maxTokens = request.max_completion_tokens;
    delete request.max_completion_tokens;
    if (maxTokens !== undefined) request.max_tokens = maxTokens;
    request.stream = stream;

    // PeerLLM documents only model, messages, stream, temperature, and
    // max_tokens for chat completions.
    delete request.stop;
    delete request.prompt_cache_key;
    delete request.reasoning_effort;
    delete request.verbosity;
    delete request.usage;
    delete request.provider;
  }

  override async listModels(): Promise<ModelInfo[]> {
    try {
      // PeerLLM's model catalog is public and does not require authentication.
      const response = await this.fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      const parsed = JSON.parse(response.body) as PeerLLMModelsResponse;
      const models = parsed.data ?? [];
      if (models.length === 0) return FALLBACK_MODELS;
      return models.map(model => ({
        id: model.id,
        name: model.id,
        vision: false,
        efforts: [],
      }));
    } catch (err) {
      log.warn(`Failed to fetch models: ${err instanceof Error ? err.message : String(err)}`);
      return FALLBACK_MODELS;
    }
  }

  override describe(): LLMProviderDescription {
    return {
      id: 'peerllm',
      label: 'PeerLLM',
      storageSuffix: 'peerllmApiKey',
      credentialMode: 'apiKey',
      credentialLabel: 'PeerLLM API Key',
      credentialPlaceholder: 'Enter your PeerLLM API key',
      models: FALLBACK_MODELS,
      defaultTierModels: DEFAULT_TIER_MODELS,
    };
  }
}

export function createPeerLLMProvider(): PeerLLMProvider | undefined {
  const apiKey = (globalThis as Record<string, unknown>).PEERLLM_API_KEY as string | undefined;
  if (!apiKey) {
    log.warn('No API key found');
    return undefined;
  }
  return new PeerLLMProvider({ apiKey });
}
