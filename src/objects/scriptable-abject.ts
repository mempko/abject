/**
 * ScriptableAbject — an Abject whose behavior is defined by an editable JavaScript handler map.
 *
 * Source format is a parenthesized object expression:
 *   ({
 *     greet(msg) {
 *       const { name } = msg.payload;
 *       return { greeting: 'Hello, ' + name + '!' };
 *     }
 *   })
 *
 * Handler functions run in a Sandbox (src/core/sandbox.ts): a context of their
 * own where `this` offers this.call(), this.dep(), this.find(), this.changed(),
 * this.emit(), this.observe(), this.saveData() and the live this.id and
 * this.data. Nothing of the real Abject or of Node crosses in: messages,
 * replies and data cross as copies, and each stretch of handler code runs
 * under a time limit.
 */

import { withKeyedLock } from '../core/keyed-lock.js';
import {
  AbjectId,
  AbjectManifest,
  AbjectMessage,
  MethodDeclaration,
  EventDeclaration,
  InterfaceId,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require as contractRequire } from '../core/contracts.js';
import { request, event } from '../core/message.js';
import { INTROSPECT_METHODS, INTROSPECT_EVENTS } from '../core/introspect.js';
import { Sandbox, SandboxSourceError, type SandboxOutcome } from '../core/sandbox.js';
import { isPackageOwner, packageNameOf } from '../core/packages.js';
import { Log } from '../core/timed-log.js';
import { bytesToHex } from '../core/encoding.js';

const log = new Log('ScriptableAbject');

/** Editable methods merged into every ScriptableAbject's interface */
/**
 * Description given to a manifest method that the runtime declared on the
 * object's behalf because its source registers the handler and nothing had
 * described it. Authoring tools look for this prefix to know which methods
 * still need a real description.
 */
export const SOURCE_DECLARED_DESCRIPTION = "Registered by this object's source.";

const EDITABLE_METHODS: MethodDeclaration[] = [
  {
    name: 'updateManifest',
    description: 'Replace this object\'s self-description (description, icon, tags, interface methods and events) with a redrafted one. Handlers the source registers stay declared whatever the draft says, and declarations for handlers the source lacks are dropped; the accepted manifest is published to the Registry. Owner, ObjectCreator, AbjectEditor, and AbjectStore may call it.',
    parameters: [
      { name: 'manifest', type: { kind: 'object' as const, properties: {} }, description: 'The new manifest ({ name, description, version, icon?, interface: { id, name, description, methods, events? }, tags? })' },
    ],
    returns: { kind: 'object' as const, properties: {} },
  },
  {
    name: 'getSource',
    description: 'Get the current handler source code',
    parameters: [],
    returns: { kind: 'primitive' as const, primitive: 'string' as const },
  },
  {
    name: 'getData',
    description: 'Get a deep copy of this object\'s internal data (the same record source code mutates as this.data).',
    parameters: [],
    returns: { kind: 'object' as const, properties: {} },
  },
  {
    name: 'persistSnapshot',
    description: 'Persist the current source and internal data, then read back the durable receipt. expectedSource rejects a stale deployment.',
    parameters: [{ name: 'expectedSource', description: 'Expected live source', optional: true, type: { kind: 'primitive' as const, primitive: 'string' as const } }],
    returns: { kind: 'object' as const, properties: { success: { kind: 'primitive' as const, primitive: 'boolean' as const } } },
  },
  {
    name: 'updateSource',
    description: 'Replace handler source code at runtime',
    parameters: [
      {
        name: 'source',
        type: { kind: 'primitive' as const, primitive: 'string' as const },
        description: 'New handler map source',
      },
    ],
    returns: {
      kind: 'object' as const,
      properties: {
        success: { kind: 'primitive' as const, primitive: 'boolean' as const },
        error: { kind: 'primitive' as const, primitive: 'string' as const },
      },
    },
  },
  {
    name: 'probe',
    description: 'Validate that all dependencies referenced in source can be resolved',
    parameters: [],
    returns: {
      kind: 'object' as const,
      properties: {
        success: { kind: 'primitive' as const, primitive: 'boolean' as const },
        resolvedDeps: { kind: 'array' as const, elementType: { kind: 'primitive' as const, primitive: 'string' as const } },
        missingDeps: { kind: 'array' as const, elementType: { kind: 'primitive' as const, primitive: 'string' as const } },
        error: { kind: 'primitive' as const, primitive: 'string' as const },
      },
    },
  },
];

const EDITABLE_EVENTS: EventDeclaration[] = [
  {
    name: 'sourceUpdated',
    description: 'Emitted when source code is successfully updated',
    payload: { kind: 'object' as const, properties: {
      objectId: { kind: 'primitive' as const, primitive: 'string' as const },
      methods: { kind: 'array' as const, elementType: { kind: 'primitive' as const, primitive: 'string' as const } },
    }},
  },
];

/**
 * Compute the merged manifest for a ScriptableAbject without constructing one.
 * Merges editable methods/events and the 'scriptable' tag, matching the constructor logic.
 * Also merges introspect methods/events (same as Abject constructor).
 */
export function mergeScriptableManifest(manifest: AbjectManifest): AbjectManifest {
  const tags = [...(manifest.tags ?? [])];
  if (!tags.includes('scriptable')) tags.push('scriptable');

  const iface = manifest.interface;
  const allMethods = [...iface.methods, ...EDITABLE_METHODS];
  const allEvents = [...(iface.events ?? []), ...EDITABLE_EVENTS];

  // Also merge introspect methods/events (same as Abject constructor)
  const hasDescribe = allMethods.some(m => m.name === 'describe');
  const finalMethods = hasDescribe ? allMethods : [...allMethods, ...INTROSPECT_METHODS];
  const hasChildReady = allEvents.some(e => e.name === 'childReady');
  const finalEvents = hasChildReady ? allEvents : [...allEvents, ...INTROSPECT_EVENTS];

  return {
    ...manifest,
    interface: { ...iface, methods: finalMethods, events: finalEvents },
    tags,
  };
}

/**
 * An Abject whose handlers are compiled from a JavaScript source string.
 * Supports live editing: new source can be applied at runtime without restarting.
 */
