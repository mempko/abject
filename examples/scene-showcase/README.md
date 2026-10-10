# examples/scene-showcase/ - Scene Showcase

A user-style ScriptableAbject that tours the desktop's 3D scene vocabulary. It
uses only public messages (WidgetManager, window `scene` / `attachTo`, UIServer
world `scene`, SceneLibrary), so it doubles as a worked example to copy from.
It is plain JavaScript and loads with no build step.

It needs the desktop edition: it opens windows and draws in the world scene,
and the headless edition has no WidgetManager, so `show` fails there.

## Files

- **SceneShowcase.js**: the handler map, plain text, ready to paste. The
  package's `entry`.
- **SceneShowcase.json**: `{ manifest, source }`, the form AbjectStore saves.
  The package reads its `manifest` from here; its `source` holds the same code
  as `SceneShowcase.js`, so edit both together.
- **abject.json**: package metadata: script runtime, workspace scope,
  `entry: SceneShowcase.js`, `manifest: SceneShowcase.json`.

## What it shows

Opening it (`show`) puts a **stage window** and a **guide panel** on the desktop,
plus a **companion** that lives on the desktop itself. The panel's buttons switch
the stage between three stations.

| Where | What to look at | The params doing it |
|---|---|---|
| Materials station | Twelve shapes in built-in presets on a plinth and a floor, soft shadows, contact AO; click a shape to wobble it | `material: 'gold'`, `look: 'studio'`, `castShadow` + `shadow.softness`, `ao`, parametric primitives (`capsule`, `roundedBox`, `lathe`, `extrude`, `torus`, `tube`), a preset it registers itself (`showcaseEnamel` via SceneLibrary `registerMaterial`), `interactive` + `wobble` |
| Arcade station | A synthwave corner: neon grid and portal, neon 3D sign, hologram orb, chrome ball, sparks and embers | `look: 'neon'`, `bloom`, `line` nodes with `blend: 'additive'`, `kind: 'text'` with `material: 'neon'`, GPU `particles` (`turbulence`, `drag`, `sizeEnd`), keyframe animation, `sky` with stars |
| Title station | Gold extruded title under a sunset sky that you can orbit and zoom | `kind: 'text'`, `material: 'gold'` / `'chrome'`, `look: 'sunset'`, `dof`, a `camera` node with `orbit` and `zoom`, an instanced halo spinning with `preset: 'spin'` |
| Companion (desktop) | A glossy orb with an eye: drag it anywhere, flick it, click it for sparks; its spot is remembered | world scope, `layer: 'stack'`, `draggable: { inertia: true }`, `trail`, `label`, `breathe` / `wobble` presets, a `spring` animate op for **Summon companion**, `dragEnd` saved in `this.data` |
| Guide panel | A working widget window that sways on a turning world node, with a gold ring popping out of its corner | window `attachTo({ scope: 'world', nodeId })`, keyframed rotation, `clip: 'none'` |
| Scene info button | The screen's GPU capabilities and live stats | WidgetManager `getSceneParams` (`capabilities`, `stats`) |

Colours for chrome, labels and several materials are theme tokens (`$accent`,
`$accentTertiary`, `$textPrimary`, `$windowBg`), so it follows the palette:
try it in Red Sigil and in a light palette such as Agitprop. `hide` (or closing
the stage window) removes the companion and the dock from the desktop and
unregisters the preset; closing only the panel keeps the stage open.

## Load it

**As a package (no build step):** this directory is a script package
(`abject.json` names `SceneShowcase.js` and the manifest in
`SceneShowcase.json`). Either add the directory in Settings → Packages →
Package directories, or start the backend with
`ABJECTS_PACKAGE_DIRS=$PWD/examples/scene-showcase pnpm awaken`, or install a
copy with `pnpm forge examples/scene-showcase`. After a restart
**SceneShowcase** is in the sidebar of every workspace with the default
profile. As a package abject it is
read-only; clone it to get an editable copy. See `docs/PACKAGES.md`.

**From the Explorer (no AI involved, exact copy):**

1. In the sidebar under SYSTEM, open **Explorer**. Pick **AbjectStore** and the
   method **save**.
2. Fill the fields: `objectId` `scene-showcase`; `manifest` the `manifest`
   object from `SceneShowcase.json` (paste the JSON object); `source` the whole
   of `SceneShowcase.js`; `owner` your name; `data` `{}`. Press **Send**.
3. Restart Abjects (quit and reopen the app, or restart `pnpm awaken`). Saved
   objects are restored at boot, and **SceneShowcase** appears under ABJECTS in
   the sidebar. Click it to open the showcase.

To remove it later, send AbjectStore **remove** with its current object id (the
Explorer shows it) and restart.

**Over an object you already have:** open it in the Abject Editor, paste
`SceneShowcase.js` over its source and press Save. The object keeps its own
name; `show` opens the showcase.

**From a script (developers):** spawn it through Factory with the workspace's
store and registry, the way the repo's verification scripts do:

```ts
const { manifest, source } = JSON.parse(fs.readFileSync('examples/scene-showcase/SceneShowcase.json', 'utf8'));
const { objectId } = await call(factoryId, 'spawn', { manifest, source, parentId: workspaceAbjectStoreId, registryHint: workspaceRegistryId });
await call(objectId, 'show', {});
```

## Methods

`show`, `hide`, `setStation({ station: 'materials' | 'arcade' | 'title' })`,
`summonCompanion`, `toggleRide({ ride? })`, `sceneInfo`, `getState`. The
manifest also lists the callbacks it receives: `changed` (widget events),
`nodeInput` (clicks and drags on its scene nodes) and `windowCloseRequested`.

## Related

- [../README.md](../README.md): all examples and how to load them
- [../../docs/PACKAGES.md](../../docs/PACKAGES.md): script packages, read-only package abjects, cloning
- `src/objects/scene-library.ts`: material, look and preset registration (`registerMaterial`)
- `src/objects/widget-manager.ts`: windows, `getSceneParams`
