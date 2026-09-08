import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PeerLLMProvider } from './peerllm.js';
import { estimateCostUsd, lookupPricing } from './pricing.js';
import { LLMObject } from '../objects/llm-object.js';

test('PeerLLM describes its credential, model, and tier defaults', () => {
  const description = new PeerLLMProvider({ apiKey: '' }).describe();
  assert.equal(description.id, 'peerllm');
  assert.equal(description.label, 'PeerLLM');
  assert.equal(description.storageSuffix, 'peerllmApiKey');
  assert.equal(description.credentialMode, 'apiKey');
  assert.deepEqual(description.models, [{
    id: 'LLooMA1.0',
    name: 'LLooMA 1.0 (Orchestration)',
    vision: false,
    efforts: [],
  }]);
  assert.deepEqual(description.defaultTierModels, {
    smart: 'LLooMA1.0',
    balanced: 'LLooMA1.0',
    fast: 'LLooMA1.0',
    code: 'LLooMA1.0',
  });
});

test('PeerLLM lists public models without authorization', async () => {
  let capturedUrl = '';
  let capturedOptions: unknown;
  const provider = new PeerLLMProvider({
    apiKey: 'secret',
    fetchFn: async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: [{ id: 'LLooMA1.0' }, { id: 'community/model' }] }),
      };
    },
  });

  assert.deepEqual(await provider.listModels(), [
    { id: 'LLooMA1.0', name: 'LLooMA1.0', vision: false, efforts: [] },
    { id: 'community/model', name: 'community/model', vision: false, efforts: [] },
  ]);
  assert.equal(capturedUrl, 'https://api.peerllm.com/v1/models');
  const request = capturedOptions as { method?: string; headers?: Record<string, string> };
  assert.equal(request.method, 'GET');
  assert.equal(request.headers?.Authorization, undefined);
});

test('PeerLLM sends compatible chat completions and translates max tokens', async () => {
  let capturedUrl = '';
  let capturedOptions: unknown;
  const provider = new PeerLLMProvider({
    apiKey: 'peer-key',
    fetchFn: async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'chatcmpl-peer',
          object: 'chat.completion',
          created: 1,
          model: 'LLooMA1.0',
          choices: [{ index: 0, message: { role: 'assistant', content: 'peer response' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
        }),
      };
    },
  });

  const completion = await provider.complete(
    [{ role: 'user', content: 'hello' }],
    { maxTokens: 256 },
  );
  assert.equal(completion.content, 'peer response');
  assert.equal(capturedUrl, 'https://api.peerllm.com/v1/chat/completions');

  const request = capturedOptions as { headers?: Record<string, string>; body?: string };
  assert.equal(request.headers?.Authorization, 'Bearer peer-key');
  const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
  assert.equal(body.model, 'LLooMA1.0');
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 256);
  for (const unsupported of [
    'max_completion_tokens', 'stop', 'prompt_cache_key', 'reasoning_effort',
    'verbosity', 'usage', 'provider', 'temperature',
  ]) {
    assert.equal(unsupported in body, false, `${unsupported} must not be sent to PeerLLM`);
  }
});

test('PeerLLM uses the public $10-per-million-token rate for every model', () => {
  assert.deepEqual(lookupPricing('peerllm', 'LLooMA1.0'), {
    inputPerMTok: 10,
    outputPerMTok: 10,
    cacheReadPerMTok: 10,
    cacheWritePerMTok: 10,
    source: 'builtin',
  });
  assert.deepEqual(lookupPricing('PeerLLM', 'community/model'), {
    inputPerMTok: 10,
    outputPerMTok: 10,
    cacheReadPerMTok: 10,
    cacheWritePerMTok: 10,
    source: 'builtin',
  });
  assert.equal(estimateCostUsd('peerllm', 'LLooMA2.0', {
    inputTokens: 600,
    outputTokens: 400,
  }), 0.01);
  assert.equal(estimateCostUsd('peerllm', 'Qwen_Qwen3-8B-Q5_K_M', {
    inputTokens: 250,
    outputTokens: 250,
    cacheReadTokens: 250,
    cacheWriteTokens: 250,
  }), 0.01);
});

test('LLMObject advertises and conditionally registers PeerLLM', async () => {
  const llm = new LLMObject();
  assert.ok(llm.listProviderDescriptions().some(provider => provider.id === 'peerllm'));
  assert.equal(llm.listProviders().includes('peerllm'), false);

  await llm.configure({ credentials: { peerllm: 'secret' } });
  assert.ok(llm.listProviders().includes('peerllm'));
});
