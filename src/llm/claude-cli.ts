/**
 * ClaudeCliProvider - drives the `claude` CLI as an LLM backend, instead of
 * calling the Anthropic HTTP API.
 *
 * Why: lets the user reuse their Claude subscription (via `claude auth
 * login`) instead of providing an API key. Also useful in environments that
 * already trust the user's Claude Code installation.
 *
 * Mode: warm interactive sessions. The CLI runs its normal terminal session
 * inside a pseudo-terminal and is reused across requests, with `/clear`
 * between them to drop the previous conversation. This removes the ~0.74s
 * process boot that the previous per-request spawn paid every time.
 *
 * Because the session is a terminal UI, the reply is read from the rendered
 * screen. See `pty-session.ts` for what that costs in fidelity, and
 * `pty-dialects.ts` for the patterns that recognise this particular UI.
 *
 * Reports under provider name `'claude-cli'` - its own first-class entry in
 * the provider registry. Tier routing in GlobalSettings can pick it
 * alongside `anthropic`, `openai`, etc.
 */

import {
  flattenConversation,
  formatCliError,
  hasImages,
  runCliIdle,
  runCliIdleStreaming,
} from './cli-process.js';
import { PtySessionPool, sessionSandboxDir } from './pty-session.js';
import { claudeDialect } from './pty-dialects.js';
import {
  BaseLLMProvider,
  LLMCompletionOptions,
  LLMCompletionResult,
  LLMMessage,
  LLMProviderDescription,
  LLMStreamChunk,
  ModelInfo,
  cliIsRetryable,
} from './provider.js';

/**
 * Sentinel value for the "Auto" model option - spawn with no `--model` flag
 * and let the CLI use its configured default. Routing schema requires a
 * non-empty string, so we use a literal token here and translate to "no
 * flag" when building the session's argv.
 */
const AUTO_MODEL = 'auto';

function shouldOmitModelFlag(model: string | undefined): boolean {
  return !model || model === AUTO_MODEL;
}

/**
 * Default idle timeout: how long a session can be entirely silent before we
 * give up on it. Resets on every byte of terminal output, so a long-but-
 * progressing generation keeps running; only a true hang hits it.
 *
 * Calibrated for opus on synthesis-heavy tasks (full UI rewrites, large
 * code generation, large analysis), where the model can reason for minutes
 * before drawing anything. 6 minutes catches genuine hangs while letting
 * deep reasoning complete.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 360_000;

/**
 * Warm sessions per model. Each one is a live child process holding a
 * terminal session, and a terminal UI has a single input box, so two
 * concurrent requests need two sessions. Two is a deliberate floor: enough
 * for a little parallelism without a process pile-up when several models
 * are routed at once.
 */
const DEFAULT_MAX_SESSIONS = 2;

/**
 * How a provider talks to the CLI binary. The two differ in what they can
 * report, not in what model answers.
 *
 * 'stream-json' runs a one-shot `-p` call per request and reads structured
 * events: the reply arrives as data, and token usage comes back with it.
 *
 * 'terminal' keeps an interactive session warm in a pseudo-terminal and
 * reads the reply off the rendered screen. It saves the binary's startup
 * cost on every request after the first, and pays for it by reporting no
 * token usage (a terminal UI prints none per turn) and by depending on
 * patterns that match a UI rather than an interface.
 */
export type CliTransport = 'stream-json' | 'terminal';

export class ClaudeCliProvider extends BaseLLMProvider {
  /**
   * Top-level provider name; lives alongside `anthropic` etc. The two
   * transports register as separate providers so tier routing can pick
   * between them the same way it picks any other provider, with no new
   * settings machinery.
   */
  readonly name: string;

  private readonly transport: CliTransport;

  /** Path to the binary; default 'claude' resolved via PATH. */
  private readonly bin: string;

  /** Idle timeout in ms - resets on every byte of terminal output. */
  private readonly idleTimeoutMs: number;

  private readonly maxSessions: number;

