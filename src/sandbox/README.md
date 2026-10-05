# src/sandbox/ - Abject Packages and WASM Hosting

Host-side support for abjects that ship as packages instead of being built
into the server: WASM modules written in other languages, and script abjects
(JavaScript handler maps, which may be authored in TypeScript). The package
format, where packages load from, and how they are configured are described in
`docs/PACKAGES.md`; the WASM host/guest contract is `docs/WASM_ABI.md`.

The objects that tie packages into the runtime are `src/objects/wasm-abject.ts`
(a module-backed Abject) and `src/objects/scriptable-abject.ts` (a
source-backed one). SDKs live in `sdk/cpp/` and `sdk/script/`.

## Files

### extensions.ts

Package discovery and boot-time ingest.

- `readPackage(dir)`: read and validate one package (`runtime` `wasm` or
  `script`, scope, manifest, declared settings)
- `packageRoots()` / `discoverPackages()`: the places packages load from, in
  precedence order (bundled `native/`, installed extensions,
  `ABJECTS_PACKAGE_DIRS`, directories added in `packages.json`)
- `resolvePackages()`: which copy of each type name loads; later same-or-newer
  copies win, older ones are shadowed, disabled ones never load
- `ingestAllExtensions(factory)`: register every enabled package's type with
  the Factory before anything spawns

### package-config.ts

`$ABJECTS_DATA_DIR/packages.json`: extra package directories, disabled
packages, and settings values. Read at boot; written by the Packages object
(`src/objects/packages.ts`), atomically and readable only by its owner.

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

A script package's abjects run in the same sandbox as any ScriptableAbject
(no Node or browser globals; everything by message), on worker threads when
workers are enabled. They are owned by `package:<name>`, which makes their
source and manifest read-only (only reinstalling the package changes them);
the Factory refuses that owner to anything not spawned from the package.

A WASM abject can only:

- **Emit envelopes** (messages to other abjects) — `abjects:send` capability
- **Log** — `abjects:log` capability
- **Read the clock** — `abjects:time` capability

Everything else (storage, network, timers, UI) is reached by messaging
capability abjects, exactly like every other object in the system. The WASI
shim exposes no filesystem, environment, or network.
