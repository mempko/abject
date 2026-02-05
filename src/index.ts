/**
 * Abjects - LLM-Mediated Object System
 *
 * Entry point for the browser application.
 */

import { createApp, App } from './ui/app.js';
import { LLMObject } from './objects/llm-object.js';
import { ObjectCreator } from './objects/object-creator.js';
import { ProxyGenerator } from './objects/proxy-generator.js';
import { Negotiator } from './protocol/negotiator.js';
import { HealthMonitor } from './protocol/health-monitor.js';
import { HttpClient } from './objects/capabilities/http-client.js';
import { Storage } from './objects/capabilities/storage.js';
import { Timer } from './objects/capabilities/timer.js';
import { Clipboard } from './objects/capabilities/clipboard.js';
import { Console } from './objects/capabilities/console.js';
import { FileSystem } from './objects/capabilities/filesystem.js';

// Export public API
export { App, createApp } from './ui/app.js';
export { Runtime, getRuntime } from './runtime/runtime.js';
export { MessageBus } from './runtime/message-bus.js';
export { Mailbox } from './runtime/mailbox.js';
export { Abject, SimpleAbject } from './core/abject.js';
export { Registry, REGISTRY_ID } from './objects/registry.js';
export { Factory, FACTORY_ID } from './objects/factory.js';
export { UIServer, UI_SERVER_ID } from './objects/ui-server.js';
export { LLMObject, LLM_OBJECT_ID } from './objects/llm-object.js';
export { ObjectCreator, OBJECT_CREATOR_ID } from './objects/object-creator.js';
export { ProxyGenerator, PROXY_GENERATOR_ID } from './objects/proxy-generator.js';
export { Negotiator, NEGOTIATOR_ID } from './protocol/negotiator.js';
export { HealthMonitor, HEALTH_MONITOR_ID } from './protocol/health-monitor.js';

// Export capability objects
export { HttpClient, HTTP_CLIENT_ID } from './objects/capabilities/http-client.js';
export { Storage, STORAGE_ID } from './objects/capabilities/storage.js';
export { Timer, TIMER_ID } from './objects/capabilities/timer.js';
export { Clipboard, CLIPBOARD_ID } from './objects/capabilities/clipboard.js';
export { Console, CONSOLE_ID } from './objects/capabilities/console.js';
export { FileSystem, FILESYSTEM_ID } from './objects/capabilities/filesystem.js';

// Export core types
export * from './core/types.js';
export * from './core/message.js';
export * from './core/capability.js';
export * from './core/contracts.js';

// Export LLM providers
export type { LLMProvider, LLMMessage, LLMCompletionResult } from './llm/provider.js';
export { AnthropicProvider } from './llm/anthropic.js';
export { OpenAIProvider } from './llm/openai.js';
export { OllamaProvider } from './llm/ollama.js';

// Export network
export { Transport } from './network/transport.js';
export type { TransportConfig } from './network/transport.js';
export { WebSocketTransport } from './network/websocket.js';

// Export compositor
export { Compositor } from './ui/compositor.js';

/**
 * Initialize and start the Abjects system in the browser.
 */
async function main(): Promise<App> {
  console.log('[ABJECTS] Initializing...');

  // Get API key from global config if available
  const anthropicKey = (window as unknown as Record<string, unknown>).ANTHROPIC_API_KEY as string | undefined;
  const openaiKey = (window as unknown as Record<string, unknown>).OPENAI_API_KEY as string | undefined;

  // Create application
  const app = await createApp({
    container: '#app',
    debug: true,
  });

  const runtime = app.appRuntime;

  // Create and spawn LLM object
  const llm = new LLMObject();
  llm.configure({
    anthropicApiKey: anthropicKey,
    openaiApiKey: openaiKey,
  });
  await runtime.spawn(llm);

  // Create and spawn capability objects
  const httpClient = new HttpClient();
  await runtime.spawn(httpClient);

  const storage = new Storage();
  await runtime.spawn(storage);

  const timer = new Timer();
  await runtime.spawn(timer);

  const clipboard = new Clipboard();
  await runtime.spawn(clipboard);

  const consoleObj = new Console();
  await runtime.spawn(consoleObj);

  const filesystem = new FileSystem();
  await runtime.spawn(filesystem);

  // Create proxy generator
  const proxyGenerator = new ProxyGenerator();
  proxyGenerator.setLLM(llm);
  await runtime.spawn(proxyGenerator);

  // Create negotiator
  const negotiator = new Negotiator();
  negotiator.setDependencies(
    runtime.objectRegistry,
    runtime.objectFactory,
    proxyGenerator,
    runtime.messageBus
  );
  await runtime.spawn(negotiator);

  // Create health monitor
  const healthMonitor = new HealthMonitor();
  healthMonitor.setNegotiator(negotiator);
  healthMonitor.startMonitoring();
  await runtime.spawn(healthMonitor);

  // Create object creator
  const objectCreator = new ObjectCreator();
  objectCreator.setDependencies(llm, runtime.objectRegistry, runtime.objectFactory);
  await runtime.spawn(objectCreator);

  console.log('[ABJECTS] System ready');
  console.log(`[ABJECTS] ${runtime.objectRegistry.objectCount} objects registered`);

  // Make app available globally for debugging
  (window as unknown as Record<string, unknown>).abjects = {
    app,
    runtime,
    llm,
    objectCreator,
    registry: runtime.objectRegistry,
    factory: runtime.objectFactory,
  };

  return app;
}

// Auto-start if in browser
if (typeof window !== 'undefined' && document.readyState !== 'loading') {
  main().catch(console.error);
} else if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    main().catch(console.error);
  });
}
