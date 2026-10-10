/**
 * Factory object - spawns new objects from manifests and code.
 */

import {
  AbjectId,
  TypeId,
  AbjectManifest,
  AbjectMessage,
  ObjectRegistration,
  SpawnRequest,
  SpawnResult,
} from '../core/types.js';
import { v4 as uuidv4 } from 'uuid';
import { Abject } from '../core/abject.js';
import { require, invariant } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';

const log = new Log('Factory');
import { request } from '../core/message.js';
import type { MessageBusLike } from '../runtime/message-bus.js';
import { type WorkerPool, workerIndexForId } from '../runtime/worker-pool.js';
import { ScriptableAbject, mergeScriptableManifest } from './scriptable-abject.js';
import { Organism, buildOrganismManifest } from './organism.js';
import type { OrganismSpec } from './organism.js';
import { WasmAbject, mergeWasmManifest, WASM_ABJECT_CONSTRUCTOR, type WasmAskGuidance } from './wasm-abject.js';
import {
  isWasmSourceRef,
  storeWasmModule,
  decodeBase64Module,
} from '../sandbox/wasm-module-store.js';
import { isPackageOwner } from '../core/packages.js';
import { BOOTSTRAP_SENDER_ID, isBuiltInRegistration } from '../core/built-in.js';

/** What the Factory records for objects that run code rather than a server class. */
const CODE_CONSTRUCTORS: ReadonlySet<string> = new Set(['ScriptableAbject', 'Organism', WASM_ABJECT_CONSTRUCTOR]);

const FACTORY_INTERFACE = 'abjects:factory';

export type ObjectFactory = (args?: unknown) => Abject;

/**
 * A named package type: an installed package (src/sandbox/extensions.ts) that
 * spawns under a type name. When the name matches a built-in constructor, the
 * package takes precedence — that's how a package transparently replaces a
 * TypeScript system object (`replaces` in abject.json).
 */
export interface PackageTypeRegistration {
  /** 'wasm' spawns a WasmAbject, 'script' a ScriptableAbject. */
  runtime: 'wasm' | 'script';
  manifest: AbjectManifest;
  /** wasm source ref (`wasm:sha256:<hex>`) or JavaScript handler-map source. */
  source: string;
  /** 'system' types spawn once at boot; 'workspace' types spawn per workspace. */
  scope: 'system' | 'workspace';
  /**
   * The `package:<name>` owner the type's abjects spawn with, either
   * runtime. It marks them as the package's: their data is kept as package
   * data (never restored as user objects), a script one's source is
   * read-only, and a clone or instance drops it.
   */
  owner: AbjectId;
  /** The package this type came from, for the Packages settings view. */
  package?: { name: string; version: string };
  /** Workspace scope: the workspace profiles it joins; none means `default`. */
  profiles?: string[];
  /** wasm: the package's guide and tier for answering `ask`. */
  ask?: WasmAskGuidance;
}

/**
 * The Factory object creates and manages object lifecycles.
 */
export class Factory extends Abject {
  private spawned: Map<AbjectId, Abject> = new Map();
  /**
   * Objects being built right now: constructed (or sent to a worker) with
   * their init still running. An object asks for things during onInit, before
   * `spawned`/`workerSpawned` or any registry knows it, so how it was built
   * (a server class or code) and where it goes are recorded here first. Each
   * entry is dropped in the same synchronous step that writes the lasting
   * record, so nothing can run between the two.
   */
  private building: Map<AbjectId, { builtIn: boolean; registryId?: AbjectId }> = new Map();
  private constructors: Map<string, ObjectFactory> = new Map();
  private packageTypes: Map<string, PackageTypeRegistration> = new Map();
  private _factoryBus?: MessageBusLike;
  private _factoryRegistryId?: AbjectId;

  // Worker parallelism
  private _workerPool?: WorkerPool;
  private workerEligible: Set<string> = new Set();
  /** Objects being stopped whose snapshots must survive (see the kill handler). */
  private snapshotKeep = new Set<AbjectId>();
  private workerSpawned: Map<AbjectId, string> = new Map(); // objectId → constructorName
  private workerRegistries: Map<AbjectId, AbjectId> = new Map(); // objectId → registryId

