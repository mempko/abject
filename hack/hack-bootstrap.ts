/**
 * hack-bootstrap.ts — Shared bootstrap function for security audit harness.
 *
 * Extracts the reusable core bootstrap logic from server/index.ts
 * (constructor registration + spawn ordering) into an exported function.
 * Does NOT include WebSocket server, auth gate, or shutdown handlers.
 */

// Polyfill WebRTC APIs for Node.js
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
import { BackendUI } from '../server/backend-ui.js';
import { LLMObject } from '../src/objects/llm-object.js';
import { ObjectCreator } from '../src/objects/object-creator.js';
import { ProxyGenerator } from '../src/objects/proxy-generator.js';
import { Negotiator } from '../src/protocol/negotiator.js';
import { HealthMonitor } from '../src/protocol/health-monitor.js';
import { HttpClient } from '../src/objects/capabilities/http-client.js';
import { NodeStorage } from '../server/node-storage.js';
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
import { ProcessExplorer } from '../src/objects/process-explorer.js';
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
import type { MessageBus } from '../src/runtime/message-bus.js';
import * as path from 'node:path';

export interface BootOptions {
  dataDir: string;
  debug?: boolean;
  /** If set, pre-seed storage so PeerRegistry only connects to this signaling URL (not the public default). */
  signalingUrl?: string;
}

export interface BootResult {
  runtime: ReturnType<typeof getRuntime>;
  bus: MessageBus;
  factoryId: AbjectId;
  registryId: AbjectId;
  workspaceManagerId: AbjectId;
  workspaceShareRegistryId: AbjectId;
  peerRegistryId: AbjectId;
  peerRouterId: AbjectId;
  identityId: AbjectId;
  storageId: AbjectId;
  peerRouterObj: PeerRouter;
  peerRegistryObj: PeerRegistry;
  peerId: string;
  bootstrapRequest: <T>(target: AbjectId, method: string, payload: unknown) => Promise<T>;
  cleanup: () => void;
}

