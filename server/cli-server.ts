/**
 * CliServer -- WebSocket gateway for terminal clients (the `abject` command).
 *
 * Listens on its own port (CLI_PORT, default 7723) and speaks a small JSON
 * protocol tailored for chat operations, mirroring how BackendUI serves the
 * browser on its own socket. Every chat op carries an explicit workspaceId,
 * so a single connection can drive conversations in any number of workspaces
 * at once. Auth shares the browser client's gate: same AuthConfig, same
 * SessionStore, so one login token works on both.
 *
 * Questions to the person (confirmations, permission prompts) come from
 * DialogBroker, which registers this object as a responder at boot: every
 * terminal is told of each question, can list the open ones, and can answer.
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
import { refuseAllOrigins } from '../src/network/origin-policy.js';
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
  /**
   * Interface to listen on: loopback unless set (CLI_BIND). A container
   * publishing the gateway binds 0.0.0.0, and then wants a login.
   */
  bind?: string;
  authConfig: AuthConfig;
  sessions: SessionStore;
  /** Stop this backend (`abject stop`): the same way out as SIGTERM. */
  requestShutdown?: () => void;
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

/** Goal aspects forwarded to terminal clients as progress lines. */
const GOAL_ASPECTS = [
  'goalCreated', 'goalUpdated', 'goalCompleted', 'goalFailed',
  'goalPaused', 'goalResumed', 'scrumPlanned',
  'taskCompleted', 'taskPermanentlyFailed', 'taskUnblocked',
  'goalInterjection', 'goalClarificationRequested',
] as const;

/**
 * A dialog as terminals receive it: the broker's open dialog, with an options
 * dialog's grouped answers also flattened into `options` for clients that list
 * them in one column.
 */
function dialogView(payload: unknown): Record<string, unknown> {
  const d = (payload ?? {}) as Record<string, unknown> & {
    groups?: Array<{ label: string; options: Array<{ id: string; label: string; tone?: string }> }>;
  };
  const options = Array.isArray(d.groups)
    ? d.groups.flatMap(g => g.options.map(o => ({ id: o.id, label: o.label, group: g.label, tone: o.tone })))
    : undefined;
  return { ...d, ...(options ? { options } : {}) };
}

export class CliServer extends Abject {
  private wsServer: NodeWebSocketServer | null = null;
  private port: number;
  private readonly bind: string;
  private readonly authConfig: AuthConfig;
  private readonly sessions: SessionStore;
  private readonly requestShutdown?: () => void;

