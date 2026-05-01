/**
 * DeepSeek API integration.
 *
 * DeepSeek's public API is OpenAI-compatible (POST /chat/completions), so we
 * subclass OpenAIProvider with different base URL and tier models.
 */

import { FetchDelegate, ModelTier, ModelInfo, LLMProviderDescription } from './provider.js';
import { OpenAIProvider } from './openai.js';
import { Log } from '../core/timed-log.js';

const log = new Log('DEEPSEEK');

export interface DeepSeekConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchFn?: FetchDelegate;
}

const DEFAULT_TIER_MODELS: Record<ModelTier, string> = {
  smart: 'deepseek-reasoner',
  balanced: 'deepseek-chat',
  fast: 'deepseek-chat',
};

interface DeepSeekModelsResponse {
  data: Array<{ id: string; object?: string }>;
}

export class DeepSeekProvider extends OpenAIProvider {
  constructor(config: DeepSeekConfig) {
    super({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl ?? 'https://api.deepseek.com',
      fetchFn: config.fetchFn,
      tierModels: DEFAULT_TIER_MODELS,
    });
    this.name = 'deepseek';
  }

  override async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
      });
      const data = JSON.parse(response.body) as DeepSeekModelsResponse;
      return data.data.map(m => ({ id: m.id, name: m.id }));
    } catch (err) {
      log.warn(`Failed to fetch models: ${err instanceof Error ? err.message : String(err)}`);
      return [
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      ];
    }
  }

  override describe(): LLMProviderDescription {
    return {
      id: 'deepseek',
      label: 'DeepSeek',
      storageSuffix: 'deepseekApiKey',
      credentialMode: 'apiKey',
      credentialLabel: 'DeepSeek API Key',
      credentialPlaceholder: 'sk-...',
      models: [
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      ],
      defaultTierModels: DEFAULT_TIER_MODELS,
    };
  }
}

export function createDeepSeekProvider(): DeepSeekProvider | undefined {
  const apiKey = (globalThis as Record<string, unknown>).DEEPSEEK_API_KEY as string | undefined;
  if (!apiKey) {
    log.warn('No API key found');
    return undefined;
  }
  return new DeepSeekProvider({ apiKey });
}
