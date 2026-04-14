/**
 * Node.js Storage implementation that persists to disk.
 *
 * Extends the base Storage capability, overriding the in-memory fallback
 * to read/write a JSON file at `.abjects/storage.json`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Storage, StorageEntry } from '../src/objects/capabilities/storage.js';
import { Log } from '../src/core/timed-log.js';

const STORAGE_DIR = process.env.ABJECTS_DATA_DIR ?? '.abjects';
const STORAGE_FILE = 'storage.json';
const log = new Log('NODE-STORAGE');

export class NodeStorage extends Storage {
  private storagePath: string;

  constructor(storagePath?: string) {
    super();
    this.storagePath = storagePath ?? path.join(process.cwd(), STORAGE_DIR, STORAGE_FILE);
  }

  protected override async onInit(): Promise<void> {
    // Skip super.onInit() — no IndexedDB in Node.js
    this.useMemory = true;

    // Ensure .abjects/ directory exists
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Load existing data from disk
    if (fs.existsSync(this.storagePath)) {
      try {
        const raw = fs.readFileSync(this.storagePath, 'utf-8');
        const entries: Record<string, StorageEntry> = JSON.parse(raw);
        for (const [key, entry] of Object.entries(entries)) {
          this.memoryFallback.set(key, entry);
        }
        log.info(`Loaded ${this.memoryFallback.size} entries from ${this.storagePath}`);
      } catch (err) {
        log.warn(`Failed to load ${this.storagePath}, starting fresh:`, err);
      }
    }
  }

  override async setValue(key: string, value: unknown): Promise<boolean> {
    const result = await super.setValue(key, value);
    this.persistToDisk();
    return result;
  }

  override async deleteValue(key: string): Promise<boolean> {
    const result = await super.deleteValue(key);
    this.persistToDisk();
    return result;
  }

  override async clearAll(): Promise<boolean> {
    const result = await super.clearAll();
    this.persistToDisk();
    return result;
  }

  private persistToDisk(): void {
    const obj: Record<string, StorageEntry> = {};
    for (const [key, entry] of this.memoryFallback) {
      obj[key] = entry;
    }

    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(this.storagePath, JSON.stringify(obj, null, 2), 'utf-8');
  }
}
