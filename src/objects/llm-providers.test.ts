/**
 * LLM providers implemented by other abjects: an abject registers with the
 * LLM object by message (registerProvider) and serves the calls routed to it
 * (providerComplete, providerStream + providerChunk).
 *
 * In-process: a real Runtime (bus, Registry, Factory) and a real LLMObject
 * with no built-in providers configured, so every call here goes to an
 * abject-backed provider.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Runtime } from '../runtime/runtime.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId, AbjectManifest, AbjectMessage, InterfaceId, TypeId } from '../core/types.js';
import { LLMObject } from './llm-object.js';
import { Packages } from './packages.js';
import { packageOwner } from '../core/packages.js';
import { ingestAllExtensions } from '../sandbox/extensions.js';
import { writePackageConfig } from '../sandbox/package-config.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

function manifestFor(name: string, methods: string[] = []): AbjectManifest {
  return {
    name,
    description: `${name} test object`,
    version: '1.0.0',
    interface: {
      id: `abjects:test:${name.toLowerCase()}` as InterfaceId,
      name,
      description: name,
      methods: methods.map(m => ({ name: m, description: m, parameters: [] })),
    },
    tags: ['test'],
  } as unknown as AbjectManifest;
}

/** Calls the LLM on a test's behalf and collects the stream chunks it is sent. */
class Probe extends Abject {
  chunks: string[] = [];
  constructor() {
    super({ manifest: manifestFor('Probe') });
    this.on('llmChunk', (m: AbjectMessage) => { this.chunks.push((m.payload as { content: string }).content); });
  }
  ask<T>(to: AbjectId, method: string, payload: unknown = {}, timeoutMs = 10_000): Promise<T> {
    return this.request<T>(request(this.id, to, method, payload), timeoutMs);
  }
}

/** A provider written as an ordinary abject: completions only. */
class EchoProvider extends Abject {
  constructor(name = 'EchoProvider', private readonly fail = false) {
    super({ manifest: manifestFor(name, ['providerComplete']) });
    this.on('providerComplete', (m: AbjectMessage) => {
      if (this.fail) throw new Error('upstream refused the request');
      const { messages, options } = m.payload as { messages: Array<{ role: string; content: string }>; options: { model?: string } };
      const last = messages.filter(x => x.role === 'user').pop()?.content ?? '';
      return { content: `echo(${options.model}): ${last}`, usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.001 } };
    });
  }
  register(llm: AbjectId, spec: unknown): Promise<{ name: string; registered: boolean; backends: number }> {
    return this.request(request(this.id, llm, 'registerProvider', spec));
  }
  unregister(llm: AbjectId, name: string): Promise<boolean> {
    return this.request(request(this.id, llm, 'unregisterProvider', { name }));
  }
}

/** A provider shipped as a script package: streams, and registers itself. */
const GATEWAY_SOURCE = `({
  async join(msg) { return this.call(this.dep('LLM'), 'registerProvider', msg.payload); },
  providerComplete(msg) { return { content: 'served by ' + this.id, usage: { inputTokens: 1, outputTokens: 1 } }; },
  async providerStream(msg) {
    const { streamId } = msg.payload;
    const parts = ['one ', 'two ', 'three'];
    for (const p of parts) await this.emit(msg.routing.from, 'providerChunk', { streamId, content: p });
    return { chunks: parts.length, stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 3 } };
  }
})`;

async function start(): Promise<{ rt: Runtime; probe: Probe; llm: LLMObject }> {
  const rt = new Runtime();
  await rt.start();
  const llm = new LLMObject();
  await rt.objectFactory.spawnInstance(llm);
  const probe = new Probe();
  await rt.objectFactory.spawnInstance(probe);
  return { rt, probe, llm };
}

const userAsks = (text: string) => [{ role: 'user', content: text }];

