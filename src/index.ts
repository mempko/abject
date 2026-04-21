/**
 * Abjects - LLM-Mediated Object System
 *
 * Public API barrel — re-exports all types, objects, and utilities.
 */

// Export public API
export { Runtime, getRuntime } from './runtime/runtime.js';
export { MessageBus, HealthInterceptor } from './runtime/message-bus.js';
export type { MessageBusLike } from './runtime/message-bus.js';
export { Mailbox } from './runtime/mailbox.js';
export { WorkerBus } from './runtime/worker-bus.js';
export { WorkerBridge } from './runtime/worker-bridge.js';
export type { WorkerLike } from './runtime/worker-bridge.js';
export { WorkerPool, workerIndexForId } from './runtime/worker-pool.js';
export { DedicatedWorkerBridge } from './runtime/dedicated-worker-bridge.js';
export { Abject, SimpleAbject, DEFERRED_REPLY } from './core/abject.js';
export { Registry, REGISTRY_ID } from './objects/registry.js';
export { Factory, FACTORY_ID } from './objects/factory.js';
export { LLMObject, LLM_OBJECT_ID } from './objects/llm-object.js';
export type { TierConfig, TierRouting } from './objects/llm-object.js';
export { ObjectCreator, OBJECT_CREATOR_ID } from './objects/object-creator.js';
export { ProxyGenerator, PROXY_GENERATOR_ID } from './objects/proxy-generator.js';
export { Negotiator, NEGOTIATOR_ID } from './protocol/negotiator.js';
export { HealthMonitor, HEALTH_MONITOR_ID } from './protocol/health-monitor.js';
export { Settings, SETTINGS_ID } from './objects/settings.js';
export { Taskbar, TASKBAR_ID } from './objects/taskbar.js';
export { AppExplorer, APP_EXPLORER_ID } from './objects/app-explorer.js';
export { ObjectBrowser, OBJECT_BROWSER_ID } from './objects/object-browser.js';
export { ObjectCatalog, OBJECT_CATALOG_ID } from './objects/object-catalog.js';
export { WidgetManager, WIDGET_MANAGER_ID } from './objects/widget-manager.js';
export { ModalDialog } from './objects/modal-dialog.js';
export { ThemeAbject, THEME_ID } from './objects/theme.js';
export { WindowManager, WINDOW_MANAGER_ID } from './objects/window-manager.js';
export { AbjectEditor, ABJECT_EDITOR_ID } from './objects/abject-editor.js';
export { JobManager, JOBMANAGER_ID } from './objects/job-manager.js';
export { JobBrowser, JOB_BROWSER_ID } from './objects/job-browser.js';
export { GoalManager, GOAL_MANAGER_ID } from './objects/goal-manager.js';
export type { Goal, GoalId, ProgressEntry } from './objects/goal-manager.js';
export { GoalBrowser, GOAL_BROWSER_ID } from './objects/goal-browser.js';
export { GoalObserver, GOAL_OBSERVER_ID } from './objects/goal-observer.js';
export { Chat, CHAT_ID } from './objects/chat.js';
export { AbjectStore, ABJECT_STORE_ID } from './objects/abject-store.js';
export { KnowledgeBase, KNOWLEDGE_BASE_ID } from './objects/knowledge-base.js';
export { KnowledgeBrowser, KNOWLEDGE_BROWSER_ID } from './objects/knowledge-browser.js';
export { AgentBrowser, AGENT_BROWSER_ID } from './objects/agent-browser.js';
export { AgentCreator, AGENT_CREATOR_ID } from './objects/agent-creator.js';
export { Scheduler, SCHEDULER_ID } from './objects/scheduler.js';
export { SchedulerBrowser, SCHEDULER_BROWSER_ID } from './objects/scheduler-browser.js';
export { ScriptableAbject } from './objects/scriptable-abject.js';
export { Organism } from './objects/organism.js';
export type { OrganismSpec, OrganelleSpec } from './objects/organism.js';
export { Supervisor, SUPERVISOR_ID } from './runtime/supervisor.js';
export type { ChildSpec, RestartType, RestartStrategy, SupervisorConfig } from './runtime/supervisor.js';
export { WorkspaceManager, WORKSPACE_MANAGER_ID } from './objects/workspace-manager.js';
export type { WorkspaceAccessMode, SharedWorkspaceInfo } from './objects/workspace-manager.js';
export { WorkspaceRegistry, WORKSPACE_REGISTRY_ID } from './objects/workspace-registry.js';
export { WorkspaceSwitcher, WORKSPACE_SWITCHER_ID } from './objects/workspace-switcher.js';
export { GlobalSettings, GLOBAL_SETTINGS_ID } from './objects/global-settings.js';
export { GlobalToolbar, GLOBAL_TOOLBAR_ID } from './objects/global-toolbar.js';
export { PeerNetwork, PEER_NETWORK_ID } from './objects/peer-network.js';
export { ProcessExplorer, PROCESS_EXPLORER_ID } from './objects/process-explorer.js';
export { LLMMonitor, LLM_MONITOR_ID } from './objects/llm-monitor.js';
export { IdentityObject, IDENTITY_ID } from './objects/identity.js';
export { PeerRegistry, PEER_REGISTRY_ID } from './objects/peer-registry.js';
export { SignalingRelayObject, SIGNALING_RELAY_ID } from './objects/signaling-relay.js';
export { PeerDiscoveryObject, PEER_DISCOVERY_ID } from './objects/peer-discovery.js';
export { RemoteRegistry, REMOTE_REGISTRY_ID } from './objects/remote-registry.js';
export { WorkspaceShareRegistry, WORKSPACE_SHARE_REGISTRY_ID } from './objects/workspace-share-registry.js';
export type { DiscoveredWorkspace } from './objects/workspace-share-registry.js';
export { WorkspaceBrowser, WORKSPACE_BROWSER_ID } from './objects/workspace-browser.js';

