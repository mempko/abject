/**
 * Abjects Node.js Backend Entry Point
 *
 * Mirrors the bootstrap in src/index.ts but without DOM/Canvas.
 * All system objects run here; the browser is a thin rendering client.
 */

// Polyfill WebRTC APIs for Node.js (PeerTransport needs RTCPeerConnection, etc.)
import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  RTCDataChannel,
} from 'node-datachannel/polyfill';

Object.assign(globalThis, {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  RTCDataChannel,
});

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
import { WidgetManager } from '../src/objects/widget-manager.js';
import { ThemeAbject } from '../src/objects/theme.js';
import { WindowManager } from '../src/objects/window-manager.js';
import { AbjectEditor } from '../src/objects/abject-editor.js';
import { JobManager } from '../src/objects/job-manager.js';
import { JobBrowser } from '../src/objects/job-browser.js';
import { Chat } from '../src/objects/chat.js';
import { AgentAbject } from '../src/objects/agent-abject.js';
import { AbjectStore } from '../src/objects/abject-store.js';
import { Supervisor } from '../src/runtime/supervisor.js';
import type { RestartType } from '../src/runtime/supervisor.js';
import { WorkspaceManager } from '../src/objects/workspace-manager.js';
import { WorkspaceRegistry } from '../src/objects/workspace-registry.js';
import { WorkspaceSwitcher } from '../src/objects/workspace-switcher.js';
import { GlobalSettings } from '../src/objects/global-settings.js';
import { GlobalToolbar } from '../src/objects/global-toolbar.js';
import { PeerNetwork } from '../src/objects/peer-network.js';
import { ObjectManager } from '../src/objects/object-manager.js';
import { IdentityObject } from '../src/objects/identity.js';
import { PeerRegistry } from '../src/objects/peer-registry.js';
import { RemoteRegistry } from '../src/objects/remote-registry.js';
import { PeerRouter } from '../src/network/peer-router.js';
import { SignalingRelayObject } from '../src/objects/signaling-relay.js';
import { PeerDiscoveryObject } from '../src/objects/peer-discovery.js';
import { SharedState } from '../src/objects/capabilities/shared-state.js';
import { FileTransfer } from '../src/objects/capabilities/file-transfer.js';
import { MediaStreamCapability } from '../src/objects/capabilities/media-stream.js';
import { WorkspaceShareRegistry, WORKSPACE_SHARE_REGISTRY_ID } from '../src/objects/workspace-share-registry.js';
import { WorkspaceBrowser } from '../src/objects/workspace-browser.js';
import { NodeWebSocketServer } from '../src/network/websocket-server.js';
import { NodeWorkerAdapter } from './node-worker-adapter.js';
import { loadAuthConfig, SessionStore, authenticateConnection } from './auth.js';
import { Log } from '../src/core/timed-log.js';
import * as path from 'node:path';
import os from 'node:os';

