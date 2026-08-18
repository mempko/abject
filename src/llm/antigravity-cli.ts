/**
 * AntigravityCliProvider - drives the `agy` (Antigravity CLI) binary in
 * non-interactive print mode as an LLM backend.
 *
 * Why: lets the user reuse their Antigravity subscription / session quota
 * instead of providing an API key.
 *
 * Mode: stateless one-shot. Each request spawns a fresh `agy` process
 * reading one NDJSON user message on stdin and writing a stream-json event
 * stream on stdout. Nothing is scraped off a screen: the reply arrives as
 * data and token usage comes back with it.
 *
 * TOOL ACCESS - unresolved, and a deliberate note rather than an oversight.
 * Unlike `claude` (`--tools ""`) there is no way to run `agy` as a plain
 * text generator: its init event advertises ~56 tools (run_command,
 * write_to_file, call_mcp_tool, the browser suite) and `--mode plan` warns
 * it "has no effect while slash command expansion is disabled". Two
 * consequences callers should know about:
 *
 *  1. Every request pays ~15k input tokens for a tool catalog Abjects can
 *     never use, because capabilities are routed through objects on the
 *     message bus rather than the CLI's own tool layer.
 *  2. Headless mode cannot answer a permission prompt, so a tool call is
 *     auto-denied - and the model frequently gives up at that point and
 *     returns an empty answer with status SUCCESS. {@link TOOLLESS_NOTE}
 *     tells the model up front not to bother, and an empty result is
 *     surfaced as {@link EmptyCompletionError} rather than as success.
 *
 * Denial is not total either: allow-rules in the user's agy settings.json
 * (e.g. `command(find)`) apply to these sessions too, so treat
 * antigravity-cli as a provider with tool access and run it somewhere
 * harmless. See {@link AntigravityCliProvider.sandbox}.
 *
 * Reports under provider name `'antigravity-cli'`.
 */

import { spawn } from 'node:child_process';
import {
  formatCliError,
  flattenConversation,
  killProc,
  runCliIdle,
  runCliIdleStreaming,
} from './cli-process.js';
import { sessionSandboxDir } from './pty-session.js';
import {
  BaseLLMProvider,
  EmptyCompletionError,
  LLMCompletionOptions,
  LLMCompletionResult,
  LLMMessage,
  LLMProviderDescription,
  LLMStreamChunk,
  ModelInfo,
  cliIsRetryable,
} from './provider.js';

/**
 * Sentinel for the "Auto" model option - spawn with no `--model` flag and
 * let the CLI use its configured default. Routing schema requires a
 * non-empty string, so a literal token stands in for "no flag".
 */
const AUTO_MODEL = 'auto';

/**
 * Mirrors `agy models`. IDs carry the reasoning effort suffix where the CLI
 * requires one (bare names like `gemini-3.7-flash` are rejected without a
 * separate `--effort`, and pro/claude models reject `--effort` outright), so
 * passing the suffixed ID alone is the only form that works for every model.
 *
 * vision is false throughout: agy rejects an image content block outright
 * (exit 1, result status ERROR), so image requests must be routed away from
 * this provider rather than degraded.
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

/**
 * How long the process can be entirely silent before we give up on it.
 * Resets on every byte of output, so a long-but-progressing generation keeps
 * running and only a true hang hits it. Matches the claude provider's
 * calibration for synthesis-heavy work.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 360_000;

/**
 * `--print-timeout` is a wall-clock cap agy applies to the whole print, and
 * it defaults to 5m - shorter than our idle window, so left alone agy always
 * gives up first and the idle watchdog can never fire. Handing agy a
 * generous multiple of our own limit makes the idle watchdog authoritative
 * again: a generation that keeps producing bytes is never cut for taking
 * long, only for going quiet.
 */
const PRINT_TIMEOUT_FACTOR = 4;

