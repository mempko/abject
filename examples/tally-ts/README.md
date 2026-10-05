# Tally

A script package written in TypeScript: named counters that survive restarts.

```bash
pnpm forge examples/tally-ts   # compile tally.ts, check it, install into .abjects/extensions/
pnpm awaken                    # Tally spawns in every workspace
```

## What it shows

- **TypeScript authoring.** `tally.ts` is one handler-map expression that
  `satisfies AbjectHandlers<State>` from `sdk/script/abject.d.ts`, so `this`
  (`call`, `dep`, `data`, `saveData`, …) and `this.data` are typed. `pnpm forge`
  compiles it to `main.js`; the type-only import is erased.
- **Durable data.** Counts live in `this.data` and are saved with `saveData()`.
  As a package abject, Tally's data is kept under `package/Tally` in each
  workspace's AbjectStore and handed back when the package spawns again.
- **Settings.** `abject.json` declares Unit, Step and Announce changes. They
  appear as a form in Settings → Packages → Tally, and the object reads them
  with `Packages.getSettings` (falling back to defaults).

## Methods

| Method | Payload | Returns |
|---|---|---|
| `add` | `{ name, by? }` | `{ name, count, unit }` |
| `counts` | `{}` | `{ unit, counts }` |
| `reset` | `{ name? }` | `{ counts }` |

With Announce changes on, every `add` emits `counted` (`{ name, count }`) to
the object's dependents.

## Files

- **tally.ts**: the object.
- **manifest.json**: its manifest.
- **abject.json**: package metadata (script runtime, workspace scope, entry,
  manifest, declared settings).