// Export widget Abjects
export { WidgetAbject, buildFont, WIDGET_INTERFACE_DECL } from './objects/widgets/widget-abject.js';
export type { WidgetConfig } from './objects/widgets/widget-abject.js';
export { WindowAbject } from './objects/widgets/window-abject.js';
export { LabelWidget } from './objects/widgets/label-widget.js';
export { parseMarkdown, estimateMarkdownHeight } from './objects/widgets/markdown.js';
export type { ParsedMarkdown, MarkdownBlock, TextSpan, SpanStyle, BlockType } from './objects/widgets/markdown.js';
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
export { ListWidget } from './objects/widgets/list-widget.js';
export type { ListItem, ListWidgetConfig } from './objects/widgets/list-widget.js';
export { TreeWidget } from './objects/widgets/tree-widget.js';
export type { TreeItem, TreeWidgetConfig } from './objects/widgets/tree-widget.js';
export { SplitPaneWidget } from './objects/widgets/split-pane-widget.js';
export type { SplitPaneConfig } from './objects/widgets/split-pane-widget.js';
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
export { SharedState, SHARED_STATE_ID } from './objects/capabilities/shared-state.js';
export { TupleSpace, TUPLE_SPACE_ID } from './objects/tuple-space.js';
export type { TupleEntry, TuplePattern } from './objects/tuple-space.js';
export { FileTransfer, FILE_TRANSFER_ID } from './objects/capabilities/file-transfer.js';
export { MediaStreamCapability, MEDIA_STREAM_ID } from './objects/capabilities/media-stream.js';
export { AgentAbject, AGENT_ABJECT_ID } from './objects/agent-abject.js';
export type { AgentPhase, AgentAction, AgentActionResult, AgentTaskState, AgentTaskOptions, AgentConfig, TerminalActionConfig } from './objects/agent-abject.js';
export { WebBrowserViewer, WEB_BROWSER_VIEWER_ID } from './objects/web-browser-viewer.js';
export { ShellExecutor, SHELL_EXECUTOR_ID } from './objects/capabilities/shell-executor.js';
export { HostFileSystem, HOST_FILESYSTEM_ID } from './objects/capabilities/host-filesystem.js';
export { WebSearch, WEB_SEARCH_ID } from './objects/capabilities/web-search.js';
export { WebFetch, WEB_FETCH_ID } from './objects/capabilities/web-fetch.js';
export { Screenshot, SCREENSHOT_ID } from './objects/capabilities/screenshot.js';
export { SkillRegistry, SKILL_REGISTRY_ID } from './objects/skill-registry.js';
export { SkillAgent, SKILL_AGENT_ID } from './objects/skill-agent.js';
export { ObjectAgent, OBJECT_AGENT_ID } from './objects/object-agent.js';
export { SkillBrowser, SKILL_BROWSER_ID } from './objects/skill-browser.js';
export { MCPRegistryClient, MCP_REGISTRY_CLIENT_ID } from './objects/mcp-registry-client.js';
export type { MCPServerSummary, MCPServerDetail } from './objects/mcp-registry-client.js';
export { ClawHubClient, CLAWHUB_CLIENT_ID } from './objects/clawhub-client.js';
export type { ClawHubSkillSummary, SkillBundle } from './objects/clawhub-client.js';
export { CatalogBrowser, CATALOG_BROWSER_ID } from './objects/catalog-browser.js';
export { SecretsVault, SECRETS_VAULT_ID } from './objects/secrets-vault.js';
export type { SecretMeta } from './objects/secrets-vault.js';
export { OAuthHelper, OAUTH_HELPER_ID } from './objects/oauth-helper.js';
export type { OAuthProviderConfig, ConnectedAccount } from './objects/oauth-helper.js';
export { parseSkillMd } from './core/skill-parser.js';
export type { ParsedSkill } from './core/skill-parser.js';
export type { SkillInfo, SkillConfig, EnabledSkillSummary, MCPServerMeta } from './core/skill-types.js';
export { HttpServer, HTTP_SERVER_ID } from './objects/http-server.js';
export { MCPBridge, MCP_BRIDGE_ID } from './objects/mcp-bridge.js';
export type { MCPBridgeConfig, MCPBridgeStatus } from './objects/mcp-bridge.js';
export { MCPTransport } from './network/mcp-transport.js';
export type { MCPTransportState, MCPTransportEvents } from './network/mcp-transport.js';
export type {
  MCPToolDefinition, MCPToolCallResult, MCPContentItem,
  MCPResourceDefinition, MCPInitResult, MCPServerCapabilities,
  JsonRpcRequest, JsonRpcResponse, JsonRpcError,
} from './core/mcp-types.js';
// WebParser, WebBrowser, and WebAgent are server-only — import directly from their files:
// import { WebParser } from './objects/capabilities/web-parser.js';
// import { WebBrowser } from './objects/capabilities/web-browser.js';
// import { WebAgent } from './objects/web-agent.js';

