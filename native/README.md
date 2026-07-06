# native/ - Bundled Native System Packages

WASM abjects that ship as part of the system. Unlike user extensions
(`.abjects/extensions/`, installed with `pnpm forge`), these are committed to
the repo with their built `main.wasm` and load automatically on every boot,
before user extensions. A user-installed extension with the same type name
overrides the bundled one.

Where they load from (`findBuiltinNativeDir` in `src/sandbox/extensions.ts`):

1. `$ABJECTS_NATIVE_DIR` (explicit override)
2. `<resources>/native` in the packaged desktop app (shipped via
   electron-builder `extraResources`)
3. `native/` in the repo (dev, `pnpm awaken`)

Each package is a standard forge package: `abject.json` with the embedded
manifest (`pnpm smelt` keeps it in sync) plus `main.wasm`. Package format:
`docs/WASM_ABI.md`. Sources are committed alongside; rebuilding requires the
WASI SDK, but running never does; the built module is the artifact.

## Packages

- **knowledge-base**: C++ replacement for the built-in KnowledgeBase
  (`replaces: "KnowledgeBase"`, workspace scope). BM25 full-text recall,
  2-5x faster than the TS/SQLite version on the hot paths. See its README.