export class ScriptableAbject extends Abject {
  private _source: string;
  private _owner: AbjectId;
  /** Runs the installed source; `this.data` lives inside it. */
  private sandbox!: Sandbox;
  /** What the sandbox's source installed, kept for a rollback to it. */
  private handlerList: HandlerList = [];
  /** Every function the source defines, message handler or not. */
  private _handlerFunctions: Set<string> = new Set();
  /** The last copy of `this.data` read out, for when the sandbox cannot answer. */
  private _lastData: Record<string, unknown>;
  private activeUserCalls = 0;
  private activating = false;
  /** Whether a `show` call (by message) left the object on screen; `hide` clears it. */
  private _showing = false;
  private _userMethods: Set<string> = new Set();
  private _depCache: Record<string, AbjectId> = {};

  // Coalesced saveData state: at most one save in flight, one queued.
  private static readonly SAVE_MIN_INTERVAL_MS = 1000;
  private _saveTail: Promise<void> = Promise.resolve();
  private _pendingSave?: { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void };
  private _lastSaveStart = 0;
  private _storeId?: AbjectId;
  /**
   * Set for a package abject spawned at system scope: its registry has no
   * AbjectStore, so its data is kept by the Packages service instead.
   */
  private _packagesId?: AbjectId;
  /** That data's first load, in flight; settled once it has been read. */
  private _packageDataLoad?: Promise<void>;
  private _packageDataLoaded = false;

  constructor(
    manifest: AbjectManifest,
    source: string,
    owner: AbjectId,
    data?: Record<string, unknown>,
  ) {
    const tags = [...(manifest.tags ?? [])];
    if (!tags.includes('scriptable')) {
      tags.push('scriptable');
    }

    // Merge editable methods and events into the single interface
    const iface = manifest.interface;
    super({
      manifest: {
        ...manifest,
        interface: {
          ...iface,
          methods: [...iface.methods, ...EDITABLE_METHODS],
          events: [...(iface.events ?? []), ...EDITABLE_EVENTS],
        },
        tags,
      },
    });

    this._source = source;
    this._owner = owner;
    // Internal data clones with the object via Factory.clone, snapshot restore,
    // and respawn. Source code mutates it as `this.data`; persistence is
    // explicit via `await this.saveData()`.
    this._lastData = data ?? {};

    this.compileAndInstall(source, this._lastData);
    this.setupEditableHandlers();
  }

  get source(): string {
    return this._source;
  }

  get owner(): AbjectId {
    return this._owner;
  }

  /**
   * A copy of the internal data record. Used by Factory/AbjectStore to read
   * what should be persisted or carried with a clone.
   */
  get dataSnapshot(): Record<string, unknown> {
    return this.readData();
  }

  protected override askPrompt(question: string): string {
    let prompt = super.askPrompt(question);
    if (this._source) prompt += '\n\nSource code:\n' + this._source;
    const data = this.readData();
    if (Object.keys(data).length > 0) {
      let dataJson: string;
      try {
        dataJson = JSON.stringify(data, null, 2);
      } catch {
        dataJson = '(non-serializable)';
      }
      // Cap at ~2 KB so a large data record doesn't drown the prompt.
      if (dataJson.length > 2048) dataJson = dataJson.slice(0, 2048) + '\n…(truncated)';
      prompt += '\n\nInternal data (this.data):\n' + dataJson;
    }
    prompt += '\n\nYou are this object. Your capabilities are exactly what the manifest and source code above describe. Answer questions based on your actual capabilities, not hypothetical ones.';
    return prompt;
  }

  /** The source's own `ask` answers when it has one; super.ask(msg) there is the answer above. */
  protected override async handleAsk(question: string, callerId?: AbjectId, msg?: AbjectMessage): Promise<string> {
    if (!this._handlerFunctions.has('ask')) return super.handleAsk(question, callerId, msg);
    const call = msg ?? ({ payload: { question }, routing: { from: callerId, method: 'ask' } } as unknown as AbjectMessage);
    try {
      const answer = await this.invokeUserHandler('ask', call);
      if (typeof answer === 'string') return answer;
      if (answer === undefined || answer === null) return `(${this.manifest.name}'s ask returned no answer)`;
      return JSON.stringify(answer);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(`[${this.manifest.name}] its ask handler failed: ${reason}`);
      return `${this.manifest.name}'s own ask handler failed: ${reason}`;
    }
  }

  /**
   * The source's own `describe` says what the object is, as a description
   * string or an object of fields; the reply always carries the real
   * manifest, since other objects learn from it how to call this one. A
   * describe that fails gives the system's description instead.
   */
  protected override handleDescribe(msg: AbjectMessage): unknown {
    const base = super.handleDescribe(msg) as { manifest: AbjectManifest; description: string };
    if (!this._handlerFunctions.has('describe')) return base;
    return (async () => {
      try {
        const own = await this.invokeUserHandler('describe', msg);
        if (typeof own === 'string') return { ...base, description: own };
        if (own !== null && typeof own === 'object' && !Array.isArray(own)) {
          const fields = own as Record<string, unknown>;
          return { ...fields, manifest: this.manifest, description: typeof fields.description === 'string' ? fields.description : base.description };
        }
        log.warn(`[${this.manifest.name}] its describe returned neither a string nor an object; using the system's description`);
      } catch (err) {
        log.warn(`[${this.manifest.name}] its describe failed (${err instanceof Error ? err.message : String(err)}); using the system's description`);
      }
      return base;
    })();
  }

  /**
   * Get a dependency ID by name via Registry discovery.
   * Results are cached so subsequent calls for the same name are instant.
   */
  async dep(name: string): Promise<AbjectId> {
    if (name in this._depCache) return this._depCache[name];
    const id = await this.requireDep(name);
    this._depCache[name] = id;
    return id;
  }

  /**
   * Find an object by name via Registry discovery. Returns null if not found.
   * Supports qualified names:
   *   'ObjectName'                    — local registry
   *   'workspace.ObjectName'          — specific local workspace
   *   'peer.workspace.ObjectName'     — remote peer's workspace
   */
  async find(name: string): Promise<AbjectId | null> {
    const parts = name.split('.');
    if (parts.length === 3) {
      return this.findInRemoteWorkspace(parts[0], parts[1], parts[2]);
    }
    if (parts.length === 2) {
      return this.findInLocalWorkspace(parts[0], parts[1]);
    }
    return this.discoverDep(name);
  }

