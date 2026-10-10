# examples/ - Loadable Abject Packages

Example packages to build and load into an instance: WASM modules written in
C++ (`sdk/cpp`) and script abjects written in TypeScript or JavaScript
(`sdk/script`). Each subdirectory is one package: an `abject.json` describing
it plus its sources. None of them is loaded unless you load it. Bundled
system packages, which load on every boot, live in `native/` instead.

## Examples

| Package | Runtime | Shows | Build step | Edition |
|---|---|---|---|---|
| [echo-cpp](echo-cpp/README.md) | WASM (C++) | The whole ABI in a small object: sync replies, `changed`, `@Name` requests with deferred replies, `snapshot`/`persist` | WASI SDK | desktop and headless |
| [tally-ts](tally-ts/README.md) | script (TypeScript) | Typed handlers, durable `this.data`, package settings | `pnpm forge` (TypeScript) | desktop and headless |
| [openai-compatible-provider](openai-compatible-provider/README.md) | script (TypeScript) | An abject-backed LLM provider: `registerProvider`, `providerComplete`, settings, `HttpClient` | `pnpm forge` (TypeScript) | desktop and headless |
| [scene-showcase](scene-showcase/README.md) | script (JavaScript) | The 3D scene vocabulary: materials, looks, particles, a desktop companion, a window on a world node | none | desktop only (it opens windows) |

All four are workspace scope and name no `profiles`, so they join the
`default` workspace profile only (`docs/WORKSPACE_PROFILES.md`).

## Loading one

Install a copy into the data directory's `extensions/`:

```bash
pnpm forge examples/echo-cpp   # build + validate + install
pnpm forge examples/tally-ts   # compile the TypeScript, check it, install
pnpm awaken                    # packages load at boot
```

`pnpm forge` installs into `$ABJECTS_DATA_DIR/extensions/` (`.abjects/` in a
source checkout). For an installed desktop app or `abject` command, whose data
lives in the OS data directory, set `ABJECTS_DATA_DIR` or pass
`--dest <data-dir>/extensions`.

Or load a package straight from its directory, without installing it: add the
directory in Settings → Packages, or name it in `ABJECTS_PACKAGE_DIRS`
(`:`-separated, `;` on Windows). A TypeScript entry has to be built in place
first:

```bash
pnpm forge examples/tally-ts --build-only   # writes main.js and points abject.json at it
ABJECTS_PACKAGE_DIRS=$PWD/examples/tally-ts pnpm awaken
```

Packages load at boot, so restart after installing. Disable one in Settings →
Packages (or `/package disable <name>` in the `abject` command), or uninstall
it by deleting its directory under `extensions/`, and restart.

Building the WASM example needs the [WASI SDK](https://github.com/WebAssembly/wasi-sdk)
(default `~/tools/wasi-sdk`, override with `WASI_SDK`). The script examples
need nothing beyond the repo's own dependencies.

## Files

- **echo-cpp/**, **tally-ts/**, **openai-compatible-provider/**,
  **scene-showcase/**: the packages.
- **.gitignore**: keeps build output out of git: `*.wasm`, and the `main.js`
  that `--build-only` writes for the two TypeScript packages.

## Gotchas

- Packages from these directories are read-only in the app (package abjects
  are owned by `package:<name>`). Clone one to get an editable copy, or
  change the source here and reinstall.
- Two copies of one type name: the one found later wins when its version is
  the same or newer, and an older one is skipped with a warning. Package
  directories (`ABJECTS_PACKAGE_DIRS`, Settings → Packages) come after
  `extensions/`, so bump `version` or remove the stale copy when both exist.
- Package data survives a backend restart in both runtimes: a WASM module's
  `persist` and a script's `saveData()` are kept under `package/<Type>` in the
  workspace's AbjectStore (with `Packages` for a system-scope package) and
  handed back at the next spawn.

## Related

- [../docs/PACKAGES.md](../docs/PACKAGES.md): package format, load order, settings
- [../docs/WASM_ABI.md](../docs/WASM_ABI.md): the WASM contract
- [../docs/LLM_PROVIDERS.md](../docs/LLM_PROVIDERS.md): abject-backed LLM providers
- [../sdk/README.md](../sdk/README.md): the C++ and script SDKs
- [../native/README.md](../native/README.md): bundled system packages
