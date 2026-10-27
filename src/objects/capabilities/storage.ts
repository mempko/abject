/**
 * Storage capability object - provides persistent key-value storage via IndexedDB.
 */

import { AbjectId, AbjectMessage } from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { Log } from '../../core/timed-log.js';
import { require } from '../../core/contracts.js';
import { event } from '../../core/message.js';
import { UndoHistories, UndoRefused, UNDO_EVENTS, sameValue, undoMethods } from '../../core/undo.js';

const log = new Log('Storage');

const STORAGE_INTERFACE = 'abjects:storage';
const DB_NAME = 'abjects-storage';
const STORE_NAME = 'kv';

/** One key a step changed: what it held before and after. */
interface JournalEntry {
  key: string;
  before: unknown;
  beforeExists: boolean;
  after: unknown;
  afterExists: boolean;
}

/** A write to apply in setMany: a value, or `delete: true`. */
interface ManyWrite {
  key: string;
  value?: unknown;
  delete?: boolean;
}

const undoParam = {
  name: 'undo',
  type: { kind: 'primitive' as const, primitive: 'string' as const },
  description: 'A label for this change (e.g. "Star Notes"). Given one, the change is kept in your undo history here and the `undo` method takes it back.',
  optional: true,
};

export interface StorageEntry {
  key: string;
  value: unknown;
  updatedAt: number;
}

/**
 * Storage capability object using IndexedDB.
 */
export class Storage extends Abject {
  private db?: IDBDatabase;
  protected memoryFallback: Map<string, StorageEntry> = new Map();
  protected useMemory = false;
  private dbName: string;

