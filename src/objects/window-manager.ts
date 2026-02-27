/**
 * WindowManager — centralized window behavior policy (z-order, drag, resize).
 *
 * Tracks all windows by surfaceId, raises them on activation, and handles
 * all drag/resize operations. Delegates low-level display operations to UIServer
 * and notifies WindowAbjects of rect changes via `windowRect` events.
 */

import {
  AbjectId,
  AbjectMessage,
  InterfaceId,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require as contractRequire } from '../core/contracts.js';
import { request, event } from '../core/message.js';
import {
  Rect,
  TITLE_BAR_HEIGHT,
  EDGE_SIZE,
} from './widgets/widget-types.js';

const WM_INTERFACE: InterfaceId = 'abjects:window-manager';

interface WindowInfo {
  windowId: AbjectId;
  zIndex: number;
  rect: Rect;
  chromeless: boolean;
  draggable: boolean;
  minimized: boolean;
  title: string;
  titleBarHeight: number;
  titleButtonSize: number;
  titleButtonMargin: number;
  workspaceId?: string;
}

interface DragState {
  surfaceId: string;
  windowId: AbjectId;
  type: 'move' | 'resize';
  edge: string;
  startMouseX: number;
  startMouseY: number;
  startRect: Rect;
}

/**
 * WindowManager — owns window behavior policy (z-order, drag, resize).
 * UIServer stays as a low-level display server; WindowAbject receives rect updates.
 */
export class WindowManager extends Abject {
  private windows: Map<string, WindowInfo> = new Map();
  private uiServerId?: AbjectId;
  private taskbarId?: AbjectId;
  private taskbarsByWorkspace: Map<string, AbjectId> = new Map();
  private dragState?: DragState;

