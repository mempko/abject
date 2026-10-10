/**
 * The backend bootstrap shared by both editions.
 *
 * Everything that runs whether or not there is a display lives here: the
 * runtime, the capabilities, the agents, the settings and permission objects,
 * the peer layer, the terminal gateway and the workspaces. The desktop edition
 * (server/index.ts) hands in a UiLayer (server/ui-layer.ts) that adds the
 * display server, the windows and the browser socket at fixed points; the
 * headless edition (server/headless.ts) hands in none. Nothing here imports a
 * window, a widget or the display server, so the headless bundle carries none.
 */

import { AgentEvaluation } from '../src/objects/agent-evaluation.js';
import { TaskSession } from '../src/objects/task-session.js';
import { AbjectId, TypeId, AbjectMessage, SpawnResult } from '../src/core/types.js';
import { getRuntime, resetRuntime, type Runtime } from '../src/runtime/runtime.js';
import * as message from '../src/core/message.js';
import { require as contractRequire } from '../src/core/contracts.js';
import { LLMObject } from '../src/objects/llm-object.js';
import { ObjectCreator } from '../src/objects/object-creator.js';
import { ProxyGenerator } from '../src/objects/proxy-generator.js';
import { Negotiator } from '../src/protocol/negotiator.js';
import { HealthMonitor } from '../src/protocol/health-monitor.js';
import { CassetteRecorder } from '../src/objects/cassette-recorder.js';
import { HttpClient } from '../src/objects/capabilities/http-client.js';
import { NodeStorage } from './node-storage.js';
import { Timer } from '../src/objects/capabilities/timer.js';
import { Clipboard } from '../src/objects/capabilities/clipboard.js';
import { Console } from '../src/objects/capabilities/console.js';
import { FileSystem } from '../src/objects/capabilities/filesystem.js';
import { WebParser } from '../src/objects/capabilities/web-parser.js';
import { WebBrowser } from '../src/objects/capabilities/web-browser.js';
import { WebAgent } from '../src/objects/web-agent.js';
import { NotificationCenter } from '../src/objects/notification-center.js';
import { ObjectCatalog } from '../src/objects/object-catalog.js';
import { ThemeAbject } from '../src/objects/theme.js';
import { JobManager } from '../src/objects/job-manager.js';
import { GoalManager } from '../src/objects/goal-manager.js';
import { AgentCreator } from '../src/objects/agent-creator.js';
import { Scheduler } from '../src/objects/scheduler.js';
import { Chat } from '../src/objects/chat.js';
import { ChatManager } from '../src/objects/chat-manager.js';
import { AgentAbject } from '../src/objects/agent-abject.js';
import { ScrumMaster } from '../src/objects/scrum-master.js';
import { GoalObserver } from '../src/objects/goal-observer.js';
import { TaskReviewer } from '../src/objects/task-reviewer.js';
import { AbjectStore } from '../src/objects/abject-store.js';
import { Supervisor } from '../src/runtime/supervisor.js';
import { signalChild, type TrackedChild } from '../src/runtime/child-processes.js';
import type { RestartType } from '../src/runtime/supervisor.js';
import { WorkspaceManager } from '../src/objects/workspace-manager.js';
import { WorkerRecovery } from '../src/objects/worker-recovery.js';
import { WorkspaceRegistry } from '../src/objects/workspace-registry.js';
import { SettingsManager } from '../src/objects/settings-manager.js';
import { PermissionBroker } from '../src/objects/permission-broker.js';
import { DialogBroker } from '../src/objects/dialog-broker.js';
import { HeapMonitor } from '../src/objects/heap-monitor.js';
import { IdentityObject } from '../src/objects/identity.js';
import { PeerRegistry } from '../src/objects/peer-registry.js';
import { RemoteRegistry } from '../src/objects/remote-registry.js';
import { PeerRouter } from '../src/network/peer-router.js';
import { SignalingRelayObject } from '../src/objects/signaling-relay.js';
import { PeerDiscoveryObject } from '../src/objects/peer-discovery.js';
import { SharedState } from '../src/objects/capabilities/shared-state.js';
import { TupleSpace } from '../src/objects/tuple-space.js';
import { TriggerManager } from '../src/objects/trigger-manager.js';
import { CollectionStore } from '../src/objects/collection-store.js';
import { FileTransfer } from '../src/objects/capabilities/file-transfer.js';
import { MediaStreamCapability } from '../src/objects/capabilities/media-stream.js';
import { WorkspaceShareRegistry, WORKSPACE_SHARE_REGISTRY_ID } from '../src/objects/workspace-share-registry.js';
import { ShellExecutor } from '../src/objects/capabilities/shell-executor.js';
import { HostFileSystem } from '../src/objects/capabilities/host-filesystem.js';
import { WebSearch } from '../src/objects/capabilities/web-search.js';
import { WebFetch } from '../src/objects/capabilities/web-fetch.js';
import { StreamClient } from '../src/objects/capabilities/stream-client.js';
import { SkillRegistry } from '../src/objects/skill-registry.js';
import { SkillAgent } from '../src/objects/skill-agent.js';
import { ObjectAgent } from '../src/objects/object-agent.js';
import { ExternalProjectRegistry } from '../src/objects/external-project-registry.js';
import { ExternalCreator } from '../src/objects/external-creator.js';
import { MCPBridge } from '../src/objects/mcp-bridge.js';
import { MCPRegistryClient } from '../src/objects/mcp-registry-client.js';
import { ClawHubClient } from '../src/objects/clawhub-client.js';
import { SecretsVault } from '../src/objects/secrets-vault.js';
import { Packages } from '../src/objects/packages.js';
import { InstanceInfo, instanceReport, type InstanceInfoSource } from '../src/objects/instance-info.js';
import { Crypto } from '../src/objects/capabilities/crypto.js';
import { abjectVersion } from './version.js';
import { OAuthHelper } from '../src/objects/oauth-helper.js';
import type { UITransportLike } from '../src/network/webrtc-ui-transport.js';
import { WasmAbject } from '../src/objects/wasm-abject.js';
import type { WasmAbjectArgs } from '../src/objects/wasm-abject.js';
import { ingestAllExtensions } from '../src/sandbox/extensions.js';
import type { MCPBridgeConfig } from '../src/objects/mcp-bridge.js';
import { NodeWorkerAdapter, planWorkerHeaps, workerHeapMb } from './node-worker-adapter.js';
import { DedicatedWorkerBridge } from '../src/runtime/dedicated-worker-bridge.js';
import { loadAuthConfig, SessionStore, type AuthConfig } from './auth.js';
import { AuthGate } from './auth-gate.js';
import { CliServer } from './cli-server.js';
import { WebGateway } from '../src/objects/web-gateway.js';
import { WebExposure } from '../src/objects/web-exposure.js';
import { Log } from '../src/core/timed-log.js';
import {
  assertNoOtherBackend, newOwnerToken, removeInstance, writeInstance, DETACHED_ENV, type Edition,
} from './instance-file.js';
import * as http from 'node:http';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { MessagePort } from 'node:worker_threads';
import type { PeerId } from '../src/core/identity.js';

const WS_PORT = parseInt(process.env.WS_PORT ?? '7719', 10);
/**
 * The CLI gateway's port, derived from WS_PORT rather than defaulted flat.
 *
 * A second instance is started by handing it its own WS_PORT (see the
 * awaken2/awaken3 scripts). When the CLI gateway arrived it brought a second
 * port that defaulted to a constant, so every instance quietly raced for the
 * same 7723: whichever booted first won and the rest died at startup with an
 * EADDRINUSE that named a port nobody had chosen. Deriving it means a new
 * instance needs one decision, not two, and the next per-instance port should
 * follow the same rule.
 *
 * The offset preserves the historical default: the stock 7719 still yields
 * 7723. It does assume WS ports stay clustered below that band, which the
 * current 7719/7721/7722 ladder does.
 */
