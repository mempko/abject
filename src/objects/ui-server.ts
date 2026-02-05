/**
 * UI Server object - provides X11-style surface management, input events, and widget system.
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

const TITLE_BAR_HEIGHT = 30;
const WIDGET_FONT = '14px system-ui';
const TITLE_FONT = 'bold 13px system-ui';

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

export interface WidgetEventPayload {
  windowId: string;
  widgetId: string;
  type: 'click' | 'change' | 'submit';
  value?: string;
}

interface WindowState {
  id: string;
  surfaceId: string;
  owner: AbjectId;
  title: string;
  rect: Rect;
  widgets: string[];
}

interface WidgetState {
  id: string;
  windowId: string;
  type: 'label' | 'textInput' | 'button';
  rect: Rect;
  text: string;
  placeholder?: string;
  masked?: boolean;
  focused?: boolean;
  cursorPos?: number;
}

/**
 * The UI Server provides surface management, input routing, and a widget system.
 */
export class UIServer extends Abject {
  private compositor?: Compositor;
  private surfaceOwners: Map<string, AbjectId> = new Map();
  private focusedSurface?: string;

  private windows: Map<string, WindowState> = new Map();
  private widgets: Map<string, WidgetState> = new Map();
  private focusedWidget?: string;

  constructor() {
    super({
      manifest: {
        name: 'UIServer',
        description:
          'X11-style display server with widget system. Objects request surfaces or windows with widgets.',
        version: '1.0.0',
        interfaces: [
          {
            id: UI_INTERFACE,
            name: 'UI',
            description: 'Surface management, input, and widgets',
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
              {
                name: 'createWindow',
                description: 'Create a window with title bar and content area',
                parameters: [
                  {
                    name: 'title',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Window title',
                  },
                  {
                    name: 'rect',
                    type: { kind: 'reference', reference: 'Rect' },
                    description: 'Window position and size',
                  },
                  {
                    name: 'zIndex',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'Z-ordering',
                    optional: true,
                  },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'addWidget',
                description: 'Add a widget to a window',
                parameters: [
                  {
                    name: 'windowId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The window to add the widget to',
                  },
                  {
                    name: 'id',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Widget identifier',
                  },
                  {
                    name: 'type',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Widget type: label, textInput, or button',
                  },
                  {
                    name: 'rect',
                    type: { kind: 'reference', reference: 'Rect' },
                    description: 'Widget position relative to window content area',
                  },
                  {
                    name: 'text',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Widget text content',
                    optional: true,
                  },
                  {
                    name: 'placeholder',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Placeholder text for text inputs',
                    optional: true,
                  },
                  {
                    name: 'masked',
                    type: { kind: 'primitive', primitive: 'boolean' },
                    description: 'Mask text (for password fields)',
                    optional: true,
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'updateWidget',
                description: 'Update widget properties',
                parameters: [
                  {
                    name: 'widgetId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The widget to update',
                  },
                  {
                    name: 'text',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'New text content',
                    optional: true,
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getWidgetValue',
                description: 'Get the current value of a text input widget',
                parameters: [
                  {
                    name: 'widgetId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The widget ID',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'destroyWindow',
                description: 'Destroy a window and all its widgets',
                parameters: [
                  {
                    name: 'windowId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The window to destroy',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
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
              {
                name: 'widgetEvent',
                description: 'Widget interaction event',
                payload: { kind: 'reference', reference: 'WidgetEventPayload' },
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

    this.on('createWindow', async (msg: AbjectMessage) => {
      const { title, rect, zIndex } = msg.payload as {
        title: string;
        rect: Rect;
        zIndex?: number;
      };
      return this.createWindow(msg.routing.from, title, rect, zIndex);
    });

    this.on('addWidget', async (msg: AbjectMessage) => {
      const payload = msg.payload as {
        windowId: string;
        id: string;
        type: 'label' | 'textInput' | 'button';
        rect: Rect;
        text?: string;
        placeholder?: string;
        masked?: boolean;
      };
      return this.addWidget(msg.routing.from, payload);
    });

    this.on('updateWidget', async (msg: AbjectMessage) => {
      const { widgetId, text, masked } = msg.payload as {
        widgetId: string;
        text?: string;
        masked?: boolean;
      };
      return this.updateWidget(msg.routing.from, widgetId, text, masked);
    });

    this.on('getWidgetValue', async (msg: AbjectMessage) => {
      const { widgetId } = msg.payload as { widgetId: string };
      return this.getWidgetValue(msg.routing.from, widgetId);
    });

    this.on('destroyWindow', async (msg: AbjectMessage) => {
      const { windowId } = msg.payload as { windowId: string };
      return this.destroyWindow(msg.routing.from, windowId);
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
  }

  // ── Surface API ──────────────────────────────────────────────────────

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

  // ── Window / Widget API ──────────────────────────────────────────────

  /**
   * Create a window with title bar.
   */
  private createWindow(
    owner: AbjectId,
    title: string,
    rect: Rect,
    zIndex?: number
  ): string {
    require(this.compositor !== undefined, 'Compositor not set');

    const surfaceId = this.compositor!.createSurface(this.id, rect, zIndex ?? 100);
    this.surfaceOwners.set(surfaceId, this.id);

    const windowId = `win-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const win: WindowState = {
      id: windowId,
      surfaceId,
      owner,
      title,
      rect,
      widgets: [],
    };
    this.windows.set(windowId, win);

    this.renderWindow(windowId);
    return windowId;
  }

  /**
   * Add a widget to a window.
   */
  private addWidget(
    owner: AbjectId,
    config: {
      windowId: string;
      id: string;
      type: 'label' | 'textInput' | 'button';
      rect: Rect;
      text?: string;
      placeholder?: string;
      masked?: boolean;
    }
  ): boolean {
    const win = this.windows.get(config.windowId);
    if (!win || win.owner !== owner) return false;

    const widget: WidgetState = {
      id: config.id,
      windowId: config.windowId,
      type: config.type,
      rect: config.rect,
      text: config.text ?? '',
      placeholder: config.placeholder,
      masked: config.masked,
      focused: false,
      cursorPos: 0,
    };

    this.widgets.set(config.id, widget);
    win.widgets.push(config.id);

    this.renderWindow(config.windowId);
    return true;
  }

  /**
   * Update a widget's properties.
   */
  private updateWidget(
    owner: AbjectId,
    widgetId: string,
    text?: string,
    masked?: boolean
  ): boolean {
    const widget = this.widgets.get(widgetId);
    if (!widget) return false;

    const win = this.windows.get(widget.windowId);
    if (!win || win.owner !== owner) return false;

    if (text !== undefined) {
      widget.text = text;
      widget.cursorPos = text.length;
    }
    if (masked !== undefined) {
      widget.masked = masked;
    }

    this.renderWindow(widget.windowId);
    return true;
  }

  /**
   * Get a text input widget's current value.
   */
  private getWidgetValue(owner: AbjectId, widgetId: string): string {
    const widget = this.widgets.get(widgetId);
    if (!widget) return '';

    const win = this.windows.get(widget.windowId);
    if (!win || win.owner !== owner) return '';

    return widget.text;
  }

  /**
   * Destroy a window and all its widgets.
   */
  private destroyWindow(owner: AbjectId, windowId: string): boolean {
    const win = this.windows.get(windowId);
    if (!win || win.owner !== owner) return false;

    // Remove widgets
    for (const widgetId of win.widgets) {
      if (this.focusedWidget === widgetId) {
        this.focusedWidget = undefined;
      }
      this.widgets.delete(widgetId);
    }

    // Remove surface
    this.surfaceOwners.delete(win.surfaceId);
    this.compositor?.destroySurface(win.surfaceId);

    if (this.focusedSurface === win.surfaceId) {
      this.focusedSurface = undefined;
    }

    this.windows.delete(windowId);
    return true;
  }

  // ── Window Rendering ─────────────────────────────────────────────────

  /**
   * Render an entire window: chrome + all widgets.
   */
  private renderWindow(windowId: string): void {
    const win = this.windows.get(windowId);
    if (!win || !this.compositor) return;

    const sid = win.surfaceId;
    const w = win.rect.width;
    const h = win.rect.height;

    // Clear
    this.compositor.draw({ type: 'clear', surfaceId: sid, params: {} });

    // Window background
    this.compositor.draw({
      type: 'rect',
      surfaceId: sid,
      params: { x: 0, y: 0, width: w, height: h, fill: '#1e1e2e', stroke: '#444', radius: 6 },
    });

    // Title bar
    this.compositor.draw({
      type: 'rect',
      surfaceId: sid,
      params: { x: 0, y: 0, width: w, height: TITLE_BAR_HEIGHT, fill: '#2a2a3e', radius: 6 },
    });
    // Cover bottom corners of title bar so they're square where content meets
    this.compositor.draw({
      type: 'rect',
      surfaceId: sid,
      params: { x: 0, y: TITLE_BAR_HEIGHT - 6, width: w, height: 6, fill: '#2a2a3e' },
    });

    // Title text
    this.compositor.draw({
      type: 'text',
      surfaceId: sid,
      params: {
        x: 12,
        y: TITLE_BAR_HEIGHT / 2,
        text: win.title,
        font: TITLE_FONT,
        fill: '#ccc',
        baseline: 'middle',
      },
    });

    // Separator line
    this.compositor.draw({
      type: 'line',
      surfaceId: sid,
      params: { x1: 0, y1: TITLE_BAR_HEIGHT, x2: w, y2: TITLE_BAR_HEIGHT, stroke: '#444' },
    });

    // Render widgets
    for (const widgetId of win.widgets) {
      const widget = this.widgets.get(widgetId);
      if (widget) {
        this.renderWidget(sid, widget);
      }
    }
  }

  /**
   * Render a single widget onto a surface.
   */
  private renderWidget(surfaceId: string, widget: WidgetState): void {
    if (!this.compositor) return;

    // Widget coordinates are relative to content area (below title bar)
    const ox = widget.rect.x;
    const oy = widget.rect.y + TITLE_BAR_HEIGHT;
    const w = widget.rect.width;
    const h = widget.rect.height;

    switch (widget.type) {
      case 'label':
        this.compositor.draw({
          type: 'text',
          surfaceId,
          params: {
            x: ox,
            y: oy + h / 2,
            text: widget.text,
            font: WIDGET_FONT,
            fill: '#aaa',
            baseline: 'middle',
          },
        });
        break;

      case 'textInput': {
        // Background
        const borderColor = widget.focused ? '#6a6aff' : '#555';
        this.compositor.draw({
          type: 'rect',
          surfaceId,
          params: {
            x: ox, y: oy, width: w, height: h,
            fill: '#151520', stroke: borderColor, radius: 4,
          },
        });

        // Clip text content to widget bounds
        this.compositor.draw({ type: 'save', surfaceId, params: {} });
        this.compositor.draw({
          type: 'clip',
          surfaceId,
          params: { x: ox + 1, y: oy + 1, width: w - 2, height: h - 2 },
        });

        // Text or placeholder
        const displayText = widget.text
          ? (widget.masked ? '\u2022'.repeat(widget.text.length) : widget.text)
          : '';
        const textPadding = 8;

        if (displayText) {
          this.compositor.draw({
            type: 'text',
            surfaceId,
            params: {
              x: ox + textPadding,
              y: oy + h / 2,
              text: displayText,
              font: WIDGET_FONT,
              fill: '#ddd',
              baseline: 'middle',
            },
          });
        } else if (widget.placeholder && !widget.focused) {
          this.compositor.draw({
            type: 'text',
            surfaceId,
            params: {
              x: ox + textPadding,
              y: oy + h / 2,
              text: widget.placeholder,
              font: WIDGET_FONT,
              fill: '#555',
              baseline: 'middle',
            },
          });
        }

        // Cursor
        if (widget.focused) {
          const cursorX = ox + textPadding + this.measureTextWidth(
            surfaceId,
            displayText.substring(0, widget.cursorPos ?? 0)
          );
          this.compositor.draw({
            type: 'line',
            surfaceId,
            params: {
              x1: cursorX, y1: oy + 4,
              x2: cursorX, y2: oy + h - 4,
              stroke: '#8888ff',
            },
          });
        }

        this.compositor.draw({ type: 'restore', surfaceId, params: {} });
        break;
      }

      case 'button':
        this.compositor.draw({
          type: 'rect',
          surfaceId,
          params: {
            x: ox, y: oy, width: w, height: h,
            fill: '#4a4a6e', stroke: '#666', radius: 4,
          },
        });
        this.compositor.draw({
          type: 'text',
          surfaceId,
          params: {
            x: ox + w / 2,
            y: oy + h / 2,
            text: widget.text,
            font: WIDGET_FONT,
            fill: '#eee',
            align: 'center',
            baseline: 'middle',
          },
        });
        break;
    }
  }

  /**
   * Measure text width on a surface's canvas context.
   */
  private measureTextWidth(surfaceId: string, text: string): number {
    if (!this.compositor || !text) return 0;
    const surface = this.compositor.getSurface(surfaceId);
    if (!surface) return 0;
    surface.ctx.font = WIDGET_FONT;
    return surface.ctx.measureText(text).width;
  }

  // ── Input Handling ───────────────────────────────────────────────────

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

    if (surface && type === 'mousedown') {
      // Check if click is inside a window managed by widget system
      const win = this.findWindowBySurface(surface.id);
      if (win) {
        this.handleWindowClick(win, x - surface.rect.x, y - surface.rect.y);
        return;
      }
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
      if (owner && owner !== this.id) {
        this.sendInputEvent(owner, inputEvent);
      }

      if (type === 'mousedown' && owner && owner !== this.id) {
        this.setFocus(owner, surface.id);
      }
    }
  }

  /**
   * Handle click inside a window — hit-test widgets.
   */
  private handleWindowClick(win: WindowState, localX: number, localY: number): void {
    // Convert to content-area coordinates
    const cx = localX;
    const cy = localY - TITLE_BAR_HEIGHT;

    // Unfocus previous widget
    if (this.focusedWidget) {
      const prev = this.widgets.get(this.focusedWidget);
      if (prev) {
        prev.focused = false;
      }
      this.focusedWidget = undefined;
    }

    // Hit-test widgets
    for (const widgetId of win.widgets) {
      const widget = this.widgets.get(widgetId);
      if (!widget) continue;

      const wr = widget.rect;
      if (cx >= wr.x && cx < wr.x + wr.width && cy >= wr.y && cy < wr.y + wr.height) {
        if (widget.type === 'textInput') {
          widget.focused = true;
          this.focusedWidget = widget.id;
          // Place cursor at click position
          widget.cursorPos = this.cursorPosFromX(
            win.surfaceId,
            widget,
            cx - wr.x - 8
          );
        } else if (widget.type === 'button') {
          this.sendWidgetEvent(win.owner, {
            windowId: win.id,
            widgetId: widget.id,
            type: 'click',
            value: widget.text,
          });
        }
        break;
      }
    }

    // Set surface focus for keyboard events
    this.focusedSurface = win.surfaceId;

    this.renderWindow(win.id);
  }

  /**
   * Determine cursor position from a click X offset within the text.
   */
  private cursorPosFromX(surfaceId: string, widget: WidgetState, clickX: number): number {
    const text = widget.masked ? '\u2022'.repeat(widget.text.length) : widget.text;
    if (!text) return 0;

    for (let i = 0; i <= text.length; i++) {
      const w = this.measureTextWidth(surfaceId, text.substring(0, i));
      if (w >= clickX) {
        return Math.max(0, i > 0 ? i - 1 : 0);
      }
    }
    return text.length;
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
      if (owner && owner !== this.id) {
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
    // If a widget has focus, handle text input
    if (type === 'keydown' && this.focusedWidget) {
      const widget = this.widgets.get(this.focusedWidget);
      if (widget && widget.type === 'textInput') {
        if (this.handleTextInputKey(widget, e)) {
          e.preventDefault();
          return;
        }
      }
    }

    if (!this.focusedSurface) return;

    const owner = this.surfaceOwners.get(this.focusedSurface);
    if (!owner || owner === this.id) return;

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
   * Handle a keydown event for a focused text input widget.
   * Returns true if the event was consumed.
   */
  private handleTextInputKey(widget: WidgetState, e: KeyboardEvent): boolean {
    const pos = widget.cursorPos ?? 0;

    if (e.key === 'Backspace') {
      if (pos > 0) {
        widget.text = widget.text.substring(0, pos - 1) + widget.text.substring(pos);
        widget.cursorPos = pos - 1;
        this.rerenderWidgetWindow(widget);
        this.emitTextChange(widget);
      }
      return true;
    }

    if (e.key === 'Delete') {
      if (pos < widget.text.length) {
        widget.text = widget.text.substring(0, pos) + widget.text.substring(pos + 1);
        this.rerenderWidgetWindow(widget);
        this.emitTextChange(widget);
      }
      return true;
    }

    if (e.key === 'ArrowLeft') {
      if (pos > 0) {
        widget.cursorPos = pos - 1;
        this.rerenderWidgetWindow(widget);
      }
      return true;
    }

    if (e.key === 'ArrowRight') {
      if (pos < widget.text.length) {
        widget.cursorPos = pos + 1;
        this.rerenderWidgetWindow(widget);
      }
      return true;
    }

    if (e.key === 'Home') {
      widget.cursorPos = 0;
      this.rerenderWidgetWindow(widget);
      return true;
    }

    if (e.key === 'End') {
      widget.cursorPos = widget.text.length;
      this.rerenderWidgetWindow(widget);
      return true;
    }

    if (e.key === 'Enter') {
      const win = this.windows.get(widget.windowId);
      if (win) {
        this.sendWidgetEvent(win.owner, {
          windowId: win.id,
          widgetId: widget.id,
          type: 'submit',
          value: widget.text,
        });
      }
      return true;
    }

    if (e.key === 'Tab') {
      this.focusNextWidget(widget);
      return true;
    }

    // Printable character
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      widget.text = widget.text.substring(0, pos) + e.key + widget.text.substring(pos);
      widget.cursorPos = pos + 1;
      this.rerenderWidgetWindow(widget);
      this.emitTextChange(widget);
      return true;
    }

    return false;
  }

  /**
   * Handle paste events.
   */
  private handlePasteEvent(e: ClipboardEvent): void {
    if (!this.focusedWidget) return;

    const widget = this.widgets.get(this.focusedWidget);
    if (!widget || widget.type !== 'textInput') return;

    const text = e.clipboardData?.getData('text') ?? '';
    if (!text) return;

    e.preventDefault();
    const pos = widget.cursorPos ?? 0;
    widget.text = widget.text.substring(0, pos) + text + widget.text.substring(pos);
    widget.cursorPos = pos + text.length;
    this.rerenderWidgetWindow(widget);
    this.emitTextChange(widget);
  }

  /**
   * Focus the next text input in the same window.
   */
  private focusNextWidget(current: WidgetState): void {
    const win = this.windows.get(current.windowId);
    if (!win) return;

    const textInputs = win.widgets
      .map((id) => this.widgets.get(id))
      .filter((w): w is WidgetState => w !== undefined && w.type === 'textInput');

    const idx = textInputs.findIndex((w) => w.id === current.id);
    const next = textInputs[(idx + 1) % textInputs.length];

    if (next && next.id !== current.id) {
      current.focused = false;
      next.focused = true;
      this.focusedWidget = next.id;
      this.renderWindow(current.windowId);
    }
  }

  /**
   * Rerender the window containing a widget.
   */
  private rerenderWidgetWindow(widget: WidgetState): void {
    this.renderWindow(widget.windowId);
  }

  /**
   * Emit a text change widget event.
   */
  private emitTextChange(widget: WidgetState): void {
    const win = this.windows.get(widget.windowId);
    if (win) {
      this.sendWidgetEvent(win.owner, {
        windowId: win.id,
        widgetId: widget.id,
        type: 'change',
        value: widget.text,
      });
    }
  }

  /**
   * Find a window by its surface ID.
   */
  private findWindowBySurface(surfaceId: string): WindowState | undefined {
    for (const win of this.windows.values()) {
      if (win.surfaceId === surfaceId) return win;
    }
    return undefined;
  }

  // ── Event Sending ────────────────────────────────────────────────────

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
   * Send widget event to a window owner.
   */
  private async sendWidgetEvent(
    objectId: AbjectId,
    payload: WidgetEventPayload
  ): Promise<void> {
    await this.send(
      event(this.id, objectId, UI_INTERFACE, 'widgetEvent', payload)
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
