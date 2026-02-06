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
import { SimpleAbject } from './core/abject.js';
import * as message from './core/message.js';
import { MockTransport } from './network/transport.js';
import { Settings } from './objects/settings.js';
import { Taskbar } from './objects/taskbar.js';
import { RegistryBrowser } from './objects/registry-browser.js';
import { ObjectWorkshop } from './objects/object-workshop.js';

// Export public API
export { App, createApp } from './ui/app.js';
export { Runtime, getRuntime } from './runtime/runtime.js';
export { MessageBus, HealthInterceptor } from './runtime/message-bus.js';
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
export { Settings, SETTINGS_ID } from './objects/settings.js';
export { Taskbar, TASKBAR_ID } from './objects/taskbar.js';
export { RegistryBrowser, REGISTRY_BROWSER_ID } from './objects/registry-browser.js';
export { ObjectWorkshop, OBJECT_WORKSHOP_ID } from './objects/object-workshop.js';
export { ScriptableAbject, EDITABLE_INTERFACE_ID } from './objects/scriptable-abject.js';

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
export { INTROSPECT_INTERFACE_ID, INTROSPECT_INTERFACE, formatManifestAsDescription } from './core/introspect.js';
export type { IntrospectResult } from './core/introspect.js';

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
 * Escape HTML special characters for safe DOM insertion.
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Display a fatal error message in the DOM.
 */
function showError(container: HTMLElement, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  const el = document.createElement('div');
  el.style.cssText = [
    'position: fixed',
    'top: 50%',
    'left: 50%',
    'transform: translate(-50%, -50%)',
    'max-width: 600px',
    'width: 90%',
    'padding: 24px',
    'background: #2d1b1b',
    'border: 1px solid #ff4444',
    'border-radius: 8px',
    'color: #ff8888',
    'font-family: system-ui, -apple-system, sans-serif',
    'font-size: 14px',
    'z-index: 10000',
  ].join(';');

  el.innerHTML = `
    <h2 style="margin: 0 0 12px 0; color: #ff4444; font-size: 18px;">Abjects failed to start</h2>
    <p style="margin: 0 0 12px 0; color: #ffaaaa;">${escapeHtml(message)}</p>
    ${stack ? `<pre style="margin: 0; padding: 12px; background: #1a1a2e; border-radius: 4px; overflow-x: auto; font-size: 12px; color: #888;">${escapeHtml(stack)}</pre>` : ''}
  `;

  container.appendChild(el);
}

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

  // Create and spawn HttpClient first (LLM providers route through it)
  const httpClient = new HttpClient();
  await runtime.spawn(httpClient);

  // Create and spawn LLM object
  const llm = new LLMObject();
  llm.setHttpClientId(httpClient.id);
  llm.configure({
    anthropicApiKey: anthropicKey,
    openaiApiKey: openaiKey,
  });
  await runtime.spawn(llm);

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

  // Set base dependencies for ScriptableAbjects
  runtime.objectFactory.setBaseDeps({
    Registry: runtime.objectRegistry.id,
    UIServer: app.appUIServer.id,
  });

  // Create proxy generator
  const proxyGenerator = new ProxyGenerator();
  proxyGenerator.setLLMId(llm.id);
  await runtime.spawn(proxyGenerator);

  // Create negotiator
  const negotiator = new Negotiator();
  negotiator.setDependencies(
    runtime.objectRegistry.id,
    runtime.objectFactory.id,
    proxyGenerator.id,
    runtime.messageBus
  );
  await runtime.spawn(negotiator);

  // Create health monitor
  const healthMonitor = new HealthMonitor();
  healthMonitor.setNegotiatorId(negotiator.id);
  healthMonitor.startMonitoring();
  await runtime.spawn(healthMonitor);

  // Wire negotiator → health monitor
  negotiator.setHealthMonitorId(healthMonitor.id);

  // Create object creator
  const objectCreator = new ObjectCreator();
  objectCreator.setDependencies(llm.id, runtime.objectRegistry.id, runtime.objectFactory.id, negotiator.id);
  await runtime.spawn(objectCreator);

  // Create settings (loads saved keys or shows config UI)
  const settings = new Settings();
  settings.setDependencies(llm.id, storage.id, app.appUIServer);
  await runtime.spawn(settings);

  // Create registry browser
  const registryBrowser = new RegistryBrowser();
  registryBrowser.setDependencies(app.appUIServer, runtime.objectRegistry.id, objectCreator.id, llm.id);
  await runtime.spawn(registryBrowser);

  // Create object workshop
  const objectWorkshop = new ObjectWorkshop();
  objectWorkshop.setDependencies(app.appUIServer, objectCreator.id);
  await runtime.spawn(objectWorkshop);

  // Create taskbar (must be last — needs references to other UI objects)
  const taskbar = new Taskbar();
  taskbar.setDependencies(app.appUIServer, settings.id, registryBrowser.id, objectWorkshop.id, runtime.objectRegistry.id);
  await runtime.spawn(taskbar);

  console.log('[ABJECTS] System ready');
  console.log(`[ABJECTS] ${runtime.objectRegistry.objectCount} objects registered`);

  // Make app available globally for debugging
  (window as unknown as Record<string, unknown>).abjects = {
    app,
    runtime,
    llm,
    settings,
    objectCreator,
    registryBrowser,
    objectWorkshop,
    taskbar,
    registry: runtime.objectRegistry,
    factory: runtime.objectFactory,
    httpClient,
    storage,
    timer,
    clipboard,
    console: consoleObj,
    filesystem,
    modules: {
      SimpleAbject,
      Storage,
      Timer,
      Console,
      FileSystem,
      HealthMonitor,
      MockTransport,
      message,
    },
  };

  return app;
}

// Auto-start if in browser
function startWithErrorHandling(): void {
  main().catch((err) => {
    console.error('[ABJECTS] Fatal startup error:', err);
    const container = document.querySelector('#app') as HTMLElement;
    if (container) {
      showError(container, err);
    }
  });
}

if (typeof window !== 'undefined' && document.readyState !== 'loading') {
  startWithErrorHandling();
} else if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', startWithErrorHandling);
}
