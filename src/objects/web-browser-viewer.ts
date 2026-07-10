/**
 * WebBrowserViewer — visual browser monitor with human takeover.
 *
 * Per-workspace UI Abject that shows tabs for each open browser page and
 * live screenshots, so users can monitor web automation in real time.
 * Subscribes to WebBrowser for page lifecycle events and polls screenshots
 * on a timer.
 *
 * Beyond read-only monitoring, the user can take control of a page: mouse
 * and keyboard input on the screenshot canvas is mapped into page
 * coordinates and replayed through the browser as trusted input (real mouse
 * trails, real key events). Agents blocked on something only a human can do
 * (e.g. an interactive verification challenge) can call `requestControl` to
 * open the viewer and prompt the user to take over; the request resolves
 * when the user hands control back.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { request } from '../core/message.js';
import { require as requireContract, requireNonEmpty } from '../core/contracts.js';
import { Capabilities } from '../core/capability.js';

const WEB_BROWSER_VIEWER_INTERFACE: InterfaceId = 'abjects:web-browser-viewer';

const WIN_W = 640;
const WIN_H = 480;
const REFRESH_INTERVAL_MS = 1000;
/** Faster screenshot cadence while the user is driving the page. */
const CONTROL_REFRESH_INTERVAL_MS = 250;
/** Coalescing window for mousemove trails before a viewerInput flush. */
const FLUSH_INTERVAL_MS = 40;
/** How long a requestControl handoff waits for the user by default. */
const HANDOFF_DEFAULT_TIMEOUT_MS = 5 * 60_000;

interface PageInfo {
  pageId: string;
  owner: string;
  url: string;
  title: string;
  createdAt: number;
  lastActivity: number;
}

/** Scale-to-fit transform of the last drawn screenshot (canvas → page px). */
interface FitTransform {
  drawX: number;
  drawY: number;
  drawW: number;
  drawH: number;
  shotW: number;
  shotH: number;
}

/** Raw event queued for WebBrowser.viewerInput. */
interface RawPageEvent {
  type: 'mousemove' | 'mousedown' | 'mouseup' | 'wheel' | 'key' | 'insertText';
  x?: number;
  y?: number;
  button?: number;
  deltaY?: number;
  key?: string;
  text?: string;
}

/** An agent's pending human-handoff request awaiting a deferred reply. */
interface PendingHandoff {
  msg: AbjectMessage;
  pageId: string;
  reason: string;
  timer: ReturnType<typeof setTimeout>;
  /** 'handback' resolves when the user hands control back (default);
   *  'takeover' resolves as soon as the user takes control. */
  resolveOn: 'handback' | 'takeover';
}

export class WebBrowserViewer extends Abject {
  private webBrowserId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private timerId?: AbjectId;

  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private tabBarId?: AbjectId;
  private backBtnId?: AbjectId;
  private fwdBtnId?: AbjectId;
  private reloadBtnId?: AbjectId;
  private urlLabelId?: AbjectId;
  private controlBtnId?: AbjectId;
  private bannerRowId?: AbjectId;
  private bannerLabelId?: AbjectId;
  private bannerTakeBtnId?: AbjectId;
  private bannerDismissBtnId?: AbjectId;
  private canvasId?: AbjectId;
  private statusLabelId?: AbjectId;

  private pages: PageInfo[] = [];
  private selectedPageIndex = 0;
  private refreshTimerId?: string;
  private refreshIntervalMs = REFRESH_INTERVAL_MS;
  /** Anti-flicker state: skip redraws when the frame hasn't changed, keep the
   *  last good frame through transient screenshot failures, and never run two
   *  refreshes concurrently (out-of-order draws). */
  private refreshing = false;
  private lastShotDataUri?: string;
  private lastCanvasSize = { width: 0, height: 0 };