  /**
   * One pool per resolved model, created on first use.
   *
   * Keyed by model because the session's model is fixed at spawn (via
   * `--model`), which is both simpler and more reliable than switching a
   * live session's model mid-conversation. In the common configuration
   * every tier resolves to "auto", so this holds exactly one pool.
   *
   * Lazy because `LLMObject` constructs providers purely to read their
   * manifests; constructing one must never start a process.
   */
  private readonly pools = new Map<string, PtySessionPool>();

  constructor(config: {
    bin?: string;
    idleTimeoutMs?: number;
    maxSessions?: number;
    transport?: CliTransport;
  } = {}) {
    super({});
    this.transport = config.transport ?? 'stream-json';
    this.name = this.transport === 'terminal' ? 'claude-cli-pty' : 'claude-cli';
    this.bin = config.bin ?? 'claude';
    this.idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxSessions = config.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { code } = await runCliIdle(this.bin, ['--version'], { idleTimeoutMs: 5_000 });
      return code === 0;
    } catch {
      return false;
    }
  }

  /**
   * Read a complete response from a warm session.
   *
   * Wrapped in {@link withRetries} so a transient session death (idle-killed
   * by an upstream stall, a UI that failed to settle, the child exiting) is
   * re-attempted with backoff on a fresh session. Permanent failures (binary
   * missing, auth gone) surface on the first try via `cliIsRetryable`.
   */
  async complete(messages: LLMMessage[], options?: LLMCompletionOptions): Promise<LLMCompletionResult> {
    const model = this.resolveModel(options);

    // Images always take the one-shot path, whatever the configured
    // transport. A pty carries keystrokes, and there is no way to put a
    // picture on the child's clipboard, so a terminal session simply
    // cannot express the request.
    if (this.transport === 'stream-json' || hasImages(messages)) {
      return this.completeOneShot(messages, model);
    }

    const prompt = buildPrompt(messages);
    return this.withRetries(async () => {
      const content = await this.poolFor(model).ask(prompt);
      return {
        content,
        finishReason: 'stop' as const,
        // A terminal UI reports no per-turn token counts, so requests
        // routed here contribute no usage figures to the ledger.
        usage: undefined,
      };
    }, { isRetryable: cliIsRetryable, label: `${this.name}.complete` });
  }

  /**
   * One-shot `-p` call reading structured events.
   *
   * Nothing here is scraped off a screen: the reply arrives as data and
   * token usage comes back with it. Costs the binary's startup on every
   * request, which is the whole of what the warm terminal session saves.
   *
   * The same flags that make the terminal session toolless apply here, so
   * neither transport can reach tools the other cannot.
   */
  private async completeOneShot(messages: LLMMessage[], model: string): Promise<LLMCompletionResult> {
    const argv = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      // Claude Code rejects stream-json output without --verbose.
      '--verbose',
      // Nothing should persist: this is a one-shot, not a conversation.
      '--no-session-persistence',
      ...claudeDialect.argv,
    ];
    if (!shouldOmitModelFlag(model)) argv.push('--model', model);

    const stdin = `${JSON.stringify(buildStreamJsonUserMessage(messages))}\n`;

    return this.withRetries(async () => {
      let text = '';
      let resultText: string | undefined;
      let usage: LLMCompletionResult['usage'];
      let cliError: string | undefined;

      const { code, stdout, stderr } = await runCliIdleStreaming(
        this.bin, argv,
        // Run somewhere empty, matching the terminal transport. Claude Code
        // injects the working directory and its git status into the default
        // system prompt, so running here would put the user's repo state
        // into every request: wasted tokens, and context an agent asked for
        // a JSON action has no business seeing.
        { idleTimeoutMs: this.idleTimeoutMs, stdin, cwd: sessionSandboxDir() },
        (line) => {
          const err = extractStreamError(line);
          if (err) cliError = err;
          const delta = extractStreamDelta(line);
          if (delta) text += delta;
          const final = extractStreamResultText(line);
          if (final) resultText = final;
          const u = extractStreamUsage(line);
          if (u) usage = u;
        },
      );

      if (code !== 0) {
        throw new Error(formatCliError(this.bin, code, stderr, stdout, argv, cliError));
      }
      // Deltas are authoritative when present; the terminal result event is
      // the fallback for builds that do not emit incremental text.
      const content = text || resultText;
      if (!content) {
        throw new Error(`${this.bin} returned no result. raw=${stdout.slice(0, 300)}`);
      }
      return { content, finishReason: 'stop' as const, usage };
    }, { isRetryable: cliIsRetryable, label: `${this.name}.complete` });
  }

  /**
   * Yield the reply as a single chunk.
   *
   * Token-level streaming is not recoverable from a terminal UI: the screen
   * is repainted rather than appended, so partial frames are not a reliable
   * prefix of the final text. Callers get one chunk on completion instead of
   * incremental deltas.
   */
  async *stream(messages: LLMMessage[], options?: LLMCompletionOptions): AsyncIterable<LLMStreamChunk> {
    const result = await this.complete(messages, options);
    if (result.content.length > 0) yield { content: result.content, done: false };
    // The terminal chunk must carry a stop reason. Without one the consumer
    // cannot tell a complete answer from a stream that died mid-generation,
    // and logs every call as "no finish frame - possible truncation". Usage
    // rides the same chunk because it is the only place the ledger reads it
    // from on the streaming path; the terminal transport has none to give,
    // but the stream-json one does and used to lose it here.
    yield { content: '', done: true, stopReason: result.finishReason, usage: result.usage };
  }

  override resolveModel(options?: LLMCompletionOptions): string {
    return options?.model ?? AUTO_MODEL;
  }

  async listModels(): Promise<ModelInfo[]> {
    // The CLI exposes no list endpoint; report the canonical aliases.
    // vision: true because image requests take the stream-json transport,
    // which passes base64 image blocks through to the model. The warm
    // terminal session cannot carry an image; complete() routes around it.
    return [
      { id: AUTO_MODEL, name: 'Auto (latest default)', vision: true },
      { id: 'opus',   name: 'Claude Opus (alias)', vision: true },
      { id: 'sonnet', name: 'Claude Sonnet (alias)', vision: true },
      { id: 'haiku',  name: 'Claude Haiku (alias)', vision: true },
    ];
  }

  override describe(): LLMProviderDescription {
    const terminal = this.transport === 'terminal';
    return {
      id: this.name,
      // Named for what the user is choosing between. The trade is startup
      // cost against token accounting and output fidelity, so the label
      // says which one this is rather than leaving them to guess.
      label: terminal ? 'Claude CLI (warm terminal session)' : 'Claude CLI',
      // No persisted credential - the binary owns auth. We still need a
      // unique storage suffix so per-provider keys don't collide.
      storageSuffix: terminal ? 'claudeCliPty' : 'claudeCli',
      credentialMode: 'cli',
      cli: {
        binary: 'claude',
        installHint: terminal
          ? 'Reuses one warm `claude` session per model: saves process startup on every '
            + 'request, reports no token usage, and reads replies off the rendered screen. '
            + 'Install Claude Code: https://docs.anthropic.com/en/docs/claude-code/setup'
          : 'One `claude` process per request, reading structured output: reports token '
            + 'usage and returns the reply verbatim. '
            + 'Install Claude Code: https://docs.anthropic.com/en/docs/claude-code/setup',
      },
      models: [
        { id: AUTO_MODEL, name: 'Auto (latest default)', vision: true },
        { id: 'opus',     name: 'Claude Opus (alias)', vision: true },
        { id: 'sonnet',   name: 'Claude Sonnet (alias)', vision: true },
        { id: 'haiku',    name: 'Claude Haiku (alias)', vision: true },
      ],
      // CLI providers default to 'auto' - the binary picks its current
      // default for each session. Upgrading the binary auto-rolls these
      // routes onto the new default with no settings changes.
      defaultTierModels: { smart: AUTO_MODEL, balanced: AUTO_MODEL, fast: AUTO_MODEL, code: AUTO_MODEL },
    };
  }

  /**
   * Kill every warm session. Called when LLMObject stops, so terminal
   * sessions never outlive the runtime that created them.
   */
  async shutdown(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(pools.map(p => p.close()));
  }

  /** The pool serving `model`, started on first use. */
  private poolFor(model: string): PtySessionPool {
    let pool = this.pools.get(model);
    if (!pool) {
      // Append to the dialect's argv rather than replacing it: that argv
      // carries the flags that disable tools and MCP, and dropping them
      // would hand the model a tool layer Abjects means to own.
      const argv = shouldOmitModelFlag(model)
        ? [...claudeDialect.argv]
        : [...claudeDialect.argv, '--model', model];
      pool = new PtySessionPool(
        { ...claudeDialect, bin: this.bin, argv },
        {
          idleTimeoutMs: this.idleTimeoutMs,
          maxSessions: this.maxSessions,
        },
      );
      this.pools.set(model, pool);
    }
    return pool;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Flatten a conversation into the single block of text a terminal session
 * accepts as one turn.
 *
 * System messages become a leading delimited block rather than a
 * `--system-prompt` flag: the flag is fixed for a session's whole lifetime,
 * and Abjects gives each agent its own system prompt, so pinning one per
 * session would mean a separate warm session per agent.
 */
function buildPrompt(messages: LLMMessage[]): string {
  const { system, transcript } = flattenConversation(messages);
  const parts: string[] = [];
  if (system) parts.push(`[Instructions]\n${system}\n[/Instructions]`);
  parts.push(transcript);
  return parts.join('\n\n');
}

/**
 * Build the single NDJSON user message the CLI reads in stream-json input
 * mode.
 *
 * The whole conversation collapses into one turn, the same shape the warm
 * session gets, with every image lifted out as its own content block.
 * Images come before the text: the request is almost always "here is a
 * picture, now do this with it", and the instruction reads better last.
 */
function buildStreamJsonUserMessage(messages: LLMMessage[]): unknown {
  const images: unknown[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type !== 'image') continue;
      images.push({
        type: 'image',
        source: { type: 'base64', media_type: part.mediaType, data: part.data },
      });
    }
  }

  const content: unknown[] = [...images, { type: 'text', text: buildPrompt(messages) }];
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
}