  private clients: Set<CliSession> = new Set();
  private workspaceManagerId?: AbjectId;
  private dialogBrokerId?: AbjectId;
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
        tags: ['system'],
      },
    });

    contractRequire(args.port > 0, 'port must be positive');
    contractRequire(args.bind === undefined || args.bind.trim().length > 0, 'CliServer: bind must name an interface');
    this.port = args.port;
    this.bind = args.bind?.trim() || '127.0.0.1';
    this.authConfig = args.authConfig;
    this.sessions = args.sessions;
    this.requestShutdown = args.requestShutdown;
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

    // Questions from DialogBroker: broadcast so any terminal can answer (the
    // first answer wins, on a desktop or here; the rest see dialogClosed).
    this.on('dialogOpened', async (msg: AbjectMessage) => {
      if (!(await this.fromDialogBroker(msg))) return;
      this.broadcast({ event: 'dialog', workspaceId: '', data: dialogView(msg.payload) });
    });

    this.on('dialogClosed', async (msg: AbjectMessage) => {
      if (!(await this.fromDialogBroker(msg))) return;
      this.broadcast({ event: 'dialogClosed', workspaceId: '', data: msg.payload });
    });

    // Global settings changed (from here, the Settings window, or elsewhere).
    this.on('settingsChanged', (msg: AbjectMessage) => {
      if (msg.routing.from !== this.globalDeps.get('SettingsManager')) return;
      this.broadcast({ event: 'settingsChanged', workspaceId: '', data: msg.payload });
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
    // Questions to the person reach us from DialogBroker once the bootstrap
    // registers this object as a responder; nothing to subscribe to here.
    this.dialogBrokerId = await this.discoverDep('DialogBroker') ?? undefined;

    // Settings changes, so an open settings view repaints whoever made them.
    const settingsManagerId = await this.discoverDep('SettingsManager');
    if (settingsManagerId) {
      this.globalDeps.set('SettingsManager', settingsManagerId);
      this.send(request(this.id, settingsManagerId, 'addDependent', {}));
    }

    this.wsServer = new NodeWebSocketServer({
      port: this.port,
      host: this.bind,
      perMessageDeflate: false,
      // No browser client speaks this protocol; the `abject` command and scripts send no
      // Origin. A web page has no business here: it could send to agents and
      // answer their permission dialogs (respondDialog).
      allowOrigin: refuseAllOrigins,
    });
    this.wsServer.onConnection((ws) => this.handleConnection(ws));
    await this.wsServer.ready();
    log.info(`CLI gateway listening on ${this.bind}:${this.port} (auth ${this.authConfig.enabled ? 'enabled' : 'disabled'})`);
    if (!isLoopback(this.bind) && !this.authConfig.enabled) {
      log.warn(`CLI gateway is reachable beyond this machine (${this.bind}) with no login: set one (abject setup, or ABJECTS_AUTH_USER/ABJECTS_AUTH_PASSWORD)`);
    }
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
      case 'createWorkspace': return this.wsmRequest('createWorkspace', {
        name: this.str(params, 'name'),
        ...(typeof params.profile === 'string' && params.profile !== '' ? { profile: params.profile } : {}),
      });
      case 'listProfiles': return this.wsmRequest('listProfiles', {});
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
        // DialogBroker takes answers only from the surfaces registered at
        // boot, this object among them.
        const dialogId = this.str(params, 'dialogId');
        const confirmed = params.confirmed === true;
        const value = typeof params.value === 'string' ? params.value : undefined;
        const option = typeof params.option === 'string' ? params.option : undefined;
        return this.depRequest<boolean>('DialogBroker', 'respond', { dialogId, confirmed, value, option }, 15000);
      }
      case 'listDialogs': {
        const open = await this.depRequest<unknown[]>('DialogBroker', 'listOpen', {});
        return (open ?? []).map(dialogView);
      }

      // ── This instance ────────────────────────────────────────────────
      case 'instanceInfo': return this.depRequest('InstanceInfo', 'getInfo', {});
      case 'shutdown': {
        // Every terminal client here got past the gate (or none is required),
        // and could already do far more than stop the backend.
        contractRequire(!!this.requestShutdown, 'This backend cannot be stopped from a terminal');
        log.info('Shutdown requested by a terminal client');
        // After the reply goes out, so the client hears that it worked.
        setTimeout(() => this.requestShutdown!(), 100);
        return true;
      }
      case 'isConfigured': return this.settingsRequest('isConfigured', {});

      // ── External projects (trust and autonomy are the person's call) ──
      case 'listProjects': return this.projectRequest(this.str(params, 'workspaceId'), 'listProjects', {});
      case 'setProjectTrusted': return this.projectRequest(this.str(params, 'workspaceId'), 'setTrusted', {
        name: this.str(params, 'name'), trusted: params.trusted === true,
      });
      case 'setProjectAutonomy': return this.projectRequest(this.str(params, 'workspaceId'), 'setAutonomy', {
        name: this.str(params, 'name'), autonomy: this.str(params, 'autonomy'),
      });

      // ── Settings ──────────────────────────────────────────────────────
      // Global settings go to SettingsManager, which takes changes from this
      // object and the Settings window only and never hands secrets out.
      // Workspace settings go to the abjects that own them. A fixed set of
      // ops, not a general call: this socket may have no login.
      case 'getSettingsSchema': return this.settingsRequest('getSettingsSchema', {});
      case 'getSettings': return this.settingsRequest('getSettings',
        typeof params.section === 'string' && params.section !== '' ? { section: params.section } : {});
      case 'setSettings': return this.settingsRequest('setSettings', {
        section: this.str(params, 'section'), values: this.obj(params, 'values'),
      }, 60_000);
      case 'listPresets': return this.settingsRequest('listPresets', {}, 60_000);
      case 'applyPreset': return this.settingsRequest('applyPreset', { name: this.str(params, 'name') }, 60_000);
      case 'savePreset': return this.settingsRequest('savePreset', { name: this.str(params, 'name') }, 60_000);
      case 'deletePreset': return this.settingsRequest('deletePreset', { name: this.str(params, 'name') });
      case 'listModels': return this.settingsRequest('listModels', { provider: this.str(params, 'provider') }, 60_000);
      case 'getWorkspaceSettings': return this.opGetWorkspaceSettings(this.str(params, 'workspaceId'));
      case 'setWorkspaceSettings': return this.opSetWorkspaceSettings(
        this.str(params, 'workspaceId'), this.str(params, 'section'), this.obj(params, 'values'));
      case 'listPackages': return this.depRequest('Packages', 'list', {});
      case 'setPackageEnabled': return this.depRequest('Packages', 'setEnabled', {
        name: this.str(params, 'name'), enabled: params.enabled === true,
      });
      case 'setPackageSettings': return this.depRequest('Packages', 'setSettings', {
        name: this.str(params, 'name'), values: this.obj(params, 'values'),
      });
      case 'listSkills': return this.depRequest('SkillRegistry', 'listSkills', {});
      case 'setSkillEnabled': return this.depRequest('SkillRegistry',
        params.enabled === true ? 'enableSkill' : 'disableSkill', { name: this.str(params, 'name') }, 60_000);
      case 'getUpdateStatus': return this.opUpdates('status', params);
      case 'updateAction': return this.opUpdates(this.str(params, 'action'), params);

      default:
        throw new Error(`Unknown op: ${op}`);
    }
  }

  private obj(params: Record<string, unknown>, name: string): Record<string, unknown> {
    const value = params[name];
    contractRequire(!!value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
    return value as Record<string, unknown>;
  }

  /** Ids of global abjects these ops reach, found by name once. */
  private globalDeps = new Map<string, AbjectId>();

  private async depRequest<T = unknown>(name: string, method: string, payload: unknown, timeoutMs = 30_000): Promise<T> {
    let id = this.globalDeps.get(name);
    if (!id) {
      id = await this.discoverDep(name) ?? undefined;
      if (!id) throw new Error(`${name} is not running on this instance`);
      this.globalDeps.set(name, id);
    }
    try {
      return await this.request<T>(request(this.id, id, method, payload), timeoutMs);
    } catch (err) {
      // A respawned abject has a new id: look it up again next time.
      this.globalDeps.delete(name);
      throw err;
    }
  }

  private settingsRequest<T = unknown>(method: string, payload: unknown, timeoutMs?: number): Promise<T> {
    return this.depRequest<T>('SettingsManager', method, payload, timeoutMs);
  }

  /** Software updates (the packaged desktop app only): status, check, download, restart, auto-download. */
  private async opUpdates(action: string, params: Record<string, unknown>): Promise<unknown> {
    switch (action) {
      case 'status': return this.depRequest('AppUpdater', 'getStatus', {});
      case 'check': return this.depRequest('AppUpdater', 'checkNow', {}, 60_000);
      case 'download': return this.depRequest('AppUpdater', 'download', {});
      // The terminal asks about running goals before it sends this.
      case 'restart': return this.depRequest('AppUpdater', 'restartToUpdate', {}, 300_000);
      case 'autoDownload': return this.depRequest('AppUpdater', 'setAutoDownload', { enabled: params.enabled === true });
      default: throw new Error(`Unknown update action: ${action}. Actions: status, check, download, restart, autoDownload`);
    }
  }

  /** Everything a workspace's Settings window shows, in one read. */
  private async opGetWorkspaceSettings(workspaceId: string): Promise<unknown> {
    const detailed = await this.wsmRequest<Array<{
      workspaceId: string; name: string; accessMode: string; whitelist: string[];
      exposedObjectIds: string[]; registryId: AbjectId; joined?: boolean;
    }>>('listWorkspacesDetailed', {});
    const ws = detailed.find(w => w.workspaceId === workspaceId);
    if (!ws) throw new Error(`Unknown workspace: ${workspaceId}`);
    const [description, tags] = await Promise.all([
      this.wsmRequest<string>('getDescription', { workspaceId }),
      this.wsmRequest<string[]>('getTags', { workspaceId }),
    ]);
    const webExposureId = await this.discoverInRegistry(ws.registryId, 'WebExposure');
    const themeId = await this.discoverInRegistry(ws.registryId, 'Theme');
    const web = webExposureId ? await this.request<unknown>(request(this.id, webExposureId, 'getConfig', {})) : null;
    const theme = themeId ? {
      active: await this.request<string>(request(this.id, themeId, 'getActiveThemeId', {})),
      presets: (await this.request<Array<{ id: string; name: string }>>(request(this.id, themeId, 'listPresets', {})))
        .map(p => ({ id: p.id, name: p.name })),
    } : null;
    return {
      general: { name: ws.name, description: description ?? '', tags: tags ?? [] },
      access: { accessMode: ws.accessMode, whitelist: ws.whitelist ?? [], exposedObjectIds: ws.exposedObjectIds ?? [], joined: !!ws.joined },
      web,
      appearance: theme,
    };
  }

  /**
   * Change one section of a workspace's settings: general (name,
   * description, tags), access (accessMode, whitelist, exposedObjectIds),
   * web (enabled, entries: name to { access, methods?, mode?, handler? } or
   * null to remove), appearance (theme id).
   */
  private async opSetWorkspaceSettings(workspaceId: string, section: string, values: Record<string, unknown>): Promise<unknown> {
    const known = (allowed: string[]): void => {
      const unknown = Object.keys(values).filter(k => !allowed.includes(k));
      contractRequire(unknown.length === 0, `Unknown ${section} setting${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
    };
    const strings = (v: unknown, what: string): string[] => {
      contractRequire(Array.isArray(v) && v.every(x => typeof x === 'string'), `${what} must be a list of strings`);
      return v as string[];
    };
    const wsDeps = async (name: string): Promise<AbjectId> => {
      const detailed = await this.wsmRequest<Array<{ workspaceId: string; registryId: AbjectId }>>('listWorkspacesDetailed', {});
      const ws = detailed.find(w => w.workspaceId === workspaceId);
      if (!ws) throw new Error(`Unknown workspace: ${workspaceId}`);
      const id = await this.discoverInRegistry(ws.registryId, name);
      if (!id) throw new Error(`${name} is not running in this workspace`);
      return id;
    };
    switch (section) {
      case 'general': {
        known(['name', 'description', 'tags']);
        if (values.name !== undefined) await this.wsmRequest('renameWorkspace', { workspaceId, name: String(values.name) });
        if (values.description !== undefined) await this.wsmRequest('setDescription', { workspaceId, description: String(values.description) });
        if (values.tags !== undefined) await this.wsmRequest('setTags', { workspaceId, tags: strings(values.tags, 'tags') });
        break;
      }
      case 'access': {
        known(['accessMode', 'whitelist', 'exposedObjectIds']);
        if (values.accessMode !== undefined) await this.wsmRequest('setAccessMode', { workspaceId, accessMode: String(values.accessMode) });
        if (values.whitelist !== undefined) await this.wsmRequest('setWhitelist', { workspaceId, whitelist: strings(values.whitelist, 'whitelist') });
        if (values.exposedObjectIds !== undefined) await this.wsmRequest('setExposedObjects', { workspaceId, objectIds: strings(values.exposedObjectIds, 'exposedObjectIds') });
        break;
      }
      case 'web': {
        known(['enabled', 'entries']);
        const webExposureId = await wsDeps('WebExposure');
        const check = (r: { success?: boolean; error?: string } | undefined): void => {
          if (r && r.success === false) throw new Error(r.error ?? 'WebExposure refused the change');
        };
        if (values.enabled !== undefined) {
          check(await this.request(request(this.id, webExposureId, 'setEnabled', { enabled: values.enabled === true })));
        }
        if (values.entries !== undefined) {
          contractRequire(!!values.entries && typeof values.entries === 'object', 'entries must map abject name to an entry or null');
          for (const [name, entry] of Object.entries(values.entries as Record<string, unknown>)) {
            if (entry === null) check(await this.request(request(this.id, webExposureId, 'removeEntry', { name })));
            else check(await this.request(request(this.id, webExposureId, 'setEntry', { name, ...(entry as object) })));
          }
        }
        break;
      }
      case 'appearance': {
        known(['theme']);
        if (values.theme !== undefined) {
          const themeId = await wsDeps('Theme');
          await this.request(request(this.id, themeId, 'setThemeById', { id: String(values.theme) }));
        }
        break;
      }
      default:
        throw new Error(`Unknown workspace settings section: ${section}. Sections: general, access, web, appearance`);
    }
    return this.opGetWorkspaceSettings(workspaceId);
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
   * currently on a desktop (always false without one): terminal clients open
   * a tab per open chat.
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
    // A terminal talks to the conversation; it opens no window on any
    // desktop that happens to be attached to the same instance.
    let opened: { conversationId: string; chatId: string };
    if (conversationId) {
      const result = await this.chatManagerRequest<{ conversationId: string; chatId: string } | false>(
        workspaceId, 'openConversation', { conversationId }, 20000);
      if (!result || !result.chatId) throw new Error(`Conversation not found or failed to open: ${conversationId}`);
      opened = result;
    } else {
      opened = await this.chatManagerRequest<{ conversationId: string; chatId: string }>(
        workspaceId, 'newConversation', { title, show: false }, 20000);
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
    // Through the conversation when it is loaded, so its own record of the
    // goal (paused, stopping) stays true for every view of it.
    const sub = this.chatSubs.get(this.watchKey(workspaceId, conversationId));
    if (sub) return this.request<boolean>(request(this.id, sub.chatId, op, {}), 15000);
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
        // A round is a graph, and the terminal client cannot show one without
        // the edges. Dropping them here is why it could only ever show a list.
        dependsOn: Array.isArray(t.fields?.dependsOn) ? (t.fields.dependsOn as string[]) : undefined,
      })),
    };
  }

  /** Accept dialog events only from DialogBroker itself. */
  private async fromDialogBroker(msg: AbjectMessage): Promise<boolean> {
    this.dialogBrokerId = await this.resolveDep('DialogBroker', this.dialogBrokerId);
    return !!this.dialogBrokerId && msg.routing.from === this.dialogBrokerId;
  }

  /** A request to a workspace's ExternalProjectRegistry. */
  private async projectRequest(workspaceId: string, method: string, payload: unknown): Promise<unknown> {
    const deps = await this.resolveWorkspaceDeps(workspaceId);
    const registryId = await this.discoverInRegistry(deps.registryId, 'ExternalProjectRegistry');
    if (!registryId) throw new Error('This workspace has no external projects');
    const result = await this.request<unknown>(request(this.id, registryId, method, payload));
    const failed = result as { success?: boolean; error?: string } | null;
    if (failed && failed.success === false) throw new Error(failed.error ?? `${method} was refused`);
    return result;
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
    if (cached) {
      void this.ensureNotifications(workspaceId, cached.registryId);
      return cached;
    }

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

    await this.ensureNotifications(workspaceId, entry.registryId);
    return deps;
  }

  /**
   * Subscribe to a workspace's NotificationCenter so its notifications reach
   * terminals. Checked again on later use, so one that respawned (a new id) or
   * came up late is picked up rather than missed for the life of the gateway.
   */
  private async ensureNotifications(workspaceId: string, registryId: AbjectId): Promise<void> {
    const id = await this.discoverInRegistry(registryId, 'NotificationCenter').catch(() => null);
    if (!id || this.notificationCenterToWorkspace.has(id)) return;
    for (const [known, ws] of this.notificationCenterToWorkspace) {
      if (ws === workspaceId) this.notificationCenterToWorkspace.delete(known);
    }
    this.notificationCenterToWorkspace.set(id, workspaceId);
    this.send(request(this.id, id, 'addDependent', {}));
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
