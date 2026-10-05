# sdk/ - SDKs for Writing Abjects Outside the Server

Libraries for writing abjects that ship as packages (`docs/PACKAGES.md`)
instead of being built into the server: same manifests, message passing,
discovery, persistence, and supervision as the built-in TypeScript objects.

## SDKs

- **cpp/**: header-only C++ SDK (see its README) for the WASM abject ABI
  (`docs/WASM_ABI.md`). Object base class, handler registration, request
  continuations, manifest builder, and the export glue; builds as a WASI
  reactor via `cpp/build.sh` and the WASI SDK.
- **script/**: TypeScript types for script packages (see its README). A
  script package is a JavaScript handler map run as a ScriptableAbject in the
  sandbox; `pnpm forge` compiles a TypeScript entry and erases these types.

The WASM ABI is language-agnostic; SDKs for other languages (Rust, Zig, Go)
implement the same envelope protocol and module exports.
