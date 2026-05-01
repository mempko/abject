/**
 * MiniMax API integration.
 *
 * MiniMax offers an OpenAI-compatible chat-completions endpoint at
 * api.minimax.io. We subclass OpenAIProvider with a different base URL and
 * tier models.
 */

import { FetchDelegate, ModelTier, ModelInfo, LLMProviderDescription } from './provider.js';
import { OpenAIProvider } from './openai.js';
import { Log } from '../core/timed-log.js';

const log = new Log('MINIMAX');

export interface MiniMaxConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchFn?: FetchDelegate;
}

const DEFAULT_TIER_MODELS: Record<ModelTier, string> = {
  smart: 'MiniMax-M2',
  balanced: 'MiniMax-M1',
  fast: 'abab6.5s-chat',
};

export class MiniMaxProvider extends OpenAIProvider {
  constructor(config: MiniMaxConfig) {
    super({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl ?? 'https://api.minimax.io',
      fetchFn: config.fetchFn,
      tierModels: DEFAULT_TIER_MODELS,
    });
    this.name = 'minimax';
  }

  // MiniMax does not expose a /v1/models discovery endpoint (returns 404),
  // so we return a curated list instead of querying the API.
  override async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'MiniMax-M2', name: 'MiniMax M2' },
      { id: 'MiniMax-M1', name: 'MiniMax M1' },
      { id: 'abab6.5-chat', name: 'abab6.5 Chat' },
      { id: 'abab6.5s-chat', name: 'abab6.5s Chat' },
    ];
  }

  override describe(): LLMProviderDescription {
    return {
      id: 'minimax',
      label: 'MiniMax',
      storageSuffix: 'minimaxApiKey',
      credentialMode: 'apiKey',
      credentialLabel: 'MiniMax API Key',
      credentialPlaceholder: 'sk-...',
      models: [
        { id: 'MiniMax-M2', name: 'MiniMax M2' },
        { id: 'MiniMax-M1', name: 'MiniMax M1' },
        { id: 'abab6.5-chat', name: 'abab6.5 Chat' },
        { id: 'abab6.5s-chat', name: 'abab6.5s Chat' },
      ],
      defaultTierModels: DEFAULT_TIER_MODELS,
    };
  }
}

export function createMiniMaxProvider(): MiniMaxProvider | undefined {
  const apiKey = (globalThis as Record<string, unknown>).MINIMAX_API_KEY as string | undefined;
  if (!apiKey) {
    log.warn('No API key found');
    return undefined;
  }
  return new MiniMaxProvider({ apiKey });
}
