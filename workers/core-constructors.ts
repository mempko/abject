/**
 * The constructors every worker thread has: the abjects that run on any
 * instance, with or without a display. The desktop edition adds the UI ones
 * (ui-constructors.ts); the headless edition runs these alone, so its worker
 * bundle carries no window, widget or desktop code.
 *
 * Must match the main thread's registrations (server/boot.ts): an abject
 * registered there but missing here fails to spawn on the worker pool.
 */

import * as path from 'node:path';
import type { Abject } from '../src/core/abject.js';
import { AgentEvaluation } from '../src/objects/agent-evaluation.js';
import { TaskSession } from '../src/objects/task-session.js';
import type { AbjectId, AbjectManifest } from '../src/core/types.js';
import { LLMObject } from '../src/objects/llm-object.js';
import { ObjectCreator } from '../src/objects/object-creator.js';
import { ProxyGenerator } from '../src/objects/proxy-generator.js';
import { Negotiator } from '../src/protocol/negotiator.js';
import { HealthMonitor } from '../src/protocol/health-monitor.js';
import { CassetteRecorder } from '../src/objects/cassette-recorder.js';
import { HttpClient } from '../src/objects/capabilities/http-client.js';
import { Timer } from '../src/objects/capabilities/timer.js';
import { Clipboard } from '../src/objects/capabilities/clipboard.js';
import { Console } from '../src/objects/capabilities/console.js';
import { FileSystem } from '../src/objects/capabilities/filesystem.js';
import { JobManager } from '../src/objects/job-manager.js';
import { GoalManager } from '../src/objects/goal-manager.js';
import { AgentCreator } from '../src/objects/agent-creator.js';
import { Scheduler } from '../src/objects/scheduler.js';
import { TupleSpace } from '../src/objects/tuple-space.js';
import { TriggerManager } from '../src/objects/trigger-manager.js';
import { WebExposure } from '../src/objects/web-exposure.js';
import { CollectionStore } from '../src/objects/collection-store.js';
import { AbjectStore } from '../src/objects/abject-store.js';
import { NotificationCenter } from '../src/objects/notification-center.js';
import { ObjectCatalog } from '../src/objects/object-catalog.js';
import { Chat } from '../src/objects/chat.js';
import { ChatManager } from '../src/objects/chat-manager.js';
import { ThemeAbject } from '../src/objects/theme.js';
import { SettingsManager } from '../src/objects/settings-manager.js';
import { PermissionBroker } from '../src/objects/permission-broker.js';
import { DialogBroker } from '../src/objects/dialog-broker.js';
import { GoalObserver } from '../src/objects/goal-observer.js';
import { TaskReviewer } from '../src/objects/task-reviewer.js';
import { AgentAbject } from '../src/objects/agent-abject.js';
import { ScrumMaster } from '../src/objects/scrum-master.js';
import { ScriptableAbject } from '../src/objects/scriptable-abject.js';
import { NodeStorage } from '../server/node-storage.js';
import { ShellExecutor } from '../src/objects/capabilities/shell-executor.js';
import { HostFileSystem } from '../src/objects/capabilities/host-filesystem.js';
import { WebSearch } from '../src/objects/capabilities/web-search.js';
import { WebFetch } from '../src/objects/capabilities/web-fetch.js';
import { StreamClient } from '../src/objects/capabilities/stream-client.js';
import { SkillRegistry } from '../src/objects/skill-registry.js';
import { SkillAgent } from '../src/objects/skill-agent.js';
import { MCPRegistryClient } from '../src/objects/mcp-registry-client.js';
import { ClawHubClient } from '../src/objects/clawhub-client.js';
import { SecretsVault } from '../src/objects/secrets-vault.js';
import { Packages } from '../src/objects/packages.js';
import { Crypto } from '../src/objects/capabilities/crypto.js';
import { OAuthHelper } from '../src/objects/oauth-helper.js';
import { ObjectAgent } from '../src/objects/object-agent.js';
import { ExternalProjectRegistry } from '../src/objects/external-project-registry.js';
import { ExternalCreator } from '../src/objects/external-creator.js';
import { SharedState } from '../src/objects/capabilities/shared-state.js';
import { WebAgent } from '../src/objects/web-agent.js';
import { Organism } from '../src/objects/organism.js';
import type { OrganismSpec } from '../src/objects/organism.js';
import { WorkspaceManager } from '../src/objects/workspace-manager.js';
import { WorkspaceRegistry } from '../src/objects/workspace-registry.js';
import { WorkspaceShareRegistry } from '../src/objects/workspace-share-registry.js';
import { WebParser } from '../src/objects/capabilities/web-parser.js';
import { WebBrowser } from '../src/objects/capabilities/web-browser.js';
import { FileTransfer } from '../src/objects/capabilities/file-transfer.js';
import { MCPBridge } from '../src/objects/mcp-bridge.js';
import type { MCPBridgeConfig } from '../src/objects/mcp-bridge.js';
import { WasmAbject } from '../src/objects/wasm-abject.js';
import type { WasmAbjectArgs } from '../src/objects/wasm-abject.js';

export type ObjectFactory = (args?: unknown) => Abject;

