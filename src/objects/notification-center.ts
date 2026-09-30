/**
 * NotificationCenter — workspace-scoped toasts with persistent history.
 *
 * Any Abject can fire a transient message that appears as a small card in
 * the top-right corner of the screen. The card fades in, holds, fades out,
 * and disposes itself. Multiple notifications stack vertically.
 *
 * Beyond the toasts, NotificationCenter keeps a history of recent
 * notifications and exposes a viewer window (`show` method) so the user
 * can review what they missed. The bell button in GlobalToolbar opens it.
 *
 * Wiring: Abjects discover this via `discoverDep('NotificationCenter')`
 * and send a `notify` event with `{ message, level?, durationMs? }`.
 *
 * Levels: 'info' (accent), 'success' (statusSuccess), 'warning'
 * (statusWarning), 'error' (statusError).
 *
 * Motion is data, played client-side as window (slab) effects: a toast
 * slides in with 'toast-arrive', its level accent follows as it settles
 * ('toast-info' | 'toast-success' | 'toast-warning' | 'toast-error'), it
 * leaves with 'toast-depart' (the window closes when that effect ends), and
 * the toasts below glide up into the gap. NotificationCenter registers these
 * names with WidgetManager when they are missing, so anyone can restyle them
 * with registerWindowEffect under the same name. Nothing streams per frame.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { require as contractRequire, invariant } from '../core/contracts.js';
import { shapeOf } from '../core/theme-data.js';
import { sectionHeaderStyle, sectionHeaderText, hintStyle, emptyStateMarkdown, emptyStateStyle } from './ui-kit.js';
import type { SlabEffectSpec } from '../ui/gl/slab-motion.js';
import type { ListItem } from './widgets/list-widget.js';

const NOTIFICATION_INTERFACE: InterfaceId = 'abjects:notify' as InterfaceId;
export const NOTIFICATION_CENTER_ID = 'abjects:notification-center' as AbjectId;

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

/**
 * The toast motion library: named slab effects registered with WidgetManager
 * (only when the name is not registered yet, so a restyle survives). Offsets
 * are px, rotations radians; see WidgetManager registerWindowEffect.
 */
export const TOAST_EFFECTS: Readonly<Record<string, SlabEffectSpec>> = {
  /** Slide in from the right edge with a slight swing, overshoot, settle. */
  'toast-arrive': {
    duration: 640,
    easing: 'decelerate',
    x: { stops: [[0, 380], [0.62, -12], [0.82, 4], [1, 0]] },
    z: { stops: [[0, 70], [0.6, 0], [1, 0]] },
    rotateY: { stops: [[0, 0.5], [0.62, -0.05], [0.84, 0.015], [1, 0]] },
    opacity: { stops: [[0, 0], [0.3, 1], [1, 1]] },
  },
  /** Slide off to the right, folding to a bright line; ends hidden. */
  'toast-depart': {
    duration: 420,
    easing: 'accelerate',
    x: [0, 120],
    scaleY: { stops: [[0, 1], [0.45, 0.85], [1, 0.06]] },
    opacity: { stops: [[0, 1], [0.5, 0.85], [1, 0]] },
    scan: { from: 'middle', alpha: { stops: [[0, 0], [0.5, 0.8], [1, 0]] } },
  },
  /** Info: a living-light rim flash. */
  'toast-info': {
    duration: 700,
    easing: 'decelerate',
    rim: { alpha: [0.9, 0] },
    aura: { alpha: [0.4, 0], spread: 22 },
  },
  /** Success: a living-light burst off the edges. */
  'toast-success': {
    duration: 1000,
    easing: 'decelerate',
    rim: { alpha: [0.95, 0] },
    aura: { alpha: [0.5, 0], spread: 26 },
    particles: { count: 40, from: 'edges', speed: [40, 150], size: [1.5, 4], gravity: 25, shape: 'glow' },
  },
  /** Warning: a brass rim and a small swell. */
  'toast-warning': {
    duration: 760,
    easing: 'decelerate',
    scale: { wave: { amplitude: 0.025, cycles: 1, decay: true } },
    rim: { color: '$statusWarning', alpha: [0.95, 0] },
    aura: { color: '$statusWarning', alpha: [0.35, 0], spread: 22 },
  },
  /** Error: a short shake with a red rim. */
  'toast-error': {
    duration: 480,
    easing: 'linear',
    x: { wave: { amplitude: 8, cycles: 4, decay: true } },
    rim: { color: '$statusError', alpha: [1, 0] },
    aura: { color: '$statusError', alpha: [0.35, 0], spread: 20 },
  },
};