  private async findInRemoteWorkspace(
    ownerName: string, workspaceName: string, objectName: string,
  ): Promise<AbjectId | null> {
    const cacheKey = `remote:${ownerName}.${workspaceName}.${objectName}`;
    if (cacheKey in this._depCache) return this._depCache[cacheKey];
    try {
      const wsrId = await this.discoverDep('WorkspaceShareRegistry');
      if (!wsrId) return null;
      const workspaces = await this.request<Array<{
        ownerName: string; name: string; registryId: string;
      }>>(request(this.id, wsrId, 'getDiscoveredWorkspaces', {}));
      const ws = workspaces.find(w => w.ownerName === ownerName && w.name === workspaceName);
      if (!ws) return null;
      const results = await this.request<Array<{ id: AbjectId }>>(
        request(this.id, ws.registryId as AbjectId, 'discover', { name: objectName })
      );
      if (results.length > 0) {
        this._depCache[cacheKey] = results[0].id;
        return results[0].id;
      }
    } catch { /* peer offline */ }
    return null;
  }

  private async findInLocalWorkspace(
    workspaceName: string, objectName: string,
  ): Promise<AbjectId | null> {
    const cacheKey = `local:${workspaceName}.${objectName}`;
    if (cacheKey in this._depCache) return this._depCache[cacheKey];
    try {
      // Workspace registries are registered as "WorkspaceRegistry:<name>"
      const wsRegId = await this.discoverDep(`WorkspaceRegistry:${workspaceName}`);
      if (!wsRegId) return null;
      const results = await this.request<Array<{ id: AbjectId }>>(
        request(this.id, wsRegId, 'discover', { name: objectName })
      );
      if (results.length > 0) {
        this._depCache[cacheKey] = results[0].id;
        return results[0].id;
      }
    } catch { /* workspace not found */ }
    return null;
  }

  /** Keep synchronous UI handlers synchronous while tracking async work for activation. */
  private invokeUserHandler(name: string, msg: AbjectMessage): unknown {
    // A system-scope package abject's data arrives before its first handler
    // runs; after that this path is synchronous again.
    const loading = this.packageDataReady();
    if (loading) return loading.then(() => this.invokeUserHandler(name, msg));
    if (this.activating) throw new Error('Source activation in progress; retry against the committed revision');
    this.activeUserCalls++;
    const method = msg.routing.method;
    const lifecycle = method === 'show' || method === 'hide';
    let outcome: SandboxOutcome;
    try {
      outcome = this.sandbox.invoke(name, [msg]);
    } catch (err) {
      this.activeUserCalls--;
      throw err;
    }
    if (!outcome.sync) {
      return outcome.promise.then((value) => {
        if (lifecycle) this._showing = method === 'show';
        return value;
      }).finally(() => { this.activeUserCalls--; });
    }
    if (lifecycle) this._showing = method === 'show';
    this.activeUserCalls--;
    return outcome.value;
  }

