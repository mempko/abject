/**
 * The desktop edition's display layer: everything the bootstrap adds when
 * there is a screen to draw on.
 *
 * The display server (BackendUI, registered as UIServer) and the browser
 * socket it serves; the window system (WindowManager, WidgetManager and the
 * desktop scene); the display capabilities (Screenshot, AudioOutput, Speech);
 * the global windows and browsers; paired remote browsers (RemoteUIAccess);
 * and, inside the Electron app, its browser windows and updater. The headless
 * edition never imports this file, so none of it is in its bundle.
 */

import { randomUUID } from 'node:crypto';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { AbjectId } from '../src/core/types.js';
import type { Runtime } from '../src/runtime/runtime.js';
import { BackendUI } from './backend-ui.js';
import { authenticateConnection } from './auth.js';
import { NodeWebSocketServer } from '../src/network/websocket-server.js';
import { allowOrigins, clientOriginsFromEnv } from '../src/network/origin-policy.js';
import { NodeWorkerAdapter } from './node-worker-adapter.js';
import { DedicatedWorkerBridge } from '../src/runtime/dedicated-worker-bridge.js';
import { toUIWireData, postUIWireData, normalizeWsPayload } from './ui-transport.js';
import type { UITransportLike } from '../src/network/webrtc-ui-transport.js';
import type { BootContext, HealthResponder, UiLayer } from './boot.js';
import { BrowserWindowHost } from '../src/objects/capabilities/browser-window-host.js';
import { WebBrowserViewer } from '../src/objects/web-browser-viewer.js';
import { Settings } from '../src/objects/settings.js';
import { CommandPaletteAbject } from '../src/objects/command-palette.js';
import { WindowSwitcherAbject } from '../src/objects/window-switcher.js';
import { Taskbar } from '../src/objects/taskbar.js';
import { PeersViewer } from '../src/objects/peers-viewer.js';
import { AppExplorer } from '../src/objects/app-explorer.js';
import { ObjectBrowser } from '../src/objects/object-browser.js';
import { MethodInspector } from '../src/objects/method-inspector.js';
import { WidgetManager } from '../src/objects/widget-manager.js';
import { SceneLibrary } from '../src/objects/scene-library.js';
import { WindowManager } from '../src/objects/window-manager.js';
import { AbjectEditor } from '../src/objects/abject-editor.js';
import { JobBrowser } from '../src/objects/job-browser.js';
import { GoalBrowser } from '../src/objects/goal-browser.js';
import { KnowledgeBrowser } from '../src/objects/knowledge-browser.js';
import { FileManager } from '../src/objects/file-manager.js';
import { FileViewer } from '../src/objects/file-viewer.js';
import { AgentBrowser } from '../src/objects/agent-browser.js';
import { SchedulerBrowser } from '../src/objects/scheduler-browser.js';
import { ChatWindow } from '../src/objects/chat-window.js';
import { ChatBrowser } from '../src/objects/chat-browser.js';
import { WorkspaceSwitcher } from '../src/objects/workspace-switcher.js';
import { Sidebar } from '../src/objects/sidebar.js';
import { GlobalSettings } from '../src/objects/global-settings.js';
import { GlobalToolbar } from '../src/objects/global-toolbar.js';
import { PeerNetwork } from '../src/objects/peer-network.js';
import { ProcessExplorer } from '../src/objects/process-explorer.js';
import { LLMMonitor } from '../src/objects/llm-monitor.js';
import { DataBrowser } from '../src/objects/data-browser.js';
import { AudioOutput } from '../src/objects/capabilities/audio-output.js';
import { Speech } from '../src/objects/capabilities/speech.js';
import { Screenshot } from '../src/objects/capabilities/screenshot.js';
import { SkillBrowser } from '../src/objects/skill-browser.js';
import { ExternalProjectBrowser } from '../src/objects/external-project-browser.js';
import { CatalogBrowser } from '../src/objects/catalog-browser.js';
import { RemoteUIAccess } from '../src/objects/remote-ui-access.js';
import { WorkspaceBrowser } from '../src/objects/workspace-browser.js';
import { WorkspaceCollaboratorInspector } from '../src/objects/workspace-collaborator-inspector.js';
import { WebGatewayBrowser } from '../src/objects/web-gateway-browser.js';
import { AppUpdater } from '../src/objects/app-updater.js';

