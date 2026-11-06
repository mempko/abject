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
import { request, event } from '../core/message.js';
import { require as requireContract, requireNonEmpty, requirePositive } from '../core/contracts.js';
import { chromeCase } from '../core/theme-data.js';
import { fontStacks } from './widgets/widget-types.js';
import {
  DEFAULT_FRAME_POLL_MS,
  DEFAULT_KEY_FRAME_INTERVAL_MS,
  dataUriBytes,
  needsResync,
} from './frame-diff.js';
import type { ViewerFramePatch, ViewerFrameReply } from './frame-diff.js';
import type { ViewerVideoReply } from './video-encoder.js';

const WEB_BROWSER_VIEWER_INTERFACE: InterfaceId = 'abjects:web-browser-viewer';

/** The rectangle on the canvas a page frame is fitted into (letterboxed). */
export interface ViewerFitRect {
  drawX: number;
  drawY: number;
  drawW: number;
  drawH: number;
}

/** What one viewerFrame reply asks the viewer to do. */
export interface ViewerFrameDecision {
  action: 'ignore' | 'key' | 'delta' | 'resync';
  reason: string;
  patches: ViewerFramePatch[];
}

/** What the picture on the canvas currently is. */
export interface ViewerFrameScreenState {
  lastDrawnSeq?: number;
  lastFit?: ViewerFitRect;
}

/**
 * Decide what to do with one `viewerFrame` reply given what is already on
 * screen. `ignore` means send no draw call at all. `resync` means the reply is
 * a patch against a frame this viewer no longer holds, so the next poll must
 * ask for a fresh key frame instead of patching.
 */
export function decideViewerFrameAction(
  reply: ViewerFrameReply,
  state: ViewerFrameScreenState,
): ViewerFrameDecision {
  requireContract(reply !== undefined && reply !== null, 'viewerFrame reply is required');

  if (reply.kind === 'unchanged') {
    return { action: 'ignore', reason: 'identical to the frame on screen', patches: [] };
  }
  if (reply.kind === 'key') {
    return { action: 'key', reason: 'whole frame', patches: [] };
  }
  if (!state.lastFit) {
    return { action: 'resync', reason: 'no frame on screen to patch', patches: [] };
  }
  if (needsResync(reply.baseSeq, state.lastDrawnSeq)) {
    return {
      action: 'resync',
      reason: `patch bases on seq ${reply.baseSeq} but the screen holds ${state.lastDrawnSeq ?? 'nothing'}`,
      patches: [],
    };
  }
  if (reply.patches.length === 0) {
    return { action: 'ignore', reason: 'patch batch carried nothing', patches: [] };
  }
  return { action: 'delta', reason: `${reply.patches.length} patch(es)`, patches: reply.patches };
}

/**
 * Map one page-pixel patch rectangle through the fit transform onto the
 * canvas. The rect is widened to whole pixels (never narrowed) so adjacent
 * patches cannot leave a one-pixel seam between them.
 */