  constructor() {
    super({
      manifest: {
        name: 'Factory',
        description:
          'Creates new objects from manifests. Can spawn WASM objects or built-in types.',
        version: '1.0.0',
        interface: {
            id: FACTORY_INTERFACE,
            name: 'Factory',
            description: 'Abject creation and lifecycle management',
            methods: [
              {
                name: 'spawn',
                description: 'Create a new Abject from manifest. The payload is the SpawnRequest itself ({ manifest, source?, ... }) or wrapped as { request: { manifest, ... } }.',
                parameters: [
                  {
                    name: 'request',
                    type: { kind: 'reference', reference: 'SpawnRequest' },
                    description: 'Spawn configuration: { manifest, source?, parentId?, registryHint?, ... }',
                  },
                ],
                returns: { kind: 'reference', reference: 'SpawnResult' },
              },
              {
                name: 'kill',
                description: 'Stop and destroy an Abject',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the Abject to kill',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'respawn',
                description: 'Kill an Abject and respawn a fresh instance with the same ID',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the Abject to respawn',
                  },
                  {
                    name: 'constructorName',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The registered constructor name',
                  },
                ],
                returns: { kind: 'reference', reference: 'SpawnResult' },
              },
              {
                name: 'clone',
                description: 'Clone an existing Abject (new instance with same manifest/source). Instances are prototypes: by default the clone carries a deep copy of the original\'s data and diverges from there; pass withData: false for a fresh-data copy of the same behavior. The clone\'s manifest records lineage (clonedFrom, generation). Searches local registry first, then remote workspace registries. Pass registryHint to control which registry the clone lands in.',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the Abject to clone',
                  },
                  {
                    name: 'withData',
                    type: { kind: 'primitive', primitive: 'boolean' },
                    description: 'Copy the original\'s data into the clone (default true). false gives a fresh instance of the same behavior with empty data.',
                    optional: true,
                  },
                  {
                    name: 'registryHint',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Optional registry ID to register the clone in (e.g. workspace registry). Defaults to global registry.',
                    optional: true,
                  },
                ],
                returns: { kind: 'reference', reference: 'SpawnResult' },
              },
              {
                name: 'instantiate',
                description: 'Create a fresh runtime INSTANCE of an existing object\'s type — same manifest/source, a NEW identity, and its own (empty by default) data. Unlike clone, it does NOT copy the source object\'s data and does NOT carry its typeId, so you get a blank new instance of the same kind, not a fork of its current state. Use this to open another live instance/window of an existing source-backed object (e.g. a second editor). Resolves the source object by objectId or typeId across the registryHint, global, and remote registries. The instance is ephemeral (no typeId), so persist any per-instance state under your own document key rather than relying on snapshot/restore.',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The AbjectId of an existing instance whose type to instantiate (or pass typeId)',
                    optional: true,
                  },
                  {
                    name: 'typeId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The durable TypeId of the object type to instantiate (alternative to objectId)',
                    optional: true,
                  },
                  {
                    name: 'data',
                    type: { kind: 'object', properties: {} },
                    description: 'Initial data for the new instance (default empty). NOT copied from the source object.',
                    optional: true,
                  },
                  {
                    name: 'registryHint',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Registry to resolve the source object in and register the new instance in (e.g. your workspace registry, this.parentId). Searched first.',
                    optional: true,
                  },
                  {
                    name: 'parentId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Parent/owner of the new instance (defaults to Factory)',
                    optional: true,
                  },
                ],
                returns: { kind: 'reference', reference: 'SpawnResult' },
              },
              {
                name: 'registerConstructor',
                description: 'Register a constructor for a named Abject type',
                parameters: [
                  {
                    name: 'name',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Abject type name',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getObjectInfo',
                description: 'Get worker placement info for an Abject',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The ID of the Abject to query',
                  },
                ],
                returns: { kind: 'object', properties: {
                  isWorkerHosted: { kind: 'primitive', primitive: 'boolean' },
                  constructorName: { kind: 'primitive', primitive: 'string' },
                  workerIndex: { kind: 'primitive', primitive: 'number' },
                }},
              },
            ],
          },
        tags: ['system', 'core'],
      },
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('spawn', async (msg: AbjectMessage) => {
      // The manifest names one parameter, `request`, so a caller that wraps
      // arguments by parameter name (the Explorer's method form) sends
      // { request: { manifest, ... } }; everyone else sends the SpawnRequest
      // itself. Both are accepted.
      const payload = (msg.payload ?? {}) as SpawnRequest & { request?: SpawnRequest };
      const wrapped = payload.manifest === undefined
        && typeof payload.request === 'object' && payload.request !== null;
      const req = wrapped ? payload.request! : payload;
      return this.spawn(await this.admitSpawn(msg.routing.from, req));
    });

    this.on('kill', async (msg: AbjectMessage) => {
      const { objectId, keepSnapshot } = msg.payload as { objectId: AbjectId; keepSnapshot?: boolean };
      await this.admitKill(msg.routing.from, objectId);
      // Stopping an object is normally the user discarding it, so its
      // snapshot goes too. Recovery stops objects it is about to bring back
      // from those very snapshots, and says so.
      if (keepSnapshot) this.snapshotKeep.add(objectId);
      try { return await this.kill(objectId); } finally { this.snapshotKeep.delete(objectId); }
    });

    this.on('clone', async (msg: AbjectMessage) => {
      const { objectId, registryHint, withData } = msg.payload as {
        objectId: AbjectId; registryHint?: AbjectId; withData?: boolean;
      };
      const hint = await this.admitCopy(msg.routing.from, objectId, registryHint, 'clone');
      return this.clone(objectId, hint, withData ?? true);
    });

    this.on('instantiate', async (msg: AbjectMessage) => {
      const req = msg.payload as {
        objectId?: AbjectId; typeId?: TypeId; data?: Record<string, unknown>;
        registryHint?: AbjectId; parentId?: AbjectId;
      };
      const key = (req.objectId ?? req.typeId ?? '') as AbjectId;
      const hint = await this.admitCopy(msg.routing.from, key, req.registryHint, 'instantiate');
      return this.instantiate({ ...req, ...(hint ? { registryHint: hint } : {}) });
    });

    this.on('respawn', async (msg: AbjectMessage) => {
      const { objectId, constructorName, parentId, registryId } = msg.payload as {
        objectId: AbjectId;
        constructorName: string;
        parentId?: AbjectId;
        registryId?: AbjectId;
      };
      require(await this.isTrustedRequester(msg.routing.from),
        'Factory respawns objects only for built-in objects (the Supervisor, worker recovery)');
      return this.respawn(objectId, constructorName, parentId, registryId);
    });

    this.on('listPackageTypes', async () => this.listPackageTypes());

    this.on('getObjectInfo', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: AbjectId };
      const isWorker = this.workerSpawned.has(objectId);
      const constructorName = this.workerSpawned.get(objectId);
      const workerIndex = isWorker && this._workerPool
        ? workerIndexForId(objectId, this._workerPool.workerCount)
        : undefined;
      // Where this Factory registered the object: authoritative for looking up
      // a caller's registration, unlike anything the caller could claim.
      const registryId = this.workerRegistries.get(objectId) ?? this.spawned.get(objectId)?.getRegistryId();
      return { isWorkerHosted: isWorker, constructorName, workerIndex, ...(registryId ? { registryId } : {}) };
    });
  }

  // ── Who may ask for what (src/core/built-in.ts) ──────────────────────

  /**
   * The bootstrap, this Factory, and built-in objects: they may ask for
   * anything. What this Factory built answers first, from how it built it
   * (a registered constructor, or code): an object asks for things during its
   * own onInit, before it is registered anywhere. Anything else is judged by
   * its registration.
   */
  private async isTrustedRequester(requesterId: AbjectId): Promise<boolean> {
    if (requesterId === BOOTSTRAP_SENDER_ID || requesterId === this.id) return true;
    const inProgress = this.building.get(requesterId);
    if (inProgress) return inProgress.builtIn;
    const local = this.spawned.get(requesterId);
    if (local) return !(local instanceof ScriptableAbject || local instanceof Organism || local instanceof WasmAbject);
    const constructorName = this.workerSpawned.get(requesterId);
    if (constructorName !== undefined) return !CODE_CONSTRUCTORS.has(constructorName);
    return this.isBuiltInCaller(requesterId);
  }

  /** The registry this Factory registered an object in, when it spawned it. */
  private registryOf(objectId: AbjectId): AbjectId | undefined {
    return this.building.get(objectId)?.registryId
      ?? this.workerRegistries.get(objectId) ?? this.spawned.get(objectId)?.getRegistryId();
  }

  /**
   * Run an instance's init with the object recorded as being built, then
   * track it as spawned in the same step.
   */
  private async initRecorded(obj: Abject, registryId: AbjectId | undefined, init: () => Promise<void>): Promise<void> {
    this.building.set(obj.id, { builtIn: Factory.isServerClass(obj), registryId });
    try {
      await init();
    } catch (err) {
      this.building.delete(obj.id);
      throw err;
    }
    this.spawned.set(obj.id, obj);
    this.building.delete(obj.id);
  }

  /** Whether an instance runs a server class rather than code. */
  private static isServerClass(obj: Abject): boolean {
    return !(obj instanceof ScriptableAbject || obj instanceof Organism || obj instanceof WasmAbject);
  }

  /** Whether a request asks for a server class (a registered constructor) rather than code. */
  private asksForServerClass(req: SpawnRequest): boolean {
    if (req.source || req.code || req.codeBase64) return false;
    if (req.manifest && this.packageTypes.has(req.manifest.name)) return false;
    return !!req.manifest && this.constructors.has(req.manifest.name);
  }

  /**
   * What a spawn request may ask for, by who sent it. Code that is not built
   * in may spawn more code (source, a WASM module, an Organism, an installed
   * package type) into its own registry, never a server class: an instance of
   * one is trusted by its registration, and it would carry whatever name the
   * request gave it. Nor may it take a built-in's typeId shape
   * (`{peer}/{scope}/{Name}`), which peers address built-ins by.
   */
  private async admitSpawn(requesterId: AbjectId, req: SpawnRequest): Promise<SpawnRequest> {
    if (await this.isTrustedRequester(requesterId)) return req;
    require(!this.asksForServerClass(req),
      `Factory spawns the built-in '${req.manifest?.name}' only for built-in objects; spawn code (source, a WASM module or a package type) instead`);
    require(!req.typeId || String(req.typeId).split('/').length !== 3,
      `typeId '${String(req.typeId)}' has a built-in's shape; user objects use {peer}/{workspace}/user/{Name}`);
    const own = this.registryOf(requesterId);
    return own ? { ...req, registryHint: own } : req;
  }

  /**
   * Stopping an object: built-in objects stop anything; any other object
   * stops itself and the objects it owns (created).
   */
  private async admitKill(requesterId: AbjectId, objectId: AbjectId): Promise<void> {
    if (objectId === requesterId || await this.isTrustedRequester(requesterId)) return;
    const reg = await this.resolveRegistration(objectId, this.registryOf(objectId)).catch(() => null);
    require(!!reg && !!reg.owner && reg.owner === requesterId,
      'Factory stops an object only for itself, its owner, or a built-in object');
  }

  /**
   * Copying an object (clone, instantiate): anything may copy source-backed
   * objects, into its own registry; only built-in objects may copy a
   * built-in one. Returns the registry to place the copy in.
   */
  private async admitCopy(
    requesterId: AbjectId, key: AbjectId, registryHint: AbjectId | undefined, method: string,
  ): Promise<AbjectId | undefined> {
    if (await this.isTrustedRequester(requesterId)) return registryHint;
    const reg = key ? await this.resolveRegistration(key, registryHint).catch(() => null) : null;
    require(!reg || !isBuiltInRegistration(reg),
      `Factory '${method}' copies a built-in object only for built-in objects`);
    return this.registryOf(requesterId) ?? registryHint;
  }

  // Spawn/clone/instantiate semantics agents use to create objects correctly.
  protected override askTier(): 'smart' | 'balanced' | 'fast' {
    return 'balanced';
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## Factory Usage Guide

### Methods
- \`spawn({ manifest, source?, code?, owner?, parentId? })\` — Spawn a new object. If a constructor is registered for the manifest name, uses that. If source is provided and manifest.tags includes 'organism', creates an Organism from a JSON OrganismSpec. If source is provided without the organism tag, creates a ScriptableAbject. Returns { objectId, status }.
- \`kill({ objectId })\` — Stop and destroy an object. Unregisters from Registry, removes from Supervisor, and stops the object. Returns boolean.
- \`clone({ objectId, withData?, registryHint? })\` — Clone an existing object (new instance with same manifest/source but new ID). Returns { objectId, status }. Instances are prototypes: the clone carries a deep copy of the original's data by default and then diverges independently; pass \`withData: false\` for a fresh-data copy of the same behavior. The clone's manifest records lineage (\`clonedFrom\`, \`generation\`), so populations of copies stay traceable to their original. Works for Organisms -- the clone gets a fresh internal registry, organelles, and interface with new IDs. Cloning fits source-backed objects (ScriptableAbjects and Organisms); system infrastructure singletons are spawned at bootstrap and are rarely meaningful to clone. Searches local registry first, then remote workspace registries. Pass \`registryHint\` (a registry AbjectId) to register the clone in a specific registry (e.g. workspace registry) instead of the global one.
- \`respawn({ objectId, constructorName, parentId? })\` — Kill and re-create an object with the same ID. Used by Supervisor for restart.
- \`registerConstructor(name, factory)\` — Register a constructor function for a named object type.

### Organism
An Organism is a composite Abject with its own internal registry. Like a biological cell, it has organelles (internal ScriptableAbjects) hidden behind an interface (the membrane). To spawn one, pass \`source\` as a JSON-serialized OrganismSpec and include \`'organism'\` in \`manifest.tags\`. The spec defines an interface organelle (the externally visible face) and internal organelles that discover each other through the organism's internal registry. Organelles are not visible in the workspace Registry -- only the organism itself is.

### Object Inspection
- \`getObjectInfo({ objectId })\` — Returns \`{ isWorkerHosted, constructorName, workerIndex }\` or undefined if not found.

### Key Constraints
- \`spawn()\` only works for pre-registered constructors or objects with source code. Use ObjectCreator to create entirely new objects from natural language prompts.
- \`clone()\` looks up the original object in the Registry and re-spawns with the same manifest and source.

### Interface ID
\`abjects:factory\``;
  }

  /**
   * Set the message bus for spawned objects.
   */
  setBus(bus: MessageBusLike): void {
    this._factoryBus = bus;
  }

  /**
   * Set the registry ID for object registration via message passing.
   */
  setRegistryId(id: AbjectId): void {
    this._factoryRegistryId = id;
    // Keep the base-class registry pointer aligned: it powers discovery-
    // dependent behavior inherited from Abject (askLlm locating the LLM,
    // discoverDep). The Runtime constructs Factory directly, so this call
    // is the only place Factory ever learns which registry it belongs to.
    this.setRegistryHint(id);
  }

  /**
   * Set the worker pool for off-main-thread object execution.
   */
  setWorkerPool(pool: WorkerPool): void {
    this._workerPool = pool;
  }

  /**
   * Mark a constructor name as eligible for worker execution.
   */
  markWorkerEligible(name: string): void {
    this.workerEligible.add(name);
  }

  /**
   * Check if an object is hosted in a worker.
   */
  isWorkerHosted(objectId: AbjectId): boolean {
    return this.workerSpawned.has(objectId);
  }

  /**
   * Register a constructor for a named object type.
   */
  registerConstructor(name: string, factory: ObjectFactory): void {
    require(name !== '', 'name must not be empty');
    this.constructors.set(name, factory);
  }

  /**
   * Register a package type under a name. Spawns of that name resolve to the
   * package instead of any registered constructor, so an installed package
   * can replace a built-in implementation transparently.
   */
  registerPackageType(name: string, registration: PackageTypeRegistration): void {
    require(name !== '', 'name must not be empty');
    require(registration.manifest?.interface !== undefined, 'registration manifest must declare an interface');
    if (registration.runtime === 'wasm') {
      require(isWasmSourceRef(registration.source), 'a wasm package type needs a wasm source ref');
    } else {
      require(registration.runtime === 'script', `unknown package runtime '${String(registration.runtime)}'`);
      require(registration.source.trim() !== '' && !isWasmSourceRef(registration.source),
        'a script package type needs JavaScript handler-map source');
    }
    require(registration.scope === 'workspace' || registration.scope === 'system',
      `unknown package scope '${String(registration.scope)}'`);
    require(isPackageOwner(registration.owner), 'a package type needs a package owner');
    this.packageTypes.set(name, registration);
    log.info(`package type '${name}' registered (${registration.runtime}, ${registration.scope})`);
  }

  /**
   * The ask guidance of the package a wasm spawn comes from, matched by type
   * name and module so a restored or respawned instance answers the same way
   * and an unrelated module that borrows the name does not.
   */
  private wasmAskFor(req: { manifest: AbjectManifest; source?: string }): { ask?: WasmAskGuidance } {
    const t = this.packageTypes.get(req.manifest.name);
    return t?.runtime === 'wasm' && t.ask && t.source === req.source ? { ask: t.ask } : {};
  }

  /** Installed package types, e.g. for WorkspaceManager to spawn
   *  workspace-scoped packages alongside the built-in per-workspace set. */
  listPackageTypes(): Array<{
    name: string; scope: 'system' | 'workspace'; runtime: 'wasm' | 'script'; tags: string[];
    package?: { name: string; version: string }; profiles?: string[];
  }> {
    return Array.from(this.packageTypes.entries()).map(([name, t]) => ({
      name,
      scope: t.scope,
      runtime: t.runtime,
      tags: [...(t.manifest.tags ?? [])],
      ...(t.package ? { package: { ...t.package } } : {}),
      ...(t.profiles ? { profiles: [...t.profiles] } : {}),
    }));
  }

  /**
   * Get a registered constructor by name.
   */
  getConstructor(name: string): ObjectFactory | undefined {
    return this.constructors.get(name);
  }

  /**
   * Resolve an object's registration by AbjectId OR durable TypeId. Searches,
   * in order: the caller's registryHint (where workspace/user objects actually
   * live), the global Factory registry, a typeId->id resolve in each, then
   * remote workspace registries. This is why a bare global lookup used to miss
   * live user objects ("not found in any registry") — they register in their
   * workspace registry, not the global one.
   */
  private async resolveRegistration(idOrTypeId: string, registryHint?: AbjectId): Promise<ObjectRegistration | null> {
    const registries: AbjectId[] = [];
    if (registryHint) registries.push(registryHint);
    if (this._factoryRegistryId && !registries.includes(this._factoryRegistryId)) {
      registries.push(this._factoryRegistryId);
    }

    // Direct lookup by AbjectId in each candidate registry.
    for (const regId of registries) {
      try {
        const reg = await this.request<ObjectRegistration | null>(
          request(this.id, regId, 'lookup', { objectId: idOrTypeId as AbjectId })
        );
        if (reg) return reg;
      } catch { /* registry unreachable */ }
    }

    // Treat it as a TypeId (scoped, contains '/'): resolve to a live id, then look up.
    if (idOrTypeId.includes('/')) {
      for (const regId of registries) {
        try {
          const liveId = await this.request<AbjectId | null>(
            request(this.id, regId, 'resolveType', { typeId: idOrTypeId as TypeId })
          );
          if (liveId) {
            const reg = await this.request<ObjectRegistration | null>(
              request(this.id, regId, 'lookup', { objectId: liveId })
            );
            if (reg) return reg;
          }
        } catch { /* registry unreachable */ }
      }
    }

    // Fall back to remote workspace registries.
    return this.findInRemoteRegistries(idOrTypeId as AbjectId);
  }

  /**
   * Create a fresh runtime INSTANCE of an existing object's type: same manifest
   * and source, a NEW identity, and its own (empty by default) data. Unlike
   * clone(), it does NOT deep-copy the source object's data and does NOT carry
   * its typeId — so you get a blank new instance of the same kind, not a fork of
   * the original's current state. Use this for "open another live instance of
   * this object" (e.g. a second editor window bound to a different document).
   * The instance is ephemeral (no typeId → not snapshot/restored by typeId);
   * persist per-instance state under your own document key.
   */
  async instantiate(req: {
    objectId?: AbjectId; typeId?: TypeId; data?: Record<string, unknown>;
    registryHint?: AbjectId; parentId?: AbjectId;
  }): Promise<SpawnResult> {
    require(this._factoryBus !== undefined, 'Factory must have a message bus');
    require(this._factoryRegistryId !== undefined, 'Factory must have a registry');
    const key = req.objectId ?? req.typeId;
    require(typeof key === 'string' && key.length > 0, 'instantiate requires objectId or typeId');

    const reg = await this.resolveRegistration(key as string, req.registryHint);
    require(reg !== null, `Object '${key}' not found in any registry (cannot instantiate)`);
    require(
      !!reg!.source,
      `Object '${key}' has no source to instantiate. Only source-backed objects (ScriptableAbjects/Organisms) can be instantiated; constructor-backed system objects cannot.`,
    );

    // Fresh instance: source + manifest, caller's data (default empty), and
    // deliberately NO typeId so it has its own ephemeral identity rather than
    // colliding with the source object's durable snapshot key.
    // A package's abjects are read-only and restored from the package; an
    // instance of one is an ordinary object, so it does not keep that owner.
    const spawnReq: SpawnRequest = {
      manifest: reg!.manifest,
      source: reg!.source,
      ...(isPackageOwner(reg!.owner) ? {} : { owner: reg!.owner }),
      data: req.data ?? {},
    };
    if (req.registryHint) spawnReq.registryHint = req.registryHint;
    if (req.parentId) spawnReq.parentId = req.parentId;
    return this.spawn(spawnReq);
  }

  /**
   * Clone an existing object — creates a new instance with the same manifest/source but a new ID.
   *
   * Prototype semantics (instances are prototypes, Self-style): by default the
   * clone carries a deep copy of the original's data and then diverges
   * independently. Pass withData: false for a fresh instance of the same
   * behavior with empty data. Every clone records lineage in its manifest:
   * clonedFrom (the original's typeId when it has one, else its AbjectId) and
   * generation (parent's generation + 1).
   */
  async clone(objectId: AbjectId, registryHint?: AbjectId, withData = true): Promise<SpawnResult> {
    require(this._factoryBus !== undefined, 'Factory must have a message bus');
    require(this._factoryRegistryId !== undefined, 'Factory must have a registry');

    const reg = await this.resolveRegistration(objectId, registryHint);
    require(reg !== null, `Object '${objectId}' not found in any registry`);

    // Lineage: stamp where this copy came from and its clone generation.
    const fromPackage = isPackageOwner(reg!.owner);
    const manifest: AbjectManifest = {
      ...reg!.manifest,
      ...(fromPackage ? { tags: (reg!.manifest.tags ?? []).filter(t => t !== 'package') } : {}),
      lineage: {
        clonedFrom: (reg!.typeId as string | undefined) ?? (objectId as string),
        generation: (reg!.manifest.lineage?.generation ?? 0) + 1,
      },
    };

    // Delegate to spawn with the same manifest and source.
    // Internal data clones with the source — that is the point of having data
    // live inside the object.
    // A clone of a package abject is an ordinary, editable user object: it
    // does not inherit the package owner (which would make it read-only and
    // keep it out of the AbjectStore restore).
    const spawnReq: SpawnRequest = { manifest };
    if (reg!.source) {
      spawnReq.source = reg!.source;
      if (!fromPackage) spawnReq.owner = reg!.owner;
    }
    if (withData && reg!.data !== undefined) {
      // Deep-copy via JSON so the clone's data is independent of the original's.
      try {
        spawnReq.data = JSON.parse(JSON.stringify(reg!.data));
      } catch {
        // Original had non-serializable data; clone starts empty rather than failing.
        spawnReq.data = {};
      }
    } else if (!withData) {
      spawnReq.data = {};
    }
    if (registryHint) {
      spawnReq.registryHint = registryHint;
    }
    return this.spawn(spawnReq);
  }

  /**
   * Search remote workspace registries for an object by ID.
   */
  private async findInRemoteRegistries(objectId: AbjectId): Promise<ObjectRegistration | null> {
    try {
      const wsrId = await this.discoverDep('WorkspaceShareRegistry');
      if (!wsrId) return null;

      const workspaces = await this.request<Array<{ registryId: string }>>(
        request(this.id, wsrId, 'getDiscoveredWorkspaces', {})
      );

      for (const ws of workspaces) {
        try {
          const reg = await this.request<ObjectRegistration | null>(
            request(this.id, ws.registryId as AbjectId, 'lookup', { objectId })
          );
          if (reg) return reg;
        } catch { /* remote registry may be unreachable */ }
      }
    } catch { /* WorkspaceShareRegistry may not exist */ }

    return null;
  }

  /**
   * Kill an old instance and spawn a fresh one with the same ID.
   * Used by Supervisor for same-ID restart.
   */
  async respawn(objectId: AbjectId, constructorName: string, parentId?: AbjectId, registryId?: AbjectId): Promise<SpawnResult> {
    require(this._factoryBus !== undefined, 'Factory must have a message bus');

    // Use caller-provided registryId (e.g. workspace registry) or fall back to global
    const effectiveRegistryId = registryId ?? this._factoryRegistryId;

    // Worker path: if the constructor is worker-eligible OR the object is currently worker-hosted
    if (this._workerPool && (this.workerEligible.has(constructorName) || this.workerSpawned.has(objectId))) {
      // Look up existing registration before killing so we can capture source/manifest/owner
      let existingReg: ObjectRegistration | null = null;
      if (effectiveRegistryId) {
        try {
          existingReg = await this.request<ObjectRegistration | null>(
            request(this.id, effectiveRegistryId, 'lookup', { objectId })
          );
        } catch { /* may not be registered */ }
      }

      // Capture how the object was tracked before the kill below clears it
      const trackedName = this.workerSpawned.get(objectId);

      // Kill old worker instance if tracked
      if (this.workerSpawned.has(objectId)) {
        // Clear timers before killing so they stop firing immediately
        try {
          const timerId = await this.discoverDep('Timer');
          if (timerId) {
            await this.request(request(this.id, timerId,
              'clearTimersForObject', { objectId }));
          }
        } catch { /* Timer may not be available */ }

        if (effectiveRegistryId) {
          try {
            await this.request(
              request(this.id, effectiveRegistryId, 'unregister', { objectId })
            );
          } catch { /* may not be registered */ }
        }
        await this._workerPool.killInWorker(objectId);
        this.workerSpawned.delete(objectId);
      }

      // Respawn in worker with same ID, passing constructor args for
      // source-backed objects (ScriptableAbjects and WasmAbjects). Objects
      // tracked as WasmAbject respawn as WasmAbject regardless of the
      // constructorName the Supervisor recorded at spawn time (a wasm type
      // override may have been spawned under a built-in name).
      if (trackedName === WASM_ABJECT_CONSTRUCTOR
          || (existingReg?.source && isWasmSourceRef(existingReg.source))) {
        constructorName = WASM_ABJECT_CONSTRUCTOR;
      } else if (trackedName === 'ScriptableAbject' && existingReg?.source) {
        // Same for source-backed objects: a script package abject is
        // supervised under its type name, which no worker has a constructor
        // for; it runs, and so restarts, as a ScriptableAbject.
        constructorName = 'ScriptableAbject';
      }
      const isScriptable = constructorName === 'ScriptableAbject';
      const isWasm = constructorName === WASM_ABJECT_CONSTRUCTOR;
      this.building.set(objectId, { builtIn: !CODE_CONSTRUCTORS.has(constructorName), registryId: effectiveRegistryId });
      try {
        if (isScriptable || isWasm) {
          if (!existingReg?.source) {
            throw new Error(`Cannot respawn ${constructorName} '${objectId}': registration/source not found in Registry`);
          }
          await this._workerPool.spawnInWorker(objectId, constructorName, {
            constructorArgs: {
              manifest: existingReg.manifest,
              source: existingReg.source,
              owner: existingReg.owner ?? '',
              data: existingReg.data,
              ...(isWasm ? this.wasmAskFor(existingReg) : {}),
            },
            registryId: effectiveRegistryId,
            parentId: parentId ?? this.id,
            typeId: existingReg?.typeId,
          });
        } else {
          await this._workerPool.spawnInWorker(objectId, constructorName, {
            registryId: effectiveRegistryId,
            parentId: parentId ?? this.id,
            typeId: existingReg?.typeId,
          });
        }
      } catch (err) {
        this.building.delete(objectId);
        throw err;
      }
      this.workerSpawned.set(objectId, constructorName);
      this.building.delete(objectId);

      // Register the manifest the live object actually has, not the one the
      // snapshot carried in: a scriptable object declares every handler its
      // source registers as it is constructed, so a snapshot whose manifest
      // fell behind its code would otherwise re-register stale every boot,
      // and the desktop (which reads the Registry) would never see the
      // window the code grew. Fall back to the snapshot's, then a placeholder.
      let manifest: AbjectManifest | undefined;
      try {
        const described = await this.request<{ manifest?: AbjectManifest }>(
          request(this.id, objectId, 'describe', {}), 10000);
        if (described?.manifest?.interface) manifest = described.manifest;
      } catch (err) {
        log.warn(`respawn: could not read live manifest of ${objectId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }
      manifest ??= existingReg?.manifest ?? { name: constructorName, description: '', version: '1.0.0',
        interface: { id: 'abjects:unknown', name: constructorName, description: '', methods: [] }, tags: ['system'] };
      const now = Date.now();
      const status = {
        id: objectId, state: 'ready' as const, manifest, connections: [] as AbjectId[],
        errorCount: 0, startedAt: now, lastActivity: now,
      };

      const preservedTypeId = existingReg?.typeId;

      if (effectiveRegistryId) {
        const regPayload: Record<string, unknown> = { objectId, manifest, status };
        if (preservedTypeId) regPayload.typeId = preservedTypeId;
        if ((isScriptable || isWasm) && existingReg) {
          regPayload.source = existingReg.source;
          regPayload.owner = existingReg.owner;
          if (existingReg.data !== undefined) regPayload.data = existingReg.data;
        }
        await this.request(
          request(this.id, effectiveRegistryId, 'register', regPayload)
        );
      }

      return { objectId, typeId: preservedTypeId, status };
    }

    // Kill old instance if still tracked
    const old = this.spawned.get(objectId);
    const preservedTypeId = old?.typeId;
    if (old) {
      // Unregister from registry BEFORE stopping so cleanup notifications
      // fire while the object is still on the bus
      if (effectiveRegistryId) {
        try {
          await this.request(
            request(this.id, effectiveRegistryId, 'unregister', { objectId })
          );
        } catch { /* may not be registered */ }
      }

      try {
        await old.stop();
      } catch {
        // Object may already be stopped/dead
      }
      this.spawned.delete(objectId);
    }

    // Create fresh instance with same ID
    const factory = this.constructors.get(constructorName);
    if (!factory) throw new Error(`No constructor for '${constructorName}'`);
    const obj = factory();
    obj.setId(objectId);
    if (preservedTypeId) obj.setTypeId(preservedTypeId);

    // Pre-seed registry ID to avoid deadlock (child asking parent during init)
    if (effectiveRegistryId) {
      obj.setRegistryHint(effectiveRegistryId);
    }

    // Initialize and register
    await this.initRecorded(obj, effectiveRegistryId, () => obj.init(this._factoryBus!, parentId ?? this.id));

    if (effectiveRegistryId) {
      const payload: Record<string, unknown> = {
        objectId: obj.id,
        manifest: obj.manifest,
        status: obj.status,
      };
      if (preservedTypeId) payload.typeId = preservedTypeId;
      if (obj instanceof Organism) {
        payload.source = obj.organismSource;
      } else if (obj instanceof ScriptableAbject) {
        payload.owner = obj.owner;
        payload.source = obj.source;
        payload.data = obj.dataSnapshot;
      }
      await this.request(
        request(this.id, effectiveRegistryId, 'register', payload)
      );
    }

    this.checkInvariants();

    return {
      objectId: obj.id,
      typeId: preservedTypeId,
      status: obj.status,
    };
  }

  /**
   * Spawn a new object from a manifest.
   */
  async spawn(req: SpawnRequest): Promise<SpawnResult> {
    require(this._factoryBus !== undefined, 'Factory must have a message bus');
    require(req.manifest !== undefined, 'manifest is required');

    // Package resolution runs before every other dispatch so installed type
    // overrides win over built-in constructors (that's what `replaces` means).
    // 1. A registered package type under this name supplies the manifest,
    //    its code (a module ref for wasm, handler-map source for script) and
    //    the package owner, which keeps the abject's data as package data
    //    (out of the user-object restore) and a script one's source read-only.
    const packageType =
      !req.source && !req.code && !req.codeBase64
        ? this.packageTypes.get(req.manifest.name)
        : undefined;
    if (packageType) {
      req = {
        ...req,
        manifest: packageType.manifest,
        source: packageType.source,
        owner: packageType.owner,
      };
    }
    const scriptPackage = packageType?.runtime === 'script';
    // The package owner is reserved for abjects spawned from an installed
    // package; a request may not claim it for anything else.
    require(packageType !== undefined || !isPackageOwner(req.owner),
      `owner '${String(req.owner)}' is reserved for abjects from installed packages`);
    // 2. Raw module bytes are ingested into the content-addressed store and
    //    replaced by their canonical wasm source ref.
    if (!req.source && (req.code || req.codeBase64)) {
      const bytes = req.code
        ? new Uint8Array(req.code)
        : decodeBase64Module(req.codeBase64!);
      const ref = await storeWasmModule(bytes);
      req = { ...req, source: ref };
    }
    // 3. A wasm source ref spawns a WasmAbject (worker-hosted when possible).
    const isWasm = req.source !== undefined && isWasmSourceRef(req.source);
    if (isWasm && this._workerPool) {
      return this.spawnWasmInWorker(req);
    }

    // Check if we have a registered factory. A request carrying source asks
    // for a source-backed object, so a built-in constructor of the same name
    // must not win: that covers a script package replacing a built-in, a
    // clone of one, and a user object that happens to share a built-in's name.
    const factory = scriptPackage || req.source ? undefined : this.constructors.get(req.manifest.name);

    // Worker path: if the constructor is worker-eligible, delegate to WorkerPool
    if (factory && this._workerPool && this.workerEligible.has(req.manifest.name)) {
      return this.spawnInWorker(req);
    }

    // Worker path for ScriptableAbjects (user-created objects with source code)
    if (!factory && req.source && !req.manifest.tags?.includes('organism') && this._workerPool) {
      return this.spawnScriptableInWorker(req);
    }

    // Worker path for Organisms (entire organism runs in one worker)
    if (!factory && req.source && req.manifest.tags?.includes('organism') && this._workerPool) {
      return this.spawnOrganismInWorker(req);
    }

    let obj: Abject;

    if (isWasm) {
      // Spawn a WasmAbject inline (no worker pool available)
      obj = new WasmAbject({
        manifest: req.manifest,
        source: req.source!,
        owner: req.owner,
        data: req.data,
        ...this.wasmAskFor(req),
      });
    } else if (factory) {
      // Use registered factory function
      obj = factory(req.constructorArgs);
    } else if (req.source && req.manifest.tags?.includes('organism')) {
      // Spawn an Organism from a JSON OrganismSpec (no worker pool)
      const spec = JSON.parse(req.source) as OrganismSpec;
      obj = new Organism(spec);
    } else if (req.source) {
      // Spawn a ScriptableAbject from handler source
      obj = new ScriptableAbject(
        req.manifest,
        req.source,
        req.owner ?? ('' as AbjectId),
        req.data,
      );
    } else {
      throw new Error(
        `No constructor registered for '${req.manifest.name}' and no code provided`
      );
    }

    // Set typeId if provided
    if (req.typeId) {
      obj.setTypeId(req.typeId);
    }

    // Pre-seed registry ID to avoid deadlock (child asking parent during init)
    // Use registryHint from request if provided (workspace objects), else Factory's registry
    const hint = req.registryHint ?? this._factoryRegistryId;
    if (hint) {
      obj.setRegistryHint(hint);
    }

    // Initialize the object with parentId (default to Factory), and track it
    await this.initRecorded(obj, hint, () => obj.init(this._factoryBus!, req.parentId ?? this.id));

    // Register with the appropriate registry:
    // - If registryHint is specified, register there (workspace objects)
    // - Otherwise register in the global registry (unless skipGlobalRegistry)
    const targetRegistry = req.registryHint ?? (req.skipGlobalRegistry ? undefined : this._factoryRegistryId);
    if (targetRegistry) {
      const payload: Record<string, unknown> = {
        objectId: obj.id,
        manifest: obj.manifest,
        status: obj.status,
      };
      if (req.typeId) payload.typeId = req.typeId;
      if (obj instanceof Organism) {
        payload.source = obj.organismSource;
      } else if (obj instanceof ScriptableAbject) {
        payload.owner = obj.owner;
        payload.source = obj.source;
        payload.data = obj.dataSnapshot;
      } else if (obj instanceof WasmAbject) {
        if (obj.owner) payload.owner = obj.owner;
        payload.source = obj.source;
        const data = obj.dataSnapshot;
        if (data !== undefined) payload.data = data;
      }
      await this.request(
        request(this.id, targetRegistry, 'register', payload)
      );
    }

    this.checkInvariants();

    return {
      objectId: obj.id,
      typeId: req.typeId,
      status: obj.status,
    };
  }

  /**
   * Spawn an existing object instance.
   */
  async spawnInstance(obj: Abject, parentId?: AbjectId): Promise<SpawnResult> {
    require(this._factoryBus !== undefined, 'Factory must have a message bus');

    // Pre-seed registry ID to avoid deadlock (child asking parent during init)
    if (this._factoryRegistryId) {
      obj.setRegistryHint(this._factoryRegistryId);
    }

    // Initialize the object, and track it
    await this.initRecorded(obj, this._factoryRegistryId, () => obj.init(this._factoryBus!, parentId));

    // Register with registry via message passing
    if (this._factoryRegistryId) {
      const payload: Record<string, unknown> = {
        objectId: obj.id,
        manifest: obj.manifest,
        status: obj.status,
      };
      if (obj.typeId) payload.typeId = obj.typeId;
      if (obj instanceof Organism) {
        payload.source = obj.organismSource;
      } else if (obj instanceof ScriptableAbject) {
        payload.owner = obj.owner;
        payload.source = obj.source;
      } else if (obj instanceof WasmAbject) {
        if (obj.owner) payload.owner = obj.owner;
        payload.source = obj.source;
      }
      await this.request(
        request(this.id, this._factoryRegistryId, 'register', payload)
      );
    }

    this.checkInvariants();

    return {
      objectId: obj.id,
      typeId: obj.typeId,
      status: obj.status,
    };
  }

  /**
   * Spawn an object in a Web Worker via the WorkerPool.
   * The object runs off-main-thread; the main thread only holds its ID.
   */
  private async spawnInWorker(req: SpawnRequest): Promise<SpawnResult> {
    require(this._workerPool !== undefined, 'WorkerPool must be set');

    // Generate the object ID on the main thread (so we can register with Registry)
    const objectId = uuidv4() as AbjectId;

    // Create a temporary instance to get the real manifest (constructor name
    // in the constructors map may differ from manifest.name)
    const factory = this.constructors.get(req.manifest.name)!;
    const tempObj = factory(req.constructorArgs);
    const realManifest = tempObj.manifest;

    // Spawn in worker — pass registryId and parentId so the worker-side
    // object can discover dependencies and communicate with the bus hub
    this.building.set(objectId, { builtIn: true, registryId: req.registryHint ?? (req.skipGlobalRegistry ? undefined : this._factoryRegistryId) });
    try {
      await this._workerPool!.spawnInWorker(objectId, req.manifest.name, {
        constructorArgs: req.constructorArgs,
        registryId: req.registryHint ?? this._factoryRegistryId,
        parentId: req.parentId ?? this.id,
        typeId: req.typeId,
      });
    } catch (err) {
      this.building.delete(objectId);
      log.error(`Failed to spawn ${req.manifest.name} (${objectId.slice(0, 8)}) in worker:`, err);
      throw err;
    }

    // Track as worker-spawned
    this.workerSpawned.set(objectId, req.manifest.name);
    this.building.delete(objectId);

    // Register with registry from main thread using the real manifest
    const targetRegistry = req.registryHint ?? (req.skipGlobalRegistry ? undefined : this._factoryRegistryId);
    if (targetRegistry) this.workerRegistries.set(objectId, targetRegistry);
    if (targetRegistry) {
      const now = Date.now();
      const regPayload: Record<string, unknown> = {
        objectId,
        manifest: realManifest,
        status: {
          id: objectId,
          typeId: req.typeId,
          state: 'ready',
          manifest: realManifest,
          connections: [] as AbjectId[],
          errorCount: 0,
          startedAt: now,
          lastActivity: now,
        },
      };
      if (req.typeId) regPayload.typeId = req.typeId;
      await this.request(
        request(this.id, targetRegistry, 'register', regPayload)
      );
    }

    const now = Date.now();
    return {
      objectId,
      typeId: req.typeId,
      status: {
        id: objectId,
        typeId: req.typeId,
        state: 'ready',
        manifest: realManifest,
        connections: [] as AbjectId[],
        errorCount: 0,
        startedAt: now,
        lastActivity: now,
      },
    };
  }

  /**
   * Spawn a ScriptableAbject in a Web Worker.
   * Unlike spawnInWorker(), this handles dynamic objects created from source code.
   */
  private async spawnScriptableInWorker(req: SpawnRequest): Promise<SpawnResult> {
    require(this._workerPool !== undefined, 'WorkerPool must be set');
    require(req.source !== undefined, 'source is required for ScriptableAbject');

    const objectId = uuidv4() as AbjectId;

    this.building.set(objectId, { builtIn: false, registryId: req.registryHint ?? this._factoryRegistryId });
    try {
      await this._workerPool!.spawnInWorker(objectId, 'ScriptableAbject', {
        constructorArgs: {
          manifest: req.manifest,
          source: req.source,
          owner: req.owner ?? '',
          data: req.data,
        },
        registryId: req.registryHint ?? this._factoryRegistryId,
        parentId: req.parentId ?? this.id,
        typeId: req.typeId,
      });
    } catch (err) {
      this.building.delete(objectId);
      throw err;
    }

    this.workerSpawned.set(objectId, 'ScriptableAbject');
    this.building.delete(objectId);

    // Register the manifest the live object has, not the one the request
    // carried in. A scriptable object declares every handler its source
    // registers as it is constructed, so a request (a store restore, in
    // particular) whose manifest fell behind its source would otherwise
    // register stale, and the desktop, which reads the Registry, would never
    // see the window the code grew. The merged request manifest is the
    // fallback when the object cannot be asked.
    let realManifest: AbjectManifest | undefined;
    try {
      const described = await this.request<{ manifest?: AbjectManifest }>(
        request(this.id, objectId, 'describe', {}), 10000);
      if (described?.manifest?.interface) realManifest = described.manifest;
    } catch (err) {
      log.warn(`spawn: could not read live manifest of ${req.manifest.name} (${objectId.slice(0, 8)}): ${err instanceof Error ? err.message : String(err)}`);
    }
    realManifest ??= mergeScriptableManifest(req.manifest);

    // Register with registry including source and owner (for AbjectStore)
    const targetRegistry = req.registryHint ?? (req.skipGlobalRegistry ? undefined : this._factoryRegistryId);
    if (targetRegistry) this.workerRegistries.set(objectId, targetRegistry);
    if (targetRegistry) {
      const now = Date.now();
      const regPayload: Record<string, unknown> = {
        objectId,
        manifest: realManifest,
        owner: req.owner,
        source: req.source,
        status: {
          id: objectId,
          typeId: req.typeId,
          state: 'ready',
          manifest: realManifest,
          connections: [] as AbjectId[],
          errorCount: 0,
          startedAt: now,
          lastActivity: now,
        },
      };
      if (req.typeId) regPayload.typeId = req.typeId;
      if (req.data !== undefined) regPayload.data = req.data;
      await this.request(
        request(this.id, targetRegistry, 'register', regPayload)
      );
    }

    const now = Date.now();
    return {
      objectId,
      typeId: req.typeId,
      status: {
        id: objectId,
        typeId: req.typeId,
        state: 'ready',
        manifest: realManifest,
        connections: [] as AbjectId[],
        errorCount: 0,
        startedAt: now,
        lastActivity: now,
      },
    };
  }

  /**
   * Spawn a WasmAbject in a worker thread. Only the wasm source ref crosses
   * the thread boundary — the worker resolves module bytes from the
   * content-addressed store on disk.
   */
  private async spawnWasmInWorker(req: SpawnRequest): Promise<SpawnResult> {
    require(this._workerPool !== undefined, 'WorkerPool must be set');
    require(req.source !== undefined && isWasmSourceRef(req.source), 'wasm source ref is required');

    const objectId = uuidv4() as AbjectId;

    this.building.set(objectId, { builtIn: false, registryId: req.registryHint ?? this._factoryRegistryId });
    try {
      await this._workerPool!.spawnInWorker(objectId, WASM_ABJECT_CONSTRUCTOR, {
        constructorArgs: {
          manifest: req.manifest,
          source: req.source,
          owner: req.owner ?? '',
          data: req.data,
          ...this.wasmAskFor(req),
        },
        registryId: req.registryHint ?? this._factoryRegistryId,
        parentId: req.parentId ?? this.id,
        typeId: req.typeId,
      });
    } catch (err) {
      this.building.delete(objectId);
      throw err;
    }

    this.workerSpawned.set(objectId, WASM_ABJECT_CONSTRUCTOR);
    this.building.delete(objectId);

    // Same merged manifest the worker-side instance declares (introspect + wasm tag)
    const realManifest = mergeWasmManifest(req.manifest);

    const targetRegistry = req.registryHint ?? (req.skipGlobalRegistry ? undefined : this._factoryRegistryId);
    if (targetRegistry) this.workerRegistries.set(objectId, targetRegistry);
    if (targetRegistry) {
      const now = Date.now();
      const regPayload: Record<string, unknown> = {
        objectId,
        manifest: realManifest,
        source: req.source,
        status: {
          id: objectId,
          typeId: req.typeId,
          state: 'ready',
          manifest: realManifest,
          connections: [] as AbjectId[],
          errorCount: 0,
          startedAt: now,
          lastActivity: now,
        },
      };
      if (req.owner) regPayload.owner = req.owner;
      if (req.typeId) regPayload.typeId = req.typeId;
      if (req.data !== undefined) regPayload.data = req.data;
      await this.request(
        request(this.id, targetRegistry, 'register', regPayload)
      );
    }

    const now = Date.now();
    return {
      objectId,
      typeId: req.typeId,
      status: {
        id: objectId,
        typeId: req.typeId,
        state: 'ready',
        manifest: realManifest,
        connections: [] as AbjectId[],
        errorCount: 0,
        startedAt: now,
        lastActivity: now,
      },
    };
  }

  /**
   * Spawn an Organism in a Web Worker.
   * The entire organism (internal registry + organelles + interface) runs in one worker.
   */
  private async spawnOrganismInWorker(req: SpawnRequest): Promise<SpawnResult> {
    require(this._workerPool !== undefined, 'WorkerPool must be set');
    require(req.source !== undefined, 'source is required for Organism');

    const spec = JSON.parse(req.source!) as OrganismSpec;
    const objectId = uuidv4() as AbjectId;

    this.building.set(objectId, { builtIn: false, registryId: req.registryHint ?? this._factoryRegistryId });
    try {
      await this._workerPool!.spawnInWorker(objectId, 'Organism', {
        constructorArgs: spec,
        registryId: req.registryHint ?? this._factoryRegistryId,
        parentId: req.parentId ?? this.id,
        typeId: req.typeId,
      });
    } catch (err) {
      this.building.delete(objectId);
      throw err;
    }

    this.workerSpawned.set(objectId, 'Organism');
    this.building.delete(objectId);

    // Build the merged manifest for registry registration
    const realManifest = buildOrganismManifest(spec);

    const targetRegistry = req.registryHint ?? (req.skipGlobalRegistry ? undefined : this._factoryRegistryId);
    if (targetRegistry) this.workerRegistries.set(objectId, targetRegistry);
    if (targetRegistry) {
      const now = Date.now();
      const regPayload: Record<string, unknown> = {
        objectId,
        manifest: realManifest,
        source: req.source,
        status: {
          id: objectId,
          typeId: req.typeId,
          state: 'ready',
          manifest: realManifest,
          connections: [] as AbjectId[],
          errorCount: 0,
          startedAt: now,
          lastActivity: now,
        },
      };
      if (req.typeId) regPayload.typeId = req.typeId;
      await this.request(
        request(this.id, targetRegistry, 'register', regPayload)
      );
    }

    const now = Date.now();
    return {
      objectId,
      typeId: req.typeId,
      status: {
        id: objectId,
        typeId: req.typeId,
        state: 'ready',
        manifest: realManifest,
        connections: [] as AbjectId[],
        errorCount: 0,
        startedAt: now,
        lastActivity: now,
      },
    };
  }

  /**
   * Kill a worker-hosted object.
   */
  private async killWorkerObject(objectId: AbjectId): Promise<boolean> {
    if (!this._workerPool) return false;

    // Remove from Supervisor BEFORE stopping (prevents restart race)
    try {
      const supervisorId = await this.discoverDep('Supervisor');
      if (supervisorId) {
        await this.request(request(this.id, supervisorId,
          'removeChild', { childId: objectId }));
      }
    } catch { /* Supervisor may not be tracking this object */ }

    // Clear any active timers for this object so they stop firing immediately
    try {
      const timerId = await this.discoverDep('Timer');
      if (timerId) {
        await this.request(request(this.id, timerId,
          'clearTimersForObject', { objectId }));
      }
    } catch { /* Timer may not be available */ }

    // Unregister from the registry where the object was actually registered
    const objRegistry = this.workerRegistries.get(objectId) ?? this._factoryRegistryId;
    if (objRegistry) {
      try {
        await this.request(
          request(this.id, objRegistry, 'unregister', { objectId })
        );
      } catch { /* may not be registered */ }
    }

    // Remove from AbjectStore so it doesn't reappear on restart.
    // AbjectStore lives in the workspace registry, not the global one,
    // so we must discover it from the object's own registry.
    if (objRegistry) {
      try {
        const storeResults = await this.request<Array<{ id: AbjectId }>>(
          request(this.id, objRegistry, 'discover', { name: 'AbjectStore' })
        );
        if (storeResults.length > 0 && !this.snapshotKeep.has(objectId)) {
          await this.request(
            request(this.id, storeResults[0].id, 'remove', { objectId })
          );
        }
      } catch { /* AbjectStore may not exist in this workspace */ }
    }

    // Kill in worker
    await this._workerPool.killInWorker(objectId);
    this.workerSpawned.delete(objectId);
    this.workerRegistries.delete(objectId);

    return true;
  }

  /**
   * Kill an object.
   */
  async kill(objectId: AbjectId): Promise<boolean> {
    // Check if this is a worker-hosted object
    if (this.workerSpawned.has(objectId)) {
      return this.killWorkerObject(objectId);
    }

    const obj = this.spawned.get(objectId);
    if (!obj) {
      return false;
    }

    // Remove from Supervisor BEFORE stopping (prevents restart race)
    try {
      const supervisorId = await this.discoverDep('Supervisor');
      if (supervisorId) {
        await this.request(request(this.id, supervisorId,
          'removeChild', { childId: objectId }));
      }
    } catch { /* Supervisor may not be tracking this object */ }

    // Unregister from the registry where the object was actually registered
    // (workspace registry via registryHint, or global registry as fallback)
    const objRegistry = obj.getRegistryId() ?? this._factoryRegistryId;
    if (objRegistry) {
      await this.request(
        request(this.id, objRegistry, 'unregister', { objectId })
      );
    }

    // Remove from AbjectStore if it's a scriptable object.
    // AbjectStore lives in the workspace registry, not the global one,
    // so we must discover it from the object's own registry.
    if (obj.manifest.tags?.includes('scriptable') && objRegistry) {
      try {
        const storeResults = await this.request<Array<{ id: AbjectId }>>(
          request(this.id, objRegistry, 'discover', { name: 'AbjectStore' })
        );
        if (storeResults.length > 0 && !this.snapshotKeep.has(objectId)) {
          await this.request(
            request(this.id, storeResults[0].id, 'remove', { objectId })
          );
        }
      } catch { /* AbjectStore may not exist in this workspace */ }
    }

    await obj.stop();
    this.spawned.delete(objectId);

    this.checkInvariants();
    return true;
  }

  /**
   * Get a spawned object by ID.
   */
  getObject(objectId: AbjectId): Abject | undefined {
    return this.spawned.get(objectId);
  }

  /**
   * Get all spawned objects.
   */
  getAllObjects(): Abject[] {
    return Array.from(this.spawned.values());
  }

  /**
   * Get spawned object count.
   */
  get objectCount(): number {
    return this.spawned.size;
  }

  /**
   * Factory knows the Registry directly.
   */
  override getRegistryId(): AbjectId | undefined {
    return this._factoryRegistryId ?? super.getRegistryId();
  }

  /**
   * Check class invariants.
   */
  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.spawned.size >= 0, 'spawned count must be non-negative');
  }
}

// Well-known factory ID
export const FACTORY_ID = 'abjects:factory' as AbjectId;

/**
 * Create a spawn request message.
 */
export function createSpawnRequest(
  fromId: AbjectId,
  manifest: AbjectManifest,
  code?: ArrayBuffer,
  initialState?: unknown,
): AbjectMessage {
  return request(fromId, FACTORY_ID, 'spawn', {
    manifest,
    code,
    initialState,
  } as SpawnRequest);
}

/**
 * Create a clone request message.
 */
export function createCloneRequest(
  fromId: AbjectId,
  objectId: AbjectId
): AbjectMessage {
  return request(fromId, FACTORY_ID, 'clone', { objectId });
}

/**
 * Create a kill request message.
 */
export function createKillRequest(
  fromId: AbjectId,
  objectId: AbjectId
): AbjectMessage {
  return request(fromId, FACTORY_ID, 'kill', { objectId });
}
