/**
 * AbjectStore - keeps the workspace's user objects (script and WASM: the
 * `source` is handler-map JavaScript or a `wasm:sha256:` module ref, plus the
 * object's data) and brings them back. Also keeps installed packages' data
 * in this workspace under `package/<TypeName>`, which WorkspaceManager hands
 * back when it spawns the package; those are never restored as user objects.
 *
 * Each object's record says where it lives and when it runs:
 *   folder   a group of the person's choosing ('user' unless placed
 *            elsewhere), listed and removed as one
 *   loading  'boot' starts it with the workspace; 'needed' leaves it asleep
 *            until someone looks it up (Registry resolveType or a name
 *            lookup), shows it in a slot, or holds it, and puts it back to
 *            sleep when nothing holds it and it has been idle a while
 * Tags are the manifest's own, for search and filtering.
 *
 * Storage holds a small index (what boot reads), one body per object (its
 * data), each distinct source once by hash, and the last picture a slot drew
 * of an object (its preview), so a woken object's home shows at once.
 */

import { describeMessages, protocolText } from '../core/protocol-description.js';
import {
  AbjectId,
  TypeId,
  AbjectManifest,
  AbjectMessage,
  InterfaceId,
  SpawnResult,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require as precondition, invariant } from '../core/contracts.js';
import { request, event } from '../core/message.js';
import { Log } from '../core/timed-log.js';
import { isPackageOwner, packageDataKey } from '../core/packages.js';
import { bytesToHex } from '../core/encoding.js';
import { withKeyedLock } from '../core/keyed-lock.js';

const log = new Log('ABJECT-STORE');

const ABJECT_STORE_INTERFACE = 'abjects:abject-store' as InterfaceId;

/** The single-array layout this store used before records were kept apart. */
const LEGACY_KEY = 'abject-store:snapshots';
const INDEX_KEY = 'abject-store:index';
const bodyKey = (typeId: string) => `abject-store:body:${typeId}`;
const sourceKey = (hash: string) => `abject-store:source:${hash}`;
const previewKey = (typeId: string) => `abject-store:preview:${typeId}`;

/** When an object runs: with the workspace, or only while something needs it. */
export type Loading = 'boot' | 'needed';

/** The folder an object lives in unless placed elsewhere. */
export const DEFAULT_FOLDER = 'user';
const PACKAGE_FOLDER = 'package';

/** Tags that name system roles; a placement does not hand them out. */
const RESERVED_TAGS = new Set(['system', 'capability', 'core']);

/** One prior source of an object, by hash. */
interface VersionRef {
  sourceHash: string;
  savedAt: number;
}

/** What boot reads about an object: everything but its source and data. */
interface StoreEntry {
  typeId: string;
  /** The live instance, or '' while it sleeps (or before it first runs). */
  objectId: string;
  manifest: AbjectManifest;
  owner: string;
  savedAt: number;
  sourceHash: string;
  folder: string;
  loading: Loading;
  /** Prior sources, newest first, pushed only when a save changes the source. */
  versions?: VersionRef[];
  /** Size of the saved preview, when there is one. */
  preview?: { width: number; height: number };
}

/** An object's record with its source and data, as callers read it. */
export interface AbjectSnapshot {
  typeId: string;
  objectId: string;
  manifest: AbjectManifest;
  source: string;
  owner: string;
  savedAt: number;
  data?: Record<string, unknown>;
  folder: string;
  loading: Loading;
}

export interface RestoreResult {
  restored: number;
  failed: number;
  errors: string[];
}

/** The last picture a slot drew of an object, in the object's own coordinates. */
export interface ObjectPreview {
  width: number;
  height: number;
  commands: unknown[];
  savedAt: number;
}

/** Where an object goes and how it loads, as callers ask for it. */
interface Placement {
  folder?: string;
  tags?: string[];
  loading?: Loading;
}

/**
 * A manifest is well-formed only if it is a structured object with a non-empty
 * name and an interface carrying a methods array. The known corruption mode is
 * free-form text (an LLM saving a markdown description into the `manifest`
 * field), which leaves name/interface undefined and crashes the
 * ScriptableAbject constructor ("reading 'methods'").
 */
function isValidManifest(m: unknown): m is AbjectManifest {
  if (!m || typeof m !== 'object') return false;
  const manifest = m as Partial<AbjectManifest>;
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) return false;
  const iface = manifest.interface as { methods?: unknown } | undefined;
  if (!iface || typeof iface !== 'object' || !Array.isArray(iface.methods)) return false;
  return true;
}

/** A folder name: lowercase words joined by '-', nested with '/'. */
function isFolderName(folder: unknown): folder is string {
  return typeof folder === 'string' && /^[a-z0-9][a-z0-9_-]{0,47}(\/[a-z0-9][a-z0-9_-]{0,47}){0,5}$/.test(folder);
}

