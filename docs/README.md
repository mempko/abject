# docs/ - Specifications

Standalone specifications and design documents that outlive any one
implementation file. Layer-level documentation lives in per-directory
READMEs next to the code; documents here define contracts between parts of
the system (or between the system and external toolchains).

## Documents

- **WASM_ABI.md**: the host/guest contract for abjects written in other
  languages and compiled to WebAssembly. Defines the module exports, host
  imports, JSON envelope protocol, package format (`abject.json`), the
  `wasm:sha256:` source ref scheme, and how packages are installed
  (`pnpm forge`) or bundled with the app (`native/`).
