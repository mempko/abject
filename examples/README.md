# examples/ - Loadable WASM Abject Examples

Example abjects written in other languages (C++ via `sdk/cpp`) that you can
build and load into your workspaces. Each example is a forge package: an
`abject.json` describing it plus its sources.

Install one:

```bash
pnpm forge examples/echo-cpp   # compile + validate + install the package
pnpm awaken                    # extensions load at boot
```

Workspace-scoped packages spawn in every workspace alongside the built-in
objects; discover them by name like any other abject. Uninstall by deleting
the package directory from `.abjects/extensions/` and restarting.

Building requires the [WASI SDK](https://github.com/WebAssembly/wasi-sdk)
(default location `~/tools/wasi-sdk`, override with `WASI_SDK`).

## The examples

- **echo-cpp**: the full ABI surface in the smallest useful object: sync
  replies, `changed` events to dependents, guest-initiated requests with
  `@Name` discovery and deferred replies (`relay`), and durable state via
  snapshot/persist (`count` survives restarts).

Bundled system packages (like the C++ KnowledgeBase) live in `native/`, not
here; those ship with the app and load automatically. See `docs/WASM_ABI.md`
for the package format and `sdk/cpp/README.md` for the C++ programming model.
