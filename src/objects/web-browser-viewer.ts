/**
 * WebBrowserViewer — visual browser monitor.
 *
 * Per-workspace UI Abject that shows tabs for each open browser page and
 * live screenshots, so users can monitor web automation in real time.
 * Subscribes to WebBrowser for page lifecycle events and polls screenshots
 * on a 3-second timer.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';

const WEB_BROWSER_VIEWER_INTERFACE: InterfaceId = 'abjects:web-browser-viewer';

const WIN_W = 640;
const WIN_H = 480;
const REFRESH_INTERVAL_MS = 1000;

interface PageInfo {
  pageId: string;
  owner: string;
  url: string;
  title: string;
  createdAt: number;
  lastActivity: number;
}

export class WebBrowserViewer extends Abject {
  private webBrowserId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private timerId?: AbjectId;

  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private tabBarId?: AbjectId;
  private urlLabelId?: AbjectId;
  private canvasId?: AbjectId;
  private statusLabelId?: AbjectId;

  private pages: PageInfo[] = [];
  private selectedPageIndex = 0;
  private refreshTimerId?: string;

  constructor() {
    super({
      manifest: {
        name: 'WebBrowserViewer',
        description:
          'Visual browser monitor. Shows tabs for each open browser page with live screenshots for monitoring web automation in real time.',
        version: '1.0.0',
        interface: {
          id: WEB_BROWSER_VIEWER_INTERFACE,
          name: 'WebBrowserViewer',
          description: 'Visual browser page monitor',
          methods: [
            {
              name: 'show',
              description: 'Show the browser viewer window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'hide',
              description: 'Hide the browser viewer window',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'getState',
              description: 'Return current state of the browser viewer',
              parameters: [],
              returns: {
                kind: 'object',
                properties: {
                  visible: { kind: 'primitive', primitive: 'boolean' },
                  pageCount: { kind: 'primitive', primitive: 'number' },
                },
              },
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display browser viewer window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.timerId = await this.requireDep('Timer');
    this.webBrowserId = await this.discoverDep('WebBrowser') ?? undefined;
  }

  private setupHandlers(): void {
    this.on('show', async () => {
      return this.show();
    });

    this.on('hide', async () => {
      return this.hide();
    });

    this.on('getState', async () => {
      return { visible: !!this.windowId, pageCount: this.pages.length };
    });

    this.on('windowCloseRequested', async () => { await this.hide(); });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;
      await this.handleChanged(fromId, aspect, value);
    });

    this.on('timerFired', async (msg: AbjectMessage) => {
      const { timerId: firedId } = msg.payload as { timerId: string };
      if (firedId === this.refreshTimerId) {
        await this.refreshScreenshot();
      }
    });
  }

  // ── Show / Hide ──

  async show(): Promise<boolean> {
    if (this.windowId) {
      try {
        await this.request(request(this.id, this.widgetManagerId!, 'raiseWindow', {
          windowId: this.windowId,
        }));
      } catch { /* best effort */ }
      return true;
    }

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );
    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: '\uD83C\uDF10 Web Viewer',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 200,
        resizable: true,
      })
    );

    // Root VBox
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 0,
      })
    );

    // Batch create non-canvas widgets
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'tabBar', windowId: this.windowId, tabs: [], selectedIndex: 0 },
          { type: 'label', windowId: this.windowId, text: '', style: { color: '#8b8fa3', fontSize: 11 } },
          { type: 'label', windowId: this.windowId, text: 'No browser pages open', style: { color: '#6b7084', fontSize: 11 } },
        ],
      })
    );
    this.tabBarId = widgetIds[0];
    this.urlLabelId = widgetIds[1];
    this.statusLabelId = widgetIds[2];

    // Canvas (expanding) — kept separate due to special creation
    this.canvasId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createCanvas', {
        windowId: this.windowId,
        inputTargetId: this.id,
      })
    );

    // Add all to root layout
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: this.tabBarId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 36 } },
        { widgetId: this.urlLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 22 } },
        { widgetId: this.canvasId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.statusLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 20 } },
      ],
    }));

    await this.request(request(this.id, this.tabBarId, 'addDependent', {}));

    // Subscribe to WebBrowser for page events
    if (this.webBrowserId) {
      try {
        await this.request(
          request(this.id, this.webBrowserId, 'addDependent', {})
        );
      } catch { /* WebBrowser may not be available */ }
    }

    // Start refresh timer
    await this.startRefreshTimer();

    // Populate initial page list
    await this.refreshPageList();
    await this.refreshScreenshot();

    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    // Stop refresh timer
    await this.stopRefreshTimer();

    // Unsubscribe from WebBrowser
    if (this.webBrowserId) {
      try {
        await this.request(
          request(this.id, this.webBrowserId, 'removeDependent', {})
        );
      } catch { /* best effort */ }
    }

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.tabBarId = undefined;
    this.urlLabelId = undefined;
    this.canvasId = undefined;
    this.statusLabelId = undefined;
    this.pages = [];
    this.selectedPageIndex = 0;

    this.changed('visibility', false);
    return true;
  }

  // ── Timer ──

  private async startRefreshTimer(): Promise<void> {
    if (!this.timerId) return;
    try {
      const result = await this.request<{ timerId: string }>(
        request(this.id, this.timerId, 'setInterval', {
          intervalMs: REFRESH_INTERVAL_MS,
        })
      );
      this.refreshTimerId = result.timerId;
    } catch { /* Timer may not be available */ }
  }

  private async stopRefreshTimer(): Promise<void> {
    if (!this.timerId || !this.refreshTimerId) return;
    try {
      await this.request(
        request(this.id, this.timerId, 'clearInterval', {
          timerId: this.refreshTimerId,
        })
      );
    } catch { /* best effort */ }
    this.refreshTimerId = undefined;
  }

  // ── Event Handling ──

  private async handleChanged(fromId: AbjectId, aspect: string, value?: unknown): Promise<void> {
    // TabBar selection change
    if (fromId === this.tabBarId && aspect === 'change') {
      this.selectedPageIndex = value as number;
      await this.updateUrlLabel();
      await this.refreshScreenshot();
      return;
    }

    // WebBrowser page lifecycle events
    if (fromId === this.webBrowserId) {
      if (aspect === 'pageOpened' || aspect === 'pageClosed' || aspect === 'pageNavigated') {
        await this.refreshPageList();
        await this.refreshScreenshot();
      }
    }
  }

  // ── Data Refresh ──

  private async refreshPageList(): Promise<void> {
    if (!this.webBrowserId || !this.windowId) return;

    try {
      this.pages = await this.request<PageInfo[]>(
        request(this.id, this.webBrowserId, 'listPages', {})
      );
    } catch {
      this.pages = [];
    }

    // Clamp selected index
    if (this.pages.length === 0) {
      this.selectedPageIndex = 0;
    } else if (this.selectedPageIndex >= this.pages.length) {
      this.selectedPageIndex = this.pages.length - 1;
    }

    // Update tab bar
    if (this.tabBarId) {
      const tabLabels = this.pages.map((p, i) => {
        const title = p.title || p.url || `Page ${i + 1}`;
        return title.length > 20 ? title.slice(0, 18) + '..' : title;
      });
      try {
        await this.request(
          request(this.id, this.tabBarId, 'update', {
            tabs: tabLabels,
            selectedIndex: this.selectedPageIndex,
          })
        );
      } catch { /* widget gone */ }
    }

    // Update URL label
    await this.updateUrlLabel();

    // Update status label
    if (this.statusLabelId) {
      const statusText = this.pages.length === 0
        ? 'No browser pages open'
        : `${this.pages.length} page${this.pages.length > 1 ? 's' : ''} open | Refresh ${REFRESH_INTERVAL_MS / 1000}s`;
      try {
        await this.request(
          request(this.id, this.statusLabelId, 'update', { text: statusText })
        );
      } catch { /* widget gone */ }
    }
  }

  private async updateUrlLabel(): Promise<void> {
    if (!this.urlLabelId) return;

    const page = this.pages[this.selectedPageIndex];
    const urlText = page ? `  ${page.url}` : '';
    try {
      await this.request(
        request(this.id, this.urlLabelId, 'update', { text: urlText })
      );
    } catch { /* widget gone */ }
  }

  private async refreshScreenshot(): Promise<void> {
    if (!this.canvasId || !this.windowId) return;

    const page = this.pages[this.selectedPageIndex];
    if (!page || !this.webBrowserId) {
      // Show placeholder
      await this.drawPlaceholder();
      return;
    }

    try {
      const shot = await this.request<{ dataUri: string; width: number; height: number }>(
        request(this.id, this.webBrowserId, 'viewerScreenshot', {
          pageId: page.pageId,
        })
      );

      // Get canvas size to scale the screenshot
      const canvasSize = await this.request<{ width: number; height: number }>(
        request(this.id, this.canvasId, 'getCanvasSize', {})
      );

      const cw = canvasSize.width;
      const ch = canvasSize.height;
      if (cw <= 0 || ch <= 0) return;

      // Scale to fit while preserving aspect ratio
      const imgAspect = shot.width / shot.height;
      const canvasAspect = cw / ch;
      let drawW: number, drawH: number, drawX: number, drawY: number;

      if (imgAspect > canvasAspect) {
        // Image wider than canvas — fit to width
        drawW = cw;
        drawH = cw / imgAspect;
        drawX = 0;
        drawY = Math.floor((ch - drawH) / 2);
      } else {
        // Image taller than canvas — fit to height
        drawH = ch;
        drawW = ch * imgAspect;
        drawX = Math.floor((cw - drawW) / 2);
        drawY = 0;
      }

      await this.request(
        request(this.id, this.canvasId, 'draw', {
          commands: [
            { type: 'clear', params: { color: '#1a1a2e' } },
            {
              type: 'imageUrl',
              params: {
                x: drawX, y: drawY,
                width: Math.floor(drawW), height: Math.floor(drawH),
                url: shot.dataUri,
              },
            },
          ],
        })
      );
    } catch {
      // Screenshot failed — show error placeholder
      await this.drawPlaceholder('Screenshot unavailable');
    }
  }

  private async drawPlaceholder(text?: string): Promise<void> {
    if (!this.canvasId) return;

    try {
      const canvasSize = await this.request<{ width: number; height: number }>(
        request(this.id, this.canvasId, 'getCanvasSize', {})
      );

      const cx = Math.floor(canvasSize.width / 2);
      const cy = Math.floor(canvasSize.height / 2);

      await this.request(
        request(this.id, this.canvasId, 'draw', {
          commands: [
            { type: 'clear', params: { color: '#1a1a2e' } },
            {
              type: 'text',
              params: {
                x: cx, y: cy,
                text: text ?? 'No browser pages open',
                font: '13px sans-serif',
                fill: '#6b7084',
                align: 'center',
                baseline: 'middle',
              },
            },
          ],
        })
      );
    } catch { /* canvas gone */ }
  }

  protected override getSourceForAsk(): string | undefined {
    return `## WebBrowserViewer Usage Guide

### Methods
- \`show()\` — Open the browser viewer window. Shows tabs for each open browser page with live screenshots.
- \`hide()\` — Close the browser viewer window.
- \`getState()\` — Returns { visible: boolean, pageCount: number }.

### Features
- Tab bar showing all open browser pages (auto-updated on page open/close/navigate).
- URL bar showing the current page URL.
- Live screenshot canvas that refreshes every 3 seconds.
- Screenshots are scaled to fit the canvas while preserving aspect ratio.
- When no pages are open, shows a placeholder message.

### Interface ID
\`abjects:web-browser-viewer\``;
  }
}

export const WEB_BROWSER_VIEWER_ID = 'abjects:web-browser-viewer' as AbjectId;
