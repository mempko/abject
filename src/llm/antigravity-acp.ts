/**
 * Antigravity ACP stdio image-capable transport (`agy acp --stdio`).
 *
 * Why: `agy --print` with `--input-format stream-json` only accepts text blocks
 * and rejects inline image blocks, whereas `agy acp --stdio` speaks NDJSON
 * JSON-RPC 2.0 with `promptCapabilities.image = true` and accepts inline
 * base64 `{ type: 'image', data, mimeType }` blocks alongside text in
 * `session/prompt`, streaming visible deltas as `agent_message_chunk`
 * notifications and returning `stopReason` and `usage`.
 *
 * Isolation: each call spawns a fresh `agy acp --stdio` subprocess in an
 * isolated temporary working directory (or a caller-supplied `cwd`) without
 * touching `HOME` so `~/.gemini/` OAuth credentials stay intact. Any
 * server-initiated permission request is auto-cancelled.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatCliError, hasImages, killProc } from './cli-process.js';
import { trackChild, untrackChild } from '../runtime/child-processes.js';
import {
  ContextOverflowError,
  EmptyCompletionError,
  NativeToolAbandonedError,
  getTextContent,
  isContextOverflowMessage,
  type LLMCompletionResult,
  type LLMMessage,
  type LLMStreamChunk,
} from './provider.js';

/** Default idle watchdog matching AntigravityCliProvider (6 minutes). */
export const DEFAULT_ACP_IDLE_TIMEOUT_MS = 360_000;

const AUTO_MODEL = 'auto';
const SESSION_CLOSE_TIMEOUT_MS = 1_000;
const GRACEFUL_EXIT_TIMEOUT_MS = 1_500;
const ABORT_EXIT_TIMEOUT_MS = 500;

export interface AgyAcpOptions {
  /** Path or name of the `agy` binary. Defaults to `'agy'`. */
  bin?: string;
  /** Model ID passed to `session/set_model`. Omitted or `'auto'` keeps the CLI default. */
  model?: string;
  /**
   * How long the subprocess may remain completely silent before being killed.
   * Resets on every byte of stdout or stderr. Defaults to {@link DEFAULT_ACP_IDLE_TIMEOUT_MS}.
   */
  idleTimeoutMs?: number;
  /**
   * Working directory passed to `spawn` and `session/new`. When omitted, an
   * isolated temp directory is created for the call and removed on teardown.
   * Caller-supplied directories are never deleted.
   */
  cwd?: string;
  /** Client identity sent in the ACP `initialize` handshake. */
  clientInfo?: { name: string; version: string };
  /** Optional diagnostic hint appended to subprocess failure messages. */
  errorHint?: string;
}

export type AgyAcpPromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface AgyAcpUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  thinking_tokens?: number;
}

interface JsonRpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: JsonRpcError;
}

interface PendingRpc {
  method: string;
  resolve: (result: Record<string, unknown> | undefined) => void;
  reject: (err: Error) => void;
}

const DATA_URI_BASE64_RE = /^data:[^;]+;base64,/i;

function stripDataUriPrefix(data: string): string {
  return DATA_URI_BASE64_RE.test(data) ? data.replace(DATA_URI_BASE64_RE, '') : data;
}

/**
 * Convert an Abject conversation into ACP `session/prompt` content blocks.
 *
 * System messages are joined under `System Instructions:` at the front,
 * user/assistant turns are role-labelled (matching `flattenConversation`),
 * and inline image parts are emitted as `{ type: 'image', data, mimeType }`
 * blocks at their position in the conversation.
 */
export function buildAgyAcpPromptBlocks(messages: LLMMessage[]): AgyAcpPromptBlock[] {
  const systemParts: string[] = [];
  const nonSystem: LLMMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = getTextContent(msg);
      if (text) systemParts.push(text);
    } else {
      nonSystem.push(msg);
    }
  }

  const blocks: AgyAcpPromptBlock[] = [];
  let textBuf = systemParts.length > 0 ? `System Instructions: ${systemParts.join('\n\n')}` : '';

  const appendText = (chunk: string, sep: string) => {
    if (!chunk) return;
    textBuf = textBuf ? `${textBuf}${sep}${chunk}` : chunk;
  };

  const flushText = () => {
    if (textBuf) {
      blocks.push({ type: 'text', text: textBuf });
      textBuf = '';
    }
  };

  for (const msg of nonSystem) {
    const roleLabel = msg.role === 'assistant' ? 'Assistant:' : 'User:';
    if (typeof msg.content === 'string') {
      appendText(`${roleLabel} ${msg.content}`, '\n\n');
      continue;
    }
    let emittedRole = false;
    for (const part of msg.content) {
      if (part.type === 'text') {
        if (!emittedRole) {
          appendText(`${roleLabel} ${part.text}`, '\n\n');
          emittedRole = true;
        } else {
          appendText(part.text, '\n');
        }
      } else if (part.type === 'image') {
        if (!emittedRole) {
          if (textBuf || nonSystem.length > 1) {
            appendText(roleLabel, '\n\n');
          }
          emittedRole = true;
        }
        flushText();
        blocks.push({
          type: 'image',
          data: stripDataUriPrefix(part.data),
          mimeType: part.mediaType,
        });
      }
    }
    if (!emittedRole) {
      appendText(`${roleLabel} `, '\n\n');
    }
  }

  flushText();
  return blocks;
}

