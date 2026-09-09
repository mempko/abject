/**
 * KnowledgeBase - persistent agent memory system.
 *
 * Stores structured knowledge entries that agents can remember, recall,
 * and search. Backed by SQLite (node:sqlite) with an FTS5 full-text index
 * for BM25-ranked lexical retrieval and SharedState for cross-peer sync.
 *
 * Retrieval philosophy (lexical-first): agents query with exact terms and
 * can iterate, which is where BM25 shines.
 */

import { withKeyedLock } from '../core/keyed-lock.js';
import { knowledgeRef, applicable, preservesLearning, validateLearningEffect, type KnowledgeLearning, type LearningDecision } from '../core/learning.js';
import { describeMessages, protocolText, protocolNumber, protocolObject } from '../core/protocol-description.js';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AbjectId,
  AbjectMessage,
  InterfaceId,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import {
  require as precondition,
  requireNonEmpty,
  invariant,
} from '../core/contracts.js';
import { request } from '../core/message.js';
import { Log } from '../core/timed-log.js';
import {
  readPattern, readStructured, serializePattern, renderPatternText, isStructuredPattern,
  isFlattenedPattern, type PatternBody,
} from '../core/pattern.js';

const log = new Log('KNOWLEDGE-BASE');

const KNOWLEDGE_BASE_INTERFACE = 'abjects:knowledge-base' as InterfaceId;
const STORAGE_KEY = 'knowledge-base:entries';
/**
 * Per-entry Storage key. This implementation keeps entries in SQLite, but the
 * native KnowledgeBase writes them through Storage under these keys, and both
 * serve the same workspace store, so snapshots can hold either shape.
 */
const ENTRY_KEY_PREFIX = 'knowledge-base:entry:';

/**
 * Tag marking a durable fact about the user (home location, name, role,
 * preferences). Profile-tagged facts are injected into every agent's context
 * unconditionally, so stable knowledge about the user surfaces even when the
 * task shares no keywords with it (keyword recall alone would miss it).
 */
export const PROFILE_TAG = 'profile';

export type KnowledgeType = 'learned' | 'fact' | 'insight' | 'reference' | 'pattern';

/**
 * Who authored an entry. Curation policy keys off this: 'user' entries are
 * never auto-evicted or auto-merged; only 'agent'/'reviewer' entries are
 * eligible for automated consolidation.
 */
export type KnowledgeOrigin = 'user' | 'agent' | 'reviewer' | 'scrum';

export interface KnowledgeEntry {
  knowledgeRef?: string;
  learning?: KnowledgeLearning;
  id: string;
  title: string;
  content: string;
  type: KnowledgeType;
  tags: string[];
  origin: KnowledgeOrigin;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number;
  /** Times a reviewer judged this entry to have actually helped a task. */
  usefulCount: number;
  lastUsefulAt: number;
  /** Archived entries are hidden from recall/match but restorable. */
  archived: boolean;
  /**
   * The peer that authored this entry. Entries arriving over cross-peer sync
   * keep their origin peer's id, so a browser can attribute them and withhold
   * edit controls for what this peer does not own. Absent on entries written
   * before the field existed, which are read as local.
   */
  creatorPeerId?: string;
}

const KNOWLEDGE_ORIGINS: readonly KnowledgeOrigin[] = ['user', 'agent', 'reviewer', 'scrum'];

/** A recall result: the full entry plus ranking metadata for query searches. */
export interface RecallResult extends KnowledgeEntry {
  /** Match context with [bracketed] highlights (query searches only). */
  snippet?: string;
  /** Relevance score, higher is better (query searches only). */
  score?: number;
}

/**
 * A weave result: a pattern entry plus how it entered the selection.
 * 'matched' for query hits, 'linked-from: NAME' for link expansions.
 */
export interface WovenPattern extends KnowledgeEntry {
  snippet?: string;
  score?: number;
  via: string;
}

/** Compact preview shape returned when recall is called with previews: true. */
export interface RecallPreview {
  knowledgeRef?: string;
  learning?: KnowledgeLearning;
  id: string;
  title: string;
  type: KnowledgeType;
  tags: string[];
  snippet: string;
  score?: number;
}

export class KnowledgeBase extends Abject {
  private pendingLearning = new Set<string>();
  private storageId?: AbjectId;
  private sharedStateId?: AbjectId;
  private llmId?: AbjectId;
  private entries: Map<string, KnowledgeEntry> = new Map();
  private db?: DatabaseSync;
  private distillTimer?: ReturnType<typeof setInterval>;

