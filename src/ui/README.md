# src/ui/ - Compositor and Desktop Rendering

The rendering half of the desktop. `compositor.ts` is the WebGL2 desktop the
browser client draws with: every window surface is a slab in a 3D scene whose
content is a 2D canvas painted by draw commands ("2D buffers on 3D surfaces"),
and scene-vocabulary nodes (meshes, lights, canvas layers, particles, models,
text, lines, sky) hang off a window's subtree or the world. The compositor is
behaviourally dumb: it renders the state it is sent and answers picking;
decisions stay with the Abjects on the server.

The Compositor runs only in the browser (`client/frontend-client.ts` owns
it). Server-side code may import the pure modules here (`icons.ts`,
`motion.ts` and the data modules in `gl/`), never `compositor.ts`.

## Architecture

```
  server (worker threads)                      browser
  ─────────────────────────                    ───────────────────────────────────────
  WindowAbject / widgets / any Abject
      │ draw { commands }, scene { ops },
      │ effect, setSlabTransform, ...
      ▼
  UIServer (BackendUI, UI worker)  ──binary wire──▶  FrontendClient
      retains surfaces, draw logs,                      │ createSurface, draw, sceneOps,
      scene nodes, transforms, theme                    │ setSceneTheme, setSlabMotion, ...
      for reconnect replay                              ▼
      ▲                                             Compositor
      │                                               ├─ Surface: OffscreenCanvas per window,
      │                                               │  painted by draw commands, uploaded
      │                                               │  as the slab's texture when dirty
      │                                               ├─ SceneStore: retained nodes per window
      │                                               │  subtree and per world owner
      │                                               ├─ GlRenderer: slabs, meshes, particles,
      │                                               │  lines, sky, shadows, post effects
      │                                               └─ Overlay2D: screen-space chrome
      │                                                       │
      └──────── input (surface-local x, y, nodeId) ◀── ray picking + alpha test
```

## Files

- **`compositor.ts`**: `Compositor`. Surfaces, the scene, cameras, picking,
  the render loop, Exposé, the phone layout and capture. Imports the engine in
  [gl/](gl/README.md).
- **`icons.ts`**: the vector icon set. `iconCommands(name, opts)` returns draw
  commands for an icon in a box; `isIconName`. Used by buttons, lists, trees,
  window chrome and the dock (server side).
- **`motion.ts`**: cubic-bezier easings (`STANDARD`, `ACCELERATE`,
  `DECELERATE`, `EMPHASIZE`, `LINEAR`), `Tween`, and `fadeIn` / `fadeOut` /
  `scaleIn` / `pulse` / `shimmer`. Pure timing math with no canvas;
  WindowAbject uses it server-side and `gl/anim-tracks.ts` reuses the curves
  client-side.
- **[gl/](gl/README.md)**: the hand-rolled WebGL2 engine and the scene
  vocabulary.

## The Compositor

**Surfaces.** `createSurface` makes a window slab backed by an
`OffscreenCanvas`; `draw(command)` paints it with the 2D draw-command
vocabulary (`DRAW_COMMAND_TYPES` in `src/objects/widgets/widget-types.ts`:
high-level shapes, `text`, `markdown`, `imageUrl`, `videoFrame`, and the
Canvas 2D API names). The canvas uploads as the slab's texture only when it
changed. `moveSurface`, `resizeSurface`, `setZIndex`, `setVisible`,
`setSurfaceTitle`, `setFocusedSurface` and `destroySurface` manage the rest.
Surfaces tagged with a workspace (`setSurfaceWorkspace`) show only while that
workspace is active (`setActiveWorkspace`); untagged ones always show.

**Canvas layers are scene nodes.** A `kind: 'canvas'` node is a 2D layer in
the scene graph, placed at its transform or at `params.rect` (window px from
the top-left). It is painted through the same draw channel as the surface
(draw commands carrying `nodeId`): commands accumulate on its pixels and
`clear` restarts it, erasing to transparent. Non-backdrop layers slice the
subtree's meshes by depth, so 2D and 3D stack in any order; `backdrop: true`
pins a layer behind every mesh, like the window's own content. CanvasWidget
and pop-outs are canvas layers.

**The scene.** `applySceneOps(surfaceId, ops)` maintains retained nodes on a
window's subtree; `applyWorldSceneOps(ownerId, ops)` does the same for world
nodes drawn behind the windows (`back`), above them (`front`) or between them
(`stack`). Colours may be `$token` references resolved against the scene
theme (`setSceneTheme`); `material` and `look` names resolve against the
preset library (`setSceneLibrary`). A window's 3D children are clipped to its
content rect by default (`clip: 'content' | 'window' | 'none'`) with a scissor,
or a stencil when the window is tilted.

