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
  cliIsRetryable,
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

/**
 * Default idle timeout: how long the subprocess can be silent (no stdout
 * AND no stderr) before we kill it. Resets on every chunk of output, so
 * a long-but-progressing generation keeps running. Only true hangs
 * (auth prompt, network stall, broken binary) hit the limit.
 *
 * Calibrated for opus on synthesis-heavy tasks (full UI rewrites,
 * multi-thousand-token code generation, large analysis): the model can
 * take 3+ minutes of internal reasoning before emitting the first stream
 * token, especially with very large prompts (40KB+) where it needs
 * substantial planning. 180s killed legitimate work; 6 minutes catches
 * genuine hangs while letting deep reasoning complete.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 360_000;

export class ClaudeCliProvider extends BaseLLMProvider {
  /** Top-level provider name; lives alongside `anthropic` etc. */
  readonly name = 'claude-cli';

  /** Path to the binary; default 'claude' resolved via PATH. */
  private readonly bin: string;

  /** Idle timeout in ms — resets on every stdout/stderr chunk. */
  private readonly idleTimeoutMs: number;

  constructor(config: { bin?: string; idleTimeoutMs?: number } = {}) {
    super({});
    this.bin = config.bin ?? 'claude';
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

  /**
   * Read a complete response. Internally drives `--output-format stream-json`
   * so token deltas reset the idle timer mid-call — long generations no
   * longer get SIGTERM'd. Returns the same shape `complete()` always has;
   * usage comes from the terminal `result` event.
   *
   * Wrapped in {@link withRetries} so a transient subprocess death
   * (idle-killed by an upstream stall, broken pipe, transient ECONNRESET on
   * the binary's outbound API call) is re-attempted with backoff. Permanent
   * failures (auth missing, unknown CLI flag, model rejected) are surfaced
   * on the first try by `cliIsRetryable`.
   */
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
          const errMsg = extractStreamError(line);
          if (errMsg) cliErrorMessage = errMsg;
          const delta = extractStreamDelta(line);
          if (delta) textSoFar += delta;
          const finalText = extractStreamResultText(line);
          if (finalText) resultText = finalText;
          const u = extractStreamUsage(line);
          if (u) usage = u;
        },
      );

      if (code !== 0) {
        throw new Error(formatCliError('claude', code, stderr, stdout, args.argv, cliErrorMessage));
      }

      const content = textSoFar || resultText;
      if (!content) {
        throw new Error(`claude CLI returned no result. raw=${stdout.slice(0, 200)}`);
      }

      return {
        content,
        finishReason: 'stop',
        usage,
      };
    }, { isRetryable: cliIsRetryable, label: 'claude-cli.complete' });
  }

  async *stream(messages: LLMMessage[], options?: LLMCompletionOptions): AsyncIterable<LLMStreamChunk> {
    const args = this.buildArgs(messages, options, 'stream-json');

    // Retry logic for streams: an attempt is retryable only if it fails
    // BEFORE any delta has been yielded to the consumer. Once tokens have
    // started flowing, a mid-stream failure can't be re-attempted without
    // duplicating output, so we propagate. Permanent failures (auth /
    // unknown flag / missing binary) skip retries on the first error.
    const maxAttempts = 3;
    const initialDelayMs = 1000;
    const backoffFactor = 2;
    const maxDelayMs = 10000;
    let yielded = false;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Iterate manually (rather than `yield*`) so we can track whether
        // any chunk has crossed the generator boundary to the consumer —
        // that's the gate for "safe to retry" vs "must propagate".
        for await (const chunk of this.streamOnce(args)) {
          if (chunk.content.length > 0) yielded = true;
          yield chunk;
        }
        return; // success
      } catch (err) {
        lastErr = err;
        if (yielded) throw err;
        if (attempt >= maxAttempts) throw err;
        if (!cliIsRetryable(err)) throw err;
        const delay = Math.min(initialDelayMs * Math.pow(backoffFactor, attempt - 1), maxDelayMs);
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(`[claude-cli.stream] attempt ${attempt}/${maxAttempts} failed: ${msg.slice(0, 200)} — retrying in ${delay}ms`);
        await new Promise<void>(resolve => setTimeout(resolve, delay));
      }
    }
    // Defensive — the loop above either returns or throws.
    throw lastErr;
  }

  /** Single stream attempt — yields chunks; throws on subprocess failure. */
  private async *streamOnce(args: { argv: string[]; stdin: string }): AsyncIterable<LLMStreamChunk> {
    const proc = spawn(this.bin, args.argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdin.end(args.stdin);

    // Idle timer: reset on every chunk of stdout/stderr. Without this a
    // hung subprocess (auth prompt, network stall) would block forever.
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutFired = false;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timeoutFired = true;
        try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      }, this.idleTimeoutMs);
    };
    armIdle();

    let textSoFar = '';
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
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }

    const code = await new Promise<number>((resolve) => proc.on('close', (c) => resolve(c ?? 0)));
    if (timeoutFired) {
      throw new Error(`claude idle for ${this.idleTimeoutMs}ms — no output, subprocess killed`);
    }
    if (code !== 0) {
      throw new Error(formatCliError('claude', code, stderr, allStdout, args.argv, cliErrorMessage));
    }
    yield { content: '', done: true };
    void textSoFar;
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

    // Claude Code requires `--verbose` together with `--output-format
    // stream-json` (CLI rejects the call with exit 1 otherwise).
    //
    // `--include-partial-messages` makes the binary emit incremental
    // `content_block_delta` events as tokens generate. Without it, the
    // assistant message lands as a single event at the end — fine for
    // correctness, terrible for the idle timeout: a long generation is
    // silent for the whole turn, and we'd kill it. Recent stable builds
    // (2.1.x) accept the flag; older releases that reject it will exit
    // 1 with a clear `unknown option` error.
    const argv: string[] = [
      '-p',
      '--output-format', outputFormat,
      // Disable EVERY native capability the claude CLI offers: built-in
      // tools (Bash/Read/Edit/Web*), user-configured MCP servers, and
      // slash-command skills. In Abjects the LLM is a pure JSON-action
      // generator — agents call other Abjects via the message bus, never
      // through claude-cli's tool layer. Without these flags the model
      // sees a catalog of tools (`mcp__claude_ai_Gmail__*`, Slack, Linear,
      // Calendar...) and reflexively reaches for them on tasks that
      // mention email/calendar/etc., producing tool calls that error
      // ("permission not granted") instead of routing through our own
      // configured Abjects (e.g. the protonmail-mcp MCPBridge).
      //
      // - `--tools ""`            disables every built-in tool
      // - `--strict-mcp-config`   ignores user-/project-level MCP servers
      //                           (paired with no `--mcp-config`, no MCP at all)
      // - `--disable-slash-commands` disables skills
      //
      // All three remain compatible with subscription auth; only `--bare`
      // forces ANTHROPIC_API_KEY.
      '--tools', '',
      '--strict-mcp-config',
      '--disable-slash-commands',
    ];
    if (outputFormat === 'stream-json') {
      argv.push('--verbose');
      argv.push('--include-partial-messages');
    }
    const model = options?.model;
    // 'auto' / undefined → omit `--model` so the CLI picks its current
    // default. This is how "Auto (latest)" routes track binary upgrades.
    if (!shouldOmitModelFlag(model)) argv.push('--model', model!);
    // `--system-prompt` *replaces* the default Claude Code system prompt
    // (vs `--append-system-prompt` which layers on top of it). Replace is
    // preferred because the default prompt injects ~5k tokens of coding-
    // assistant guidance Abjects doesn't need. We only pass the flag when
    // we actually have system content — a whitespace placeholder makes the
    // CLI exit 1 ("system prompt required"). Without the flag the CLI uses
    // its default; that's fine for calls that have no system role anyway.
    // Subscription auth still works (only `--bare` forces API key).
    if (system) argv.push('--system-prompt', system);

    // Long prompts on the command line risk argv-length limits — pipe via
    // stdin instead. Tells claude to read the prompt from stdin with `-`.
    argv.push('-');

    return { argv, stdin: prompt };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

