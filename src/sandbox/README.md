# src/sandbox/ - Abject Packages and WASM Hosting

Host-side support for abjects that ship as packages instead of being compiled
into the server: WASM modules written in other languages, and script abjects
(JavaScript handler maps, optionally authored in TypeScript). This directory
finds packages, decides which copy of each type loads, registers them with
the Factory at boot, keeps `packages.json`, stores WASM modules by content
hash, and runs a module with three host imports (emit, log, time) and a
minimal WASI shim.

The abjects that put packages to work live in `src/objects/`:
`wasm-abject.ts` (`WasmAbject`, a module-backed Abject),
`scriptable-abject.ts` (a source-backed one) and `packages.ts` (the
`Packages` system abject behind the Packages settings tab). SDKs are in
`sdk/cpp/` and `sdk/script/`; `pnpm forge` (`scripts/forge-abject.ts`) builds,
validates and installs a package. Package format and configuration:
[`docs/PACKAGES.md`](../../docs/PACKAGES.md). Host/guest contract:
[`docs/WASM_ABI.md`](../../docs/WASM_ABI.md).

## Architecture

Boot (`server/boot.ts`, shared by the desktop and headless editions), after
constructors are registered and before anything spawns:

```
 packageRoots()             in order; a later root wins a type name when its
                            version is the same or newer
   1. bundled native/   (findBuiltinNativeDir: ABJECTS_NATIVE_DIR,
                         Electron resources/native, repo native/, ./native)
   2. $ABJECTS_DATA_DIR/extensions/   (pnpm forge installs here)
   3. ABJECTS_PACKAGE_DIRS            (path-delimiter separated)
   4. packages.json "dirs"            (Settings → Packages)
        │
        ▼
 discoverPackages()   readPackage() on every dir holding an abject.json;
        │             a broken package is reported, never thrown
        ▼
 resolvePackages()    one winner per type name (replaces target or name):
        │             enabled | disabled | shadowed | invalid
        ▼
 ingestAllExtensions(factory)
        ├─ wasm:   bytes → storeWasmModule() → source 'wasm:sha256:<hex>'
        ├─ script: checkScriptSource() → source text
        └─ both:   owner 'package:<name>'
        ▼
 Factory.registerPackageType(typeName, ...)
        │
        ├─ boot stops if a required package's type did not load, or
        │     if no 'KnowledgeBase' package type loaded
        ├─ scope 'system' (no replaces): spawned once by server/boot.ts
        │     as {peerId}/system/{Name}; 'autostart' ones get `startup`
        ├─ scope 'workspace': spawned per workspace by WorkspaceManager
        │     (in the workspace profiles the package joins) with its saved
        │     data; 'autostart' ones get `startup`
        └─ replaces '<Builtin>': every spawn of that name resolves to the package
```

At spawn, a WASM type becomes a `WasmAbject` whose `onInit` loads the module
from the store (main thread or worker, straight from disk) and wraps it in a
`WasmInstance`:

```
 bus message ─▶ WasmAbject '*' handler ─▶ instance.handle({kind:'message'})
                                              │ JSON in guest memory
                                              ▼
                                         guest abject_handle
                                              │ envelopes: reply, error, request,
                                              │ event, changed, persist, log
                                              ▼
 bus ◀─ WasmAbject bridges each envelope (requests resolve '@Name' via
        Registry; their results go back in as {kind:'result'})
```

## Files

### extensions.ts

Package discovery and boot-time ingest.

- `readPackage(dir)`: read and validate one `abject.json`. `runtime` is
  `wasm` (default) or `script`; `scope` is `system` or `workspace`; the
  manifest is inline or a path (a manifest file or an AbjectStore snapshot
  `{ manifest, source }`) and its name must equal `replaces` or the package
  name. Also validates `settings` (`parseSettingSpecs`), `profiles`
  (`parseProfiles`, workspace scope only), `required`, and `ask`
  (`{ guide, tier }`; the guide file is read once here). WASM packages need
  `abi: 1` and a module (default `main.wasm`); script packages need a built
  `source`, or an `entry` that is already `.js`/`.cjs`/`.mjs`.
