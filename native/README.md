# native/ - Bundled Native System Packages

WASM abjects that ship as part of the system. Unlike user extensions
(installed into `$ABJECTS_DATA_DIR/extensions/` with `pnpm forge`), these are
committed to the repo with their built `main.wasm` and are ingested on every
boot, before any other package. Running them never needs a compiler; only
rebuilding them does.

## How it works

At boot `ingestAllExtensions` (`src/sandbox/extensions.ts`) reads every
package root in precedence order: bundled (`native/`), installed extensions,
`ABJECTS_PACKAGE_DIRS`, then directories added in `packages.json`. A later
copy of the same type name wins only when its version is the same or newer;
an older one is shadowed and logged. Each WASM module goes into the
content-addressed module store and its type is registered with the Factory,
so a package with `replaces` overrides the built-in name before anything
spawns.

`findBuiltinNativeDir()` locates this directory, first match wins:

1. `$ABJECTS_NATIVE_DIR` (explicit override)
2. `<resources>/native` in the packaged desktop app (electron-builder
   `extraResources` in `electron-builder.yml`)
3. `../../native` relative to the running code: `<repo>/native` in a
   checkout (`pnpm awaken`). In the headless archive the same hop from
   `lib/dist-server/server/` lands on `lib/native/`, and the `abject` command
   also sets `ABJECTS_NATIVE_DIR` to `<install>/lib/native` when it starts the
   backend (`cli/backend.ts`).
4. `native` under the working directory

Each package is a standard package directory (`docs/PACKAGES.md`): an
`abject.json` with the embedded manifest plus `main.wasm`, with its sources
alongside. A package marked `"required": true` stays enabled whatever
`packages.json` says, and boot stops with an error if it cannot be loaded
(an `abject.json` that fails validation, or a module that fails to register)
and no other copy provides its type.

## Files

- **knowledge-base/**: the workspace KnowledgeBase, C++ compiled to WASM
  (`replaces: "KnowledgeBase"`, workspace scope, required). There is no
  TypeScript implementation; see its [README](knowledge-base/README.md).

## Rebuilding

`pnpm smelt` runs `forge --build-only` on `native/knowledge-base`: it runs the
package's `build` command, validates the module's exports and ABI version,
extracts the module's manifest and writes it back into `abject.json`. It
needs the WASI SDK (`~/tools/wasi-sdk`, or set `WASI_SDK`). For another
bundled package, run `pnpm forge native/<name> --build-only`; `smelt` names
the knowledge base only.

Commit the rebuilt `main.wasm` and `abject.json` together.

## Gotchas

- **What ships.** The desktop app copies only `abject.json`, `*.wasm` and
  `*.md` from here. The headless archive (`scripts/package-headless.mjs`)
  copies `*.json`, `*.wasm` and `*.md` and skips `src/`, `build/` and
  `node_modules/`. A file a package reads at runtime (an `ask` guide, for
  example) must fit those filters.
- **`--build-only` rewrites `abject.json`** from a fixed field list (name,
  version, abi, wasm, scope, replaces, build, settings, profiles, ask,
  required, manifest). Any other hand-added field is dropped.
- **Bump `version`** when a package's surface changes. A stale copy of the
  same type in the extensions directory then loses to the bundled one instead
  of shadowing it.

## Related

- [../docs/WASM_ABI.md](../docs/WASM_ABI.md): host/guest contract
- [../docs/PACKAGES.md](../docs/PACKAGES.md): package format and load order
- [../sdk/cpp/README.md](../sdk/cpp/README.md): the C++ SDK these are built with
- [../src/sandbox/README.md](../src/sandbox/README.md): package discovery and ingest
- [../examples/README.md](../examples/README.md): user-loadable example packages
