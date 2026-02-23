/**
 * Storage capability object - provides persistent key-value storage via IndexedDB.
 */

import { AbjectId, AbjectMessage } from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { Capabilities } from '../../core/capability.js';

const STORAGE_INTERFACE = 'abjects:storage';
const DB_NAME = 'abjects-storage';
const STORE_NAME = 'kv';

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
          'Persistent key-value storage backed by IndexedDB. Objects can store and retrieve data that persists across sessions.',
        version: '1.0.0',
        interfaces: [
          {
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
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
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
          },
        ],
        requiredCapabilities: [],
        providedCapabilities: [
          Capabilities.STORAGE_READ,
          Capabilities.STORAGE_WRITE,
        ],
        tags: ['capability', 'storage', 'persistence'],
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
      const { key, value } = msg.payload as { key: string; value: unknown };
      return this.setValue(key, value);
    });

    this.on('delete', async (msg: AbjectMessage) => {
      const { key } = msg.payload as { key: string };
      return this.deleteValue(key);
    });

    this.on('has', async (msg: AbjectMessage) => {
      const { key } = msg.payload as { key: string };
      return this.hasKey(key);
    });

    this.on('keys', async () => {
      return this.getKeys();
    });

    this.on('clear', async () => {
      return this.clearAll();
    });
  }

  /**
   * Initialize the IndexedDB database.
   */
  private async initDatabase(): Promise<void> {
    // Check if IndexedDB is available
    if (typeof indexedDB === 'undefined') {
      console.warn('[STORAGE] IndexedDB not available, using memory fallback');
      this.useMemory = true;
      return;
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);

      request.onerror = () => {
        console.warn('[STORAGE] IndexedDB error, using memory fallback');
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

  protected override getSourceForAsk(): string | undefined {
    return `## Storage Usage Guide

### Store a Value

  await this.call(
    this.dep('Storage'), 'abjects:storage', 'set',
    { key: 'myKey', value: { name: 'foo', count: 42 } });

### Retrieve a Value

  const value = await this.call(
    this.dep('Storage'), 'abjects:storage', 'get',
    { key: 'myKey' });
  // Returns the stored value, or null if not found

### Check if a Key Exists

  const exists = await this.call(
    this.dep('Storage'), 'abjects:storage', 'has',
    { key: 'myKey' });

### Delete a Value

  await this.call(
    this.dep('Storage'), 'abjects:storage', 'delete',
    { key: 'myKey' });

### List All Keys

  const keys = await this.call(
    this.dep('Storage'), 'abjects:storage', 'keys', {});

### Clear All Data

  await this.call(
    this.dep('Storage'), 'abjects:storage', 'clear', {});

### IMPORTANT
- Values can be any JSON-serializable data (objects, arrays, strings, numbers, booleans).
- Data persists across sessions (backed by IndexedDB).
- Do NOT use localStorage or IndexedDB directly — always go through the Storage object.`;
  }
}

// Well-known storage ID
export const STORAGE_ID = 'abjects:storage' as AbjectId;
