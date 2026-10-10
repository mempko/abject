# sdk/cpp/ - C++ Abject SDK

Write abjects in C++, compile them to WebAssembly, and run them as
first-class objects. The SDK is header-only and implements the guest side of
`docs/WASM_ABI.md` (ABI v1): the module exports, the JSON envelopes, and a
small object model on top. The host side is `WasmAbject`
(`src/objects/wasm-abject.ts`), which gives the module a mailbox, Registry
registration, supervision, worker placement and `describe`/`ask`.

## Quick start

```cpp
#include <abject/abject.hpp>
using namespace abject;

class Echo final : public Object {
 public:
  json manifest() override {
    ManifestBuilder m("EchoCpp", "Echoes payloads back", "1.0.0", "abjects:echo-cpp");
    m.method("echo", "Echo the payload back")
      .param("value", "string", "Value to echo")
      .returns("object");
    m.event("echoed", "Fired after every echo");
    m.tag("demo");
    return m.build();
  }

  void on_init(const InitInfo& info) override {
    on("echo", [this](Request& req) {
      changed("echoed", req.payload());
      req.reply({{"echo", req.payload()}});
    });
  }
};

ABJECT_OBJECT(Echo)
```

Build it (requires the [WASI SDK](https://github.com/WebAssembly/wasi-sdk);
`WASI_SDK` names its root, default `~/tools/wasi-sdk`):

```bash
sdk/cpp/build.sh my-object.cpp -o main.wasm
```

Package it as a directory with an `abject.json` and load it with
`pnpm forge <dir>` (see "Packaging" below), or spawn it ad hoc through the
Factory with the module bytes (`Factory.spawn({ manifest, code })` or
`{ manifest, codeBase64 }`).

## The programming model

Everything is message passing, as in TypeScript abjects:

- **Handlers.** `on(method, handler)` registers a handler for requests and
  events; `"*"` is a catch-all. Register them in `on_init`. `Request::reply`
  and `Request::error(code, message)` answer a request; a request handler that
  does neither (and did not defer) gets an automatic `null` reply. A request
  with no handler gets `METHOD_NOT_FOUND`; an unhandled event is dropped.
- **Calling out.** `request(to, method, payload, continuation, timeout_ms)`
  (default 30 s). `to` is an AbjectId, a well-known id, or `"@Name"` for
  Registry discovery (cached by the host; if the cached object is gone the
  host resolves the name again and retries once). The continuation receives a
  `Result{ok, payload, code, message}`; an error message shaped
  `CODE: text` arrives split into `code` and `message`, and an unknown name
  fails with `TARGET_NOT_FOUND`.
- **Deferred replies.** For a reply that depends on such a call, call
  `req.defer()`, keep `req.message_id()`, and answer later with
  `reply_to(id, payload)` or `error_to(id, code, message)` (see `relay` in
  `examples/echo-cpp/echo.cpp`). The host drops deferred requests still open
  after 10 minutes.
- **Events and dependents.** `send_event(to, method, payload)` is
  fire-and-forget. `changed(aspect, value)` notifies dependents (subscribers
  via `addDependent`); the host keeps the dependents list.
- **Durable state.** Override `snapshot()` to return a JSON object and call
  `persist()`: the host takes the snapshot and saves it where a script
  abject's `saveData` goes (a package abject's under `package/<Type>` in its
  workspace's AbjectStore, or with `Packages` at system scope; any other
  abject as a user snapshot in its workspace's AbjectStore), and it comes
  back as `InitInfo::data` after a backend restart, a Supervisor respawn or
  a clone. Saves are coalesced (about one a second), so calling `persist()`
  after every change is fine. Each save copies the whole snapshot, so keep it
  small: for state that is large or changes often, message the workspace
  `"@Storage"` abject instead, one key per record (as
  `native/knowledge-base` does). See `docs/WASM_ABI.md`.
- **Logging and time.** `log(LogLevel::Info, ...)` reaches the server log and
  the workspace Console; `now_ms()` is wall-clock milliseconds.
- **Identity.** `id()` and `type_id()` (empty when the object has no durable
  identity); `InitInfo` also carries `name`, `data` and `now`.

The host answers `describe`, `ping`, `ask`, the dependents bookkeeping and a
few other base-class messages itself (the full list is in `docs/WASM_ABI.md`);
the module never sees them. Everything else reaches your handlers, including
`recipientGone`, the bus's notice that an object you addressed is gone. A
package can add an `ask` usage guide and tier in its `abject.json`
(`docs/PACKAGES.md`).

### ManifestBuilder

`ManifestBuilder(name, description, version, interface_id)` with
`method(name, description)` returning a builder for
`.param(name, type, description, optional = false)` and `.returns(type)`;
`event(name, description)`; `tag(t)`; `icon(glyph)`; `build()`.
Types are `"string"`, `"number"`, `"boolean"`, `"null"`, `"object"` and
`"array"`.

## Packaging

A package is a directory with `abject.json`:

```json
{
  "name": "EchoCpp",
  "version": "1.0.0",
  "abi": 1,
  "scope": "workspace",
  "wasm": "main.wasm",
  "build": "bash ../../sdk/cpp/build.sh echo.cpp -o main.wasm"
}
```

`pnpm forge <dir>` runs `build`, checks the module's exports and ABI version,
extracts the manifest from the module, checks that its `name` equals the
package name (or the `replaces` target), and installs `main.wasm` plus
`abject.json` (manifest embedded) into `$ABJECTS_DATA_DIR/extensions/<name>/`.
`--build-only` writes the manifest into the package's own `abject.json`
instead (bundled packages: `pnpm smelt`), and `--no-build` skips the build
command and uses the existing module. Fields and load order:
`docs/PACKAGES.md`.

## Environment constraints

- **Single-threaded.** The host never re-enters the module; continuations run
  on later `abject_handle` calls, never concurrently.
- **No exceptions** (`-fno-exceptions`); the bundled nlohmann/json runs in
  `JSON_NOEXCEPTION` mode. Parse with `json::parse(s, nullptr, false)` and
  check `is_discarded()`; read fields with `value()` / `contains()`. Indexing
  a missing key on a `const json` aborts the module.
- **No filesystem, sockets or environment.** The WASI shim provides
  `fd_write` (routed to the log), the clock and randomness; `environ` and
  `args` are empty and `proc_exit` traps. Every real capability is another
  abject you message.
- **The manifest comes from a probe instance.** The `abject_manifest` export
  constructs a throwaway object of your class to call `manifest()`, so keep
  constructors free of side effects and do the work in `on_init`.
- Invalid UTF-8 in outgoing JSON is replaced rather than trapping.

## Files

- **build.sh**: clang++ wrapper: `--target=wasm32-wasi`, reactor model,
  C++20, `-O2`, `-fno-exceptions`, `-fno-threadsafe-statics`, a 1 MiB stack
  and 4 MiB initial memory. Extra arguments pass through to clang++.
- **include/**: the headers; add it to the include path (`build.sh` does). See
  [include/README.md](include/README.md).

## Related

- [../../docs/WASM_ABI.md](../../docs/WASM_ABI.md): the ABI this SDK implements
- [../../docs/PACKAGES.md](../../docs/PACKAGES.md): package format and load order
- [../../examples/echo-cpp/README.md](../../examples/echo-cpp/README.md): the smallest complete example
- [../../native/knowledge-base/README.md](../../native/knowledge-base/README.md): a full system object built with this SDK
- [../README.md](../README.md): the other SDK (script packages)
