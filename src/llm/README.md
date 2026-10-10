# src/llm/ - LLM Providers and Model Plumbing

The model backends the `LLM` object routes to, and the pure helpers around
them. Nothing here is an Abject: these are plain classes and functions that
`LLMObject` (`src/objects/llm-object.ts`, registered as `LLM`) constructs and
calls. Every other abject reaches a model only by messaging `LLM`
(`complete`, `stream`, `compress`, `decide`, `transcribe`, ...); tier routing,
fallbacks, the call ledger, spend, prompt-cache keepalive and goal budgets all
live in `LLMObject`, not in this directory.

## Architecture

```
  caller abject
      │  complete / stream / decide (messages)
      ▼
  LLMObject  (src/objects/llm-object.ts, worker-eligible)
      │  tier routing + fallbacks, ledger + pricing, cache keepalive,
      │  execution context (execution-context.ts) on every request
      ▼
  LLMProvider interface (provider.ts)
      ├── HTTP API providers ─── anthropic, openai, google-gemini, ollama,
      │                          OpenAI-compatible subclasses (openrouter,
      │                          deepseek, grok, kimi, minimax, meta, peerllm)
      ├── CLI-agent providers ── claude-cli / claude-cli-pty, codex-cli /
      │                          codex-cli-pty, antigravity-cli (child processes)
      └── RemoteLLMProvider ──── an abject, by message (providerComplete /
                                 providerStream / providerModels)

  DecisionProvider (decision.ts) ─ typesafe, openrouter; with none configured
                                   (or when it fails), decision-emulator.ts
                                   answers on a chat model
```

`LLMObject.configure()` registers providers. The CLI providers are always
registered (each reports availability by running its binary with
`--version`); API-key providers are registered only when a credential is
present; Ollama is registered when its URL is configured or when it answers at
`http://localhost:11434`. `LLMObject.PROVIDER_DESCRIPTORS` holds a
credential-less stub of every built-in provider, used only to read
`describe()` for Settings → AI, so constructing a provider must never start a
process or touch the disk.

Credentials come from SettingsManager (stored under each description's
`storageSuffix`) and, at boot, from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and
`TYPESAFE_API_KEY`.

## Files

### Core contract and shared helpers

- **`provider.ts`**: the `LLMProvider` interface and `BaseLLMProvider`. Message
  types (`LLMMessage` with text, image and PDF `ContentPart`s and an optional
  `cacheBreakpoint`), `LLMCompletionOptions` (`tier`, `model`, `effort`,
  `maxTokens`, `cacheKey`, `jsonMode`, ...), `ModelTier`
  (`smart | balanced | fast | code`), `EffortLevel`, `ModelInfo`,
  `LLMProviderDescription` (what Settings renders: credential mode, default
  tier models, `tierRules`, `capabilities`, `modelMigrations`), `CacheProfile`
  (TTL and read/write price ratios that drive keepalive). Also `withRetries`
  with `defaultIsRetryable` / `cliIsRetryable`, `EmptyCompletionError`,
  `NativeToolAbandonedError`, `ContextOverflowError` (marker
  `CONTEXT_OVERFLOW` survives the bus as text), and the conversation budget
  helpers (`enforceConversationCharBudget`, `anchoredConversationChars`,
  `promptTokensOf`, `truncateText`). LLMObject keeps the provider map.
- **`execution-context.ts`**: the text every request carries.
  `withExecutionContext()` prepends `ABJECT_EXECUTION_CONTEXT` (actions travel
  as Abject messages), adds `NATIVE_PROVIDER_CONTEXT` for providers whose
  `executionContext().nativeAccess` is not `none`, and applies a provider's
  versioned `promptGuidance()` prefix and suffix without mutating the
  caller's messages. `executionProvenance()` records provider, model,
  transport and guidance version on each result.
