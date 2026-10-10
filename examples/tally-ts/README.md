# examples/tally-ts/ - Tally, a TypeScript Script Package

Named counters that survive restarts, written as a script package in
TypeScript. It shows the three things most packages need: typed handlers
against `sdk/script/abject.d.ts`, durable `this.data`, and settings declared
in `abject.json`. No window, so it runs on the desktop and the headless
edition.

## Build and load

```bash
pnpm forge examples/tally-ts   # compile tally.ts, check it, install into $ABJECTS_DATA_DIR/extensions/Tally/
pnpm awaken                    # Tally spawns in each workspace with the default profile
```

forge compiles `tally.ts` with esbuild (the type-only import and `satisfies`
are erased), checks that the result is one handler-map expression that
compiles in the sandbox, validates the manifest and settings, and warns about
any declared method without a handler. To load the directory in place
instead:

```bash
pnpm forge examples/tally-ts --build-only   # writes main.js and adds "source": "main.js" to abject.json
ABJECTS_PACKAGE_DIRS=$PWD/examples/tally-ts pnpm awaken
```

`--build-only` edits this `abject.json` (it adds `source`); `main.js` is
gitignored.

## What it shows

- **TypeScript authoring.** `tally.ts` is one handler-map expression that
  `satisfies AbjectHandlers<State>`, so `this` (`call`, `dep`, `data`,
  `saveData`, `ensure`, `changed`, ...) and `this.data` are typed. `_settings`
  is a helper member: the leading `_` keeps it from being a message handler.
- **Durable data.** Counts live in `this.data.counts` and are saved with
  `saveData()`. As a package abject, Tally's data is kept under
  `package/Tally` in each workspace's AbjectStore and handed back when the
  package spawns again.
- **Settings.** `abject.json` declares Unit (string, default `visits`), Step
  (number, default 1) and Announce changes (boolean, default off). They
  appear as a form in Settings → Packages → Tally; on the headless edition,
  set them in `packages.json` under `settings.Tally`. The object reads them
  with `Packages.getSettings` on every call and falls back to the defaults
  when the call fails.

## Methods

| Method | Payload | Returns |
|---|---|---|
| `add` | `{ name, by? }` (`by` defaults to the Step setting) | `{ name, count, unit }` |
| `counts` | `{}` | `{ unit, counts }` |
| `reset` | `{ name? }` (all counts when omitted) | `{ counts }` |

With Announce changes on, every `add` emits `counted` (`{ name, count }`) to
the object's dependents.

## Files

- **tally.ts**: the object.
- **manifest.json**: its manifest (`abject.json` points at it; the manifest
  `name` must equal the package name, `Tally`).
- **abject.json**: package metadata: script runtime, workspace scope, entry,
  manifest path and the declared settings.

## Related

- [../README.md](../README.md): all examples and how to load them
- [../../sdk/script/README.md](../../sdk/script/README.md): the script SDK types
- [../../docs/PACKAGES.md](../../docs/PACKAGES.md): package format, settings, data
- [../openai-compatible-provider/README.md](../openai-compatible-provider/README.md): a package that also observes its settings
