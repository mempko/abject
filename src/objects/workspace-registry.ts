/**
 * WorkspaceRegistry — a Registry that chains to a fallback (global) registry
 * on discovery miss. Each workspace gets its own WorkspaceRegistry holding
 * workspace-scoped objects, while shared system objects are found via the
 * fallback chain.
 *
 * Two chaining strategies are mixed:
 *   - `discover` / `getSource` / `updateSource` / `updateManifest` chain
 *     "fallback only on miss" because lookups want one answer (a name or id
 *     resolves to one Abject — its source is part of that identity, so an
 *     object spawned without a registryHint into the global registry must be
 *     just as readable and editable through the workspace registry).
 *   - `list` / `listSummaries` always merge local + fallback because callers
 *     (CommandPalette, ProcessExplorer, AppExplorer-style UIs) need the
 *     complete picture: workspace-local Abjects *and* system services.
 *   - `listLocal` never chains: it answers "which objects does THIS workspace
 *     own?". Callers deciding lifecycle (WorkspaceManager's delete sweep) must
 *     use it, or they mistake global system objects for workspace children.
 */

import { AbjectId, AbjectManifest, AbjectMessage, DEFAULT_SHARING_POLICY, DiscoveryQuery, InterfaceId, ObjectRegistration, SharingPolicy, TypeId } from '../core/types.js';
import { require } from '../core/contracts.js';
import { Registry } from './registry.js';
import { request } from '../core/message.js';

const WORKSPACE_REGISTRY_INTERFACE = 'abjects:workspace-registry' as InterfaceId;
void WORKSPACE_REGISTRY_INTERFACE;

/** One line per search hit — same shape the base Registry's `search` returns. */
export interface RegistrySearchHit {
  id: AbjectId;
  name: string;
  typeId?: TypeId;
  description: string;
  matchedOn: string;
  /** Present when the hit is a pooled object owned by a peer. */
  ownerPeerId?: string;
}

export interface RemoteObjectRegistration extends ObjectRegistration {
  ownerPeerId?: string;
  workspaceId?: string;
  workspaceName?: string;
}

export class WorkspaceRegistry extends Registry {
  private fallbackRegistryId?: AbjectId;
  /** Cached catalog from the global registry, refreshed in onInit / setFallback. */
  private _globalCatalogCache = '';
  /**
   * Remote pooled objects from peer workspaces. This catalog is the ONLY local
   * record of a peer's object: nothing is ever mounted on this bus under a
   * remote AbjectId. A message addressed to one of these ids finds no local
   * mailbox and falls through to PeerRouter's MessageInterceptor, which routes
   * it to the owning peer from its own route table.
   *
   * The division of labour: this catalog answers "what is out there and who
   * owns it"; PeerRouter answers "how do I reach it".
   */
  private remotePooledObjects: Map<AbjectId, RemoteObjectRegistration> = new Map();

  /** Pending debounce for a global-catalog refresh triggered by a change event. */
  private globalRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  /** The fallback registry we already hold a subscription with. */
  private fallbackSubscribedTo: AbjectId | null = null;

  /** The bus once we are initialized; `this.bus` throws before that. */
  private get busIfReady() {
    try {
      return this.bus;
    } catch {
      return null;
    }
  }

  /**
   * Whether a catalogued id is one PeerRouter is expected to carry to its
   * owner — the addressability check that replaces "is a stand-in mounted".
   *
   * Only a Shared-Live entry with a named owning peer qualifies. A 'replicated'
   * entry is catalogued precisely so peers can inspect and fork it; routing a
   * call to the owner would be the opposite of what that policy asks for. A
   * 'user-local' entry should never have reached this catalog at all — if an
   * older peer sends one anyway, it stays visible but unaddressable.
   *
   * This is a statement about policy and ownership only. Whether the peer is
   * connected and a route is actually held is PeerRouter's question to answer,
   * at the moment a message is intercepted.
   */
  private isRemotelyAddressable(objectId: AbjectId): boolean {
    const reg = this.remotePooledObjects.get(objectId);
    if (!reg?.manifest) return false;
    if (!reg.ownerPeerId) return false;
    return this.sharingPolicyOf(reg.manifest) === 'shared-live';
  }

  protected override async onStop(): Promise<void> {
    if (this.globalRefreshTimer) {
      clearTimeout(this.globalRefreshTimer);
      this.globalRefreshTimer = null;
    }
    await super.onStop();
  }

  /**
   * A caller is local only when it is genuinely on this host. Anything wearing
   * a remote identity — a pooled catalog id, or a registration stamped with an
   * owning peer — is remote no matter what the bus says about its mailbox.
   *
   * With stand-ins gone, no remote object holds a mailbox here, so the base
   * check's `bus.isRegistered()` has narrowed back to meaning "strictly local".
   * The two branches below are kept as the authoritative record regardless: a
   * peer's id must read as remote on its own evidence, before the bus is ever
   * consulted.
   */
  protected override isLocalCaller(callerId: AbjectId): boolean {
    if (this.remotePooledObjects.has(callerId)) return false;
    const local = this.lookupObject(callerId) as RemoteObjectRegistration | null;
    if (local?.ownerPeerId) return false;
    return super.isLocalCaller(callerId);
  }

  /** Mirror of base Registry's META_METHODS (private upstream, so we can't
   * reuse it directly); used when we recompute summaries locally because we
   * replaced the base handler. */
  private static readonly META_METHODS_LOCAL = new Set([
    'describe', 'ask', 'getRegistry', 'ping',
    'addDependent', 'removeDependent',
    'getSource', 'updateSource', 'probe',
  ]);

