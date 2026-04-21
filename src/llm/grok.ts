/**
 * xAI Grok API integration.
 *
 * xAI exposes an OpenAI-compatible chat-completions endpoint at api.x.ai, so
 * we subclass OpenAIProvider with different base URL and tier models.
 */

import { FetchDelegate, ModelTier, ModelInfo } from './provider.js';
import { OpenAIProvider } from './openai.js';
import { Log } from '../core/timed-log.js';

const log = new Log('GROK');

export interface GrokConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchFn?: FetchDelegate;
}

const DEFAULT_TIER_MODELS: Record<ModelTier, string> = {
  smart: 'grok-4',
  balanced: 'grok-4-mini',
  fast: 'grok-4-fast',
};

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

  override async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
      });
      const data = JSON.parse(response.body) as GrokModelsResponse;
      return data.data.map(m => ({ id: m.id, name: m.id }));
    } catch (err) {
      log.warn(`Failed to fetch models: ${err instanceof Error ? err.message : String(err)}`);
      return [
        { id: 'grok-4', name: 'Grok 4' },
        { id: 'grok-4-mini', name: 'Grok 4 Mini' },
        { id: 'grok-4-fast', name: 'Grok 4 Fast' },
      ];
    }
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