/** When the level accent plays, after the arrival starts (the slide has settled). */
const ACCENT_DELAY_MS = 420;
/** Toasts below a departing one start gliding up this far into its departure. */
const REFLOW_DELAY_MS = 180;
/** How long the glide into a new slot takes. */
const REFLOW_MS = 460;
/**
 * A departed toast stays hidden this long past its departure effect, so the
 * window can close with no flash of the resting slab in between.
 */
const DEPART_HOLD_MS = 2500;
/** Re-read the registered toast effects (durations, missing names) at most this often. */
const EFFECT_SYNC_TTL_MS = 60_000;

/**
 * Keeps a departed toast hidden from just before its departure ends until
 * well after, covering the moment between the effect finishing and the
 * window closing.
 */
function holdHiddenSpec(departMs: number): SlabEffectSpec {
  const total = departMs + DEPART_HOLD_MS;
  const off = Math.max(0, departMs - 40) / total;
  const hidden = Math.max(0, departMs - 10) / total;
  return { duration: total, easing: 'linear', opacity: { stops: [[0, 1], [off, 1], [hidden, 0], [1, 0]] } };
}

/** Starts a slab `dy` px below its new rest and eases it up, overshooting a touch. */
function glideSpec(dy: number): SlabEffectSpec {
  return { duration: REFLOW_MS, easing: 'decelerate', y: { stops: [[0, dy], [0.78, -0.05 * dy], [1, 0]] } };
}

interface ActiveToast {
  /** Undefined until the window exists (the slot is reserved first). */
  windowId?: AbjectId;
  level: NotificationLevel;
  /** The y the window currently rests at (desktop px). */
  y: number;
  /** Dismissed before its window finished building. */
  cancelled?: boolean;
  dismissTimer?: ReturnType<typeof setTimeout>;
  accentTimer?: ReturnType<typeof setTimeout>;
}

/**
 * A single past notification kept in the history. `id` is monotonic so the
 * viewer can use it as a stable list-row value across rebuilds.
 */
interface NotificationEntry {
  id: string;
  message: string;
  level: NotificationLevel;
  timestamp: number;
}

const TOAST_WIDTH = 320;
const TOAST_HEIGHT = 56;
const TOAST_GAP = 8;
const SCREEN_MARGIN = 16;
const DEFAULT_DURATION_MS = 4000;

const MAX_HISTORY = 100;
const VIEWER_WIDTH = 420;
const VIEWER_HEIGHT = 480;

export class NotificationCenter extends Abject {
  private widgetManagerId?: AbjectId;
  private uiServerId?: AbjectId;
  /** The stack, top to bottom; a toast leaves it when its departure starts. */
  private toasts: ActiveToast[] = [];
  /** Toasts playing their departure (window still open). */
  private departing = new Set<ActiveToast>();
  private displayWidth = 1280;
  private displayHeight = 800;

  /** Toast effect names known to be registered, with their current durations. */
  private effectDurations = new Map<string, number>();
  private effectsSyncedAt = 0;
  private effectSync?: Promise<void>;
  private reflowTimer?: ReturnType<typeof setTimeout>;

  /** In-memory history; capped at MAX_HISTORY. Newest first. */
  private history: NotificationEntry[] = [];
  private nextHistoryId = 1;

