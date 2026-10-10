# examples/echo-cpp/ - EchoCpp, a C++ WASM Abject

The smallest useful abject written in C++ against `sdk/cpp`. It touches every
part of the WASM ABI: a self-declared manifest, synchronous replies,
dependents notification, guest-initiated requests with deferred replies, and
durable state through `snapshot`/`persist`. It has no window, so it works on
the desktop and the headless edition.

## Build and load

Needs the [WASI SDK](https://github.com/WebAssembly/wasi-sdk) at
`~/tools/wasi-sdk` (or set `WASI_SDK`).

```bash
pnpm forge examples/echo-cpp   # runs the build command, validates the module, installs it
pnpm awaken                    # EchoCpp spawns in each workspace with the default profile
```

forge runs `bash ../../sdk/cpp/build.sh echo.cpp -o main.wasm`, checks the
exports and ABI version, reads the manifest out of the module (this
`abject.json` has none of its own), and installs into
`$ABJECTS_DATA_DIR/extensions/EchoCpp/`. With `--build-only` it builds in
place and embeds the manifest here instead, so the directory can be loaded
through `ABJECTS_PACKAGE_DIRS` or Settings → Packages. `--no-build` reuses an
existing `main.wasm`.

## Methods

| Method | Payload | Returns |
|---|---|---|
| `echo` | anything (the manifest names `value`) | `{ echo: <the payload>, count }`; also emits `echoed` `{ count }` to dependents and persists |
| `count` | `{}` | the number of `echo` calls so far |
| `relay` | `{ to, method, payload? }` | `{ relayed: <the target's reply> }`, or an error with the code the host reports (such as `TARGET_NOT_FOUND` or `REQUEST_FAILED`); `INVALID_ARGS` without `to` and `method` |

`to` is an AbjectId or `"@Name"`. For example, from a script abject:

```js
const echo = await this.dep('EchoCpp');
await this.call(echo, 'echo', { value: 'hi' });
await this.call(echo, 'relay', { to: '@KnowledgeBase', method: 'listTags', payload: { limit: 5 } });
```

## What to look at in echo.cpp

- `manifest()`: a `ManifestBuilder` with three methods, one optional
  parameter and one event.
- `on_init()`: reads `count` back from `info.data`, then registers handlers.
  Handlers are registered here, never in the constructor (the module builds a
  throwaway instance to read the manifest).
- `relay`: `req.defer()`, then `request(...)` with a continuation that answers
  through `reply_to` / `error_to` using the saved `message_id()`.
- `snapshot()` + `persist()`: the count is saved as the package's data in the
  workspace's AbjectStore (under `package/EchoCpp`) and handed back in
  `info.data` after a backend restart, a respawn or a clone, so it keeps
  counting where it left off. The host coalesces the saves, so persisting on
  every `echo` is fine; state that is large or changes often belongs in
  `@Storage` instead.

## Files

- **echo.cpp**: the object and its `ABJECT_OBJECT(Echo)` export glue.
- **abject.json**: package metadata: name, version, `abi: 1`, workspace
  scope, module path and build command.
- **main.wasm**: build output, gitignored (`examples/.gitignore`).

## Related

- [../README.md](../README.md): all examples and how to load them
- [../../sdk/cpp/README.md](../../sdk/cpp/README.md): the C++ programming model
- [../../docs/WASM_ABI.md](../../docs/WASM_ABI.md): the ABI
- [../../native/knowledge-base/README.md](../../native/knowledge-base/README.md): a full system object in C++
