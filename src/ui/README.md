# src/ui/ - User Interface Layer

Browser application shell and canvas-based rendering. Uses an X11-style compositor model where each object gets isolated drawing surfaces.

## Files

### app.ts

Application shell and bootstrap.

- **`App`**: creates canvas element, Compositor, UIServer, Runtime
  - `start()` → starts Runtime, sets up input listeners (mouse, keyboard)
  - Accessors: `appRuntime`, `appCompositor`, `appUIServer`
- **`createApp({ container, debug? })`**: factory function for one-line bootstrap

### compositor.ts

Canvas-based surface compositor.

- **Surface model**: each surface is an `OffscreenCanvas` with its own 2D context
  - Properties: `id`, `objectId`, `rect` (position/size), `zIndex`, `visible`, `dirty`
- **Render loop**: `requestAnimationFrame`, only renders when `needsRender` flag is set
- **Z-order**: surfaces sorted by `zIndex`, drawn bottom-to-top
- **DPI-aware**: scales canvas by `devicePixelRatio`
- **Draw commands**: `rect` (optional rounded corners), `text`, `line`, `image`, `path`, `clear`
- **Hit testing**: `surfaceAt(x, y)` iterates reverse z-order for topmost visible surface
- **Surface management**: `createSurface()`, `destroySurface()`, `moveSurface()`, `resizeSurface()`, `setZIndex()`, `setVisible()`

## Design

This follows the X11 display server model:
1. Objects request surfaces from the UIServer (an Abject)
2. UIServer delegates to Compositor for actual rendering
3. Input events are routed from canvas → surface under pointer → owning object
4. Each object draws to its own `OffscreenCanvas` (isolation)
5. The compositor composites all surfaces onto the main canvas each frame