  // Viewer window state. Distinct from toast windows.
  private viewerWindowId?: AbjectId;
  private viewerListId?: AbjectId;
  private viewerClearBtnId?: AbjectId;
  private viewerEmptyLabelId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'NotificationCenter',
        description: 'System-wide toast notifications. Fire-and-forget transient messages from any Abject.',
        version: '1.1.0',
        interface: {
          id: NOTIFICATION_INTERFACE,
          name: 'NotificationCenter',
          description: 'Surface a short transient message to the user. Toast motion is a set of named window effects played client-side: toast-arrive (slide in), then the level accent toast-info | toast-success | toast-warning | toast-error, and toast-depart (the toast closes when it ends, so end it hidden). NotificationCenter registers them with WidgetManager only when missing; restyle any of them with WidgetManager registerWindowEffect({ name, spec }) under the same name.',
          methods: [
            {
              name: 'notify',
              description: 'Show a toast and append the message to history. The toast slides in, plays its level accent, and leaves after durationMs; toasts below it glide up.',
              parameters: [
                { name: 'message',     type: { kind: 'primitive', primitive: 'string' },  description: 'Text to display' },
                { name: 'level',       type: { kind: 'primitive', primitive: 'string' },  description: 'info | success | warning | error', optional: true },
                { name: 'durationMs',  type: { kind: 'primitive', primitive: 'number' },  description: 'Visible duration in ms (default 4000)', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'clear',
              description: 'Dismiss every active toast now (each plays its departure). Does not affect history.',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'show',
              description: 'Open the notifications history viewer window.',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'hide',
              description: 'Close the notifications history viewer window.',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'toggle',
              description: 'Toggle the notifications history viewer window.',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'listNotifications',
              description: 'Return the recent notifications history (newest first).',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'NotificationEntry' } },
            },
            {
              name: 'clearHistory',
              description: 'Remove every notification from history. Does not affect active toasts.',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
          ],
          events: [
            {
              name: 'notificationAdded',
              description: 'Fires with the full content of every new notification, so mirroring surfaces can show the toast.',
              payload: { kind: 'object', properties: {
                message: { kind: 'primitive', primitive: 'string' },
                level: { kind: 'primitive', primitive: 'string' },
                at: { kind: 'primitive', primitive: 'number' },
              } },
            },
            {
              name: 'historyChanged',
              description: 'Fires when the history count changes (add or clear).',
              payload: { kind: 'object', properties: {
                count: { kind: 'primitive', primitive: 'number' },
              } },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'ui', 'notifications'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.widgetManagerId = await this.discoverDep('WidgetManager') ?? undefined;
    this.uiServerId = await this.discoverDep('BackendUI') ?? undefined;
    await this.fetchTheme();
    await this.refreshDisplaySize();
    await this.syncToastEffects();
  }

  private setupHandlers(): void {
    this.on('notify', async (msg: AbjectMessage) => {
      const { message, level, durationMs } = msg.payload as {
        message: string;
        level?: NotificationLevel;
        durationMs?: number;
      };
      const text = message ?? '';
      const lvl = level ?? 'info';
      if (text.length > 0) {
        // Record before showing the toast — even if the toast spawn fails
        // (no WidgetManager yet, etc.), the entry still lands in history.
        this.recordHistory(text, lvl);
        // Full toast content for mirroring surfaces (terminal gateways);
        // historyChanged above only carries the count.
        this.changed('notificationAdded', { message: text, level: lvl, at: Date.now() });
      }
      await this.spawnToast(text, lvl, durationMs ?? DEFAULT_DURATION_MS);
      return true;
    });

    this.on('clear', async () => {
      // Everything leaves at once; no glides, the whole stack is going.
      await Promise.all(this.toasts.slice().map((t) => this.dismissToast(t, false)));
      return true;
    });

    this.on('listNotifications', async () => this.history.slice());

    this.on('clearHistory', async () => {
      this.history = [];
      this.changed('historyChanged', { count: 0 });
      if (this.viewerWindowId) await this.refreshViewer();
      return true;
    });

    this.on('show',   async () => this.openViewer());
    this.on('hide',   async () => this.closeViewer());
    this.on('toggle', async () => this.viewerWindowId ? this.closeViewer() : this.openViewer());

    // Window-close from chrome / Esc — clean up viewer state.
    this.on('windowCloseRequested', async () => {
      if (this.viewerWindowId) await this.closeViewer();
    });

    // Click handlers for viewer widgets.
    this.on('changed', async (m: AbjectMessage) => {
      const { aspect } = m.payload as { aspect: string };
      const fromId = m.routing.from;
      if (aspect === 'click' && fromId === this.viewerClearBtnId) {
        if (this.history.length === 0) return;
        this.history = [];
        this.changed('historyChanged', { count: 0 });
        await this.refreshViewer();
        // Applied: a hand-coloured flash on the viewer.
        if (this.viewerWindowId) {
          this.playWindowEffect(this.viewerWindowId, 'flash', '$accent');
        }
      }
    });
  }

  private recordHistory(message: string, level: NotificationLevel): void {
    this.history.unshift({
      id: `n${this.nextHistoryId++}`,
      message,
      level,
      timestamp: Date.now(),
    });
    if (this.history.length > MAX_HISTORY) {
      this.history.length = MAX_HISTORY;
    }
    this.changed('historyChanged', { count: this.history.length });
    // If the viewer is open, refresh it so newly arriving notifications
    // appear at the top in real time.
    if (this.viewerWindowId) {
      this.refreshViewer().catch(() => {});
    }
  }

  private async refreshDisplaySize(): Promise<void> {
    if (!this.widgetManagerId) return;
    try {
      const info = await this.request<{ width: number; height: number }>(
        request(this.id, this.widgetManagerId, 'getDisplayInfo', {}),
      );
      this.displayWidth = info.width;
      this.displayHeight = info.height;
    } catch { /* keep defaults */ }
  }

  // ── Toast motion library ────────────────────────────────────────────

  /**
   * Register any toast effect WidgetManager does not know yet and note the
   * durations of the ones it does (a restyled 'toast-depart' sets when the
   * window closes). Concurrent calls share one pass.
   */
  private syncToastEffects(): Promise<void> {
    if (!this.effectSync) {
      this.effectSync = this.doSyncToastEffects().finally(() => { this.effectSync = undefined; });
    }
    return this.effectSync;
  }

  private async doSyncToastEffects(): Promise<void> {
    if (!this.widgetManagerId) return;
    this.effectsSyncedAt = Date.now();
    let registered: Record<string, SlabEffectSpec>;
    try {
      const all = await this.request<{ registered?: Record<string, SlabEffectSpec> }>(
        request(this.id, this.widgetManagerId, 'listWindowEffects', {}),
      );
      registered = all?.registered ?? {};
    } catch {
      return; // toasts play their inline specs
    }
    const known = new Map<string, number>();
    for (const [name, spec] of Object.entries(TOAST_EFFECTS)) {
      const current = registered[name];
      if (current && typeof current.duration === 'number') {
        known.set(name, current.duration);
        continue;
      }
      try {
        await this.request(request(this.id, this.widgetManagerId, 'registerWindowEffect', { name, spec }));
        known.set(name, spec.duration);
      } catch { /* this one plays inline */ }
    }
    this.effectDurations = known;
  }

  /** Play a toast effect by name when registered (so restyles apply), else inline. */
  private playToastEffect(windowId: AbjectId, name: string): void {
    const spec = TOAST_EFFECTS[name];
    if (this.effectDurations.has(name) || !spec) this.playWindowEffect(windowId, name);
    else this.playWindowEffect(windowId, spec as unknown as Record<string, unknown>);
  }

  // ── Toast lifecycle ─────────────────────────────────────────────────

  /** Resting y (desktop px) of the toast in stack slot `index`. */
  private slotY(index: number): number {
    contractRequire(index >= 0, 'slotY: index must be a stack slot');
    return SCREEN_MARGIN + index * (TOAST_HEIGHT + TOAST_GAP);
  }

  private toastX(): number {
    return this.displayWidth - TOAST_WIDTH - SCREEN_MARGIN;
  }

  private async spawnToast(message: string, level: NotificationLevel, durationMs: number): Promise<void> {
    if (!this.widgetManagerId) return;
    if (message.length === 0) return;

    // Reserve the slot before any await, so toasts fired together stack
    // instead of landing on the same spot.
    const toast: ActiveToast = { level, y: 0 };
    this.toasts.push(toast);
    this.checkInvariants();

    await this.refreshDisplaySize();
    if (Date.now() - this.effectsSyncedAt > EFFECT_SYNC_TTL_MS) void this.syncToastEffects();
    if (toast.cancelled) return;

    const y = this.slotY(this.toasts.indexOf(toast));
    let windowId: AbjectId;
    try {
      windowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId, 'createWindowAbject', {
          title: 'Notification',
          rect: { x: this.toastX(), y, width: TOAST_WIDTH, height: TOAST_HEIGHT },
          chromeless: true,
          transparent: true,
          resizable: false,
          zIndex: 10000,
          // Toasts appear unprompted; taking focus would steal typing.
          focusOnCreate: false,
          // On the phone's zoomable camera the stack stays at the screen's
          // top-right, readable, wherever the camera is looking.
          screenAnchor: 'top-right',
        }),
      );
    } catch {
      const idx = this.toasts.indexOf(toast);
      if (idx !== -1) {
        this.toasts.splice(idx, 1);
        this.scheduleReflow(0);
      }
      return;
    }
    if (toast.cancelled) {
      // Dismissed while the window was being made: it never showed.
      await this.destroyToastWindow(windowId);
      return;
    }
    toast.windowId = windowId;
    toast.y = y;

    // Arrival starts now, while the card is still empty (a transparent window
    // shows nothing until its card paints), so the toast slides in rather
    // than appearing and then jumping. The level accent follows once the
    // slide has settled.
    this.playToastEffect(windowId, 'toast-arrive');
    toast.accentTimer = this.setTimer(() => {
      toast.accentTimer = undefined;
      if (toast.windowId && this.toasts.includes(toast)) this.playToastEffect(toast.windowId, `toast-${level}`);
    }, ACCENT_DELAY_MS);

    const labelColor = this.colorForLevel(level);
    const accent     = this.accentForLevel(level);

    // Toasts lead with a solid level bar (an empty label filled with the
    // level's accent) so the level reads at a glance.
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId, 'create', {
        specs: [
          {
            type: 'label',
            windowId,
            text: message,
            style: {
              wordWrap: true,
              color: labelColor,
              fontSize: 13,
            },
          },
          { type: 'label', windowId, text: '', style: { background: accent, radius: 0 } },
        ],
      }),
    ).catch(() => ({ widgetIds: [] as AbjectId[] }));