/**
 * Told to the model up front, because agy has no flag that removes its
 * tools and its own init advertises ~56 of them. That is a false premise
 * here: headless mode denies every one, and the model that believes it can
 * reach for run_command / list_dir sometimes abandons the turn once denied
 * (measured: two wasted turns and 31k tokens on a request that needed
 * neither tool).
 *
 * Costs ~50 input tokens against a ~15k tool catalog. Measured effect on
 * prompts that carry their own material is small (both forms answered
 * 3 of 3), so this is here to correct the premise, not as a proven speedup.
 */
/** Appended to every failure: the two commands that diagnose most of them. */
const AGY_HINT = '(try: `agy auth login` or `agy --version`)';

const TOOLLESS_NOTE =
  'Everything needed to answer is in this message: respond from its text alone. '
  + 'This session runs without tools.';

export class AntigravityCliProvider extends BaseLLMProvider {
  /** Top-level provider name in registry */
  readonly name = 'antigravity-cli';

  /** Path to binary; default 'agy' resolved via PATH */
  private readonly bin: string;
  private readonly idleTimeoutMs: number;

  /**
   * Working directory for every spawned process, created on first use.
   *
   * agy keeps no per-directory state (verified: a session leaves nothing
   * behind), so unlike the pty providers one directory serves the whole
   * provider instead of one per request. It exists purely to keep the tool
   * layer described above pointed somewhere harmless rather than at
   * whatever directory the server happens to run in - which for a dev
   * checkout is the user's own project, and is listed in agy's
   * trustedWorkspaces besides.
   *
   * Lazy because `LLMObject` constructs providers purely to read their
   * manifests; constructing one must never touch the filesystem.
   */
  private sandbox: string | undefined;

