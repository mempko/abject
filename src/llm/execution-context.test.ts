import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodexCliProvider, extractCodexFinalMessage } from './codex-cli.js';
import { checkCodexEvent } from './codex-execution.js';
import { runCliIdle } from './cli-process.js';
import { LLMObject } from '../objects/llm-object.js';
import { EXECUTION_CONTEXT_VERSION } from './execution-context.js';
import { cliIsRetryable } from './provider.js';

const message = (text: string) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });

test('Codex parser returns final output without concatenating progress actions', () => {
  const final = '{"action":"read","path":"settings.ts"}';
  const result = extractCodexFinalMessage([
    message('I could use {"action":"fail"}, but will inspect the owner.'), message(final),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 50, output_tokens: 10 } }),
  ].join('\n'));
  assert.equal(result?.text, final); assert.equal(result?.usage?.inputTokens, 50);
  assert.equal(extractCodexFinalMessage(message(final)), null, 'missing completion must not execute a partial answer');
  assert.throws(() => extractCodexFinalMessage(`${message(final)}\n${JSON.stringify({ type: 'turn.failed' })}`), /failed generation/);
  assert.throws(() => extractCodexFinalMessage(JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call' } })), /PROVIDER_BOUNDARY/);
  assert.equal(cliIsRetryable(new Error('PROVIDER_BOUNDARY: native execution')), false);
});

test('both Codex settings use restricted structured execution with provider context', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'abject-codex-adapter-'));
  const bin = path.join(root, 'fake-codex');
  await fs.writeFile(bin, `#!/usr/bin/env node
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
assert.equal(args[0], 'exec');
for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--json']) assert(args.includes(flag));
for (const feature of ['shell_tool','unified_exec','apps','plugins','hooks','browser_use','computer_use']) assert(args.some((a,i)=>a==='--disable'&&args[i+1]===feature));
assert(args.includes('default_permissions="abject-generation"'));
assert(args.includes('permissions.abject-generation.network.enabled=false'));
assert(args.some(a=>a.startsWith('developer_instructions=')&&a.includes('Abject capabilities have their own permissions')));
assert(process.cwd().includes('abjects-codex-img-'));
process.stdin.resume(); process.stdin.on('end',()=>{
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Progress only'}}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"action":"read"}'}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:17,output_tokens:4}}));
});
`, { mode: 0o700 });
  try {
    for (const transport of ['stream-json', 'terminal'] as const) {
      const provider = new CodexCliProvider({ bin, transport, idleTimeoutMs: 5000 });
      const result = await provider.complete([{ role: 'user', content: 'Inspect through Abject.' }]);
      assert.equal(result.content, '{"action":"read"}'); assert.equal(result.usage?.inputTokens, 17);
      assert.equal(provider.executionContext().transport, 'stream-json');
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('native execution events terminate a provider before its next operation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'abject-codex-boundary-'));
  const marker = path.join(root, 'should-not-exist');
  try {
    await assert.rejects(runCliIdle(process.execPath, ['-e', `
console.log(JSON.stringify({type:'item.started',item:{type:'command_execution'}}));
setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'fixture'),500);
`], { idleTimeoutMs: 2000, validateLine: checkCodexEvent }), /PROVIDER_BOUNDARY/);
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
    await assert.rejects(runCliIdle(process.execPath, ['-e', `process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'file_change'}}))`],
      { idleTimeoutMs: 2000, validateLine: checkCodexEvent }), /PROVIDER_BOUNDARY/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('completion and streaming attach actual execution context without mutating caller messages', async () => {
  const llm: any = new LLMObject();
  const seen: any[] = [];
  const provider: any = { name: 'fixture', resolveModel: () => 'fixture-model',
    executionContext: () => ({ transport: 'stream-json', nativeAccess: 'available' }),
    complete: async (messages: any) => { seen.push(messages); return { content: '{"action":"read"}', finishReason: 'stop' }; },
    async *stream(messages: any) { seen.push(messages); yield { content: '{"action":"read"}', done: true }; },
  };
  const original = [{ role: 'system', content: 'Return the next action.' }, { role: 'user', content: 'Inspect settings.' }];
  const result = await llm.meteredComplete(provider, original);
  const chunks: any[] = []; for await (const chunk of llm.meteredStream(provider, original)) chunks.push(chunk);
  for (const execution of [result.execution, chunks[0].execution]) {
    assert.equal(execution.provider, 'fixture'); assert.equal(execution.model, 'fixture-model');
    assert.equal(execution.contextVersion, EXECUTION_CONTEXT_VERSION);
  }
  for (const messages of seen) {
    assert.match(messages[0].content, /Use Ask/); assert.match(messages[0].content, /provider-side restriction/);
    assert.equal(messages[1].content, original[0].content);
  }
  assert.equal(original.length, 2);
});

test('provider prompt guidance joins the system context, ends the prompt, and is versioned in provenance', async () => {
  const { withExecutionContext } = await import('./execution-context.js');
  const guidance = { version: 'fixture-v1', prefix: 'PREFIX NOTE', suffix: 'SUFFIX NOTE' };
  const llm: any = new LLMObject();
  const seen: any[] = [];
  const provider: any = { name: 'fixture', resolveModel: () => 'fixture-model',
    executionContext: () => ({ transport: 'stream-json', nativeAccess: 'available' }),
    promptGuidance: () => guidance,
    complete: async (messages: any) => { seen.push(messages); return { content: '{"action":"read"}', finishReason: 'stop' }; },
    async *stream(messages: any) { seen.push(messages); yield { content: '', done: true, stopReason: 'stop', deniedActions: ['read_file'] }; },
  };
  const original = [{ role: 'system', content: 'Return the next action.' }, { role: 'user', content: 'Inspect settings.' }];
  const result = await llm.meteredComplete(provider, original);
  assert.equal(result.execution.promptGuidanceVersion, 'fixture-v1');
  assert.equal(result.execution.nativeAccess, 'available');
  const chunks: any[] = []; for await (const chunk of llm.meteredStream(provider, original)) chunks.push(chunk);
  assert.equal(chunks[0].execution.nativeAccess, 'denied', 'a refused native tool is recorded on the request provenance');
  assert.deepEqual(chunks[0].execution.deniedActions, ['read_file']);
  assert.equal(chunks[0].execution.promptGuidanceVersion, 'fixture-v1');
  for (const messages of seen) {
    assert.match(messages[0].content, /provider-side restriction[\s\S]*PREFIX NOTE$/, 'prefix joins the shared system context');
    assert.equal(messages[1].content, original[0].content);
    assert.equal(messages.at(-1).role, 'user');
    assert.match(messages.at(-1).content, /^Inspect settings\.\n\nSUFFIX NOTE$/, 'suffix ends the last user message');
  }
  assert.equal(original[1].content, 'Inspect settings.', 'caller messages are never mutated');

  // A suffix after an assistant turn becomes its own user turn; content parts keep their shape.
  const afterAssistant = withExecutionContext([{ role: 'assistant', content: 'ok' }], { nativeAccess: 'none' }, guidance);
  assert.deepEqual(afterAssistant.at(-1), { role: 'user', content: 'SUFFIX NOTE' });
  const parts = withExecutionContext([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], { nativeAccess: 'none' }, guidance);
  assert.equal((parts.at(-1)!.content as any[]).at(-1).text, '\n\nSUFFIX NOTE');
  assert.doesNotMatch(withExecutionContext([], { nativeAccess: 'none' })[0].content as string, /PREFIX/, 'no guidance, no prefix');
});