  // ── Human takeover state ──
  private controlMode = false;
  private lastTransform?: FitTransform;
  private pendingEvents: RawPageEvent[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private flushing = false;
  private mouseButtonsDown = new Set<number>();
  private lastPagePos = { x: 0, y: 0 };
  private pendingHandoff?: PendingHandoff;

  constructor() {
    super({
      manifest: {
        name: 'WebBrowserViewer',
        description:
          'Visual browser monitor with human takeover. Shows tabs for each open browser page with live screenshots, and lets the user take control of a page: their mouse and keyboard input is replayed into the real page. Agents can call requestControl to prompt the user to intervene (e.g. complete a human-verification challenge) and are notified when the user hands control back.',
        version: '1.1.0',
        interface: {
          id: WEB_BROWSER_VIEWER_INTERFACE,
          name: 'WebBrowserViewer',
          description: 'Visual browser page monitor and human takeover surface',
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
                  controlling: { kind: 'primitive', primitive: 'boolean' },
                  handoffPending: { kind: 'primitive', primitive: 'boolean' },
                },
              },
            },
            {
              name: 'requestControl',
              description:
                'Ask the human at the screen to take control of a browser page. Opens the viewer window, selects the page tab, and shows a prompt with the given reason plus Take Control / Dismiss buttons. The reply is deferred: with resolveOn "handback" (default) it resolves { completed: true } when the user hands control back — use for steps the caller must wait out, like a verification challenge. With resolveOn "takeover" it resolves as soon as the user takes control — use when the point is simply to give the user the page (co-browsing) and the caller should not block on them finishing. Dismiss or timeout resolves { completed: false, reason }.',
              parameters: [
                { name: 'pageId', type: { kind: 'primitive', primitive: 'string' }, description: 'Browser page handle the human should act on' },
                { name: 'reason', type: { kind: 'primitive', primitive: 'string' }, description: 'Short message shown to the user explaining what to do' },
                { name: 'timeoutMs', type: { kind: 'primitive', primitive: 'number' }, description: 'How long to wait for the user before giving up (default 300000)', optional: true },
                { name: 'resolveOn', type: { kind: 'primitive', primitive: 'string' }, description: "'handback' (default) resolves when the user hands control back; 'takeover' resolves as soon as they take control", optional: true },
              ],
              returns: {
                kind: 'object',
                properties: {
                  completed: { kind: 'primitive', primitive: 'boolean' },
                  reason: { kind: 'primitive', primitive: 'string' },
                },
              },
            },
          ],
          events: [
            {
              name: 'humanControlRequested',
              description: 'An agent asked the user to take control of a page. Payload: { pageId, reason }',
              payload: {
                kind: 'object',
                properties: {
                  pageId: { kind: 'primitive', primitive: 'string' },
                  reason: { kind: 'primitive', primitive: 'string' },
                },
              },
            },
            {
              name: 'humanControlStarted',
              description: 'The user took control of a page. Payload: { pageId }',
              payload: {
                kind: 'object',
                properties: {
                  pageId: { kind: 'primitive', primitive: 'string' },
                },
              },
            },
            {
              name: 'humanControlEnded',
              description: 'The user handed control back (or the handoff was dismissed / timed out). Payload: { completed }',
              payload: {
                kind: 'object',
                properties: {
                  completed: { kind: 'primitive', primitive: 'boolean' },
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

  protected override checkInvariants(): void {
    super.checkInvariants();
    requireContract(!this.controlMode || this.windowId !== undefined,
      'control mode requires a visible window');
    requireContract(this.selectedPageIndex >= 0, 'selected page index is non-negative');
  }

  private setupHandlers(): void {
    this.on('show', async () => {
      return this.show();
    });

    this.on('hide', async () => {
      return this.hide();
    });

    this.on('getState', async () => {
      return {
        visible: !!this.windowId,
        pageCount: this.pages.length,
        controlling: this.controlMode,
        handoffPending: !!this.pendingHandoff,
      };
    });

    this.on('requestControl', async (msg: AbjectMessage) => {
      const { pageId, reason, timeoutMs, resolveOn } = msg.payload as {
        pageId: string; reason: string; timeoutMs?: number;
        resolveOn?: 'handback' | 'takeover';
      };
      requireNonEmpty(pageId, 'requestControl requires a pageId');
      requireNonEmpty(reason, 'requestControl requires a reason');

      if (this.pendingHandoff) {
        return { completed: false, reason: 'busy: another human handoff is already pending' };
      }

      await this.show();
      await this.selectPage(pageId);

      // The user is already driving — a takeover-mode request is satisfied
      if (this.controlMode && resolveOn === 'takeover') {
        return { completed: true, reason: 'the user is already in control' };
      }

      const timer = setTimeout(() => {
        void this.resolveHandoff(false, 'timeout: the user did not respond in time');
      }, timeoutMs ?? HANDOFF_DEFAULT_TIMEOUT_MS);
      this.pendingHandoff = { msg, pageId, reason, timer, resolveOn: resolveOn ?? 'handback' };

      await this.updateControlUi();
      this.changed('humanControlRequested', { pageId, reason });
      return DEFERRED_REPLY;
    });

    this.on('windowCloseRequested', async () => { await this.hide(); });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;
      await this.handleChanged(fromId, aspect, value);
    });

    this.on('input', async (msg: AbjectMessage) => {
      await this.handleCanvasInput(msg.payload as Record<string, unknown>);
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
        title: '🌐 Web Viewer',
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
          { type: 'tabBar', windowId: this.windowId, tabs: [], selectedIndex: 0, closable: true },
          { type: 'button', windowId: this.windowId, text: '◀' },
          { type: 'button', windowId: this.windowId, text: '▶' },
          { type: 'button', windowId: this.windowId, text: '⟳' },
          { type: 'label', windowId: this.windowId, text: '', style: { color: '#8b8fa3', fontSize: 11 } },
          { type: 'button', windowId: this.windowId, text: 'Take Control' },
          { type: 'label', windowId: this.windowId, text: '', style: { color: '#e8b45a', fontSize: 12 } },
          { type: 'button', windowId: this.windowId, text: 'Take Control' },
          { type: 'button', windowId: this.windowId, text: 'Dismiss' },
          { type: 'label', windowId: this.windowId, text: 'No browser pages open', style: { color: '#6b7084', fontSize: 11 } },
        ],
      })
    );
    this.tabBarId = widgetIds[0];
    this.backBtnId = widgetIds[1];
    this.fwdBtnId = widgetIds[2];
    this.reloadBtnId = widgetIds[3];
    this.urlLabelId = widgetIds[4];
    this.controlBtnId = widgetIds[5];
    this.bannerLabelId = widgetIds[6];
    this.bannerTakeBtnId = widgetIds[7];
    this.bannerDismissBtnId = widgetIds[8];
    this.statusLabelId = widgetIds[9];

    // Assemble top-to-bottom. Nested HBoxes auto-add themselves to the root
    // layout at creation, so creation order IS row order: tab bar first, then
    // the url row, the handoff banner, the canvas, and the status line.
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.tabBarId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    // URL row: url label (expanding) + control toggle button (fixed)
    const urlRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 4, bottom: 0, left: 0 },
        spacing: 6,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: urlRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 26 },
    }));
    await this.request(request(this.id, urlRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.backBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 28, height: 24 } },
        { widgetId: this.fwdBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 28, height: 24 } },
        { widgetId: this.reloadBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 28, height: 24 } },
        { widgetId: this.urlLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 22 } },
        { widgetId: this.controlBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 130, height: 24 } },
      ],
    }));

    // Handoff banner row: reason label (expanding) + take/dismiss buttons
    this.bannerRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 2, right: 4, bottom: 2, left: 8 },
        spacing: 6,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.bannerRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 32 },
    }));
    await this.request(request(this.id, this.bannerRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.bannerLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 28 } },
        { widgetId: this.bannerTakeBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 130, height: 26 } },
        { widgetId: this.bannerDismissBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 90, height: 26 } },
      ],
    }));

    // Canvas (expanding) — kept separate due to special creation
    this.canvasId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createCanvas', {
        windowId: this.windowId,
        inputTargetId: this.id,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: this.canvasId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.statusLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 20 } },
      ],
    }));

    // Banner only appears when an agent requests a handoff
    await this.request(request(this.id, this.bannerRowId, 'update', { visible: false }));

    // Subscribe to interactive widgets
    await this.request(request(this.id, this.tabBarId, 'addDependent', {}));
    await this.request(request(this.id, this.backBtnId, 'addDependent', {}));
    await this.request(request(this.id, this.fwdBtnId, 'addDependent', {}));
    await this.request(request(this.id, this.reloadBtnId, 'addDependent', {}));
    await this.request(request(this.id, this.controlBtnId, 'addDependent', {}));
    await this.request(request(this.id, this.bannerTakeBtnId, 'addDependent', {}));
    await this.request(request(this.id, this.bannerDismissBtnId, 'addDependent', {}));

    // Subscribe to WebBrowser for page events
    if (this.webBrowserId) {
      try {
        await this.request(
          request(this.id, this.webBrowserId, 'addDependent', {})
        );
      } catch { /* WebBrowser may not be available */ }
    }

    // Start refresh timer
    await this.startRefreshTimer(REFRESH_INTERVAL_MS);

    // Populate initial page list
    await this.refreshPageList();
    await this.refreshScreenshot();

    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    // End any takeover state before tearing the window down
    this.controlMode = false;
    this.clearInputQueue();
    await this.resolveHandoff(false, 'dismissed: viewer was closed');

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
    this.backBtnId = undefined;
    this.fwdBtnId = undefined;
    this.reloadBtnId = undefined;
    this.urlLabelId = undefined;
    this.controlBtnId = undefined;
    this.bannerRowId = undefined;
    this.bannerLabelId = undefined;
    this.bannerTakeBtnId = undefined;
    this.bannerDismissBtnId = undefined;
    this.canvasId = undefined;
    this.statusLabelId = undefined;
    this.pages = [];
    this.selectedPageIndex = 0;
    this.lastTransform = undefined;
    this.lastShotDataUri = undefined;

    this.changed('visibility', false);
    return true;
  }

  // ── Timer ──

  private async startRefreshTimer(intervalMs: number): Promise<void> {
    if (!this.timerId) return;
    this.refreshIntervalMs = intervalMs;
    try {
      this.refreshTimerId = await this.request<string>(
        request(this.id, this.timerId, 'setInterval', {
          intervalMs,
        })
      );
    } catch { /* Timer may not be available */ }
  }

  private async stopRefreshTimer(): Promise<void> {
    if (!this.timerId || !this.refreshTimerId) return;
    try {
      await this.request(
        request(this.id, this.timerId, 'clearTimer', {
          timerId: this.refreshTimerId,
        })
      );
    } catch { /* best effort */ }
    this.refreshTimerId = undefined;
  }

  private async restartRefreshTimer(intervalMs: number): Promise<void> {
    if (intervalMs === this.refreshIntervalMs && this.refreshTimerId) return;
    await this.stopRefreshTimer();
    await this.startRefreshTimer(intervalMs);
  }

  // ── Event Handling ──

  private async handleChanged(fromId: AbjectId, aspect: string, value?: unknown): Promise<void> {
    // TabBar selection change
    if (fromId === this.tabBarId && aspect === 'change') {
      this.selectedPageIndex = value as number;
      this.clearInputQueue();
      this.lastShotDataUri = undefined; // force a redraw for the new page
      await this.updateUrlLabel();
      await this.refreshScreenshot();
      return;
    }

    if (aspect === 'click') {
      if (fromId === this.backBtnId || fromId === this.fwdBtnId || fromId === this.reloadBtnId) {
        const nav = fromId === this.backBtnId ? 'back' : fromId === this.fwdBtnId ? 'forward' : 'reload';
        await this.navigateSelectedPage(nav);
        return;
      }
      if (fromId === this.controlBtnId) {
        if (this.controlMode) {
          await this.releaseControl();
        } else {
          await this.takeControl();
        }
        return;
      }
      if (fromId === this.bannerTakeBtnId) {
        if (this.controlMode) {
          // Button reads "Done, hand back" in this state
          await this.releaseControl();
        } else {
          await this.takeControl();
        }
        return;
      }
      if (fromId === this.bannerDismissBtnId) {
        await this.resolveHandoff(false, 'dismissed: the user declined to take control');
        return;
      }
    }

    // WebBrowser page lifecycle events
    if (fromId === this.webBrowserId) {
      if (aspect === 'pageOpened' || aspect === 'pageClosed' || aspect === 'pageNavigated') {
        await this.refreshPageList();
        await this.refreshScreenshot();
      }
    }
  }

  /** Back/forward/reload on the selected page via the browser's history. */
  private async navigateSelectedPage(nav: 'back' | 'forward' | 'reload'): Promise<void> {
    const page = this.pages[this.selectedPageIndex];
    if (!page || !this.webBrowserId) return;
    try {
      const { url } = await this.request<{ url: string; title: string }>(
        request(this.id, this.webBrowserId, 'viewerNavigate', { pageId: page.pageId, nav })
      );
      page.url = url;
      await this.updateUrlLabel();
    } catch { /* nothing to go back/forward to — leave the page as is */ }
    this.lastShotDataUri = undefined;
    await this.refreshScreenshot();
  }

  // ── Human takeover ──

  private async takeControl(): Promise<void> {
    if (this.controlMode || !this.windowId) return;
    this.controlMode = true;
    this.mouseButtonsDown.clear();
    // A takeover-mode handoff is satisfied the moment the user takes control;
    // the requesting agent continues while the user keeps driving.
    if (this.pendingHandoff?.resolveOn === 'takeover') {
      await this.resolveHandoff(true, 'the user took control');
    }
    await this.updateControlUi();
    await this.restartRefreshTimer(CONTROL_REFRESH_INTERVAL_MS);
    this.lastShotDataUri = undefined; // redraw so the control-mode border appears
    await this.refreshScreenshot();
    const page = this.pages[this.selectedPageIndex];
    this.changed('humanControlStarted', { pageId: page?.pageId });
  }

  /** Exit control mode. Resolves a pending (handback) handoff as completed. */
  private async releaseControl(): Promise<void> {
    if (!this.controlMode) return;
    this.controlMode = false;
    // Release any button the page still thinks is down
    for (const button of this.mouseButtonsDown) {
      this.queueEvent({ type: 'mouseup', button, x: this.lastPagePos.x, y: this.lastPagePos.y }, true);
    }
    this.mouseButtonsDown.clear();
    const hadHandoff = !!this.pendingHandoff;
    await this.resolveHandoff(true); // emits humanControlEnded when it settles a handoff
    await this.updateControlUi();
    await this.restartRefreshTimer(REFRESH_INTERVAL_MS);
    this.lastShotDataUri = undefined; // redraw so the control-mode border clears
    await this.refreshScreenshot();
    if (!hadHandoff) this.changed('humanControlEnded', { completed: true });
  }

  /**
   * Settle the pending handoff (if any): reply to the requesting agent and
   * hide the banner. humanControlEnded is emitted only when the user is not
   * still controlling (control end is releaseControl's event to send).
   */
  private async resolveHandoff(completed: boolean, reason?: string): Promise<void> {
    const handoff = this.pendingHandoff;
    if (!handoff) return;
    this.pendingHandoff = undefined;
    clearTimeout(handoff.timer);
    try {
      this.sendDeferredReply(handoff.msg, { completed, ...(reason ? { reason } : {}) });
    } catch { /* requester gone */ }
    await this.updateControlUi();
    if (!this.controlMode) {
      this.changed('humanControlEnded', { completed });
    }
  }

  /** Sync the control button, banner, and status label to takeover state. */
  private async updateControlUi(): Promise<void> {
    if (!this.windowId) return;

    if (this.controlBtnId) {
      try {
        await this.request(request(this.id, this.controlBtnId, 'update', {
          text: this.controlMode ? 'Release Control' : 'Take Control',
        }));
      } catch { /* widget gone */ }
    }

    if (this.bannerRowId) {
      try {
        if (this.pendingHandoff) {
          await this.request(request(this.id, this.bannerLabelId!, 'update', {
            text: `⚠ ${this.pendingHandoff.reason}`,
          }));
          await this.request(request(this.id, this.bannerTakeBtnId!, 'update', {
            text: this.controlMode ? 'Done, hand back' : 'Take Control',
          }));
          await this.request(request(this.id, this.bannerDismissBtnId!, 'update', {
            visible: !this.controlMode,
          }));
          await this.request(request(this.id, this.bannerRowId, 'update', { visible: true }));
        } else {
          await this.request(request(this.id, this.bannerRowId, 'update', { visible: false }));
        }
      } catch { /* widget gone */ }
    }

    await this.updateStatusLabel();
  }

  /** Map canvas-local coordinates into page-viewport coordinates. */
  private mapToPage(x: number, y: number): { x: number; y: number } | undefined {
    const t = this.lastTransform;
    if (!t || t.drawW <= 0 || t.drawH <= 0) return undefined;
    const px = (x - t.drawX) * t.shotW / t.drawW;
    const py = (y - t.drawY) * t.shotH / t.drawH;
    if (px < 0 || py < 0 || px >= t.shotW || py >= t.shotH) {
      return undefined; // letterbox area
    }
    return { x: Math.round(px), y: Math.round(py) };
  }

  /**
   * Translate a compositor keydown into a Playwright key/combo, or undefined
   * for bare modifier presses. Shift is already baked into single-character
   * keys, so it is only folded in for named keys (Shift+Tab, ...).
   */
  private toPlaywrightKey(
    key?: string,
    modifiers?: { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean },
  ): string | undefined {
    if (!key || key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') {
      return undefined;
    }
    const mods: string[] = [];
    if (modifiers?.ctrl) mods.push('Control');
    if (modifiers?.alt) mods.push('Alt');
    if (modifiers?.meta) mods.push('Meta');
    if (modifiers?.shift && key.length > 1) mods.push('Shift');
    return mods.length > 0 ? [...mods, key].join('+') : key;
  }

  /** Raw input from the screenshot canvas. Only forwarded in control mode. */
  private async handleCanvasInput(payload: Record<string, unknown>): Promise<void> {
    const type = payload.type as string;
    if (type === 'canvasResize') return; // transform recomputes on next refresh
    if (!this.controlMode) return;
    if (!this.pages[this.selectedPageIndex] || !this.webBrowserId) return;

    switch (type) {
      case 'mousemove': {
        const pos = this.mapToPage(payload.x as number, payload.y as number);
        if (!pos) return;
        this.lastPagePos = pos;
        this.queueEvent({ type: 'mousemove', x: pos.x, y: pos.y }, false);
        return;
      }
      case 'mousedown': {
        const pos = this.mapToPage(payload.x as number, payload.y as number);
        if (!pos) return;
        this.lastPagePos = pos;
        const button = (payload.button as number) ?? 0;
        this.mouseButtonsDown.add(button);
        this.queueEvent({ type: 'mousemove', x: pos.x, y: pos.y }, false);
        this.queueEvent({ type: 'mousedown', button }, true);
        return;
      }
      case 'mouseup': {
        // Layouts forward mouseup to the focused child WITHOUT translating to
        // child-local coordinates (unlike mousedown/mousemove), so the payload
        // position is unreliable. The browser releases at the current pointer
        // position anyway, which mousedown/mousemove already established.
        const button = (payload.button as number) ?? 0;
        this.mouseButtonsDown.delete(button);
        this.queueEvent({ type: 'mouseup', button }, true);
        return;
      }
      case 'mouseleave': {
        // Never leave the page with a stuck button
        for (const button of this.mouseButtonsDown) {
          this.queueEvent({ type: 'mouseup', button }, true);
        }
        this.mouseButtonsDown.clear();
        return;
      }
      case 'wheel': {
        const pos = this.mapToPage(payload.x as number, payload.y as number);
        if (!pos) return;
        this.queueEvent({ type: 'wheel', x: pos.x, y: pos.y, deltaY: (payload.deltaY as number) ?? 0 }, true);
        return;
      }
      case 'keydown': {
        const combo = this.toPlaywrightKey(
          payload.key as string | undefined,
          payload.modifiers as { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean } | undefined,
        );
        if (!combo) return;
        this.queueEvent({ type: 'key', key: combo }, true);
        return;
      }
      case 'paste': {
        const text = payload.pasteText as string | undefined;
        if (text) this.queueEvent({ type: 'insertText', text }, true);
        return;
      }
    }
  }

  /**
   * Queue a raw event for delivery. Consecutive mousemoves collapse to the
   * latest position and consecutive wheels at the same spot sum their deltas,
   * so a flush carries a short realistic trail instead of a flood. Discrete
   * events flush immediately; moves flush on a short timer.
   */
  private queueEvent(ev: RawPageEvent, discrete: boolean): void {
    const last = this.pendingEvents[this.pendingEvents.length - 1];
    if (ev.type === 'mousemove' && last?.type === 'mousemove') {
      this.pendingEvents[this.pendingEvents.length - 1] = ev;
    } else if (ev.type === 'wheel' && last?.type === 'wheel' && last.x === ev.x && last.y === ev.y) {
      last.deltaY = (last.deltaY ?? 0) + (ev.deltaY ?? 0);
    } else {
      this.pendingEvents.push(ev);
    }

    if (discrete) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
      }
      void this.flushEvents();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        void this.flushEvents();
      }, FLUSH_INTERVAL_MS);
    }
  }

  /**
   * Drain the event queue to WebBrowser.viewerInput, one request in flight at
   * a time so ordering is preserved (a mousedown can never overtake the move
   * that positioned it). After a batch containing a discrete event, refresh
   * the screenshot immediately so the user sees the effect of their click.
   */
  private async flushEvents(): Promise<void> {
    if (this.flushing) return; // the running drain loop picks up new events
    this.flushing = true;
    try {
      while (this.pendingEvents.length > 0) {
        // Note: draining continues even after controlMode flips off, so the
        // stuck-button mouseups queued by releaseControl still go out.
        const page = this.pages[this.selectedPageIndex];
        if (!page || !this.webBrowserId) {
          this.pendingEvents = [];
          break;
        }
        const batch = this.pendingEvents;
        this.pendingEvents = [];
        const hadDiscrete = batch.some((e) => e.type !== 'mousemove');
        try {
          await this.request(
            request(this.id, this.webBrowserId, 'viewerInput', {
              pageId: page.pageId,
              events: batch,
            })
          );
        } catch { /* page closed mid-batch; drop */ }
        if (hadDiscrete) {
          void this.refreshScreenshot();
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private clearInputQueue(): void {
    this.pendingEvents = [];
    this.mouseButtonsDown.clear();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  // ── Data Refresh ──

  /** Refresh the page list and focus the tab for the given pageId. */
  private async selectPage(pageId: string): Promise<void> {
    await this.refreshPageList();
    const idx = this.pages.findIndex((p) => p.pageId === pageId);
    if (idx >= 0 && idx !== this.selectedPageIndex) {
      this.selectedPageIndex = idx;
      if (this.tabBarId) {
        try {
          await this.request(
            request(this.id, this.tabBarId, 'update', { selectedIndex: idx })
          );
        } catch { /* widget gone */ }
      }
      await this.updateUrlLabel();
    }
    await this.refreshScreenshot();
  }

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

    await this.updateStatusLabel();
  }

  private async updateStatusLabel(): Promise<void> {
    if (!this.statusLabelId) return;
    let statusText: string;
    if (this.controlMode) {
      statusText = 'You are in control — mouse and keyboard go to the page';
    } else if (this.pages.length === 0) {
      statusText = 'No browser pages open';
    } else {
      statusText = `${this.pages.length} page${this.pages.length > 1 ? 's' : ''} open | Refresh ${this.refreshIntervalMs / 1000}s`;
    }
    try {
      await this.request(
        request(this.id, this.statusLabelId, 'update', { text: statusText })
      );
    } catch { /* widget gone */ }
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
    // Single-flight: overlapping refreshes (timer + post-click) would draw
    // frames out of order and flicker.
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.doRefreshScreenshot();
    } finally {
      this.refreshing = false;
    }
  }

  private async doRefreshScreenshot(): Promise<void> {
    if (!this.canvasId) return;
    const page = this.pages[this.selectedPageIndex];
    if (!page || !this.webBrowserId) {
      // Show placeholder
      this.lastTransform = undefined;
      this.lastShotDataUri = undefined;
      await this.drawPlaceholder();
      return;
    }

    try {
      const shot = await this.request<{ dataUri: string; width: number; height: number; url?: string; title?: string }>(
        request(this.id, this.webBrowserId, 'viewerScreenshot', {
          pageId: page.pageId,
        })
      );

      // Track in-page navigation (link clicks during takeover) cheaply
      if (shot.url && shot.url !== page.url) {
        page.url = shot.url;
        if (shot.title) page.title = shot.title;
        await this.updateUrlLabel();
      }

      // Get canvas size to scale the screenshot
      const canvasSize = await this.request<{ width: number; height: number }>(
        request(this.id, this.canvasId, 'getCanvasSize', {})
      );

      const cw = canvasSize.width;
      const ch = canvasSize.height;
      if (cw <= 0 || ch <= 0) return;

      // Unchanged frame on an unchanged canvas — skip the redraw entirely.
      // Re-submitting an identical frame as a fresh data URI forces the
      // client to re-decode it, which is what flickers.
      if (shot.dataUri === this.lastShotDataUri
        && cw === this.lastCanvasSize.width && ch === this.lastCanvasSize.height) {
        return;
      }

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

      // Remember the fit transform so control-mode input can be mapped back
      // into page coordinates
      this.lastTransform = {
        drawX, drawY,
        drawW: Math.floor(drawW), drawH: Math.floor(drawH),
        shotW: shot.width, shotH: shot.height,
      };

      await this.request(
        request(this.id, this.canvasId!, 'draw', {
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
            ...(this.controlMode ? [{
              type: 'rect',
              params: {
                x: drawX, y: drawY,
                width: Math.floor(drawW), height: Math.floor(drawH),
                stroke: '#e8b45a', lineWidth: 2,
              },
            }] : []),
          ],
        })
      );
      this.lastShotDataUri = shot.dataUri;
      this.lastCanvasSize = { width: cw, height: ch };
    } catch {
      // Screenshot failed. If a frame is already on screen, keep it — a
      // transient failure (page mid-navigation) must not flash a placeholder.
      if (this.lastShotDataUri) return;
      this.lastTransform = undefined;
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

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## WebBrowserViewer Usage Guide

### Methods
- \`show()\` — Open the browser viewer window. Shows tabs for each open browser page with live screenshots.
- \`hide()\` — Close the browser viewer window.
- \`getState()\` — Returns { visible, pageCount, controlling, handoffPending }.
- \`requestControl({ pageId, reason, timeoutMs?, resolveOn? })\` — Ask the human to take control of a page. Opens the window, selects the page's tab, and shows the reason with Take Control / Dismiss buttons. The reply is DEFERRED. resolveOn 'handback' (default): resolves { completed: true } when the user hands control back — for steps you must wait out (verification challenges). resolveOn 'takeover': resolves as soon as the user takes control — for handing them the page to browse (do not block on them finishing). Declined / timed out → { completed: false, reason }. Send this with a generous request timeout (minutes, not seconds) — a human has to notice and act.

### Human takeover
- The user can click "Take Control" at any time (or in response to a requestControl prompt). While controlling, their mouse and keyboard on the screenshot are replayed into the real page as trusted input with genuine movement trails, which satisfies interactive human-verification widgets.
- The screenshot refresh speeds up automatically while the user is in control.
- Events emitted: \`humanControlRequested\` { pageId, reason }, \`humanControlStarted\` { pageId }, \`humanControlEnded\` { completed }.

### Features
- Tab bar showing all open browser pages (auto-updated on page open/close/navigate).
- Back / forward / reload buttons driving the page's real history.
- URL bar showing the current page URL (tracks link clicks during takeover).
- Live screenshot canvas (1s refresh; 250ms while the user is in control). Redraws only when the frame actually changes, and keeps the last good frame through transient screenshot failures.
- Screenshots are scaled to fit the canvas while preserving aspect ratio.
- When no pages are open, shows a placeholder message.

### Interface ID
\`abjects:web-browser-viewer\``;
  }
}

export const WEB_BROWSER_VIEWER_ID = 'abjects:web-browser-viewer' as AbjectId;
