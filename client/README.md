# client/ - Browser Frontend Client

Thin rendering client that connects to the Node.js backend over WebSocket. The browser handles only canvas drawing, input capture, and local hit-testing. All object logic runs on the server.

## Connection Lifecycle

```
Browser                              Server (backend-ui.ts)
  │                                        │
  │  1. WebSocket connect (:7719)          │
  ├───────────────────────────────────────→│
  │                                        │
  │  2. "ready" message                    │
  ├───────────────────────────────────────→│
  │                                        │
  │  3. Full state replay                  │
  │     (createSurface × N, draw × N)     │
  │←───────────────────────────────────────┤
  │                                        │
  │  4. Steady-state loop                  │
  │     draw, surface ops ←────────────── │
  │     input events ─────────────────→   │
  │     measure requests ←────────────── │
  │     measure replies ──────────────→   │
  │                                        │
  │  5. Disconnect / reconnect             │
  │     → goto step 1 (full replay)        │
```

## Files

### index.html

Static HTML shell.

- Full-screen dark canvas (`#0f1019` background, no scrollbars)
- Loads Inter font from Google Fonts
- Container: `<div id="app">` target for canvas creation

### index.ts

Browser entry point.

- Reads `VITE_WS_PORT` (default `7719`) for WebSocket connection
- Creates full-screen `<canvas>` element in `#app`
- Instantiates `FrontendClient` and calls `connect()`
- Exposes `window.frontendClient` for debugging

### frontend-client.ts

Core client class. Owns the Canvas, Compositor, and WebSocket connection.

**Rendering (Backend → Browser):**
- Receives draw commands over WebSocket, dispatches to local `Compositor`
- Manages surfaces (create, destroy, move, resize, z-order, visibility)
- Responds to `measureTextRequest` using Canvas 2D `measureText()`
- Responds to `displayInfoRequest` with canvas dimensions
- Workspace filtering hides surfaces not in the active workspace

**Input (Browser → Backend):**
- Mouse events: local hit-test via `compositor.surfaceAt()`, converts to surface-local coordinates
- Keyboard events: forwarded to focused surface
- Wheel events: forwarded with delta and modifiers
- Clipboard: paste sends text content, copy/cut use selection buffer
- Mouse grab: mousedown locks events to a surface until mouseup (enables window dragging)

**Key state:**
- `focusedSurface` — receives keyboard events
- `grabbedSurface` — receives all mouse events during drag
- `currentSelectedText` — clipboard selection buffer

## Build

```bash
pnpm client          # Dev server on port 5174
```

Configured via `vite.client.config.ts` (root: `client/`, output: `dist-client/`).

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_WS_PORT` | `7719` | Backend WebSocket port |
| `VITE_CLIENT_PORT` | `5174` | Client dev server port |
