# Abjects WASM ABI v1

This document specifies the binary interface between the Abjects runtime (the
host) and a WebAssembly module implementing an Abject (the guest). Any language
that compiles to WebAssembly can implement this ABI; a C++ SDK is provided in
`sdk/cpp/`.

A WASM abject is a first-class Abject. The host wraps the module in a
`WasmAbject` (an ordinary `Abject` subclass), so the module automatically gets
a mailbox, bus routing, Registry registration, typeId identity, Supervisor
restarts, worker-thread placement, `describe`/introspect, and P2P reachability.
The guest never talks to the bus directly; it exchanges JSON envelopes with its
host through linear memory.

## Data encoding

All payloads crossing the boundary are UTF-8 JSON in linear memory.

- A **buffer** is a length-prefixed byte range: a `u32` little-endian byte
  length at `ptr`, followed by that many bytes at `ptr + 4`.
- Host-to-guest calls pass `(ptr, len)` pairs pointing at raw UTF-8 bytes
  (no length prefix; the length is the argument).
- Guest-to-host returns are buffer pointers (`0` means "nothing").

Threading and ownership guarantees:

- The host is single-threaded and never calls into the instance reentrantly.
- A buffer returned by the guest only needs to stay valid until the next call
  into any guest export. SDKs may reuse one scratch buffer for every return.
- Input buffers are allocated by the host via `abject_alloc`; ownership passes
  to the guest with the call that receives them. The guest frees (or reuses)
  them internally.

## Required guest exports

```
memory                              WebAssembly.Memory
abject_abi_version() -> i32         must return 1
abject_alloc(size: i32) -> i32      allocate `size` bytes for a host write
abject_manifest() -> i32            buffer: JSON AbjectManifest
abject_init(ptr: i32, len: i32) -> i32
abject_handle(ptr: i32, len: i32) -> i32
```

Optional guest exports:

```
abject_snapshot() -> i32            buffer: JSON object (durable data), or 0
_initialize()                       WASI reactor initializer; called once
                                    right after instantiation when present
```

### abject_manifest

Returns the module's own `AbjectManifest` (same JSON shape TypeScript abjects
declare: `name`, `description`, `version`, `interface` with typed `methods`
and `events`, `tags`). The module self-describes; the
`abjects:introspect` protocol (`describe`) is answered by the host from this
manifest. The host adds the introspect methods to the manifest and tags it
`wasm`.

### abject_init

Called exactly once, after instantiation, before any `abject_handle`. Input:

```json
{
  "objectId": "<AbjectId>",
  "typeId": "<TypeId, optional>",
  "name": "<manifest name>",
  "data": { },
  "now": 1234567890123
}
```

`data` is the restored durable state (from a previous `persist`, a clone, or a
snapshot restore); absent on first spawn. Returns `0` or a buffer holding a
JSON **array of outbound envelopes** (see below), e.g. to discover
dependencies or load state at startup.

### abject_handle

The single entry point for everything that happens after init. Input is one
**inbound envelope**; the return is `0` or a buffer holding a JSON array of
outbound envelopes.

The host answers some messages itself and never passes them in: `describe`,
`ping`, `ask`, `addDependent`, `removeDependent`, `progress`, `getRegistry`
and `getResultContract`. Every other request and event goes to the guest,
including `recipientGone` (the bus's notice that an object this one addressed
no longer exists). Messages that arrive while the module is still
instantiating are queued and delivered after `abject_init`.

## Envelopes

### Inbound (host to guest)

```json
{ "kind": "message", "message": { <full AbjectMessage> } }
```
An incoming request or event from another abject. `message.header.messageId`
identifies a request for replying; `message.routing.method` selects the
handler; `message.payload` is the argument.

```json
{ "kind": "result", "id": "<guest request id>", "ok": true,  "payload": <any> }
{ "kind": "result", "id": "<guest request id>", "ok": false, "code": "...", "message": "..." }
```
Completion of a guest-initiated `request` envelope.

### Outbound (guest to host)

Outbound envelopes may be returned from `abject_init`/`abject_handle` or
emitted mid-call via the `abjects.emit` import; both are processed
identically, in order: the envelopes emitted during a call first, then the
array it returns.

