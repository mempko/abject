import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildAgyAcpPromptBlocks,
  completeAgyAcp,
  mapAcpFinishReason,
  streamAgyAcp,
  toAcpUsage,
} from './antigravity-acp.js';
import {
  ContextOverflowError,
  EmptyCompletionError,
  NativeToolAbandonedError,
  cliIsRetryable,
  type LLMMessage,
  type LLMStreamChunk,
} from './provider.js';

/** Create an executable fake `agy` script implementing a configurable ACP stdio server. */
async function makeFakeAgyAcp(
  root: string,
  name: string,
  body: string,
): Promise<string> {
  const bin = path.join(root, name);
  await fs.writeFile(bin, `#!/usr/bin/env node
'use strict';
${body}
`);
  await fs.chmod(bin, 0o755);
  return bin;
}

const STANDARD_ACP_SERVER_PREAMBLE = `
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
`;

test('buildAgyAcpPromptBlocks flattens system/text and emits inline base64 image blocks', () => {
  const messages: LLMMessage[] = [
    { role: 'system', content: 'Answer concisely.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe the quadrants.' },
        { type: 'image', mediaType: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' },
      ],
    },
    { role: 'assistant', content: 'Yellow, Blue, Green, Red.' },
    {
      role: 'user',
      content: [
        { type: 'image', mediaType: 'image/webp', data: 'UklGRg==' },
        { type: 'text', text: 'And this one?' },
      ],
    },
  ];

  const blocks = buildAgyAcpPromptBlocks(messages);
  assert.deepEqual(blocks, [
    { type: 'text', text: 'System Instructions: Answer concisely.\n\nUser: Describe the quadrants.' },
    { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    { type: 'text', text: 'Assistant: Yellow, Blue, Green, Red.\n\nUser:' },
    { type: 'image', data: 'UklGRg==', mimeType: 'image/webp' },
    { type: 'text', text: 'And this one?' },
  ]);
});

test('toAcpUsage and mapAcpFinishReason normalize ACP responses', () => {
  assert.deepEqual(
    toAcpUsage({
      inputTokens: 9867,
      outputTokens: 73,
      cachedReadTokens: 120,
      cachedWriteTokens: 45,
      thoughtTokens: 41,
      totalTokens: 9940,
    }),
    {
      inputTokens: 9867,
      outputTokens: 73,
      cacheReadTokens: 120,
      cacheWriteTokens: 45,
      reasoningTokens: 41,
    },
  );
  assert.equal(toAcpUsage(undefined), undefined);
  assert.equal(toAcpUsage({}), undefined);

  assert.equal(mapAcpFinishReason('end_turn'), 'stop');
  assert.equal(mapAcpFinishReason('max_tokens'), 'length');
  assert.equal(mapAcpFinishReason('length'), 'length');
  assert.equal(mapAcpFinishReason('cancelled'), 'error');
  assert.equal(mapAcpFinishReason('error'), 'error');
  assert.equal(mapAcpFinishReason(undefined), 'stop');
});

