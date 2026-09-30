# src/ui/gl/ - WebGL2 Renderer

Minimal hand-rolled WebGL2 layer under the 3D Compositor (no three.js). The
renderer is deliberately dumb: it owns the GL context, shaders, buffers, and
textures and exposes typed draw calls; all scene and layout decisions live in
`src/ui/compositor.ts`. Self-contained modules (particles, lines, sky, post
effects) draw through `renderer.context` with their own programs and restore
the renderer's GL state contract when done.

Everything a scene node can say is data validated in `scene-types.ts`; the
simulation (animation, particles, dragging, orbit cameras) runs client-side
off the render loop, so the wire only ever carries declarative specs.

## Files

Core
- **renderer.ts**: `GlRenderer`. Context/program/buffer/texture ownership,
  typed draw calls, premultiplied source-over blending (matches canvas2d
  compositing), transparent backbuffer so the desktop backdrop shows through,
  mesh program variants per shading mode, shadow maps, bloom.
- **shaders.ts**: GLSL sources for the slab, glow, mesh, shadow and bloom
  programs (mobile-portable: matched highp, int flags, constant loops).
- **program-cache.ts**: compile cache for self-contained modules; records a
  failed build once and degrades to drawing nothing.
- **camera.ts**: the scene camera definition shared by the compositor and
  WidgetManager's `getSceneParams`.
- **math.ts** / **picking.ts**: vector/matrix helpers; camera-ray hit testing
  for slabs, meshes and planes.
- **overlay-2d.ts**: screen-space 2D overlay pass drawn above the 3D scene.

Scene vocabulary
- **scene-types.ts**: node kinds, primitives, params and their validators;
  `$token` colours resolved from the active theme.
- **scene.ts**: `SceneStore`, the retained node trees (window subtrees and
  world namespaces), parameter inheritance and world matrices.
- **scene-presets.ts**: built-in material and look presets (the SceneLibrary
  Abject adds registered ones) and their validators.
- **material.ts**: resolves node params, presets and the environment into
  renderer draw options (materials, lights, sky, tone mapping, grading).
- **shadow-fit.ts**: directional and spot shadow frusta fitted to casters.
- **primitives.ts**: unit geometry for the built-in shapes, plus parametric
  capsule, roundedBox, grid, tube, lathe and extrude (`getShapeGeometry`).
- **triangulate.ts**: polygon triangulation with holes (extrude, 3D text).

Content kinds
- **gltf.ts**: glTF 2.0 / GLB parsing, scene flattening and node animation
  for `model` nodes (pure data, runs in Node too).
- **text-geometry.ts**: extruded 3D text for `text` nodes.
- **label-texture.ts**: crisp camera-facing label textures for `label` nodes.
- **line-renderer.ts**: thick screen-space lines, ribbons and trails.
- **sky-renderer.ts**: the sky dome for `sky` nodes.

Motion and effects
- **gpu-particles.ts**: particle emitters simulated in the vertex shader, one
  instanced draw per emitter.
- **anim-tracks.ts**: keyframes, springs, motion presets and the lookAt /
  follow constraints (pure math).
- **orbit-camera.ts**: window camera nodes (off-axis, glued to the window)
  and the orbit controller.
- **post-effects.ts**: per-subtree SSAO, depth of field, outlines, light
  shafts, FXAA, chromatic aberration, vignette and grain, with a quality
  governor.
- **slab-motion.ts**: declarative whole-window effects and transitions.
