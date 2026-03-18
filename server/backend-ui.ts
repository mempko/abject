/**
 * BackendUI — Node.js-side display server abject.
 *
 * Implements the same `abjects:ui` interface as UIServer so that all existing
 * abjects (WidgetManager, WindowAbject, widgets, etc.) can communicate with it
 * without changes. Instead of calling a local Compositor, it forwards draw
 * commands over WebSocket to the thin browser FrontendClient.
 */

import {
  AbjectId,
  AbjectMessage,
} from '../src/core/types.js';
import { Abject } from '../src/core/abject.js';
import { require as contractRequire } from '../src/core/contracts.js';
import { event, request } from '../src/core/message.js';
import { Capabilities } from '../src/core/capability.js';
import type { WebSocket } from 'ws';
import type {
  BackendToFrontendMsg,
  FrontendToBackendMsg,
  FontMetricsMsg,
  InputMsg,
  EndWindowDragMsg,
} from './ws-protocol.js';
import type { AuthConfig, SessionStore } from './auth.js';
import type { UITransport } from './ui-transport.js';
import { WebSocketUITransport } from './ui-transport.js';
import { Log } from '../src/core/timed-log.js';

const log = new Log('BackendUI');
const UI_INTERFACE = 'abjects:ui';
const WIDGET_FONT = '14px "Inter", system-ui, sans-serif';

export interface SurfaceState {
  surfaceId: string;
  objectId: AbjectId;
  rect: { x: number; y: number; width: number; height: number };
  zIndex: number;
  inputPassthrough: boolean;
  inputMonitor: boolean;
  lastDrawCommands: Array<{ type: string; surfaceId: string; params: unknown }>;
  workspaceId?: string;
}