export function coreConstructors(): Map<string, ObjectFactory> {
  const map = new Map<string, ObjectFactory>();
  map.set('LLMObject', () => new LLMObject());
  map.set('HttpClient', () => new HttpClient());
  map.set('Storage', (args?: unknown) => {
    const dataDir = process.env.ABJECTS_DATA_DIR ?? '.abjects';
    const opts = args as { dbName?: string } | undefined;
    if (opts?.dbName) {
      const wsId = opts.dbName.replace('abjects-storage-', '');
      const storagePath = path.resolve(dataDir, `ws-${wsId}`, 'storage.json');
      return new NodeStorage(storagePath);
    }
    return new NodeStorage(path.resolve(dataDir, 'storage.json'));
  });
  map.set('Timer', () => new Timer());
  map.set('Clipboard', () => new Clipboard());
  map.set('Console', () => new Console());
  map.set('FileSystem', (args?: unknown) => {
    const opts = args as { workspaceId?: string } | undefined;
    return new FileSystem(opts?.workspaceId);
  });
  map.set('ProxyGenerator', () => new ProxyGenerator());
  map.set('Negotiator', () => new Negotiator());
  map.set('HealthMonitor', () => new HealthMonitor());
  map.set('CassetteRecorder', () => new CassetteRecorder());
  map.set('ObjectCreator', () => new ObjectCreator());
  map.set('NotificationCenter', () => new NotificationCenter());
  map.set('ObjectCatalog', () => new ObjectCatalog());
  map.set('JobManager', () => new JobManager());
  map.set('GoalManager', () => new GoalManager());
  map.set('AgentCreator', () => new AgentCreator());
  map.set('Scheduler', () => new Scheduler());
  map.set('TupleSpace', () => new TupleSpace());
  map.set('TriggerManager', () => new TriggerManager());
  map.set('WebExposure', () => new WebExposure());
  map.set('CollectionStore', () => new CollectionStore());
  map.set('Chat', (args?: unknown) => new Chat(args as { conversationId?: string; title?: string; rect?: { x: number; y: number; width: number; height: number } } | undefined));
  map.set('ChatManager', () => new ChatManager());
  map.set('AbjectStore', () => new AbjectStore());
  map.set('Theme', () => new ThemeAbject());
  map.set('SettingsManager', () => new SettingsManager());
  map.set('PermissionBroker', () => new PermissionBroker());
  map.set('DialogBroker', () => new DialogBroker());
  map.set('GoalObserver', () => new GoalObserver());
  map.set('TaskSession', () => new TaskSession());
  map.set('AgentEvaluation', () => new AgentEvaluation());
  map.set('TaskReviewer', () => new TaskReviewer());
  map.set('AgentAbject', () => new AgentAbject());
  map.set('ScrumMaster', () => new ScrumMaster());
  map.set('ShellExecutor', () => new ShellExecutor());
  map.set('HostFileSystem', () => new HostFileSystem());
  map.set('WebSearch', () => new WebSearch());
  map.set('WebFetch', () => new WebFetch());
  map.set('StreamClient', () => new StreamClient());
  map.set('SkillRegistry', () => {
    const dataDir = process.env.ABJECTS_DATA_DIR ?? '.abjects';
    return new SkillRegistry(path.resolve(dataDir, 'skills'));
  });
  map.set('SkillAgent', () => new SkillAgent());
  map.set('MCPRegistryClient', () => new MCPRegistryClient());
  map.set('ClawHubClient', () => new ClawHubClient());
  map.set('SecretsVault', () => new SecretsVault());
  map.set('Packages', () => new Packages());
  map.set('Crypto', () => new Crypto());
  map.set('OAuthHelper', () => new OAuthHelper());
  map.set('ObjectAgent', () => new ObjectAgent());
  map.set('ExternalProjectRegistry', () => new ExternalProjectRegistry());
  map.set('ExternalCreator', () => new ExternalCreator());
  map.set('SharedState', () => new SharedState());
  map.set('WebAgent', () => new WebAgent());
  map.set('ScriptableAbject', (args?: unknown) => {
    const opts = args as {
      manifest: AbjectManifest;
      source: string;
      owner: string;
      data?: Record<string, unknown>;
    };
    return new ScriptableAbject(opts.manifest, opts.source, opts.owner as AbjectId, opts.data);
  });
  map.set('Organism', (args?: unknown) => {
    const spec = args as OrganismSpec;
    return new Organism(spec);
  });
  map.set('WorkspaceManager', () => new WorkspaceManager());
  map.set('WorkspaceRegistry', (args?: unknown) => new WorkspaceRegistry(args as { workspaceId?: string } | undefined));
  map.set('WorkspaceShareRegistry', () => new WorkspaceShareRegistry());
  map.set('WebParser', () => new WebParser());
  map.set('WebBrowser', () => new WebBrowser());
  map.set('FileTransfer', () => new FileTransfer());
  map.set('MCPBridge', (args?: unknown) => new MCPBridge(args as MCPBridgeConfig));
  map.set('WasmAbject', (args?: unknown) => new WasmAbject(args as WasmAbjectArgs));
  return map;
}
