/**
 * Abjects Node.js Backend Entry Point
 *
 * Mirrors the bootstrap in src/index.ts but without DOM/Canvas.
 * All system objects run here; the browser is a thin rendering client.
 */

import { AbjectId, AbjectMessage, InterfaceId, SpawnResult } from '../src/core/types.js';
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
import { Settings } from '../src/objects/settings.js';
import { Taskbar } from '../src/objects/taskbar.js';
import { RegistryBrowser } from '../src/objects/registry-browser.js';
import { ObjectWorkshop } from '../src/objects/object-workshop.js';
import { WidgetManager } from '../src/objects/widget-manager.js';
import { ThemeAbject } from '../src/objects/theme.js';
import { WindowManager } from '../src/objects/window-manager.js';
import { AbjectEditor } from '../src/objects/abject-editor.js';
import { JobManager } from '../src/objects/job-manager.js';
import { JobBrowser } from '../src/objects/job-browser.js';
import { Chat } from '../src/objects/chat.js';
import { Supervisor } from '../src/runtime/supervisor.js';
import type { RestartType } from '../src/runtime/supervisor.js';
import { NodeWebSocketServer } from '../src/network/websocket-server.js';

const WS_PORT = parseInt(process.env.WS_PORT ?? '7719', 10);

async function main(): Promise<void> {
  console.log('[ABJECTS] Initializing backend...');

  // Read API keys from environment
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  // Reset any stale singleton state
  resetRuntime();

  // Create runtime
  const runtime = getRuntime({ debug: !!process.env.DEBUG });

  // Create BackendUI (replaces UIServer)
  const backendUI = new BackendUI();
  runtime.registerCoreObject(backendUI);

  // Start runtime (bootstraps Registry + Factory)
  await runtime.start();

  const bus = runtime.messageBus;
  const factoryId = runtime.objectFactory.id;
  const registryId = runtime.objectRegistry.id;
  const FACTORY_IFACE = 'abjects:factory' as InterfaceId;
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

  function bootstrapRequest<T>(target: AbjectId, iface: InterfaceId, method: string, payload: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const msg = message.request(BOOTSTRAP_ID, target, iface, method, payload);
      pendingReplies.set(msg.header.messageId, {
        resolve: resolve as (v: unknown) => void, reject,
      });
      bus.send(msg).catch(reject);
    });
  }

  async function factorySpawn(name: string): Promise<AbjectId> {
    const result = await bootstrapRequest<SpawnResult>(factoryId, FACTORY_IFACE, 'spawn', {
      manifest: { name, description: '', version: '1.0.0', interfaces: [],
                  requiredCapabilities: [], tags: ['system'] },
    });
    return result.objectId;
  }

  // Register constructors with Factory
  runtime.objectFactory.registerConstructor('HttpClient', () => new HttpClient());
  runtime.objectFactory.registerConstructor('LLMObject', () => new LLMObject());
  runtime.objectFactory.registerConstructor('Storage', () => new NodeStorage());
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
  runtime.objectFactory.registerConstructor('RegistryBrowser', () => new RegistryBrowser());
  runtime.objectFactory.registerConstructor('ObjectWorkshop', () => new ObjectWorkshop());
  runtime.objectFactory.registerConstructor('JobManager', () => new JobManager());
  runtime.objectFactory.registerConstructor('JobBrowser', () => new JobBrowser());
  runtime.objectFactory.registerConstructor('Chat', () => new Chat());
  runtime.objectFactory.registerConstructor('Supervisor', () => new Supervisor());
  runtime.objectFactory.registerConstructor('Taskbar', () => new Taskbar());

  // Spawn Supervisor early so it can supervise other objects
  const supervisorId = await factorySpawn('Supervisor');
  const SUPERVISOR_IFACE = 'abjects:supervisor' as InterfaceId;
  const HEALTH_IFACE = 'abjects:health-monitor' as InterfaceId;

  // Helper: spawn via Factory, register with Supervisor, return ID
  async function supervisedSpawn(name: string, restart: RestartType = 'permanent'): Promise<AbjectId> {
    const id = await factorySpawn(name);
    await bootstrapRequest(supervisorId, SUPERVISOR_IFACE, 'addChild', {
      id, constructorName: name, restart,
    });
    return id;
  }

  // Spawn in dependency order via Factory messages
  const httpClientId = await supervisedSpawn('HttpClient');
  const llmId = await supervisedSpawn('LLMObject');

  // Configure LLM with API keys
  if (anthropicKey || openaiKey) {
    await bootstrapRequest(llmId, 'abjects:llm' as InterfaceId, 'configure', {
      anthropicApiKey: anthropicKey,
      openaiApiKey: openaiKey,
    });
  }

  const storageId = await supervisedSpawn('Storage');
  const themeId = await supervisedSpawn('Theme');
  const timerId = await supervisedSpawn('Timer');
  const clipboardId = await supervisedSpawn('Clipboard');
  const consoleId = await supervisedSpawn('Console');
  const filesystemId = await supervisedSpawn('FileSystem');
  const windowManagerId = await supervisedSpawn('WindowManager');
  const widgetManagerId = await supervisedSpawn('WidgetManager');

  const proxyGenId = await supervisedSpawn('ProxyGenerator');
  const negotiatorId = await supervisedSpawn('Negotiator');
  const healthMonitorId = await supervisedSpawn('HealthMonitor');
  const objectCreatorId = await supervisedSpawn('ObjectCreator');
  const abjectEditorId = await supervisedSpawn('AbjectEditor');
  const settingsId = await supervisedSpawn('Settings');
  const registryBrowserId = await supervisedSpawn('RegistryBrowser');
  const objectWorkshopId = await supervisedSpawn('ObjectWorkshop');
  const jobManagerId = await supervisedSpawn('JobManager');
  const jobBrowserId = await supervisedSpawn('JobBrowser');
  const chatId = await supervisedSpawn('Chat');
  const taskbarId = await supervisedSpawn('Taskbar');

  // ALL objects are now spawned and init'd — safe to start health monitoring.
  // The ready gate ensures HealthMonitor won't ping objects prematurely.
  const monitoredIds = [
    httpClientId, llmId, storageId, themeId, timerId, clipboardId,
    consoleId, filesystemId, windowManagerId, widgetManagerId,
    proxyGenId, negotiatorId, objectCreatorId, abjectEditorId,
    settingsId, registryBrowserId, objectWorkshopId,
    jobManagerId, jobBrowserId, chatId, taskbarId,
  ];
  for (const objId of monitoredIds) {
    await bootstrapRequest(healthMonitorId, HEALTH_IFACE, 'monitorObject', { objectId: objId });
    await bootstrapRequest(healthMonitorId, HEALTH_IFACE, 'markObjectReady', { objectId: objId });
  }
  await bootstrapRequest(healthMonitorId, HEALTH_IFACE, 'startMonitoring', {});

  // Clean up bootstrap handler
  bus.removeReplyHandler(BOOTSTRAP_ID);
  bus.unregister(BOOTSTRAP_ID);

  // Start WebSocket server
  const wsServer = new NodeWebSocketServer({ port: WS_PORT });

  wsServer.onConnection((ws) => {
    console.log(`[ABJECTS] Frontend connected`);
    backendUI.setWebSocket(ws);
  });

  console.log('');
  console.log(`  ABJECTS server running`);
  console.log('');
  console.log(`  WebSocket:  ws://localhost:${WS_PORT}`);
  console.log(`  Objects:    ${runtime.objectRegistry.objectCount}`);
  console.log(`  Surfaces:   ${backendUI.surfaceCount}`);
  console.log('');
  console.log(`  Waiting for frontend connection...`);

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('[ABJECTS] Shutting down...');
    await wsServer.close();
    await runtime.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

process.on('unhandledRejection', (reason) => {
  console.error('[ABJECTS] Unhandled rejection (server stayed up):', reason);
});

main().catch((err) => {
  console.error('[ABJECTS] Fatal startup error:', err);
  process.exit(1);
});
