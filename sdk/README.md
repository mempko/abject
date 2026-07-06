# sdk/ - SDKs for Writing Abjects in Other Languages

Libraries for implementing the WASM abject ABI (`docs/WASM_ABI.md`) so
objects can be written in compiled languages and run as first-class abjects:
same manifests, message passing, discovery, persistence, and supervision as
TypeScript objects.

## SDKs

- **cpp/**: header-only C++ SDK (see its README). Object base class, handler
  registration, request continuations, manifest builder, and the export
  glue; builds as a WASI reactor via `cpp/build.sh` and the WASI SDK.

The ABI is language-agnostic; SDKs for other languages (Rust, Zig, Go)
implement the same envelope protocol and module exports.
