/**
 * CodexCliProvider - drives the `codex` CLI as an LLM backend, instead of
 * calling the OpenAI HTTP API.
 *
 * Why: lets the user reuse their ChatGPT subscription (via `codex login`)
 * instead of providing an OpenAI API key.
 *
 * Mode: warm interactive sessions. The CLI runs its normal terminal session
 * inside a pseudo-terminal and is reused across requests, with `/new`
 * between them to drop the previous conversation. This removes the ~1.1s
 * process boot that the previous per-request `codex exec` paid every time.
 *
 * Because the session is a terminal UI, the reply is read from the rendered
 * screen. See `pty-session.ts` for what that costs in fidelity, and
 * `pty-dialects.ts` for the patterns that recognise this particular UI.
 *
 * Reports under provider name `'codex-cli'` - its own first-class entry in
 * the provider registry, picked via tier routing in GlobalSettings.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PtySessionPool } from './pty-session.js';
import { codexDialect } from './pty-dialects.js';
import type { CliTransport } from './claude-cli.js';
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
 * Sentinel value for the "Auto" model option - spawn with no `--model` flag
 * and let codex use its configured default. When codex ships a new model,
 * `codex update` moves the default and routes using "Auto" track it with no
 * settings change.
 */
const AUTO_MODEL = 'auto';

function shouldOmitModelFlag(model: string | undefined): boolean {
  return !model || model === AUTO_MODEL;
}

/**
 * How long a session can be entirely silent before we give up on it. Resets
 * on every byte of terminal output, so a long-but-progressing generation
 * keeps running; only a true hang hits it.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 180_000;

/** Warm sessions per model; see the note in claude-cli.ts. */
const DEFAULT_MAX_SESSIONS = 2;

export class CodexCliProvider extends BaseLLMProvider {
  /** See the note on the same field in ClaudeCliProvider. */
  readonly name: string;

  private readonly transport: CliTransport;

  private readonly bin: string;
  private readonly idleTimeoutMs: number;
  private readonly maxSessions: number;

  /**
   * One pool per resolved model, created on first use. Lazy because
   * `LLMObject` constructs providers purely to read their manifests;
   * constructing one must never start a process.
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
    this.name = this.transport === 'terminal' ? 'codex-cli-pty' : 'codex-cli';
    this.bin = config.bin ?? 'codex';
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

  async complete(messages: LLMMessage[], options?: LLMCompletionOptions): Promise<LLMCompletionResult> {
    const model = this.resolveModel(options);

    // Images always take the one-shot path, whatever the configured
    // transport: a pty carries keystrokes, not pictures.
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
   * Yield the reply as a single chunk; see the note on the same method in
   * claude-cli.ts for why a repainted screen cannot produce token deltas.
   */
  async *stream(messages: LLMMessage[], options?: LLMCompletionOptions): AsyncIterable<LLMStreamChunk> {
    const result = await this.complete(messages, options);
    if (result.content.length > 0) yield { content: result.content, done: false };
    // The terminal chunk must carry a stop reason. Without one the consumer
    // cannot tell a complete answer from a stream that died mid-generation,
    // and logs every call as "no finish frame - possible truncation".
    yield { content: '', done: true, stopReason: result.finishReason };
  }