  constructor() {
    super();
    this.setupWorkspaceHandlers();
  }

  private setupWorkspaceHandlers(): void {
    this.on('setFallback', async (msg: AbjectMessage) => {
      const { registryId } = msg.payload as { registryId: AbjectId };
      this.fallbackRegistryId = registryId;
      this.subscribeToFallback();
      await this.refreshGlobalCatalog();
      return true;
    });

    // The fallback (global) registry notifies its subscribers whenever its
    // catalog moves. Without these the global cache was built exactly once, at
    // onInit, and every system object spawned afterwards was invisible to ask.
    const onFallbackChanged = async (msg: AbjectMessage) => {
      if (msg.routing.from !== this.fallbackRegistryId) return;
      this.scheduleGlobalCatalogRefresh();
    };
    this.on('objectRegistered', onFallbackChanged);
    this.on('objectUnregistered', onFallbackChanged);
    this.on('objectUpdated', onFallbackChanged);
    this.on('manifestUpdated', onFallbackChanged);
    this.on('changed', onFallbackChanged);

    // Override getSource / updateSource / updateManifest to chain on local
    // miss. Resolution is by identity, not by which registry holds the entry:
    // an object spawned without a registryHint lands in the fallback (global)
    // registry, and its source must still be readable (load_target's fetch)
    // and its cached source/manifest writable (deploy_update's cache sync)
    // through the workspace registry. Forward the original payload verbatim —
    // getSource/updateSource accept objectId | typeId | name | ref, and the
    // fallback resolves by the same rules.
    // The registry this one falls back to. Callers that need to identify a
    // GLOBAL object (a system service calling into a workspace) have to be able
    // to reach it, and `lookup` deliberately does not chain: several callers
    // use a miss to mean "not in this workspace".
    this.on('getFallbackRegistry', async () => this.fallbackRegistryId ?? null);

    this.on('getSource', async (msg: AbjectMessage) => {
      const { objectId, typeId, name, ref } = msg.payload as {
        objectId?: string; typeId?: string; name?: string; ref?: string;
      };
      const key = ref ?? objectId ?? typeId ?? name ?? '';
      // P2-1: a remote caller reads only the curated set, and never chains to
      // the global registry.
      if (this.isRemoteCaller(msg)) {
        const reg = this.resolveRegistration(key) ?? this.remotePooledObjects.get(key as AbjectId) ?? null;
        return this.isExposedToRemote(reg) ? (reg?.source ?? null) : null;
      }
      const local = this.getObjectSource(key);
      if (local !== null) return local;
      if (!this.fallbackRegistryId) return null;
      try {
        return await this.request<string | null>(
          request(this.id, this.fallbackRegistryId, 'getSource', msg.payload as Record<string, unknown>),
        );
      } catch {
        return null;
      }
    });

    this.on('updateSource', async (msg: AbjectMessage) => {
      this.denyRemoteWrite(msg, 'updateSource');
      const { objectId, typeId, name, ref, source } = msg.payload as {
        objectId?: string; typeId?: string; name?: string; ref?: string; source: string;
      };
      const reg = this.resolveRegistration(ref ?? objectId ?? typeId ?? name ?? '');
      if (reg) {
        reg.source = source;
        return true;
      }
      if (!this.fallbackRegistryId) return false;
      try {
        return await this.request<boolean>(
          request(this.id, this.fallbackRegistryId, 'updateSource', msg.payload as Record<string, unknown>),
        );
      } catch {
        return false;
      }
    });

    this.on('updateManifest', async (msg: AbjectMessage) => {
      this.denyRemoteWrite(msg, 'updateManifest');
      const { objectId, manifest } = msg.payload as { objectId: AbjectId; manifest: AbjectManifest };
      if (this.lookupObject(objectId)) {
        return this.updateManifestRegistration(objectId, manifest);
      }
      if (!this.fallbackRegistryId) return false;
      try {
        return await this.request<boolean>(
          request(this.id, this.fallbackRegistryId, 'updateManifest', msg.payload as Record<string, unknown>),
        );
      } catch {
        return false;
      }
    });

    // Remote pooling handlers
    this.on('registerRemote', async (msg: AbjectMessage) => {
      const payload = msg.payload as {
        object?: ObjectRegistration;
        registration?: ObjectRegistration;
        objectId?: AbjectId;
        manifest?: AbjectManifest;
        name?: string;
        typeId?: TypeId;
        source?: string;
        ownerPeerId?: string;
        workspaceId?: string;
        workspaceName?: string;
      };
      return this.registerRemote(payload);
    });

    this.on('unregisterRemote', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: AbjectId };
      return this.unregisterRemote(objectId);
    });

    this.on('unregisterRemoteForPeer', async (msg: AbjectMessage) => {
      const { peerId, workspaceId } = msg.payload as { peerId: string; workspaceId?: string };
      return this.unregisterRemoteForPeer(peerId, workspaceId);
    });

    this.on('unregisterRemoteForWorkspace', async (msg: AbjectMessage) => {
      const { workspaceId } = msg.payload as { workspaceId: string };
      return this.unregisterRemoteForWorkspace(workspaceId);
    });

    this.on('resolveUri', async (msg: AbjectMessage) => {
      const { uri } = msg.payload as { uri: string };
      const reg = await this.resolveUri(uri);
      // P2-1: URI resolution is a read of the catalog like any other — a
      // remote caller may only resolve into the curated set.
      if (this.isRemoteCaller(msg)) return this.isExposedToRemote(reg) ? reg : null;
      return reg;
    });

    this.on('lookup', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: AbjectId };
      const local = this.lookupObject(objectId);
      // P2-1: no fallback chaining and no uncurated hits for a remote caller.
      if (this.isRemoteCaller(msg)) {
        const reg = local ?? this.remotePooledObjects.get(objectId) ?? null;
        return this.isExposedToRemote(reg) ? reg : null;
      }
      if (local) return local;
      const remote = this.remotePooledObjects.get(objectId);
      if (remote) return remote;
      if (!this.fallbackRegistryId) return null;
      try {
        return await this.request<ObjectRegistration | null>(
          request(this.id, this.fallbackRegistryId, 'lookup', { objectId }),
        );
      } catch {
        return null;
      }
    });

    // Override list / listSummaries to union local + remote pooled + global
    // fallback — but only for a LOCAL caller. A remote caller gets the curated
    // slice of local ∪ pooled and no fallback chaining at all: the global
    // registry (LLMObject, HttpClient, Storage, PeerRouter …) is this host's
    // business, never a peer's.
    this.on('list', async (msg: AbjectMessage) => {
      const caller = msg.routing.from;
      const union = this.localAndPooled();
      if (!this.isLocalCaller(caller)) {
        return this.filterForCaller(union, caller);
      }
      const remote = await this.fallbackList();
      return mergeById(union, remote);
    });

    this.on('listSummaries', async (msg: AbjectMessage) => {
      const caller = msg.routing.from;
      const local = this.localListSummaries() as Array<{ id?: string }>;
      const pooled = this.pooledListSummaries() as Array<{ id?: string }>;
      const union = mergeById(local, pooled);
      if (!this.isLocalCaller(caller)) {
        const allowed = new Set(
          this.filterForCaller(this.localAndPooled(), caller).map((reg) => reg.id as string),
        );
        return union.filter((s) => s.id !== undefined && allowed.has(s.id));
      }
      const remote = await this.fallbackListSummaries();
      return mergeById(union, remote as Array<{ id?: string }>);
    });

    // Compact text search over local ∪ pooled. The base Registry scores only
    // its own catalog, so a pooled peer object was unfindable through search
    // even though `discover` could reach it. Chaining mirrors handleDiscover:
    // fall back to the global registry ONLY on empty results and ONLY for a
    // local caller — a remote caller gets the curated slice of local ∪ pooled
    // and never sees the global registry.
    this.on('search', async (msg: AbjectMessage) => {
      const caller = msg.routing.from;
      const { query, limit } = msg.payload as { query?: string; limit?: number };
      require(typeof query === 'string' && query.trim().length > 0, 'query must be a non-empty string');
      const max = typeof limit === 'number' && limit > 0 ? Math.min(limit, 50) : 10;
      const local = this.isLocalCaller(caller);
      const union = local
        ? this.localAndPooled()
        : this.filterForCaller(this.localAndPooled(), caller);
      const hits = this.scoreSearch(union, query as string, max);
      if (hits.length > 0 || !local) return hits;
      return this.fallbackSearch(query as string, max);
    });

    // Local-only listing — deliberately does NOT chain to pooled remote or fallback.
    this.on('listLocal', async () => this.listLocal());

    // --- Object lifecycle taxonomy -----------------------------------------
    // Registry-side actions for inspecting, copying, and re-classifying
    // objects. A UI (the collaborator inspector) or an agent drives sharing
    // through these rather than reaching into the catalog directly.
    this.on('listShareable', async () => this.listShareable());

    this.on('listRemote', async () => this.listRemote());

    this.on('inspectRemote', async (msg: AbjectMessage) => {
      // P2-1: inspection reveals a full manifest + source; a peer inspecting
      // this host's catalog is refused outright (it may inspect through its
      // own registry's pooled copy of what we curated to it).
      this.denyRemoteWrite(msg, 'inspectRemote');
      const payload = msg.payload as { ref?: string; uri?: string; objectId?: AbjectId };
      return this.inspectRemote(payload);
    });

    // fork and clone are one operation under two names: 'clone' matches
    // Factory's vocabulary for copying an object, 'fork' names the cross-peer
    // case where the copy leaves its owner behind and diverges.
    const forkHandler = async (msg: AbjectMessage) => {
      // One handler serves two names; name the method the caller actually
      // invoked in the refusal so a refused 'cloneRemote' does not report
      // itself as 'forkRemote'.
      this.denyRemoteWrite(msg, msg.routing.method ?? 'forkRemote');
      const payload = msg.payload as {
        ref?: string; uri?: string; objectId?: AbjectId; withData?: boolean; name?: string;
      };
      return this.forkRemote(payload);
    };
    this.on('forkRemote', forkHandler);
    this.on('cloneRemote', forkHandler);

    this.on('setSharingPolicy', async (msg: AbjectMessage) => {
      this.denyRemoteWrite(msg, 'setSharingPolicy');
      const { objectId, policy } = msg.payload as { objectId: AbjectId; policy: SharingPolicy };
      return this.setSharingPolicy(objectId, policy);
    });

    this.on('getSharingPolicy', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: AbjectId };
      const reg = this.lookupObject(objectId) ?? this.remotePooledObjects.get(objectId) ?? null;
      return reg ? this.sharingPolicyOf(reg.manifest) : null;
    });
  }

  /**
   * Set the fallback registry (typically the global Registry).
   */
  setFallback(globalRegistryId: AbjectId): void {
    this.fallbackRegistryId = globalRegistryId;
  }

  protected override async onInit(): Promise<void> {
    await super.onInit();
    this.subscribeToFallback();
    await this.refreshGlobalCatalog();
  }

  /** Local ∪ pooled, merged by id — the full set this workspace can speak for. */
  private localAndPooled(): ObjectRegistration[] {
    return mergeById(
      this.listObjects(),
      Array.from(this.remotePooledObjects.values()) as ObjectRegistration[],
    );
  }

  /**
   * Rank registrations against a substring query exactly as the base Registry's
   * `search` does: name > tags > description > method names, ties broken by name.
   */
  private scoreSearch(regs: ObjectRegistration[], query: string, max: number): RegistrySearchHit[] {
    const q = query.toLowerCase();
    const hits: Array<{ rank: number; hit: RegistrySearchHit }> = [];
    for (const reg of regs) {
      const m = reg.manifest;
      if (!m) continue;
      const name = (reg.name ?? m.name) ?? '';
      const tags = (m.tags ?? []).join(' ');
      const methods = (m.interface?.methods ?? [])
        .filter((method) => !WorkspaceRegistry.META_METHODS_LOCAL.has(method.name))
        .map((method) => method.name);
      let rank: number | undefined;
      let matchedOn: string | undefined;
      if (name.toLowerCase().includes(q)) { rank = 0; matchedOn = 'name'; }
      else if (tags.toLowerCase().includes(q)) { rank = 1; matchedOn = 'tags'; }
      else if ((m.description ?? '').toLowerCase().includes(q)) { rank = 2; matchedOn = 'description'; }
      else if (methods.some((mn) => mn.toLowerCase().includes(q))) { rank = 3; matchedOn = 'methods'; }
      if (rank === undefined) continue;
      const owner = (reg as RemoteObjectRegistration).ownerPeerId;
      hits.push({
        rank,
        hit: {
          id: reg.id,
          name,
          typeId: reg.typeId,
          description: (m.description ?? '').slice(0, 160),
          matchedOn: matchedOn as string,
          ...(owner ? { ownerPeerId: owner } : {}),
        },
      });
    }
    hits.sort((a, b) => a.rank - b.rank || a.hit.name.localeCompare(b.hit.name));
    return hits.slice(0, max).map((h) => h.hit);
  }

  /** Miss-only chain: ask the global registry the same question. */
  private async fallbackSearch(query: string, max: number): Promise<RegistrySearchHit[]> {
    if (!this.fallbackRegistryId) return [];
    try {
      const res = await this.request<RegistrySearchHit[]>(
        request(this.id, this.fallbackRegistryId, 'search', { query, limit: max }),
      );
      return Array.isArray(res) ? res : [];
    } catch {
      return [];
    }
  }

  /**
   * What goes into the ask prompt's main catalog. A remote caller sees the
   * curated slice of local ∪ pooled; a local caller gets the local objects here
   * and the pooled ones in their own labelled section (see askPromptFor).
   */
  protected override catalogForCaller(callerId?: AbjectId): ObjectRegistration[] {
    if (callerId && !this.isLocalCaller(callerId)) {
      return this.filterForCaller(this.localAndPooled(), callerId);
    }
    return this.listObjects();
  }

  /**
   * Override ask catalog: a LOCAL caller sees the workspace's own objects, the
   * objects pooled in from joined peer workspaces, and the global registry's
   * system capabilities (ShellExecutor, HttpClient …). A REMOTE caller sees
   * only the curated set — the global catalog is omitted entirely.
   */
  protected override askPromptFor(question: string, callerId?: AbjectId): string {
    const base = super.askPromptFor(question, callerId);
    if (callerId && !this.isLocalCaller(callerId)) return base;

    let out = base;

    const pooled = this.pooledPromptSection();
    if (pooled) {
      out += `\n\n## Shared Objects (peer workspaces)\n\n` +
        `These live on a joined peer and are callable from here by id or name.\n\n${pooled}`;
    }

    if (this.fallbackRegistryId && this._globalCatalogCache) {
      out += `\n## System Capabilities (global registry)\n\n${this._globalCatalogCache}`;
    }

    return out;
  }

  /** One line per pooled peer object: durable name, typeId, capabilities, owner. */
  private pooledPromptSection(): string {
    const lines: string[] = [];
    for (const reg of this.remotePooledObjects.values()) {
      const m = reg.manifest;
      const name = reg.name ?? m.name;
      const parts: string[] = [`- **${name}**`];
      if (reg.typeId) parts.push(`(typeId: ${reg.typeId})`);
      parts.push(`: ${m.description ?? ''}`);
      const methods = (m.interface?.methods ?? [])
        .filter((method) => !WorkspaceRegistry.META_METHODS_LOCAL.has(method.name))
        .map((method) => method.name)
        .join(', ');
      let line = parts.join(' ');
      const caps = (m.providedCapabilities ?? []).join(', ');
      if (caps) line += ` Capabilities: ${caps}.`;
      if (methods) line += ` Methods: ${methods}.`;
      if (reg.ownerPeerId) line += ` Owner peer: ${reg.ownerPeerId}.`;
      if (reg.workspaceName) line += ` Workspace: ${reg.workspaceName}.`;
      lines.push(line);
    }
    return lines.join('\n');
  }

  /**
   * Subscribe to the fallback registry's change events so the global catalog
   * cache tracks it instead of freezing at boot. Idempotent: re-subscribing is
   * a set insert on the other side.
   */
  private subscribeToFallback(): void {
    if (!this.fallbackRegistryId) return;
    if (this.fallbackSubscribedTo === this.fallbackRegistryId) return;
    const target = this.fallbackRegistryId;
    try {
      this.send(request(this.id, target, 'subscribe', {}));
      this.fallbackSubscribedTo = target;
    } catch {
      // not on the bus yet — onInit will retry
    }
  }

  /** Coalesce bursts of registry churn into one catalog rebuild. */
  private scheduleGlobalCatalogRefresh(): void {
    if (this.globalRefreshTimer) return;
    this.globalRefreshTimer = setTimeout(() => {
      this.globalRefreshTimer = null;
      void this.refreshGlobalCatalog();
    }, 250);
  }

  /**
   * Register a remote pooled object from a peer workspace.
   */
  public registerRemote(entry: {
    object?: ObjectRegistration;
    registration?: ObjectRegistration;
    objectId?: AbjectId;
    manifest?: AbjectManifest;
    name?: string;
    typeId?: TypeId;
    source?: string;
    ownerPeerId?: string;
    workspaceId?: string;
    workspaceName?: string;
  }): boolean {
    const reg = entry.object ?? entry.registration;
    const id = (reg?.id ?? entry.objectId) as AbjectId;
    if (!id) return false;
    const manifest = reg?.manifest ?? entry.manifest;
    if (!manifest) return false;
    // Inbound half of the policy gate. The sender is supposed to filter these
    // out before they hit the wire (WorkspaceShareRegistry does), but a catalog
    // arriving from an older peer must not be able to plant a private object here.
    if (this.sharingPolicyOf(manifest) === 'user-local') return false;

    const remoteObj: RemoteObjectRegistration = {
      id,
      typeId: reg?.typeId ?? entry.typeId,
      name: reg?.name ?? entry.name ?? manifest.name,
      manifest,
      source: reg?.source ?? entry.source,
      status: (reg?.status ?? 'active') as any,
      registeredAt: reg?.registeredAt ?? Date.now(),
      ownerPeerId: entry.ownerPeerId ?? (reg as RemoteObjectRegistration)?.ownerPeerId,
      workspaceId: entry.workspaceId ?? (reg as RemoteObjectRegistration)?.workspaceId,
      workspaceName: entry.workspaceName ?? (reg as RemoteObjectRegistration)?.workspaceName,
    };

    this.remotePooledObjects.set(id, remoteObj);
    // Nothing is mounted locally for this id: `this.send(id)` finds no local
    // mailbox, and PeerRouter's interceptor carries it to the owning peer.
    // Pooling on its own emits nothing, so a catalog delta arriving while a
    // subscriber's window is already open would leave it stale. Mirror the base
    // registry's register notification to repaint AppExplorer's Shared tab.
    void this.notifySubscribers('objectRegistered', remoteObj);
    return true;
  }

  /**
   * Unregister a remote pooled object.
   */
  public unregisterRemote(objectId: AbjectId): boolean {
    const removed = this.remotePooledObjects.delete(objectId);
    // Same reasoning as registerRemote: tell subscribers the peer's object left.
    if (removed) void this.notifySubscribers('objectUnregistered', objectId);
    return removed;
  }

  /**
   * Drop every remote entry a peer contributed, optionally narrowed to one
   * workspace. WorkspaceShareRegistry calls this when a peer disconnects and
   * before a full catalog re-sync, so a departed peer's objects do not linger
   * in the catalog as addressable entries.
   */
  public unregisterRemoteForPeer(peerId: string, workspaceId?: string): number {
    let removed = 0;
    for (const [id, reg] of Array.from(this.remotePooledObjects)) {
      if (reg.ownerPeerId !== peerId) continue;
      if (workspaceId && reg.workspaceId !== workspaceId) continue;
      if (this.unregisterRemote(id)) removed++;
    }
    return removed;
  }

  /** Drop every remote entry belonging to a workspace we left or unshared. */
  public unregisterRemoteForWorkspace(workspaceId: string): number {
    let removed = 0;
    for (const [id, reg] of Array.from(this.remotePooledObjects)) {
      if (reg.workspaceId !== workspaceId) continue;
      if (this.unregisterRemote(id)) removed++;
    }
    return removed;
  }

  /**
   * Enumerate only locally owned objects in this workspace registry.
   */
  public listLocal(): ObjectRegistration[] {
    return this.listObjects();
  }

  /**
   * Locally owned objects minus the private ones. This is what may be published
   * to peers; `listLocal` stays unfiltered because lifecycle callers (the
   * workspace delete sweep) must still see every object this workspace owns.
   */
  public listShareable(): ObjectRegistration[] {
    return this.listObjects().filter((reg) => this.sharingPolicyOf(reg.manifest) !== 'user-local');
  }

  /**
   * The declared policy, or the default. Read defensively: a manifest can come
   * off the wire from a peer running an older build with no `sharing` field, or
   * with a value this build does not know.
   */
  private sharingPolicyOf(manifest?: AbjectManifest): SharingPolicy {
    const declared = manifest?.sharing;
    if (declared === 'shared-live' || declared === 'replicated' || declared === 'user-local') {
      return declared;
    }
    return DEFAULT_SHARING_POLICY;
  }

  /** Every remote catalog entry, described for inspection. */
  public listRemote(): Record<string, unknown>[] {
    return Array.from(this.remotePooledObjects.values()).map((reg) => this.describeRegistration(reg));
  }

  /**
   * Inspect one object — local or remote — by id, name, or abject:// URI.
   * Reports its policy, its lineage, and whether it is actually reachable
   * live, which is the distinction a caller needs before deciding to call it
   * or fork it.
   */
  public async inspectRemote(req: { ref?: string; uri?: string; objectId?: AbjectId }): Promise<Record<string, unknown> | null> {
    const ref = req.ref ?? req.uri ?? (req.objectId as string | undefined) ?? '';
    require(ref.length > 0, 'inspectRemote requires ref, uri, or objectId');
    const reg = await this.resolveUri(ref);
    if (!reg) return null;
    return this.describeRegistration(reg);
  }

  private describeRegistration(reg: ObjectRegistration): Record<string, unknown> {
    const meta = reg as RemoteObjectRegistration;
    const policy = this.sharingPolicyOf(reg.manifest);
    return {
      id: reg.id,
      typeId: reg.typeId,
      name: reg.name ?? reg.manifest.name,
      description: reg.manifest.description,
      version: reg.manifest.version,
      icon: reg.manifest.icon,
      tags: reg.manifest.tags ?? [],
      status: reg.status,
      policy,
      remote: this.remotePooledObjects.has(reg.id),
      // Live means the id is routable to its owner: PeerRouter carries calls
      // to this id across the wire. A replicated entry is visible, not callable.
      live: this.isRemotelyAddressable(reg.id),
      canFork: policy !== 'user-local',
      hasSnapshot: reg.data !== undefined,
      ownerPeerId: meta.ownerPeerId,
      workspaceId: meta.workspaceId,
      workspaceName: meta.workspaceName,
      lineage: reg.manifest.lineage,
      methods: (reg.manifest.interface?.methods ?? [])
        .filter((m) => !WorkspaceRegistry.META_METHODS_LOCAL.has(m.name))
        .map((m) => ({ name: m.name, description: m.description })),
    };
  }

  /**
   * Fork a remote (or local) object into THIS workspace: a snapshot copy that
   * carries its own identity and diverges from the original from here on. This
   * is the Replicated/Cloned half of the taxonomy, as against Shared-Live's
   * proxy — nothing about the fork stays coupled to the owner.
   *
   * The copy's manifest records where it came from: clonedFrom/generation as
   * Factory.clone already does, plus the origin peer and workspace so a
   * population of forks spread across a mesh stays traceable to its source.
   */
  public async forkRemote(req: {
    ref?: string; uri?: string; objectId?: AbjectId; withData?: boolean; name?: string;
  }): Promise<{ ok: boolean; objectId?: AbjectId; reason?: string; lineage?: AbjectManifest['lineage'] }> {
    const ref = req.ref ?? req.uri ?? (req.objectId as string | undefined) ?? '';
    require(ref.length > 0, 'forkRemote requires ref, uri, or objectId');

    const reg = await this.resolveUri(ref);
    if (!reg) {
      return { ok: false, reason: `Object '${ref}' not found locally or in any joined peer catalog` };
    }

    const policy = this.sharingPolicyOf(reg.manifest);
    if (policy === 'user-local') {
      return { ok: false, reason: `'${reg.name ?? reg.manifest.name}' is user-local and cannot be copied` };
    }

    const meta = reg as RemoteObjectRegistration;
    const data = req.withData === false ? undefined : await this.snapshotFor(reg);

    const lineage: AbjectManifest['lineage'] = {
      clonedFrom: (reg.typeId as string | undefined) ?? (reg.id as string),
      generation: (reg.manifest.lineage?.generation ?? 0) + 1,
      originPeerId: meta.ownerPeerId,
      originWorkspaceId: meta.workspaceId,
      originWorkspaceName: meta.workspaceName,
      forkedAt: Date.now(),
      forkedFromRemote: !!meta.ownerPeerId,
    };

    const manifest: AbjectManifest = {
      ...reg.manifest,
      name: req.name ?? reg.manifest.name,
      lineage,
      // A fork must not inherit 'shared-live': that stance says "I am the one
      // authoritative instance", and the copy is not. It becomes replicated —
      // visible and forkable in turn, but never proxied as the original.
      sharing: policy === 'shared-live' ? 'replicated' : policy,
    };

    const factoryId = await this.resolveFactory();
    if (!factoryId) return { ok: false, reason: 'Factory not reachable — cannot spawn the fork' };

    // registryHint lands the fork in THIS workspace registry, which is the
    // whole point: the copy belongs to us, not to the workspace it came from.
    const spawnReq: Record<string, unknown> = { manifest, registryHint: this.id };
    if (reg.source) spawnReq.source = reg.source;
    if (data !== undefined) spawnReq.data = data;

    try {
      const result = await this.request<{ objectId: AbjectId; status?: string }>(
        request(this.id, factoryId, 'spawn', spawnReq),
      );
      return { ok: true, objectId: result?.objectId, lineage };
    } catch (err) {
      return { ok: false, reason: `spawn failed: ${(err as Error)?.message ?? String(err)}` };
    }
  }

  /**
   * Best snapshot available for a fork. A live getState is preferred when the
   * object exposes one and is actually reachable (locally, or as a Shared-Live
   * id routed to its owner, where this becomes a real round trip).
   * Otherwise the catalog copy stands — which is exactly what a 'replicated'
   * object publishes it for, and all a peer has once the owner goes offline.
   */
  private async snapshotFor(reg: ObjectRegistration): Promise<Record<string, unknown> | undefined> {
    const catalogData = reg.data ? this.deepCopy(reg.data) : undefined;

    const exposesGetState = (reg.manifest.interface?.methods ?? []).some((m) => m.name === 'getState');
    const reachable = this.isRemotelyAddressable(reg.id) || (this.busIfReady?.isRegistered(reg.id) ?? false);
    if (exposesGetState && reachable) {
      try {
        const live = await this.request<unknown>(request(this.id, reg.id, 'getState', {}));
        if (live && typeof live === 'object') {
          const copied = this.deepCopy(live as Record<string, unknown>);
          if (copied !== undefined) return copied;
        }
      } catch {
        // Owner offline, or the object refused — fall back to the catalog copy.
      }
    }
    return catalogData;
  }

  /** JSON deep copy so the fork's data shares nothing with the original's. */
  private deepCopy(value: Record<string, unknown>): Record<string, unknown> | undefined {
    try {
      return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    } catch {
      return undefined; // non-serializable state — the fork starts empty rather than failing
    }
  }

  /** Factory, looked up once and cached. */
  private _factoryId?: AbjectId;

  private async resolveFactory(): Promise<AbjectId | null> {
    if (this._factoryId) return this._factoryId;
    try {
      this._factoryId = (await this.discoverDep('Factory')) ?? undefined;
    } catch {
      this._factoryId = undefined;
    }
    return this._factoryId ?? null;
  }

  /**
   * Re-classify a locally owned object. Narrowing away from 'shared-live'
   * changes what peers are told at the next announce/catalog sync; there is no
   * local stand-in to tear down, because remote reachability lives entirely in
   * PeerRouter's route table and the exposure whitelist it announces.
   */
  public setSharingPolicy(objectId: AbjectId, policy: SharingPolicy): boolean {
    require(
      policy === 'shared-live' || policy === 'replicated' || policy === 'user-local',
      `Unknown sharing policy '${policy}'`,
    );
    const reg = this.lookupObject(objectId);
    if (!reg) return false;
    void this.updateManifestRegistration(objectId, { ...reg.manifest, sharing: policy });
    return true;
  }

  /**
   * Resolve an abject URI supporting 'abject://[peer]/[workspace]/[object]',
   * URN 'abject:<id>', or name/slug/UUID lookup.
   */
  public async resolveUri(uri: string): Promise<ObjectRegistration | null> {
    if (!uri) return null;

    // 1. URN formats: 'abject:<id>', 'abjects:<id>'
    if (uri.startsWith('abject:') && !uri.startsWith('abject://')) {
      const id = uri.slice('abject:'.length).replace(/^\/+/, '');
      return this.resolveByIdOrName(id);
    }
    if (uri.startsWith('abjects:')) {
      return this.resolveByIdOrName(uri);
    }

    // 2. URI format: 'abject://[peer]/[workspace]/[object]' or 'abject://[object]'
    if (uri.startsWith('abject://')) {
      const rawPath = uri.slice('abject://'.length);
      const parts = rawPath.split('/').filter((p) => p.length > 0);

      if (parts.length === 1) {
        return this.resolveByIdOrName(parts[0]);
      }
      if (parts.length === 2) {
        return this.resolveByPath(parts[0], undefined, parts[1]);
      }
      if (parts.length >= 3) {
        return this.resolveByPath(parts[0], parts[1], parts[2]);
      }
    }

    // Fallback direct reference
    return this.resolveByIdOrName(uri);
  }

  private async resolveByIdOrName(ref: string): Promise<ObjectRegistration | null> {
    const local = this.resolveRegistration(ref);
    if (local) return local;

    for (const reg of this.remotePooledObjects.values()) {
      if (matchesRef(ref, reg)) return reg;
    }

    if (this.fallbackRegistryId) {
      try {
        const remote = await this.request<ObjectRegistration | null>(
          request(this.id, this.fallbackRegistryId, 'lookup', { objectId: ref as AbjectId }),
        );
        if (remote) return remote;
      } catch {
        // fallback lookup failure
      }
    }
    return null;
  }

  private async resolveByPath(
    peerPart: string,
    wsPart: string | undefined,
    objectPart: string,
  ): Promise<ObjectRegistration | null> {
    const isWildcard = (s?: string) => !s || s === '*' || s === '' || s === '~' || s === 'local';

    // Check local objects if peer is wildcard/local
    const localMatches = this.listObjects().filter((reg) => matchesRef(objectPart, reg));
    if (localMatches.length > 0 && isWildcard(peerPart)) {
      return localMatches[0];
    }

    // Check remote pooled objects
    for (const reg of this.remotePooledObjects.values()) {
      if (!matchesRef(objectPart, reg)) continue;

      const peerMatch =
        isWildcard(peerPart) ||
        (reg.ownerPeerId && matchesSlugOrExact(peerPart, reg.ownerPeerId));

      const wsMatch =
        wsPart === undefined ||
        isWildcard(wsPart) ||
        (reg.workspaceId && matchesSlugOrExact(wsPart, reg.workspaceId)) ||
        (reg.workspaceName && matchesSlugOrExact(wsPart, reg.workspaceName));

      if (peerMatch && wsMatch) {
        return reg;
      }
    }

    if (localMatches.length > 0) {
      return localMatches[0];
    }

    return this.resolveByIdOrName(objectPart);
  }

  private discoverRemoteObjects(query: DiscoveryQuery): ObjectRegistration[] {
    const results: ObjectRegistration[] = [];
    for (const reg of this.remotePooledObjects.values()) {
      if (query.name && reg.name !== query.name && reg.manifest.name !== query.name) {
        continue;
      }
      if (query.interface && reg.manifest.interface.id !== query.interface) {
        continue;
      }
      if (query.capability && !reg.manifest.providedCapabilities?.includes(query.capability as any)) {
        continue;
      }
      if (query.tags && query.tags.length > 0) {
        const regTags = new Set(reg.manifest.tags);
        if (!query.tags.every((t) => regTags.has(t))) {
          continue;
        }
      }
      results.push(reg);
    }
    return results;
  }

  /**
   * Override discover: query local + remote pooled objects, chain to fallback on miss.
   */
  protected override async handleDiscover(query: DiscoveryQuery): Promise<ObjectRegistration[]> {
    const local = this.discoverObjects(query);
    const remote = this.discoverRemoteObjects(query);
    const combined = mergeById(local, remote);
    if (combined.length > 0) return combined;

    if (this.fallbackRegistryId) {
      try {
        const fallback = await this.request<ObjectRegistration[]>(
          request(this.id, this.fallbackRegistryId, 'discover', query),
        );
        return mergeById(combined, fallback);
      } catch {
        return combined;
      }
    }

    return combined;
  }

  private async refreshGlobalCatalog(): Promise<void> {
    if (!this.fallbackRegistryId) return;
    try {
      const objects = await this.request<ObjectRegistration[]>(
        request(this.id, this.fallbackRegistryId, 'list', {}),
      );
      this._globalCatalogCache = objects
        .map((reg) => {
          const m = reg.manifest;
          const methods = m.interface.methods
            .filter((method) => !['describe', 'ask', 'ping', 'addDependent', 'removeDependent', 'checkHealth'].includes(method.name))
            .map((method) => method.name)
            .join(', ');
          let line = `- **${reg.name ?? m.name}**: ${m.description}`;
          if (methods) line += ` Methods: ${methods}`;
          return line;
        })
        .join('\n');
    } catch {
      // Keep existing cache on failure
    }
  }

  /**
   * Re-implement summary computation here because base Registry's `toSummary`
   * is private; structurally identical so callers see one shape.
   */
  private localListSummaries(): unknown[] {
    return this.listObjects().map((reg) => {
      const m = reg.manifest;
      const methods = m.interface.methods
        .filter((method) => !WorkspaceRegistry.META_METHODS_LOCAL.has(method.name))
        .map((method) => method.name);
      return {
        id: reg.id,
        typeId: reg.typeId,
        name: reg.name ?? m.name,
        description: m.description,
        methods,
        tags: m.tags,
      };
    });
  }

  private async fallbackList(): Promise<ObjectRegistration[]> {
    if (!this.fallbackRegistryId) return [];
    try {
      return await this.request<ObjectRegistration[]>(
        request(this.id, this.fallbackRegistryId, 'list', {}),
      );
    } catch {
      return [];
    }
  }

  private async fallbackListSummaries(): Promise<unknown[]> {
    if (!this.fallbackRegistryId) return [];
    try {
      return await this.request<unknown[]>(
        request(this.id, this.fallbackRegistryId, 'listSummaries', {}),
      );
    } catch {
      return [];
    }
  }

  private pooledListSummaries(): unknown[] {
    return Array.from(this.remotePooledObjects.values()).map((reg) => {
      const m = reg.manifest;
      const methods = m.interface.methods
        .filter((method) => !WorkspaceRegistry.META_METHODS_LOCAL.has(method.name))
        .map((method) => method.name);
      return {
        id: reg.id,
        typeId: reg.typeId,
        name: reg.name ?? m.name,
        description: m.description,
        methods,
        tags: m.tags,
        ownerPeerId: reg.ownerPeerId,
        workspaceId: reg.workspaceId,
        workspaceName: reg.workspaceName,
      };
    });
  }
}

/**
 * Merge two arrays by `id`, preserving local order first. Defensive against
 * malformed entries that lack an id.
 */
function mergeById<T extends { id?: string }>(local: T[], remote: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of local) {
    if (item.id) seen.add(item.id);
    out.push(item);
  }
  for (const item of remote) {
    if (item.id && seen.has(item.id)) continue;
    out.push(item);
  }
  return out;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
}

function matchesSlugOrExact(query: string, value: string): boolean {
  if (query === value) return true;
  if (query.toLowerCase() === value.toLowerCase()) return true;
  if (slugify(query) === slugify(value)) return true;
  return false;
}

function matchesRef(ref: string, reg: ObjectRegistration): boolean {
  if (reg.id === ref) return true;
  if (reg.typeId && reg.typeId === ref) return true;
  if (reg.name && matchesSlugOrExact(ref, reg.name)) return true;
  if (reg.manifest.name && matchesSlugOrExact(ref, reg.manifest.name)) return true;
  if (reg.manifest.interface.id === ref) return true;
  return false;
}

export const WORKSPACE_REGISTRY_ID = 'abjects:workspace-registry' as AbjectId;
