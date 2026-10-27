/**
 * ChatManager — per-workspace infra Abject for multiple Chat conversations.
 *
 * Owns the conversation roster (persisted to workspace Storage) and the
 * Chat Abject lifecycle (spawn, kill, rename). Pure logic; no windows or
 * widgets. See `ChatBrowser` for the UI surface.
 *
 * A conversation can be opened without a window (`openConversation`, what a
 * terminal does) or shown in one (`showConversation`, on a desktop). Chat is
 * the conversation either way; its window is a separate view it spawns.
 *
 * Deleting a conversation sets it aside: its roster row, transcript and
 * active-goal marker are kept on disk for the session and three days, and
 * its cards folder is set aside by AbjectStore. `undo` (from whoever deleted
 * it) puts all of it back; the Chat itself respawns when next opened.
 */

import { v4 as uuidv4 } from 'uuid';
import { AbjectId, AbjectMessage, InterfaceId, TypeId, SpawnResult } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { captureConversation, type ContextMessage } from '../core/conversation-context.js';
import { describeMessages, protocolText } from '../core/protocol-description.js';
import { Log } from '../core/timed-log.js';
import { invariant, require as precondition } from '../core/contracts.js';
import { UndoHistories, UndoRefused, UNDO_EVENTS, undoMethods, type UndoAction, type UndoHistoryJSON, type UndoState, type UndoStep } from '../core/undo.js';

const log = new Log('ChatManager');

const CHAT_MANAGER_INTERFACE: InterfaceId = 'abjects:chat-manager';

const ROSTER_KEY = 'chats:roster';
const DEFAULT_TITLE = 'New chat';
const historyKey = (conversationId: string) => `chats:history:${conversationId}`;
const activeGoalKey = (conversationId: string) => `chats:activegoal:${conversationId}`;
/** The AbjectStore folder a conversation's cards live in. */
const cardsFolder = (conversationId: string) => `chats/${conversationId.toLowerCase()}`;
/** Deleted conversations, kept a while so undo can bring them back. */
const TRASH_INDEX_KEY = 'chats:trash-index';
const trashKey = (id: string) => `chats:trash:${id}`;
/** Each caller's deletions, kept on disk with the trash they point into. */
const UNDO_KEY = 'chats:undo';

interface Rect { x: number; y: number; width: number; height: number }

export interface PersistedConversation {
  conversationId: string;
  typeId?: string;
  title: string;
  rect?: Rect;
  createdAt: number;
  lastActiveAt: number;
}

interface ConversationRuntime extends PersistedConversation {
  chatId?: AbjectId;
}

/** A deleted conversation, as the trash index lists it. */
interface ChatTrashItem {
  id: string;
  conversationId: string;
  title: string;
  removedAt: number;
  bytes: number;
}

/** What a deleted conversation leaves behind, kept whole for undo. */
interface ChatTrashRecord {
  conversation: PersistedConversation;
  history?: unknown[];
  activeGoal?: string;
  /** AbjectStore trash ids of its cards, set aside with the folder. */
  cards?: string[];
}

/**
 * One undoable change to the roster. A deletion points into the trash while
 * it is done (`trashId`) and loses the pointer once undone; renames stay in
 * memory.
 */
type ChatStep =
  | { kind: 'delete'; conversationId: string; trashId?: string }
  | { kind: 'rename'; conversationId: string; before: string; after: string };

export class ChatManager extends Abject {
  private registryId?: AbjectId;
  private factoryId?: AbjectId;
  private storageId?: AbjectId;
  private widgetManagerId?: AbjectId;

  private peerId?: string;
  private workspaceId?: string;

  private conversations: Map<string, ConversationRuntime> = new Map();

  /**
   * Chat Abjects currently working on a goal. The outgoing `goalActivity`
   * aspect is the union over every chat, so one conversation going idle
   * cannot clear the indicator while another is still busy.
   */
  private busyChats: Set<AbjectId> = new Set();
  private lastGoalActivity?: boolean;

  private persistTimer?: ReturnType<typeof setTimeout>;

  /** Deleted conversations kept for undo, by trash id. */
  private trash: Map<string, ChatTrashItem> = new Map();
  /** Each caller's undoable roster changes (by its durable typeId). */
  private undo = new UndoHistories<ChatStep>({ mergeMs: 0, maxSteps: 50 });
  private undoPersistTimer?: ReturnType<typeof setTimeout>;
  private readonly sessionStartedAt = Date.now();
  static readonly TRASH_KEEP_MS = 3 * 24 * 60 * 60_000;
  private static readonly TRASH_MAX_ITEMS = 50;
  private static readonly TRASH_MAX_BYTES = 32 * 1024 * 1024;

