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
import { Storage } from '../src/objects/capabilities/storage.js';
import { Timer } from '../src/objects/capabilities/timer.js';
import { Clipboard } from '../src/objects/capabilities/clipboard.js';
import { Console } from '../src/objects/capabilities/console.js';
import { FileSystem } from '../src/objects/capabilities/filesystem.js';
import { Settings } from '../src/objects/settings.js';
import { Taskbar } from '../src/objects/taskbar.js';
import { RegistryBrowser } from '../src/objects/registry-browser.js';
import { ObjectWorkshop } from '../src/objects/object-workshop.js';
import { WidgetManager } from '../src/objects/widget-manager.js';
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
  bus.register(BOOTSTRAP_ID, async (msg: AbjectMessage) => {
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
      bus.send(msg);
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
  runtime.objectFactory.registerConstructor('Storage', () => new Storage());
  runtime.objectFactory.registerConstructor('Timer', () => new Timer());
  runtime.objectFactory.registerConstructor('Clipboard', () => new Clipboard());
  runtime.objectFactory.registerConstructor('Console', () => new Console());
  runtime.objectFactory.registerConstructor('FileSystem', () => new FileSystem());
  runtime.objectFactory.registerConstructor('WidgetManager', () => new WidgetManager());
  runtime.objectFactory.registerConstructor('ProxyGenerator', () => new ProxyGenerator());
  runtime.objectFactory.registerConstructor('Negotiator', () => new Negotiator());
  runtime.objectFactory.registerConstructor('HealthMonitor', () => new HealthMonitor());
  runtime.objectFactory.registerConstructor('ObjectCreator', () => new ObjectCreator());
  runtime.objectFactory.registerConstructor('Settings', () => new Settings());
  runtime.objectFactory.registerConstructor('RegistryBrowser', () => new RegistryBrowser());
  runtime.objectFactory.registerConstructor('ObjectWorkshop', () => new ObjectWorkshop());
  runtime.objectFactory.registerConstructor('Taskbar', () => new Taskbar());

  // Spawn in dependency order via Factory messages
  const httpClientId = await factorySpawn('HttpClient');
  const llmId = await factorySpawn('LLMObject');

  // Configure LLM with API keys
  if (anthropicKey || openaiKey) {
    await bootstrapRequest(llmId, 'abjects:llm' as InterfaceId, 'configure', {
      anthropicApiKey: anthropicKey,
      openaiApiKey: openaiKey,
    });
  }

  const storageId = await factorySpawn('Storage');
  const timerId = await factorySpawn('Timer');
  const clipboardId = await factorySpawn('Clipboard');
  const consoleId = await factorySpawn('Console');
  const filesystemId = await factorySpawn('FileSystem');
  const widgetManagerId = await factorySpawn('WidgetManager');

  // Set base deps with BackendUI acting as UIServer
  runtime.objectFactory.setBaseDeps({
    Registry: registryId,
    UIServer: backendUI.id,
    WidgetManager: widgetManagerId,
  });

  const proxyGenId = await factorySpawn('ProxyGenerator');
  const negotiatorId = await factorySpawn('Negotiator');
  const healthMonitorId = await factorySpawn('HealthMonitor');

  // Start monitoring
  await bootstrapRequest(healthMonitorId,
    'abjects:health-monitor' as InterfaceId, 'startMonitoring', {});

  const objectCreatorId = await factorySpawn('ObjectCreator');
  const settingsId = await factorySpawn('Settings');
  const registryBrowserId = await factorySpawn('RegistryBrowser');
  const objectWorkshopId = await factorySpawn('ObjectWorkshop');
  const taskbarId = await factorySpawn('Taskbar');

  // Clean up bootstrap handler
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

main().catch((err) => {
  console.error('[ABJECTS] Fatal startup error:', err);
  process.exit(1);
});
