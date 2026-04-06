/**
 * Abjects Node.js Backend Entry Point
 *
 * Mirrors the bootstrap in src/index.ts but without DOM/Canvas.
 * System objects run here or in dedicated worker_threads (UI, P2P).
 */

import { AbjectId, TypeId, AbjectMessage, SpawnResult } from '../src/core/types.js';
import { getRuntime, resetRuntime } from '../src/runtime/runtime.js';
import * as message from '../src/core/message.js';
import { BackendUI } from './backend-ui.js';
import { LLMObject } from '../src/objects/llm-object.js';
import { ObjectCreator } from '../src/objects/object-creator.js';
import { ProxyGenerator } from '../src/objects/proxy-generator.js';
import { Negotiator } from '../src/protocol/negotiator.js';
import { HealthMonitor } from '../src/protocol/health-monitor.js';
import { HttpClient } from '../src/objects/capabilities/http-client.js';
import { NodeStorage } from './node-storage.js';
import { Timer } from '../src/objects/capabilities/timer.js';
import { Clipboard } from '../src/objects/capabilities/clipboard.js';
import { Console } from '../src/objects/capabilities/console.js';
import { FileSystem } from '../src/objects/capabilities/filesystem.js';
import { WebParser } from '../src/objects/capabilities/web-parser.js';
import { WebBrowser } from '../src/objects/capabilities/web-browser.js';
import { WebAgent } from '../src/objects/web-agent.js';
import { WebBrowserViewer } from '../src/objects/web-browser-viewer.js';
import { Settings } from '../src/objects/settings.js';
import { Taskbar } from '../src/objects/taskbar.js';
import { AppExplorer } from '../src/objects/app-explorer.js';
import { ObjectBrowser } from '../src/objects/object-browser.js';
import { ObjectCatalog } from '../src/objects/object-catalog.js';
import { WidgetManager } from '../src/objects/widget-manager.js';
import { ThemeAbject } from '../src/objects/theme.js';
import { WindowManager } from '../src/objects/window-manager.js';
import { AbjectEditor } from '../src/objects/abject-editor.js';
import { JobManager } from '../src/objects/job-manager.js';
import { JobBrowser } from '../src/objects/job-browser.js';
import { GoalManager } from '../src/objects/goal-manager.js';
import { GoalBrowser } from '../src/objects/goal-browser.js';
import { Chat } from '../src/objects/chat.js';
import { AgentAbject } from '../src/objects/agent-abject.js';
import { GoalObserver } from '../src/objects/goal-observer.js';
import { AbjectStore } from '../src/objects/abject-store.js';
import { Supervisor } from '../src/runtime/supervisor.js';
import type { RestartType } from '../src/runtime/supervisor.js';
import { WorkspaceManager } from '../src/objects/workspace-manager.js';
import { WorkspaceRegistry } from '../src/objects/workspace-registry.js';
import { WorkspaceSwitcher } from '../src/objects/workspace-switcher.js';
import { GlobalSettings } from '../src/objects/global-settings.js';
import { GlobalToolbar } from '../src/objects/global-toolbar.js';
import { PeerNetwork } from '../src/objects/peer-network.js';
import { ProcessExplorer } from '../src/objects/process-explorer.js';
import { LLMMonitor } from '../src/objects/llm-monitor.js';
import { IdentityObject } from '../src/objects/identity.js';
import { PeerRegistry } from '../src/objects/peer-registry.js';
import { RemoteRegistry } from '../src/objects/remote-registry.js';
import { PeerRouter } from '../src/network/peer-router.js';
import { SignalingRelayObject } from '../src/objects/signaling-relay.js';
import { PeerDiscoveryObject } from '../src/objects/peer-discovery.js';
import { SharedState } from '../src/objects/capabilities/shared-state.js';
import { TupleSpace } from '../src/objects/tuple-space.js';
import { FileTransfer } from '../src/objects/capabilities/file-transfer.js';
import { MediaStreamCapability } from '../src/objects/capabilities/media-stream.js';
import { WorkspaceShareRegistry, WORKSPACE_SHARE_REGISTRY_ID } from '../src/objects/workspace-share-registry.js';
import { ShellExecutor } from '../src/objects/capabilities/shell-executor.js';
import { HostFileSystem } from '../src/objects/capabilities/host-filesystem.js';
import { WebSearch } from '../src/objects/capabilities/web-search.js';
import { WebFetch } from '../src/objects/capabilities/web-fetch.js';
import { Screenshot } from '../src/objects/capabilities/screenshot.js';
import { SkillRegistry } from '../src/objects/skill-registry.js';
import { SkillBrowser } from '../src/objects/skill-browser.js';
import { SkillAgent } from '../src/objects/skill-agent.js';
import { ObjectAgent } from '../src/objects/object-agent.js';
import { WorkspaceBrowser } from '../src/objects/workspace-browser.js';
import { NodeWebSocketServer } from '../src/network/websocket-server.js';
import { NodeWorkerAdapter } from './node-worker-adapter.js';
import { DedicatedWorkerBridge } from '../src/runtime/dedicated-worker-bridge.js';
import { WebSocketUITransport } from './ui-transport.js';
import { loadAuthConfig, SessionStore, authenticateConnection } from './auth.js';
import { Log } from '../src/core/timed-log.js';
import * as path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
import type { PeerId } from '../src/core/identity.js';

