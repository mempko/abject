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
 *
 * A conversation made private when it is created (`private: true`) keeps its
 * roster row, transcript and goal marker under `private:` Storage keys, which
 * only ChatManager and Chat may read. It is listed and readable only for the
 * person's own views of it (CONVERSATION_VIEWS); everyone else reads it as
 * absent, and roster events show PRIVATE_TITLE for it. A deleted private
 * conversation is kept in memory only, for undo until restart.
 */

import { v4 as uuidv4 } from 'uuid';
import { AbjectId, AbjectMessage, InterfaceId, TypeId, SpawnResult } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { captureConversation, forkConversationEntries, type ContextMessage } from '../core/conversation-context.js';
import { describeMessages, protocolText } from '../core/protocol-description.js';
import { Log } from '../core/timed-log.js';
import { ensure, invariant, require as precondition } from '../core/contracts.js';
import { UndoHistories, UndoRefused, UNDO_EVENTS, undoMethods, type UndoAction, type UndoHistoryJSON, type UndoState, type UndoStep } from '../core/undo.js';
import {
  PRIVATE_KEY_PREFIX, PRIVATE_TITLE, PRIVATE_CONVERSATION_UNAVAILABLE, PRIVATE_OUTCOME_ACK_MS,
  privateHistoryKey, isPrivatePayload, type PrivateGoalOutcome,
} from '../core/privacy.js';

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
/** Private conversations' roster rows, readable only by ChatManager and Chat. */
const PRIVATE_ROSTER_KEY = `${PRIVATE_KEY_PREFIX}chats:roster`;
const privateActiveGoalKey = (conversationId: string) => `${PRIVATE_KEY_PREFIX}chats:activegoal:${conversationId}`;
/** Where a private conversation's attachments are kept (Chat writes them). */
const privateUploadPrefix = (conversationId: string) => `${PRIVATE_KEY_PREFIX}chats:upload:${conversationId}:`;
/**
 * The person's own views of the roster (built-in only): they list private
 * conversations and read them. Everyone else reads a private one as absent.
 */
const CONVERSATION_VIEWS = ['ChatBrowser', 'CliServer', 'ChatWindow', 'Chat', 'CommandPalette'] as const;

interface Rect { x: number; y: number; width: number; height: number }

export interface PersistedConversation {
  conversationId: string;
  typeId?: string;
  title: string;
  rect?: Rect;
  createdAt: number;
  lastActiveAt: number;
  /** Made private when created: listed only for views, stored under `private:` keys. */
  private?: boolean;
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
  /** A private conversation's: kept in memory only, never in the trash index on disk. */
  private?: boolean;
}