- **`tier-resolver.ts`**: pure functions over (description, catalog).
  `resolveTier()` picks a tier's model from a live catalog by `TierRule`
  (moving alias first, else newest of a family, else the pinned default).
  `LATEST_MODEL` (`'latest'`) is the routing value that re-resolves every
  time. `aliasLadders()` turns a catalog of per-line moving aliases
  (OpenRouter's `~vendor/line-latest`) into one price-ranked tier ladder per
  vendor. `freezeModel()` turns `latest` into today's model when a preset is
  saved. SettingsManager builds the built-in and saved tier presets from
  these.
- **`pricing.ts`**: list prices in USD per million tokens, keyed
  `provider/model-prefix` with longest-prefix match. A provider-reported cost
  (OpenRouter `usage.cost`) always wins; otherwise `estimateCostUsd()` applies
  this table. Only verified rate cards are listed; anything else is left
  unpriced rather than guessed. Ollama and the CLI providers are priced at 0.
  User overrides (`setModelPricing` on `LLM`) beat the table.

### HTTP API providers

Each has per-tier defaults (`TIER_MODELS` or `DEFAULT_TIER_MODELS` as the
offline fallback, `TIER_RULES` for picking from the live catalog) and its own
reasoning knobs. LLMObject constructs them in `configure()` from the
credentials it is given (Settings, or the API-key environment variables at boot).

- **`anthropic.ts`**: Messages API. All system messages become system blocks;
  cache breakpoints follow the caller's `cacheBreakpoint` markers. Per-model
  thinking profile (adaptive opt-in, adaptive default, manual budget, none),
  per-tier effort and `max_tokens`, with a 16k floor whenever thinking is
  active. `effort: 'none'` is the no-thinking contract used for utility and
  keepalive calls. Thinking or large outputs complete through the streaming
  path.
- **`openai.ts`**: Chat Completions. The base class for every OpenAI-compatible
  provider: subclasses override `reasoningProfile()`, `applyReasoning()`,
  `modelVision()`, `cacheProfile()` and `describe()`. Sends
  `prompt_cache_key` from `cacheKey`, nets cached tokens out of
  `inputTokens`, routes large output caps to streaming, and applies a 60s
  idle and 10 minute overall stream timeout. First-party OpenAI only also
  serves `transcribe` / `synthesize`.
- **`openrouter.ts`**: OpenAI-compatible gateway (`https://openrouter.ai/api`)
  with attribution headers, the unified `reasoning: { effort }` field,
  optional per-model reasoning overrides and `provider` routing preferences,
  and `usage: { include: true }` so each call reports its real cost. Its tier
  rules use moving aliases plus `aliasLadders`. Also a `DecisionProvider`
  (System One endpoint `/v1/systemone`).
- **`deepseek.ts`**, **`grok.ts`**, **`kimi.ts`**, **`minimax.ts`**, **`meta.ts`**,
  **`peerllm.ts`**: thin `OpenAIProvider` subclasses (base URL, tier models,
  which models reason or accept `reasoning_effort`, output ceilings, live
  `/models` listing). PeerLLM also trims requests to the fields its API
  documents.
- **`google-gemini.ts`**: Gemini's own schema (`systemInstruction`, role
  `model`, `parts`), effort mapped to `thinkingLevel`, generous per-tier
  `maxOutputTokens` because thinking counts against it. Supports
  `transcribe` (not `synthesize`).
- **`ollama.ts`**: local models, credential is a URL (default
  `http://localhost:11434`). `autoDetectModel()` picks the first installed
  model, `listModels()` reads `/api/tags` and each model's context window from
  `/api/show`, `jsonMode` becomes Ollama's `format: 'json'`, NDJSON streaming.

### Abject-backed providers

- **`remote-provider.ts`**: `RemoteLLMProvider`, the adapter for a provider
  implemented by another abject. The abject sends `registerProvider` to `LLM`
  (validated by `parseRemoteProviderSpec`: name, label, models,
  `defaultTierModels`, `streaming`, `liveModels`, `timeoutMs`); calls then
  arrive at the abject as `providerComplete`, `providerStream` (chunks come
  back as `providerChunk` events) and `providerModels`. Several abjects of
  one installed package may back one name; calls go to the first live
  backend. Protocol: [`docs/LLM_PROVIDERS.md`](../../docs/LLM_PROVIDERS.md).

### CLI-agent providers

These drive a coding-agent binary the user has already logged in to, so a
subscription can stand in for an API key. Each binary runs with its own
tools disabled or fenced off, in a scratch working directory rather than the
server's, and is told by `execution-context.ts` that actions go through
Abject messages.

- **`claude-cli.ts`**: `ClaudeCliProvider`, registered twice:
  `claude-cli` (one-shot `claude -p` with stream-json in and out, reports
  token usage) and `claude-cli-pty` (warm interactive sessions in a
  pseudo-terminal, faster start, no usage figures, reply read off the
  screen). Image requests always take the one-shot path. Model list from the
  Anthropic API (when `ANTHROPIC_API_KEY` is set), then the public OpenRouter
  catalog, then a built-in list; `isDrivableClaudeModel()` drops ids the
  binary refuses.
