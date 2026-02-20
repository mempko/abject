/**
 * Abjects - LLM-Mediated Object System
 *
 * Entry point for the browser application.
 */

import { createApp, App } from './ui/app.js';
import { AbjectId, AbjectMessage, InterfaceId, SpawnResult } from './core/types.js';
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
import { WidgetManager } from './objects/widget-manager.js';
import { ThemeAbject } from './objects/theme.js';
import { WindowManager } from './objects/window-manager.js';
import { AbjectEditor } from './objects/abject-editor.js';
import { JobManager } from './objects/job-manager.js';
import { JobBrowser } from './objects/job-browser.js';
import { Chat } from './objects/chat.js';
import { Supervisor } from './runtime/supervisor.js';
import type { RestartType } from './runtime/supervisor.js';

// Export public API
export { App, createApp } from './ui/app.js';
export { Runtime, getRuntime } from './runtime/runtime.js';
export { MessageBus, HealthInterceptor } from './runtime/message-bus.js';
export { Mailbox } from './runtime/mailbox.js';
export { Abject, SimpleAbject, DEFERRED_REPLY } from './core/abject.js';
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
export { WidgetManager, WIDGET_MANAGER_ID } from './objects/widget-manager.js';
export { ThemeAbject, THEME_ID } from './objects/theme.js';
export { WindowManager, WINDOW_MANAGER_ID } from './objects/window-manager.js';
export { AbjectEditor, ABJECT_EDITOR_ID } from './objects/abject-editor.js';
export { JobManager, JOBMANAGER_ID } from './objects/job-manager.js';
export { JobBrowser, JOB_BROWSER_ID } from './objects/job-browser.js';
export { Chat, CHAT_ID } from './objects/chat.js';
export { ScriptableAbject, EDITABLE_INTERFACE_ID } from './objects/scriptable-abject.js';
export { Supervisor, SUPERVISOR_ID, SUPERVISOR_INTERFACE_ID } from './runtime/supervisor.js';
export type { ChildSpec, RestartType, RestartStrategy, SupervisorConfig } from './runtime/supervisor.js';