  private setupEditableHandlers(): void {
    this.on('persistSnapshot', async msg => withKeyedLock(`${this.id}:source-activation`, async () => {
      const { expectedSource } = msg.payload as { expectedSource?: string };
      if (expectedSource !== undefined && expectedSource !== this._source) return { success: false, conflict: true, error: 'Source changed before persistence' };
      await this.saveData();
      if (this._packagesId) {
        // A system-scope package abject: its source is the package's, and its
        // data is what Packages now holds.
        const data = await this.request<Record<string, unknown> | null>(request(this.id, this._packagesId, 'getPackageData', {}));
        return { success: true, source: this._source, data: data ?? {} };
      }
      const saved = await this.request<{ source: string; data?: Record<string, unknown> } | null>(request(this.id, this._storeId!, 'getDurableSnapshot', { objectId: this.id }));
      if (!saved || saved.source !== this._source) throw new Error('Durable source does not match the live deployment');
      return { success: true, source: saved.source, data: saved.data ?? {} };
    }));
    this.on('getSource', () => {
      return this._source;
    });

    this.on('getData', async () => {
      await this.packageDataReady();
      // A copy: callers can't mutate the live record.
      return this.readData();
    });

    // Prototype replication across peers: return everything needed to grow an
    // independent copy of this object elsewhere (manifest + source + optional
    // data), signed by this peer's identity so the copy carries verifiable
    // provenance. Reachability is the access gate: a remote caller can only
    // send this message if the workspace's share mode and whitelist already
    // admit it, so replicate answers whoever can already talk to the object.
    // The receiving side spawns the payload locally via its own Factory
    // (spawn with { manifest, source, data }).
    this.on('replicate', async (msg: AbjectMessage) => {
      const { withData } = (msg.payload ?? {}) as { withData?: boolean };
      const data: Record<string, unknown> | undefined = withData !== false ? this.readData() : undefined;
      const manifest = {
        ...this.manifest,
        lineage: {
          clonedFrom: (this.typeId as string | undefined) ?? (this.id as string),
          generation: (this.manifest.lineage?.generation ?? 0) + 1,
        },
      };

      // Provenance signature: hash of name+version+source, signed by this
      // peer's identity. Absent identity, the payload replicates unsigned.
      let origin: { peerId?: string; signature?: string; signedAt: number } = {
        signedAt: Date.now(),
      };
      try {
        const identityId = await this.discoverDep('Identity');
        if (identityId) {
          const digestSrc = new TextEncoder().encode(
            `${manifest.name}@${manifest.version}\n${this._source}`);
          const digestBuf = await crypto.subtle.digest('SHA-256', digestSrc as BufferSource);
          const digest = bytesToHex(digestBuf);
          const signature = await this.request<string>(
            request(this.id, identityId, 'sign', { data: digest }));
          const identity = await this.request<{ peerId?: string }>(
            request(this.id, identityId, 'getIdentity', {}));
          origin = { peerId: identity?.peerId, signature, signedAt: Date.now() };
        }
      } catch { /* identity unavailable; replicate unsigned */ }

      return { manifest, source: this._source, data, origin };
    });

    this.on('probe', async () => {
      // Extract dep('...') and find('...') references from source
      // Match both this.dep() and bare dep() forms
      const depPattern = /(?:this\.)?dep\(\s*['"]([^'"]+)['"]\s*\)/g;
      const findPattern = /(?:this\.)?find\(\s*['"]([^'"]+)['"]\s*\)/g;
      const depNames = new Set<string>();
      let match: RegExpExecArray | null;
      while ((match = depPattern.exec(this._source)) !== null) depNames.add(match[1]);
      while ((match = findPattern.exec(this._source)) !== null) depNames.add(match[1]);

      // Qualified names (containing dots) are validated at runtime, not probe time
      const qualifiedNames = new Set<string>();
      for (const name of depNames) {
        if (name.includes('.')) qualifiedNames.add(name);
      }
      for (const name of qualifiedNames) depNames.delete(name);

      const resolved: string[] = [...qualifiedNames];
      const missing: string[] = [];

      for (const name of depNames) {
        const id = await this.find(name);
        if (id) {
          resolved.push(name);
        } else {
          missing.push(name);
        }
      }

      if (missing.length > 0) {
        return {
          success: false,
          resolvedDeps: resolved,
          missingDeps: missing,
          error: `Missing dependencies: ${missing.join(', ')}`,
        };
      }
      return { success: true, resolvedDeps: resolved, missingDeps: [], error: '' };
    });

    this.on('updateManifest', async (msg: AbjectMessage) => {
      const { manifest: draft } = msg.payload as { manifest?: Partial<AbjectManifest> };
      if (!draft || typeof draft !== 'object' || !draft.interface || !Array.isArray(draft.interface.methods)) {
        return { success: false, error: 'updateManifest requires { manifest } with an interface that has a methods array' };
      }
      const fromPackage = this.packageRefusal('manifest');
      if (fromPackage) return fromPackage;
      if (!(await this.senderMayEdit(msg.routing.from))) {
        return { success: false, error: `Only the owner (${this._owner || 'none'}), ObjectCreator, AbjectEditor, or AbjectStore may update the manifest (sender: ${msg.routing.from})` };
      }
      const live = this.manifest;
      if (typeof draft.description === 'string' && draft.description.trim()) live.description = draft.description;
      if (typeof draft.version === 'string' && draft.version.trim()) live.version = draft.version;
      if (typeof draft.icon === 'string') live.icon = draft.icon;
      if (Array.isArray(draft.tags)) {
        const tags = draft.tags.filter((t): t is string => typeof t === 'string');
        if (!tags.includes('scriptable')) tags.push('scriptable');
        live.tags = tags;
      }
      const iface = live.interface;
      if (typeof draft.interface.description === 'string') iface.description = draft.interface.description;
      // The drafted methods, then the editable methods every scriptable object
      // has, without duplicates; the source then has the last word on which
      // handlers actually exist.
      const drafted = draft.interface.methods.filter((m): m is MethodDeclaration => !!m && typeof m.name === 'string' && typeof m.description === 'string')
        .map(m => ({ ...m, parameters: Array.isArray(m.parameters) ? m.parameters : [] }));
      const seen = new Set(drafted.map(m => m.name));
      iface.methods = [...drafted, ...EDITABLE_METHODS.filter(m => !seen.has(m.name))];
      if (Array.isArray(draft.interface.events)) iface.events = draft.interface.events;
      const { added, removed } = this.reconcileManifestWithSource(new Set(this._userMethods));
      this.publishManifest();
      log.info(`[${this.manifest.name}] manifest replaced by ${msg.routing.from.slice(0, 8)}: ${iface.methods.length} methods` +
        `${added.length > 0 ? `; source added ${added.join(', ')}` : ''}${removed.length > 0 ? `; dropped ${removed.join(', ')}` : ''}`);
      return { success: true, methods: iface.methods.map(m => m.name), sourceDeclared: added, dropped: removed };
    });

    this.on('updateSource', async (msg: AbjectMessage) => {
      const { source, expectedSource } = msg.payload as { source: string; expectedSource?: string };
      const fromPackage = this.packageRefusal('source');
      if (fromPackage) {
        log.warn(`updateSource rejected for package abject '${this.manifest.name}' (sender ${msg.routing.from})`);
        return fromPackage;
      }
      if (msg.routing.from !== this._owner) {
        // Ownership may be stale after restart (ObjectCreator gets new ID each session).
        // Resolve the current ObjectCreator, AbjectEditor, and AbjectStore via
        // registry and accept if the sender matches any (the store applies
        // version restores).
        const creatorId = await this.discoverDep('ObjectCreator');
        const editorId = await this.discoverDep('AbjectEditor');
        const storeId = await this.discoverDep('AbjectStore');
        if (msg.routing.from !== creatorId && msg.routing.from !== editorId && msg.routing.from !== storeId) {
          log.warn(
            `updateSource rejected: ${msg.routing.from} is not owner ${this._owner}`
          );
          return {
            success: false,
            error:
              `Only the owner can update source (owner: ${this._owner || 'none — this object was spawned without one'}; sender: ${msg.routing.from}). ` +
              'ObjectCreator, AbjectEditor, and AbjectStore are also accepted and take over ownership. ' +
              'Agents: route the edit through ObjectCreator — its edit_source / deploy_update local actions carry owner context, ' +
              'while a direct updateSource call from a job never will.',
          };
        }
        // Adopt sender as owner — except the store, whose version restores
        // are maintenance, not a claim on the object.
        if (msg.routing.from !== storeId) {
          this._owner = msg.routing.from;
        }
      }

      return withKeyedLock(`${this.id}:source-activation`, async () => {
        if (expectedSource !== undefined && expectedSource !== this._source) return { success: false, conflict: true, error: 'Source changed since the expected base; read it and reconcile' };
        return this.activateSource(source, msg, { announce: true, interrupt: false });
      });
    });

    // HeapMonitor's call when this object's sandbox holds more memory than one
    // object may (src/objects/heap-monitor.ts). A restart brings the same
    // source up in a fresh sandbox with `this.data` carried across, which
    // frees whatever the code piled up outside its data. When a restart did
    // not free it, HeapMonitor asks for `stop`: the object stops for this
    // session and its saved copy is kept, so it loads again next time.
    this.on('freeMemory', async (msg: AbjectMessage) => {
      if (!await this.isBuiltInCaller(msg.routing.from, ['HeapMonitor'])) {
        return { success: false, error: 'Only HeapMonitor restarts or stops an object for the memory it holds' };
      }
      const { stop, heldBytes, limitBytes } = msg.payload as { stop?: boolean; heldBytes: number; limitBytes: number };
      const mb = (n: number): string => `${Math.round(n / (1024 * 1024))} MB`;
      const name = this.manifest.name;
      if (stop) {
        log.error(`[${name}] held ${mb(heldBytes)} again soon after a restart (one object may hold ${mb(limitBytes)}); stopping it, its saved copy kept`);
        void this.notify(`${name} filled up its memory again right after a restart (${mb(heldBytes)}), so it was stopped to keep everything else running. Its saved copy is kept, and it loads again next time.`, 'warning', 15_000);
        const factoryId = await this.discoverDep('Factory');
        if (!factoryId) return { success: false, error: 'Factory unavailable' };
        // An event, not a request: the reply would come back to an object
        // that has just stopped.
        this.send(event(this.id, factoryId, 'kill', { objectId: this.id, keepSnapshot: true }));
        return { success: true, stopped: true };
      }
      const result = await withKeyedLock(`${this.id}:source-activation`, () =>
        this.activateSource(this._source, msg, { announce: false, interrupt: true }));
      if (!result.success) {
        log.warn(`[${name}] could not be restarted to free ${mb(heldBytes)}: ${result.error}`);
        return result;
      }
      log.warn(`[${name}] held ${mb(heldBytes)} (one object may hold ${mb(limitBytes)}); restarted it in a fresh sandbox with its data`);
      void this.notify(`${name} was holding ${mb(heldBytes)} of memory, so it was restarted to free it. Its data was kept.`, 'warning', 15_000);
      return { success: true, restarted: true };
    });

    this.installDefaultCloseHandler();
  }

