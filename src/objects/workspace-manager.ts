/**
 * WorkspaceManager — orchestrates workspace lifecycle.
 *
 * Each workspace is an isolated collection of abjects with its own registry,
 * storage, taskbar, chat, settings, theme, and user-created objects.
 * A workspace switcher in the taskbar lets users move between them.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  AbjectId,
  TypeId,
  AbjectMessage,
  InterfaceId,
  SpawnResult,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import type { ThemeData } from '../core/theme-data.js';
import { require as precondition, invariant } from '../core/contracts.js';
import { request, event } from '../core/message.js';
import { SIDEBAR_WIDTH, SIDEBAR_COMPACT_WIDTH } from './sidebar.js';
import { namesFromTypeIds, nameFromTypeId } from './exposure-selectors.js';
import { isHostLocalObject } from './host-local-objects.js';
import { Log } from '../core/timed-log.js';

const WORKSPACE_MANAGER_INTERFACE = 'abjects:workspace-manager' as InterfaceId;
const STORAGE_INTERFACE = 'abjects:storage' as InterfaceId;
const REGISTRY_INTERFACE = 'abjects:registry' as InterfaceId;
const FACTORY_INTERFACE = 'abjects:factory' as InterfaceId;
const TASKBAR_INTERFACE = 'abjects:taskbar' as InterfaceId;
const WORKSPACE_REGISTRY_INTERFACE = 'abjects:workspace-registry' as InterfaceId;
const ABJECT_STORE_INTERFACE = 'abjects:abject-store' as InterfaceId;
const SUPERVISOR_INTERFACE = 'abjects:supervisor' as InterfaceId;
const UI_INTERFACE = 'abjects:ui' as InterfaceId;
const WIDGETS_INTERFACE = 'abjects:widgets' as InterfaceId;
const WINDOW_MANAGER_INTERFACE = 'abjects:window-manager' as InterfaceId;

const SETTINGS_INTERFACE = 'abjects:settings' as InterfaceId;
const CHAT_INTERFACE = 'abjects:chat' as InterfaceId;
const CHAT_BROWSER_INTERFACE = 'abjects:chat-browser' as InterfaceId;
const APP_EXPLORER_INTERFACE = 'abjects:app-explorer' as InterfaceId;
const JOB_BROWSER_INTERFACE = 'abjects:job-browser' as InterfaceId;
const GOAL_BROWSER_INTERFACE = 'abjects:goal-browser' as InterfaceId;
const WORKSPACE_SWITCHER_INTERFACE = 'abjects:workspace-switcher' as InterfaceId;
const GLOBAL_TOOLBAR_INTERFACE = 'abjects:global-toolbar' as InterfaceId;

const STORAGE_KEY_LIST = 'workspaces:list';
const STORAGE_KEY_ACTIVE = 'workspaces:active';

const wsLog = new Log('WORKSPACE-MANAGER');

/** Infrastructure objects — always spawned for every workspace (no UI). */
const INFRA_OBJECTS = [
  'AbjectStore', 'SharedState', 'TupleSpace', 'FileTransfer', 'MediaStream', 'Theme',
  'GoalManager', 'JobManager', 'TaskSession', 'AgentAbject', 'ScrumMaster', 'GoalObserver', 'WebAgent', 'SkillAgent', 'ObjectAgent',
  // ExternalProjectRegistry precedes ExternalCreator: the agent resolves it at init.
  'ExternalProjectRegistry', 'ExternalCreator', 'ObjectCreator',
  // TaskReviewer discovers KnowledgeBase, so it spawns after it.
  'AgentCreator', 'Scheduler', 'KnowledgeBase', 'TaskReviewer', 'AgentEvaluation', 'ChatManager',
  'Console', 'CollectionStore', 'TriggerManager', 'WebExposure',
] as const;

/** UI objects — deferred for inactive workspaces, spawned on first switch. */
const UI_OBJECTS = [
  'Settings', 'AppExplorer', 'GoalBrowser', 'JobBrowser', 'KnowledgeBrowser', 'AgentBrowser', 'SchedulerBrowser',
  'WebBrowserViewer', 'FileManager', 'FileViewer', 'ExternalProjectBrowser', 'ChatBrowser',
  // Taskbar resolves its optional browsers at init, so every object it offers a
  // row for has to be spawned before it.
  'AbjectEditor', 'PeersViewer', 'Taskbar',
  'CommandPalette', 'NotificationCenter', 'WindowSwitcher', 'DataBrowser',
] as const;

/** All per-workspace objects in dependency order. */
const PER_WORKSPACE_OBJECTS = [...INFRA_OBJECTS, ...UI_OBJECTS];

export type WorkspaceAccessMode = 'local' | 'shared' | 'public';

/**
 * Coerce a persisted access mode to the current vocabulary. 'private' was
 * renamed to 'shared' (whitelisted peers only); anything unrecognised becomes
 * 'local', so a stale record can only narrow access, never widen it.
 */
export function normalizeAccessMode(raw: unknown): WorkspaceAccessMode {
  if (raw === 'local' || raw === 'shared' || raw === 'public') return raw;
  if (raw === 'private') return 'shared';
  return 'local';
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  description: string;
  tags: string[];
  accessMode: WorkspaceAccessMode;
  whitelist: string[];
  exposedObjectIds: AbjectId[];
  exposedTypeIds: TypeId[];
  /**
   * True only when the user has explicitly curated the exposure list through
   * `setExposedObjects`. The registry and SharedState entries that
   * `setAccessMode` seeds automatically are infrastructure, not a curation
   * choice, so they leave this false and the workspace keeps offering every
   * shareable object to joiners.
   */
  curated?: boolean;
  childIds: AbjectId[];
  registryId: AbjectId;
  storageId: AbjectId;
  taskbarId: AbjectId;
  uiObjects: Array<{ id: AbjectId; iface: InterfaceId }>;
  childTypeIds: Map<AbjectId, TypeId>;
  uiSpawned: boolean;
  /**
   * True when this record mirrors a workspace hosted by a remote peer. Joined
   * records are first-class workspaces locally — own registry, own taskbar —
   * but they stay `accessMode: 'local'` because we mirror them, we do not host
   * them, and must not re-advertise them as ours.
   */
  joined?: boolean;
  /** Peer hosting this shared workspace (joined records only). */
  ownerPeerId?: string;
  /**
   * Peers (including this instance) known to hold a reference to the shared
   * workspace. A shared workspace is reference-counted across instances: it
   * survives until every participant has left or deleted it.
   */
  participants?: string[];
}

export interface SharedWorkspaceInfo {
  workspaceId: string;
  name: string;
  description?: string;
  tags?: string[];
  ownerPeerId?: string;
  ownerName?: string;
  accessMode: WorkspaceAccessMode;
  whitelist?: string[];
  exposedObjectIds?: string[];
  /**
   * TypeIds of the curated exposure list, carried alongside `exposedObjectIds`.
   * Consumers honour curation across a restart through these: the AbjectIds of
   * the previous run no longer resolve, but the types still do.
   */
  exposedTypeIds?: string[];
  /**
   * True when the exposure list is a deliberate user curation rather than the
   * automatic registry/SharedState seed. Consumers must not infer curation
   * from a non-empty exposure list: a shared workspace never has an empty one.
   */
  curated?: boolean;
  registryId?: string;
}

interface PersistedWorkspace {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  accessMode?: WorkspaceAccessMode;
  whitelist?: string[];
  exposedObjectIds?: string[];
  exposedTypeIds?: string[];
  /** Whether the user explicitly curated this workspace's exposure list. */
  curated?: boolean;
  createdAt: number;
  /** Set for workspaces joined from a peer, so they are restored as such. */
  joined?: boolean;
  ownerPeerId?: string;
  participants?: string[];
}

/** Route shape both invite-link forms parse into (what WorkspaceShareRegistry consumes). */
export interface InviteLinkRoute {
  ownerPeerId: string;
  workspaceId: string;
  accessMode: string;
  registryId: string;
  name?: string;
}

/**
 * Parse an invite link. Two forms are accepted everywhere a link is pasted:
 *
 *   abject://<ownerPeerId>/<workspaceId>                      (short form,
 *                                   what Settings shows as the share link)
 *   abject://join?peer=<ownerPeerId>&ws=<workspaceId>&mode=…&reg=…&name=…
 *                                   (full form, from createInviteLink)
 *
 * Parsed by hand rather than via `new URL(...)` so a custom scheme, a bare
 * query string, or a pasted fragment all behave the same. Missing fields in
 * the short form default to a public route with no registry hint; the join
 * then relies on discovery for the rest.
 */