test('completeAgyAcp performs full ACP handshake, sends image blocks, ignores thought chunks, and cleans up temp cwd', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'abject-acp-test-'));
  const logFile = path.join(root, 'rpc.jsonl');
  try {
    const bin = await makeFakeAgyAcp(root, 'fake-agy-complete', `
${STANDARD_ACP_SERVER_PREAMBLE}
const logFile = ${JSON.stringify(logFile)};
fs.appendFileSync(logFile, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  fs.appendFileSync(logFile, JSON.stringify(msg) + '\\n');
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } });
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-123' } });
  } else if (msg.method === 'session/set_model') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-123', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'internal reasoning' } } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-123', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Yellow, ' } } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-123', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Blue, Green, Red' } } } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 9867, outputTokens: 73, cachedReadTokens: 10, cachedWriteTokens: 5, thoughtTokens: 41, totalTokens: 9940 } } });
  } else if (msg.method === 'session/close') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
rl.on('close', () => process.exit(0));
`);

    const res = await completeAgyAcp(
      [
        { role: 'system', content: 'Be brief.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Name the 4 colors.' },
            { type: 'image', mediaType: 'image/png', data: 'QUJDRA==' },
          ],
        },
      ],
      { bin, model: 'gemini-4-argon-high', idleTimeoutMs: 5000 },
    );

    assert.equal(res.content, 'Yellow, Blue, Green, Red');
    assert.equal(res.finishReason, 'stop');
    assert.deepEqual(res.usage, {
      inputTokens: 9867,
      outputTokens: 73,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      reasoningTokens: 41,
    });

    const records = (await fs.readFile(logFile, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    const meta = records[0];
    assert.deepEqual(meta.argv, ['acp', '--stdio']);
    assert.equal(existsSync(meta.cwd), false, 'owned temp cwd must be removed on teardown');

    const methods = records.slice(1).map(r => r.method);
    assert.deepEqual(methods, ['initialize', 'session/new', 'session/set_model', 'session/prompt', 'session/close']);
    assert.deepEqual(records[3].params, { sessionId: 'sess-123', modelId: 'gemini-4-argon-high' });
    assert.deepEqual(records[4].params.prompt, [
      { type: 'text', text: 'System Instructions: Be brief.\n\nUser: Name the 4 colors.' },
      { type: 'image', data: 'QUJDRA==', mimeType: 'image/png' },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('streamAgyAcp omits session/set_model for auto, preserves caller cwd, and streams deltas before prompt resolves', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'abject-acp-stream-'));
  const callerCwd = path.join(root, 'workspace');
  await fs.mkdir(callerCwd);
  const logFile = path.join(root, 'rpc.jsonl');
  try {
    const bin = await makeFakeAgyAcp(root, 'fake-agy-stream', `
${STANDARD_ACP_SERVER_PREAMBLE}
const logFile = ${JSON.stringify(logFile)};
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  fs.appendFileSync(logFile, JSON.stringify(msg) + '\\n');
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } });
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-stream' } });
  } else if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-stream', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first ' } } } });
    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-stream', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'second' } } } });
    }, 40);
    setTimeout(() => {
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'max_tokens', usage: { inputTokens: 100, outputTokens: 20 } } });
    }, 90);
  } else if (msg.method === 'session/close') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
rl.on('close', () => process.exit(0));
`);

    const chunks: LLMStreamChunk[] = [];
    const arrivalTimes: number[] = [];
    const t0 = Date.now();
    for await (const chunk of streamAgyAcp(
      [{ role: 'user', content: [{ type: 'image', mediaType: 'image/jpeg', data: 'AAAA' }] }],
      { bin, model: 'auto', cwd: callerCwd, idleTimeoutMs: 5000 },
    )) {
      chunks.push(chunk);
      arrivalTimes.push(Date.now() - t0);
    }

    assert.equal(chunks.length, 3);
    assert.deepEqual(chunks[0], { content: 'first ', done: false });
    assert.deepEqual(chunks[1], { content: 'second', done: false });
    assert.deepEqual(chunks[2], {
      content: '',
      done: true,
      stopReason: 'length',
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    assert.ok(arrivalTimes[2] - arrivalTimes[0] >= 40, 'first delta should arrive before prompt finishes');
    assert.equal(existsSync(callerCwd), true, 'caller-supplied cwd must not be deleted');

    const methods = (await fs.readFile(logFile, 'utf8')).trim().split('\n').map(l => JSON.parse(l).method);
    assert.deepEqual(methods, ['initialize', 'session/new', 'session/prompt', 'session/close']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('server permission requests are auto-cancelled and empty output surfaces NativeToolAbandonedError', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'abject-acp-perm-'));
  const replyFile = path.join(root, 'replies.jsonl');
  try {
    const bin = await makeFakeAgyAcp(root, 'fake-agy-perm', `
${STANDARD_ACP_SERVER_PREAMBLE}
const replyFile = ${JSON.stringify(replyFile)};
let pendingPromptId = null;
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === 99 && msg.result) {
    fs.appendFileSync(replyFile, JSON.stringify(msg) + '\\n');
    send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 0 } } });
    return;
  }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } });
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-perm' } });
  } else if (msg.method === 'session/prompt') {
    pendingPromptId = msg.id;
    send({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: { sessionId: 'sess-perm', toolCall: { title: 'read_file' } } });
  } else if (msg.method === 'session/close') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
rl.on('close', () => process.exit(0));
`);

    await assert.rejects(
      completeAgyAcp([{ role: 'user', content: 'Look at this' }], { bin, idleTimeoutMs: 5000 }),
      (err: unknown) => {
        assert.ok(err instanceof NativeToolAbandonedError);
        assert.deepEqual(err.deniedActions, ['read_file']);
        return true;
      },
    );

    const replies = (await fs.readFile(replyFile, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(replies[0], {
      jsonrpc: '2.0',
      id: 99,
      result: { outcome: { outcome: 'cancelled' } },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('empty output without denied tools throws EmptyCompletionError and overflow RPC error throws ContextOverflowError', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'abject-acp-err-'));
  try {
    const emptyBin = await makeFakeAgyAcp(root, 'fake-agy-empty', `
${STANDARD_ACP_SERVER_PREAMBLE}
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's-empty' } });
  else if (msg.method === 'session/prompt') send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  else if (msg.method === 'session/close') send({ jsonrpc: '2.0', id: msg.id, result: {} });
});
rl.on('close', () => process.exit(0));
`);

    await assert.rejects(
      completeAgyAcp([{ role: 'user', content: 'hi' }], { bin: emptyBin, idleTimeoutMs: 5000 }),
      (err: unknown) => err instanceof EmptyCompletionError && !(err instanceof NativeToolAbandonedError),
    );

    const overflowBin = await makeFakeAgyAcp(root, 'fake-agy-overflow', `
${STANDARD_ACP_SERVER_PREAMBLE}
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's-ovf' } });
  else if (msg.method === 'session/prompt') send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'prompt is too long for context window' } });
});
rl.on('close', () => process.exit(0));
`);

    await assert.rejects(
      completeAgyAcp([{ role: 'user', content: 'huge' }], { bin: overflowBin, idleTimeoutMs: 5000 }),
      (err: unknown) => err instanceof ContextOverflowError,
    );

    const noImageBin = await makeFakeAgyAcp(root, 'fake-agy-noimg', `
${STANDARD_ACP_SERVER_PREAMBLE}
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false } } } });
  }
});
rl.on('close', () => process.exit(0));
`);

    await assert.rejects(
      completeAgyAcp(
        [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] }],
        { bin: noImageBin, idleTimeoutMs: 5000 },
      ),
      /promptCapabilities\.image=false/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('idle timeout kills hung subprocess with retryable error and cleans up temp cwd', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'abject-acp-timeout-'));
  const cwdFile = path.join(root, 'cwd.txt');
  const pidFile = path.join(root, 'pid.txt');
  try {
    const bin = await makeFakeAgyAcp(root, 'fake-agy-hang', `
${STANDARD_ACP_SERVER_PREAMBLE}
fs.writeFileSync(${JSON.stringify(cwdFile)}, process.cwd());
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's-hang' } });
  // Intentionally never respond to session/prompt.
});
`);

    await assert.rejects(
      completeAgyAcp([{ role: 'user', content: 'hang' }], { bin, idleTimeoutMs: 250 }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /idle for 250ms — no output, subprocess killed/);
        assert.equal(cliIsRetryable(err), true);
        return true;
      },
    );

    const childCwd = (await fs.readFile(cwdFile, 'utf8')).trim();
    assert.equal(existsSync(childCwd), false, 'owned temp cwd must be cleaned up after idle timeout');
    const childPid = Number((await fs.readFile(pidFile, 'utf8')).trim());
    assert.throws(() => process.kill(childPid, 0), 'timed-out child process must no longer be alive');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('early break from streamAgyAcp terminates subprocess and cleans up temp cwd', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'abject-acp-abort-'));
  const cwdFile = path.join(root, 'cwd.txt');
  const pidFile = path.join(root, 'pid.txt');
  try {
    const bin = await makeFakeAgyAcp(root, 'fake-agy-abort', `
${STANDARD_ACP_SERVER_PREAMBLE}
fs.writeFileSync(${JSON.stringify(cwdFile)}, process.cwd());
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's-abort' } });
  else if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-abort', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chunk-1' } } } });
    // Keep alive waiting for more work.
    setInterval(() => {}, 10_000);
  }
});
`);

    const received: string[] = [];
    for await (const chunk of streamAgyAcp([{ role: 'user', content: 'stream' }], { bin, idleTimeoutMs: 5000 })) {
      received.push(chunk.content);
      break;
    }

    assert.deepEqual(received, ['chunk-1']);
    const childCwd = (await fs.readFile(cwdFile, 'utf8')).trim();
    assert.equal(existsSync(childCwd), false, 'owned temp cwd must be removed on early consumer break');
    const childPid = Number((await fs.readFile(pidFile, 'utf8')).trim());
    assert.throws(() => process.kill(childPid, 0), 'aborted child process must be terminated');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