// Export core types
export * from './core/types.js';
export * from './core/message.js';
export * from './core/capability.js';
export * from './core/contracts.js';
export { validateCode, runSandboxed, compileSandboxed, SANDBOX_BUILTINS, SANDBOX_BUILTIN_NAMES, BLOCKED_CODE_PATTERNS } from './core/sandbox.js';
export type { SandboxOptions } from './core/sandbox.js';
export { formatManifestAsDescription } from './core/introspect.js';
export type { PeerId, PeerIdentity, PeerContact, PeerConnectionState } from './core/identity.js';
export { derivePeerId, derivePeerIdFromJwk, deriveSessionKey, aesEncrypt, aesDecrypt } from './core/identity.js';
export type { IntrospectResult } from './core/introspect.js';

// Export LLM providers
export type { LLMProvider, LLMMessage, LLMCompletionResult, ModelTier, ModelInfo, ContentPart, TextPart, ImagePart } from './llm/provider.js';
export { getTextContent, userMessageWithImages } from './llm/provider.js';
export { AnthropicProvider } from './llm/anthropic.js';
export { OpenAIProvider } from './llm/openai.js';
export { OllamaProvider } from './llm/ollama.js';
export { OpenRouterProvider } from './llm/openrouter.js';
export { DeepSeekProvider } from './llm/deepseek.js';
export { GrokProvider } from './llm/grok.js';
export { GeminiProvider } from './llm/google-gemini.js';
export { KimiProvider } from './llm/kimi.js';
export { MiniMaxProvider } from './llm/minimax.js';

// Export network
export { Transport } from './network/transport.js';
export type { TransportConfig } from './network/transport.js';
export { WebSocketTransport } from './network/websocket.js';
export { SignalingClient } from './network/signaling.js';
export type { SignalingRelay } from './network/signaling.js';
export { PeerTransport } from './network/peer-transport.js';
export { PeerRouter, PEER_ROUTER_ID } from './network/peer-router.js';

// Export compositor
export { Compositor } from './ui/compositor.js';

