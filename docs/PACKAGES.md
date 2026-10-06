# Abject packages

A package adds abjects to an Abject instance without changing the server. The
same release can be launched with different packages to become a different
kind of instance, and packages are turned on, turned off, pointed at and
configured from the Packages tab of the system settings.

## Two runtimes

| Runtime | What it runs | Written in | Scope |
|---|---|---|---|
| `wasm` (default) | A WebAssembly module hosted by `WasmAbject` (`docs/WASM_ABI.md`) | Any language with an SDK (`sdk/cpp/`) | `system` (one per instance) or `workspace` (one per workspace) |
| `script` | A JavaScript handler map hosted by `ScriptableAbject`, the same form as abjects made in the app | JavaScript, or TypeScript compiled by `pnpm forge` (`sdk/script/`) | `system` or `workspace` |

Both run on the worker pool when workers are enabled (the default).

A `workspace` package is spawned in each workspace whose profile it joins
(below); a `system` package once per instance, in the global registry, for
work that belongs to the instance rather than to a workspace.

## The package directory

A package is a directory with an `abject.json`:

```json
{
  "name": "Tally",
  "version": "1.0.0",
  "runtime": "script",
  "scope": "workspace",
  "entry": "tally.ts",
  "manifest": "manifest.json",
  "settings": [
    { "key": "unit", "label": "Unit", "type": "string", "default": "visits" },
    { "key": "token", "label": "API token", "type": "secret", "required": true }
  ]
}
```

| Field | Meaning |
|---|---|
| `name`, `version` | Package name (also the type name unless `replaces` is set) and a dotted version |
| `runtime` | `wasm` (default) or `script` |
| `scope` | `system` or `workspace` (script packages: `workspace`) |
| `replaces` | Optional. Take over a built-in type of that name: every spawn of it resolves to the package |
| `profiles` | Optional, workspace scope. The workspace profiles the package joins (`docs/WORKSPACE_PROFILES.md`); none means `default` only |
| `manifest` | The manifest inline, or a path to a JSON file holding it. An AbjectStore snapshot file (`{ manifest, source }`) works too. WASM packages may omit it; `pnpm forge` extracts the module's own. |
| `entry` | Script packages: the source to build. `.ts` is compiled; `.js` is used as is |
| `source` | Script packages: the built JavaScript (`main.js` after `pnpm forge`). A `.js` entry needs none |
| `wasm`, `abi`, `build` | WASM packages: see `docs/WASM_ABI.md` |
| `settings` | Optional. Settings the package needs, shown as a form in the Packages tab (below) |

The manifest's `name` must equal the type name (`replaces`, or the package
name) so Registry discovery finds the object.

### Script source

A script package's source is one handler-map expression, exactly what a
ScriptableAbject runs:

```js
({
  async add(msg) {
    this.data.count = (this.data.count || 0) + 1;
    await this.saveData();
    return this.data.count;
  }
})
```

Nothing may sit outside the expression. Helpers and constants go inside it
as `_` members, which are not message handlers; forge refuses top-level
declarations.

The sandbox has no Node or browser globals (no `require`, `fetch`, `crypto`);
everything else is reached by message through `this` (`call`, `dep`, `find`,
`emit`, `observe`, `changed`, `data`, `saveData`). `sdk/script/abject.d.ts`
types all of it for TypeScript; see `examples/tally-ts`. For secure random
tokens, hashes, HMACs, password hashing and signature checks, ask the `Crypto`
object (`this.call(this.dep('Crypto'), 'randomBytes', {})`); `Math.random` is
not secure.

A package can add an LLM provider by registering with the LLM object on
startup; see `docs/LLM_PROVIDERS.md` and `examples/openai-compatible-provider`.

## Building and installing

```bash
pnpm forge examples/tally-ts              # build + install into $ABJECTS_DATA_DIR/extensions/
pnpm forge examples/tally-ts --build-only # build in place (main.js) to load the directory directly
```

For a script package, forge compiles a TypeScript entry with esbuild (types,
`satisfies` and type-only imports are erased; runtime imports are refused),
checks the result compiles to a handler map in the sandbox, validates the
manifest and settings, and warns about declared methods with no handler.

A package with a `.js` entry and a manifest needs no build at all:
`examples/scene-showcase` loads straight from its directory.

## Where packages load from

In this order. A later copy of a type name wins when its version is the same
or newer; an older copy found later is shadowed rather than downgrading the
type.

1. Bundled native packages: `native/` (shipped with the desktop app as
   `resources/native`, or `ABJECTS_NATIVE_DIR`)
2. Installed extensions: `$ABJECTS_DATA_DIR/extensions/` (`pnpm forge`)
3. `ABJECTS_PACKAGE_DIRS`: directories separated by `:` (`;` on Windows)
4. Directories added in the Packages tab (stored in `packages.json`)

Each entry is either a package directory itself or a directory of package
directories. Packages load at boot; directory and enable/disable changes take
effect at the next start.

## Configuration: `packages.json`

`$ABJECTS_DATA_DIR/packages.json`, written by the Packages tab (through the
`Packages` system abject) and readable only by its owner:

```json
{
  "dirs": ["/opt/acme/packages"],
  "disabled": ["SceneShowcase"],
  "settings": { "Tally": { "unit": "hits", "token": "…" } }
}
```

It can also be written by provisioning tooling before the first boot. A
malformed file is ignored (defaults apply) rather than stopping the instance.

## Settings

A package declares the settings it needs; the Packages tab renders a form for
them and stores the values in `packages.json`. Types: `string`, `secret`
(masked in the tab and never shown back), `number`, `boolean`. Settings apply
at once, no restart.

A package's own abjects read them from the `Packages` object:

```ts
const { values } = await this.call(this.dep('Packages'), 'getSettings', {});
```

`getSettings` answers only abjects spawned from a running package, identified
from where the Factory registered them, never from the message. Script
package abjects are recognised by their `package:<name>` owner. WASM package
abjects, which have no owner, are recognised by the typeId stamped at spawn.
Values come back with defaults filled in and secrets included. Observe the
`Packages` object (`this.observe(this.dep('Packages'))`) to hear
`settingsChanged`.

## How package abjects behave

- **Spawned from the package.** WorkspaceManager spawns each workspace-scoped
  package type in every workspace whose profile it joins; the bootstrap
  spawns system-scoped types (WASM and script) once, under the Supervisor.
  Abjects tagged `autostart` get a `startup` call after spawning, at either
  scope.
- **Read-only.** Script package abjects are owned by `package:<name>`. They
  refuse source and manifest edits from everyone, ObjectCreator and
  AbjectEditor included. Change the package and reinstall it. The Factory
  refuses that owner to anything not spawned from the package.
- **Data survives restarts.** `saveData` stores a workspace package abject's
  data under `package/<TypeName>` in its workspace's AbjectStore, and
  WorkspaceManager hands it back at the next spawn. AbjectStore never restores
  package abjects as user objects, and its `list` leaves them out. A
  system-scope package abject has no AbjectStore (there is none at system
  scope): its data is kept by the `Packages` service in the global Storage
  (`savePackageData`, `getPackageData`, answered only to that package's own
  system abject), and read back before its first handler runs, after a
  supervised restart too.
- **A clone is an ordinary object.** Cloning a package abject drops the
  package owner and the `package` tag, so the copy is editable and persists as
  a user object.
- **`ask` shows source and data to the model.** Keep secrets and records in
  workspace Storage or settings, not in `this.data`.