  override resolveModel(options?: LLMCompletionOptions): string {
    return options?.model ?? AUTO_MODEL;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: AUTO_MODEL,         name: 'Auto (recommended)', vision: true },
      { id: 'gpt-5-codex',      name: 'gpt-5-codex (ChatGPT login)', vision: true },
      { id: 'gpt-5-codex-mini', name: 'gpt-5-codex-mini (ChatGPT login)', vision: true },
      { id: 'gpt-5',            name: 'gpt-5 (API key only)', vision: true },
      { id: 'gpt-5-mini',       name: 'gpt-5-mini (API key only)', vision: true },
    ];
  }

  override describe(): LLMProviderDescription {
    const terminal = this.transport === 'terminal';
    return {
      id: this.name,
      label: terminal ? 'Codex CLI (warm terminal session)' : 'Codex CLI',
      storageSuffix: terminal ? 'codexCliPty' : 'codexCli',
      credentialMode: 'cli',
      cli: {
        binary: 'codex',
        installHint: terminal
          ? 'Reuses one warm `codex` session per model. Reports no token usage, reads '
            + 'replies off the rendered screen, and runs in the working directory with '
            + 'codex\'s own tools available, so a request can see the current project. '
            + 'Install Codex: npm install -g @openai/codex'
          : 'One `codex exec` per request, reading structured output: reports token usage '
            + 'and returns the reply verbatim. Install Codex: npm install -g @openai/codex',
      },
      // vision: true because image requests take the one-shot `codex exec
      // -i` transport; the warm terminal session cannot carry an image and
      // complete() routes around it.
      //
      // Codex's accepted model names depend on auth mode. With a ChatGPT
      // account login (`codex login`, the no-API-key path) only the
      // `gpt-5-codex*` variants are accepted - `gpt-5` / `gpt-5-mini` are
      // API-key-only and are rejected with "model is not supported when
      // using Codex with a ChatGPT account". "Auto" sidesteps both by
      // letting the binary choose what is valid for the current auth.
      models: [
        { id: AUTO_MODEL,         name: 'Auto (recommended)', vision: true },
        { id: 'gpt-5-codex',      name: 'gpt-5-codex (ChatGPT login)', vision: true },
        { id: 'gpt-5-codex-mini', name: 'gpt-5-codex-mini (ChatGPT login)', vision: true },
        { id: 'gpt-5',            name: 'gpt-5 (API key only)', vision: true },
        { id: 'gpt-5-mini',       name: 'gpt-5-mini (API key only)', vision: true },
      ],
      defaultTierModels: { smart: AUTO_MODEL, balanced: AUTO_MODEL, fast: AUTO_MODEL, code: AUTO_MODEL },
      // One-time migration: codex with a ChatGPT-account login refuses the
      // API-only `gpt-5` / `gpt-5-mini` model names. Rewrite any saved tier
      // routing that still uses those to 'auto', which works either way.
      modelMigrations: {
        'gpt-5':      AUTO_MODEL,
        'gpt-5-mini': AUTO_MODEL,
      },
    };
  }

  /**
   * One-shot `codex exec --json` call reading structured events.
   *
   * Reports token usage on `turn.completed` and returns the reply verbatim,
   * neither of which the terminal session can do. Images ride the same path
   * as `-i <file>`, written to a scratch directory for the call and removed
   * afterwards, since codex takes paths rather than inline blocks.
   *
   * `--skip-git-repo-check` because a scratch directory is not a trusted
   * work tree, which the interactive session has no way around.
   */
  private async completeOneShot(messages: LLMMessage[], model: string): Promise<LLMCompletionResult> {
    const dir = mkdtempSync(join(tmpdir(), 'abjects-codex-img-'));
    const paths: string[] = [];
    try {
      for (const msg of messages) {
        if (!Array.isArray(msg.content)) continue;
        for (const part of msg.content) {
          if (part.type !== 'image') continue;
          const ext = part.mediaType.split('/')[1] ?? 'png';
          const file = join(dir, `image-${paths.length}.${ext}`);
          writeFileSync(file, Buffer.from(part.data, 'base64'));
          paths.push(file);
        }
      }

      const argv = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only'];
      for (const file of paths) argv.push('-i', file);
      if (!shouldOmitModelFlag(model)) argv.push('--model', model);
      argv.push('-');   // prompt arrives on stdin, avoiding argv length limits

      const prompt = buildPrompt(messages);
      return await this.withRetries(async () => {
        const { code, stdout, stderr } = await runCliIdle(
          this.bin, argv, { idleTimeoutMs: this.idleTimeoutMs }, prompt, dir,
        );
        if (code !== 0) {
          throw new Error(`codex exec exited ${code} | stderr=${stderr.trim().slice(0, 400)}`);
        }
        const final = extractCodexFinalMessage(stdout);
        if (!final) {
          throw new Error(`codex returned no message. raw=${stdout.slice(0, 300)}`);
        }
        return { content: final.text, finishReason: 'stop' as const, usage: final.usage };
      }, { isRetryable: cliIsRetryable, label: `${this.name}.complete` });
    } finally {
      // The images are the user's content; do not leave them on disk.
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Kill every warm session; called when LLMObject stops. */
  async shutdown(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(pools.map(p => p.close()));
  }

  private poolFor(model: string): PtySessionPool {
    let pool = this.pools.get(model);
    if (!pool) {
      // Append to the dialect's argv rather than replacing it: that argv
      // carries the sandbox and approval-policy flags.
      const argv = shouldOmitModelFlag(model)
        ? [...codexDialect.argv]
        : [...codexDialect.argv, '--model', model];
      pool = new PtySessionPool(
        { ...codexDialect, bin: this.bin, argv },
        {
          idleTimeoutMs: this.idleTimeoutMs,
          maxSessions: this.maxSessions,
          // Codex runs in the process's own working directory, unlike the
          // claude provider which gets an empty per-session sandbox.
          //
          // Not a preference: codex only starts in a directory its config
          // records as trusted, and exits immediately (code 0, no output)
          // in a fresh one. A git repo is not enough, with or without a
          // commit; verified by running the same session in the project
          // directory (works) and a fresh sandbox (exits every time).
          //
          // This matches what this provider did before it moved to a warm
          // session, so it is not a regression, but combined with codex's
          // tool access (see CODEX_HARDENING in pty-dialects.ts) it does
          // mean a codex session can read the project it runs in.
          cwd: process.cwd(),
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
 * accepts as one turn. Codex has no system-prompt concept in its UI, so
 * system messages become a leading delimited block.
 */
function buildPrompt(messages: LLMMessage[]): string {
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
  return parts.join('\n\n');
}

interface CliResult { code: number; stdout: string; stderr: string; }

/**
 * Spawn a CLI without a terminal and return its output when it closes.
 * Only used for one-shot checks like `--version`; the request path goes
 * through the pty pool.
 */
function runCliIdle(
  bin: string, argv: string[],
  opts: { idleTimeoutMs: number },
  stdin = '',
  cwd?: string,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, argv, { stdio: ['pipe', 'pipe', 'pipe'], cwd });
    let stdout = '';
    let stderr = '';
    let killed = false;

    let idleTimer: ReturnType<typeof setTimeout>;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        killed = true;
        try { proc.kill('SIGTERM'); } catch { /* already gone */ }
        reject(new Error(`${bin} idle for ${opts.idleTimeoutMs}ms - no output, subprocess killed`));
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
    proc.stdin.end(stdin);
  });
}

/** True when any message carries an image part. */
function hasImages(messages: LLMMessage[]): boolean {
  return messages.some(m =>
    Array.isArray(m.content) && m.content.some(p => p.type === 'image'));
}

interface CodexFinalMessage {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Walk codex's NDJSON output and accumulate the assistant's final message.
 *
 * `codex exec --json` emits whole events rather than token deltas:
 * `item.completed` with `item.type === 'agent_message'` carries the reply
 * (possibly more than once across a turn, so they concatenate in order),
 * and `turn.completed` carries token accounting. Reasoning items are
 * deliberately dropped; only agent_message is user-visible.
 */
function extractCodexFinalMessage(raw: string): CodexFinalMessage | null {
  let text = '';
  let usage: CodexFinalMessage['usage'];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(trimmed); } catch { continue; }

    if (obj.type === 'item.completed') {
      const item = (obj as { item?: { type?: string; text?: string } }).item;
      if (item?.type === 'agent_message' && typeof item.text === 'string') text += item.text;
    } else if (obj.type === 'turn.completed') {
      const u = (obj as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
      if (u) usage = { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 };
    }
  }

  const finalText = text.trim();
  return finalText ? { text: finalText, usage } : null;
}
