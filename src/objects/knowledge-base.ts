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

const log = new Log('KNOWLEDGE-BASE');

const KNOWLEDGE_BASE_INTERFACE = 'abjects:knowledge-base' as InterfaceId;
const STORAGE_KEY = 'knowledge-base:entries';

/**
 * Tag marking a durable fact about the user (home location, name, role,
 * preferences). Profile-tagged facts are injected into every agent's context
 * unconditionally, so stable knowledge about the user surfaces even when the
 * task shares no keywords with it (keyword recall alone would miss it).
 */
export const PROFILE_TAG = 'profile';

export type KnowledgeType = 'learned' | 'fact' | 'insight' | 'reference';

/**
 * Who authored an entry. Curation policy keys off this: 'user' entries are
 * never auto-evicted or auto-merged; only 'agent'/'reviewer' entries are
 * eligible for automated consolidation.
 */
export type KnowledgeOrigin = 'user' | 'agent' | 'reviewer' | 'scrum';

export interface KnowledgeEntry {
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
}

const KNOWLEDGE_ORIGINS: readonly KnowledgeOrigin[] = ['user', 'agent', 'reviewer', 'scrum'];

/** A recall result: the full entry plus ranking metadata for query searches. */
export interface RecallResult extends KnowledgeEntry {
  /** Match context with [bracketed] highlights (query searches only). */
  snippet?: string;
  /** Relevance score, higher is better (query searches only). */
  score?: number;
}

/** Compact preview shape returned when recall is called with previews: true. */
export interface RecallPreview {
  id: string;
  title: string;
  type: KnowledgeType;
  tags: string[];
  snippet: string;
  score?: number;
}