- `loadPackageManifest()`, `checkScriptSource()` (compiles the source in the
  sandbox and returns its handler names), `compareVersions()`.
- `extensionsDir()`, `findBuiltinNativeDir()`, `packageRoots(config)`,
  `discoverPackages(roots)`, `scanExtensions(dir)`.
- `resolvePackages(discovered, config)`: later roots win a type name when
  their version is the same or newer; an older later copy is `shadowed`
  instead of downgrading the type. Packages named in `disabled` do not load,
  unless marked `required`.
- `ingestAllExtensions(factory, config)`: registers every enabled package
  with `Factory.registerPackageType`, tagging its manifest `package` and
  giving its abjects the owner `package:<name>` (either runtime). A package
  that cannot be read or fails to register is logged and skipped, except a
  `required` one whose type no other copy provides, which stops boot. For an
  unreadable package, `discoverPackages` records what its abject.json still
  declares (`declared`: name, type, `required`) when the JSON parses.

### package-config.ts

`$ABJECTS_DATA_DIR/packages.json`: `dirs` (extra package directories),
`disabled` (package names) and `settings` (values per package name).
`readPackageConfig()` is synchronous and returns defaults for a missing or
malformed file; `normalizePackageConfig()` drops anything malformed rather
than failing boot; `writePackageConfig()` writes atomically with mode 0600,
because settings may hold secrets. `envPackageDirs()` reads
`ABJECTS_PACKAGE_DIRS`. The `Packages` abject (`src/objects/packages.ts`) is
the writer.

### wasm-abi.ts

The ABI v1 surface shared by the host pieces.

- `WASM_ABI_VERSION` (1) and `REQUIRED_EXPORTS`: `memory`,
  `abject_abi_version`, `abject_alloc`, `abject_manifest`, `abject_init`,
  `abject_handle`; optional `abject_snapshot` and `_initialize`
  (`WasmAbjectExports`).
- Envelope types: inbound `message` and `result`; outbound `reply`, `error`,
  `request` (with a guest-chosen `id`, `to` as an AbjectId, well-known id or
  `@Name`), `event`, `changed`, `persist`, `log`. `WasmInitInfo` is the
  `abject_init` input (`objectId`, `typeId`, `name`, `data`, `now`).
- Buffer codec: guest buffers are a u32 little-endian length followed by
  UTF-8 (`readGuestBuffer`); `readGuestString` reads unprefixed bytes.
- `validateWasmModule(module)` lists missing or mistyped exports;
  `looksLikeManifest(value)` is the structural manifest check also used for
  script packages.

### wasm-instance.ts

`WasmInstance`, one instantiated module. `WasmAbject` drives it; nothing
else should.

- `WasmInstance.create(bytes, ctx)`: compile, check exports, instantiate, run
  `_initialize` (WASI reactor), then check the ABI version.
- `manifest()`, `init(info)` (once), `handle(envelope)`, `snapshot()`. Each
  call returns the envelopes the guest emitted during the call (via
  `abjects.emit`) followed by the ones it returned, in that order.
- Imports: `abjects.emit`, `abjects.log`, `abjects.time_ms`, each requiring a
  capability (`abjects:send`, `abjects:log`, `abjects:time`); `env.abort`
  (AssemblyScript style) and `env.seed`; a minimal WASI preview1 shim:
  stdout and stderr go to the log, clock and random work, args and
  environment are empty, there are no files beyond the standard streams and
  no sockets, and `proc_exit` throws.
- `extractWasmManifest(bytes)`: instantiate once with default capabilities and
  read the manifest (used by `pnpm forge`).

### wasm-module-store.ts

