# src/ui/gl/ - WebGL2 Renderer

Minimal hand-rolled WebGL2 layer under the 3D Compositor (no three.js). The
renderer is deliberately dumb: it owns the GL context, shaders, buffers, and
textures and exposes typed draw calls; all scene and layout decisions live in
`src/ui/compositor.ts`.

## Files

- **renderer.ts**: `GlRenderer`. Context/program/buffer/texture ownership,
  typed draw calls, premultiplied source-over blending (matches canvas2d
  compositing), transparent backbuffer so the abyss background shows through.
- **shaders.ts**: GLSL sources for the slab/mesh/overlay programs.
- **scene.ts** / **scene-types.ts**: the retained scene vocabulary (mesh,
  light, and group nodes; `$token` colors resolved from the active theme)
  that windows attach 3D content to.
- **primitives.ts**: mesh builders for the built-in shapes.
- **picking.ts**: camera-ray hit testing per slab, with per-pixel alpha test
  for input routing.
- **math.ts**: vector/matrix helpers.
- **overlay-2d.ts**: screen-space 2D overlay pass drawn above the 3D scene.
