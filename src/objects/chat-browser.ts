/**
 * ChatBrowser — per-workspace UI surface for the Chat conversation roster.
 *
 * Thin UI over ChatManager. Subscribes to ChatManager's `changed` events to
 * live-refresh a list of conversations, and dispatches user button clicks
 * (open, delete, new) as requests back to ChatManager. No persistence, no
 * lifecycle — all state lives in ChatManager. An onboarding flag lets the
 * browser auto-open once on a fresh workspace so users discover the feature.
 * Ctrl+Z in its window undoes the last deletion made here: ChatManager keeps
 * the step (this browser is the caller that made it), the browser forwards.
 * Private conversations show a lock and a "not remembered" note, search
 * matches only their titles (their history is never fetched for it), and
 * toasts never name them.
 *
 * The window: the count and the New chat / Private buttons, tabs (All,
 * Working, Private), and the list grouped by when each chat was last active.
 * A click or Enter opens a chat; arrows only move the selection. Rename and
 * delete show on the selected or hovered row, and F2 / Del reach them.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Log } from '../core/timed-log.js';
import { undoMethods, type UndoAction, type UndoResult, type UndoState } from '../core/undo.js';
import { sectionHeaderStyle, sectionHeaderText, emptyStateMarkdown, emptyStateStyle, livingStyle } from './ui-kit.js';
import type { ListItem } from './widgets/list-widget.js';
import type { PersistedConversation } from './chat-manager.js';

/** A roster row as listConversations returns it to a view. */
type RosterRow = PersistedConversation & { working?: boolean };

/** The list's filter tabs, in order. */
const TABS = ['all', 'working', 'private'] as const;
type Tab = typeof TABS[number];

/** What the footer teaches: the keys, and that a delete can be undone. */
const FOOTER_TEXT = '\u2191\u2193 Move    Enter Open    F2 Rename    Del Delete    \u00B7    Ctrl+Z undoes a delete';

const log = new Log('ChatBrowser');

const CHAT_BROWSER_INTERFACE: InterfaceId = 'abjects:chat-browser';

const ONBOARDING_KEY = 'chat-browser:seen-onboarding';

const OVERVIEW_W = 520;
const OVERVIEW_H = 620;
const HEADER_BTN_H = 38;
const TAB_BAR_H = 34;
const FOOTER_H = 18;

export class ChatBrowser extends Abject {
  private widgetManagerId?: AbjectId;
  private chatManagerId?: AbjectId;
  private storageId?: AbjectId;

  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private listWidgetId?: AbjectId;
  private newChatBtnId?: AbjectId;
  private newPrivateChatBtnId?: AbjectId;
  private tabBarId?: AbjectId;
  /** Section header ("N chats"), restyled while a chat is working. */
  private headerLabelId?: AbjectId;
  /** The tab whose rows the list shows. */
  private tab: Tab = 'all';
  /** The roster as last fetched, for re-filtering on a tab switch. */
  private rows: RosterRow[] = [];
  /** Each regular chat's message text for search, and the lastActiveAt it was read at. */
  private historyText = new Map<string, { at: number; text: string }>();
  /** Conversation count behind the header text. */
  private chatCount = 0;
  /** Conversations working now, from the roster rows. */
  private workingCount = 0;
  /** Aggregate goalActivity from ChatManager: some chat is working. */
  private anyChatWorking = false;

