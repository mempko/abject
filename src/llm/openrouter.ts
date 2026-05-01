/**
 * OpenRouter API integration.
 *
 * OpenRouter is a meta-provider: a single API key and endpoint routes requests
 * to dozens of underlying models (Anthropic, OpenAI, Google, DeepSeek, Meta,
 * Qwen, etc.). The wire protocol is OpenAI-compatible, so we subclass
 * OpenAIProvider and override the base URL, tier models, and attribution
 * headers.
 */

import { FetchDelegate, ModelTier, ModelInfo, LLMProviderDescription } from './provider.js';
import { OpenAIProvider } from './openai.js';
import { Log } from '../core/timed-log.js';

const log = new Log('OPENROUTER');

export interface OpenRouterConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchFn?: FetchDelegate;
  siteUrl?: string;
  appTitle?: string;
}

const DEFAULT_TIER_MODELS: Record<ModelTier, string> = {
  smart: 'anthropic/claude-opus-4-6',
  balanced: 'openai/gpt-5.4-mini',
  fast: 'meta-llama/llama-3.3-70b-instruct',
};

interface OpenRouterModelsResponse {
  data: Array<{ id: string; name?: string }>;
}

export class OpenRouterProvider extends OpenAIProvider {
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
  }

  override async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
      });
      const data = JSON.parse(response.body) as OpenRouterModelsResponse;
      return data.data.map(m => ({ id: m.id, name: m.name ?? m.id }));
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
  return new OpenRouterProvider({ apiKey });
}
