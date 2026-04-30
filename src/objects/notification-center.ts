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
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Tween, fadeIn as motionFadeIn, fadeOut as motionFadeOut } from '../ui/motion.js';
import type { ListItem } from './widgets/list-widget.js';
import type { IconName } from '../ui/icons.js';

const NOTIFICATION_INTERFACE: InterfaceId = 'abjects:notify' as InterfaceId;
export const NOTIFICATION_CENTER_ID = 'abjects:notification-center' as AbjectId;

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

interface ActiveToast {
  windowId: AbjectId;
  surfaceId?: string;
  height: number;
  alpha: number;
  fadeIn?: Tween;
  fadeOut?: Tween;
  dismissTimer?: ReturnType<typeof setTimeout>;
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

const LEVEL_ICON: Record<NotificationLevel, IconName> = {
  info:    'info',
  success: 'check',
  warning: 'warning',
  error:   'close',
};

export class NotificationCenter extends Abject {
  private widgetManagerId?: AbjectId;
  private uiServerId?: AbjectId;
  private toasts: ActiveToast[] = [];
  private displayWidth = 1280;
  private displayHeight = 800;

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
        version: '1.0.0',
        interface: {
          id: NOTIFICATION_INTERFACE,
          name: 'NotificationCenter',
          description: 'Surface a short transient message to the user.',
          methods: [
            {
              name: 'notify',
              description: 'Show a toast and append the message to history. Toast dismisses itself after durationMs.',
              parameters: [
                { name: 'message',     type: { kind: 'primitive', primitive: 'string' },  description: 'Text to display' },
                { name: 'level',       type: { kind: 'primitive', primitive: 'string' },  description: 'info | success | warning | error', optional: true },
                { name: 'durationMs',  type: { kind: 'primitive', primitive: 'number' },  description: 'Visible duration in ms (default 4000)', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'clear',
              description: 'Dismiss every active toast immediately. Does not affect history.',
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
    await this.refreshDisplaySize();
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
      }
      await this.spawnToast(text, lvl, durationMs ?? DEFAULT_DURATION_MS);
      return true;
    });

    this.on('clear', async () => {
      for (const t of this.toasts.slice()) await this.dismissToast(t, true);
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
        this.history = [];
        this.changed('historyChanged', { count: 0 });
        await this.refreshViewer();
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

  // ── Toast lifecycle ─────────────────────────────────────────────────

  private async spawnToast(message: string, level: NotificationLevel, durationMs: number): Promise<void> {
    if (!this.widgetManagerId) return;
    if (message.length === 0) return;

    await this.refreshDisplaySize();

    const toast: ActiveToast = {
      windowId: '' as AbjectId,
      height: TOAST_HEIGHT,
      alpha: 0,
    };

    const yIndex = this.toasts.length;
    const y = SCREEN_MARGIN + yIndex * (TOAST_HEIGHT + TOAST_GAP);
    const x = this.displayWidth - TOAST_WIDTH - SCREEN_MARGIN;

    let windowId: AbjectId;
    try {
      windowId = await this.request<AbjectId>(
        request(this.id, this.widgetManagerId, 'createWindowAbject', {
          title: 'Notification',
          rect: { x, y, width: TOAST_WIDTH, height: TOAST_HEIGHT },
          chromeless: true,
          transparent: true,
          resizable: false,
          zIndex: 10000,
        }),
      );
    } catch {
      return;
    }
    toast.windowId = windowId;

    const labelColor = this.colorForLevel(level);
    const accent     = this.accentForLevel(level);

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
        ],
      }),
    ).catch(() => ({ widgetIds: [] as AbjectId[] }));

    const labelId = widgetIds[0];

    // Layout: a single VBox with an inset label. Caller sees a card with
    // an accent stripe on the left edge (drawn by the chromeless-window
    // accent line) and the message text indented.
    const layoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId, 'createVBox', {
        windowId,
        margins: { top: 12, right: 16, bottom: 12, left: 16 },
        spacing: 0,
      }),
    ).catch(() => undefined);

