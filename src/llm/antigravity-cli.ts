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
 * TOOL ACCESS - closed as no-mechanism after investigation (LINC#571,
 * agy 1.1.23). Unlike `claude` (`--tools ""`) there is no way to run `agy`
 * as a plain text generator: no `--safe-mode`/`--config-dir`/tool-strip
 * flag exists, `--sandbox` does not shrink the catalog, and the config
 * paths (`~/.gemini/config/*`, skills included) are hardcoded in the
 * binary. Isolating via a HOME override was considered and REJECTED: agy's
 * OAuth state lives under `~/.gemini/`, and forking it silently forks the
 * credential store (the classic overnight login-freeze failure mode). A
 * custom `--agent` may become an isolation surface once agent definitions
 * are documented. Consequences callers should know about:
 *
 *  1. Every request pays ~24.2k input tokens for a 57-tool catalog Abjects
 *     can never use (measured; capabilities are routed through objects on
 *     the message bus rather than the CLI's own tool layer). The prefill is
 *     never cache-hit across requests either - agy assembles the request,
 *     so the cross-request cache miss is an upstream problem; caching does
 *     work between turns inside one multi-turn call.
 *  2. Headless mode cannot answer a permission prompt, so a gated tool call
 *     is auto-denied - and the model frequently gives up at that point and
 *     returns an empty answer with status SUCCESS. {@link TOOLLESS_NOTE}
 *     tells the model up front not to bother, and an empty result is
 *     surfaced as {@link EmptyCompletionError} rather than as success; the
 *     retry then resamples instantly ({@link agyRetryDelayMs}) since the
 *     abandonment is stochastic, not load-shedding.
 *
 * Denial is not total either - this is confirmed LIVE, not theoretical:
 * bench probes saw headless sessions EXECUTE `run_command` (listing $HOME)
 * and `write_to_file` (writes corralled into agy's per-session
 * `~/.gemini/antigravity-cli/brain/<id>/` scratch) under the user's
 * allow-rules. Treat antigravity-cli as a provider with tool access and
 * run it somewhere harmless. See {@link AntigravityCliProvider.sandbox}.
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
import { discoverModels, peekCachedModels } from './cli-model-discovery.js';
import {
  BaseLLMProvider,
  EmptyCompletionError,
  LLMCompletionOptions,
  LLMCompletionResult,
  LLMMessage,
  LLMProviderDescription,
  LLMStreamChunk,
  ModelInfo,
  ModelTier,
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
const AGY_MODELS = [
  { id: AUTO_MODEL,                 name: 'Auto (recommended)', vision: false },
  { id: 'gemini-3.7-flash-high',    name: 'Gemini 3.7 Flash (High)', vision: false },
  { id: 'gemini-3.7-flash-medium',  name: 'Gemini 3.7 Flash (Medium)', vision: false },
  { id: 'gemini-3.7-flash-low',     name: 'Gemini 3.7 Flash (Low)', vision: false },
  { id: 'gemini-3.6-flash-high',    name: 'Gemini 3.6 Flash (High)', vision: false },
  { id: 'gemini-3.6-flash-medium',  name: 'Gemini 3.6 Flash (Medium)', vision: false },
  { id: 'gemini-3.6-flash-low',     name: 'Gemini 3.6 Flash (Low)', vision: false },
  { id: 'gemini-3.1-pro-high',      name: 'Gemini 3.1 Pro (High)', vision: false },
  { id: 'gemini-3.1-pro-low',       name: 'Gemini 3.1 Pro (Low)', vision: false },
  { id: 'claude-sonnet-4-6',        name: 'Claude Sonnet 4.6 (Thinking)', vision: false },
  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', vision: false },
  { id: 'gpt-oss-120b-medium',      name: 'GPT-OSS 120B (Medium)', vision: false },
] as const satisfies readonly ModelInfo[];

/**
 * Union of the catalog's ids, so a tier default or migration target that
 * names a model not in AGY_MODELS is a compile error, not a runtime
 * surprise on the first live call.
 */
type AgyModelId = (typeof AGY_MODELS)[number]['id'];

/** Cache key for this provider's discovered list. */
const MODEL_DISCOVERY_KEY = 'antigravity-cli';

/**
 * The `auto` sentinel row. It is ours rather than the CLI's, so live
 * discovery prepends it to whatever `agy models` reports.
 */
const AGY_AUTO_ENTRY: ModelInfo = AGY_MODELS[0];

/**
 * Live discovery via `agy models`.
 *
 * Alone among the three CLI providers, this binary does publish its own
 * list - which makes it the most authoritative source of the three: no
 * network call and no third-party catalog, just the installed CLI
 * reporting what it actually accepts. The list above went stale exactly as
 * you would expect a hand-copied one to (it still offered gemini-3.5-*
 * after the CLI had dropped them, and had never heard of gemini-3.8-*).
 *
 * Output is one model per line, `id<TAB>Label`, with no header row and no
 * `auto` row - that sentinel is ours, so it is prepended here.
 */
async function agyModels(bin: string): Promise<ModelInfo[]> {
  const { code, stdout } = await runCliIdle(bin, ['models'], { idleTimeoutMs: 8_000 });
  if (code !== 0) return [];
  const live: ModelInfo[] = [];
  const seen = new Set<string>([AUTO_MODEL]);
  for (const line of stdout.split('\n')) {
    const [rawId, rawLabel] = line.split('\t');
    const id = (rawId ?? '').trim();
    // Blank lines, and anything with whitespace inside the id: a banner or
    // a column header is not a model name.
    if (id.length === 0 || /\s/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const label = (rawLabel ?? '').trim();
    live.push({ id, name: label.length > 0 ? label : id, vision: false });
  }
  return live.length > 0 ? [AGY_AUTO_ENTRY, ...live] : [];
}

function shouldOmitModelFlag(model: string | undefined): boolean {
  return !model || model === AUTO_MODEL;
}

/**
 * Default model per routing tier. Explicit effort-suffixed IDs, never
 * AUTO_MODEL: "auto" resolves server-side to a high thinking budget
 * (measured: gemini-3.7-flash-high behavior), which is a tail-latency
 * amplifier on hard prompts (LINC#571). Explicit suffixes bound thinking
 * per tier; AUTO_MODEL remains user-selectable in AGY_MODELS.
 *
 * code and smart share flash-high DELIBERATELY: there is no higher non-pro
 * rung — the pro models reject --effort and pay pro-grade latency, wrong
 * for a tier default. Kept honest by the `agy models` tripwire test.
 */
export const AGY_TIER_MODELS: Record<ModelTier, AgyModelId> = {
  smart: 'gemini-3.7-flash-high',
  balanced: 'gemini-3.7-flash-medium',
  fast: 'gemini-3.7-flash-low',
  code: 'gemini-3.7-flash-high',
};

/**
 * Retry delay policy (LINC#571): an empty completion is the model
 * stochastically abandoning the turn (denied tool, reasoning-only reply) —
 * not load-shedding — so there is nothing external to wait out and the
 * fix is an instant resample. Everything else keeps the exponential
 * backoff it was handed.
 */
export function agyRetryDelayMs(err: unknown, _attempt: number, defaultDelayMs: number): number {
  return err instanceof EmptyCompletionError ? 0 : defaultDelayMs;
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
   * Tier-routed calls resolve through AGY_TIER_MODELS (mirroring the
   * direct Gemini provider) so a tier never silently rides "auto".
   */
  override resolveModel(options?: LLMCompletionOptions): string {
    if (options?.model) return options.model;
    if (options?.tier) return AGY_TIER_MODELS[options.tier];
    return AUTO_MODEL;
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
    }, { isRetryable: agyIsRetryable, delayMs: agyRetryDelayMs, label: 'antigravity-cli.complete' });
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
        const backoff = Math.min(initialDelayMs * Math.pow(backoffFactor, attempt - 1), maxDelayMs);
        const delay = agyRetryDelayMs(err, attempt, backoff);
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
      // agy ignores an input message whose `event` it does not recognize and
      // says so on stderr, which otherwise surfaces as an empty turn or a
      // timeout further downstream. Name the cause here: a CLI that changed
      // its input vocabulary is a one-line fix, but only once someone can see
      // that is what happened.
      if (/unsupported stream input message event/.test(stderr + allStdout)) {
        throw new Error(
          `agy rejected our input message: it does not recognize the event name we send. ` +
          `This provider speaks the stream-json input format introduced in agy 1.1.15 ` +
          `({"event":"user","message":{...}}); a newer agy has probably renamed it. ` +
          `Check \`agy changelog\` and update buildStreamJsonUserMessage. ` +
          formatCliError('agy', code, stderr, allStdout, argv, cliErrorMessage, AGY_HINT),
        );
      }
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
    return discoverModels(MODEL_DISCOVERY_KEY, [() => agyModels(this.bin)], [...AGY_MODELS]);
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
      // Synchronous, and what the settings panel paints first, so it
      // reports whatever `agy models` has already reported rather than the
      // built-in list.
      models: peekCachedModels(MODEL_DISCOVERY_KEY) ?? [...AGY_MODELS],
      defaultTierModels: AGY_TIER_MODELS,
      // agy sunset the 3.5 flash line (caught live by the models tripwire
      // test); migrate any saved tier routing to the current 3.7 line at
      // the same effort, matching the tier defaults above.
      modelMigrations: {
        'gemini-3.5-flash-high': 'gemini-3.7-flash-high',
        'gemini-3.5-flash-medium': 'gemini-3.7-flash-medium',
        'gemini-3.5-flash-low': 'gemini-3.7-flash-low',
      } satisfies Record<string, AgyModelId>,
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
    // Resolution matches what the ledger reports: explicit model, then the
    // tier default, then auto (no flag).
    const model = this.resolveModel(options);
    if (!shouldOmitModelFlag(model)) {
      argv.push('--model', model);
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

/**
 * The single NDJSON user message agy reads in stream-json input mode.
 *
 * The discriminator is `event`, not the `type` the Claude-style CLIs use.
 * agy decodes `message` first and dispatches on `event` second, so getting
 * the discriminator wrong produced `stream input message is missing the
 * "event" field` rather than anything naming the field it wanted. Confirmed
 * against agy 1.1.15, which is the release that introduced this input mode:
 * `{"event":"user","message":{"role":"user","content":[{"type":"text",...}]}}`
 * runs a turn, and any other event name is ignored with a warning.
 */
function buildStreamJsonUserMessage(messages: LLMMessage[]): unknown {
  return {
    event: 'user',
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
