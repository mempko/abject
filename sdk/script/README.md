# sdk/script/ - Script Packages in TypeScript

Types for writing script abjects in TypeScript. A script abject is one
handler-map expression run as a ScriptableAbject in the sandbox (no Node or
browser globals; everything by message). `pnpm forge` compiles the TypeScript
with esbuild and erases these types, so the installed package is plain
JavaScript.

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

- `satisfies AbjectHandlers<State>` types `this` inside every method as
  `AbjectThis<State>` plus the map's own members. Pass the map's type as the
  second parameter to check calls between its methods too.
- Import types only (`import type`). A runtime import cannot be resolved in the
  sandbox, and forge refuses it.
- `PackageSettings<V>` types what `Packages.getSettings` returns to a
  package's own abjects.
- **A script package is one handler-map expression and nothing else.**
  Helpers and constants go inside it as `_` members (not message handlers);
  forge refuses top-level declarations.
- **Serving HTTP:** `WebRequest`, `WebResponse` and `WebCookie` type a
  handler exposed in the gateway's `http` mode (`docs/WEB_GATEWAY.md`).
- **LLM providers:** `LLMProviderSpec`, `ProviderCompleteRequest` /
  `ProviderCompleteReply` and `ProviderStreamRequest` / `ProviderStreamReply`
  type the provider protocol (`docs/LLM_PROVIDERS.md`).

## Files

- **abject.d.ts**: `AbjectMessage`, `AbjectThis`, `AbjectHandlers`,
  `PackageSettings`, the LLM provider protocol types, `HttpResponse`, and the
  web handler types (`WebRequest`, `WebResponse`, `WebCookie`).

See `examples/tally-ts` and `examples/openai-compatible-provider` for complete
packages, and `docs/PACKAGES.md` for the package format, settings and
lifecycle.
