/**
 * ChatManager — per-workspace infra Abject for multiple Chat conversations.
 *
 * Owns the conversation roster (persisted to workspace Storage) and the
 * Chat Abject lifecycle (spawn, kill, rename). Pure logic; no windows or
 * widgets. See `ChatBrowser` for the UI surface.
 */

import { v4 as uuidv4 } from 'uuid';
import { AbjectId, AbjectMessage, InterfaceId, TypeId, SpawnResult } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Log } from '../core/timed-log.js';

const log = new Log('ChatManager');

const CHAT_MANAGER_INTERFACE: InterfaceId = 'abjects:chat-manager';

const ROSTER_KEY = 'chats:roster';
const DEFAULT_TITLE = 'New chat';

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

export class ChatManager extends Abject {
  private registryId?: AbjectId;
  private factoryId?: AbjectId;
  private storageId?: AbjectId;
  private widgetManagerId?: AbjectId;

  private peerId?: string;
  private workspaceId?: string;

  private conversations: Map<string, ConversationRuntime> = new Map();

  private persistTimer?: ReturnType<typeof setTimeout>;

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
              description: 'Create a new conversation, open its window, and return its ids.',
              parameters: [
                { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: 'Optional starting title', optional: true },
              ],
              returns: { kind: 'object', properties: {
                conversationId: { kind: 'primitive', primitive: 'string' },
                chatId: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'showConversation',
              description: 'Open or raise the window for an existing conversation.',
              parameters: [
                { name: 'conversationId', type: { kind: 'primitive', primitive: 'string' }, description: 'Conversation id' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'showLatest',
              description: 'Raise the most-recently-active conversation window; no-op if the roster is empty.',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'deleteConversation',
              description: 'Remove a conversation, close its window, and delete its persisted history.',
              parameters: [
                { name: 'conversationId', type: { kind: 'primitive', primitive: 'string' }, description: 'Conversation id' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'renameConversation',
              description: 'Update the title of a conversation.',
              parameters: [
                { name: 'conversationId', type: { kind: 'primitive', primitive: 'string' }, description: 'Conversation id' },
                { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: 'New title' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
          ],
          events: [
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
        requiredCapabilities: [],
        providedCapabilities: [],
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

    // Rehydrate Chat instances — deferred so Factory drains its spawn queue.
    queueMicrotask(() => void this.rehydrateConversations());
  }

  private setupHandlers(): void {
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
        }));
    });

    this.on('newConversation', async (msg: AbjectMessage) => {
      const payload = (msg.payload ?? {}) as { title?: string };
      return this.createConversation(payload.title);
    });

    this.on('showConversation', async (msg: AbjectMessage) => {
      const { conversationId } = msg.payload as { conversationId: string };
      return this.openChatWindow(conversationId);
    });

    this.on('showLatest', async () => {
      const latest = this.latestConversation();
      if (!latest) return false;
      return this.openChatWindow(latest.conversationId);
    });

    this.on('deleteConversation', async (msg: AbjectMessage) => {
      const { conversationId } = msg.payload as { conversationId: string };
      return this.removeConversation(conversationId);
    });

    this.on('renameConversation', async (msg: AbjectMessage) => {
      const { conversationId, title } = msg.payload as { conversationId: string; title: string };
      return this.applyRename(conversationId, title, /* fromChat */ false);
    });

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
      c.rect = rect;
      c.lastActiveAt = Date.now();
      this.schedulePersist();
      this.changed('rosterChanged', {});
    });

    // `messageAdded` from a child Chat → bump that conversation's lastActiveAt
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;
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

  private async ensureWorkspaceId(): Promise<string | undefined> {
    if (this.workspaceId) return this.workspaceId;
    if (!this.widgetManagerId) return undefined;
    try {
      const ws = await this.request<string | null>(
        request(this.id, this.widgetManagerId, 'getObjectWorkspace', { objectId: this.id })
      );
      this.workspaceId = ws ?? undefined;
    } catch { /* WidgetManager may not be ready */ }
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
    const rows: PersistedConversation[] = Array.from(this.conversations.values()).map(c => ({
      conversationId: c.conversationId,
      typeId: c.typeId,
      title: c.title,
      rect: c.rect,
      createdAt: c.createdAt,
      lastActiveAt: c.lastActiveAt,
    }));
    try {
      await this.request(request(this.id, this.storageId, 'set', {
        key: ROSTER_KEY, value: rows,
      }));
    } catch (err) {
      log.warn(`Failed to persist roster: ${String(err)}`);
    }
  }

  // ─── Chat instance lifecycle ───────────────────────────────────────

  private async rehydrateConversations(): Promise<void> {
    if (!this.factoryId || !this.registryId) return;
    if (this.conversations.size === 0) return;

    await this.ensurePeerId();
    await this.ensureWorkspaceId();

    for (const c of this.conversations.values()) {
      if (c.chatId) continue;
      await this.spawnChatFor(c);
    }
    this.schedulePersist();
    this.changed('rosterChanged', {});
  }

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
            requiredCapabilities: [], tags: ['system', 'ui', 'agent'],
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

  private async createConversation(title?: string): Promise<{ conversationId: string; chatId: AbjectId }> {
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
    this.conversations.set(conversationId, c);

    const chatId = await this.spawnChatFor(c);
    await this.persistRoster();

    this.changed('conversationCreated', { conversationId, title: c.title });
    this.changed('rosterChanged', {});

    if (chatId) {
      try {
        await this.request(request(this.id, chatId, 'show', {}), 5000);
      } catch { /* best effort */ }
    }

    return { conversationId, chatId: chatId ?? ('' as AbjectId) };
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
      await this.request(request(this.id, chatId, 'show', {}), 5000);
      return true;
    } catch {
      return false;
    }
  }

  private async removeConversation(conversationId: string): Promise<boolean> {
    const c = this.conversations.get(conversationId);
    if (!c) return false;

    // Hide the Chat window, then kill the Abject
    if (c.chatId) {
      try { await this.request(request(this.id, c.chatId, 'hide', {}), 3000); } catch { /* best effort */ }
      if (this.factoryId) {
        try { await this.request(request(this.id, this.factoryId, 'kill', { objectId: c.chatId }), 3000); } catch { /* best effort */ }
      }
    }

    // Delete persisted history
    if (this.storageId) {
      try {
        await this.request(request(this.id, this.storageId, 'delete', { key: `chats:history:${conversationId}` }));
      } catch { /* best effort */ }
    }

    this.conversations.delete(conversationId);
    await this.persistRoster();
    this.changed('conversationDeleted', { conversationId });
    this.changed('rosterChanged', {});
    return true;
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
