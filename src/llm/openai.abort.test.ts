/**
 * Kill on a non-streaming OpenAI call while the response body is still
 * arriving.
 *
 * The server is a node:http server on 127.0.0.1 that sends the status line
 * and headers at once, then holds the body open, standing in for a reply
 * whose body is slow. Nothing leaves loopback, and the provider talks to it
 * with the real fetch(). The one hook is a spy on Response.prototype.text
 * that notes when the body read starts and calls through.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getEventListeners } from 'node:events';
import type { AddressInfo } from 'node:net';
import { OpenAIProvider } from './openai.js';

const REPLY = JSON.stringify({
  choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1 },
});

/** A server that answers each request with `status`, sends `head` of the body, and holds the rest until `finish()`. */
async function slowBodyServer(status: number, head: string) {
  let requests = 0;
  let closed = 0;
  const held: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    requests++;
    req.resume();
    res.socket?.on('close', () => { closed++; });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.write(head);
    held.push(res);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests: () => requests,
    closed: () => closed,
    /** Send the rest of every held body. */
    finish: (rest: string) => { for (const res of held.splice(0)) res.end(rest); },
    stop: async () => {
      for (const res of held.splice(0)) res.destroy();
      server.closeAllConnections();
      await new Promise<void>(r => server.close(() => r()));
    },
  };
}

/** Settle `p` within `ms`, or fail naming what never happened. */
async function within<T>(ms: number, what: string, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: still pending after ${ms} ms`)), ms);
  });
  try { return await Promise.race([p, late]); } finally { clearTimeout(timer); }
}

/**
 * Resolves when a body from `baseUrl` starts being read, so a Kill sent after
 * it lands in the body read and not in fetch() itself. Other responses in
 * this process are let through unmarked. restore() puts
 * Response.prototype.text back; the tests share one process.
 */
function bodyReadStarts(baseUrl: string): { started: Promise<void>; restore: () => void } {
  const original = Response.prototype.text;
  let mark!: () => void;
  const started = new Promise<void>(r => { mark = r; });
  Response.prototype.text = function (this: Response) {
    if (this.url.startsWith(baseUrl)) mark();
    return original.call(this);
  };
  return { started, restore: () => { Response.prototype.text = original; } };
}

async function until(what: string, done: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting until ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

const ask = [{ role: 'user' as const, content: 'hi' }];

test('Kill while the body is still arriving closes the connection and rejects at once', async () => {
  const server = await slowBodyServer(200, REPLY.slice(0, 20));
  const bodyRead = bodyReadStarts(server.baseUrl);
  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseUrl: server.baseUrl });
    const kill = new AbortController();
    const call = provider.complete(ask, { signal: kill.signal });
    call.catch(() => { /* asserted below */ });

    await until('the request reaches the server', () => server.requests() === 1);
    await within(1000, 'the body read to start', bodyRead.started);
    kill.abort();

    // A retry would first wait out the 1 s backoff, so rejecting sooner means none was made.
    await assert.rejects(within(500, 'complete() after Kill', call), (err: Error) => err.name === 'AbortError');
    await until('the server sees the socket close', () => server.closed() === 1);
    assert.equal(server.requests(), 1, 'one request reached the server');
    assert.equal(getEventListeners(kill.signal, 'abort').length, 0, 'the abort listener is gone once the call settles');
  } finally { bodyRead.restore(); await server.stop(); }
});

test('Kill while an error body is still arriving rejects as an abort, not as an API error', async () => {
  const server = await slowBodyServer(500, '{"error":');
  const bodyRead = bodyReadStarts(server.baseUrl);
  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseUrl: server.baseUrl });
    const kill = new AbortController();
    const call = provider.complete(ask, { signal: kill.signal });
    call.catch(() => { /* asserted below */ });

    await until('the request reaches the server', () => server.requests() === 1);
    await within(1000, 'the body read to start', bodyRead.started);
    kill.abort();

    // A retry would first wait out the 1 s backoff, so rejecting sooner means none was made.
    await assert.rejects(within(500, 'complete() after Kill', call), (err: Error) => err.name === 'AbortError');
    await until('the server sees the socket close', () => server.closed() === 1);
    assert.equal(server.requests(), 1, 'one request reached the server');
    assert.equal(getEventListeners(kill.signal, 'abort').length, 0, 'the abort listener is gone once the call settles');
  } finally { bodyRead.restore(); await server.stop(); }
});

test('a slow body that is not killed still completes, and leaves no abort listener behind', async () => {
  const server = await slowBodyServer(200, REPLY.slice(0, 20));
  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseUrl: server.baseUrl });
    const kill = new AbortController();
    const call = provider.complete(ask, { signal: kill.signal });

    await until('the request reaches the server', () => server.requests() === 1);
    await new Promise(r => setTimeout(r, 100));
    server.finish(REPLY.slice(20));

    const result = await within(1000, 'complete() with the whole body sent', call);
    assert.equal(result.content, 'hello');
    assert.equal(getEventListeners(kill.signal, 'abort').length, 0, 'the abort listener is gone once the call settles');
  } finally { await server.stop(); }
});

test('an error reply that is not killed reads as the API error, and leaves no abort listener behind', async () => {
  // 400 is not retried, so this is one request.
  const server = await slowBodyServer(400, '{"error":');
  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseUrl: server.baseUrl });
    const kill = new AbortController();
    const call = provider.complete(ask, { signal: kill.signal });
    call.catch(() => { /* asserted below */ });

    await until('the request reaches the server', () => server.requests() === 1);
    server.finish('"bad request"}');

    await assert.rejects(within(1000, 'complete() with a 400 reply', call), /LLM API error \(400\): \{"error":"bad request"\}/);
    assert.equal(server.requests(), 1, 'one request reached the server');
    assert.equal(getEventListeners(kill.signal, 'abort').length, 0, 'the abort listener is gone once the call settles');
  } finally { await server.stop(); }
});

test('a request that fails before any reply leaves no abort listener behind', async () => {
  const server = http.createServer((req) => { req.socket.destroy(); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseUrl: `http://127.0.0.1:${port}` });
    const kill = new AbortController();
    // BaseLLMProvider.fetch itself, so the failure is not retried with backoff.
    const fetchDirect = (provider as any).fetch.bind(provider) as (url: string, init: RequestInit, opts: { timeout: number }) => Promise<unknown>;
    await assert.rejects(within(1000, 'fetch() to a server that drops the connection',
      fetchDirect(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', body: '{}', signal: kill.signal }, { timeout: 5000 })));
    assert.equal(getEventListeners(kill.signal, 'abort').length, 0, 'the abort listener is gone once the request fails');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
});