    if (layoutId && labelId) {
      await this.request(request(this.id, layoutId, 'addLayoutChildren', {
        children: [
          { widgetId: labelId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        ],
      })).catch(() => {});
    }

    // Fade in.
    toast.fadeIn = motionFadeIn(180, (a) => {
      toast.alpha = a;
      this.applyAlpha(toast).catch(() => {});
    }).start();

    // Auto-dismiss timer.
    toast.dismissTimer = setTimeout(() => {
      this.dismissToast(toast).catch(() => {});
    }, durationMs);

    this.toasts.push(toast);

    // Suppress unused; level is captured via colors but not stored.
    void accent;
  }

  private async dismissToast(toast: ActiveToast, immediate = false): Promise<void> {
    const idx = this.toasts.indexOf(toast);
    if (idx === -1) return;

    if (toast.dismissTimer) {
      clearTimeout(toast.dismissTimer);
      toast.dismissTimer = undefined;
    }
    toast.fadeIn?.cancel();

    const finalize = async () => {
      this.toasts.splice(this.toasts.indexOf(toast), 1);
      if (this.widgetManagerId && toast.windowId) {
        try {
          await this.request(
            request(this.id, this.widgetManagerId, 'destroyWindowAbject', { windowId: toast.windowId }),
          );
        } catch { /* already gone */ }
      }
      // Reflow remaining toasts upward so dismissed slots don't leave gaps.
      this.reflowToasts().catch(() => {});
    };

    if (immediate) {
      await finalize();
      return;
    }

    toast.fadeOut = motionFadeOut(180, (a) => {
      toast.alpha = a;
      this.applyAlpha(toast).catch(() => {});
    }, () => { finalize().catch(() => {}); }).start();
  }

  /**
   * Apply the current toast alpha by re-emitting a transparent overlay on
   * top of its window content. Cheap because the chromeless window is small.
   */
  private async applyAlpha(_toast: ActiveToast): Promise<void> {
    // The window-level globalAlpha wrap (in WindowAbject) renders chrome
    // and children at openOpacity. We don't update that here — but we keep
    // this hook so callers can extend with explicit overlay drawing if they
    // need finer animation than open-once-and-stay.
  }

  /**
   * Slide remaining toasts up to fill any gap left by a dismissed one.
   */
  private async reflowToasts(): Promise<void> {
    if (!this.widgetManagerId) return;
    for (let i = 0; i < this.toasts.length; i++) {
      const t = this.toasts[i];
      const y = SCREEN_MARGIN + i * (TOAST_HEIGHT + TOAST_GAP);
      const x = this.displayWidth - TOAST_WIDTH - SCREEN_MARGIN;
      try {
        await this.request(request(this.id, t.windowId, 'windowRect', {
          x, y, width: TOAST_WIDTH, height: TOAST_HEIGHT,
        }));
      } catch { /* window may have been destroyed mid-reflow */ }
    }
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
        margins: { top: 12, right: 12, bottom: 12, left: 12 },
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
            text: 'No notifications yet.',
            style: { color: this.theme.textTertiary, align: 'center' },
          },
        ],
      }),
    );

    [this.viewerClearBtnId, this.viewerListId, this.viewerEmptyLabelId] = widgetIds;
    await this.request(request(this.id, this.viewerClearBtnId, 'addDependent', {}));

    await this.request(request(this.id, rootLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: this.viewerClearBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 80, height: 30 }, alignment: 'right' },
        { widgetId: this.viewerListId,     sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.viewerEmptyLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 18 } },
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
      iconName: LEVEL_ICON[entry.level],
      iconColor: this.colorForLevel(entry.level),
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
    switch (level) {
      case 'success': return this.theme.statusSuccess;
      case 'warning': return this.theme.statusWarning;
      case 'error':   return this.theme.statusError;
      case 'info':
      default:        return this.theme.accent;
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