const CLI_PORT_OFFSET = 4;
const CLI_PORT = parseInt(process.env.CLI_PORT ?? String(WS_PORT + CLI_PORT_OFFSET), 10);
// The HTTP gateway's port follows WS_PORT the same way, one past the CLI, so
// a second instance (awaken2/awaken3) does not collide. HTTP_BIND stays
// loopback unless set; a public bind is the user's deliberate choice.
const HTTP_GATEWAY_PORT_OFFSET = 5;
const HTTP_PORT = parseInt(process.env.HTTP_PORT ?? String(WS_PORT + HTTP_GATEWAY_PORT_OFFSET), 10);
const DATA_DIR = process.env.ABJECTS_DATA_DIR ?? '.abjects';
/** Dedicated threads for the peer layer (and, on a desktop, the display server). */
const DEDICATED_WORKERS = process.env.ABJECTS_DEDICATED_WORKERS !== '0'; // default: enabled
const alog = new Log('ABJECTS');

/** What the bootstrap hands a UiLayer at each of its points. */
export interface BootContext {
  runtime: Runtime;
  log: Log;
  alog: Log;
  /** Dedicated worker threads (UI and P2P) are on. */
  dedicatedWorkers: boolean;
  wsPort: number;
  registryId: AbjectId;
  authConfig: AuthConfig;
  sessionStore: SessionStore;
  instanceSource: InstanceInfoSource;
  bootstrapRequest<T>(target: AbjectId, method: string, payload: unknown): Promise<T>;
  supervisedSpawn(name: string, restart?: RestartType, typeId?: TypeId): Promise<AbjectId>;
  systemTypeId(name: string): TypeId | undefined;
}

/**
 * The display half of the desktop edition. Each method is called once, at the
 * point of the bootstrap its name says. The headless edition passes none.
 */
export interface UiLayer {
  /** Constructor names (UI) that may run on the worker pool. */
  readonly workerEligible: readonly string[];
  /** Before the runtime starts: a display server on the main thread registers here. */
  beforeRuntimeStart(runtime: Runtime): Promise<void>;
  /** After it starts: the UI worker and the display server's registration. */
  afterRuntimeStart(ctx: BootContext): Promise<void>;
  /**
   * The browser UI socket on WS_PORT. It answers the health endpoint too, so
   * the bootstrap opens no health server of its own when there is one.
   */
  openSocket(ctx: BootContext, health: HealthResponder): Promise<void>;
  registerConstructors(ctx: BootContext): void;
  /** Before WebBrowser spawns: the desktop app's own browser windows. */
  beforeWebBrowser(ctx: BootContext): Promise<void>;
  /** The display capabilities and window system; registers the dialog presenter for confirm and prompt. */
  spawnDisplay(ctx: BootContext, dialogBrokerId: AbjectId): Promise<void>;
  /** The P2P layer is up: paired remote browsers attach through these. */
  remoteUiAttach(peerId: string, transport: UITransportLike, meta?: { name?: string }): void;
  portToUITransport(port: MessagePort): UITransportLike;
  /** After SettingsManager: the Settings window, which presents permission prompts. */
  spawnSettingsWindow(ctx: BootContext, dialogBrokerId: AbjectId): Promise<void>;
  /** The global windows and browsers, after the services they show. */
  spawnGlobalUi(ctx: BootContext): Promise<void>;
  /** After the workspaces: the windows over them. */
  spawnLateUi(ctx: BootContext): Promise<void>;
  /** Ids HealthMonitor should watch. */
  monitoredIds(): AbjectId[];
  /** Release the socket and the UI worker at shutdown. */
  release(): Promise<void>;
  /** Lines for the ready banner. */
  banner(): string[];
}

/** Answers GET /healthz and /version from the instance report. */
export type HealthResponder = (req: http.IncomingMessage, res: http.ServerResponse) => boolean;

export interface BootOptions {
  edition: Edition;
  /** The pool worker's entry for this edition. */
  workerScript: URL;
  /** The dedicated P2P worker's entry for this edition. */
  p2pWorkerScript: URL;
  /** The desktop's display layer; absent on the headless edition. */
  ui?: UiLayer;
}

/**
 * Tear the backend down without exiting, once it is running.
 *
 * The desktop app embeds this server in Electron's main process, so it needs
 * to release the ports and stop the worker pool at window close and then let
 * Electron run its own shutdown. Undefined until `bootServer()` has got far
 * enough for there to be anything to release.
 */
export let backendShutdown: (() => Promise<void>) | undefined;