/** Map ACP `session/prompt` usage fields onto Abject's normalized usage shape. */
export function toAcpUsage(
  u: AgyAcpUsage | Record<string, unknown> | undefined,
): LLMCompletionResult['usage'] | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const raw = u as AgyAcpUsage;
  const inputTokens = raw.inputTokens ?? raw.input_tokens;
  const outputTokens = raw.outputTokens ?? raw.output_tokens;
  const cacheReadTokens = raw.cachedReadTokens ?? raw.cache_read_tokens;
  const cacheWriteTokens = raw.cachedWriteTokens ?? raw.cache_write_tokens;
  const reasoningTokens = raw.thoughtTokens ?? raw.thinking_tokens;
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined;
  }
  const out: NonNullable<LLMCompletionResult['usage']> = {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
  };
  if (cacheReadTokens !== undefined) out.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) out.cacheWriteTokens = cacheWriteTokens;
  if (reasoningTokens !== undefined) out.reasoningTokens = reasoningTokens;
  return out;
}

/** Map an ACP `stopReason` string onto `LLMCompletionResult['finishReason']`. */
export function mapAcpFinishReason(
  stopReason: string | undefined,
): LLMCompletionResult['finishReason'] {
  if (!stopReason) return 'stop';
  const norm = stopReason.toLowerCase();
  if (norm === 'max_tokens' || norm === 'length') return 'length';
  if (norm === 'error' || norm === 'cancelled' || norm === 'canceled') return 'error';
  return 'stop';
}

function extractDeniedActionName(msg: JsonRpcMessage): string {
  const params = msg.params as Record<string, unknown> | undefined;
  const toolCall = params?.toolCall as Record<string, unknown> | undefined;
  const tool = params?.tool as Record<string, unknown> | undefined;
  const candidates = [
    toolCall?.title,
    toolCall?.kind,
    toolCall?.name,
    tool?.name,
    params?.action,
    params?.name,
    msg.method,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return 'unknown_tool';
}

function formatRpcError(method: string, err: JsonRpcError, hint?: string): Error {
  const detailParts = [`agy acp ${method} failed`];
  if (typeof err.code === 'number') detailParts.push(`code=${err.code}`);
  if (typeof err.message === 'string' && err.message.trim()) detailParts.push(err.message.trim());
  if (typeof err.data === 'string' && err.data.trim()) {
    detailParts.push(err.data.trim().slice(0, 300));
  } else if (err.data && typeof err.data === 'object') {
    try {
      detailParts.push(JSON.stringify(err.data).slice(0, 300));
    } catch {
      // ignore non-serializable error data
    }
  }
  if (hint) detailParts.push(hint);
  const detail = detailParts.join(' | ');
  if (isContextOverflowMessage(detail)) {
    return new ContextOverflowError(detail, 'antigravity-cli');
  }
  return new Error(detail);
}

function waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve();
    };
    proc.once('close', done);
    proc.once('exit', done);
    const t = setTimeout(() => {
      killProc(proc);
      done();
    }, timeoutMs);
    t.unref?.();
  });
}

/**
 * Stream a single conversation turn over `agy acp --stdio`.
 *
 * Yields incremental `{ content, done: false }` chunks as `agent_message_chunk`
 * notifications arrive, followed by a terminal `{ content: '', done: true,
 * stopReason, usage }` chunk when `session/prompt` resolves.
 *
 * Throws {@link NativeToolAbandonedError} if the turn produced no text after
 * auto-cancelling a server permission request, {@link EmptyCompletionError} if
 * the turn produced no text otherwise, and {@link ContextOverflowError} when
 * the server rejects the prompt for length.
 */
