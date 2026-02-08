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
  InterfaceId,
} from '../src/core/types.js';
import { Abject } from '../src/core/abject.js';
import { require as contractRequire } from '../src/core/contracts.js';
import { event, request } from '../src/core/message.js';
import { Capabilities } from '../src/core/capability.js';
import type { WebSocket } from 'ws';
import type {
  BackendToFrontendMsg,
  FrontendToBackendMsg,
  InputMsg,
} from './ws-protocol.js';

const UI_INTERFACE: InterfaceId = 'abjects:ui';
const WIDGET_FONT = '14px system-ui';

export interface SurfaceState {
  surfaceId: string;
  objectId: AbjectId;
  rect: { x: number; y: number; width: number; height: number };
  zIndex: number;
  lastDrawCommands: Array<{ type: string; surfaceId: string; params: unknown }>;
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
  private pendingRequests: Map<string, { resolve: (value: unknown) => void }> = new Map();
  private ws: WebSocket | null = null;
  private surfaceCounter = 0;
  private consoleId?: AbjectId;
  private lastDisplayInfo: { width: number; height: number } = { width: 1280, height: 720 };

  constructor() {
    super({
      manifest: {
        name: 'UIServer',
        description:
          'X11-style display server. Manages surfaces, draw commands, and routes input events to surface owners.',
        version: '1.0.0',
        interfaces: [
          {
            id: UI_INTERFACE,
            name: 'UI',
            description: 'Surface management and input routing',
            methods: [
              {
                name: 'createSurface',
                description: 'Create a new drawing surface. Example: const surfaceId = await this.call(this.dep("UIServer"), "abjects:ui", "createSurface", { rect: { x: 100, y: 100, width: 300, height: 200 }, zIndex: 100 })',
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
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'destroySurface',
                description: 'Destroy a surface. Example: await this.call(this.dep("UIServer"), "abjects:ui", "destroySurface", { surfaceId })',
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
                  '"path" (params: { path (SVG path string), fill?, stroke?, lineWidth? }). ' +
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
        ],
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.UI_SURFACE, Capabilities.UI_INPUT],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('createSurface', async (msg: AbjectMessage) => {
      const { rect, zIndex } = msg.payload as {
        rect: { x: number; y: number; width: number; height: number };
        zIndex?: number;
      };
      return this.handleCreateSurface(msg.routing.from, rect, zIndex);
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
  }

  protected override async onInit(): Promise<void> {
    this.consoleId = await this.discoverDep('Console') ?? undefined;
  }

  private async log(level: string, message: string, data?: unknown): Promise<void> {
    if (!this.consoleId) return;
    try {
      await this.send(
        request(this.id, this.consoleId, 'abjects:console' as InterfaceId, level, { message, data })
      );
    } catch { /* logging should never break the caller */ }
  }

  // ── WebSocket management ────────────────────────────────────────────

  /**
   * Set the WebSocket connection to the frontend.
   */
  setWebSocket(ws: WebSocket): void {
    this.ws = ws;
    ws.on('message', (data: Buffer | string) => {
      const str = typeof data === 'string' ? data : data.toString();
      try {
        const msg = JSON.parse(str) as FrontendToBackendMsg;
        this.handleFrontendMessage(msg);
      } catch (err) {
        console.error('[BackendUI] Failed to parse frontend message:', err);
      }
    });
    ws.on('close', () => {
      if (this.ws === ws) {
        this.ws = null;
      }
    });
  }

  /**
   * Send a message to the frontend.
   */
  private sendToFrontend(msg: BackendToFrontendMsg): void {
    if (this.ws && this.ws.readyState === 1 /* WebSocket.OPEN */) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ── Surface API ──────────────────────────────────────────────────────

  private handleCreateSurface(
    objectId: AbjectId,
    rect: { x: number; y: number; width: number; height: number },
    zIndex?: number
  ): string {
    const surfaceId = `surface-${objectId}-${this.surfaceCounter++}`;
    const z = zIndex ?? 0;

    this.surfaces.set(surfaceId, {
      surfaceId,
      objectId,
      rect: { ...rect },
      zIndex: z,
      lastDrawCommands: [],
    });

    this.sendToFrontend({
      type: 'createSurface',
      surfaceId,
      objectId,
      rect,
      zIndex: z,
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

    this.sendToFrontend({
      type: 'destroySurface',
      surfaceId,
    });

    this.log('debug', 'destroySurface', { surfaceId, objectId });
    return true;
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
    const commandsBySurface = new Map<string, Array<{ type: string; surfaceId: string; params: unknown }>>();
    for (const cmd of validCommands) {
      let batch = commandsBySurface.get(cmd.surfaceId);
      if (!batch) {
        batch = [];
        commandsBySurface.set(cmd.surfaceId, batch);
      }
      batch.push(cmd);
    }
    for (const [surfaceId, batch] of commandsBySurface) {
      const state = this.surfaces.get(surfaceId);
      if (state) {
        state.lastDrawCommands = batch;
      }
    }

    if (validCommands.length > 0) {
      this.sendToFrontend({
        type: 'draw',
        commands: validCommands,
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
    if (!state || state.objectId !== objectId) {
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
    if (!state || state.objectId !== objectId) {
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
    if (!state || state.objectId !== objectId) {
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
    if (!this.ws || this.ws.readyState !== 1) {
      return { ...this.lastDisplayInfo };
    }
    const info = await this.requestFromFrontend<{ width: number; height: number }>({
      type: 'displayInfoRequest',
      requestId: this.nextRequestId(),
    });
    this.lastDisplayInfo = { width: info.width, height: info.height };
    return info;
  }

  private async handleMeasureText(
    surfaceId: string,
    text: string,
    font: string
  ): Promise<number> {
    if (!text) return 0;

    if (!this.ws || this.ws.readyState !== 1) {
      // Rough estimate: ~7.5px per character at 14px font
      return text.length * 7.5;
    }

    const result = await this.requestFromFrontend<{ width: number }>({
      type: 'measureTextRequest',
      requestId: this.nextRequestId(),
      surfaceId,
      text,
      font,
    });

    return result.width;
  }

  // ── Request/reply with frontend ─────────────────────────────────────

  private requestIdCounter = 0;

  private nextRequestId(): string {
    return `req-${++this.requestIdCounter}`;
  }

  private requestFromFrontend<T>(msg: BackendToFrontendMsg & { requestId: string }): Promise<T> {
    return new Promise((resolve) => {
      this.pendingRequests.set(msg.requestId, {
        resolve: resolve as (value: unknown) => void,
      });
      this.sendToFrontend(msg);
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

      case 'ready':
        console.log('[BackendUI] Frontend connected and ready');
        this.replayStateToFrontend();
        break;

      case 'surfaceCreated':
        // Acknowledgment from frontend — no action needed
        break;
    }
  }

  private async handleFrontendInput(msg: InputMsg): Promise<void> {
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
        await this.sendInputEvent(state.objectId, inputEvent);
      }
    }
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

    // 3. Restore focus
    if (this.focusedSurface && this.surfaces.has(this.focusedSurface)) {
      this.sendToFrontend({
        type: 'setFocused',
        surfaceId: this.focusedSurface,
      });
    }

    console.log(`[BackendUI] Replayed ${this.surfaces.size} surfaces to frontend`);
  }

  // ── Event sending ───────────────────────────────────────────────────

  private async sendInputEvent(
    objectId: AbjectId,
    inputEvent: InputEvent
  ): Promise<void> {
    await this.send(
      event(this.id, objectId, UI_INTERFACE, 'input', inputEvent)
    );
  }

  private async sendFocusEvent(
    objectId: AbjectId,
    surfaceId: string,
    focused: boolean
  ): Promise<void> {
    await this.send(
      event(this.id, objectId, UI_INTERFACE, 'focus', { surfaceId, focused })
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