```json
{ "kind": "reply", "correlationId": "<inbound messageId>", "payload": <any> }
```
Reply to an inbound request. May be returned from the same `abject_handle`
call (synchronous reply) or from a later one (deferred reply, e.g. after a
`result` arrives). If a request's `abject_handle` returns no reply/error for
it, the host holds the request open until a later envelope resolves it or the
caller times out. A held request is forgotten after 10 minutes.

```json
{ "kind": "error", "correlationId": "<inbound messageId>", "code": "SOME_CODE", "message": "..." }
```
Error reply to an inbound request: the caller's request fails with that code
and message.

```json
{ "kind": "request", "id": "<guest-chosen id>", "to": "<target>", "method": "...", "payload": <any>, "timeoutMs": 30000 }
```
Send a request to another abject. The host performs the request and later
delivers a `result` envelope with the same `id`. `to` is an `AbjectId`, a
well-known id, or `"@Name"` to discover a dependency by manifest name via the
Registry (resolution is cached). `timeoutMs` is optional (default 30000).

A failed request comes back as a `result` with `ok: false`. Its `code` is the
code of an error message shaped `CODE: message`, otherwise `REQUEST_FAILED`;
a `"@Name"` the Registry does not know fails with `TARGET_NOT_FOUND`. When the
object a cached `"@Name"` pointed at is gone (respawned under a new id), the
host resolves the name again and retries once.

```json
{ "kind": "event", "to": "<target>", "method": "...", "payload": <any> }
```
Fire-and-forget event. Same `to` resolution as `request`; an event whose
target cannot be resolved is dropped with a warning in the log.

```json
{ "kind": "changed", "aspect": "...", "value": <any> }
```
Notify dependents (Smalltalk `changed:` protocol). The host tracks
`addDependent`/`removeDependent` and fans out.

```json
{ "kind": "persist" }
```
Ask the host to call `abject_snapshot()` and save the returned data, the way a
script abject's `saveData` is saved, so it survives a backend restart. It comes
back through `abject_init`'s `data` when the object is spawned again: after a
restart, a Supervisor respawn, or as the start of a clone. Where it is kept
depends on where the object came from:

- an abject from an installed package, in a workspace: that workspace's
  AbjectStore, under `package/<TypeName>`; WorkspaceManager hands it back at
  the next spawn;
- an abject from a `"scope": "system"` package: the `Packages` service, in
  the global Storage; the host reads it before calling `abject_init`;
- any other WASM abject (spawned through the Factory with `source`, `code`
  or `codeBase64`): its workspace's AbjectStore, as a user object snapshot
  that the store restores at boot. With no AbjectStore (spawned at system
  scope) the data lives only in the Registry and does not survive a restart.

Saves are coalesced: at most one is in flight and one queued, a second apart,
and the snapshot is taken when the save starts, so a guest may persist after
every change. A persist still waiting when the object stops is written then.
Every save also updates the object's Registry registration. Each save copies
the whole snapshot across the boundary and rewrites a stored record, so keep
it small; large or frequently-changing state belongs in the workspace
`Storage` abject (via `request` envelopes), one key per record.

```json
{ "kind": "log", "level": "debug" | "info" | "warn" | "error", "message": "..." }
```
Log through the host object's logging (workspace Console + server log).

## Host imports

Module `abjects`:

```
emit(ptr: i32, len: i32)            one outbound envelope, JSON UTF-8
log(level: i32, ptr: i32, len: i32) 0=debug 1=info 2=warn 3=error
time_ms() -> f64                    wall-clock milliseconds since epoch
```

`emit`, `log` and `time_ms` are gated by the object's capability set
(`abjects:send` / `abjects:log` / `abjects:time`), which every abject holds by
default; grants can be restricted at spawn time.

