# Abject packages

A package adds abjects to an Abject instance without changing the server. The
same release can be launched with different packages to become a different
kind of instance, and packages are turned on, turned off, pointed at and
configured from the Packages tab of the system settings, or from a terminal
with the `abject` command (below).

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
| `scope` | `system` or `workspace`. `pnpm forge` writes `workspace` when it is missing; a directory loaded without forge must state it |
| `replaces` | Optional. Take over a type of that name: every spawn of it resolves to the package |
| `profiles` | Optional, workspace scope only. The workspace profiles the package joins (`docs/WORKSPACE_PROFILES.md`); none means `default` only |
| `manifest` | The manifest inline, or a path to a JSON file holding it. An AbjectStore snapshot file (`{ manifest, source }`) works too. WASM packages may omit it; `pnpm forge` extracts the module's own |
| `entry` | Script packages: the source to build. `.ts` is compiled; `.js` is used as is |
| `source` | Script packages: the built JavaScript (`main.js` after `pnpm forge`). A `.js` entry needs none |
| `wasm`, `abi` | WASM packages: the module file (default `main.wasm`) and the ABI version (`1`); see `docs/WASM_ABI.md` |
| `build` | Optional. A shell command `pnpm forge` runs in the package directory first (`--no-build` skips it) |
| `settings` | Optional. Settings the package needs, shown as a form in the Packages tab (below) |
| `ask` | Optional, WASM packages. `{ "guide": "<markdown file>", "tier": "fast" \| "balanced" \| "smart" }`: the usage guide appended to the abject's `ask` prompt and the tier it answers at. The host answers `ask` itself, so a module supplies its guidance here. `pnpm forge` installs the guide file with the module |
| `required` | Optional. `true` for a package the system cannot run without (a bundled native package with no built-in fallback): it stays enabled whatever `packages.json` says, the Packages tab refuses to disable it, and boot stops with an error when it cannot be loaded (an `abject.json` that parses but fails validation included) and no other copy provides its type |

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

Nothing may sit outside the expression, not even a leading comment in a
JavaScript entry. Helpers and constants go inside it as `_` members, which are
not message handlers; forge refuses top-level declarations.

The sandbox has no Node or browser globals (no `require`, `fetch`, `crypto`);
everything else is reached by message through `this` (`call`, `dep`, `find`,
`emit`, `observe`, `changed`, `data`, `saveData`). `sdk/script/abject.d.ts`
types all of it for TypeScript; see `examples/tally-ts`. For secure random
tokens, hashes, HMACs, password hashing and signature checks, ask the `Crypto`
object (`this.call(this.dep('Crypto'), 'randomBytes', {})`); `Math.random` is
not secure.

A package can add an LLM provider by registering with the LLM object on
startup; see `docs/LLM_PROVIDERS.md` and `examples/openai-compatible-provider`.
It can serve web pages through the HTTP gateway; see `docs/WEB_GATEWAY.md`.

## Building and installing

```bash
pnpm forge examples/tally-ts              # build + install into $ABJECTS_DATA_DIR/extensions/
pnpm forge examples/tally-ts --build-only # build in place (main.js) to load the directory directly
pnpm forge examples/tally-ts --dest DIR   # install into another extensions directory
```

`$ABJECTS_DATA_DIR` is the instance's data directory. A source checkout uses
`.abjects`; an installed desktop app or `abject` command uses the OS data
directory (`~/.config/abject` on Linux, `~/Library/Application Support/abject`
on macOS, `%APPDATA%\abject` on Windows) unless `ABJECTS_DATA_DIR` or
`abject setup` chose another. `pnpm forge` installs into
`.abjects/extensions/` unless `ABJECTS_DATA_DIR` or `--dest` says otherwise,
so set one of them to install into an installed instance. Restart the backend
to load what you installed.