- **`codex-cli.ts`**: `CodexCliProvider`, registered as `codex-cli` and
  `codex-cli-pty`. Both run the same structured one-shot `codex exec --json`
  in a temporary directory that is removed afterwards; the `-pty` entry is
  kept as a legacy setting. `extractCodexFinalMessage()` parses the result.
- **`codex-execution.ts`**: the fixed `codex exec` arguments (no approvals, no
  web search, read-only minimal filesystem, no network, no MCP, many features
  disabled, Abject guidance as `developer_instructions`) and
  `checkCodexEvent()`, which aborts the run with `PROVIDER_BOUNDARY:` on the
  first native command, file change or tool call.
- **`antigravity-cli.ts`**: `AntigravityCliProvider` (`antigravity-cli`), the
  `agy` binary in one-shot print mode with stream-json output. `agy` cannot
  shed its tool catalog, so the provider reports `nativeAccess: 'available'`,
  runs in a sandbox directory, adds prompt guidance, and surfaces an empty
  answer after a denied tool as `NativeToolAbandonedError` (retried
  immediately by `agyRetryDelayMs`). Tier defaults are explicit
  effort-suffixed ids (`AGY_TIER_MODELS`); `agy models` supplies the list.
- **`cli-process.ts`**: shared subprocess plumbing: `runCliIdle` /
  `runCliIdleStreaming` (kill on silence, not on duration; children are
  tracked so shutdown can signal them), `killProc` (SIGTERM then SIGKILL),
  `formatCliError`, `flattenConversation`, `hasImages`.
- **`cli-model-discovery.ts`**: `discoverModels()` tries live sources in
  order, caches a live answer for an hour and a fallback for 30s, and dedupes
  concurrent requests; `peekCachedModels()` lets the synchronous
  `describe()` paint the cached list; `openRouterCatalog()` reads the public
  OpenRouter catalog (no key needed).
- **`pty-session.ts`**: `PtySession` (one warm CLI in a pseudo-terminal from
  `@lydell/node-pty`, screen kept by `@xterm/headless`, both loaded by dynamic
  import on first use) and `PtySessionPool` (leases one session per request;
  defaults: 2 sessions, recycled after 50 turns, evicted after 10 idle
  minutes). Also `scrubAgentEnv()`, and `sessionSandboxDir()` /
  `removeSandboxDir()` for the empty working directory each CLI process runs
  in.
- **`pty-dialects.ts`**: everything that recognises a particular terminal UI.
  Only `claudeDialect` exists (ready, busy and turn-complete patterns, trust
  dialog dismissal, chrome filtering, hardening flags
  `--tools "" --strict-mcp-config --permission-mode dontAsk --safe-mode`).

### Decision models

- **`decision.ts`**: the typed-question contract shared by decision models and
  the emulator: `DecisionRequest` (a `state` plus `choice`, `noul` (yes/no
  probability) and `score` questions), `DecisionResult` (flags `emulated` and
  `calibrated`), `DecisionProvider`, `DECISION_LIMITS`,
  `validateDecisionRequest`, and readers (`choiceOf`, `noulOf`, `scoreOf`,
  `summarizeAnswers`).
- **`typesafe.ts`**: `TypeSafeProvider` (decision-only, `capabilities:
  { chat: false, decide: true }`) and `callSystemOne()`, the System One wire
  client OpenRouter reuses.
- **`decision-emulator.ts`**: `emulateDecision()` answers the same questions
  on a chat model through an `EmulationTransport` that LLMObject supplies:
  one probability line per question, a tolerant parser, a repair turn for
  missing answers, one retry on a stronger tier, and a partial result that
  names what is `missing`.

### Tests

Run with `pnpm test` (Node test runner over `src/llm/*.test.ts` among others).

- **`anthropic.sampling.test.ts`**: `complete` and `stream` never send
  `temperature`, even when a caller's options still carry it.
- **`antigravity-cli.test.ts`**: a stand-in `agy` that denies a tool; checks
  `NativeToolAbandonedError` and the provenance it carries.
- **`execution-context.test.ts`**: Codex parsing and arguments, boundary
  enforcement, execution context and prompt guidance on real LLMObject calls.
