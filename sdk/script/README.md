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

## Files

- **abject.d.ts**: `AbjectMessage`, `AbjectThis`, `AbjectHandlers`,
  `PackageSettings`.

See `examples/tally-ts` for a complete package, and `docs/PACKAGES.md` for the
package format, settings and lifecycle.