  private refreshTimer?: ReturnType<typeof setTimeout>;
  /** Single-flight guards: at most one refresh (fetch + rebuild) runs at a
   *  time. A roster event during a refresh sets `refreshPending`, and the
   *  loop re-runs once after — so a burst of events (e.g. during a goal) can
   *  never spawn overlapping window rebuilds that flood the render queue. */
  private refreshInFlight = false;
  private refreshPending = false;
  /** Conversation titles as last listed, for the delete toast. */
  private titles = new Map<string, string>();
  /** Private conversations as last listed. */
  private privateIds = new Set<string>();

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
            ...undoMethods('the last conversation deleted from this window (ChatManager keeps it)'),
          ],
          events: [],
        },
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

      // goalActivity from ChatManager (a chat turn/goal is busy) → forward
      // verbatim; the taskbar pulses the chat icon while active.
      if (aspect === 'goalActivity') {
        this.changed('goalActivity', value ?? {});
        const working = !!(value && typeof value === 'object' && (value as { active?: boolean }).active);
        if (working !== this.anyChatWorking) {
          this.anyChatWorking = working;
          this.refreshHeader();
        }
        return;
      }

      if (aspect === 'click' && fromId === this.newChatBtnId) {
        await this.requestNewConversation();
        return;
      }
      if (aspect === 'click' && fromId === this.newPrivateChatBtnId) {
        await this.requestNewConversation(true);
        return;
      }
      if (aspect === 'change' && fromId === this.tabBarId) {
        const next = TABS[typeof value === 'number' ? value : Number(value)];
        if (next && next !== this.tab) {
          this.tab = next;
          await this.pushItems();
        }
        return;
      }

      // List events: a click or Enter opens a chat (arrows only move the
      // selection); the row's actions, or F2 and Del, rename and delete it.
      // All carry the conversationId in the item's `value`.
      if (fromId === this.listWidgetId) {
        const data = parseItemValue(value);
        if (!data?.value) return;
        if ((aspect === 'selectionChanged' && data.via === 'click') || aspect === 'confirm') {
          await this.requestShowConversation(data.value);
          return;
        }
        if (aspect === 'action' && data.actionId === 'delete') {
          await this.requestDeleteConversation(data.value);
          return;
        }
        if (aspect === 'action' && data.actionId === 'rename') {
          await this.requestRenameConversation(data.value);
        }
        return;
      }

      // ChatManager roster events → refresh the list
      if (fromId === this.chatManagerId) {
        if (aspect === 'rosterChanged'
          || aspect === 'activityChanged'
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

    this.on('undo', async () => this.undoHere('undo'));
    this.on('redo', async () => this.undoHere('redo'));
    this.on('getUndoState', async (): Promise<UndoState> => {
      if (!this.chatManagerId) return { canUndo: false, canRedo: false };
      try {
        return await this.request<UndoState>(request(this.id, this.chatManagerId, 'getUndoState', {}), 5000);
      } catch {
        return { canUndo: false, canRedo: false };
      }
    });
  }

  /** Undo or redo this window's last change through ChatManager, then show the roster as it is now. */
  private async undoHere(action: UndoAction): Promise<UndoResult> {
    const result = await this.forwardUndo([this.chatManagerId], action);
    if (result.ok) this.scheduleRefresh();
    return result;
  }

  // ─── Dispatchers to ChatManager ────────────────────────────────────

  private async requestNewConversation(isPrivate = false): Promise<void> {
    if (!this.chatManagerId) return;
    try {
      await this.request(request(this.id, this.chatManagerId, 'newConversation', isPrivate ? { private: true } : {}), 5000);
    } catch (err) {
      log.warn(`newConversation failed: ${String(err)}`);
      this.playEffect('shake');
    }
  }

  private async requestShowConversation(conversationId: string): Promise<void> {
    if (!this.chatManagerId) return;
    try {
      await this.request(request(this.id, this.chatManagerId, 'showConversation', { conversationId }), 5000);
    } catch (err) {
      log.warn(`showConversation failed: ${String(err)}`);
      this.playEffect('shake');
    }
  }

  private async requestDeleteConversation(conversationId: string): Promise<void> {
    if (!this.chatManagerId) return;
    const title = this.titles.get(conversationId);
    try {
      // Generous: the conversation's cards are set aside with it.
      await this.request(request(this.id, this.chatManagerId, 'deleteConversation', { conversationId }), 60_000);
      // A toast is seen beyond this window: a private chat is named only as
      // one, and its undo lasts until a restart (it is kept in memory only).
      if (this.privateIds.has(conversationId)) {
        await this.notify('Deleted a private chat. Ctrl+Z undoes it until Abjects restarts', 'success');
      } else {
        await this.notify(`Deleted ${title ? `"${title}"` : 'the conversation'}. Ctrl+Z to undo`, 'success');
      }
    } catch (err) {
      log.warn(`deleteConversation failed: ${String(err)}`);
      this.playEffect('shake');
      await this.notify('Delete failed', 'error');
    }
  }

  /** Ask for a new name and rename the conversation (a private one is renamed only from its own window). */
  private async requestRenameConversation(conversationId: string): Promise<void> {
    if (!this.chatManagerId || this.privateIds.has(conversationId)) return;
    const current = this.titles.get(conversationId) ?? '';
    const title = await this.prompt({
      title: 'Rename chat',
      message: 'A new name for this chat.',
      defaultValue: current,
      confirmLabel: 'Rename',
    });
    if (title === null || !title.trim() || title.trim() === current) return;
    try {
      await this.request(request(this.id, this.chatManagerId, 'renameConversation', { conversationId, title: title.trim() }), 5000);
    } catch (err) {
      log.warn(`renameConversation failed: ${String(err)}`);
      this.playEffect('shake');
    }
  }

  /** Play a one-shot slab effect on the open overview window (visual only). */
  private playEffect(effect: string, color?: string): void {
    if (!this.windowId) return;
    try {
      this.playWindowEffect(this.windowId, effect, color);
    } catch { /* window gone */ }
  }

  // ─── Header ────────────────────────────────────────────────────────

  /** Header text: the chat count, plus how many are working. */
  private headerText(): string {
    const count = this.chatCount === 1 ? '1 chat' : `${this.chatCount} chats`;
    const working = this.workingCount || (this.anyChatWorking ? 1 : 0);
    return sectionHeaderText(this.theme, working > 0 ? `${count} \u00B7 ${working} working` : count);
  }

  /** Heading style at rest; the living light while a chat is working. */
  private headerStyle(): Record<string, unknown> {
    const base = { ...sectionHeaderStyle(this.theme, 14), align: 'left', wordWrap: false, selectable: false };
    return this.workingCount > 0 || this.anyChatWorking ? { ...base, color: livingStyle(this.theme).color } : base;
  }

  /** Tab labels with their counts. */
  private tabLabels(): string[] {
    const privateCount = this.rows.filter(r => r.private).length;
    return [`All ${this.rows.length}`, `Working ${this.workingCount}`, `Private ${privateCount}`];
  }

  /** The rows the selected tab shows. */
  private rowsInTab(): RosterRow[] {
    if (this.tab === 'working') return this.rows.filter(r => r.working);
    if (this.tab === 'private') return this.rows.filter(r => r.private);
    return this.rows;
  }

  /** Re-filter the list for the selected tab and refresh the tab counts (no refetch). */
  private async pushItems(): Promise<void> {
    if (this.tabBarId) {
      try {
        this.send(event(this.id, this.tabBarId, 'update', { tabs: this.tabLabels(), selectedIndex: TABS.indexOf(this.tab) }));
      } catch { /* widget gone */ }
    }
    if (!this.listWidgetId) return;
    try {
      await this.request(request(this.id, this.listWidgetId, 'update', { items: this.itemsInTab() }));
    } catch { /* list gone */ }
  }

  /** Push the header's text and style (on working-state flips). */
  private refreshHeader(): void {
    if (!this.headerLabelId) return;
    try {
      this.send(event(this.id, this.headerLabelId, 'update', { text: this.headerText(), style: this.headerStyle() }));
    } catch { /* widget gone */ }
  }

  /**
   * Fetch the roster. Returns the rows on success (possibly an empty array
   * for a genuinely empty roster), or `null` when the request failed or timed
   * out — callers keep the current list on null rather than blanking it. The
   * timeout is generous because ChatManager can be briefly busy under load,
   * and a slow reply must not be read as "no conversations".
   */
  private async fetchRoster(): Promise<RosterRow[] | null> {
    if (!this.chatManagerId) return null;
    try {
      const rows = await this.request<RosterRow[]>(
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
        title: 'Conversations',
        rect: { x: winX, y: winY, width: winW, height: winH },
        zIndex: 210,
        resizable: true,
      })
    );
    this.send(request(this.id, this.windowId, 'addDependent', {}));

    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 16, right: 16, bottom: 16, left: 16 },
        spacing: 8,
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
    this.newPrivateChatBtnId = undefined;
    this.tabBarId = undefined;
    this.headerLabelId = undefined;
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

  /** Run refreshes single-file until none is pending. Fetches BEFORE touching
   *  the window, so a timed-out/failed fetch keeps the current list instead of
   *  blanking it. */
  private async drainRefresh(): Promise<void> {
    if (this.refreshInFlight) return;
    this.refreshInFlight = true;
    try {
      while (this.refreshPending) {
        this.refreshPending = false;
        if (!this.windowId || !this.rootLayoutId) return;
        const rows = await this.fetchRoster();
        if (rows === null) continue; // keep current; re-loop if more arrived
        await this.takeRows(rows);

        // A list already on screen that stays a list is updated in place.
        // Rebuilding it put an empty list in the window while every
        // conversation's history loaded, a visible blink on each roster change,
        // and it threw away the search text and scroll position.
        if (this.listWidgetId && rows.length > 0) {
          this.refreshHeader();
          await this.pushItems();
          continue;
        }

        // Switching between the empty state and the list changes what the
        // window holds, so that is rebuilt.
        try {
          await this.request(request(this.id, this.rootLayoutId, 'clearLayoutChildren', {}));
        } catch { /* best effort */ }
        this.listWidgetId = undefined;
        this.newChatBtnId = undefined;
        this.newPrivateChatBtnId = undefined;
        this.tabBarId = undefined;
        this.headerLabelId = undefined;
        await this.populate(rows, true);
      }
    } finally {
      this.refreshInFlight = false;
    }
  }

  // ─── Rendering ─────────────────────────────────────────────────────

  /**
   * Lay out the window: the header row, then (with any chats) the tabs, the
   * list and the key hints, or the empty state. `taken` says the rows were
   * already taken in (takeRows) by the refresh that called this.
   */
  private async populate(rows: RosterRow[], taken = false): Promise<void> {
    if (!this.rootLayoutId || !this.windowId) return;
    // Rows first, so the list goes on screen already filled.
    if (!taken) await this.takeRows(rows);

    const headerRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: this.theme.tokens.space.md,
      })
    );

    const headerSpecs: Array<Record<string, unknown>> = [
      {
        type: 'label', windowId: this.windowId,
        text: this.headerText(),
        style: this.headerStyle(),
      },
      {
        type: 'button', windowId: this.windowId, text: 'Private',
        style: {
          background: this.theme.buttonBg,
          color: this.theme.buttonText,
          borderColor: this.theme.buttonBorder,
          fontSize: 13,
          icon: 'lock',
        },
      },
      {
        type: 'button', windowId: this.windowId, text: 'New chat',
        style: {
          background: this.theme.actionBg,
          color: this.theme.actionText,
          borderColor: this.theme.actionBorder,
          fontSize: 13,
          icon: 'plus',
        },
      },
    ];
    const { widgetIds: headerIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs: headerSpecs })
    );
    const titleLabelId = headerIds[0];
    this.headerLabelId = titleLabelId;
    this.newPrivateChatBtnId = headerIds[1];
    this.newChatBtnId = headerIds[2];

    await this.request(request(this.id, headerRowId, 'addLayoutChildren', {
      children: [
        { widgetId: titleLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: HEADER_BTN_H } },
        { widgetId: this.newPrivateChatBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 104, height: HEADER_BTN_H } },
        { widgetId: this.newChatBtnId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 120, height: HEADER_BTN_H } },
      ],
    }));
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: headerRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: HEADER_BTN_H },
    }));
    this.send(request(this.id, this.newChatBtnId, 'addDependent', {}));
    this.send(request(this.id, this.newPrivateChatBtnId, 'addDependent', {}));

    if (rows.length === 0) {
      await this.renderEmptyState();
      return;
    }

    // Tabs, then one rich ListWidget: rows grouped by when they were last
    // active, flat, with a marker, the title on up to two lines and the time
    // and status below. Rename and delete show on the selected or hovered row.
    const { widgetIds: [tabBarId, listId, footerId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'tabBar', windowId: this.windowId, tabs: this.tabLabels(), selectedIndex: TABS.indexOf(this.tab) },
          {
            type: 'list', windowId: this.windowId, items: this.itemsInTab(), searchable: true,
            searchPlaceholder: 'Search titles and messages',
            rowStyle: 'flat', actionsOn: 'active', maxTitleLines: 2,
            keyActions: { Delete: 'delete', F2: 'rename' },
          },
          {
            type: 'label', windowId: this.windowId, text: FOOTER_TEXT,
            style: { fontSize: 11, color: this.theme.textMeta, align: 'left', wordWrap: false, selectable: false },
          },
        ],
      })
    );
    this.tabBarId = tabBarId;
    this.listWidgetId = listId;

    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: tabBarId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: TAB_BAR_H } },
        { widgetId: listId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: footerId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: FOOTER_H } },
      ],
    }));
    this.send(request(this.id, this.tabBarId, 'addDependent', {}));
    this.send(request(this.id, this.listWidgetId, 'addDependent', {}));
  }

  /**
   * Take a fetched roster in: the counts, titles and private ids, and each
   * regular chat's message text for search. A chat's text is read again only
   * when it has been active since it was read, and a private chat's never is.
   */
  private async takeRows(rows: RosterRow[]): Promise<void> {
    this.rows = rows;
    this.chatCount = rows.length;
    this.workingCount = rows.filter(r => r.working).length;
    this.titles = new Map(rows.map(c => [c.conversationId, c.title]));
    this.privateIds = new Set(rows.filter(c => c.private).map(c => c.conversationId));
    const listed = new Set(rows.map(c => c.conversationId));
    for (const id of this.historyText.keys()) if (!listed.has(id)) this.historyText.delete(id);
    await Promise.all(rows.map(async (c) => {
      if (c.private || this.historyText.get(c.conversationId)?.at === c.lastActiveAt) return;
      const text = await this.fetchConversationHistory(c.conversationId);
      this.historyText.set(c.conversationId, { at: c.lastActiveAt, text });
    }));
  }

  /** The list's rows for the selected tab, or one quiet line when the tab has none. */
  private itemsInTab(): ListItem[] {
    const rows = this.rowsInTab();
    if (rows.length === 0) {
      const label = this.tab === 'working' ? 'No chat is working right now' : 'No private chats';
      return [{ label, value: '' }];
    }
    const now = Date.now();
    return rows.map(c => this.toListItem(c, now));
  }

  private async fetchConversationHistory(conversationId: string): Promise<string> {
    if (!this.chatManagerId) return '';
    try {
      const entries = await this.request<unknown[] | null>(
        request(this.id, this.chatManagerId, 'getHistory', { conversationId }),
        5000,
      );
      if (!Array.isArray(entries)) return '';
      const textParts: string[] = [];
      for (const entry of entries) {
        if (typeof entry === 'string') {
          textParts.push(entry);
        } else if (entry && typeof entry === 'object' && 'content' in entry) {
          const content = (entry as { content?: unknown }).content;
          if (typeof content === 'string' && content.trim()) {
            textParts.push(content.trim());
          }
        }
      }
      return textParts.join(' ');
    } catch (err) {
      log.warn(`fetchConversationHistory failed for ${conversationId.slice(0, 8)}: ${String(err)}`);
      return '';
    }
  }

  /**
   * One row: a marker (working, private, or a quiet dot), the title, when it
   * was last active, and its status. The message text rides as `secondary`,
   * which the list searches but does not show. A private chat gets no rename:
   * its title changes only from its own window.
   */
  private toListItem(c: RosterRow, now: number): ListItem {
    const marker = c.working
      ? { iconName: 'dot' as const, iconColor: this.theme.accentSecondary }
      : c.private
        ? { iconName: 'lock' as const, iconColor: this.theme.accentTertiary }
        : { iconName: 'dot' as const, iconColor: this.theme.textTertiary };
    const note = c.working
      ? { text: 'Working on a goal', color: this.theme.accentSecondary }
      : c.private
        ? { text: 'Private, not remembered', color: this.theme.accentTertiary }
        : undefined;
    const rename = { id: 'rename', label: 'Rename', iconName: 'pencil' as const };
    const remove = {
      id: 'delete', label: 'Delete', iconName: 'trash' as const,
      textColor: this.theme.destructiveText, borderColor: this.theme.destructiveBorder,
    };
    const searchText = c.private ? undefined : this.historyText.get(c.conversationId)?.text;
    return {
      label: c.title,
      value: c.conversationId,
      section: sectionOf(c.lastActiveAt, now),
      detail: formatRelativeTime(c.lastActiveAt),
      ...(note ? { note } : {}),
      ...marker,
      secondary: searchText || undefined,
      actions: c.private ? [remove] : [rename, remove],
    };
  }

  private async renderEmptyState(): Promise<void> {
    if (!this.rootLayoutId || !this.windowId) return;
    const text = emptyStateMarkdown(
      'Start a conversation',
      'Ask for anything with **New chat**. A **Private** chat keeps nothing: no memory, no learning, and its goals are deleted when they finish.',
    );
    const { widgetIds: [cardId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{
          type: 'markdown', windowId: this.windowId, text,
          style: { ...emptyStateStyle(this.theme), selectable: false },
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

/** Parse a ListWidget event payload (`selectionChanged`/`confirm`/`action`) into fields. */
function parseItemValue(value: unknown): { value?: string; actionId?: string; via?: string } | undefined {
  try {
    if (typeof value === 'string') return JSON.parse(value);
    if (value && typeof value === 'object') return value as { value?: string; actionId?: string; via?: string };
  } catch { /* malformed */ }
  return undefined;
}

/** The group a chat falls in by when it was last active: Today, Yesterday, This week, Earlier. */
function sectionOf(ts: number, now: number): string {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (ts >= today) return 'Today';
  if (ts >= today - day) return 'Yesterday';
  if (ts >= today - 6 * day) return 'This week';
  return 'Earlier';
}

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return d === 1 ? '1 day ago' : `${d} days ago`;
  return new Date(ts).toLocaleDateString();
}

export const CHAT_BROWSER_ID = 'abjects:chat-browser' as AbjectId;
