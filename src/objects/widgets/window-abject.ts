/**
 * WindowAbject — composite morph that contains child widgets.
 *
 * Owns a UIServer surface, coordinates rendering (Morphic drawOn:) and
 * routes input to children (Morphic event dispatch with bubbling).
 * All child interaction is via message passing — no direct references.
 */

import {
  AbjectId,
  AbjectMessage,
} from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { request, event } from '../../core/message.js';
import {
  Rect,
  ThemeData,
  MIDNIGHT_BLOOM,
  WINDOW_INTERFACE,
  TITLE_BAR_HEIGHT,
  TITLE_FONT,
  lightenColor,
} from './widget-types.js';

export interface WindowConfig {
  title: string;
  rect: Rect;
  uiServerId: AbjectId;
  chromeless?: boolean;
  transparent?: boolean;
  resizable?: boolean;
  draggable?: boolean;
  zIndex?: number;
  theme?: ThemeData;
}

/**
 * WindowAbject — a composite morph that owns a surface and contains child widgets.
 */
export class WindowAbject extends Abject {
  private surfaceId?: string;
  private uiServerId: AbjectId;
  private title: string;
  private rect: Rect;
  private chromeless: boolean;
  private transparent: boolean;
  private resizable: boolean;
  private draggable: boolean;
  private zIndex: number;
  protected override theme: ThemeData;

  /** Expose surfaceId so WidgetManager can register with WindowManager. */
  get surface(): string | undefined { return this.surfaceId; }

  private children: AbjectId[] = [];
  private childRects: Map<AbjectId, Rect> = new Map();
  private expandedSelects: Set<AbjectId> = new Set();
  private focusedChildId?: AbjectId;
  private focusedParentChildId?: AbjectId;  // the window's direct child (layout) that contains focusedChildId
  private hoveredChildId?: AbjectId;

  private windowFocused = false;
  private destroying = false;
  private rendering = false;
  private renderScheduled = false;
  private frameTimer?: ReturnType<typeof setTimeout>;

