/**
 * AntigravityCliProvider — drives the `agy` (Antigravity CLI) binary
 * in non-interactive (`-p`) mode as an LLM backend.
 *
 * Why: lets the user reuse their Antigravity subscription / session quota
 * instead of providing an API key.
 *
 * Mode: stateless. Each `complete()` call spawns a fresh `agy -p` process,
 * pipes the conversation in, and parses the JSON event stream.
 * Slash commands and skills are disabled with `--disable-slash-commands`
 * so Abjects gets raw LLM text.
 *
 * Reports under provider name `'antigravity-cli'`.
 */

import { spawn } from 'node:child_process';
import {
  BaseLLMProvider,
  LLMCompletionOptions,
  LLMCompletionResult,
  LLMMessage,
  LLMProviderDescription,
  LLMStreamChunk,
  ModelInfo,
  cliIsRetryable,
  getTextContent,
} from './provider.js';

const AUTO_MODEL = 'auto';

function shouldOmitModelFlag(model: string | undefined): boolean {
  return !model || model === AUTO_MODEL;
}

const DEFAULT_IDLE_TIMEOUT_MS = 360_000;

export class AntigravityCliProvider extends BaseLLMProvider {
  /** Top-level provider name in registry */
  readonly name = 'antigravity-cli';

  /** Path to binary; default 'agy' resolved via PATH */
  private readonly bin: string;
  private readonly idleTimeoutMs: number;

