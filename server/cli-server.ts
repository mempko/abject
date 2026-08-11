/**
 * CliServer -- WebSocket gateway for terminal clients (`pnpm commune`).
 *
 * Listens on its own port (CLI_PORT, default 7723) and speaks a small JSON
 * protocol tailored for chat operations, mirroring how BackendUI serves the
 * browser on its own socket. Every chat op carries an explicit workspaceId,
 * so a single connection can drive conversations in any number of workspaces
 * at once. Auth shares the browser client's gate: same AuthConfig, same
 * SessionStore, so one login token works on both.
 *
 * Wire protocol (JSON text frames):
 *   client -> server  { id, op, ...params }
 *   server -> client  { id, ok: true, result } | { id, ok: false, error }
 *   server -> client  { event, workspaceId, conversationId?, data }   (pushed)
 */

import type { WebSocket } from 'ws';
import { AbjectId, AbjectMessage, InterfaceId } from '../src/core/types.js';
import { Abject } from '../src/core/abject.js';
import { request } from '../src/core/message.js';
import { require as contractRequire, requireNonEmpty } from '../src/core/contracts.js';
import { NodeWebSocketServer } from '../src/network/websocket-server.js';
import { authenticateConnection, AuthConfig, SessionStore } from './auth.js';
import { Log } from '../src/core/timed-log.js';

const log = new Log('CliServer');

const CLI_SERVER_INTERFACE: InterfaceId = 'abjects:cli-server';

/** One connected terminal client. */
interface CliSession {
  ws: WebSocket;
  /** Watch keys (`${workspaceId}:${conversationId}`) this session receives events for. */
  watches: Set<string>;
}

/** Cached per-workspace dependency ids. */
interface WorkspaceDeps {
  registryId: AbjectId;
  chatManagerId: AbjectId;
  goalManagerId?: AbjectId;
}

/** A live Chat subscription shared by all sessions watching its conversation. */
interface ChatSub {
  chatId: AbjectId;
  workspaceId: string;
  conversationId: string;
}

export interface CliServerArgs {
  port: number;
  authConfig: AuthConfig;
  sessions: SessionStore;
}

/** Goal aspects forwarded to terminal clients as progress lines. */
const GOAL_ASPECTS = [
  'goalCreated', 'goalUpdated', 'goalCompleted', 'goalFailed',
  'goalPaused', 'goalResumed', 'scrumPlanned',
  'taskCompleted', 'taskPermanentlyFailed', 'taskUnblocked',
  'goalInterjection', 'goalClarificationRequested',
] as const;

export class CliServer extends Abject {
  private wsServer: NodeWebSocketServer | null = null;
  private port: number;
  private readonly authConfig: AuthConfig;
  private readonly sessions: SessionStore;

  private clients: Set<CliSession> = new Set();
  private workspaceManagerId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private depsByWorkspace: Map<string, WorkspaceDeps> = new Map();
  /** Watch key -> shared Chat subscription (subscribed while any session watches). */
  private chatSubs: Map<string, ChatSub> = new Map();
  /** Chat AbjectId -> watch key, for routing incoming Chat events. */
  private chatIdToKey: Map<AbjectId, string> = new Map();
  /** GoalManager AbjectId -> workspaceId, for routing goal events. */
  private goalManagerToWorkspace: Map<AbjectId, string> = new Map();
  /** ChatManager AbjectId -> workspaceId, for routing roster events. */
  private chatManagerToWorkspace: Map<AbjectId, string> = new Map();
  /** NotificationCenter AbjectId -> workspaceId, for routing toast events. */
  private notificationCenterToWorkspace: Map<AbjectId, string> = new Map();

