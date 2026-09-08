import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider } from './anthropic.js';

test('Anthropic completion and streaming use model sampling defaults, including legacy caller options', async t => {
  const requests: Record<string, unknown>[] = [];
  const respond = (init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if ('temperature' in body) {
      return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: '`temperature` is deprecated for this model.' } }), { status: 400 });
    }
    if (body.stream) {
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 2, output_tokens: 0 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fixture response' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Fixture response' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 2 } }));
  };
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => respond(init));
  const provider = new AnthropicProvider({ apiKey: 'fixture-key', model: 'claude-opus-5', fetchFn: async (_url, init) => {
    const response = respond(init);
    return { ok: response.ok, status: response.status, statusText: response.statusText, headers: {}, body: await response.text() };
  } });
  // Old scripts or saved options may still contain the removed field.
  const options = { maxTokens: 256, temperature: 0.2 };
  const messages = [{ role: 'user' as const, content: 'Reply with the fixture response' }];
  assert.equal((await provider.complete(messages, options)).content, 'Fixture response');
  let content = '';
  for await (const chunk of provider.stream(messages, options)) content += chunk.content;
  assert.equal(content, 'Fixture response');
  assert.equal(requests.length, 2);
  for (const body of requests) assert.equal('temperature' in body, false);
});