test('an abject registers as a provider and serves completions routed to it', async () => {
  const { rt, probe, llm } = await start();
  try {
    const echo = new EchoProvider();
    await rt.objectFactory.spawnInstance(echo);
    const reg = await echo.register(llm.id, {
      name: 'echo', label: 'Echo', models: [{ id: 'echo-1', name: 'Echo One' }], defaultTierModels: { balanced: 'echo-1' },
    });
    assert.deepEqual(reg, { name: 'echo', registered: true, backends: 1 });

    assert.ok((await probe.ask<string[]>(llm.id, 'listProviders')).includes('echo'));
    const desc = (await probe.ask<Array<{ id: string; label: string; credentialMode: string }>>(llm.id, 'listProviderDescriptions'))
      .find(d => d.id === 'echo');
    assert.deepEqual({ label: desc?.label, credentialMode: desc?.credentialMode }, { label: 'Echo', credentialMode: 'none' },
      'shown in Settings with no credential row');
    const models = await probe.ask<Array<{ id: string }>>(llm.id, 'listProviderModels', { provider: 'echo' });
    assert.deepEqual(models.map(m => m.id), ['echo-1']);

    const result = await probe.ask<{ content: string }>(llm.id, 'complete', { messages: userAsks('hello'), provider: 'echo' });
    assert.equal(result.content, 'echo(echo-1): hello', 'the default model is filled in for the provider');

    // Tier routing reaches it like any built-in provider.
    await probe.ask(llm.id, 'setTierRouting', { tierRouting: { fast: { provider: 'echo', model: 'echo-1' } } });
    const routed = await probe.ask<{ content: string }>(llm.id, 'complete', { messages: userAsks('via tier'), options: { tier: 'fast' } });
    assert.equal(routed.content, 'echo(echo-1): via tier');

    const ledger = await probe.ask<{ entries: Array<{ provider: string; status: string; costUsd?: number }> }>(llm.id, 'getLedger', {});
    const calls = ledger.entries.filter(e => e.provider === 'echo');
    assert.equal(calls.length, 2, 'both calls are in the ledger under the provider');
    assert.ok(calls.every(e => e.status === 'complete' && e.costUsd === 0.001), 'the provider-reported cost prices the call');
  } finally {
    await rt.stop();
  }
});

test('provider names: built-ins are reserved, a live holder keeps its name, a gone one frees it', async () => {
  const { rt, llm } = await start();
  try {
    const first = new EchoProvider('First');
    const second = new EchoProvider('Second');
    await rt.objectFactory.spawnInstance(first);
    await rt.objectFactory.spawnInstance(second);

    await assert.rejects(first.register(llm.id, { name: 'anthropic' }), /built-in provider name/);
    await assert.rejects(first.register(llm.id, { name: 'Has Spaces' }), /name must be/);
    await assert.rejects(first.register(llm.id, { name: 'ok', defaultTierModels: { huge: 'x' } }), /unknown tier/);

    await first.register(llm.id, { name: 'shared-name' });
    await assert.rejects(second.register(llm.id, { name: 'shared-name' }), /another abject that is still running/);
    await assert.rejects(second.unregister(llm.id, 'shared-name'), /only an abject serving/);

    // Re-registering from the holder updates it.
    const again = await first.register(llm.id, { name: 'shared-name', label: 'Renamed' });
    assert.equal(again.backends, 1);

    await rt.objectFactory.kill(first.id);
    const taken = await second.register(llm.id, { name: 'shared-name' });
    assert.equal(taken.registered, true, 'the name is free once its holder is gone');

    assert.equal(await second.unregister(llm.id, 'shared-name'), true);
    const probe = new Probe();
    await rt.objectFactory.spawnInstance(probe);
    assert.ok(!(await probe.ask<string[]>(llm.id, 'listProviders')).includes('shared-name'));
  } finally {
    await rt.stop();
  }
});

