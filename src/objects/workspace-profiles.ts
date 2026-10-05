/**
 * Workspace profiles: which built-in objects, and which packages, a workspace
 * gets.
 *
 * Every workspace used to get the same set: the agent stack, object creation,
 * the desktop UI, and every workspace-scope package. A profile names a set
 * instead, and a workspace keeps the profile it was created with:
 *
 * - `default`: today's set, and every package that names no profile.
 * - `service`: storage, sharing and web exposure only. No agents, no object
 *   creation, no desktop: for a workspace that serves rather than hosts a
 *   person, such as one organization's partition on a shared instance.
 * - any others defined in `$ABJECTS_DATA_DIR/profiles.json`:
 *
 *     { "profiles": { "org": { "description": "…", "objects": ["SharedState", "WebExposure"] } } }
 *
 *   `objects` lists built-in per-workspace objects. AbjectStore is always
 *   included (it is how a workspace persists); UI objects in the list are
 *   spawned when the workspace is first shown, the rest when it comes up.
 *
 * A package joins the profiles it lists in its abject.json (`"profiles":
 * ["org"]`); one that lists none joins `default` only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Infrastructure objects — spawned when a workspace comes up (no UI). */
export const INFRA_OBJECTS = [
  'AbjectStore', 'SharedState', 'TupleSpace', 'FileTransfer', 'MediaStream', 'Theme',
  'GoalManager', 'JobManager', 'TaskSession', 'AgentAbject', 'ScrumMaster', 'GoalObserver', 'WebAgent', 'SkillAgent', 'ObjectAgent',
  // ExternalProjectRegistry precedes ExternalCreator: the agent resolves it at init.
  'ExternalProjectRegistry', 'ExternalCreator', 'ObjectCreator',
  // TaskReviewer discovers KnowledgeBase, so it spawns after it.
  'AgentCreator', 'Scheduler', 'KnowledgeBase', 'TaskReviewer', 'AgentEvaluation', 'ChatManager',
  'Console', 'CollectionStore', 'TriggerManager', 'WebExposure',
] as const;

/** UI objects — deferred for inactive workspaces, spawned on first switch. */
export const UI_OBJECTS = [
  'Settings', 'AppExplorer', 'GoalBrowser', 'JobBrowser', 'KnowledgeBrowser', 'AgentBrowser', 'SchedulerBrowser',
  'WebBrowserViewer', 'FileManager', 'FileViewer', 'ExternalProjectBrowser', 'ChatBrowser',
  // Taskbar resolves its optional browsers at init, so every object it offers a
  // row for has to be spawned before it.
  'AbjectEditor', 'PeersViewer', 'Taskbar',
  'CommandPalette', 'NotificationCenter', 'WindowSwitcher', 'DataBrowser',
] as const;

/** All per-workspace objects in dependency order. */
export const PER_WORKSPACE_OBJECTS: readonly string[] = [...INFRA_OBJECTS, ...UI_OBJECTS];

/**
 * Per-workspace objects that cannot start without other per-workspace
 * objects: each requires (requireDep) these at init. A profile listing one
 * without its requirements is refused rather than left to fail at spawn.
 */
export const WORKSPACE_OBJECT_REQUIRES: Readonly<Record<string, readonly string[]>> = {
  ScrumMaster: ['AgentAbject', 'GoalManager'],
  WebAgent: ['AgentAbject'],
  SkillAgent: ['AgentAbject'],
  ObjectAgent: ['AgentAbject'],
  ExternalCreator: ['AgentAbject', 'ExternalProjectRegistry'],
  AgentCreator: ['AgentAbject'],
  TaskReviewer: ['AgentAbject'],
  GoalBrowser: ['GoalManager'],
  JobBrowser: ['JobManager'],
  ChatBrowser: ['ChatManager'],
  Taskbar: ['AppExplorer', 'ChatBrowser', 'JobBrowser', 'PeersViewer'],
};

export const DEFAULT_PROFILE = 'default';

export interface WorkspaceProfile {
  name: string;
  description: string;
  /** Spawned whenever the workspace is up, in dependency order. */
  objects: readonly string[];
  /** Spawned the first time the workspace is shown, in dependency order. */
  ui: readonly string[];
  origin: 'built-in' | 'configured';
}