  constructor(config: { bin?: string; idleTimeoutMs?: number } = {}) {
    super({});
    this.bin = config.bin ?? 'agy';
    this.idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { code } = await runCliIdle(this.bin, ['--version'], '', { idleTimeoutMs: 5_000 });
      return code === 0;
    } catch {
      return false;
    }
  }

  async complete(messages: LLMMessage[], options?: LLMCompletionOptions): Promise<LLMCompletionResult> {
    const args = this.buildArgs(messages, options, 'stream-json');
    return this.withRetries(async () => {
      let textSoFar = '';
      let resultText: string | undefined;
      let usage: LLMCompletionResult['usage'];
      let cliErrorMessage: string | undefined;

      const { code, stdout, stderr } = await runCliIdleStreaming(
        this.bin, args.argv, args.stdin,
        { idleTimeoutMs: this.idleTimeoutMs },
        (line) => {
          const errMsg = extractAgyStreamError(line);
          if (errMsg) cliErrorMessage = errMsg;
          const delta = extractAgyStreamDelta(line);
          if (delta) textSoFar += delta;
          const finalText = extractAgyStreamResultText(line);
          if (finalText) resultText = finalText;
          const u = extractAgyStreamUsage(line);
          if (u) usage = u;
        },
      );

      if (code !== 0) {
        throw new Error(formatCliError('agy', code, stderr, stdout, args.argv, cliErrorMessage));
      }

      const content = textSoFar || resultText;
      if (!content) {
        throw new Error(`agy CLI returned no result. raw=${stdout.slice(0, 200)}`);
      }

      return {
        content,
        finishReason: 'stop',
        usage,
      };
    }, { isRetryable: cliIsRetryable, label: 'antigravity-cli.complete' });
  }

  async *stream(messages: LLMMessage[], options?: LLMCompletionOptions): AsyncIterable<LLMStreamChunk> {
    const args = this.buildArgs(messages, options, 'stream-json');
    const maxAttempts = 3;
    const initialDelayMs = 1000;
    const backoffFactor = 2;
    const maxDelayMs = 10000;
    let yielded = false;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        for await (const chunk of this.streamOnce(args.argv, args.stdin)) {
          if (chunk.content.length > 0) yielded = true;
          yield chunk;
        }
        return;
      } catch (err) {
        lastErr = err;
        if (yielded) throw err;
        if (attempt >= maxAttempts) throw err;
        if (!cliIsRetryable(err)) throw err;
        const delay = Math.min(initialDelayMs * Math.pow(backoffFactor, attempt - 1), maxDelayMs);
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(`[antigravity-cli.stream] attempt ${attempt}/${maxAttempts} failed: ${msg.slice(0, 200)} — retrying in ${delay}ms`);
        await new Promise<void>(resolve => setTimeout(resolve, delay));
      }
    }
    throw lastErr;
  }

  private async *streamOnce(argv: string[], stdin: string): AsyncIterable<LLMStreamChunk> {
    const proc = spawn(this.bin, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    if (stdin.length > 0) proc.stdin.end(stdin);
    else proc.stdin.end();

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutFired = false;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timeoutFired = true;
        try { proc.kill('SIGTERM'); } catch { /* gone */ }
      }, this.idleTimeoutMs);
    };
    armIdle();

    let buffer = '';
    let allStdout = '';
    let stderr = '';
    let cliErrorMessage: string | undefined;

    proc.stderr.on('data', (b) => { stderr += b.toString(); armIdle(); });

    try {
      for await (const chunk of proc.stdout) {
        armIdle();
        const s = String(chunk);
        allStdout += s;
        buffer += s;
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
          if (!line) continue;
          const errMsg = extractAgyStreamError(line);
          if (errMsg) cliErrorMessage = errMsg;
          const delta = extractAgyStreamDelta(line);
          if (delta) yield { content: delta, done: false };
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }

    const code = await new Promise<number>((resolve) => proc.on('close', (c) => resolve(c ?? 0)));
    if (timeoutFired) {
      throw new Error(`agy idle for ${this.idleTimeoutMs}ms — no output, subprocess killed`);
    }
    if (code !== 0) {
      throw new Error(formatCliError('agy', code, stderr, allStdout, argv, cliErrorMessage));
    }
    yield { content: '', done: true };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: AUTO_MODEL,         name: 'Auto (recommended)', vision: false },
      { id: 'gemini-3.6-flash',  name: 'Gemini 3.6 Flash', vision: false },
      { id: 'gemini-3.6-pro',    name: 'Gemini 3.6 Pro', vision: false },
      { id: 'gemini-3.1-pro',    name: 'Gemini 3.1 Pro', vision: false },
    ];
  }

  override describe(): LLMProviderDescription {
    return {
      id: 'antigravity-cli',
      label: 'Antigravity CLI',
      storageSuffix: 'antigravityCli',
      credentialMode: 'cli',
      cli: {
        binary: 'agy',
        installHint: 'Install Antigravity CLI: agy install or https://antigravity.google',
      },
      models: [
        { id: AUTO_MODEL,         name: 'Auto (recommended)', vision: false },
        { id: 'gemini-3.6-flash',  name: 'Gemini 3.6 Flash', vision: false },
        { id: 'gemini-3.6-pro',    name: 'Gemini 3.6 Pro', vision: false },
        { id: 'gemini-3.1-pro',    name: 'Gemini 3.1 Pro', vision: false },
      ],
      defaultTierModels: { smart: AUTO_MODEL, balanced: AUTO_MODEL, fast: AUTO_MODEL, code: AUTO_MODEL },
    };
  }

  private buildArgs(
    messages: LLMMessage[],
    options: LLMCompletionOptions | undefined,
    outputFormat: 'json' | 'stream-json',
  ): { argv: string[]; stdin: string } {
    const systemParts: string[] = [];
    const transcript: string[] = [];

    for (const msg of messages) {
      const text = getTextContent(msg);
      if (msg.role === 'system') systemParts.push(text);
      else if (msg.role === 'assistant') transcript.push(`Assistant: ${text}`);
      else transcript.push(`User: ${text}`);
    }

    if (systemParts.length > 0) {
      transcript.unshift(`System Instructions: ${systemParts.join('\n\n')}`);
    }

    const prompt = transcript.join('\n\n');
    const argv: string[] = [
      '-p', prompt,
      '--output-format', outputFormat,
      '--disable-slash-commands',
    ];

    const model = options?.model;
    if (!shouldOmitModelFlag(model)) {
      argv.push('--model', model!, '--effort', 'medium');
    }

    return { argv, stdin: '' };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

interface CliResult { code: number; stdout: string; stderr: string; }

function runCliIdle(
  bin: string, argv: string[], stdin: string,
  opts: { idleTimeoutMs: number },
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;

    let idleTimer: ReturnType<typeof setTimeout>;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        killed = true;
        try { proc.kill('SIGTERM'); } catch { /* gone */ }
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
        reject(new Error(`${bin} idle for ${opts.idleTimeoutMs}ms — no output, subprocess killed`));
      }, opts.idleTimeoutMs);
    };
    armIdle();

    proc.stdout.on('data', (b) => { stdout += b.toString(); armIdle(); });
    proc.stderr.on('data', (b) => { stderr += b.toString(); armIdle(); });
    proc.on('error', (err) => {
      if (idleTimer) clearTimeout(idleTimer);
      if (!killed) reject(err);
    });
    proc.on('close', (code) => {
      if (idleTimer) clearTimeout(idleTimer);
      if (!killed) resolve({ code: code ?? 0, stdout, stderr });
    });

    if (stdin.length > 0) proc.stdin.end(stdin);
    else proc.stdin.end();
  });
}