export async function* streamAgyAcp(
  messages: LLMMessage[],
  opts: AgyAcpOptions = {},
): AsyncIterable<LLMStreamChunk> {
  const bin = opts.bin ?? 'agy';
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_ACP_IDLE_TIMEOUT_MS;
  const clientInfo = opts.clientInfo ?? { name: 'abjects', version: '1.0.0' };
  const promptBlocks = buildAgyAcpPromptBlocks(messages);
  const wantsImages = hasImages(messages);
  const argv = ['acp', '--stdio'];

  const ownedTempDir = opts.cwd ? undefined : mkdtempSync(join(tmpdir(), 'abjects-agy-acp-'));
  const workDir = opts.cwd ?? ownedTempDir!;

  const queue: LLMStreamChunk[] = [];
  let streamDone = false;
  let hasError = false;
  let streamError: unknown;
  let waiter: (() => void) | null = null;

  const wake = () => {
    const w = waiter;
    waiter = null;
    w?.();
  };

  const proc = spawn(bin, argv, {
    cwd: workDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  trackChild(proc.pid, `CLI: ${bin} acp`, { group: false });
  proc.on('exit', () => untrackChild(proc.pid));
  proc.stdin.on('error', () => {});

  let stdoutBuf = '';
  let stdoutTail = '';
  let stderr = '';
  let nextId = 1;
  let aborted = false;
  let closed = false;
  let assembledText = '';
  const deniedActions: string[] = [];
  const pending = new Map<number, PendingRpc>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const clearIdle = () => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const failAllPending = (err: Error) => {
    for (const entry of pending.values()) {
      entry.reject(err);
    }
    pending.clear();
  };

  const armIdle = () => {
    clearIdle();
    if (aborted || closed) return;
    idleTimer = setTimeout(() => {
      aborted = true;
      clearIdle();
      killProc(proc);
      failAllPending(new Error(`${bin} idle for ${idleTimeoutMs}ms — no output, subprocess killed`));
    }, idleTimeoutMs);
    idleTimer.unref?.();
  };

  const writeJsonLine = (payload: unknown): boolean => {
    if (aborted || closed || proc.stdin.destroyed || !proc.stdin.writable) return false;
    try {
      proc.stdin.write(JSON.stringify(payload) + '\n');
      return true;
    } catch {
      return false;
    }
  };

  const handleLine = (line: string) => {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    // Server-initiated request (e.g. tool permission prompt): auto-cancel.
    if (msg.id !== undefined && msg.id !== null && typeof msg.method === 'string') {
      const action = extractDeniedActionName(msg);
      if (!deniedActions.includes(action)) deniedActions.push(action);
      writeJsonLine({
        jsonrpc: '2.0',
        id: msg.id,
        result: { outcome: { outcome: 'cancelled' } },
      });
      return;
    }

    // Response to one of our RPC requests.
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const entry = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) {
        entry.reject(formatRpcError(entry.method, msg.error, opts.errorHint));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // Streaming notification.
    if (typeof msg.method === 'string') {
      const update = msg.params?.update as Record<string, unknown> | undefined;
      if (update?.sessionUpdate === 'agent_message_chunk') {
        const content = update.content as Record<string, unknown> | undefined;
        if (content?.type === 'text' && typeof content.text === 'string' && content.text.length > 0) {
          assembledText += content.text;
          queue.push({ content: content.text, done: false });
          wake();
        }
      }
    }
  };

  const rpc = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | undefined> => {
    if (aborted) return Promise.reject(new Error(`${bin} acp session aborted before ${method}`));
    if (closed) {
      return Promise.reject(new Error(formatCliError(bin, proc.exitCode ?? 1, stderr, stdoutTail, argv, `closed before ${method}`, opts.errorHint)));
    }
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { method, resolve, reject });
      const ok = writeJsonLine({ jsonrpc: '2.0', id, method, params });
      if (!ok) {
        pending.delete(id);
        reject(new Error(`${bin} acp stdin unavailable while sending ${method}`));
      }
    });
  };

  proc.stdout.on('data', (chunk: Buffer) => {
    if (aborted) return;
    const s = chunk.toString('utf8');
    stdoutTail = (stdoutTail + s).slice(-1000);
    armIdle();
    stdoutBuf += s;
    let nl = stdoutBuf.indexOf('\n');
    while (nl !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      nl = stdoutBuf.indexOf('\n');
      if (line) handleLine(line);
    }
  });

  proc.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
    if (!aborted) armIdle();
  });

  proc.on('error', (err) => {
    closed = true;
    clearIdle();
    failAllPending(err);
  });

  proc.on('close', (code, signal) => {
    closed = true;
    clearIdle();
    const tail = stdoutBuf.trim();
    stdoutBuf = '';
    if (tail && !aborted) handleLine(tail);
    if (pending.size > 0) {
      const reason = signal ? `terminated by ${signal}` : 'ACP process exited before replying';
      const detail = formatCliError(bin, code ?? 1, stderr, stdoutTail, argv, reason, opts.errorHint);
      const err = isContextOverflowMessage(detail)
        ? new ContextOverflowError(detail, 'antigravity-cli')
        : new Error(detail);
      failAllPending(err);
    }
  });

  armIdle();

  let sessionId: string | undefined;

  const runSession = async (): Promise<void> => {
    try {
      const initRes = await rpc('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo,
      });
      const agentCaps = initRes?.agentCapabilities as Record<string, unknown> | undefined;
      const promptCaps = agentCaps?.promptCapabilities as Record<string, unknown> | undefined;
      if (wantsImages && promptCaps?.image === false) {
        throw new Error(`${bin} acp server reported promptCapabilities.image=false`);
      }

      const newRes = await rpc('session/new', {
        cwd: workDir,
        mcpServers: [],
      });
      const sid = newRes?.sessionId;
      if (typeof sid !== 'string' || sid.length === 0) {
        throw new Error(`${bin} acp session/new returned no sessionId`);
      }
      sessionId = sid;

      const modelId = opts.model?.trim();
      if (modelId && modelId !== AUTO_MODEL) {
        await rpc('session/set_model', { sessionId, modelId });
      }

      const promptRes = await rpc('session/prompt', {
        sessionId,
        prompt: promptBlocks,
      });

      const rawStopReason = typeof promptRes?.stopReason === 'string' ? promptRes.stopReason : undefined;
      const finishReason = mapAcpFinishReason(rawStopReason);
      const usage = toAcpUsage(promptRes?.usage as Record<string, unknown> | undefined);

      if (assembledText.length === 0) {
        if (deniedActions.length > 0) {
          throw new NativeToolAbandonedError(
            `antigravity-cli produced no output after native tool(s) ${deniedActions.join(', ')} were denied`,
            [...deniedActions],
            finishReason,
          );
        }
        throw new EmptyCompletionError(
          'antigravity-cli ACP returned empty completion',
          finishReason,
        );
      }

      queue.push({
        content: '',
        done: true,
        stopReason: finishReason,
        usage,
      });
    } catch (err) {
      hasError = true;
      streamError = err;
    } finally {
      streamDone = true;
      wake();
    }
  };

  const sessionPromise = runSession();

  const cleanup = async (earlyAbort: boolean): Promise<void> => {
    clearIdle();
    if (earlyAbort) {
      aborted = true;
      failAllPending(new Error(`${bin} acp stream cancelled by consumer`));
    } else if (sessionId && !aborted && !closed && proc.exitCode === null) {
      // Best-effort session/close with a tight timeout so teardown never stalls.
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve();
        };
        const t = setTimeout(finish, SESSION_CLOSE_TIMEOUT_MS);
        t.unref?.();
        rpc('session/close', { sessionId }).then(finish, finish);
      });
    }
    try { proc.stdin.end(); } catch { /* already closed */ }
    if (earlyAbort || aborted) {
      killProc(proc);
      await waitForProcessExit(proc, ABORT_EXIT_TIMEOUT_MS);
    } else {
      await waitForProcessExit(proc, GRACEFUL_EXIT_TIMEOUT_MS);
    }
    await sessionPromise.catch(() => {});
    if (ownedTempDir) {
      try { rmSync(ownedTempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  };

  let completedNormally = false;
  try {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      if (hasError) throw streamError;
      if (streamDone) break;
      await new Promise<void>((resolve) => {
        waiter = resolve;
      });
    }
    completedNormally = true;
  } finally {
    await cleanup(!completedNormally);
  }
}

/**
 * Run a non-streaming completion over `agy acp --stdio`.
 *
 * Collects all streamed `agent_message_chunk` text deltas and returns the
 * assembled content, normalized `finishReason`, and token `usage`.
 */
export async function completeAgyAcp(
  messages: LLMMessage[],
  opts: AgyAcpOptions = {},
): Promise<LLMCompletionResult> {
  let content = '';
  let finishReason: LLMCompletionResult['finishReason'] = 'stop';
  let usage: LLMCompletionResult['usage'];

  for await (const chunk of streamAgyAcp(messages, opts)) {
    if (chunk.content) content += chunk.content;
    if (chunk.done) {
      if (chunk.stopReason) finishReason = mapAcpFinishReason(chunk.stopReason);
      if (chunk.usage) usage = chunk.usage;
    }
  }

  return { content, finishReason, usage };
}