**Cameras.** The desktop camera is a perspective camera whose z = 0 plane maps
1:1 to CSS pixels (`gl/camera.ts`); scrolling the desktop moves the camera.
Each window's subtree renders through its own off-axis camera that converges
on the window, and a `camera` node can replace it and orbit under the user's
hand (`cameraChange` reported, throttled).

**Motion runs here.** `animate` ops, presets, springs, particles, draggable
nodes (`onNodeDrag`), orbit coasting and the declarative slab effects and
transitions (`setSlabMotion`, `surfaceEffect`, `setSurfaceModal`) all run off
the render loop in the browser. The wire carries specs, never per-frame
values. `setSurfaceTransform` tilts or floats a slab;
`setSurfaceAttachment` makes a slab ride a scene node.

**Picking.** `surfaceAt` / `surfaceLocalAt` cast a camera ray, intersect each
slab's plane in its local space (correct under lift, tilt and attachment),
and alpha-test the surface canvas so transparent pixels click through.
`nodeAt` finds interactive scene nodes; their input goes to the Abject that
contributed them.

**Render loop.** `requestAnimationFrame`, rendering only when `needsRender` is
set or an animation, effect or video region wants the next frame.

**Exposé and the phone.** `enterExpose` spreads the active workspace's windows
into a grid to pick one (desktop and phone). In mobile mode
(`setMobileMode`) the compositor fits, zooms, pans and flies to surfaces,
keeps screen-anchored rails in place, and draws titles, close chips and the
gesture handle on the 2D overlay.

**Capture.** `captureSurface` crops the GL canvas so the capture shows meshes,
lights and effects, rendering a window from another workspace for the capture
if needed; it falls back to the surface canvas in mobile mode or after
context loss. `captureDesktop` renders synchronously and reads the canvas in
the same task (the drawing buffer is not preserved).

**Media and blobs.** `registerVideoElement` plus `videoFrame` regions let the
client composite live video into a slab each frame. Images and models
referenced as `abx:sha256:<hash>` resolve through `setBlobResolver`.

## Adding to the Vocabulary

- **A 2D draw command**: add the name to `DRAW_COMMAND_TYPES` (and its
  required params) in `src/objects/widgets/widget-types.ts`, then handle it in
  `Compositor.draw`. CanvasWidget checks user batches against that list on the
  server, so both sides change together.
- **A scene node kind or param**: see [gl/README.md](gl/README.md). Validation
  lives in `gl/scene-types.ts` and UIServer (BackendUI) runs it on every scene
  batch, atomically, before anything is sent; drawing lives in the compositor
  and `gl/`.
- **A slab effect or transition**: data in `gl/slab-motion.ts`, or registered
  at runtime through WidgetManager without code.

## Gotchas

- **Keep shared modules pure.** BackendUI, WidgetManager, WindowAbject,
  SceneLibrary and NotificationCenter import `gl/scene-types.ts`,
  `gl/slab-motion.ts`, `gl/scene-presets.ts`, `gl/camera.ts`, and constants
  from `gl/gpu-particles.ts` and `gl/shaders.ts` in Node. Those modules must
  not touch the DOM or GL at load time. `compositor.ts` is browser only and
  the headless bundle check rejects it.
- **Tainted canvases.** A cross-origin image drawn without CORS taints the
  surface canvas, and texture upload of a tainted canvas throws. The upload
  is guarded (the surface is marked `tainted` and keeps its last good
  texture), and remote images are drawn from server-fetched data URIs.
- **Everything is retained.** Nodes persist until removed or their surface or
  owner goes. UIServer keeps each surface's and layer's draw log for
  reconnect replay and compacts it at `clear` boundaries (a log with no clear
  is capped, oldest commands first), so begin each repaint with a `clear`.
- **y points down.** The world is x right, y down, +z toward the viewer, in
  px. The projection bakes in the y flip and face culling is off.
- **Visual only.** Slab effects, tilts and lift never change a window's rect
  or input routing; picking follows the drawn matrix.

## Related

- [gl/README.md](gl/README.md): renderer, scene vocabulary, effects
- [../objects/widgets/README.md](../objects/widgets/README.md): the widgets
  that produce draw commands and scene ops
- [../../client/README.md](../../client/README.md): the browser client that
  owns the Compositor
- [../../server/README.md](../../server/README.md): BackendUI, the UIServer