export class KnowledgeBase extends Abject {
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
          'Persistent agent memory system. Agents remember facts, insights, and lessons learned, then retrieve them three ways: recall (BM25 full-text search), match (exact/regex lookup for identifiers), and get (fetch one full entry by id). Knowledge persists across restarts and syncs across peers.',
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
                { name: 'type', type: { kind: 'primitive', primitive: 'string' }, description: "Entry type: 'learned' | 'fact' | 'insight' | 'reference'" },
                { name: 'tags', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Tags for search/filtering', optional: true },
                { name: 'origin', type: { kind: 'primitive', primitive: 'string' }, description: "Who authored this: 'user' | 'agent' | 'reviewer' | 'scrum' (default 'agent')", optional: true },
              ],
              returns: { kind: 'object', properties: { id: { kind: 'primitive', primitive: 'string' } } },
            },
            {
              name: 'recall',
              description: 'Search knowledge entries by query (BM25-ranked full text, title-boosted), type, or tags. Each result carries a snippet and score. Pass previews: true for compact {id, title, snippet} results, then fetch winners with get.',
              parameters: [
                { name: 'query', type: { kind: 'primitive', primitive: 'string' }, description: 'Search query (keywords)', optional: true },
                { name: 'type', type: { kind: 'primitive', primitive: 'string' }, description: 'Filter by type', optional: true },
                { name: 'tags', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Filter by tags', optional: true },
                { name: 'limit', type: { kind: 'primitive', primitive: 'number' }, description: 'Max results (default 10)', optional: true },
                { name: 'previews', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Return compact previews instead of full entries', optional: true },
              ],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'KnowledgeEntry' } },
            },
            {
              name: 'match',
              description: 'Exact/regex lookup over titles and content. Use for identifiers, names, and precise strings where full-text ranking is unnecessary. Pattern is a case-insensitive regex; an invalid regex is treated as a literal substring.',
              parameters: [
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
        archived INTEGER NOT NULL DEFAULT 0
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
      `ALTER TABLE entries ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent'`,
      `ALTER TABLE entries ADD COLUMN usefulCount INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE entries ADD COLUMN lastUsefulAt INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE entries ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
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
      `SELECT id, title, content, type, tags, createdBy, createdAt, updatedAt, accessCount, lastAccessedAt, origin, usefulCount, lastUsefulAt, archived FROM entries`
    ).all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      const entry = this.rowToEntry(r);
      this.entries.set(entry.id, entry);
    }
  }

  private rowToEntry(r: Record<string, unknown>): KnowledgeEntry {
    let tags: string[] = [];
    try { tags = JSON.parse(String(r.tags ?? '[]')) as string[]; } catch { /* keep [] */ }
    return {
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
  private writeEntryToDb(e: KnowledgeEntry): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT INTO entries(id, title, content, type, tags, createdBy, createdAt, updatedAt, accessCount, lastAccessedAt, origin, usefulCount, lastUsefulAt, archived)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          archived = excluded.archived
      `).run(
        e.id, e.title, e.content, e.type, JSON.stringify(e.tags), e.createdBy,
        e.createdAt, e.updatedAt, e.accessCount, e.lastAccessedAt,
        e.origin, e.usefulCount, e.lastUsefulAt, e.archived ? 1 : 0,
      );
    } catch (err) {
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

  private ftsSearch(query: string, limit: number): Array<{ id: string; score: number; snippet: string }> {
    if (!this.db) return this.naiveSearch(query, limit);
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
        WHERE entries_fts MATCH ?
        ORDER BY bm25(entries_fts, 10.0, 1.0, 5.0)
        LIMIT ?
      `).all(match, limit) as Array<Record<string, unknown>>;
      return rows.map(r => ({
        id: String(r.id),
        score: Number(r.score ?? 0),
        snippet: String(r.snip ?? ''),
      }));
    } catch (err) {
      log.warn(`FTS search failed: ${err instanceof Error ? err.message : String(err)}`);
      return this.naiveSearch(query, limit);
    }
  }

  /** In-memory fallback when the db is unavailable: term-overlap scoring. */
  private naiveSearch(query: string, limit: number): Array<{ id: string; score: number; snippet: string }> {
    const terms = (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
    if (terms.length === 0) return [];
    const scored: Array<{ id: string; score: number; snippet: string }> = [];
    for (const e of this.entries.values()) {
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
  private async rankIds(query: string, poolSize: number): Promise<Array<{ id: string; score: number; snippet?: string }>> {
    return this.ftsSearch(query, poolSize)
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

Types: 'learned' (behavioral lessons), 'fact' (discovered facts), 'insight' (agent analysis), 'reference' (pointers to resources)

### Update / forget / list

  await call(await dep('KnowledgeBase'), 'update', { id: entryId, content: 'Updated...' });
  await call(await dep('KnowledgeBase'), 'forget', { id: entryId });
  const all = await call(await dep('KnowledgeBase'), 'list', { type: 'learned', limit: 20 });

### When to remember (durable knowledge only)
- User preferences or personal facts (location, name, role): tag these with "profile" so every future task always has them, even when the task wording does not mention them
- Facts about the workspace or project structure
- Stable patterns or capabilities that help future unrelated tasks
- References to external resources or object capabilities
Ephemeral problems (runtime errors, connection failures, debugging context) belong in the goal scratchpad, and the knowledge base stays clean for durable lessons.

### When to recall
- Before starting a task, check if relevant knowledge exists
- When uncertain about user preferences or project conventions
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

  private setupHandlers(): void {
    this.on('remember', async (msg: AbjectMessage) => {
      const { title, content, type, tags, origin } = msg.payload as {
        title: string; content: string; type: KnowledgeType; tags?: string[]; origin?: KnowledgeOrigin;
      };
      requireNonEmpty(title, 'title');
      requireNonEmpty(content, 'content');
      precondition(
        type === 'learned' || type === 'fact' || type === 'insight' || type === 'reference',
        `Invalid knowledge type: ${type}`,
      );
      const entryOrigin: KnowledgeOrigin =
        origin && KNOWLEDGE_ORIGINS.includes(origin) ? origin : 'agent';

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
        existing.content = content;
        existing.tags = tags ?? existing.tags;
        existing.archived = false;
        existing.updatedAt = Date.now();
        this.writeEntryToDb(existing);
        this.syncToSharedState();
        this.changed('entryUpdated', existing);
        log.info(`Updated knowledge: "${title}" (${type})`);
        return { id: existing.id };
      }

      const entry: KnowledgeEntry = {
        id: uuidv4(),
        title: title.slice(0, 200),
        content,
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
      };

      this.entries.set(entry.id, entry);
      this.writeEntryToDb(entry);
      this.syncToSharedState();
      this.changed('entryAdded', entry);
      log.info(`Remembered: "${entry.title}" (${entry.type}) [${entry.tags.join(', ')}]`);
      return { id: entry.id };
    });

    this.on('recall', async (msg: AbjectMessage) => {
      const { query, type, tags, limit, previews } = msg.payload as {
        query?: string; type?: KnowledgeType; tags?: string[]; limit?: number; previews?: boolean;
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
          if (!entry || entry.archived) continue;
          if (type && entry.type !== type) continue;
          if (tags?.length && !tags.some(t => entry.tags.includes(t))) continue;
          results.push({
            ...entry,
            snippet: r.snippet ?? entry.content.slice(0, 160),
            score: r.score,
          });
          if (results.length >= max) break;
        }
      } else {
        // No query: return recent entries filtered by type/tags
        results = [...this.entries.values()]
          .filter(e => {
            if (e.archived) return false;
            if (type && e.type !== type) return false;
            if (tags?.length && !tags.some(t => e.tags.includes(t))) return false;
            return true;
          })
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, max);
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
          snippet: r.snippet ?? r.content.slice(0, 160),
          score: r.score,
        }));
      }
      return results;
    });

    this.on('match', async (msg: AbjectMessage) => {
      const { pattern, limit } = msg.payload as { pattern: string; limit?: number };
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
        .filter(e => !e.archived && (test(e.title) || test(e.content) || e.tags.some(t => test(t))))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, max);

      const now = Date.now();
      for (const e of results) {
        e.accessCount++;
        e.lastAccessedAt = now;
        this.bumpAccessInDb(e);
      }

      log.info(`Match "${pattern}" => ${results.length} entries`);
      return results;
    });

    this.on('get', async (msg: AbjectMessage) => {
      const { id } = msg.payload as { id: string };
      requireNonEmpty(id, 'id');
      const entry = this.entries.get(id);
      if (!entry) return null;
      entry.accessCount++;
      entry.lastAccessedAt = Date.now();
      this.bumpAccessInDb(entry);
      return entry;
    });

    this.on('forget', async (msg: AbjectMessage) => {
      const { id } = msg.payload as { id: string };
      requireNonEmpty(id, 'id');
      const entry = this.entries.get(id);
      if (!entry) return { success: false };

      this.entries.delete(id);
      this.deleteEntryFromDb(id);
      this.syncToSharedState();
      this.changed('entryRemoved', { id });
      log.info(`Forgot: "${entry.title}"`);
      return { success: true };
    });

    this.on('update', async (msg: AbjectMessage) => {
      const payload = msg.payload as {
        id: string; content?: string; title?: string; tags?: string[];
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

      // Surface a no-op rather than reporting success: a wrong-shaped payload
      // that touches no recognized field must not masquerade as an update.
      if (content === undefined && title === undefined && tags === undefined) {
        return { success: false, error: 'No updatable fields provided (expected content, title, and/or tags)' };
      }

      if (content !== undefined) entry.content = content;
      if (title !== undefined) entry.title = title.slice(0, 200);
      if (tags !== undefined) entry.tags = tags;
      entry.updatedAt = Date.now();

      this.writeEntryToDb(entry);
      this.syncToSharedState();
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
        .slice(0, max);
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
      const { ids } = msg.payload as { ids: string[] };
      precondition(Array.isArray(ids) && ids.length > 0, 'ids must be a non-empty array');
      const now = Date.now();
      let marked = 0;
      for (const id of ids) {
        const entry = this.entries.get(id);
        if (!entry) continue;
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
      const { id, archived } = msg.payload as { id: string; archived?: boolean };
      requireNonEmpty(id, 'id');
      const entry = this.entries.get(id);
      if (!entry) return { success: false, error: `No entry with id "${id}"` };
      entry.archived = archived ?? true;
      entry.updatedAt = Date.now();
      this.writeEntryToDb(entry);
      this.syncToSharedState();
      this.changed('entryUpdated', entry);
      log.info(`${entry.archived ? 'Archived' : 'Restored'}: "${entry.title}"`);
      return { success: true };
    });

    // ── SharedState sync listener ──
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value: unknown };
      if (aspect !== 'stateChanged') return;
      const change = value as { namespace?: string; key?: string; value?: unknown };
      if (change.namespace !== 'knowledge-base' || change.key !== 'entries') return;

      const remote = change.value as KnowledgeEntry[] | undefined;
      if (!Array.isArray(remote)) return;

      // Merge: accept entries we don't have, update entries with newer updatedAt
      let merged = 0;
      for (const re of remote) {
        const local = this.entries.get(re.id);
        if (!local || re.updatedAt > local.updatedAt) {
          const normalized = this.normalizeEntry(re);
          this.entries.set(normalized.id, normalized);
          this.writeEntryToDb(normalized);
          merged++;
        }
      }
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

  // ─── Distillation ──────────────────────────────────────────────

  private static readonly MAX_ENTRIES = 1000;
  private static readonly MAX_ARCHIVED = 2000;
  private static readonly STALE_NEVER_ACCESSED_DAYS = 7;
  private static readonly STALE_INACTIVE_DAYS = 30;
  private static readonly ARCHIVED_PURGE_DAYS = 180;

  /**
   * An entry the automated cleanup must never touch: user-authored entries
   * (origin 'user'), user facts (tagged 'user'/'person'), and entries a
   * reviewer has confirmed useful.
   */
  private isProtected(entry: KnowledgeEntry): boolean {
    if (entry.origin === 'user') return true;
    if (entry.type === 'fact' && entry.tags.some(t => t === 'user' || t === 'person')) return true;
    if (entry.usefulCount > 0) return true;
    return false;
  }

  /** Archive (not delete): hidden from recall/match, restorable in the browser. */
  private archiveEntry(entry: KnowledgeEntry, why: string): void {
    log.info(`Distill: archiving "${entry.title}" (${why})`);
    entry.archived = true;
    entry.updatedAt = Date.now();
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
      .filter(e => e.archived && e.origin !== 'user')
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
