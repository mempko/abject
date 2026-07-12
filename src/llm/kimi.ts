/**
 * Kimi (Moonshot AI) API integration.
 *
 * Kimi exposes an OpenAI-compatible chat-completions endpoint at
 * api.moonshot.ai. We subclass OpenAIProvider with a different base URL and
 * tier models. Kimi is known for very long context windows.
 */

import { FetchDelegate, ModelTier, ModelInfo, LLMProviderDescription, LLMCompletionOptions } from './provider.js';
import { OpenAIProvider, OpenAIRequest, OpenAIReasoningProfile } from './openai.js';
import { Log } from '../core/timed-log.js';

const log = new Log('KIMI');

export interface KimiConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchFn?: FetchDelegate;
}

// kimi-k2-0905-preview was discontinued May 2026; kimi-k2.6 is the current
// reasoning flagship. moonshot-v1-* are non-reasoning and still active.
const DEFAULT_TIER_MODELS: Record<ModelTier, string> = {
  smart: 'kimi-k2.6',
  balanced: 'moonshot-v1-32k',
  fast: 'moonshot-v1-8k',
  code: 'kimi-k2.6',
};

/** k2.5+ / k2-thinking reason via a thinking param; moonshot-v1-* do not. */
function kimiReasons(model: string): boolean {
  return /k2\.\d|k2-thinking/.test(model.toLowerCase());
}

/** Output ceiling — small for the small-context moonshot models so a big cap
 * can never starve the prompt. */
function kimiMaxOutput(model: string): number {
  const m = model.toLowerCase();
  if (m.includes('v1-8k')) return 4096;
  if (m.includes('v1-32k')) return 8192;
  if (m.includes('v1-128k')) return 32000;
  return 32000;
}

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

  protected override reasoningProfile(model: string): OpenAIReasoningProfile {
    return { supportsEffort: false, reasons: kimiReasons(model), maxOutput: kimiMaxOutput(model) };
  }

  protected override applyReasoning(request: OpenAIRequest, model: string, _options: LLMCompletionOptions): { reasoningActive: boolean } {
    // Moonshot ignores reasoning_effort/verbosity; thinking models take a
    // thinking toggle. reasoning_content shares max_tokens (sized by the base).
    if (!kimiReasons(model)) return { reasoningActive: false };
    request.thinking = { type: 'enabled' };
    return { reasoningActive: true };
  }

  // Moonshot marks vision-capable models explicitly ("-vision-" variants);
  // the K-series and plain moonshot-v1 chat models are text-only
  protected override modelVision(modelId: string): boolean | undefined {
    return /vision/i.test(modelId);
  }

  override async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
      });
      const data = JSON.parse(response.body) as KimiModelsResponse;
      return data.data.map(m => ({ id: m.id, name: m.id, vision: this.modelVision(m.id) }));
    } catch (err) {
      log.warn(`Failed to fetch models: ${err instanceof Error ? err.message : String(err)}`);
      return [
        { id: 'kimi-k2.6', name: 'Kimi K2.6', vision: false },
        { id: 'moonshot-v1-128k', name: 'Moonshot v1 128k', vision: false },
        { id: 'moonshot-v1-32k', name: 'Moonshot v1 32k', vision: false },
        { id: 'moonshot-v1-8k', name: 'Moonshot v1 8k', vision: false },
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
        { id: 'kimi-k2.6', name: 'Kimi K2.6', vision: false },
        { id: 'moonshot-v1-128k', name: 'Moonshot v1 128k', vision: false },
        { id: 'moonshot-v1-32k', name: 'Moonshot v1 32k', vision: false },
        { id: 'moonshot-v1-8k', name: 'Moonshot v1 8k', vision: false },
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