export async function bootServer(options: BootOptions): Promise<void> {
  contractRequire(options.edition === 'desktop' || options.edition === 'headless', 'edition must be desktop or headless');
  contractRequire(options.edition === 'headless' ? !options.ui : !!options.ui, 'the desktop edition has a UI layer and the headless one has none');
  const ui = options.ui;
  const log = new Log('BOOTSTRAP');
  alog.info(`Initializing backend (${options.edition})...`);

  // One backend per data directory: a second one against the same SQLite
  // files and ports does not fail cleanly.
  const dataDirAbs = path.resolve(DATA_DIR);
  await assertNoOtherBackend(dataDirAbs);

  // Read API keys from environment
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const typesafeKey = process.env.TYPESAFE_API_KEY;

  // Reset any stale singleton state
  resetRuntime();

  // Auto-detect worker count from available CPU cores.
  // Leave 1 core for the main thread; minimum 1 worker.
  // Set ABJECTS_WORKER_COUNT=N env var to override (0 to disable workers).
  const cpuCount = os.cpus().length;
  const defaultWorkerCount = Math.min(8, Math.max(1, cpuCount - 1));
  const envOverride = process.env.ABJECTS_WORKER_COUNT;
  const workerCount = envOverride !== undefined ? parseInt(envOverride, 10) : defaultWorkerCount;
  const workerEnabled = workerCount > 0;
  // Heap ceilings are shared out over every worker thread: the pool and the
  // dedicated P2P worker, plus the UI worker on a desktop.
  planWorkerHeaps(workerCount + (DEDICATED_WORKERS ? (ui ? 2 : 1) : 0));

  // What InstanceInfo and the health endpoint report.
  let serving = false;
  const instanceSource: InstanceInfoSource = {
    version: abjectVersion(),
    startedAt: Date.now(),
    workerCount,
    edition: options.edition,
    ready: () => serving,
  };
  alog.info(`Abject ${instanceSource.version} (${options.edition}) on Node ${process.versions.node}; ` +
    `${workerCount} pool worker(s), heap ceiling ${workerHeapMb()} MB each`);

  // Create runtime
  const runtime = getRuntime({
    debug: !!process.env.DEBUG,
    workerEnabled,
    workerCount,
    workerFactory: workerEnabled
      ? () => new NodeWorkerAdapter(options.workerScript)
      : undefined,
  });

  if (!DEDICATED_WORKERS) {
    // Peer objects run on the main thread: polyfill WebRTC here.
    const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, RTCDataChannel } =
      await import('node-datachannel/polyfill');
    Object.assign(globalThis, { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, RTCDataChannel });
  }
  if (ui) await ui.beforeRuntimeStart(runtime);

  // Start runtime (bootstraps Registry + Factory)
  await runtime.start();
  log.timed('runtime started');

  const bus = runtime.messageBus;
  const factoryId = runtime.objectFactory.id;
  const registryId = runtime.objectRegistry.id;
  const BOOTSTRAP_ID = 'bootstrap' as AbjectId;

  // Register a temporary bootstrap sender on the bus for request-reply.
  // Replies arrive via the mailbox (same path as all other messages).
  const pendingReplies = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const bootMailbox = bus.register(BOOTSTRAP_ID);

  // Background loop reads replies from the bootstrap mailbox
  let bootDone = false;
  const bootLoop = (async () => {
    while (!bootDone) {
      let msg: AbjectMessage;
      try { msg = await bootMailbox.receive(); } catch { break; }
      const pending = pendingReplies.get(msg.header.correlationId!);
      if (pending) {
        pendingReplies.delete(msg.header.correlationId!);
        if (msg.header.type === 'error') {
          pending.reject(new Error((msg.payload as { message: string }).message));
        } else {
          pending.resolve(msg.payload);
        }
      }
    }
  })();

  function bootstrapRequest<T>(target: AbjectId, method: string, payload: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const msg = message.request(BOOTSTRAP_ID, target, method, payload);
      pendingReplies.set(msg.header.messageId, {
        resolve: resolve as (v: unknown) => void, reject,
      });
      bus.send(msg);
    });
  }

  async function factorySpawn(name: string, typeId?: TypeId): Promise<AbjectId> {
    const result = await bootstrapRequest<SpawnResult>(factoryId, 'spawn', {
      manifest: { name, description: '', version: '1.0.0',
                  tags: ['system'] },
      typeId,
    });
    return result.objectId;
  }

  // The login every socket checks. AuthGate (spawned below) is where a saved
  // login takes effect; until then the environment's login applies. The owner
  // token lets a local terminal in either way (see instance-file.ts).
  const ownerToken = newOwnerToken();
  const authConfig: AuthConfig = { ...loadAuthConfig(), ownerToken };
  const sessionStore = new SessionStore();

  let localPeerId: string | undefined;
  /** Compute a system-scoped TypeId: {peerId}/system/{name} */
  function systemTypeId(name: string): TypeId | undefined {
    if (!localPeerId) return undefined;
    return `${localPeerId}/system/${name}` as TypeId;
  }

  // Filled in once Supervisor exists; the context is handed out before that.
  let supervisorId: AbjectId | undefined;
  async function supervisedSpawn(name: string, restart: RestartType = 'permanent', typeId?: TypeId): Promise<AbjectId> {
    contractRequire(!!supervisorId, 'Supervisor must spawn before supervised objects');
    const id = await factorySpawn(name, typeId);
    await bootstrapRequest(supervisorId!, 'addChild', {
      id, constructorName: name, restart,
    });
    return id;
  }

  const ctx: BootContext = {
    runtime, log, alog,
    dedicatedWorkers: DEDICATED_WORKERS,
    wsPort: WS_PORT,
    registryId,
    authConfig, sessionStore, instanceSource,
    bootstrapRequest, supervisedSpawn, systemTypeId,
  };

  if (ui) await ui.afterRuntimeStart(ctx);

  // Local health and version, for a service manager, a host agent or the
  // `abject` command on the same machine (loopback only). 503 until boot has
  // finished. On a desktop the UI socket answers them on the same port.
  const health: HealthResponder = (req, res) => {
    const urlPath = (req.url ?? '').split('?')[0];
    if (req.method !== 'GET' || (urlPath !== '/healthz' && urlPath !== '/version')) return false;
    const report = instanceReport(instanceSource);
    const body = urlPath === '/version' ? { version: report.version }
      : { status: report.ready ? 'ok' : 'starting', ...report };
    res.writeHead(urlPath === '/healthz' && !report.ready ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return true;
  };
  let healthServer: http.Server | undefined;
  if (ui) {
    await ui.openSocket(ctx, health);
  } else {
    healthServer = http.createServer((req, res) => {
      if (health(req, res)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found\n');
    });
    await new Promise<void>((resolve, reject) => {
      healthServer!.once('error', reject);
      healthServer!.listen(WS_PORT, '127.0.0.1', () => { healthServer!.off('error', reject); resolve(); });
    });
    log.timed(`health endpoint listening on 127.0.0.1:${WS_PORT}`);
  }

  // Register constructors with Factory
  // CliServer shares the browser client's auth gate: the same live authConfig
  // (kept current by AuthGate) and the same SessionStore, so one login token
  // works on both sockets. Main thread only (owns live sockets), so it is
  // deliberately absent from workerEligible. Held so shutdown can release the
  // CLI port up front. Going through the runtime teardown to reach its onStop
  // means a teardown that wedges leaves this socket bound, and a bound CLI port
  // is what stops the NEXT `awaken` from starting at all.
  let cliServer: CliServer | undefined;
  runtime.objectFactory.registerConstructor('CliServer',
    () => (cliServer = new CliServer({
      port: CLI_PORT, bind: process.env.CLI_BIND, authConfig, sessions: sessionStore,
      // `abject stop`: the same way out as a SIGTERM, which the desktop app
      // routes through Electron's own quit.
      requestShutdown: () => { process.emit('SIGTERM'); },
    })));
  // The HTTP gateway shares the browser client's auth gate (session tokens)
  // and adds its own API tokens. Main-thread only, like CliServer: it holds a
  // listening socket. Its per-workspace config (WebExposure) and its window
  // (WebGatewayBrowser) are ordinary abjects.
  let webGateway: WebGateway | undefined;
  runtime.objectFactory.registerConstructor('WebGateway',
    () => (webGateway = new WebGateway({ port: HTTP_PORT, bind: process.env.HTTP_BIND, authConfig, sessions: sessionStore })));
  runtime.objectFactory.registerConstructor('WebExposure', () => new WebExposure());
  // Main thread only: it holds the live auth config the sockets read.
  runtime.objectFactory.registerConstructor('AuthGate', () => new AuthGate({ authConfig, sessions: sessionStore }));
  runtime.objectFactory.registerConstructor('DialogBroker', () => new DialogBroker());
  runtime.objectFactory.registerConstructor('HttpClient', () => new HttpClient());
  runtime.objectFactory.registerConstructor('LLMObject', () => new LLMObject());
  runtime.objectFactory.registerConstructor('Storage', (args?: unknown) => {
    const opts = args as { dbName?: string } | undefined;
    // For workspace storage, use a separate file path
    if (opts?.dbName) {
      const wsId = opts.dbName.replace('abjects-storage-', '');
      const storagePath = path.resolve(DATA_DIR, `ws-${wsId}`, 'storage.json');
      return new NodeStorage(storagePath);
    }
    return new NodeStorage(path.resolve(DATA_DIR, 'storage.json'));
  });
  runtime.objectFactory.registerConstructor('Timer', () => new Timer());
  runtime.objectFactory.registerConstructor('Clipboard', () => new Clipboard());
  runtime.objectFactory.registerConstructor('Console', () => new Console());
  runtime.objectFactory.registerConstructor('FileSystem', (args?: unknown) => {
    const opts = args as { workspaceId?: string } | undefined;
    return new FileSystem(opts?.workspaceId);
  });
  runtime.objectFactory.registerConstructor('Theme', () => new ThemeAbject());
  runtime.objectFactory.registerConstructor('ProxyGenerator', () => new ProxyGenerator());
  runtime.objectFactory.registerConstructor('Negotiator', () => new Negotiator());
  runtime.objectFactory.registerConstructor('HealthMonitor', () => new HealthMonitor());
  runtime.objectFactory.registerConstructor('CassetteRecorder', () => new CassetteRecorder());
  runtime.objectFactory.registerConstructor('ObjectCreator', () => new ObjectCreator());
  runtime.objectFactory.registerConstructor('NotificationCenter', () => new NotificationCenter());
  runtime.objectFactory.registerConstructor('ObjectCatalog', () => new ObjectCatalog());
  runtime.objectFactory.registerConstructor('JobManager', () => new JobManager());
  runtime.objectFactory.registerConstructor('GoalManager', () => new GoalManager());
  runtime.objectFactory.registerConstructor('AgentCreator', () => new AgentCreator());
  runtime.objectFactory.registerConstructor('Scheduler', () => new Scheduler());
  runtime.objectFactory.registerConstructor('Chat', (args?: unknown) => new Chat(args as { conversationId?: string; title?: string; rect?: { x: number; y: number; width: number; height: number } } | undefined));
  runtime.objectFactory.registerConstructor('ChatManager', () => new ChatManager());
  runtime.objectFactory.registerConstructor('AgentAbject', () => new AgentAbject());
  runtime.objectFactory.registerConstructor('ScrumMaster', () => new ScrumMaster());
  runtime.objectFactory.registerConstructor('GoalObserver', () => new GoalObserver());
  runtime.objectFactory.registerConstructor('TaskSession', () => new TaskSession());
  runtime.objectFactory.registerConstructor('AgentEvaluation', () => new AgentEvaluation());
  runtime.objectFactory.registerConstructor('TaskReviewer', () => new TaskReviewer());
  runtime.objectFactory.registerConstructor('AbjectStore', () => new AbjectStore());
  runtime.objectFactory.registerConstructor('Supervisor', () => new Supervisor());
  runtime.objectFactory.registerConstructor('WorkspaceManager', () => new WorkspaceManager());
  runtime.objectFactory.registerConstructor('WorkerRecovery', () => new WorkerRecovery());
  runtime.objectFactory.registerConstructor('WorkspaceRegistry', (args?: unknown) => new WorkspaceRegistry(args as { workspaceId?: string } | undefined));
  runtime.objectFactory.registerConstructor('SettingsManager', () => new SettingsManager());
  runtime.objectFactory.registerConstructor('PermissionBroker', () => new PermissionBroker());
  // Main-thread only, and absent from workerEligible on purpose: it reads the
  // pool's heap reports, and an object watching for a worker to die cannot
  // live inside one.
  runtime.objectFactory.registerConstructor('HeapMonitor',
    () => new HeapMonitor({ pool: runtime.workerPool }));
  runtime.objectFactory.registerConstructor('Identity', () => new IdentityObject());
  runtime.objectFactory.registerConstructor('PeerRegistry', () => new PeerRegistry());
  runtime.objectFactory.registerConstructor('RemoteRegistry', () => new RemoteRegistry());
  runtime.objectFactory.registerConstructor('PeerRouter', () => new PeerRouter());
  runtime.objectFactory.registerConstructor('SignalingRelay', () => new SignalingRelayObject());
  runtime.objectFactory.registerConstructor('PeerDiscovery', () => new PeerDiscoveryObject());
  runtime.objectFactory.registerConstructor('WorkspaceShareRegistry', () => new WorkspaceShareRegistry());
  runtime.objectFactory.registerConstructor('WebParser', () => new WebParser());
  runtime.objectFactory.registerConstructor('WebBrowser', () => new WebBrowser());
  runtime.objectFactory.registerConstructor('WebAgent', () => new WebAgent());
  runtime.objectFactory.registerConstructor('SharedState', () => new SharedState());
  runtime.objectFactory.registerConstructor('TupleSpace', () => new TupleSpace());
  runtime.objectFactory.registerConstructor('TriggerManager', () => new TriggerManager());
  runtime.objectFactory.registerConstructor('CollectionStore', () => new CollectionStore());
  runtime.objectFactory.registerConstructor('StreamClient', () => new StreamClient());
  runtime.objectFactory.registerConstructor('FileTransfer', () => new FileTransfer());
  runtime.objectFactory.registerConstructor('MediaStream', () => new MediaStreamCapability());
  runtime.objectFactory.registerConstructor('ShellExecutor', () => new ShellExecutor());
  runtime.objectFactory.registerConstructor('HostFileSystem', () => new HostFileSystem());
  runtime.objectFactory.registerConstructor('WebSearch', () => new WebSearch());
  runtime.objectFactory.registerConstructor('WebFetch', () => new WebFetch());
  runtime.objectFactory.registerConstructor('SkillRegistry', () => new SkillRegistry(path.resolve(DATA_DIR, 'skills')));
  runtime.objectFactory.registerConstructor('SkillAgent', () => new SkillAgent());
  runtime.objectFactory.registerConstructor('ObjectAgent', () => new ObjectAgent());
  runtime.objectFactory.registerConstructor('ExternalProjectRegistry', () => new ExternalProjectRegistry());
  runtime.objectFactory.registerConstructor('ExternalCreator', () => new ExternalCreator());
  runtime.objectFactory.registerConstructor('MCPRegistryClient', () => new MCPRegistryClient());
  runtime.objectFactory.registerConstructor('ClawHubClient', () => new ClawHubClient());
  runtime.objectFactory.registerConstructor('SecretsVault', () => new SecretsVault());
  runtime.objectFactory.registerConstructor('Packages', () => new Packages());
  runtime.objectFactory.registerConstructor('InstanceInfo', () => new InstanceInfo(instanceSource));
  runtime.objectFactory.registerConstructor('Crypto', () => new Crypto());
  runtime.objectFactory.registerConstructor('OAuthHelper', () => new OAuthHelper());
  runtime.objectFactory.registerConstructor('MCPBridge', (args?: unknown) => {
    const config = args as MCPBridgeConfig;
    return new MCPBridge(config);
  });
  runtime.objectFactory.registerConstructor('WasmAbject', (args?: unknown) => new WasmAbject(args as WasmAbjectArgs));
  if (ui) ui.registerConstructors(ctx);

  // Mark worker-eligible constructors (only used when workerEnabled).
  // Per-workspace objects use registryHint to discover workspace dependencies.
  if (runtime.config.workerEnabled) {
    const workerEligible = [
      // Global capabilities
      'LLMObject', 'HttpClient', 'Timer',
      'Clipboard', 'Console', 'FileSystem',
      'ShellExecutor', 'HostFileSystem',
      'WebSearch', 'WebFetch',
      'Storage', 'StreamClient', 'Crypto',
      // Global services
      'SettingsManager', 'PermissionBroker', 'DialogBroker',
      'ObjectCatalog',
      // Negotiator stays on the main thread: it installs proxy routes on the main bus.
      'ProxyGenerator', 'HealthMonitor', 'CassetteRecorder',
      'SkillRegistry',
      'MCPRegistryClient', 'ClawHubClient',
      'SecretsVault', 'OAuthHelper', 'Packages',
      // Per-workspace objects
      'AbjectStore', 'Theme', 'NotificationCenter',
      'TupleSpace', 'SharedState',
      'GoalManager', 'GoalObserver', 'TaskSession', 'AgentEvaluation', 'TaskReviewer',
      'JobManager',
      'AgentAbject', 'ScrumMaster', 'AgentCreator',
      'ObjectAgent', 'SkillAgent', 'WebAgent', 'ExternalProjectRegistry', 'ExternalCreator',
      'TriggerManager', 'CollectionStore',
      'Scheduler',
      'ObjectCreator', 'Chat', 'ChatManager',
      'ScriptableAbject', 'WasmAbject',
      // Workspace infrastructure: the main thread is reserved for the message
      // bus, transports, and PeerRouter (a synchronous bus interceptor).
      'WorkspaceManager', 'WorkspaceRegistry', 'WorkspaceShareRegistry',
      'WebBrowser', 'WebParser', 'FileTransfer', 'MCPBridge',
      ...(ui?.workerEligible ?? []),
      // Deliberately NOT worker-eligible:
      // - PeerRouter: synchronous MessageInterceptor installed on the bus.
      // - Supervisor: must not depend on the workers it restarts.
      // - MediaStream: holds live RTCPeerConnection/MediaStreamTrack handles;
      //   needs its track ops turned into P2P-worker RPCs before it can move.
      // - Identity/PeerRegistry/SignalingRelay/PeerDiscovery/RemoteRegistry:
      //   already co-located in the dedicated P2P worker.
      // - AuthGate, CliServer, WebGateway, HeapMonitor, InstanceInfo: they
      //   hold this process's sockets and state.
    ];
    for (const name of workerEligible) {
      runtime.objectFactory.markWorkerEligible(name);
    }
  }

  log.timed('constructors registered');

  // Ingest abject packages (WASM and script) before anything spawns: bundled
  // native system packages (native/, shipped with the app) first, then
  // user-installed extensions (.abjects/extensions/*), then ABJECTS_PACKAGE_DIRS
  // and the directories in packages.json; later ones win name collisions, and
  // packages.json can disable any of them. A package with `replaces` must
  // override its built-in constructor in the Factory before the first spawn of
  // that name.
  const wasmExtensions = await ingestAllExtensions(runtime.objectFactory);
  if (wasmExtensions.length > 0) {
    log.timed(`packages ingested (${wasmExtensions.map(e => `${e.typeName}:${e.runtime}`).join(', ')})`);
  }
  // The KnowledgeBase exists only as the bundled native package; without it
  // every workspace would run with no memory, so a missing one stops boot.
  if (!runtime.objectFactory.listPackageTypes().some(t => t.name === 'KnowledgeBase')) {
    throw new Error('The native KnowledgeBase package (native/knowledge-base) was not found or did not load. ' +
      'It ships with the app; reinstall, or run pnpm smelt in a source checkout.');
  }

  // Spawn Supervisor early so it can supervise other objects
  supervisorId = await factorySpawn('Supervisor');

  // Spawn in dependency order via Factory messages
  // Global objects (shared across workspaces)
  const httpClientId = await supervisedSpawn('HttpClient');
  const llmId = await supervisedSpawn('LLMObject');

  // Configure LLM. We always call configure() so the CLI providers
  // (claude-cli, codex-cli) get registered alongside the API ones,
  // independent of whether the user has API keys set. The CLI providers'
  // own `isAvailable()` reports detection on first use.
  const bootCreds: Record<string, string> = {};
  if (anthropicKey) bootCreds.anthropic = anthropicKey;
  if (openaiKey)    bootCreds.openai    = openaiKey;
  if (typesafeKey)  bootCreds.typesafe  = typesafeKey;
  await bootstrapRequest(llmId, 'configure', {
    credentials: bootCreds,
  });

  const storageId = await supervisedSpawn('Storage');
  const timerId = await supervisedSpawn('Timer');
  // Randomness, hashing and signature checks for abjects without node:crypto.
  await supervisedSpawn('Crypto');
  const clipboardId = await supervisedSpawn('Clipboard');
  const consoleId = await supervisedSpawn('Console');
  // FileSystem is per-workspace (spawned by WorkspaceManager, rooted under
  // the instance's data directory); no global instance.
  const webParserId = await supervisedSpawn('WebParser');
  // Inside the desktop app WebBrowser's pages are Electron windows, which it
  // asks BrowserWindowHost for; outside it there is no host and WebBrowser
  // launches its own Chromium.
  if (ui) await ui.beforeWebBrowser(ctx);
  const webBrowserId = await supervisedSpawn('WebBrowser');
  // WebAgent is per-workspace (spawned by WorkspaceManager), not global
  const shellExecutorId = await supervisedSpawn('ShellExecutor');
  const hostFilesystemId = await supervisedSpawn('HostFileSystem');
  const webSearchId = await supervisedSpawn('WebSearch');
  const webFetchId = await supervisedSpawn('WebFetch');
  await supervisedSpawn('StreamClient');
  // Every question to the person goes through it; the desktop and the
  // terminal gateway register with it below, and then registration seals.
  const dialogBrokerId = await supervisedSpawn('DialogBroker');
  if (ui) await ui.spawnDisplay(ctx, dialogBrokerId);

  log.timed('core capabilities spawned');

  // ── P2P Layer: dedicated worker or main thread ───────────────────────
  let identityId: AbjectId;
  let peerRegistryId: AbjectId;
  let remoteRegistryId: AbjectId;
  let peerRouterId: AbjectId;
  let signalingRelayId: AbjectId;
  let peerDiscoveryId: AbjectId;
  let remoteUIAccessId: AbjectId | undefined;
  let p2pBridge: DedicatedWorkerBridge | null = null;

  // PeerRouter always runs on main thread (it's a MessageInterceptor)
  peerRouterId = await supervisedSpawn('PeerRouter');
  const peerRouterObj = runtime.objectFactory.getObject(peerRouterId) as unknown as PeerRouter;
  peerRouterObj.setBus(bus);
  bus.addInterceptor(peerRouterObj);

  if (DEDICATED_WORKERS) {
    // ── P2P Worker mode ──────────────────────────────────────────────
    alog.info('Spawning dedicated P2P worker...');

    // Pre-assign IDs for all P2P objects. Paired remote browsers
    // (RemoteUIAccess) attach to a display, so only a desktop has one.
    identityId = randomUUID() as AbjectId;
    peerRegistryId = randomUUID() as AbjectId;
    remoteRegistryId = randomUUID() as AbjectId;
    signalingRelayId = randomUUID() as AbjectId;
    peerDiscoveryId = randomUUID() as AbjectId;
    remoteUIAccessId = ui ? randomUUID() as AbjectId : undefined;

    const p2pWorker = new NodeWorkerAdapter(options.p2pWorkerScript);
    p2pBridge = new DedicatedWorkerBridge(p2pWorker, bus);
    const bridge = p2pBridge;
    // Anything the P2P worker constructs outside the pre-assigned ids gets a
    // bridge mapping instead of becoming a worker-hosted id with no route.
    bridge.onLocalRegistered = (id) => bus.registerDedicatedBridge(id, bridge);
    bridge.onLocalUnregistered = (id) => bus.unregisterDedicatedBridge(id);

    // Register all P2P object IDs on the main bus before worker init
    const p2pObjectIds = [identityId, peerRegistryId, remoteRegistryId, signalingRelayId, peerDiscoveryId,
      ...(remoteUIAccessId ? [remoteUIAccessId] : [])];
    for (const id of p2pObjectIds) {
      bus.registerDedicatedBridge(id, p2pBridge);
    }

    // Register P2P objects in the Registry so other objects can discover them.
    // P2P objects in the worker use discoverDep/requireDep which queries the
    // main Registry. Without this, PeerRegistry can't find Identity, etc.
    const p2pRegistrations: Array<{ id: AbjectId; name: string; interfaceId: string }> = [
      { id: identityId, name: 'Identity', interfaceId: 'abjects:identity' },
      { id: peerRegistryId, name: 'PeerRegistry', interfaceId: 'abjects:peer-registry' },
      { id: remoteRegistryId, name: 'RemoteRegistry', interfaceId: 'abjects:remote-registry' },
      { id: signalingRelayId, name: 'SignalingRelay', interfaceId: 'abjects:signaling-relay' },
      { id: peerDiscoveryId, name: 'PeerDiscovery', interfaceId: 'abjects:peer-discovery' },
      ...(remoteUIAccessId ? [{ id: remoteUIAccessId, name: 'RemoteUIAccess', interfaceId: 'abjects:remote-ui-access' }] : []),
    ];
    for (const reg of p2pRegistrations) {
      await bootstrapRequest(registryId, 'register', {
        objectId: reg.id,
        manifest: {
          name: reg.name,
          description: `${reg.name} (running in P2P worker)`,
          version: '1.0.0',
          interface: { id: reg.interfaceId, name: reg.name, description: '', methods: [] },
          tags: ['system', 'peer'],
        },
        status: 'running',
      });
    }

    // Wire P2P bridge events before starting worker
    // peer-id: set once when Identity reports peerId
    p2pBridge.onCustom('peer-id', (data) => {
      localPeerId = data.peerId as string;
      peerRouterObj.setLocalPeerId(localPeerId as PeerId);
      alog.info(`Local peerId (from P2P worker): ${localPeerId.slice(0, 16)}...`);
    });

    // remote-message: inbound P2P messages → PeerRouter
    p2pBridge.onCustom('remote-message', (data) => {
      const msg = data.message as AbjectMessage;
      const fromPeerId = data.fromPeerId as string as PeerId;
      peerRouterObj.handleIncomingMessage(msg, fromPeerId);
    });

    // peer-status: connected peers cache update
    p2pBridge.onCustom('peer-status', (data) => {
      const peers = (data.connectedPeers as string[]).map(p => p as PeerId);
      peerRouterObj.updateConnectedPeers(peers);

      // On new connection, announce routes, from scratch: the peer may have
      // restarted, or been dropped and readmitted, and lost what it was told.
      if (data.event === 'connected' && data.peerId) {
        peerRouterObj.announceRoutesToNewConnection(data.peerId as string as PeerId);
      }
    });

    // Wire PeerRouter → P2P bridge for transport sends
    peerRouterObj.setP2PBridge(p2pBridge);

    // remote-ui-attach: a remote UI client successfully paired in the P2P
    // worker. The transport bytes are relayed across via a MessagePort; on
    // this side the UI layer wraps the port and attaches it to the display.
    if (ui) {
      p2pBridge.onCustom('remote-ui-attach', (data) => {
        const d = data as unknown as { peerId: string; meta?: { name?: string }; transferPort: MessagePort };
        ui.remoteUiAttach(d.peerId, ui.portToUITransport(d.transferPort), d.meta);
      });
    }

    // Wait for worker ready, then send config
    await p2pBridge.waitReady();
    p2pBridge.sendConfig({
      identityId: identityId as string,
      peerRegistryId: peerRegistryId as string,
      remoteRegistryId: remoteRegistryId as string,
      signalingRelayId: signalingRelayId as string,
      peerDiscoveryId: peerDiscoveryId as string,
      ...(remoteUIAccessId ? { remoteUIAccessId: remoteUIAccessId as string } : {}),
      registryId: registryId as string,
    });

    // The first 'ready' was the worker starting up; the P2P bootstrap
    // happens after init-config, and it says so with 'p2p-ready'.
    await new Promise<void>((resolve) => {
      p2pBridge!.onCustom('p2p-ready', () => resolve());
      // Also resolve on timeout to avoid blocking forever
      setTimeout(resolve, 2000);
    });

    log.timed('P2P worker ready');
  } else {
    // ── Non-worker fallback (original behavior) ──────────────────────
    identityId = await supervisedSpawn('Identity');

    // Get peerId for computing system TypeIds
    try {
      const identity = await bootstrapRequest<{ peerId: string }>(identityId, 'getIdentity', {});
      localPeerId = identity.peerId;
      alog.info(`Local peerId: ${localPeerId.slice(0, 16)}...`);
    } catch {
      alog.warn('Could not get peerId — system TypeIds will not be assigned');
    }

    log.timed('identity ready');
    peerRegistryId = await supervisedSpawn('PeerRegistry', 'permanent', systemTypeId('PeerRegistry'));
    remoteRegistryId = await supervisedSpawn('RemoteRegistry', 'permanent', systemTypeId('RemoteRegistry'));

    // Install PeerRouter with direct PeerRegistry reference
    const peerRegistryObj = runtime.objectFactory.getObject(peerRegistryId) as PeerRegistry;
    peerRouterObj.setPeerRegistry(peerRegistryObj);

    // Wire PeerRegistry → PeerRouter for inbound messages
    peerRegistryObj.onRemoteMessage((msg, fromPeerId) => {
      peerRouterObj.handleIncomingMessage(msg, fromPeerId);
    });

    // Spawn and wire SignalingRelay and PeerDiscovery
    signalingRelayId = await supervisedSpawn('SignalingRelay', 'permanent', systemTypeId('SignalingRelay'));
    peerDiscoveryId = await supervisedSpawn('PeerDiscovery', 'permanent', systemTypeId('PeerDiscovery'));

    const signalingRelayObj = runtime.objectFactory.getObject(signalingRelayId) as unknown as SignalingRelayObject;
    const peerDiscoveryObj = runtime.objectFactory.getObject(peerDiscoveryId) as unknown as PeerDiscoveryObject;

    signalingRelayObj.setPeerRegistry(peerRegistryObj);
    peerDiscoveryObj.setPeerRegistry(peerRegistryObj);
    peerDiscoveryObj.setSignalingRelay(signalingRelayObj);

    // Set the signaling relay as fallback for PeerRegistry
    peerRegistryObj.setSignalingRelay(signalingRelayObj);
  }

  log.timed('P2P layer ready');

  // The permission authority comes up after the capability objects it
  // governs. setPermissionsAuthority is first-caller-wins, so whoever claims it
  // decides what runs on this host, and it needs a system typeId of its own
  // because changing a project's autonomy is gated on the caller's type identity.
  const permissionBrokerId = await supervisedSpawn(
    'PermissionBroker', 'permanent', systemTypeId('PermissionBroker'));

  // Where a saved login takes effect, before SettingsManager loads one.
  await supervisedSpawn('AuthGate', 'permanent', systemTypeId('AuthGate'));
  // The settings as data: loads and applies them at boot, then takes changes
  // from the Settings window and the terminal client. After PermissionBroker,
  // whose settings authority it claims (first caller wins).
  const settingsManagerId = await supervisedSpawn('SettingsManager', 'permanent', systemTypeId('SettingsManager'));

  if (ui) await ui.spawnSettingsWindow(ctx, dialogBrokerId);
  // Installed packages and their configuration (the Packages settings tab).
  // Worker-eligible like the other global services: it only reads and writes
  // packages.json and the package directories, and asks the Factory by message.
  await supervisedSpawn('Packages', 'permanent', systemTypeId('Packages'));
  // Version, readiness and edition for abjects (main thread: it reads this process's state).
  await supervisedSpawn('InstanceInfo', 'permanent', systemTypeId('InstanceInfo'));

  const heapMonitorId = await supervisedSpawn('HeapMonitor', 'permanent', systemTypeId('HeapMonitor'));
  const skillRegistryId = await supervisedSpawn('SkillRegistry', 'permanent', systemTypeId('SkillRegistry'));
  await supervisedSpawn('WebGateway', 'permanent', systemTypeId('WebGateway'));
  const mcpRegistryClientId = await supervisedSpawn('MCPRegistryClient', 'permanent', systemTypeId('MCPRegistryClient'));
  const clawHubClientId = await supervisedSpawn('ClawHubClient', 'permanent', systemTypeId('ClawHubClient'));
  const secretsVaultId = await supervisedSpawn('SecretsVault', 'permanent', systemTypeId('SecretsVault'));
  const oauthHelperId = await supervisedSpawn('OAuthHelper', 'permanent', systemTypeId('OAuthHelper'));

  const proxyGenId = await supervisedSpawn('ProxyGenerator', 'permanent', systemTypeId('ProxyGenerator'));
  const negotiatorId = await supervisedSpawn('Negotiator', 'permanent', systemTypeId('Negotiator'));
  const healthMonitorId = await supervisedSpawn('HealthMonitor', 'permanent', systemTypeId('HealthMonitor'));
  // Records objects' HTTP traffic as typeId-keyed cassettes (evidence for
  // judging generated objects — mempko/abject#11 series). HttpClient finds
  // it through the registry and sends exchanges to it directly.
  await supervisedSpawn('CassetteRecorder', 'permanent', systemTypeId('CassetteRecorder'));

  if (ui) await ui.spawnGlobalUi(ctx);

  log.timed('global services spawned');

  // System-scoped packages (WASM and script) spawn once, as global objects,
  // here (after the peerId is known so they get {peerId}/system/{Name}
  // typeIds). A script package runs on the worker pool like any other
  // ScriptableAbject and keeps its data with Packages, spawned above.
  // Packages that replace a built-in need no spawn of their own: the
  // built-in's normal spawn already resolved to the package.
  const autostartTypes = new Set(runtime.objectFactory.listPackageTypes()
    .filter((t) => t.tags.includes('autostart')).map((t) => t.name));
  for (const ext of wasmExtensions) {
    if (ext.scope !== 'system' || ext.replaces) continue;
    try {
      const id = await supervisedSpawn(ext.typeName, 'permanent', systemTypeId(ext.typeName));
      log.timed(`system package '${ext.typeName}' (${ext.runtime}) spawned`);
      // As WorkspaceManager does for workspace packages: an autostart package
      // gets its `startup` call once spawned. Not awaited: a slow startup
      // must not hold the boot up.
      if (autostartTypes.has(ext.typeName)) {
        void bootstrapRequest(id, 'startup', {}).catch((err: unknown) =>
          alog.warn(`system package '${ext.typeName}' startup failed:`, err));
      }
    } catch (err) {
      alog.error(`Failed to spawn system package '${ext.typeName}':`, err);
    }
  }

  // CLI gateway. Spawned and registered as the remote dialog responder
  // BEFORE any workspace boots: DialogBroker's surfaces are then sealed, so no
  // user abject (they only exist inside workspaces) can ever register itself
  // and auto-answer permission dialogs.
  const cliServerId = await supervisedSpawn('CliServer', 'permanent', systemTypeId('CliServer'));
  await bootstrapRequest(dialogBrokerId, 'registerResponder', { objectId: cliServerId });
  await bootstrapRequest(dialogBrokerId, 'seal', {});
  log.timed('CLI gateway spawned, dialog surfaces sealed');

  // WorkspaceManager spawns per-workspace objects (Chat, agents, and on a
  // desktop the workspace's windows).
  const workspaceManagerId = await supervisedSpawn('WorkspaceManager', 'permanent', systemTypeId('WorkspaceManager'));
  log.timed('WorkspaceManager spawned');

  // Boot workspaces BEFORE spawning WSR — boot() loads persisted workspaces
  // (including their access modes) so listSharedWorkspaces returns real data.
  // Cannot happen during onInit because Factory would deadlock processing our spawn request.
  await bootstrapRequest(workspaceManagerId, 'boot', {});
  log.timed('workspace boot complete');

  // WorkspaceShareRegistry must spawn AFTER boot() so listSharedWorkspaces finds shared workspaces
  const workspaceShareRegistryId = await supervisedSpawn('WorkspaceShareRegistry', 'permanent', systemTypeId('WorkspaceShareRegistry'));

  // Rebuilds what a dead pool worker took with it. Main thread only: it must
  // outlive any worker.
  const workerRecoveryId = await supervisedSpawn('WorkerRecovery', 'permanent', systemTypeId('WorkerRecovery'));
  if (runtime.workerPool) {
    runtime.workerPool.onWorkerLost = (lostIds, workerIndex) => {
      try {
        runtime.messageBus.send(message.event(workerRecoveryId, workerRecoveryId, 'workerLost', { objectIds: lostIds, workerIndex, reason: 'worker exited' }));
      } catch (err) {
        alog.error(`could not hand the worker loss to WorkerRecovery: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
  }

  // Register allowed system objects for remote access
  peerRouterObj.allowSystemObjectDirect(workspaceShareRegistryId, WORKSPACE_SHARE_REGISTRY_ID, systemTypeId('WorkspaceShareRegistry'));
  peerRouterObj.announceRoutesToAll().catch(() => {});
  if (ui) await ui.spawnLateUi(ctx);

  // ObjectCatalog: background service maintaining live cache of all registrations
  const objectCatalogId = await supervisedSpawn('ObjectCatalog', 'permanent', systemTypeId('ObjectCatalog'));

  // ALL objects are now spawned and init'd — safe to start health monitoring.
  const monitoredIds = [
    httpClientId, llmId, storageId, timerId, clipboardId,
    consoleId, webParserId, webBrowserId,
    shellExecutorId, hostFilesystemId, webSearchId, webFetchId,
    identityId, peerRegistryId, remoteRegistryId, peerRouterId,
    signalingRelayId, peerDiscoveryId,
    workspaceShareRegistryId, objectCatalogId,
    heapMonitorId, skillRegistryId,
    mcpRegistryClientId, clawHubClientId,
    secretsVaultId, oauthHelperId,
    proxyGenId, negotiatorId,
    workspaceManagerId, cliServerId, dialogBrokerId, permissionBrokerId,
    ...(ui?.monitoredIds() ?? []),
  ];
  await Promise.all(monitoredIds.map(async (objId) => {
    await bootstrapRequest(healthMonitorId, 'monitorObject', { objectId: objId });
    await bootstrapRequest(healthMonitorId, 'markObjectReady', { objectId: objId });
  }));
  await bootstrapRequest(healthMonitorId, 'startMonitoring', {});

  // Clean up bootstrap sender
  bootDone = true;
  bus.unregister(BOOTSTRAP_ID); // closes mailbox, breaks boot loop
  await bootLoop;

  log.summary('server ready');
  serving = true;

  // Found by `abject` (and refused to a second backend) through this file.
  writeInstance({
    pid: process.pid,
    edition: options.edition,
    version: instanceSource.version,
    wsPort: WS_PORT,
    cliPort: CLI_PORT,
    ownerToken,
    dataDir: dataDirAbs,
    startedAt: instanceSource.startedAt,
    detached: process.env[DETACHED_ENV] === '1',
  });

  console.log('');
  console.log(`  ABJECTS server running (${options.edition})`);
  console.log('');
  for (const line of ui?.banner() ?? [`  Health:     http://localhost:${WS_PORT}/healthz`]) console.log(line);
  console.log(`  CLI:        ws://localhost:${CLI_PORT}  (abject)`);
  console.log(`  Data:       ${dataDirAbs}`);
  console.log(`  Auth:       ${authConfig.enabled ? 'enabled' : 'disabled'}`);
  console.log(`  Workers:    ${DEDICATED_WORKERS ? (ui ? 'UI + P2P dedicated' : 'P2P dedicated') : 'disabled'}`);
  console.log(`  Objects:    ${runtime.objectRegistry.objectCount}`);
  console.log('');

  /**
   * Arm a hard exit that does not depend on this thread's event loop.
   *
   * The one call that can wedge shutdown — libdatachannel's `cleanup` — is
   * synchronous native code. While it blocks, this thread runs no timers, no
   * promises and no signal handlers, which is why a `setTimeout` deadline is
   * worthless against it and why Ctrl-C stopped working: SIGINT was caught,
   * but the handler was JS and needed a loop that was already gone.
   *
   * A separate *process* has its own everything and goes on running while
   * ours is stuck, so it can still fire. It sends SIGKILL, the one signal
   * nothing can swallow. The app's own child processes were signalled at the
   * start of shutdown (runtime.signalChildProcesses), so a SIGKILL here does
   * not leave them orphaned.
   *
   * It cannot be a worker thread. A worker can rescue a main thread blocked
   * in native code — that much was measured — but not one blocked inside
   * `process.exit()`, because Node's exit sequence stops sub-worker contexts
   * on its way out and so kills the rescuer first. That is precisely where
   * this last hung: the teardown below finished in 25ms and the process
   * still never left.
   *
   * There is no disarm and it needs none. The child holds a pipe to us and
   * reads its closing as "the parent is gone", so a normal exit collapses it
   * before the deadline and it fires only when we genuinely failed to leave.
   * Watching the pipe rather than a pid also means it can never SIGKILL
   * whatever unrelated process later inherits ours.
   */
  const armExitWatchdog = (ms: number, what: string): void => {
    const notice = JSON.stringify(`[Abject] ${what} did not finish within ${ms}ms — hard-exiting\n`);
    const child = `
      let gone = false;
      const leave = () => { gone = true; process.exit(0); };
      process.stdin.resume();
      process.stdin.on('end', leave);
      process.stdin.on('close', leave);
      process.stdin.on('error', leave);
      setTimeout(() => {
        if (gone) return;
        try { process.stderr.write(${notice}); } catch {}
        try { process.kill(${process.pid}, 'SIGKILL'); } catch {}
        process.exit(0);
      }, ${ms});
    `;
    try {
      // A single-executable launcher (the packaged `abject`) runs only its own
      // entry and treats `-e` as an argument, so it is told by environment to
      // evaluate the watchdog instead (see scripts/sea-bootstrap.cjs).
      const sea = process.env.ABJECT_SEA === '1';
      const watchdog = spawn(process.execPath, sea ? ['__abject-eval'] : ['-e', child], {
        detached: true,
        stdio: ['pipe', 'ignore', 'inherit'],
        // In the desktop app execPath is the Electron binary, which would
        // otherwise start a whole second app instead of evaluating this.
        // Plain node ignores the variable.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(sea ? { ABJECT_EVAL: child } : {}) },
      });
      // The watchdog must never be the reason the process stays up.
      watchdog.unref();
      (watchdog.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    } catch (err) {
      alog.warn('could not arm the exit watchdog:', err);
    }
  };

  /**
   * How long the whole departure gets before the watchdog stops waiting.
   * Comfortably above a healthy teardown (25ms) and above Electron's own
   * quit sequence (~6.5s of its own timers), so it only ever fires on a
   * genuine wedge.
   */
  const SHUTDOWN_DEADLINE_MS = 10_000;

  /** How long a child process gets to leave on SIGTERM before SIGKILL. */
  const CHILD_KILL_GRACE_MS = 2_000;

  // Handle graceful shutdown
  let shuttingDown = false;

  /**
   * Release everything this process is holding, and DO NOT exit.
   *
   * Exiting is the caller's decision because the two callers need different
   * ones. A signal handler owns the process and exits itself. Electron does
   * not: its main process has child processes of its own — a zygote, a network
   * service — that only get reaped by Electron's own shutdown, so a
   * `process.exit()` here would leave them orphaned, holding the AppImage
   * mount, and the file busy against the next update.
   *
   * What this does own is the reason the process would not exit by itself:
   * the listening sockets and the worker pool keep the event loop alive long
   * after the last window has gone.
   */
  const releaseEverything = async (): Promise<void> => {
    // Arm the watchdog before anything else, and never disarm it. The hang
    // that outlived every earlier fix was not in the teardown at all but in
    // the `process.exit()` after it, so a watchdog scoped to one slow call
    // was disarmed a moment before it was needed. This one covers the whole
    // departure, and both callers inherit it.
    armExitWatchdog(SHUTDOWN_DEADLINE_MS, 'shutdown');
    // The next `abject` must not find this backend once it is going.
    removeInstance(dataDirAbs);
    sessionStore.destroy();
    // Child processes first, before anything that can be slow. MCP servers
    // run in sessions of their own, so nothing takes them down with us: if
    // the teardown below wedges, outlasts Electron's quit deadline, or
    // crashes at exit (all three have happened), a server whose bridge was
    // never reached stays alive holding the AppImage mount, and the app
    // never finishes quitting. Signalling them here does not depend on any
    // object getting to its onStop.
    const children = await runtime.signalChildProcesses('SIGTERM').catch(() => [] as TrackedChild[]);
    if (children.length > 0) {
      alog.info(`Signalled ${children.length} child process(es) to stop: ${children.map((c) => c.label).join(', ')}`);
      // Whatever ignores SIGTERM gets SIGKILL on a timer of its own, so it
      // does not depend on the teardown below reaching its owner either.
      const escalate = setTimeout(() => {
        for (const child of children) signalChild(child, 'SIGKILL');
      }, CHILD_KILL_GRACE_MS);
      escalate.unref();
    }
    // Release every listening socket before the slow work. Whatever happens
    // to the runtime teardown after this, the next `awaken` can bind.
    await Promise.allSettled([
      healthServer ? new Promise<void>((resolve) => healthServer!.close(() => resolve())) : Promise.resolve(),
      cliServer ? cliServer.stop() : Promise.resolve(),
      webGateway ? webGateway.stop() : Promise.resolve(),
    ]);
    // Stop the dedicated workers first — and stop their objects before their
    // threads.
    //
    // runtime.stop() reaches the worker pool and the objects in this thread's
    // factory, and nothing else. The UI and P2P workers are dedicated threads
    // whose objects it has never seen, so they used to outlive the runtime
    // completely: the log showed the P2P worker dialing brand new peers a
    // second and a half after "runtime stopped", because its auto-connect loop
    // was still running and nobody had ever told it to stop. Asking each
    // worker to stop its own objects is what finally runs PeerRegistry's
    // onStop() — the teardown that closes the peer connections, stops that
    // loop and disconnects the signaling client, and which had been sitting
    // there correct and unreachable. Terminating the threads afterwards is
    // what guarantees no new PeerConnection can appear while the cleanup
    // below walks the ones that exist.
    //
    // Before runtime.stop(), because the bus those objects speak on is only
    // up until it returns.
    //
    // The worker pool stops alongside them rather than after: waiting for the
    // P2P worker (up to 3s) and then stopping the pool used to run past
    // Electron's 5s quit deadline. The pool needs only the bus, which stays
    // up until runtime.stop() below.
    const [p2pSettled] = await Promise.allSettled([
      p2pBridge?.shutdownWorker(3000),
      ui ? ui.release() : Promise.resolve(),
      runtime.shutdownWorkerPool(),
    ]);

    // Did the P2P worker manage to shut libdatachannel down on its own thread?
    // That is the only teardown that can actually join the RTC threads, so it
    // decides whether there is anything left for us to do below.
    const workerShutDownRtc =
      p2pSettled.status === 'fulfilled' && (p2pSettled.value as { nativeCleanup?: boolean } | undefined)?.nativeCleanup === true;

    await runtime.stop().catch(() => { /* teardown is best effort */ });

    // Shut libdatachannel down explicitly.
    //
    // It is loaded by the P2P worker, and a worker is a thread — so the native
    // addon lives in this process and its static destructors run at exit,
    // where they abort. That abort is why every headless run ends at 134, and
    // in the desktop app it is worse than noise: a SIGABRT leaves the
    // AppImage's own FUSE mount behind, which is what holds the file busy
    // against the next update. `cleanup` is the library's own answer to this;
    // terminating the worker does not unload the addon.
    if (workerShutDownRtc) {
      // Already done, on the thread that owns the callbacks — and this thread
      // must not even import the addon. Loading it here puts it in an env that
      // never held a PeerConnection: cleanup() from there walks empty instance
      // sets while re-entering a library that is already down.
      alog.info('node-datachannel was shut down by the P2P worker — skipping main-thread cleanup');
      return;
    }

    // The worker could not confirm (it timed out, or died before answering),
    // so fall back to shutting the library down from here.
    let dc: typeof import('node-datachannel') | undefined;
    try {
      dc = await import('node-datachannel');
    } catch { /* never loaded, or a version without it */ }

    if (dc) {
      // Synchronous native code: it holds this thread until it converges or
      // gives up on its own 10s deadline. It could not converge before,
      // because the P2P worker was still alive above it and still creating
      // PeerConnections — CloseAll() walked a set another thread kept
      // inserting into. (That set, `PeerConnectionWrapper::instances` in
      // node-datachannel, has no mutex; the race is real but the fix belongs
      // upstream. Stopping the only other thread that touches it is what
      // makes this call safe from here.)
      const startedAt = Date.now();
      try {
        dc.cleanup();
        alog.info(`node-datachannel cleanup returned in ${Date.now() - startedAt}ms`);
      } catch (err) {
        // "cleanup timeout (possible deadlock)" lands here. It used to be
        // swallowed by a bare catch written for the import failing, which is
        // how ten blocked seconds and a failed teardown left no trace at all.
        alog.warn(`node-datachannel cleanup failed after ${Date.now() - startedAt}ms:`, err);
      }
    }
  };
  backendShutdown = releaseEverything;

  const shutdown = (signal: string) => {
    // A second signal means the first one did not get us out. Leave now:
    // swallowing it turns a wedged teardown into a process that survives
    // every subsequent Ctrl-C, outlives its supervisor, and sits on the
    // ports until someone hunts it down with SIGKILL.
    if (shuttingDown) {
      alog.warn(`${signal} received while already shutting down — exiting immediately`);
      process.exit(1);
    }
    shuttingDown = true;
    alog.info(`Shutting down (${signal})...`);
    releaseEverything().finally(() => {
      // Timestamped on purpose: everything logged before this line is our own
      // teardown, everything after it belongs to the runtime's exit. Without
      // that boundary a hang here looks exactly like a hang in the teardown,
      // which is how the last one hid for so long.
      alog.info('Teardown complete — exiting');
      process.exit(0);
    });
    // Covers a teardown that is merely slow. A teardown *blocked* in native
    // code cannot be rescued by a timer on the thread it is blocking — the
    // watchdog thread inside releaseEverything() is what covers that.
    setTimeout(() => process.exit(1), 3000);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // A terminal closed under a foreground `abject serve`.
  if (process.platform !== 'win32') process.on('SIGHUP', () => shutdown('SIGHUP'));
}

process.on('unhandledRejection', (reason) => {
  alog.error('Unhandled rejection (server stayed up):', reason);
});

/**
 * Name the process sitting on a port we needed.
 *
 * A bare EADDRINUSE stack says a port is taken but not by what, and the two
 * causes want opposite responses: a previous server of our own that outlived
 * its supervisor should be killed, while another instance that is simply
 * running (a second dev server, the desktop app) means this one wants
 * different ports. Naming the holder lets the reader tell them apart. Such a
 * process can also be wedged past the point where it answers signals at all,
 * so "just Ctrl-C it" is not always available and the reader needs a pid to
 * SIGKILL. Best effort: `ss` may be missing, in which case the caller still
 * gets the plain error.
 */
function describePortHolder(port: number): string | undefined {
  try {
    const out = execFileSync('ss', ['-lptnH'], { encoding: 'utf-8', timeout: 2000 });
    const line = out.split('\n').find(l => l.includes(`:${port} `));
    const pid = line?.match(/pid=(\d+)/)?.[1];
    if (!pid) return undefined;
    let cmd = '';
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim().slice(0, 120);
    } catch { /* process may have just exited */ }
    return `port ${port} is held by pid ${pid}${cmd ? ` (${cmd})` : ''}. ` +
      `If that is a live instance, give this one its own ports (WS_PORT, or CLI_PORT ` +
      `for the gateway alone); if it is a stale server of ours, clear it with: kill -9 ${pid}`;
  } catch {
    return undefined;
  }
}

/** Boot, and on failure explain it and exit. Each edition's entry calls this. */
export function runServer(options: BootOptions): void {
  bootServer(options).catch((err) => {
    // A spawn failure travels back over the bus as a plain Error rebuilt from
    // the reply payload, so `code`/`port` do not survive the trip. Fall back to
    // the message text, which does.
    const text = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string } | null)?.code;
    if (code === 'EADDRINUSE' || text.includes('EADDRINUSE')) {
      const port = (err as { port?: number }).port ?? Number(text.match(/:(\d+)\s*$/)?.[1]);
      const detail = Number.isFinite(port) ? describePortHolder(port as number) : undefined;
      alog.error(`Fatal startup error: ${detail ?? String(err)}`);
      if (detail) {
        alog.error('A server that lost its supervisor keeps its sockets bound until it is killed; '
          + 'a server that is simply still running needs a different port here, not a kill.');
      }
      process.exit(1);
    }
    alog.error('Fatal startup error:', err);
    process.exit(1);
  });
}
