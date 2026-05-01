/**
 * Kimi (Moonshot AI) API integration.
 *
 * Kimi exposes an OpenAI-compatible chat-completions endpoint at
 * api.moonshot.ai. We subclass OpenAIProvider with a different base URL and
 * tier models. Kimi is known for very long context windows.
 */

import { FetchDelegate, ModelTier, ModelInfo, LLMProviderDescription } from './provider.js';
import { OpenAIProvider } from './openai.js';
import { Log } from '../core/timed-log.js';

const log = new Log('KIMI');

export interface KimiConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchFn?: FetchDelegate;
}

const DEFAULT_TIER_MODELS: Record<ModelTier, string> = {
  smart: 'kimi-k2-0905-preview',
  balanced: 'moonshot-v1-32k',
  fast: 'moonshot-v1-8k',
};

interface KimiModelsResponse {
  data: Array<{ id: string; object?: string }>;
}

export class KimiProvider extends OpenAIProvider {
  constructor(config: KimiConfig) {
    super({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl ?? 'https://api.moonshot.ai',
      fetchFn: config.fetchFn,
      tierModels: DEFAULT_TIER_MODELS,
    });
    this.name = 'kimi';
  }

  override async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
      });
      const data = JSON.parse(response.body) as KimiModelsResponse;
      return data.data.map(m => ({ id: m.id, name: m.id }));
    } catch (err) {
      log.warn(`Failed to fetch models: ${err instanceof Error ? err.message : String(err)}`);
      return [
        { id: 'kimi-k2-0905-preview', name: 'Kimi K2 (preview)' },
        { id: 'moonshot-v1-128k', name: 'Moonshot v1 128k' },
        { id: 'moonshot-v1-32k', name: 'Moonshot v1 32k' },
        { id: 'moonshot-v1-8k', name: 'Moonshot v1 8k' },
      ];
    }
  }

  override describe(): LLMProviderDescription {
    return {
      id: 'kimi',
      label: 'Kimi',
      storageSuffix: 'kimiApiKey',
      credentialMode: 'apiKey',
      credentialLabel: 'Kimi (Moonshot) API Key',
      credentialPlaceholder: 'sk-...',
      models: [
        { id: 'kimi-k2-0905-preview', name: 'Kimi K2 (preview)' },
        { id: 'moonshot-v1-128k', name: 'Moonshot v1 128k' },
        { id: 'moonshot-v1-32k', name: 'Moonshot v1 32k' },
        { id: 'moonshot-v1-8k', name: 'Moonshot v1 8k' },
      ],
      defaultTierModels: DEFAULT_TIER_MODELS,
    };
  }
}

export function createKimiProvider(): KimiProvider | undefined {
  const apiKey = (globalThis as Record<string, unknown>).MOONSHOT_API_KEY as string | undefined;
  if (!apiKey) {
    log.warn('No API key found');
    return undefined;
  }
  return new KimiProvider({ apiKey });
}
