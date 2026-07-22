/**
 * ChatBrowser — per-workspace UI surface for the Chat conversation roster.
 *
 * Thin UI over ChatManager. Subscribes to ChatManager's `changed` events to
 * live-refresh a list of conversations, and dispatches user button clicks
 * (open, delete, new) as requests back to ChatManager. No persistence, no
 * lifecycle — all state lives in ChatManager. An onboarding flag lets the
 * browser auto-open once on a fresh workspace so users discover the feature.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { Log } from '../core/timed-log.js';
import { lightenColor } from './widgets/widget-types.js';
import type { ListItem } from './widgets/list-widget.js';
import type { PersistedConversation } from './chat-manager.js';

const log = new Log('ChatBrowser');

const CHAT_BROWSER_INTERFACE: InterfaceId = 'abjects:chat-browser';

const ONBOARDING_KEY = 'chat-browser:seen-onboarding';

const OVERVIEW_W = 440;
const OVERVIEW_H = 520;
const HEADER_BTN_H = 40;

export class ChatBrowser extends Abject {
  private widgetManagerId?: AbjectId;
  private chatManagerId?: AbjectId;
  private storageId?: AbjectId;

  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private listWidgetId?: AbjectId;
  private newChatBtnId?: AbjectId;

  private refreshTimer?: ReturnType<typeof setTimeout>;
  /** Single-flight guards: at most one refresh (fetch + rebuild) runs at a
   *  time. A roster event during a refresh sets `refreshPending`, and the
   *  loop re-runs once after — so a burst of events (e.g. during a goal) can
   *  never spawn overlapping window rebuilds that flood the render queue. */
  private refreshInFlight = false;
  private refreshPending = false;

  constructor() {
    super({
      manifest: {
        name: 'ChatBrowser',
        description:
          'UI window listing the conversations in ChatManager. Provides ' +
          'buttons to create, open, and delete conversations; subscribes to ' +
          'ChatManager events to stay in sync. No state of its own.',
        version: '1.0.0',
        interface: {
          id: CHAT_BROWSER_INTERFACE,
          name: 'ChatBrowser',
          description: 'Chat conversation overview window',
          methods: [
            {
              name: 'show',
              description: 'Open the conversation overview window.',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'hide',
              description: 'Close the overview window.',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'getState',
              description: 'Return whether the overview window is currently visible.',
              parameters: [],
              returns: { kind: 'object', properties: {
                visible: { kind: 'primitive', primitive: 'boolean' },
              } },
            },
          ],
          events: [],
        },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display conversation overview', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.chatManagerId = await this.requireDep('ChatManager');
    this.storageId = await this.discoverDep('Storage') ?? undefined;

    // Subscribe to ChatManager so we live-refresh on roster changes
    this.send(request(this.id, this.chatManagerId, 'addDependent', {}));

    // First-run: open the overview the first time a workspace is seen so
    // users discover the chat feature. Once any conversation is created, the
    // onboarding flag is set and we never auto-open again.
    queueMicrotask(() => void this.maybeShowFirstRun());
  }

  private setupHandlers(): void {
    this.on('show', async () => this.show());
    this.on('hide', async () => this.hide());
    this.on('getState', async () => ({ visible: !!this.windowId }));

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;

      if (aspect === 'click' && fromId === this.newChatBtnId) {
        await this.requestNewConversation();
        return;
      }

      // Rich list events: clicking a row opens it; the inline Delete action
      // removes it. Both carry the conversationId in the item's `value`.
      if (fromId === this.listWidgetId) {
        if (aspect === 'selectionChanged') {
          const convId = parseItemValue(value)?.value;
          if (convId) await this.requestShowConversation(convId);
          return;
        }
        if (aspect === 'action') {
          const data = parseItemValue(value);
          if (data?.actionId === 'delete' && data.value) {
            await this.requestDeleteConversation(data.value);
          }
          return;
        }
        return;
      }

      // ChatManager roster events → refresh the list
      if (fromId === this.chatManagerId) {
        if (aspect === 'rosterChanged'
          || aspect === 'conversationCreated'
          || aspect === 'conversationDeleted'
          || aspect === 'conversationRenamed') {
          // Mark onboarding seen once the user creates their first chat
          if (aspect === 'conversationCreated') this.markOnboardingSeen();
          this.scheduleRefresh();
        }
      }
    });

    this.on('windowCloseRequested', async () => { await this.hide(); });
  }

  // ─── Dispatchers to ChatManager ────────────────────────────────────

  private async requestNewConversation(): Promise<void> {
    if (!this.chatManagerId) return;
    try {
      await this.request(request(this.id, this.chatManagerId, 'newConversation', {}), 5000);
    } catch (err) { log.warn(`newConversation failed: ${String(err)}`); }
  }

  private async requestShowConversation(conversationId: string): Promise<void> {
    if (!this.chatManagerId) return;
    try {
      await this.request(request(this.id, this.chatManagerId, 'showConversation', { conversationId }), 5000);
    } catch (err) { log.warn(`showConversation failed: ${String(err)}`); }
  }

  private async requestDeleteConversation(conversationId: string): Promise<void> {
    if (!this.chatManagerId) return;
    try {
      await this.request(request(this.id, this.chatManagerId, 'deleteConversation', { conversationId }), 5000);
      await this.notify('Conversation deleted', 'success');
    } catch (err) {
      log.warn(`deleteConversation failed: ${String(err)}`);
      await this.notify('Delete failed', 'error');
    }
  }

  /**
   * Fetch the roster. Returns the rows on success (possibly an empty array
   * for a genuinely empty roster), or `null` when the request failed or timed
   * out — callers keep the current list on null rather than blanking it. The
   * timeout is generous because ChatManager can be briefly busy under load,
   * and a slow reply must not be read as "no conversations".
   */
  private async fetchRoster(): Promise<PersistedConversation[] | null> {
    if (!this.chatManagerId) return null;
    try {
      const rows = await this.request<PersistedConversation[]>(
        request(this.id, this.chatManagerId, 'listConversations', {}), 5000,
      );
      return rows ?? [];
    } catch (err) {
      log.warn(`listConversations failed (keeping current list): ${String(err)}`);
      return null;
    }
  }

  // ─── First-run / onboarding ────────────────────────────────────────

  private async maybeShowFirstRun(): Promise<void> {
    if (!this.storageId || !this.chatManagerId) return;
    try {
      const seen = await this.request<boolean | null>(
        request(this.id, this.storageId, 'get', { key: ONBOARDING_KEY })
      );
      if (seen) return;
      // Only auto-open for an empty roster; if the user already has chats,
      // the Taskbar Chat button is the discoverable entry point.
      const state = await this.request<{ conversationCount: number }>(
        request(this.id, this.chatManagerId, 'getState', {})
      );
      if (state && state.conversationCount > 0) return;
    } catch { /* best effort */ }
    await this.show();
  }

  private markOnboardingSeen(): void {
    if (!this.storageId) return;
    try {
      this.send(request(this.id, this.storageId, 'set', { key: ONBOARDING_KEY, value: true }));
    } catch { /* best effort */ }
  }

  // ─── Window lifecycle ──────────────────────────────────────────────

  async show(): Promise<boolean> {
    if (this.windowId) {
      try {
        await this.request(request(this.id, this.widgetManagerId!, 'raiseWindow', { windowId: this.windowId }));
      } catch { /* best effort */ }
      return true;
    }

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );
    const winW = Math.min(OVERVIEW_W, Math.max(320, displayInfo.width - 40));
    const winH = Math.min(OVERVIEW_H, Math.max(320, displayInfo.height - 40));
    const winX = Math.max(20, Math.floor((displayInfo.width - winW) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - winH) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: '\uD83D\uDCAC  Conversations',
        rect: { x: winX, y: winY, width: winW, height: winH },
        zIndex: 210,
        resizable: true,
      })
    );
    this.send(request(this.id, this.windowId, 'addDependent', {}));

    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: this.theme.tokens.space.xl, right: this.theme.tokens.space.xl, bottom: this.theme.tokens.space.xl, left: this.theme.tokens.space.xl },
        spacing: this.theme.tokens.space.md,
      })
    );

    await this.populate(await this.fetchRoster() ?? []);
    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;
    try {
      await this.request(request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      }));
    } catch { /* best effort */ }
    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.listWidgetId = undefined;
    this.newChatBtnId = undefined;
    this.changed('visibility', false);
    return true;
  }

  private scheduleRefresh(): void {
    if (!this.windowId) return;
    // Coalesce: mark that a refresh is wanted. If one is already running or a
    // debounce timer is pending, that in-flight pass will pick it up — we must
    // NOT start a second concurrent refresh (overlapping rebuilds flood the
    // render queue and freeze the UI during a goal's roster-event burst).
    this.refreshPending = true;
    if (this.refreshInFlight || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.drainRefresh();
    }, 80);
  }

  /** Run refreshes single-file until none is pending. Fetches BEFORE clearing,
   *  so a timed-out/failed fetch keeps the current list instead of blanking it. */
  private async drainRefresh(): Promise<void> {
    if (this.refreshInFlight) return;
    this.refreshInFlight = true;
    try {
      while (this.refreshPending) {
        this.refreshPending = false;
        if (!this.windowId || !this.rootLayoutId) return;
        const rows = await this.fetchRoster();
        if (rows === null) continue; // keep current; re-loop if more arrived
        try {
          await this.request(request(this.id, this.rootLayoutId, 'clearLayoutChildren', {}));
        } catch { /* best effort */ }
        this.listWidgetId = undefined;
        this.newChatBtnId = undefined;
        await this.populate(rows);
      }
    } finally {
      this.refreshInFlight = false;
    }
  }

  // ─── Rendering ─────────────────────────────────────────────────────

  private async populate(rows: PersistedConversation[]): Promise<void> {
    if (!this.rootLayoutId || !this.windowId) return;

    // Header row: title + "+ New chat"
    const headerRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: this.theme.tokens.space.md,
      })
    );

    const headerSpecs: Array<Record<string, unknown>> = [
      {
        type: 'label', windowId: this.windowId, text: 'Conversations',
        style: { color: this.theme.textPrimary, fontSize: 14, fontWeight: 'bold', align: 'left', wordWrap: false, selectable: false },
      },
      {
        type: 'button', windowId: this.windowId, text: '+ New chat',
        style: {
          background: this.theme.actionBg,
          color: this.theme.actionText,
          borderColor: this.theme.actionBorder,
          fontSize: 13,
          radius: 6,
        },
      },
    ];
    const { widgetIds: headerIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: headerSpecs })
    );
    const titleLabelId = headerIds[0];
    this.newChatBtnId = headerIds[1];

    await this.request(request(this.id, headerRowId, 'addLayoutChildren', {
      children: [
        { widgetId: titleLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: HEADER_BTN_H } },
        { widgetId: this.newChatBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 120, height: HEADER_BTN_H } },
      ],
    }));
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: headerRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: HEADER_BTN_H },
    }));
    this.send(request(this.id, this.newChatBtnId, 'addDependent', {}));

    if (rows.length === 0) {
      await this.renderEmptyState();
      return;
    }

    // A single rich ListWidget renders each conversation as a card: title on
    // the first line, relative time muted below, and an inline Delete action.
    // Clicking a row opens the conversation; the action button deletes it.
    const { widgetIds: [listId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{ type: 'list', windowId: this.windowId, items: [], searchable: false }],
      })
    );
    this.listWidgetId = listId;

    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.listWidgetId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));
    this.send(request(this.id, this.listWidgetId, 'addDependent', {}));

    const items: ListItem[] = rows.map(c => this.toListItem(c));
    await this.request(request(this.id, this.listWidgetId, 'update', { items }));
  }

  private toListItem(c: PersistedConversation): ListItem {
    return {
      label: c.title,
      value: c.conversationId,
      detail: formatRelativeTime(c.lastActiveAt),
      actions: [
        {
          id: 'delete',
          label: 'Delete',
          color: this.theme.destructiveBg,
          textColor: this.theme.destructiveText,
        },
      ],
    };
  }

  private async renderEmptyState(): Promise<void> {
    if (!this.rootLayoutId || !this.windowId) return;
    const text =
      '\u2728  **Start a conversation**\n\n' +
      'Each chat is its own window and keeps its own history. ' +
      'Click **+ New chat** above to begin.';
    const { widgetIds: [cardId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{
          type: 'markdown', windowId: this.windowId, text,
          style: {
            color: this.theme.textPrimary,
            fontSize: 13,
            wordWrap: true,
            selectable: false,
            markdown: true,
            align: 'center',
            background: lightenColor(this.theme.windowBg, 6),
            radius: 12,
          },
        }],
      })
    );
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: cardId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 120 },
      alignment: 'center',
    }));
  }
}

/** Parse a ListWidget event payload (`selectionChanged`/`action`) into fields. */
function parseItemValue(value: unknown): { value?: string; actionId?: string } | undefined {
  try {
    if (typeof value === 'string') return JSON.parse(value);
    if (value && typeof value === 'object') return value as { value?: string; actionId?: string };
  } catch { /* malformed */ }
  return undefined;
}

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

export const CHAT_BROWSER_ID = 'abjects:chat-browser' as AbjectId;
