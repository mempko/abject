# src/sandbox/ - WASM Abject Hosting

Host-side support for abjects written in other languages and compiled to
WebAssembly. The full host/guest contract is specified in `docs/WASM_ABI.md`;
the object that ties it into the runtime is `src/objects/wasm-abject.ts`
(an ordinary Abject subclass, like ScriptableAbject but backed by a module
instead of a JS source string). A C++ SDK for writing modules lives in
`sdk/cpp/`.

## Files

### wasm-abi.ts

The ABI v1 surface shared by the host pieces.

- Envelope types: guest↔host JSON messages (`reply`, `error`, `request`,
  `event`, `changed`, `persist`, `log` outbound; `message`, `result` inbound)
- `WasmAbjectExports`: typed view of a conforming module's exports
- Length-prefixed buffer codec (`readGuestBuffer`, `readGuestString`)
- `validateWasmModule(module)`: verify required exports before instantiation

### wasm-instance.ts

`WasmInstance` — wrapper around one instantiated module.

- Compiles, validates exports and ABI version, runs `_initialize` (WASI
  reactor), reads the module's self-declared manifest
- `init(info)` / `handle(envelope)` / `snapshot()` — the three guest calls
- Capability-gated `abjects` imports (`emit`, `log`, `time_ms`)
- Minimal WASI preview1 shim: stdout/stderr to the log, clock, random,
  empty args/env — deliberately **no** filesystem or sockets
- `extractWasmManifest(bytes)`: package-time manifest extraction

### wasm-module-store.ts

Content-addressed module storage at `$ABJECTS_DATA_DIR/wasm/<sha256>.wasm`.
Modules are referenced everywhere by the wasm source ref `wasm:sha256:<hex>`,
which rides the same `source` field ScriptableAbjects use — so Registry
registration, AbjectStore snapshots, clone/instantiate, and Supervisor respawn
work unchanged. Main thread and worker threads both resolve refs straight from
disk; module bytes never cross thread boundaries.

## Security Model

A WASM abject can only:

- **Emit envelopes** (messages to other abjects) — `abjects:send` capability
- **Log** — `abjects:log` capability
- **Read the clock** — `abjects:time` capability

Everything else (storage, network, timers, UI) is reached by messaging
capability abjects, exactly like every other object in the system. The WASI
shim exposes no filesystem, environment, or network.