Module `wasi_snapshot_preview1`: the host provides a minimal, capability-safe
shim so C/C++ standard libraries link and run: `fd_write` (stdout to the info
log, stderr to the error log), `clock_time_get`, `random_get`,
`environ_*`/`args_*` (empty), `proc_exit` (traps), `sched_yield`, and stubs
for `fd_close`, `fd_seek`, `fd_fdstat_get` and `poll_oneoff`. There is no
filesystem or socket access. Modules should be compiled as WASI *reactors*
(`-mexec-model=reactor`; `sdk/cpp/build.sh` does this).

Module `env`: `abort(msgPtr, filePtr, line, col)` and `seed()` are provided
for AssemblyScript-style runtimes.

## How a module becomes an object in the system

The compiled module is stored content-addressed at
`$ABJECTS_DATA_DIR/wasm/<sha256>.wasm` (the instance's data directory:
`.abjects` in a source checkout, the OS data directory in an installed build;
see `docs/PACKAGES.md`) and referred to everywhere by the **wasm source ref**
string:

```
wasm:sha256:<hex digest>
```

This ref rides the same `source` field ScriptableAbjects use for JS source, so
Registry registration, AbjectStore snapshots, `clone`, `instantiate`, and
Supervisor `respawn` all work unchanged.

Ways to spawn:

- `Factory.spawn({ manifest, source: "wasm:sha256:..." })`: the module is
  already in the store.
- `Factory.spawn({ manifest, code })` / `{ manifest, codeBase64 }`: raw module
  bytes; the Factory hashes and stores them, then proceeds as above.
- **Installed extensions** (`$ABJECTS_DATA_DIR/extensions/<name>/`, see
  `abject.json` below) are ingested at boot. A package with
  `"scope": "system"` is spawned once as a global system object;
  `"scope": "workspace"` is spawned per workspace by the WorkspaceManager, in
  the workspaces whose profile it joins (`docs/WORKSPACE_PROFILES.md`). A
  package with `"replaces": "<Name>"` registers as a **type override** in the
  Factory: any spawn of that name resolves to the WASM implementation instead
  of a built-in constructor. A replaced type needs no built-in at all: the
  KnowledgeBase exists only as `native/knowledge-base`
  (`"replaces": "KnowledgeBase"`).
- **Bundled native system packages** (`native/<name>/` in the repo, shipped
  as `resources/native` in the desktop app) use the same package format and
  are ingested before user extensions on every boot, so they need no install
  step. A user-installed extension with the same type name overrides the
  bundled one when its version is the same or newer. Rebuild a bundled package
  in place with `pnpm forge native/<name> --build-only`, which re-embeds the
  extracted manifest into the package's `abject.json`; `pnpm smelt` does this
  for `native/knowledge-base`.

Packages (WASM and script), where they load from, `packages.json` and package
settings are described in `docs/PACKAGES.md`.

## Package format

```
my-object/
  abject.json      install metadata
  main.wasm        the module
```

`abject.json`:

```json
{
  "name": "MyObject",
  "version": "1.0.0",
  "abi": 1,
  "wasm": "main.wasm",
  "scope": "workspace" | "system",
  "replaces": "SomeType",
  "build": "bash ../../sdk/cpp/build.sh my-object.cpp -o main.wasm",
  "ask": { "guide": "ask-guide.md", "tier": "balanced" },
  "manifest": { <AbjectManifest, extracted from the module by `pnpm forge`> }
}
```

`replaces`, `build` and `ask` are optional; `docs/PACKAGES.md` lists every
field (`settings`, `profiles`, `required` too). `ask` exists for WASM
packages: the host answers `ask` for the module, so the package supplies the
usage guide appended to the prompt and the tier it answers at.

`pnpm forge <dir>` runs the `build` command (the C++ SDK's `build.sh` needs the
WASI SDK, default `~/tools/wasi-sdk`, override with `WASI_SDK`), validates the
module's exports and ABI version, extracts the manifest, checks that its name
equals the type name (`replaces`, or the package name), and installs the
package into `$ABJECTS_DATA_DIR/extensions/`. `--build-only` writes the
manifest into the package's own `abject.json` instead, for a package loaded
straight from its directory.

## Versioning

`abject_abi_version()` must return `1`. The host refuses modules with a
different ABI version. Additive changes (new optional envelope kinds, new
optional exports) do not bump the version; breaking changes do.
