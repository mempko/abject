import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AntigravityCliProvider } from './antigravity-cli.js';
import { NativeToolAbandonedError } from './provider.js';
import { LLMObject } from '../objects/llm-object.js';

/** A stand-in agy: records the prompt it was given, then reports a denied native tool and no answer. */
async function fakeAgy(root: string, capture: string): Promise<string> {
  const bin = path.join(root, 'fake-agy');
  await fs.writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.on('data', c => { input += c; }).on('end', () => {
  fs.appendFileSync(${JSON.stringify(capture)}, input + '\\n---\\n');
  process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '',
    usage: { input_tokens: 5, output_tokens: 0 }, denied_actions: [{ action: 'read_file', display_name: 'ViewFile' }] } }) + '\\n');
  process.stderr.write('jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied.\\n');
  process.exit(0);
});
`);
  await fs.chmod(bin, 0o755);
  return bin;
}

test('a denied native tool surfaces as NativeToolAbandonedError, names the tool, and rides the provenance', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'abject-agy-adapter-'));
  const capture = path.join(root, 'prompts.txt');
  try {
    const provider = new AntigravityCliProvider({ bin: await fakeAgy(root, capture), idleTimeoutMs: 5000 });
    await assert.rejects(provider.complete([{ role: 'user', content: 'Decide the next action.' }]), (err: any) => {
      assert.ok(err instanceof NativeToolAbandonedError, err?.message);
      assert.deepEqual(err.deniedActions, ['read_file']);
      assert.match(err.message, /read_file were denied/);
      return true;
    });

    // Through LLMObject: the guidance is applied and the denial lands on the request provenance.
    const llm: any = new LLMObject();
    const chunks: any[] = [];
    for await (const chunk of llm.meteredStream(provider, [{ role: 'user', content: 'Decide the next action.' }], { tier: 'smart' })) chunks.push(chunk);
    const last = chunks.at(-1);
    assert.equal(last.content, '');
    assert.equal(last.done, true);
    assert.equal(last.execution.nativeAccess, 'denied');
    assert.deepEqual(last.execution.deniedActions, ['read_file']);
    assert.equal(last.execution.promptGuidanceVersion, provider.promptGuidance().version);

    const prompts = (await fs.readFile(capture, 'utf8')).split('\n---\n').filter(Boolean);
    assert.ok(prompts.length >= 2, 'complete and stream each sent at least one prompt');
    const sent = JSON.parse(prompts.at(-1)!);
    const text: string = sent.message.content[0].text;
    assert.match(text, /^System Instructions: [\s\S]*respond from its text alone/, 'prefix joins the system instructions');
    assert.match(text, /Continue with the single JSON action that comes next\.\s*$/, 'suffix is the last thing in the prompt');
    assert.ok(text.indexOf('Decide the next action.') < text.lastIndexOf('provider-native tools'), 'suffix follows the caller text');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