- **`peerllm.test.ts`**: PeerLLM description, model listing, request shape,
  pricing, and conditional registration.

## Adding a Provider

Prefer an abject-backed provider: a script package (usually tagged
`autostart`) that sends `registerProvider` to `LLM` needs no change here. See
[`docs/LLM_PROVIDERS.md`](../../docs/LLM_PROVIDERS.md) and
`examples/openai-compatible-provider`.

A built-in provider:

1. Create `src/llm/<name>.ts`. For an OpenAI-compatible API, extend
   `OpenAIProvider` and pass `baseUrl` and `tierModels`; otherwise extend
   `BaseLLMProvider`.
2. Implement `complete()` and `stream()` (the terminal chunk carries
   `stopReason` and `usage`), `resolveModel()`, `listModels()` and
   `describe()` (unique `id`, `storageSuffix`, `credentialMode`,
   `defaultTierModels`, ideally `tierRules`). Override `supportedEfforts()`
   and `cacheProfile()` where the API supports them.
3. Throw `ContextOverflowError` for length rejections
   (`isContextOverflowMessage()` recognises the common wording) and
   `EmptyCompletionError` for an empty answer, so callers can recover.
4. Register it in `LLMObject.configure()` (the `apiKeyFactories` list for an
   API key) and add a stub to `LLMObject.PROVIDER_DESCRIPTORS`, which also
   reserves the name against abject-backed providers. Settings → AI picks it
   up from `listProviderDescriptions`.
5. Add a `pricing.ts` entry only for a verified rate card, and export the
   class from `src/index.ts`.

## Gotchas

- **Built-in providers do not go through HttpClient.** They call the
  endpoints configured in Settings > AI with the global `fetch` (streaming or
  not), so HttpClient's web rules (the master switch, allowed and denied
  domains, private hosts) do not apply to them: those rules govern what
  abjects may reach. Abject-backed providers are abjects, so theirs do.
  `BaseLLMProvider` still accepts a `fetchFn` delegate (tests use it).
- **Reasoning shares the output cap.** Thinking and reasoning tokens count
  against `max_tokens`, so the providers size caps per tier and raise them
  when thinking is on. Changing a tier's cap can make answers come back empty
  or truncated (`finishReason: 'length'`).
- **`describe()` must stay cheap and side-effect free.** It is called on stub
  instances, and descriptions cross worker boundaries by structured clone, so
  they hold data only (rules are RegExp source strings, migrations are maps).
- **The PTY transport scrapes a rendering.** `claude-cli-pty` can lose a
  newline when a line exactly fills the UI's width, reports no token usage,
  and depends on patterns in `pty-dialects.ts` that a Claude Code release can
  break. Use `claude-cli` when byte-exact output or usage matters.
- **`@lydell/node-pty` is native.** It loads a platform package by name at
  runtime, so the server bundle keeps it external (`build-server.mjs`) and
  installs ship it as a runtime dependency (`scripts/package-headless.mjs`).
  It is imported only when a PTY session first starts.
- **Sandbox directories are per process run.** `sessionSandboxDir()` makes
  `$TMPDIR/abjects-cli-sessions/s<pid>-<random>` (with `git init`); a PTY
  session removes its own on dispose and the one-shot `claude-cli` path
  removes each request's when it returns. `antigravity-cli` keeps one per
  provider for the life of the process. What a process leaves behind when it
  dies is swept by the first `sessionSandboxDir()` call of a later process,
  which removes every `s<pid>-*` whose pid is gone.
- **Retry classifiers decide what is permanent.** `defaultIsRetryable` treats
  401/403/404, bad requests, unknown models and missing binaries as permanent
  and retries 408/429. `cliIsRetryable` never retries `PROVIDER_BOUNDARY:`
  errors.
- **Model ids go stale.** Pinned tier defaults are only the offline fallback;
  routing set to `latest` follows `tierRules`. A saved preset freezes `latest`
  to a concrete id but keeps a catalog's own moving alias as an alias.

## Related

- [`../objects/README.md`](../objects/README.md): `LLMObject`, `SettingsManager`,
  `GlobalSettings`, `LLMMonitor`
- [`../../docs/LLM_PROVIDERS.md`](../../docs/LLM_PROVIDERS.md): the abject-backed provider protocol
- [`../../docs/PACKAGES.md`](../../docs/PACKAGES.md): shipping a provider as a package
