/**
 * UI Server object - provides X11-style surface management and input events.
 */

import {
  AbjectId,
  AbjectMessage,
  InterfaceId,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require } from '../core/contracts.js';
import { event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import {
  Compositor,
  Rect,
  DrawCommand,

} from '../ui/compositor.js';

const UI_INTERFACE: InterfaceId = 'abjects:ui';

export interface InputEvent {
  type: 'mousedown' | 'mouseup' | 'mousemove' | 'keydown' | 'keyup' | 'wheel';
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
}

/**
 * The UI Server provides surface management and input routing.
 */
export class UIServer extends Abject {
  private compositor?: Compositor;
  private surfaceOwners: Map<string, AbjectId> = new Map();
  private focusedSurface?: string;

  constructor() {
    super({
      manifest: {
        name: 'UIServer',
        description:
          'X11-style display server. Objects request surfaces to draw on and receive input events.',
        version: '1.0.0',
        interfaces: [
          {
            id: UI_INTERFACE,
            name: 'UI',
            description: 'Surface management and input',
            methods: [
              {
                name: 'createSurface',
                description: 'Create a new drawing surface',
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
                description: 'Destroy a surface',
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
                description: 'Execute draw commands on a surface',
                parameters: [
                  {
                    name: 'commands',
                    type: {
                      kind: 'array',
                      elementType: { kind: 'reference', reference: 'DrawCommand' },
                    },
                    description: 'Draw commands to execute',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'moveSurface',
                description: 'Move a surface',
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
                description: 'Resize a surface',
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
            ],
            events: [
              {
                name: 'input',
                description: 'Input event (mouse, keyboard)',
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
      const { rect, zIndex } = msg.payload as { rect: Rect; zIndex?: number };
      return this.createSurface(msg.routing.from, rect, zIndex);
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
    canvas.addEventListener('mousedown', (e) => this.handleMouseEvent(e, 'mousedown'));
    canvas.addEventListener('mouseup', (e) => this.handleMouseEvent(e, 'mouseup'));
    canvas.addEventListener('mousemove', (e) => this.handleMouseEvent(e, 'mousemove'));
    canvas.addEventListener('wheel', (e) => this.handleWheelEvent(e));

    window.addEventListener('keydown', (e) => this.handleKeyEvent(e, 'keydown'));
    window.addEventListener('keyup', (e) => this.handleKeyEvent(e, 'keyup'));
  }

  /**
   * Create a surface for an object.
   */
  private createSurface(
    objectId: AbjectId,
    rect: Rect,
    zIndex?: number
  ): string {
    require(this.compositor !== undefined, 'Compositor not set');

    const surfaceId = this.compositor!.createSurface(objectId, rect, zIndex);
    this.surfaceOwners.set(surfaceId, objectId);

    return surfaceId;
  }

  /**
   * Destroy a surface.
   */
  private destroySurface(objectId: AbjectId, surfaceId: string): boolean {
    // Verify ownership
    if (this.surfaceOwners.get(surfaceId) !== objectId) {
      return false;
    }

    this.surfaceOwners.delete(surfaceId);
    return this.compositor?.destroySurface(surfaceId) ?? false;
  }

  /**
   * Execute draw commands.
   */
  private executeDraw(objectId: AbjectId, commands: DrawCommand[]): boolean {
    require(this.compositor !== undefined, 'Compositor not set');

    for (const cmd of commands) {
      // Verify ownership
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
    if (this.surfaceOwners.get(surfaceId) !== objectId) {
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
    if (this.surfaceOwners.get(surfaceId) !== objectId) {
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
    if (this.surfaceOwners.get(surfaceId) !== objectId) {
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

    // Notify old surface of focus loss
    if (oldFocus && oldFocus !== surfaceId) {
      const oldOwner = this.surfaceOwners.get(oldFocus);
      if (oldOwner) {
        this.sendFocusEvent(oldOwner, oldFocus, false);
      }
    }

    // Notify new surface of focus gain
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
   * Handle mouse events.
   */
  private handleMouseEvent(
    e: MouseEvent,
    type: 'mousedown' | 'mouseup' | 'mousemove'
  ): void {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const surface = this.compositor?.surfaceAt(x, y);

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

      // Focus on click
      if (type === 'mousedown') {
        this.setFocus(owner!, surface.id);
      }
    }
  }

  /**
   * Handle wheel events.
   */
  private handleWheelEvent(e: WheelEvent): void {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

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
   * Handle keyboard events.
   */
  private handleKeyEvent(e: KeyboardEvent, type: 'keydown' | 'keyup'): void {
    if (!this.focusedSurface) {
      return;
    }

    const owner = this.surfaceOwners.get(this.focusedSurface);
    if (!owner) {
      return;
    }

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
   * Send input event to an object.
   */
  private async sendInputEvent(
    objectId: AbjectId,
    inputEvent: InputEvent
  ): Promise<void> {
    await this.send(
      event(this.id, objectId, UI_INTERFACE, 'input', inputEvent)
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
      event(this.id, objectId, UI_INTERFACE, 'focus', { surfaceId, focused })
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
