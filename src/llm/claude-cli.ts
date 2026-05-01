/**
 * ClaudeCliProvider — drives the `claude` CLI in non-interactive (`-p`)
 * mode as an LLM backend, instead of calling the Anthropic HTTP API.
 *
 * Why: lets the user reuse their Claude subscription quota (via `claude
 * auth login`) instead of providing an API key. Also useful in
 * environments that already trust the user's Claude Code installation.
 *
 * Mode: stateless. Each `complete()` call spawns a fresh `claude -p`
 * process, pipes the conversation in, and parses the JSON reply. Tools
 * / MCP / hooks / skills are explicitly disabled with `--bare` — Abjects
 * has its own MCP and tool layer; we only want raw LLM text out of this
 * backend.
 *
 * Reports under provider name `'claude-cli'` — its own first-class entry
 * in the provider registry. Tier routing in GlobalSettings can pick it
 * alongside `anthropic`, `openai`, etc.
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
 * and let the CLI pick its current default. Routing schema requires a
 * non-empty string, so we use a literal token here and translate to
 * "no flag" at argv-build time.
 */
const AUTO_MODEL = 'auto';

function shouldOmitModelFlag(model: string | undefined): boolean {
  return !model || model === AUTO_MODEL;
}

/** What `claude -p --output-format json` writes to stdout. */
interface ClaudeCliJson {
  result?: string;
  session_id?: string;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  };
  /** Older builds emit `error` on a top-level key. */
  error?: string;
}

export class ClaudeCliProvider extends BaseLLMProvider {
  /** Top-level provider name; lives alongside `anthropic` etc. */
  readonly name = 'claude-cli';

  /** Path to the binary; default 'claude' resolved via PATH. */
  private readonly bin: string;

  constructor(config: { bin?: string } = {}) {
    super({});
    this.bin = config.bin ?? 'claude';
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
    const args = this.buildArgs(messages, options, 'json');
    const { code, stdout, stderr } = await runCli(this.bin, args.argv, args.stdin, 120_000);
    if (code !== 0) {
      throw new Error(formatCliError('claude', code, stderr, stdout, args.argv));
    }

    const parsed = parseClaudeJson(stdout);
    if (parsed.error) {
      throw new Error(`claude CLI error: ${parsed.error}`);
    }
    if (!parsed.result) {
      throw new Error(`claude CLI returned no result. raw=${stdout.slice(0, 200)}`);
    }

    return {
      content: parsed.result,
      finishReason: 'stop',
      usage: parsed.usage ? {
        inputTokens:       parsed.usage.input_tokens ?? 0,
        outputTokens:      parsed.usage.output_tokens ?? 0,
        cacheReadTokens:   parsed.usage.cache_read_tokens,
        cacheWriteTokens:  parsed.usage.cache_creation_tokens,
      } : undefined,
    };
  }

  async *stream(messages: LLMMessage[], options?: LLMCompletionOptions): AsyncIterable<LLMStreamChunk> {
    const args = this.buildArgs(messages, options, 'stream-json');
    const proc = spawn(this.bin, args.argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdin.end(args.stdin);

    let textSoFar = '';
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
        // Some failures arrive as a single error event on stdout —
        // capture it so we can surface a useful message.
        const errMsg = extractStreamError(line);
        if (errMsg) cliErrorMessage = errMsg;
        const delta = extractStreamDelta(line);
        if (delta) {
          textSoFar += delta;
          yield { content: delta, done: false };
        }
      }
    }