  constructor(dbName?: string) {
    const resolvedDbName = dbName ?? DB_NAME;
    super({
      manifest: {
        name: 'Storage',
        description:
          'Persistent key-value storage backed by IndexedDB. Objects can store and retrieve data that persists across sessions. Use cases: persist user settings across restarts, cache API responses, save and restore application state.',
        version: '1.0.0',
        interface: {
            id: STORAGE_INTERFACE,
            name: 'Storage',
            description: 'Key-value storage operations',
            methods: [
              {
                name: 'get',
                description: 'Get a value by key',
                parameters: [
                  {
                    name: 'key',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Storage key',
                  },
                ],
                returns: {
                  kind: 'union',
                  variants: [
                    { kind: 'reference', reference: 'any' },
                    { kind: 'primitive', primitive: 'null' },
                  ],
                },
              },
              {
                name: 'set',
                description: 'Set a value',
                parameters: [
                  {
                    name: 'key',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Storage key',
                  },
                  {
                    name: 'value',
                    type: { kind: 'reference', reference: 'any' },
                    description: 'Value to store',
                  },
                  undoParam,
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'delete',
                description: 'Delete a value',
                parameters: [
                  {
                    name: 'key',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Storage key',
                  },
                  undoParam,
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'setMany',
                description: 'Write several keys as one change: each write is { key, value } or { key, delete: true }. With `undo`, one undo takes them all back.',
                parameters: [
                  {
                    name: 'writes',
                    type: { kind: 'array', elementType: { kind: 'object', properties: {} } },
                    description: 'The writes, in order',
                  },
                  undoParam,
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              ...undoMethods('your last change made with an `undo` label (your changes only). On success the reply carries `restored`: { key: value } for each key put back, null for one now absent; re-read your state from it. A key that changed again since is not overwritten: the undo is refused'),
              {
                name: 'has',
                description: 'Check if key exists',
                parameters: [
                  {
                    name: 'key',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Storage key',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getPrevious',
                description:
                  "A key's value from the newest surviving snapshot of the store that still holds it, or null when no snapshot does. Backends that keep no snapshots always answer null. Used to recover a value that a later write damaged.",
                parameters: [
                  {
                    name: 'key',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Storage key',
                  },
                ],
                returns: {
                  kind: 'union',
                  variants: [
                    { kind: 'reference', reference: 'any' },
                    { kind: 'primitive', primitive: 'null' },
                  ],
                },
              },
              {
                name: 'getByPrefix',
                description: 'Every key that starts with `prefix` and its value, in one read. Use it to restore many entries at once; one `get` per key costs a round trip each.',
                parameters: [
                  {
                    name: 'prefix',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Key prefix',
                  },
                ],
                returns: { kind: 'reference', reference: 'any' },
              },
              {
                name: 'keys',
                description: 'List all keys',
                parameters: [],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'primitive', primitive: 'string' },
                },
              },
              {
                name: 'clear',
                description: 'Clear all stored data',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
            events: UNDO_EVENTS,
          },
        tags: ['system', 'capability', 'storage', 'persistence'],
      },
    });

    this.dbName = resolvedDbName;
    this.setupHandlers();
  }

  protected async onInit(): Promise<void> {
    await this.initDatabase();
  }

  private setupHandlers(): void {
    this.on('get', async (msg: AbjectMessage) => {
      const { key } = msg.payload as { key: string };
      return this.getValue(key);
    });

    this.on('set', async (msg: AbjectMessage) => {
      const { key, value, undo } = msg.payload as { key: string; value: unknown; undo?: string };
      if (undo === undefined) return this.setValue(key, value);
      return this.writeWithUndo(msg, undo, [{ key, value }]);
    });

    this.on('delete', async (msg: AbjectMessage) => {
      const { key, undo } = msg.payload as { key: string; undo?: string };
      if (undo === undefined) return this.deleteValue(key);
      return this.writeWithUndo(msg, undo, [{ key, delete: true }]);
    });

    this.on('setMany', async (msg: AbjectMessage) => {
      const { writes, undo } = msg.payload as { writes: ManyWrite[]; undo?: string };
      require(Array.isArray(writes) && writes.every(w => typeof w?.key === 'string' && w.key.length > 0),
        'setMany: writes must be [{ key, value }] or [{ key, delete: true }]');
      if (undo === undefined) {
        for (const w of writes) {
          if (w.delete) await this.deleteValue(w.key); else await this.setValue(w.key, w.value);
        }
        return true;
      }
      return this.writeWithUndo(msg, undo, writes);
    });

    this.on('undo', async (msg: AbjectMessage) => this.undoFor(msg, 'undo'));
    this.on('redo', async (msg: AbjectMessage) => this.undoFor(msg, 'redo'));
    this.on('getUndoState', async (msg: AbjectMessage) =>
      this.journal.state(await this.undoCallerKey(msg.routing.from)));

    this.on('has', async (msg: AbjectMessage) => {
      const { key } = msg.payload as { key: string };
      return this.hasKey(key);
    });

    this.on('getPrevious', async (msg: AbjectMessage) => {
      const { key } = msg.payload as { key: string };
      return this.getPreviousValue(key);
    });

    this.on('getByPrefix', async (msg: AbjectMessage) => {
      const { prefix } = msg.payload as { prefix: string };
      require(typeof prefix === 'string' && prefix.length > 0, 'getByPrefix: prefix must be a non-empty string');
      return this.getValuesByPrefix(prefix);
    });

    this.on('keys', async () => {
      return this.getKeys();
    });

    this.on('clear', async () => {
      return this.clearAll();
    });
  }

  // ── Undo journal ────────────────────────────────────────────────

  /**
   * Each writer's labeled changes, kept for this session. A step holds the
   * keys it changed with their values before and after, so undo writes the
   * before values back and redo the after values, each only while the keys
   * still hold what the step left there.
   */
  private journal = new UndoHistories<JournalEntry[]>({
    merge: (older, newer) => {
      const byKey = new Map(older.map(e => [e.key, { ...e }]));
      for (const e of newer) {
        const prior = byKey.get(e.key);
        byKey.set(e.key, prior ? { ...prior, after: e.after, afterExists: e.afterExists } : e);
      }
      return [...byKey.values()];
    },
  });
  /** The live id each writer last wrote from, to tell it its undo state moved. */
  private journalWriters = new Map<string, AbjectId>();

  private async readEntry(key: string): Promise<{ exists: boolean; value: unknown }> {
    const exists = await this.hasKey(key);
    return { exists, value: exists ? await this.getValue(key) : null };
  }

  private async writeEntry(key: string, exists: boolean, value: unknown): Promise<void> {
    if (exists) await this.setValue(key, value); else await this.deleteValue(key);
  }

  private async writeWithUndo(msg: AbjectMessage, label: string, writes: ManyWrite[]): Promise<boolean> {
    require(typeof label === 'string' && label.trim().length > 0, 'undo: the label must be a non-empty string');
    const caller = await this.undoCallerKey(msg.routing.from);
    const entries: JournalEntry[] = [];
    for (const w of writes) {
      const before = await this.readEntry(w.key);
      const afterExists = !w.delete;
      const after = afterExists ? w.value : null;
      await this.writeEntry(w.key, afterExists, after);
      const prior = entries.find(e => e.key === w.key);
      if (prior) { prior.after = after; prior.afterExists = afterExists; continue; }
      entries.push({ key: w.key, before: before.value, beforeExists: before.exists, after, afterExists });
    }
    const changed = entries.filter(e => e.beforeExists !== e.afterExists || !sameValue(e.before, e.after));
    if (changed.length > 0) {
      this.journal.for(caller).record(label.trim(), changed, { mergeKey: changed.map(e => e.key).join('\n') });
      this.journalWriters.set(caller, msg.routing.from);
      this.tellUndoState(caller);
    }
    return true;
  }

  private async undoFor(msg: AbjectMessage, action: 'undo' | 'redo'): Promise<unknown> {
    const caller = await this.undoCallerKey(msg.routing.from);
    const history = this.journal.get(caller);
    if (!history) return { ok: false, reason: action === 'undo' ? 'Nothing to undo' : 'Nothing to redo' };
    const result = await history[action](async (step) => {
      const restored: Record<string, unknown> = {};
      for (const e of step.data) {
        const now = await this.readEntry(e.key);
        const expectExists = action === 'undo' ? e.afterExists : e.beforeExists;
        const expect = action === 'undo' ? e.after : e.before;
        if (now.exists !== expectExists || (now.exists && !sameValue(now.value, expect))) {
          throw new UndoRefused(`'${e.key}' changed since, so "${step.label}" can no longer be ${action === 'undo' ? 'undone' : 'redone'}`);
        }
      }
      for (const e of step.data) {
        const exists = action === 'undo' ? e.beforeExists : e.afterExists;
        const value = action === 'undo' ? e.before : e.after;
        await this.writeEntry(e.key, exists, value);
        restored[e.key] = exists ? value : null;
      }
      return { restored };
    });
    this.journalWriters.set(caller, msg.routing.from);
    this.tellUndoState(caller);
    return result;
  }

  private tellUndoState(caller: string): void {
    const to = this.journalWriters.get(caller);
    if (to) this.send(event(this.id, to, 'undoStateChanged', this.journal.state(caller)));
  }

  /**
   * Initialize the IndexedDB database.
   */
  private async initDatabase(): Promise<void> {
    // Check if IndexedDB is available
    if (typeof indexedDB === 'undefined') {
      log.warn('IndexedDB not available, using memory fallback');
      this.useMemory = true;
      return;
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);

      request.onerror = () => {
        log.warn('IndexedDB error, using memory fallback');
        this.useMemory = true;
        resolve();
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
    });
  }

  /**
   * A key's value from the newest surviving snapshot of the store.
   *
   * Backends that keep snapshots (the Node one keeps the JSON files it grew
   * out of) can answer this; the rest have nothing older to offer and say
   * so. It exists because a store with no history cannot recover a value
   * that a later write damaged, and the knowledge base needed exactly that.
   */
  async getPreviousValue(_key: string): Promise<unknown> {
    return null;
  }

  /**
   * Get a value by key.
   */
  async getValue(key: string): Promise<unknown> {
    if (this.useMemory) {
      return this.memoryFallback.get(key)?.value ?? null;
    }

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);

      request.onsuccess = () => {
        const entry = request.result as StorageEntry | undefined;
        resolve(entry?.value ?? null);
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Set a value.
   */
  async setValue(key: string, value: unknown): Promise<boolean> {
    const entry: StorageEntry = {
      key,
      value,
      updatedAt: Date.now(),
    };

    if (this.useMemory) {
      this.memoryFallback.set(key, entry);
      return true;
    }

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(entry);

      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Delete a value.
   */
  async deleteValue(key: string): Promise<boolean> {
    if (this.useMemory) {
      return this.memoryFallback.delete(key);
    }

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(key);

      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Check if a key exists.
   */
  async hasKey(key: string): Promise<boolean> {
    if (this.useMemory) {
      return this.memoryFallback.has(key);
    }

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getKey(key);

      request.onsuccess = () => resolve(request.result !== undefined);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Every key starting with `prefix` and its value, as one object.
   */
  async getValuesByPrefix(prefix: string): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    if (this.useMemory) {
      for (const [key, entry] of this.memoryFallback) if (key.startsWith(prefix)) out[key] = entry.value;
      return out;
    }

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`));

      request.onsuccess = () => {
        for (const entry of request.result as StorageEntry[]) out[entry.key] = entry.value;
        resolve(out);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get all keys.
   */
  async getKeys(): Promise<string[]> {
    if (this.useMemory) {
      return Array.from(this.memoryFallback.keys());
    }

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAllKeys();

      request.onsuccess = () => resolve(request.result as string[]);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear all data.
   */
  async clearAll(): Promise<boolean> {
    if (this.useMemory) {
      this.memoryFallback.clear();
      return true;
    }

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.clear();

      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## Storage Usage Guide

### Store a Value

  await this.call(
    this.dep('Storage'), 'set',
    { key: 'myKey', value: { name: 'foo', count: 42 } });

### Retrieve a Value

  const value = await this.call(
    this.dep('Storage'), 'get',
    { key: 'myKey' });
  // Returns the stored value, or null if not found

### Check if a Key Exists

  const exists = await this.call(
    this.dep('Storage'), 'has',
    { key: 'myKey' });

### Delete a Value

  await this.call(
    this.dep('Storage'), 'delete',
    { key: 'myKey' });

### List All Keys

  const keys = await this.call(
    this.dep('Storage'), 'keys', {});

### Clear All Data

  await this.call(
    this.dep('Storage'), 'clear', {});

### IMPORTANT
- Values can be any JSON-serializable data (objects, arrays, strings, numbers, booleans).
- Data persists across sessions (backed by IndexedDB).
- Do NOT use localStorage or IndexedDB directly — always go through the Storage object.`;
  }
}

// Well-known storage ID
export const STORAGE_ID = 'abjects:storage' as AbjectId;
