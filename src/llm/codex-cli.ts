/**
 * CodexCliProvider — drives the `codex` CLI in non-interactive mode
 * (`codex exec --json`) as an LLM backend, instead of calling the
 * OpenAI HTTP API.
 *
 * Why: lets the user reuse their ChatGPT subscription quota (via
 * `codex login`) instead of providing an OpenAI API key.
 *
 * Mode: stateless. Each `complete()` spawns a fresh `codex exec`.
 * `--sandbox read-only` prevents codex from touching the filesystem;
 * Abjects has its own MCP / tool layer so we only want raw text.
 *
 * Reports under provider name `'codex-cli'` — its own first-class entry
 * in the provider registry, picked via tier routing in GlobalSettings.
 *
 * Caveats vs ClaudeCliProvider:
 * - codex has no first-class system-prompt flag. We prepend system
 *   instructions to the prompt as a delimited block.
 * - codex emits NDJSON event streams; we accumulate the assistant's
 *   final text and ignore tool/plan events.
 * - codex's `--json` token-usage fields are less stable than Claude's.
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
  getTextContent,
} from './provider.js';

/**
 * Sentinel value for the "Auto" model option — pass no `--model` flag
 * and let codex pick its current default. When codex ships a new model
 * (e.g. GPT-6), `codex upgrade` updates the default and routes that use
 * "Auto" track it with no settings change.
 */
const AUTO_MODEL = 'auto';

function shouldOmitModelFlag(model: string | undefined): boolean {
  return !model || model === AUTO_MODEL;
}

export class CodexCliProvider extends BaseLLMProvider {
  readonly name = 'codex-cli';

  private readonly bin: string;

  constructor(config: { bin?: string } = {}) {
    super({});
    this.bin = config.bin ?? 'codex';
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { code } = await runCli(this.bin, ['--version'], '', 5_000);
      return code === 0;
    } catch {
      return false;
    }
  }

  async complete(messages: LLMMessage[], options?: LLMCompletionOptions): Promise<LLMCompletionResult> {
    const { argv, stdin } = this.buildArgs(messages, options);
    const { code, stdout, stderr } = await runCli(this.bin, argv, stdin, 180_000);
    if (code !== 0) {
      throw new Error(formatCliError('codex', code, stderr, stdout, argv));
    }

    const final = extractCodexFinalMessage(stdout);
    if (!final) {
      throw new Error(`codex CLI returned no message. raw=${stdout.slice(0, 300)}`);
    }
    return {
      content: final.text,
      finishReason: 'stop',
      usage: final.usage,
    };
  }

  async *stream(messages: LLMMessage[], options?: LLMCompletionOptions): AsyncIterable<LLMStreamChunk> {
    const { argv, stdin } = this.buildArgs(messages, options);
    const proc = spawn(this.bin, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdin.end(stdin);

    let buffer = '';
    let allStdout = '';
    let stderr = '';
    let cliErrorMessage: string | undefined;
    proc.stderr.on('data', (b) => { stderr += b.toString(); });

    for await (const chunk of proc.stdout) {
      const s = String(chunk);
      allStdout += s;
      buffer += s;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        if (!line) continue;
        const errMsg = extractCodexStreamError(line);
        if (errMsg) cliErrorMessage = errMsg;
        const delta = extractCodexStreamDelta(line);
        if (delta) yield { content: delta, done: false };
      }
    }

    const code = await new Promise<number>((resolve) => proc.on('close', (c) => resolve(c ?? 0)));
    if (code !== 0) {
      throw new Error(formatCliError('codex', code, stderr, allStdout, argv, cliErrorMessage));
    }
    yield { content: '', done: true };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: AUTO_MODEL,         name: 'Auto (recommended)' },
      { id: 'gpt-5-codex',      name: 'gpt-5-codex (ChatGPT login)' },
      { id: 'gpt-5-codex-mini', name: 'gpt-5-codex-mini (ChatGPT login)' },
      { id: 'gpt-5',            name: 'gpt-5 (API key only)' },
      { id: 'gpt-5-mini',       name: 'gpt-5-mini (API key only)' },
    ];
  }

  override describe(): LLMProviderDescription {
    return {
      id: 'codex-cli',
      label: 'Codex CLI',
      storageSuffix: 'codexCli',
      credentialMode: 'cli',
      cli: {
        binary: 'codex',
        installHint: 'Install Codex: npm install -g @openai/codex',
      },
      // Codex's accepted model names depend on auth mode. With a ChatGPT
      // account login (`codex login`, the no-API-key path) only the
      // `gpt-5-codex*` variants are accepted — `gpt-5` / `gpt-5-mini` are
      // API-key-only and surface a 400 "model is not supported when using
      // Codex with a ChatGPT account" if picked. "Auto" sidesteps both
      // by letting the binary choose what's valid for the current auth.
      models: [
        { id: AUTO_MODEL,         name: 'Auto (recommended)' },
        { id: 'gpt-5-codex',      name: 'gpt-5-codex (ChatGPT login)' },
        { id: 'gpt-5-codex-mini', name: 'gpt-5-codex-mini (ChatGPT login)' },
        { id: 'gpt-5',            name: 'gpt-5 (API key only)' },
        { id: 'gpt-5-mini',       name: 'gpt-5-mini (API key only)' },
      ],
      defaultTierModels: { smart: AUTO_MODEL, balanced: AUTO_MODEL, fast: AUTO_MODEL },
      // One-time migration: codex with a ChatGPT-account login refuses
      // the API-only `gpt-5` / `gpt-5-mini` model names. Rewrite any
      // saved tier-routing model that still uses those to 'auto', which
      // works regardless of auth mode.
      modelMigrations: {
        'gpt-5':      AUTO_MODEL,
        'gpt-5-mini': AUTO_MODEL,
      },
    };
  }

  /**
   * Build argv + stdin for one `codex exec` call.
   *
   * codex has no system-prompt flag, so we fold all system messages
   * into a leading `[Instructions] … [/Instructions]` block followed
   * by the user/assistant transcript.
   */
  private buildArgs(messages: LLMMessage[], options?: LLMCompletionOptions): { argv: string[]; stdin: string } {
    const systemParts: string[] = [];
    const transcript: string[] = [];
    for (const msg of messages) {
      const text = getTextContent(msg);
      if (msg.role === 'system') systemParts.push(text);
      else if (msg.role === 'assistant') transcript.push(`Assistant: ${text}`);
      else transcript.push(`User: ${text}`);
    }
    const parts: string[] = [];
    if (systemParts.length) parts.push(`[Instructions]\n${systemParts.join('\n\n')}\n[/Instructions]`);
    parts.push(transcript.join('\n\n'));
    const prompt = parts.join('\n\n');

    const argv: string[] = ['exec', '--json', '--sandbox', 'read-only'];
    const model = options?.model;
    if (!shouldOmitModelFlag(model)) argv.push('--model', model!);
    // Read prompt from stdin to avoid argv-length limits.
    argv.push('-');

    return { argv, stdin: prompt };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

interface CliResult { code: number; stdout: string; stderr: string; }

function runCli(bin: string, argv: string[], stdin: string, timeoutMs: number): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (b) => { stdout += b.toString(); });
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('error', (err) => {
      clearTimeout(timer);
      if (!killed) reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (!killed) resolve({ code: code ?? 0, stdout, stderr });
    });

    if (stdin.length > 0) proc.stdin.end(stdin);
    else proc.stdin.end();
  });
}

