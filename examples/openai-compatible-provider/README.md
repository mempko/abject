# examples/openai-compatible-provider/ - OpenAICompatible, an LLM Provider Package

An LLM provider for any OpenAI-compatible chat endpoint (vLLM, LM Studio, a
llama.cpp server, a company gateway), written as a TypeScript script package.
It registers with the `LLM` object on startup, so its models appear in
Settings → AI beside the built-in providers and go through tier routing,
fallbacks and the ledger like them. It is the worked example for
`docs/LLM_PROVIDERS.md`. No window, so it runs on the desktop and the headless
edition.

## Build and load

```bash
pnpm forge examples/openai-compatible-provider   # compile provider.ts, check it, install
pnpm awaken                                      # it registers on startup
```

Or build in place and load the directory:

```bash
pnpm forge examples/openai-compatible-provider --build-only
ABJECTS_PACKAGE_DIRS=$PWD/examples/openai-compatible-provider pnpm awaken
```

Then:

1. Fill in its settings in Settings → Packages → OpenAICompatible (on the
   headless edition, in `packages.json` under `settings.OpenAICompatible`).
2. If the endpoint is on this machine or a private network, add it under
   Private hosts in Settings → Permissions → Web, for example
   `localhost:8000`. `HttpClient` refuses private and loopback addresses
   otherwise.
3. Pick its models in Settings → AI.

## Settings

| Key | Type | Meaning |
|---|---|---|
| `baseUrl` | string, required | The endpoint's API root, for example `http://localhost:8000/v1`; requests go to `<baseUrl>/chat/completions` |
| `apiKey` | secret | Sent as `Authorization: Bearer <key>` when set |
| `models` | string, required | Model ids, comma separated. The first is the default for the smart, balanced and code tiers; the last for fast |
| `name` | string, default `openai-compatible` | The provider id tier routing and the ledger use |
| `label` | string, default `OpenAI-compatible` | What the provider dropdown shows |

Until `baseUrl` and `models` are set, `startup` returns
`{ registered: false, reason }` and nothing is registered.

## How it works

- **Startup.** The manifest is tagged `autostart`, so WorkspaceManager calls
  `startup` after spawning it. `startup` observes the `Packages` object and
  registers with `LLM` (`registerProvider` with the name, label, models and
  `defaultTierModels`).
- **Settings changes.** As an observer of `Packages` it receives `changed`;
  on `settingsChanged` for its own package it registers again. If the
  provider id changed, it first sends `unregisterProvider` for the old one.
  The name it holds is kept in `_registeredAs`, live state that is not saved.
- **One provider, many copies.** A workspace package spawns in each workspace
  with the default profile; every copy registers the same name and joins the
  same provider (the reply's `backends` counts them), and any of them may
  serve a call.
- **Completions.** `providerComplete` reads the settings, posts the
  conversation through `HttpClient` (`request`, 10-minute timeout), and maps
  both ways: text and images (as data URLs) go out, documents are dropped;
  `maxTokens`, `stopSequences` and `jsonMode` become `max_tokens`, `stop` and
  `response_format`; `finish_reason: length` comes back as `length`, anything
  else as `stop`; `prompt_tokens` / `completion_tokens` become `usage`. A
  non-2xx answer throws with the status and the start of the body, so a
  configured fallback route is tried next.

It does not implement `providerStream` or `providerModels`, and reports no
`costUsd`, so its calls are priced from `setModelPricing` overrides or counted
as unpriced.

## Files

- **provider.ts**: the handler map (`startup`, `changed`, `providerComplete`,
  and the `_settings`, `_register` and `_toOpenAI` helpers).
- **manifest.json**: the manifest, tagged `autostart` and `llm-provider`.
- **abject.json**: package metadata: script runtime, workspace scope, entry,
  manifest path and the five settings.
- `main.js` (not committed): what `--build-only` writes; gitignored.

## Related

- [../README.md](../README.md): all examples and how to load them
- [../../docs/LLM_PROVIDERS.md](../../docs/LLM_PROVIDERS.md): the provider protocol and Private hosts
- [../../sdk/script/README.md](../../sdk/script/README.md): the provider types (`ProviderCompleteRequest`, `RegisterProviderReply`, ...)
- [../tally-ts/README.md](../tally-ts/README.md): a simpler script package with settings
- `src/llm/remote-provider.ts`: how `LLM` turns a registered abject into a provider
