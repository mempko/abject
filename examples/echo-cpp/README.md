# EchoCpp - C++ WASM Abject Example

The smallest useful abject written in C++ against `sdk/cpp`, exercising the
full ABI surface. Load it into your workspaces with:

```bash
pnpm forge examples/echo-cpp
pnpm awaken
```

## What it shows

- **echo**: a request handler with a synchronous reply, plus a `changed`
  event fanned out to dependents (`echoed`).
- **relay**: a guest-initiated request to another abject (`to` accepts an
  AbjectId or `"@Name"` for Registry discovery) with a **deferred reply**:
  the handler calls `req.defer()` and answers from the request continuation
  via `reply_to`/`error_to`.
- **count** + `snapshot()` + `persist()`: durable state that survives
  respawn and restore and rides along on clone.

## Files

- **echo.cpp**: the object (manifest via `ManifestBuilder`, handlers in
  `on_init`, `ABJECT_OBJECT(Echo)` export glue).
- **abject.json**: forge package metadata (workspace scope, build command).
- **main.wasm**: build output (gitignored here; `pnpm forge` builds it).