  constructor(config: WindowConfig) {
    super({
      manifest: {
        name: 'Window',
        description: 'Composite window morph — owns surface, contains child widgets',
        version: '1.0.0',
        interface: {
            id: WINDOW_INTERFACE,
            name: 'Window',
            description: 'Window management and child widget coordination',
            methods: [
              {
                name: 'addChild',
                description: 'Add a widget as a child of this window (Morphic addMorph:)',
                parameters: [
                  { name: 'widgetId', type: { kind: 'primitive', primitive: 'string' }, description: 'Widget AbjectId' },
                  { name: 'rect', type: { kind: 'reference', reference: 'Rect' }, description: 'Widget rect in content area' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'removeChild',
                description: 'Remove a widget from this window (Morphic removeMorph:)',
                parameters: [
                  { name: 'widgetId', type: { kind: 'primitive', primitive: 'string' }, description: 'Widget AbjectId' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'setTitle',
                description: 'Set window title',
                parameters: [
                  { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: 'New title' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getRect',
                description: 'Get window rect',
                parameters: [],
                returns: { kind: 'reference', reference: 'Rect' },
              },
              {
                name: 'destroy',
                description: 'Destroy this window and all children',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
            events: [
              {
                name: 'windowMoved',
                description: 'Window was moved by user',
                payload: { kind: 'object', properties: { x: { kind: 'primitive', primitive: 'number' }, y: { kind: 'primitive', primitive: 'number' } } },
              },
              {
                name: 'windowResized',
                description: 'Window was resized by user',
                payload: { kind: 'object', properties: { width: { kind: 'primitive', primitive: 'number' }, height: { kind: 'primitive', primitive: 'number' } } },
              },
              {
                name: 'windowCloseRequested',
                description: 'Close button was clicked — owner should destroy',
                payload: { kind: 'object', properties: {} },
              },
              {
                name: 'windowMinimized',
                description: 'Window was minimized',
                payload: { kind: 'object', properties: {} },
              },
              {
                name: 'windowRestored',
                description: 'Window was restored from minimized state',
                payload: { kind: 'object', properties: {} },
              },
            ],
          },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['widget', 'window'],
      },
    });

    this.uiServerId = config.uiServerId;
    this.title = config.title;
    this.rect = { ...config.rect };
    this.chromeless = config.chromeless ?? false;
    this.transparent = config.transparent ?? false;
    this.resizable = config.resizable ?? false;
    this.draggable = config.draggable ?? false;
    this.zIndex = config.zIndex ?? 100;
    this.theme = config.theme ?? MIDNIGHT_BLOOM;

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('addChild', async (msg: AbjectMessage) => {
      const { widgetId, rect } = msg.payload as { widgetId: AbjectId; rect: Rect };
      console.debug(`[Window:${this.id}] addChild — widgetId=${widgetId}`);
      this.children.push(widgetId);

      // If rect is {0,0,0,0}, fill the full content area (typical for layout children)
      const contentW = this.rect.width;
      const contentH = this.rect.height - (this.chromeless ? 0 : TITLE_BAR_HEIGHT);
      const effectiveRect = (rect.width === 0 && rect.height === 0)
        ? { x: 0, y: 0, width: contentW, height: contentH }
        : rect;
      this.childRects.set(widgetId, effectiveRect);

      // Update the child widget's own rect so it knows its dimensions
      if (rect.width === 0 && rect.height === 0) {
        try {
          await this.request(
            request(this.id, widgetId, 'update', { rect: effectiveRect })
          );
        } catch {
          // Widget setup may not be complete yet
        }
      }

      this.scheduleFrame();
      return true;
    });

    this.on('removeChild', async (msg: AbjectMessage) => {
      const { widgetId } = msg.payload as { widgetId: AbjectId };
      if (!this.children.includes(widgetId)) return true;  // Not a direct child (layout-managed) — no-op
      this.children = this.children.filter((id) => id !== widgetId);
      this.childRects.delete(widgetId);
      this.expandedSelects.delete(widgetId);
      if (this.focusedChildId === widgetId) { this.focusedChildId = undefined; this.focusedParentChildId = undefined; }
      if (this.focusedParentChildId === widgetId) this.focusedParentChildId = undefined;
      if (this.hoveredChildId === widgetId) this.hoveredChildId = undefined;
      this.scheduleFrame();
      return true;
    });

    this.on('setTitle', async (msg: AbjectMessage) => {
      const { title } = msg.payload as { title: string };
      this.title = title;
      this.scheduleFrame();
      return true;
    });

    this.on('getRect', async () => {
      return { ...this.rect };
    });

    this.on('destroy', async () => {
      await this.destroyWindow();
      return true;
    });

    // Input events forwarded from UIServer
    this.on('input', async (msg: AbjectMessage) => {
      const inputEvent = msg.payload as {
        type: string;
        surfaceId?: string;
        x?: number;
        y?: number;
        button?: number;
        key?: string;
        code?: string;
        modifiers?: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean };
        deltaX?: number;
        deltaY?: number;
        pasteText?: string;
      };
      await this.handleInputEvent(inputEvent);
    });

    // Child dirty notification — schedule a frame render
    this.on('childDirty', async () => {
      if (this.destroying) return;
      this.scheduleFrame();
    });

    // Receive changed events from children (e.g., select expanded/collapsed)
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      if (aspect === 'expanded') {
        if (value) {
          this.expandedSelects.add(msg.routing.from);
        } else {
          this.expandedSelects.delete(msg.routing.from);
        }
      }
    });

    // Focus/unfocus events from UIServer
    this.on('focus', async (msg: AbjectMessage) => {
      const { focused } = msg.payload as { surfaceId: string; focused: boolean };
      this.windowFocused = focused;

      // When window loses focus, send mouseleave to hovered child so it
      // clears hover highlight and hides tooltips (the mouse may never
      // re-enter this window before entering the newly focused one).
      if (!focused && this.hoveredChildId) {
        try {
          await this.request<{ consumed: boolean }>(
            request(this.id, this.hoveredChildId, 'handleInput', {
              type: 'mouseleave',
            })
          );
        } catch {
          // Widget gone
        }
        this.hoveredChildId = undefined;
      }

      this.scheduleFrame();
    });

    this.on('updateTheme', async (msg: AbjectMessage) => {
      this.theme = msg.payload as ThemeData;
      this.scheduleFrame();
      return true;
    });

    // Frontend reconnected with new font metrics — recompute layout and redraw
    this.on('fontMetricsChanged', async () => {
      this.scheduleFrame();
      return true;
    });

    // WindowManager sends titleBarAction when close/minimize buttons are clicked
    this.on('titleBarAction', async (msg: AbjectMessage) => {
      const { action } = msg.payload as { action: string };
      if (action === 'close') {
        await this.changed('windowCloseRequested', {});
      } else if (action === 'minimize') {
        await this.changed('windowMinimized', {});
      } else if (action === 'restore') {
        await this.changed('windowRestored', {});
        this.scheduleFrame();
      }
    });

    // WindowManager sends rect updates during drag/resize;
    // Taskbar (and other owners) may also send windowRect for programmatic resize.
    this.on('windowRect', async (msg: AbjectMessage) => {
      const { x, y, width, height } = msg.payload as { x: number; y: number; width: number; height: number };
      const moved = x !== this.rect.x || y !== this.rect.y;
      const sizeChanged = width !== this.rect.width || height !== this.rect.height;
      this.rect = { x, y, width, height };

      // Update the actual UIServer surface so it matches the new rect
      if (this.surfaceId) {
        if (moved) {
          this.request(
            request(this.id, this.uiServerId, 'moveSurface', { surfaceId: this.surfaceId, x, y })
          ).catch(() => {});
        }
        if (sizeChanged) {
          this.request(
            request(this.id, this.uiServerId, 'resizeSurface', { surfaceId: this.surfaceId, width, height })
          ).catch(() => {});
        }
      }

      if (sizeChanged) {
        await this.updateChildrenOnResize();
        await this.renderWindow();
      }
      await this.changed('windowRect', { x, y, width, height });
    });
  }

  protected override getSourceForAsk(): string | undefined {
    return `## WindowAbject Usage Guide

### Overview

WindowAbject is a composite morph that owns a UIServer surface and contains child widgets.
It handles rendering (Morphic drawOn:) and routes input events to children.

### Title Bar Actions

WindowManager sends 'titleBarAction' events to WindowAbject when title bar buttons are clicked.
WindowAbject translates these into dependency-protocol events:

- action: 'close'   → emits 'windowCloseRequested' to dependents
- action: 'minimize' → emits 'windowMinimized' to dependents
- action: 'restore'  → emits 'windowRestored' to dependents, then re-renders

### Event Flow

1. User clicks close (X) or minimize (_) button in title bar
2. WindowManager detects the hit and sends 'titleBarAction' to WindowAbject
3. WindowAbject calls this.changed(eventName) which notifies all dependents
4. WidgetManager (registered as dependent) receives the event via 'changed' handler
5. WidgetManager forwards the event to the window's owner Abject
6. Owner handles the event (e.g., calls hide() on windowCloseRequested)

### Owner Handling

Window owners do NOT register as dependents of WindowAbject directly.
Instead, WidgetManager acts as the intermediary. Owners receive events as
method calls on 'abjects:widgets' interface:

  this.on('windowCloseRequested', async (msg) => {
    await this.hide();
  });

### Interface ID

'abjects:window' — for addChild, removeChild, setTitle, getRect, destroy`;
  }

  protected async onInit(): Promise<void> {
    // Create surface via UIServer
    this.surfaceId = await this.request<string>(
      request(this.id, this.uiServerId, 'createSurface', {
        rect: this.rect,
        zIndex: this.zIndex,
      })
    );
    await this.request<boolean>(
      request(this.id, this.uiServerId, 'focus', {
        surfaceId: this.surfaceId,
      })
    );
    await this.renderWindow();
  }

  // ── Rendering (Morphic drawOn:) ──────────────────────────────────────

  /**
   * Game-engine style frame scheduler: debounce all mutation-triggered renders
   * into a single renderWindow() call. The timer resets on each call, so the
   * render fires only after all pending mutations settle.
   */
  private scheduleFrame(): void {
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.frameTimer = setTimeout(() => {
      this.frameTimer = undefined;
      if (!this.destroying) {
        this.renderWindow().catch(() => {});
      }
    }, 0);
  }

  private async renderWindow(): Promise<void> {
    if (!this.surfaceId || this.destroying) return;
    if (this.rendering) {
      this.renderScheduled = true;
      return;
    }

    this.rendering = true;
    this.renderScheduled = false;
    try {
      await this.renderWindowInner();
    } finally {
      this.rendering = false;
      if (this.renderScheduled) {
        this.renderScheduled = false;
        this.scheduleFrame();
      }
    }
  }

  private async renderWindowInner(): Promise<void> {
    const sid = this.surfaceId!;
    const w = this.rect.width;
    const h = this.rect.height;
    const commands: unknown[] = [];

    // Clear
    commands.push({ type: 'clear', surfaceId: sid, params: {} });

    if (!this.transparent) {
      // Window shadow
      commands.push({ type: 'save', surfaceId: sid, params: {} });
      commands.push({
        type: 'shadow',
        surfaceId: sid,
        params: { color: this.theme.shadowColor, blur: 20, offsetY: 6 },
      });
      commands.push({
        type: 'rect',
        surfaceId: sid,
        params: { x: 0, y: 0, width: w, height: h, fill: this.theme.windowBg, radius: this.theme.windowRadius },
      });
      commands.push({ type: 'restore', surfaceId: sid, params: {} });

      // Window background (drawn without shadow)
      commands.push({
        type: 'rect',
        surfaceId: sid,
        params: { x: 0, y: 0, width: w, height: h, fill: this.theme.windowBg, stroke: this.theme.windowBorder, radius: this.theme.windowRadius },
      });

      // Faint accent overlay — barely-perceptible green tint matching website card glow
      commands.push({ type: 'save', surfaceId: sid, params: {} });
      commands.push({ type: 'globalAlpha', surfaceId: sid, params: { alpha: 0.03 } });
      commands.push({
        type: 'rect',
        surfaceId: sid,
        params: { x: 1, y: 1, width: w - 2, height: h - 2, fill: this.theme.accent, radius: this.theme.windowRadius },
      });
      commands.push({ type: 'restore', surfaceId: sid, params: {} });

      // Accent border glow — brighter when focused
      const borderGlowAlpha = this.windowFocused ? 0.2 : 0.08;
      if (this.windowFocused) {
        commands.push({ type: 'save', surfaceId: sid, params: {} });
        commands.push({
          type: 'shadow',
          surfaceId: sid,
          params: { color: 'rgba(57, 255, 142, 0.07)', blur: 16 },
        });
        commands.push({
          type: 'rect',
          surfaceId: sid,
          params: { x: 0, y: 0, width: w, height: h, stroke: `rgba(57, 255, 142, ${borderGlowAlpha})`, radius: this.theme.windowRadius },
        });
        commands.push({ type: 'restore', surfaceId: sid, params: {} });
      } else {
        commands.push({
          type: 'rect',
          surfaceId: sid,
          params: { x: 0, y: 0, width: w, height: h, stroke: `rgba(57, 255, 142, ${borderGlowAlpha})`, radius: this.theme.windowRadius },
        });
      }
    }

    if (!this.chromeless) {
      // Title bar with gradient
      commands.push({ type: 'save', surfaceId: sid, params: {} });
      commands.push({
        type: 'linearGradient',
        surfaceId: sid,
        params: { x0: 0, y0: 0, x1: 0, y1: TITLE_BAR_HEIGHT, stops: [
          { offset: 0, color: this.theme.titleBarBg },
          { offset: 1, color: lightenColor(this.theme.titleBarBg, 8) },
        ] },
      });
      commands.push({
        type: 'rect',
        surfaceId: sid,
        params: { x: 0, y: 0, width: w, height: TITLE_BAR_HEIGHT, fill: this.theme.titleBarBg, radius: this.theme.windowRadius },
      });
      commands.push({ type: 'restore', surfaceId: sid, params: {} });
      commands.push({
        type: 'rect',
        surfaceId: sid,
        params: { x: 0, y: TITLE_BAR_HEIGHT - 6, width: w, height: 6, fill: this.theme.titleBarBg },
      });
      // Title text with subtle glow shadow
      commands.push({ type: 'save', surfaceId: sid, params: {} });
      commands.push({
        type: 'shadow',
        surfaceId: sid,
        params: { color: 'rgba(57, 255, 142, 0.15)', blur: 8 },
      });
      commands.push({
        type: 'text',
        surfaceId: sid,
        params: {
          x: 12, y: TITLE_BAR_HEIGHT / 2,
          text: this.title, font: TITLE_FONT, fill: this.theme.textPrimary, baseline: 'middle',
        },
      });
      commands.push({ type: 'restore', surfaceId: sid, params: {} });

      // Close and minimize buttons (right side of title bar)
      const btnSize = this.theme.titleButtonSize;
      const btnMargin = this.theme.titleButtonMargin;
      const iconSize = this.theme.titleButtonIconSize;

      // Close button (rightmost)
      const closeCx = w - btnMargin - btnSize / 2;
      const closeCy = TITLE_BAR_HEIGHT / 2;
      // X icon — two crossing lines
      const halfIcon = iconSize / 2;
      commands.push({
        type: 'line', surfaceId: sid,
        params: {
          x1: closeCx - halfIcon, y1: closeCy - halfIcon,
          x2: closeCx + halfIcon, y2: closeCy + halfIcon,
          stroke: this.theme.textSecondary, lineWidth: 1.5,
        },
      });
      commands.push({
        type: 'line', surfaceId: sid,
        params: {
          x1: closeCx + halfIcon, y1: closeCy - halfIcon,
          x2: closeCx - halfIcon, y2: closeCy + halfIcon,
          stroke: this.theme.textSecondary, lineWidth: 1.5,
        },
      });

      // Minimize button (left of close)
      const minCx = closeCx - btnSize - btnMargin;
      const minCy = TITLE_BAR_HEIGHT / 2;
      // Dash icon — horizontal line
      commands.push({
        type: 'line', surfaceId: sid,
        params: {
          x1: minCx - halfIcon, y1: minCy,
          x2: minCx + halfIcon, y2: minCy,
          stroke: this.theme.textSecondary, lineWidth: 1.5,
        },
      });

      // Signature accent line under title bar with soft glow
      commands.push({ type: 'save', surfaceId: sid, params: {} });
      commands.push({
        type: 'shadow',
        surfaceId: sid,
        params: { color: 'rgba(57, 255, 142, 0.3)', blur: 6 },
      });
      commands.push({
        type: 'line',
        surfaceId: sid,
        params: { x1: 0, y1: TITLE_BAR_HEIGHT, x2: w, y2: TITLE_BAR_HEIGHT, stroke: this.theme.accent },
      });
      commands.push({ type: 'restore', surfaceId: sid, params: {} });
    }

    // Resize grip
    if (this.resizable) {
      commands.push({
        type: 'line', surfaceId: sid,
        params: { x1: w - 3, y1: h - 8, x2: w - 8, y2: h - 3, stroke: this.theme.resizeGrip },
      });
      commands.push({
        type: 'line', surfaceId: sid,
        params: { x1: w - 3, y1: h - 4, x2: w - 4, y2: h - 3, stroke: this.theme.resizeGrip },
      });
    }

    // Render children in parallel — request draw commands from each child widget (Morphic drawOn:)
    const childResults = await Promise.all(
      this.children.map(async (childId) => {
        const childRect = this.childRects.get(childId);
        if (!childRect) return null;
        const ox = childRect.x;
        const oy = this.chromeless ? childRect.y : childRect.y + TITLE_BAR_HEIGHT;
        try {
          return await this.request<unknown[]>(
            request(this.id, childId, 'render', { surfaceId: sid, ox, oy })
          );
        } catch {
          return null;
        }
      })
    );
    for (const childCmds of childResults) {
      if (Array.isArray(childCmds)) commands.push(...childCmds);
    }

    // Window may have been destroyed mid-render (e.g., destroy arrived
    // re-entrantly during a child render await).
    if (this.destroying || !this.surfaceId) return;

    // Draw all commands to surface
    await this.request<boolean>(
      request(this.id, this.uiServerId, 'draw', { commands })
    );
  }

  // ── Input Handling (Morphic event dispatch) ──────────────────────────

  private async handleInputEvent(inputEvent: {
    type: string;
    surfaceId?: string;
    x?: number;
    y?: number;
    button?: number;
    key?: string;
    code?: string;
    modifiers?: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean };
    deltaX?: number;
    deltaY?: number;
    pasteText?: string;
  }): Promise<void> {
    if (inputEvent.type === 'mousedown') {
      await this.handleMouseDown(inputEvent);
    } else if (inputEvent.type === 'mousemove') {
      await this.handleMouseMove(inputEvent);
    } else if (inputEvent.type === 'mouseup') {
      await this.handleMouseUp(inputEvent);
    } else if (inputEvent.type === 'keydown') {
      await this.handleKeyDown(inputEvent);
    } else if (inputEvent.type === 'wheel') {
      await this.handleWheel(inputEvent);
    } else if (inputEvent.type === 'paste') {
      await this.handlePaste(inputEvent.pasteText ?? '');
    } else if (inputEvent.type === 'mouseleave') {
      await this.handleMouseLeave();
    }
  }

  private async handleMouseLeave(): Promise<void> {
    // Send mouseleave to hovered child
    if (this.hoveredChildId) {
      try {
        await this.request<{ consumed: boolean }>(
          request(this.id, this.hoveredChildId, 'handleInput', {
            type: 'mouseleave',
          })
        );
      } catch {
        // Widget gone
      }
      this.hoveredChildId = undefined;
    }
    // Send mouseleave to focused layout child (stops drag-selection forwarding)
    if (this.focusedParentChildId) {
      try {
        await this.request<{ consumed: boolean }>(
          request(this.id, this.focusedParentChildId, 'handleInput', {
            type: 'mouseleave',
          })
        );
      } catch {
        // Widget gone
      }
      this.focusedParentChildId = undefined;
    }
  }

  private async handleMouseDown(e: { x?: number; y?: number }): Promise<void> {
    const localX = e.x ?? 0;
    const localY = e.y ?? 0;

    // Content-area coordinates
    const cx = localX;
    const cy = this.chromeless ? localY : localY - TITLE_BAR_HEIGHT;

    // First check expanded selects (highest priority in hit-test)
    for (const childId of this.expandedSelects) {
      const childRect = this.childRects.get(childId);
      if (!childRect) continue;

      // Forward to the expanded select widget — let it handle dropdown hit-test
      try {
        const result = await this.request<{ consumed: boolean }>(
          request(this.id, childId, 'handleInput', {
            type: 'mousedown', x: cx, y: cy,
          })
        );
        if (result.consumed) {
          this.scheduleFrame();
          return;
        }
      } catch {
        // Widget gone
      }
    }

    // Unfocus previous widget
    if (this.focusedChildId) {
      try {
        await this.request(
          request(this.id, this.focusedChildId, 'setFocused', { focused: false })
        );
      } catch {
        // Widget gone
      }
      this.focusedChildId = undefined;
      this.focusedParentChildId = undefined;
    }

    // Hit-test children
    let childConsumed = false;
    for (const childId of this.children) {
      const childRect = this.childRects.get(childId);
      if (!childRect) continue;

      if (cx >= childRect.x && cx < childRect.x + childRect.width &&
          cy >= childRect.y && cy < childRect.y + childRect.height) {
        try {
          const result = await this.request<{ consumed: boolean; focusWidgetId?: AbjectId }>(
            request(this.id, childId, 'handleInput', {
              type: 'mousedown', x: cx, y: cy,
            })
          );
          if (result.consumed) {
            childConsumed = true;
            // Use focusWidgetId if returned (layout routing), otherwise the child itself
            const focusTarget = result.focusWidgetId ?? childId;
            this.focusedChildId = focusTarget;
            this.focusedParentChildId = childId;
            await this.request(
              request(this.id, focusTarget, 'setFocused', { focused: true })
            );
          }
        } catch {
          // Widget gone
        }
        break;
      }
    }

    // If no child consumed the click and this window is draggable,
    // request a drag from UIServer (two-phase grab for chromeless+draggable windows)
    if (!childConsumed && this.draggable) {
      await this.send(
        event(this.id, this.uiServerId, 'requestDrag', {
          surfaceId: this.surfaceId,
        })
      );
    }

    this.scheduleFrame();
  }

  private async handleMouseMove(e: { surfaceId?: string; x?: number; y?: number }): Promise<void> {
    // Content-area coordinates
    const cx = e.x ?? 0;
    const cy = (e.y ?? 0) - (this.chromeless ? 0 : TITLE_BAR_HEIGHT);

    // Compute global coordinates for tooltip positioning
    const globalX = this.rect.x + (e.x ?? 0);
    const globalY = this.rect.y + (e.y ?? 0);

    // Forward mousemove to expanded selects for hover
    for (const childId of this.expandedSelects) {
      try {
        await this.request<{ consumed: boolean }>(
          request(this.id, childId, 'handleInput', {
            type: 'mousemove', x: cx, y: cy, globalX, globalY,
          })
        );
      } catch {
        // Widget gone
      }
    }

    // Hit-test children to forward mousemove/mouseleave for hover tracking
    let hitChildId: AbjectId | undefined;
    for (const childId of this.children) {
      const childRect = this.childRects.get(childId);
      if (!childRect) continue;

      if (cx >= childRect.x && cx < childRect.x + childRect.width &&
          cy >= childRect.y && cy < childRect.y + childRect.height) {
        hitChildId = childId;
        break;
      }
    }

    if (hitChildId !== this.hoveredChildId) {
      // Send mouseleave to old hovered child
      if (this.hoveredChildId) {
        try {
          await this.request<{ consumed: boolean }>(
            request(this.id, this.hoveredChildId, 'handleInput', {
              type: 'mouseleave',
            })
          );
        } catch {
          // Widget gone
        }
      }

      this.hoveredChildId = hitChildId;

      // Send mousemove to new child
      if (hitChildId) {
        try {
          await this.request<{ consumed: boolean }>(
            request(this.id, hitChildId, 'handleInput', {
              type: 'mousemove', x: cx, y: cy, globalX, globalY,
            })
          );
        } catch {
          // Widget gone
        }
      }
    } else if (hitChildId) {
      // Same child — forward mousemove with local coords
      try {
        await this.request<{ consumed: boolean }>(
          request(this.id, hitChildId, 'handleInput', {
            type: 'mousemove', x: cx, y: cy, globalX, globalY,
          })
        );
      } catch {
        // Widget gone
      }
    }

    // Forward mousemove to the parent layout of the focused child even when
    // the cursor is outside its bounds (supports drag-selection)
    if (this.focusedParentChildId && this.focusedParentChildId !== hitChildId) {
      try {
        await this.request<{ consumed: boolean }>(
          request(this.id, this.focusedParentChildId, 'handleInput', {
            type: 'mousemove', x: cx, y: cy, globalX, globalY,
          })
        );
      } catch {
        // Widget gone
      }
    }
  }

  private async handleMouseUp(e: { x?: number; y?: number }): Promise<void> {
    // Forward mouseup to focused child so it can end drag-selection
    if (this.focusedChildId) {
      const cx = e.x ?? 0;
      const cy = (e.y ?? 0) - (this.chromeless ? 0 : TITLE_BAR_HEIGHT);
      try {
        await this.request<{ consumed: boolean }>(
          request(this.id, this.focusedChildId, 'handleInput', {
            type: 'mouseup', x: cx, y: cy,
          })
        );
      } catch {
        // Widget gone
      }
    }
  }

  private async handleKeyDown(e: {
    key?: string;
    code?: string;
    modifiers?: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean };
  }): Promise<void> {
    if (!this.focusedChildId) return;

    try {
      const result = await this.request<{ consumed: boolean }>(
        request(this.id, this.focusedChildId, 'handleInput', {
          type: 'keydown', key: e.key, code: e.code, modifiers: e.modifiers,
        })
      );

      // Event bubbling — if child didn't consume, Window handles
      if (!result.consumed) {
        if (e.key === 'Tab') {
          await this.focusNextWidget();
        }
      }
    } catch {
      // Widget gone
    }
  }

  private async handleWheel(e: {
    x?: number;
    y?: number;
    deltaY?: number;
  }): Promise<void> {
    const cx = e.x ?? 0;
    const cy = (e.y ?? 0) - (this.chromeless ? 0 : TITLE_BAR_HEIGHT);

    // Find child under cursor
    for (const childId of this.children) {
      const childRect = this.childRects.get(childId);
      if (!childRect) continue;

      if (cx >= childRect.x && cx < childRect.x + childRect.width &&
          cy >= childRect.y && cy < childRect.y + childRect.height) {
        try {
          await this.request<{ consumed: boolean }>(
            request(this.id, childId, 'handleInput', {
              type: 'wheel', x: cx, y: cy, deltaY: e.deltaY,
            })
          );
        } catch {
          // Widget gone
        }
        return;
      }
    }
  }

  private async handlePaste(pasteText: string): Promise<void> {
    if (!pasteText || !this.focusedChildId) return;

    try {
      await this.request<{ consumed: boolean }>(
        request(this.id, this.focusedChildId, 'handleInput', {
          type: 'paste', pasteText,
        })
      );
    } catch {
      // Widget gone
    }
  }

  // ── Focus Management ──────────────────────────────────────────────────

  private async focusNextWidget(): Promise<void> {
    if (!this.focusedChildId) return;

    // Get flat list of focusable widgets (supports layouts via getFocusableWidgets)
    const focusableWidgets = await this.getFocusableWidgetList();
    if (focusableWidgets.length === 0) return;

    const idx = focusableWidgets.indexOf(this.focusedChildId);
    if (idx === -1) return;

    // Try the next focusable widget in order
    for (let i = 1; i < focusableWidgets.length; i++) {
      const nextId = focusableWidgets[(idx + i) % focusableWidgets.length];
      if (nextId === this.focusedChildId) break;

      // Unfocus current
      try {
        await this.request(
          request(this.id, this.focusedChildId, 'setFocused', { focused: false })
        );
      } catch {
        // Widget gone
      }

      // Focus next
      this.focusedChildId = nextId;
      try {
        await this.request(
          request(this.id, nextId, 'setFocused', { focused: true })
        );
      } catch {
        // Widget gone
      }

      this.scheduleFrame();
      return;
    }
  }

  /**
   * Get a flat list of all focusable widgets across all children,
   * recursing into layout children via getFocusableWidgets.
   */
  private async getFocusableWidgetList(): Promise<AbjectId[]> {
    const result: AbjectId[] = [];
    for (const childId of this.children) {
      try {
        const nested = await this.request<AbjectId[]>(
          request(this.id, childId, 'getFocusableWidgets', {})
        );
        if (Array.isArray(nested) && nested.length > 0) {
          result.push(...nested);
          continue;
        }
      } catch {
        // Not a layout — treat as regular widget
      }
      result.push(childId);
    }
    return result;
  }

  /**
   * Update children rects on window resize. For layout children,
   * send the full content area rect. For non-layout children, keep existing rects.
   */
  private async updateChildrenOnResize(): Promise<void> {
    const contentW = this.rect.width;
    const contentH = this.rect.height - (this.chromeless ? 0 : TITLE_BAR_HEIGHT);

    for (const childId of this.children) {
      const childRect = this.childRects.get(childId);
      if (!childRect) continue;

      // Update layout children to fill the full content area
      const newRect = {
        x: 0,
        y: 0,
        width: contentW,
        height: contentH,
      };
      this.childRects.set(childId, newRect);

      try {
        await this.request(
          request(this.id, childId, 'update', { rect: newRect })
        );
      } catch {
        // Widget gone
      }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  private async destroyWindow(): Promise<void> {
    this.destroying = true;
    if (this.frameTimer) {
      clearTimeout(this.frameTimer);
      this.frameTimer = undefined;
    }
    console.debug(`[WindowAbject:${this.id}] destroyWindow — ${this.children.length} children`);
    // Send destroy message to all children (must use request() so the reply
    // is consumed; using send() with a request message causes the reply to
    // fall through as a new handler invocation).
    for (const childId of this.children) {
      try {
        console.debug(`[WindowAbject:${this.id}] destroying child ${childId}`);
        await this.request(request(this.id, childId, 'destroy', {}));
      } catch {
        // Child may already be gone
      }
    }
    this.children = [];
    this.childRects.clear();
    this.expandedSelects.clear();
    this.focusedChildId = undefined;
    this.focusedParentChildId = undefined;

    // Destroy surface
    if (this.surfaceId) {
      console.debug(`[WindowAbject:${this.id}] destroying surface ${this.surfaceId}`);
      await this.request<boolean>(
        request(this.id, this.uiServerId, 'destroySurface', {
          surfaceId: this.surfaceId,
        })
      );
      this.surfaceId = undefined;
    }

    console.debug(`[WindowAbject:${this.id}] calling stop()`);
    await this.stop();
  }
}