function runCliIdleStreaming(
  bin: string, argv: string[], stdin: string,
  opts: { idleTimeoutMs: number },
  onLine: (line: string) => void,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let buffer = '';
    let killed = false;

    let idleTimer: ReturnType<typeof setTimeout>;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        killed = true;
        try { proc.kill('SIGTERM'); } catch { /* gone */ }
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
        reject(new Error(`${bin} idle for ${opts.idleTimeoutMs}ms — no output, subprocess killed`));
      }, opts.idleTimeoutMs);
    };
    armIdle();

    proc.stdout.on('data', (b) => {
      const s = b.toString();
      stdout += s;
      buffer += s;
      armIdle();
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        if (line) {
          try { onLine(line); } catch { /* swallow */ }
        }
      }
    });
    proc.stderr.on('data', (b) => { stderr += b.toString(); armIdle(); });
    proc.on('error', (err) => {
      if (idleTimer) clearTimeout(idleTimer);
      if (!killed) reject(err);
    });
    proc.on('close', (code) => {
      if (idleTimer) clearTimeout(idleTimer);
      if (!killed) {
        const tail = buffer.trim();
        if (tail) {
          try { onLine(tail); } catch { /* swallow */ }
        }
        resolve({ code: code ?? 0, stdout, stderr });
      }
    });

    if (stdin.length > 0) proc.stdin.end(stdin);
    else proc.stdin.end();
  });
}

export function extractAgyStreamResultText(line: string): string | undefined {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.event === 'result') {
      const res = obj.result as { response?: string } | undefined;
      if (typeof res?.response === 'string' && res.response.length > 0) return res.response;
    }
  } catch { /* skip */ }
  return undefined;
}

export function extractAgyStreamUsage(line: string): LLMCompletionResult['usage'] | undefined {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    let u: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number } | undefined;

    if (obj.event === 'result') {
      u = (obj.result as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number } })?.usage;
    } else if (obj.event === 'step_update') {
      u = (obj.step_update as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number } })?.usage;
    }

    if (u && typeof u === 'object') {
      return {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_tokens,
      };
    }
  } catch { /* skip */ }
  return undefined;
}

export function extractAgyStreamError(line: string): string | undefined {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.event === 'result') {
      const res = obj.result as { status?: string; error?: string } | undefined;
      if (res?.status === 'ERROR' && typeof res.error === 'string') {
        return res.error;
      }
    }
    if (obj.event === 'error') {
      const err = obj.error as { message?: string } | string | undefined;
      if (typeof err === 'string') return err;
      if (err && typeof err.message === 'string') return err.message;
    }
  } catch { /* skip */ }
  return undefined;
}

export function extractAgyStreamDelta(line: string): string | undefined {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.event === 'step_update') {
      const step = obj.step_update as { text_delta?: string } | undefined;
      if (typeof step?.text_delta === 'string') {
        return step.text_delta;
      }
    }
  } catch { /* skip */ }
  return undefined;
}

function formatCliError(
  bin: string,
  code: number,
  stderr: string,
  stdout: string,
  argv: string[],
  parsedError?: string,
): string {
  const parts: string[] = [`${bin} CLI exited ${code}`];
  if (parsedError) parts.push(`error=${parsedError}`);
  if (stderr.trim()) parts.push(`stderr=${stderr.trim().slice(0, 500)}`);
  if (stdout.trim()) parts.push(`stdout=${stdout.trim().slice(-500)}`);
  parts.push(`argv=${bin} ${argv.join(' ')}`);
  parts.push(`(try: \`${bin} auth login\` or \`${bin} --version\`)`);
  return parts.join(' | ');
}