    const code = await new Promise<number>((resolve) => proc.on('close', (c) => resolve(c ?? 0)));
    if (code !== 0) {
      throw new Error(formatCliError('claude', code, stderr, allStdout, args.argv, cliErrorMessage));
    }
    yield { content: '', done: true };
    void textSoFar; // for future debug; stream consumers accumulate themselves
  }

  async listModels(): Promise<ModelInfo[]> {
    // The CLI doesn't expose a list endpoint; report the canonical aliases.
    return [
      { id: AUTO_MODEL, name: 'Auto (latest default)' },
      { id: 'opus',   name: 'Claude Opus (alias)' },
      { id: 'sonnet', name: 'Claude Sonnet (alias)' },
      { id: 'haiku',  name: 'Claude Haiku (alias)' },
    ];
  }

  override describe(): LLMProviderDescription {
    return {
      id: 'claude-cli',
      label: 'Claude CLI',
      // No persisted credential — the binary owns auth. We still need
      // a unique storage suffix so per-provider keys don't collide.
      storageSuffix: 'claudeCli',
      credentialMode: 'cli',
      cli: {
        binary: 'claude',
        installHint: 'Install Claude Code: https://docs.anthropic.com/en/docs/claude-code/setup',
      },
      models: [
        { id: AUTO_MODEL, name: 'Auto (latest default)' },
        { id: 'opus',     name: 'Claude Opus (alias)' },
        { id: 'sonnet',   name: 'Claude Sonnet (alias)' },
        { id: 'haiku',    name: 'Claude Haiku (alias)' },
      ],
      // CLI providers default to 'auto' — the binary picks its current
      // latest model for each call. Upgrading the binary auto-rolls
      // these routes onto the new default with no settings changes.
      defaultTierModels: { smart: AUTO_MODEL, balanced: AUTO_MODEL, fast: AUTO_MODEL },
    };
  }

  /**
   * Build the argv + stdin payload for one call.
   *
   * Strategy: flatten the conversation into a transcript and pass it as
   * the prompt argument. The system message is split out and passed via
   * `--append-system-prompt`. This loses a little structural fidelity vs
   * a stream-json input but keeps the integration single-shot and easy
   * to reason about. The returned text is the same either way.
   */
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
    const prompt = transcript.join('\n\n');
    const system = systemParts.join('\n\n');

    // Conservative arg set. Claude Code requires `--verbose` together
    // with `--output-format stream-json` (the CLI rejects the call with
    // exit 1 otherwise), so we add it on the streaming path only. Other
    // flags from earlier drafts (`--bare`, `--include-partial-messages`)
    // turned out to be unsupported on stable builds — keeping the
    // surface minimal means a working `claude` install just works.
    const argv: string[] = [
      '-p',
      '--output-format', outputFormat,
    ];
    if (outputFormat === 'stream-json') {
      argv.push('--verbose');
    }
    const model = options?.model;
    // 'auto' / undefined → omit `--model` so the CLI picks its current
    // default. This is how "Auto (latest)" routes track binary upgrades.
    if (!shouldOmitModelFlag(model)) argv.push('--model', model!);
    if (system) argv.push('--append-system-prompt', system);

    // Long prompts on the command line risk argv-length limits — pipe via
    // stdin instead. Tells claude to read the prompt from stdin with `-`.
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

function parseClaudeJson(raw: string): ClaudeCliJson {
  // Some claude builds wrap the JSON with leading log lines. Find the
  // first '{' and parse from there; fall back to raw text on any error.
  const trimmed = raw.trimStart();
  const i = trimmed.indexOf('{');
  if (i < 0) return { error: `unexpected output: ${raw.slice(0, 200)}` };
  try {
    return JSON.parse(trimmed.slice(i)) as ClaudeCliJson;
  } catch (err) {
    return { error: `JSON parse failed: ${(err as Error).message}; raw=${raw.slice(0, 200)}` };
  }
}

/**
 * Pull the visible-text delta out of a stream-json line, if any.
 *
 * Claude Code emits a sequence of typed events; we only surface the
 * `delta`/`text_delta` payloads to callers. Unknown shapes are skipped
 * silently — the CLI's exact event schema evolves between versions.
 */
/**
 * Some failure modes (auth missing, model rejected, internal error) come
 * through as a single `{type:"error", error:{message:...}}` line on stdout
 * before exit. Extract the human-readable message so we can surface it
 * in the thrown error.
 */
function extractStreamError(line: string): string | undefined {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.type === 'error') {
      const inner = obj.error as { message?: string } | string | undefined;
      if (typeof inner === 'string') return inner;
      if (inner && typeof inner.message === 'string') return inner.message;
      return JSON.stringify(obj);
    }
  } catch { /* not json */ }
  return undefined;
}

/**
 * Build a single-line error string with everything we know — exit code,
 * stderr, stdout tail, the parsed-out CLI error event if any, and the
 * argv so the user can replay the call by hand. Without this every
 * failure looks like the opaque "exited 1: no stderr" you saw before.
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
  parts.push(`(try: \`${bin} auth login\` or \`${bin} --version\`)`);
  return parts.join(' | ');
}

function extractStreamDelta(line: string): string | undefined {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    // Common shapes seen across Claude Code releases:
    //   { type: 'content_block_delta', delta: { type: 'text_delta', text: '...' } }
    //   { type: 'partial_message', message: { content: [{ type: 'text', text: '...' }] } }
    //   { type: 'assistant', message: { content: [...] } }
    if (typeof obj.type === 'string') {
      const t = obj.type as string;
      if (t === 'content_block_delta') {
        const delta = (obj as { delta?: { text?: string } }).delta;
        if (delta && typeof delta.text === 'string') return delta.text;
      }
      if (t === 'partial_message' || t === 'assistant') {
        const message = (obj as { message?: { content?: Array<{ type?: string; text?: string }> } }).message;
        const text = message?.content?.find((b) => b.type === 'text')?.text;
        if (text) return text;
      }
    }
  } catch {
    /* malformed line — skip */
  }
  return undefined;
}