  /**
   * Bring `source` up in a fresh sandbox carrying `this.data` across: the old
   * lifecycle hides, the new one shows if the object was on screen, and a
   * failure on the way puts the old sandbox back. A source update waits for
   * live handlers to finish and announces the new source; a restart
   * (`interrupt`) fails whatever is still running and announces nothing,
   * since the source is the same. Callers hold the source-activation lock.
   */
  private async activateSource(
    source: string, msg: AbjectMessage, { announce, interrupt }: { announce: boolean; interrupt: boolean },
  ): Promise<ApplyResult & { conflict?: boolean; rolledBack?: boolean; rollbackError?: string }> {
    this.activating = true;
    try {
      if (!interrupt) {
        const deadline = Date.now() + 10000;
        while (this.activeUserCalls > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        if (this.activeUserCalls > 0) return { success: false, error: 'Live handlers are still running; reconcile their effects before activation' };
      }
      // The new source compiles in a sandbox of its own before anything
      // changes; the old one keeps running until the new one has shown.
      const previousSource = this._source;
      const previousList = this.handlerList;
      const previousData = this.readData();
      const prepared = this.prepareSource(source, previousData);
      if ('error' in prepared) return { success: false, error: prepared.error, ...(prepared.errorLine !== undefined ? { errorLine: prepared.errorLine } : {}) };
      const old = this.sandbox;
      // Only an object that was on screen comes back on screen. Re-showing
      // one that was not opened a window nobody asked for, and failed the
      // update outright on an instance with no display. The old hide still
      // runs either way: it is how the old lifecycle lets go of what it holds.
      const wasShowing = this._showing;
      const reshow = async (): Promise<void> => {
        if (wasShowing && this._handlerFunctions.has('show')) await this.runLifecycle('show', msg);
      };
      if (this._handlerFunctions.has('hide')) {
        try { await this.runLifecycle('hide', msg); }
        catch (err) {
          prepared.sandbox.dispose('the update was rolled back');
          let rollbackError: string | undefined;
          try { old.writeData(previousData); await reshow(); } catch (restore) { rollbackError = String(restore); }
          return { success: false, error: `Previous lifecycle could not deactivate: ${String(err)}`, rolledBack: !rollbackError, rollbackError };
        }
      }
      // The new handlers start from the data as the old hide left it.
      prepared.sandbox.writeData(this.readData());
      const result = this.activate(prepared, source, announce);

      if (wasShowing && this._handlerFunctions.has('show')) {
        try { await this.runLifecycle('show', msg); }
        catch (err) {
          let rollbackError: string | undefined;
          const failed = this.sandbox;
          try {
            if (this._handlerFunctions.has('hide')) await this.runLifecycle('hide', msg);
            old.writeData(previousData);
            this.activate({ sandbox: old, list: previousList }, previousSource, announce);
            await reshow();
          } catch (restore) { rollbackError = String(restore); }
          if (this.sandbox !== failed) failed.dispose('its activation failed');
          return { success: false, error: `Activation failed: ${String(err)}`, rolledBack: !rollbackError, rollbackError };
        }
      }
      old.dispose(interrupt ? 'it was restarted' : 'its source was replaced');
      return result;
    } finally { this.activating = false; }
  }

  /**
   * The refusal for an edit to an abject from an installed package, or
   * undefined for any other abject. Its code comes from the package, so an
   * edit here would be undone by the next upgrade; nobody may make one, the
   * authoring objects included.
   */
  private packageRefusal(what: 'source' | 'manifest'): { success: false; error: string } | undefined {
    const pkg = packageNameOf(this._owner);
    if (!pkg) return undefined;
    return {
      success: false,
      error: `'${this.manifest.name}' comes from the installed package '${pkg}', so its ${what} is read-only here. ` +
        'Change the package and reinstall it (pnpm forge), or clone this object to get an editable copy.',
    };
  }

  /**
   * Whether a sender may change this object's source or manifest: its owner,
   * or one of the authoring objects, whose ids change every session so the
   * recorded owner may be stale.
   */
  private async senderMayEdit(from: AbjectId): Promise<boolean> {
    if (packageNameOf(this._owner)) return false;
    if (from === this._owner) return true;
    const [creatorId, editorId, storeId] = await Promise.all([
      this.discoverDep('ObjectCreator'), this.discoverDep('AbjectEditor'), this.discoverDep('AbjectStore'),
    ]);
    return from === creatorId || from === editorId || from === storeId;
  }

  private installDefaultCloseHandler(): void {
    if (this._userMethods.has('windowCloseRequested')) return;
    this.on('windowCloseRequested', async (msg: AbjectMessage) => {
      if (this._handlerFunctions.has('hide')) {
        await this.invokeUserHandler('hide', msg);
        this._showing = false;
      }
    });
  }

  // ── Convenience methods for handler code ──────────────────────────

  /**
   * Call a method on another object via message passing.
   * The `to` parameter accepts a Promise (from this.dep()) or a plain ID.
   *
   * Options: { timeout?: number } — override the default 30s request timeout.
   * Long-running calls (e.g. WebAgent.runTask) should pass a longer timeout.
   *
   * Backward compat: detects 4-arg calls (to, interfaceId, method, payload)
   * from stored user objects and skips the second arg.
   */
  async call<T>(
    to: AbjectId | string | Promise<AbjectId>,
    method: string,
    payload?: unknown,
    options?: { timeout?: number } | unknown,
  ): Promise<T> {
    // Backward compat: if called with 4 args and the 2nd looks like an interface ID, skip it
    if (options !== undefined && typeof method === 'string' && typeof payload === 'string') {
      // Old call signature: call(to, interfaceId, method, payload)
      const actualMethod = payload as unknown as string;
      const actualPayload = options;
      const resolvedTo = await to;
      return this.request<T>(
        request(this.id, resolvedTo as AbjectId, actualMethod, actualPayload)
      );
    }
    const resolvedTo = await to;
    const timeoutMs = (options && typeof options === 'object' && 'timeout' in options)
      ? (options as { timeout?: number }).timeout
      : undefined;
    return this.request<T>(
      request(this.id, resolvedTo as AbjectId, method, payload ?? {}),
      timeoutMs,
    );
  }

  /**
   * Send an event (fire-and-forget) to another object.
   * The `to` parameter accepts a Promise (from this.dep()) or a plain ID.
   */
  async emit(to: AbjectId | string | Promise<AbjectId>, eventName: string, payload?: unknown): Promise<void> {
    const resolvedTo = await to;
    this.send(event(this.id, resolvedTo as AbjectId, eventName, payload ?? {}));
  }

  /**
   * Observe another object — call addDependent so this object receives
   * 'changed' events from the target. Define a 'changed' handler in your
   * source to process them.
   */
  async observe(target: AbjectId | string | Promise<AbjectId>): Promise<void> {
    const resolvedTarget = await target;
    await this.request(request(this.id, resolvedTarget as AbjectId, 'addDependent', {}));
  }

  // ── Compilation ───────────────────────────────────────────────────

  /**
   * Try to compile source without installing. Returns error message on failure, undefined on success.
   */
  static tryCompile(source: string): string | undefined {
    try {
      Sandbox.checkHandlers(source, 'scriptable-check.js');
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Compile source and install handlers. Throws on failure (used during construction).
   * Handler functions are bound to this instance so they can call convenience methods.
   * Non-function properties (e.g. _windowId: null) are set on the instance so handlers
   * can share state via `this`.
   */
  /**
   * Handlers auto-provided by the framework (Abject base + ScriptableAbject).
   * User code cannot override these; they are silently skipped during compile.
   * ObjectCreator imports this set to exclude them from verification and LLM prompts.
   */
  // NOTE: windowCloseRequested is deliberately NOT protected. It is the one
  // window-lifecycle callback user objects are meant to handle (e.g. a
  // multi-window object closing only the window whose X was clicked). The bus
  // keeps one handler per method, and installDefaultCloseHandler() already
  // installs a default (→ hide()) ONLY when the object defines no override. If
  // it were protected, the user's handler would be silently dropped and the
  // default would fire for every window the object owns — closing the wrong
  // window (e.g. a manager's main window when an editor's X is clicked).
  static readonly PROTECTED_HANDLERS = new Set([
    'getSource', 'getData', 'updateSource', 'persistSnapshot', 'probe',
    'getRegistry',
    'ping', 'addDependent', 'removeDependent', 'freeMemory',
  ]);

  /**
   * System handlers the source may override, calling the system's own with
   * `super.<name>(msg)`: `ask` (answer a question) and `describe` (say what
   * the object is). They reach the source through handleAsk and
   * handleDescribe, so the system's handler stays in front of them: an ask
   * still answers when the object is busy, and describe always carries the
   * real manifest.
   */
  static readonly INHERITED_HANDLERS = new Set(['ask', 'describe']);

  /** Keys on the this-proxy that must not be overwritten by user handler code. */
  private static readonly PROXY_BUILTINS = new Set([
    'call', 'dep', 'find', 'changed', 'emit', 'observe', 'id',
    'data', 'saveData', 'ensure', 'invariant',
  ]);

  /** Longest a handler, or a timer callback, may run without pausing. */
  private static readonly HANDLER_SLICE_MS = 1000;

  /**
   * A sandbox for this object's source: `this` and the bare globals offer the
   * helpers below, each reached by message on the code's behalf, plus the
   * live `id` and `data`. What crosses in either direction is a copy.
   */
  private createSandbox(): Sandbox {
    return new Sandbox({
      filename: `scriptable-${this.manifest.name}.js`,
      sliceMs: ScriptableAbject.HANDLER_SLICE_MS,
      timers: true,
      contracts: true,
      data: true,
      reservedNames: [...ScriptableAbject.PROXY_BUILTINS],
      inherited: {
        ask: (msg: unknown) => {
          // super.ask(msg) or super.ask('a question').
          const m = msg as { payload?: { question?: unknown }; routing?: { from?: AbjectId } } | undefined;
          const question = typeof msg === 'string' ? msg : m?.payload?.question;
          return super.handleAsk(typeof question === 'string' ? question : '', m?.routing?.from);
        },
        describe: (msg: unknown) => super.handleDescribe(msg as AbjectMessage),
      },
      asyncHelpers: {
        call: (to: unknown, method: unknown, payload?: unknown, options?: unknown) =>
          this.call(to as AbjectId, method as string, payload, options),
        dep: (name: unknown) => this.dep(String(name)),
        find: (name: unknown) => this.find(String(name)),
        emit: (to: unknown, eventName: unknown, payload?: unknown) => this.emit(to as AbjectId, String(eventName), payload),
        observe: (target: unknown) => this.observe(target as AbjectId),
        saveData: () => this.saveData(),
      },
      syncHelpers: {
        id: () => this.id,
        changed: (aspect: unknown, value?: unknown) => { this.changed(String(aspect), value); },
      },
      onInterrupt: (err) => log.warn(`[${this.manifest.name}] ${err.message} Its calls in flight failed and its timers were cleared.`),
      onUncaught: (err) => log.warn(`[${this.manifest.name}] uncaught error in a timer callback: ${err.message}`),
      owner: () => ({ id: this.id, name: this.manifest.name }),
    });
  }

  /** A copy of `this.data`; the last one read when the sandbox cannot answer. */
  private readData(): Record<string, unknown> {
    try {
      this._lastData = this.sandbox.readData();
    } catch (err) {
      log.warn(`[${this.manifest.name}] could not read this.data (${err instanceof Error ? err.message : String(err)}); using the last copy`);
    }
    return this._lastData;
  }

  private writeData(data: Record<string, unknown>): void {
    this.sandbox.writeData(data);
    this._lastData = data;
  }

  /** Run the current source's show or hide outside the message path (source activation). */
  private async runLifecycle(name: 'show' | 'hide', msg: AbjectMessage): Promise<void> {
    const outcome = this.sandbox.invoke(name, [msg]);
    if (!outcome.sync) await outcome.promise;
  }

  /**
   * Persist the current internal data through AbjectStore so it survives
   * restart and is included in clones / snapshots / remote shares.
   * Throws ContractViolation if `data` contains values JSON cannot serialize.
   *
   * Calls are coalesced: at most one save is in flight and one is queued.
   * Generated source often calls saveData inside animation ticks (30+/sec);
   * without coalescing each call is a Registry discover + AbjectStore save +
   * full-store Storage write, which floods the workspace and starves every
   * other object's requests. The returned promise resolves once a save that
   * includes the caller's data mutations has been persisted.
   */
  async saveData(): Promise<void> {
    try {
      this.sandbox.readData();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `saveData failed: this.data is not JSON-serializable (${reason}). ` +
        `Remove functions, cycles, or class instances and retry.`
      );
    }

    // Join the queued save if one exists — it has not started yet, so it
    // will pick up the caller's mutations when it reads the data.
    if (this._pendingSave) return this._pendingSave.promise;

    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    this._pendingSave = { promise, resolve, reject };

    this._saveTail = this._saveTail.then(async () => {
      const wait = ScriptableAbject.SAVE_MIN_INTERVAL_MS - (Date.now() - this._lastSaveStart);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const ticket = this._pendingSave;
      if (!ticket) return; // already flushed by onStop
      // Clear before reading the data: mutations after this point need a new save.
      this._pendingSave = undefined;
      this._lastSaveStart = Date.now();
      try {
        await this.persistDataNow();
        ticket.resolve();
      } catch (err) {
        ticket.reject(err);
      }
    });
    return promise;
  }

  /**
   * The actual AbjectStore round trip. Only called from the coalesced
   * saveData chain (and the final flush in onStop).
   */
  private async persistDataNow(): Promise<void> {
    try {
      if (this._packagesId) {
        // Never write before the stored data has been read: that would
        // replace it with whatever this fresh instance started with.
        await this.packageDataReady();
        await this.request(request(this.id, this._packagesId, 'savePackageData', { data: this.readData() }));
        return;
      }
      if (!this._storeId) {
        this._storeId = await this.discoverDep('AbjectStore') ?? undefined;
      }
      if (!this._storeId) {
        throw new Error('AbjectStore unavailable; data is not persisted');
      }
      await this.request(
        request(this.id, this._storeId, 'save', {
          objectId: this.id,
          manifest: this.manifest,
          source: this._source,
          owner: this._owner,
          data: this.readData(),
        })
      );
    } catch (err) {
      // The cached id may be stale (store respawned) — rediscover next time.
      this._storeId = undefined;
      log.warn(`saveData: failed to persist for '${this.manifest.name}':`, err);
      throw err;
    }
  }

  /**
   * A package abject spawned at system scope lives in the global registry,
   * which has no AbjectStore: workspaces have one each, the system level
   * none. Its data is kept by the Packages service instead, which answers
   * only that package's own abjects; it is read before the first handler
   * runs (packageDataReady), so after a supervised restart too. Workspace
   * package abjects find their workspace's store and get their data from
   * WorkspaceManager at spawn, as before.
   */
  protected override async onInit(): Promise<void> {
    await super.onInit();
    if (!isPackageOwner(this._owner)) return;
    this._storeId = await this.discoverDep('AbjectStore') ?? undefined;
    if (this._storeId) return;
    this._packagesId = await this.discoverDep('Packages') ?? undefined;
  }

  /**
   * Load a system-scope package abject's saved data, once, the first time
   * anything needs it. Not in onInit: the Factory registers an object only
   * after its init, and Packages hands data only to an abject it can find
   * registered as the package's own. A failed read is retried next time and
   * fails the call meanwhile, rather than going on with empty data.
   * Undefined when there is nothing (left) to wait for.
   */
  private packageDataReady(): Promise<void> | undefined {
    if (!this._packagesId || this._packageDataLoaded) return undefined;
    this._packageDataLoad ??= (async () => {
      try {
        const stored = await this.request<Record<string, unknown> | null>(
          request(this.id, this._packagesId!, 'getPackageData', {}));
        if (stored && typeof stored === 'object') this.writeData(stored);
        this._packageDataLoaded = true;
      } catch (err) {
        log.warn(`[${this.manifest.name}] could not load package data:`, err);
        throw err;
      } finally {
        this._packageDataLoad = undefined;
      }
    })();
    return this._packageDataLoad;
  }

  protected override async onStop(): Promise<void> {
    await super.onStop();
    // Flush a queued save so the last data mutations survive shutdown.
    // Status is already 'stopped' here, so request() would refuse and a
    // reply could never be dispatched back to us — post the save as a
    // fire-and-forget event straight to the bus instead. Then stop the
    // sandbox, and its timers with it.
    const ticket = this._pendingSave;
    this._pendingSave = undefined;
    try {
      if (!ticket) return;
      const data = this.readData();
      try {
        if (this._packagesId) {
          this.bus.send(event(this.id, this._packagesId, 'savePackageData', { data }));
        } else if (this._storeId) {
          this.bus.send(event(this.id, this._storeId, 'save', {
            objectId: this.id,
            manifest: this.manifest,
            source: this._source,
            owner: this._owner,
            data,
          }));
        }
      } catch { /* best effort at shutdown */ }
      ticket.resolve();
    } finally {
      this.sandbox.dispose('the object stopped');
    }
  }

  /**
   * Make the manifest say what the source does.
   *
   * The manifest is how every other object, the desktop included, learns what
   * this one can do: the Taskbar lists an object only when its manifest
   * declares show and hide, the Registry's ask answers from it, and a
   * generated proxy is built against it. Source is edited far more often than
   * manifests are redrafted, so a handler the source registers but the
   * manifest omits is invisible to all of them; that is how an object gained
   * a window and never appeared in the taskbar. Declare every source handler
   * the manifest lacks (a placeholder description; a redrafted manifest
   * replaces it), and drop declarations for handlers the source no longer
   * registers, so no caller is promised a method that would fail.
   *
   * Returns what changed, for the caller to report.
   */
  private reconcileManifestWithSource(previousUserMethods: ReadonlySet<string>): { added: string[]; removed: string[] } {
    const methods = this.manifest.interface.methods;
    const declared = new Set(methods.map(m => m.name));
    const added: string[] = [];
    for (const name of this._userMethods) {
      if (declared.has(name)) continue;
      methods.push({
        name,
        description: `${SOURCE_DECLARED_DESCRIPTION} Parameters are not declared here; ask the object how to call it.`,
        parameters: [],
      });
      added.push(name);
    }
    const removed: string[] = [];
    for (const name of previousUserMethods) {
      if (this._userMethods.has(name) || !declared.has(name)) continue;
      const at = methods.findIndex(m => m.name === name);
      if (at >= 0) { methods.splice(at, 1); removed.push(name); }
    }
    if (added.length > 0 || removed.length > 0) {
      log.info(`[${this.manifest.name}] manifest reconciled with source: ` +
        `${added.length > 0 ? `added ${added.join(', ')}` : ''}${added.length > 0 && removed.length > 0 ? '; ' : ''}${removed.length > 0 ? `removed ${removed.join(', ')}` : ''}`);
    }
    return { added, removed };
  }

  /** Push the reconciled manifest to the Registry that holds this object, if any. */
  private publishManifest(): void {
    void (async () => {
      const registryId = await this.resolveRegistryId();
      if (!registryId) return;
      await this.request(request(this.id, registryId, 'updateManifest', { objectId: this.id, manifest: this.manifest }), 10_000);
    })().catch(err => log.warn(`[${this.manifest.name}] manifest update not accepted by Registry: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Install the first source (construction). Throws when it does not install. */
  private compileAndInstall(source: string, data: Record<string, unknown>): void {
    const prepared = this.prepareSource(source, data);
    if ('error' in prepared) throw new Error(prepared.error);
    this.sandbox = prepared.sandbox;
    this.handlerList = prepared.list;
    this.registerHandlers(prepared.list);
    // Before registration, so the Registry sees the reconciled manifest.
    this.reconcileManifestWithSource(new Set());
  }

  /** Compile source into a new sandbox holding `data`; nothing live changes. */
  private prepareSource(source: string, data: Record<string, unknown>): { sandbox: Sandbox; list: HandlerList } | { error: string; errorLine?: number } {
    const sandbox = this.createSandbox();
    try {
      sandbox.writeData(data);
      return { sandbox, list: sandbox.installHandlers(source) };
    } catch (err) {
      sandbox.dispose('its source did not install');
      return { error: err instanceof Error ? err.message : String(err), errorLine: err instanceof SandboxSourceError ? err.line : undefined };
    }
  }

  /** Message handlers: the source's functions, less the private and the protected. */
  private registerHandlers(list: HandlerList): void {
    this._handlerFunctions = new Set(list.filter(h => h.kind === 'function').map(h => h.name));
    for (const name of this._handlerFunctions) {
      if (name.startsWith('_') || ScriptableAbject.PROTECTED_HANDLERS.has(name) || ScriptableAbject.INHERITED_HANDLERS.has(name)) continue;
      this.on(name, msg => this.invokeUserHandler(name, msg));
      this._userMethods.add(name);
    }
  }

  /**
   * Make a prepared sandbox the live one: its handlers replace the old ones
   * on the bus and the manifest follows; `announce` tells dependents the
   * source changed. The caller disposes the old sandbox.
   */
  private activate(prepared: { sandbox: Sandbox; list: HandlerList }, source: string, announce = true): ApplyResult {
    const previousUserMethods = new Set(this._userMethods);
    for (const method of this._userMethods) this.off(method);
    this._userMethods.clear();
    this.sandbox = prepared.sandbox;
    this.handlerList = prepared.list;
    this.registerHandlers(prepared.list);
    this._source = source;
    this.installDefaultCloseHandler();

    const { added, removed } = this.reconcileManifestWithSource(previousUserMethods);
    if (added.length > 0 || removed.length > 0) this.publishManifest();

    // Tell dependents the source changed: a Negotiator that connected this
    // object to another regenerates the proxy between them.
    if (announce) this.changed('sourceUpdated', { objectId: this.id, methods: Array.from(this._userMethods) });

    return { success: true, ...(added.length > 0 ? { manifestMethodsAdded: added } : {}), ...(removed.length > 0 ? { manifestMethodsRemoved: removed } : {}) };
  }

  /**
   * Apply new source at runtime, carrying `this.data` across. Returns
   * success/error and names the manifest methods added or removed by the
   * swap. On failure, old handlers remain — the object never enters a broken
   * state.
   */
  applySource(source: string): ApplyResult {
    const prepared = this.prepareSource(source, this.readData());
    if ('error' in prepared) return { success: false, error: prepared.error, ...(prepared.errorLine !== undefined ? { errorLine: prepared.errorLine } : {}) };
    const old = this.sandbox;
    const result = this.activate(prepared, source);
    old.dispose('its source was replaced');
    return result;
  }
}

type HandlerList = Array<{ name: string; kind: 'function' | 'value' }>;

interface ApplyResult {
  success: boolean;
  error?: string;
  errorLine?: number;
  manifestMethodsAdded?: string[];
  manifestMethodsRemoved?: string[];
}