export interface InputEvent {
  type: 'mousedown' | 'mouseup' | 'mousemove' | 'keydown' | 'keyup' | 'wheel' | 'paste';
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
 * BackendUI — implements `abjects:ui` on the Node.js backend.
 * Surface commands are forwarded to the browser frontend over WebSocket.
 * Input events from the frontend are routed to surface owners.
 */
export class BackendUI extends Abject {
  private surfaces: Map<string, SurfaceState> = new Map();
  private focusedSurface?: string;
  private mouseGrabAbject?: AbjectId;  // WindowManager grabs mouse during drag
  private pendingRequests: Map<string, { resolve: (value: unknown) => void; reject: (e: Error) => void }> = new Map();
  private transport: UITransport | null = null;
  private frontendReady = false;
  private surfaceCounter = 0;
  private consoleId?: AbjectId;
  private windowManagerId?: AbjectId;
  private currentSelectedText = '';
  private lastDisplayInfo: { width: number; height: number } = { width: 1280, height: 720 };
  private lastMouseX = 0;
  private lastMouseY = 0;
  private lastMonitorMoveTime = 0;
  private activeWorkspaceId?: string;
  private authConfig?: AuthConfig;
  private sessionStore?: SessionStore;
  /** Font metrics from frontend: font → char → pixel width */
  private fontMetrics: Map<string, Map<string, number>> = new Map();
  /** Hash of last draw commands per surface for dedup */
  private lastDrawHash: Map<string, string> = new Map();
  /** Frame-rate batching: queued messages flushed once per event loop tick */
  private sendQueue: BackendToFrontendMsg[] = [];
  private flushScheduled = false;

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
                  'Valid types: "clear" (params: {}), "rect" (params: { x, y, width, height, fill?, stroke?, lineWidth?, radius? }), ' +
                  '"text" (params: { x, y, text, font?, fill?, align?, baseline? }), "line" (params: { x1, y1, x2, y2, stroke?, lineWidth? }), ' +
                  '"path" (params: { path (SVG path string), fill?, stroke?, lineWidth? }), ' +
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
        rect: { x: number; y: number; width: number; height: number };
        zIndex?: number;
        inputPassthrough?: boolean;
        inputMonitor?: boolean;
      };
      return this.handleCreateSurface(msg.routing.from, rect, zIndex, inputPassthrough, inputMonitor);
    });

    this.on('destroySurface', async (msg: AbjectMessage) => {
      const { surfaceId } = msg.payload as { surfaceId: string };
      return this.handleDestroySurface(msg.routing.from, surfaceId);
    });

    this.on('draw', async (msg: AbjectMessage) => {
      const { commands } = msg.payload as {
        commands: Array<{ type: string; surfaceId: string; params: unknown }>;
      };
      return this.handleDraw(msg.routing.from, commands);
    });

    this.on('moveSurface', async (msg: AbjectMessage) => {
      const { surfaceId, x, y } = msg.payload as {
        surfaceId: string;
        x: number;
        y: number;
      };
      return this.handleMoveSurface(msg.routing.from, surfaceId, x, y);
    });

    this.on('resizeSurface', async (msg: AbjectMessage) => {
      const { surfaceId, width, height } = msg.payload as {
        surfaceId: string;
        width: number;
        height: number;
      };
      return this.handleResizeSurface(msg.routing.from, surfaceId, width, height);
    });

    this.on('setZIndex', async (msg: AbjectMessage) => {
      const { surfaceId, zIndex } = msg.payload as {
        surfaceId: string;
        zIndex: number;
      };
      return this.handleSetZIndex(msg.routing.from, surfaceId, zIndex);
    });

    this.on('focus', async (msg: AbjectMessage) => {
      const { surfaceId } = msg.payload as { surfaceId: string };
      return this.handleFocus(msg.routing.from, surfaceId);
    });

    this.on('getDisplayInfo', async () => {
      return this.handleGetDisplayInfo();
    });

    this.on('measureText', async (msg: AbjectMessage) => {
      const { surfaceId, text, font } = msg.payload as {
        surfaceId: string;
        text: string;
        font?: string;
      };
      return this.handleMeasureText(surfaceId, text, font ?? WIDGET_FONT);
    });

    this.on('setSurfaceVisible', async (msg: AbjectMessage) => {
      const { surfaceId, visible } = msg.payload as { surfaceId: string; visible: boolean };
      this.sendToFrontend({ type: 'setSurfaceVisible', surfaceId, visible });
      return true;
    });

    this.on('setSurfaceWorkspace', async (msg: AbjectMessage) => {
      const { surfaceId, workspaceId } = msg.payload as { surfaceId: string; workspaceId: string };
      const state = this.surfaces.get(surfaceId);
      if (state) {
        state.workspaceId = workspaceId;
      }
      this.sendToFrontend({ type: 'setSurfaceWorkspace', surfaceId, workspaceId });
      return true;
    });

    this.on('setActiveWorkspace', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      this.activeWorkspaceId = workspaceId;
      this.sendToFrontend({ type: 'setActiveWorkspace', workspaceId });
      return true;
    });

    this.on('clipboardWrite', async (msg: AbjectMessage) => {
      const { text } = msg.payload as { text: string };
      this.sendToFrontend({ type: 'clipboardWrite', text });
      return true;
    });

    this.on('selectionChanged', async (msg: AbjectMessage) => {
      const { selectedText } = msg.payload as { selectedText: string };
      this.currentSelectedText = selectedText;
      this.sendToFrontend({ type: 'setSelectedText', text: selectedText });
    });

    this.on('registerWindowManager', async (msg: AbjectMessage) => {
      this.windowManagerId = msg.routing.from;
      return true;
    });

    // Two-phase drag: WindowAbject sends requestDrag when a chromeless+draggable
    // window's empty area is clicked. We tell WindowManager to start the drag
    // and the client to handle the move locally (zero latency).
    this.on('requestDrag', async (msg: AbjectMessage) => {
      const { surfaceId } = msg.payload as { surfaceId: string };
      if (!this.windowManagerId || !surfaceId) return;
      const state = this.surfaces.get(surfaceId);
      if (!state) return;
      this.send(event(this.id, this.windowManagerId,
        'startDrag', {
          surfaceId,
          globalX: this.lastMouseX,
          globalY: this.lastMouseY,
        }));
      // Client handles the move drag locally
      this.sendToFrontend({
        type: 'startWindowDrag',
        surfaceId,
        dragType: 'move',
      });
    });

    this.on('objectUnregistered', async (msg: AbjectMessage) => {
      const objectId = msg.payload as AbjectId;
      this.destroySurfacesForObject(objectId);
    });

    this.on('updateAuth', async (msg: AbjectMessage) => {
      const { enabled, username, password } = msg.payload as {
        enabled: boolean;
        username: string;
        password: string;
      };
      if (!this.authConfig || !this.sessionStore) return false;

      const changed = this.authConfig.enabled !== enabled
        || this.authConfig.username !== username
        || this.authConfig.password !== password;

      this.authConfig.enabled = enabled;
      this.authConfig.username = username;
      this.authConfig.password = password;

      if (changed) {
        this.sessionStore.clearAll();
        this.disconnectFrontend();
        log.info(`Auth config updated (enabled=${enabled}), sessions cleared, frontend disconnected`);
      }
      return true;
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
      this.send(
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

Destroy a surface:
  await this.call(this.dep('UIServer'), 'destroySurface', { surfaceId });

### Drawing

Each draw command has exactly 3 fields: { type, surfaceId, params }

  await this.call(this.dep('UIServer'), 'draw', {
    commands: [
      { type: 'clear', surfaceId, params: { color: '#1e1e2e' } },
      { type: 'rect', surfaceId, params: { x: 10, y: 10, width: 80, height: 30, fill: '#4a4a6e', radius: 4 } },
      { type: 'text', surfaceId, params: { x: 150, y: 100, text: 'Hello', font: '24px system-ui', fill: '#ffffff', align: 'center' } },
    ]
  });

### Draw Command Types

'clear' - Clear surface. params: {} or { color: '#rrggbb' }
'rect'  - Rectangle. params: { x, y, width, height, fill?, stroke?, lineWidth?, radius? }
'text'  - Text. params: { x, y, text, font?, fill?, stroke?, align?, baseline? }
'line'  - Line. params: { x1, y1, x2, y2, stroke?, lineWidth? }
'path'  - SVG path. params: { path, fill?, stroke?, lineWidth? }
'circle' - Circle. params: { cx, cy, radius, fill?, stroke?, lineWidth? }
'arc'   - Arc. params: { cx, cy, radius, startAngle, endAngle, fill?, stroke?, counterclockwise? }
'ellipse' - Ellipse. params: { cx, cy, radiusX, radiusY, rotation?, fill?, stroke? }
'polygon' - Polygon. params: { points: [{x,y}...], fill?, stroke?, closePath? }
'imageUrl' - Draw image from URL or data URI. params: { x, y, width?, height?, url }
          Use with HttpClient.getBase64() to display fetched images.

### Displaying Images

  // 1. Fetch image as base64 data URI
  const img = await this.call(this.dep('HttpClient'), 'getBase64', { url: 'https://example.com/photo.jpg' });
  // 2. Draw on surface
  await this.call(this.dep('UIServer'), 'draw', {
    commands: [{ type: 'imageUrl', surfaceId, params: { x: 0, y: 0, width: 300, height: 200, url: img.dataUri } }]
  });

### State management
'save'/'restore' - Save/restore canvas state
'clip' - Set clipping region. params: { x, y, width, height }
'translate'/'rotate'/'scale' - Transform canvas
'globalAlpha' - Set transparency. params: { alpha }
'shadow' - Set shadow. params: { color, blur, offsetX?, offsetY? }
'linearGradient'/'radialGradient' - Set gradient fill+stroke

IMPORTANT:
- Use 'fill' for fill color, NOT 'color'
- Use 'rect' NOT 'fillRect', 'text' NOT 'fillText'
- Always nest parameters inside 'params'
- Transparent pixels do NOT receive mouse input — use opaque backgrounds`;
  }

  // ── Auth gate ───────────────────────────────────────────────────────

  /**
   * Store references to the shared AuthConfig and SessionStore so
   * the `updateAuth` handler can mutate them at runtime.
   */
  setAuthGate(config: AuthConfig, sessions: SessionStore): void {
    this.authConfig = config;
    this.sessionStore = sessions;
  }

  /**
   * Force-disconnect the current frontend WebSocket.
   * The frontend will reconnect automatically and go through the auth gate.
   */
  disconnectFrontend(): void {
    if (this.transport) {
      this.transport.close(4001, 'Auth config changed');
    }
  }

  // ── WebSocket management ────────────────────────────────────────────

  /**
   * Set the WebSocket connection to the frontend (convenience wrapper).
   * Wraps the WebSocket in a WebSocketUITransport and calls setTransport().
   */
  setWebSocket(ws: WebSocket): void {
    this.setTransport(new WebSocketUITransport(ws));
  }

  /**
   * Set the transport used to communicate with the frontend.
   * Works with any UITransport: WebSocket, MessagePort, etc.
   */
  setTransport(newTransport: UITransport): void {
    // Clean up state from previous connection
    this.frontendReady = false;
    this.sendQueue = [];
    this.flushScheduled = false;
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('Frontend reconnected'));
    }
    this.pendingRequests.clear();

    this.transport = newTransport;
    newTransport.onMessage((str: string) => {
      try {
        const msg = JSON.parse(str) as FrontendToBackendMsg;
        this.handleFrontendMessage(msg);
      } catch (err) {
        log.error('Failed to parse frontend message:', err);
      }
    });
    newTransport.onClose(() => {
      if (this.transport === newTransport) {
        this.transport = null;
        this.frontendReady = false;
        this.sendQueue = [];
        this.flushScheduled = false;
        // Reject any pending frontend requests so they don't hang forever
        for (const [reqId, pending] of this.pendingRequests) {
          pending.reject(new Error('Frontend disconnected'));
        }
        this.pendingRequests.clear();
      }
    });
  }

  /**
   * Send a message to the frontend (batched).
   * Messages are queued and flushed via setTimeout(0) so that draw flushing
   * and scheduleRelayout timers fire in the same event-loop phase.
   */
  private sendToFrontend(msg: BackendToFrontendMsg): void {
    if (!this.transport || !this.transport.ready) return;
    this.sendQueue.push(msg);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setTimeout(() => this.flushSendQueue(), 0);
    }
  }

  /**
   * Send a message to the frontend immediately (bypasses batching).
   * Used for request/reply messages where the caller awaits a response.
   */
  private sendToFrontendImmediate(msg: BackendToFrontendMsg): void {
    if (this.transport && this.transport.ready) {
      this.transport.send(JSON.stringify(msg));
    }
  }

  private flushSendQueue(): void {
    this.flushScheduled = false;
    if (!this.transport || !this.transport.ready || this.sendQueue.length === 0) return;

    if (this.sendQueue.length === 1) {
      this.transport.send(JSON.stringify(this.sendQueue[0]));
    } else {
      this.transport.send(JSON.stringify(this.sendQueue));
    }
    this.sendQueue = [];
  }

  // ── Surface API ──────────────────────────────────────────────────────

  private handleCreateSurface(
    objectId: AbjectId,
    rect: { x: number; y: number; width: number; height: number },
    zIndex?: number,
    inputPassthrough?: boolean,
    inputMonitor?: boolean
  ): string {
    const surfaceId = `surface-${objectId}-${this.surfaceCounter++}`;
    const z = zIndex ?? 0;

    this.surfaces.set(surfaceId, {
      surfaceId,
      objectId,
      rect: { ...rect },
      zIndex: z,
      inputPassthrough: inputPassthrough ?? false,
      inputMonitor: inputMonitor ?? false,
      lastDrawCommands: [],
    });

    this.sendToFrontend({
      type: 'createSurface',
      surfaceId,
      objectId,
      rect,
      zIndex: z,
      inputPassthrough: inputPassthrough ?? false,
    });

    this.log('debug', 'createSurface', { surfaceId, objectId, rect, zIndex });
    return surfaceId;
  }

  private handleDestroySurface(objectId: AbjectId, surfaceId: string): boolean {
    const state = this.surfaces.get(surfaceId);
    if (!state || state.objectId !== objectId) {
      return false;
    }

    this.surfaces.delete(surfaceId);
    this.lastDrawHash.delete(surfaceId);

    this.sendToFrontend({
      type: 'destroySurface',
      surfaceId,
    });

    this.log('debug', 'destroySurface', { surfaceId, objectId });
    return true;
  }

  /**
   * Destroy all surfaces owned by a given object (cleanup on unregister).
   */
  private destroySurfacesForObject(objectId: AbjectId): number {
    let count = 0;
    for (const [surfaceId, state] of this.surfaces.entries()) {
      if (state.objectId === objectId) {
        this.surfaces.delete(surfaceId);
        this.lastDrawHash.delete(surfaceId);
        this.sendToFrontend({ type: 'destroySurface', surfaceId });
        if (this.focusedSurface === surfaceId) this.focusedSurface = undefined;
        count++;
      }
    }
    return count;
  }

  private handleDraw(
    objectId: AbjectId,
    commands: Array<{ type: string; surfaceId: string; params: unknown }>
  ): boolean {
    // Filter commands to only include surfaces owned by the caller
    const validCommands = commands.filter(
      (cmd) => this.surfaces.get(cmd.surfaceId)?.objectId === objectId
    );

    // Store draw commands per surface (each batch is a full redraw)
    // and deduplicate: skip surfaces whose draw commands haven't changed
    const commandsBySurface = new Map<string, Array<{ type: string; surfaceId: string; params: unknown }>>();
    for (const cmd of validCommands) {
      let batch = commandsBySurface.get(cmd.surfaceId);
      if (!batch) {
        batch = [];
        commandsBySurface.set(cmd.surfaceId, batch);
      }
      batch.push(cmd);
    }

    const changedCommands: Array<{ type: string; surfaceId: string; params: unknown }> = [];
    for (const [surfaceId, batch] of commandsBySurface) {
      const hash = JSON.stringify(batch);
      const prevHash = this.lastDrawHash.get(surfaceId);
      const state = this.surfaces.get(surfaceId);
      if (state) {
        state.lastDrawCommands = batch;
      }
      if (hash !== prevHash) {
        this.lastDrawHash.set(surfaceId, hash);
        changedCommands.push(...batch);
      }
    }

    if (changedCommands.length > 0) {
      this.sendToFrontend({
        type: 'draw',
        commands: changedCommands,
      });
    }

    this.log('debug', 'draw', { objectId, commandCount: commands.length });
    return true;
  }

  private handleMoveSurface(
    objectId: AbjectId,
    surfaceId: string,
    x: number,
    y: number
  ): boolean {
    const state = this.surfaces.get(surfaceId);
    if (!state || (state.objectId !== objectId && objectId !== this.windowManagerId)) {
      return false;
    }

    state.rect.x = x;
    state.rect.y = y;

    this.sendToFrontend({
      type: 'moveSurface',
      surfaceId,
      x,
      y,
    });

    return true;
  }

  private handleResizeSurface(
    objectId: AbjectId,
    surfaceId: string,
    width: number,
    height: number
  ): boolean {
    const state = this.surfaces.get(surfaceId);
    if (!state || (state.objectId !== objectId && objectId !== this.windowManagerId)) {
      return false;
    }

    state.rect.width = width;
    state.rect.height = height;

    this.sendToFrontend({
      type: 'resizeSurface',
      surfaceId,
      width,
      height,
    });

    return true;
  }

  private handleSetZIndex(
    objectId: AbjectId,
    surfaceId: string,
    zIndex: number
  ): boolean {
    const state = this.surfaces.get(surfaceId);
    if (!state || (state.objectId !== objectId && objectId !== this.windowManagerId)) {
      return false;
    }

    state.zIndex = zIndex;

    this.sendToFrontend({
      type: 'setZIndex',
      surfaceId,
      zIndex,
    });

    return true;
  }

  private handleFocus(objectId: AbjectId, surfaceId: string): boolean {
    const state = this.surfaces.get(surfaceId);
    if (!state || state.objectId !== objectId) {
      return false;
    }

    const oldFocus = this.focusedSurface;
    this.focusedSurface = surfaceId;

    // Send focus lost to previous owner
    if (oldFocus && oldFocus !== surfaceId) {
      const oldState = this.surfaces.get(oldFocus);
      if (oldState) {
        this.sendFocusEvent(oldState.objectId, oldFocus, false);
      }
    }

    // Send focus gained to new owner
    this.sendFocusEvent(objectId, surfaceId, true);

    // Tell frontend which surface is focused (for keyboard routing)
    this.sendToFrontend({
      type: 'setFocused',
      surfaceId,
    });

    return true;
  }

  private async handleGetDisplayInfo(): Promise<{ width: number; height: number }> {
    if (!this.transport || !this.transport.ready || !this.frontendReady) {
      return { ...this.lastDisplayInfo };
    }
    try {
      const info = await this.requestFromFrontend<{ width: number; height: number }>({
        type: 'displayInfoRequest',
        requestId: this.nextRequestId(),
      });
      this.lastDisplayInfo = { width: info.width, height: info.height };
      return info;
    } catch {
      return { ...this.lastDisplayInfo };
    }
  }

  private async handleMeasureText(
    surfaceId: string,
    text: string,
    font: string
  ): Promise<number> {
    if (!text) return 0;

    // Try local measurement using font metrics table from frontend
    const charWidths = this.fontMetrics.get(font);
    if (charWidths) {
      let width = 0;
      for (let i = 0; i < text.length; i++) {
        const cw = charWidths.get(text[i]);
        width += cw ?? (charWidths.get('M') ?? 7.5);
      }
      return width;
    }

    // No metrics yet — fall back to round-trip or estimate
    if (!this.transport || !this.transport.ready || !this.frontendReady) {
      return text.length * 7.5;
    }

    try {
      const result = await this.requestFromFrontend<{ width: number }>({
        type: 'measureTextRequest',
        requestId: this.nextRequestId(),
        surfaceId,
        text,
        font,
      });
      return result.width;
    } catch {
      return text.length * 7.5;
    }
  }

  // ── Request/reply with frontend ─────────────────────────────────────

  private requestIdCounter = 0;

  private nextRequestId(): string {
    return `req-${++this.requestIdCounter}`;
  }

  private requestFromFrontend<T>(msg: BackendToFrontendMsg & { requestId: string }, timeoutMs = 10000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(msg.requestId);
        reject(new Error(`Frontend request ${msg.type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(msg.requestId, {
        resolve: (value: unknown) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.sendToFrontendImmediate(msg);
    });
  }

  // ── Frontend message handling ───────────────────────────────────────

  private handleFrontendMessage(msg: FrontendToBackendMsg): void {
    switch (msg.type) {
      case 'input':
        this.handleFrontendInput(msg as InputMsg);
        break;

      case 'measureTextReply': {
        const pending = this.pendingRequests.get(msg.requestId!);
        if (pending) {
          this.pendingRequests.delete(msg.requestId!);
          pending.resolve({ width: msg.width });
        }
        break;
      }

      case 'displayInfoReply': {
        this.lastDisplayInfo = { width: msg.width, height: msg.height };
        const pending = this.pendingRequests.get(msg.requestId!);
        if (pending) {
          this.pendingRequests.delete(msg.requestId!);
          pending.resolve({ width: msg.width, height: msg.height });
        }
        break;
      }

      case 'fontMetrics': {
        const fmMsg = msg as FontMetricsMsg;
        for (const [font, chars] of Object.entries(fmMsg.metrics)) {
          const charMap = new Map<string, number>();
          for (const [ch, w] of Object.entries(chars)) {
            charMap.set(ch, w);
          }
          this.fontMetrics.set(font, charMap);
        }
        log.info(`Received font metrics for ${Object.keys(fmMsg.metrics).length} fonts`);
        break;
      }

      case 'ready':
        log.info('Frontend connected and ready');
        this.frontendReady = true;
        this.replayStateToFrontend();
        break;

      case 'endWindowDrag':
        this.handleEndWindowDrag(msg as EndWindowDragMsg);
        break;

      case 'surfaceCreated':
        // Acknowledgment from frontend — no action needed
        break;
    }
  }

  private async handleFrontendInput(msg: InputMsg): Promise<void> {
    // Track last mouse position (global coords) for requestDrag
    if (msg.inputType === 'mousedown' || msg.inputType === 'mousemove') {
      const surfState = msg.surfaceId ? this.surfaces.get(msg.surfaceId) : undefined;
      this.lastMouseX = (msg.x ?? 0) + (surfState?.rect.x ?? 0);
      this.lastMouseY = (msg.y ?? 0) + (surfState?.rect.y ?? 0);
    }

    // ── Input monitors: broadcast mouse/wheel events to all monitor surfaces ──
    // Throttle mousemove to ~60fps to avoid flooding monitor mailboxes
    const now = Date.now();
    const isMouseMove = msg.inputType === 'mousemove';
    const shouldBroadcast = !isMouseMove || (now - this.lastMonitorMoveTime >= 16);
    if (shouldBroadcast && (msg.inputType === 'mousedown' || msg.inputType === 'mouseup' ||
        msg.inputType === 'mousemove' || msg.inputType === 'wheel')) {
      if (isMouseMove) this.lastMonitorMoveTime = now;
      // Reconstruct global coords
      const surfState = msg.surfaceId ? this.surfaces.get(msg.surfaceId) : undefined;
      const globalX = (msg.x ?? 0) + (surfState?.rect.x ?? 0);
      const globalY = (msg.y ?? 0) + (surfState?.rect.y ?? 0);

      for (const state of this.surfaces.values()) {
        if (!state.inputMonitor) continue;
        this.sendInputEvent(state.objectId, {
          type: msg.inputType,
          surfaceId: state.surfaceId,
          x: globalX - state.rect.x,
          y: globalY - state.rect.y,
          button: msg.button,
          deltaX: msg.deltaX,
          deltaY: msg.deltaY,
          modifiers: msg.modifiers,
        });
      }
    }

    // ── WindowManager grab: route drag events to WindowManager (resize only) ──
    // Move drags are handled client-side; resize drags still go through the server.
    if (this.mouseGrabAbject) {
      if (msg.inputType === 'mousemove') {
        // Prefer globalX/globalY from client (avoids stale local→global reconstruction)
        const state = msg.surfaceId ? this.surfaces.get(msg.surfaceId) : undefined;
        const globalX = msg.globalX ?? ((msg.x ?? 0) + (state?.rect.x ?? 0));
        const globalY = msg.globalY ?? ((msg.y ?? 0) + (state?.rect.y ?? 0));
        this.send(event(this.id, this.mouseGrabAbject, 'dragMove', {
          globalX, globalY,
        }));
        return;
      }
      if (msg.inputType === 'mouseup') {
        const state = msg.surfaceId ? this.surfaces.get(msg.surfaceId) : undefined;
        const globalX = msg.globalX ?? ((msg.x ?? 0) + (state?.rect.x ?? 0));
        const globalY = msg.globalY ?? ((msg.y ?? 0) + (state?.rect.y ?? 0));
        this.send(event(this.id, this.mouseGrabAbject, 'dragEnd', {
          globalX, globalY,
        }));
        this.mouseGrabAbject = undefined;
        return;
      }
    }

    const inputEvent: InputEvent = {
      type: msg.inputType,
      surfaceId: msg.surfaceId,
      x: msg.x,
      y: msg.y,
      button: msg.button,
      key: msg.key,
      code: msg.code,
      modifiers: msg.modifiers,
      deltaX: msg.deltaX,
      deltaY: msg.deltaY,
      pasteText: msg.pasteText,
    };

    if (msg.surfaceId) {
      const state = this.surfaces.get(msg.surfaceId);
      if (state) {
        if (msg.inputType === 'mousedown' && this.windowManagerId) {
          // ── Ctrl+click: immediately start window drag (client-side move) ──
          if (msg.modifiers?.ctrl) {
            const globalX = (msg.x ?? 0) + (state.rect.x ?? 0);
            const globalY = (msg.y ?? 0) + (state.rect.y ?? 0);
            this.send(event(this.id, this.windowManagerId,
              'startDrag', {
                surfaceId: msg.surfaceId, globalX, globalY,
              }));
            // Tell client to handle the move drag locally (zero latency)
            this.sendToFrontend({
              type: 'startWindowDrag',
              surfaceId: msg.surfaceId,
              dragType: 'move',
            });
            this.handleFocus(state.objectId, msg.surfaceId);
            return;
          }

          // Ask WindowManager if it wants to grab the mouse (drag/resize)
          const localX = msg.x ?? 0;
          const localY = msg.y ?? 0;
          try {
            const reply = await this.request<{ grab: boolean; dragType?: 'move' | 'resize'; minimize?: string }>(
              request(this.id, this.windowManagerId,
                'surfaceMouseDown', {
                  surfaceId: msg.surfaceId, localX, localY,
                })
            );

            // WindowManager requested a minimize — hide the surface directly
            if (reply.minimize) {
              this.sendToFrontend({ type: 'setSurfaceVisible', surfaceId: reply.minimize, visible: false });
              return;
            }

            if (reply.grab) {
              // Tell client about the drag start
              this.sendToFrontend({
                type: 'startWindowDrag',
                surfaceId: msg.surfaceId,
                dragType: reply.dragType ?? 'move',
              });

              if (reply.dragType === 'resize') {
                // Resize drags still go through server (needs content re-rendering)
                this.mouseGrabAbject = this.windowManagerId;
              }
              // Move drags: no mouseGrabAbject — client handles it locally
              this.handleFocus(state.objectId, msg.surfaceId);
              return;
            }
          } catch (err) {
            // WindowManager not available — fall through to original behavior
          }

          // WindowManager didn't grab — proceed with normal input routing
          await this.sendInputEvent(state.objectId, inputEvent);
          this.handleFocus(state.objectId, msg.surfaceId);
          return;
        }

        await this.sendInputEvent(state.objectId, inputEvent);
      }
    }
  }

  // ── Client-side drag end ────────────────────────────────────────────

  /**
   * Handle endWindowDrag from client — client did the move locally,
   * now sync final position to server state and WindowManager.
   */
  private handleEndWindowDrag(msg: EndWindowDragMsg): void {
    const state = this.surfaces.get(msg.surfaceId);
    if (state) {
      state.rect.x = msg.x;
      state.rect.y = msg.y;
    }

    // Notify WindowManager of the final position so it updates its windows map
    if (this.windowManagerId) {
      this.send(event(this.id, this.windowManagerId, 'clientDragEnd', {
        surfaceId: msg.surfaceId,
        x: msg.x,
        y: msg.y,
      }));
    }

    // Do NOT send moveSurface back to client — it already has the correct position
  }

  // ── State replay ────────────────────────────────────────────────────

  /**
   * Replay all current surface state to the frontend.
   * Called when a frontend sends 'ready' (initial connect or reconnect).
   */
  private replayStateToFrontend(): void {
    // 1. Recreate all surfaces
    for (const state of this.surfaces.values()) {
      this.sendToFrontend({
        type: 'createSurface',
        surfaceId: state.surfaceId,
        objectId: state.objectId,
        rect: { ...state.rect },
        zIndex: state.zIndex,
        inputPassthrough: state.inputPassthrough,
      });
    }

    // 2. Replay last draw commands for each surface
    for (const state of this.surfaces.values()) {
      if (state.lastDrawCommands.length > 0) {
        this.sendToFrontend({
          type: 'draw',
          commands: state.lastDrawCommands,
        });
      }
    }

    // 3. Replay workspace assignments
    for (const state of this.surfaces.values()) {
      if (state.workspaceId) {
        this.sendToFrontend({
          type: 'setSurfaceWorkspace',
          surfaceId: state.surfaceId,
          workspaceId: state.workspaceId,
        });
      }
    }

    // 4. Replay active workspace filter
    if (this.activeWorkspaceId) {
      this.sendToFrontend({
        type: 'setActiveWorkspace',
        workspaceId: this.activeWorkspaceId,
      });
    }

    // 5. Restore focus
    if (this.focusedSurface && this.surfaces.has(this.focusedSurface)) {
      this.sendToFrontend({
        type: 'setFocused',
        surfaceId: this.focusedSurface,
      });
    }

    let totalDrawCmds = 0;
    for (const state of this.surfaces.values()) {
      totalDrawCmds += state.lastDrawCommands.length;
    }
    log.info(`Replayed ${this.surfaces.size} surfaces (${totalDrawCmds} draw commands) to frontend`);

    // 6. Trigger all surface owners to redraw with fresh font metrics.
    // The replayed draw commands used metrics from the previous browser session;
    // if the new browser has different fonts, layouts need recomputing.
    this.lastDrawHash.clear();
    const notifiedOwners = new Set<string>();
    for (const state of this.surfaces.values()) {
      const ownerId = state.objectId;
      if (!notifiedOwners.has(ownerId)) {
        notifiedOwners.add(ownerId);
        this.send(event(this.id, ownerId as AbjectId, 'fontMetricsChanged', {}));
      }
    }
  }

  // ── Event sending ───────────────────────────────────────────────────

  private async sendInputEvent(
    objectId: AbjectId,
    inputEvent: InputEvent
  ): Promise<void> {
    this.send(
      event(this.id, objectId, 'input', inputEvent)
    );
  }

  private async sendFocusEvent(
    objectId: AbjectId,
    surfaceId: string,
    focused: boolean
  ): Promise<void> {
    this.send(
      event(this.id, objectId, 'focus', { surfaceId, focused })
    );
  }

  /**
   * Get surface count.
   */
  get surfaceCount(): number {
    return this.surfaces.size;
  }
}

export const BACKEND_UI_ID = 'abjects:backend-ui' as AbjectId;