// Export widget Abjects
export { WidgetAbject, buildFont, WIDGET_INTERFACE_DECL } from './objects/widgets/widget-abject.js';
export type { WidgetConfig } from './objects/widgets/widget-abject.js';
export { WindowAbject } from './objects/widgets/window-abject.js';
export { LabelWidget } from './objects/widgets/label-widget.js';
export { ButtonWidget } from './objects/widgets/button-widget.js';
export { TextInputWidget } from './objects/widgets/text-input-widget.js';
export { TextAreaWidget } from './objects/widgets/text-area-widget.js';
export { CheckboxWidget } from './objects/widgets/checkbox-widget.js';
export { ProgressWidget } from './objects/widgets/progress-widget.js';
export { DividerWidget } from './objects/widgets/divider-widget.js';
export { SelectWidget } from './objects/widgets/select-widget.js';
export { CanvasWidget } from './objects/widgets/canvas-widget.js';
export type { CanvasWidgetConfig } from './objects/widgets/canvas-widget.js';
export { LayoutAbject, isSpacer, LAYOUT_INTERFACE_DECL } from './objects/widgets/layout-abject.js';
export type { LayoutConfig, LayoutMargins, ChildRect } from './objects/widgets/layout-abject.js';
export { VBoxLayout } from './objects/widgets/vbox-layout.js';
export { HBoxLayout } from './objects/widgets/hbox-layout.js';
export { ScrollableVBoxLayout } from './objects/widgets/scrollable-vbox-layout.js';
export {
  WIDGET_INTERFACE,
  WINDOW_INTERFACE,
  LAYOUT_INTERFACE,
  CANVAS_INTERFACE,
  WIDGET_FONT,
  TITLE_FONT,
  CODE_FONT,
  DEFAULT_LINE_HEIGHT,
  TITLE_BAR_HEIGHT,
  EDGE_SIZE,
  MIDNIGHT_BLOOM,
} from './objects/widgets/widget-types.js';
export type { WidgetType, Rect, WidgetStyle as WidgetAbjectStyle, SizePolicy, LayoutChildConfig, SpacerConfig, ThemeData } from './objects/widgets/widget-types.js';

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
export type { LLMProvider, LLMMessage, LLMCompletionResult, ModelTier } from './llm/provider.js';
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
 *
 * All system objects are spawned via Factory messages. Each object discovers
 * its own dependencies via Registry self-discovery in `onInit()`.
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
  const bus = runtime.messageBus;
  const factoryId = runtime.objectFactory.id;
  const registryId = runtime.objectRegistry.id;
  const FACTORY_IFACE = 'abjects:factory' as InterfaceId;
  const BOOTSTRAP_ID = 'bootstrap' as AbjectId;

  // Register a temporary bootstrap sender on the bus to enable request-reply
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

  // Helper: spawn via Factory message, return spawned object ID
  async function factorySpawn(name: string): Promise<AbjectId> {
    const result = await bootstrapRequest<SpawnResult>(factoryId, FACTORY_IFACE, 'spawn', {
      manifest: { name, description: '', version: '1.0.0', interfaces: [],
                  requiredCapabilities: [], tags: ['system'] },
    });
    return result.objectId;
  }

  // Register constructors with Factory (local calls — Factory is in-process)
  runtime.objectFactory.registerConstructor('HttpClient', () => new HttpClient());
  runtime.objectFactory.registerConstructor('LLMObject', () => new LLMObject());
  runtime.objectFactory.registerConstructor('Storage', () => new Storage());
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
  // Each object discovers its own dependencies via Registry self-discovery
  const httpClientId = await supervisedSpawn('HttpClient');
  const llmId = await supervisedSpawn('LLMObject');

  // Configure LLM with API keys (still needed — this isn't a dep)
  await bootstrapRequest(llmId, 'abjects:llm' as InterfaceId, 'configure', {
    anthropicApiKey: anthropicKey,
    openaiApiKey: openaiKey,
  });

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
    settingsId, registryBrowserId,
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

  console.log('[ABJECTS] System ready');
  console.log(`[ABJECTS] ${runtime.objectRegistry.objectCount} objects registered`);

  // Make app available globally for debugging
  // Retrieve spawned object references from Factory for backward-compatible debug access
  const getObj = (id: AbjectId) => runtime.objectFactory.getObject(id);

  (window as unknown as Record<string, unknown>).abjects = {
    app,
    runtime,
    // Direct object references (for debugging and tests)
    llm: getObj(llmId),
    settings: getObj(settingsId),
    objectCreator: getObj(objectCreatorId),
    abjectEditor: getObj(abjectEditorId),
    registryBrowser: getObj(registryBrowserId),
    taskbar: getObj(taskbarId),
    registry: runtime.objectRegistry,
    factory: runtime.objectFactory,
    httpClient: getObj(httpClientId),
    storage: getObj(storageId),
    timer: getObj(timerId),
    clipboard: getObj(clipboardId),
    console: getObj(consoleId),
    theme: getObj(themeId),
    widgetManager: getObj(widgetManagerId),
    windowManager: getObj(windowManagerId),
    filesystem: getObj(filesystemId),
    jobManager: getObj(jobManagerId),
    jobBrowser: getObj(jobBrowserId),
    chat: getObj(chatId),
    supervisor: getObj(supervisorId),
    // Object IDs for message-based interaction
    ids: {
      llm: llmId,
      settings: settingsId,
      objectCreator: objectCreatorId,
      abjectEditor: abjectEditorId,
      registryBrowser: registryBrowserId,
      taskbar: taskbarId,
      registry: registryId,
      factory: factoryId,
      httpClient: httpClientId,
      storage: storageId,
      timer: timerId,
      clipboard: clipboardId,
      console: consoleId,
      theme: themeId,
      widgetManager: widgetManagerId,
      windowManager: windowManagerId,
      filesystem: filesystemId,
      proxyGenerator: proxyGenId,
      negotiator: negotiatorId,
      healthMonitor: healthMonitorId,
      jobManager: jobManagerId,
      jobBrowser: jobBrowserId,
      chat: chatId,
      supervisor: supervisorId,
    },
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