/** What a deleted conversation leaves behind, kept whole for undo. */
interface ChatTrashRecord {
  conversation: PersistedConversation;
  history?: unknown[];
  activeGoal?: string;
  /** AbjectStore trash ids of its cards, set aside with the folder. */
  cards?: string[];
  /** A private conversation's attachments, by Storage key. */
  uploads?: Record<string, unknown>;
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
  /** Deleted private conversations' records, by trash id: memory only, gone at restart. */
  private privateTrash: Map<string, ChatTrashRecord> = new Map();
  /** Whether PRIVATE_ROSTER_KEY holds rows, so emptying it is written too. */
  private privateRosterSaved = false;
  /** Whether PRIVATE_ROSTER_KEY was read; until then it is never written, so a failed read cannot erase it. */
  private privateRosterLoaded = false;
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
              description: 'Return the current conversation roster, sorted by lastActiveAt descending. Private conversations are listed (with private: true) only for the person\'s own views.',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'PersistedConversation' } },
            },
            {
              name: 'newConversation',
              description: 'Create a new conversation and return its ids. Opens its window on a desktop unless show is false.',
              parameters: [
                { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: 'Optional starting title', optional: true },
                { name: 'show', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Open its window (default true; ignored without a display)', optional: true },
                { name: 'private', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Make it private: nothing in it is learned, its goals are deleted when they finish, and only the person\'s own views can read it', optional: true },
              ],
              returns: { kind: 'object', properties: {
                conversationId: { kind: 'primitive', primitive: 'string' },
                chatId: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'forkConversation',
              description: 'Copy a conversation up to and including one message into a new conversation, leaving the original untouched. The new conversation carries the copied transcript as its history, so it can be talked to from there. Opens its window on a desktop unless show is false.',
              parameters: [
                { name: 'conversationId', type: { kind: 'primitive', primitive: 'string' }, description: 'The conversation to copy from' },
                { name: 'throughMessageId', type: { kind: 'primitive', primitive: 'string' }, description: 'The message the fork ends at (included)' },
                { name: 'show', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Open the new conversation window (default true; ignored without a display)', optional: true },
                { name: 'private', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Make the copy private (a fork of a private conversation is always private)', optional: true },
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
            {
              name: 'deliverPrivateOutcome',
              description: 'GoalManager only: hand a private goal\'s outcome to the private conversation that started it, starting its Chat if it is dormant. Returns whether the Chat took it.',
              parameters: [
                { name: 'conversationId', type: { kind: 'primitive', primitive: 'string' }, description: 'The private conversation' },
                { name: 'outcome', type: { kind: 'reference', reference: 'PrivateGoalOutcome' }, description: 'How the goal ended' },
              ],
              returns: { kind: 'object', properties: {
                accepted: { kind: 'primitive', primitive: 'boolean' },
              } },
            },
          ],
          events: [
            ...UNDO_EVENTS,
            {
              name: 'conversationCreated',
              description: 'Fires when a new conversation is added to the roster. A private one carries private: true and a placeholder title.',
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
              description: 'Fires when a conversation title changes. A private one carries private: true and a placeholder title.',
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
    for (const id of this.privateTrash.keys()) {
      invariant(this.trash.get(id)?.private === true, 'ChatManager: a private trash record without its private trash entry');
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
      const c = await this.visibleConversation(conversationId, msg.routing.from);
      if (!this.storageId || !c) throw new Error(PRIVATE_CONVERSATION_UNAVAILABLE);
      if (!throughMessageId) throw new Error('A conversation boundary is required');
      const entries = await this.request<ContextMessage[] | null>(request(this.id, this.storageId, 'get', { key: this.historyKeyOf(c) }));
      if (!Array.isArray(entries)) throw new Error('Conversation history unavailable');
      return captureConversation(conversationId, entries, throughMessageId);
    });
    this.on('getState', async (msg: AbjectMessage) => {
      const roster = await this.rosterFor(msg.routing.from);
      return {
        conversationCount: roster.length,
        latestConversationId: this.latestConversation(roster)?.conversationId ?? '',
      };
    });

    this.on('listConversations', async (msg: AbjectMessage) => {
      return (await this.rosterFor(msg.routing.from))
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
          // Only views get private rows at all (rosterFor).
          ...(c.private ? { private: true } : {}),
        }));
    });

    this.on('newConversation', async (msg: AbjectMessage) => {
      const payload = (msg.payload ?? {}) as { title?: string; show?: boolean; private?: boolean };
      return this.createConversation(payload.title, payload.show !== false, undefined, isPrivatePayload(payload));
    });

    this.on('forkConversation', async (msg: AbjectMessage) => {
      const payload = (msg.payload ?? {}) as { conversationId?: string; throughMessageId?: string; show?: boolean; private?: boolean };
      precondition(typeof payload.conversationId === 'string' && payload.conversationId.length > 0,
        'forkConversation: a conversation id is required');
      precondition(typeof payload.throughMessageId === 'string' && payload.throughMessageId.length > 0,
        'forkConversation: the message the fork ends at is required');
      if (!(await this.visibleConversation(payload.conversationId, msg.routing.from))) {
        throw new Error(PRIVATE_CONVERSATION_UNAVAILABLE);
      }
      return this.forkConversation(payload.conversationId, payload.throughMessageId, payload.show !== false, isPrivatePayload(payload));
    });

    this.on('openConversation', async (msg: AbjectMessage) => {
      const { conversationId } = msg.payload as { conversationId: string };
      const c = await this.visibleConversation(conversationId, msg.routing.from);
      if (!c) return false;
      const chatId = c.chatId ?? await this.spawnChatFor(c);
      if (!chatId) return false;
      return { conversationId, chatId };
    });

    this.on('showConversation', async (msg: AbjectMessage) => {
      const { conversationId } = msg.payload as { conversationId: string };
      if (!(await this.visibleConversation(conversationId, msg.routing.from))) return false;
      const opened = await this.openChatWindow(conversationId);
      if (!opened) return false;
      const c = this.conversations.get(conversationId);
      return { conversationId, chatId: c?.chatId ?? '' };
    });

    this.on('getHistory', async (msg: AbjectMessage) => {
      const { conversationId } = msg.payload as { conversationId: string };
      const c = await this.visibleConversation(conversationId, msg.routing.from);
      if (!this.storageId || !c) return [];
      try {
        const entries = await this.request<unknown[] | null>(
          request(this.id, this.storageId, 'get', { key: this.historyKeyOf(c) })
        );
        return Array.isArray(entries) ? entries : [];
      } catch (err) {
        log.warn(`getHistory failed for ${conversationId.slice(0, 8)}: ${String(err)}`);
        return [];
      }
    });

    this.on('getActiveGoal', async (msg: AbjectMessage) => {
      const { conversationId } = msg.payload as { conversationId: string };
      const c = await this.visibleConversation(conversationId, msg.routing.from);
      if (!this.storageId || !c) return null;
      try {
        const goalId = await this.request<string | null>(
          request(this.id, this.storageId, 'get', { key: this.activeGoalKeyOf(c) })
        );
        return typeof goalId === 'string' && goalId ? goalId : null;
      } catch {
        return null;
      }
    });

    this.on('showLatest', async (msg: AbjectMessage) => {
      const latest = this.latestConversation(await this.rosterFor(msg.routing.from));
      if (!latest) return false;
      return this.openChatWindow(latest.conversationId);
    });

    this.on('deleteConversation', async (msg: AbjectMessage) => {
      const { conversationId } = msg.payload as { conversationId: string };
      const c = await this.visibleConversation(conversationId, msg.routing.from);
      if (!c) return false;
      // The step's label is kept on disk with the deletion: a private title stays out of it.
      const title = c.private ? PRIVATE_TITLE : c.title;
      const trashId = await this.removeConversation(conversationId);
      await this.recordStep(msg.routing.from, `Delete chat ${title}`, { kind: 'delete', conversationId, trashId });
      return true;
    });

    this.on('renameConversation', async (msg: AbjectMessage) => {
      const { conversationId, title } = msg.payload as { conversationId: string; title: string };
      if (!(await this.visibleConversation(conversationId, msg.routing.from))) return false;
      const before = this.conversations.get(conversationId)?.title;
      const renamed = await this.applyRename(conversationId, title, /* fromChat */ false);
      const after = this.conversations.get(conversationId)?.title;
      if (renamed && before !== undefined && after !== undefined) {
        await this.recordStep(msg.routing.from, 'Rename chat', { kind: 'rename', conversationId, before, after });
      }
      return renamed;
    });

    // A private goal's outcome, when the Chat that started it was not there
    // to take it from GoalManager directly.
    this.on('deliverPrivateOutcome', async (msg: AbjectMessage) => {
      if (!(await this.isBuiltInCaller(msg.routing.from, ['GoalManager']))) return { accepted: false };
      const { conversationId, outcome } = (msg.payload ?? {}) as { conversationId?: string; outcome?: PrivateGoalOutcome };
      precondition(typeof outcome?.goalId === 'string' && outcome.goalId.length > 0,
        'deliverPrivateOutcome: an outcome with a goal id is required');
      return this.deliverPrivateOutcome(conversationId ?? '', outcome!);
    });

    this.on('undo', async (msg: AbjectMessage) => this.undoFor(msg.routing.from, 'undo'));
    this.on('redo', async (msg: AbjectMessage) => this.undoFor(msg.routing.from, 'redo'));
    this.on('getUndoState', async (msg: AbjectMessage) => this.undo.state(await this.undoCallerKey(msg.routing.from)));

    // Events from child Chat Abjects
    this.on('titleChanged', async (msg: AbjectMessage) => {
      const { conversationId, title } = msg.payload as { conversationId: string; title: string };
      if (!conversationId || typeof title !== 'string') return;
      if (!this.fromOwnChat(conversationId, msg.routing.from)) return;
      await this.applyRename(conversationId, title, /* fromChat */ true);
    });

    this.on('rectChanged', async (msg: AbjectMessage) => {
      const { conversationId, rect } = msg.payload as { conversationId: string; rect: Rect };
      const c = this.conversations.get(conversationId);
      if (!c || !rect || !this.fromOwnChat(conversationId, msg.routing.from)) return;
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

  // ─── Private conversations ─────────────────────────────────────────

  /** Whether a caller is one of the person's own views of the roster. */
  private async isView(callerId: AbjectId): Promise<boolean> {
    return this.isBuiltInCaller(callerId, CONVERSATION_VIEWS);
  }

  /**
   * Whether a caller may see a private conversation: a view, except that a
   * Chat sees only its own conversation (a Chat is one conversation, never a
   * reader of the others).
   */
  private async seesPrivate(c: ConversationRuntime, callerId: AbjectId): Promise<boolean> {
    if (c.chatId === callerId) return true;
    if (!(await this.isView(callerId))) return false;
    return !(await this.isBuiltInCaller(callerId, ['Chat']));
  }

  /** A conversation as a caller may see it: a private one only for views. */
  private async visibleConversation(conversationId: string, callerId: AbjectId): Promise<ConversationRuntime | undefined> {
    const c = this.conversations.get(conversationId);
    if (!c) return undefined;
    if (c.private && !(await this.seesPrivate(c, callerId))) return undefined;
    return c;
  }

  /** The roster a caller may see: private rows only for views. */
  private async rosterFor(callerId: AbjectId): Promise<ConversationRuntime[]> {
    const all = Array.from(this.conversations.values());
    if (!all.some(c => c.private)) return all;
    if (await this.isView(callerId) && !(await this.isBuiltInCaller(callerId, ['Chat']))) return all;
    return all.filter(c => !c.private || c.chatId === callerId);
  }

  /** A private conversation takes title and window moves only from its own Chat. */
  private fromOwnChat(conversationId: string, callerId: AbjectId): boolean {
    const c = this.conversations.get(conversationId);
    return !c?.private || c.chatId === callerId;
  }

  private historyKeyOf(c: PersistedConversation): string {
    return c.private ? privateHistoryKey(c.conversationId) : historyKey(c.conversationId);
  }

  private activeGoalKeyOf(c: PersistedConversation): string {
    return c.private ? privateActiveGoalKey(c.conversationId) : activeGoalKey(c.conversationId);
  }

  /** The title fields of a roster event: a private conversation's real title stays out. */
  private titleFields(c: PersistedConversation, title = c.title): { title: string; private?: true } {
    return c.private ? { title: PRIVATE_TITLE, private: true } : { title };
  }

  /**
   * Hand a private goal's outcome to its conversation's Chat, spawning the
   * Chat when the conversation is dormant. The Chat's reply says whether it
   * took it; an unknown or non-private conversation takes nothing.
   */
  private async deliverPrivateOutcome(conversationId: string, outcome: PrivateGoalOutcome): Promise<{ accepted: boolean }> {
    const c = this.conversations.get(conversationId);
    if (!c?.private) return { accepted: false };
    const chatId = c.chatId ?? await this.spawnChatFor(c);
    if (!chatId) return { accepted: false };
    try {
      // Within GoalManager's own wait for this reply.
      const reply = await this.request<{ accepted?: boolean } | null>(
        request(this.id, chatId, 'privateGoalOutcome', outcome), PRIVATE_OUTCOME_ACK_MS / 2);
      return { accepted: reply?.accepted === true };
    } catch (err) {
      log.warn(`A private goal outcome did not reach its chat: ${String(err)}`);
      return { accepted: false };
    }
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
    await this.loadPrivateRoster();
  }

  /**
   * Private rows live apart, where only ChatManager and Chat can read them.
   * A read that fails is tried again shortly, and the rows it finds join
   * any private conversation started in the meantime.
   */
  private async loadPrivateRoster(attempt = 1): Promise<void> {
    if (!this.storageId || this.privateRosterLoaded) return;
    let stored: unknown;
    try {
      stored = await this.request<unknown>(request(this.id, this.storageId, 'get', { key: PRIVATE_ROSTER_KEY }));
    } catch (err) {
      log.warn(`Could not read the private roster (attempt ${attempt}): ${String(err)}`);
      if (attempt < 5) setTimeout(() => { void this.loadPrivateRoster(attempt + 1); }, 2000 * attempt);
      return;
    }
    this.privateRosterLoaded = true;
    if (!Array.isArray(stored) || stored.length === 0) return;
    for (const c of stored as PersistedConversation[]) {
      if (c?.conversationId && !this.conversations.has(c.conversationId)) {
        this.conversations.set(c.conversationId, { ...c, private: true });
      }
    }
    this.privateRosterSaved = true;
    if (attempt > 1) {
      await this.persistRoster();
      this.changed('rosterChanged', {});
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
    const all = Array.from(this.conversations.values());
    const rows: PersistedConversation[] = all.filter(c => !c.private).map(c => this.persisted(c));
    try {
      await this.request(request(this.id, this.storageId, 'set', {
        key: ROSTER_KEY, value: rows,
      }));
    } catch (err) {
      log.warn(`Failed to persist roster: ${String(err)}`);
    }
    if (!this.privateRosterLoaded) return;
    const privateRows = all.filter(c => c.private).map(c => this.persisted(c));
    if (privateRows.length === 0 && !this.privateRosterSaved) return;
    try {
      await this.request(request(this.id, this.storageId, 'set', {
        key: PRIVATE_ROSTER_KEY, value: privateRows,
      }));
      this.privateRosterSaved = privateRows.length > 0;
    } catch (err) {
      log.warn(`Failed to persist the private roster: ${String(err)}`);
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
            // A private Chat never enters a peer catalog.
            ...(c.private ? { sharing: 'user-local' } : {}),
          },
          registryHint: this.registryId,
          typeId,
          constructorArgs: {
            conversationId: c.conversationId,
            title: c.title,
            rect: c.rect,
            ...(c.private ? { private: true } : {}),
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

  /**
   * Copy a conversation through one message into a new conversation. The
   * original keeps its transcript and roster row untouched; the copy starts
   * life with the same prefix as its own history, so the agent resumes there.
   * A fork of a private conversation is private; `makePrivate` makes a fork
   * of a regular one private too.
   */
  private async forkConversation(
    sourceId: string, throughMessageId: string, show: boolean, makePrivate = false,
  ): Promise<{ conversationId: string; chatId: AbjectId }> {
    const source = this.conversations.get(sourceId);
    if (!source) throw new Error(PRIVATE_CONVERSATION_UNAVAILABLE);
    const entries = await this.storageGet(this.historyKeyOf(source));
    if (!Array.isArray(entries)) throw new Error('Conversation history unavailable');
    const seed = forkConversationEntries(sourceId, entries as ContextMessage[], throughMessageId);
    const isPrivate = source.private === true || makePrivate;
    if (!isPrivate) return this.createConversation(`${source.title} (fork)`, show, seed);
    // A private fork reads its attachments from its own upload keys, so it
    // keeps them when the original is deleted.
    const conversationId = uuidv4();
    const { entries: own, keys } = await this.copyPrivateUploads(seed, conversationId);
    try {
      // A normal chat's title came from its words; a private copy starts neutral.
      const title = source.private === true ? `${source.title} (fork)` : PRIVATE_TITLE;
      return await this.createConversation(title, show, own, true, conversationId);
    } catch (err) {
      for (const key of keys) await this.storageDelete(key);
      throw err;
    }
  }

  /**
   * Copy each private upload the entries reference (attachment.path, a
   * `private:chats:upload:` key) under the new conversation's own upload
   * prefix, and point the copied entries at the copies. Returns the entries
   * and the keys written.
   */
  private async copyPrivateUploads(
    entries: ContextMessage[], conversationId: string,
  ): Promise<{ entries: ContextMessage[]; keys: string[] }> {
    const uploadPrefix = `${PRIVATE_KEY_PREFIX}chats:upload:`;
    const copies = new Map<string, string>();
    const keys: string[] = [];
    const out: ContextMessage[] = [];
    for (const entry of entries) {
      const path = entry.attachment?.path;
      if (!entry.attachment || typeof path !== 'string' || !path.startsWith(uploadPrefix)) {
        out.push(entry);
        continue;
      }
      let copy = copies.get(path);
      if (!copy) {
        const value = await this.storageGet(path);
        if (value === null || value === undefined) { out.push(entry); continue; }
        copy = `${privateUploadPrefix(conversationId)}${uuidv4()}`;
        await this.storageSet(copy, value);
        copies.set(path, copy);
        keys.push(copy);
      }
      out.push({ ...entry, attachment: { ...entry.attachment, path: copy } });
    }
    ensure(out.length === entries.length, 'copyPrivateUploads: every entry is kept');
    return { entries: out, keys };
  }

  private async createConversation(
    title: string | undefined, show: boolean, seed?: ContextMessage[], isPrivate = false,
    conversationId: string = uuidv4(),
  ): Promise<{ conversationId: string; chatId: AbjectId }> {
    await this.ensurePeerId();
    await this.ensureWorkspaceId();
    const now = Date.now();
    const c: ConversationRuntime = {
      conversationId,
      typeId: this.computeTypeId(conversationId),
      title: (title?.trim() || (isPrivate ? PRIVATE_TITLE : DEFAULT_TITLE)),
      rect: this.stagger(),
      createdAt: now,
      lastActiveAt: now,
      ...(isPrivate ? { private: true } : {}),
    };

    // A fork's copied transcript must be on disk before its Chat starts: Chat
    // reads its history once, in onInit, and never looks again.
    if (seed && seed.length > 0) await this.storageSet(this.historyKeyOf(c), seed);

    // A conversation joins the roster only once its Chat is running: a failed
    // spawn used to leave a "New chat" row behind that nothing could open.
    const chatId = await this.spawnChatFor(c);
    if (!chatId) {
      if (seed && seed.length > 0) await this.storageDelete(this.historyKeyOf(c));
      throw new Error('Failed to create conversation: its Chat could not start');
    }
    this.conversations.set(conversationId, c);
    await this.persistRoster();

    this.changed('conversationCreated', { conversationId, ...this.titleFields(c) });
    this.changed('rosterChanged', {});

    // A window only where there is a display: show reports false otherwise.
    if (show) {
      try {
        const shown = await this.request<boolean>(request(this.id, chatId, 'show', {}), 20000);
        if (shown) this.changed('conversationOpened', { conversationId, ...this.titleFields(c), chatId });
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
      if (shown) this.changed('conversationOpened', { conversationId, ...this.titleFields(c), chatId });
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
   *
   * A private conversation is set aside in memory only, and its goals and
   * `private:` keys go now (removePrivateConversation).
   */
  private async removeConversation(conversationId: string): Promise<string> {
    const c = this.conversations.get(conversationId);
    precondition(c !== undefined, `removeConversation: no conversation '${conversationId}'`);
    if (c!.private) return this.removePrivateConversation(c!);

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

  /**
   * Delete a private conversation: its Chat stops, GoalManager stops and
   * forgets every goal it started, and its transcript and attachments leave
   * Storage. What undo needs is kept in memory only, until restart; nothing
   * of it reaches the trash on disk.
   */
  private async removePrivateConversation(c: ConversationRuntime): Promise<string> {
    precondition(c.private === true, 'removePrivateConversation: the conversation is not private');
    const conversationId = c.conversationId;
    if (c.chatId) {
      try { await this.request(request(this.id, c.chatId, 'hide', {}), 3000); } catch { /* best effort */ }
      if (this.factoryId) {
        try { await this.request(request(this.id, this.factoryId, 'kill', { objectId: c.chatId }), 3000); } catch { /* best effort */ }
      }
    }

    // Its goals are deleted with it, not delivered.
    const goalManagerId = await this.discoverDep('GoalManager');
    if (goalManagerId) {
      try {
        await this.request(request(this.id, goalManagerId, 'purgeConversationGoals', { conversationId }), 10_000);
      } catch (err) {
        log.warn(`Could not purge a private conversation's goals: ${String(err)}`);
      }
    }

    const history = await this.storageGet(privateHistoryKey(conversationId));
    const uploads = await this.privateUploads(conversationId);
    const trashId = this.setAsidePrivate({
      conversation: this.persisted(c),
      ...(Array.isArray(history) ? { history } : {}),
      ...(Object.keys(uploads).length > 0 ? { uploads } : {}),
    });

    await this.storageDelete(privateHistoryKey(conversationId));
    await this.storageDelete(privateActiveGoalKey(conversationId));
    for (const key of Object.keys(uploads)) await this.storageDelete(key);

    if (c.chatId) {
      this.busyChats.delete(c.chatId);
      this.emitGoalActivity();
    }
    this.conversations.delete(conversationId);
    await this.persistRoster();
    this.changed('conversationDeleted', { conversationId });
    this.changed('rosterChanged', {});
    await this.purgeTrash();
    return trashId;
  }

  /** A private conversation's attachments in Storage, by key. */
  private async privateUploads(conversationId: string): Promise<Record<string, unknown>> {
    if (!this.storageId) return {};
    try {
      const found = await this.request<Record<string, unknown> | null>(
        request(this.id, this.storageId, 'getByPrefix', { prefix: privateUploadPrefix(conversationId) }));
      return found && typeof found === 'object' ? found : {};
    } catch {
      return {};
    }
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
    if (item.private) return this.restorePrivateConversation(trashId, conversationId);
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

  /**
   * Put a deleted private conversation back from memory: transcript and
   * attachments under its `private:` keys, roster row. Its goals were
   * deleted with it, so no goal marker comes back.
   */
  private async restorePrivateConversation(trashId: string, conversationId: string): Promise<void> {
    const record = this.privateTrash.get(trashId);
    if (!record) {
      this.trash.delete(trashId);
      throw new UndoRefused('The deleted private chat is gone (Abjects restarted)');
    }
    if (record.history) await this.storageSet(privateHistoryKey(conversationId), record.history);
    for (const [key, value] of Object.entries(record.uploads ?? {})) await this.storageSet(key, value);

    const c: ConversationRuntime = { ...record.conversation, private: true };
    this.conversations.set(conversationId, c);
    await this.persistRoster();
    this.trash.delete(trashId);
    this.privateTrash.delete(trashId);
    this.changed('conversationCreated', { conversationId, ...this.titleFields(c) });
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
      ...(c.private ? { private: true } : {}),
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
    this.changed('conversationRenamed', { conversationId, ...this.titleFields(c, trimmed) });
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

  /**
   * Keep a deleted private conversation's record in memory under a new trash
   * id: undo finds it until restart, and nothing of it is written to disk.
   */
  private setAsidePrivate(record: ChatTrashRecord): string {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.privateTrash.set(id, record);
    this.trash.set(id, {
      id,
      conversationId: record.conversation.conversationId,
      title: PRIVATE_TITLE,
      removedAt: Date.now(),
      bytes: JSON.stringify(record).length,
      private: true,
    });
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
    await this.storageSet(TRASH_INDEX_KEY, [...this.trash.values()].filter(t => !t.private));
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
        const wasPrivate = this.trash.get(id)?.private === true;
        this.trash.delete(id);
        if (wasPrivate) this.privateTrash.delete(id);
        else await this.storageDelete(trashKey(id));
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

  private latestConversation(among: Iterable<ConversationRuntime> = this.conversations.values()): ConversationRuntime | undefined {
    let best: ConversationRuntime | undefined;
    for (const c of among) {
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
