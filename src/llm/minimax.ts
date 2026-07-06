/**
 * MiniMax API integration.
 *
 * MiniMax offers an OpenAI-compatible chat-completions endpoint at
 * api.minimax.io. We subclass OpenAIProvider with a different base URL and
 * tier models.
 */

import { FetchDelegate, ModelTier, ModelInfo, LLMProviderDescription, LLMCompletionOptions } from './provider.js';
import { OpenAIProvider, OpenAIRequest, OpenAIReasoningProfile } from './openai.js';
import { Log } from '../core/timed-log.js';

const log = new Log('MINIMAX');

export interface MiniMaxConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchFn?: FetchDelegate;
}

// MiniMax-M1 and abab6.5s-chat are off the current model list; M3 is the
// reasoning flagship, M2.7 the mid tier, M2.7-highspeed the fast variant.
const DEFAULT_TIER_MODELS: Record<ModelTier, string> = {
  smart: 'MiniMax-M3',
  balanced: 'MiniMax-M2.7',
  fast: 'MiniMax-M2.7-highspeed',
};

/** M2.x / M3 reason (always-on, not effort-tunable); abab models do not. */
function minimaxReasons(model: string): boolean {
  return /minimax-m[23]/.test(model.toLowerCase());
}

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

  protected override reasoningProfile(model: string): OpenAIReasoningProfile {
    return { supportsEffort: false, reasons: minimaxReasons(model), maxOutput: 40000 };
  }

  protected override applyReasoning(request: OpenAIRequest, model: string, _options: LLMCompletionOptions): { reasoningActive: boolean } {
    // M2/M3 reason unconditionally (no effort/enable knob). Split the trace out
    // via reasoning_split so <think> tags don't leak into visible content; the
    // reasoning shares max_tokens (sized generously by the base).
    if (!minimaxReasons(model)) return { reasoningActive: false };
    request.reasoning_split = true;
    return { reasoningActive: true };
  }

  // MiniMax does not expose a /v1/models discovery endpoint (returns 404),
  // so we return a curated list instead of querying the API.
  override async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'MiniMax-M3', name: 'MiniMax M3' },
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
      { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed' },
      { id: 'MiniMax-M2', name: 'MiniMax M2' },
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
        { id: 'MiniMax-M3', name: 'MiniMax M3' },
        { id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
        { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed' },
        { id: 'MiniMax-M2', name: 'MiniMax M2' },
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
