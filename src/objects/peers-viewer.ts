/** Standalone viewer for peers participating in the active shared workspace. */
import { Abject } from '../core/abject.js';
import { invariant } from '../core/contracts.js';
import { request } from '../core/message.js';
import type { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import type { WorkspaceMemberInfo } from './workspace-share-registry.js';

const PEERS_VIEWER_INTERFACE = 'abjects:peers-viewer' as InterfaceId;
const EMPTY_RECT = { x: 0, y: 0, width: 0, height: 0 };

interface ActiveWorkspace {
  id: string;
  name?: string;
  registryId: string;
  accessMode?: 'local' | 'shared' | 'public';
  whitelist?: string[];
  participants?: string[];
  joined?: boolean;
  ownerPeerId?: string;
  exposedObjectIds?: string[];
}

interface DiscoveredWorkspaceInfo {
  workspaceId: string;
  ownerPeerId?: string;
  ownerName?: string;
}

type WorkspaceActivity = 'Interacting' | 'Browsing' | 'Invited';

interface PeerRow {
  peerId: string;
  name?: string;
  connected: boolean;
  role: 'Owner' | 'You' | 'Participant';
  activity: WorkspaceActivity;
  joinedAt?: number;
  lastSeen?: number;
}

interface ContactInfo {
  peerId: string;
  name?: string;
  state?: string;
  lastSeen?: number;
}

interface NetworkPeerInfo {
  peerId: string;
  name?: string;
  connectedAt?: number;
}

interface CatalogEntry {
  id?: string;
  typeId?: string;
  ownerPeerId?: string;
  workspaceId?: string;
  name?: string;
  manifest?: { name?: string; description?: string };
  description?: string;
}

type PeerLoadState = 'loading' | 'ready' | 'empty' | 'no-shared-workspace' | 'error';
type CatalogLoadState = 'idle' | 'loading' | 'ready' | 'error';

export class PeersViewer extends Abject {
  private widgetManagerId?: AbjectId;
  private workspaceManagerId?: AbjectId;
  private workspaceShareRegistryId?: AbjectId;
  private peerRegistryId?: AbjectId;
  private identityId?: AbjectId;

  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private splitPaneId?: AbjectId;
  private peerListId?: AbjectId;
  private detailPaneId?: AbjectId;
  private refreshButtonId?: AbjectId;
  private statusLabelId?: AbjectId;
  private detailWidgetIds: AbjectId[] = [];
  private catalogListId?: AbjectId;
  private detailRebuildGeneration = 0;
  private detailRebuildQueue: Promise<void> = Promise.resolve();

  private workspace?: ActiveWorkspace;
  private localPeerId?: string;
  private localPeerName?: string;
  private peers: PeerRow[] = [];
  private selectedPeerIndex = -1;
  private catalog: CatalogEntry[] = [];
  private selectedCatalogIndex = -1;
  private peerLoadState: PeerLoadState = 'loading';
  private peerLoadError?: string;
  private catalogLoadState: CatalogLoadState = 'idle';

  constructor() {
    super({
      manifest: {
        name: 'PeersViewer',
        description: 'View peers and their exposed abjects in the active shared workspace.',
        version: '1.0.0',
        interface: {
          id: PEERS_VIEWER_INTERFACE,
          name: 'PeersViewer',
          description: 'Standalone active-workspace peer viewer',
          methods: [
            {
              name: 'show',
              description: 'Show the peers viewer',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'hide',
              description: 'Hide the peers viewer',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'refresh',
              description: 'Refresh peers and exposed abjects',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'ui', 'peer'],
      },
    });
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('show', async () => this.show());
    this.on('hide', async () => this.hide());
    this.on('refresh', async () => this.refresh());
    this.on('getState', async () => ({
      visible: !!this.windowId,
      workspaceId: this.workspace?.id,
      peers: this.peers,
      selectedPeerId: this.selectedPeer()?.peerId,
      exposedAbjectCount: this.catalog.length,
    }));
    this.on('changed', async (msg: AbjectMessage) => {
      const payload = (msg.payload ?? {}) as Record<string, unknown>;
      const aspect = typeof payload['aspect'] === 'string' ? payload['aspect'] : '';
      await this.handleWidgetEvent(msg.routing.from, aspect, payload);
    });
    this.on('clicked', async (msg: AbjectMessage) => {
      await this.handleWidgetEvent(msg.routing.from, 'clicked', (msg.payload ?? {}) as Record<string, unknown>);
    });
    this.on('selectionChanged', async (msg: AbjectMessage) => {
      await this.handleWidgetEvent(msg.routing.from, 'selectionChanged', (msg.payload ?? {}) as Record<string, unknown>);
    });
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.selectedPeerIndex >= -1, 'Selected peer index must be -1 or greater');
    invariant(
      this.selectedPeerIndex < this.peers.length || this.selectedPeerIndex === -1,
      'Selected peer index must refer to a peer'
    );
  }

  private async ensureDependencies(): Promise<void> {
    this.widgetManagerId ??= (await this.discoverDep('WidgetManager')) ?? undefined;
    this.workspaceManagerId ??= (await this.discoverDep('WorkspaceManager')) ?? undefined;
    this.workspaceShareRegistryId ??= (await this.discoverDep('WorkspaceShareRegistry')) ?? undefined;
    this.peerRegistryId ??= (await this.discoverDep('PeerRegistry')) ?? undefined;
    this.identityId ??= (await this.discoverDep('Identity')) ?? undefined;
  }

  async show(): Promise<boolean> {
    if (this.windowId) return true;
    await this.ensureDependencies();
    if (!this.widgetManagerId) return false;

    await this.buildUi();
    await this.refresh();
    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;
    try {
      await this.request(request(this.id, this.widgetManagerId!, 'destroyWindowAbject', { windowId: this.windowId }));
    } catch {
      // The window may already have been closed by the compositor.
    }
    this.detailRebuildGeneration += 1;
    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.splitPaneId = undefined;
    this.peerListId = undefined;
    this.detailPaneId = undefined;
    this.refreshButtonId = undefined;
    this.statusLabelId = undefined;
    this.detailWidgetIds = [];
    this.catalogListId = undefined;
    this.selectedCatalogIndex = -1;
    this.changed('visibility', false);
    return true;
  }

  async refresh(): Promise<boolean> {
    if (!this.windowId) return this.show();
    const selectedPeerId = this.selectedPeer()?.peerId;
    this.peerLoadState = 'loading';
    this.peerLoadError = undefined;
    this.catalogLoadState = 'idle';
    this.peers = [];
    this.catalog = [];
    this.selectedPeerIndex = -1;
    await this.rebuildPeerList();
    await this.rebuildDetailPane();
    await this.updateStatus();

    await this.loadData();
    this.selectedPeerIndex = selectedPeerId
      ? this.peers.findIndex(peer => peer.peerId === selectedPeerId)
      : this.peers.length > 0 ? 0 : -1;
    if (this.selectedPeerIndex < 0 && this.peers.length > 0) this.selectedPeerIndex = 0;
    await this.loadSelectedPeerCatalog();
    await this.rebuildPeerList();
    await this.rebuildDetailPane();
    await this.updateStatus();
    this.checkInvariants();
    return true;
  }

  private selectedPeer(): PeerRow | undefined {
    return this.selectedPeerIndex >= 0 ? this.peers[this.selectedPeerIndex] : undefined;
  }

  private effectiveAccessMode(): 'local' | 'shared' | 'public' {
    if (!this.workspace) return 'local';
    if (this.workspace.accessMode === 'public') return 'public';
    if (this.workspace.joined || this.cleanText(this.workspace.ownerPeerId)) return 'shared';
    return this.workspace.accessMode === 'shared' ? 'shared' : 'local';
  }

  private cleanText(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    if (!text || text === 'undefined' || text === 'null') return undefined;
    return text;
  }

  private workspaceLabel(): string {
    return this.cleanText(this.workspace?.name) ?? 'Unnamed workspace';
  }

  private peerLabel(peer: PeerRow): string {
    return this.cleanText(peer.name) ?? this.cleanText(peer.peerId) ?? 'Unknown peer';
  }

  private async loadData(): Promise<void> {
    const previousNames = new Map(
      this.peers.map(peer => [peer.peerId, this.cleanText(peer.name)] as const),
    );
    const selectedPeerId = this.selectedPeer()?.peerId;

    this.workspace = undefined;
    this.localPeerId = undefined;
    this.localPeerName = undefined;
    this.peers = [];
    this.catalog = [];
    this.peerLoadError = undefined;
    this.catalogLoadState = 'idle';

    if (this.identityId) {
      try {
        const identity = await this.request<Record<string, unknown>>(
          request(this.id, this.identityId, 'getIdentity', {})
        );
        const peerId = this.cleanText(identity['peerId'] ?? identity['id']);
        if (peerId) this.localPeerId = peerId;
        this.localPeerName = this.cleanText(identity['name'] ?? identity['displayName']);
      } catch {
        // Identity may still be initializing.
      }
    }

    if (!this.workspaceManagerId) {
      this.peerLoadState = 'error';
      this.peerLoadError = 'Workspace information is unavailable.';
      return;
    }

    try {
      this.workspace = (await this.request<ActiveWorkspace | null>(
        request(this.id, this.workspaceManagerId, 'getActiveWorkspace', {})
      )) ?? undefined;
    } catch {
      this.peerLoadState = 'error';
      this.peerLoadError = 'Could not load the active workspace.';
      return;
    }

    const accessMode = this.effectiveAccessMode();
    if (!this.workspace || accessMode === 'local') {
      this.peerLoadState = 'no-shared-workspace';
      this.selectedPeerIndex = -1;
      return;
    }

    const connected = new Set<string>();
    const contacts = new Map<string, ContactInfo>();
    const networkPeers = new Map<string, NetworkPeerInfo>();
    if (this.peerRegistryId) {
      try {
        const peerIds = await this.request<string[]>(request(this.id, this.peerRegistryId, 'getConnectedPeers', {}));
        for (const value of peerIds ?? []) {
          const peerId = this.cleanText(value);
          if (peerId) connected.add(peerId);
        }
      } catch {
        // Shared invitees can still be shown when live presence is unavailable.
      }
      try {
        const entries = await this.request<ContactInfo[]>(request(this.id, this.peerRegistryId, 'listContacts', {}));
        for (const contact of entries ?? []) {
          const peerId = this.cleanText(contact.peerId);
          if (peerId) contacts.set(peerId, contact);
        }
      } catch {
        // Names and last-seen timestamps are optional display metadata.
      }
      try {
        const entries = await this.request<NetworkPeerInfo[]>(request(this.id, this.peerRegistryId, 'listNetworkPeers', {}));
        for (const peer of entries ?? []) {
          const peerId = this.cleanText(peer.peerId);
          if (peerId) networkPeers.set(peerId, peer);
        }
      } catch {
        // Connected peer IDs remain sufficient for the public view.
      }
    }

    let members: WorkspaceMemberInfo[] = [];
    let discoveredWorkspace: DiscoveredWorkspaceInfo | undefined;
    if (this.workspaceShareRegistryId) {
      try {
        members = await this.request<WorkspaceMemberInfo[]>(
          request(this.id, this.workspaceShareRegistryId, 'getActiveMembers', { workspaceId: this.workspace.id })
        );
      } catch {
        // Invitation and connection data still provide a useful degraded view.
      }
      try {
        const discovered = await this.request<DiscoveredWorkspaceInfo[]>(
          request(this.id, this.workspaceShareRegistryId, 'getDiscoveredWorkspaces', {})
        );
        discoveredWorkspace = (discovered ?? []).find(entry => entry.workspaceId === this.workspace?.id);
      } catch {
        // Joined workspace records normally persist owner identity as well.
      }
    }
    const activeMembers = new Map<string, WorkspaceMemberInfo>();
    for (const member of members ?? []) {
      const peerId = this.cleanText(member.peerId);
      if (peerId) activeMembers.set(peerId, member);
    }
    const persistedOwnerPeerId = this.cleanText(this.workspace.ownerPeerId);
    const discoveredOwnerPeerId = this.cleanText(discoveredWorkspace?.ownerPeerId);
    const isJoinedMirror = this.workspace.joined === true || persistedOwnerPeerId !== undefined;
    const ownerPeerId = persistedOwnerPeerId
      ?? discoveredOwnerPeerId
      ?? (!isJoinedMirror ? this.localPeerId : undefined);
    const ownerName = ownerPeerId === this.localPeerId
      ? this.localPeerName
      : ownerPeerId === discoveredOwnerPeerId
        ? this.cleanText(discoveredWorkspace?.ownerName)
        : undefined;
    const addPeer = (value: unknown, activity: WorkspaceActivity, suppliedName?: string): void => {
      const peerId = this.cleanText(value);
      if (!peerId) return;
      const existing = this.peers.find(peer => peer.peerId === peerId);
      const member = activeMembers.get(peerId);
      const contact = contacts.get(peerId);
      const networkPeer = networkPeers.get(peerId);
      const isYou = peerId === this.localPeerId;
      const present = activeMembers.has(peerId);
      const row: PeerRow = {
        peerId,
        name: this.cleanText(suppliedName)
          ?? (isYou ? this.cleanText(this.localPeerName) : undefined)
          ?? this.cleanText(member?.peerName)
          ?? this.cleanText(contact?.name)
          ?? this.cleanText(networkPeer?.name)
          ?? this.cleanText(existing?.name)
          ?? previousNames.get(peerId)
          ?? peerId,
        connected: isYou || present || connected.has(peerId),
        role: isYou ? 'You' : peerId === ownerPeerId ? 'Owner' : 'Participant',
        activity: present || isYou ? 'Interacting' : activity,
        joinedAt: member?.joinedAt,
        lastSeen: contact?.lastSeen,
      };
      if (existing) Object.assign(existing, row);
      else this.peers.push(row);
    };

    if (accessMode === 'shared') {
      if (this.localPeerId) addPeer(this.localPeerId, 'Interacting');
      if (ownerPeerId) addPeer(ownerPeerId, 'Invited', ownerName);
      // Persisted participants are the authoritative shared-workspace roster.
      // The whitelist is retained as a compatibility source for older hosted records.
      for (const peerId of this.workspace.participants ?? []) addPeer(peerId, 'Invited');
      for (const peerId of this.workspace.whitelist ?? []) addPeer(peerId, 'Invited');
      for (const member of activeMembers.values()) addPeer(member.peerId, 'Interacting', member.peerName);
    } else {
      if (this.localPeerId) addPeer(this.localPeerId, 'Interacting');
      for (const peerId of connected) addPeer(peerId, 'Browsing');
      for (const member of activeMembers.values()) {
        if (connected.has(member.peerId) || activeMembers.has(member.peerId)) {
          addPeer(member.peerId, 'Interacting', member.peerName);
        }
      }
    }

    this.peers.sort((a, b) => {
      const roleRank = (peer: PeerRow): number => peer.role === 'Owner' ? 0 : peer.role === 'You' ? 1 : 2;
      const activityRank = (peer: PeerRow): number => peer.activity === 'Interacting' ? 0 : peer.activity === 'Browsing' ? 1 : 2;
      return roleRank(a) - roleRank(b)
        || activityRank(a) - activityRank(b)
        || (a.name ?? a.peerId).localeCompare(b.name ?? b.peerId);
    });
    const preservedSelection = selectedPeerId
      ? this.peers.findIndex(peer => peer.peerId === selectedPeerId)
      : -1;
    this.selectedPeerIndex = preservedSelection >= 0
      ? preservedSelection
      : this.peers.length > 0 ? 0 : -1;
    this.peerLoadState = this.peers.length > 0 ? 'ready' : 'empty';
    this.checkInvariants();
  }

  private async loadSelectedPeerCatalog(): Promise<void> {
    const selectedCatalogId = this.catalog[this.selectedCatalogIndex]
      ? this.catalogEntryId(this.catalog[this.selectedCatalogIndex], this.selectedCatalogIndex)
      : undefined;
    this.catalog = [];
    this.selectedCatalogIndex = -1;
    const peer = this.selectedPeer();
    if (!peer || !this.workspace?.registryId) {
      this.catalogLoadState = 'idle';
      return;
    }

    this.catalogLoadState = 'loading';
    try {
      // WorkspaceRegistry.list is the canonical union of local and synchronized
      // peer-owned registrations. Remote registrations retain their workspace
      // and owner provenance; local exposure is curated by the workspace record.
      const entries = await this.request<CatalogEntry[]>(
        request(this.id, this.workspace.registryId as AbjectId, 'list', {})
      );
      if (this.selectedPeer()?.peerId !== peer.peerId) return;

      const exposedIds = new Set(
        (this.workspace.exposedObjectIds ?? [])
          .map(value => this.cleanText(value))
          .filter((value): value is string => value !== undefined)
      );
      if (peer.peerId === this.localPeerId) {
        this.catalog = (entries ?? []).filter(entry => {
          const id = this.cleanText(entry.id);
          return id !== undefined && exposedIds.has(id);
        });
      } else {
        this.catalog = (entries ?? []).filter(entry =>
          this.cleanText(entry.ownerPeerId) === peer.peerId
          && this.cleanText(entry.workspaceId) === this.workspace?.id
        );
      }
      this.selectedCatalogIndex = selectedCatalogId
        ? this.catalog.findIndex((entry, index) => this.catalogEntryId(entry, index) === selectedCatalogId)
        : this.catalog.length > 0 ? 0 : -1;
      if (this.selectedCatalogIndex < 0 && this.catalog.length > 0) this.selectedCatalogIndex = 0;
      this.catalogLoadState = 'ready';
    } catch {
      this.catalogLoadState = 'error';
    }
  }

  private async buildUi(): Promise<void> {
    const manager = this.widgetManagerId!;
    const display = await this.request<{ width: number; height: number }>(
      request(this.id, manager, 'getDisplayInfo', {})
    );
    const width = 760;
    const height = 500;
    this.windowId = await this.request<AbjectId>(request(this.id, manager, 'createWindowAbject', {
      title: '👥 Peers',
      rect: {
        x: Math.max(20, Math.floor((display.width - width) / 2)),
        y: Math.max(20, Math.floor((display.height - height) / 2)),
        width,
        height,
      },
      zIndex: 200,
    }));
    this.rootLayoutId = await this.request<AbjectId>(request(this.id, manager, 'createVBox', {
      windowId: this.windowId,
      margins: { top: 6, right: 6, bottom: 6, left: 6 },
      spacing: 6,
    }));
    this.detailPaneId = await this.request<AbjectId>(request(this.id, manager, 'createDetachedScrollableVBox', {
      windowId: this.windowId,
      margins: { top: 6, right: 8, bottom: 6, left: 8 },
      spacing: 5,
    }));

    const created = await this.request<{ widgetIds: AbjectId[] }>(request(this.id, manager, 'create', {
      specs: [
        { type: 'button', windowId: this.windowId, rect: EMPTY_RECT, text: 'Refresh' },
        { type: 'list', windowId: this.windowId, rect: EMPTY_RECT, items: [] },
        { type: 'label', windowId: this.windowId, rect: EMPTY_RECT, text: '' },
        {
          type: 'splitPane',
          windowId: this.windowId,
          rect: EMPTY_RECT,
          orientation: 'horizontal',
          dividerPosition: 0.35,
          minSize: 180,
        },
      ],
    }));
    [this.refreshButtonId, this.peerListId, this.statusLabelId, this.splitPaneId] = created.widgetIds;

    await this.request(request(this.id, this.splitPaneId, 'setLeftChild', { widgetId: this.peerListId }));
    await this.request(request(this.id, this.splitPaneId, 'setRightChild', { widgetId: this.detailPaneId }));
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: this.refreshButtonId, sizePolicy: { vertical: 'fixed', horizontal: 'fixed' }, preferredSize: { width: 90, height: 28 } },
        { widgetId: this.splitPaneId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.statusLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 18 } },
      ],
    }));
    this.send(request(this.id, this.refreshButtonId, 'addDependent', {}));
    this.send(request(this.id, this.peerListId, 'addDependent', {}));
  }

  private async rebuildPeerList(): Promise<void> {
    if (!this.peerListId) return;
    const items: Array<{ label: string; value: string }> = this.peers.map(peer => {
      const status = peer.connected ? '●' : '○';
      return {
        label: `${status} ${this.peerLabel(peer)} — ${peer.role} • ${peer.activity}`,
        value: peer.peerId,
      };
    });
    if (items.length === 0) {
      let label: string;
      if (this.peerLoadState === 'loading') label = 'Loading peers…';
      else if (this.peerLoadState === 'error') label = 'Peer data unavailable';
      else if (this.peerLoadState === 'no-shared-workspace') label = 'Local workspace — peers unavailable';
      else if (this.effectiveAccessMode() === 'public') label = 'No connected peers';
      else label = 'No invited peers';
      items.push({ label, value: '' });
    }
    await this.request(request(this.id, this.peerListId, 'update', {
      items,
      selectedIndex: this.selectedPeerIndex,
    }));
  }

  private async rebuildDetailPane(): Promise<void> {
    const generation = ++this.detailRebuildGeneration;
    const rebuild = this.detailRebuildQueue.then(async () => {
      if (generation !== this.detailRebuildGeneration) return;
      await this.rebuildDetailPaneNow(generation);
    });
    this.detailRebuildQueue = rebuild.catch(() => undefined);
    await rebuild;
  }

  private async rebuildDetailPaneNow(generation: number): Promise<void> {
    if (!this.detailPaneId || !this.windowId) return;
    for (const widgetId of this.detailWidgetIds) this.send(request(this.id, widgetId, 'destroy', {}));
    this.detailWidgetIds = [];
    this.catalogListId = undefined;
    try {
      await this.request(request(this.id, this.detailPaneId, 'clearLayoutChildren', {}));
    } catch {
      // Best effort if the window is closing.
    }
    if (generation !== this.detailRebuildGeneration) return;

    const peer = this.selectedPeer();
    const lines: Array<{ text: string; heading?: boolean }> = [];
    let catalogItems: Array<{ label: string; value: string; secondary?: string }> = [];
    if (this.peerLoadState === 'loading') {
      lines.push({ text: 'Loading peers and workspace details…', heading: true });
    } else if (this.peerLoadState === 'error') {
      lines.push({ text: 'Peer data unavailable', heading: true });
      lines.push({ text: this.peerLoadError || 'The peer list could not be loaded. Try Refresh.' });
    } else if (this.peerLoadState === 'no-shared-workspace') {
      lines.push({ text: 'Peers unavailable for local workspaces', heading: true });
      lines.push({ text: 'Change this workspace to Shared or Public to see peer presence.' });
    } else if (!peer) {
      if (this.effectiveAccessMode() === 'public') {
        lines.push({ text: 'No connected peers', heading: true });
        lines.push({ text: 'Connected peers will appear here as browsing or interacting with this public workspace.' });
      } else {
        lines.push({ text: 'No invited peers', heading: true });
        lines.push({ text: 'Peers invited to this shared workspace will appear here, including when offline.' });
      }
    } else {
      lines.push({ text: this.peerLabel(peer), heading: true });
      lines.push({ text: `Status: ${peer.connected ? 'Connected' : 'Disconnected'}` });
      lines.push({ text: `Role: ${peer.role}` });
      lines.push({ text: `Workspace activity: ${peer.activity}` });
      if (peer.joinedAt) lines.push({ text: `Joined workspace: ${new Date(peer.joinedAt).toLocaleString()}` });
      if (!peer.connected && peer.lastSeen) lines.push({ text: `Last seen: ${new Date(peer.lastSeen).toLocaleString()}` });
      lines.push({ text: `Peer ID: ${peer.peerId}` });
      if (this.catalogLoadState === 'loading') {
        lines.push({ text: 'Loading exposed abjects…', heading: true });
      } else if (this.catalogLoadState === 'error') {
        lines.push({ text: 'Exposed abjects unavailable', heading: true });
        lines.push({ text: 'The workspace catalog for this peer could not be loaded.' });
      } else {
        lines.push({
          text: `Workspace-exposed abjects (${this.catalog.length})`,
          heading: true,
        });
        if (this.catalog.length === 0) {
          lines.push({ text: 'No abjects are exposed by this peer.' });
        } else {
          catalogItems = this.catalog.map((entry, index) => {
            const id = this.cleanText(entry.id);
            const name = this.cleanText(entry.manifest?.name)
              ?? this.cleanText(entry.name)
              ?? id
              ?? '(unnamed abject)';
            const description = this.cleanText(entry.manifest?.description)
              ?? this.cleanText(entry.description);
            return {
              label: name,
              value: id ?? `catalog-entry-${index}`,
              secondary: description ?? (id && id !== name ? id : undefined),
            };
          });
        }
      }
    }

    const labelSpecs = lines.map(line => ({
      type: 'label',
      windowId: this.windowId,
      rect: EMPTY_RECT,
      text: line.text,
      style: line.heading
        ? { fontSize: 13, fontWeight: 'bold', color: '#e8eef7', wordWrap: true, selectable: true }
        : { fontSize: 11, color: '#bac4d3', wordWrap: true, selectable: true },
    }));
    const specs: Array<Record<string, unknown>> = [...labelSpecs];
    const catalogListIndex = catalogItems.length > 0 ? specs.length : -1;
    if (catalogItems.length > 0) {
      specs.push({
        type: 'list',
        windowId: this.windowId,
        rect: EMPTY_RECT,
        items: catalogItems,
        selectedIndex: this.selectedCatalogIndex,
        searchable: true,
      });
      const selectedEntry = this.catalog[this.selectedCatalogIndex];
      if (selectedEntry) {
        const selectedId = this.cleanText(selectedEntry.id) ?? this.catalogEntryId(selectedEntry, this.selectedCatalogIndex);
        const selectedName = this.cleanText(selectedEntry.manifest?.name)
          ?? this.cleanText(selectedEntry.name)
          ?? selectedId;
        const selectedDescription = this.cleanText(selectedEntry.manifest?.description)
          ?? this.cleanText(selectedEntry.description)
          ?? 'No description provided.';
        specs.push(
          {
            type: 'label', windowId: this.windowId, rect: EMPTY_RECT,
            text: selectedName,
            style: { fontSize: 12, fontWeight: 'bold', color: '#e8eef7', wordWrap: true, selectable: true },
          },
          {
            type: 'label', windowId: this.windowId, rect: EMPTY_RECT,
            text: selectedDescription,
            style: { fontSize: 11, color: '#bac4d3', wordWrap: true, selectable: true },
          },
        );
        specs.push({
          type: 'label', windowId: this.windowId, rect: EMPTY_RECT,
          text: `Abject ID: ${selectedId}`,
          style: { fontSize: 10, color: '#8995a7', wordWrap: true, selectable: true },
        });
      }
    }

    const created = await this.request<{ widgetIds: AbjectId[] }>(request(this.id, this.widgetManagerId!, 'create', {
      specs,
    }));
    if (generation !== this.detailRebuildGeneration) {
      for (const widgetId of created.widgetIds) this.send(request(this.id, widgetId, 'destroy', {}));
      return;
    }
    this.detailWidgetIds = created.widgetIds;
    if (catalogListIndex >= 0) {
      this.catalogListId = created.widgetIds[catalogListIndex];
      await this.request(request(this.id, this.catalogListId, 'addDependent', {}));
    }
    await this.request(request(this.id, this.detailPaneId, 'addLayoutChildren', {
      children: this.detailWidgetIds.map((widgetId, index) => index === catalogListIndex
        ? {
            widgetId,
            sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
          }
        : {
            widgetId,
            sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
            preferredSize: { height: index > catalogListIndex && catalogListIndex >= 0 ? 44 : 20 },
          }),
    }));
  }

  private catalogEntryId(entry: CatalogEntry, index: number): string {
    return this.cleanText(entry.id) ?? `catalog-entry-${index}`;
  }

  private async updateStatus(): Promise<void> {
    if (!this.statusLabelId) return;
    const text = this.peerLoadState === 'loading'
      ? 'Loading peer data…'
      : this.peerLoadState === 'error'
        ? 'Peer data unavailable — use Refresh to retry.'
        : this.peerLoadState === 'no-shared-workspace'
          ? 'Active workspace is local-only.'
          : this.workspace
            ? this.effectiveAccessMode() === 'public'
              ? `${this.workspaceLabel()} • Public • ${this.peers.filter(peer => peer.connected).length} connected • ${this.peers.filter(peer => peer.activity === 'Interacting').length} interacting`
              : `${this.workspaceLabel()} • Shared • ${this.peers.length} invited • ${this.peers.filter(peer => peer.connected).length} connected`
            : 'No active workspace.';
    await this.request(request(this.id, this.statusLabelId, 'update', { text }));
  }

  private readIndex(value: unknown, depth = 0): number | undefined {
    if (depth > 4) return undefined;
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string') {
      const text = value.trim();
      if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
      try {
        return this.readIndex(JSON.parse(text), depth + 1);
      } catch {
        return undefined;
      }
    }
    if (!value || typeof value !== 'object') return undefined;
    const payload = value as Record<string, unknown>;
    for (const key of ['selectedIndex', 'index', 'value']) {
      const index = this.readIndex(payload[key], depth + 1);
      if (index !== undefined) return index;
    }
    return undefined;
  }

  private isClick(aspect: string): boolean {
    return aspect === 'clicked' || aspect === 'click' || aspect === 'pressed' || aspect === 'activated';
  }

  private async handleWidgetEvent(from: AbjectId, aspect: string, payload: Record<string, unknown>): Promise<void> {
    if (from === this.refreshButtonId && this.isClick(aspect)) {
      await this.refresh();
      return;
    }
    const index = this.readIndex(payload);
    if (from === this.peerListId && aspect === 'selectionChanged'
      && index !== undefined && index >= 0 && index < this.peers.length) {
      // WidgetManager can deliver the same selection through both the specific
      // event and its generic changed envelope. The first delivery owns the
      // load/rebuild; later deliveries for the same peer are no-ops.
      if (index === this.selectedPeerIndex) return;
      this.selectedPeerIndex = index;
      this.catalog = [];
      this.selectedCatalogIndex = -1;
      this.catalogLoadState = 'loading';
      await this.rebuildDetailPane();
      await this.loadSelectedPeerCatalog();
      await this.rebuildDetailPane();
      this.checkInvariants();
      return;
    }
    if (from === this.catalogListId && aspect === 'selectionChanged'
      && index !== undefined && index >= 0 && index < this.catalog.length) {
      if (index === this.selectedCatalogIndex) return;
      this.selectedCatalogIndex = index;
      await this.rebuildDetailPane();
      this.checkInvariants();
    }
  }
}

export const PEERS_VIEWER_ID = 'abjects:peers-viewer' as AbjectId;