/** The desktop's display layer, ready to hand to bootServer. */
export function createDesktopUi(): UiLayer {
  let backendUI: BackendUI | null = null;          // main-thread display server (no dedicated workers)
  let uiBridge: DedicatedWorkerBridge | null = null; // the UI worker (dedicated workers)
  const backendUIId = randomUUID() as AbjectId;
  let wsServer: NodeWebSocketServer | undefined;
  let dedicated = true;
  let packagedElectron = false;
  const ids: Record<string, AbjectId> = {};

  /**
   * Connect an authenticated WebSocket to BackendUI.
   * In worker mode: create MessageChannel, relay ws ↔ port, transfer port to UI worker.
   * In non-worker mode: pass WebSocket directly to BackendUI.
   */
  function connectFrontend(ctx: BootContext, ws: import('ws').WebSocket): void {
    if (dedicated && uiBridge) {
      // Worker mode: relay via MessageChannel
      const { port1, port2 } = new MessageChannel();

      // Relay: ws → port1 (to worker)
      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        postUIWireData(port1, normalizeWsPayload(data, isBinary));
      });

      // Relay: port1 (from worker) → ws
      port1.on('message', (data: unknown) => {
        if (ws.readyState === 1) {
          ws.send(toUIWireData(data));
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
      ctx.alog.info('Frontend WebSocket relayed to UI worker via MessagePort');
    } else if (backendUI) {
      // Non-worker mode: direct WebSocket
      backendUI.addWebSocket(ws);
    }
  }

  const layer: UiLayer = {
    workerEligible: [
      // Display capabilities and the global windows
      'Screenshot', 'AudioOutput', 'Speech',
      'GlobalSettings', 'PeerNetwork', 'SceneLibrary',
      'ObjectBrowser', 'MethodInspector', 'ProcessExplorer', 'LLMMonitor',
      'SkillBrowser', 'CatalogBrowser',
      // Per-workspace windows
      'Settings', 'AppExplorer', 'GoalBrowser', 'JobBrowser', 'KnowledgeBrowser',
      'FileManager', 'FileViewer', 'AgentBrowser', 'ExternalProjectBrowser', 'DataBrowser', 'SchedulerBrowser',
      'ChatWindow', 'ChatBrowser', 'AbjectEditor', 'PeersViewer', 'Taskbar',
      'WorkspaceBrowser', 'WorkspaceCollaboratorInspector', 'CommandPalette', 'WindowSwitcher',
      'WebBrowserViewer',
      // The UI shell. WidgetManager moves its entire widget tree with it:
      // windows/widgets/layouts init onto their creator's bus, so they all
      // live in WidgetManager's worker.
      'WidgetManager', 'WindowManager', 'Sidebar', 'GlobalToolbar', 'WorkspaceSwitcher',
    ],

    async beforeRuntimeStart(runtime: Runtime): Promise<void> {
      dedicated = process.env.ABJECTS_DEDICATED_WORKERS !== '0';
      if (!dedicated) {
        // Non-worker fallback: BackendUI runs on main thread (original behavior)
        backendUI = new BackendUI();
        runtime.registerCoreObject(backendUI);
      }
    },

    async afterRuntimeStart(ctx: BootContext): Promise<void> {
      if (!dedicated) return;
      const bus = ctx.runtime.messageBus;
      ctx.alog.info('Spawning dedicated UI worker...');
      const uiWorkerScript = new URL('../workers/ui-worker-node.ts', import.meta.url);
      const uiWorker = new NodeWorkerAdapter(uiWorkerScript);
      uiBridge = new DedicatedWorkerBridge(uiWorker, bus);
      const bridge = uiBridge;
      // Objects constructed locally inside the UI worker announce themselves
      // via bus:registered — hook those so they get a bridge mapping, the same
      // coverage pool workers get. Without it the id is marked worker-hosted
      // with no route, and requests to it die on the no-worker-bridge path.
      bridge.onLocalRegistered = (id) => bus.registerDedicatedBridge(id, bridge);
      bridge.onLocalUnregistered = (id) => bus.unregisterDedicatedBridge(id);
      uiBridge.onDead = (code) => {
        ctx.log.error('==================================================================');
        ctx.log.error(`UI WORKER DIED (exit code ${code}): the desktop UI is gone.`);
        ctx.log.error('Window, widget, and scene requests now fail fast with WORKER_DEAD');
        ctx.log.error('until the server restarts. If the cause was "JS heap out of');
        ctx.log.error('memory", raise ABJECTS_WORKER_MAX_OLD_SPACE_MB or check for a');
        ctx.log.error('client send-queue backlog in the lines above.');
        ctx.log.error('==================================================================');
      };

      // Register BackendUI ID on the main bus before worker init
      // so replies can be routed back to BackendUI during its init
      bus.registerDedicatedBridge(backendUIId, uiBridge);

      // Wait for worker to be ready, then send config
      await uiBridge.waitReady();
      uiBridge.sendConfig({ backendUIId: backendUIId as string, registryId: ctx.registryId as string });
      ctx.log.timed('UI worker ready');

      // Register BackendUI with the Registry so other objects can discover it
      // via discoverDep('UIServer'); providing the UI surface capability is
      // how agents learn this instance has a display.
      await ctx.bootstrapRequest(ctx.registryId, 'register', {
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
      ctx.log.timed('BackendUI registered in Registry');
    },

    async openSocket(ctx: BootContext, health: HealthResponder): Promise<void> {
      // Pages that may open the UI socket: the desktop app's own client, the
      // Vite dev client, and ABJECTS_ALLOWED_ORIGINS. Any other site open in a
      // browser on this machine is refused (src/network/origin-policy.ts).
      // Paired remote clients (client.abject.world) arrive over WebRTC, not
      // through this socket.
      const clientOrigins = clientOriginsFromEnv(process.env);
      for (const bad of clientOrigins.ignored) {
        ctx.log.warn(`ABJECTS_ALLOWED_ORIGINS: ignoring ${bad} (not an http:// or https:// origin)`);
      }
      ctx.log.info(`UI socket accepts pages from ${clientOrigins.origins.join(', ') || 'no origin (non-browser clients only)'}`);

      wsServer = new NodeWebSocketServer({
        port: ctx.wsPort,
        host: '127.0.0.1',
        perMessageDeflate: false,
        allowOrigin: allowOrigins(clientOrigins.origins),
        // Local health and version, on the same port the headless edition
        // serves them on. 503 until boot has finished.
        onHttpRequest: health,
      });

      const { authConfig, sessionStore } = ctx;
      wsServer.onConnection((ws) => {
        ctx.alog.info('Frontend connection received');
        if (authConfig.enabled) {
          ctx.alog.info('Frontend connected (auth required)');
          authenticateConnection(ws, authConfig, sessionStore).then(({ result }) => {
            if (result === 'authenticated') {
              ctx.alog.info('Frontend authenticated');
              connectFrontend(ctx, ws);
            } else {
              ctx.alog.info(`Frontend auth ${result}, closing`);
              ws.close(1008, `Authentication ${result}`);
            }
          });
        } else {
          ctx.alog.info('Frontend connected');
          ws.send(JSON.stringify({ type: 'authNotRequired' }));
          connectFrontend(ctx, ws);
        }
      });

      // Wait for the TCP port to actually be bound before proceeding
      await wsServer.ready();
      ctx.log.timed('WS server listening');
    },

    registerConstructors(ctx: BootContext): void {
      const factory = ctx.runtime.objectFactory;
      factory.registerConstructor('WindowManager', () => new WindowManager());
      factory.registerConstructor('WidgetManager', () => new WidgetManager());
      factory.registerConstructor('SceneLibrary', () => new SceneLibrary());
      factory.registerConstructor('Screenshot', () => new Screenshot());
      factory.registerConstructor('AudioOutput', () => new AudioOutput());
      factory.registerConstructor('Speech', () => new Speech());
      factory.registerConstructor('AbjectEditor', () => new AbjectEditor());
      factory.registerConstructor('Settings', () => new Settings());
      factory.registerConstructor('CommandPalette', () => new CommandPaletteAbject());
      factory.registerConstructor('WindowSwitcher', () => new WindowSwitcherAbject());
      factory.registerConstructor('AppExplorer', () => new AppExplorer());
      factory.registerConstructor('ObjectBrowser', () => new ObjectBrowser());
      factory.registerConstructor('MethodInspector', () => new MethodInspector());
      factory.registerConstructor('JobBrowser', () => new JobBrowser());
      factory.registerConstructor('GoalBrowser', () => new GoalBrowser());
      factory.registerConstructor('KnowledgeBrowser', () => new KnowledgeBrowser());
      factory.registerConstructor('FileManager', () => new FileManager());
      factory.registerConstructor('FileViewer', () => new FileViewer());
      factory.registerConstructor('AgentBrowser', () => new AgentBrowser());
      factory.registerConstructor('SchedulerBrowser', () => new SchedulerBrowser());
      factory.registerConstructor('ChatWindow', (args?: unknown) => new ChatWindow(args as ConstructorParameters<typeof ChatWindow>[0]));
      factory.registerConstructor('ChatBrowser', () => new ChatBrowser());
      factory.registerConstructor('Taskbar', () => new Taskbar());
      factory.registerConstructor('PeersViewer', () => new PeersViewer());
      factory.registerConstructor('WorkspaceSwitcher', () => new WorkspaceSwitcher());
      factory.registerConstructor('Sidebar', () => new Sidebar());
      factory.registerConstructor('GlobalSettings', () => new GlobalSettings());
      factory.registerConstructor('GlobalToolbar', () => new GlobalToolbar());
      factory.registerConstructor('PeerNetwork', () => new PeerNetwork());
      factory.registerConstructor('ProcessExplorer', () => new ProcessExplorer());
      factory.registerConstructor('LLMMonitor', () => new LLMMonitor());
      factory.registerConstructor('WorkspaceBrowser', () => new WorkspaceBrowser());
      factory.registerConstructor('WorkspaceCollaboratorInspector', () => new WorkspaceCollaboratorInspector());
      factory.registerConstructor('WebBrowserViewer', () => new WebBrowserViewer());
      factory.registerConstructor('DataBrowser', () => new DataBrowser());
      factory.registerConstructor('SkillBrowser', () => new SkillBrowser());
      factory.registerConstructor('ExternalProjectBrowser', () => new ExternalProjectBrowser());
      factory.registerConstructor('CatalogBrowser', () => new CatalogBrowser());
      factory.registerConstructor('WebGatewayBrowser', () => new WebGatewayBrowser());
      factory.registerConstructor('RemoteUIAccess', () => new RemoteUIAccess());
      // Desktop app only: opens the Electron windows WebBrowser's pages run in.
      // Main-thread only, and absent from workerEligible on purpose: Electron's
      // window APIs exist only on the main process's main thread.
      if (process.versions.electron) {
        factory.registerConstructor('BrowserWindowHost', () => new BrowserWindowHost());
      }
    },

    async beforeWebBrowser(ctx: BootContext): Promise<void> {
      if (process.versions.electron) await ctx.supervisedSpawn('BrowserWindowHost');
      // Packaged desktop app only: software updates. A dev run (pnpm awaken),
      // the headless server and an unpackaged Electron have nothing to update,
      // and electron-updater ships only inside the app. Main-thread only: it
      // needs Electron's app. Its UI is the Updates tab in GlobalSettings.
      packagedElectron = !!process.versions.electron && (await import('electron')).app.isPackaged;
      if (packagedElectron) {
        ctx.runtime.objectFactory.registerConstructor('AppUpdater', () => new AppUpdater());
      }
    },

    async spawnDisplay(ctx: BootContext, dialogBrokerId: AbjectId): Promise<void> {
      ids.screenshot = await ctx.supervisedSpawn('Screenshot');
      ids.audioOutput = await ctx.supervisedSpawn('AudioOutput');
      ids.speech = await ctx.supervisedSpawn('Speech');
      ids.windowManager = await ctx.supervisedSpawn('WindowManager');
      ids.widgetManager = await ctx.supervisedSpawn('WidgetManager');
      // WidgetManager draws the confirm and prompt questions DialogBroker holds.
      await ctx.bootstrapRequest(dialogBrokerId, 'registerPresenter', { objectId: ids.widgetManager, kinds: ['confirm', 'prompt'] });
      // Named 3D presets (materials, looks); pushes its library to UIServer.
      await ctx.supervisedSpawn('SceneLibrary');
      // CommandPalette / NotificationCenter / WindowSwitcher are per-workspace —
      // spawned by WorkspaceManager so each instance sees its workspace's
      // registry. See INFRA_OBJECTS / UI_OBJECTS in workspace-profiles.ts.
    },

    remoteUiAttach(peerId: string, transport: UITransportLike, meta?: { name?: string }): void {
      const clientMeta = { kind: 'webrtc' as const, peerId, name: meta?.name };
      // The pair-token handshake already authenticated this client, so signal
      // the frontend that it's good to go — same message the WS path sends in
      // the auth-disabled branch. Without this the client stays on the
      // "Descending into the depths" overlay forever.
      if (transport.ready) {
        transport.send(JSON.stringify({ type: 'authNotRequired' }));
      }
      if (dedicated && uiBridge) {
        const { port1, port2 } = new MessageChannel();

        transport.onMessage((data: string | Uint8Array) => {
          postUIWireData(port1, data);
        });
        port1.on('message', (data: unknown) => {
          if (transport.ready) transport.send(toUIWireData(data));
        });

        transport.onClose(() => port1.close());
        port1.on('close', () => {
          if (transport.ready) transport.close();
        });

        // Pre-announce metadata before transferring the port. Node's parent-port
        // queue preserves order so the worker sees meta first and pairs it with
        // the next webrtc-relay port-transfer.
        uiBridge.sendCustom({ type: 'frontend-client-meta', portName: 'webrtc-relay', meta: clientMeta });
        uiBridge.transferPort('webrtc-relay', port2);
      } else if (backendUI) {
        backendUI.addTransport(transport, clientMeta);
      } else {
        transport.close();
      }
    },

    /**
     * Wrap a Node MessagePort (received from the P2P worker after a successful
     * remote-UI pairing) as a UITransportLike — the same interface that
     * BackendUI expects from a direct WebRTCUITransport. The actual encrypted
     * DataChannel lives in the P2P worker; wire frames and pre-auth JSON
     * strings cross the port unchanged (buffers transferred, not copied).
     */
    portToUITransport(port: MessagePort): UITransportLike {
      let msgHandler: ((data: string | Uint8Array) => void) | undefined;
      let closeHandler: (() => void) | undefined;
      let closed = false;

      port.on('message', (data) => {
        msgHandler?.(toUIWireData(data));
      });
      port.on('close', () => {
        closed = true;
        closeHandler?.();
      });

      return {
        send(data: string | Uint8Array): void {
          if (closed) return;
          postUIWireData(port, data);
        },
        onMessage(handler) { msgHandler = handler; },
        onClose(handler) { closeHandler = handler; },
        close(): void {
          if (closed) return;
          closed = true;
          try { port.close(); } catch { /* ignore */ }
        },
        get ready() { return !closed; },
      };
    },

    async spawnSettingsWindow(ctx: BootContext, dialogBrokerId: AbjectId): Promise<void> {
      // RemoteUIAccess must be reachable before GlobalSettings so the auth tab's
      // discoverDep('RemoteUIAccess') in onInit succeeds. With dedicated
      // workers it was already bootstrapped inside the P2P worker (which holds
      // the WebRTC polyfill); the main-thread spawn here is only the
      // non-worker fallback.
      if (!dedicated) {
        const remoteUIAccessId = await ctx.supervisedSpawn('RemoteUIAccess', 'permanent', ctx.systemTypeId('RemoteUIAccess'));
        const remoteUIAccessObj = ctx.runtime.objectFactory.getObject(remoteUIAccessId) as RemoteUIAccess | undefined;
        remoteUIAccessObj?.setAttachHandler((peerId: string, transport: UITransportLike, meta?: { name?: string }) => {
          layer.remoteUiAttach(peerId, transport, meta);
        });
      }
      // Before GlobalSettings, which shows the Updates tab only when AppUpdater exists.
      if (packagedElectron) await ctx.supervisedSpawn('AppUpdater', 'permanent', ctx.systemTypeId('AppUpdater'));
      ids.globalSettings = await ctx.supervisedSpawn('GlobalSettings', 'permanent', ctx.systemTypeId('GlobalSettings'));
      // The Settings window draws the permission questions (options dialogs).
      await ctx.bootstrapRequest(dialogBrokerId, 'registerPresenter', { objectId: ids.globalSettings, kinds: ['options'] });
    },

    async spawnGlobalUi(ctx: BootContext): Promise<void> {
      const t = (name: string) => ctx.systemTypeId(name);
      ids.peerNetwork = await ctx.supervisedSpawn('PeerNetwork', 'permanent', t('PeerNetwork'));
      ids.globalToolbar = await ctx.supervisedSpawn('GlobalToolbar', 'permanent', t('GlobalToolbar'));
      ids.objectBrowser = await ctx.supervisedSpawn('ObjectBrowser', 'permanent', t('ObjectBrowser'));
      ids.methodInspector = await ctx.supervisedSpawn('MethodInspector', 'permanent', t('MethodInspector'));
      ids.processExplorer = await ctx.supervisedSpawn('ProcessExplorer', 'permanent', t('ProcessExplorer'));
      await ctx.supervisedSpawn('LLMMonitor', 'permanent', t('LLMMonitor'));
      ids.skillBrowser = await ctx.supervisedSpawn('SkillBrowser', 'permanent', t('SkillBrowser'));
      await ctx.supervisedSpawn('WebGatewayBrowser', 'permanent', t('WebGatewayBrowser'));
      ids.catalogBrowser = await ctx.supervisedSpawn('CatalogBrowser', 'permanent', t('CatalogBrowser'));
      // Sidebar owns the dock window the rails populate; WorkspaceSwitcher is a
      // global UI (never hidden during workspace switch)
      await ctx.supervisedSpawn('Sidebar', 'permanent', t('Sidebar'));
      ids.workspaceSwitcher = await ctx.supervisedSpawn('WorkspaceSwitcher', 'permanent', t('WorkspaceSwitcher'));
      ctx.log.timed('global UI spawned');
    },

    async spawnLateUi(ctx: BootContext): Promise<void> {
      ids.workspaceBrowser = await ctx.supervisedSpawn('WorkspaceBrowser', 'permanent', ctx.systemTypeId('WorkspaceBrowser'));
      await ctx.supervisedSpawn('WorkspaceCollaboratorInspector', 'permanent', ctx.systemTypeId('WorkspaceCollaboratorInspector'));
    },

    monitoredIds(): AbjectId[] {
      return Object.values(ids).filter(id => id !== ids.screenshot && id !== ids.audioOutput && id !== ids.speech);
    },

    async release(): Promise<void> {
      await Promise.allSettled([
        wsServer ? wsServer.close() : Promise.resolve(),
        uiBridge?.shutdownWorker(2000),
      ]);
    },

    banner(): string[] {
      return [`  WebSocket:  ws://localhost:${process.env.WS_PORT ?? '7719'}`];
    },
  };
  return layer;
}