async function sha256Hex(text: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

const objectRefParam = { name: 'objectId', type: { kind: 'primitive' as const, primitive: 'string' as const }, description: 'Live objectId, durable typeId, or object name' };

/**
 * Persists and restores user-created source-backed abjects (script or WASM),
 * and keeps installed packages' data for this workspace.
 */
export class AbjectStore extends Abject {
  private storageId?: AbjectId;
  private factoryId?: AbjectId;
  private registryId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private workspaceId?: string;
  private peerId?: string;

  /** The index, by typeId. */
  private entries: Map<string, StoreEntry> = new Map();
  /** Sources read or written this session, by hash (bounded). */
  private sourceCache: Map<string, string> = new Map();
  /** Hashes known to be in Storage. */
  private storedSources: Set<string> = new Set();
  /** Objects woken but not yet up, by typeId, so concurrent lookups share one wake. */
  private waking: Map<string, Promise<AbjectId>> = new Map();
  /** Who holds a sleeping-kind object awake (slots, windows), by typeId. */
  private holds: Map<string, Set<AbjectId>> = new Map();
  /** When each awake 'needed' object was last woken, held or released. */
  private touchedAt: Map<string, number> = new Map();
  /** Ids of instances put to sleep recently: their last save still lands on the right record. */
  private retiredIds: Map<string, { typeId: string; at: number }> = new Map();

  /** Prior sources kept per object; older history ages out. */
  private static readonly MAX_VERSIONS = 10;
  private static readonly SOURCE_CACHE_MAX = 200;
  /** A 'needed' object nothing holds goes back to sleep after this long. */
  static readonly IDLE_MS = 5 * 60_000;
  private static readonly SWEEP_MS = 60_000;
  private static readonly RETIRED_KEEP_MS = 120_000;
  /** Limits on a preview, which is display data any holder may write. */
  private static readonly PREVIEW_MAX_COMMANDS = 4000;
  private static readonly PREVIEW_MAX_CHARS = 256_000;

  // Debounced index write state (see schedulePersist).
  private static readonly PERSIST_DEBOUNCE_MS = 500;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private persistInFlight?: Promise<void>;
  private persistDirty = false;

  constructor() {
    super({
      manifest: {
        name: 'AbjectStore',
        description:
          'Keeps the workspace\'s user objects (their code and data), with a folder and tags each, and brings them back: at startup, or only when needed for objects set to load that way.',
        version: '2.0.0',
        interface: {
            id: ABJECT_STORE_INTERFACE,
            name: 'AbjectStore',
            description: 'Abject persistence, placement and loading',
            methods: [
              {
                name: 'save',
                description: 'Save a snapshot of a scriptable abject (its manifest, source and data). An object saves itself through saveData.',
                parameters: [
                  { name: 'objectId', type: { kind: 'primitive', primitive: 'string' }, description: 'The ID of the object to save' },
                  { name: 'manifest', type: { kind: 'reference', reference: 'AbjectManifest' }, description: 'The object manifest' },
                  { name: 'source', type: { kind: 'primitive', primitive: 'string' }, description: 'Handler source code' },
                  { name: 'owner', type: { kind: 'primitive', primitive: 'string' }, description: 'Owner object ID' },
                  { name: 'data', type: { kind: 'object', properties: {} }, description: 'Optional internal data record (this.data) to persist with the snapshot' },
                  { name: 'folder', type: { kind: 'primitive', primitive: 'string' }, description: 'Folder to keep it in (default: where it is, else "user")', optional: true },
                  { name: 'loading', type: { kind: 'primitive', primitive: 'string' }, description: '"boot" (start with the workspace) or "needed" (asleep until looked up or shown)', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'create',
                description: 'Make a new kept object from a manifest, source and data, placed in a folder with tags. With loading "needed" it starts asleep and wakes when looked up or shown; with "boot" it starts now and with every workspace start. Returns { typeId, objectId } (objectId empty while asleep).',
                parameters: [
                  { name: 'manifest', type: { kind: 'reference', reference: 'AbjectManifest' }, description: 'The object manifest' },
                  { name: 'source', type: { kind: 'primitive', primitive: 'string' }, description: 'Handler source code' },
                  { name: 'data', type: { kind: 'object', properties: {} }, description: 'Its starting data (this.data)', optional: true },
                  { name: 'folder', type: { kind: 'primitive', primitive: 'string' }, description: 'Folder, e.g. "user/recipes" (default "user")', optional: true },
                  { name: 'tags', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Tags for search and filtering, added to the manifest\'s', optional: true },
                  { name: 'loading', type: { kind: 'primitive', primitive: 'string' }, description: '"boot" or "needed" (default "boot")', optional: true },
                ],
                returns: { kind: 'object', properties: {} },
              },
              {
                name: 'copy',
                description: 'Make an independent copy of a kept object, optionally with different data, in a folder of your choosing. "More of the same" is a copy with new data. Returns { typeId, objectId }.',
                parameters: [
                  objectRefParam,
                  { name: 'data', type: { kind: 'object', properties: {} }, description: 'Data for the copy (default: a copy of the original\'s)', optional: true },
                  { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Name for the copy (default: the original\'s; repeats are numbered)', optional: true },
                  { name: 'folder', type: { kind: 'primitive', primitive: 'string' }, description: 'Folder (default: the original\'s)', optional: true },
                  { name: 'tags', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Tags (default: the original\'s)', optional: true },
                  { name: 'loading', type: { kind: 'primitive', primitive: 'string' }, description: '"boot" or "needed" (default: the original\'s)', optional: true },
                ],
                returns: { kind: 'object', properties: {} },
              },
              {
                name: 'place',
                description: 'Move a kept object to another folder, set its tags, or change when it loads. Returns true.',
                parameters: [
                  objectRefParam,
                  { name: 'folder', type: { kind: 'primitive', primitive: 'string' }, description: 'New folder', optional: true },
                  { name: 'tags', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Its tags, replacing the current ones', optional: true },
                  { name: 'loading', type: { kind: 'primitive', primitive: 'string' }, description: '"boot" or "needed"', optional: true },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'remove',
                description: 'Remove a saved snapshot',
                parameters: [{ name: 'objectId', type: { kind: 'primitive', primitive: 'string' }, description: 'The ID of the object to remove' }],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'list',
                description: 'List the kept user objects (abjects from installed packages are not listed): { typeId, objectId, name, description, tags, folder, loading, asleep, owner, savedAt }. Filter by folder (including the folders inside it), tag, or loading.',
                parameters: [
                  { name: 'folder', type: { kind: 'primitive', primitive: 'string' }, description: 'Only this folder and those inside it', optional: true },
                  { name: 'tag', type: { kind: 'primitive', primitive: 'string' }, description: 'Only objects with this tag', optional: true },
                  { name: 'loading', type: { kind: 'primitive', primitive: 'string' }, description: 'Only "boot" or "needed" objects', optional: true },
                ],
                returns: { kind: 'array', elementType: { kind: 'object', properties: {} } },
              },
              {
                name: 'listFolders',
                description: 'The folders in use, with how many objects each holds: [{ folder, count }].',
                parameters: [],
                returns: { kind: 'array', elementType: { kind: 'object', properties: {} } },
              },
              {
                name: 'removeFolder',
                description: 'Remove every object in a folder (and the folders inside it). A built-in caller removes them all; anyone else removes only the objects they own. Returns { removed }.',
                parameters: [{ name: 'folder', type: { kind: 'primitive', primitive: 'string' }, description: 'The folder' }],
                returns: { kind: 'object', properties: {} },
              },
              {
                name: 'wake',
                description: 'Start a sleeping object (a no-op for one already running) and return its live objectId. A lookup through the Registry (resolveType, a name) wakes it the same way.',
                parameters: [objectRefParam],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'hold',
                description: 'Keep an object awake while you show or use it (waking it if it sleeps); release it when you are done. Returns its live objectId.',
                parameters: [objectRefParam],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'release',
                description: 'Stop holding an object awake. Once nothing holds it and it has been idle a while, an object that loads when needed goes back to sleep.',
                parameters: [objectRefParam],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'sleepIdle',
                description: 'Put objects that load when needed to sleep now if nothing holds them and they have been idle at least idleMs (default 5 minutes). Built-in objects only. Returns how many went to sleep.',
                parameters: [{ name: 'idleMs', type: { kind: 'primitive', primitive: 'number' }, description: 'How long counts as idle', optional: true }],
                returns: { kind: 'primitive', primitive: 'number' },
              },
              {
                name: 'savePreview',
                description: 'Keep the last picture a slot drew of an object (draw commands in the object\'s own coordinates), shown the next time before the object wakes. Taken from the object, its owner, whoever holds it, and built-in objects.',
                parameters: [
                  objectRefParam,
                  { name: 'width', type: { kind: 'primitive', primitive: 'number' }, description: 'Drawing width' },
                  { name: 'height', type: { kind: 'primitive', primitive: 'number' }, description: 'Drawing height' },
                  { name: 'commands', type: { kind: 'array', elementType: { kind: 'object', properties: {} } }, description: 'Draw commands' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getPreview',
                description: 'An object\'s saved preview { width, height, commands, savedAt }, or null.',
                parameters: [objectRefParam],
                returns: { kind: 'object', properties: {} },
              },
              {
                name: 'restoreAll',
                description: 'Bring back every saved abject: those that load at boot start; those that load when needed are registered asleep',
                parameters: [],
                returns: { kind: 'reference', reference: 'RestoreResult' },
              },
              {
                name: 'getPackageData',
                description: 'The saved data (this.data) of an abject from an installed script package in this workspace, or null. WorkspaceManager hands it back when it spawns the package; package abjects are never restored as user objects.',
                parameters: [{ name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'The package type name' }],
                returns: { kind: 'object', properties: {} },
              },
              {
                name: 'restoreLost',
                description: 'Respawn the snapshots of the named objects only, after a worker crash took the live instances; other objects are left alone. Returns { restored, failed, errors }.',
                parameters: [{ name: 'objectIds', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Ids of live objects that are gone' }],
                returns: { kind: 'object', properties: {} },
              },
              {
                name: 'listVersions',
                description: 'List an object\'s saved source versions (newest first). Every source-changing save keeps the prior source, bounded at 10. Returns { name, typeId, objectId, current: { savedAt, sizeChars }, versions: [{ index, savedAt, sizeChars }] }, or null when the object has no snapshot. Accepts a live objectId, durable typeId, or object name.',
                parameters: [objectRefParam],
                returns: { kind: 'object', properties: {} },
              },
              {
                name: 'getVersion',
                description: 'Fetch one prior version\'s full source. Returns { source, savedAt }.',
                parameters: [
                  objectRefParam,
                  { name: 'index', type: { kind: 'primitive', primitive: 'number' }, description: 'Version index from listVersions (0 = most recent prior version)' },
                ],
                returns: { kind: 'object', properties: {} },
              },
              {
                name: 'restoreVersion',
                description: 'Make a prior version the live source: applies it to the running object (updateSource), updates the snapshot and registry, and pushes the replaced source onto the version ring so the restore is itself undoable. Returns { success, error? }.',
                parameters: [
                  objectRefParam,
                  { name: 'index', type: { kind: 'primitive', primitive: 'number' }, description: 'Version index from listVersions' },
                ],
                returns: { kind: 'object', properties: {} },
              },
              {
                name: 'deleteVersion',
                description: 'Permanently remove one prior version from an object\'s history (frees its ring slot; the live source is untouched). Returns { success, error? }.',
                parameters: [
                  objectRefParam,
                  { name: 'index', type: { kind: 'primitive', primitive: 'number' }, description: 'Version index from listVersions' },
                ],
                returns: { kind: 'object', properties: {} },
              },
            ],
          },
        tags: ['system', 'persistence'],
      },
    });

    this.setupHandlers();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Who may write a record
  // ═══════════════════════════════════════════════════════════════════

  /** An object's registration, from this store's registry (with its fallback). */
  private async registrationOf(objectId: string): Promise<{ owner?: string; source?: string; typeId?: string } | undefined> {
    if (!this.registryId || !objectId) return undefined;
    return await this.request<{ owner?: string; source?: string; typeId?: string } | null>(
      request(this.id, this.registryId, 'lookup', { objectId }), 10_000).catch(() => null) ?? undefined;
  }

  /**
   * A record is written by a built-in object (ObjectCreator, the editor,
   * WorkspaceManager), by the object itself, or by its owner (the object that
   * created it). Saved source is what the object runs after a restart, so
   * nothing else may write it. Returns the object's registration when the
   * writer is not built-in, undefined when it is.
   */
  private async requireSnapshotWriter(
    msg: AbjectMessage, ref: string, method: string,
  ): Promise<{ owner?: string; source?: string; typeId?: string } | undefined> {
    const sender = msg.routing.from;
    if (await this.isBuiltInCaller(sender)) return undefined;
    precondition(typeof ref === 'string' && ref !== '', `${method}: objectId must not be empty`);
    const entry = this.findEntry(ref);
    const objectId = entry?.objectId || ref;
    const registered = await this.registrationOf(objectId);
    const owner = registered?.owner ?? entry?.owner;
    const retired = this.retiredIds.get(sender);
    const isSelf = objectId === sender || (!!entry && !!retired && retired.typeId === entry.typeId);
    precondition(isSelf || (!!owner && owner === sender),
      `AbjectStore '${method}' is taken only from the object itself, its owner, or a built-in object`);
    return registered ?? { owner: entry?.owner };
  }

  // ═══════════════════════════════════════════════════════════════════
  // Handlers
  // ═══════════════════════════════════════════════════════════════════

  private setupHandlers(): void {
    describeMessages(this.manifest, [{name:'getDurableSnapshot',description:'Read a source/data snapshot directly from Storage after durable acknowledgement.',parameters:{objectId:protocolText}}]);
    this.on('save', async (msg: AbjectMessage) => {
      const { objectId, manifest, source, owner, data, folder, loading } = msg.payload as {
        objectId: string;
        manifest: AbjectManifest;
        source: string;
        owner: string;
        data?: Record<string, unknown>;
        folder?: string;
        loading?: Loading;
      };
      // An object saving itself keeps the owner its registration records: a
      // claimed `package:<name>` would write that package's data instead.
      const registered = await this.requireSnapshotWriter(msg, objectId, 'save');
      const finalOwner = registered === undefined ? owner : (registered.owner ?? this.findEntry(objectId)?.owner ?? '');
      return this.saveSnapshot(objectId, manifest, source, finalOwner, data, { folder, loading });
    });

    this.on('create', async (msg: AbjectMessage) => {
      const { manifest, source, data, folder, tags, loading, owner } = msg.payload as {
        manifest: AbjectManifest; source: string; data?: Record<string, unknown>;
        folder?: string; tags?: string[]; loading?: Loading; owner?: string;
      };
      const caller = msg.routing.from;
      const builtIn = await this.isBuiltInCaller(caller);
      // Anyone may keep an object of their own; only a built-in object makes
      // one on another's behalf.
      precondition(owner === undefined || owner === caller || builtIn,
        'create: an object is owned by whoever creates it (only built-in objects name another owner)');
      return this.createObject({ manifest, source, data, owner: owner ?? caller, placement: { folder, tags, loading } });
    });

    this.on('copy', async (msg: AbjectMessage) => {
      const { objectId, data, name, folder, tags, loading } = msg.payload as {
        objectId: string; data?: Record<string, unknown>; name?: string;
        folder?: string; tags?: string[]; loading?: Loading;
      };
      const caller = msg.routing.from;
      const builtIn = await this.isBuiltInCaller(caller);
      const entry = this.requireEntry(objectId, 'copy');
      precondition(!isPackageOwner(entry.owner), 'copy: a package\'s abjects are copied from the package, not from this store');
      // A copy carries the original's source, so it is made for the original's
      // owner, the object itself, or a built-in object (acting for its owner).
      if (!builtIn) {
        precondition(caller === entry.owner || caller === entry.objectId,
          'copy: an object is copied by its owner, by itself, or by a built-in object');
      }
      const full = await this.fullRecord(entry);
      const manifest = name ? { ...entry.manifest, name } : entry.manifest;
      return this.createObject({
        manifest,
        source: full.source,
        data: data ?? structuredClone(full.data ?? {}),
        owner: builtIn ? entry.owner : caller,
        placement: { folder: folder ?? entry.folder, tags: tags ?? entry.manifest.tags, loading: loading ?? entry.loading },
      });
    });

    this.on('place', async (msg: AbjectMessage) => {
      const { objectId, folder, tags, loading } = msg.payload as { objectId: string; folder?: string; tags?: string[]; loading?: Loading };
      await this.requireSnapshotWriter(msg, objectId, 'place');
      return this.placeObject(this.requireEntry(objectId, 'place'), { folder, tags, loading });
    });

    this.on('remove', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: string };
      await this.requireSnapshotWriter(msg, objectId, 'remove');
      return this.removeSnapshot(objectId);
    });

    this.on('list', async (msg: AbjectMessage) => {
      const { folder, tag, loading } = (msg.payload ?? {}) as { folder?: string; tag?: string; loading?: Loading };
      return this.userEntries()
        .filter(e => !folder || e.folder === folder || e.folder.startsWith(`${folder}/`))
        .filter(e => !tag || (e.manifest.tags ?? []).includes(tag))
        .filter(e => !loading || e.loading === loading)
        .map(e => this.describeEntry(e));
    });

    this.on('listFolders', async () => {
      const counts = new Map<string, number>();
      for (const e of this.userEntries()) counts.set(e.folder, (counts.get(e.folder) ?? 0) + 1);
      return [...counts].sort((a, b) => a[0].localeCompare(b[0])).map(([folder, count]) => ({ folder, count }));
    });

    this.on('removeFolder', async (msg: AbjectMessage) => {
      const { folder } = msg.payload as { folder: string };
      precondition(isFolderName(folder), 'removeFolder: folder must be a folder name such as "user/recipes"');
      const caller = msg.routing.from;
      const builtIn = await this.isBuiltInCaller(caller);
      const inFolder = this.userEntries()
        .filter(e => e.folder === folder || e.folder.startsWith(`${folder}/`))
        .filter(e => builtIn || e.owner === caller);
      for (const entry of inFolder) await this.retireEntry(entry);
      log.info(`Removed folder '${folder}': ${inFolder.length} object(s)`);
      return { removed: inFolder.length };
    });

    this.on('wake', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: string };
      return this.wake(this.requireEntry(objectId, 'wake'));
    });

    this.on('hold', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: string };
      const entry = this.requireEntry(objectId, 'hold');
      const holders = this.holds.get(entry.typeId) ?? new Set<AbjectId>();
      holders.add(msg.routing.from);
      this.holds.set(entry.typeId, holders);
      this.touchedAt.set(entry.typeId, Date.now());
      return this.wake(entry);
    });

    this.on('release', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: string };
      const entry = this.findEntry(objectId);
      if (!entry) return false;
      const holders = this.holds.get(entry.typeId);
      const released = holders?.delete(msg.routing.from) ?? false;
      if (holders && holders.size === 0) this.holds.delete(entry.typeId);
      this.touchedAt.set(entry.typeId, Date.now());
      return released;
    });

    // Put idle objects that load when needed to sleep now (the sweep runs
    // every minute on its own); `idleMs` overrides how long counts as idle.
    this.on('sleepIdle', async (msg: AbjectMessage) => {
      precondition(await this.isBuiltInCaller(msg.routing.from), 'sleepIdle is taken from built-in objects only');
      const { idleMs } = (msg.payload ?? {}) as { idleMs?: number };
      precondition(idleMs === undefined || (Number.isFinite(idleMs) && idleMs >= 0), 'sleepIdle: idleMs must be a duration in ms');
      return this.sweepIdle(idleMs ?? AbjectStore.IDLE_MS);
    });

    this.on('savePreview', async (msg: AbjectMessage) => {
      const { objectId, width, height, commands } = msg.payload as { objectId: string; width: number; height: number; commands: unknown[] };
      const entry = this.requireEntry(objectId, 'savePreview');
      const caller = msg.routing.from;
      const holder = this.holds.get(entry.typeId)?.has(caller) ?? false;
      if (!holder) await this.requireSnapshotWriter(msg, objectId, 'savePreview');
      return this.savePreview(entry, width, height, commands);
    });

    this.on('getPreview', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: string };
      const entry = this.findEntry(objectId);
      if (!entry?.preview || !this.storageId) return null;
      return await this.request<ObjectPreview | null>(request(this.id, this.storageId, 'get', { key: previewKey(entry.typeId) })).catch(() => null);
    });

    // Registry catalog events (we subscribe in onInit). A registration whose
    // manifest differs from the snapshot's is the snapshot falling behind.
    const adoptManifest = (msg: AbjectMessage) => {
      if (msg.routing.from !== this.registryId) return;
      const reg = msg.payload as { id?: string; manifest?: AbjectManifest } | undefined;
      if (!reg?.id || !reg.manifest?.interface) return;
      const entry = this.findEntry(reg.id);
      if (!entry || entry.objectId !== reg.id) return;
      if (JSON.stringify(entry.manifest) === JSON.stringify(reg.manifest)) return;
      entry.manifest = reg.manifest;
      entry.savedAt = Date.now();
      this.schedulePersist();
      log.info(`Snapshot manifest refreshed for '${reg.manifest.name}' from the Registry`);
    };
    this.on('manifestUpdated', adoptManifest);
    this.on('objectRegistered', adoptManifest);
    this.on('objectUpdated', adoptManifest);
    this.on('objectUnregistered', () => undefined);

    this.on('getDurableSnapshot', async msg => {
      if (!this.storageId) throw new Error('Storage unavailable');
      const { objectId } = msg.payload as { objectId: string };
      const index = await this.request<StoreEntry[] | null>(request(this.id, this.storageId, 'get', { key: INDEX_KEY }));
      const entry = index?.find(e => e.objectId === objectId || e.typeId === objectId);
      if (!entry) return null;
      const [body, source] = await Promise.all([
        this.request<{ data?: Record<string, unknown> } | null>(request(this.id, this.storageId, 'get', { key: bodyKey(entry.typeId) })),
        this.request<string | null>(request(this.id, this.storageId, 'get', { key: sourceKey(entry.sourceHash) })),
      ]);
      return { ...this.describeEntry(entry), manifest: entry.manifest, source: source ?? '', data: body?.data } ;
    });

    this.on('getPackageData', async (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      precondition(typeof name === 'string' && name !== '', 'name must not be empty');
      // Package data can hold a package's credentials: it goes to built-in
      // objects (WorkspaceManager hands it to the abject at spawn) and to that
      // package's own abjects.
      if (!(await this.isBuiltInCaller(msg.routing.from))) {
        const caller = await this.registrationOf(msg.routing.from);
        precondition(!!caller && isPackageOwner(caller.owner)
          && this.findPackageEntry(name)?.owner === caller.owner,
          'package data goes to built-in objects and to that package\'s own abjects only');
      }
      const entry = this.findPackageEntry(name);
      return entry ? (await this.readBody(entry.typeId))?.data ?? null : null;
    });

    this.on('restoreAll', async (msg: AbjectMessage) => {
      precondition(await this.isBuiltInCaller(msg.routing.from), 'restoreAll is taken from built-in objects only');
      return this.restoreAll();
    });

    // A crashed worker takes its objects with it; their snapshots survive.
    this.on('restoreLost', async (msg: AbjectMessage) => {
      precondition(await this.isBuiltInCaller(msg.routing.from), 'restoreLost is taken from built-in objects only');
      const { objectIds } = msg.payload as { objectIds: string[] };
      const wanted = new Set(Array.isArray(objectIds) ? objectIds : []);
      const hit = this.userEntries().filter(e => wanted.has(e.objectId));
      if (hit.length === 0) return { restored: 0, failed: 0, errors: [] };
      log.info(`restoreLost: ${hit.length} snapshot(s) belong to objects lost with a worker`);
      return this.restoreAll(wanted);
    });

    this.on('listVersions', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: string };
      const entry = this.findEntry(objectId);
      if (!entry) return null;
      const sizeOf = async (hash: string) => (await this.readSource(hash))?.length ?? 0;
      return {
        name: entry.manifest.name,
        typeId: entry.typeId,
        objectId: entry.objectId,
        current: { savedAt: entry.savedAt, sizeChars: await sizeOf(entry.sourceHash) },
        versions: await Promise.all((entry.versions ?? []).map(async (v, index) => ({
          index,
          savedAt: v.savedAt,
          sizeChars: await sizeOf(v.sourceHash),
        }))),
      };
    });

    this.on('getVersion', async (msg: AbjectMessage) => {
      const { objectId, index } = msg.payload as { objectId: string; index: number };
      const entry = this.findEntry(objectId);
      precondition(entry !== undefined, `No snapshot found for '${objectId}'`);
      const versions = entry!.versions ?? [];
      precondition(
        Number.isInteger(index) && index >= 0 && index < versions.length,
        `Version index ${index} out of range (object has ${versions.length} prior versions)`,
      );
      const v = versions[index];
      return { source: await this.readSource(v.sourceHash) ?? '', savedAt: v.savedAt };
    });

    this.on('restoreVersion', async (msg: AbjectMessage) => {
      const { objectId, index } = msg.payload as { objectId: string; index: number };
      await this.requireSnapshotWriter(msg, objectId, 'restoreVersion');
      return this.restoreVersion(objectId, index);
    });

    this.on('deleteVersion', async (msg: AbjectMessage) => {
      const { objectId, index } = msg.payload as { objectId: string; index: number };
      await this.requireSnapshotWriter(msg, objectId, 'deleteVersion');
      const entry = this.findEntry(objectId);
      if (!entry) return { success: false, error: `No snapshot found for '${objectId}'` };
      const versions = entry.versions ?? [];
      if (!Number.isInteger(index) || index < 0 || index >= versions.length) {
        return { success: false, error: `Version index ${index} out of range (object has ${versions.length} prior versions)` };
      }
      const removed = versions.splice(index, 1)[0];
      if (versions.length === 0) delete entry.versions;
      this.schedulePersist();
      await this.dropUnusedSources([removed.sourceHash]);
      log.info(`Deleted version of '${entry.manifest.name}' from ${new Date(removed.savedAt).toISOString()} (${versions.length} remain)`);
      this.changed('versionDeleted', { typeId: entry.typeId, objectId: entry.objectId, deletedSavedAt: removed.savedAt });
      return { success: true };
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Finding records
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Resolve a record by typeId key, live objectId, a recently retired
   * objectId, or manifest name. Callers usually hold the live objectId,
   * which changes across restarts and sleeps, while records are keyed by
   * durable typeId.
   */
  private findEntry(ref: string): StoreEntry | undefined {
    if (!ref) return undefined;
    const direct = this.entries.get(ref);
    if (direct) return direct;
    for (const entry of this.entries.values()) {
      if (entry.objectId === ref) return entry;
    }
    const retired = this.retiredIds.get(ref);
    if (retired) return this.entries.get(retired.typeId);
    for (const entry of this.entries.values()) {
      if (entry.manifest.name === ref && !isPackageOwner(entry.owner)) return entry;
    }
    return undefined;
  }

  private requireEntry(ref: string, method: string): StoreEntry {
    const entry = this.findEntry(ref);
    precondition(entry !== undefined, `${method}: no kept object '${ref}'`);
    return entry!;
  }

  /** The record for a package type, if any. */
  private findPackageEntry(typeName: string): StoreEntry | undefined {
    const entry = this.entries.get(packageDataKey(typeName));
    return entry && isPackageOwner(entry.owner) ? entry : undefined;
  }

  /** Every record that is a user object (not package data). */
  private userEntries(): StoreEntry[] {
    return [...this.entries.values()].filter(e => !isPackageOwner(e.owner));
  }

  /** A record as `list` shows it: no source, no data. */
  private describeEntry(entry: StoreEntry): Record<string, unknown> {
    return {
      typeId: entry.typeId,
      objectId: entry.objectId,
      name: entry.manifest.name,
      description: entry.manifest.description,
      tags: entry.manifest.tags ?? [],
      folder: entry.folder,
      loading: entry.loading,
      asleep: !entry.objectId,
      owner: entry.owner,
      savedAt: entry.savedAt,
      ...(entry.preview ? { preview: entry.preview } : {}),
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // Storage: index, bodies, sources, previews
  // ═══════════════════════════════════════════════════════════════════

  private async storageGet<T>(key: string): Promise<T | null> {
    precondition(this.storageId !== undefined, 'Storage unavailable');
    return await this.request<T | null>(request(this.id, this.storageId!, 'get', { key }));
  }

  private async storageSet(key: string, value: unknown): Promise<void> {
    precondition(this.storageId !== undefined, 'Storage unavailable; the record is not durable');
    await this.request(request(this.id, this.storageId!, 'set', { key, value }));
  }

  private async storageDelete(key: string): Promise<void> {
    if (!this.storageId) return;
    await this.request(request(this.id, this.storageId, 'delete', { key })).catch(() => undefined);
  }

  /** Keep a source once, by hash; returns the hash. */
  private async writeSource(source: string): Promise<string> {
    const hash = await sha256Hex(source);
    if (!this.storedSources.has(hash)) {
      await this.storageSet(sourceKey(hash), source);
      this.storedSources.add(hash);
    }
    this.cacheSource(hash, source);
    return hash;
  }

  private cacheSource(hash: string, source: string): void {
    this.sourceCache.delete(hash);
    this.sourceCache.set(hash, source);
    if (this.sourceCache.size > AbjectStore.SOURCE_CACHE_MAX) {
      this.sourceCache.delete(this.sourceCache.keys().next().value!);
    }
  }

  private async readSource(hash: string): Promise<string | undefined> {
    const cached = this.sourceCache.get(hash);
    if (cached !== undefined) return cached;
    const source = await this.storageGet<string>(sourceKey(hash)).catch(() => null);
    if (typeof source !== 'string') return undefined;
    this.cacheSource(hash, source);
    return source;
  }

  private async readBody(typeId: string): Promise<{ data?: Record<string, unknown> } | undefined> {
    return (await this.storageGet<{ data?: Record<string, unknown> }>(bodyKey(typeId)).catch(() => null)) ?? undefined;
  }

  /** A record with its source and data, read from Storage. */
  private async fullRecord(entry: StoreEntry): Promise<AbjectSnapshot> {
    const [source, body] = await Promise.all([this.readSource(entry.sourceHash), this.readBody(entry.typeId)]);
    precondition(typeof source === 'string' && source.length > 0, `The source of '${entry.manifest.name}' is missing from Storage`);
    return {
      typeId: entry.typeId,
      objectId: entry.objectId,
      manifest: entry.manifest,
      source: source!,
      owner: entry.owner,
      savedAt: entry.savedAt,
      folder: entry.folder,
      loading: entry.loading,
      ...(body?.data !== undefined ? { data: body.data } : {}),
    };
  }

  /** Drop stored sources no record or version refers to any more. */
  private async dropUnusedSources(candidates: string[]): Promise<void> {
    if (candidates.length === 0) return;
    const used = new Set<string>();
    for (const e of this.entries.values()) {
      used.add(e.sourceHash);
      for (const v of e.versions ?? []) used.add(v.sourceHash);
    }
    for (const hash of new Set(candidates)) {
      if (used.has(hash)) continue;
      this.storedSources.delete(hash);
      this.sourceCache.delete(hash);
      await this.storageDelete(sourceKey(hash));
    }
  }

  /**
   * Load the index. A store still in the old single-array layout is moved
   * to the new one first: each source kept once, each object's data in its
   * own body, the index without either.
   */
  private async loadFromStorage(): Promise<void> {
    try {
      const index = await this.storageGet<StoreEntry[]>(INDEX_KEY);
      if (Array.isArray(index)) {
        for (const entry of index) {
          if (!entry?.typeId || !isValidManifest(entry.manifest)) continue;
          this.entries.set(entry.typeId, { ...entry, folder: entry.folder || DEFAULT_FOLDER, loading: entry.loading ?? 'boot' });
          this.storedSources.add(entry.sourceHash);
          for (const v of entry.versions ?? []) this.storedSources.add(v.sourceHash);
        }
        log.info(`Loaded ${this.entries.size} records from storage`);
        return;
      }
      const legacy = await this.storageGet<Array<Record<string, unknown>>>(LEGACY_KEY);
      if (Array.isArray(legacy) && legacy.length > 0) await this.migrateLegacy(legacy);
    } catch (err) {
      log.warn('Failed to load from storage:', err);
    }
  }

  private async migrateLegacy(legacy: Array<Record<string, unknown>>): Promise<void> {
    let moved = 0;
    for (const snap of legacy) {
      const manifest = snap.manifest as AbjectManifest;
      const source = snap.source as string;
      const typeId = (snap.typeId as string) || (snap.objectId as string);
      if (!typeId || !isValidManifest(manifest) || typeof source !== 'string' || !source) {
        log.warn(`Migration: dropping an unrestorable record '${String((manifest as { name?: unknown } | undefined)?.name ?? typeId)}'`);
        continue;
      }
      const sourceHash = await this.writeSource(source);
      const versions: VersionRef[] = [];
      for (const v of (snap.versions as Array<{ source: string; savedAt: number }> | undefined) ?? []) {
        if (typeof v?.source === 'string' && v.source) versions.push({ sourceHash: await this.writeSource(v.source), savedAt: v.savedAt });
      }
      const owner = (snap.owner as string) ?? '';
      if (snap.data !== undefined) await this.storageSet(bodyKey(typeId), { data: snap.data });
      this.entries.set(typeId, {
        typeId,
        objectId: (snap.objectId as string) ?? '',
        manifest,
        owner,
        savedAt: (snap.savedAt as number) ?? Date.now(),
        sourceHash,
        folder: isPackageOwner(owner) ? PACKAGE_FOLDER : DEFAULT_FOLDER,
        loading: 'boot',
        ...(versions.length > 0 ? { versions } : {}),
      });
      moved++;
    }
    await this.persistIndex();
    await this.storageDelete(LEGACY_KEY);
    log.info(`Moved ${moved} records to the per-object layout`);
  }

  private async persistIndex(): Promise<void> {
    await this.storageSet(INDEX_KEY, [...this.entries.values()]);
  }

  /**
   * Debounced index write. The index is small (no source, no data), and
   * back-to-back saves coalesce into one Storage round trip.
   */
  private schedulePersist(): void {
    this.persistDirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.flushPersist().catch(err => log.warn('Deferred index persistence failed:', err));
    }, AbjectStore.PERSIST_DEBOUNCE_MS);
  }

  private async flushPersist(): Promise<void> {
    if (this.persistInFlight) await this.persistInFlight;
    if (!this.persistDirty) return;
    this.persistDirty = false;
    this.persistInFlight = this.persistIndex();
    try {
      await this.persistInFlight;
    } catch (err) {
      this.persistDirty = true;
      throw err;
    } finally {
      this.persistInFlight = undefined;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════

  protected override async onInit(): Promise<void> {
    this.storageId = await this.requireDep('Storage');
    this.factoryId = await this.requireDep('Factory');

    // Discover workspace Registry so we can register user objects in it
    this.registryId = await this.discoverDep('Registry') ?? undefined;
    // Follow the catalog: a manifest that changes on a live object (a source
    // update that grew a handler, a redraft) must reach the snapshot too, or
    // the next restart restores the old self-description.
    if (this.registryId) {
      try { await this.request(request(this.id, this.registryId, 'subscribe', {})); }
      catch (err) { log.warn(`could not subscribe to Registry: ${err instanceof Error ? err.message : String(err)}`); }
    }

    // On a desktop, WidgetManager is told which workspace each object belongs
    // to so its windows show with that workspace. A headless instance has none.
    this.widgetManagerId = await this.discoverDep('WidgetManager') ?? undefined;

    await this.loadFromStorage();
    this.setRecurringTimer(() => { void this.sweepIdle(); }, AbjectStore.SWEEP_MS);
  }

  protected override async onStop(): Promise<void> {
    await super.onStop();
    // Flush a pending debounced write so no index change is lost at
    // shutdown. Status is already 'stopped' so request() would refuse; post
    // the write as a fire-and-forget event straight to the bus.
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (this.persistDirty && this.storageId) {
      this.persistDirty = false;
      try {
        this.bus.send(event(this.id, this.storageId, 'set', { key: INDEX_KEY, value: [...this.entries.values()] }));
      } catch { /* best effort at shutdown */ }
    }
  }

  /**
   * Our workspace id, from the workspace registry we were spawned into. It is
   * what user typeIds (`{peer}/{workspace}/user/{Name}`) are made of, so it
   * must not depend on anything that draws windows.
   */
  private async ensureWorkspaceId(): Promise<string | undefined> {
    if (this.workspaceId) return this.workspaceId;
    const registryId = await this.resolveRegistryId();
    if (!registryId) return undefined;
    try {
      const ws = await this.request<string | null>(request(this.id, registryId, 'getWorkspaceId', {}));
      this.workspaceId = ws ?? undefined;
    } catch {
      // The global registry has no workspace; neither do we.
    }
    return this.workspaceId;
  }

  private async ensurePeerId(): Promise<string | undefined> {
    if (this.peerId) return this.peerId;
    try {
      const identityId = await this.discoverDep('Identity');
      if (identityId) {
        const identity = await this.request<{ peerId: string }>(request(this.id, identityId, 'getIdentity', {}));
        this.peerId = identity.peerId;
      }
    } catch { /* Identity may not be available */ }
    return this.peerId;
  }

  /**
   * A durable TypeId for a new object named `name`: `{peer}/{ws}/user/{Name}`,
   * numbered (`-2`, `-3`) when another record holds it, so copies of one
   * object each keep their own record.
   */
  private async newTypeId(name: string, objectId?: string): Promise<string> {
    await this.ensurePeerId();
    await this.ensureWorkspaceId();
    const base = this.peerId && this.workspaceId ? `${this.peerId}/${this.workspaceId}/user/${name}` : (objectId || name);
    const free = (id: string) => { const e = this.entries.get(id); return !e || (!!objectId && e.objectId === objectId); };
    if (free(base)) return base;
    for (let n = 2; ; n++) {
      if (free(`${base}-${n}`)) return `${base}-${n}`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Saving
  // ═══════════════════════════════════════════════════════════════════

  /** Check a placement and turn it into folder, loading and manifest tags. */
  private placementOf(p: Placement, fallback: { folder: string; loading: Loading }): { folder: string; loading: Loading; tags?: string[] } {
    precondition(p.folder === undefined || isFolderName(p.folder),
      'folder must be lowercase words joined by "-", nested with "/", such as "user/recipes"');
    precondition(p.folder === undefined || (p.folder !== PACKAGE_FOLDER && !p.folder.startsWith(`${PACKAGE_FOLDER}/`)),
      'the "package" folder holds installed packages\' data');
    precondition(p.loading === undefined || p.loading === 'boot' || p.loading === 'needed',
      'loading must be "boot" or "needed"');
    let tags: string[] | undefined;
    if (p.tags !== undefined) {
      precondition(Array.isArray(p.tags) && p.tags.every(t => typeof t === 'string' && t.trim().length > 0 && t.length <= 40),
        'tags must be short words');
      tags = [...new Set(p.tags.map(t => t.trim().toLowerCase()))];
      const reserved = tags.filter(t => RESERVED_TAGS.has(t));
      precondition(reserved.length === 0, `tags may not claim system roles: ${reserved.join(', ')}`);
    }
    return { folder: p.folder ?? fallback.folder, loading: p.loading ?? fallback.loading, ...(tags ? { tags } : {}) };
  }

  /** A manifest carrying `tags` (system tags it already had stay). */
  private withTags(manifest: AbjectManifest, tags: string[] | undefined): AbjectManifest {
    if (!tags) return manifest;
    const kept = (manifest.tags ?? []).filter(t => RESERVED_TAGS.has(t) || t === 'scriptable');
    return { ...manifest, tags: [...new Set([...kept, ...tags])] };
  }

  async saveSnapshot(
    objectId: string,
    manifest: AbjectManifest,
    source: string,
    owner: string,
    data?: Record<string, unknown>,
    placement: Placement = {},
  ): Promise<boolean> {
    precondition(objectId !== '', 'objectId must not be empty');
    precondition(source !== '', 'source must not be empty');
    precondition(
      isValidManifest(manifest),
      'manifest must be a structured AbjectManifest with a non-empty name and interface.methods (refusing to persist free-form text)',
    );
    if (isPackageOwner(owner)) {
      return this.savePackageSnapshot(objectId, manifest, source, owner, data);
    }

    return withKeyedLock(`${this.id}:save:${objectId}`, async () => {
      const wsId = await this.ensureWorkspaceId();
      // The last save of an object just put to sleep lands on its record and
      // leaves it asleep.
      const retired = this.retiredIds.has(objectId);
      let existing = this.findEntry(objectId);
      if (existing && existing.objectId !== objectId && !retired) {
        // Found by name only: another object of the same name. This one gets
        // its own record.
        existing = undefined;
      }
      let typeId = existing?.typeId;
      if (!typeId) {
        // The Factory may have given the object a typeId at spawn; it keeps
        // that one when no other record holds it.
        const registered = await this.registrationOf(objectId);
        typeId = registered?.typeId && !this.entries.has(registered.typeId)
          ? registered.typeId
          : await this.newTypeId(manifest.name, objectId);
      }
      const place = this.placementOf(placement, { folder: existing?.folder ?? DEFAULT_FOLDER, loading: existing?.loading ?? 'boot' });

      const sourceHash = await this.writeSource(source);
      // Version history: a save that CHANGES the source pushes the outgoing
      // source onto the ring first, so it stays restorable.
      let versions = existing?.versions;
      if (existing && existing.sourceHash !== sourceHash) {
        versions = [{ sourceHash: existing.sourceHash, savedAt: existing.savedAt }, ...(existing.versions ?? [])]
          .slice(0, AbjectStore.MAX_VERSIONS);
        log.info(`Source changed for '${manifest.name}' — kept prior version (${versions.length}/${AbjectStore.MAX_VERSIONS} kept)`);
      }
      // A save without data (an ObjectCreator-driven save after a source
      // edit) keeps the data the object had.
      if (data !== undefined) await this.storageSet(bodyKey(typeId), { data });
      const finalData = data !== undefined ? data : (existing ? (await this.readBody(typeId))?.data : undefined);

      const finalManifest = this.withTags(manifest, place.tags);
      const entry: StoreEntry = {
        typeId,
        objectId: retired ? (existing?.objectId ?? '') : objectId,
        manifest: finalManifest,
        owner,
        savedAt: Date.now(),
        sourceHash,
        folder: place.folder,
        loading: place.loading,
        ...(versions && versions.length > 0 ? { versions } : {}),
        ...(existing?.preview ? { preview: existing.preview } : {}),
      };
      this.entries.set(typeId, entry);
      this.schedulePersist();
      await this.flushPersist();
      if (existing && existing.sourceHash !== sourceHash && versions && versions.length >= AbjectStore.MAX_VERSIONS) {
        await this.dropUnusedSources((existing.versions ?? []).map(v => v.sourceHash));
      }

      // Register the object in the workspace registry so it appears in AppExplorer/Taskbar
      if (this.registryId && !retired) {
        try {
          await this.request(request(this.id, this.registryId, 'register', {
            objectId, manifest: finalManifest, owner, source, typeId: typeId as TypeId,
            ...(finalData !== undefined ? { data: finalData } : {}),
          }));
        } catch { /* best effort — registry may not be ready */ }
      }
      if (!retired) await this.tagWorkspace(objectId, wsId);
      log.info(`Saved snapshot for '${manifest.name}' (${objectId})`);
      return true;
    });
  }

  /** Tell WidgetManager which workspace an object's windows belong to. */
  private async tagWorkspace(objectId: string, wsId?: string): Promise<void> {
    if (!this.widgetManagerId || !wsId || !objectId) return;
    try {
      await this.request(request(this.id, this.widgetManagerId, 'setObjectWorkspace', { objectId: objectId as AbjectId, workspaceId: wsId }));
    } catch { /* Best effort — WidgetManager may not be ready */ }
  }

  /**
   * Save the data of an abject from an installed package. One record per
   * package type in this workspace, under `package/<TypeName>`. It is never
   * restored as a user object (the package supplies the code, and
   * WorkspaceManager hands this data back when it spawns the package), and it
   * keeps no version history (the source is not edited here).
   */
  private async savePackageSnapshot(
    objectId: string,
    manifest: AbjectManifest,
    source: string,
    owner: string,
    data?: Record<string, unknown>,
  ): Promise<boolean> {
    const key = packageDataKey(manifest.name);
    const existing = this.findPackageEntry(manifest.name);
    const sourceHash = await this.writeSource(source);
    if (data !== undefined) await this.storageSet(bodyKey(key), { data });
    const finalData = data !== undefined ? data : (existing ? (await this.readBody(key))?.data : undefined);
    this.entries.set(key, {
      typeId: key, objectId, manifest, owner, savedAt: Date.now(), sourceHash,
      folder: PACKAGE_FOLDER, loading: 'boot',
    });
    this.schedulePersist();
    await this.flushPersist();
    if (existing && existing.sourceHash !== sourceHash) await this.dropUnusedSources([existing.sourceHash]);

    // Keep the live registration's data current (a respawn after a worker
    // crash reads it), under the typeId WorkspaceManager stamped at spawn.
    if (this.registryId) {
      try {
        const reg = await this.request<{ manifest: AbjectManifest; source?: string; typeId?: TypeId } | null>(
          request(this.id, this.registryId, 'lookup', { objectId }));
        if (reg) {
          await this.request(request(this.id, this.registryId, 'register', {
            objectId, manifest: reg.manifest, owner, source: reg.source ?? source,
            ...(reg.typeId ? { typeId: reg.typeId } : {}),
            ...(finalData !== undefined ? { data: finalData } : {}),
          }));
        }
      } catch { /* best effort — registry may not be ready */ }
    }

    log.info(`Saved package data for '${manifest.name}' (${objectId})`);
    return true;
  }

  /**
   * Make a new kept object. It starts now when it loads at boot, else it is
   * registered asleep and starts the first time something needs it.
   */
  private async createObject(req: {
    manifest: AbjectManifest; source: string; data?: Record<string, unknown>; owner: string; placement: Placement;
  }): Promise<{ typeId: string; objectId: string }> {
    precondition(isValidManifest(req.manifest), 'create: manifest must have a name and interface.methods');
    precondition(typeof req.source === 'string' && req.source.length > 0, 'create: source must not be empty');
    precondition(req.data === undefined || (typeof req.data === 'object' && !Array.isArray(req.data)), 'create: data must be an object');
    precondition(!isPackageOwner(req.owner), 'create: package abjects come from their package');
    const place = this.placementOf(req.placement, { folder: DEFAULT_FOLDER, loading: 'boot' });
    const typeId = await this.newTypeId(req.manifest.name);
    const sourceHash = await this.writeSource(req.source);
    if (req.data !== undefined) await this.storageSet(bodyKey(typeId), { data: req.data });
    const entry: StoreEntry = {
      typeId,
      objectId: '',
      manifest: this.withTags(req.manifest, place.tags),
      owner: req.owner,
      savedAt: Date.now(),
      sourceHash,
      folder: place.folder,
      loading: place.loading,
    };
    this.entries.set(typeId, entry);
    this.schedulePersist();
    await this.flushPersist();
    log.info(`Created '${entry.manifest.name}' in '${entry.folder}' (${entry.loading})`);
    if (entry.loading === 'boot') {
      return { typeId, objectId: await this.wake(entry) };
    }
    await this.registerAsleep([entry]);
    return { typeId, objectId: '' };
  }

  /** Move, retag or change when an object loads. */
  private async placeObject(entry: StoreEntry, p: Placement): Promise<boolean> {
    precondition(!isPackageOwner(entry.owner), 'place: package data stays with its package');
    const place = this.placementOf(p, { folder: entry.folder, loading: entry.loading });
    entry.folder = place.folder;
    entry.loading = place.loading;
    if (place.tags) {
      entry.manifest = this.withTags(entry.manifest, place.tags);
      if (entry.objectId && this.registryId) {
        try {
          await this.request(request(this.id, this.registryId, 'updateManifest', { objectId: entry.objectId, manifest: entry.manifest }));
        } catch { /* registry sync is best effort */ }
      }
    }
    entry.savedAt = Date.now();
    this.schedulePersist();
    await this.flushPersist();
    if (!entry.objectId) {
      // Asleep: the Registry's sleeping entry carries the new tags; one that
      // now loads at boot starts now.
      if (entry.loading === 'boot') await this.wake(entry);
      else await this.registerAsleep([entry]);
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Removing
  // ═══════════════════════════════════════════════════════════════════

  /** Remove a record by objectId, typeId or name. */
  async removeSnapshot(ref: string): Promise<boolean> {
    const entry = this.findEntry(ref);
    if (!entry) return false;
    await this.dropEntry(entry);
    log.info(`Removed snapshot for ${ref}`);
    return true;
  }

  /** Forget a record and everything stored for it. */
  private async dropEntry(entry: StoreEntry): Promise<void> {
    this.entries.delete(entry.typeId);
    this.holds.delete(entry.typeId);
    this.touchedAt.delete(entry.typeId);
    this.schedulePersist();
    await this.flushPersist();
    await this.storageDelete(bodyKey(entry.typeId));
    if (entry.preview) await this.storageDelete(previewKey(entry.typeId));
    await this.dropUnusedSources([entry.sourceHash, ...(entry.versions ?? []).map(v => v.sourceHash)]);
    if (!entry.objectId && this.registryId) {
      try { await this.request(request(this.id, this.registryId, 'forgetAsleep', { typeIds: [entry.typeId] })); } catch { /* registry may be gone */ }
    }
  }

  /** Stop an object if it runs, then forget it. */
  private async retireEntry(entry: StoreEntry): Promise<void> {
    if (entry.objectId && this.factoryId) {
      try {
        await this.request(request(this.id, this.factoryId, 'kill', { objectId: entry.objectId, keepSnapshot: true }), 15_000);
      } catch { /* already gone */ }
    }
    await this.dropEntry(entry);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Previews
  // ═══════════════════════════════════════════════════════════════════

  private async savePreview(entry: StoreEntry, width: number, height: number, commands: unknown[]): Promise<boolean> {
    precondition(Number.isFinite(width) && width > 0 && width <= 4096, 'savePreview: width must be 1 to 4096');
    precondition(Number.isFinite(height) && height > 0 && height <= 8192, 'savePreview: height must be 1 to 8192');
    precondition(Array.isArray(commands) && commands.length <= AbjectStore.PREVIEW_MAX_COMMANDS,
      `savePreview: at most ${AbjectStore.PREVIEW_MAX_COMMANDS} draw commands`);
    const preview: ObjectPreview = { width, height, commands, savedAt: Date.now() };
    precondition(JSON.stringify(preview).length <= AbjectStore.PREVIEW_MAX_CHARS,
      `savePreview: a preview is at most ${AbjectStore.PREVIEW_MAX_CHARS} characters`);
    await this.storageSet(previewKey(entry.typeId), preview);
    if (!entry.preview || entry.preview.width !== width || entry.preview.height !== height) {
      entry.preview = { width, height };
      this.schedulePersist();
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Waking and sleeping
  // ═══════════════════════════════════════════════════════════════════

  /** Tell the Registry about objects that sleep: findable by name, tags and typeId, woken on lookup. */
  private async registerAsleep(entries: StoreEntry[]): Promise<void> {
    if (!this.registryId || entries.length === 0) return;
    try {
      await this.request(request(this.id, this.registryId, 'registerAsleep', {
        entries: entries.map(e => ({ typeId: e.typeId, manifest: e.manifest, owner: e.owner, folder: e.folder })),
      }));
    } catch (err) {
      log.warn(`could not register sleeping objects: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Start an object from its record (no-op when it runs); its live objectId. */
  private async wake(entry: StoreEntry): Promise<AbjectId> {
    precondition(!isPackageOwner(entry.owner), 'wake: package abjects come from their package');
    this.touchedAt.set(entry.typeId, Date.now());
    if (entry.objectId) return entry.objectId as AbjectId;
    const inFlight = this.waking.get(entry.typeId);
    if (inFlight) return inFlight;
    const started = (async () => {
      const objectId = await this.spawnEntry(entry);
      // An object that loads when needed hears `startup` when it declares
      // it: its moment to pick up its data (timers, subscriptions).
      if (entry.loading === 'needed' && entry.manifest.interface.methods.some(m => m.name === 'startup')) {
        try { await this.request(request(this.id, objectId, 'startup', {}), 10_000); }
        catch (err) { log.warn(`'${entry.manifest.name}' startup failed: ${err instanceof Error ? err.message : String(err)}`); }
      }
      return objectId;
    })();
    this.waking.set(entry.typeId, started);
    try {
      return await started;
    } finally {
      this.waking.delete(entry.typeId);
    }
  }

  /** Spawn one record through the Factory and note its live id. */
  private async spawnEntry(entry: StoreEntry): Promise<AbjectId> {
    precondition(this.factoryId !== undefined, 'Factory unavailable');
    const full = await this.fullRecord(entry);
    const spawned = await this.request<SpawnResult>(
      request(this.id, this.factoryId!, 'spawn', {
        manifest: entry.manifest,
        source: full.source,
        owner: entry.owner,
        parentId: this.id,
        registryHint: this.registryId,
        typeId: entry.typeId as TypeId,
        ...(full.data !== undefined ? { data: full.data } : {}),
      }),
    );
    precondition(typeof spawned?.objectId === 'string' && spawned.objectId.length > 0, `spawning '${entry.manifest.name}' returned no object`);
    entry.objectId = spawned.objectId;
    this.schedulePersist();
    await this.tagWorkspace(spawned.objectId, await this.ensureWorkspaceId());
    log.info(`Started '${entry.manifest.name}' as ${spawned.objectId}`);
    return spawned.objectId as AbjectId;
  }

  /**
   * Put idle objects that load when needed back to sleep: nothing holds them,
   * nothing woke them for IDLE_MS, and they show no window. Their data is
   * flushed as they stop (ScriptableAbject saves on stop).
   */
  private async sweepIdle(idleMs = AbjectStore.IDLE_MS): Promise<number> {
    const now = Date.now();
    for (const [id, retired] of this.retiredIds) {
      if (now - retired.at > AbjectStore.RETIRED_KEEP_MS) this.retiredIds.delete(id);
    }
    const idle = this.userEntries().filter(e => e.loading === 'needed' && e.objectId
      && !(this.holds.get(e.typeId)?.size)
      && now - (this.touchedAt.get(e.typeId) ?? 0) >= idleMs);
    if (idle.length === 0) return 0;
    const windowOwners = new Set<string>();
    if (this.widgetManagerId) {
      try {
        const windows = await this.request<Array<{ owner?: string; ownerId?: string }>>(request(this.id, this.widgetManagerId, 'listWindows', {}));
        for (const w of windows ?? []) { const o = w.owner ?? w.ownerId; if (o) windowOwners.add(o); }
      } catch { /* no display */ }
    }
    let slept = 0;
    for (const entry of idle) {
      if (windowOwners.has(entry.objectId)) continue;
      await this.sleep(entry);
      slept++;
    }
    return slept;
  }

  /** Stop a running object that loads when needed, keeping its record, and register it asleep. */
  private async sleep(entry: StoreEntry): Promise<void> {
    const objectId = entry.objectId;
    if (!objectId || !this.factoryId) return;
    this.retiredIds.set(objectId, { typeId: entry.typeId, at: Date.now() });
    entry.objectId = '';
    this.schedulePersist();
    try {
      await this.request(request(this.id, this.factoryId, 'kill', { objectId, keepSnapshot: true }), 15_000);
    } catch (err) {
      log.warn(`could not put '${entry.manifest.name}' to sleep: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.registerAsleep([entry]);
    log.info(`'${entry.manifest.name}' is asleep`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Restoring
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Bring the workspace's objects back: those that load at boot start (they
   * get new ids); those that load when needed are registered asleep. With
   * `only`, the objects whose live instances a crashed worker took are
   * started again and the rest is left alone. Abjects from installed packages
   * are never restored here: WorkspaceManager spawns them from the package and
   * hands their data back (getPackageData).
   */
  async restoreAll(only?: ReadonlySet<string>): Promise<RestoreResult> {
    const result: RestoreResult = { restored: 0, failed: 0, errors: [] };
    const user = this.userEntries();
    const toStart = only ? user.filter(e => only.has(e.objectId)) : user.filter(e => e.loading === 'boot');
    const toSleep = only ? [] : user.filter(e => e.loading === 'needed');

    if (toStart.length === 0 && toSleep.length === 0) {
      log.info('No snapshots to restore');
      return result;
    }
    log.info(`Restoring ${toStart.length} abjects (${toSleep.length} asleep until needed)...`);
    await this.ensurePeerId();
    await this.ensureWorkspaceId();

    for (const entry of toStart) {
      entry.objectId = '';
      try {
        await this.spawnEntry(entry);
        result.restored++;
        // Auto-start objects tagged 'autostart' or 'agent' so they can
        // re-register with their dependencies (e.g. AgentAbject) without
        // requiring the user to manually open them.
        const tags = entry.manifest.tags ?? [];
        if (tags.includes('autostart') || tags.includes('agent')) {
          try {
            await this.request(request(this.id, entry.objectId as AbjectId, 'startup', {}), 10000);
            log.info(`Auto-started '${entry.manifest.name}'`);
          } catch { /* Best effort — handler may not exist yet */ }
        }
      } catch (err) {
        result.failed++;
        const errMsg = `Failed to restore '${entry.manifest.name}': ${err instanceof Error ? err.message : String(err)}`;
        result.errors.push(errMsg);
        log.warn(errMsg);
      }
    }
    for (const entry of toSleep) entry.objectId = '';
    await this.registerAsleep(toSleep);

    this.persistDirty = true;
    await this.flushPersist();
    log.info(`Restore complete: ${result.restored} restored, ${toSleep.length} asleep, ${result.failed} failed`);
    return result;
  }

  /**
   * Make a prior version the live source: the current source is pushed onto
   * the ring first (a restore is itself undoable), the record updates, the
   * running object gets `updateSource`, and the registry syncs. The version
   * ring keeps its restored entry — restoring is a copy, not a move.
   */
  private async restoreVersion(ref: string, index: number): Promise<{ success: boolean; error?: string }> {
    const entry = this.findEntry(ref);
    if (!entry) return { success: false, error: `No snapshot found for '${ref}'` };
    const versions = entry.versions ?? [];
    if (!Number.isInteger(index) || index < 0 || index >= versions.length) {
      return { success: false, error: `Version index ${index} out of range (object has ${versions.length} prior versions)` };
    }
    const chosen = versions[index];
    const source = await this.readSource(chosen.sourceHash);
    if (!source) return { success: false, error: 'That version\'s source is missing from Storage' };

    // Apply to the live object first — if the old source no longer compiles
    // against today's runtime, fail without touching the record.
    if (entry.objectId) {
      try {
        const result = await this.request<{ success: boolean; error?: string }>(
          request(this.id, entry.objectId as AbjectId, 'updateSource', { source }));
        if (result && result.success === false) return { success: false, error: result.error ?? 'updateSource failed' };
      } catch (err) {
        return { success: false, error: `Live object rejected the version: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    entry.versions = [{ sourceHash: entry.sourceHash, savedAt: entry.savedAt }, ...versions].slice(0, AbjectStore.MAX_VERSIONS);
    entry.sourceHash = chosen.sourceHash;
    entry.savedAt = Date.now();
    this.schedulePersist();
    await this.flushPersist();

    if (this.registryId && entry.objectId) {
      try {
        await this.request(request(this.id, this.registryId, 'updateSource', { objectId: entry.objectId, source }));
      } catch { /* registry sync is best effort */ }
    }

    log.info(`Restored '${entry.manifest.name}' to version from ${new Date(chosen.savedAt).toISOString()}`);
    this.changed('versionRestored', { typeId: entry.typeId, objectId: entry.objectId, restoredSavedAt: chosen.savedAt });
    return { success: true };
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    for (const [key, entry] of this.entries) {
      invariant(key === entry.typeId, 'every record is kept under its typeId');
    }
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## AbjectStore Usage Guide

AbjectStore keeps this workspace's objects: their code and data, a folder, tags, and when they load.

### Make a kept object

  const { typeId, objectId } = await call(await dep('AbjectStore'), 'create', {
    manifest, source, data: { day: 'Saturday' },
    folder: 'user/weather', tags: ['card', 'weather'], loading: 'needed',
  });
  // loading 'boot' starts it now and with every workspace start; 'needed'
  // keeps it asleep until it is looked up (resolveType, a name lookup) or
  // shown in a slot, and lets it sleep again when idle. objectId is empty
  // while it sleeps. An object that declares a 'startup' method hears it each
  // time it wakes.

### More of the same: copy with new data

  const copy = await call(await dep('AbjectStore'), 'copy', {
    objectId: typeId, data: { day: 'Sunday' }, folder: 'user/weather',
  });
  // An independent object with the original's code; changing one leaves the
  // other alone. Copies of one name are numbered (-2, -3).

### Folders, tags and loading

  await call(await dep('AbjectStore'), 'place', { objectId, folder: 'user/kitchen', tags: ['recipes'], loading: 'needed' });
  const kept = await call(await dep('AbjectStore'), 'list', { folder: 'user/kitchen', tag: 'recipes' });
  // [{ typeId, objectId, name, description, tags, folder, loading, asleep, owner, savedAt }]
  const folders = await call(await dep('AbjectStore'), 'listFolders', {});
  await call(await dep('AbjectStore'), 'removeFolder', { folder: 'user/kitchen' });
  // Tags are for search and filtering (the Registry finds them too);
  // folders group objects so they can be listed and removed together.

### Reaching a sleeping object

  const id = await call(registryId, 'resolveType', { typeId });   // wakes it
  const held = await call(await dep('AbjectStore'), 'hold', { objectId: typeId });
  // ... use it ...
  await call(await dep('AbjectStore'), 'release', { objectId: typeId });

### Save and remove

  await call(await dep('AbjectStore'), 'save', { objectId: 'the-object-id' });
  await call(await dep('AbjectStore'), 'remove', { objectId: 'the-object-id' });

### Version history (undo a bad source edit)

  const info = await call(await dep('AbjectStore'), 'listVersions', { objectId });
  const old = await call(await dep('AbjectStore'), 'getVersion', { objectId, index: 0 });
  const result = await call(await dep('AbjectStore'), 'restoreVersion', { objectId, index: 0 });
  await call(await dep('AbjectStore'), 'deleteVersion', { objectId, index: 0 });

### IMPORTANT
- The interface ID is 'abjects:abject-store'.
- Everything here is scoped to this workspace.
- restoreAll() is called at boot to bring back user-created objects.`;
  }
}

// Well-known AbjectStore ID
export const ABJECT_STORE_ID = 'abjects:abject-store' as AbjectId;
