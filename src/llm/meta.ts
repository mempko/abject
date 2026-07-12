/**
 * Meta Model API integration.
 *
 * Meta's Model API (launched July 2026) exposes an OpenAI-compatible
 * chat-completions endpoint at api.meta.ai and currently serves one model:
 * muse-spark-1.1 — multimodal (text/image/video/PDF in, text out), 1M-token
 * context, 131k max output, reasoning_effort supported. We subclass
 * OpenAIProvider with the Meta base URL and route every tier to the sole
 * model until Meta ships variants.
 */

import { FetchDelegate, ModelTier, ModelInfo, LLMProviderDescription } from './provider.js';
import { OpenAIProvider, OpenAIReasoningProfile } from './openai.js';
import { Log } from '../core/timed-log.js';

const log = new Log('META');

export interface MetaConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchFn?: FetchDelegate;
}

// muse-spark-1.1 is the only model the Model API serves today; all tiers
// route to it. Split the tiers when Meta ships smaller/faster variants.
const DEFAULT_TIER_MODELS: Record<ModelTier, string> = {
  smart: 'muse-spark-1.1',
  balanced: 'muse-spark-1.1',
  fast: 'muse-spark-1.1',
  code: 'muse-spark-1.1',
};

/** Muse Spark's documented output ceiling (context window is 1,048,576). */
const MUSE_SPARK_MAX_OUTPUT = 131072;

interface MetaModelsResponse {
  data: Array<{ id: string; object?: string }>;
}

export class MetaProvider extends OpenAIProvider {
  constructor(config: MetaConfig) {
    super({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl ?? 'https://api.meta.ai',
      fetchFn: config.fetchFn,
      tierModels: DEFAULT_TIER_MODELS,
    });
    this.name = 'meta';
  }

  // Muse Spark reasons and takes reasoning_effort exactly like the OpenAI
  // base; only the output ceiling differs.
  protected override reasoningProfile(_model: string): OpenAIReasoningProfile {
    return { supportsEffort: true, reasons: true, maxOutput: MUSE_SPARK_MAX_OUTPUT };
  }

  // Muse Spark models are multimodal (image/video/PDF input).
  protected override modelVision(modelId: string): boolean | undefined {
    if (/muse-spark/i.test(modelId)) return true;
    return undefined;
  }

  override async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
      });
      const data = JSON.parse(response.body) as MetaModelsResponse;
      return data.data.map(m => ({ id: m.id, name: m.id, vision: this.modelVision(m.id) }));
    } catch (err) {
      log.warn(`Failed to fetch models: ${err instanceof Error ? err.message : String(err)}`);
      return [
        { id: 'muse-spark-1.1', name: 'Muse Spark 1.1', vision: true },
      ];
    }
  }

  override describe(): LLMProviderDescription {
    return {
      id: 'meta',
      label: 'Meta',
      storageSuffix: 'metaApiKey',
      credentialMode: 'apiKey',
      credentialLabel: 'Meta Model API Key',
      credentialPlaceholder: 'MODEL_API_KEY from the Model API dashboard',
      models: [
        { id: 'muse-spark-1.1', name: 'Muse Spark 1.1', vision: true },
      ],
      defaultTierModels: DEFAULT_TIER_MODELS,
    };
  }
}

export function createMetaProvider(): MetaProvider | undefined {
  const apiKey = (globalThis as Record<string, unknown>).META_API_KEY as string | undefined;
  if (!apiKey) {
    log.warn('No API key found');
    return undefined;
  }
  return new MetaProvider({ apiKey });
}