interface CodexFinalMessage {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Walk codex's NDJSON output and accumulate the assistant's final
 * message. `codex exec --json` emits whole-event JSONL (no token
 * streaming):
 *   - `thread.started` — session id, ignored
 *   - `turn.started`   — turn boundary, ignored
 *   - `item.completed` with `item.type === 'agent_message'` and
 *     `item.text` — *the* assistant reply (may appear multiple times
 *     across a turn; we concatenate them in order)
 *   - `turn.completed` with `usage: { input_tokens, cached_input_tokens,
 *     output_tokens }` — stop signal + token accounting
 *   - `error` / `turn.failed` — failure (handled separately)
 *
 * Older builds emit reasoning items (`item.type === 'reasoning'`) we
 * deliberately drop; only `agent_message` items are user-visible.
 */
function extractCodexFinalMessage(raw: string): CodexFinalMessage | null {
  let text = '';
  let usage: CodexFinalMessage['usage'] | undefined;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    const type = obj.type as string | undefined;

    if (type === 'item.completed') {
      const item = (obj as { item?: { type?: string; text?: string } }).item;
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        text += item.text;
      }
    } else if (type === 'turn.completed') {
      const u = (obj as { usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number } }).usage;
      if (u) {
        usage = {
          inputTokens:  u.input_tokens  ?? 0,
          outputTokens: u.output_tokens ?? 0,
        };
      }
    }
  }

  const finalText = text.trim();
  if (!finalText) return null;
  return { text: finalText, usage };
}

/**
 * Codex emits failures as `turn.failed` events with a doubly-encoded
 * message — the outer `error.message` is itself a JSON string of the
 * underlying API error. Unwrap as far as we can to surface the human
 * sentence ("The 'gpt-5' model is not supported when…") rather than
 * the raw envelope.
 */
function extractCodexStreamError(line: string): string | undefined {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
  const t = obj.type as string | undefined;
  if (t !== 'turn.failed' && t !== 'error') return undefined;

  // turn.failed → { error: { message: "<json string>" } }
  // error      → { message: "..." } | { error: ... }
  const candidate = (obj as { error?: unknown }).error ?? (obj as { message?: unknown }).message;
  let msg = pickMessage(candidate);
  // Some messages are JSON-encoded API errors; unwrap one more layer.
  try {
    const inner = JSON.parse(msg) as Record<string, unknown>;
    const innerMsg = pickMessage(inner.error ?? inner);
    if (innerMsg) msg = innerMsg;
  } catch { /* leave as-is */ }
  return msg || undefined;
}

function pickMessage(x: unknown): string {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object') {
    const m = (x as { message?: unknown }).message;
    if (typeof m === 'string') return m;
    return JSON.stringify(x);
  }
  return '';
}

/**
 * Build a single-line error string with everything we know — exit code,
 * the parsed CLI error if we extracted one, stderr, stdout tail, and
 * the argv so the user can replay the call by hand.
 */
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
  parts.push(`(try: \`${bin} login\` or \`${bin} --version\`)`);
  return parts.join(' | ');
}

/**
 * Extract a text chunk from one codex stream line. Codex emits whole
 * messages on `item.completed` rather than token-level deltas, so each
 * yield here is the full text of one agent_message item.
 */
function extractCodexStreamDelta(line: string): string | undefined {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.type !== 'item.completed') return undefined;
    const item = (obj as { item?: { type?: string; text?: string } }).item;
    if (item?.type !== 'agent_message') return undefined;
    return typeof item.text === 'string' ? item.text : undefined;
  } catch {
    return undefined;
  }
}