const WS_PORT = parseInt(process.env.WS_PORT ?? '7719', 10);
const DATA_DIR = process.env.ABJECTS_DATA_DIR ?? '.abjects';
const DEDICATED_WORKERS = process.env.ABJECTS_DEDICATED_WORKERS !== '0'; // default: enabled
const alog = new Log('ABJECTS');

async function main(): Promise<void> {
  const log = new Log('BOOTSTRAP');
  alog.info('Initializing backend...');

  // Read API keys from environment
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

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
  const workerScriptPath = new URL('../workers/abject-worker-node.ts', import.meta.url);

  // Create runtime
  const runtime = getRuntime({
    debug: !!process.env.DEBUG,
    workerEnabled,
    workerCount,
    workerFactory: workerEnabled
      ? () => new NodeWorkerAdapter(workerScriptPath)
      : undefined,
  });

  // Pre-assign BackendUI ID (used in both worker and non-worker modes)
  const backendUIId = randomUUID() as AbjectId;
  let backendUI: BackendUI | null = null;        // non-null only in non-worker mode
  let uiBridge: DedicatedWorkerBridge | null = null;  // non-null only in worker mode

  if (DEDICATED_WORKERS) {
    // UI Worker mode: BackendUI runs in a dedicated worker_thread
    alog.info('Spawning dedicated UI worker...');
  } else {
    // Non-worker fallback: BackendUI runs on main thread (original behavior)
    // Polyfill WebRTC on main thread (needed for P2P objects)
    const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, RTCDataChannel } =
      await import('node-datachannel/polyfill');
    Object.assign(globalThis, { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, RTCDataChannel });

    backendUI = new BackendUI();
    runtime.registerCoreObject(backendUI);
  }

  // Start runtime (bootstraps Registry + Factory)
  await runtime.start();
  log.timed('runtime started');

  const bus = runtime.messageBus;

  // ── Create UI Worker (if dedicated workers enabled) ──────────────────
  if (DEDICATED_WORKERS) {
    const uiWorkerScript = new URL('../workers/ui-worker-node.ts', import.meta.url);
    const uiWorker = new NodeWorkerAdapter(uiWorkerScript);
    uiBridge = new DedicatedWorkerBridge(uiWorker, bus);

    // Register BackendUI ID on the main bus before worker init
    // so replies can be routed back to BackendUI during its init
    bus.registerDedicatedBridge(backendUIId, uiBridge);

    // Wait for worker to be ready, then send config
    await uiBridge.waitReady();
    uiBridge.sendConfig({ backendUIId: backendUIId as string, registryId: runtime.objectRegistry.id as string });
    log.timed('UI worker ready');
  }

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
                  requiredCapabilities: [], tags: ['system'] },
      typeId,
    });
    return result.objectId;
  }

  // In worker mode, register BackendUI with the Registry so other objects
  // can discover it via discoverDep('UIServer'). In non-worker mode, this
  // was handled by runtime.registerCoreObject() + factory.spawnInstance().
  if (DEDICATED_WORKERS) {
    await bootstrapRequest(registryId, 'register', {
      objectId: backendUIId,
      manifest: {
        name: 'UIServer',
        description: 'X11-style display server (running in UI worker)',
        version: '1.0.0',
        interface: {
          id: 'abjects:ui',
          name: 'UI',
          description: 'Surface management and input routing',
          methods: [],
        },
        requiredCapabilities: [],
        providedCapabilities: ['abjects:ui:surface', 'abjects:ui:input'],
        tags: ['system', 'ui'],
      },
      status: 'running',
    });
    log.timed('BackendUI registered in Registry');
  }

  // ── Start WS server early (right after BackendUI is ready) ──────────
  // The frontend only talks to BackendUI, which is already initialized.
  // Surfaces appear progressively as objects spawn during remaining bootstrap.
  const authConfig = loadAuthConfig();
  const sessionStore = new SessionStore();
  if (backendUI) {
    // Non-worker mode: BackendUI directly mutates the shared authConfig
    backendUI.setAuthGate(authConfig, sessionStore);
  }
  if (DEDICATED_WORKERS) {
    // Worker mode: intercept updateAuth messages going TO BackendUI so we
    // update the main-thread authConfig used by the WS connection handler.
    bus.addInterceptor({
      intercept(msg: AbjectMessage): 'pass' | 'drop' | AbjectMessage {
        if (msg.routing.to === backendUIId && msg.routing.method === 'updateAuth') {
          const { enabled, username, password } = msg.payload as {
            enabled: boolean; username: string; password: string;
          };
          const changed = authConfig.enabled !== enabled
            || authConfig.username !== username
            || authConfig.password !== password;

          authConfig.enabled = enabled;
          authConfig.username = username;
          authConfig.password = password;

          if (changed) {
            sessionStore.clearAll();
            alog.info(`Auth config updated on main thread (enabled=${enabled})`);
          }
        }
        return 'pass'; // always pass through — BackendUI still handles it
      },
    });
  }

  /**
   * Connect an authenticated WebSocket to BackendUI.
   * In worker mode: create MessageChannel, relay ws ↔ port, transfer port to UI worker.
   * In non-worker mode: pass WebSocket directly to BackendUI.
   */
  function connectFrontend(ws: import('ws').WebSocket): void {
    if (DEDICATED_WORKERS && uiBridge) {
      // Worker mode: relay via MessageChannel
      const { port1, port2 } = new MessageChannel();

      // Relay: ws → port1 (to worker)
      ws.on('message', (data: Buffer | string) => {
        port1.postMessage(typeof data === 'string' ? data : data.toString());
      });

      // Relay: port1 (from worker) → ws
      port1.on('message', (data: unknown) => {
        if (ws.readyState === 1) {
          ws.send(String(data));
        }
      });

      // Clean up on close
      ws.on('close', () => {
        port1.close();
      });
      port1.on('close', () => {
        if (ws.readyState === 1) {
          ws.close();
        }
      });

      // Transfer port2 to UI worker for BackendUI to use as transport
      uiBridge.transferPort('ws-relay', port2);
      alog.info('Frontend WebSocket relayed to UI worker via MessagePort');
    } else if (backendUI) {
      // Non-worker mode: direct WebSocket
      backendUI.addWebSocket(ws);
    }
  }

  const wsServer = new NodeWebSocketServer({
    port: WS_PORT,
    host: '127.0.0.1',
    perMessageDeflate: false,
  });

  wsServer.onConnection((ws) => {
    alog.info('Frontend connection received');
    if (authConfig.enabled) {
      alog.info('Frontend connected (auth required)');
      authenticateConnection(ws, authConfig, sessionStore).then(({ result }) => {
        if (result === 'authenticated') {
          alog.info('Frontend authenticated');
          connectFrontend(ws);
        } else {
          alog.info(`Frontend auth ${result}, closing`);
          ws.close(1008, `Authentication ${result}`);
        }
      });
    } else {
      alog.info('Frontend connected');
      ws.send(JSON.stringify({ type: 'authNotRequired' }));
      connectFrontend(ws);
    }
  });

  // Wait for the TCP port to actually be bound before proceeding
  await wsServer.ready();
  log.timed('WS server listening');

  // Register constructors with Factory
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
  runtime.objectFactory.registerConstructor('FileSystem', () => new FileSystem());
  runtime.objectFactory.registerConstructor('Theme', () => new ThemeAbject());
  runtime.objectFactory.registerConstructor('WindowManager', () => new WindowManager());
  runtime.objectFactory.registerConstructor('WidgetManager', () => new WidgetManager());
  runtime.objectFactory.registerConstructor('ProxyGenerator', () => new ProxyGenerator());
  runtime.objectFactory.registerConstructor('Negotiator', () => new Negotiator());
  runtime.objectFactory.registerConstructor('HealthMonitor', () => new HealthMonitor());
  runtime.objectFactory.registerConstructor('ObjectCreator', () => new ObjectCreator());
  runtime.objectFactory.registerConstructor('AbjectEditor', () => new AbjectEditor());
  runtime.objectFactory.registerConstructor('Settings', () => new Settings());
  runtime.objectFactory.registerConstructor('AppExplorer', () => new AppExplorer());
  runtime.objectFactory.registerConstructor('ObjectBrowser', () => new ObjectBrowser());
  runtime.objectFactory.registerConstructor('ObjectCatalog', () => new ObjectCatalog());
  runtime.objectFactory.registerConstructor('JobManager', () => new JobManager());
  runtime.objectFactory.registerConstructor('JobBrowser', () => new JobBrowser());
  runtime.objectFactory.registerConstructor('GoalManager', () => new GoalManager());
  runtime.objectFactory.registerConstructor('GoalBrowser', () => new GoalBrowser());
  runtime.objectFactory.registerConstructor('Chat', () => new Chat());
  runtime.objectFactory.registerConstructor('AgentAbject', () => new AgentAbject());
  runtime.objectFactory.registerConstructor('GoalObserver', () => new GoalObserver());
  runtime.objectFactory.registerConstructor('AbjectStore', () => new AbjectStore());
  runtime.objectFactory.registerConstructor('Supervisor', () => new Supervisor());
  runtime.objectFactory.registerConstructor('Taskbar', () => new Taskbar());
  runtime.objectFactory.registerConstructor('WorkspaceManager', () => new WorkspaceManager());
  runtime.objectFactory.registerConstructor('WorkspaceRegistry', () => new WorkspaceRegistry());
  runtime.objectFactory.registerConstructor('WorkspaceSwitcher', () => new WorkspaceSwitcher());
  runtime.objectFactory.registerConstructor('GlobalSettings', () => new GlobalSettings());
  runtime.objectFactory.registerConstructor('GlobalToolbar', () => new GlobalToolbar());
  runtime.objectFactory.registerConstructor('PeerNetwork', () => new PeerNetwork());
  runtime.objectFactory.registerConstructor('ProcessExplorer', () => new ProcessExplorer());
  runtime.objectFactory.registerConstructor('LLMMonitor', () => new LLMMonitor());
  runtime.objectFactory.registerConstructor('Identity', () => new IdentityObject());
  runtime.objectFactory.registerConstructor('PeerRegistry', () => new PeerRegistry());
  runtime.objectFactory.registerConstructor('RemoteRegistry', () => new RemoteRegistry());
  runtime.objectFactory.registerConstructor('PeerRouter', () => new PeerRouter());
  runtime.objectFactory.registerConstructor('SignalingRelay', () => new SignalingRelayObject());
  runtime.objectFactory.registerConstructor('PeerDiscovery', () => new PeerDiscoveryObject());
  runtime.objectFactory.registerConstructor('WorkspaceShareRegistry', () => new WorkspaceShareRegistry());
  runtime.objectFactory.registerConstructor('WorkspaceBrowser', () => new WorkspaceBrowser());
  runtime.objectFactory.registerConstructor('WebParser', () => new WebParser());
  runtime.objectFactory.registerConstructor('WebBrowser', () => new WebBrowser());
  runtime.objectFactory.registerConstructor('WebAgent', () => new WebAgent());
  runtime.objectFactory.registerConstructor('WebBrowserViewer', () => new WebBrowserViewer());
  runtime.objectFactory.registerConstructor('SharedState', () => new SharedState());
  runtime.objectFactory.registerConstructor('TupleSpace', () => new TupleSpace());
  runtime.objectFactory.registerConstructor('FileTransfer', () => new FileTransfer());
  runtime.objectFactory.registerConstructor('MediaStream', () => new MediaStreamCapability());
  runtime.objectFactory.registerConstructor('ShellExecutor', () => new ShellExecutor());
  runtime.objectFactory.registerConstructor('HostFileSystem', () => new HostFileSystem());
  runtime.objectFactory.registerConstructor('WebSearch', () => new WebSearch());
  runtime.objectFactory.registerConstructor('WebFetch', () => new WebFetch());
  runtime.objectFactory.registerConstructor('Screenshot', () => new Screenshot());
  runtime.objectFactory.registerConstructor('SkillRegistry', () => new SkillRegistry(path.resolve(DATA_DIR, 'skills')));
  runtime.objectFactory.registerConstructor('SkillBrowser', () => new SkillBrowser());
  runtime.objectFactory.registerConstructor('SkillAgent', () => new SkillAgent());
  runtime.objectFactory.registerConstructor('ObjectAgent', () => new ObjectAgent());

  // Mark worker-eligible constructors (only used when workerEnabled).
  // Per-workspace objects use registryHint to discover workspace dependencies.
  if (runtime.config.workerEnabled) {
    const workerEligible = [
      // Global capabilities
      'LLMObject', 'HttpClient', 'Timer',
      'Clipboard', 'Console', 'FileSystem',
      // Global services
      'GlobalSettings', 'PeerNetwork', 'ObjectCatalog', 'ObjectBrowser', 'ProcessExplorer', 'LLMMonitor', 'ProxyGenerator', 'Negotiator', 'HealthMonitor',
      // Per-workspace objects (use workspace registry via registryHint)
      'AbjectStore', 'Theme', 'Settings', 'AppExplorer',
      'TupleSpace',
      'GoalManager', 'GoalBrowser',
      'JobManager', 'JobBrowser',
      'AgentAbject', 'ObjectCreator',
      'Chat', 'AbjectEditor', 'Taskbar',
    ];
    for (const name of workerEligible) {
      runtime.objectFactory.markWorkerEligible(name);
    }
  }

  log.timed('constructors registered');

  // Spawn Supervisor early so it can supervise other objects
  const supervisorId = await factorySpawn('Supervisor');

  // Helper: spawn via Factory, register with Supervisor, return ID
  async function supervisedSpawn(name: string, restart: RestartType = 'permanent', typeId?: TypeId): Promise<AbjectId> {
    const id = await factorySpawn(name, typeId);
    await bootstrapRequest(supervisorId, 'addChild', {
      id, constructorName: name, restart,
    });
    return id;
  }

  // Spawn in dependency order via Factory messages
  // Global objects (shared across workspaces)
  const httpClientId = await supervisedSpawn('HttpClient');
  const llmId = await supervisedSpawn('LLMObject');

  // Configure LLM with API keys
  if (anthropicKey || openaiKey) {
    await bootstrapRequest(llmId, 'configure', {
      anthropicApiKey: anthropicKey,
      openaiApiKey: openaiKey,
    });
  }

  const storageId = await supervisedSpawn('Storage');
  const timerId = await supervisedSpawn('Timer');
  const clipboardId = await supervisedSpawn('Clipboard');
  const consoleId = await supervisedSpawn('Console');
  const filesystemId = await supervisedSpawn('FileSystem');
  const webParserId = await supervisedSpawn('WebParser');
  const webBrowserId = await supervisedSpawn('WebBrowser');
  // WebAgent is per-workspace (spawned by WorkspaceManager), not global
  const shellExecutorId = await supervisedSpawn('ShellExecutor');
  const hostFilesystemId = await supervisedSpawn('HostFileSystem');
  const webSearchId = await supervisedSpawn('WebSearch');
  const webFetchId = await supervisedSpawn('WebFetch');
  const screenshotId = await supervisedSpawn('Screenshot');
  const windowManagerId = await supervisedSpawn('WindowManager');
  const widgetManagerId = await supervisedSpawn('WidgetManager');

  log.timed('core capabilities spawned');

  // ── P2P Layer: dedicated worker or main thread ───────────────────────
  let localPeerId: string | undefined;
  let identityId: AbjectId;
  let peerRegistryId: AbjectId;
  let remoteRegistryId: AbjectId;
  let peerRouterId: AbjectId;
  let signalingRelayId: AbjectId;
  let peerDiscoveryId: AbjectId;
  let p2pBridge: DedicatedWorkerBridge | null = null;

  /** Compute a system-scoped TypeId: {peerId}/system/{name} */
  function systemTypeId(name: string): TypeId | undefined {
    if (!localPeerId) return undefined;
    return `${localPeerId}/system/${name}` as TypeId;
  }

  // PeerRouter always runs on main thread (it's a MessageInterceptor)
  peerRouterId = await supervisedSpawn('PeerRouter');
  const peerRouterObj = runtime.objectFactory.getObject(peerRouterId) as unknown as PeerRouter;
  peerRouterObj.setBus(bus);
  bus.addInterceptor(peerRouterObj);

  if (DEDICATED_WORKERS) {
    // ── P2P Worker mode ──────────────────────────────────────────────
    alog.info('Spawning dedicated P2P worker...');

    // Pre-assign IDs for all P2P objects
    identityId = randomUUID() as AbjectId;
    peerRegistryId = randomUUID() as AbjectId;
    remoteRegistryId = randomUUID() as AbjectId;
    signalingRelayId = randomUUID() as AbjectId;
    peerDiscoveryId = randomUUID() as AbjectId;

    const p2pWorkerScript = new URL('../workers/p2p-worker-node.ts', import.meta.url);
    const p2pWorker = new NodeWorkerAdapter(p2pWorkerScript);
    p2pBridge = new DedicatedWorkerBridge(p2pWorker, bus);

    // Register all P2P object IDs on the main bus before worker init
    const p2pObjectIds = [identityId, peerRegistryId, remoteRegistryId, signalingRelayId, peerDiscoveryId];
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
    ];
    for (const reg of p2pRegistrations) {
      await bootstrapRequest(registryId, 'register', {
        objectId: reg.id,
        manifest: {
          name: reg.name,
          description: `${reg.name} (running in P2P worker)`,
          version: '1.0.0',
          interface: { id: reg.interfaceId, name: reg.name, description: '', methods: [] },
          requiredCapabilities: [],
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

      // On new connection, announce routes
      if (data.event === 'connected' && data.peerId) {
        peerRouterObj.announceRoutesToPeer(data.peerId as string as PeerId).catch(() => {});
      }
    });

    // Wire PeerRouter → P2P bridge for transport sends
    peerRouterObj.setP2PBridge(p2pBridge);

    // Wait for worker ready, then send config
    await p2pBridge.waitReady();
    p2pBridge.sendConfig({
      identityId: identityId as string,
      peerRegistryId: peerRegistryId as string,
      remoteRegistryId: remoteRegistryId as string,
      signalingRelayId: signalingRelayId as string,
      peerDiscoveryId: peerDiscoveryId as string,
      registryId: registryId as string,
    });

    // Wait a tick for the worker to bootstrap (it sends 'ready' again after P2P init)
    // Note: the first 'ready' was from the worker starting up,
    // the actual P2P bootstrap happens after init-config
    // We need to wait for the P2P objects to be fully initialized
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

  const globalSettingsId = await supervisedSpawn('GlobalSettings', 'permanent', systemTypeId('GlobalSettings'));
  const peerNetworkId = await supervisedSpawn('PeerNetwork', 'permanent', systemTypeId('PeerNetwork'));
  const globalToolbarId = await supervisedSpawn('GlobalToolbar', 'permanent', systemTypeId('GlobalToolbar'));
  const objectBrowserId = await supervisedSpawn('ObjectBrowser', 'permanent', systemTypeId('ObjectBrowser'));
  const processExplorerId = await supervisedSpawn('ProcessExplorer', 'permanent', systemTypeId('ProcessExplorer'));
  const llmMonitorId = await supervisedSpawn('LLMMonitor', 'permanent', systemTypeId('LLMMonitor'));
  const skillRegistryId = await supervisedSpawn('SkillRegistry', 'permanent', systemTypeId('SkillRegistry'));
  const skillBrowserId = await supervisedSpawn('SkillBrowser', 'permanent', systemTypeId('SkillBrowser'));

  const proxyGenId = await supervisedSpawn('ProxyGenerator', 'permanent', systemTypeId('ProxyGenerator'));
  const negotiatorId = await supervisedSpawn('Negotiator', 'permanent', systemTypeId('Negotiator'));
  const healthMonitorId = await supervisedSpawn('HealthMonitor', 'permanent', systemTypeId('HealthMonitor'));

  // WorkspaceSwitcher is a global UI (never hidden during workspace switch)
  const workspaceSwitcherId = await supervisedSpawn('WorkspaceSwitcher', 'permanent', systemTypeId('WorkspaceSwitcher'));

  log.timed('global UI + services spawned');

  // WorkspaceManager spawns per-workspace objects (Settings, Taskbar, Chat, etc.)
  const workspaceManagerId = await supervisedSpawn('WorkspaceManager', 'permanent', systemTypeId('WorkspaceManager'));
  log.timed('WorkspaceManager spawned');

  // Boot workspaces BEFORE spawning WSR — boot() loads persisted workspaces
  // (including their access modes) so listSharedWorkspaces returns real data.
  // Cannot happen during onInit because Factory would deadlock processing our spawn request.
  await bootstrapRequest(workspaceManagerId, 'boot', {});
  log.timed('workspace boot complete');

  // WorkspaceShareRegistry must spawn AFTER boot() so listSharedWorkspaces finds shared workspaces
  const workspaceShareRegistryId = await supervisedSpawn('WorkspaceShareRegistry', 'permanent', systemTypeId('WorkspaceShareRegistry'));

  // Register allowed system objects for remote access
  peerRouterObj.allowSystemObjectDirect(workspaceShareRegistryId, WORKSPACE_SHARE_REGISTRY_ID, systemTypeId('WorkspaceShareRegistry'));
  peerRouterObj.announceRoutesToAll().catch(() => {});
  const workspaceBrowserId = await supervisedSpawn('WorkspaceBrowser', 'permanent', systemTypeId('WorkspaceBrowser'));

  // ObjectCatalog: background service maintaining live cache of all registrations
  const objectCatalogId = await supervisedSpawn('ObjectCatalog', 'permanent', systemTypeId('ObjectCatalog'));

  // ALL objects are now spawned and init'd — safe to start health monitoring.
  const monitoredIds = [
    httpClientId, llmId, storageId, timerId, clipboardId,
    consoleId, filesystemId, webParserId, webBrowserId,
    shellExecutorId, hostFilesystemId, webSearchId, webFetchId,
    windowManagerId, widgetManagerId,
    identityId, peerRegistryId, remoteRegistryId, peerRouterId,
    signalingRelayId, peerDiscoveryId,
    workspaceShareRegistryId, workspaceBrowserId, objectCatalogId,
    globalSettingsId, peerNetworkId, globalToolbarId, objectBrowserId, processExplorerId, skillRegistryId, skillBrowserId,
    proxyGenId, negotiatorId,
    workspaceSwitcherId, workspaceManagerId,
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
  console.log('');
  console.log(`  ABJECTS server running`);
  console.log('');
  console.log(`  WebSocket:  ws://localhost:${WS_PORT}`);
  console.log(`  Auth:       ${authConfig.enabled ? 'enabled' : 'disabled'}`);
  console.log(`  Workers:    ${DEDICATED_WORKERS ? 'UI + P2P dedicated' : 'disabled'}`);
  console.log(`  Objects:    ${runtime.objectRegistry.objectCount}`);
  console.log('');

  // Handle graceful shutdown
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    alog.info('Shutting down...');
    sessionStore.destroy();
    // Close WS server first to release the port, then clean up runtime
    wsServer.close()
      .then(() => runtime.stop())
      .catch(() => {})
      .finally(() => process.exit(0));
    // If cleanup takes too long, force exit
    setTimeout(() => process.exit(1), 3000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

process.on('unhandledRejection', (reason) => {
  alog.error('Unhandled rejection (server stayed up):', reason);
});

main().catch((err) => {
  alog.error('Fatal startup error:', err);
  process.exit(1);
});