test('a provider\'s own failure reaches the caller as an error', async () => {
  const { rt, probe, llm } = await start();
  try {
    const broken = new EchoProvider('Broken', true);
    await rt.objectFactory.spawnInstance(broken);
    await broken.register(llm.id, { name: 'broken' });
    await assert.rejects(
      probe.ask(llm.id, 'complete', { messages: userAsks('hi'), provider: 'broken' }),
      /upstream refused the request/,
    );
  } finally {
    await rt.stop();
  }
});

test('a package provider streams, and every workspace\'s copy of it backs one name with failover', async () => {
  const { rt, probe, llm } = await start();
  try {
    const factory = rt.objectFactory;
    factory.registerPackageType('Gateway', {
      runtime: 'script', scope: 'workspace', manifest: manifestFor('Gateway', ['join', 'providerComplete', 'providerStream']),
      source: GATEWAY_SOURCE, owner: packageOwner('gateway-pkg'),
    });
    const spawnIn = async (ws: string) => (await factory.spawn({
      manifest: { name: 'Gateway', description: '', version: '1.0.0', tags: [] } as unknown as AbjectManifest,
      typeId: `peer/${ws}/Gateway` as TypeId,
    })).objectId;
    const a = await spawnIn('ws1');
    const b = await spawnIn('ws2');

    const spec = { name: 'gateway', streaming: true, models: [{ id: 'gw-1', name: 'Gateway One' }] };
    assert.equal((await probe.ask<{ backends: number }>(a, 'join', spec)).backends, 1);
    assert.equal((await probe.ask<{ backends: number }>(b, 'join', spec)).backends, 2,
      'the second workspace\'s copy of the same package joins the provider');

    // Streaming: chunks reach the caller as llmChunk events, and the reply
    // carries the whole text.
    probe.chunks = [];
    const streamed = await probe.ask<{ content: string }>(llm.id, 'stream', { messages: userAsks('count'), provider: 'gateway' });
    assert.equal(streamed.content, 'one two three');
    assert.equal(probe.chunks.join(''), 'one two three');

    const first = await probe.ask<{ content: string }>(llm.id, 'complete', { messages: userAsks('who'), provider: 'gateway' });
    assert.equal(first.content, `served by ${a}`);

    // The serving copy goes away: the next call fails over to the other one.
    await factory.kill(a);
    const second = await probe.ask<{ content: string }>(llm.id, 'complete', { messages: userAsks('who now'), provider: 'gateway' });
    assert.equal(second.content, `served by ${b}`);
  } finally {
    await rt.stop();
  }
});

// ── The OpenAI-compatible example package ──────────────────────────

/** Stands in for HttpClient: records requests and answers like an OpenAI endpoint. */
class FakeHttpClient extends Abject {
  requests: Array<{ url: string; headers?: Record<string, string>; body: Record<string, unknown> }> = [];
  constructor() {
    super({ manifest: manifestFor('HttpClient', ['request']) });
    this.on('request', (m: AbjectMessage) => {
      const req = m.payload as { url: string; headers?: Record<string, string>; body: string };
      this.requests.push({ url: req.url, headers: req.headers, body: JSON.parse(req.body) });
      return {
        status: 200, statusText: 'OK', headers: {}, ok: true,
        body: JSON.stringify({ choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 2 } }),
      };
    });
  }
}

