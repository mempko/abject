# src/ui/gl/ - WebGL2 Engine and Scene Vocabulary

The hand-rolled WebGL2 layer under the Compositor (no three.js), and the
scene vocabulary every Abject uses to put 3D content on the desktop. The
renderer is deliberately dumb: it owns the GL context, shaders, buffers and
textures and exposes typed draw calls; scene and layout decisions live in
`src/ui/compositor.ts`. Self-contained modules (particles, lines, sky, post
effects) draw through `renderer.context` with their own programs and restore
the renderer's GL state when done.

Everything a scene node can say is data, validated by `scene-types.ts`. The
simulation (animation, springs, particles, dragging, orbit cameras, slab
motion) runs in the browser off the render loop, so the wire only ever
carries declarative specs.

## Architecture

```
  Abject ──scene { ops }──▶ WindowAbject ──▶ UIServer (BackendUI)
                                              validateSceneOps (scene-types.ts),
                                              retains nodes for replay
                                                    │ sceneOps (wire)
                                                    ▼
  browser:  Compositor.applySceneOps / applyWorldSceneOps
              └─▶ SceneStore (scene.ts)           retained nodes, keyed by surface
                    or `world:<owner>`, resolveParams (inheritance), worldMatrix
                      └─▶ material.ts             params + presets + environment
                            │                     → draw options
                            ▼
                    GlRenderer (renderer.ts)      slabs, meshes, shadows, bloom
                    + modules                     gpu-particles, line-renderer,
                                                  sky-renderer, post-effects,
                                                  label-texture, text-geometry, gltf
```

A window's own slab is the root of its subtree (kind `surface`, managed by
the Compositor); vocabulary nodes attach to it and inherit its transform, so
3D content travels with its window. World nodes belong to an owner Abject and
draw behind, above or between the windows.

## The Vocabulary

A `SceneOp` is `{ op: 'add' | 'update' | 'remove' | 'animate', id, parentId?,
kind?, transform?, params? }`. Units are px, x right, y down, +z toward the
viewer; rotations are Euler radians.

| Kind | What it is |
|---|---|
| `group` | Transform and inherited params for its children |
| `mesh` | A primitive (`plane`, `box`, `sphere`, `cylinder`, `cone`, `torus`, `icosphere`, `ring`, and parametric `capsule`, `roundedBox`, `grid`, `tube`, `lathe`, `extrude`) or custom geometry; optional instances |
| `light` | `point`, `directional`, `spot`, `hemisphere`; optional shadows |
| `environment` | Ambient, fog, tone mapping, grading, `look` presets, bloom and post effects for its subtree |
| `canvas` | A 2D layer painted by draw commands (see [../README.md](../README.md)) |
| `particles` | A GPU particle emitter |
| `camera` | The subtree's camera, optionally orbiting under the user's hand |
| `model` | glTF 2.0 / GLB from a URL, data URI or `abx:sha256:` ref |
| `text` | Extruded 3D text |
| `label` | Crisp camera-facing 2D text |
| `line` | Thick screen-space lines and ribbons |
| `sky` | A dome behind the rest of its subtree |

Materials take `standard`, `unlit`, `toon`, `matcap` or `rim` shading,
`normal` or `additive` blending, texture maps, and a `material` preset name.
Colours are `#hex` or `$token` (`SCENE_THEME_TOKENS`), resolved against the
active theme. `animate` takes a channel tween, a path, or a preset (`spin`,
`orbit`, `bob`, `pulse`, `shake`, `flash`, `float`, `wobble`, `breathe`,
`hover`). Window clipping is `clip: 'content'` (default), `'window'` or
`'none'`. The full live reference (kinds, params, presets, limits, camera
values) is what WidgetManager's `getSceneParams` returns.

## Files

Core

- **`renderer.ts`**: `GlRenderer`. Context, program, buffer and texture
  ownership; typed draw calls (slab, glow, flat quad, meshes with shading
  variants and instancing, overlay); premultiplied source-over blending to
  match canvas2d; a transparent backbuffer so the desktop backdrop shows
  through; shadow maps and bloom; guarded texture upload; context-loss
  recovery.
- **`shaders.ts`**: GLSL for the slab, glow, flat, bloom, overlay, depth
  (shadow), outline and mesh programs, written to the mobile portability rules.
  Exports `MAX_MESH_LIGHTS` and `SHADOW_SIZE`.
- **`program-cache.ts`**: compile cache for the self-contained modules. A
  program that fails on this GPU is recorded once and every later request
  returns null, so the module draws nothing instead of throwing.
  `restoreRendererState` puts back the state GlRenderer relies on;
  `contextGeneration` tells modules to rebuild after context loss.
- **`camera.ts`**: the scene camera definition (`CAMERA_FOV_Y`,
  `cameraDistance`): the z = 0 plane maps 1:1 to CSS px. Shared by the
  Compositor and WidgetManager's `getSceneParams`.
- **`math.ts`**: column-major `Mat4` / vector helpers; the projection bakes in
  the y flip.
- **`picking.ts`**: screen point to world ray; ray hits on slab planes,
  primitives and triangles.