export function parseInviteLink(link: string): InviteLinkRoute | undefined {
  const raw = (link ?? '').trim();
  if (!raw) return undefined;

  const short = raw.match(/^(?:abject:\/\/)?([^/?#\s]+)\/([^/?#\s]+)$/);
  if (short && short[1] !== 'join') {
    return { ownerPeerId: short[1], workspaceId: short[2], accessMode: 'public', registryId: '' };
  }

  const qIndex = raw.indexOf('?');
  const query = qIndex >= 0 ? raw.slice(qIndex + 1) : raw;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(query);
  } catch {
    return undefined;
  }

  const ownerPeerId = params.get('peer') ?? '';
  const workspaceId = params.get('ws') ?? '';
  if (!ownerPeerId || !workspaceId) return undefined;

  return {
    ownerPeerId,
    workspaceId,
    accessMode: params.get('mode') ?? 'public',
    registryId: params.get('reg') ?? '',
    name: params.get('name') ?? undefined,
  };
}

export class WorkspaceManager extends Abject {
  private workspaces: Map<string, WorkspaceInfo> = new Map();
  /**
   * Last loaded persisted records, indexed by id. restoreWorkspace reads this
   * to recover fields its call site does not carry (joined/owner/participants).
   */
  private persistedById: Map<string, PersistedWorkspace> = new Map();
  private activeWorkspaceId?: string;
  private peerId?: string;
  private globalStorageId?: AbjectId;
  private globalRegistryId?: AbjectId;
  private factoryId?: AbjectId;
  private supervisorId?: AbjectId;
  private workspaceSwitcherId?: AbjectId;
  private workspaceShareRegistryId?: AbjectId;
  private globalToolbarId?: AbjectId;
  private sidebarId?: AbjectId;
  /** Debounce for display-driven sidebar rebuilds (client connect bursts). */
  private sidebarRefreshTimer?: ReturnType<typeof setTimeout>;
  private uiServerId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private windowManagerId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'WorkspaceManager',
        description:
          'Manages workspace lifecycle: create, switch, delete, and persist workspaces. Each workspace is an isolated collection of abjects.',
        version: '1.0.0',
        interface: {
            id: WORKSPACE_MANAGER_INTERFACE,
            name: 'WorkspaceManager',
            description: 'Workspace lifecycle management',
            methods: [
              {
                name: 'createWorkspace',
                description: 'Create a new workspace',
                parameters: [
                  {
                    name: 'name',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Workspace name',
                  },
                ],
                returns: { kind: 'object', properties: { workspaceId: { kind: 'primitive', primitive: 'string' } } },
              },
              {
                name: 'deleteWorkspace',
                description: 'Delete a workspace',
                parameters: [
                  {
                    name: 'workspaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'ID of workspace to delete',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'recoverLostObjects',
                description: 'After a worker thread crash: rebuild any workspace that lost objects (respawn it, restore its user objects from snapshots, fail its running goals with the reason), and restore lost user objects elsewhere. Returns { workspaces: [{ workspaceId, name, lost, restored, goalsFailed }] }.',
                parameters: [
                  { name: 'objectIds', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Ids of the objects that died' },
                  { name: 'reason', type: { kind: 'primitive', primitive: 'string' }, description: 'Reason recorded on the failed goals', optional: true },
                ],
                returns: { kind: 'object', properties: {} },
              },
              {
                name: 'switchWorkspace',
                description: 'Switch to a workspace',
                parameters: [
                  {
                    name: 'workspaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'ID of workspace to switch to',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'listWorkspaces',
                description: 'List all workspaces',
                parameters: [],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'reference', reference: 'WorkspaceInfo' },
                },
              },
              {
                name: 'getActiveWorkspace',
                description: 'Get the active workspace',
                parameters: [],
                returns: { kind: 'object', properties: {
                  id: { kind: 'primitive', primitive: 'string' },
                  name: { kind: 'primitive', primitive: 'string' },
                  registryId: { kind: 'primitive', primitive: 'string' },
                } },
              },
              {
                name: 'renameWorkspace',
                description: 'Rename a workspace',
                parameters: [
                  {
                    name: 'workspaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'ID of workspace to rename',
                  },
                  {
                    name: 'name',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'New name',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getAccessMode',
                description: 'Get the access mode of a workspace',
                parameters: [
                  {
                    name: 'workspaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'ID of workspace',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'setAccessMode',
                description: 'Set the access mode of a workspace (local, private, public)',
                parameters: [
                  {
                    name: 'workspaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'ID of workspace',
                  },
                  {
                    name: 'accessMode',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Access mode: local, private, or public',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getWhitelist',
                description: 'Get the whitelist of allowed peer IDs for a workspace',
                parameters: [
                  {
                    name: 'workspaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'ID of workspace',
                  },
                ],
                returns: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
              },
              {
                name: 'setWhitelist',
                description: 'Set the whitelist of allowed peer IDs for a workspace',
                parameters: [
                  {
                    name: 'workspaceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'ID of workspace',
                  },
                  {
                    name: 'whitelist',
                    type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
                    description: 'Array of peer IDs',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'listSharedWorkspaces',
                description: 'List workspaces that are shared (not local)',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'SharedWorkspaceInfo' } },
              },
              {
                name: 'listJoinedWorkspaces',
                description: 'List workspaces joined from a peer, with their owner peer and registry',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'JoinedWorkspaceInfo' } },
              },
              {
                name: 'findWorkspaceForObject',
                description: 'Find which workspace contains a given object and return its access info',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Object ID to look up',
                  },
                ],
                returns: { kind: 'object', properties: {
                  workspaceId: { kind: 'primitive', primitive: 'string' },
                  name: { kind: 'primitive', primitive: 'string' },
                  accessMode: { kind: 'primitive', primitive: 'string' },
                  whitelist: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
                } },
              },
              {
                name: 'getWorkspaceForObject',
                description: 'Fast lookup: find which workspace contains a given object by ID',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Object ID to look up',
                  },
                ],
                returns: { kind: 'object', properties: {
                  workspaceId: { kind: 'primitive', primitive: 'string' },
                  workspaceName: { kind: 'primitive', primitive: 'string' },
                } },
              },
              {
                name: 'listWorkspacesDetailed',
                description: 'List all workspaces with full details including child IDs and access mode',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'WorkspaceDetailedInfo' } },
              },
              {
                name: 'getExposedObjects',
                description: 'Get the list of exposed object IDs for a workspace',
                parameters: [
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'ID of workspace' },
                ],
                returns: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
              },
              {
                name: 'setExposedObjects',
                description: 'Set the list of exposed object IDs for a workspace',
                parameters: [
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'ID of workspace' },
                  { name: 'objectIds', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Array of object IDs to expose' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getDescription',
                description: 'Get the description of a workspace',
                parameters: [
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'ID of workspace' },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'setDescription',
                description: 'Set the description of a workspace',
                parameters: [
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'ID of workspace' },
                  { name: 'description', type: { kind: 'primitive', primitive: 'string' }, description: 'Workspace description' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getTags',
                description: 'Get the tags of a workspace',
                parameters: [
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'ID of workspace' },
                ],
                returns: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
              },
              {
                name: 'setTags',
                description: 'Set the tags of a workspace',
                parameters: [
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'ID of workspace' },
                  { name: 'tags', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Array of tags' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'createInviteLink',
                description: 'Create a shareable invite link for a workspace',
                parameters: [
                  { name: 'workspaceId', type: { kind: 'primitive', primitive: 'string' }, description: 'ID of workspace' },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'joinFromInviteLink',
                description: 'Join a shared workspace from an invite link',
                parameters: [
                  { name: 'link', type: { kind: 'primitive', primitive: 'string' }, description: 'Invite link (abject://join?...)' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
          },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'core'],
      },
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('createWorkspace', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      return this.createWorkspace(name);
    });

    this.on('recoverLostObjects', async (msg: AbjectMessage) => {
      const { objectIds, reason } = msg.payload as { objectIds: string[]; reason?: string };
      return this.recoverLostObjects(new Set((Array.isArray(objectIds) ? objectIds : []) as AbjectId[]),
        reason ?? 'A worker thread crashed and took this workspace\'s objects with it');
    });

    this.on('deleteWorkspace', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      return this.deleteWorkspace(workspaceId);
    });

    this.on('switchWorkspace', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      return this.switchWorkspace(workspaceId);
    });

    this.on('listWorkspaces', async () => {
      return this.listWorkspaces();
    });

    this.on('getActiveWorkspace', async () => {
      return this.getActiveWorkspace();
    });

    this.on('renameWorkspace', async (msg: AbjectMessage) => {
      const { workspaceId, name } = msg.payload as { workspaceId: string; name: string };
      return this.renameWorkspace(workspaceId, name);
    });

    this.on('getAccessMode', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      return this.getAccessMode(workspaceId);
    });

    this.on('setAccessMode', async (msg: AbjectMessage) => {
      const { workspaceId, accessMode } = msg.payload as { workspaceId: string; accessMode: string };
      return this.setAccessMode(workspaceId, accessMode as WorkspaceAccessMode);
    });

    this.on('getWhitelist', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      return this.getWhitelist(workspaceId);
    });

    this.on('setWhitelist', async (msg: AbjectMessage) => {
      const { workspaceId, whitelist } = msg.payload as { workspaceId: string; whitelist: string[] };
      return this.setWhitelist(workspaceId, whitelist);
    });

    this.on('listSharedWorkspaces', async () => {
      return this.listSharedWorkspaces();
    });

    this.on('listJoinedWorkspaces', async () => {
      return this.listJoinedWorkspaces();
    });

    this.on('findWorkspaceForObject', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: string };
      return this.findWorkspaceForObject(objectId as AbjectId);
    });

    this.on('getWorkspaceForObject', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: string };
      return this.getWorkspaceForObject(objectId as AbjectId);
    });

    this.on('listWorkspacesDetailed', async () => {
      return this.listWorkspacesDetailed();
    });

    this.on('getExposedObjects', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      return this.getExposedObjects(workspaceId);
    });

    this.on('setExposedObjects', async (msg: AbjectMessage) => {
      const { workspaceId, objectIds } = msg.payload as { workspaceId: string; objectIds: string[] };
      return this.setExposedObjects(workspaceId, objectIds as AbjectId[]);
    });

    this.on('getDescription', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      return this.getDescription(workspaceId);
    });

    this.on('setDescription', async (msg: AbjectMessage) => {
      const { workspaceId, description } = msg.payload as { workspaceId: string; description: string };
      return this.setDescription(workspaceId, description);
    });

    this.on('getTags', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      return this.getTags(workspaceId);
    });

    this.on('setTags', async (msg: AbjectMessage) => {
      const { workspaceId, tags } = msg.payload as { workspaceId: string; tags: string[] };
      return this.setTags(workspaceId, tags);
    });

    this.on('refreshTaskbar', async () => {
      return this.refreshTaskbar();
    });

    this.on('materializeJoinedWorkspace', async (msg: AbjectMessage) => {
      const { workspaceId, name, ownerPeerId, participants } = msg.payload as {
        workspaceId: string; name?: string; ownerPeerId: string; participants?: string[];
      };
      return this.materializeJoinedWorkspace(workspaceId, name ?? '', ownerPeerId, participants ?? []);
    });

    this.on('releaseJoinedWorkspace', async (msg: AbjectMessage) => {
      const { workspaceId, peerId, destroy } = msg.payload as {
        workspaceId: string; peerId?: string; destroy?: boolean;
      };
      return this.releaseJoinedWorkspace(workspaceId, peerId, destroy ?? false);
    });

    this.on('getWorkspaceRegistryId', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      return this.workspaces.get(workspaceId)?.registryId ?? null;
    });

    this.on('createInviteLink', async (msg: AbjectMessage) => {
      const { workspaceId } = (msg.payload ?? {}) as { workspaceId?: string };
      return this.createInviteLink(workspaceId ?? '');
    });

    this.on('joinFromInviteLink', async (msg: AbjectMessage) => {
      const { link } = (msg.payload ?? {}) as { link?: string };
      return this.joinFromInviteLink(link ?? '');
    });

    // UIServer dependency events: a frontend client becoming ready makes
    // display info live, so rebuild the display-sized sidebar dock. Debounced
    // because connects and reconnects arrive in bursts.
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect } = msg.payload as { aspect: string };
      if (aspect === 'frontendClientsChanged' && msg.routing.from === this.uiServerId) {
        if (this.sidebarRefreshTimer) return;
        this.sidebarRefreshTimer = setTimeout(() => {
          this.sidebarRefreshTimer = undefined;
          this.refreshTaskbar().catch(() => {});
        }, 250);
      }
    });

    // Keep workspace membership and exposure in sync when Factory registers a
    // newly spawned, cloned, or restored child with its WorkspaceRegistry.
    this.on('objectRegistered', async (msg: AbjectMessage) => {
      const registryId = msg.routing.from;
      const { id: objectId, typeId } = msg.payload as { id: string; typeId?: string };
      for (const ws of this.workspaces.values()) {
        if (ws.registryId !== registryId) continue;

        const childId = objectId as AbjectId;
        let workspaceChanged = false;
        if (!ws.childIds.includes(childId)) {
          ws.childIds.push(childId);
          workspaceChanged = true;
        }
        if (typeId && ws.childTypeIds.get(childId) !== typeId) {
          ws.childTypeIds.set(childId, typeId as TypeId);
          workspaceChanged = true;
        }

        // Uncurated shared workspaces and joined mirrors expose newly
        // registered children automatically. Public workspaces retain their
        // deliberately narrow default until explicitly curated.
        const autoExpose = ws.curated !== true
          && (ws.accessMode === 'shared' || ws.joined === true);
        if (autoExpose && !ws.exposedObjectIds.includes(childId)) {
          ws.exposedObjectIds.push(childId);
          workspaceChanged = true;
        }

        if (workspaceChanged) {
          await this.syncExposedToRegistry(ws);
          await this.persistWorkspaceList();
          if (ws.accessMode !== 'local') {
            this.changed('workspaceObjectsChanged', {
              workspaceId: ws.id, objectId,
            });
          }
        }
        break;
      }
    });

    // Boot must be called after spawn completes (cannot spawn during onInit
    // because Factory is busy processing our own spawn request).
    this.on('boot', async () => {
      return this.boot();
    });
  }

  protected override async onInit(): Promise<void> {
    this.globalStorageId = await this.requireDep('Storage');
    this.globalRegistryId = await this.requireDep('Registry');
    this.factoryId = await this.requireDep('Factory');
    this.supervisorId = await this.discoverDep('Supervisor') ?? undefined;
    this.workspaceSwitcherId = await this.discoverDep('WorkspaceSwitcher') ?? undefined;
    this.globalToolbarId = await this.discoverDep('GlobalToolbar') ?? undefined;
    this.sidebarId = await this.discoverDep('Sidebar') ?? undefined;
    this.uiServerId = await this.discoverDep('UIServer') ?? undefined;
    this.widgetManagerId = await this.discoverDep('WidgetManager') ?? undefined;
    this.windowManagerId = await this.discoverDep('WindowManager') ?? undefined;

    // Re-measure the sidebar dock when a frontend client (re)connects: the
    // dock is sized to the display, and display info is only live once a
    // client is ready (a dock built before that uses a stale default size).
    if (this.uiServerId) {
      this.send(request(this.id, this.uiServerId, 'addDependent', {}));
    }
  }

  /**
   * Boot workspaces — must be called after spawn completes.
   * This cannot run during onInit because Factory would deadlock.
   */
  private async boot(): Promise<boolean> {
    const log = new Log('WORKSPACE-BOOT');

    // Discover peerId from IdentityObject for scoped TypeIds
    try {
      const identityId = await this.discoverDep('Identity');
      if (identityId) {
        const identity = await this.request<{ peerId: string }>(
          request(this.id, identityId, 'getIdentity', {})
        );
        this.peerId = identity.peerId;
      }
    } catch {
      wsLog.warn('Could not discover peerId from IdentityObject');
    }
    log.timed('identity resolved');

    const persisted = await this.loadWorkspaceList();
    log.timed(`workspace list loaded (${persisted.length} workspaces)`);

    if (persisted.length === 0) {
      // First boot — create "Default" workspace and migrate existing data
      const { workspaceId } = await this.createWorkspace('Default');
      log.timed('created Default workspace');
      await this.migrateExistingData(workspaceId);
      log.timed('migrated existing data');
      await this.switchWorkspace(workspaceId);
      log.timed('switched to Default workspace');
    } else {
      // Load active workspace ID BEFORE restoring so we know which one to fully spawn
      const activeId = await this.loadActiveWorkspaceId();
      const targetId = activeId && persisted.some(ws => ws.id === activeId) ? activeId : persisted[0].id;

      // Restore active workspace first with FULL spawn (infra + UI)
      const activeWs = persisted.find(ws => ws.id === targetId)!;
      await this.restoreWorkspace(activeWs.id, activeWs.name, normalizeAccessMode(activeWs.accessMode),
        activeWs.whitelist ?? [], activeWs.exposedTypeIds ?? [], activeWs.description ?? '',
        activeWs.tags ?? [], true);
      log.timed(`active workspace '${activeWs.name}' restored`);

      // Switch to active workspace immediately — UI is ready
      await this.switchWorkspace(targetId);
      log.timed('switchWorkspace done');

      // Restore remaining workspaces in the background — don't block boot.
      // This lets the server start accepting connections immediately.
      const remaining = persisted.filter(ws => ws.id !== targetId);
      if (remaining.length > 0) {
        void this.restoreRemainingWorkspaces(remaining);
      }
    }

    log.summary();
    return true;
  }

  /**
   * Restore inactive workspaces in the background after boot completes.
   */
  private async restoreRemainingWorkspaces(workspaces: PersistedWorkspace[]): Promise<void> {
    for (const ws of workspaces) {
      try {
        await this.restoreWorkspace(ws.id, ws.name, normalizeAccessMode(ws.accessMode), ws.whitelist ?? [],
          ws.exposedTypeIds ?? [], ws.description ?? '', ws.tags ?? [], false);
      } catch (err) {
        wsLog.warn(`Failed to restore workspace '${ws.name}':`, err);
      }
    }
    // Refresh the switcher now that all workspaces are available
    await this.refreshTaskbar();
  }

  // ── Workspace Lifecycle ──

  async createWorkspace(name: string): Promise<{ workspaceId: string }> {
    precondition(name !== '', 'workspace name must not be empty');

    const workspaceId = uuidv4();
    const info = await this.spawnWorkspaceObjects(workspaceId, name);
    this.workspaces.set(workspaceId, info);

    await this.persistWorkspaceList();

    wsLog.info(`Created workspace '${name}' (${workspaceId})`);
    return { workspaceId };
  }

  async deleteWorkspace(workspaceId: string): Promise<boolean> {
    precondition(this.workspaces.size > 1, 'Cannot delete the last workspace');
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return false;

    // If deleting the active workspace, switch to another first
    if (this.activeWorkspaceId === workspaceId) {
      const otherId = [...this.workspaces.keys()].find((id) => id !== workspaceId);
      if (otherId) await this.switchWorkspace(otherId);
    }

    // Remove and persist BEFORE tearing down children: the removal has to reach
    // storage even if a teardown step throws, or the workspace comes back on the
    // next load while the caller was told the delete succeeded.
    this.workspaces.delete(workspaceId);
    await this.persistWorkspaceList();

    // Never leave the active pointer on a workspace that no longer exists.
    // `workspaces:active` is read back on the next boot, and a dangling id
    // there is precisely what lands refreshTaskbar with no local record. The
    // switchWorkspace above normally moves it; this catches the case where it
    // did not (no other workspace, or the switch failed).
    if (this.activeWorkspaceId === workspaceId) {
      this.activeWorkspaceId = [...this.workspaces.keys()][0];
      await this.persistActiveWorkspaceId();
    }

    // Unregister this workspace's Taskbar from WindowManager
    if (this.windowManagerId) {
      try {
        await this.request(request(this.id, this.windowManagerId,
          'unregisterTaskbar', { workspaceId }));
      } catch { /* WindowManager may be gone */ }
    }

    // Hide workspace taskbar
    if (ws.taskbarId) {
      try {
        await this.request(request(this.id, ws.taskbarId, 'hide', {}));
      } catch { /* may already be hidden */ }
    }

    // Kill all per-workspace objects (in reverse order) — but only objects this
    // workspace actually owns. childIds can be contaminated with ids that are not
    // ours (the workspace registry's `list` unions local + global by design), and
    // killing one of those stops the system objects — this manager included —
    // halfway through the delete.
    const protectedIds = new Set<AbjectId>();
    for (const gid of [this.id, this.factoryId, this.globalRegistryId, this.globalStorageId,
      this.supervisorId, this.uiServerId, this.widgetManagerId, this.windowManagerId,
      this.workspaceSwitcherId, this.globalToolbarId, this.sidebarId]) {
      if (gid) protectedIds.add(gid);
    }
    for (const [otherId, other] of this.workspaces) {
      if (otherId === workspaceId) continue;
      protectedIds.add(other.registryId);
      for (const cid of other.childIds) protectedIds.add(cid);
    }

    for (const childId of [...ws.childIds].reverse()) {
      if (protectedIds.has(childId)) {
        wsLog.warn(`Refusing to kill non-workspace object ${childId} while deleting '${ws.name}'`);
        continue;
      }
      try {
        await this.request(
          request(this.id, this.factoryId!, 'kill', { objectId: childId })
        );
      } catch { /* may already be dead */ }
    }

    // Unregister workspace registry from global registry
    try {
      await this.request(
        request(this.id, this.globalRegistryId!, 'unregister', { objectId: ws.registryId })
      );
    } catch { /* already gone */ }

    // Delete the workspace's IndexedDB database
    if (typeof indexedDB !== 'undefined') {
      try {
        indexedDB.deleteDatabase(`abjects-storage-${workspaceId}`);
      } catch { /* best effort */ }
    }

    // Ask WorkspaceShareRegistry to forget any joined entry for this
    // workspace. Left behind, it keeps feeding the remote shim:
    // getJoinedWorkspaces still reports the workspace, so refreshTaskbar
    // re-appends a switcher button for a workspace that is gone locally.
    await this.dropShareRegistryEntry(workspaceId);

    // Rebuild switcher/taskbar with the updated workspace list (the earlier
    // refreshTaskbar inside switchWorkspace ran before the workspace was removed).
    await this.refreshTaskbar();

    wsLog.info(`Deleted workspace '${ws.name}' (${workspaceId})`);
    return true;
  }

  /**
   * A worker thread died and `lost` are the objects it hosted. A workspace
   * that lost any part of itself (its registry, storage, or one of its
   * per-workspace objects) is rebuilt whole: the survivors are stopped, the
   * same set of objects is spawned again under the same workspace id, the
   * user objects come back from the workspace's snapshots, and the goals
   * that were running are failed with the reason. Workspaces that only lost
   * user objects get those objects restored from their snapshots.
   */
  private async recoverLostObjects(lost: Set<AbjectId>, reason: string): Promise<{
    workspaces: Array<{ workspaceId: string; name: string; lost: number; restored: number; goalsFailed: number }>;
  }> {
    const report: Array<{ workspaceId: string; name: string; lost: number; restored: number; goalsFailed: number }> = [];
    if (lost.size === 0 || !this.factoryId) return { workspaces: report };
    const childNamed = (ws: WorkspaceInfo, name: string): AbjectId | undefined => {
      for (const [id, typeId] of ws.childTypeIds) if (String(typeId).split('/').pop() === name) return id;
      return undefined;
    };

    for (const [workspaceId, ws] of [...this.workspaces]) {
      const hit = [ws.registryId, ws.storageId, ...ws.childIds].filter((id): id is AbjectId => !!id && lost.has(id));
      const wsLog = new Log(`WS-RECOVER:${ws.name}`);
      if (hit.length === 0) {
        // Only user objects can have died here; the store knows which.
        const storeId = childNamed(ws, 'AbjectStore');
        if (!storeId) continue;
        try {
          const r = await this.request<{ restored: number }>(request(this.id, storeId, 'restoreLost', { objectIds: [...lost] }), 300_000);
          if (r?.restored) {
            wsLog.info(`restored ${r.restored} user object(s) from snapshots`);
            report.push({ workspaceId, name: ws.name, lost: r.restored, restored: r.restored, goalsFailed: 0 });
          }
        } catch (err) { wsLog.warn(`restoreLost failed: ${err instanceof Error ? err.message : String(err)}`); }
        continue;
      }

      wsLog.warn(`${hit.length} of this workspace's objects died with a worker; rebuilding the workspace`);
      // Survivors are stopped so the rebuilt workspace has one of everything.
      for (const childId of [...ws.childIds].reverse()) {
        if (lost.has(childId)) continue;
        try { await this.request(request(this.id, this.factoryId, 'kill', { objectId: childId, keepSnapshot: true }), 15_000); } catch { /* may already be gone */ }
      }
      if (this.globalRegistryId) {
        try { await this.request(request(this.id, this.globalRegistryId, 'unregister', { objectId: ws.registryId })); } catch { /* already gone */ }
      }

      const objects = ws.uiSpawned ? PER_WORKSPACE_OBJECTS : INFRA_OBJECTS;
      const info = await this.spawnWorkspaceObjects(workspaceId, ws.name, objects);
      info.accessMode = ws.accessMode;
      info.whitelist = ws.whitelist;
      info.description = ws.description;
      info.tags = ws.tags;
      info.curated = ws.curated;
      info.exposedTypeIds = ws.exposedTypeIds;
      // Object ids are new; the durable exposure list is by typeId.
      info.exposedObjectIds = [...info.childTypeIds].filter(([, t]) => ws.exposedTypeIds.includes(t)).map(([id]) => id);
      if (info.accessMode !== 'local' && !info.exposedObjectIds.includes(info.registryId)) info.exposedObjectIds.push(info.registryId);
      info.joined = ws.joined;
      info.ownerPeerId = ws.ownerPeerId;
      info.participants = ws.participants;
      this.workspaces.set(workspaceId, info);
      await this.syncExposedToRegistry(info);

      // The spawn above already restored the workspace's snapshots (it does
      // so for every workspace it brings up); count what came back.
      let restored = 0;
      const storeId = childNamed(info, 'AbjectStore');
      if (storeId) {
        try {
          const snaps = await this.request<unknown[]>(request(this.id, storeId, 'list', {}), 30_000);
          restored = Array.isArray(snaps) ? snaps.length : 0;
        } catch (err) { wsLog.warn(`could not count restored snapshots: ${err instanceof Error ? err.message : String(err)}`); }
      }

      let goalsFailed = 0;
      const goalManagerId = childNamed(info, 'GoalManager');
      if (goalManagerId) {
        try {
          const r = await this.request<{ failed: number }>(request(this.id, goalManagerId, 'failActiveGoals', { reason }), 60_000);
          goalsFailed = r?.failed ?? 0;
        } catch (err) { wsLog.warn(`could not fail running goals: ${err instanceof Error ? err.message : String(err)}`); }
      }

      wsLog.info(`rebuilt: ${info.childIds.length} objects, ${restored} restored from snapshots, ${goalsFailed} goal(s) failed`);
      this.changed('workspaceObjectsChanged', { workspaceId });
      report.push({ workspaceId, name: ws.name, lost: hit.length, restored, goalsFailed });
    }

    if (report.length > 0) {
      try { await this.refreshTaskbar(); } catch { /* best effort */ }
    }
    return { workspaces: report };
  }

  async switchWorkspace(workspaceId: string): Promise<boolean> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) {
      // Check if this is a joined remote workspace
      if (!this.workspaceShareRegistryId) {
        this.workspaceShareRegistryId = await this.discoverDep('WorkspaceShareRegistry') ?? undefined;
      }
      if (this.workspaceShareRegistryId) {
        try {
          const joined = await this.request<Array<{ workspaceId: string; ownerPeerId: string }>>(
            request(this.id, this.workspaceShareRegistryId, 'getJoinedWorkspaces', {})
          );
          if (joined && joined.some(j => j.workspaceId === workspaceId)) {
            this.activeWorkspaceId = workspaceId;
            if (this.uiServerId) {
              await this.request(request(this.id, this.uiServerId, 'setActiveWorkspace', { workspaceId }));
            }
            if (this.widgetManagerId) {
              try {
                await this.request(request(this.id, this.widgetManagerId, 'setActiveWorkspace', { workspaceId }));
              } catch { /* WidgetManager may not be ready */ }
            }
            await this.persistActiveWorkspaceId();
            await this.refreshTaskbar();
            wsLog.info(`Switched to joined remote workspace (${workspaceId})`);
            return true;
          }
        } catch { /* best effort */ }
      }
      return false;
    }

    // Lazy-spawn UI objects on first switch to a deferred workspace
    if (!ws.uiSpawned) {
      await this.spawnUIObjects(workspaceId);
    }

    this.activeWorkspaceId = workspaceId;

    // Instant switch: change the compositor filter (no hide/show messages needed)
    if (this.uiServerId) {
      await this.request(request(this.id, this.uiServerId, 'setActiveWorkspace', { workspaceId }));
    }

    // Tell WidgetManager so it can re-skin system-level UI (workspace switcher,
    // global toolbar, taskbar) with the new workspace's theme.
    if (this.widgetManagerId) {
      try {
        await this.request(request(this.id, this.widgetManagerId, 'setActiveWorkspace', { workspaceId }));
      } catch { /* WidgetManager may not be ready */ }
    }

    await this.persistActiveWorkspaceId();

    // Reposition all panels (GlobalToolbar → WorkspaceSwitcher → Taskbar)
    // This also refreshes WorkspaceSwitcher with current workspace data.
    await this.refreshTaskbar();

    wsLog.info(`Switched to workspace '${ws.name}' (${workspaceId})`);
    return true;
  }

  /**
   * Rebuild the sidebar dock and re-populate its sections (System, Spaces,
   * Abjects). Called on startup, workspace switch, workspace create, and
   * whenever a section provider asks for a refresh.
   */
  private async refreshTaskbar(): Promise<boolean> {
    if (!this.activeWorkspaceId) return false;
    const ws = this.workspaces.get(this.activeWorkspaceId);

    // Resolve the active workspace's theme once and push it into the sidebar
    // and each section provider's show() so they rebuild with the correct
    // palette. The sidebar and global providers are outside any workspace, so
    // they can't resolve the active theme themselves reliably; pushing it here
    // is deterministic and runs on both startup and every workspace switch
    // (both flow through refreshTaskbar).
    let activeTheme: ThemeData | undefined;
    if (this.widgetManagerId) {
      try {
        activeTheme = await this.request<ThemeData>(
          request(this.id, this.widgetManagerId, 'getActiveTheme', {}));
      } catch { /* WidgetManager not ready — toolbars fall back to cached theme */ }
    }

    // Lazy-discover the sidebar (spawn-order race on first boot).
    if (!this.sidebarId) {
      this.sidebarId = await this.discoverDep('Sidebar') ?? undefined;
    }
    if (!this.sidebarId) return false;

    // Rebuild the dock window, then push the fresh section layout IDs into
    // each provider. Section order: System → Spaces → Abjects.
    type SidebarSections = { windowId: AbjectId; system: AbjectId; spaces: AbjectId; abjects: AbjectId; compact: boolean };
    let sections: SidebarSections | null = null;
    try {
      await this.request(request(this.id, this.sidebarId, 'show', { theme: activeTheme }));
      sections = await this.request<SidebarSections | null>(
        request(this.id, this.sidebarId, 'getSections', {}));
    } catch (err) {
      wsLog.warn('Failed to rebuild sidebar:', err);
    }
    if (!sections) return false;

    // Tell WindowManager the reserved dock width so maximized windows re-fit
    // when the sidebar toggles between compact and full width.
    if (this.windowManagerId) {
      this.send(event(this.id, this.windowManagerId, 'workAreaChanged', {
        left: sections.compact ? SIDEBAR_COMPACT_WIDTH : SIDEBAR_WIDTH,
      }));
    }

    if (this.globalToolbarId) {
      try {
        await this.request(request(this.id, this.globalToolbarId, 'show', {
          theme: activeTheme,
          windowId: sections.windowId,
          sectionLayoutId: sections.system,
          compact: sections.compact,
        }));
      } catch { /* toolbar not ready */ }
    }

    if (this.workspaceSwitcherId) {
      try {
        if (!this.workspaceShareRegistryId) {
          this.workspaceShareRegistryId = await this.discoverDep('WorkspaceShareRegistry') ?? undefined;
        }
        let joinedWorkspaces: Array<{ workspaceId: string; name?: string; ownerPeerId: string; registryId?: string }> = [];
        if (this.workspaceShareRegistryId) {
          try {
            joinedWorkspaces = await this.request<Array<{ workspaceId: string; name?: string; ownerPeerId: string; registryId?: string }>>(
              request(this.id, this.workspaceShareRegistryId, 'getJoinedWorkspaces', {})
            ) ?? [];
          } catch { /* best-effort */ }
        }
        // Joined workspaces are materialized as first-class local records
        // (materializeJoinedWorkspace / restoreWorkspace), so listWorkspaces()
        // already contains them. Dedupe by workspace id, preferring the local
        // record so the switcher uses its registryId/taskbarId/ownerPeerId
        // metadata; only append joined entries that have no local record yet.
        // Without this, a joined workspace rendered two identical buttons.
        // `joined` rides along so the switcher can render a joined workspace as
        // shared even though it keeps `accessMode: 'local'` by invariant.
        // Annotating this narrower than listWorkspaces() would strip the field.
        const allWorkspaces: Array<{ id: string; name: string; accessMode: WorkspaceAccessMode; joined?: boolean }> =
          this.listWorkspaces();
        const seenWorkspaceIds = new Set(allWorkspaces.map(w => w.id));
        for (const jw of joinedWorkspaces) {
          if (seenWorkspaceIds.has(jw.workspaceId)) continue;
          seenWorkspaceIds.add(jw.workspaceId);
          // Only workspaces with no local record reach here (see dedupe above),
          // so every one of these is joined rather than hosted by us.
          allWorkspaces.push({
            id: jw.workspaceId,
            name: jw.name || `Remote: ${jw.workspaceId.slice(0, 8)}`,
            accessMode: 'shared' as WorkspaceAccessMode,
            joined: true,
          });
        }

        // Find the active workspace's Settings ID for the gear button
        const settingsEntry = ws?.uiObjects.find(o => o.iface === SETTINGS_INTERFACE);
        await this.request(request(this.id, this.workspaceSwitcherId,
          'show', {
            workspaces: allWorkspaces,
            activeWorkspaceId: this.activeWorkspaceId,
            settingsId: settingsEntry?.id,
            theme: activeTheme,
            windowId: sections.windowId,
            sectionLayoutId: sections.spaces,
            compact: sections.compact,
          }));
      } catch { /* use default */ }
    }

    // A joined or newly restored workspace owns its Taskbar, spawned lazily on
    // first switch. Never borrow another workspace's Taskbar to stand in for
    // it — that is what rendered the local Default workspace's rows for a
    // shared workspace. Fall back only when there is no active record at all.
    let taskbarId: AbjectId | undefined = ws?.taskbarId || undefined;
    if (!taskbarId) {
      if (ws) {
        if (!ws.uiSpawned) {
          await this.spawnUIObjects(ws.id);
          taskbarId = this.workspaces.get(ws.id)?.taskbarId || undefined;
        }
        if (!taskbarId) {
          wsLog.warn(`refreshTaskbar: workspace '${ws.name}' (${ws.id}) has no Taskbar of its own; skipping rather than showing another workspace's`);
        }
      } else {
        // No local record for the active workspace at all. Borrowing whichever
        // workspace happens to own a Taskbar (in practice Default's) is exactly
        // what rendered Default's rows under a shared workspace: the Abjects
        // section then lists objects that belong to a different workspace.
        // Render nothing rather than the wrong workspace's contents.
        wsLog.warn(`refreshTaskbar: no local record for active workspace '${this.activeWorkspaceId}'; leaving the Abjects section empty rather than borrowing another workspace's Taskbar`);
      }
    }
    if (taskbarId) {
      try {
        await this.request(request(this.id, taskbarId, 'show', {
          theme: activeTheme,
          windowId: sections.windowId,
          sectionLayoutId: sections.abjects,
          compact: sections.compact,
        }));
      } catch (err) {
        wsLog.warn('Failed to refresh taskbar:', err);
      }
    }

    return true;
  }

  listWorkspaces(): Array<{
    id: string;
    name: string;
    accessMode: WorkspaceAccessMode;
    joined?: boolean;
    ownerPeerId?: string;
  }> {
    // Joined records deliberately keep `accessMode: 'local'` so restart recovery
    // never re-advertises a peer's workspace as one we host. That makes access
    // mode alone misleading for presentation, so carry `joined` through as well:
    // a caller rendering a workspace has to tell a mirror from one we own.
    return [...this.workspaces.entries()].map(([id, ws]) => ({
      id,
      name: ws.name,
      accessMode: ws.accessMode,
      joined: ws.joined,
      ownerPeerId: ws.ownerPeerId,
    }));
  }

  getActiveWorkspace(): {
    id: string;
    name: string;
    registryId: string;
    accessMode: WorkspaceAccessMode;
    whitelist: string[];
    participants: string[];
    joined?: boolean;
    ownerPeerId?: string;
  } | null {
    if (!this.activeWorkspaceId) return null;
    // Joined workspaces are materialized into `this.workspaces`, so this
    // resolves their own dedicated record and registry — never Default's.
    const ws = this.workspaces.get(this.activeWorkspaceId);
    if (!ws) {
      wsLog.warn(`getActiveWorkspace: no local record for active workspace '${this.activeWorkspaceId}'`);
      return null;
    }
    return {
      id: this.activeWorkspaceId,
      name: ws.name,
      registryId: ws.registryId,
      accessMode: ws.accessMode,
      whitelist: [...ws.whitelist],
      participants: [...(ws.participants ?? [])],
      joined: ws.joined,
      ownerPeerId: ws.ownerPeerId,
    };
  }

  async renameWorkspace(workspaceId: string, name: string): Promise<boolean> {
    precondition(name !== '', 'name must not be empty');
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return false;
    ws.name = name;
    await this.persistWorkspaceList();
    return true;
  }

  getAccessMode(workspaceId: string): WorkspaceAccessMode {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return 'local';
    return ws.accessMode;
  }

  async setAccessMode(workspaceId: string, accessMode: WorkspaceAccessMode): Promise<boolean> {
    precondition(
      accessMode === 'local' || accessMode === 'shared' || accessMode === 'public',
      'accessMode must be local, shared, or public',
    );
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return false;
    const prevMode = ws.accessMode;
    ws.accessMode = accessMode;

    // Ensure registry and SharedState are always exposed when workspace is shared.
    // This is an infrastructure seed, not a curation choice: `curated` stays
    // false here so the workspace goes on offering every shareable object.
    if (accessMode !== 'local' && ws.exposedObjectIds.length === 0) {
      ws.exposedObjectIds = [ws.registryId];
      const regTypeId = ws.childTypeIds.get(ws.registryId);
      ws.exposedTypeIds = regTypeId ? [regTypeId] : [];
    }
    if (accessMode !== 'local') {
      await this.ensureSharedStateExposed(ws);
    }

    await this.syncExposedToRegistry(ws);
    await this.persistWorkspaceList();

    // Notify SharedState of the new access mode
    await this.dispatchAccessMode(ws);

    // Emit access change event for PeerRouter cache invalidation
    this.changed('workspaceAccessChanged', {
      workspaceId, accessMode, whitelist: ws.whitelist,
      exposedObjectIds: ws.exposedObjectIds,
    });

    // Emit sharing events for dependents
    if (accessMode !== 'local' && prevMode === 'local') {
      this.changed('workspaceShared', {
        workspaceId, name: ws.name, description: ws.description, tags: ws.tags,
        accessMode, whitelist: ws.whitelist, exposedObjectIds: ws.exposedObjectIds,
        registryId: ws.registryId,
      });
    } else if (accessMode === 'local' && prevMode !== 'local') {
      this.changed('workspaceUnshared', { workspaceId, name: ws.name });
    } else if (accessMode !== 'local') {
      // Mode changed between private/public
      this.changed('workspaceShared', {
        workspaceId, name: ws.name, description: ws.description, tags: ws.tags,
        accessMode, whitelist: ws.whitelist, exposedObjectIds: ws.exposedObjectIds,
        registryId: ws.registryId,
      });
    }

    return true;
  }

  getWhitelist(workspaceId: string): string[] {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return [];
    return [...ws.whitelist];
  }

  async setWhitelist(workspaceId: string, whitelist: string[]): Promise<boolean> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return false;
    ws.whitelist = [...whitelist];
    await this.persistWorkspaceList();

    // Emit access change event for PeerRouter cache invalidation
    this.changed('workspaceAccessChanged', {
      workspaceId, accessMode: ws.accessMode, whitelist: ws.whitelist,
      exposedObjectIds: ws.exposedObjectIds,
    });

    // Notify SharedState of the new whitelist so shared-mode outbound sync
    // targets stay in step with the whitelist (a change while already shared
    // would otherwise leave SharedState broadcasting to a stale peer set).
    const access = this.participationAccess(ws);
    if (access.accessMode === 'shared') {
      await this.dispatchAccessMode(ws);
    }

    return true;
  }

  getExposedObjects(workspaceId: string): AbjectId[] {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return [];
    return [...ws.exposedObjectIds];
  }

  async setExposedObjects(workspaceId: string, objectIds: AbjectId[]): Promise<boolean> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return false;
    // An explicit list is what makes a workspace curated; an empty list means
    // "share everything again" and clears curation. The registry entry added
    // just below is infrastructure and never counts as curation by itself.
    ws.curated = objectIds.length > 0;
    // Always include workspace registry when workspace is shared
    if (ws.accessMode !== 'local' && !objectIds.includes(ws.registryId)) {
      objectIds = [ws.registryId, ...objectIds];
    }
    ws.exposedObjectIds = [...objectIds];
    // Compute corresponding typeIds for durable persistence
    ws.exposedTypeIds = objectIds
      .map(id => ws.childTypeIds.get(id))
      .filter((t): t is TypeId => t !== undefined);
    await this.syncExposedToRegistry(ws);
    await this.persistWorkspaceList();

    this.changed('workspaceAccessChanged', {
      workspaceId, accessMode: ws.accessMode, whitelist: ws.whitelist,
      exposedObjectIds: ws.exposedObjectIds,
    });

    return true;
  }

  getDescription(workspaceId: string): string {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return '';
    return ws.description;
  }

  async setDescription(workspaceId: string, description: string): Promise<boolean> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return false;
    ws.description = description;
    await this.persistWorkspaceList();
    this.changed('workspaceMetadataChanged', { workspaceId, description, tags: ws.tags });
    return true;
  }

  getTags(workspaceId: string): string[] {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return [];
    return [...ws.tags];
  }

  async setTags(workspaceId: string, tags: string[]): Promise<boolean> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return false;
    ws.tags = [...tags];
    await this.persistWorkspaceList();
    this.changed('workspaceMetadataChanged', { workspaceId, description: ws.description, tags: ws.tags });
    return true;
  }

  /**
   * Workspaces this instance joined from a peer, as first-class local records.
   *
   * A joined workspace is materialized as an ordinary local record — we do not
   * host it, so it is never re-advertised as shared — which means it does not
   * appear in `listSharedWorkspaces`. WorkspaceShareRegistry needs it after a
   * restart to re-establish the catalog mirror for a restored workspace.
   */
  listJoinedWorkspaces(): Array<{ workspaceId: string; name: string; ownerPeerId?: string; registryId?: string }> {
    const result: Array<{ workspaceId: string; name: string; ownerPeerId?: string; registryId?: string }> = [];
    for (const [, ws] of this.workspaces) {
      if (!ws.joined) continue;
      result.push({
        workspaceId: ws.id,
        name: ws.name,
        ownerPeerId: ws.ownerPeerId,
        registryId: ws.registryId,
      });
    }
    return result;
  }

  listSharedWorkspaces(): SharedWorkspaceInfo[] {
    const result: SharedWorkspaceInfo[] = [];
    for (const [, ws] of this.workspaces) {
      if (ws.accessMode !== 'local') {
        result.push({
          workspaceId: ws.id,
          exposedTypeIds: ws.exposedTypeIds ? [...ws.exposedTypeIds] : undefined,
          curated: ws.curated === true,
          name: ws.name,
          description: ws.description,
          tags: [...ws.tags],
          accessMode: ws.accessMode,
          whitelist: ws.accessMode === 'shared' ? [...ws.whitelist] : undefined,
          exposedObjectIds: [...ws.exposedObjectIds],
          registryId: ws.registryId,
        });
      }
    }
    return result;
  }

  /**
   * Find the workspace that contains a given object and return its access info.
   */
  findWorkspaceForObject(objectId: AbjectId): {
    workspaceId: string;
    name: string;
    accessMode: WorkspaceAccessMode;
    whitelist: string[];
    exposedObjectIds: AbjectId[];
    /** P2-3: true when a public workspace has never been curated. */
    uncuratedPublic?: boolean;
    /** True for a mirror of a remote peer's workspace (never advertised). */
    joined?: boolean;
  } | null {
    for (const [, ws] of this.workspaces) {
      if (ws.registryId === objectId || ws.childIds.includes(objectId)) {
        const exposed = this.effectiveExposedIds(ws);
        // PeerRouter gates inbound messages on this, so it reports
        // PARTICIPATION access: a joined mirror answers 'shared' +
        // owner/participants here, while still answering 'local' to
        // listWorkspacesDetailed so it is never announced as a route.
        const access = this.participationAccess(ws);
        return {
          workspaceId: ws.id,
          name: ws.name,
          accessMode: access.accessMode,
          whitelist: access.whitelist,
          exposedObjectIds: exposed,
          // P2-3: public but never curated → registry-plus-nothing.
          uncuratedPublic: ws.accessMode === 'public' && ws.curated !== true,
          joined: ws.joined === true,
        };
      }
    }
    return null;
  }

  /**
   * Fast lookup: find which workspace contains a given object by ID.
   * Returns workspaceId and workspaceName, or null if not found.
   */
  getWorkspaceForObject(objectId: AbjectId): { workspaceId: string; workspaceName: string } | null {
    for (const [, ws] of this.workspaces) {
      if (ws.registryId === objectId || ws.childIds.includes(objectId)) {
        return { workspaceId: ws.id, workspaceName: ws.name };
      }
    }
    return null;
  }

  /**
   * List all workspaces with full details including child IDs and access mode.
   * Used by PeerRouter for route propagation.
   */
  listWorkspacesDetailed(): Array<{
    workspaceId: string;
    name: string;
    accessMode: WorkspaceAccessMode;
    whitelist: string[];
    exposedObjectIds: AbjectId[];
    childIds: AbjectId[];
    registryId: AbjectId;
    /**
     * P2-3: public workspace the user never curated. Nothing but the registry
     * is published; the Settings sharing/Access UI shows a notice for this.
     */
    uncuratedPublic?: boolean;
    /**
     * Mirror of a remote peer's workspace. This view is the ROUTE-ANNOUNCEMENT
     * view, so it keeps reporting the hosting `accessMode` ('local' for a
     * mirror); the flag lets PeerRouter refuse to advertise it outright rather
     * than relying on that mode alone.
     */
    joined?: boolean;
  }> {
    return [...this.workspaces.entries()].map(([, ws]) => ({
      workspaceId: ws.id,
      name: ws.name,
      accessMode: ws.accessMode,
      whitelist: [...ws.whitelist],
      exposedObjectIds: this.effectiveExposedIds(ws),
      childIds: [...ws.childIds],
      registryId: ws.registryId,
      uncuratedPublic: ws.accessMode === 'public' && ws.curated !== true,
      joined: ws.joined === true,
    }));
  }

  // ── Internal Helpers ──

  /**
   * Spawn only UI objects into an existing workspace that was initially
   * created with infra-only objects. Reuses the same per-object post-spawn
   * setup (Taskbar registration, Theme registration, uiObjects tracking).
   */
  // ═══════════════════════════════════════════════════════════════════
  // Invite / join link handling
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Build a shareable invite link for a workspace we host.
   *
   * Shape: abject://join?peer=<ownerPeerId>&ws=<workspaceId>&mode=<accessMode>
   *                     &reg=<registryId>&name=<name>
   *
   * The fields mirror exactly what WorkspaceShareRegistry.addWorkspaceFromRoute
   * consumes. `name` is carried as an extra because a route alone cannot supply
   * one — addWorkspaceFromRoute falls back to using the workspaceId as the name.
   */
  async createInviteLink(workspaceId: string): Promise<string> {
    precondition(!!workspaceId, 'createInviteLink: workspaceId is required');

    let ownerPeerId = '';
    try {
      const identityId = await this.discoverDep('Identity');
      if (identityId) {
        const identity = await this.request<Record<string, unknown>>(
          request(this.id, identityId, 'getIdentity', {})
        );
        const pid = identity?.['peerId'] ?? identity?.['id'];
        if (typeof pid === 'string') ownerPeerId = pid;
      }
    } catch {
      /* Identity not available — link is still usable if the peer is known */
    }

    let accessMode = 'public';
    let registryId = '';
    let name = workspaceId;

    if (!this.workspaceShareRegistryId) {
      this.workspaceShareRegistryId = (await this.discoverDep('WorkspaceShareRegistry')) ?? undefined;
    }
    if (this.workspaceShareRegistryId) {
      try {
        const shared = await this.request<Array<Record<string, unknown>>>(
          request(this.id, this.workspaceShareRegistryId, 'getSharedWorkspaces', {})
        );
        const match = (shared ?? []).find(s => s['workspaceId'] === workspaceId);
        if (match) {
          if (typeof match['accessMode'] === 'string') accessMode = match['accessMode'] as string;
          if (typeof match['registryId'] === 'string') registryId = match['registryId'] as string;
          if (typeof match['name'] === 'string') name = match['name'] as string;
        }
      } catch {
        /* not shared yet — the caller may still want a link */
      }
    }

    const params = new URLSearchParams();
    params.set('peer', ownerPeerId);
    params.set('ws', workspaceId);
    params.set('mode', accessMode);
    if (registryId) params.set('reg', registryId);
    if (name) params.set('name', name);

    return `abject://join?${params.toString()}`;
  }

  /**
   * Join a shared workspace from an invite link: register the route so the
   * workspace is discoverable, then request the actual join.
   */
  async joinFromInviteLink(link: string): Promise<boolean> {
    const route = parseInviteLink(link);
    if (!route) return false;

    if (!this.workspaceShareRegistryId) {
      this.workspaceShareRegistryId = (await this.discoverDep('WorkspaceShareRegistry')) ?? undefined;
    }
    if (!this.workspaceShareRegistryId) return false;

    try {
      await this.request(
        request(this.id, this.workspaceShareRegistryId, 'addWorkspaceFromRoute', {
          ownerPeerId: route.ownerPeerId,
          workspaceId: route.workspaceId,
          accessMode: route.accessMode,
          registryId: route.registryId,
          hops: 0,
        })
      );
    } catch {
      /* route may already be known via discovery */
    }

    let accepted = false;
    try {
      const ack = await this.request<{ accepted?: boolean }>(
        request(this.id, this.workspaceShareRegistryId, 'joinWorkspace', {
          peerId: route.ownerPeerId,
          workspaceId: route.workspaceId,
        })
      );
      accepted = !!(ack && ack.accepted);
    } catch {
      accepted = false;
    }

    if (accepted) {
      this.changed('joinedWorkspace', route.workspaceId);
      try {
        await this.refreshTaskbar();
      } catch {
        /* taskbar refresh is best effort */
      }
    }

    return accepted;
  }

  private async spawnUIObjects(workspaceId: string): Promise<void> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws || ws.uiSpawned) return;
    ws.uiSpawned = true;  // Set early to prevent re-entry during concurrent switches

    const uiIfaceMap: Record<string, InterfaceId> = {
      Settings: SETTINGS_INTERFACE,
      AppExplorer: APP_EXPLORER_INTERFACE,
      GoalBrowser: GOAL_BROWSER_INTERFACE,
      JobBrowser: JOB_BROWSER_INTERFACE,
      ChatBrowser: CHAT_BROWSER_INTERFACE,
    };

    for (const objName of UI_OBJECTS) {
      const typeId = this.computeTypeId(workspaceId, objName);
      let result: SpawnResult;
      try {
        result = await this.request<SpawnResult>(
          request(this.id, this.factoryId!, 'spawn', {
            manifest: { name: objName, description: '', version: '1.0.0',
              requiredCapabilities: [], tags: ['system'] },
            registryHint: ws.registryId,
            typeId,
          })
        );
      } catch {
        continue;
      }

      const objId = result.objectId;
      ws.childIds.push(objId);
      if (typeId) ws.childTypeIds.set(objId, typeId);

      if (objName === 'Taskbar') {
        ws.taskbarId = objId;
        if (this.windowManagerId) {
          try {
            await this.request(request(this.id, this.windowManagerId,
              'registerTaskbar', { taskbarId: objId, workspaceId }));
          } catch { /* WindowManager may not be ready */ }
        }
      }

      if (uiIfaceMap[objName]) {
        ws.uiObjects.push({ id: objId, iface: uiIfaceMap[objName] });
      }

      if (this.widgetManagerId) {
        try {
          await this.request(request(this.id, this.widgetManagerId, 'setObjectWorkspace', {
            objectId: objId, workspaceId,
          }));
        } catch { /* WidgetManager may not be ready */ }
      }
    }

    wsLog.info(`Spawned deferred UI objects for workspace '${ws.name}' (${workspaceId})`);
  }

  /**
   * Compute a scoped TypeId: {peerId}/{workspaceId}/{objectName}
   * Returns undefined if peerId is not yet known.
   */
  private computeTypeId(workspaceId: string, objectName: string): TypeId | undefined {
    if (!this.peerId) return undefined;
    return `${this.peerId}/${workspaceId}/${objectName}` as TypeId;
  }

  /**
   * Spawn all objects for a workspace: WorkspaceRegistry, Storage, and per-ws objects.
   */
  private async spawnWorkspaceObjects(
    workspaceId: string, name: string,
    objectsToSpawn: readonly string[] = PER_WORKSPACE_OBJECTS,
  ): Promise<WorkspaceInfo> {
    const log = new Log(`WS-SPAWN:${name}`);
    // 1. Spawn WorkspaceRegistry (skip all registries — we register manually)
    const wsRegistryTypeId = this.computeTypeId(workspaceId, 'WorkspaceRegistry');
    const wsRegResult = await this.request<SpawnResult>(
      request(this.id, this.factoryId!, 'spawn', {
        manifest: { name: 'WorkspaceRegistry', description: `Workspace registry for '${name}'`,
          version: '1.0.0', requiredCapabilities: [], tags: ['system'] },
        skipGlobalRegistry: true,
        typeId: wsRegistryTypeId,
      })
    );
    const wsRegistryId = wsRegResult.objectId;

    // Subscribe to workspace registry for object registration events
    await this.request(
      request(this.id, wsRegistryId, 'subscribe', {})
    );

    // Configure fallback to global registry
    await this.request(
      request(this.id, wsRegistryId, 'setFallback', {
        registryId: this.globalRegistryId!,
      })
    );

    // Register workspace registry in itself (so workspace objects find "Registry")
    await this.request(
      request(this.id, wsRegistryId, 'register', {
        objectId: wsRegistryId,
        typeId: wsRegistryTypeId,
        manifest: { name: 'Registry', description: `Workspace registry for '${name}'`,
          version: '1.0.0', interface: { id: 'abjects:registry', name: 'Registry',
          description: 'Object registration and discovery', methods: [] },
          requiredCapabilities: [], tags: ['system', 'core'] },
      })
    );

    // Register the global registry in the workspace registry as "SystemRegistry"
    // so workspace objects (e.g. AppExplorer) can discover and query it
    await this.request(
      request(this.id, wsRegistryId, 'register', {
        objectId: this.globalRegistryId!,
        manifest: {
          name: 'SystemRegistry',
          description: 'System-wide registry for core objects shared across workspaces',
          version: '1.0.0',
          interface: { id: 'abjects:registry' as InterfaceId, name: 'Registry',
            description: 'Object registration and discovery', methods: [] },
          requiredCapabilities: [], tags: ['system', 'core'],
        },
      })
    );

    // Register workspace registry in the global registry so it's discoverable
    await this.request(
      request(this.id, this.globalRegistryId!, 'register', {
        objectId: wsRegistryId,
        typeId: wsRegistryTypeId,
        manifest: { name: `WorkspaceRegistry:${name}`, description: `Workspace registry for '${name}'`,
          version: '1.0.0', interface: { id: 'abjects:registry', name: 'Registry',
          description: 'Object registration and discovery', methods: [] },
          requiredCapabilities: [], tags: ['system', 'workspace'] },
      })
    );

    // 2. Spawn workspace-scoped Storage (registryHint → workspace registry, Factory auto-registers)
    const wsStorageTypeId = this.computeTypeId(workspaceId, 'Storage');
    const wsStorageResult = await this.request<SpawnResult>(
      request(this.id, this.factoryId!, 'spawn', {
        manifest: { name: 'Storage', description: `Workspace storage for '${name}'`,
          version: '1.0.0', requiredCapabilities: [], tags: ['system'] },
        registryHint: wsRegistryId,
        constructorArgs: { dbName: `abjects-storage-${workspaceId}` },
        typeId: wsStorageTypeId,
      })
    );
    const wsStorageId = wsStorageResult.objectId;
    log.timed('registry + storage ready');

    // 2b. Spawn workspace-scoped FileSystem (on-disk, rooted at ~/.abject/ws-<id>/files).
    // workspaceId is carried in constructorArgs so the instance roots itself even
    // when placed in a worker thread. Not in INFRA_OBJECTS — spawned explicitly here.
    const wsFileSystemTypeId = this.computeTypeId(workspaceId, 'FileSystem');
    const wsFileSystemResult = await this.request<SpawnResult>(
      request(this.id, this.factoryId!, 'spawn', {
        manifest: { name: 'FileSystem', description: `Workspace filesystem for '${name}'`,
          version: '2.0.0', requiredCapabilities: [], tags: ['system'] },
        registryHint: wsRegistryId,
        constructorArgs: { workspaceId },
        typeId: wsFileSystemTypeId,
      })
    );
    const wsFileSystemId = wsFileSystemResult.objectId;

    // 3. Spawn per-workspace objects (in dependency order)
    // Factory auto-registers each in the workspace registry via registryHint
    const childIds: AbjectId[] = [wsRegistryId, wsStorageId, wsFileSystemId];
    let taskbarId: AbjectId = '' as AbjectId;
    let abjectStoreId: AbjectId | undefined;
    const uiObjects: Array<{ id: AbjectId; iface: InterfaceId }> = [];
    const childTypeIds = new Map<AbjectId, TypeId>();

    // Compute typeIds for infrastructure objects
    const regTypeId = this.computeTypeId(workspaceId, 'WorkspaceRegistry');
    const storTypeId = this.computeTypeId(workspaceId, 'Storage');
    if (regTypeId) childTypeIds.set(wsRegistryId, regTypeId);
    if (storTypeId) childTypeIds.set(wsStorageId, storTypeId);
    if (wsFileSystemTypeId) childTypeIds.set(wsFileSystemId, wsFileSystemTypeId);

    // Map object names to their interface IDs for UI object tracking
    const uiIfaceMap: Record<string, InterfaceId> = {
      Settings: SETTINGS_INTERFACE,
      AppExplorer: APP_EXPLORER_INTERFACE,
      GoalBrowser: GOAL_BROWSER_INTERFACE,
      JobBrowser: JOB_BROWSER_INTERFACE,
      ChatBrowser: CHAT_BROWSER_INTERFACE,
    };

    // Installed workspace-scoped WASM extensions spawn alongside the built-in
    // per-workspace set. Extensions replacing a built-in are already in
    // objectsToSpawn under the built-in's name (the Factory resolves the
    // override), so only genuinely new type names are appended here.
    let extensionNames: string[] = [];
    try {
      const wasmTypes = await this.request<Array<{ name: string; scope: string }>>(
        request(this.id, this.factoryId!, 'listWasmTypes', {})
      );
      extensionNames = wasmTypes
        .filter((t) => t.scope === 'workspace' && !objectsToSpawn.includes(t.name))
        .map((t) => t.name);
    } catch { /* Factory without WASM support */ }

    for (const objName of [...objectsToSpawn, ...extensionNames]) {
      const typeId = this.computeTypeId(workspaceId, objName);
      let result: SpawnResult;
      try {
        result = await this.request<SpawnResult>(
          request(this.id, this.factoryId!, 'spawn', {
            manifest: { name: objName, description: '', version: '1.0.0',
              requiredCapabilities: [], tags: ['system'] },
            registryHint: wsRegistryId,
            typeId,
          })
        );
      } catch {
        // Constructor not registered (e.g. server-only objects in browser mode) — skip
        continue;
      }
      log.timed(`spawn ${objName}`);

      const objId = result.objectId;
      childIds.push(objId);
      if (typeId) childTypeIds.set(objId, typeId);

      if (objName === 'AbjectStore') {
        abjectStoreId = objId;
      }

      if (objName === 'Taskbar') {
        taskbarId = objId;
        // Register this workspace's Taskbar with WindowManager so it can
        // route minimize/restore events based on the window's workspace tag
        if (this.windowManagerId) {
          try {
            await this.request(request(this.id, this.windowManagerId,
              'registerTaskbar', { taskbarId: objId, workspaceId }));
          } catch { /* WindowManager may not be ready */ }
        }
      }

      // Register per-workspace Theme with WidgetManager for per-workspace theming
      if (objName === 'Theme' && this.widgetManagerId) {
        try {
          await this.request(request(this.id, this.widgetManagerId,
            'registerWorkspaceTheme', { workspaceId, themeId: objId }));
        } catch { /* WidgetManager may not be ready */ }
      }

      // Track UI objects for reference
      if (uiIfaceMap[objName]) {
        uiObjects.push({ id: objId, iface: uiIfaceMap[objName] });
      }

      // Tag this object with its workspace so WidgetManager can
      // assign the workspace ID to any surfaces it creates
      if (this.widgetManagerId) {
        try {
          await this.request(request(this.id, this.widgetManagerId, 'setObjectWorkspace', {
            objectId: objId, workspaceId,
          }));
        } catch { /* WidgetManager may not be ready */ }
      }
    }

    log.timed(`all ${objectsToSpawn.length} objects spawned`);

    // 4. Restore persisted user-created abjects for this workspace
    // abjectStoreId is captured by name during the spawn loop above (don't rely
    // on a positional index — childIds ordering changes when infra is added).
    if (abjectStoreId) {
      try {
        await this.request(
          request(this.id, abjectStoreId, 'restoreAll', {})
        );
        log.timed('restoreAll complete');
      } catch (err) {
        wsLog.warn(`Failed to restore abjects for workspace '${name}':`, err);
      }
    }

    // 5. Sync childIds with actual registry contents (picks up restored user objects).
    // `listLocal`, never `list`: `list` unions this workspace's registry with the
    // GLOBAL registry, which would adopt every system object as a child of this
    // workspace and get it killed when the workspace is deleted.
    try {
      const registered = await this.request<Array<{ id: string; typeId?: string }>>(
        request(this.id, wsRegistryId, 'listLocal', {})
      );
      for (const entry of registered) {
        const eid = entry.id as AbjectId;
        if (!childIds.includes(eid)) {
          childIds.push(eid);
        }
        if (entry.typeId && !childTypeIds.has(eid)) {
          childTypeIds.set(eid, entry.typeId as TypeId);
        }
      }
    } catch { /* registry not ready */ }

    log.summary();
    return {
      id: workspaceId,
      name,
      description: '',
      tags: [],
      accessMode: 'local',
      whitelist: [],
      exposedObjectIds: [],
      exposedTypeIds: [],
      childIds,
      registryId: wsRegistryId,
      storageId: wsStorageId,
      taskbarId,
      uiObjects,
      childTypeIds,
      participants: [],
      uiSpawned: objectsToSpawn.includes('Taskbar'),
    };
  }

  /**
   * Restore a previously persisted workspace by re-spawning its objects.
   */
  private async restoreWorkspace(
    workspaceId: string, name: string,
    accessMode: WorkspaceAccessMode = 'local', whitelist: string[] = [],
    exposedTypeIds: string[] = [], description: string = '', tags: string[] = [],
    isActive: boolean = true,
  ): Promise<void> {
    const objectsToSpawn = isActive ? PER_WORKSPACE_OBJECTS : INFRA_OBJECTS;
    const info = await this.spawnWorkspaceObjects(workspaceId, name, objectsToSpawn);
    info.accessMode = accessMode;
    info.whitelist = whitelist;
    info.description = description;
    info.tags = tags;
    info.exposedTypeIds = exposedTypeIds as TypeId[];

    // Resolve persisted typeIds to current runtime AbjectIds via Registry
    const resolvedIds: AbjectId[] = [];
    for (const typeId of exposedTypeIds) {
      try {
        const abjectId = await this.request<AbjectId | null>(
          request(this.id, info.registryId, 'resolveType', { typeId })
        );
        if (abjectId) resolvedIds.push(abjectId);
      } catch { /* type not found — may have been removed */ }
    }
    info.exposedObjectIds = resolvedIds;

    // Joined shared workspaces persist like any other workspace; recover what
    // makes them a mirror of a remote host rather than one of ours.
    const persisted = this.persistedById.get(workspaceId);
    // Curation is a deliberate user choice and has to survive a cold boot.
    // Without this, a restored shared workspace would re-read the exposure list
    // that `setAccessMode` seeded for it as though the user had curated it.
    info.curated = persisted?.curated === true;
    if (persisted?.participants?.length) {
      info.participants = [...persisted.participants];
    }
    if (persisted?.joined) {
      info.joined = true;
      info.ownerPeerId = persisted.ownerPeerId;
      this.addParticipants(info, persisted.ownerPeerId ? [persisted.ownerPeerId] : []);
      wsLog.info(`Restored joined shared workspace '${name}' (${workspaceId}) owner=${persisted.ownerPeerId ?? 'unknown'} registry=${info.registryId} participants=${info.participants?.length ?? 0}`);
    }

    this.workspaces.set(workspaceId, info);

    // AbjectStore restores persisted children before this workspace record is
    // installed, so their objectRegistered events can be missed. Reconcile
    // against the WorkspaceRegistry's local-only catalog after persisted policy
    // (especially curated/joined) has been restored.
    try {
      const registrations = await this.request<Array<{ id: string; typeId?: string }>>(
        request(this.id, info.registryId, 'listLocal', {})
      );
      let reconciled = false;
      const autoExpose = info.curated !== true
        && (info.accessMode === 'shared' || info.joined === true);
      for (const registration of registrations) {
        const childId = registration.id as AbjectId;
        if (!info.childIds.includes(childId)) {
          info.childIds.push(childId);
          reconciled = true;
        }
        if (registration.typeId && info.childTypeIds.get(childId) !== registration.typeId) {
          info.childTypeIds.set(childId, registration.typeId as TypeId);
          reconciled = true;
        }
        if (autoExpose && !info.exposedObjectIds.includes(childId)) {
          info.exposedObjectIds.push(childId);
          reconciled = true;
        }
      }
      if (reconciled) await this.persistWorkspaceList();
    } catch (err) {
      wsLog.warn(`Failed to reconcile restored children for workspace '${name}':`, err);
    }

    // Notify SharedState of the workspace access mode so it knows whether to
    // sync P2P. A restored mirror is handled by activateJoinedParticipation
    // below instead, which dispatches its participation mode -- dispatching the
    // persisted 'local' here first would only make it clear its remote peers.
    if (info.joined !== true) {
      // Routed through participationAccess like every other dispatch site, and
      // retried: a restore that raced SharedState's spawn used to lose the mode
      // outright, leaving the workspace silent until the next explicit change.
      await this.dispatchAccessMode(info);
    }

    if (info.accessMode !== 'local') {
      await this.ensureSharedStateExposed(info);
      await this.syncExposedToRegistry(info);
      this.changed('workspaceShared', {
        workspaceId, name, description, tags,
        accessMode, whitelist,
        exposedObjectIds: info.exposedObjectIds,
        registryId: info.registryId,
      });
    } else if (info.joined === true) {
      // Restored mirror: re-arm participation (curation + SharedState sync +
      // PeerRouter cache invalidation) on every boot. Without this the mirror
      // comes back up with SharedState pinned 'local' and never syncs again.
      await this.activateJoinedParticipation(info);
    }
    wsLog.info(`Restored workspace '${name}' (${workspaceId})`);
  }

  /**
   * Migrate existing data from the global storage to the default workspace storage.
   */
  private async migrateExistingData(workspaceId: string): Promise<void> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return;

    try {
      const keys = await this.request<string[]>(
        request(this.id, this.globalStorageId!, 'keys', {})
      );

      // Keys that belong to per-workspace objects
      // settings: keys are now managed by GlobalSettings in global storage
      const migrateKeys = keys.filter((key) =>
        key.startsWith('theme:') ||
        key.startsWith('abject-store:') ||
        key.startsWith('chat:')
      );

      for (const key of migrateKeys) {
        try {
          const value = await this.request<unknown>(
            request(this.id, this.globalStorageId!, 'get', { key })
          );
          if (value !== null) {
            await this.request(
              request(this.id, ws.storageId, 'set', { key, value })
            );
          }
        } catch { /* skip individual key errors */ }
      }

      if (migrateKeys.length > 0) {
        wsLog.info(`Migrated ${migrateKeys.length} keys to default workspace`);
      }
    } catch (err) {
      wsLog.warn('Data migration failed:', err);
    }
  }

  // ── Persistence ──

  private async loadWorkspaceList(): Promise<PersistedWorkspace[]> {
    try {
      const stored = await this.request<PersistedWorkspace[] | null>(
        request(this.id, this.globalStorageId!, 'get', { key: STORAGE_KEY_LIST })
      );
      const list = Array.isArray(stored) ? stored : [];
      // Index the raw records so restoreWorkspace can recover joined-workspace
      // fields that its own parameters do not carry.
      this.persistedById.clear();
      for (const entry of list) {
        this.persistedById.set(entry.id, entry);
      }
      return list;
    } catch (err) {
      wsLog.warn('Failed to load workspace list:', err);
      return [];
    }
  }

  private async loadActiveWorkspaceId(): Promise<string | null> {
    try {
      const stored = await this.request<string | null>(
        request(this.id, this.globalStorageId!, 'get', { key: STORAGE_KEY_ACTIVE })
      );
      return stored;
    } catch {
      return null;
    }
  }

  /**
   * The access a workspace grants for PARTICIPATION, as distinct from the
   * `accessMode` that governs HOSTING and advertisement.
   *
   * A joined mirror is pinned `accessMode:'local'` on purpose: we mirror the
   * workspace, we do not host it, so it must never be re-advertised as ours
   * (see `materializeJoinedWorkspace`). The bug was that this single field was
   * ALSO gating SharedState replication and PeerRouter's inbound permission,
   * so a mirror could not exchange anything with the very peers it joined.
   * P2PChat has no transport of its own -- it rides per-workspace SharedState
   * under the LWW names `p2pchat:channels` / `p2pchat:channel:*` -- so it went
   * silent on every joining peer.
   *
   * Hosting therefore keeps `accessMode`; participation reads this. A mirror
   * participates as 'shared' whitelisted to `participants + ownerPeerId`,
   * which is strictly NARROWER than 'public': only the workspace's own members
   * are admitted. Every non-mirror workspace is returned unchanged.
   */
  private participationAccess(ws: WorkspaceInfo): {
    accessMode: WorkspaceAccessMode;
    whitelist: string[];
  } {
    if (ws.joined !== true || ws.accessMode !== 'local') {
      return { accessMode: ws.accessMode, whitelist: [...ws.whitelist] };
    }
    const peers = new Set<string>(ws.participants ?? []);
    if (ws.ownerPeerId) peers.add(ws.ownerPeerId);
    return { accessMode: 'shared', whitelist: [...peers] };
  }

  /**
   * Namespaces SharedState may replicate to peers when this workspace shares.
   * A trailing '*' is a prefix glob. This is the namespace-level companion to
   * the peer-level whitelist: peers gate WHO receives, this gates WHAT crosses.
   * The list names every namespace the system actually replicates today, so
   * introducing the policy changes no existing sync.
   */
  private static readonly SHARED_NAMESPACES: readonly string[] = [
    'goals:catalog',
    'goal-*',
    'ts-*',
    'knowledge-base',
    'p2pchat:channels',
    'p2pchat:channel:*',
  ];

  private static readonly ACCESS_DISPATCH_ATTEMPTS = 5;
  private static readonly ACCESS_DISPATCH_BASE_MS = 250;

  /**
   * Push a workspace's PARTICIPATION access mode (and the shared-namespace
   * whitelist) to its SharedState.
   *
   * Every former call site did discover-then-fire-and-forget inside a
   * swallowing try/catch, so a dispatch issued before SharedState had spawned
   * was simply lost -- and because nothing re-sent it, a restored or joined
   * workspace could stay unsynced indefinitely. Retry with backoff instead.
   */
  private async dispatchAccessMode(ws: WorkspaceInfo, attempt = 0): Promise<void> {
    const access = this.participationAccess(ws);
    let target: AbjectId | undefined;
    try {
      const results = await this.request<Array<{ id: AbjectId }>>(
        request(this.id, ws.registryId, 'discover', { name: 'SharedState' })
      );
      target = results[0]?.id;
    } catch { /* SharedState not spawned yet -- fall through to retry */ }

    if (target) {
      this.send(event(this.id, target, 'setAccessMode', {
        accessMode: access.accessMode,
        whitelist: access.whitelist,
        sharedNamespaces: [...WorkspaceManager.SHARED_NAMESPACES],
      }));
      return;
    }

    if (attempt + 1 >= WorkspaceManager.ACCESS_DISPATCH_ATTEMPTS) return;
    const delay = WorkspaceManager.ACCESS_DISPATCH_BASE_MS * Math.pow(2, attempt);
    setTimeout(() => { void this.dispatchAccessMode(ws, attempt + 1); }, delay);
  }

  /**
   * Wire a joined mirror for participation without advertising it as hosted.
   *
   * The record keeps `accessMode:'local'`, so the three things that normally
   * ride that field have to be done explicitly here:
   *  1. curate the mirror's SharedState and registry -- without this,
   *     PeerRouter's second (curation) gate denies every inbound message into
   *     the mirror, because nothing is exposed to match against;
   *  2. dispatch the PARTICIPATION mode to SharedState, which is what starts
   *     discovery/sync and therefore what carries P2PChat between peers;
   *  3. emit `workspaceAccessChanged` so PeerRouter clears the permission-cache
   *     entries that still say 'local' -> deny for the mirror's objects.
   *
   * Deliberately does NOT emit `workspaceShared`: that announces a workspace we
   * host, which this is not.
   */
  private async activateJoinedParticipation(ws: WorkspaceInfo): Promise<void> {
    const access = this.participationAccess(ws);
    if (access.accessMode === 'local') return;

    // Minimal curation: the registry is the peer's entry point, SharedState is
    // the replication endpoint. Nothing else in the mirror is offered.
    await this.ensureSharedStateExposed(ws);
    if (!ws.exposedObjectIds.includes(ws.registryId)) {
      ws.exposedObjectIds.push(ws.registryId);
      const regTypeId = ws.childTypeIds.get(ws.registryId);
      if (regTypeId && !ws.exposedTypeIds.includes(regTypeId)) {
        ws.exposedTypeIds.push(regTypeId);
      }
    }
    await this.syncExposedToRegistry(ws);
    await this.persistWorkspaceList();

    await this.dispatchAccessMode(ws);

    this.changed('workspaceAccessChanged', {
      workspaceId: ws.id,
      accessMode: access.accessMode,
      whitelist: access.whitelist,
      exposedObjectIds: [...ws.exposedObjectIds],
    });
  }

  /**
   * Ensure SharedState is in the workspace's exposed objects when shared.
   * Discovers SharedState via the workspace registry and adds it if missing.
   */
  private async ensureSharedStateExposed(ws: WorkspaceInfo): Promise<void> {
    // Check if SharedState is already exposed
    const alreadyExposed = ws.exposedObjectIds.some(id => {
      const typeId = ws.childTypeIds.get(id);
      return typeId?.endsWith('/SharedState');
    });
    if (alreadyExposed) return;

    try {
      const results = await this.request<Array<{ id: AbjectId }>>(
        request(this.id, ws.registryId, 'discover', { name: 'SharedState' })
      );
      if (results.length > 0) {
        const ssId = results[0].id;
        if (!ws.exposedObjectIds.includes(ssId)) {
          ws.exposedObjectIds.push(ssId);
          const ssTypeId = ws.childTypeIds.get(ssId);
          if (ssTypeId && !ws.exposedTypeIds.includes(ssTypeId)) {
            ws.exposedTypeIds.push(ssTypeId);
          }
        }
      }
    } catch { /* SharedState not spawned yet */ }
  }

  /**
   * The set of objects a remote peer may reach in this workspace.
   *
   * `exposedObjectIds` serves two masters: it is the host-side catalog filter
   * AND PeerRouter's permission gate (see the "Second gate: exposed objects
   * check" in `peer-router.ts`, which denies any target absent from this list).
   * While a workspace is uncurated the seeded `[registryId, SharedState]` pair
   * must not narrow that gate, or an object the joiner can see in the catalog
   * would still be uncallable over P2P. So an uncurated shared workspace
   * exposes every child; a curated one exposes exactly its curated list plus
   * the registry the joiner needs as an entry point.
   *
   * Local workspaces keep the previous narrow list. A joined mirror also stays
   * `accessMode:'local'` — it is mirrored, not hosted, so it is never
   * advertised — but `activateJoinedParticipation` curates its SharedState and
   * registry into `exposedObjectIds`, so this returns exactly the two objects
   * the owner and fellow participants must reach for replication, and nothing
   * else from the mirror.
   *
   * Note the residual: an object marked `sharing: 'user-local'` is still kept
   * out of the catalog by `WorkspaceShareRegistry.isShareable`, so a peer can
   * never discover its id here, but this gate no longer refuses it on id alone.
   */
  private effectiveExposedIds(ws: WorkspaceInfo): AbjectId[] {
    const uncurated = ws.curated !== true;
    let ids: AbjectId[];
    if (uncurated && ws.accessMode === 'shared') {
      // Uncurated 'shared' (whitelisted peers only): every shareable child.
      // Host-local infrastructure (stores, schedulers, consoles, agents...)
      // stays out for the same reason WorkspaceShareRegistry.applyCuration
      // keeps it out of the catalog: the permission gate and the catalog must
      // agree on what a member may reach, or a member could invoke objects it
      // was never shown.
      ids = ws.childIds.filter(
        id => id === ws.registryId || !isHostLocalObject(nameFromTypeId(ws.childTypeIds.get(id))),
      );
    } else {
      // P2-3: an uncurated PUBLIC workspace must not mean "share everything".
      // Anyone on the network can reach it, so until the user curates we
      // expose only what setAccessMode/ensureSharedStateExposed seeded (the
      // registry entry point and SharedState, which replication needs in both
      // directions). Curated and local workspaces expose exactly their list.
      ids = [...ws.exposedObjectIds];
    }
    if (!ids.includes(ws.registryId)) ids.push(ws.registryId);
    return [...new Set(ids)];
  }

  /**
   * The durable half of `effectiveExposedIds` (P1-2).
   *
   * AbjectIds rotate on every restart, so a registry curated by id alone shows
   * a remote caller nothing once the host comes back up. TypeIds and registered
   * names survive that churn, so we send all three and let the registry's
   * exposure predicate match on id OR typeId OR name.
   */
  private effectiveExposedSelectors(ws: WorkspaceInfo): { ids: AbjectId[]; typeIds: string[]; names: string[] } {
    const ids = this.effectiveExposedIds(ws);
    const typeIds = new Set<string>();
    for (const id of ids) {
      const t = ws.childTypeIds.get(id);
      if (t) typeIds.add(t);
    }
    // Durable typeIds persisted with the workspace outlive this run's ids.
    if (ws.curated === true) {
      for (const t of ws.exposedTypeIds ?? []) typeIds.add(t);
    }
    const typeIdList = [...typeIds];
    return { ids, typeIds: typeIdList, names: namesFromTypeIds(typeIdList) };
  }

  private async syncExposedToRegistry(ws: WorkspaceInfo): Promise<void> {
    try {
      this.send(
        request(this.id, ws.registryId, 'setExposedObjectIds',
          this.effectiveExposedSelectors(ws))
      );
    } catch (err) {
      wsLog.warn('Failed to sync exposed objects to registry:', err);
    }
  }

  /**
   * Materialize a workspace joined from a remote peer as a first-class local
   * record: its own WorkspaceRegistry (where the remote proxies land) and its
   * own UI/Taskbar scaffolding, spawned lazily on first switch exactly like
   * any other inactive workspace.
   *
   * The record deliberately stays `accessMode: 'local'` — we mirror this
   * workspace, we do not host it, so it must not be re-advertised as ours. Its
   * shared identity lives in `joined`/`ownerPeerId`/`participants`.
   *
   * Idempotent: re-joining returns the existing record and only widens the
   * participant set.
   */
  async materializeJoinedWorkspace(
    workspaceId: string,
    name: string,
    ownerPeerId: string,
    participants: string[] = [],
  ): Promise<{ workspaceId: string; registryId: AbjectId; created: boolean }> {
    precondition(workspaceId !== '', 'workspaceId must not be empty');
    precondition(ownerPeerId !== '', 'ownerPeerId must not be empty');

    const existing = this.workspaces.get(workspaceId);
    if (existing) {
      existing.joined = true;
      existing.ownerPeerId = ownerPeerId;
      if (name) existing.name = name;
      this.addParticipants(existing, [ownerPeerId, ...participants]);
      await this.persistWorkspaceList();
      wsLog.info(`Joined workspace '${existing.name}' (${workspaceId}) already materialized; registry=${existing.registryId} participants=${existing.participants?.length ?? 0}`);
      // Re-join widened the participant set: push the new whitelist through so
      // SharedState syncs with the arrivals and PeerRouter admits them.
      await this.activateJoinedParticipation(existing);
      return { workspaceId, registryId: existing.registryId, created: false };
    }

    const wsName = name || `Shared ${workspaceId.slice(0, 8)}`;
    // INFRA_OBJECTS only: the dedicated registry has to exist right now (the
    // catalog sync targets it), while the UI follows on the first switch.
    const info = await this.spawnWorkspaceObjects(workspaceId, wsName, INFRA_OBJECTS);
    info.joined = true;
    info.ownerPeerId = ownerPeerId;
    info.description = `Shared workspace hosted by peer ${ownerPeerId}`;
    this.addParticipants(info, [ownerPeerId, ...participants]);
    this.workspaces.set(workspaceId, info);
    await this.persistWorkspaceList();

    wsLog.info(`Materialized joined workspace '${wsName}' (${workspaceId}) owner=${ownerPeerId} registry=${info.registryId} participants=${info.participants?.length ?? 0}`);
    // The record stays 'local' (not advertised); this opens participation.
    await this.activateJoinedParticipation(info);
    this.changed('workspaceJoined', {
      workspaceId,
      name: wsName,
      ownerPeerId,
      registryId: info.registryId,
      participants: [...(info.participants ?? [])],
    });
    this.checkInvariants();
    return { workspaceId, registryId: info.registryId, created: true };
  }

  /**
   * Release this instance's reference to a shared workspace.
   *
   * A shared workspace is a distributed, reference-counted entity: every
   * participating instance holds one reference and leaving drops only that
   * one. The workspace lives on wherever another instance still holds it, and
   * is torn down here once no participant remains — or immediately when this
   * instance explicitly deletes its own mirror (`destroy`).
   */
  async releaseJoinedWorkspace(
    workspaceId: string,
    peerId?: string,
    destroy: boolean = false,
  ): Promise<{ released: boolean; remaining: string[]; deleted: boolean }> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) {
      wsLog.warn(`releaseJoinedWorkspace: no local record for workspace '${workspaceId}'`);
      return { released: false, remaining: [], deleted: false };
    }

    const leaving = peerId ?? this.peerId ?? '';
    ws.participants = (ws.participants ?? []).filter((p) => p !== leaving);
    const remaining = [...ws.participants];

    const deleted = ws.joined === true && (destroy || remaining.length === 0);
    if (deleted) {
      try {
        await this.deleteWorkspace(workspaceId);
      } catch (err) {
        wsLog.warn(`releaseJoinedWorkspace: failed to delete workspace '${workspaceId}':`, err);
      }
      // deleteWorkspace drops the share-registry entry itself, but it can bail
      // before getting there (the last workspace cannot be deleted). Ask again
      // so the joined entry never outlives the reference that justified it.
      await this.dropShareRegistryEntry(workspaceId);
    } else {
      await this.persistWorkspaceList();
    }

    wsLog.info(`Released workspace '${workspaceId}' for '${leaving || 'local'}': ${remaining.length} participant(s) remain, deleted=${deleted}`);
    this.changed('workspaceParticipantsChanged', { workspaceId, participants: remaining, deleted });
    return { released: true, remaining, deleted };
  }

  /** Union `peerIds` (plus this instance) into a workspace's participant set. */
  private addParticipants(ws: WorkspaceInfo, peerIds: string[]): void {
    const set = new Set<string>(ws.participants ?? []);
    if (this.peerId) set.add(this.peerId);
    for (const p of peerIds) {
      if (p) set.add(p);
    }
    ws.participants = [...set];
  }

  private async persistWorkspaceList(): Promise<void> {
    const list: PersistedWorkspace[] = [...this.workspaces.entries()].map(([id, ws]) => {
      return {
        id,
        name: ws.name,
        description: ws.description,
        tags: ws.tags,
        accessMode: ws.accessMode,
        whitelist: ws.whitelist,
        exposedObjectIds: ws.exposedObjectIds,
        exposedTypeIds: ws.exposedTypeIds,
        curated: ws.curated,
        joined: ws.joined,
        ownerPeerId: ws.ownerPeerId,
        participants: ws.participants ? [...ws.participants] : undefined,
        createdAt: Date.now(),
      };
    });
    try {
      await this.request(
        request(this.id, this.globalStorageId!, 'set', {
          key: STORAGE_KEY_LIST,
          value: list,
        })
      );
    } catch (err) {
      wsLog.warn('Failed to persist workspace list:', err);
    }
  }

  private async persistActiveWorkspaceId(): Promise<void> {
    // Persists `null` when there is no active workspace. Returning early on an
    // empty id would make a *cleared* active workspace unwritable, leaving the
    // previous — possibly deleted — id in storage to be restored on next boot.
    try {
      await this.request(
        request(this.id, this.globalStorageId!, 'set', {
          key: STORAGE_KEY_ACTIVE,
          value: this.activeWorkspaceId ?? null,
        })
      );
    } catch (err) {
      wsLog.warn('Failed to persist active workspace:', err);
    }
  }

  /**
   * Ask WorkspaceShareRegistry to forget its joined entry for a workspace.
   *
   * Deliberately one-way. WSR's own `leaveWorkspace` already calls back into
   * `releaseJoinedWorkspace` here, so this targets `dropJoinedWorkspace` — the
   * local-only entry point that clears WSR's bookkeeping without re-entering
   * this manager. Best-effort: a missing or unresponsive WSR must not fail a
   * delete that has already been persisted.
   */
  private async dropShareRegistryEntry(workspaceId: string): Promise<void> {
    if (!this.workspaceShareRegistryId) {
      this.workspaceShareRegistryId = await this.discoverDep('WorkspaceShareRegistry') ?? undefined;
    }
    if (!this.workspaceShareRegistryId) return;
    try {
      await this.request(request(this.id, this.workspaceShareRegistryId,
        'dropJoinedWorkspace', { workspaceId }));
    } catch (err) {
      wsLog.warn(`dropShareRegistryEntry: WorkspaceShareRegistry did not drop '${workspaceId}':`, err);
    }
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## WorkspaceManager Usage Guide

### Methods
- \`createWorkspace({ name })\` — Create a new workspace. Returns { workspaceId }.
- \`deleteWorkspace({ workspaceId })\` — Delete a workspace. Cannot delete the last one.
- \`switchWorkspace({ workspaceId })\` — Switch to a workspace (compositor-level filtering, instant switch).
- \`listWorkspaces()\` — List all workspaces. Returns [{ id, name }].
- \`getActiveWorkspace()\` — Get the active workspace. Returns { id, name }.
- \`renameWorkspace({ workspaceId, name })\` — Rename a workspace.
- \`getAccessMode({ workspaceId })\` — Get workspace access mode (local, private, public).
- \`setAccessMode({ workspaceId, accessMode })\` — Set workspace access mode.

### Whitelist Management
- \`getWhitelist({ workspaceId })\` — Get the peer whitelist for a workspace. Returns string[].
- \`setWhitelist({ workspaceId, whitelist })\` — Set the peer whitelist (array of peer IDs).

### Discovery & Inspection
- \`listSharedWorkspaces({})\` — List workspaces with non-local access mode. Returns [{ id, name, accessMode }].
- \`findWorkspaceForObject({ objectId })\` — Find which workspace owns an object. Returns { workspaceId } or undefined.
- \`listWorkspacesDetailed({})\` — Full workspace details including access mode, whitelist, and child objects.

### Interface ID
\`abjects:workspace-manager\``;
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.workspaces.size >= 0, 'workspace count must be non-negative');
    for (const ws of this.workspaces.values()) {
      invariant(!ws.joined || !!ws.ownerPeerId, 'joined workspace must record its owner peer');
    }
  }
}

export const WORKSPACE_MANAGER_ID = 'abjects:workspace-manager' as AbjectId;
