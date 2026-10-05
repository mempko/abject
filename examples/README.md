# examples/ - Loadable Abject Packages

Example abject packages you can build and load into your workspaces: WASM
modules written in other languages (C++ via `sdk/cpp`), and script abjects
written in TypeScript or JavaScript (`sdk/script`). Each example is a package:
an `abject.json` describing it plus its sources. `docs/PACKAGES.md` covers the
format and where packages load from.

Install one:

```bash
pnpm forge examples/echo-cpp   # build + validate + install the package
pnpm forge examples/tally-ts   # same for a TypeScript script package
pnpm awaken                    # packages load at boot
```

Or load a package straight from its directory without installing it: add the
directory in Settings → Packages, or set `ABJECTS_PACKAGE_DIRS` (a script
package with a TypeScript entry needs `pnpm forge <dir> --build-only` first).

Workspace-scoped packages spawn in every workspace alongside the built-in
objects; discover them by name like any other abject. Disable one in Settings →
Packages, or uninstall it by deleting its directory from `.abjects/extensions/`,
and restart.

Building WASM examples requires the [WASI SDK](https://github.com/WebAssembly/wasi-sdk)
(default location `~/tools/wasi-sdk`, override with `WASI_SDK`).

## WASM examples

- **echo-cpp**: the full ABI surface in the smallest useful object: sync
  replies, `changed` events to dependents, guest-initiated requests with
  `@Name` discovery and deferred replies (`relay`), and durable state via
  snapshot/persist (`count` survives restarts).

## Script examples

- **tally-ts**: a script package written in TypeScript. Typed handlers
  (`sdk/script/abject.d.ts`), durable `this.data`, and settings declared in
  `abject.json` that the Packages tab renders as a form and the object reads
  with `Packages.getSettings`.
- **scene-showcase**: a tour of the 3D scene vocabulary. Material presets under
  a studio look, a neon arcade with bloom and GPU particles, an extruded gold
  title with an orbit camera, a draggable desktop companion with a trail, and a
  guide panel window riding a turning world node. A plain JavaScript package
  that loads with no build step; it can also be loaded through AbjectStore as a
  user object (its README says how).

Bundled system packages (like the C++ KnowledgeBase) live in `native/`, not
here; those ship with the app and load automatically. See `docs/WASM_ABI.md`
for the WASM contract, `sdk/cpp/README.md` for the C++ programming model and
`sdk/script/README.md` for script packages.