export async function bootAbjectsCore(opts: BootOptions): Promise<BootResult> {
  const DATA_DIR = opts.dataDir;

  resetRuntime();

  const runtime = getRuntime({
    debug: opts.debug ?? false,
    workerEnabled: false,
    workerCount: 0,
  });

  const backendUI = new BackendUI();
  runtime.registerCoreObject(backendUI);

  await runtime.start();

  const bus = runtime.messageBus;
  const factoryId = runtime.objectFactory.id;
  const registryId = runtime.objectRegistry.id;
  const BOOTSTRAP_ID = 'bootstrap' as AbjectId;

  // Register a temporary bootstrap sender. Replies arrive via the mailbox.
  const pendingReplies = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const bootMailbox = bus.register(BOOTSTRAP_ID);
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
    const o = args as { dbName?: string } | undefined;
    if (o?.dbName) {
      const wsId = o.dbName.replace('abjects-storage-', '');
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
  runtime.objectFactory.registerConstructor('ProcessExplorer', () => new ProcessExplorer());
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

  // Spawn Supervisor early
  const supervisorId = await factorySpawn('Supervisor');

  async function supervisedSpawn(name: string, restart: RestartType = 'permanent', typeId?: TypeId): Promise<AbjectId> {
    const id = await factorySpawn(name, typeId);
    await bootstrapRequest(supervisorId, 'addChild', {
      id, constructorName: name, restart,
    });
    return id;
  }

  // Spawn in dependency order
  await supervisedSpawn('HttpClient');
  const llmId = await supervisedSpawn('LLMObject');

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (anthropicKey || openaiKey) {
    await bootstrapRequest(llmId, 'configure', {
      anthropicApiKey: anthropicKey,
      openaiApiKey: openaiKey,
    });
  }

  const storageId = await supervisedSpawn('Storage');

  // Pre-seed signaling URL so PeerRegistry doesn't connect to the public default
  if (opts.signalingUrl) {
    await bootstrapRequest(storageId, 'set', {
      key: 'peer-registry:signaling-urls',
      value: [opts.signalingUrl],
    });
  }

  await supervisedSpawn('Timer');
  await supervisedSpawn('Clipboard');
  await supervisedSpawn('Console');
  await supervisedSpawn('FileSystem');
  await supervisedSpawn('WebParser');
  await supervisedSpawn('WebBrowser');
  await supervisedSpawn('WindowManager');
  await supervisedSpawn('WidgetManager');

  const identityId = await supervisedSpawn('Identity');

  let localPeerId = '';
  try {
    const identity = await bootstrapRequest<{ peerId: string }>(identityId, 'getIdentity', {});
    localPeerId = identity.peerId;
  } catch {
    console.warn('[BOOT] Could not get peerId');
  }

  function systemTypeId(name: string): TypeId | undefined {
    if (!localPeerId) return undefined;
    return `${localPeerId}/system/${name}` as TypeId;
  }

  const peerRegistryId = await supervisedSpawn('PeerRegistry', 'permanent', systemTypeId('PeerRegistry'));
  const remoteRegistryId = await supervisedSpawn('RemoteRegistry', 'permanent', systemTypeId('RemoteRegistry'));
  const peerRouterId = await supervisedSpawn('PeerRouter', 'permanent', systemTypeId('PeerRouter'));

  const peerRegistryObj = runtime.objectFactory.getObject(peerRegistryId) as PeerRegistry;
  const peerRouterObj = runtime.objectFactory.getObject(peerRouterId) as unknown as PeerRouter;
  peerRouterObj.setBus(bus);
  peerRouterObj.setPeerRegistry(peerRegistryObj);
  bus.addInterceptor(peerRouterObj);

  peerRegistryObj.onRemoteMessage((msg, fromPeerId) => {
    peerRouterObj.handleIncomingMessage(msg, fromPeerId);
  });

  const signalingRelayId = await supervisedSpawn('SignalingRelay', 'permanent', systemTypeId('SignalingRelay'));
  const peerDiscoveryId = await supervisedSpawn('PeerDiscovery', 'permanent', systemTypeId('PeerDiscovery'));

  const signalingRelayObj = runtime.objectFactory.getObject(signalingRelayId) as unknown as SignalingRelayObject;
  const peerDiscoveryObj = runtime.objectFactory.getObject(peerDiscoveryId) as unknown as PeerDiscoveryObject;

  signalingRelayObj.setPeerRegistry(peerRegistryObj);
  peerDiscoveryObj.setPeerRegistry(peerRegistryObj);
  peerDiscoveryObj.setSignalingRelay(signalingRelayObj);
  peerRegistryObj.setSignalingRelay(signalingRelayObj);

  await supervisedSpawn('GlobalSettings', 'permanent', systemTypeId('GlobalSettings'));
  await supervisedSpawn('PeerNetwork', 'permanent', systemTypeId('PeerNetwork'));
  await supervisedSpawn('GlobalToolbar', 'permanent', systemTypeId('GlobalToolbar'));
  await supervisedSpawn('ObjectBrowser', 'permanent', systemTypeId('ObjectBrowser'));

  await supervisedSpawn('ProxyGenerator', 'permanent', systemTypeId('ProxyGenerator'));
  await supervisedSpawn('Negotiator', 'permanent', systemTypeId('Negotiator'));
  await supervisedSpawn('HealthMonitor', 'permanent', systemTypeId('HealthMonitor'));

  await supervisedSpawn('WorkspaceSwitcher', 'permanent', systemTypeId('WorkspaceSwitcher'));

  const workspaceManagerId = await supervisedSpawn('WorkspaceManager', 'permanent', systemTypeId('WorkspaceManager'));

  // Boot workspaces BEFORE spawning WSR
  await bootstrapRequest(workspaceManagerId, 'boot', {});

  const workspaceShareRegistryId = await supervisedSpawn('WorkspaceShareRegistry', 'permanent', systemTypeId('WorkspaceShareRegistry'));

  peerRouterObj.allowSystemObjectDirect(workspaceShareRegistryId, WORKSPACE_SHARE_REGISTRY_ID, systemTypeId('WorkspaceShareRegistry'));
  peerRouterObj.announceRoutesToAll().catch(() => {});
  await supervisedSpawn('WorkspaceBrowser', 'permanent', systemTypeId('WorkspaceBrowser'));

  // Clean up bootstrap sender
  function cleanup() {
    bootDone = true;
    bus.unregister(BOOTSTRAP_ID);
  }

  return {
    runtime,
    bus,
    factoryId,
    registryId,
    workspaceManagerId,
    workspaceShareRegistryId,
    peerRegistryId,
    peerRouterId,
    identityId,
    storageId,
    peerRouterObj,
    peerRegistryObj,
    peerId: localPeerId,
    bootstrapRequest,
    cleanup,
  };
}