Content-addressed module storage at `$ABJECTS_DATA_DIR/wasm/<sha256>.wasm`.
Modules are referenced by the source ref `wasm:sha256:<hex>`
(`WASM_SOURCE_PREFIX`, `isWasmSourceRef`, `hashFromWasmRef`), which rides the
same `source` field ScriptableAbjects use, so Registry registration,
AbjectStore snapshots, clone, instantiate and Supervisor respawn work
unchanged. `storeWasmModule()` is idempotent and writes through a temp file
and rename; `loadWasmModule()` re-hashes the bytes and refuses a mismatch.
The Factory's spawn also accepts raw module bytes (`code`, or `codeBase64`
through `decodeBase64Module()`), stores them here and spawns from the ref.

## Adding a Package

Follow "New WASM Abject" or "New Script Package" in the repository's
`CLAUDE.md`, and the examples: `examples/echo-cpp` (C++ to WASM),
`examples/tally-ts` (TypeScript with settings), `examples/scene-showcase`
(plain JavaScript), `examples/openai-compatible-provider` (an LLM provider).
In short: write the code against the SDK, add an `abject.json`, then
`pnpm forge <dir>` to build and install into `$ABJECTS_DATA_DIR/extensions/`,
or point `ABJECTS_PACKAGE_DIRS` or Settings → Packages at the directory
(build first with `--build-only` when the entry is TypeScript). No
constructor registration is needed anywhere.

Bundled system packages live in `native/` with their built `main.wasm`
committed; after changing their sources run `pnpm smelt` (forge
`--build-only` on `native/knowledge-base`). When the `abject` command starts
an installed backend it sets `ABJECTS_NATIVE_DIR` to the install's
`lib/native` (`cli/backend.ts`).

## Security Model

A script package's abjects run in the same sandbox as any ScriptableAbject
(no Node or browser globals; everything by message), on the worker pool when
workers are enabled. Package abjects of either runtime are owned by
`package:<name>`, which makes a script one's source and manifest read-only
(reinstalling the package is the only way to change them) and keeps their
data (a script's `saveData`, a WASM module's `persist`) under `package/<Type>`
in the workspace's AbjectStore, or with the `Packages` service for a
system-scope package. A clone or instance made from one is an ordinary,
editable user object.

A WASM abject can only:

- **Emit envelopes** (messages to other abjects): `abjects:send`
- **Log**: `abjects:log`
- **Read the clock**: `abjects:time`

Storage, network, timers and UI are reached by messaging capability abjects,
exactly like every other object. The WASI shim exposes no filesystem,
environment, arguments or network.

## Gotchas

- **The WASM boundary serializes everything.** The in-process bus passes
  payloads by reference, but every envelope into or out of a guest is JSON
  copied through linear memory, and `WasmAbject.dataSnapshot` calls the
  guest's `abject_snapshot` each time it is read. Keep hot-path payloads
  small; never ship a whole store per message.
- **The manifest name must match the type name** (`replaces` target or
  package name), or `readPackage` rejects the package.
- **A required package that cannot be loaded stops boot,** whether its
  abject.json fails validation or it fails to register, unless another copy
  provides its type. An abject.json that does not parse cannot say it is
  required, so it is only a warning; boot separately stops when no
  `KnowledgeBase` type loaded.
- **Version order decides shadowing.** A stale copy in a later root with a
  lower version is shadowed with a warning; a same-or-newer copy wins even
  over the bundled one.
- **TypeScript entries are not compiled at boot.** A script package must
  carry built JavaScript (`pnpm forge` writes `main.js` and points `source`
  at it).
- **The module store only grows.** Every distinct module that is ingested or
  spawned adds a `<sha256>.wasm`; nothing removes old ones.

## Related

- [`../../docs/PACKAGES.md`](../../docs/PACKAGES.md): package format, load order, settings
- [`../../docs/WASM_ABI.md`](../../docs/WASM_ABI.md): the guest/host contract
- [`../../docs/WORKSPACE_PROFILES.md`](../../docs/WORKSPACE_PROFILES.md): which workspaces a package joins
- [`../../native/README.md`](../../native/README.md): bundled system packages
- [`../../sdk/README.md`](../../sdk/README.md): the C++ and script SDKs
- [`../objects/README.md`](../objects/README.md): WasmAbject, ScriptableAbject, Packages, Factory
