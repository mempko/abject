# docs/ - Specifications

Standalone specifications and guides that outlive any one implementation
file. They define contracts between parts of the system, or between the
system and the people and toolchains that extend it: providers, packages,
modules in other languages, web routes, workspace profiles.

## Documents

- **LLM_PROVIDERS.md**: how an abject becomes an LLM provider by registering with the LLM object, the messages it then answers, naming rules, credentials, and network limits.
- **PACKAGES.md**: abject packages in both runtimes (WASM and script): `abject.json`, building with `pnpm forge`, where packages load from, `packages.json`, settings, the `abject` command, the headless edition, and how package abjects persist and stay read-only.
- **WASM_ABI.md**: the host/guest contract for abjects compiled to WebAssembly: module exports, host imports, the JSON envelope protocol, the `wasm:sha256:` source ref, and the package format.
- **WEB_GATEWAY.md**: the HTTP gateway: serving abjects as JSON method routes, or in `http` mode as whole HTTP requests (pages, sign-in, cookies, webhooks), access and tokens, and what the gateway keeps for itself.
- **WORKSPACE_PROFILES.md**: which built-in objects and packages a workspace gets: the `default` and `service` profiles, `profiles.json`, packages joining profiles, the headless edition, and restarts.

## Code-level architecture

How the code is laid out and how the parts fit is documented next to the
code, one README per directory:

- `src/README.md`: the layer map, with a README in each layer (`core/`, `runtime/`, `objects/` and its `capabilities/` and `widgets/`, `protocol/`, `llm/`, `network/`, `sandbox/`, `ui/` and `ui/gl/`).
- `server/README.md`: the backend and its two editions (desktop and headless) sharing one bootstrap.
- `workers/README.md`: worker thread entry points and their constructor tables.
- `client/README.md` and `electron/README.md`: the browser client and the desktop app shell.
- `sdk/README.md` (with `sdk/cpp/` and `sdk/script/`), `native/README.md` and `examples/README.md`: writing, bundling and trying packages.
- `deploy/README.md`, `packaging/README.md` and `scripts/README.md`: running as a service, package-manager manifests, and build tooling.

At the top level, `ARCHITECTURE.md` describes the system as a whole,
`PHILOSOPHY.md` its principles, and `WHISPER.md` the signaling server.