For a script package, forge compiles a TypeScript entry with esbuild (types,
`satisfies` and type-only imports are erased; runtime imports are refused),
checks the result compiles to a handler map in the sandbox, validates the
manifest, settings and profiles, and warns about declared methods with no
handler.

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
directories. A package that cannot be read is skipped with a warning (the
Packages tab lists it as a problem); the others still load. The exception is a
`required` package: when it cannot be loaded and no other copy provides its
type, boot stops and says why. An `abject.json` that does not parse cannot
say it is required, so it is only a warning. Packages load at
boot; directory and enable/disable changes take effect at the next start.

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
(masked in the tab and never shown back), `number`, `boolean`. Each setting
may have a `label`, a `description`, a `default` of its type, and
`required: true`. Settings apply at once, no restart.

A package's own abjects read them from the `Packages` object:

```ts
const { values } = await this.call(this.dep('Packages'), 'getSettings', {});
```

`getSettings` answers only abjects spawned from a running package, identified
from where the Factory registered them, never from the message: package
abjects of either runtime carry the `package:<name>` owner, which only the
Factory gives out.
The reply is `{ package, values }`, with defaults filled in and secrets
included. Observe the `Packages` object (`this.observe(this.dep('Packages'))`)
to hear `settingsChanged` (value `{ package }`).

## From a terminal

The `abject` command (`pnpm abject` in a source checkout) lists packages and
turns them on and off, in its chat or from the shell:

```bash
abject settings packages                    # name, version, status, running
abject settings package disable SceneShowcase   # takes effect at the next start
```

In the chat the same commands are `/packages` and `/package enable|disable <name>`.
It has no command for package settings: write them in `packages.json`, or send
the terminal gateway's `setPackageSettings { name, values }` op.

## Desktop and headless

Both editions of the backend load the same packages: the desktop
(`server/index.ts`, with a display) and the headless server
(`server/headless.ts`). The headless edition has no WidgetManager, no windows,
no dock and no system settings window, so a package that opens windows finds
no WidgetManager there (`this.find('WidgetManager')` answers `null`,
`this.dep('WidgetManager')` throws). A package meant for both asks
`InstanceInfo` (`getInfo`, whose reply has `edition` and `display`) before it
draws.

## How package abjects behave

- **Spawned from the package.** WorkspaceManager spawns each workspace-scoped
  package type in every workspace whose profile it joins; the bootstrap
  spawns system-scoped types (WASM and script) once, under the Supervisor. A
  package with `replaces` needs no spawn of its own where the type it replaces
  is already spawned: that spawn resolves to the package.
- **`startup` for `autostart`.** A package abject tagged `autostart` (in its
  manifest's `tags`; a C++ module adds it with `tag("autostart")`) gets a
  `startup` call after spawning, for either runtime and at either scope.
- **A row in the System section (desktop).** A system-scoped abject tagged
  `launcher` that has `show` and `hide` methods gets a row in the dock's System
  section (GlobalToolbar), with its manifest's name and icon; clicking the row
  calls `show`. Rows come and go as such abjects register and unregister. Tag
  it `system` as well, or it is also listed in each workspace's Abjects
  section.
- **Read-only.** Package abjects of either runtime are owned by
  `package:<name>`. Script ones refuse source and manifest edits from
  everyone, ObjectCreator and AbjectEditor included (a WASM module cannot be
  edited in the app at all). Change the package and reinstall it. The Factory
  refuses that owner to anything not spawned from the package.
- **Data survives restarts.** A script abject's `saveData` and a WASM
  abject's `persist` store a workspace package abject's data under
  `package/<TypeName>` in its workspace's AbjectStore, and WorkspaceManager
  hands it back at the next spawn (a WASM module gets it as `data` in
  `abject_init`). AbjectStore never restores package abjects as user objects,
  and its `list` leaves them out. A system-scope package abject has no
  AbjectStore (there is none at system scope): its data is kept by the
  `Packages` service in the global Storage (`savePackageData`,
  `getPackageData`, answered only to that package's own system abject), and
  read back before its first handler runs (for a WASM module, before
  `abject_init`), after a supervised restart too. Saves of either runtime are
  coalesced, about one a second.
- **A clone is an ordinary object.** Cloning a package abject drops the
  package owner and the `package` tag, so the copy is editable and persists as
  a user object.
- **`ask` shows source and data to the model.** Keep secrets and records in
  workspace Storage or settings, not in `this.data`.
