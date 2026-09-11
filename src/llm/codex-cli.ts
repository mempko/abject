/**
 * CodexCliProvider - drives the `codex` CLI as an LLM backend, instead of
 * calling the OpenAI HTTP API.
 *
 * Why: lets the user reuse their ChatGPT subscription (via `codex login`)
 * instead of providing an OpenAI API key.
 *
 * Mode: structured one-shot sessions. Both saved transport choices use this
 * path so provider-native activity is inspectable and the same permissions apply.
 * The temporary workspace contains only request attachments.
 *
 * Reports under provider name `'codex-cli'` - its own first-class entry in
 * the provider registry, picked via tier routing in GlobalSettings.
 */

import type { PromptGuidance } from './execution-context.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flattenConversation, runCliIdle } from './cli-process.js';
import { codexExecutionArgs, checkCodexEvent } from './codex-execution.js';
import {
  discoverModels,
  fetchJsonWithTimeout,
  openRouterCatalog,
  peekCachedModels,
} from './cli-model-discovery.js';
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
} from './provider.js';

/**
 * Sentinel value for the "Auto" model option - spawn with no `--model` flag
 * and let codex use its configured default. When codex ships a new model,
 * `codex update` moves the default and routes using "Auto" track it with no
 * settings change.
 */
const AUTO_MODEL = 'auto';

/** Cache key for this provider's discovered list. */
const MODEL_DISCOVERY_KEY = 'codex-cli';

const AUTO_ENTRY: ModelInfo = { id: AUTO_MODEL, name: 'Auto (recommended)', vision: true };

/** Offered when the catalog is unreachable; also merged in behind it. */
const KNOWN_CODEX_MODELS: ModelInfo[] = [
  { id: 'gpt-5-codex',      name: 'gpt-5-codex (ChatGPT login)', vision: true },
  { id: 'gpt-5-codex-mini', name: 'gpt-5-codex-mini (ChatGPT login)', vision: true },
  { id: 'gpt-5',            name: 'gpt-5 (API key only)', vision: true },
  { id: 'gpt-5-mini',       name: 'gpt-5-mini (API key only)', vision: true },
];

const FALLBACK_MODELS: ModelInfo[] = [AUTO_ENTRY, ...KNOWN_CODEX_MODELS];

/**
 * Substrings that mark an id as something `codex` cannot be pointed at.
 *
 * OpenAI publishes one catalog across every modality, so the same `openai/`
 * prefix that carries gpt-5.6 also carries image, audio and chat-tuned
 * entries. Codex drives a terminal coding agent; pointing it at one of
 * these fails at request time, and an option that cannot work is worse than
 * an option that is missing. `-image`, `-audio` and `-chat` are in the
 * catalog today (gpt-5-image, gpt-audio-mini, gpt-5.2-chat); the rest are
 * the other modality suffixes OpenAI ships under, named here so a new one
 * does not have to reach a user's dropdown before anybody notices.
 */
const NON_DRIVABLE_MARKERS = [
  '-image', '-audio', '-chat', '-tts', '-realtime', '-transcribe', '-search',
];

/**
 * The oldest generation worth offering. Codex is a coding agent: the gpt-4,
 * o-series and gpt-oss rows in the catalog all predate it, and listing every
 * model OpenAI ever shipped is how a picker becomes unusable.
 */
const MIN_DRIVABLE_MAJOR = 5;

/**
 * Whether the binary can be pointed at this id.
 *
 * The rule used to be `id.includes('codex')`, which is exactly why the
 * picker could not show gpt-5.6: that generation ships as gpt-5.6-luna,
 * -sol and -terra (plus their -pro forms) and carries no 'codex' anywhere
 * in the name, so a filter keyed on the word excluded the newest models by
 * construction. So the rule is the family rather than the word - every
 * gpt-5-or-later id, minus the modality variants above - with codex-tuned
 * ids allowed outright so they survive whatever the numbering does next.
 * Matching on a parsed major version rather than a literal prefix is what
 * keeps the next generation from needing an edit here to become visible.
 *
 * Dots are kept, unlike the Anthropic ids in claude-cli.ts:
 * 'gpt-5.1-codex-max' is the form the binary accepts.
 */
export function isDrivableCodexModel(id: string): boolean {
  if (NON_DRIVABLE_MARKERS.some((marker) => id.includes(marker))) return false;
  if (id.includes('codex')) return true;
  const generation = /^gpt-(\d+)(?:\.\d+)?(?:-|$)/.exec(id);
  return generation !== null && Number(generation[1]) >= MIN_DRIVABLE_MAJOR;
}