interface CliResult { code: number; stdout: string; stderr: string; }

/**
 * Spawn a CLI, return its full stdout/stderr/exit when it closes.
 *
 * Uses an *idle* timeout: the timer resets on every chunk of stdout or
 * stderr, so a long-but-progressing subprocess keeps running. Only true
 * hangs (no output for `idleTimeoutMs`) trigger SIGTERM. This replaces
 * the old wall-clock total-call timeout, which killed long generations
 * even though claude was still working.
 */
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
        try { proc.kill('SIGTERM'); } catch { /* already gone */ }
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

/**
 * Same as `runCliIdle`, but feeds each line of stdout to `onLine` as it
 * arrives. Used by `complete()` to walk a `--output-format stream-json`
 * stream so token deltas reset the idle timer in real time. The full
 * stdout/stderr buffers are still returned for error reporting.
 */
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
        try { proc.kill('SIGTERM'); } catch { /* already gone */ }
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
          try { onLine(line); } catch { /* never let a callback crash the runner */ }
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
        // Flush any trailing line without a newline.
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

/**
 * Some `claude --output-format stream-json` builds emit a final
 * `{type:"result", result:"…", usage:{…}}` line that mirrors what `json`
 * mode would have returned. We capture it as a fallback in case no
 * incremental deltas were observed (older builds, or pure tool-only
 * turns). When deltas *are* present they are authoritative and we
 * prefer them over `result.result`.
 */