  constructor(config: { bin?: string; idleTimeoutMs?: number } = {}) {
    super({});
    this.bin = config.bin ?? 'agy';
    this.idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
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
   * The model a request runs on. Without this override the base class
   * reports 'default' for an unrouted call, which the ledger then files
   * under a model name that exists nowhere and matches no price entry.
   */
  override resolveModel(options?: LLMCompletionOptions): string {
    return options?.model ?? AUTO_MODEL;
  }

  async complete(messages: LLMMessage[], options?: LLMCompletionOptions): Promise<LLMCompletionResult> {
    const args = this.buildArgs(messages, options);
    return this.withRetries(async () => {
      let textSoFar = '';
      let resultText: string | undefined;
      let usage: LLMCompletionResult['usage'];
      let cliErrorMessage: string | undefined;

      const { code, stdout, stderr } = await runCliIdleStreaming(
        this.bin, args.argv,
        { idleTimeoutMs: this.idleTimeoutMs, stdin: args.stdin, cwd: this.sandboxDir() },
        (line) => {
          const ev = parseAgyLine(line);
          if (!ev) return;
          if (ev.error) cliErrorMessage = ev.error;
          if (ev.delta) textSoFar += ev.delta;
          if (ev.resultText) resultText = ev.resultText;
          // Only the result event's usage is cumulative for the whole call;
          // a step_update reports that step alone, so it is a fallback for
          // a run that ends without a result event rather than a total.
          if (ev.usage && (ev.isResult || !usage)) usage = ev.usage;
        },
      );

      // agy can report {status:'ERROR'} in the result event yet still exit 0.
      if (code !== 0 || cliErrorMessage) {
        throw new Error(formatCliError('agy', code, stderr, stdout, args.argv, cliErrorMessage, AGY_HINT));
      }

      const content = textSoFar || resultText;
      if (!content) {
        // Almost always a denied tool call: agy explains itself in plain
        // text on stderr ("no output produced - a tool required the
        // \"command\" permission..."), which is not JSON and would
        // otherwise be dropped on the floor.
        throw emptyCompletionError('agy', stdout, stderr);
      }

      return {
        content,
        finishReason: 'stop',
        usage,
      };
    }, { isRetryable: agyIsRetryable, label: 'antigravity-cli.complete' });
  }

  async *stream(messages: LLMMessage[], options?: LLMCompletionOptions): AsyncIterable<LLMStreamChunk> {
    const args = this.buildArgs(messages, options);
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
        if (attempt >= maxAttempts) {
          // Retries exhausted on an empty stream: report it as a normal
          // (empty) completion so callers with their own empty-response
          // handling see what they saw before this layer learned to retry.
          if (err instanceof EmptyCompletionError) {
            yield { content: '', done: true, stopReason: err.stopReason };
            return;
          }
          throw err;
        }
        if (!agyIsRetryable(err)) throw err;
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
    const proc = spawn(this.bin, argv, { stdio: ['pipe', 'pipe', 'pipe'], cwd: this.sandboxDir() });
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
    let usage: LLMCompletionResult['usage'];
    let sawDelta = false;
    let resultText: string | undefined;
    let consumedToEnd = false;

    // Same accumulation rules as complete(); see the notes there.
    const absorb = (line: string): string | undefined => {
      const ev = parseAgyLine(line);
      if (!ev) return undefined;
      if (ev.error) cliErrorMessage = ev.error;
      if (ev.usage && (ev.isResult || !usage)) usage = ev.usage;
      if (ev.resultText) resultText = ev.resultText;
      if (ev.delta) { sawDelta = true; return ev.delta; }
      return undefined;
    };

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
          const delta = absorb(line);
          if (delta) yield { content: delta, done: false };
        }
      }
      // The final NDJSON line (usually the 'result' event) may arrive without
      // a trailing newline; without this flush an ERROR status there is lost.
      const tail = buffer.trim();
      if (tail) {
        const delta = absorb(tail);
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
    // agy can report {status:'ERROR'} in the result event yet still exit 0;
    // surfacing it here keeps the caller from treating an empty stream as
    // success.
    if (code !== 0 || cliErrorMessage) {
      throw new Error(formatCliError('agy', code, stderr, allStdout, argv, cliErrorMessage, AGY_HINT));
    }
    // Deltas are authoritative when present; the result event's whole reply
    // is the fallback for a turn that produced no incremental text, which
    // would otherwise be counted a success and yielded to nobody.
    if (!sawDelta) {
      if (!resultText) throw emptyCompletionError('agy', allStdout, stderr);
      yield { content: resultText, done: false };
    }
    // The terminal chunk must carry a stop reason. Without one the consumer
    // cannot tell a complete answer from a stream that died mid-generation,
    // and logs every call as "no finish frame - possible truncation". Usage
    // rides the same chunk, which is the only place the ledger reads it from
    // on the streaming path.
    yield { content: '', done: true, stopReason: 'stop', usage };
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
        installHint: 'One `agy` process per request, reading structured output: reports token '
          + 'usage and returns the reply verbatim. Note agy has no way to disable its own '
          + 'tools, so a request can read the filesystem and run commands its settings allow. '
          + 'Install Antigravity CLI: agy install or https://antigravity.google',
      },
      models: AGY_MODELS,
      defaultTierModels: { smart: AUTO_MODEL, balanced: AUTO_MODEL, fast: AUTO_MODEL, code: AUTO_MODEL },
    };
  }

  /** The sandbox working directory, created on first use. */
  private sandboxDir(): string {
    if (!this.sandbox) this.sandbox = sessionSandboxDir();
    return this.sandbox;
  }

  private buildArgs(
    messages: LLMMessage[],
    options: LLMCompletionOptions | undefined,
  ): { argv: string[]; stdin: string } {
    // `--print=` rather than `-p <prompt>`: print is a string flag, so the
    // bare `-p` form would swallow the next flag as its value (observed:
    // `agy -p --input-format stream-json` runs with "--input-format" as the
    // prompt). An explicit empty value keeps stdin as the prompt channel,
    // which lifts the whole conversation off argv and out of reach of
    // MAX_ARG_STRLEN. Verified with a 168 KB prompt, well past the ~128 KiB
    // single-argument cap on Linux.
    const argv: string[] = [
      '--print=',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--disable-slash-commands',
      '--print-timeout', goDuration(this.idleTimeoutMs * PRINT_TIMEOUT_FACTOR),
    ];

    // Effort-suffixed IDs (see AGY_MODELS) are self-contained; a separate
    // --effort flag is rejected by pro/claude models, so never pass one.
    const model = options?.model;
    if (!shouldOmitModelFlag(model)) {
      argv.push('--model', model!);
    }

    return { argv, stdin: `${JSON.stringify(buildStreamJsonUserMessage(messages))}\n` };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Flatten a conversation into the single turn agy runs per NDJSON message.
 *
 * Image parts are deliberately dropped rather than passed through: agy
 * rejects an image content block outright, which is why every entry in
 * AGY_MODELS reports `vision: false` and image requests are routed to
 * another provider before they reach here.
 */
function buildPrompt(messages: LLMMessage[]): string {
  const { system, transcript } = flattenConversation(messages);
  const instructions = [TOOLLESS_NOTE, system].filter(Boolean).join('\n\n');
  return [`System Instructions: ${instructions}`, transcript].join('\n\n');
}

/** The single NDJSON user message agy reads in stream-json input mode. */
function buildStreamJsonUserMessage(messages: LLMMessage[]): unknown {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: buildPrompt(messages) }] },
  };
}