  constructor() {
    super({
      manifest: {
        name: 'ChatManager',
        description:
          'Per-workspace roster of Chat conversations. Owns conversation ' +
          'lifecycle (spawn, persist, rename, delete) and exposes methods + ' +
          'events for UI surfaces like ChatBrowser to drive. No windows.',
        version: '1.0.0',
        interface: {
          id: CHAT_MANAGER_INTERFACE,
          name: 'ChatManager',
          description: 'Conversation roster and lifecycle',
          methods: [
            {
              name: 'getState',
              description: 'Return roster size and the most-recently-active conversation id.',
              parameters: [],
              returns: { kind: 'object', properties: {
                conversationCount: { kind: 'primitive', primitive: 'number' },
                latestConversationId: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'listConversations',
              description: 'Return the current conversation roster, sorted by lastActiveAt descending.',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'PersistedConversation' } },
            },
            {
              name: 'newConversation',
              description: 'Create a new conversation and return its ids. Opens its window on a desktop unless show is false.',
              parameters: [
                { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: 'Optional starting title', optional: true },
                { name: 'show', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Open its window (default true; ignored without a display)', optional: true },
              ],
              returns: { kind: 'object', properties: {
                conversationId: { kind: 'primitive', primitive: 'string' },
                chatId: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'showConversation',
              description: 'Open or raise the window for an existing conversation. Returns the conversation and Chat ids, or false if the conversation is unknown.',
              parameters: [
                { name: 'conversationId', type: { kind: 'primitive', primitive: 'string' }, description: 'Conversation id' },
              ],
              returns: { kind: 'object', properties: {
                conversationId: { kind: 'primitive', primitive: 'string' },
                chatId: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'openConversation',
              description: 'Load an existing conversation so it can be talked to, without opening a window. Returns the conversation and Chat ids, or false if the conversation is unknown.',
              parameters: [
                { name: 'conversationId', type: { kind: 'primitive', primitive: 'string' }, description: 'Conversation id' },
              ],
              returns: { kind: 'object', properties: {
                conversationId: { kind: 'primitive', primitive: 'string' },
                chatId: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'getHistory',
              description: 'Return the persisted transcript of a conversation without opening it.',
              parameters: [
                { name: 'conversationId', type: { kind: 'primitive', primitive: 'string' }, description: 'Conversation id' },
              ],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'ConversationEntry' } },
            },
            {
              name: 'getActiveGoal',
              description: 'Return the goal id a conversation is currently running, or null.',
              parameters: [
                { name: 'conversationId', type: { kind: 'primitive', primitive: 'string' }, description: 'Conversation id' },
              ],
              returns: { kind: 'primitive', primitive: 'string' },
            },
            {
              name: 'showLatest',
              description: 'Raise the most-recently-active conversation window; no-op if the roster is empty.',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'deleteConversation',
              description: 'Remove a conversation, close its window, and set its history and cards aside. `undo` (from whoever deleted it) brings it back within the session and three days; a goal it started keeps running either way.',
              parameters: [
                { name: 'conversationId', type: { kind: 'primitive', primitive: 'string' }, description: 'Conversation id' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'renameConversation',
              description: 'Update the title of a conversation. `undo` from the same caller puts the old title back.',
              parameters: [
                { name: 'conversationId', type: { kind: 'primitive', primitive: 'string' }, description: 'Conversation id' },
                { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: 'New title' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            ...undoMethods('your last deletion or rename of a conversation'),
          ],
          events: [
            ...UNDO_EVENTS,
            {
              name: 'conversationCreated',
              description: 'Fires when a new conversation is added to the roster.',
              payload: { kind: 'object', properties: {
                conversationId: { kind: 'primitive', primitive: 'string' },
                title: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'conversationDeleted',
              description: 'Fires when a conversation is removed from the roster.',
              payload: { kind: 'object', properties: {
                conversationId: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'conversationOpened',
              description: 'Fires when a conversation window is shown (newly created or reopened). Lets attached clients mirror the set of open chats live.',
              payload: { kind: 'object', properties: {
                conversationId: { kind: 'primitive', primitive: 'string' },
                title: { kind: 'primitive', primitive: 'string' },
                chatId: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'conversationRenamed',
              description: 'Fires when a conversation title changes.',
              payload: { kind: 'object', properties: {
                conversationId: { kind: 'primitive', primitive: 'string' },
                title: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'rosterChanged',
              description: 'Fires whenever the roster changes for any reason (create/rename/delete/lastActive bump/rect move). UI surfaces use this as a catch-all signal to refresh their view.',
              payload: { kind: 'object', properties: {} },
            },
          ],
        },
        tags: ['system'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.registryId = await this.requireDep('Registry');
    this.factoryId = await this.requireDep('Factory');
    this.storageId = await this.discoverDep('Storage') ?? undefined;
    this.widgetManagerId = await this.discoverDep('WidgetManager') ?? undefined;

    await this.ensurePeerId();
    await this.ensureWorkspaceId();
    await this.loadRoster();
    await this.loadTrash();

    // Lazy rehydration: we do NOT spawn a Chat Abject for every saved
    // conversation at boot. Each conversation's Chat is spawned on demand when
    // the user opens it (openChatWindow spawns if absent). Eagerly spawning all
    // of them made every conversation a live GoalManager subscriber, so a
    // single running goal's progress events were delivered to dozens of idle
    // chats at once — amplifying bus traffic and starving rendering. The roster
    // metadata above is enough to list conversations; the Chat itself waits.
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    for (const c of this.conversations.values()) {
      invariant(typeof c.conversationId === 'string' && c.conversationId.length > 0, 'ChatManager: a conversation without an id');
    }
    for (const t of this.trash.values()) {
      invariant(!this.conversations.has(t.conversationId), 'ChatManager: a conversation both on the roster and in the trash');
    }
  }

  protected override async onStop(): Promise<void> {
    // Undo histories are written on a short debounce; write the last one now.
    if (this.undoPersistTimer && this.storageId) {
      clearTimeout(this.undoPersistTimer);
      this.undoPersistTimer = undefined;
      try {
        this.send(request(this.id, this.storageId, 'set', { key: UNDO_KEY, value: this.savedUndo() }));
      } catch { /* storage gone */ }
    }
  }

  private setupHandlers(): void {
    describeMessages(this.manifest, [{ name: 'getConversationContext', description: 'Read a saved conversation through a specific message, including source goal references. Does not open its window.', parameters: { conversationId: protocolText, throughMessageId: protocolText } }]);
    this.on('getConversationContext', async msg => {
      const { conversationId, throughMessageId } = msg.payload as { conversationId: string; throughMessageId: string };
      if (!this.storageId || !this.conversations.has(conversationId)) throw new Error('Conversation unavailable');
      if (!throughMessageId) throw new Error('A conversation boundary is required');
      const entries = await this.request<ContextMessage[] | null>(request(this.id, this.storageId, 'get', { key: `chats:history:${conversationId}` }));
      if (!Array.isArray(entries)) throw new Error('Conversation history unavailable');
      return captureConversation(conversationId, entries, throughMessageId);
    });
    this.on('getState', async () => ({
      conversationCount: this.conversations.size,
      latestConversationId: this.latestConversation()?.conversationId ?? '',
    }));

    this.on('listConversations', async () => {
      return Array.from(this.conversations.values())
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .map(c => ({
          conversationId: c.conversationId,
          typeId: c.typeId,
          title: c.title,
          rect: c.rect,
          createdAt: c.createdAt,
          lastActiveAt: c.lastActiveAt,
          // Runtime id of the spawned Chat (absent while the conversation is
          // dormant) so gateways can attach to live chats without re-showing.
          chatId: c.chatId,
        }));
    });

    this.on('newConversation', async (msg: AbjectMessage) => {
      const payload = (msg.payload ?? {}) as { title?: string; show?: boolean };
      return this.createConversation(payload.title, payload.show !== false);
    });

    this.on('openConversation', async (msg: AbjectMessage) => {
      const { conversationId } = msg.payload as { conversationId: string };
      const c = this.conversations.get(conversationId);
      if (!c) return false;
      const chatId = c.chatId ?? await this.spawnChatFor(c);
      if (!chatId) return false;
      return { conversationId, chatId };
    });

    this.on('showConversation', async (msg: AbjectMessage) => {
      const { conversationId } = msg.payload as { conversationId: string };
      const opened = await this.openChatWindow(conversationId);
      if (!opened) return false;
      const c = this.conversations.get(conversationId);
      return { conversationId, chatId: c?.chatId ?? '' };
    });

    this.on('getHistory', async (msg: AbjectMessage) => {
      const { conversationId } = msg.payload as { conversationId: string };
      if (!this.storageId || !this.conversations.has(conversationId)) return [];
      try {
        const entries = await this.request<unknown[] | null>(
          request(this.id, this.storageId, 'get', { key: `chats:history:${conversationId}` })
        );
        return Array.isArray(entries) ? entries : [];
      } catch (err) {
        log.warn(`getHistory failed for ${conversationId.slice(0, 8)}: ${String(err)}`);
        return [];
      }
    });

    this.on('getActiveGoal', async (msg: AbjectMessage) => {
      const { conversationId } = msg.payload as { conversationId: string };
      if (!this.storageId || !this.conversations.has(conversationId)) return null;
      try {
        const goalId = await this.request<string | null>(
          request(this.id, this.storageId, 'get', { key: `chats:activegoal:${conversationId}` })
        );
        return typeof goalId === 'string' && goalId ? goalId : null;
      } catch {
        return null;
      }
    });

    this.on('showLatest', async () => {
      const latest = this.latestConversation();
      if (!latest) return false;
      return this.openChatWindow(latest.conversationId);
    });

    this.on('deleteConversation', async (msg: AbjectMessage) => {
      const { conversationId } = msg.payload as { conversationId: string };
      const c = this.conversations.get(conversationId);
      if (!c) return false;
      const title = c.title;
      const trashId = await this.removeConversation(conversationId);
      await this.recordStep(msg.routing.from, `Delete chat ${title}`, { kind: 'delete', conversationId, trashId });
      return true;
    });

    this.on('renameConversation', async (msg: AbjectMessage) => {
      const { conversationId, title } = msg.payload as { conversationId: string; title: string };
      const before = this.conversations.get(conversationId)?.title;
      const renamed = await this.applyRename(conversationId, title, /* fromChat */ false);
      const after = this.conversations.get(conversationId)?.title;
      if (renamed && before !== undefined && after !== undefined) {
        await this.recordStep(msg.routing.from, 'Rename chat', { kind: 'rename', conversationId, before, after });
      }
      return renamed;
    });

    this.on('undo', async (msg: AbjectMessage) => this.undoFor(msg.routing.from, 'undo'));
    this.on('redo', async (msg: AbjectMessage) => this.undoFor(msg.routing.from, 'redo'));
    this.on('getUndoState', async (msg: AbjectMessage) => this.undo.state(await this.undoCallerKey(msg.routing.from)));

    // Events from child Chat Abjects
    this.on('titleChanged', async (msg: AbjectMessage) => {
      const { conversationId, title } = msg.payload as { conversationId: string; title: string };
      if (!conversationId || typeof title !== 'string') return;
      await this.applyRename(conversationId, title, /* fromChat */ true);
    });

    this.on('rectChanged', async (msg: AbjectMessage) => {
      const { conversationId, rect } = msg.payload as { conversationId: string; rect: Rect };
      const c = this.conversations.get(conversationId);
      if (!c || !rect) return;
      // Where a chat window sits is kept so it reopens there, and that is all.
      // It is not roster news: no row in the overview shows it, and moving a
      // window is not talking in it. Announcing it rebuilt the overview list
      // four times a second while a chat window was dragged, and stamped an
      // idle chat "just now" so it jumped to the top.
      c.rect = rect;
      this.schedulePersist();
    });

    // Events from child Chat Abjects.
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;
      // goalActivity from a child Chat (a turn is running or a goal this
      // conversation owns is active) → fold into the per-chat busy set and
      // re-emit the aggregate on transitions so UI surfaces (ChatBrowser →
      // taskbar) can mark the chat icon.
      if (aspect === 'goalActivity') {
        const active = !!(value as { active?: boolean } | undefined)?.active;
        if (active) this.busyChats.add(fromId); else this.busyChats.delete(fromId);
        this.emitGoalActivity();
        return;
      }
      // `messageAdded` → bump that conversation's lastActiveAt
      if (aspect !== 'messageAdded') return;
      for (const c of this.conversations.values()) {
        if (c.chatId === fromId) {
          c.lastActiveAt = Date.now();
          this.schedulePersist();
          this.changed('rosterChanged', {});
          return;
        }
      }
    });
  }

  // ─── Identity / workspace resolution ────────────────────────────────

  private async ensurePeerId(): Promise<string | undefined> {
    if (this.peerId) return this.peerId;
    try {
      const identityId = await this.discoverDep('Identity');
      if (identityId) {
        const identity = await this.request<{ peerId: string }>(
          request(this.id, identityId, 'getIdentity', {})
        );
        this.peerId = identity.peerId;
      }
    } catch { /* Identity may not be ready */ }
    return this.peerId;
  }

  /** Our workspace id, from the workspace registry we were spawned into. */
  private async ensureWorkspaceId(): Promise<string | undefined> {
    if (this.workspaceId) return this.workspaceId;
    if (!this.registryId) return undefined;
    try {
      const ws = await this.request<string | null>(request(this.id, this.registryId, 'getWorkspaceId', {}));
      this.workspaceId = ws ?? undefined;
    } catch { /* not in a workspace */ }
    return this.workspaceId;
  }

  private computeTypeId(conversationId: string): TypeId | undefined {
    if (!this.peerId || !this.workspaceId) return undefined;
    return `${this.peerId}/${this.workspaceId}/chat/${conversationId}` as TypeId;
  }

  // ─── Roster persistence ─────────────────────────────────────────────

  private async loadRoster(): Promise<void> {
    if (!this.storageId) return;
    try {
      const stored = await this.request<PersistedConversation[] | null>(
        request(this.id, this.storageId, 'get', { key: ROSTER_KEY })
      );
      if (Array.isArray(stored)) {
        for (const c of stored) {
          this.conversations.set(c.conversationId, { ...c });
        }
        log.info(`Loaded ${this.conversations.size} conversations from roster`);
      }
    } catch (err) {
      log.warn(`Failed to load roster: ${String(err)}`);
    }
  }

  private schedulePersist(): void {
    if (!this.storageId) return;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persistRoster();
    }, 150);
  }

  private async persistRoster(): Promise<void> {
    if (!this.storageId) return;
    const rows: PersistedConversation[] = Array.from(this.conversations.values()).map(c => this.persisted(c));
    try {
      await this.request(request(this.id, this.storageId, 'set', {
        key: ROSTER_KEY, value: rows,
      }));
    } catch (err) {
      log.warn(`Failed to persist roster: ${String(err)}`);
    }
  }

  // ─── Chat instance lifecycle ───────────────────────────────────────

  private async spawnChatFor(c: ConversationRuntime): Promise<AbjectId | undefined> {
    if (c.chatId) return c.chatId;
    if (!this.factoryId || !this.registryId) return undefined;

    await this.ensurePeerId();
    await this.ensureWorkspaceId();

    const typeId = c.typeId as TypeId | undefined ?? this.computeTypeId(c.conversationId);
    if (typeId && !c.typeId) c.typeId = typeId;

    try {
      const result = await this.request<SpawnResult>(
        request(this.id, this.factoryId, 'spawn', {
          manifest: {
            name: 'Chat', description: '', version: '1.0.0',
            tags: ['system', 'agent'],
          },
          registryHint: this.registryId,
          typeId,
          constructorArgs: {
            conversationId: c.conversationId,
            title: c.title,
            rect: c.rect,
          },
        })
      );
      c.chatId = result.objectId;
      this.send(request(this.id, c.chatId, 'addDependent', {}));
      if (this.widgetManagerId && this.workspaceId) {
        try {
          await this.request(request(this.id, this.widgetManagerId, 'setObjectWorkspace', {
            objectId: c.chatId, workspaceId: this.workspaceId,
          }));
        } catch { /* best effort */ }
      }
      return c.chatId;
    } catch (err) {
      log.warn(`Failed to spawn Chat for conversation ${c.conversationId.slice(0, 8)}: ${String(err)}`);
      return undefined;
    }
  }

  // ─── Conversation operations ───────────────────────────────────────

  private async createConversation(title: string | undefined, show: boolean): Promise<{ conversationId: string; chatId: AbjectId }> {
    await this.ensurePeerId();
    await this.ensureWorkspaceId();
    const conversationId = uuidv4();
    const now = Date.now();
    const c: ConversationRuntime = {
      conversationId,
      typeId: this.computeTypeId(conversationId),
      title: (title?.trim() || DEFAULT_TITLE),
      rect: this.stagger(),
      createdAt: now,
      lastActiveAt: now,
    };

    // A conversation joins the roster only once its Chat is running: a failed
    // spawn used to leave a "New chat" row behind that nothing could open.
    const chatId = await this.spawnChatFor(c);
    if (!chatId) throw new Error('Failed to create conversation: its Chat could not start');
    this.conversations.set(conversationId, c);
    await this.persistRoster();

    this.changed('conversationCreated', { conversationId, title: c.title });
    this.changed('rosterChanged', {});

    // A window only where there is a display: show reports false otherwise.
    if (show) {
      try {
        const shown = await this.request<boolean>(request(this.id, chatId, 'show', {}), 20000);
        if (shown) this.changed('conversationOpened', { conversationId, title: c.title, chatId });
      } catch { /* best effort */ }
    }

    this.checkInvariants();
    return { conversationId, chatId };
  }

  private async openChatWindow(conversationId: string): Promise<boolean> {
    const c = this.conversations.get(conversationId);
    if (!c) return false;
    let chatId = c.chatId;
    if (!chatId) chatId = await this.spawnChatFor(c);
    if (!chatId) return false;
    c.lastActiveAt = Date.now();
    this.schedulePersist();
    this.changed('rosterChanged', {});
    try {
      const shown = await this.request<boolean>(request(this.id, chatId, 'show', {}), 20000);
      if (shown) this.changed('conversationOpened', { conversationId, title: c.title, chatId });
      return shown === true;
    } catch {
      return false;
    }
  }

  /** Emit the aggregate `goalActivity` aspect when it flips. */
  private emitGoalActivity(): void {
    const active = this.busyChats.size > 0;
    if (this.lastGoalActivity === active) return;
    this.lastGoalActivity = active;
    this.changed('goalActivity', { active });
  }

  /**
   * Delete a conversation: its Chat stops, and its transcript, active-goal
   * marker, roster row and cards are set aside. Returns the trash id that
   * undo brings it back from. A goal it started is left running.
   */
  private async removeConversation(conversationId: string): Promise<string> {
    const c = this.conversations.get(conversationId);
    precondition(c !== undefined, `removeConversation: no conversation '${conversationId}'`);

    // Hide the Chat window, then kill the Abject
    if (c!.chatId) {
      try { await this.request(request(this.id, c!.chatId, 'hide', {}), 3000); } catch { /* best effort */ }
      if (this.factoryId) {
        try { await this.request(request(this.id, this.factoryId, 'kill', { objectId: c!.chatId }), 3000); } catch { /* best effort */ }
      }
    }

    // What the conversation said, and the goal it was following, kept for undo.
    const history = await this.storageGet(historyKey(conversationId));
    const activeGoal = await this.storageGet(activeGoalKey(conversationId));

    // The conversation's cards are objects in its folder; they go with it,
    // set aside by AbjectStore.
    const cards = await this.removeCards(conversationId);

    const trashId = await this.setAside({
      conversation: this.persisted(c!),
      ...(Array.isArray(history) ? { history } : {}),
      ...(typeof activeGoal === 'string' && activeGoal ? { activeGoal } : {}),
      ...(cards.length > 0 ? { cards } : {}),
    });

    // Delete persisted history and any reconnect marker
    if (this.storageId) {
      try {
        await this.request(request(this.id, this.storageId, 'delete', { key: historyKey(conversationId) }));
      } catch { /* best effort */ }
      try {
        await this.request(request(this.id, this.storageId, 'delete', { key: activeGoalKey(conversationId) }));
      } catch { /* best effort */ }
    }

    if (c!.chatId) {
      this.busyChats.delete(c!.chatId);
      this.emitGoalActivity();
    }
    this.conversations.delete(conversationId);
    await this.persistRoster();
    this.changed('conversationDeleted', { conversationId });
    this.changed('rosterChanged', {});
    return trashId;
  }

  /** Remove a conversation's cards folder; the AbjectStore trash ids of what it set aside. */
  private async removeCards(conversationId: string): Promise<string[]> {
    const storeId = await this.discoverDep('AbjectStore');
    if (!storeId) return [];
    const folder = cardsFolder(conversationId);
    const startedAt = Date.now();
    let typeIds: string[] = [];
    try {
      const listed = await this.request<Array<{ typeId: string }>>(request(this.id, storeId, 'list', { folder }), 10_000);
      typeIds = listed.map(e => e.typeId);
    } catch { /* best effort */ }
    if (typeIds.length === 0) return [];
    let removed = 0;
    try {
      const result = await this.request<{ removed?: number }>(request(this.id, storeId, 'removeFolder', { folder }), 30_000);
      removed = result?.removed ?? 0;
    } catch { /* best effort */ }
    if (removed === 0) return [];
    try {
      const kept = await this.request<Array<{ id: string; typeId: string; removedAt: number }>>(
        request(this.id, storeId, 'listRemoved', {}), 10_000);
      return kept.filter(k => typeIds.includes(k.typeId) && k.removedAt >= startedAt).map(k => k.id);
    } catch {
      return [];
    }
  }

  /**
   * Bring a conversation's cards back. AbjectStore's own undo when its next
   * step for us is this folder's removal (it keeps AbjectStore's history in
   * step); otherwise each set-aside card by its trash id, so deletions undone
   * out of order still find their cards.
   */
  private async restoreCards(conversationId: string, cards: string[] | undefined): Promise<void> {
    if (!cards || cards.length === 0) return;
    const storeId = await this.discoverDep('AbjectStore');
    if (!storeId) return;
    try {
      const state = await this.request<UndoState>(request(this.id, storeId, 'getUndoState', {}), 5000);
      if (state.canUndo && state.undoLabel === `Delete folder ${cardsFolder(conversationId)}`) {
        const undone = await this.request<{ ok: boolean }>(request(this.id, storeId, 'undo', {}), 60_000);
        if (undone?.ok) return;
      }
    } catch { /* fall back to the trash ids */ }
    for (const id of cards) {
      try {
        await this.request(request(this.id, storeId, 'restoreRemoved', { id }), 30_000);
      } catch (err) {
        log.warn(`Could not bring back a card of ${conversationId.slice(0, 8)}: ${String(err)}`);
      }
    }
  }

  /** Put a deleted conversation back from the trash: transcript, goal marker, cards, roster row. */
  private async restoreConversation(trashId: string, conversationId: string): Promise<void> {
    if (this.conversations.has(conversationId)) throw new UndoRefused('That chat is back already');
    const item = this.trash.get(trashId);
    if (!item) throw new UndoRefused('The deleted chat is no longer kept');
    const record = await this.storageGet(trashKey(trashId)) as ChatTrashRecord | null;
    if (!record?.conversation?.conversationId) {
      this.trash.delete(trashId);
      await this.persistTrashIndex();
      throw new UndoRefused(`'${item.title}' is no longer kept`);
    }
    if (record.history) await this.storageSet(historyKey(conversationId), record.history);
    if (record.activeGoal) await this.storageSet(activeGoalKey(conversationId), record.activeGoal);
    await this.restoreCards(conversationId, record.cards);

    // Back on the roster without a Chat: it respawns when next opened.
    this.conversations.set(conversationId, { ...record.conversation });
    await this.persistRoster();
    this.trash.delete(trashId);
    await this.persistTrashIndex();
    await this.storageDelete(trashKey(trashId));
    this.changed('conversationCreated', { conversationId, title: record.conversation.title });
    this.changed('rosterChanged', {});
    this.checkInvariants();
  }

  private persisted(c: ConversationRuntime): PersistedConversation {
    return {
      conversationId: c.conversationId,
      typeId: c.typeId,
      title: c.title,
      rect: c.rect,
      createdAt: c.createdAt,
      lastActiveAt: c.lastActiveAt,
    };
  }

  private async applyRename(conversationId: string, title: string, fromChat: boolean): Promise<boolean> {
    const c = this.conversations.get(conversationId);
    if (!c) return false;
    const trimmed = (title ?? '').trim().slice(0, 80);
    if (!trimmed || trimmed === c.title) return false;
    c.title = trimmed;
    c.lastActiveAt = Date.now();
    this.schedulePersist();
    if (!fromChat && c.chatId) {
      // Propagate to the Chat Abject so its window title updates live
      try {
        await this.request(request(this.id, c.chatId, 'setTitle', { title: trimmed }), 3000);
      } catch { /* best effort */ }
    }
    this.changed('conversationRenamed', { conversationId, title: trimmed });
    this.changed('rosterChanged', {});
    return true;
  }

  // ─── Deleted conversations, kept for undo ──────────────────────────

  /**
   * Keep a deleted conversation's record under a new trash id, for the
   * session and at least TRASH_KEEP_MS, within the count and size limits.
   */
  private async setAside(record: ChatTrashRecord): Promise<string> {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const bytes = JSON.stringify(record).length;
    await this.storageSet(trashKey(id), record);
    this.trash.set(id, {
      id,
      conversationId: record.conversation.conversationId,
      title: record.conversation.title,
      removedAt: Date.now(),
      bytes,
    });
    await this.persistTrashIndex();
    await this.purgeTrash();
    return id;
  }

  private async loadTrash(): Promise<void> {
    if (!this.storageId) return;
    const index = await this.storageGet(TRASH_INDEX_KEY);
    if (Array.isArray(index)) {
      for (const item of index as ChatTrashItem[]) {
        // A conversation on the roster is not also deleted (a crash between writes).
        if (item?.id && item.conversationId && !this.conversations.has(item.conversationId)) this.trash.set(item.id, item);
      }
    }
    this.undo.load(await this.storageGet(UNDO_KEY) as Record<string, UndoHistoryJSON<ChatStep>> | null);
    await this.purgeTrash();
  }

  private async persistTrashIndex(): Promise<void> {
    await this.storageSet(TRASH_INDEX_KEY, [...this.trash.values()]);
  }

  /**
   * Forget deleted conversations past keeping: deleted before this session
   * and longer ago than TRASH_KEEP_MS, or beyond the count and size limits
   * (oldest first). Undo steps that pointed at them go too.
   */
  private async purgeTrash(): Promise<void> {
    const now = Date.now();
    const items = [...this.trash.values()].sort((a, b) => a.removedAt - b.removedAt);
    const expired = new Set(items
      .filter(t => t.removedAt < this.sessionStartedAt && now - t.removedAt > ChatManager.TRASH_KEEP_MS)
      .map(t => t.id));
    let count = items.length - expired.size;
    let bytes = items.filter(t => !expired.has(t.id)).reduce((n, t) => n + t.bytes, 0);
    for (const t of items) {
      if (expired.has(t.id)) continue;
      if (count <= ChatManager.TRASH_MAX_ITEMS && bytes <= ChatManager.TRASH_MAX_BYTES) break;
      expired.add(t.id);
      count--;
      bytes -= t.bytes;
    }
    if (expired.size > 0) {
      for (const id of expired) {
        this.trash.delete(id);
        await this.storageDelete(trashKey(id));
      }
      await this.persistTrashIndex();
      log.info(`Forgot ${expired.size} deleted conversation(s) past keeping`);
    }
    const before = this.undo.steps().length;
    this.undo.prune(step => this.stepStillApplies(step));
    if (this.undo.steps().length !== before) this.scheduleUndoPersist();
  }

  /** Whether what a step acts on is still there (kept in the trash, or on the roster). */
  private stepStillApplies(step: UndoStep<ChatStep>): boolean {
    const d = step.data;
    if (d.kind === 'delete' && d.trashId) return this.trash.has(d.trashId);
    return this.conversations.has(d.conversationId);
  }

  // ─── Undo ──────────────────────────────────────────────────────────

  private async recordStep(callerId: AbjectId, label: string, step: ChatStep): Promise<void> {
    const caller = await this.undoCallerKey(callerId);
    this.undo.for(caller).record(label, step);
    if (step.kind === 'delete') this.scheduleUndoPersist();
    this.send(event(this.id, callerId, 'undoStateChanged', this.undo.state(caller)));
  }

  private async undoFor(callerId: AbjectId, action: UndoAction): Promise<unknown> {
    const caller = await this.undoCallerKey(callerId);
    const history = this.undo.get(caller);
    if (!history) return { ok: false, reason: action === 'undo' ? 'Nothing to undo' : 'Nothing to redo' };
    const result = await history[action](step => this.applyStep(step, action));
    this.scheduleUndoPersist();
    this.send(event(this.id, callerId, 'undoStateChanged', this.undo.state(caller)));
    return result;
  }

  /** Take a step back (undo) or forward again (redo). */
  private async applyStep(step: UndoStep<ChatStep>, action: UndoAction): Promise<void> {
    const d = step.data;
    if (d.kind === 'delete') {
      if (action === 'undo') {
        if (!d.trashId) throw new UndoRefused('The deleted chat is no longer kept');
        await this.restoreConversation(d.trashId, d.conversationId);
        delete d.trashId;
      } else {
        if (!this.conversations.has(d.conversationId)) throw new UndoRefused('That chat is gone already');
        d.trashId = await this.removeConversation(d.conversationId);
      }
      return;
    }
    const c = this.conversations.get(d.conversationId);
    if (!c) throw new UndoRefused('That chat is gone');
    const [expect, next] = action === 'undo' ? [d.after, d.before] : [d.before, d.after];
    if (c.title !== expect) throw new UndoRefused(`The chat was renamed since ('${c.title}')`);
    await this.applyRename(d.conversationId, next, /* fromChat */ false);
  }

  /** Each caller's deletions, the part of the histories kept on disk (renames stay in memory). */
  private savedUndo(): Record<string, UndoHistoryJSON<ChatStep>> {
    const out: Record<string, UndoHistoryJSON<ChatStep>> = {};
    for (const [caller, saved] of Object.entries(this.undo.toJSON())) {
      const done = saved.done.filter(s => s.data.kind === 'delete');
      const undone = saved.undone.filter(s => s.data.kind === 'delete');
      if (done.length + undone.length > 0) out[caller] = { done, undone };
    }
    return out;
  }

  private scheduleUndoPersist(): void {
    if (this.undoPersistTimer || !this.storageId) return;
    this.undoPersistTimer = setTimeout(() => {
      this.undoPersistTimer = undefined;
      void this.storageSet(UNDO_KEY, this.savedUndo()).catch(err => log.warn(`Undo history persistence failed: ${String(err)}`));
    }, 250);
  }

  // ─── Storage helpers ───────────────────────────────────────────────

  private async storageGet(key: string): Promise<unknown> {
    if (!this.storageId) return null;
    try {
      return await this.request<unknown>(request(this.id, this.storageId, 'get', { key }));
    } catch {
      return null;
    }
  }

  private async storageSet(key: string, value: unknown): Promise<void> {
    if (!this.storageId) return;
    await this.request(request(this.id, this.storageId, 'set', { key, value }));
  }

  private async storageDelete(key: string): Promise<void> {
    if (!this.storageId) return;
    try {
      await this.request(request(this.id, this.storageId, 'delete', { key }));
    } catch { /* best effort */ }
  }

  private latestConversation(): ConversationRuntime | undefined {
    let best: ConversationRuntime | undefined;
    for (const c of this.conversations.values()) {
      if (!best || c.lastActiveAt > best.lastActiveAt) best = c;
    }
    return best;
  }

  private stagger(): Rect {
    // Cascade new windows so they don't stack exactly on top of each other.
    const offset = (this.conversations.size % 6) * 28;
    return { x: 80 + offset, y: 60 + offset, width: 640, height: 620 };
  }
}

export const CHAT_MANAGER_ID = 'abjects:chat-manager' as AbjectId;
