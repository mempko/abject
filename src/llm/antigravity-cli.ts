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

import { spawn, type ChildProcess } from 'node:child_process';
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

/**
 * Mirrors `agy models`. IDs carry the reasoning effort suffix where the CLI
 * requires one (bare names like `gemini-3.7-flash` are rejected without a
 * separate `--effort`, and pro/claude models reject `--effort` outright), so
 * passing the suffixed ID alone is the only form that works for every model.
 */
const AGY_MODELS: ModelInfo[] = [
  { id: AUTO_MODEL,                 name: 'Auto (recommended)', vision: false },
  { id: 'gemini-3.7-flash-high',    name: 'Gemini 3.7 Flash (High)', vision: false },
  { id: 'gemini-3.7-flash-medium',  name: 'Gemini 3.7 Flash (Medium)', vision: false },
  { id: 'gemini-3.7-flash-low',     name: 'Gemini 3.7 Flash (Low)', vision: false },
  { id: 'gemini-3.6-flash-high',    name: 'Gemini 3.6 Flash (High)', vision: false },
  { id: 'gemini-3.6-flash-medium',  name: 'Gemini 3.6 Flash (Medium)', vision: false },
  { id: 'gemini-3.6-flash-low',     name: 'Gemini 3.6 Flash (Low)', vision: false },
  { id: 'gemini-3.5-flash-high',    name: 'Gemini 3.5 Flash (High)', vision: false },
  { id: 'gemini-3.5-flash-medium',  name: 'Gemini 3.5 Flash (Medium)', vision: false },
  { id: 'gemini-3.5-flash-low',     name: 'Gemini 3.5 Flash (Low)', vision: false },
  { id: 'gemini-3.1-pro-high',      name: 'Gemini 3.1 Pro (High)', vision: false },
  { id: 'gemini-3.1-pro-low',       name: 'Gemini 3.1 Pro (Low)', vision: false },
  { id: 'claude-sonnet-4-6',        name: 'Claude Sonnet 4.6 (Thinking)', vision: false },
  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', vision: false },
  { id: 'gpt-oss-120b-medium',      name: 'GPT-OSS 120B (Medium)', vision: false },
];

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

      // agy can report {status:'ERROR'} in the result event yet still exit 0.
      if (code !== 0 || cliErrorMessage) {
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

    // Attached before any await: 'close' can fire while the generator is
    // suspended at a yield, and a listener added afterwards would wait forever.
    let exited = false;
    const exitCode = new Promise<number>((resolve) => proc.on('close', (c) => {
      exited = true;
      resolve(c ?? 0);
    }));

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutFired = false;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timeoutFired = true;
        killProc(proc);
      }, this.idleTimeoutMs);
    };
    armIdle();

    let buffer = '';
    let allStdout = '';
    let stderr = '';
    let cliErrorMessage: string | undefined;
    let consumedToEnd = false;

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
      // The final NDJSON line (usually the 'result' event) may arrive without
      // a trailing newline; without this flush an ERROR status there is lost.
      const tail = buffer.trim();
      if (tail) {
        const errMsg = extractAgyStreamError(tail);
        if (errMsg) cliErrorMessage = errMsg;
        const delta = extractAgyStreamDelta(tail);
        if (delta) yield { content: delta, done: false };
      }
      consumedToEnd = true;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      // Consumer abandoned the stream mid-flight (goal cancelled) or the loop
      // threw: without this the child keeps running with no watchdog left.
      if (!consumedToEnd && !exited) killProc(proc);
    }

    const code = await exitCode;
    if (timeoutFired) {
      throw new Error(`agy idle for ${this.idleTimeoutMs}ms — no output, subprocess killed`);
    }
    if (code !== 0) {
      throw new Error(formatCliError('agy', code, stderr, allStdout, argv, cliErrorMessage));
    }
    if (cliErrorMessage) {
      // agy can report {status:'ERROR'} in the result event yet still exit 0;
      // surfacing it here keeps the caller from treating an empty stream as success.
      throw new Error(formatCliError('agy', code, stderr, allStdout, argv, cliErrorMessage));
    }
    yield { content: '', done: true };
  }

  async listModels(): Promise<ModelInfo[]> {
    return AGY_MODELS;
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
      models: AGY_MODELS,
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

    // agy has no stdin prompt channel (verified: bare -p prints help, '-p -'
    // treats the dash as the prompt, and piped stdin is ignored), so the whole
    // prompt must ride argv. Fail fast with an actionable message instead of a
    // cryptic spawn E2BIG: Linux caps a single arg at MAX_ARG_STRLEN (128 KiB);
    // macOS caps total argv+env at ARG_MAX (~1 MB).
    const promptBytes = Buffer.byteLength(prompt, 'utf8');
    const maxPromptBytes = process.platform === 'linux' ? 120_000 : 700_000;
    if (promptBytes > maxPromptBytes) {
      throw new Error(
        `Prompt is ${promptBytes} bytes but the agy CLI only accepts prompts via argv ` +
        `(limit ~${maxPromptBytes} bytes on this platform). Shorten the conversation ` +
        `or use an API-key provider for prompts this large.`,
      );
    }

    const argv: string[] = [
      '-p', prompt,
      '--output-format', outputFormat,
      '--disable-slash-commands',
    ];

    // Effort-suffixed IDs (see AGY_MODELS) are self-contained; a separate
    // --effort flag is rejected by pro/claude models, so never pass one.
    const model = options?.model;
    if (!shouldOmitModelFlag(model)) {
      argv.push('--model', model!);
    }

    return { argv, stdin: '' };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/** SIGTERM now, SIGKILL in 2s if the process ignores it. unref'd so the
 *  fallback timer never holds the event loop open. */
function killProc(proc: ChildProcess): void {
  try { proc.kill('SIGTERM'); } catch { /* gone */ }
  const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
  t.unref?.();
}

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
        killProc(proc);
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
        killProc(proc);
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