const WS_PORT = parseInt(process.env.WS_PORT ?? '7719', 10);
const DATA_DIR = process.env.ABJECTS_DATA_DIR ?? '.abjects';
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

  // Create BackendUI (replaces UIServer)
  const backendUI = new BackendUI();
  runtime.registerCoreObject(backendUI);

  // Start runtime (bootstraps Registry + Factory)
  await runtime.start();
  log.timed('runtime started');

  const bus = runtime.messageBus;
  const factoryId = runtime.objectFactory.id;
  const registryId = runtime.objectRegistry.id;
  const BOOTSTRAP_ID = 'bootstrap' as AbjectId;

  // Register a temporary bootstrap sender on the bus for request-reply
  const pendingReplies = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  bus.register(BOOTSTRAP_ID);
  bus.setReplyHandler(BOOTSTRAP_ID, (msg: AbjectMessage) => {
    const pending = pendingReplies.get(msg.header.correlationId!);
    if (pending) {
      pendingReplies.delete(msg.header.correlationId!);
      if (msg.header.type === 'error') {
        pending.reject(new Error((msg.payload as { message: string }).message));
      } else {
        pending.resolve(msg.payload);
      }
    }
  });

  function bootstrapRequest<T>(target: AbjectId, method: string, payload: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const msg = message.request(BOOTSTRAP_ID, target, method, payload);
      pendingReplies.set(msg.header.messageId, {
        resolve: resolve as (v: unknown) => void, reject,
      });
      bus.send(msg).catch(reject);
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

  // Register constructors with Factory
  runtime.objectFactory.registerConstructor('HttpClient', () => new HttpClient());
  runtime.objectFactory.registerConstructor('LLMObject', () => new LLMObject());
  runtime.objectFactory.registerConstructor('Storage', (args?: unknown) => {
    const opts = args as { dbName?: string } | undefined;
    // For workspace storage, use a separate file path
    if (opts?.dbName) {
      const wsId = opts.dbName.replace('abjects-storage-', '');
      const storagePath = path.join(process.cwd(), DATA_DIR, `ws-${wsId}`, 'storage.json');
      return new NodeStorage(storagePath);
    }
    return new NodeStorage(path.join(process.cwd(), DATA_DIR, 'storage.json'));
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
  runtime.objectFactory.registerConstructor('JobManager', () => new JobManager());
  runtime.objectFactory.registerConstructor('JobBrowser', () => new JobBrowser());
  runtime.objectFactory.registerConstructor('Chat', () => new Chat());
  runtime.objectFactory.registerConstructor('AgentAbject', () => new AgentAbject());
  runtime.objectFactory.registerConstructor('AbjectStore', () => new AbjectStore());
  runtime.objectFactory.registerConstructor('Supervisor', () => new Supervisor());
  runtime.objectFactory.registerConstructor('Taskbar', () => new Taskbar());
  runtime.objectFactory.registerConstructor('WorkspaceManager', () => new WorkspaceManager());
  runtime.objectFactory.registerConstructor('WorkspaceRegistry', () => new WorkspaceRegistry());
  runtime.objectFactory.registerConstructor('WorkspaceSwitcher', () => new WorkspaceSwitcher());
  runtime.objectFactory.registerConstructor('GlobalSettings', () => new GlobalSettings());
  runtime.objectFactory.registerConstructor('GlobalToolbar', () => new GlobalToolbar());
  runtime.objectFactory.registerConstructor('PeerNetwork', () => new PeerNetwork());
  runtime.objectFactory.registerConstructor('ObjectManager', () => new ObjectManager());
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
  runtime.objectFactory.registerConstructor('FileTransfer', () => new FileTransfer());
  runtime.objectFactory.registerConstructor('MediaStream', () => new MediaStreamCapability());

  // Mark worker-eligible constructors (only used when workerEnabled).
  // Per-workspace objects use registryHint to discover workspace dependencies.
  if (runtime.config.workerEnabled) {
    const workerEligible = [
      // Global capabilities
      'LLMObject', 'HttpClient', 'Timer',
      'Clipboard', 'Console', 'FileSystem',
      // Global services
      'GlobalSettings', 'PeerNetwork', 'ObjectBrowser', 'ProxyGenerator', 'Negotiator', 'HealthMonitor',
      // Per-workspace objects (use workspace registry via registryHint)
      'AbjectStore', 'Theme', 'Settings', 'AppExplorer',
      'JobManager', 'JobBrowser', 'ObjectManager',
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
  const windowManagerId = await supervisedSpawn('WindowManager');
  const widgetManagerId = await supervisedSpawn('WidgetManager');

  log.timed('core capabilities spawned');
  const identityId = await supervisedSpawn('Identity');

  // Get peerId for computing system TypeIds
  let localPeerId: string | undefined;
  try {
    const identity = await bootstrapRequest<{ peerId: string }>(identityId, 'getIdentity', {});
    localPeerId = identity.peerId;
    alog.info(`Local peerId: ${localPeerId.slice(0, 16)}...`);
  } catch {
    alog.warn('Could not get peerId — system TypeIds will not be assigned');
  }

  /** Compute a system-scoped TypeId: {peerId}/system/{name} */
  function systemTypeId(name: string): TypeId | undefined {
    if (!localPeerId) return undefined;
    return `${localPeerId}/system/${name}` as TypeId;
  }

  log.timed('identity ready');
  const peerRegistryId = await supervisedSpawn('PeerRegistry', 'permanent', systemTypeId('PeerRegistry'));
  const remoteRegistryId = await supervisedSpawn('RemoteRegistry', 'permanent', systemTypeId('RemoteRegistry'));
  const peerRouterId = await supervisedSpawn('PeerRouter', 'permanent', systemTypeId('PeerRouter'));

  // Install PeerRouter interceptor for transparent P2P routing
  const peerRegistryObj = runtime.objectFactory.getObject(peerRegistryId) as PeerRegistry;
  const peerRouterObj = runtime.objectFactory.getObject(peerRouterId) as unknown as PeerRouter;
  peerRouterObj.setBus(bus);
  peerRouterObj.setPeerRegistry(peerRegistryObj);
  bus.addInterceptor(peerRouterObj);

  // Wire PeerRegistry → PeerRouter for inbound messages
  peerRegistryObj.onRemoteMessage((msg, fromPeerId) => {
    peerRouterObj.handleIncomingMessage(msg, fromPeerId);
  });

  // Spawn and wire SignalingRelay and PeerDiscovery
  const signalingRelayId = await supervisedSpawn('SignalingRelay', 'permanent', systemTypeId('SignalingRelay'));
  const peerDiscoveryId = await supervisedSpawn('PeerDiscovery', 'permanent', systemTypeId('PeerDiscovery'));

  const signalingRelayObj = runtime.objectFactory.getObject(signalingRelayId) as unknown as SignalingRelayObject;
  const peerDiscoveryObj = runtime.objectFactory.getObject(peerDiscoveryId) as unknown as PeerDiscoveryObject;

  signalingRelayObj.setPeerRegistry(peerRegistryObj);
  peerDiscoveryObj.setPeerRegistry(peerRegistryObj);
  peerDiscoveryObj.setSignalingRelay(signalingRelayObj);

  // Set the signaling relay as fallback for PeerRegistry when no signaling server is available
  peerRegistryObj.setSignalingRelay(signalingRelayObj);

  log.timed('P2P layer ready');
  // Set up auth gate BEFORE GlobalSettings spawns, so applySavedAuthConfig()
  // can update the authConfig during its onInit()
  const authConfig = loadAuthConfig();
  const sessionStore = new SessionStore();
  backendUI.setAuthGate(authConfig, sessionStore);

  const globalSettingsId = await supervisedSpawn('GlobalSettings', 'permanent', systemTypeId('GlobalSettings'));
  const peerNetworkId = await supervisedSpawn('PeerNetwork', 'permanent', systemTypeId('PeerNetwork'));
  const globalToolbarId = await supervisedSpawn('GlobalToolbar', 'permanent', systemTypeId('GlobalToolbar'));
  const objectBrowserId = await supervisedSpawn('ObjectBrowser', 'permanent', systemTypeId('ObjectBrowser'));

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

  // ALL objects are now spawned and init'd — safe to start health monitoring.
  const monitoredIds = [
    httpClientId, llmId, storageId, timerId, clipboardId,
    consoleId, filesystemId, webParserId, webBrowserId,
    windowManagerId, widgetManagerId,
    identityId, peerRegistryId, remoteRegistryId, peerRouterId,
    signalingRelayId, peerDiscoveryId,
    workspaceShareRegistryId, workspaceBrowserId,
    globalSettingsId, peerNetworkId, globalToolbarId, objectBrowserId,
    proxyGenId, negotiatorId,
    workspaceSwitcherId, workspaceManagerId,
  ];
  await Promise.all(monitoredIds.map(async (objId) => {
    await bootstrapRequest(healthMonitorId, 'monitorObject', { objectId: objId });
    await bootstrapRequest(healthMonitorId, 'markObjectReady', { objectId: objId });
  }));
  await bootstrapRequest(healthMonitorId, 'startMonitoring', {});

  // Clean up bootstrap handler
  bus.removeReplyHandler(BOOTSTRAP_ID);
  bus.unregister(BOOTSTRAP_ID);

  // Start WebSocket server
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
          backendUI.setWebSocket(ws);
        } else {
          alog.info(`Frontend auth ${result}, closing`);
          ws.close(1008, `Authentication ${result}`);
        }
      });
    } else {
      alog.info('Frontend connected');
      ws.send(JSON.stringify({ type: 'authNotRequired' }));
      backendUI.setWebSocket(ws);
    }
  });

  log.summary('server ready');
  console.log('');
  console.log(`  ABJECTS server running`);
  console.log('');
  console.log(`  WebSocket:  ws://localhost:${WS_PORT}`);
  console.log(`  Auth:       ${authConfig.enabled ? 'enabled' : 'disabled'}`);
  console.log(`  Objects:    ${runtime.objectRegistry.objectCount}`);
  console.log(`  Surfaces:   ${backendUI.surfaceCount}`);
  console.log('');
  console.log(`  Waiting for frontend connection...`);

  // Handle graceful shutdown
  const shutdown = async () => {
    alog.info('Shutting down...');
    sessionStore.destroy();
    await wsServer.close();
    await runtime.stop();
    process.exit(0);
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
