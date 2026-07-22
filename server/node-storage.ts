/**
 * Node.js Storage implementation backed by SQLite (node:sqlite).
 *
 * Replaces the previous JSON-file backend, which held the whole store in a Map
 * and rewrote the ENTIRE pretty-printed `storage.json` synchronously on every
 * `set`/`delete`/`clear` (O(N) per write, blocking the event loop — the source
 * of multi-second write stalls once a workspace store grew large).
 *
 * This backend keeps a single `kv(key, value, updatedAt)` table in WAL mode and
 * does O(1) per-key upserts/deletes through prepared statements. The message
 * interface (`get`/`set`/`delete`/`has`/`keys`/`clear`) is unchanged, so every
 * caller — TS objects and the C++ KnowledgeBase reaching `@Storage` — is
 * unaffected. A one-time migration imports a legacy `storage.json` on first
 * boot and renames it to `.bak` (rollback loses nothing). If SQLite is somehow
 * unavailable, it degrades to the base in-memory Map (no persistence, but the
 * app still runs).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { Storage, StorageEntry } from '../src/objects/capabilities/storage.js';
import { Log } from '../src/core/timed-log.js';

const STORAGE_DIR = process.env.ABJECTS_DATA_DIR ?? '.abjects';
const STORAGE_FILE = 'storage.json';
const log = new Log('NODE-STORAGE');

export class NodeStorage extends Storage {
  private dbPath: string;
  private legacyJsonPath: string;
  private sqlite?: DatabaseSync;
  private getStmt?: StatementSync;
  private setStmt?: StatementSync;
  private delStmt?: StatementSync;
  private hasStmt?: StatementSync;
  private keysStmt?: StatementSync;
  private clearStmt?: StatementSync;

  constructor(storagePath?: string) {
    super();
    // Historically `storagePath` pointed at `<dir>/storage.json`. Keep the same
    // directory (per-workspace) but use a `.db` file, and remember the legacy
    // JSON path so a first-boot migration can find it.
    const base = storagePath ?? path.resolve(STORAGE_DIR, STORAGE_FILE);
    const dir = path.dirname(base);
    this.dbPath = path.join(dir, 'storage.db');
    this.legacyJsonPath = base.endsWith('.json') ? base : path.join(dir, STORAGE_FILE);
  }

  protected override async onInit(): Promise<void> {
    // Never touch IndexedDB in Node; the base's memory path is the degraded
    // fallback if SQLite fails to open.
    this.useMemory = true;

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    try {
      this.openDb();
      this.migrateFromJsonIfNeeded();
    } catch (err) {
      log.error(`SQLite unavailable, storage degraded to in-memory (no persistence): ${err instanceof Error ? err.message : String(err)}`);
      this.sqlite = undefined;
    }
  }

  protected override async onStop(): Promise<void> {
    if (this.sqlite) {
      try { this.sqlite.close(); } catch { /* already closed */ }
      this.sqlite = undefined;
    }
  }

  // ── Overridden storage ops: O(1) per-key SQLite, or in-memory if degraded ──

  override async getValue(key: string): Promise<unknown> {
    if (!this.sqlite) return super.getValue(key);
    const row = this.getStmt!.get(key) as { value: string } | undefined;
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return null; }
  }

  override async setValue(key: string, value: unknown): Promise<boolean> {
    if (!this.sqlite) return super.setValue(key, value);
    this.setStmt!.run(key, JSON.stringify(value), Date.now());
    return true;
  }

  override async deleteValue(key: string): Promise<boolean> {
    if (!this.sqlite) return super.deleteValue(key);
    const info = this.delStmt!.run(key);
    return Number(info.changes) > 0;
  }

  override async hasKey(key: string): Promise<boolean> {
    if (!this.sqlite) return super.hasKey(key);
    return this.hasStmt!.get(key) !== undefined;
  }

  override async getKeys(): Promise<string[]> {
    if (!this.sqlite) return super.getKeys();
    return (this.keysStmt!.all() as Array<{ key: string }>).map(r => r.key);
  }

  override async clearAll(): Promise<boolean> {
    if (!this.sqlite) return super.clearAll();
    this.clearStmt!.run();
    return true;
  }

  // ── SQLite plumbing ────────────────────────────────────────────────────

  private openDb(): void {
    const db = new DatabaseSync(this.dbPath);
    // WAL + NORMAL sync: durable enough for local app state, and lets writes
    // return without a full fsync on every set.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.getStmt = db.prepare('SELECT value FROM kv WHERE key = ?');
    this.setStmt = db.prepare(
      'INSERT INTO kv(key, value, updatedAt) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt',
    );
    this.delStmt = db.prepare('DELETE FROM kv WHERE key = ?');
    this.hasStmt = db.prepare('SELECT 1 FROM kv WHERE key = ?');
    this.keysStmt = db.prepare('SELECT key FROM kv');
    this.clearStmt = db.prepare('DELETE FROM kv');
    this.sqlite = db;
    log.info(`Storage opened at ${this.dbPath} (SQLite/WAL)`);
  }

  /**
   * One-time import of a legacy `storage.json` (the old whole-file backend).
   * Guarded by a `meta` marker so it runs at most once; the legacy file is
   * renamed to `.bak` on success so a rollback to the old build loses nothing
   * and a re-run can't double-import.
   */
  private migrateFromJsonIfNeeded(): void {
    if (!this.sqlite) return;
    const marker = this.sqlite.prepare(`SELECT value FROM meta WHERE key = 'migratedFromJson'`).get();
    if (marker) return;

    if (fs.existsSync(this.legacyJsonPath)) {
      try {
        const raw = fs.readFileSync(this.legacyJsonPath, 'utf-8');
        const entries = JSON.parse(raw) as Record<string, StorageEntry>;
        let migrated = 0;
        this.sqlite.exec('BEGIN');
        try {
          for (const [key, entry] of Object.entries(entries)) {
            if (!entry || typeof entry !== 'object') continue;
            const updatedAt = Number((entry as StorageEntry).updatedAt ?? Date.now());
            this.setStmt!.run(key, JSON.stringify((entry as StorageEntry).value), updatedAt);
            migrated++;
          }
          this.sqlite.exec('COMMIT');
        } catch (err) {
          try { this.sqlite.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
          throw err;
        }
        fs.renameSync(this.legacyJsonPath, `${this.legacyJsonPath}.bak`);
        log.info(`Migrated ${migrated} entries from legacy ${this.legacyJsonPath} → SQLite (old file kept as .bak)`);
      } catch (err) {
        log.warn(`Legacy JSON migration skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.sqlite.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('migratedFromJson', ?)`)
      .run(String(Date.now()));
  }
}