  constructor(args: CliServerArgs) {
    super({
      manifest: {
        name: 'CliServer',
        description:
          'WebSocket gateway for terminal clients. Speaks a JSON protocol for ' +
          'listing workspaces, managing chat conversations across any number of ' +
          'workspaces, sending messages, and streaming chat/goal events back to ' +
          'connected terminals. Shares the auth gate with the browser client.',
        version: '1.0.0',
        interface: {
          id: CLI_SERVER_INTERFACE,
          name: 'CliServer',
          description: 'Terminal client gateway',
          methods: [
            {
              name: 'getPort',
              description: 'Return the port the CLI gateway listens on.',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'number' },
            },
            {
              name: 'getState',
              description: 'Return connected terminal client count and active chat subscription count.',
              parameters: [],
              returns: { kind: 'object', properties: {
                clientCount: { kind: 'primitive', primitive: 'number' },
                subscriptionCount: { kind: 'primitive', primitive: 'number' },
              } },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system'],
      },
    });

    contractRequire(args.port > 0, 'port must be positive');
    this.port = args.port;
    this.authConfig = args.authConfig;
    this.sessions = args.sessions;
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('getPort', () => this.port);

    this.on('getState', () => ({
      clientCount: this.clients.size,
      subscriptionCount: this.chatSubs.size,
    }));

    // ── Events pushed to us by objects we subscribed to ─────────────────

    this.on('messageAdded', (msg: AbjectMessage) => {
      const key = this.chatIdToKey.get(msg.routing.from);
      if (!key) return;
      const sub = this.chatSubs.get(key);
      if (!sub) return;
      this.pushToWatchers(key, {
        event: 'message',
        workspaceId: sub.workspaceId,
        conversationId: sub.conversationId,
        data: msg.payload,
      });
    });

    this.on('titleChanged', (msg: AbjectMessage) => {
      const key = this.chatIdToKey.get(msg.routing.from);
      if (!key) return;
      const sub = this.chatSubs.get(key);
      if (!sub) return;
      this.pushToWatchers(key, {
        event: 'titleChanged',
        workspaceId: sub.workspaceId,
        conversationId: sub.conversationId,
        data: msg.payload,
      });
    });

    // Roster events from per-workspace ChatManagers we subscribed to.
    for (const aspect of ['conversationCreated', 'conversationDeleted', 'conversationRenamed', 'conversationOpened'] as const) {
      this.on(aspect, (msg: AbjectMessage) => {
        const workspaceId = this.chatManagerToWorkspace.get(msg.routing.from);
        if (!workspaceId) return;
        if (aspect === 'conversationDeleted') {
          const { conversationId } = msg.payload as { conversationId: string };
          this.dropSubscription(this.watchKey(workspaceId, conversationId), /* chatGone */ true);
        }
        this.broadcast({ event: aspect, workspaceId, data: msg.payload });
      });
    }

    // Modal dialogs from the global WidgetManager: broadcast so any terminal
    // can answer (the first respond wins; the rest see dialogClosed).
    this.on('dialogOpened', (msg: AbjectMessage) => {
      if (msg.routing.from !== this.widgetManagerId) return;
      this.broadcast({ event: 'dialog', workspaceId: '', data: msg.payload });
    });

    this.on('dialogClosed', (msg: AbjectMessage) => {
      if (msg.routing.from !== this.widgetManagerId) return;
      this.broadcast({ event: 'dialogClosed', workspaceId: '', data: msg.payload });
    });

    // Toasts from per-workspace NotificationCenters we subscribed to.
    this.on('notificationAdded', (msg: AbjectMessage) => {
      const workspaceId = this.notificationCenterToWorkspace.get(msg.routing.from);
      if (!workspaceId) return;
      this.broadcast({ event: 'toast', workspaceId, data: msg.payload });
    });

    // Goal progress from per-workspace GoalManagers we subscribed to.
    for (const aspect of GOAL_ASPECTS) {
      this.on(aspect, (msg: AbjectMessage) => {
        const workspaceId = this.goalManagerToWorkspace.get(msg.routing.from);
        if (!workspaceId) return;
        this.pushToWorkspaceWatchers(workspaceId, {
          event: 'goalProgress',
          workspaceId,
          data: { aspect, ...(msg.payload as object ?? {}) },
        });
      });
    }
  }

  protected override async onInit(): Promise<void> {
    // Mirror modal dialogs: WidgetManager announces dialogOpened/dialogClosed
    // to its dependents.
    try {
      this.widgetManagerId = await this.requireDep('WidgetManager');
      this.send(request(this.id, this.widgetManagerId, 'addDependent', {}));
    } catch { /* dialogs just won't mirror */ }

    this.wsServer = new NodeWebSocketServer({
      port: this.port,
      host: '127.0.0.1',
      perMessageDeflate: false,
    });
    this.wsServer.onConnection((ws) => this.handleConnection(ws));
    await this.wsServer.ready();
    log.info(`CLI gateway listening on 127.0.0.1:${this.port} (auth ${this.authConfig.enabled ? 'enabled' : 'disabled'})`);
  }

  protected override async onStop(): Promise<void> {
    for (const session of this.clients) {
      try { session.ws.close(1001, 'Server shutting down'); } catch { /* already closed */ }
    }
    this.clients.clear();
    if (this.wsServer) {
      // Drop the reference before awaiting: shutdown releases this port up
      // front and the runtime teardown stops every object again afterwards,
      // so a close that rejects must not leave a second attempt behind.
      const server = this.wsServer;
      this.wsServer = null;
      await server.close().catch(() => { /* already closed */ });
    }
  }

  // ── Connection lifecycle ──────────────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    log.info('Terminal client connected');
    if (this.authConfig.enabled) {
      authenticateConnection(ws, this.authConfig, this.sessions).then(({ result }) => {
        if (result === 'authenticated') {
          log.info('Terminal client authenticated');
          this.attachSession(ws);
        } else {
          log.info(`Terminal client auth ${result}, closing`);
          try { ws.close(1008, `Authentication ${result}`); } catch { /* already closed */ }
        }
      });
    } else {
      ws.send(JSON.stringify({ type: 'authNotRequired' }));
      this.attachSession(ws);
    }
  }

  private attachSession(ws: WebSocket): void {
    const session: CliSession = { ws, watches: new Set() };
    this.clients.add(session);

    ws.on('message', (data: unknown) => {
      let msg: { id?: unknown; op?: unknown } & Record<string, unknown>;
      try {
        msg = JSON.parse(String(data));
      } catch {
        this.sendTo(session, { id: null, ok: false, error: 'Malformed JSON' });
        return;
      }
      const id = msg.id ?? null;
      const op = typeof msg.op === 'string' ? msg.op : '';
      this.handleOp(session, op, msg).then(
        (result) => this.sendTo(session, { id, ok: true, result }),
        (err: unknown) => this.sendTo(session, {
          id, ok: false, error: err instanceof Error ? err.message : String(err),
        }),
      );
    });

    ws.on('close', () => {
      this.clients.delete(session);
      const watched = [...session.watches];
      session.watches.clear();
      for (const key of watched) this.releaseWatchIfUnused(key);
      log.info(`Terminal client disconnected (${this.clients.size} remaining)`);
    });
  }

  private sendTo(session: CliSession, payload: unknown): void {
    if (session.ws.readyState !== 1) return;
    try { session.ws.send(JSON.stringify(payload)); } catch { /* closing */ }
  }

  private broadcast(payload: unknown): void {
    for (const session of this.clients) this.sendTo(session, payload);
  }

  private pushToWatchers(key: string, payload: unknown): void {
    for (const session of this.clients) {
      if (session.watches.has(key)) this.sendTo(session, payload);
    }
  }

  private pushToWorkspaceWatchers(workspaceId: string, payload: unknown): void {
    const prefix = `${workspaceId}:`;
    for (const session of this.clients) {
      for (const key of session.watches) {
        if (key.startsWith(prefix)) { this.sendTo(session, payload); break; }
      }
    }
  }

  // ── Op dispatch ───────────────────────────────────────────────────────

  private async handleOp(
    session: CliSession,
    op: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    requireNonEmpty(op, 'op');
    switch (op) {
      case 'listWorkspaces': return this.opListWorkspaces();
      case 'switchWorkspace': return this.wsmRequest('switchWorkspace', {
        workspaceId: this.str(params, 'workspaceId'),
      });
      case 'createWorkspace': return this.wsmRequest('createWorkspace', { name: this.str(params, 'name') });
      case 'renameWorkspace': return this.wsmRequest('renameWorkspace', {
        workspaceId: this.str(params, 'workspaceId'), name: this.str(params, 'name'),
      });
      case 'deleteWorkspace': {
        const workspaceId = this.str(params, 'workspaceId');
        const result = await this.wsmRequest('deleteWorkspace', { workspaceId });
        this.forgetWorkspace(workspaceId);
        return result;
      }
      case 'listChats': return this.opListChats(this.str(params, 'workspaceId'));
      case 'newChat': return this.opOpenOrCreate(session, this.str(params, 'workspaceId'), undefined,
        typeof params.title === 'string' ? params.title : undefined);
      case 'openChat': return this.opOpenOrCreate(session, this.str(params, 'workspaceId'),
        this.str(params, 'conversationId'));
      case 'closeChat': {
        const key = this.watchKey(this.str(params, 'workspaceId'), this.str(params, 'conversationId'));
        session.watches.delete(key);
        this.releaseWatchIfUnused(key);
        return true;
      }
      case 'renameChat': return this.chatManagerRequest(this.str(params, 'workspaceId'), 'renameConversation', {
        conversationId: this.str(params, 'conversationId'), title: this.str(params, 'title'),
      });
      case 'deleteChat': {
        const workspaceId = this.str(params, 'workspaceId');
        const conversationId = this.str(params, 'conversationId');
        const result = await this.chatManagerRequest(workspaceId, 'deleteConversation', { conversationId });
        this.dropSubscription(this.watchKey(workspaceId, conversationId), /* chatGone */ true);
        return result;
      }
      case 'send': return this.opSend(session, this.str(params, 'workspaceId'),
        this.str(params, 'conversationId'), this.str(params, 'message'));
      case 'history': return this.chatManagerRequest(this.str(params, 'workspaceId'), 'getHistory', {
        conversationId: this.str(params, 'conversationId'),
      });
      case 'stopGoal':
      case 'pauseGoal':
      case 'resumeGoal':
        return this.opGoalControl(op, this.str(params, 'workspaceId'), this.str(params, 'conversationId'));
      case 'goalStatus':
        return this.opGoalStatus(this.str(params, 'workspaceId'), this.str(params, 'goalId'));
      case 'respondDialog': {
        // Routed through WidgetManager's respondDialog gate: dialogs refuse
        // direct respond messages, and the gate only accepts boot-registered
        // responders (this object).
        if (!this.widgetManagerId) throw new Error('Dialog gateway unavailable');
        const dialogId = this.str(params, 'dialogId');
        const confirmed = params.confirmed === true;
        const value = typeof params.value === 'string' ? params.value : undefined;
        const option = typeof params.option === 'string' ? params.option : undefined;
        return this.request<boolean>(
          request(this.id, this.widgetManagerId, 'respondDialog', { dialogId, confirmed, value, option }), 15000);
      }
      default:
        throw new Error(`Unknown op: ${op}`);
    }
  }

  private str(params: Record<string, unknown>, name: string): string {
    const value = params[name];
    contractRequire(typeof value === 'string' && value.length > 0, `${name} must be a non-empty string`);
    return value as string;
  }

  // ── Ops ───────────────────────────────────────────────────────────────

  private async opListWorkspaces(): Promise<unknown> {
    const [list, active] = await Promise.all([
      this.wsmRequest<Array<{ id: string; name: string; accessMode: string }>>('listWorkspaces', {}),
      this.wsmRequest<{ id: string } | null>('getActiveWorkspace', {}),
    ]);
    return list.map(ws => ({ ...ws, active: ws.id === active?.id }));
  }

  /** Roster row as returned by ChatManager.listConversations. */
  private async fetchRoster(workspaceId: string): Promise<Array<{
    conversationId: string; title: string; createdAt: number; lastActiveAt: number; chatId?: AbjectId;
  }>> {
    return this.chatManagerRequest(workspaceId, 'listConversations', {});
  }

  /** Is this spawned Chat currently showing a window? */
  private async chatVisible(chatId: AbjectId): Promise<boolean> {
    try {
      const state = await this.request<{ visible?: boolean }>(
        request(this.id, chatId, 'getState', {}), 5000);
      return state.visible === true;
    } catch {
      return false;
    }
  }

  /**
   * The conversation roster with an `open` flag marking chats whose window is
   * currently on the desktop — terminal clients open a tab per open chat.
   */
  private async opListChats(workspaceId: string): Promise<unknown> {
    const roster = await this.fetchRoster(workspaceId);
    return Promise.all(roster.map(async (row) => ({
      conversationId: row.conversationId,
      title: row.title,
      createdAt: row.createdAt,
      lastActiveAt: row.lastActiveAt,
      open: row.chatId ? await this.chatVisible(row.chatId) : false,
    })));
  }

  /**
   * Open an existing conversation (or create a new one) in a workspace,
   * subscribe this session to its events, and return its ids.
   */
  private async opOpenOrCreate(
    session: CliSession,
    workspaceId: string,
    conversationId?: string,
    title?: string,
  ): Promise<{ conversationId: string; chatId: string }> {
    let opened: { conversationId: string; chatId: string };
    if (conversationId) {
      // A chat whose window is already on the desktop is attached as-is —
      // re-showing it would raise the window on every CLI connect.
      const row = (await this.fetchRoster(workspaceId)).find(r => r.conversationId === conversationId);
      if (row?.chatId && await this.chatVisible(row.chatId)) {
        opened = { conversationId, chatId: row.chatId };
      } else {
        const result = await this.chatManagerRequest<{ conversationId: string; chatId: string } | false>(
          workspaceId, 'showConversation', { conversationId }, 20000);
        if (!result || !result.chatId) throw new Error(`Conversation not found or failed to open: ${conversationId}`);
        opened = result;
      }
    } else {
      opened = await this.chatManagerRequest<{ conversationId: string; chatId: string }>(
        workspaceId, 'newConversation', { title }, 20000);
      if (!opened.chatId) throw new Error('Failed to create conversation');
    }

    const key = this.watchKey(workspaceId, opened.conversationId);
    await this.ensureSubscription(key, workspaceId, opened.conversationId, opened.chatId as AbjectId);
    session.watches.add(key);
    return opened;
  }

  private async opSend(
    session: CliSession,
    workspaceId: string,
    conversationId: string,
    text: string,
  ): Promise<boolean> {
    const key = this.watchKey(workspaceId, conversationId);
    let sub = this.chatSubs.get(key);
    if (!sub) {
      // Not open yet (e.g. after a reconnect) — open it, which also subscribes.
      await this.opOpenOrCreate(session, workspaceId, conversationId);
      sub = this.chatSubs.get(key);
    }
    if (!sub) throw new Error(`No open chat for conversation ${conversationId}`);
    return this.request<boolean>(
      request(this.id, sub.chatId, 'sendMessage', { message: text }), 15000);
  }

  private async opGoalControl(
    op: 'stopGoal' | 'pauseGoal' | 'resumeGoal',
    workspaceId: string,
    conversationId: string,
  ): Promise<boolean> {
    const goalId = await this.chatManagerRequest<string | null>(
      workspaceId, 'getActiveGoal', { conversationId });
    if (!goalId) throw new Error('No active goal for this conversation');
    const deps = await this.resolveWorkspaceDeps(workspaceId);
    if (!deps.goalManagerId) throw new Error('GoalManager not available in this workspace');
    return this.request<boolean>(
      request(this.id, deps.goalManagerId, op, { goalId }), 15000);
  }

  /**
   * A goal's live detail — title/status plus its task list — so terminals
   * can render the same goal tree the desktop chat shows.
   */
  private async opGoalStatus(workspaceId: string, goalId: string): Promise<unknown> {
    const deps = await this.resolveWorkspaceDeps(workspaceId);
    if (!deps.goalManagerId) throw new Error('GoalManager not available in this workspace');
    const [goal, tuples] = await Promise.all([
      this.request<{ id: string; title: string; description?: string; status: string; error?: string } | null>(
        request(this.id, deps.goalManagerId, 'getGoal', { goalId })),
      this.request<Array<{ id: string; fields?: Record<string, unknown> }>>(
        request(this.id, deps.goalManagerId, 'getTasksForGoal', { goalId })).catch(() => []),
    ]);
    if (!goal) return null;
    return {
      goalId: goal.id,
      title: goal.title,
      description: goal.description,
      status: goal.status,
      error: goal.error,
      tasks: (tuples ?? []).map(t => ({
        id: t.id,
        description: String(t.fields?.description ?? ''),
        status: String(t.fields?.status ?? 'pending'),
        agentName: typeof t.fields?.agentName === 'string' ? t.fields.agentName : undefined,
      })),
    };
  }

  // ── Workspace dependency resolution ──────────────────────────────────

  private async resolveWorkspaceManager(): Promise<AbjectId> {
    if (!this.workspaceManagerId) {
      this.workspaceManagerId = await this.requireDep('WorkspaceManager');
    }
    return this.workspaceManagerId;
  }

  private async wsmRequest<T = unknown>(method: string, payload: unknown): Promise<T> {
    const wsmId = await this.resolveWorkspaceManager();
    return this.request<T>(request(this.id, wsmId, method, payload));
  }

  private async resolveWorkspaceDeps(workspaceId: string): Promise<WorkspaceDeps> {
    const cached = this.depsByWorkspace.get(workspaceId);
    if (cached) return cached;

    const detailed = await this.wsmRequest<Array<{ workspaceId: string; registryId: AbjectId }>>(
      'listWorkspacesDetailed', {});
    const entry = detailed.find(w => w.workspaceId === workspaceId);
    if (!entry) throw new Error(`Unknown workspace: ${workspaceId}`);

    const chatManagerId = await this.discoverInRegistry(entry.registryId, 'ChatManager');
    if (!chatManagerId) throw new Error(`ChatManager not found in workspace ${workspaceId}`);
    const goalManagerId = await this.discoverInRegistry(entry.registryId, 'GoalManager') ?? undefined;

    const deps: WorkspaceDeps = { registryId: entry.registryId, chatManagerId, goalManagerId };
    this.depsByWorkspace.set(workspaceId, deps);
    this.chatManagerToWorkspace.set(chatManagerId, workspaceId);
    // Roster events keep terminal chat lists live without polling.
    this.send(request(this.id, chatManagerId, 'addDependent', {}));

    // Toasts: NotificationCenter is a UI object that only exists in
    // workspaces that have been active at least once — subscribe when present.
    const notificationCenterId = await this.discoverInRegistry(entry.registryId, 'NotificationCenter');
    if (notificationCenterId) {
      this.notificationCenterToWorkspace.set(notificationCenterId, workspaceId);
      this.send(request(this.id, notificationCenterId, 'addDependent', {}));
    }
    return deps;
  }

  private async discoverInRegistry(registryId: AbjectId, name: string): Promise<AbjectId | null> {
    const results = await this.request<Array<{ id: AbjectId }>>(
      request(this.id, registryId, 'discover', { name }));
    return results.length > 0 ? results[0].id : null;
  }

  private async chatManagerRequest<T = unknown>(
    workspaceId: string,
    method: string,
    payload: unknown,
    timeoutMs = 30000,
  ): Promise<T> {
    const deps = await this.resolveWorkspaceDeps(workspaceId);
    return this.request<T>(request(this.id, deps.chatManagerId, method, payload), timeoutMs);
  }

  /** Drop all cached ids for a deleted workspace and its goal/roster routing. */
  private forgetWorkspace(workspaceId: string): void {
    const deps = this.depsByWorkspace.get(workspaceId);
    if (deps) {
      this.chatManagerToWorkspace.delete(deps.chatManagerId);
      if (deps.goalManagerId) this.goalManagerToWorkspace.delete(deps.goalManagerId);
      this.depsByWorkspace.delete(workspaceId);
    }
    for (const [ncId, wsId] of this.notificationCenterToWorkspace) {
      if (wsId === workspaceId) this.notificationCenterToWorkspace.delete(ncId);
    }
    for (const [key, sub] of this.chatSubs) {
      if (sub.workspaceId === workspaceId) this.dropSubscription(key, /* chatGone */ true);
    }
  }

  // ── Chat subscription refcounting ────────────────────────────────────

  private watchKey(workspaceId: string, conversationId: string): string {
    return `${workspaceId}:${conversationId}`;
  }

  /**
   * Subscribe to a Chat's events (idempotent). A lazily-respawned Chat gets a
   * fresh AbjectId, so an existing sub for the same conversation is re-pointed
   * when the id changes.
   */
  private async ensureSubscription(
    key: string,
    workspaceId: string,
    conversationId: string,
    chatId: AbjectId,
  ): Promise<void> {
    const existing = this.chatSubs.get(key);
    if (existing && existing.chatId === chatId) return;
    if (existing) this.chatIdToKey.delete(existing.chatId);

    this.chatSubs.set(key, { chatId, workspaceId, conversationId });
    this.chatIdToKey.set(chatId, key);
    this.send(request(this.id, chatId, 'addDependent', {}));

    // Goal progress is per-workspace: subscribe the first time a chat in this
    // workspace is watched (kept while any watch in the workspace remains).
    const deps = await this.resolveWorkspaceDeps(workspaceId);
    if (deps.goalManagerId && !this.goalManagerToWorkspace.has(deps.goalManagerId)) {
      this.goalManagerToWorkspace.set(deps.goalManagerId, workspaceId);
      this.send(request(this.id, deps.goalManagerId, 'addDependent', {}));
    }
  }

  /** Unsubscribe from a Chat when no session watches it anymore. */
  private releaseWatchIfUnused(key: string): void {
    for (const session of this.clients) {
      if (session.watches.has(key)) return;
    }
    this.dropSubscription(key, /* chatGone */ false);
  }

  private dropSubscription(key: string, chatGone: boolean): void {
    const sub = this.chatSubs.get(key);
    if (!sub) return;
    this.chatSubs.delete(key);
    this.chatIdToKey.delete(sub.chatId);
    for (const session of this.clients) session.watches.delete(key);
    if (!chatGone) {
      try { this.send(request(this.id, sub.chatId, 'removeDependent', {})); } catch { /* chat may be gone */ }
    }

    // Release the workspace's GoalManager subscription when its last chat
    // watch goes away.
    const deps = this.depsByWorkspace.get(sub.workspaceId);
    if (deps?.goalManagerId) {
      const stillWatched = [...this.chatSubs.values()].some(s => s.workspaceId === sub.workspaceId);
      if (!stillWatched) {
        this.goalManagerToWorkspace.delete(deps.goalManagerId);
        try { this.send(request(this.id, deps.goalManagerId, 'removeDependent', {})); } catch { /* gone */ }
      }
    }
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    contractRequire(this.port > 0, 'port must be positive');
    contractRequire(this.chatIdToKey.size === this.chatSubs.size,
      'chat id routing map must mirror subscription map');
  }
}

export const CLI_SERVER_ID = 'abjects:cli-server' as AbjectId;