/** Auto first, the live catalog next, the built-in names last. */
function withKnownModels(live: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>([AUTO_ENTRY.id]);
  const out: ModelInfo[] = [AUTO_ENTRY];
  for (const model of [...live, ...KNOWN_CODEX_MODELS]) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

/**
 * Tier 1: OpenAI's own catalog. Authoritative, but it needs a key and this
 * provider authenticates through the binary (`codex login`), so most users
 * have none for us to borrow. An absent key is a silent skip, not an error.
 *
 * Sorted newest-first to match the order the OpenRouter tier already
 * arrives in: the picker is read top-down, and the newest generation is
 * what somebody opening it is looking for.
 */
async function openAiApiModels(): Promise<ModelInfo[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return [];
  const body = await fetchJsonWithTimeout('https://api.openai.com/v1/models', {
    Authorization: `Bearer ${key}`,
  }) as { data?: unknown };
  const rows = Array.isArray(body?.data) ? body.data as Array<Record<string, unknown>> : [];
  const drivable = rows.filter((row) => typeof row.id === 'string' && isDrivableCodexModel(row.id));
  drivable.sort((a, b) => Number(b.created ?? 0) - Number(a.created ?? 0));
  const live: ModelInfo[] = drivable.map((row) => ({
    id: row.id as string,
    name: row.id as string,
    vision: true,
  }));
  return live.length > 0 ? withKnownModels(live) : [];
}

/**
 * Tier 2: the public OpenRouter catalog. Needs no key, so in practice this
 * is the tier that fires and the one that puts gpt-5.6 on screen.
 *
 * Codex refreshes its own list from an endpoint it does not expose, and
 * that endpoint needs the ChatGPT session token, so this is what is
 * actually reachable without one. OpenRouter returns newest-first, which is
 * the order the picker wants, so it is preserved rather than re-sorted.
 */
async function openRouterCodexModels(): Promise<ModelInfo[]> {
  const entries = await openRouterCatalog('openai/');
  const live: ModelInfo[] = [];
  for (const entry of entries) {
    if (!isDrivableCodexModel(entry.id)) continue;
    live.push({ id: entry.id, name: entry.name, vision: true });
  }
  return live.length > 0 ? withKnownModels(live) : [];
}

function shouldOmitModelFlag(model: string | undefined): boolean {
  return !model || model === AUTO_MODEL;
}

/**
 * How long a session can be entirely silent before we give up on it. Resets
 * on every byte of terminal output, so a long-but-progressing generation
 * keeps running; only a true hang hits it.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 180_000;

export class CodexCliProvider extends BaseLLMProvider {
  /** See the note on the same field in ClaudeCliProvider. */
  readonly name: string;

  private readonly transport: CliTransport;

  private readonly bin: string;
  private readonly idleTimeoutMs: number;

  executionContext() { return { transport: 'stream-json', nativeAccess: 'restricted' as const }; }
  /**
   * Codex takes its guidance as `developer_instructions` on the command line
   * (see codex-execution.ts), not as prompt text, so there is nothing to
   * prepend or append; the version still names what the model was told.
   */
  promptGuidance(): PromptGuidance { return { version: 'codex-developer-instructions-v1' }; }

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

    // The terminal alias uses the same enforceable, inspectable transport.
    return this.completeOneShot(messages, model);
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
    return discoverModels(
      MODEL_DISCOVERY_KEY,
      [openAiApiModels, openRouterCodexModels],
      FALLBACK_MODELS,
    );
  }

  override describe(): LLMProviderDescription {
    const terminal = this.transport === 'terminal';
    return {
      id: this.name,
      label: terminal ? 'Codex CLI (legacy terminal setting)' : 'Codex CLI',
      storageSuffix: terminal ? 'codexCliPty' : 'codexCli',
      credentialMode: 'cli',
      cli: {
        binary: 'codex',
        installHint: 'Runs structured Codex requests with restricted native access and Abject message guidance. '
          + 'Install Codex: npm install -g @openai/codex',
      },
      // Image attachments are staged in the per-request workspace.
      // Codex's accepted model names depend on auth mode. With a ChatGPT
      // account login (`codex login`, the no-API-key path) only the
      // `gpt-5-codex*` variants are accepted - `gpt-5` / `gpt-5-mini` are
      // API-key-only and are rejected with "model is not supported when
      // using Codex with a ChatGPT account". "Auto" sidesteps both by
      // letting the binary choose what is valid for the current auth.
      // Synchronous, and what the settings panel paints first, so it
      // reports whatever discovery has already found rather than always
      // seeding the panel with the built-in names above.
      models: peekCachedModels(MODEL_DISCOVERY_KEY) ?? FALLBACK_MODELS,
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

      const argv = codexExecutionArgs();
      for (const file of paths) argv.push('-i', file);
      if (!shouldOmitModelFlag(model)) argv.push('--model', model);
      argv.push('-');   // prompt arrives on stdin, avoiding argv length limits

      const prompt = buildPrompt(messages);
      return await this.withRetries(async () => {
        const { code, stdout, stderr } = await runCliIdle(
          this.bin, argv, { idleTimeoutMs: this.idleTimeoutMs, stdin: prompt, cwd: dir, validateLine: checkCodexEvent },
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

  async shutdown(): Promise<void> { /* one-shot processes are owned by each request */ }
}


function buildPrompt(messages: LLMMessage[]): string {
  const { system, transcript } = flattenConversation(messages);
  const parts: string[] = [];
  if (system) parts.push(`[Instructions]\n${system}\n[/Instructions]`);
  parts.push(transcript);
  return parts.join('\n\n');
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
 * (the last completed assistant message is the final response),
 * and `turn.completed` carries token accounting. Reasoning items are
 * deliberately dropped; only agent_message is user-visible.
 */
export function extractCodexFinalMessage(raw: string): CodexFinalMessage | null {
  let text = '';
  let completed = false;
  let usage: CodexFinalMessage['usage'];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(trimmed); } catch { continue; }

    checkCodexEvent(trimmed);
    if (obj.type === 'turn.failed' || obj.type === 'error') {
      throw new Error('Codex reported a failed generation; no Abject action was accepted.');
    }
    if (obj.type === 'item.completed') {
      const item = (obj as { item?: { type?: string; text?: string } }).item;
      if (item?.type === 'agent_message' && typeof item.text === 'string') text = item.text;
    } else if (obj.type === 'turn.completed') {
      completed = true;
      const u = (obj as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
      if (u) usage = { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 };
    }
  }

  const finalText = text.trim();
  return completed && finalText ? { text: finalText, usage } : null;
}
