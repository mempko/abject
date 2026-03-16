/**
 * UI Server — X11-style display server. Manages surfaces, draw commands,
 * and routes input events to surface owners.
 */

import {
  AbjectId,
  AbjectMessage,
  InterfaceId,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require } from '../core/contracts.js';
import { event, request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import {
  Compositor,
  Rect,
  DrawCommand,

} from '../ui/compositor.js';

const UI_INTERFACE: InterfaceId = 'abjects:ui';

const WIDGET_FONT = '14px system-ui';

export interface InputEvent {
  type: 'mousedown' | 'mouseup' | 'mousemove' | 'mouseleave' | 'keydown' | 'keyup' | 'wheel' | 'paste';
  surfaceId?: string;
  x?: number;
  y?: number;
  button?: number;
  key?: string;
  code?: string;
  modifiers?: {
    shift: boolean;
    ctrl: boolean;
    alt: boolean;
    meta: boolean;
  };
  deltaX?: number;
  deltaY?: number;
  pasteText?: string;
}

/**
 * X11-style display server. Manages surfaces, draw commands, and routes input events to surface owners.
 * Most objects should use WidgetManager instead of UIServer directly.
 */
export class UIServer extends Abject {
  private compositor?: Compositor;
  private surfaceOwners: Map<string, AbjectId> = new Map();
  private focusedSurface?: string;
  private grabbedSurface?: string;  // Mouse capture: routes events during drag
  private mouseGrabAbject?: AbjectId;  // WindowManager grabs mouse during drag
  private lastHoveredSurfaceId?: string;  // Track surface under cursor for mouseleave synthesis
  private consoleId?: AbjectId;
  private windowManagerId?: AbjectId;
  private currentSelectedText = '';
  private lastMouseX = 0;
  private lastMouseY = 0;
  private lastMonitorMoveTime = 0;

  constructor() {
    super({
      manifest: {
        name: 'UIServer',
        description:
          'X11-style display server. Manages surfaces, draw commands, and routes input events to surface owners. Use cases: draw shapes/text/images directly on surfaces, handle raw mouse and keyboard input events.',
        version: '1.0.0',
        interface: {
            id: UI_INTERFACE,
            name: 'UI',
            description: 'Surface management and input routing',
            methods: [
              {
                name: 'createSurface',
                description: 'Create a new drawing surface. Example: const surfaceId = await this.call(this.dep("UIServer"), "createSurface", { rect: { x: 100, y: 100, width: 300, height: 200 }, zIndex: 100 })',
                parameters: [
                  {
                    name: 'rect',
                    type: { kind: 'reference', reference: 'Rect' },
                    description: 'Surface position and size',
                  },
                  {
                    name: 'zIndex',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'Z-ordering (higher = on top)',
                    optional: true,
                  },
                  {
                    name: 'inputPassthrough',
                    type: { kind: 'primitive', primitive: 'boolean' },
                    description: 'If true, surface is display-only — input events pass through to surfaces behind it',
                    optional: true,
                  },
                  {
                    name: 'inputMonitor',
                    type: { kind: 'primitive', primitive: 'boolean' },
                    description: 'If true, surface receives a copy of all mouse/wheel events (in surface-local coordinates) before normal hit-test routing. Use with inputPassthrough for cursor-following overlays.',
                    optional: true,
                  },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'destroySurface',
                description: 'Destroy a surface. Example: await this.call(this.dep("UIServer"), "destroySurface", { surfaceId })',
                parameters: [
                  {
                    name: 'surfaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The surface to destroy',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'draw',
                description: 'Execute draw commands on a surface. Each command has exactly 3 fields: { type, surfaceId, params }. ' +
                  'Valid types: "clear", "rect", "text", "line", "path", "save", "restore", "clip", "translate", "image", "imageUrl", ' +
                  '"circle" (params: { cx, cy, radius, fill?, stroke?, lineWidth? }), ' +
                  '"arc" (params: { cx, cy, radius, startAngle, endAngle, fill?, stroke?, lineWidth?, counterclockwise? }), ' +
                  '"ellipse" (params: { cx, cy, radiusX, radiusY, rotation?, fill?, stroke?, lineWidth? }), ' +
                  '"polygon" (params: { points: [{x,y}...], fill?, stroke?, lineWidth?, closePath? }), ' +
                  '"rotate" (params: { angle }), "scale" (params: { x, y }), ' +
                  '"globalAlpha" (params: { alpha }), "shadow" (params: { color, blur, offsetX?, offsetY? }), ' +
                  '"setLineDash" (params: { segments }), ' +
                  '"linearGradient" (params: { x0, y0, x1, y1, stops: [{offset, color}...] }), ' +
                  '"radialGradient" (params: { cx0, cy0, r0, cx1, cy1, r1, stops: [{offset, color}...] }). ' +
                  '"imageUrl" (params: { x, y, width?, height?, url }) — draws an image from a URL or data URI. ' +
                  'IMPORTANT: Use "fill" for fill color (NOT "color"), "stroke" for stroke color, "rect" (NOT "fillRect"), "text" (NOT "fillText"). ' +
                  'Always nest parameters inside "params", NOT as flat top-level fields.',
                parameters: [
                  {
                    name: 'commands',
                    type: {
                      kind: 'array',
                      elementType: { kind: 'reference', reference: 'DrawCommand' },
                    },
                    description: 'Array of { type, surfaceId, params } draw commands',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'moveSurface',
                description: 'Move a surface. Example: await this.call(uiId, "abjects:ui", "moveSurface", { surfaceId, x: 200, y: 100 })',
                parameters: [
                  {
                    name: 'surfaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The surface to move',
                  },
                  {
                    name: 'x',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'New x position',
                  },
                  {
                    name: 'y',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'New y position',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'resizeSurface',
                description: 'Resize a surface. Example: await this.call(uiId, "abjects:ui", "resizeSurface", { surfaceId, width: 400, height: 300 })',
                parameters: [
                  {
                    name: 'surfaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The surface to resize',
                  },
                  {
                    name: 'width',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'New width',
                  },
                  {
                    name: 'height',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'New height',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'setZIndex',
                description: 'Set surface z-index',
                parameters: [
                  {
                    name: 'surfaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The surface',
                  },
                  {
                    name: 'zIndex',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'New z-index',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'focus',
                description: 'Set keyboard focus to a surface',
                parameters: [
                  {
                    name: 'surfaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The surface to focus',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getDisplayInfo',
                description: 'Get display dimensions',
                parameters: [],
                returns: {
                  kind: 'object',
                  properties: {
                    width: { kind: 'primitive', primitive: 'number' },
                    height: { kind: 'primitive', primitive: 'number' },
                  },
                },
              },
              {
                name: 'setSurfaceVisible',
                description: 'Show or hide a surface without destroying it',
                parameters: [
                  {
                    name: 'surfaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The surface to show/hide',
                  },
                  {
                    name: 'visible',
                    type: { kind: 'primitive', primitive: 'boolean' },
                    description: 'Whether the surface should be visible',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'measureText',
                description: 'Measure the pixel width of text on a surface',
                parameters: [
                  {
                    name: 'surfaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The surface to measure on',
                  },
                  {
                    name: 'text',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The text to measure',
                  },
                  {
                    name: 'font',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'CSS font string',
                    optional: true,
                  },
                ],
                returns: { kind: 'primitive', primitive: 'number' },
              },
              {
                name: 'setSurfaceWorkspace',
                description: 'Tag a surface with a workspace ID for compositor filtering',
                parameters: [
                  {
                    name: 'surfaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The surface to tag',
                  },
                  {
                    name: 'workspaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The workspace ID',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'setActiveWorkspace',
                description: 'Set the active workspace for compositor filtering',
                parameters: [
                  {
                    name: 'workspaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The workspace ID to activate',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
            events: [
              {
                name: 'input',
                description: 'Input event (mouse, keyboard, paste)',
                payload: { kind: 'reference', reference: 'InputEvent' },
              },
              {
                name: 'focus',
                description: 'Surface gained/lost focus',
                payload: {
                  kind: 'object',
                  properties: {
                    surfaceId: { kind: 'primitive', primitive: 'string' },
                    focused: { kind: 'primitive', primitive: 'boolean' },
                  },
                },
              },
            ],
          },
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.UI_SURFACE, Capabilities.UI_INPUT],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('createSurface', async (msg: AbjectMessage) => {
      const { rect, zIndex, inputPassthrough, inputMonitor } = msg.payload as {
        rect: Rect; zIndex?: number; inputPassthrough?: boolean; inputMonitor?: boolean;
      };
      return this.createSurface(msg.routing.from, rect, zIndex, inputPassthrough, inputMonitor);
    });

    this.on('destroySurface', async (msg: AbjectMessage) => {
      const { surfaceId } = msg.payload as { surfaceId: string };
      return this.destroySurface(msg.routing.from, surfaceId);
    });

    this.on('draw', async (msg: AbjectMessage) => {
      const { commands } = msg.payload as { commands: DrawCommand[] };
      return this.executeDraw(msg.routing.from, commands);
    });

    this.on('moveSurface', async (msg: AbjectMessage) => {
      const { surfaceId, x, y } = msg.payload as {
        surfaceId: string;
        x: number;
        y: number;
      };
      return this.moveSurface(msg.routing.from, surfaceId, x, y);
    });

    this.on('resizeSurface', async (msg: AbjectMessage) => {
      const { surfaceId, width, height } = msg.payload as {
        surfaceId: string;
        width: number;
        height: number;
      };
      return this.resizeSurface(msg.routing.from, surfaceId, width, height);
    });

    this.on('setZIndex', async (msg: AbjectMessage) => {
      const { surfaceId, zIndex } = msg.payload as {
        surfaceId: string;
        zIndex: number;
      };
      return this.setZIndex(msg.routing.from, surfaceId, zIndex);
    });

    this.on('focus', async (msg: AbjectMessage) => {
      const { surfaceId } = msg.payload as { surfaceId: string };
      return this.setFocus(msg.routing.from, surfaceId);
    });

    this.on('getDisplayInfo', async () => {
      return this.getDisplayInfo();
    });

    this.on('measureText', async (msg: AbjectMessage) => {
      const { surfaceId, text, font } = msg.payload as {
        surfaceId: string;
        text: string;
        font?: string;
      };
      return this.measureTextWidthWithFont(surfaceId, text, font ?? WIDGET_FONT);
    });

    this.on('setSurfaceVisible', async (msg: AbjectMessage) => {
      const { surfaceId, visible } = msg.payload as { surfaceId: string; visible: boolean };
      this.compositor?.setVisible(surfaceId, visible);
      return true;
    });

    this.on('setSurfaceWorkspace', async (msg: AbjectMessage) => {
      const { surfaceId, workspaceId } = msg.payload as { surfaceId: string; workspaceId: string };
      this.compositor?.setSurfaceWorkspace(surfaceId, workspaceId);
      return true;
    });

    this.on('setActiveWorkspace', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      this.compositor?.setActiveWorkspace(workspaceId);
      return true;
    });

    this.on('selectionChanged', async (msg: AbjectMessage) => {
      const { selectedText } = msg.payload as { selectedText: string };
      this.currentSelectedText = selectedText;
    });

    this.on('registerWindowManager', async (msg: AbjectMessage) => {
      this.windowManagerId = msg.routing.from;
      return true;
    });

    // Two-phase drag: WindowAbject sends requestDrag when a chromeless+draggable
    // window's empty area is clicked. We set the mouse grab and tell WindowManager
    // to start the drag using the last known mouse position.
    this.on('requestDrag', async (msg: AbjectMessage) => {
      const { surfaceId } = msg.payload as { surfaceId: string };
      if (!this.windowManagerId || !surfaceId) return;
      const surface = this.compositor?.getSurface(surfaceId);
      if (!surface) return;
      this.mouseGrabAbject = this.windowManagerId;
      this.send(event(this.id, this.windowManagerId,
        'startDrag', {
          surfaceId,
          globalX: this.lastMouseX,
          globalY: this.lastMouseY,
        }));
    });

    this.on('objectUnregistered', async (msg: AbjectMessage) => {
      const objectId = msg.payload as AbjectId;
      this.destroySurfacesForObject(objectId);
    });
  }

  protected override async onInit(): Promise<void> {
    this.consoleId = await this.discoverDep('Console') ?? undefined;

    const registryId = await this.discoverDep('Registry') ?? undefined;
    if (registryId) {
      try {
        await this.request(request(this.id, registryId,
          'subscribe', {}));
      } catch { /* best effort */ }
    }
  }

  private async log(level: string, message: string, data?: unknown): Promise<void> {
    if (!this.consoleId) return;
    try {
      await this.send(
        request(this.id, this.consoleId, level, { message, data })
      );
    } catch { /* logging should never break the caller */ }
  }

  protected override getSourceForAsk(): string | undefined {
    return `## UIServer Usage Guide

### Creating and Using Surfaces

Create a surface:
  const surfaceId = await this.call(this.dep('UIServer'), 'createSurface',
    { rect: { x: 100, y: 100, width: 300, height: 200 }, zIndex: 100 });

Create a display-only surface (input events pass through to surfaces behind it):
  const surfaceId = await this.call(this.dep('UIServer'), 'createSurface',
    { rect: { x: 0, y: 0, width, height }, zIndex: 50, inputPassthrough: true });

Create a cursor-following overlay (receives all mouse events without blocking input to surfaces behind):
  const surfaceId = await this.call(this.dep('UIServer'), 'createSurface',
    { rect: { x: 0, y: 0, width, height }, zIndex: 9999, inputPassthrough: true, inputMonitor: true });

Destroy a surface:
  await this.call(this.dep('UIServer'), 'destroySurface', { surfaceId });

### Drawing

Each draw command has exactly 3 fields: { type, surfaceId, params }

  await this.call(this.dep('UIServer'), 'draw', {
    commands: [
      { type: 'clear', surfaceId, params: {} },
      { type: 'rect', surfaceId, params: { x: 0, y: 0, width: 300, height: 200, fill: '#1e1e2e' } },
      { type: 'rect', surfaceId, params: { x: 10, y: 10, width: 80, height: 30, fill: '#4a4a6e', stroke: '#666', radius: 4 } },
      { type: 'text', surfaceId, params: { x: 150, y: 100, text: 'Hello', font: '24px system-ui', fill: '#ffffff', align: 'center', baseline: 'middle' } },
      { type: 'line', surfaceId, params: { x1: 0, y1: 50, x2: 300, y2: 50, stroke: '#444', lineWidth: 1 } },
      { type: 'path', surfaceId, params: { path: 'M10 10 L50 50 L10 50 Z', fill: '#ff0000' } },
    ]
  });

### Draw Command Types

**Basic shapes:**
'clear' - Clear surface. params: {} (transparent) or { color: '#rrggbb' } (opaque fill)
          IMPORTANT: Transparent pixels do NOT receive mouse input. Use { color: '#rrggbb' } or
          draw an opaque 'rect' background immediately after clearing.
'rect'  - Rectangle. params: { x, y, width, height, fill?, stroke?, lineWidth?, radius? }
'text'  - Text. params: { x, y, text, font?, fill?, stroke?, strokeWidth?, align?, baseline? }
'line'  - Line. params: { x1, y1, x2, y2, stroke?, lineWidth? }
'path'  - SVG path. params: { path (SVG path string), fill?, stroke?, lineWidth? }
'circle' - Circle. params: { cx, cy, radius, fill?, stroke?, lineWidth? }
'arc'   - Arc/pie slice. params: { cx, cy, radius, startAngle, endAngle, fill?, stroke?, lineWidth?, counterclockwise? }
          Filled arcs draw as pie slices (lineTo center + closePath).
'ellipse' - Ellipse. params: { cx, cy, radiusX, radiusY, rotation?, fill?, stroke?, lineWidth? }
'polygon' - Polygon/polyline. params: { points: [{x,y}...], fill?, stroke?, lineWidth?, closePath? }
'image' - Draw raw image object. params: { x, y, width?, height?, data (ImageBitmap | HTMLImageElement | ImageData) }
          For URLs or data URIs (including HttpClient.getBase64() results), use 'imageUrl' instead.
'imageUrl' - Draw image from URL or data URI. params: { x, y, width?, height?, url }
          Use with HttpClient.getBase64() to display fetched images:
          1. const img = await this.call(this.dep('HttpClient'), 'getBase64', { url: imageUrl });
          2. { type: 'imageUrl', surfaceId, params: { x: 0, y: 0, width: 300, height: 200, url: img.dataUri } }

**State management:**
'save'  - Save canvas state. params: {}
'restore' - Restore canvas state. params: {}
'clip'  - Set clipping region. params: { x, y, width, height }

**Transforms:**
'translate' - Translate origin. params: { x, y }
'rotate' - Rotate canvas. params: { angle } (radians)
'scale'  - Scale canvas. params: { x, y }

**Gradients & effects (state-setters, use with save/restore):**
'globalAlpha' - Set transparency. params: { alpha } (0-1)
'shadow' - Set shadow. params: { color, blur, offsetX?, offsetY? }
'setLineDash' - Set dash pattern. params: { segments } (e.g. [5, 3])
'linearGradient' - Set fill+stroke to linear gradient. params: { x0, y0, x1, y1, stops: [{offset, color}...] }
'radialGradient' - Set fill+stroke to radial gradient. params: { cx0, cy0, r0, cx1, cy1, r1, stops: [{offset, color}...] }

IMPORTANT:
- Use 'fill' for fill color, NOT 'color'
- Use 'stroke' for stroke color, NOT 'strokeColor'
- Use 'rect' NOT 'fillRect'
- Use 'text' NOT 'fillText'
- Always nest parameters inside 'params', NOT as flat top-level fields

### Drawing Circles

  // Native circle: { type: 'circle', surfaceId, params: { cx: 100, cy: 100, radius: 30, fill: '#ff0000' } }

### Gradients & Effects Examples

  // Gradient-filled rectangle (use save/restore to scope state):
  { type: 'save', surfaceId, params: {} },
  { type: 'linearGradient', surfaceId, params: { x0: 0, y0: 0, x1: 200, y1: 0, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }] } },
  { type: 'rect', surfaceId, params: { x: 10, y: 10, width: 200, height: 50, fill: '#000' } },
  { type: 'restore', surfaceId, params: {} },

  // Shadow behind a shape:
  { type: 'save', surfaceId, params: {} },
  { type: 'shadow', surfaceId, params: { color: 'rgba(0,0,0,0.5)', blur: 10, offsetY: 4 } },
  { type: 'rect', surfaceId, params: { x: 20, y: 20, width: 100, height: 60, fill: '#333' } },
  { type: 'restore', surfaceId, params: {} },

  // Pie chart wedge:
  { type: 'arc', surfaceId, params: { cx: 150, cy: 150, radius: 80, startAngle: 0, endAngle: Math.PI / 2, fill: '#39ff8e' } }

### Other Methods

Move surface: this.call(this.dep('UIServer'), 'moveSurface', { surfaceId, x: 200, y: 100 })
Resize: this.call(this.dep('UIServer'), 'resizeSurface', { surfaceId, width: 400, height: 300 })
Set z-index: this.call(this.dep('UIServer'), 'setZIndex', { surfaceId, zIndex: 200 })
Get display size: const { width, height } = await this.call(this.dep('UIServer'), 'getDisplayInfo', {})
Measure text: const w = await this.call(this.dep('UIServer'), 'measureText', { surfaceId, text: 'Hello', font: '14px system-ui' })

### Background Pattern for Interactive Surfaces

Transparent pixels do NOT receive mouse input. For interactive surfaces, ALWAYS draw an opaque
background right after clearing:

  { type: 'clear', surfaceId, params: { color: '#1a1a2e' } }

Or equivalently:

  { type: 'clear', surfaceId, params: {} },
  { type: 'rect', surfaceId, params: { x: 0, y: 0, width: W, height: H, fill: '#1a1a2e' } },

### Input Events

UIServer sends 'input' events to surface owners. Keyboard events only arrive when the surface is focused
(user clicked on it). Event types: mousedown, mouseup, mousemove, keydown, keyup, wheel, paste.

Full event payload shape:
  { type, surfaceId, x, y, button, key, code, modifiers: { shift, ctrl, alt, meta }, deltaX, deltaY, text }

key vs code:
  key  = logical key produced: 'a', 'A', 'Enter', 'ArrowUp', ' ' (space)
  code = physical key location: 'KeyA', 'Enter', 'ArrowUp', 'Space'
  Use 'key' for character/command input. Use 'code' for positional controls (e.g. WASD).

Example handler with keyboard dispatch:
  async input(msg) {
    const { type, surfaceId, x, y, key, code, modifiers } = msg.payload;
    if (type === 'keydown') {
      if (key === 'ArrowUp') { /* move up */ }
      if (key === 'Enter') { /* confirm */ }
      if (modifiers.ctrl && key === 'z') { /* undo */ }
    }
    if (type === 'mousedown') { /* click at surface-local (x, y) */ }
    if (type === 'wheel') { /* scroll: deltaX, deltaY */ }
    if (type === 'paste') { /* pasted text in msg.payload.text */ }
  }`;
  }

  /**
   * Set the compositor.
   */
  setCompositor(compositor: Compositor): void {
    this.compositor = compositor;
  }

  /**
   * Setup input event listeners.
   */
  setupInputListeners(canvas: HTMLCanvasElement): void {
    canvas.tabIndex = 0;
    canvas.style.outline = 'none';

    canvas.addEventListener('mousedown', (e) => {
      canvas.focus();
      this.handleMouseEvent(e, 'mousedown');
    });
    canvas.addEventListener('mouseup', (e) => this.handleMouseEvent(e, 'mouseup'));
    canvas.addEventListener('mousemove', (e) => this.handleMouseEvent(e, 'mousemove'));
    canvas.addEventListener('wheel', (e) => this.handleWheelEvent(e));

    // Listen on document — more robust than window/canvas against browser extensions
    document.addEventListener('keydown', (e) => this.handleKeyEvent(e, 'keydown'));
    document.addEventListener('keyup', (e) => this.handleKeyEvent(e, 'keyup'));

    document.addEventListener('paste', (e) => this.handlePasteEvent(e));
    document.addEventListener('copy', (e) => this.handleCopyEvent(e));
    document.addEventListener('cut', (e) => this.handleCutEvent(e));
  }

  // ── Surface API ──────────────────────────────────────────────────────

  /**
   * Create a surface for an object.
   */
  private createSurface(
    objectId: AbjectId,
    rect: Rect,
    zIndex?: number,
    inputPassthrough?: boolean,
    inputMonitor?: boolean
  ): string {
    require(this.compositor !== undefined, 'Compositor not set');

    const surfaceId = this.compositor!.createSurface(
      objectId, rect, zIndex, undefined, inputPassthrough, inputMonitor
    );
    this.surfaceOwners.set(surfaceId, objectId);
    this.log('debug', 'createSurface', { surfaceId, objectId, rect, zIndex, inputPassthrough, inputMonitor });

    return surfaceId;
  }

  /**
   * Destroy a surface.
   */
  private destroySurface(objectId: AbjectId, surfaceId: string): boolean {
    if (this.surfaceOwners.get(surfaceId) !== objectId) {
      return false;
    }

    this.surfaceOwners.delete(surfaceId);
    this.log('debug', 'destroySurface', { surfaceId, objectId });
    return this.compositor?.destroySurface(surfaceId) ?? false;
  }

  /**
   * Destroy all surfaces owned by a given object (cleanup on unregister).
   */
  private destroySurfacesForObject(objectId: AbjectId): number {
    let count = 0;
    for (const [surfaceId, ownerId] of this.surfaceOwners.entries()) {
      if (ownerId === objectId) {
        this.surfaceOwners.delete(surfaceId);
        this.compositor?.destroySurface(surfaceId);
        if (this.focusedSurface === surfaceId) this.focusedSurface = undefined;
        if (this.grabbedSurface === surfaceId) this.grabbedSurface = undefined;
        count++;
      }
    }
    return count;
  }

  /**
   * Execute draw commands.
   */
  private executeDraw(objectId: AbjectId, commands: DrawCommand[]): boolean {
    require(this.compositor !== undefined, 'Compositor not set');
    this.log('debug', 'draw', { objectId, commandCount: commands.length });

    for (const cmd of commands) {
      if (this.surfaceOwners.get(cmd.surfaceId) !== objectId) {
        continue;
      }
      this.compositor!.draw(cmd);
    }

    return true;
  }

  /**
   * Move a surface.
   */
  private moveSurface(
    objectId: AbjectId,
    surfaceId: string,
    x: number,
    y: number
  ): boolean {
    if (this.surfaceOwners.get(surfaceId) !== objectId && objectId !== this.windowManagerId) {
      return false;
    }
    this.compositor?.moveSurface(surfaceId, x, y);
    return true;
  }

  /**
   * Resize a surface.
   */
  private resizeSurface(
    objectId: AbjectId,
    surfaceId: string,
    width: number,
    height: number
  ): boolean {
    if (this.surfaceOwners.get(surfaceId) !== objectId && objectId !== this.windowManagerId) {
      return false;
    }
    this.compositor?.resizeSurface(surfaceId, width, height);
    return true;
  }

  /**
   * Set z-index.
   */
  private setZIndex(
    objectId: AbjectId,
    surfaceId: string,
    zIndex: number
  ): boolean {
    if (this.surfaceOwners.get(surfaceId) !== objectId && objectId !== this.windowManagerId) {
      return false;
    }
    this.compositor?.setZIndex(surfaceId, zIndex);
    return true;
  }

  /**
   * Set keyboard focus.
   */
  private setFocus(objectId: AbjectId, surfaceId: string): boolean {
    if (this.surfaceOwners.get(surfaceId) !== objectId) {
      return false;
    }

    const oldFocus = this.focusedSurface;
    this.focusedSurface = surfaceId;

    if (oldFocus && oldFocus !== surfaceId) {
      const oldOwner = this.surfaceOwners.get(oldFocus);
      if (oldOwner) {
        this.sendFocusEvent(oldOwner, oldFocus, false);
      }
    }

    this.sendFocusEvent(objectId, surfaceId, true);

    return true;
  }

  /**
   * Get display info.
   */
  private getDisplayInfo(): { width: number; height: number } {
    return {
      width: this.compositor?.width ?? 0,
      height: this.compositor?.height ?? 0,
    };
  }

  /**
   * Measure text width with a specific font.
   */
  private measureTextWidthWithFont(surfaceId: string, text: string, font: string): number {
    if (!this.compositor || !text) return 0;
    const surface = this.compositor.getSurface(surfaceId);
    if (!surface) return 0;
    surface.ctx.font = font;
    return surface.ctx.measureText(text).width;
  }

  // ── Input Handling ───────────────────────────────────────────────────

  /**
   * Handle mouse events — find surface and forward input event to owner.
   * Async because mousedown may send a request to WindowManager.
   */
  private async handleMouseEvent(
    e: MouseEvent,
    type: 'mousedown' | 'mouseup' | 'mousemove'
  ): Promise<void> {
    const canvasRect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - canvasRect.left;
    const y = e.clientY - canvasRect.top;

    // Track last mouse position for requestDrag
    this.lastMouseX = x;
    this.lastMouseY = y;

    // ── Input monitors: broadcast mouse events to all monitor surfaces ──
    // Throttle mousemove to ~60fps to avoid flooding monitor mailboxes
    const now = performance.now();
    const shouldBroadcast = type !== 'mousemove' || (now - this.lastMonitorMoveTime >= 16);
    if (shouldBroadcast) {
      if (type === 'mousemove') this.lastMonitorMoveTime = now;
      const monitors = this.compositor?.getInputMonitors() ?? [];
      for (const mon of monitors) {
        const owner = this.surfaceOwners.get(mon.id);
        if (owner) {
          this.sendInputEvent(owner, {
            type,
            surfaceId: mon.id,
            x: x - mon.rect.x,
            y: y - mon.rect.y,
            button: e.button,
            modifiers: {
              shift: e.shiftKey,
              ctrl: e.ctrlKey,
              alt: e.altKey,
              meta: e.metaKey,
            },
          });
        }
      }
    }

    // ── WindowManager grab: route drag events to WindowManager ──
    if (this.mouseGrabAbject) {
      if (type === 'mousemove') {
        this.send(event(this.id, this.mouseGrabAbject, 'dragMove', {
          globalX: x, globalY: y,
        }));
        return;
      }
      if (type === 'mouseup') {
        this.send(event(this.id, this.mouseGrabAbject, 'dragEnd', {
          globalX: x, globalY: y,
        }));
        this.mouseGrabAbject = undefined;
        return;
      }
    }

    // Mouse capture: during drag, route to grabbed surface regardless of position
    const hitSurface = this.compositor?.surfaceAt(x, y);
    const grabbed = this.grabbedSurface
      ? this.compositor?.getSurface(this.grabbedSurface)
      : undefined;
    const surface = grabbed ?? hitSurface;

    if (type === 'mousedown' && surface && this.windowManagerId) {
      const owner = this.surfaceOwners.get(surface.id);

      // ── Ctrl+click: immediately start window drag (synchronous grab) ──
      if (e.ctrlKey) {
        this.mouseGrabAbject = this.windowManagerId;
        this.send(event(this.id, this.windowManagerId,
          'startDrag', {
            surfaceId: surface.id, globalX: x, globalY: y,
          }));
        if (owner) {
          this.setFocus(owner, surface.id);
        }
        return;
      }

      // Ask WindowManager if it wants to grab the mouse (drag/resize)
      try {
        const localX = x - surface.rect.x;
        const localY = y - surface.rect.y;
        const reply = await this.request<{ grab: boolean; minimize?: string }>(
          request(this.id, this.windowManagerId,
            'surfaceMouseDown', {
              surfaceId: surface.id, localX, localY,
            })
        );

        // WindowManager requested a minimize — hide the surface directly
        if (reply.minimize) {
          this.compositor?.setVisible(reply.minimize, false);
          return;
        }

        if (reply.grab) {
          // WindowManager claimed the grab — it handles drag/resize
          this.mouseGrabAbject = this.windowManagerId;
          if (owner) {
            this.setFocus(owner, surface.id);
          }
          return;
        }
      } catch {
        // WindowManager not available — fall through to original behavior
      }

      // WindowManager didn't grab — proceed with normal input routing
      if (owner) {
        const inputEvent: InputEvent = {
          type,
          surfaceId: surface.id,
          x: x - surface.rect.x,
          y: y - surface.rect.y,
          button: e.button,
          modifiers: {
            shift: e.shiftKey,
            ctrl: e.ctrlKey,
            alt: e.altKey,
            meta: e.metaKey,
          },
        };
        this.sendInputEvent(owner, inputEvent);
        this.grabbedSurface = surface.id;
        this.setFocus(owner, surface.id);
      }
      return;
    }

    // ── Normal mousemove / mouseup path ──

    // Synthesize mouseleave based on actual hit surface (not grabbed surface)
    if (type === 'mousemove') {
      this.updateHoveredSurface(hitSurface?.id);
    }

    const inputEvent: InputEvent = {
      type,
      surfaceId: surface?.id,
      x: surface ? x - surface.rect.x : x,
      y: surface ? y - surface.rect.y : y,
      button: e.button,
      modifiers: {
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        meta: e.metaKey,
      },
    };

    if (surface) {
      const owner = this.surfaceOwners.get(surface.id);
      if (owner) {
        this.sendInputEvent(owner, inputEvent);
      }
    }

    if (type === 'mouseup') {
      this.grabbedSurface = undefined;
    }
  }

  /**
   * Handle wheel events.
   */
  private handleWheelEvent(e: WheelEvent): void {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // ── Input monitors: broadcast wheel events to all monitor surfaces ──
    const monitors = this.compositor?.getInputMonitors() ?? [];
    for (const mon of monitors) {
      const owner = this.surfaceOwners.get(mon.id);
      if (owner) {
        this.sendInputEvent(owner, {
          type: 'wheel',
          surfaceId: mon.id,
          x: x - mon.rect.x,
          y: y - mon.rect.y,
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          modifiers: {
            shift: e.shiftKey,
            ctrl: e.ctrlKey,
            alt: e.altKey,
            meta: e.metaKey,
          },
        });
      }
    }

    const surface = this.compositor?.surfaceAt(x, y);

    if (surface) {
      const owner = this.surfaceOwners.get(surface.id);
      if (owner) {
        this.sendInputEvent(owner, {
          type: 'wheel',
          surfaceId: surface.id,
          x: x - surface.rect.x,
          y: y - surface.rect.y,
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          modifiers: {
            shift: e.shiftKey,
            ctrl: e.ctrlKey,
            alt: e.altKey,
            meta: e.metaKey,
          },
        });
      }
    }
  }

  /**
   * Handle keyboard events — forward to focused surface owner.
   */
  private handleKeyEvent(e: KeyboardEvent, type: 'keydown' | 'keyup'): void {
    if (!this.focusedSurface) return;

    const owner = this.surfaceOwners.get(this.focusedSurface);
    if (!owner) return;

    // Let clipboard shortcuts through so browser fires paste/copy/cut events
    if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'c' || e.key === 'x')) {
      return;
    }

    e.preventDefault();

    this.sendInputEvent(owner, {
      type,
      surfaceId: this.focusedSurface,
      key: e.key,
      code: e.code,
      modifiers: {
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        meta: e.metaKey,
      },
    });
  }

  /**
   * Handle paste events — forward paste text to focused surface owner.
   */
  private handlePasteEvent(e: ClipboardEvent): void {
    if (!this.focusedSurface) return;

    const owner = this.surfaceOwners.get(this.focusedSurface);
    if (!owner) return;

    const pasteText = e.clipboardData?.getData('text') ?? '';
    if (!pasteText) return;

    e.preventDefault();

    this.sendInputEvent(owner, {
      type: 'paste',
      surfaceId: this.focusedSurface,
      pasteText,
    });
  }

  /**
   * Handle copy events — write selected text to clipboard.
   */
  private handleCopyEvent(e: ClipboardEvent): void {
    if (!this.currentSelectedText) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', this.currentSelectedText);
  }

  /**
   * Handle cut events — write selected text to clipboard and forward cut to widget.
   */
  private handleCutEvent(e: ClipboardEvent): void {
    if (!this.currentSelectedText || !this.focusedSurface) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', this.currentSelectedText);
    // Forward cut as a keydown so widget deletes the selection
    const owner = this.surfaceOwners.get(this.focusedSurface);
    if (owner) {
      this.sendInputEvent(owner, {
        type: 'keydown',
        surfaceId: this.focusedSurface,
        key: 'x',
        code: 'KeyX',
        modifiers: { shift: false, ctrl: true, alt: false, meta: false },
      });
    }
    this.currentSelectedText = '';
  }

  // ── Event Sending ────────────────────────────────────────────────────

  /**
   * Send input event to an object.
   */
  /**
   * Send mouseleave to the old surface owner when the cursor moves to a different surface.
   */
  private updateHoveredSurface(currentSurfaceId: string | undefined): void {
    if (currentSurfaceId !== this.lastHoveredSurfaceId) {
      if (this.lastHoveredSurfaceId) {
        const oldOwner = this.surfaceOwners.get(this.lastHoveredSurfaceId);
        if (oldOwner) {
          this.sendInputEvent(oldOwner, {
            type: 'mouseleave',
            surfaceId: this.lastHoveredSurfaceId,
          });
        }
      }
      this.lastHoveredSurfaceId = currentSurfaceId;
    }
  }

  private async sendInputEvent(
    objectId: AbjectId,
    inputEvent: InputEvent
  ): Promise<void> {
    await this.send(
      event(this.id, objectId, 'input', inputEvent)
    );
  }

  /**
   * Send focus event to an object.
   */
  private async sendFocusEvent(
    objectId: AbjectId,
    surfaceId: string,
    focused: boolean
  ): Promise<void> {
    await this.send(
      event(this.id, objectId, 'focus', { surfaceId, focused })
    );
  }

  /**
   * Get surface count.
   */
  get surfaceCount(): number {
    return this.surfaceOwners.size;
  }
}

// Well-known UI server ID
export const UI_SERVER_ID = 'abjects:ui-server' as AbjectId;
