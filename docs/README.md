# docs/ - Specifications

Standalone specifications and design documents that outlive any one
implementation file. Layer-level documentation lives in per-directory
READMEs next to the code; documents here define contracts between parts of
the system (or between the system and external toolchains).

## Documents

- **LLM_PROVIDERS.md**: how an abject becomes an LLM provider by registering
  with the LLM object (`registerProvider`), the messages it then answers
  (`providerComplete`, `providerStream` with `providerChunk` events,
  `providerModels`), naming rules, credentials, and network limits.
- **WEB_GATEWAY.md**: the HTTP gateway: serving abjects as JSON method
  routes, or in `http` mode as whole HTTP requests (pages, sign-in, cookies,
  webhooks), and what the gateway keeps for itself.
- **WORKSPACE_PROFILES.md**: which built-in objects and packages a workspace
  gets: the `default` and `service` profiles, `profiles.json`, packages
  joining profiles, and restarts.
- **PACKAGES.md**: abject packages in both runtimes (WASM and script):
  the `abject.json` format, building with `pnpm forge` (including TypeScript),
  where packages load from, `packages.json`, declared settings and how a
  package's abjects read them, and how package abjects persist and stay
  read-only.
- **WASM_ABI.md**: the host/guest contract for abjects written in other
  languages and compiled to WebAssembly. Defines the module exports, host
  imports, JSON envelope protocol, package format (`abject.json`), the
  `wasm:sha256:` source ref scheme, and how packages are installed
  (`pnpm forge`) or bundled with the app (`native/`).
