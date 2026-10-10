# sdk/script/ - Script Packages in TypeScript

Types for writing script abjects in TypeScript. A script abject is one
handler-map expression run as a `ScriptableAbject` in the sandbox (a Node
`vm` context with no Node or browser globals); everything outside it is
reached by message through `this`. `pnpm forge` compiles the TypeScript with
esbuild and erases these types, so the package that loads is plain
JavaScript. Nothing here is imported at runtime.

```ts
import type { AbjectHandlers, AbjectMessage } from '../../sdk/script/abject';

interface State { count: number }

({
  async add(msg: AbjectMessage<{ by?: number }>) {
    this.data.count = (this.data.count ?? 0) + (msg.payload.by ?? 1);
    await this.saveData();
    return this.data.count;
  },
}) satisfies AbjectHandlers<State>;
```

## How it works

- `satisfies AbjectHandlers<State>` types `this` inside every method as
  `AbjectThis<State>` plus the map's own members. Pass the map's type as the
  second parameter to check calls between its methods too.
- `AbjectThis` is what the sandbox gives a script abject: `id`, `data`,
  `saveData()`, `call()`, `dep()`, `find()`, `changed()`, `emit()`,
  `observe()`, `ensure()` and `invariant()`. `call` and `emit` accept the
  promise `dep()` returns, so `this.call(this.dep('LLM'), ...)` needs no
  separate `await`.
- **One expression and nothing else.** Helpers and constants go inside the map
  as `_` members (not message handlers). forge refuses top-level declarations,
  runtime `import`/`export`, and a JavaScript entry that starts with a comment.
- **Type-only imports** (`import type`). A runtime import cannot be resolved in
  the sandbox, and forge refuses it.
- **Sandbox globals.** The standard built-ins (`Math`, `JSON`, `Date`, `Map`,
  `Promise`, and so on) plus `setTimeout` / `setInterval`; no `require`,
  `fetch` or `crypto`. HTTP goes through the `HttpClient` abject; secure
  randomness, hashes and HMACs through the `Crypto` abject.
- **`this.data`** is durable and visible to the model through `ask`. Keep
  secrets in package settings (type `secret`) or Storage instead.

## Files

- **abject.d.ts**: all the types.
  - Core: `AbjectId`, `Target`, `AbjectMessage`, `AbjectThis`,
    `AbjectHandlers`.
  - Packages: `PackageSettings` (what `Packages.getSettings` returns to a
    package's own abjects).
  - LLM providers (`docs/LLM_PROVIDERS.md`): `LLMProviderSpec`,
    `RegisterProviderReply`, `LLMModel`, `LLMMessage`, `LLMContentPart`,
    `LLMCallOptions`, `LLMUsage`, `ProviderCompleteRequest` /
    `ProviderCompleteReply`, `ProviderStreamRequest` / `ProviderStreamReply`,
    `ModelTier`, `EffortLevel`.
  - HTTP: `HttpResponse` (the `HttpClient` `request` reply), and `WebRequest`,
    `WebResponse`, `WebCookie` for a handler served in the web gateway's
    `http` mode (`docs/WEB_GATEWAY.md`).

## Related

- [../../examples/tally-ts/README.md](../../examples/tally-ts/README.md): typed handlers, durable data, settings
- [../../examples/openai-compatible-provider/README.md](../../examples/openai-compatible-provider/README.md): an LLM provider package
- [../../docs/PACKAGES.md](../../docs/PACKAGES.md): package format, settings and lifecycle
- [../../docs/LLM_PROVIDERS.md](../../docs/LLM_PROVIDERS.md): the provider protocol
- [../README.md](../README.md): the SDKs