  constructor() {
    super({
      manifest: {
        name: 'WindowManager',
        description:
          'Centralized window manager — owns z-order policy, drag, and resize behavior.',
        version: '1.0.0',
        interface: {
            id: WM_INTERFACE,
            name: 'WindowManager',
            description: 'Window z-order management, drag, and resize',
            methods: [
              {
                name: 'registerWindow',
                description: 'Track a new window',
                parameters: [
                  { name: 'surfaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Surface ID' },
                  { name: 'windowId', type: { kind: 'primitive', primitive: 'string' }, description: 'Window AbjectId' },
                  { name: 'zIndex', type: { kind: 'primitive', primitive: 'number' }, description: 'Initial z-index' },
                  { name: 'rect', type: { kind: 'reference', reference: 'Rect' }, description: 'Initial window rect' },
                  { name: 'chromeless', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Whether window has no title bar' },
                  { name: 'draggable', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Whether chromeless window is draggable', optional: true },
                  { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: 'Window title (for taskbar)', optional: true },
                  { name: 'titleBarHeight', type: { kind: 'primitive', primitive: 'number' }, description: 'Title bar height for hit-testing', optional: true },
                  { name: 'titleButtonSize', type: { kind: 'primitive', primitive: 'number' }, description: 'Button hit area size', optional: true },
                  { name: 'titleButtonMargin', type: { kind: 'primitive', primitive: 'number' }, description: 'Margin between buttons and edge', optional: true },
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Workspace this window belongs to', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'unregisterWindow',
                description: 'Stop tracking a window',
                parameters: [
                  { name: 'surfaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Surface ID to unregister' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'raiseWindow',
                description: 'Bring a window to front',
                parameters: [
                  { name: 'surfaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Surface ID to raise' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getWindows',
                description: 'Return list of tracked windows',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'WindowInfo' } },
              },
              {
                name: 'restoreWindow',
                description: 'Restore a minimized window',
                parameters: [
                  { name: 'surfaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Surface ID to restore' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'registerTaskbar',
                description: 'Register a per-workspace Taskbar so minimize/restore events route to the correct one',
                parameters: [
                  { name: 'taskbarId', type: { kind: 'primitive', primitive: 'string' }, description: 'AbjectId of the Taskbar' },
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Workspace the Taskbar belongs to' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'unregisterTaskbar',
                description: 'Remove a per-workspace Taskbar registration',
                parameters: [
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Workspace to unregister' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'surfaceMouseDown',
                description: 'Handle mousedown on a surface — detect drag/resize grab',
                parameters: [
                  { name: 'surfaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'Surface ID' },
                  { name: 'localX', type: { kind: 'primitive', primitive: 'number' }, description: 'Mouse X in surface-local coords' },
                  { name: 'localY', type: { kind: 'primitive', primitive: 'number' }, description: 'Mouse Y in surface-local coords' },
                ],
                returns: { kind: 'object', properties: { grab: { kind: 'primitive', primitive: 'boolean' } } },
              },
            ],
          },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('registerWindow', async (msg: AbjectMessage) => {
      const { surfaceId, windowId, zIndex, rect, chromeless, draggable, title, titleBarHeight, titleButtonSize, titleButtonMargin, workspaceId } = msg.payload as {
        surfaceId: string;
        windowId: AbjectId;
        zIndex: number;
        rect?: Rect;
        chromeless?: boolean;
        draggable?: boolean;
        title?: string;
        titleBarHeight?: number;
        titleButtonSize?: number;
        titleButtonMargin?: number;
        workspaceId?: string;
      };
      this.windows.set(surfaceId, {
        windowId,
        zIndex,
        rect: rect ? { ...rect } : { x: 0, y: 0, width: 0, height: 0 },
        chromeless: chromeless ?? false,
        draggable: draggable ?? false,
        minimized: false,
        title: title ?? '',
        titleBarHeight: titleBarHeight ?? TITLE_BAR_HEIGHT,
        titleButtonSize: titleButtonSize ?? 20,
        titleButtonMargin: titleButtonMargin ?? 7,
        workspaceId,
      });
      return true;
    });

    this.on('unregisterWindow', async (msg: AbjectMessage) => {
      const { surfaceId } = msg.payload as { surfaceId?: string; windowId?: AbjectId };
      const removeWindow = async (sid: string, info: WindowInfo) => {
        // If the window was minimized, notify Taskbar to clean up its entry
        if (info.minimized && this.taskbarId) {
          try {
            await this.send(
              event(this.id, this.taskbarId, 'windowRestored', {
                surfaceId: sid, windowId: info.windowId,
              })
            );
          } catch { /* Taskbar may be gone */ }
        }
        this.windows.delete(sid);
      };
      if (surfaceId) {
        const info = this.windows.get(surfaceId);
        if (info) { await removeWindow(surfaceId, info); return true; }
        return false;
      }
      // Also support unregister by windowId
      const { windowId } = msg.payload as { windowId?: AbjectId };
      if (windowId) {
        for (const [sid, info] of this.windows) {
          if (info.windowId === windowId) {
            await removeWindow(sid, info);
            return true;
          }
        }
      }
      return false;
    });

    this.on('raiseWindow', async (msg: AbjectMessage) => {
      const { surfaceId } = msg.payload as { surfaceId: string };
      return this.raiseWindow(surfaceId);
    });

    this.on('getWindows', async () => {
      const result: Array<{ surfaceId: string; windowId: AbjectId; zIndex: number }> = [];
      for (const [surfaceId, info] of this.windows) {
        result.push({ surfaceId, windowId: info.windowId, zIndex: info.zIndex });
      }
      return result;
    });

    // Request from UIServer on mousedown — detect drag start, raise window
    this.on('surfaceMouseDown', async (msg: AbjectMessage) => {
      const { surfaceId, localX, localY } = msg.payload as {
        surfaceId: string;
        localX: number;
        localY: number;
      };
      return this.handleSurfaceMouseDown(surfaceId, localX, localY);
    });

    // Event from UIServer on mousemove during grab
    this.on('dragMove', async (msg: AbjectMessage) => {
      const { globalX, globalY } = msg.payload as { globalX: number; globalY: number };
      await this.handleDragMove(globalX, globalY);
    });

    // Event from UIServer on mouseup during grab
    this.on('dragEnd', async (msg: AbjectMessage) => {
      const { globalX, globalY } = msg.payload as { globalX: number; globalY: number };
      await this.handleDragEnd(globalX, globalY);
    });

    // Legacy: Event from UIServer on mousedown — raise the clicked window
    this.on('surfaceActivated', async (msg: AbjectMessage) => {
      const { surfaceId } = msg.payload as { surfaceId: string };
      await this.raiseWindow(surfaceId);
    });

    // Restore a minimized window
    this.on('restoreWindow', async (msg: AbjectMessage) => {
      const { surfaceId } = msg.payload as { surfaceId: string };
      await this.restoreWindow(surfaceId);
      return true;
    });

    // Start a drag on a window (Ctrl+click from UIServer, or chromeless+draggable from WindowAbject)
    this.on('startDrag', async (msg: AbjectMessage) => {
      const { surfaceId, globalX, globalY } = msg.payload as {
        surfaceId: string; globalX: number; globalY: number;
      };
      const info = this.windows.get(surfaceId);
      if (!info) return;
      // Set dragState BEFORE raiseWindow so incoming dragMove events work immediately
      this.dragState = {
        surfaceId,
        windowId: info.windowId,
        type: 'move',
        edge: '',
        startMouseX: globalX,
        startMouseY: globalY,
        startRect: { ...info.rect },
      };
      this.raiseWindow(surfaceId).catch(() => { /* best-effort */ });
    });

    // WorkspaceManager registers per-workspace Taskbars
    this.on('registerTaskbar', async (msg: AbjectMessage) => {
      const { taskbarId, workspaceId } = msg.payload as { taskbarId: AbjectId; workspaceId: string };
      this.taskbarsByWorkspace.set(workspaceId, taskbarId);
      return true;
    });

    this.on('unregisterTaskbar', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      this.taskbarsByWorkspace.delete(workspaceId);
      return true;
    });
  }

  protected override getSourceForAsk(): string | undefined {
    return `## WindowManager Usage Guide

### Overview

WindowManager is the centralized window behavior policy object. It owns z-order,
drag, resize, minimize, and restore behavior for all windows in the system.

### Window Registration

WidgetManager registers each window with WindowManager via 'registerWindow':

  await this.call(windowManagerId, 'abjects:window-manager', 'registerWindow', {
    surfaceId: 'surface-id',  // UIServer surface ID
    windowId: winAbjectId,    // WindowAbject ID
    zIndex: 200,              // Initial stacking order
    rect: { x, y, width, height },
    chromeless: false,        // true = no title bar
    draggable: false,         // true = chromeless window can be dragged
    title: 'My Window',       // Shown in taskbar when minimized
    titleBarHeight: 32,       // For button hit-testing
    titleButtonSize: 20,      // Close/minimize button hit area
    titleButtonMargin: 7,     // Margin between buttons and edge
  });

### Title Bar Buttons

Non-chromeless windows have close (X) and minimize (_) buttons in the title bar.
WindowManager hit-tests these on mousedown:

- Close button (rightmost): sends 'titleBarAction' { action: 'close' } to WindowAbject.
  WindowAbject then emits 'windowCloseRequested' to its dependents (WidgetManager).
  WidgetManager forwards this to the window's owner.

- Minimize button (left of close): WindowManager hides the surface via UIServer,
  sends 'titleBarAction' { action: 'minimize' } to WindowAbject, and notifies Taskbar.

### Minimize and Restore Flow

Minimize:
1. WindowManager hides surface via UIServer setSurfaceVisible(false)
2. Sends 'titleBarAction' { action: 'minimize' } to WindowAbject
3. Notifies Taskbar with 'windowMinimized' event

Restore (via 'restoreWindow' method or Taskbar click):
1. WindowManager shows surface via UIServer setSurfaceVisible(true)
2. Raises the window to front
3. Sends 'titleBarAction' { action: 'restore' } to WindowAbject
4. Notifies Taskbar with 'windowRestored' event

### Programmatic Restore

  await this.call(windowManagerId, 'abjects:window-manager', 'restoreWindow', {
    surfaceId: 'surface-id',
  });

### Raising a Window

  await this.call(windowManagerId, 'abjects:window-manager', 'raiseWindow', {
    surfaceId: 'surface-id',
  });

### Interface ID

'abjects:window-manager'`;
  }

  protected override async onInit(): Promise<void> {
    this.uiServerId = await this.requireDep('UIServer');
    this.taskbarId = await this.discoverDep('Taskbar') ?? undefined;

    // Register ourselves with UIServer so it sends us surfaceActivated events
    await this.request(
      request(this.id, this.uiServerId, 'registerWindowManager', {})
    );
  }

  // ── Surface Mouse Down — detect drag/resize grab ─────────────────────

  private async handleSurfaceMouseDown(
    surfaceId: string,
    localX: number,
    localY: number,
  ): Promise<{ grab: boolean; minimize?: string }> {
    const info = this.windows.get(surfaceId);
    if (!info) return { grab: false };

    // Always raise the window on mousedown
    await this.raiseWindow(surfaceId);

    // Check resize edges first
    const edge = this.detectResizeEdge(info, localX, localY);
    if (edge) {
      this.dragState = {
        surfaceId,
        windowId: info.windowId,
        type: 'resize',
        edge,
        startMouseX: localX + info.rect.x,
        startMouseY: localY + info.rect.y,
        startRect: { ...info.rect },
      };
      return { grab: true };
    }

    // Title bar: check close/minimize buttons before drag (non-chromeless windows)
    if (!info.chromeless && localY < TITLE_BAR_HEIGHT) {
      const btn = this.detectTitleButton(info, localX, localY);
      if (btn === 'close') {
        await this.send(
          event(this.id, info.windowId, 'titleBarAction', { action: 'close' })
        );
        return { grab: false };
      }
      if (btn === 'minimize') {
        this.minimizeWindow(surfaceId).catch(() => {});
        return { grab: false, minimize: surfaceId };
      }

      // No button hit — start drag
      this.dragState = {
        surfaceId,
        windowId: info.windowId,
        type: 'move',
        edge: '',
        startMouseX: localX + info.rect.x,
        startMouseY: localY + info.rect.y,
        startRect: { ...info.rect },
      };
      return { grab: true };
    }

    return { grab: false };
  }

  // ── Drag Move ────────────────────────────────────────────────────────

  private async handleDragMove(globalX: number, globalY: number): Promise<void> {
    if (!this.dragState || !this.uiServerId) return;

    const newRect = this.computeDragRect(globalX, globalY);
    const info = this.windows.get(this.dragState.surfaceId);
    if (!info) return;

    const moved = newRect.x !== info.rect.x || newRect.y !== info.rect.y;
    const resized = newRect.width !== info.rect.width || newRect.height !== info.rect.height;

    // Update tracked rect
    info.rect = { ...newRect };

    if (moved) {
      try {
        await this.request(
          request(this.id, this.uiServerId, 'moveSurface', {
            surfaceId: this.dragState.surfaceId, x: newRect.x, y: newRect.y,
          })
        );
      } catch { /* UIServer may be gone */ }
    }

    if (resized) {
      try {
        await this.request(
          request(this.id, this.uiServerId, 'resizeSurface', {
            surfaceId: this.dragState.surfaceId, width: newRect.width, height: newRect.height,
          })
        );
      } catch { /* UIServer may be gone */ }

      // Notify WindowAbject of rect change (it will update children and re-render)
      await this.send(
        event(this.id, this.dragState.windowId, 'windowRect', {
          x: newRect.x, y: newRect.y, width: newRect.width, height: newRect.height,
        })
      );
    }
  }

  // ── Drag End ─────────────────────────────────────────────────────────

  private async handleDragEnd(globalX: number, globalY: number): Promise<void> {
    if (!this.dragState || !this.uiServerId) return;

    const newRect = this.computeDragRect(globalX, globalY);
    const info = this.windows.get(this.dragState.surfaceId);
    if (info) {
      const moved = newRect.x !== info.rect.x || newRect.y !== info.rect.y;
      const resized = newRect.width !== info.rect.width || newRect.height !== info.rect.height;

      info.rect = { ...newRect };

      if (moved) {
        try {
          await this.request(
            request(this.id, this.uiServerId, 'moveSurface', {
              surfaceId: this.dragState.surfaceId, x: newRect.x, y: newRect.y,
            })
          );
        } catch { /* UIServer may be gone */ }
      }

      if (resized) {
        try {
          await this.request(
            request(this.id, this.uiServerId, 'resizeSurface', {
              surfaceId: this.dragState.surfaceId, width: newRect.width, height: newRect.height,
            })
          );
        } catch { /* UIServer may be gone */ }
      }
    }

    // Send final windowRect event to WindowAbject
    await this.send(
      event(this.id, this.dragState.windowId, 'windowRect', {
        x: newRect.x, y: newRect.y, width: newRect.width, height: newRect.height,
      })
    );

    this.dragState = undefined;
  }

  // ── Detect resize edge ───────────────────────────────────────────────

  private detectResizeEdge(info: WindowInfo, localX: number, localY: number): string | null {
    if (info.chromeless) return null;

    const n = localY < EDGE_SIZE;
    const s = localY > info.rect.height - EDGE_SIZE;
    const w = localX < EDGE_SIZE;
    const e = localX > info.rect.width - EDGE_SIZE;

    if (n && w) return 'nw';
    if (n && e) return 'ne';
    if (s && w) return 'sw';
    if (s && e) return 'se';
    if (n) return 'n';
    if (s) return 's';
    if (w) return 'w';
    if (e) return 'e';

    return null;
  }

  // ── Compute new rect from drag state + mouse position ────────────────

  private computeDragRect(globalX: number, globalY: number): Rect {
    contractRequire(this.dragState !== undefined, 'No active drag state');
    const ds = this.dragState!;
    const dx = globalX - ds.startMouseX;
    const dy = globalY - ds.startMouseY;

    if (ds.type === 'move') {
      return {
        x: ds.startRect.x + dx,
        y: ds.startRect.y + dy,
        width: ds.startRect.width,
        height: ds.startRect.height,
      };
    }

    // Resize
    const sr = ds.startRect;
    let newX = sr.x;
    let newY = sr.y;
    let newW = sr.width;
    let newH = sr.height;
    const edge = ds.edge;

    if (edge.includes('e')) newW = sr.width + dx;
    if (edge.includes('w')) { newW = sr.width - dx; newX = sr.x + dx; }
    if (edge.includes('s')) newH = sr.height + dy;
    if (edge.includes('n')) { newH = sr.height - dy; newY = sr.y + dy; }

    // Enforce minimum size
    if (newW < 100) { if (edge.includes('w')) newX = sr.x + sr.width - 100; newW = 100; }
    if (newH < 60) { if (edge.includes('n')) newY = sr.y + sr.height - 60; newH = 60; }

    return { x: newX, y: newY, width: newW, height: newH };
  }

  // ── Title bar button detection ───────────────────────────────────────

  private detectTitleButton(
    info: WindowInfo,
    localX: number,
    localY: number,
  ): 'close' | 'minimize' | null {
    const btnSize = info.titleButtonSize;
    const btnMargin = info.titleButtonMargin;
    const tbHeight = info.titleBarHeight;
    const w = info.rect.width;

    // Only in title bar vertical range
    if (localY >= tbHeight) return null;

    // Close button: rightmost
    const closeCx = w - btnMargin - btnSize / 2;
    const closeCy = tbHeight / 2;
    if (Math.abs(localX - closeCx) <= btnSize / 2 && Math.abs(localY - closeCy) <= btnSize / 2) {
      return 'close';
    }

    // Minimize button: left of close
    const minCx = closeCx - btnSize - btnMargin;
    const minCy = tbHeight / 2;
    if (Math.abs(localX - minCx) <= btnSize / 2 && Math.abs(localY - minCy) <= btnSize / 2) {
      return 'minimize';
    }

    return null;
  }

  // ── Taskbar resolution by workspace ─────────────────────────────────

  /**
   * Resolve the correct Taskbar for a window.
   * Uses the window's workspace tag to find the per-workspace Taskbar;
   * falls back to the globally discovered Taskbar for untagged windows.
   */
  private async getTaskbarForWindow(surfaceId: string): Promise<AbjectId | undefined> {
    const info = this.windows.get(surfaceId);
    if (info?.workspaceId) {
      const wsTaskbar = this.taskbarsByWorkspace.get(info.workspaceId);
      if (wsTaskbar) return wsTaskbar;
    }
    // Fallback: lazy-discover a global Taskbar (pre-workspace compat)
    if (!this.taskbarId) {
      this.taskbarId = await this.discoverDep('Taskbar') ?? undefined;
    }
    return this.taskbarId;
  }

  // ── Minimize / Restore ──────────────────────────────────────────────

  private async minimizeWindow(surfaceId: string): Promise<void> {
    const info = this.windows.get(surfaceId);
    if (!info) return;

    info.minimized = true;

    // Hide the surface via UIServer (fire-and-forget; primary hide is via
    // the { minimize } field in the surfaceMouseDown reply to UIServer)
    if (this.uiServerId) {
      this.send(
        event(this.id, this.uiServerId, 'setSurfaceVisible', {
          surfaceId, visible: false,
        })
      ).catch(() => {});
    }

    // Notify WindowAbject
    await this.send(
      event(this.id, info.windowId, 'titleBarAction', { action: 'minimize' })
    );

    // Notify the correct workspace Taskbar
    const taskbarId = await this.getTaskbarForWindow(surfaceId);
    if (taskbarId) {
      try {
        await this.send(
          event(this.id, taskbarId, 'windowMinimized', {
            surfaceId, windowId: info.windowId, title: info.title,
          })
        );
      } catch { /* Taskbar may be gone */ }
    }
  }

  private async restoreWindow(surfaceId: string): Promise<void> {
    const info = this.windows.get(surfaceId);
    if (!info) return;

    info.minimized = false;

    // Show the surface via UIServer (fire-and-forget, consistent with minimize path)
    if (this.uiServerId) {
      this.send(
        event(this.id, this.uiServerId, 'setSurfaceVisible', {
          surfaceId, visible: true,
        })
      ).catch(() => {});
    }

    await this.raiseWindow(surfaceId);

    // Notify WindowAbject
    await this.send(
      event(this.id, info.windowId, 'titleBarAction', { action: 'restore' })
    );

    // Notify the correct workspace Taskbar
    const taskbarId = await this.getTaskbarForWindow(surfaceId);
    if (taskbarId) {
      try {
        await this.send(
          event(this.id, taskbarId, 'windowRestored', {
            surfaceId, windowId: info.windowId,
          })
        );
      } catch { /* Taskbar may be gone */ }
    }
  }

  // ── Raise window ─────────────────────────────────────────────────────

  /**
   * Raise a window to the front of the z-order.
   *
   * 1. Look up window by surfaceId
   * 2. If not tracked or zIndex >= 999 (overlay tier), skip
   * 3. Compute maxZ = max zIndex among all tracked windows with zIndex < 999
   * 4. If window already at maxZ, skip (already on top)
   * 5. Set new zIndex = maxZ + 1
   * 6. Call UIServer setZIndex
   * 7. Update local tracking
   */
  private async raiseWindow(surfaceId: string): Promise<boolean> {
    const info = this.windows.get(surfaceId);
    if (!info) return false;

    // Don't raise overlay-tier windows (taskbar, etc.)
    if (info.zIndex >= 999) return false;

    // Compute max z-index among non-overlay windows
    let maxZ = 0;
    for (const [, w] of this.windows) {
      if (w.zIndex < 999 && w.zIndex > maxZ) {
        maxZ = w.zIndex;
      }
    }

    // Already on top
    if (info.zIndex >= maxZ) return false;

    const newZIndex = maxZ + 1;

    // Call UIServer to update the compositor
    if (this.uiServerId) {
      try {
        await this.request(
          request(this.id, this.uiServerId, 'setZIndex', {
            surfaceId,
            zIndex: newZIndex,
          })
        );
      } catch {
        return false;
      }
    }

    // Update local tracking
    info.zIndex = newZIndex;

    return true;
  }
}

// Well-known WindowManager ID
export const WINDOW_MANAGER_ID = 'abjects:window-manager' as AbjectId;
