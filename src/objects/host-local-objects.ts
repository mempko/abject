/**
 * Host-local objects: the shell and infrastructure that make up THIS peer's
 * desktop, as opposed to the collaborative content of a workspace.
 *
 * A 'shared' workspace is collaborative by definition — every non-system abject
 * in it reaches its members automatically, with no whitelist for the user to
 * maintain. That default is only safe if there is one agreed answer to "which
 * objects are the host's own furniture?", so both the outbound catalog
 * (WorkspaceShareRegistry) and the Shared tab (AppExplorer) read it from here.
 *
 * The list is deliberately an EXCLUSION list, not an allow-list: a newly
 * created user abject is shared without anyone editing this file, which is the
 * whole point of automatic sharing. Membership is by manifest name because
 * AbjectIds are ephemeral — they rotate every time an object is respawned, so a
 * set keyed on them would decay to nothing across a restart.
 *
 * Two deliberate absences, both load-bearing:
 *  - `WorkspaceRegistry` is NOT here. It is the joiner's entry point into the
 *    workspace and the one object that resolves the others by name after their
 *    ids have rotated; withholding it leaves the mirror with nothing to talk to.
 *  - The collaboration primitives (`SharedState`, `TupleSpace`, `FileTransfer`,
 *    `MediaStream`) and the shared data objects (`GoalManager`, `JobManager`,
 *    `KnowledgeBase`, `ChatManager`, `CollectionStore`) are NOT here either.
 *    They are spawned as workspace infrastructure, but they are the substance
 *    of collaboration rather than host furniture — WorkspaceManager already
 *    force-exposes SharedState for exactly this reason, and excluding them
 *    would quietly disable shared state for every shared workspace.
 */
export const HOST_LOCAL_OBJECTS: ReadonlySet<string> = new Set<string>([
  // Desktop shell — the windows, chrome and launchers of this peer's UI.
  'Taskbar', 'Settings', 'CommandPalette', 'NotificationCenter', 'WindowSwitcher',
  'AppExplorer', 'Sidebar', 'GlobalToolbar', 'WorkspaceSwitcher', 'Desktop',
  'Compositor', 'UIServer', 'WidgetManager',
  // Browsers and editors — views onto local state, never the state itself.
  'GoalBrowser', 'JobBrowser', 'KnowledgeBrowser', 'AgentBrowser', 'SchedulerBrowser',
  'WebBrowserViewer', 'FileManager', 'FileViewer', 'ExternalProjectBrowser',
  'ChatBrowser', 'ObjectCreator', 'AbjectEditor', 'DataBrowser',
  // Host-local infrastructure — persistence and capabilities bound to this
  // machine, and meaningless (or unsafe) when reached from someone else's.
  'Storage', 'AbjectStore', 'FileSystem', 'Clipboard', 'Console', 'Timer',
  'HttpClient', 'Theme', 'Scheduler', 'TriggerManager', 'SkillRegistry',
  // Orchestration and agents — these act with this host's authority.
  'ScrumMaster', 'GoalObserver', 'TaskReviewer', 'AgentCreator', 'AgentAbject',
  'WebAgent', 'SkillAgent', 'ObjectAgent', 'ExternalCreator', 'ExternalProjectRegistry',
  // System singletons — every peer runs its own, so a peer's copy is never useful.
  'Registry', 'Factory', 'WorkspaceManager', 'WorkspaceShareRegistry', 'P2P',
  'PeerRouter', 'LLMObject', 'Negotiator', 'HealthMonitor', 'ProxyGenerator',
]);

/** True when `name` is one of this host's own shell/infrastructure abjects. */
export function isHostLocalObject(name: string | undefined): boolean {
  return name !== undefined && HOST_LOCAL_OBJECTS.has(name);
}