const BUILT_IN_PROFILES: readonly WorkspaceProfile[] = [
  {
    name: DEFAULT_PROFILE,
    description: 'Everything: the agents, object creation, and the desktop.',
    objects: INFRA_OBJECTS,
    ui: UI_OBJECTS,
    origin: 'built-in',
  },
  {
    name: 'service',
    description: 'Storage, sharing and web exposure only; no agents, no object creation, no desktop. ' +
      'For a workspace that serves rather than hosts a person.',
    objects: ['AbjectStore', 'SharedState', 'Console', 'CollectionStore', 'WebExposure'],
    ui: [],
    origin: 'built-in',
  },
];

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const UI_SET: ReadonlySet<string> = new Set(UI_OBJECTS);

/** `$ABJECTS_DATA_DIR/profiles.json`, beside packages.json. */
export function profilesConfigPath(): string {
  return path.resolve(process.env.ABJECTS_DATA_DIR ?? '.abjects', 'profiles.json');
}

/**
 * Turn a configured object list into a profile, or say why it is not one:
 * unknown names, missing requirements. AbjectStore is added; the result is
 * in dependency order and split into objects and UI.
 */
export function buildProfile(name: string, description: string, objects: unknown):
  { profile: WorkspaceProfile } | { error: string } {
  if (!PROFILE_NAME.test(name)) return { error: `"${name}" is not a profile name (lowercase letters, digits, - and _)` };
  if (BUILT_IN_PROFILES.some(p => p.name === name)) return { error: `"${name}" is a built-in profile and cannot be redefined` };
  if (!Array.isArray(objects) || objects.some(o => typeof o !== 'string')) {
    return { error: `profile "${name}": objects must be a list of built-in object names` };
  }
  const listed = new Set<string>(['AbjectStore', ...(objects as string[])]);
  const unknown = [...listed].filter(o => !PER_WORKSPACE_OBJECTS.includes(o));
  if (unknown.length > 0) return { error: `profile "${name}": unknown object(s) ${unknown.join(', ')}` };
  for (const obj of listed) {
    const missing = (WORKSPACE_OBJECT_REQUIRES[obj] ?? []).filter(dep => !listed.has(dep));
    if (missing.length > 0) return { error: `profile "${name}": ${obj} needs ${missing.join(', ')}` };
  }
  const ordered = PER_WORKSPACE_OBJECTS.filter(o => listed.has(o));
  return {
    profile: {
      name,
      description,
      objects: ordered.filter(o => !UI_SET.has(o)),
      ui: ordered.filter(o => UI_SET.has(o)),
      origin: 'configured',
    },
  };
}

/**
 * The built-in profiles plus the configured ones. A malformed file or profile
 * is reported in `problems` and left out, never thrown: the instance still
 * boots, and a workspace created with a missing profile is not restored
 * under another (see WorkspaceManager).
 */
export function loadWorkspaceProfiles(file = profilesConfigPath()):
  { profiles: Map<string, WorkspaceProfile>; problems: string[] } {
  const profiles = new Map<string, WorkspaceProfile>(BUILT_IN_PROFILES.map(p => [p.name, p]));
  const problems: string[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { profiles, problems };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    problems.push(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return { profiles, problems };
  }
  const defs = (parsed as { profiles?: unknown })?.profiles;
  if (!defs || typeof defs !== 'object' || Array.isArray(defs)) {
    problems.push(`${file}: expected { "profiles": { "<name>": { "objects": [...] } } }`);
    return { profiles, problems };
  }
  for (const [name, def] of Object.entries(defs as Record<string, unknown>)) {
    const d = (def ?? {}) as { description?: unknown; objects?: unknown };
    const built = buildProfile(name, typeof d.description === 'string' ? d.description : '', d.objects);
    if ('error' in built) problems.push(built.error);
    else profiles.set(name, built.profile);
  }
  return { profiles, problems };
}

/** Whether a package with these declared profiles joins workspaces of `profile`. */
export function packageInProfile(profile: string, packageProfiles: readonly string[] | undefined): boolean {
  return packageProfiles && packageProfiles.length > 0
    ? packageProfiles.includes(profile)
    : profile === DEFAULT_PROFILE;
}
