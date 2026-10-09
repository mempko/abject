/**
 * The constructors only the desktop edition's workers have: windows, widgets,
 * browsers and the display capabilities. Added on top of coreConstructors().
 */

import type { ObjectFactory } from './core-constructors.js';
import { AbjectEditor } from '../src/objects/abject-editor.js';
import { KnowledgeBrowser } from '../src/objects/knowledge-browser.js';
import { FileManager } from '../src/objects/file-manager.js';
import { FileViewer } from '../src/objects/file-viewer.js';
import { AgentBrowser } from '../src/objects/agent-browser.js';
import { SchedulerBrowser } from '../src/objects/scheduler-browser.js';
import { DataBrowser } from '../src/objects/data-browser.js';
import { GoalBrowser } from '../src/objects/goal-browser.js';
import { Settings } from '../src/objects/settings.js';
import { CommandPaletteAbject } from '../src/objects/command-palette.js';
import { WindowSwitcherAbject } from '../src/objects/window-switcher.js';
import { AppExplorer } from '../src/objects/app-explorer.js';
import { ObjectBrowser } from '../src/objects/object-browser.js';
import { MethodInspector } from '../src/objects/method-inspector.js';
import { JobBrowser } from '../src/objects/job-browser.js';
import { ChatWindow } from '../src/objects/chat-window.js';
import { ChatBrowser } from '../src/objects/chat-browser.js';
import { Taskbar } from '../src/objects/taskbar.js';
import { PeersViewer } from '../src/objects/peers-viewer.js';
import { ProcessExplorer } from '../src/objects/process-explorer.js';
import { LLMMonitor } from '../src/objects/llm-monitor.js';
import { GlobalSettings } from '../src/objects/global-settings.js';
import { PeerNetwork } from '../src/objects/peer-network.js';
import { AudioOutput } from '../src/objects/capabilities/audio-output.js';
import { Speech } from '../src/objects/capabilities/speech.js';
import { Screenshot } from '../src/objects/capabilities/screenshot.js';
import { SkillBrowser } from '../src/objects/skill-browser.js';
import { CatalogBrowser } from '../src/objects/catalog-browser.js';
import { ExternalProjectBrowser } from '../src/objects/external-project-browser.js';
import { WorkspaceBrowser } from '../src/objects/workspace-browser.js';
import { WorkspaceCollaboratorInspector } from '../src/objects/workspace-collaborator-inspector.js';
import { WidgetManager } from '../src/objects/widget-manager.js';
import { SceneLibrary } from '../src/objects/scene-library.js';
import { WindowManager } from '../src/objects/window-manager.js';
import { Sidebar } from '../src/objects/sidebar.js';
import { GlobalToolbar } from '../src/objects/global-toolbar.js';
import { WorkspaceSwitcher } from '../src/objects/workspace-switcher.js';
import { WebBrowserViewer } from '../src/objects/web-browser-viewer.js';

export function addUiConstructors(map: Map<string, ObjectFactory>): Map<string, ObjectFactory> {
  map.set('AbjectEditor', () => new AbjectEditor());
  map.set('Settings', () => new Settings());
  map.set('CommandPalette', () => new CommandPaletteAbject());
  map.set('WindowSwitcher', () => new WindowSwitcherAbject());
  map.set('AppExplorer', () => new AppExplorer());
  map.set('ObjectBrowser', () => new ObjectBrowser());
  map.set('MethodInspector', () => new MethodInspector());
  map.set('JobBrowser', () => new JobBrowser());
  map.set('KnowledgeBrowser', () => new KnowledgeBrowser());
  map.set('FileManager', () => new FileManager());
  map.set('FileViewer', () => new FileViewer());
  map.set('AgentBrowser', () => new AgentBrowser());
  map.set('SchedulerBrowser', () => new SchedulerBrowser());
  map.set('DataBrowser', () => new DataBrowser());
  map.set('GoalBrowser', () => new GoalBrowser());
  map.set('ChatWindow', (args?: unknown) => new ChatWindow(args as ConstructorParameters<typeof ChatWindow>[0]));
  map.set('ChatBrowser', () => new ChatBrowser());
  map.set('Taskbar', () => new Taskbar());
  map.set('PeersViewer', () => new PeersViewer());
  map.set('ProcessExplorer', () => new ProcessExplorer());
  map.set('LLMMonitor', () => new LLMMonitor());
  map.set('GlobalSettings', () => new GlobalSettings());
  map.set('PeerNetwork', () => new PeerNetwork());
  map.set('AudioOutput', () => new AudioOutput());
  map.set('Speech', () => new Speech());
  map.set('Screenshot', () => new Screenshot());
  map.set('SkillBrowser', () => new SkillBrowser());
  map.set('CatalogBrowser', () => new CatalogBrowser());
  map.set('ExternalProjectBrowser', () => new ExternalProjectBrowser());
  map.set('WorkspaceBrowser', () => new WorkspaceBrowser());
  map.set('WorkspaceCollaboratorInspector', () => new WorkspaceCollaboratorInspector());
  map.set('WidgetManager', () => new WidgetManager());
  map.set('SceneLibrary', () => new SceneLibrary());
  map.set('WindowManager', () => new WindowManager());
  map.set('Sidebar', () => new Sidebar());
  map.set('GlobalToolbar', () => new GlobalToolbar());
  map.set('WorkspaceSwitcher', () => new WorkspaceSwitcher());
  map.set('WebBrowserViewer', () => new WebBrowserViewer());
  return map;
}
