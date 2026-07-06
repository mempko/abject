# sdk/cpp - C++ Abject SDK

Write abjects in C++, compile them to WebAssembly, and run them as
first-class objects in the system. Implements the guest side of
`docs/WASM_ABI.md` (ABI v1).

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

Build (requires the [WASI SDK](https://github.com/WebAssembly/wasi-sdk);
set `WASI_SDK`, default `~/tools/wasi-sdk`):

```bash
sdk/cpp/build.sh my-object.cpp -o my-object.wasm
```

Package + install with `pnpm forge <dir>` (see `docs/WASM_ABI.md` for the
`abject.json` format), or spawn ad hoc through the Factory with the module
bytes.

## The programming model

Everything is message passing, exactly like TypeScript abjects:

- `on(method, handler)` registers a handler; `Request::reply` / `error`
  answer requests. A handler that returns without replying auto-replies null.
- `request(to, method, payload, continuation)` calls another abject. `to` is
  an AbjectId or `"@Name"` (Registry discovery, cached by the host). The
  continuation receives a `Result{ok, payload, code, message}`.
- For a reply that depends on such a call, use `req.defer()` and answer later
  with `reply_to(correlationId, ...)` / `error_to(...)` (see the `relay`
  method in `examples/echo-cpp/`).
- `send_event(to, method, payload)` fire-and-forget; `changed(aspect, value)`
  notifies dependents (subscribers via `addDependent`).
- `snapshot()` + `persist()` give durable state that survives respawn,
  restore, and rides along on clone. For large or hot state, message the
  workspace `"@Storage"` abject instead.
- `log(LogLevel::Info, ...)` reaches the server log and workspace Console.

The host answers `describe`, `ping`, `ask`, and dependents bookkeeping for
you, from the manifest the module declares.

## Environment constraints

- Single-threaded; the host never re-enters the module. Continuations run on
  later `abject_handle` calls, never concurrently.
- Exceptions are disabled (`-fno-exceptions`); the bundled nlohmann/json runs
  in `JSON_NOEXCEPTION` mode. Parse with `json::parse(s, nullptr, false)` and
  check `is_discarded()`; read fields with `value()`/`contains()` — indexing
  a missing key on a `const json` aborts the module.
- No filesystem, sockets, or environment: the WASI shim provides stdout/stderr
  (routed to the log), clock, and randomness only. All real capabilities are
  other abjects you message.

## Files

- `include/abject/abject.hpp` — the SDK: `Object`, `Request`,
  `ManifestBuilder`, host imports, and the `ABJECT_OBJECT` export glue.
  Expand `ABJECT_OBJECT(Class)` exactly once, in one translation unit.
- `include/abject/json.hpp` — vendored nlohmann/json v3.11.3.
- `build.sh` — clang++ wrapper with the right target/flags
  (`wasm32-wasi`, reactor model, 1 MiB stack).