test('the OpenAI-compatible example registers from its settings, maps calls to the endpoint, and follows a rename', async () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const example = path.join(repo, 'examples/openai-compatible-provider');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abject-llm-example-'));
  const saved = { data: process.env.ABJECTS_DATA_DIR, dirs: process.env.ABJECTS_PACKAGE_DIRS, native: process.env.ABJECTS_NATIVE_DIR };
  const { rt, probe, llm } = await start();
  try {
    // Build the package the way `pnpm forge --build-only` does: compile the
    // TypeScript entry to the bare handler-map expression.
    const pkgDir = path.join(root, 'packages', 'OpenAICompatible');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'native'), { recursive: true });
    const { transform } = await import('esbuild');
    const { code } = await transform(fs.readFileSync(path.join(example, 'provider.ts'), 'utf-8'), { loader: 'ts', target: 'es2022', legalComments: 'none' });
    fs.writeFileSync(path.join(pkgDir, 'main.js'), code.trim().replace(/;\s*$/, ''));
    fs.copyFileSync(path.join(example, 'manifest.json'), path.join(pkgDir, 'manifest.json'));
    const meta = JSON.parse(fs.readFileSync(path.join(example, 'abject.json'), 'utf-8'));
    fs.writeFileSync(path.join(pkgDir, 'abject.json'), JSON.stringify({ ...meta, source: 'main.js' }));

    process.env.ABJECTS_DATA_DIR = path.join(root, 'data');
    process.env.ABJECTS_PACKAGE_DIRS = path.join(root, 'packages');
    process.env.ABJECTS_NATIVE_DIR = path.join(root, 'native');
    writePackageConfig({ dirs: [], disabled: [], settings: { OpenAICompatible: {
      baseUrl: 'https://gw.example/v1/', apiKey: 'secret-key', models: 'big-model, small-model', name: 'testgw', label: 'Test gateway',
    } } });

    const http = new FakeHttpClient();
    await rt.objectFactory.spawnInstance(http);
    await rt.objectFactory.spawnInstance(new Packages());
    assert.deepEqual((await ingestAllExtensions(rt.objectFactory)).map(e => e.typeName), ['OpenAICompatible']);
    const provider = (await rt.objectFactory.spawn({
      manifest: { name: 'OpenAICompatible', description: '', version: '1.0.0', tags: [] } as unknown as AbjectManifest,
      typeId: 'peer/ws/OpenAICompatible' as TypeId,
    })).objectId;

    const started = await probe.ask<{ registered: boolean }>(provider, 'startup');
    assert.equal(started.registered, true);
    const desc = (await probe.ask<Array<{ id: string; label: string; defaultTierModels: Record<string, string> }>>(llm.id, 'listProviderDescriptions'))
      .find(d => d.id === 'testgw');
    assert.equal(desc?.label, 'Test gateway');
    assert.equal(desc?.defaultTierModels.fast, 'small-model');

    const result = await probe.ask<{ content: string }>(llm.id, 'complete', {
      provider: 'testgw',
      options: { maxTokens: 64 },
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
      ],
    });
    assert.equal(result.content, 'pong');
    const sent = http.requests.at(-1)!;
    assert.equal(sent.url, 'https://gw.example/v1/chat/completions');
    assert.equal(sent.headers?.Authorization, 'Bearer secret-key');
    assert.equal(sent.body.model, 'big-model');
    assert.equal(sent.body.max_tokens, 64);
    const userMsg = (sent.body.messages as Array<{ role: string; content: unknown }>).find(m => m.role === 'user');
    assert.deepEqual(userMsg?.content, [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);

    // Renaming the provider in its settings re-registers it under the new id.
    const packagesId = (await probe.ask<Array<{ id: AbjectId }>>(rt.objectRegistry.id, 'discover', { name: 'Packages' }))[0].id;
    await probe.ask(packagesId, 'setSettings', { name: 'OpenAICompatible', values: { name: 'renamed-gw' } });
    let providers: string[] = [];
    for (let i = 0; i < 50; i++) {
      providers = await probe.ask<string[]>(llm.id, 'listProviders');
      if (providers.includes('renamed-gw')) break;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(providers.includes('renamed-gw'), 'registered under the new name');
    assert.ok(!providers.includes('testgw'), 'the old name was withdrawn');
  } finally {
    await rt.stop();
    for (const [k, v] of [['ABJECTS_DATA_DIR', saved.data], ['ABJECTS_PACKAGE_DIRS', saved.dirs], ['ABJECTS_NATIVE_DIR', saved.native]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
