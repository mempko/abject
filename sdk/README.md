# sdk/ - SDKs for Writing Abjects as Packages

Libraries for writing abjects that ship as packages (`docs/PACKAGES.md`)
instead of being compiled into the server. A package abject gets the same
manifest, message passing, discovery, supervision and worker placement as a
built-in TypeScript object; the server needs no change to load it.

## SDKs

| Directory | Runtime | Written in | Host |
|---|---|---|---|
| [cpp/](cpp/README.md) | `wasm`: a WebAssembly module speaking ABI v1 (`docs/WASM_ABI.md`) | C++20, built with the WASI SDK | `WasmAbject` (`src/objects/wasm-abject.ts`) |
| [script/](script/README.md) | `script`: one JavaScript handler-map expression | TypeScript (types only) or plain JavaScript | `ScriptableAbject`, in the sandbox |

- **cpp/** is header-only: an `Object` base class, handler registration,
  request continuations, a manifest builder and the export glue, plus
  `build.sh`, a clang++ wrapper for the WASI SDK. The bundled KnowledgeBase
  (`native/knowledge-base`) and `examples/echo-cpp` are built with it.
- **script/** is one declaration file. `pnpm forge` compiles a TypeScript
  entry with esbuild and erases the types, so the package that loads is plain
  JavaScript. `examples/tally-ts` and `examples/openai-compatible-provider`
  use it.

The WASM ABI is language-neutral: any language that compiles to WebAssembly
can implement the same exports and JSON envelopes. C++ is the only SDK in
this tree.

## Building and loading

Both kinds build and install the same way:

```bash
pnpm forge <package-dir>               # build, validate, install into $ABJECTS_DATA_DIR/extensions/
pnpm forge <package-dir> --build-only  # build in place, to load the directory directly
```

Packages load at boot; see `docs/PACKAGES.md` for where they are found.

## Related

- [../docs/PACKAGES.md](../docs/PACKAGES.md): package format, load order, settings
- [../docs/WASM_ABI.md](../docs/WASM_ABI.md): host/guest contract for WASM modules
- [../examples/README.md](../examples/README.md): working packages
- [../native/README.md](../native/README.md): bundled system packages
- [../scripts/README.md](../scripts/README.md): `forge-abject.ts`