function extractStreamResultText(line: string): string | undefined {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.type === 'result') {
      const r = (obj as { result?: unknown }).result;
      if (typeof r === 'string' && r.length > 0) return r;
    }
  } catch { /* not json */ }
  return undefined;
}

/**
 * Pull `usage` (token accounting) out of any stream line that carries it.
 * Claude Code emits this on the terminal `result` event in stream-json
 * mode; the same field shape as the old `--output-format json` payload.
 */
function extractStreamUsage(line: string): LLMCompletionResult['usage'] | undefined {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const u = (obj as { usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
      cache_creation_tokens?: number;
    } }).usage;
    if (u && typeof u === 'object') {
      return {
        inputTokens:      u.input_tokens ?? 0,
        outputTokens:     u.output_tokens ?? 0,
        cacheReadTokens:  u.cache_read_tokens,
        cacheWriteTokens: u.cache_creation_tokens,
      };
    }
  } catch { /* not json */ }
  return undefined;
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

/**
 * Pull the visible-text delta out of a stream-json line.
 *
 * Returns ONLY incremental token deltas — never the terminal assistant
 * event's full text. If we returned both, `complete()` (which accumulates
 * deltas into a single string) would double-count: every token once via
 * the delta + once again via the terminal `assistant` event that carries
 * the same content. The terminal full text is captured separately via
 * `extractStreamResultText` and used only when no deltas arrived (e.g.
 * tool-only turn or an unsupported claude build).
 *
 * Recognises both wrappings:
 *   { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: '…' } } }   ← 2.1.x with --include-partial-messages
 *   { type: 'content_block_delta', delta: { text: '…' } }                                     ← older top-level form
 */
function extractStreamDelta(line: string): string | undefined {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const t = obj.type;
    if (t === 'stream_event') {
      const ev = (obj as { event?: { type?: string; delta?: { text?: string } } }).event;
      if (ev?.type === 'content_block_delta' && typeof ev.delta?.text === 'string') {
        return ev.delta.text;
      }
      return undefined;
    }
    if (t === 'content_block_delta') {
      const delta = (obj as { delta?: { text?: string } }).delta;
      if (delta && typeof delta.text === 'string') return delta.text;
    }
  } catch {
    /* malformed line — skip */
  }
  return undefined;
}
