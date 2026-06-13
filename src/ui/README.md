# src/ui/ - User Interface Layer

Browser application shell and 3D rendering. The desktop is a WebGL2 scene:
every window surface is a textured slab rendered with a perspective camera.
Window content is still rasterized by the 2D draw-command vocabulary into a
per-surface `OffscreenCanvas`, which uploads as the slab's texture — "2D
buffers on 3D surfaces". Scene-vocabulary nodes (meshes, lights) attach to a
window's subtree and travel with it.

## Files

### app.ts

Application shell and bootstrap.

- **`App`**: creates canvas element, Compositor, UIServer, Runtime
  - `start()` → starts Runtime, sets up input listeners (mouse, keyboard)
  - Accessors: `appRuntime`, `appCompositor`, `appUIServer`
- **`createApp({ container, debug? })`**: factory function for one-line bootstrap

### compositor.ts

3D surface compositor (WebGL2, hand-rolled — no rendering deps).

- **Surface model**: each surface is an `OffscreenCanvas` with its own 2D
  context, painted by the draw-command vocabulary, uploaded as a slab texture
  only when dirty
- **The scene**: perspective camera whose z=0 plane maps ~1:1 to CSS px;
  desktop scroll = camera truck. Slabs get rounded corners (SDF), soft
  shadows, an accent rim + bloom and a z-lift when focused, a drag tilt that
  spring-settles, and a dim factor when unfocused — all theme-driven via the
  scene theme (`setSceneTheme`), including flat themes (surface.gradient 0)
- **Scene vocabulary**: `applySceneOps(surfaceId, ops)` maintains retained
  mesh/light/group nodes per window subtree (see `gl/scene-types.ts`);
  material colors accept `$token` references resolved against the scene theme
- **Render loop**: `requestAnimationFrame`, renders only when `needsRender`
  is set; settle animations re-request frames
- **Hit testing**: `surfaceAt`/`surfaceLocalAt` cast a camera ray and
  intersect each slab's plane in local space (correct under lift/tilt), then
  alpha-test the per-surface canvas so transparent pixels pass through
- **Mobile**: native fit/zoom positions the focused slab with a scissor clip;
  the card overview is a real 3D carousel (cards recede and turn); chrome
  (titles, close chips, scrollbars, gesture handle) renders on a screen-space
  2D overlay texture
- **Capture**: `captureDesktop()` renders synchronously then reads the GL
  canvas; `captureSurface()` reads the per-surface canvas

### gl/

The hand-rolled WebGL2 engine:

| File | Contents |
|---|---|
| `math.ts` | Column-major Mat4/Vec3 math (perspective with y-down, TRS, invert, ray transforms) |
| `renderer.ts` | GL context, program cache, premultiplied-alpha textures, context-loss recovery, typed draw calls (surface slab, SDF glow/shadow, flat quad, Blinn-Phong mesh, re-uploadable dynamic mesh, overlay) |
| `shaders.ts` | GLSL sources (rounded-slab SDF mask + rim, gaussian-erf glow, mesh lighting) |
| `primitives.ts` | plane/box/sphere/cylinder generators + custom polygonal geometry (arbitrary positions/indices, auto-computed normals) |
| `scene.ts` | Retained client store for scene-vocabulary nodes (tracks a geometry revision so dynamic meshes re-upload only on change) |
| `scene-types.ts` | The scene vocabulary: node kinds, validation (incl. custom geometry), `$token` colors, `SceneTheme` (shared with the server) |
| `picking.ts` | Camera-ray → slab-local px conversion; ray-primitive and ray-triangle (custom mesh) hit tests |
| `overlay-2d.ts` | Screen-space 2D chrome canvas composited as the final pass |

## Design

X11-style display server model, now with a 3D presentation layer:
1. Objects request surfaces from the UIServer (an Abject)
2. UIServer delegates to the Compositor for rendering and retains state
   (draw batches, scene nodes, slab transforms, scene theme) for reconnect
   replay
3. Input events route from canvas → ray-picked surface → owning object,
   with surface-local coordinates from the ray hit
4. Each object draws to its own `OffscreenCanvas` (isolation); 3D content
   attaches via the scene vocabulary (`scene` / `setSurfaceTransform` on
   UIServer)
5. The compositor renders all slabs + scene nodes + overlay chrome per frame
