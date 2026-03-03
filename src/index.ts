/**
 * Abjects - LLM-Mediated Object System
 *
 * Public API barrel — re-exports all types, objects, and utilities.
 */

// Export public API
export { App, createApp } from './ui/app.js';
export { Runtime, getRuntime } from './runtime/runtime.js';
export { MessageBus, HealthInterceptor } from './runtime/message-bus.js';
export type { MessageBusLike } from './runtime/message-bus.js';
export { Mailbox } from './runtime/mailbox.js';
export { WorkerBus } from './runtime/worker-bus.js';
export { WorkerBridge } from './runtime/worker-bridge.js';
export type { WorkerLike } from './runtime/worker-bridge.js';
export { WorkerPool, workerIndexForId } from './runtime/worker-pool.js';
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
export { AbjectStore, ABJECT_STORE_ID } from './objects/abject-store.js';
export { ScriptableAbject } from './objects/scriptable-abject.js';
export { CompositeAbject, COMPOSITE_ABJECT_ID } from './objects/composite-abject.js';
export type { CompositeSpec, CompositeChildSpec, RouteEntry } from './objects/composite-abject.js';
export { Supervisor, SUPERVISOR_ID } from './runtime/supervisor.js';
export type { ChildSpec, RestartType, RestartStrategy, SupervisorConfig } from './runtime/supervisor.js';
export { WorkspaceManager, WORKSPACE_MANAGER_ID } from './objects/workspace-manager.js';
export type { WorkspaceAccessMode, SharedWorkspaceInfo } from './objects/workspace-manager.js';
export { WorkspaceRegistry, WORKSPACE_REGISTRY_ID } from './objects/workspace-registry.js';
export { WorkspaceSwitcher, WORKSPACE_SWITCHER_ID } from './objects/workspace-switcher.js';
export { GlobalSettings, GLOBAL_SETTINGS_ID } from './objects/global-settings.js';
export { GlobalToolbar, GLOBAL_TOOLBAR_ID } from './objects/global-toolbar.js';
export { PeerNetwork, PEER_NETWORK_ID } from './objects/peer-network.js';
export { ObjectManager, OBJECT_MANAGER_ID } from './objects/object-manager.js';
export { IdentityObject, IDENTITY_ID } from './objects/identity.js';
export { PeerRegistry, PEER_REGISTRY_ID } from './objects/peer-registry.js';
export { RemoteRegistry, REMOTE_REGISTRY_ID } from './objects/remote-registry.js';
export { WorkspaceShareRegistry, WORKSPACE_SHARE_REGISTRY_ID } from './objects/workspace-share-registry.js';
export type { DiscoveredWorkspace } from './objects/workspace-share-registry.js';
export { WorkspaceBrowser, WORKSPACE_BROWSER_ID } from './objects/workspace-browser.js';

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
export { TabBarWidget } from './objects/widgets/tabbar-widget.js';
export type { TabBarConfig } from './objects/widgets/tabbar-widget.js';
export { SliderWidget } from './objects/widgets/slider-widget.js';
export type { SliderWidgetConfig } from './objects/widgets/slider-widget.js';
export { ImageWidget } from './objects/widgets/image-widget.js';
export type { ImageWidgetConfig } from './objects/widgets/image-widget.js';
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
export { AgentAbject, AGENT_ABJECT_ID } from './objects/agent-abject.js';
export type { AgentPhase, AgentAction, AgentActionResult, AgentTaskState, AgentTaskOptions, AgentConfig, TerminalActionConfig } from './objects/agent-abject.js';
export { WebBrowserViewer, WEB_BROWSER_VIEWER_ID } from './objects/web-browser-viewer.js';
// WebParser, WebBrowser, and WebAgent are server-only — import directly from their files:
// import { WebParser } from './objects/capabilities/web-parser.js';
// import { WebBrowser } from './objects/capabilities/web-browser.js';
// import { WebAgent } from './objects/web-agent.js';

// Export core types
export * from './core/types.js';
export * from './core/message.js';
export * from './core/capability.js';
export * from './core/contracts.js';
export { formatManifestAsDescription } from './core/introspect.js';
export type { PeerId, PeerIdentity, PeerContact, PeerConnectionState } from './core/identity.js';
export { derivePeerId, derivePeerIdFromJwk, deriveSessionKey, aesEncrypt, aesDecrypt } from './core/identity.js';
export type { IntrospectResult } from './core/introspect.js';

// Export LLM providers
export type { LLMProvider, LLMMessage, LLMCompletionResult, ModelTier, ContentPart, TextPart, ImagePart } from './llm/provider.js';
export { getTextContent, userMessageWithImages } from './llm/provider.js';
export { AnthropicProvider } from './llm/anthropic.js';
export { OpenAIProvider } from './llm/openai.js';
export { OllamaProvider } from './llm/ollama.js';

// Export network
export { Transport } from './network/transport.js';
export type { TransportConfig } from './network/transport.js';
export { WebSocketTransport } from './network/websocket.js';
export { SignalingClient } from './network/signaling.js';
export { PeerTransport } from './network/peer-transport.js';
export { PeerRouter, PEER_ROUTER_ID } from './network/peer-router.js';

// Export compositor
export { Compositor } from './ui/compositor.js';