- **`overlay-2d.ts`**: `Overlay2D`, a viewport-sized 2D canvas composited last
  for screen-space chrome; uploads only when it changed.

Scene vocabulary

- **`scene-types.ts`**: node kinds, primitives, shading and blend modes, world
  layers, clip modes, `SceneOp`, `SceneTheme`, `normalizeSceneOps`,
  `validateSceneOps` (loud, human-readable problems), `$token` colour
  resolution.
- **`scene.ts`**: `SceneStore`, the retained nodes, with deep-merged geometry
  updates, revision counters so meshes and canvas layers re-upload only on
  change, parameter inheritance (`resolveParams`) and `worldMatrix`.
- **`scene-presets.ts`**: built-in `material` and `look` presets and their
  validators; the SceneLibrary Abject registers more and pushes the merged
  library through UIServer to every client.
- **`material.ts`**: resolves node params, presets and the environment into
  renderer options (materials, lights, sky, tone mapping, grading). Presets
  merge under the node's own params.
- **`shadow-fit.ts`**: directional and spot shadow frusta fitted to the
  casters' bounds.
- **`primitives.ts`**: unit geometry for the built-in shapes and the parametric
  ones (`getShapeGeometry`), cached per shape.
- **`triangulate.ts`**: ear-clipping triangulation with holes (extrude, 3D
  text).

Content kinds

- **`gltf.ts`**: glTF 2.0 / GLB parsing, scene flattening and node animation for
  `model` nodes. Pure data; runs in Node too. Skins parse but draw in bind
  pose.
- **`text-geometry.ts`**: extruded 3D text, traced from a rasterized glyph
  canvas (browser only).
- **`label-texture.ts`**: label textures at device pixel ratio, camera-facing
  quads (browser only).
- **`line-renderer.ts`**: thick lines with mitred or round joins, dashes,
  per-point colour and width, ribbons and trails.
- **`sky-renderer.ts`**: the sky dome (gradient or equirectangular image, sun,
  stars) for any camera.

Motion and effects

- **`gpu-particles.ts`**: emitters simulated in the vertex shader, one
  instanced draw per emitter; the CPU only spawns. Exports
  `MAX_GPU_PARTICLES`.
- **`anim-tracks.ts`**: keyframes, easings, springs, motion presets, and the
  `lookAt` / follow constraints. Pure math shared with the server.
- **`orbit-camera.ts`**: off-axis window cameras and the orbit controller
  (drag to turn, wheel to dolly, damped coasting, clamps).
- **`post-effects.ts`**: per-subtree SSAO, depth of field, outlines, light
  shafts, FXAA, chromatic aberration, vignette and grain, with a frame-time
  governor that steps quality down and back up.
- **`slab-motion.ts`**: the declarative whole-window effects and transitions
  (open, close, minimize, restore, workspace-in) and the modal depth style.
  Built-ins are a default library; WidgetManager lets any Abject play,
  register or replace them.

## Adding a Node Kind or Param

1. Declare it in `scene-types.ts` (kind list, params doc on `SceneOp`) and
   validate it there with a message that tells the author what to send. The
   server runs this validation, so a bad op is refused before it reaches any
   browser.
2. Store it: `scene.ts` needs nothing for plain params; inherited material
   params resolve through `resolveParams`.
3. Draw it in the Compositor, through `GlRenderer` or a self-contained module
   that builds its programs with `program-cache.ts` and calls
   `restoreRendererState` when done.
4. Describe it in WidgetManager's ask guide, which is how Abjects learn the
   vocabulary.

## Gotchas

- **Portable shaders.** Phones (Adreno and similar) reject shaders that
  desktop GPUs accept. Match `highp` on both stages, use int flags, keep loop
  bounds constant. A module program that fails anyway draws nothing (program
  cache); a mesh variant that fails falls back to standard shading, then to
  skipping mesh draws ("no 3D") while the 2D desktop keeps rendering.
- **Restore GL state.** A module that changes blending, depth, culling, the
  bound vertex array or the active texture unit must call
  `restoreRendererState` before returning.
- **Pure modules run in Node.** `scene-types.ts`, `slab-motion.ts`,
  `scene-presets.ts`, `camera.ts` and `anim-tracks.ts` (through
  GraphWidget's layout) are imported by server code, and WidgetManager
  imports constants from `gpu-particles.ts` and `shaders.ts`. Nothing in them
  may touch the DOM, a canvas or GL at load time. `gltf.ts` is written to the
  same rule.
- **Premultiplied alpha everywhere.** Shaders output premultiplied colour and
  textures upload premultiplied, so 2D canvas content composites without
  fringes.
- **Light intensity is linear.** It multiplies the colour (capped at
  `MAX_LIGHT_INTENSITY`); reach is `range`, not intensity.
- **Context loss.** Programs, buffers and textures are gone after a lost
  context; modules check `contextGeneration` and rebuild.

## Related

- [../README.md](../README.md): the Compositor that drives this engine
- [../../objects/widgets/README.md](../../objects/widgets/README.md): windows,
  canvas layers, GraphWidget, motion APIs
- [../../../client/README.md](../../../client/README.md): the browser client