    const [labelId, barId] = widgetIds;

    // Square card: level bar flush on the left edge, message beside it.
    const layoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId, 'createHBox', {
        windowId,
        margins: { top: 0, right: 16, bottom: 0, left: 0 },
        spacing: 12,
        style: { background: this.theme.windowBg, borderColor: this.theme.windowBorder, borderWidth: shapeOf(this.theme).ruleWidth, radius: 0 },
      }),
    ).catch(() => undefined);

    if (layoutId && labelId && barId) {
      await this.request(request(this.id, layoutId, 'addLayoutChildren', {
        children: [
          { widgetId: barId, sizePolicy: { vertical: 'expanding', horizontal: 'fixed' }, preferredSize: { width: 6 } },
          { widgetId: labelId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        ],
      })).catch(() => {});
    }

    // Dismissed (or cleared) while the card was being built: its departure
    // is already under way.
    if (!this.toasts.includes(toast)) return;

    toast.dismissTimer = this.setTimer(() => {
      toast.dismissTimer = undefined;
      this.dismissToast(toast).catch(() => {});
    }, durationMs);

    // The stack may have shifted while this window was being built.
    if (this.slotY(this.toasts.indexOf(toast)) !== toast.y) this.scheduleReflow(0);
  }

  /**
   * Take a toast off the stack and play its departure, then close its window
   * when the departure ends. The toasts below start gliding up partway
   * through (unless `reflow` is false: clearing the whole stack).
   */
  private async dismissToast(toast: ActiveToast, reflow = true): Promise<void> {
    const idx = this.toasts.indexOf(toast);
    if (idx === -1) return;
    this.cancelTimer(toast.dismissTimer);
    this.cancelTimer(toast.accentTimer);
    toast.dismissTimer = undefined;
    toast.accentTimer = undefined;
    this.toasts.splice(idx, 1);

    if (!toast.windowId) {
      // Still being made: spawnToast closes the window as soon as it exists.
      toast.cancelled = true;
      if (reflow) this.scheduleReflow(0);
      this.checkInvariants();
      return;
    }

    const windowId = toast.windowId;
    this.departing.add(toast);
    this.checkInvariants();
    const departMs = this.effectDurations.get('toast-depart') ?? TOAST_EFFECTS['toast-depart'].duration;
    this.playToastEffect(windowId, 'toast-depart');
    // A finished effect lets the slab rest visible again, and the close
    // below can land a frame or two after the departure ends: hold the slab
    // hidden from just before the end until the window is gone.
    this.playWindowEffect(windowId, holdHiddenSpec(departMs) as unknown as Record<string, unknown>);
    if (reflow) this.scheduleReflow(Math.min(REFLOW_DELAY_MS, departMs));

    await new Promise<void>((resolve) => {
      this.setTimer(async () => {
        try {
          await this.destroyToastWindow(windowId);
        } finally {
          this.departing.delete(toast);
          resolve();
        }
      }, departMs);
    });
  }

  private async destroyToastWindow(windowId: AbjectId): Promise<void> {
    if (!this.widgetManagerId) return;
    try {
      await this.request(request(this.id, this.widgetManagerId, 'destroyWindowAbject', { windowId }));
    } catch { /* already gone */ }
  }

  /** Coalesce stack reflows: the latest request wins. */
  private scheduleReflow(delayMs: number): void {
    this.cancelTimer(this.reflowTimer);
    this.reflowTimer = this.setTimer(() => {
      this.reflowTimer = undefined;
      this.reflowToasts().catch(() => {});
    }, delayMs);
  }

  /**
   * Move each toast to its slot. The rect changes once; a one-shot glide
   * effect starts the slab where it was and eases it into place client-side,
   * with a small overshoot. Two messages per moved toast, nothing per frame.
   */
  private async reflowToasts(): Promise<void> {
    const x = this.toastX();
    for (let i = 0; i < this.toasts.length; i++) {
      const t = this.toasts[i];
      if (!t.windowId) continue; // placed when its window is made
      const y = this.slotY(i);
      if (y === t.y) continue;
      const dy = t.y - y;
      t.y = y;
      try {
        this.send(event(this.id, t.windowId, 'windowRect', { x, y, width: TOAST_WIDTH, height: TOAST_HEIGHT }));
        this.playWindowEffect(t.windowId, glideSpec(dy) as unknown as Record<string, unknown>);
      } catch { /* window may have been destroyed mid-reflow */ }
    }
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.toasts.every((t) => !this.departing.has(t)), 'a departing toast has left the stack');
    invariant(this.toasts.every((t) => !t.cancelled), 'a cancelled toast has left the stack');
  }

  // ── Viewer window ───────────────────────────────────────────────────

  private async openViewer(): Promise<boolean> {
    if (!this.widgetManagerId) return false;
    if (this.viewerWindowId) {
      // Already open — refresh (newest items may have arrived) and bail.
      await this.refreshViewer();
      return true;
    }

    await this.refreshDisplaySize();
    const x = Math.max(0, this.displayWidth - VIEWER_WIDTH - SCREEN_MARGIN);
    const y = Math.max(40, SCREEN_MARGIN + 40);

    this.viewerWindowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId, 'createWindowAbject', {
        title: 'Notifications',
        rect: { x, y, width: VIEWER_WIDTH, height: VIEWER_HEIGHT },
        chromeless: false,
        resizable: true,
        zIndex: 8500,
      }),
    );

    await this.request(request(this.id, this.viewerWindowId, 'addDependent', {}));

    const rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId, 'createVBox', {
        windowId: this.viewerWindowId,
        margins: { top: 12, right: 16, bottom: 12, left: 16 },
        spacing: 8,
      }),
    );

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId, 'create', {
        specs: [
          {
            type: 'button',
            windowId: this.viewerWindowId,
            text: 'Clear',
            style: { background: this.theme.destructiveBg, color: this.theme.destructiveText, borderColor: this.theme.destructiveBorder },
          },
          {
            type: 'list',
            windowId: this.viewerWindowId,
            items: this.toViewerItems(),
            itemHeight: 36,
          },
          {
            type: 'label',
            windowId: this.viewerWindowId,
            text: emptyStateMarkdown('No notifications yet', 'Messages from your objects and agents collect here, newest first.'),
            style: emptyStateStyle(this.theme),
          },
          {
            type: 'label',
            windowId: this.viewerWindowId,
            text: sectionHeaderText(this.theme, 'Recent'),
            style: sectionHeaderStyle(this.theme),
          },
          {
            type: 'label',
            windowId: this.viewerWindowId,
            text: `Newest first, up to ${MAX_HISTORY} kept.`,
            style: { ...hintStyle(this.theme, 11), wordWrap: false },
          },
        ],
      }),
    );

    const [clearBtnId, listId, emptyLabelId, headerLabelId, hintLabelId] = widgetIds;
    [this.viewerClearBtnId, this.viewerListId, this.viewerEmptyLabelId] = [clearBtnId, listId, emptyLabelId];
    await this.request(request(this.id, this.viewerClearBtnId, 'addDependent', {}));

    // Header row: section title and hint on the left, Clear on the right.
    const headerRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId, 'createNestedHBox', {
        parentLayoutId: rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      }),
    );
    const headerTextId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId, 'createNestedVBox', {
        parentLayoutId: headerRowId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 2,
      }),
    );
    await this.request(request(this.id, headerTextId, 'addLayoutChildren', {
      children: [
        { widgetId: headerLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 18 } },
        { widgetId: hintLabelId,   sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 14 } },
      ],
    }));
    await this.request(request(this.id, headerRowId, 'addLayoutChildren', {
      children: [
        { widgetId: headerTextId,          sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.viewerClearBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 80, height: 30 } },
      ],
    }));

    await this.request(request(this.id, rootLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: headerRowId,         sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 34 } },
        { widgetId: this.viewerListId,     sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.viewerEmptyLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 56 } },
      ],
    }));

    await this.applyEmptyState();

    return true;
  }

  private async closeViewer(): Promise<boolean> {
    if (!this.viewerWindowId || !this.widgetManagerId) return true;
    const wid = this.viewerWindowId;
    this.viewerWindowId = undefined;
    this.viewerListId = undefined;
    this.viewerClearBtnId = undefined;
    this.viewerEmptyLabelId = undefined;
    try {
      await this.request(request(this.id, this.widgetManagerId, 'destroyWindowAbject', { windowId: wid }));
    } catch { /* already gone */ }
    return true;
  }

  private async refreshViewer(): Promise<void> {
    if (!this.viewerListId) return;
    try {
      await this.request(request(this.id, this.viewerListId, 'update', {
        items: this.toViewerItems(),
      }));
      await this.applyEmptyState();
    } catch { /* widget gone */ }
  }

  private async applyEmptyState(): Promise<void> {
    if (!this.viewerListId || !this.viewerEmptyLabelId) return;
    const empty = this.history.length === 0;
    try {
      await this.request(request(this.id, this.viewerListId, 'update', { style: { visible: !empty } }));
      await this.request(request(this.id, this.viewerEmptyLabelId, 'update', { style: { visible: empty } }));
      // Clear is live only while there is something to clear.
      if (this.viewerClearBtnId) {
        await this.request(request(this.id, this.viewerClearBtnId, 'update', { style: { disabled: empty } }));
      }
    } catch { /* widgets gone */ }
  }

  /**
   * Render the history as ListItems with the level icon, message, and a
   * relative timestamp ("2m ago"). Newest first.
   */
  private toViewerItems(): ListItem[] {
    const now = Date.now();
    return this.history.map((entry) => ({
      label: entry.message,
      value: entry.id,
      secondary: formatRelativeTime(now - entry.timestamp),
      badge: { text: entry.level, color: this.colorForLevel(entry.level) },
    }));
  }

  // ── Theming helpers ─────────────────────────────────────────────────

  private colorForLevel(level: NotificationLevel): string {
    switch (level) {
      case 'success': return this.theme.statusSuccess;
      case 'warning': return this.theme.statusWarning;
      case 'error':   return this.theme.statusErrorBright;
      case 'info':
      default:        return this.theme.textPrimary;
    }
  }

  private accentForLevel(level: NotificationLevel): string {
    // Good news is the living light; warnings brass; errors red.
    switch (level) {
      case 'warning': return this.theme.statusWarning;
      case 'error':   return this.theme.statusError;
      case 'success':
      case 'info':
      default:        return this.theme.accentSecondary;
    }
  }
}

/**
 * Format a millisecond delta as a short relative time ("just now", "2m ago",
 * "3h ago"). The viewer uses these as the secondary text on each row.
 */
function formatRelativeTime(deltaMs: number): string {
  const s = Math.floor(deltaMs / 1000);
  if (s < 30) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