/** Milliseconds as a Go duration literal, which is what agy's flags parse. */
function goDuration(ms: number): string {
  return `${Math.max(1, Math.ceil(ms / 1000))}s`;
}

/**
 * An empty answer, carrying whatever agy said about why.
 *
 * Empty is nearly always a denied tool call, and agy explains that in plain
 * text on stderr rather than as a stream event, so the raw output goes into
 * the message. Typed as {@link EmptyCompletionError} so the retry loops
 * re-issue the request and, once exhausted, hand callers an empty
 * completion rather than a hard failure.
 */
function emptyCompletionError(bin: string, stdout: string, stderr: string): EmptyCompletionError {
  const detail = stderr.trim() || stdout.trim().slice(0, 300) || 'no output at all';
  return new EmptyCompletionError(`${bin} returned no result: ${detail}`, 'stop');
}

/** Retry classifier: empty completions are worth another attempt. */
function agyIsRetryable(err: unknown): boolean {
  if (err instanceof EmptyCompletionError) return true;
  return cliIsRetryable(err);
}

/** Everything one stream-json line can carry. */
interface AgyEvent {
  /** Incremental visible text. */
  delta?: string;
  /** The result event's whole reply, used when no deltas arrived. */
  resultText?: string;
  usage?: LLMCompletionResult['usage'];
  error?: string;
  /** True for the terminal `result` event, whose usage covers the whole call. */
  isResult: boolean;
}

/**
 * Parse one NDJSON line once and report everything it carries.
 *
 * Single parse on purpose: a streamed reply is one line per delta, and
 * asking four separate extractors meant four `JSON.parse` calls of the same
 * string for every token the model emitted.
 */
function parseAgyLine(line: string): AgyEvent | undefined {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }

  const out: AgyEvent = { isResult: obj.event === 'result' };

  if (obj.event === 'result') {
    const res = obj.result as
      { status?: string; error?: string; response?: string; usage?: AgyUsage } | undefined;
    if (typeof res?.response === 'string' && res.response.length > 0) out.resultText = res.response;
    if (res?.status === 'ERROR' && typeof res.error === 'string') out.error = res.error;
    out.usage = toUsage(res?.usage);
  } else if (obj.event === 'step_update') {
    const step = obj.step_update as { text_delta?: string; usage?: AgyUsage } | undefined;
    if (typeof step?.text_delta === 'string') out.delta = step.text_delta;
    out.usage = toUsage(step?.usage);
  } else if (obj.event === 'error') {
    const err = obj.error as { message?: string } | string | undefined;
    if (typeof err === 'string') out.error = err;
    else if (err && typeof err.message === 'string') out.error = err.message;
  }

  return out;
}

interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  thinking_tokens?: number;
}

function toUsage(u: AgyUsage | undefined): LLMCompletionResult['usage'] | undefined {
  if (!u || typeof u !== 'object') return undefined;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_tokens,
    // agy bills hidden reasoning separately and reports it on every turn.
    reasoningTokens: u.thinking_tokens,
  };
}
