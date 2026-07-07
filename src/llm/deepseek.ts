/**
 * DeepSeek API integration.
 *
 * DeepSeek's public API is OpenAI-compatible (POST /chat/completions), so we
 * subclass OpenAIProvider with different base URL and tier models.
 */

import { FetchDelegate, ModelTier, ModelInfo, LLMProviderDescription, LLMCompletionOptions } from './provider.js';
import { OpenAIProvider, OpenAIRequest, OpenAIReasoningProfile } from './openai.js';
import { Log } from '../core/timed-log.js';

const log = new Log('DEEPSEEK');

export interface DeepSeekConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchFn?: FetchDelegate;
}

// The deepseek-reasoner / deepseek-chat aliases stop resolving 2026-07-24 and
// currently downgrade the smart slot to V4-Flash; use the explicit V4 ids. Pro
// reasons; Flash serves the non-thinking balanced/fast tiers.
const DEFAULT_TIER_MODELS: Record<ModelTier, string> = {
  smart: 'deepseek-v4-pro',
  balanced: 'deepseek-v4-flash',
  fast: 'deepseek-v4-flash',
};

/** Reasoning models: the explicit pro id or the legacy reasoner alias. */
function deepseekReasons(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes('reasoner') || m.includes('-pro');
}

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

  protected override reasoningProfile(model: string): OpenAIReasoningProfile {
    // max_tokens INCLUDES the chain-of-thought (32k default / 64k ceiling).
    return { supportsEffort: deepseekReasons(model), reasons: deepseekReasons(model), maxOutput: 64000 };
  }

  protected override applyReasoning(request: OpenAIRequest, model: string, options: LLMCompletionOptions): { reasoningActive: boolean } {
    // Non-thinking (chat/flash): send nothing. Reasoner accepts reasoning_effort
    // "high" or "max" only; it ignores sampling params, so we don't add verbosity.
    if (!deepseekReasons(model)) return { reasoningActive: false };
    const effort = this.resolveEffort(options);
    request.reasoning_effort = effort === 'max' || effort === 'xhigh' ? 'max' : 'high';
    return { reasoningActive: true };
  }

  // The DeepSeek chat API is text-only across the catalog
  protected override modelVision(_modelId: string): boolean | undefined {
    return false;
  }

  override async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
      });
      const data = JSON.parse(response.body) as DeepSeekModelsResponse;
      return data.data.map(m => ({ id: m.id, name: m.id, vision: false }));
    } catch (err) {
      log.warn(`Failed to fetch models: ${err instanceof Error ? err.message : String(err)}`);
      return [
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', vision: false },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', vision: false },
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
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', vision: false },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', vision: false },
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