/**
 * Pull the visible-text delta out of one stream-json line.
 *
 * Returns ONLY incremental deltas, never the terminal assistant event's full
 * text: the caller accumulates deltas, so returning both would double every
 * token. Recognises the two wrappings the CLI has used for the same event.
 */
function extractStreamDelta(line: string): string | undefined {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.type === 'stream_event') {
      const ev = (obj as { event?: { type?: string; delta?: { text?: string } } }).event;
      if (ev?.type === 'content_block_delta' && typeof ev.delta?.text === 'string') return ev.delta.text;
      return undefined;
    }
    if (obj.type === 'content_block_delta') {
      const delta = (obj as { delta?: { text?: string } }).delta;
      if (typeof delta?.text === 'string') return delta.text;
    }
  } catch { /* not json */ }
  return undefined;
}

/** The terminal `result` event's full text, used when no deltas arrived. */
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

/** Token accounting from any stream line that carries it. */
function extractStreamUsage(line: string): LLMCompletionResult['usage'] | undefined {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const u = (obj as { usage?: {
      input_tokens?: number; output_tokens?: number;
      cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
    } }).usage;
    if (u && typeof u === 'object') {
      return {
        inputTokens:      u.input_tokens ?? 0,
        outputTokens:     u.output_tokens ?? 0,
        cacheReadTokens:  u.cache_read_input_tokens,
        cacheWriteTokens: u.cache_creation_input_tokens,
      };
    }
  } catch { /* not json */ }
  return undefined;
}

/** A failure reported as an `error` event on stdout rather than via exit code. */
function extractStreamError(line: string): string | undefined {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.type !== 'error') return undefined;
    const inner = obj.error as { message?: string } | string | undefined;
    if (typeof inner === 'string') return inner;
    if (typeof inner?.message === 'string') return inner.message;
    return JSON.stringify(obj);
  } catch { /* not json */ }
  return undefined;
}