  constructor() {
    super({
      manifest: {
        name: 'KnowledgeBase',
        description:
          'Persistent agent memory system. Agents remember facts, insights, lessons learned, and patterns, then retrieve them four ways: recall (BM25 full-text search), match (exact/regex lookup for identifiers), get (fetch one full entry by id), and weave (select patterns whose contexts match a goal, plus their linked patterns). Knowledge persists across restarts and syncs across peers.',
        version: '2.0.0',
        interface: {
          id: KNOWLEDGE_BASE_INTERFACE,
          name: 'KnowledgeBase',
          description: 'Agent knowledge storage and retrieval',
          methods: [
            {
              name: 'remember',
              description: 'Store a knowledge entry. Deduplicates by normalized title+type (updates if exists).',
              parameters: [
                { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: 'Short summary (max 200 chars)' },
                { name: 'content', type: { kind: 'primitive', primitive: 'string' }, description: 'The knowledge content (markdown)' },
                { name: 'type', type: { kind: 'primitive', primitive: 'string' }, description: "Entry type: 'learned' | 'fact' | 'insight' | 'reference' | 'pattern'" },
                { name: 'tags', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Tags for search/filtering', optional: true },
                { name: 'origin', type: { kind: 'primitive', primitive: 'string' }, description: "Who authored this: 'user' | 'agent' | 'reviewer' | 'scrum' (default 'agent')", optional: true },
              ],
              returns: { kind: 'object', properties: { id: { kind: 'primitive', primitive: 'string' } } },
            },
            {
              name: 'recall',
              description: 'Search knowledge entries by query (BM25-ranked full text, title-boosted), type, or tags. Each result carries a snippet and score. Pass previews: true for compact {id, title, snippet} results, then fetch winners with get.',
              parameters: [
                { name: 'scope', type: { kind: 'primitive', primitive: 'string' }, description: 'Explicit applicability scope', optional: true },
                { name: 'query', type: { kind: 'primitive', primitive: 'string' }, description: 'Search query (keywords)', optional: true },
                { name: 'type', type: { kind: 'primitive', primitive: 'string' }, description: 'Filter by type', optional: true },
                { name: 'tags', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Filter by tags', optional: true },
                { name: 'limit', type: { kind: 'primitive', primitive: 'number' }, description: 'Max results (default 10)', optional: true },
                { name: 'previews', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Return compact previews instead of full entries', optional: true },
              ],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'KnowledgeEntry' } },
            },
            {
              name: 'weave',
              description: "Select pattern entries (type 'pattern') whose contexts match the query (BM25-ranked), then follow their links to pull in related patterns. Returns { patterns, dangling }: each pattern carries via ('matched' or 'linked-from: NAME'); dangling lists link names that resolve to no pattern yet.",
              parameters: [
                { name: 'scope', type: { kind: 'primitive', primitive: 'string' }, description: 'Explicit applicability scope', optional: true },
                { name: 'query', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal or task description to match pattern contexts against' },
                { name: 'limit', type: { kind: 'primitive', primitive: 'number' }, description: 'Max directly matched patterns (default 5)', optional: true },
                { name: 'hops', type: { kind: 'primitive', primitive: 'number' }, description: 'Link-expansion depth (default 1, max 2)', optional: true },
              ],
              returns: { kind: 'object', properties: {
                patterns: { kind: 'array', elementType: { kind: 'reference', reference: 'WovenPattern' } },
                dangling: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
              } },
            },
            {
              name: 'match',
              description: 'Exact/regex lookup over titles and content. Use for identifiers, names, and precise strings where full-text ranking is unnecessary. Pattern is a case-insensitive regex; an invalid regex is treated as a literal substring.',
              parameters: [
                { name: 'scope', type: { kind: 'primitive', primitive: 'string' }, description: 'Explicit applicability scope', optional: true },
                { name: 'pattern', type: { kind: 'primitive', primitive: 'string' }, description: 'Regex or literal substring' },
                { name: 'limit', type: { kind: 'primitive', primitive: 'number' }, description: 'Max results (default 10)', optional: true },
              ],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'KnowledgeEntry' } },
            },
            {
              name: 'get',
              description: 'Fetch one full knowledge entry by id',
              parameters: [
                { name: 'id', type: { kind: 'primitive', primitive: 'string' }, description: 'Entry ID' },
              ],
              returns: { kind: 'reference', reference: 'KnowledgeEntry' },
            },
            {
              name: 'forget',
              description: 'Delete a knowledge entry by ID',
              parameters: [
                { name: 'id', type: { kind: 'primitive', primitive: 'string' }, description: 'Entry ID' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'update',
              description: 'Update an existing knowledge entry',
              parameters: [
                { name: 'id', type: { kind: 'primitive', primitive: 'string' }, description: 'Entry ID' },
                { name: 'content', type: { kind: 'primitive', primitive: 'string' }, description: 'New content', optional: true },
                { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: 'New title', optional: true },
                { name: 'tags', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'New tags', optional: true },
                { name: 'expectedRevision', type: { kind: 'primitive', primitive: 'number' }, description: 'Reject stale pattern revisions', optional: true },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'list',
              description: 'List knowledge entries, optionally filtered by type',
              parameters: [
                { name: 'type', type: { kind: 'primitive', primitive: 'string' }, description: 'Filter by type', optional: true },
                { name: 'limit', type: { kind: 'primitive', primitive: 'number' }, description: 'Max results (default 50)', optional: true },
                { name: 'includeArchived', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Include archived entries (default false)', optional: true },
              ],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'KnowledgeEntry' } },
            },
            {
              name: 'listTags',
              description: 'List tags in use across active (non-archived) entries with usage counts, most-used first. Lets agents discover the tag vocabulary instead of guessing.',
              parameters: [
                { name: 'limit', type: { kind: 'primitive', primitive: 'number' }, description: 'Max tags (default 50)', optional: true },
              ],
              returns: { kind: 'array', elementType: { kind: 'object', properties: {
                tag: { kind: 'primitive', primitive: 'string' },
                count: { kind: 'primitive', primitive: 'number' },
              } } },
            },
            {
              name: 'markUseful',
              description: 'Record that entries genuinely helped a task (reviewer feedback). Bumps usefulCount, which protects entries from staleness eviction.',
              parameters: [
                { name: 'ids', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Entry IDs that proved useful' },
                { name: 'operationId', type: { kind: 'primitive', primitive: 'string' }, description: 'Deduplicate pattern feedback for a review', optional: true },
              ],
              returns: { kind: 'object', properties: { marked: { kind: 'primitive', primitive: 'number' } } },
            },
            {
              name: 'archive',
              description: 'Archive an entry (hidden from recall/match, restorable) or restore it with archived: false',
              parameters: [
                { name: 'id', type: { kind: 'primitive', primitive: 'string' }, description: 'Entry ID' },
                { name: 'archived', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Target state (default true)', optional: true },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
          ],
          events: [
            { name: 'entryAdded', description: 'A knowledge entry was added', payload: { kind: 'reference', reference: 'KnowledgeEntry' } },
            { name: 'entryUpdated', description: 'A knowledge entry was updated', payload: { kind: 'reference', reference: 'KnowledgeEntry' } },
            { name: 'entryRemoved', description: 'A knowledge entry was removed', payload: { kind: 'object', properties: { id: { kind: 'primitive', primitive: 'string' } } } },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'knowledge'],
      },
    });

    this.setupHandlers();
  }

  override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.entries instanceof Map, 'entries must be a Map');
  }

  protected override async onInit(): Promise<void> {
    this.storageId = await this.discoverDep('Storage') ?? undefined;
    this.sharedStateId = await this.discoverDep('SharedState') ?? undefined;

    // Open the per-workspace SQLite store on a deferred task. onInit runs
    // inside WorkspaceManager's spawn call, before the manager records this
    // object as a workspace child, so resolving the scope here always misses
    // (and waiting here would deadlock: the manager records children only
    // after init returns). The deferred open retries resolution briefly and
    // falls back to the global scope only after the retries are exhausted.
    // Every db call is guarded, so reads before the open see empty results.
    this.scheduleDbOpen();

    // Subscribe to SharedState for cross-peer sync
    if (this.sharedStateId) {
      const ns = 'knowledge-base';
      try {
        await this.request(request(this.id, this.sharedStateId, 'create', { name: ns }));
      } catch { /* may already exist */ }
      try {
        await this.request(request(this.id, this.sharedStateId, 'subscribe', { name: ns }));
      } catch { /* best effort */ }

      // Peer id, for breaking ties when two peers stamp an entry at the same
      // instant. Falls back to this object's id until Identity answers.
      const identityId = await this.discoverDep('Identity');
      if (identityId) {
        try {
          const identity = await this.request<{ peerId: string }>(
            request(this.id, identityId, 'getIdentity', {})
          );
          this.localPeerId = identity.peerId;
        } catch { /* Identity may not be ready */ }
      }

      // Late join: replay everything already in the namespace (the individual
      // stateChanged events were missed while we were offline), then publish
      // our own entries so peers that were here first can see them.
      try {
        const all = await this.request<Record<string, unknown>>(
          request(this.id, this.sharedStateId, 'getAll', { name: ns })
        );
        this.reconcileFromSnapshot(all);
      } catch { /* best effort */ }
      this.syncToSharedState();
    }

    log.info(`KnowledgeBase initialized with ${this.entries.size} entries`);

    // Run initial distillation, then periodically every 30 minutes
    this.distill();
    this.distillTimer = setInterval(() => {
      this.distill();
    }, 30 * 60 * 1000);
  }

  protected override async onStop(): Promise<void> {
    if (this.distillTimer) {
      clearInterval(this.distillTimer);
      this.distillTimer = undefined;
    }
    if (this.db) {
      try { this.db.close(); } catch { /* already closed */ }
      this.db = undefined;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // SQLite store
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Deferred SQLite open: retry workspace resolution with backoff (a fresh
   * workspace's manager needs a beat to record its children), then open at
   * the resolved scope, falling back to global after the final attempt.
   */
  private scheduleDbOpen(attempt = 0): void {
    setTimeout(() => {
      if (this.db) return;
      this.resolveScope().then(async (scope) => {
        if (this.db) return;
        if (scope === 'global' && attempt < 4) {
          this.scheduleDbOpen(attempt + 1);
          return;
        }
        try {
          this.openDb(scope);
          await this.migrateFromStorage();
          this.loadEntriesFromDb();
          log.info(`Loaded ${this.entries.size} knowledge entries from SQLite (${scope})`);
        } catch (err) {
          // Degraded mode: in-memory only. Every db call is guarded.
          log.error(`SQLite unavailable, running in-memory only: ${err instanceof Error ? err.message : String(err)}`);
          this.db = undefined;
        }
      }).catch(() => this.scheduleDbOpen(attempt + 1));
    }, attempt === 0 ? 50 : 500 * Math.pow(2, attempt - 1));
  }

  /** Resolve 'ws-<id>' via WorkspaceManager, or 'global' when unscoped. */
  private async resolveScope(): Promise<string> {
    try {
      const wmId = await this.discoverDep('WorkspaceManager');
      if (!wmId) return 'global';
      const ws = await this.request<{ workspaceId?: string } | null>(
        request(this.id, wmId, 'findWorkspaceForObject', { objectId: this.id }),
        5000,
      );
      return ws?.workspaceId ? `ws-${ws.workspaceId}` : 'global';
    } catch {
      return 'global';
    }
  }

  private openDb(scope: string): void {
    const dir = path.join(os.homedir(), '.abject', scope);
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, 'knowledge.db'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS entries(
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        type TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        createdBy TEXT NOT NULL DEFAULT '',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        accessCount INTEGER NOT NULL DEFAULT 0,
        lastAccessedAt INTEGER NOT NULL DEFAULT 0,
        origin TEXT NOT NULL DEFAULT 'agent',
        usefulCount INTEGER NOT NULL DEFAULT 0,
        lastUsefulAt INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        creatorPeerId TEXT NOT NULL DEFAULT ''
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        title, content, tags,
        content='entries', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(rowid, title, content, tags)
        VALUES (new.rowid, new.title, new.content, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, content, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, content, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags);
        INSERT INTO entries_fts(rowid, title, content, tags)
        VALUES (new.rowid, new.title, new.content, new.tags);
      END;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    // Migrate pre-provenance databases in place. ADD COLUMN throws when the
    // column already exists, which is the signal to stop probing.
    const migrations = [
      `ALTER TABLE entries ADD COLUMN learning TEXT`,
      `ALTER TABLE entries ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent'`,
      `ALTER TABLE entries ADD COLUMN usefulCount INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE entries ADD COLUMN lastUsefulAt INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE entries ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE entries ADD COLUMN creatorPeerId TEXT NOT NULL DEFAULT ''`,
    ];
    for (const sql of migrations) {
      try { db.exec(sql); } catch { /* column already present */ }
    }
    this.db = db;
  }

  /**
   * One-time import of the legacy Storage-backed entry array. The legacy
   * data is left in place (only a marker records the import), so rolling
   * back to an older build loses nothing.
   */
  private async migrateFromStorage(): Promise<void> {
    if (!this.db || !this.storageId) return;
    const marker = this.db.prepare(`SELECT value FROM meta WHERE key = 'migratedFromStorage'`).get();
    if (marker) return;

    try {
      const stored = await this.request<KnowledgeEntry[] | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY }),
        5000,
      );
      let imported = 0;
      if (Array.isArray(stored)) {
        const exists = this.db.prepare(`SELECT 1 FROM entries WHERE id = ?`);
        for (const entry of stored) {
          if (!entry?.id || exists.get(entry.id)) continue;
          this.writeEntryToDb(this.normalizeEntry(entry));
          imported++;
        }
      }
      this.db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('migratedFromStorage', ?)`)
        .run(String(Date.now()));
      if (imported > 0) log.info(`Migrated ${imported} legacy entries from Storage`);
    } catch (err) {
      log.warn(`Legacy Storage migration skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private loadEntriesFromDb(): void {
    if (!this.db) return;
    const rows = this.db.prepare(
      `SELECT id, title, content, type, tags, createdBy, createdAt, updatedAt, accessCount, lastAccessedAt, origin, usefulCount, lastUsefulAt, archived, creatorPeerId FROM entries`
    ).all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      const entry = this.rowToEntry(r);
      this.entries.set(entry.id, entry);
    }
    void this.healPatterns();
  }

  /**
   * Bring every pattern into the structured form, and put back the ones an
   * older bug took apart. Runs once per store, at load.
   *
   * Two things were wrong with patterns before they had a structure. They
   * were stored as prose and their sections recovered by matching headings,
   * which failed the moment an agent wrote '## Context' where the matcher
   * expected 'Context:'. And update_pattern rebuilt entries out of the
   * sections it had recognized, so a pattern it could not read came back
   * FLATTENED: everything gone but a single Evidence line.
   *
   * Conversion fixes the first. The second needs the text back, and the only
   * place it still exists is the store's own older snapshots, so a flattened
   * pattern is looked up there before being written.
   *
   * Entries already structured are skipped, and the snapshots are read only
   * when something is actually flattened. Once a store is healed this costs
   * one pass over memory and no disk at all.
   */
  private async healPatterns(): Promise<void> {
    let converted = 0;
    let restored = 0;
    let unreadable = 0;
    let lost = 0;

    for (const entry of this.entries.values()) {
      if (entry.type !== 'pattern' || readStructured(entry.content)?.learning) continue;
      let pattern = readPattern(entry.content, entry.title);
      if (!pattern) {
        unreadable++;
        log.warn(`Pattern "${entry.title}" could not be structured; left as written`);
        continue;
      }

      if (isFlattenedPattern(pattern)) {
        const recovered = await this.recoverPattern(entry);
        if (recovered) {
          pattern = recovered;
          restored++;
          log.info(`Restored flattened pattern "${entry.title}" from an earlier snapshot`);
        } else {
          lost++;
          log.warn(`Pattern "${entry.title}" was flattened and no snapshot still holds it`);
        }
      }

      pattern.learning ??= { revision: 1, applications: [], feedbackIds: [], history: [] };
      entry.content = serializePattern(pattern);
      entry.updatedAt = Math.max(Date.now(), entry.updatedAt + 1);
      this.writeEntryToDb(entry);
      converted++;
    }

    if (converted > 0) log.info(`Structured ${converted} pattern(s) written before the format existed`);
    if (restored > 0) log.info(`Restored ${restored} pattern(s) damaged by the old update path`);
    if (unreadable > 0) log.warn(`${unreadable} pattern(s) could not be structured`);
    if (lost > 0) log.warn(`${lost} flattened pattern(s) could not be recovered`);
    if (converted > 0) this.syncToSharedState();
  }

  /**
   * An intact earlier version of one entry, from the store's own snapshots.
   * Returns nothing when no snapshot has it, or when the copy found there is
   * flattened too (the damage predates every surviving snapshot).
   */
  private async recoverPattern(entry: KnowledgeEntry): Promise<PatternBody | undefined> {
    const storageId = await this.discoverDep('Storage');
    if (!storageId) return undefined;
    const previous = await this.request<unknown>(
      request(this.id, storageId, 'getPrevious', { key: `${ENTRY_KEY_PREFIX}${entry.id}` }),
      10000,
    ).catch(() => null);

    const fromKey = this.patternFromRecord(previous, entry.title);
    if (fromKey) return fromKey;

    // Older stores kept every entry in one array under a single key.
    const legacy = await this.request<unknown>(
      request(this.id, storageId, 'getPrevious', { key: STORAGE_KEY }),
      10000,
    ).catch(() => null);
    if (!Array.isArray(legacy)) return undefined;
    const match = legacy.find(
      (e): e is { id?: unknown; content?: unknown } =>
        !!e && typeof e === 'object' && (e as { id?: unknown }).id === entry.id,
    );
    return this.patternFromRecord(match, entry.title);
  }

  /** An intact pattern out of a stored record, or nothing if it is damaged too. */
  private patternFromRecord(record: unknown, title: string): PatternBody | undefined {
    const stored = record as { content?: unknown } | null | undefined;
    if (!stored || typeof stored.content !== 'string') return undefined;
    const pattern = readPattern(stored.content, title);
    return pattern && !isFlattenedPattern(pattern) ? pattern : undefined;
  }

  /**
   * Force a pattern body into the structured form at write time.
   *
   * Any agent can save an entry of type 'pattern' through the plain
   * `remember` action, and those arrive as freehand prose. Converting on the
   * way in means the store holds one shape, so nothing downstream has to
   * guess how a given pattern was written. Prose that cannot be read as a
   * pattern is stored as-is; refusing the write would lose it entirely.
   */
  private structureOnWrite(title: string, content: string): string {
    if (isStructuredPattern(content)) return content;
    const pattern = readPattern(content, title);
    if (!pattern) {
      log.warn(`Pattern "${title}" could not be structured on write; stored as written`);
      return content;
    }
    return serializePattern(pattern);
  }

  private present(entry: KnowledgeEntry): KnowledgeEntry {
    entry = { ...entry, knowledgeRef: knowledgeRef(entry) };
    const notices = [...(entry.learning?.disputes ?? []).map(d => `DISPUTED (${d.scope || 'all scopes'}): ${d.explanation}`), ...(entry.learning?.supersessions ?? []).map(d => `SUPERSEDED (${d.scope || 'all scopes'}): use ${d.replacementId}`)];
    if (entry.learning?.scope) notices.push(`Applies only in scope: ${entry.learning.scope}`);
    if (notices.length) entry = { ...entry, content: `${notices.join('\n')}\n${entry.content}` };
    if (entry.type !== 'pattern') return entry;
    const pattern = readPattern(this.entries.get(entry.id)?.content ?? entry.content, entry.title);
    if (!pattern) return entry;
    pattern.learning ??= { revision: 1, applications: [], feedbackIds: [], history: [] };
    return { ...entry, content: (notices.length ? notices.join('\n') + '\n' : '') + renderPatternText(pattern), pattern, patternRef: JSON.stringify([entry.id, pattern.learning.revision]) } as KnowledgeEntry;
  }

  private rowToEntry(r: Record<string, unknown>): KnowledgeEntry {
    let tags: string[] = [];
    try { tags = JSON.parse(String(r.tags ?? '[]')) as string[]; } catch { /* keep [] */ }
    return {
      learning: typeof r.learning === 'string' ? JSON.parse(r.learning) : undefined,
      id: String(r.id),
      title: String(r.title),
      content: String(r.content),
      type: String(r.type) as KnowledgeType,
      tags: Array.isArray(tags) ? tags : [],
      origin: KNOWLEDGE_ORIGINS.includes(r.origin as KnowledgeOrigin) ? (r.origin as KnowledgeOrigin) : 'agent',
      createdBy: String(r.createdBy ?? ''),
      createdAt: Number(r.createdAt ?? 0),
      updatedAt: Number(r.updatedAt ?? 0),
      accessCount: Number(r.accessCount ?? 0),
      lastAccessedAt: Number(r.lastAccessedAt ?? 0),
      usefulCount: Number(r.usefulCount ?? 0),
      lastUsefulAt: Number(r.lastUsefulAt ?? 0),
      archived: Boolean(Number(r.archived ?? 0)),
      creatorPeerId: String(r.creatorPeerId ?? '') || undefined,
    };
  }

  /**
   * Fill provenance/usefulness defaults on entries from sources that predate
   * them (legacy Storage arrays, older peers syncing over SharedState).
   */
  private normalizeEntry(e: KnowledgeEntry): KnowledgeEntry {
    if (!KNOWLEDGE_ORIGINS.includes(e.origin)) e.origin = 'agent';
    e.usefulCount = Number(e.usefulCount ?? 0);
    e.lastUsefulAt = Number(e.lastUsefulAt ?? 0);
    e.archived = Boolean(e.archived);
    return e;
  }

  /** Insert or update an entry row. */
  private writeEntryToDb(e: KnowledgeEntry, strict = false): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT INTO entries(id, title, content, type, tags, createdBy, createdAt, updatedAt, accessCount, lastAccessedAt, origin, usefulCount, lastUsefulAt, archived, creatorPeerId, learning)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          content = excluded.content,
          type = excluded.type,
          tags = excluded.tags,
          updatedAt = excluded.updatedAt,
          accessCount = excluded.accessCount,
          lastAccessedAt = excluded.lastAccessedAt,
          origin = excluded.origin,
          usefulCount = excluded.usefulCount,
          lastUsefulAt = excluded.lastUsefulAt,
          archived = excluded.archived,
          creatorPeerId = excluded.creatorPeerId,
          learning = excluded.learning
      `).run(
        e.id, e.title, e.content, e.type, JSON.stringify(e.tags), e.createdBy,
        e.createdAt, e.updatedAt, e.accessCount, e.lastAccessedAt,
        e.origin, e.usefulCount, e.lastUsefulAt, e.archived ? 1 : 0,
        e.creatorPeerId ?? '', JSON.stringify(e.learning) ?? null,
      );
    } catch (err) {
      if (strict) throw err;
      log.warn(`DB write failed for "${e.title}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private deleteEntryFromDb(id: string): void {
    if (!this.db) return;
    try {
      this.db.prepare(`DELETE FROM entries WHERE id = ?`).run(id);
    } catch (err) {
      log.warn(`DB delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Lightweight access-count bump (leaves entry content untouched). */
  private bumpAccessInDb(e: KnowledgeEntry): void {
    if (!this.db) return;
    try {
      this.db.prepare(`UPDATE entries SET accessCount = ?, lastAccessedAt = ? WHERE id = ?`)
        .run(e.accessCount, e.lastAccessedAt, e.id);
    } catch { /* non-fatal */ }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Lexical search (FTS5 / BM25)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Build a safe FTS5 MATCH expression from raw user text: each token is
   * double-quoted (neutralizing FTS operators and punctuation) and tokens
   * are OR-joined so partial term overlap still ranks.
   */
  private buildFtsQuery(query: string): string | null {
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (terms.length === 0) return null;
    return terms.slice(0, 24).map(t => `"${t.replace(/"/g, '')}"`).join(' OR ');
  }

  private ftsSearch(query: string, limit: number, type?: KnowledgeType): Array<{ id: string; score: number; snippet: string }> {
    if (!this.db) return this.naiveSearch(query, limit, type);
    const match = this.buildFtsQuery(query);
    if (!match) return [];
    try {
      // bm25() returns lower-is-better (negative); flip the sign so callers
      // see higher-is-better. Column weights: title 10, content 1, tags 5.
      const rows = this.db.prepare(`
        SELECT e.id AS id,
               -bm25(entries_fts, 10.0, 1.0, 5.0) AS score,
               snippet(entries_fts, 1, '[', ']', '…', 12) AS snip
        FROM entries_fts
        JOIN entries e ON e.rowid = entries_fts.rowid
        WHERE entries_fts MATCH ? AND e.archived = 0 AND (? IS NULL OR e.type = ?)
        ORDER BY bm25(entries_fts, 10.0, 1.0, 5.0)
        LIMIT ?
      `).all(match, type ?? null, type ?? null, limit) as Array<Record<string, unknown>>;
      return rows.map(r => ({
        learning: typeof r.learning === 'string' ? JSON.parse(r.learning) : undefined,
      id: String(r.id),
        score: Number(r.score ?? 0),
        snippet: String(r.snip ?? ''),
      }));
    } catch (err) {
      log.warn(`FTS search failed: ${err instanceof Error ? err.message : String(err)}`);
      return this.naiveSearch(query, limit, type);
    }
  }

  /** In-memory fallback when the db is unavailable: term-overlap scoring. */
  private naiveSearch(query: string, limit: number, type?: KnowledgeType): Array<{ id: string; score: number; snippet: string }> {
    const terms = (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
    if (terms.length === 0) return [];
    const scored: Array<{ id: string; score: number; snippet: string }> = [];
    for (const e of this.entries.values()) {
      if (e.archived || (type && e.type !== type)) continue;
      const title = e.title.toLowerCase();
      const content = e.content.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (title.includes(t)) score += 3;
        if (content.includes(t)) score += 1;
        if (e.tags.some(tag => tag.toLowerCase().includes(t))) score += 2;
      }
      if (score > 0) scored.push({ id: e.id, score, snippet: e.content.slice(0, 160) });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Rank entries for recall: BM25 lexical ranking with snippets. */
  private async rankIds(query: string, poolSize: number, type?: KnowledgeType): Promise<Array<{ id: string; score: number; snippet?: string }>> {
    return this.ftsSearch(query, poolSize, type)
      .map(l => ({ id: l.id, score: l.score, snippet: l.snippet }));
  }

  // ═══════════════════════════════════════════════════════════════════
  // Ask protocol
  // ═══════════════════════════════════════════════════════════════════

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## KnowledgeBase Usage Guide

### Three lookup modes (use them in this order)

1. **recall** searches by keywords (BM25 full text, title-boosted). Results carry a \`snippet\` and \`score\`. Pass \`previews: true\` to scan cheaply.

  const hits = await call(await dep('KnowledgeBase'), 'recall', {
    query: 'ui preferences', limit: 5, previews: true,
  });

2. **match** finds exact identifiers and precise strings (case-insensitive regex; an invalid regex is treated as a literal). Reach for this when you know the exact name.

  const exact = await call(await dep('KnowledgeBase'), 'match', { pattern: 'GraphViewer|abjects:registry' });

3. **get** fetches one full entry by id. Scan with previews first, then get the winners.

  const entry = await call(await dep('KnowledgeBase'), 'get', { id: hits[0].id });

### The iterate pattern
Search, read the previews, and refine: when results are thin, reformulate with different terms (synonyms, the object's registered name, a distinctive phrase) and search again. Fetch full entries only for the results you will actually use.

### Remember something (create or update knowledge)

  await call(await dep('KnowledgeBase'), 'remember', {
    title: 'User prefers dark UI themes',
    content: 'When creating widgets, default to dark color schemes with light text.',
    type: 'learned',
    tags: ['ui', 'preferences'],
  });

Types: 'learned' (behavioral lessons), 'fact' (discovered facts), 'insight' (agent analysis), 'reference' (pointers to resources), 'pattern' (Alexander/Coplien-style generative pattern-language entries, written through the reviewer's save_pattern/update_pattern actions rather than composed by hand: each names the context it applies to, the forces in tension, what to do therefore, the evidence behind it, and the patterns it links to)

### Weave patterns for a goal

  const woven = await call(await dep('KnowledgeBase'), 'weave', {
    query: 'build a dashboard from live portfolio data', limit: 3,
  });
  // woven.patterns: matched patterns plus one hop of linked patterns
  // woven.dangling: link names with no pattern written yet

### Update / forget / list

  await call(await dep('KnowledgeBase'), 'update', { id: entryId, content: 'Updated...' });
  await call(await dep('KnowledgeBase'), 'forget', { id: entryId });
  const all = await call(await dep('KnowledgeBase'), 'list', { type: 'learned', limit: 20 });

### When to remember (durable knowledge only)
- User preferences or personal facts (location, name, role): tag these with "profile" so every future task always has them, even when the task wording does not mention them
- Facts about this workspace or an external project you are working in
- Stable patterns or capabilities that help future unrelated tasks
- References to external resources or object capabilities
Ephemeral problems (runtime errors, connection failures, debugging context) belong in the goal scratchpad, and the knowledge base stays clean for durable lessons.

### When to recall
- Before starting a task, check if relevant knowledge exists
- When uncertain about user preferences or a project’s conventions
- When a task is similar to a previous one`;
  }

  protected override async handleAsk(question: string): Promise<string> {
    let prompt = this.askPrompt(question);

    // Include knowledge store summary
    const entries = [...this.entries.values()];
    const byType: Record<string, number> = {};
    for (const e of entries) {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
    }
    const typeSummary = Object.entries(byType).map(([t, c]) => `${c} ${t}`).join(', ');
    prompt += `\n\n### Current Knowledge Store\n`;
    prompt += `${entries.length} entries${typeSummary ? ` (${typeSummary})` : ''}.`;
    prompt += ` Retrieval: BM25 lexical (FTS5).\n`;
    if (entries.length > 0) {
      const recent = entries.slice(-5);
      prompt += '\nRecent entries:\n';
      for (const e of recent) {
        prompt += `- [${e.type}] ${e.title}\n`;
      }
    }

    return this.askLlm(prompt, question, 'balanced');
  }

  // ═══════════════════════════════════════════════════════════════════
  // Handlers
  // ═══════════════════════════════════════════════════════════════════

  private revisePatternContent(title: string, content: string, previous?: string): string {
    const pattern = readPattern(content, title);
    if (!pattern) throw new Error('Pattern needs Context, Forces, Therefore and Evidence');
    const old = previous ? readPattern(previous, title) : undefined;
    const learning = old?.learning ?? { revision: old ? 1 : 0, applications: [], feedbackIds: [], history: [] };
    const history = [...learning.history];
    if (old) {
      const snapshot = { ...old, learning: undefined };
      history.push({ revision: learning.revision || 1, content: serializePattern(snapshot) });
    }
    pattern.learning = { ...learning, revision: learning.revision + 1, history: history.slice(-20) };
    return serializePattern(pattern);
  }

  private async applyLearningDecision(msg: AbjectMessage) {
    if (msg.routing.from !== await this.discoverDep('TaskReviewer')) throw new Error('Knowledge learning belongs to TaskReviewer');
    const p = msg.payload as { goalId: string; decisionId: string; effectId: string };
    const owner = await this.discoverDep('GoalManager');
    if (!owner) return { success: false, retryable: true, error: 'GoalManager unavailable' };
    const decision = await this.request<LearningDecision | null>(request(this.id, owner, 'getLearningDecision', p));
    const effect = decision?.effects.find(e => e.id === p.effectId);
    if (!decision || !effect) return { success: false, error: 'Unknown durable learning effect' };
    const input = effect.input;
    return withKeyedLock(`${this.id}:knowledge:${input.id}`, async () => {
      const existing = this.entries.get(String(input.id));
      const receipt = existing?.learning?.history.find(h => h.effectId === effect.id);
      if (receipt) return { success: true, duplicate: true, receipt };
      if (effect.state !== 'proposed') return { success: false, error: 'Effect is not awaiting application' };
      const error = validateLearningEffect(decision, effect);
      if (error) return { success: false, error };
      const creating = input.action === 'save_entry';
      if (creating ? !!existing : !existing) return { success: false, conflict: true, error: creating ? 'Target already exists' : 'Knowledge target unavailable' };
      if (existing && input.action !== 'record_pattern_application' && knowledgeRef(existing) !== input.knowledgeRef) return { success: false, conflict: true, error: 'Selected knowledge version changed', currentRef: knowledgeRef(existing) };
      if (existing?.origin === 'user' && !['dispute_entry','confirm_entry','record_pattern_application'].includes(String(input.action))) return { success: false, protected: true, error: 'User-authored knowledge is protected; record a supported dispute instead' };
      if (input.action === 'supersede_entry') {
        const replacement = this.entries.get(String(input.replacementId));
        if (!replacement || !applicable(replacement, String(input.scope ?? '')) || (replacement.learning?.scope && replacement.learning.scope !== input.scope)) return { success: false, error: 'Replacement must be saved and applicable before supersession' };
      }
      const now = Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1);
      const entry: KnowledgeEntry = existing ? structuredClone(existing) : { id: String(input.id), title: String(input.title), content: String(input.content), type: (input.type as KnowledgeType) ?? 'learned', tags: (input.tags as string[]) ?? [], origin: 'reviewer', createdBy: this.id, createdAt: now, updatedAt: now, archived: false, accessCount: 0, lastAccessedAt: 0, usefulCount: 0, lastUsefulAt: 0 };
      const learning = entry.learning ??= { revision: 0, history: [], disputes: [], supersessions: [] };
      if (input.action === 'update_entry') {
        if (typeof input.title === 'string') entry.title = input.title;
        if (typeof input.content === 'string') entry.content = entry.type === 'pattern' ? this.revisePatternContent(entry.title, input.content, entry.content) : input.content;
        if (Array.isArray(input.tags)) entry.tags = input.tags as string[];
      }
      if (input.action === 'record_pattern_application') {
        const pattern = entry.type === 'pattern' ? readPattern(entry.content, entry.title) : undefined;
        const app = pattern?.learning?.applications.find(a => a.id === input.applicationRef && a.goalId === decision.goalId);
        if (!pattern || !app) return { success: false, error: 'Unresolved application reference' };
        if (app.verdict !== 'applied' && (app.verdict !== input.verdict || app.evidence !== input.evidence)) return { success: false, error: 'Conflicting application feedback' };
        app.verdict = input.verdict as typeof app.verdict; app.evidence = String(input.evidence);
        entry.content = serializePattern(pattern);
      }
      if (input.action === 'archive_entry') {
        if (input.scope) return { success: false, error: 'Scoped retirement requires supersede_entry and an applicable replacement' };
        entry.archived = true;
      }
      if (input.action === 'supersede_entry') learning.supersessions.push({ replacementId: String(input.replacementId), scope: String(input.scope ?? ''), effectId: effect.id });
      if (input.action === 'dispute_entry') learning.disputes.push({ explanation: String(input.evidence), scope: String(input.scope ?? ''), effectId: effect.id });
      if (input.action === 'narrow_entry' || creating && input.scope) learning.scope = String(input.scope);
      learning.revision++;
      const before = existing ? { ...existing, learning: undefined } : null;
      const accepted = { effectId: effect.id, decisionId: decision.id, goalId: decision.goalId, revision: learning.revision, at: now, before, input: structuredClone(input), evidence: structuredClone(decision.evidence) };
      learning.history.push(accepted); entry.updatedAt = now;
      // A successful response is a durable receipt, never an optimistic map update.
      if (creating && entry.type === 'pattern') entry.content = this.revisePatternContent(entry.title, entry.content);
      if (this.db) this.writeEntryToDb(entry, true);
      else {
        const storage = this.storageId ?? await this.discoverDep('Storage');
        if (!storage) return { success: false, retryable: true, error: 'Knowledge persistence unavailable' };
        this.pendingLearning.add(entry.id);
        try {
          const saved = await this.request<{ success?: boolean } | boolean | null>(request(this.id, storage, 'set', { key: `${ENTRY_KEY_PREFIX}${entry.id}`, value: entry }));
          if (saved === false || saved && typeof saved === 'object' && saved.success === false) return { success: false, retryable: true, error: 'Knowledge persistence rejected' };
        } finally { this.pendingLearning.delete(entry.id); }
      }
      this.entries.set(entry.id, entry);
      this.syncEntryToSharedState(entry); this.changed(existing ? 'entryUpdated' : 'entryAdded', entry);
      return { success: true, receipt: accepted };
    });
  }

  private setupHandlers(): void {
    this.on('applyLearningDecision', msg => this.applyLearningDecision(msg));
    describeMessages(this.manifest, [
      { name: 'applyLearningDecision', description: 'Apply a journaled, evidence-linked correction and return a durable idempotent revision receipt.', parameters: { goalId: protocolText, decisionId: protocolText, effectId: protocolText } },
      { name: "beginPatternApplication", description: "Capture an application before execution using an opaque selection receipt.", parameters: { id: protocolText, patternRef: protocolText, applicationId: protocolText, goalId: protocolText, context: protocolText } },
      { name: "assessPatternApplication", description: "Attach feedback to a captured application without supplying a revision.", parameters: { id: protocolText, applicationRef: protocolText, goalId: protocolText, verdict: protocolText, evidence: protocolText } },
      { name: "recordPatternApplication", description: "Record one contextual application with distinct goal evidence and helpful/harmful/inconclusive verdict.", parameters: { "id": protocolText, "application": protocolObject } },
      { name: "patternHistory", description: "Inspect pattern revisions and supporting or contradicting episodes.", parameters: { "id": protocolText } },
    ]);
    // Receipts describe the version actually presented. Callers carry opaque
    // references; KnowledgeBase alone interprets and assigns revision numbers.
    this.on('beginPatternApplication', async (msg: AbjectMessage) => {
      if (this.pendingLearning.has((msg.payload as { id: string }).id)) return { success: false, retryable: true, error: 'Knowledge revision is being persisted' };
      const { id, patternRef, applicationId, goalId, context } = msg.payload as Record<string, string>;
      const entry = this.entries.get(id);
      const pattern = entry?.type === 'pattern' ? readPattern(entry.content, entry.title) : undefined;
      if (!entry || !pattern) return { success: false, error: 'Pattern not found' };
      requireNonEmpty(applicationId, 'applicationId'); requireNonEmpty(goalId, 'goalId'); requireNonEmpty(context, 'context');
      pattern.learning ??= { revision: 1, applications: [], feedbackIds: [], history: [] };
      let receipt: unknown;
      try { receipt = JSON.parse(patternRef); } catch { /* unresolved below */ }
      if (!Array.isArray(receipt) || receipt.length !== 2 || receipt[0] !== id || !Number.isSafeInteger(receipt[1]) || receipt[1] < 1)
        return { success: false, error: 'Unknown pattern selection; retrieve the pattern before applying it' };
      const revision = receipt[1] as number;
      const old = pattern.learning.applications.find(a => a.id === applicationId);
      if (old) return old.patternRevision === revision && old.goalId === goalId && old.declaredContext === context
        ? { success: true, duplicate: true, applicationRef: old.id }
        : { success: false, error: 'Conflicting application identity' };
      if (revision !== pattern.learning.revision && !pattern.learning.history.some(h => h.revision === revision))
        return { success: false, error: 'Selected pattern revision is no longer available' };
      pattern.learning.applications.push({ id: applicationId, goalId, context, declaredContext: context,
        verdict: 'applied', evidence: 'Declared before execution; effect not yet assessed', patternRevision: revision, at: Date.now() });
      entry.content = serializePattern(pattern); entry.updatedAt = Math.max(Date.now(), entry.updatedAt + 1);
      this.writeEntryToDb(entry); this.syncEntryToSharedState(entry); this.changed('entryUpdated', entry);
      return { success: true, applicationRef: applicationId };
    });
    this.on('assessPatternApplication', async (msg: AbjectMessage) => {
      if (this.pendingLearning.has((msg.payload as { id: string }).id)) return { success: false, retryable: true, error: 'Knowledge revision is being persisted' };
      const { id, applicationRef, goalId, verdict, evidence } = msg.payload as Record<string, string>;
      const entry = this.entries.get(id);
      const pattern = entry?.type === 'pattern' ? readPattern(entry.content, entry.title) : undefined;
      const application = pattern?.learning?.applications.find(a => a.id === applicationRef);
      if (!entry || !pattern || !application || application.goalId !== goalId || !application.declaredContext)
        return { success: false, error: 'Unresolved application reference' };
      requireNonEmpty(evidence, 'evidence');
      precondition(['helpful', 'harmful', 'inconclusive'].includes(verdict), 'Invalid feedback verdict');
      if (application.verdict !== 'applied') return application.verdict === verdict && application.evidence === evidence
        ? { success: true, duplicate: true, applicationRef }
        : { success: false, error: 'Conflicting application feedback' };
      application.verdict = verdict as typeof application.verdict; application.evidence = evidence;
      entry.content = serializePattern(pattern); entry.updatedAt = Math.max(Date.now(), entry.updatedAt + 1);
      this.writeEntryToDb(entry); this.syncEntryToSharedState(entry); this.changed('entryUpdated', entry);
      return { success: true, applicationRef };
    });
    this.on('recordPatternApplication', async (msg: AbjectMessage) => {
      if (this.pendingLearning.has((msg.payload as { id: string }).id)) return { success: false, retryable: true, error: 'Knowledge revision is being persisted' };
      const { id, application } = msg.payload as { id: string; application: import('../core/pattern.js').PatternApplication };
      const entry = this.entries.get(id);
      const pattern = entry?.type === 'pattern' ? readPattern(entry.content, entry.title) : undefined;
      if (!entry || !pattern) return { success: false, error: 'Pattern not found' };
      requireNonEmpty(application.id, 'application.id'); requireNonEmpty(application.goalId, 'application.goalId');
      requireNonEmpty(application.context, 'application.context'); requireNonEmpty(application.evidence, 'application.evidence');
      precondition(['applied', 'helpful', 'harmful', 'inconclusive'].includes(application.verdict), 'Invalid application verdict');
      pattern.learning ??= { revision: 1, applications: [], feedbackIds: [], history: [] };
      const old = pattern.learning.applications.find(a => a.id === application.id);
      if (old) {
        const {at: _oldAt,...oldEvidence}=old, {at: _newAt,...newEvidence}=application;
        const keys = [...new Set([...Object.keys(oldEvidence), ...Object.keys(newEvidence)])] as Array<keyof typeof oldEvidence>;
        if (keys.some(key => JSON.stringify(oldEvidence[key]) !== JSON.stringify(newEvidence[key])))
          return { success: false, error: 'Conflicting evidence for the same application identity' };
        return { success: true, duplicate: true };
      }
      precondition(Number.isSafeInteger(application.patternRevision) && application.patternRevision > 0 && application.patternRevision <= pattern.learning.revision, 'Unknown pattern revision');
      pattern.learning.applications.push({ ...application, at: Date.now() });
      entry.content = serializePattern(pattern); entry.updatedAt = Math.max(Date.now(), entry.updatedAt + 1);
      this.writeEntryToDb(entry); this.syncEntryToSharedState(entry); this.changed('entryUpdated', entry);
      return { success: true };
    });
    this.on('patternHistory', async (msg: AbjectMessage) => {
      const { id } = msg.payload as { id: string };
      const e = this.entries.get(id);
      return e?.type === 'pattern' ? readPattern(e.content, e.title)?.learning ?? null : null;
    });

    this.on('remember', async (msg: AbjectMessage) => {
      const { title, content, type, tags, origin } = msg.payload as {
        title: string; content: string; type: KnowledgeType; tags?: string[]; origin?: KnowledgeOrigin;
      };
      requireNonEmpty(title, 'title');
      requireNonEmpty(content, 'content');
      precondition(
        type === 'learned' || type === 'fact' || type === 'insight' || type === 'reference' || type === 'pattern',
        `Invalid knowledge type: ${type}`,
      );
      const entryOrigin: KnowledgeOrigin =
        origin && KNOWLEDGE_ORIGINS.includes(origin) ? origin : 'agent';

      // Patterns are stored as structure whoever writes them. The reviewer
      // sends structure already; an agent using the plain `remember` action
      // sends whatever prose it composed, and that is structured here rather
      // than left to drift into a shape nothing can read back.
      const body = type === 'pattern' ? this.revisePatternContent(title, content) : content;

      // Dedup by normalized title+type: update existing if found. A
      // re-remembered archived entry revives; its origin is preserved so a
      // reviewer refresh can never downgrade a user-authored entry.
      // User-authored entries are dedup-updatable only by user-origin
      // writes: an agent/reviewer remember whose title happens to collide
      // must not replace the user's content (it would keep origin 'user',
      // making the corruption look user-authored and eviction-protected).
      // Such writes fall through and create a separate entry instead.
      const existing = this.findByTitleAndType(title, type);
      if (existing && existing.origin === 'user' && entryOrigin !== 'user') {
        log.info(`Remember: title collides with user entry "${existing.title}"; creating separate ${entryOrigin} entry`);
      } else if (existing) {
        if (this.pendingLearning.has(existing.id)) return { success: false, retryable: true, error: 'Knowledge revision is being persisted' };
        if (existing.learning?.supersessions.length || existing.learning && existing.archived) return { success: false, error: 'Retired knowledge requires an explicit revision', id: existing.id };
        existing.content = type === 'pattern' ? this.revisePatternContent(title, content, existing.content) : body;
        existing.tags = tags ?? existing.tags;
        existing.archived = false;
        existing.updatedAt = Math.max(Date.now(), existing.updatedAt + 1);
        this.writeEntryToDb(existing);
        this.syncEntryToSharedState(existing);
        this.changed('entryUpdated', existing);
        log.info(`Updated knowledge: "${title}" (${type})`);
        return { id: existing.id };
      }

      const entry: KnowledgeEntry = {
        id: uuidv4(),
        title: title.slice(0, 200),
        content: body,
        type,
        tags: tags ?? [],
        origin: entryOrigin,
        createdBy: msg.routing.from,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessCount: 0,
        lastAccessedAt: Date.now(),
        usefulCount: 0,
        lastUsefulAt: 0,
        archived: false,
        creatorPeerId: this.selfPeerId,
      };

      this.entries.set(entry.id, entry);
      this.writeEntryToDb(entry);
      this.syncEntryToSharedState(entry);
      this.changed('entryAdded', entry);
      log.info(`Remembered: "${entry.title}" (${entry.type}) [${entry.tags.join(', ')}]`);
      return { id: entry.id };
    });

    this.on('recall', async (msg: AbjectMessage) => {
      const { query, type, tags, limit, previews, scope } = msg.payload as {
        query?: string; type?: KnowledgeType; tags?: string[]; limit?: number; previews?: boolean; scope?: string;
      };
      const max = Math.min(limit ?? 10, 50);

      let results: RecallResult[];

      if (query && query.trim().length > 0) {
        // Rank over a generous pool, then apply type/tag filters so a filter
        // can't empty the result set just because top hits were other types.
        const ranked = await this.rankIds(query, 100);
        results = [];
        for (const r of ranked) {
          const entry = this.entries.get(r.id);
          if (!entry || !applicable(entry, scope)) continue;
          if (type && entry.type !== type) continue;
          if (tags?.length && !tags.some(t => entry.tags.includes(t))) continue;
          const shown = this.present(entry);
          results.push({
            ...shown,
            snippet: r.snippet ?? shown.content.slice(0, 160),
            score: r.score,
          });
          if (results.length >= max) break;
        }
      } else {
        // No query: return recent entries filtered by type/tags
        results = [...this.entries.values()]
          .filter(e => {
            if (!applicable(e, scope)) return false;
            if (type && e.type !== type) return false;
            if (tags?.length && !tags.some(t => e.tags.includes(t))) return false;
            return true;
          })
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, max)
          .map(e => this.present(e));
      }

      // Bump access counts
      const now = Date.now();
      for (const entry of results) {
        const live = this.entries.get(entry.id);
        if (live) {
          live.accessCount++;
          live.lastAccessedAt = now;
          this.bumpAccessInDb(live);
          entry.accessCount = live.accessCount;
          entry.lastAccessedAt = now;
        }
      }

      log.info(`Recall "${query ?? '*'}" => ${results.length} entries`);

      if (previews) {
        return results.map((r): RecallPreview => ({
          id: r.id,
          title: r.title,
          type: r.type,
          tags: r.tags,
          snippet: r.learning ? r.content.slice(0, 240) : r.snippet ?? r.content.slice(0, 160),
          knowledgeRef: r.knowledgeRef, learning: r.learning,
          score: r.score,
        }));
      }
      return results;
    });

    this.on('weave', async (msg: AbjectMessage) => {
      const { query, limit, hops, scope } = msg.payload as {
        query: string; limit?: number; hops?: number; scope?: string;
      };
      requireNonEmpty(query, 'query');
      const max = Math.max(1, Math.min(limit ?? 5, 20));
      const maxHops = Math.max(0, Math.min(hops ?? 1, 2));

      // Rank over a generous pool, keep only active patterns.
      const ranked = (await this.rankIds(query, 100, 'pattern')).map(r => {
        const pattern = readPattern(this.entries.get(r.id)?.content ?? '');
        const words = new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
        const relevant = (pattern?.learning?.applications ?? []).filter(a => (a.context.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(w => words.has(w)).length >= 2);
        const helpful = new Set(relevant.filter(a => a.verdict === 'helpful').map(a => a.goalId)).size;
        const harmful = new Set(relevant.filter(a => a.verdict === 'harmful').map(a => a.goalId)).size;
        const evidenceWeight = Math.max(0.5, Math.min(1.5, 1 + helpful * 0.1 - harmful * 0.2));
        return { ...r, score: r.score * evidenceWeight, evidenceWeight };
      }).sort((a,b) => b.score - a.score);
      const selected: WovenPattern[] = [];
      const seen = new Set<string>();
      for (const r of ranked) {
        const entry = this.entries.get(r.id);
        if (!entry || !applicable(entry, scope) || entry.type !== 'pattern') continue;
        selected.push({ ...this.present(entry), snippet: r.snippet, score: r.score, via: `matched; contextual evidence weight=${r.evidenceWeight.toFixed(2)}` });
        seen.add(entry.id);
        if (selected.length >= max) break;
      }

      // Breadth-first link expansion: a matched pattern pulls in the
      // patterns its links name, so the language's structure
      // (not just keyword overlap) shapes the selection. Total output is
      // capped so a densely linked language can't flood the prompt.
      const totalCap = max * 3;
      const dangling = new Set<string>();
      let frontier = [...selected];
      for (let hop = 0; hop < maxHops && frontier.length > 0 && selected.length < totalCap; hop++) {
        const next: WovenPattern[] = [];
        for (const pattern of frontier) {
          for (const name of this.parsePatternLinks(pattern.content)) {
            const linked = this.findPatternByName(name);
            if (!linked || !applicable(linked, scope)) {
              dangling.add(name);
              continue;
            }
            if (seen.has(linked.id) || selected.length >= totalCap) continue;
            const woven: WovenPattern = { ...this.present(linked), via: `linked-from: ${pattern.title}` };
            selected.push(woven);
            seen.add(linked.id);
            next.push(woven);
          }
        }
        frontier = next;
      }

      // Bump access counts so patterns participate in staleness signals.
      const now = Date.now();
      for (const pattern of selected) {
        const live = this.entries.get(pattern.id);
        if (live) {
          live.accessCount++;
          live.lastAccessedAt = now;
          this.bumpAccessInDb(live);
          pattern.accessCount = live.accessCount;
          pattern.lastAccessedAt = now;
        }
      }

      log.info(`Weave "${query.slice(0, 60)}" => ${selected.length} patterns (${dangling.size} dangling links)`);
      return { patterns: selected, dangling: [...dangling] };
    });

    this.on('match', async (msg: AbjectMessage) => {
      const { pattern, limit, scope } = msg.payload as { pattern: string; limit?: number; scope?: string };
      requireNonEmpty(pattern, 'pattern');
      const max = Math.min(limit ?? 10, 50);

      let test: (text: string) => boolean;
      try {
        const re = new RegExp(pattern, 'i');
        test = (text) => re.test(text);
      } catch {
        const literal = pattern.toLowerCase();
        test = (text) => text.toLowerCase().includes(literal);
      }

      const results = [...this.entries.values()]
        .filter(e => applicable(e, scope) && (test(e.title) || test(e.content) || e.tags.some(t => test(t))))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, max);

      const now = Date.now();
      for (const e of results) {
        e.accessCount++;
        e.lastAccessedAt = now;
        this.bumpAccessInDb(e);
      }

      log.info(`Match "${pattern}" => ${results.length} entries`);
      return results.map(e => this.present(e));
    });

    this.on('get', async (msg: AbjectMessage) => {
      const { id } = msg.payload as { id: string };
      requireNonEmpty(id, 'id');
      const entry = this.entries.get(id);
      if (!entry) return null;
      entry.accessCount++;
      entry.lastAccessedAt = Date.now();
      this.bumpAccessInDb(entry);
      return this.present(entry);
    });

    this.on('forget', async (msg: AbjectMessage) => {
      if (this.pendingLearning.has((msg.payload as { id: string }).id)) return { success: false, retryable: true, error: 'Knowledge revision is being persisted' };
      const { id } = msg.payload as { id: string };
      requireNonEmpty(id, 'id');
      const entry = this.entries.get(id);
      if (!entry) return { success: false };

      if (entry.learning) return { success: false, error: 'Learning history must be retained; archive the entry' };
      this.entries.delete(id);
      this.deleteEntryFromDb(id);
      // A tombstone, not a snapshot: a whole-array write cannot express a
      // deletion, so peers would resurrect this entry on their next merge.
      this.syncDeletionToSharedState(id, Date.now());
      this.changed('entryRemoved', { id });
      log.info(`Forgot: "${entry.title}"`);
      return { success: true };
    });

    this.on('update', async (msg: AbjectMessage) => {
      if (this.pendingLearning.has((msg.payload as { id: string }).id)) return { success: false, retryable: true, error: 'Knowledge revision is being persisted' };
      const payload = msg.payload as {
        id: string; content?: string; title?: string; tags?: string[]; expectedRevision?: number;
        updates?: { content?: string; title?: string; tags?: string[] };
      };
      const { id } = payload;
      // Accept fields either flat on the payload or nested under `updates`;
      // callers (including LLM-generated ones) reach for both shapes.
      const content = payload.content ?? payload.updates?.content;
      const title = payload.title ?? payload.updates?.title;
      const tags = payload.tags ?? payload.updates?.tags;
      requireNonEmpty(id, 'id');
      const entry = this.entries.get(id);
      if (!entry) return { success: false, error: `No entry with id "${id}"` };

      const revision = entry.type === 'pattern' ? readPattern(entry.content)?.learning?.revision ?? 1 : entry.updatedAt;
      if (payload.expectedRevision !== undefined && payload.expectedRevision !== revision) return { success: false, conflict: true, revision, error: 'Knowledge changed; read it and reconcile before updating' };

      // Surface a no-op rather than reporting success: a wrong-shaped payload
      // that touches no recognized field must not masquerade as an update.
      if (content === undefined && title === undefined && tags === undefined) {
        return { success: false, error: 'No updatable fields provided (expected content, title, and/or tags)' };
      }

      if (content !== undefined) entry.content = entry.type === 'pattern' ? this.revisePatternContent(title ?? entry.title, content, entry.content) : content;
      if (title !== undefined) entry.title = title.slice(0, 200);
      if (tags !== undefined) entry.tags = tags;
      entry.updatedAt = Math.max(Date.now(), entry.updatedAt + 1);

      this.writeEntryToDb(entry);
      this.syncEntryToSharedState(entry);
      this.changed('entryUpdated', entry);
      log.info(`Updated: "${entry.title}"`);
      return { success: true };
    });

    this.on('list', async (msg: AbjectMessage) => {
      const { type, limit, includeArchived } = msg.payload as {
        type?: KnowledgeType; limit?: number; includeArchived?: boolean;
      };
      const max = Math.min(limit ?? 50, 200);

      return [...this.entries.values()]
        .filter(e => (includeArchived || !e.archived) && (!type || e.type === type))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, max)
        .map(e => this.present(e));
    });

    this.on('listTags', async (msg: AbjectMessage) => {
      const { limit } = (msg.payload ?? {}) as { limit?: number };
      const max = Math.min(limit ?? 50, 200);
      const counts = new Map<string, number>();
      for (const e of this.entries.values()) {
        if (e.archived) continue;
        for (const t of e.tags) {
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, max)
        .map(([tag, count]) => ({ tag, count }));
    });

    this.on('markUseful', async (msg: AbjectMessage) => {
      const { ids, operationId } = msg.payload as { ids: string[]; operationId?: string };
      precondition(Array.isArray(ids) && ids.length > 0, 'ids must be a non-empty array');
      const now = Date.now();
      let marked = 0;
      for (const id of ids) {
        const entry = this.entries.get(id);
        if (!entry) continue;
        if (entry.type === 'pattern' && operationId) {
          const pattern = readPattern(entry.content, entry.title);
          if (pattern) {
            pattern.learning ??= { revision: 1, applications: [], feedbackIds: [], history: [] };
            if (pattern.learning.feedbackIds.includes(operationId)) continue;
            pattern.learning.feedbackIds.push(operationId);
            entry.content = serializePattern(pattern);
          }
        }
        entry.usefulCount++;
        entry.lastUsefulAt = now;
        this.writeEntryToDb(entry);
        this.changed('entryUpdated', entry);
        marked++;
      }
      if (marked > 0) this.syncToSharedState();
      log.info(`markUseful: ${marked}/${ids.length} entries`);
      return { marked };
    });

    this.on('archive', async (msg: AbjectMessage) => {
      if (this.pendingLearning.has((msg.payload as { id: string }).id)) return { success: false, retryable: true, error: 'Knowledge revision is being persisted' };
      const { id, archived } = msg.payload as { id: string; archived?: boolean };
      requireNonEmpty(id, 'id');
      const entry = this.entries.get(id);
      if (!entry) return { success: false, error: `No entry with id "${id}"` };
      entry.archived = archived ?? true;
      entry.updatedAt = Math.max(Date.now(), entry.updatedAt + 1);
      this.writeEntryToDb(entry);
      this.syncEntryToSharedState(entry);
      this.changed('entryUpdated', entry);
      log.info(`${entry.archived ? 'Archived' : 'Restored'}: "${entry.title}"`);
      return { success: true };
    });

    // ── SharedState sync listener ──
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value: unknown };
      if (aspect !== 'stateChanged') return;
      // SharedState emits { name, key, value }. The `namespace` field this
      // once read does not exist on that payload, so the guard below rejected
      // every change and the merge was unreachable — cross-peer knowledge sync
      // has never actually run.
      const change = value as { name?: string; key?: string; value?: unknown };
      if (change.name !== 'knowledge-base' || !change.key) return;

      // Per-entry register: the authoritative carrier for a single change.
      if (change.key.startsWith('entry:')) {
        const id = change.key.slice('entry:'.length);
        if (this.applyRemoteEntry(id, change.value)) {
          log.info(`Merged remote knowledge entry ${id}, now ${this.entries.size} total`);
        }
        return;
      }

      // Whole-array snapshot: still accepted so a peer running the older code
      // (and our own bulk paths) keep working.
      if (change.key !== 'entries') return;
      const remote = change.value as KnowledgeEntry[] | undefined;
      if (!Array.isArray(remote)) return;

      const merged = this.mergeRemoteSnapshot(remote);
      if (merged > 0) {
        log.info(`Merged ${merged} remote knowledge entries, now ${this.entries.size} total`);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════

  /** Lowercase, strip punctuation, collapse whitespace: conservative dedupe key. */
  private normalizeTitle(title: string): string {
    return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  private findByTitleAndType(title: string, type: KnowledgeType): KnowledgeEntry | undefined {
    const norm = this.normalizeTitle(title);
    for (const entry of this.entries.values()) {
      if (entry.type === type && this.normalizeTitle(entry.title) === norm) return entry;
    }
    return undefined;
  }

  /**
   * A pattern's links, read straight off the structure.
   *
   * This used to hunt for a 'Links:' line in prose, so the links of every
   * pattern that wrote them as a '## Links' block were invisible and the
   * weave quietly stopped expanding through them.
   */
  private parsePatternLinks(content: string): string[] {
    return readPattern(content)?.links ?? [];
  }

  /** Resolve a link name to an active pattern entry by normalized title. */
  private findPatternByName(name: string): KnowledgeEntry | undefined {
    const direct = this.entries.get(name.replace(/^id:/, ''));
    if (direct?.type === 'pattern' && !direct.archived) return direct;
    const norm = this.normalizeTitle(name);
    for (const entry of this.entries.values()) {
      if (entry.type === 'pattern' && !entry.archived && (this.normalizeTitle(entry.title) === norm || (readPattern(entry.content)?.aliases ?? '').split(/[,;\n]/).some(alias => this.normalizeTitle(alias) === norm))) {
        return entry;
      }
    }
    return undefined;
  }

  // ─── Distillation ──────────────────────────────────────────────

  private static readonly MAX_ENTRIES = 1000;
  private static readonly MAX_ARCHIVED = 2000;
  private static readonly STALE_NEVER_ACCESSED_DAYS = 7;
  private static readonly STALE_INACTIVE_DAYS = 30;
  private static readonly ARCHIVED_PURGE_DAYS = 180;

  /**
   * An entry the automated cleanup must never touch: user-authored entries
   * (origin 'user'), user facts (tagged 'user'/'person'), patterns (they
   * retire only through explicit curation, never by staleness), and entries
   * a reviewer has confirmed useful.
   */
  private isProtected(entry: KnowledgeEntry): boolean {
    if (entry.learning) return true;
    if (entry.origin === 'user') return true;
    if (entry.type === 'pattern') return true;
    if (entry.type === 'fact' && entry.tags.some(t => t === 'user' || t === 'person')) return true;
    if (entry.usefulCount > 0) return true;
    return false;
  }

  /** Archive (not delete): hidden from recall/match, restorable in the browser. */
  private archiveEntry(entry: KnowledgeEntry, why: string): void {
    log.info(`Distill: archiving "${entry.title}" (${why})`);
    entry.archived = true;
    entry.updatedAt = Math.max(Date.now(), entry.updatedAt + 1);
    this.writeEntryToDb(entry);
  }

  /**
   * Periodic cleanup: archive stale, low-value entries and cap the active
   * store. Nothing is hard-deleted except archived entries that outlive the
   * purge window, keeping the store bounded.
   */
  private distill(): void {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    let archivedCount = 0;

    for (const entry of this.entries.values()) {
      if (entry.archived || this.isProtected(entry)) continue;

      const ageDays = (now - entry.createdAt) / dayMs;
      const lastAccessDays = entry.lastAccessedAt
        ? (now - entry.lastAccessedAt) / dayMs
        : ageDays;

      // Archive 'learned' entries never surfaced after 7 days
      if (entry.type === 'learned' && entry.accessCount === 0 && ageDays > KnowledgeBase.STALE_NEVER_ACCESSED_DAYS) {
        this.archiveEntry(entry, `never accessed in ${KnowledgeBase.STALE_NEVER_ACCESSED_DAYS}d`);
        archivedCount++;
        continue;
      }

      // Archive 'learned' or 'reference' entries inactive for 30 days
      if ((entry.type === 'learned' || entry.type === 'reference') && lastAccessDays > KnowledgeBase.STALE_INACTIVE_DAYS) {
        this.archiveEntry(entry, `inactive ${KnowledgeBase.STALE_INACTIVE_DAYS}d`);
        archivedCount++;
      }
    }

    // Cap the ACTIVE store by archiving the least useful entries first
    // (usefulCount, then accessCount). Protected entries are exempt.
    const active = [...this.entries.values()].filter(e => !e.archived);
    if (active.length > KnowledgeBase.MAX_ENTRIES) {
      const candidates = active
        .filter(e => !this.isProtected(e))
        .sort((a, b) => (a.usefulCount - b.usefulCount) || (a.accessCount - b.accessCount));
      let excess = active.length - KnowledgeBase.MAX_ENTRIES;
      while (excess > 0 && candidates.length > 0) {
        this.archiveEntry(candidates.shift()!, 'active-store cap');
        archivedCount++;
        excess--;
      }
    }

    // Bound the archive itself: hard-delete archived entries past the purge
    // window, oldest first when over the archive cap.
    const archived = [...this.entries.values()]
      .filter(e => e.archived && e.origin !== 'user' && !e.learning)
      .sort((a, b) => a.updatedAt - b.updatedAt);
    let purged = 0;
    for (const entry of archived) {
      const archivedDays = (now - entry.updatedAt) / dayMs;
      const overCap = archived.length - purged > KnowledgeBase.MAX_ARCHIVED;
      if (archivedDays > KnowledgeBase.ARCHIVED_PURGE_DAYS || overCap) {
        log.info(`Distill: purging archived "${entry.title}"`);
        this.entries.delete(entry.id);
        this.deleteEntryFromDb(entry.id);
        purged++;
      }
    }

    if (archivedCount > 0 || purged > 0) {
      this.syncToSharedState();
      log.info(`Distill: archived ${archivedCount}, purged ${purged}, ${this.entries.size} entries total`);
    }
  }

  /** This peer's id, used to break ties when two peers stamp the same instant. */
  private localPeerId = '';

  /**
   * Ids deleted locally or remotely, with the stamp of the deletion. A
   * whole-array snapshot cannot express a deletion, so without these a peer
   * that still holds the entry resurrects it on its next merge.
   */
  private tombstones: Map<string, number> = new Map();

  /** This peer's id, falling back to the object id before Identity resolves. */
  private get selfPeerId(): string {
    return this.localPeerId || this.id;
  }

  /** Fire-and-forget write of one register into the shared namespace. */
  private setSharedRegister(key: string, value: unknown): void {
    if (!this.sharedStateId) return;
    this.request(
      request(this.id, this.sharedStateId, 'set', {
        name: 'knowledge-base',
        key,
        value,
        persist: true,
      })
    ).catch(err => {
      log.warn(`Failed to sync ${key} to SharedState:`, err instanceof Error ? err.message : String(err));
    });
  }

  /**
   * Publish one entry as its own register. The whole-array write below is kept
   * as a snapshot channel, but it is the wrong carrier for a single change:
   * two peers remembering different things concurrently each write the entire
   * array, and the later write drops the other's entry.
   */
  private syncEntryToSharedState(entry: KnowledgeEntry): void {
    this.tombstones.delete(entry.id);
    this.setSharedRegister(`entry:${entry.id}`, {
      entry,
      updatedAt: entry.updatedAt,
      peerId: this.selfPeerId,
    });
  }

  /** Publish a deletion as a tombstone register. */
  private syncDeletionToSharedState(id: string, updatedAt: number): void {
    this.tombstones.set(id, updatedAt);
    this.setSharedRegister(`entry:${id}`, { deleted: true, updatedAt, peerId: this.selfPeerId });
  }

  /**
   * Apply one entry register received from a peer.
   *
   * Conflict resolution is last-writer-wins on `updatedAt`. Peer clocks are not
   * synchronised, so an equal stamp is broken on peerId — each side compares the
   * remote id against its own, exactly one comparison holds, and the replicas
   * converge instead of trading the entry back and forth forever.
   */
  private applyRemoteEntry(id: string, raw: unknown): boolean {
    const reg = raw as
      | { entry?: KnowledgeEntry; deleted?: boolean; updatedAt?: number; peerId?: string }
      | undefined;
    if (!reg || typeof reg !== 'object' || typeof reg.updatedAt !== 'number') return false;

    if (this.pendingLearning.has(id)) return false;
    const local = this.entries.get(id);
    if (!preservesLearning(local?.learning, reg.entry?.learning)) return false;
    const localStamp = local?.updatedAt ?? this.tombstones.get(id);
    if (localStamp !== undefined) {
      if (reg.updatedAt < localStamp) return false;
      if (reg.updatedAt === localStamp && (reg.peerId ?? '') <= this.selfPeerId) return false;
    }

    if (reg.deleted) {
      this.tombstones.set(id, reg.updatedAt);
      if (!local) return false;
      this.entries.delete(id);
      this.deleteEntryFromDb(id);
      this.changed('entryRemoved', { id });
      return true;
    }

    if (!reg.entry || typeof reg.entry !== 'object') return false;
    // Provenance rides with the entry. A peer that predates the field says
    // nothing about authorship, so the register's own peer stands in — it is
    // the closest thing to an author that arrived with the write.
    const normalized = this.normalizeEntry({
      ...reg.entry,
      id,
      creatorPeerId: reg.entry.creatorPeerId ?? reg.peerId,
    });
    this.entries.set(normalized.id, normalized);
    this.writeEntryToDb(normalized);
    this.tombstones.delete(id);
    this.changed(local ? 'entryUpdated' : 'entryAdded', normalized);
    return true;
  }

  /** Merge a whole-array snapshot from a peer, honouring local tombstones. */
  private mergeRemoteSnapshot(remote: KnowledgeEntry[]): number {
    let merged = 0;
    for (const re of remote) {
      if (!re || typeof re.id !== 'string') continue;
      const tomb = this.tombstones.get(re.id);
      if (tomb !== undefined && re.updatedAt <= tomb) continue;
      if (this.pendingLearning.has(re.id)) continue;
      const local = this.entries.get(re.id);
      if ((!local || re.updatedAt > local.updatedAt) && preservesLearning(local?.learning, re.learning)) {
        const normalized = this.normalizeEntry(re);
        this.entries.set(normalized.id, normalized);
        this.writeEntryToDb(normalized);
        merged++;
      }
    }
    return merged;
  }

  /**
   * Replay a whole namespace snapshot. This is the late-join path: a peer that
   * was offline missed the individual `stateChanged` events entirely, so on
   * init it reads the namespace whole and applies every register in it.
   */
  private reconcileFromSnapshot(snapshot: Record<string, unknown> | undefined): void {
    if (!snapshot) return;
    let merged = 0;
    for (const [key, value] of Object.entries(snapshot)) {
      if (key.startsWith('entry:')) {
        if (this.applyRemoteEntry(key.slice('entry:'.length), value)) merged++;
      } else if (key === 'entries' && Array.isArray(value)) {
        merged += this.mergeRemoteSnapshot(value as KnowledgeEntry[]);
      }
    }
    if (merged > 0) log.info(`Reconciled ${merged} knowledge entries from peers`);
  }

  private syncToSharedState(): void {
    if (!this.sharedStateId) return;
    this.request(
      request(this.id, this.sharedStateId, 'set', {
        name: 'knowledge-base',
        key: 'entries',
        value: Array.from(this.entries.values()),
        persist: true,
      })
    ).catch(err => {
      log.warn('Failed to sync to SharedState:', err instanceof Error ? err.message : String(err));
    });
  }
}

export const KNOWLEDGE_BASE_ID = 'abjects:knowledge-base' as AbjectId;