export function mapPatchToCanvas(
  patch: ViewerFramePatch,
  fit: ViewerFitRect,
  shotW: number,
  shotH: number,
): { x: number; y: number; width: number; height: number } {
  requirePositive(shotW, 'mapPatchToCanvas needs the page frame width');
  requirePositive(shotH, 'mapPatchToCanvas needs the page frame height');
  requireContract(patch.width > 0 && patch.height > 0, 'a patch must have a non-empty rect');

  const scaleX = fit.drawW / shotW;
  const scaleY = fit.drawH / shotH;
  const left = Math.floor(fit.drawX + patch.x * scaleX);
  const top = Math.floor(fit.drawY + patch.y * scaleY);
  const right = Math.ceil(fit.drawX + (patch.x + patch.width) * scaleX);
  const bottom = Math.ceil(fit.drawY + (patch.y + patch.height) * scaleY);
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

/** Counters for the change-driven frame feed. */
export interface ViewerFrameCounters {
  updatesSent: number;
  bytesSent: number;
  keyFrames: number;
  deltas: number;
  patches: number;
  unchangedTicks: number;
  resyncs: number;
}

export function emptyFrameCounters(): ViewerFrameCounters {
  return {
    updatesSent: 0, bytesSent: 0, keyFrames: 0, deltas: 0,
    patches: 0, unchangedTicks: 0, resyncs: 0,
  };
}

/**
 * Fold one poll's outcome into the counters. Pure — returns a new object — so
 * the counting rules are unit-testable without a bus or a canvas.
 */
export function accumulateFrameStats(
  counters: ViewerFrameCounters,
  reply: ViewerFrameReply,
  decision: ViewerFrameDecision,
): ViewerFrameCounters {
  const next = { ...counters };
  switch (decision.action) {
    case 'ignore':
      next.unchangedTicks += 1;
      break;
    case 'resync':
      next.resyncs += 1;
      break;
    case 'key':
      if (reply.kind === 'key') {
        next.keyFrames += 1;
        next.updatesSent += 1;
        next.bytesSent += dataUriBytes(reply.dataUri);
      }
      break;
    case 'delta':
      if (reply.kind === 'delta') {
        next.deltas += 1;
        next.patches += reply.patches.length;
        next.updatesSent += 1;
        for (const patch of reply.patches) next.bytesSent += dataUriBytes(patch.dataUri);
      }
      break;
  }
  return next;
}

const WIN_W = 640;
const WIN_H = 480;
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
  private refreshIntervalMs = DEFAULT_FRAME_POLL_MS;
  /** Anti-flicker state: skip redraws when the frame hasn't changed, keep the
   *  last good frame through transient screenshot failures, and never run two
   *  refreshes concurrently (out-of-order draws). */
  private refreshing = false;
  /** Seq of the frame the pixels on the canvas correspond to. */
  private lastDrawnSeq?: number;
  /** baseSeq of the last applied patch batch (diagnostics). */
  private lastBaseSeq?: number;
  /** Seq of the newest frame the server has (diagnostics). */
  private lastFrameSeq?: number;
  /** Set when the picture on screen can no longer be patched (resync). */
  private needsKeyFrame = false;
  /** Decoder stream id the client uses for this viewer's live page picture. */
  private readonly videoStreamId = 'viewer-page';
  /** Poll cadence for the change-driven feed, and the key-frame cadence. */
  private framePollMs = DEFAULT_FRAME_POLL_MS;
  private keyFrameIntervalMs = DEFAULT_KEY_FRAME_INTERVAL_MS;
  /** What this viewer actually sent, exposed through getState. */
  private frameStats: ViewerFrameCounters = emptyFrameCounters();
  /** Geometry + control-mode of the last drawn frame. When these are
   *  unchanged, the new screenshot fully overwrites the old one in place, so
   *  we skip the background clear — the previous frame stays on screen until
   *  the new one paints (content-level double buffering, no blank flash). */
  private lastDrawRect?: { drawX: number; drawY: number; drawW: number; drawH: number };
  private lastDrawControlMode = false;

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
                  updatesSent: { kind: 'primitive', primitive: 'number' },
                  bytesSent: { kind: 'primitive', primitive: 'number' },
                  keyFrames: { kind: 'primitive', primitive: 'number' },
                  deltas: { kind: 'primitive', primitive: 'number' },
                  patches: { kind: 'primitive', primitive: 'number' },
                  unchangedTicks: { kind: 'primitive', primitive: 'number' },
                  resyncs: { kind: 'primitive', primitive: 'number' },
                  lastSeq: { kind: 'primitive', primitive: 'number' },
                  baseSeq: { kind: 'primitive', primitive: 'number' },
                  lastFrameSeq: { kind: 'primitive', primitive: 'number' },
                  pollMs: { kind: 'primitive', primitive: 'number' },
                  keyFrameIntervalMs: { kind: 'primitive', primitive: 'number' },
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
            {
              name: 'configure',
              description:
                'Adjust the frame feed at runtime. pollMs caps how often the viewer asks for pixels (the update rate); lower is more responsive and costs a busy page more messages. keyFrameIntervalMs is how often a whole frame is re-sent so clients can resync and patch drift cannot accumulate.',
              parameters: [
                { name: 'pollMs', type: { kind: 'primitive', primitive: 'number' }, description: 'Poll cadence in ms (default 33, i.e. ~30fps); minimum 1', optional: true },
                { name: 'keyFrameIntervalMs', type: { kind: 'primitive', primitive: 'number' }, description: 'How often a whole key frame is re-sent in ms (default 2000)', optional: true },
              ],
              returns: {
                kind: 'object',
                properties: {
                  pollMs: { kind: 'primitive', primitive: 'number' },
                  keyFrameIntervalMs: { kind: 'primitive', primitive: 'number' },
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
        // Frame transport counters: what this viewer has actually sent.
        updatesSent: this.frameStats.updatesSent,
        bytesSent: this.frameStats.bytesSent,
        keyFrames: this.frameStats.keyFrames,
        deltas: this.frameStats.deltas,
        patches: this.frameStats.patches,
        unchangedTicks: this.frameStats.unchangedTicks,
        resyncs: this.frameStats.resyncs,
        lastSeq: this.lastDrawnSeq ?? -1,
        baseSeq: this.lastBaseSeq ?? -1,
        lastFrameSeq: this.lastFrameSeq ?? -1,
        pollMs: this.framePollMs,
        keyFrameIntervalMs: this.keyFrameIntervalMs,
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

      const timer = this.setTimer(() => {
        void this.resolveHandoff(false, 'timeout: the user did not respond in time');
      }, timeoutMs ?? HANDOFF_DEFAULT_TIMEOUT_MS);
      this.pendingHandoff = { msg, pageId, reason, timer, resolveOn: resolveOn ?? 'handback' };

      await this.updateControlUi();
      // An agent is asking for the human hand: the window pulses for attention.
      this.playEffect('pulse', '$accent');
      this.changed('humanControlRequested', { pageId, reason });
      return DEFERRED_REPLY;
    });

    this.on('configure', async (msg: AbjectMessage) => {
      const opts = (msg.payload ?? {}) as { pollMs?: number; keyFrameIntervalMs?: number };
      const { pollMs, keyFrameIntervalMs } = opts;
      return this.configureFrameFeed({ pollMs, keyFrameIntervalMs });
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

    await this.fetchTheme();
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
          { type: 'label', windowId: this.windowId, text: '', style: { color: this.theme.textSecondary, fontSize: 11 } },
          { type: 'button', windowId: this.windowId, text: 'Take Control', style: this.primaryStyle() },
          { type: 'label', windowId: this.windowId, text: '', style: { color: this.theme.statusWarning, fontSize: 12 } },
          { type: 'button', windowId: this.windowId, text: 'Take Control', style: this.primaryStyle() },
          { type: 'button', windowId: this.windowId, text: 'Dismiss' },
          { type: 'label', windowId: this.windowId, text: 'No browser pages open', style: { color: this.theme.textMeta, fontSize: 11 } },
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
        margins: { top: 0, right: 8, bottom: 0, left: 8 },
        spacing: 8,
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
        margins: { top: 2, right: 8, bottom: 2, left: 8 },
        spacing: 8,
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

    // Nav buttons start disabled — enabled only when the user takes control.
    // Toolbar starts hidden until refreshPageList finds an open page.
    await this.updateNavButtons();
    await this.updateToolbarVisibility();

    // Start the change-driven frame feed (~30fps by default; nothing crosses
    // the bus on a tick where the page did not change).
    await this.startRefreshTimer(this.framePollMs);

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
    this.lastDrawnSeq = undefined;
    this.lastBaseSeq = undefined;
    this.lastFrameSeq = undefined;
    this.needsKeyFrame = false;
    this.lastDrawRect = undefined;
    this.lastDrawControlMode = false;

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

  /**
   * Adjust the frame feed at runtime. `pollMs` caps how often the viewer polls
   * for pixels (the update rate); `keyFrameIntervalMs` is how often a whole
   * frame is re-sent so a client can resync and patch drift cannot accumulate
   * forever.
   */
  async configureFrameFeed(
    opts: { pollMs?: number; keyFrameIntervalMs?: number } = {},
  ): Promise<{ pollMs: number; keyFrameIntervalMs: number }> {
    if (opts.pollMs !== undefined) {
      requirePositive(opts.pollMs, 'pollMs must be positive');
      this.framePollMs = Math.max(1, Math.round(opts.pollMs));
    }
    if (opts.keyFrameIntervalMs !== undefined) {
      requirePositive(opts.keyFrameIntervalMs, 'keyFrameIntervalMs must be positive');
      this.keyFrameIntervalMs = Math.max(1, Math.round(opts.keyFrameIntervalMs));
    }

    // Keep the browser side's key-frame cadence in step with ours. A
    // WebBrowser predating this method is fine: the per-poll option still
    // carries the interval.
    if (this.webBrowserId) {
      try {
        await this.request(
          request(this.id, this.webBrowserId, 'configureViewerFrame', {
            pollMs: this.framePollMs,
            keyFrameIntervalMs: this.keyFrameIntervalMs,
          })
        );
      } catch { /* not supported by this WebBrowser */ }
    }

    if (this.windowId) {
      this.needsKeyFrame = true;
      await this.restartRefreshTimer(this.framePollMs);
      await this.refreshScreenshot();
    }
    await this.updateStatusLabel();
    return { pollMs: this.framePollMs, keyFrameIntervalMs: this.keyFrameIntervalMs };
  }

  // ── Event Handling ──

  private async handleChanged(fromId: AbjectId, aspect: string, value?: unknown): Promise<void> {
    // TabBar selection change
    if (fromId === this.tabBarId && aspect === 'change') {
      this.selectedPageIndex = value as number;
      this.clearInputQueue();
      this.needsKeyFrame = true; // a new page must not be patched over the old one
      await this.updateUrlLabel();
      await this.refreshScreenshot();
      return;
    }

    // TabBar close button (×) — confirm, then close the underlying browser page
    if (fromId === this.tabBarId && aspect === 'close') {
      await this.confirmClosePage(value as number);
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

  /**
   * Confirm and close the browser page behind a tab. Navigation and closing a
   * page are actions on the (possibly agent-driven) session, so we ask first.
   */
  private async confirmClosePage(idx: number): Promise<void> {
    const page = this.pages[idx];
    if (!page || !this.webBrowserId || !this.widgetManagerId) return;
    const label = page.title || page.url || `page ${idx + 1}`;
    let confirmed = false;
    try {
      confirmed = await this.request<boolean>(
        request(this.id, this.widgetManagerId, 'showConfirmDialog', {
          title: 'Close page?',
          message: `Close "${label}"? This ends the browser page and any automation using it loses it.`,
          confirmLabel: 'Close page',
          cancelLabel: 'Cancel',
          destructive: true,
        })
      );
    } catch { confirmed = false; }
    if (!confirmed) return;

    try {
      // viewerClosePage, not closePage: the tabs list every open page, so the
      // page is usually another object's and closePage's ownership check would
      // refuse it — silently, before this fix, because of the catch below.
      await this.request(request(this.id, this.webBrowserId, 'viewerClosePage', { pageId: page.pageId }));
    } catch { /* already gone */ }
    // The WebBrowser pageClosed event also refreshes, but do it now so the tab
    // disappears immediately.
    if (idx < this.selectedPageIndex && this.selectedPageIndex > 0) this.selectedPageIndex--;
    this.needsKeyFrame = true;
    await this.refreshPageList();
    await this.refreshScreenshot();
  }

  /** Back/forward/reload on the selected page via the browser's history. */
  private async navigateSelectedPage(nav: 'back' | 'forward' | 'reload'): Promise<void> {
    if (!this.controlMode) return; // navigation is a control action
    const page = this.pages[this.selectedPageIndex];
    if (!page || !this.webBrowserId) return;
    try {
      const { url } = await this.request<{ url: string; title: string }>(
        request(this.id, this.webBrowserId, 'viewerNavigate', { pageId: page.pageId, nav })
      );
      page.url = url;
      await this.updateUrlLabel();
    } catch {
      // Nothing to go back/forward to: the page stays as is, and the window
      // shakes so the press visibly registered.
      this.playEffect('shake');
    }
    this.needsKeyFrame = true;
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
    // A takeover changes the reserved border frame, so the next frame must be
    // a whole key frame: patches alone would not repaint the border.
    this.needsKeyFrame = true;
    await this.refreshScreenshot();
    // The human hand takes the page.
    this.playEffect('flash', '$accent');
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
    this.needsKeyFrame = true; // redraw so the control-mode border clears
    await this.refreshScreenshot();
    // Control returns to the live feed (and to the waiting agent, if any).
    this.playEffect('flash');
    if (!hadHandoff) this.changed('humanControlEnded', { completed: true });
  }

  /** Play a slab effect on the window (visual only; one fire-and-forget message). */
  private playEffect(effect: string, color?: string): void {
    if (!this.windowId) return;
    this.playWindowEffect(this.windowId, effect, color);
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
    this.cancelTimer(handoff.timer);
    try {
      this.sendDeferredReply(handoff.msg, { completed, ...(reason ? { reason } : {}) });
    } catch { /* requester gone */ }
    await this.updateControlUi();
    if (!this.controlMode) {
      this.changed('humanControlEnded', { completed });
    }
  }

  /** Enable the back/forward/reload buttons only while the user is in control —
   *  navigating the page is a control action. */
  private async updateNavButtons(): Promise<void> {
    const disabled = !this.controlMode;
    for (const id of [this.backBtnId, this.fwdBtnId, this.reloadBtnId]) {
      if (!id) continue;
      try {
        await this.request(request(this.id, id, 'update', { disabled }));
      } catch { /* widget gone */ }
    }
  }

  /** Show the toolbar (nav + take control) only when a page is open — there is
   *  nothing to navigate or control otherwise. */
  private async updateToolbarVisibility(): Promise<void> {
    const visible = this.pages.length > 0;
    for (const id of [this.backBtnId, this.fwdBtnId, this.reloadBtnId, this.controlBtnId]) {
      if (!id) continue;
      try {
        await this.request(request(this.id, id, 'update', { visible }));
      } catch { /* widget gone */ }
    }
  }

  /** Sync the control button, banner, and status label to takeover state. */
  private async updateControlUi(): Promise<void> {
    if (!this.windowId) return;

    await this.updateNavButtons();

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
            text: `\u25B2 ${this.pendingHandoff.reason}`,
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
        this.cancelTimer(this.flushTimer);
        this.flushTimer = undefined;
      }
      void this.flushEvents();
    } else if (!this.flushTimer) {
      this.flushTimer = this.setTimer(() => {
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
      this.cancelTimer(this.flushTimer);
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

    // Toolbar is only meaningful when a page is open
    await this.updateToolbarVisibility();
  }

  private async updateStatusLabel(): Promise<void> {
    if (!this.statusLabelId) return;
    let statusText: string;
    // Human control reads in red; a live page feed glows; idle is muted.
    let color: string;
    if (this.controlMode) {
      statusText = 'You are in control: mouse and keyboard go to the page';
      color = this.theme.accent;
    } else if (this.pages.length === 0) {
      statusText = 'No browser pages open';
      color = this.theme.textMeta;
    } else {
      const fps = Math.max(1, Math.round(1000 / this.framePollMs));
      statusText = `${this.pages.length} page${this.pages.length > 1 ? 's' : ''} open | Live ~${fps} fps`;
      color = this.theme.accentSecondary;
    }
    try {
      await this.request(
        request(this.id, this.statusLabelId, 'update', { text: statusText, style: { color } })
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
      await this.doRefreshFrame();
    } finally {
      this.refreshing = false;
    }
  }

  private async doRefreshFrame(): Promise<void> {
    if (!this.canvasId) return;
    const page = this.pages[this.selectedPageIndex];
    if (!page || !this.webBrowserId) {
      // Show placeholder
      this.lastTransform = undefined;
      this.lastDrawnSeq = undefined;
      this.lastBaseSeq = undefined;
      this.lastDrawRect = undefined; // next frame repaints over the text
      this.needsKeyFrame = false;
      await this.drawPlaceholder();
      return;
    }

    const forceKey = this.needsKeyFrame;

    try {
      const reply = await this.request<ViewerVideoReply>(
        request(this.id, this.webBrowserId, 'viewerVideoFrame', {
          pageId: page.pageId,
          options: { forceKey, keyFrameIntervalMs: this.keyFrameIntervalMs },
        })
      );

      // Track in-page navigation (link clicks during takeover) cheaply
      if (reply.url && reply.url !== page.url) {
        page.url = reply.url;
        if (reply.title) page.title = reply.title;
        await this.updateUrlLabel();
      }
      this.lastFrameSeq = reply.seq;

      // A still page sends nothing: the capture side compared the pixels and
      // answered 'unchanged', so there is no packet to decode and no draw.
      if (reply.kind === 'unchanged') {
        this.frameStats.unchangedTicks += 1;
        return;
      }

      // Get canvas size to scale the frame
      const canvasSize = await this.request<{ width: number; height: number }>(
        request(this.id, this.canvasId, 'getCanvasSize', {})
      );

      const cw = canvasSize.width;
      const ch = canvasSize.height;
      if (cw <= 0 || ch <= 0) return;

      // Available draw area. In control mode reserve a small frame around the
      // image for the takeover border, so the border (a) stays fully on-canvas
      // instead of being clipped at the edges, and (b) sits OUTSIDE the image
      // rect the compositor re-blits asynchronously — otherwise that blit
      // repaints over the border every frame and it flickers.
      const FRAME = this.controlMode ? 4 : 0;
      const availW = cw - FRAME * 2;
      const availH = ch - FRAME * 2;
      if (availW <= 0 || availH <= 0) return;

      // Scale to fit within the available area, preserving aspect ratio
      // The page's own pixel size, before the codec's downscale, so pointer
      // positions map back into page coordinates; the encoded size drives the
      // region the decoded picture is painted into.
      const shotW = reply.sourceWidth;
      const shotH = reply.sourceHeight;
      if (shotW <= 0 || shotH <= 0) return;
      const imgAspect = shotW / shotH;
      const availAspect = availW / availH;
      let drawW: number, drawH: number, drawX: number, drawY: number;

      if (imgAspect > availAspect) {
        // Image wider — fit to width
        drawW = availW;
        drawH = availW / imgAspect;
        drawX = FRAME;
        drawY = FRAME + Math.floor((availH - drawH) / 2);
      } else {
        // Image taller — fit to height
        drawH = availH;
        drawW = availH * imgAspect;
        drawX = FRAME + Math.floor((availW - drawW) / 2);
        drawY = FRAME;
      }

      const dw = Math.floor(drawW), dh = Math.floor(drawH);

      // Remember the fit transform so control-mode input can be mapped back
      // into page coordinates, and so patches map through the same transform.
      this.lastTransform = { drawX, drawY, drawW: dw, drawH: dh, shotW, shotH };
      const fit = { drawX, drawY, drawW: dw, drawH: dh };

      // Register the region the decoded stream paints, and re-emit it when the
      // geometry or the control border changes. The compositor contain-fits the
      // decoded frame into this rect, so one videoFrame command is all the
      // drawing this transport does — no per-tick image traffic at all.
      const rectChanged = !this.lastDrawRect
        || this.lastDrawRect.drawX !== drawX || this.lastDrawRect.drawY !== drawY
        || this.lastDrawRect.drawW !== dw || this.lastDrawRect.drawH !== dh;
      const controlChanged = this.lastDrawControlMode !== this.controlMode;

      if (rectChanged || controlChanged || this.lastDrawnSeq === undefined) {
        const commands: unknown[] = [];
        if (rectChanged || controlChanged) {
          commands.push({ type: 'clear', params: { color: this.theme.windowBg } });
        }
        commands.push({
          type: 'videoFrame',
          params: {
            videoId: this.videoStreamId,
            x: drawX, y: drawY, width: dw, height: dh,
            hidden: false,
          },
        });
        if (this.controlMode) {
          // Border stroke centered in the reserved frame, just outside the
          // picture: fully on-canvas, and clear of the region the compositor
          // re-blits.
          commands.push({
            type: 'rect',
            params: {
              x: drawX - 2, y: drawY - 2, width: dw + 4, height: dh + 4,
              stroke: this.theme.statusWarning, lineWidth: 2,
            },
          });
        }
        await this.request(request(this.id, this.canvasId, 'draw', { commands }));
      }

      // Hand the packets to the browser, which decodes them with WebCodecs.
      const uiServerId = await this.requireDep('UIServer');
      await this.request(request(this.id, uiServerId, 'viewerVideoChunk', {
        videoId: this.videoStreamId,
        codec: reply.codec,
        width: reply.width,
        height: reply.height,
        key: reply.key,
        chunks: reply.chunks,
      }));

      this.frameStats.updatesSent += 1;
      this.frameStats.bytesSent += reply.chunks.reduce((n, c) => n + c.data.length, 0);
      if (reply.key) this.frameStats.keyFrames += 1; else this.frameStats.deltas += 1;
      this.lastDrawnSeq = reply.seq;
      this.lastBaseSeq = reply.seq;
      this.lastDrawRect = fit;
      this.lastDrawControlMode = this.controlMode;
      this.needsKeyFrame = false;
    } catch {
      // The frame request failed. If a frame is already on screen, keep it — a
      // transient failure (page mid-navigation) must not flash a placeholder.
      if (this.lastDrawnSeq !== undefined) return;
      this.lastTransform = undefined;
      this.needsKeyFrame = true;
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

      const t = this.theme;
      const { body, display } = fontStacks(t);
      const commands: unknown[] = [{ type: 'clear', params: { color: t.windowBg } }];
      if (text) {
        commands.push({
          type: 'text',
          params: { x: cx, y: cy, text, font: `13px ${body}`, fill: t.textTertiary, align: 'center', baseline: 'middle' },
        });
      } else {
        // Empty state: a closed ring sigil (nothing is being watched), then
        // what appears here and how to get it.
        const ringY = cy - 44;
        commands.push(
          { type: 'circle', params: { cx, cy: ringY, radius: 18, stroke: t.textSecondary, lineWidth: 2 } },
          { type: 'circle', params: { cx, cy: ringY, radius: 10, stroke: t.accent, lineWidth: 1.5 } },
          { type: 'line', params: { x1: cx - 5, y1: ringY, x2: cx + 5, y2: ringY, stroke: t.textSecondary, lineWidth: 2 } },
          {
            type: 'text',
            params: { x: cx, y: cy, text: chromeCase(t, 'No pages open'), font: `bold 14px ${display}`, fill: t.textSecondary, align: 'center', baseline: 'middle' },
          },
          {
            type: 'text',
            params: { x: cx, y: cy + 24, text: 'Pages that agents browse for you appear here, live.', font: `12px ${body}`, fill: t.textTertiary, align: 'center', baseline: 'middle' },
          },
          {
            type: 'text',
            params: { x: cx, y: cy + 42, text: 'Ask in Chat to look something up online, then watch or take control.', font: `12px ${body}`, fill: t.textTertiary, align: 'center', baseline: 'middle' },
          },
        );
      }
      await this.request(request(this.id, this.canvasId, 'draw', { commands }));
    } catch { /* canvas gone */ }
  }

  /** Red primary-action style (Take Control). */
  private primaryStyle(): Record<string, unknown> {
    return { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder };
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
