/**
 * CollectionStore - structured, queryable, shared data for a workspace.
 *
 * Backed by SQLite (node:sqlite) at $ABJECTS_DATA_DIR/ws-<id>/collections.db,
 * beside the workspace's storage.db and files (see data-dir-layout.ts); a
 * store whose workspace never resolves uses $ABJECTS_DATA_DIR/collections.db.
 * A database left under ~/.abject by an older build moves there on first open.
 * Collections are real tables: schema-declared fields become typed columns,
 * everything else lands in a JSON `extra` column. Writes go through
 * insert/update/remove so change events fire (recordInserted/recordUpdated/
 * recordRemoved); reads use find (simple filters) or query (read-only SQL).
 *
 * Two objects that have never negotiated a protocol can still cooperate
 * through a shared collection; the change events give TriggerManager rules,
 * bound tables, and live charts something to react to.
 *
 * A write that carries `undo: 'Label'` is journaled for its caller (in memory,
 * this session): the rows as they were before and after, so the caller's
 * `undo` puts them back and `redo` takes them forward again, each only while
 * the rows still hold what the step left. A collection dropped with a label
 * is set aside instead (its table renamed under `_dropped_`), kept for the
 * session and at least three days, so undo can bring it back whole.
 */

import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import Ajv, { type ValidateFunction } from 'ajv';
import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import {
  require as precondition,
  requireNonEmpty,
  invariant,
} from '../core/contracts.js';
import { request, event } from '../core/message.js';
import { Log } from '../core/timed-log.js';
import { UndoHistories, UndoRefused, UNDO_EVENTS, sameValue, undoMethods, type UndoAction, type UndoResult, type UndoStep } from '../core/undo.js';
import { workspaceDataDir, legacyHomeDataDir, moveLegacyData } from './data-dir-layout.js';

const log = new Log('COLLECTION-STORE');

/** The database's file name, in a workspace's data directory or at the top of the instance's. */
const DB_FILE = 'collections.db';

/** Files SQLite keeps beside a database in WAL mode; they move with it. */
const SQLITE_COMPANIONS = ['-wal', '-shm'] as const;

const COLLECTION_STORE_INTERFACE = 'abjects:collection-store' as InterfaceId;

/** Valid SQL identifier: collection and field names become table/column names. */
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Columns every collection carries; schema fields may not shadow them. */
const RESERVED_COLUMNS = new Set(['id', 'createdAt', 'updatedAt', 'extra']);

const QUERY_ROW_CAP = 1000;

/** A dropped collection set aside for undo is kept at least this long (and for the whole session). */
const DROPPED_KEEP_MS = 3 * 24 * 60 * 60_000;

/** A row exactly as stored (`SELECT *`). */
type RawRow = Record<string, unknown>;

/** One row before and after a journaled write; null where the row is absent. */
interface RowChange { collection: string; id: string; before: RawRow | null; after: RawRow | null }

/** One undoable step: rows written, or a collection set aside under `hiddenAs`. */
type CollectionUndoStep =
  | { kind: 'rows'; changes: RowChange[] }
  | { kind: 'drop'; name: string; hiddenAs: string };

/** The optional undo label on writes. */
const undoParam = {
  name: 'undo',
  type: { kind: 'primitive' as const, primitive: 'string' as const },
  description: 'A label for this change (e.g. "Clean up expenses"). Given one, the change is kept in your undo history here and your `undo` call puts the rows back. Writes with the same label in a burst are one step.',
  optional: true,
};

/** Same content, ignoring when it was last written. */
function sameRow(a: RawRow | null, b: RawRow | null): boolean {
  if (!a || !b) return a === b;
  const { updatedAt: _a, ...restA } = a;
  const { updatedAt: _b, ...restB } = b;
  return sameValue(restA, restB);
}

type JsonSchema = {
  type?: string;
  properties?: Record<string, { type?: string }>;
  required?: string[];
  [key: string]: unknown;
};

interface CollectionMeta {
  name: string;
  schema?: JsonSchema;
  synced: boolean;
  createdAt: number;
  /** Schema fields that map to typed columns, in declaration order. */
  typedFields: { name: string; jsType: string }[];
  validate?: ValidateFunction;
}

function sqlTypeFor(jsType: string): string | undefined {
  switch (jsType) {
    case 'string': return 'TEXT';
    case 'number': return 'REAL';
    case 'integer': return 'INTEGER';
    case 'boolean': return 'INTEGER';
    default: return undefined;
  }
}

/** Extract the typed-column fields from a JSON schema's properties. */
function typedFieldsOf(schema: JsonSchema | undefined): { name: string; jsType: string }[] {
  const out: { name: string; jsType: string }[] = [];
  if (!schema?.properties) return out;
  for (const [name, prop] of Object.entries(schema.properties)) {
    const jsType = prop?.type;
    if (typeof jsType === 'string' && sqlTypeFor(jsType) && IDENT_RE.test(name)
        && !RESERVED_COLUMNS.has(name)) {
      out.push({ name, jsType });
    }
  }
  return out;
}

/**
 * Reject SQL that is not a single read-only statement. Defence in depth: the
 * statement also runs on a connection opened with readOnly: true, so writes
 * are refused by the engine even if a clever statement slips past here.
 */
function assertReadOnlySql(sql: string): void {
  // Strip line and block comments, then leading whitespace.
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
  const head = stripped.slice(0, 6).toUpperCase();
  precondition(
    head.startsWith('SELECT') || head.startsWith('WITH'),
    'query only runs SELECT or WITH statements; use insert/update/remove for writes'
  );
  // Reject multiple statements: a ';' followed by anything but whitespace,
  // ignoring semicolons inside single-quoted string literals.
  const noStrings = stripped.replace(/'(?:[^']|'')*'/g, "''");
  const semi = noStrings.indexOf(';');
  precondition(
    semi === -1 || noStrings.slice(semi + 1).trim().length === 0,
    'query runs a single statement; separate calls for separate statements'
  );
}

export class CollectionStore extends Abject {
  private db?: DatabaseSync;
  private readDb?: DatabaseSync;
  private dbPath?: string;
  private workspaceId?: string;
  private collections: Map<string, CollectionMeta> = new Map();
  private ajv = new Ajv({ allErrors: true, strict: false });

  /**
   * Each caller's journaled writes, in memory for the session. A burst of
   * writes under one label is one step, with each row's first before and
   * last after.
   */
  private journal = new UndoHistories<CollectionUndoStep>({
    maxSteps: 100,
    maxBytes: 2 * 1024 * 1024,
    mergeMs: 10_000,
    merge: (older, newer) => {
      if (older.kind !== 'rows' || newer.kind !== 'rows') return newer;
      const byRow = new Map(older.changes.map(c => [`${c.collection}\u0000${c.id}`, { ...c }]));
      for (const c of newer.changes) {
        const key = `${c.collection}\u0000${c.id}`;
        const prior = byRow.get(key);
        byRow.set(key, prior ? { ...prior, after: c.after } : c);
      }
      return { kind: 'rows', changes: [...byRow.values()] };
    },
  }, 32);
  /** The live id each caller last wrote from, to tell it its undo state moved. */
  private journalCallers = new Map<string, AbjectId>();
  private droppedSeq = 0;

  constructor() {
    super({
      manifest: {
        name: 'CollectionStore',
        description:
          'Structured, queryable, shared data for the workspace. Collections are SQLite tables with typed columns from an optional JSON schema. Writes emit change events; reads use simple filters or read-only SQL. Use a shared collection whenever data matters to more than one object.',
        version: '1.0.0',
        interface: {
          id: COLLECTION_STORE_INTERFACE,
          name: 'CollectionStore',
          description: 'Workspace collection storage with SQL queries',
          methods: [
            {
              name: 'createCollection',
              description: 'Create a collection (idempotent). Schema properties with type string/number/integer/boolean become typed, indexable columns; other fields are stored in a JSON extra column.',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Collection name (letters, digits, underscores; becomes the table name)' },
                { name: 'schema', type: { kind: 'reference', reference: 'JsonSchema' }, description: 'Optional JSON schema; writes are validated against it', optional: true },
                { name: 'synced', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Reserved for cross-peer sync', optional: true },
              ],
              returns: { kind: 'object', properties: { name: { kind: 'primitive', primitive: 'string' }, created: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'insert',
              description: 'Insert a record. Emits recordInserted.',
              parameters: [
                { name: 'collection', type: { kind: 'primitive', primitive: 'string' }, description: 'Collection name' },
                { name: 'record', type: { kind: 'object', properties: {} }, description: 'Record fields' },
                undoParam,
              ],
              returns: { kind: 'object', properties: { id: { kind: 'primitive', primitive: 'string' } } },
            },
            {
              name: 'update',
              description: 'Update fields of a record by id. Emits recordUpdated.',
              parameters: [
                { name: 'collection', type: { kind: 'primitive', primitive: 'string' }, description: 'Collection name' },
                { name: 'id', type: { kind: 'primitive', primitive: 'string' }, description: 'Record id' },
                { name: 'changes', type: { kind: 'object', properties: {} }, description: 'Fields to change' },
                undoParam,
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'remove',
              description: 'Delete a record by id. Emits recordRemoved.',
              parameters: [
                { name: 'collection', type: { kind: 'primitive', primitive: 'string' }, description: 'Collection name' },
                { name: 'id', type: { kind: 'primitive', primitive: 'string' }, description: 'Record id' },
                undoParam,
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'get',
              description: 'Fetch a single record by id',
              parameters: [
                { name: 'collection', type: { kind: 'primitive', primitive: 'string' }, description: 'Collection name' },
                { name: 'id', type: { kind: 'primitive', primitive: 'string' }, description: 'Record id' },
              ],
              returns: { kind: 'object', properties: {} },
            },
            {
              name: 'find',
              description: 'Find records by equality filters, with sort/limit/offset',
              parameters: [
                { name: 'collection', type: { kind: 'primitive', primitive: 'string' }, description: 'Collection name' },
                { name: 'filter', type: { kind: 'object', properties: {} }, description: 'Field: value equality pairs (typed columns and id)', optional: true },
                { name: 'sort', type: { kind: 'primitive', primitive: 'string' }, description: "Column to sort by; prefix with '-' for descending (e.g. '-updatedAt')", optional: true },
                { name: 'limit', type: { kind: 'primitive', primitive: 'number' }, description: 'Max rows (default 100)', optional: true },
                { name: 'offset', type: { kind: 'primitive', primitive: 'number' }, description: 'Rows to skip', optional: true },
              ],
              returns: { kind: 'array', elementType: { kind: 'object', properties: {} } },
            },
            {
              name: 'query',
              description: 'Run a read-only SQL statement (single SELECT or WITH) with ? placeholders. Rows are arrays in column order, capped at 1000.',
              parameters: [
                { name: 'sql', type: { kind: 'primitive', primitive: 'string' }, description: 'SQL text' },
                { name: 'params', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Positional parameters', optional: true },
              ],
              returns: { kind: 'object', properties: { columns: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, rows: { kind: 'array', elementType: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } } } } },
            },
            {
              name: 'listCollections',
              description: 'List collections with schema and row count',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'object', properties: { name: { kind: 'primitive', primitive: 'string' }, rowCount: { kind: 'primitive', primitive: 'number' } } } },
            },
            {
              name: 'dropCollection',
              description: 'Delete a collection and all its records. With `undo`, the collection is set aside (session and at least three days) so your undo brings it back whole.',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Collection name' },
                undoParam,
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            ...undoMethods('your last write made with an `undo` label (your writes only): rows changed go back, inserted rows go, removed rows return with their ids, a dropped collection comes back. Rows written again since are not overwritten: the undo is refused. Undo writes emit the usual record events'),
          ],
          events: [
            ...UNDO_EVENTS,
            { name: 'collectionCreated', description: 'A collection was created', payload: { kind: 'object', properties: { name: { kind: 'primitive', primitive: 'string' } } } },
            { name: 'collectionDropped', description: 'A collection was dropped', payload: { kind: 'object', properties: { name: { kind: 'primitive', primitive: 'string' } } } },
            { name: 'recordInserted', description: 'A record was inserted', payload: { kind: 'object', properties: { collection: { kind: 'primitive', primitive: 'string' }, id: { kind: 'primitive', primitive: 'string' } } } },
            { name: 'recordUpdated', description: 'A record was updated', payload: { kind: 'object', properties: { collection: { kind: 'primitive', primitive: 'string' }, id: { kind: 'primitive', primitive: 'string' } } } },
            { name: 'recordRemoved', description: 'A record was removed', payload: { kind: 'object', properties: { collection: { kind: 'primitive', primitive: 'string' }, id: { kind: 'primitive', primitive: 'string' } } } },
          ],
        },
        tags: ['system', 'data'],
      },
    });
    this.setupHandlers();
  }

  override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.collections instanceof Map, 'collections must be a Map');
    invariant(
      this.db === undefined || this.dbPath !== undefined,
      'an open database always has a path'
    );
  }

  protected override async onInit(): Promise<void> {
    // Resolve which workspace owns this instance so its data lands beside the
    // workspace's virtual filesystem. onInit runs inside WorkspaceManager's
    // spawn call, before the manager records the child, so the first attempt
    // usually misses; retry with backoff until the DB opens. Resolution
    // failure falls back to a global store rather than failing init; the DB
    // opens lazily on first use.
    await this.resolveWorkspace();
    if (!this.workspaceId) this.scheduleWorkspaceRetry();
    log.info(`CollectionStore initialized (workspace: ${this.workspaceId ?? 'global (pending retry)'})`);
  }

  private async resolveWorkspace(): Promise<void> {
    try {
      const wmId = await this.discoverDep('WorkspaceManager');
      if (wmId) {
        const info = await this.request<{ workspaceId?: string } | null>(
          request(this.id, wmId, 'findWorkspaceForObject', { objectId: this.id })
        );
        if (info?.workspaceId) this.workspaceId = info.workspaceId;
      }
    } catch (err) {
      log.warn('Workspace resolution failed:',
        err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Late workspace resolution. Only adopted while the database is still
   * unopened: once a DB file exists, switching paths would strand data, so a
   * store that opened at the global path stays there for its lifetime.
   */
  private scheduleWorkspaceRetry(attempt = 0): void {
    if (attempt >= 5) {
      log.warn('Workspace unresolved after retries; this store uses the global path');
      return;
    }
    setTimeout(() => {
      if (this.db || this.workspaceId) return;
      this.resolveWorkspace().then(() => {
        if (this.workspaceId) {
          log.info(`CollectionStore workspace resolved: ${this.workspaceId}`);
        } else if (!this.db) {
          this.scheduleWorkspaceRetry(attempt + 1);
        }
      }).catch(() => this.scheduleWorkspaceRetry(attempt + 1));
    }, 500 * Math.pow(2, attempt));
  }

  protected override async onStop(): Promise<void> {
    try { this.readDb?.close(); } catch { /* already closed */ }
    try { this.db?.close(); } catch { /* already closed */ }
    this.readDb = undefined;
    this.db = undefined;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Database plumbing
  // ═══════════════════════════════════════════════════════════════════

  private openDb(): DatabaseSync {
    if (this.db) return this.db;
    const dir = workspaceDataDir(this.workspaceId);
    const dbPath = path.join(dir, DB_FILE);
    moveLegacyData(path.join(legacyHomeDataDir(this.workspaceId, 'global'), DB_FILE), dbPath,
      'collections database', log, SQLITE_COMPANIONS);
    fs.mkdirSync(dir, { recursive: true });
    this.dbPath = dbPath;
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS _collections (
      name TEXT PRIMARY KEY,
      schemaJson TEXT,
      synced INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL
    )`);
    // Collections dropped with an undo label wait here, renamed, until purged.
    this.db.exec(`CREATE TABLE IF NOT EXISTS _dropped (
      hidden TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      schemaJson TEXT,
      synced INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL,
      droppedAt INTEGER NOT NULL
    )`);
    this.purgeDropped();
    this.loadCollections();
    this.checkInvariants();
    return this.db;
  }

  /** Read-only connection used exclusively by query(). Opened after the
   *  write connection so the file is guaranteed to exist. */
  private openReadDb(): DatabaseSync {
    this.openDb();
    if (!this.readDb) {
      this.readDb = new DatabaseSync(this.dbPath!, { readOnly: true });
    }
    return this.readDb;
  }

  private loadCollections(): void {
    if (!this.db) return;
    this.collections.clear();
    const rows = this.db.prepare('SELECT name, schemaJson, synced, createdAt FROM _collections').all() as
      { name: string; schemaJson: string | null; synced: number; createdAt: number }[];
    for (const row of rows) {
      const schema = row.schemaJson ? JSON.parse(row.schemaJson) as JsonSchema : undefined;
      this.collections.set(row.name, {
        name: row.name,
        schema,
        synced: row.synced === 1,
        createdAt: row.createdAt,
        typedFields: typedFieldsOf(schema),
        validate: this.compileSchema(row.name, schema),
      });
    }
  }

  private compileSchema(name: string, schema?: JsonSchema): ValidateFunction | undefined {
    if (!schema) return undefined;
    try {
      return this.ajv.compile(schema);
    } catch (err) {
      log.warn(`Schema for collection '${name}' failed to compile; validation skipped:`,
        err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  private meta(collection: string): CollectionMeta {
    const m = this.collections.get(collection);
    precondition(m !== undefined, `Unknown collection '${collection}'. Create it first with createCollection.`);
    return m!;
  }

  /** Split a record into typed-column values and JSON extras. */
  private splitRecord(m: CollectionMeta, record: Record<string, unknown>): {
    typed: Record<string, unknown>; extra: Record<string, unknown>;
  } {
    const typed: Record<string, unknown> = {};
    const extra: Record<string, unknown> = {};
    const typedNames = new Set(m.typedFields.map(f => f.name));
    for (const [k, v] of Object.entries(record)) {
      if (RESERVED_COLUMNS.has(k)) continue;
      if (typedNames.has(k)) {
        typed[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
      } else {
        extra[k] = v;
      }
    }
    return { typed, extra };
  }

  /** Rebuild a record from a table row: typed columns + parsed extras. */
  private rowToRecord(m: CollectionMeta, row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {
      id: row.id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    for (const f of m.typedFields) {
      let v = row[f.name];
      if (f.jsType === 'boolean' && v !== null && v !== undefined) v = v === 1;
      out[f.name] = v;
    }
    const extraJson = row.extra as string | null | undefined;
    if (extraJson) {
      try { Object.assign(out, JSON.parse(extraJson)); } catch { /* corrupt extra stays hidden */ }
    }
    return out;
  }

  private validateRecord(m: CollectionMeta, record: Record<string, unknown>): void {
    if (!m.validate) return;
    if (!m.validate(record)) {
      const errs = (m.validate.errors ?? [])
        .map(e => `${e.instancePath || '(root)'} ${e.message ?? ''}`)
        .join('; ');
      precondition(false, `Record fails the '${m.name}' schema: ${errs}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Handlers
  // ═══════════════════════════════════════════════════════════════════

  private setupHandlers(): void {
    this.on('createCollection', async (msg: AbjectMessage) => {
      const { name, schema, synced } = msg.payload as {
        name: string; schema?: JsonSchema; synced?: boolean;
      };
      requireNonEmpty(name, 'name');
      precondition(IDENT_RE.test(name), 'Collection names use letters, digits, and underscores, starting with a letter or underscore');
      precondition(!name.startsWith('_'), 'Names starting with underscore are reserved for internal tables');
      const db = this.openDb();

      if (this.collections.has(name)) {
        return { name, created: false };
      }

      const typedFields = typedFieldsOf(schema);
      const cols = [
        '"id" TEXT PRIMARY KEY',
        ...typedFields.map(f => `"${f.name}" ${sqlTypeFor(f.jsType)}`),
        '"extra" TEXT',
        '"createdAt" INTEGER NOT NULL',
        '"updatedAt" INTEGER NOT NULL',
      ];
      db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (${cols.join(', ')})`);
      db.prepare('INSERT OR REPLACE INTO _collections (name, schemaJson, synced, createdAt) VALUES (?, ?, ?, ?)')
        .run(name, schema ? JSON.stringify(schema) : null, synced ? 1 : 0, Date.now());

      // Cross-peer sync via SharedState CRDT replay is the follow-up; the
      // synced flag is persisted now so existing collections opt in later.
      this.collections.set(name, {
        name, schema, synced: !!synced, createdAt: Date.now(),
        typedFields, validate: this.compileSchema(name, schema),
      });
      this.checkInvariants();
      this.changed('collectionCreated', { name });
      log.info(`Collection created: ${name} (${typedFields.length} typed columns)`);
      return { name, created: true };
    });

    this.on('insert', async (msg: AbjectMessage) => {
      const { collection, record, undo } = msg.payload as {
        collection: string; record: Record<string, unknown>; undo?: string;
      };
      requireNonEmpty(collection, 'collection');
      precondition(record !== null && typeof record === 'object', 'record must be an object');
      this.checkUndoLabel(undo);
      const db = this.openDb();
      const m = this.meta(collection);
      this.validateRecord(m, record);

      const id = uuidv4();
      const now = Date.now();
      const { typed, extra } = this.splitRecord(m, record);
      const colNames = ['id', ...Object.keys(typed), 'extra', 'createdAt', 'updatedAt'];
      const placeholders = colNames.map(() => '?').join(', ');
      const values = [
        id,
        ...Object.values(typed),
        Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
        now, now,
      ];
      db.prepare(`INSERT INTO "${collection}" (${colNames.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`)
        .run(...values as never[]);

      const stored = this.rowToRecord(m, { id, createdAt: now, updatedAt: now, ...typed,
        extra: Object.keys(extra).length > 0 ? JSON.stringify(extra) : null });
      this.changed('recordInserted', { collection, id, record: stored });
      if (undo !== undefined) await this.journalRows(msg, undo, [{ collection, id, before: null, after: this.readRaw(collection, id) }]);
      return { id };
    });

    this.on('update', async (msg: AbjectMessage) => {
      const { collection, id, changes, undo } = msg.payload as {
        collection: string; id: string; changes: Record<string, unknown>; undo?: string;
      };
      requireNonEmpty(collection, 'collection');
      requireNonEmpty(id, 'id');
      precondition(changes !== null && typeof changes === 'object', 'changes must be an object');
      this.checkUndoLabel(undo);
      const db = this.openDb();
      const m = this.meta(collection);

      const row = db.prepare(`SELECT * FROM "${collection}" WHERE id = ?`).get(id) as
        Record<string, unknown> | undefined;
      if (!row) return { success: false };

      const current = this.rowToRecord(m, row);
      const merged: Record<string, unknown> = { ...current, ...changes };
      delete merged.id; delete merged.createdAt; delete merged.updatedAt;
      this.validateRecord(m, merged);

      const now = Date.now();
      const { typed, extra } = this.splitRecord(m, merged);
      const sets = [
        ...Object.keys(typed).map(k => `"${k}" = ?`),
        '"extra" = ?',
        '"updatedAt" = ?',
      ];
      db.prepare(`UPDATE "${collection}" SET ${sets.join(', ')} WHERE id = ?`)
        .run(...Object.values(typed) as never[],
          Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
          now, id);

      const stored = { ...merged, id, createdAt: current.createdAt, updatedAt: now };
      this.changed('recordUpdated', { collection, id, record: stored });
      if (undo !== undefined) {
        const after = this.readRaw(collection, id);
        if (!sameRow(row, after)) await this.journalRows(msg, undo, [{ collection, id, before: { ...row }, after }]);
      }
      return { success: true };
    });

    this.on('remove', async (msg: AbjectMessage) => {
      const { collection, id, undo } = msg.payload as { collection: string; id: string; undo?: string };
      requireNonEmpty(collection, 'collection');
      requireNonEmpty(id, 'id');
      this.checkUndoLabel(undo);
      const db = this.openDb();
      this.meta(collection);
      const before = undo !== undefined ? this.readRaw(collection, id) : null;
      const res = db.prepare(`DELETE FROM "${collection}" WHERE id = ?`).run(id);
      const success = Number(res.changes) > 0;
      if (success) this.changed('recordRemoved', { collection, id });
      if (success && before) await this.journalRows(msg, undo!, [{ collection, id, before, after: null }]);
      return { success };
    });

    this.on('get', async (msg: AbjectMessage) => {
      const { collection, id } = msg.payload as { collection: string; id: string };
      requireNonEmpty(collection, 'collection');
      requireNonEmpty(id, 'id');
      const db = this.openDb();
      const m = this.meta(collection);
      const row = db.prepare(`SELECT * FROM "${collection}" WHERE id = ?`).get(id) as
        Record<string, unknown> | undefined;
      return row ? this.rowToRecord(m, row) : null;
    });

    this.on('find', async (msg: AbjectMessage) => {
      const { collection, filter, sort, limit, offset } = msg.payload as {
        collection: string;
        filter?: Record<string, unknown>;
        sort?: string;
        limit?: number;
        offset?: number;
      };
      requireNonEmpty(collection, 'collection');
      const db = this.openDb();
      const m = this.meta(collection);

      const filterable = new Set(['id', 'createdAt', 'updatedAt', ...m.typedFields.map(f => f.name)]);
      const where: string[] = [];
      const params: unknown[] = [];
      for (const [k, v] of Object.entries(filter ?? {})) {
        precondition(filterable.has(k),
          `find filters on typed columns only (${[...filterable].join(', ')}); use query() for JSON fields`);
        where.push(`"${k}" = ?`);
        params.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
      }

      let orderBy = '"updatedAt" DESC';
      if (sort) {
        const desc = sort.startsWith('-');
        const col = desc ? sort.slice(1) : sort;
        precondition(filterable.has(col), `sort column must be one of: ${[...filterable].join(', ')}`);
        orderBy = `"${col}" ${desc ? 'DESC' : 'ASC'}`;
      }

      const lim = Math.min(Math.max(1, limit ?? 100), QUERY_ROW_CAP);
      const off = Math.max(0, offset ?? 0);
      const sql = `SELECT * FROM "${collection}"`
        + (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '')
        + ` ORDER BY ${orderBy} LIMIT ${lim} OFFSET ${off}`;
      const rows = db.prepare(sql).all(...params as never[]) as Record<string, unknown>[];
      return rows.map(r => this.rowToRecord(m, r));
    });

    this.on('query', async (msg: AbjectMessage) => {
      const { sql, params } = msg.payload as { sql: string; params?: unknown[] };
      requireNonEmpty(sql, 'sql');
      assertReadOnlySql(sql);
      const db = this.openReadDb();
      const stmt = db.prepare(sql);
      let columns: string[] = [];
      try {
        columns = stmt.columns().map(c => String((c as { column?: string | null; name?: string }).column
          ?? (c as { name?: string }).name ?? ''));
      } catch { /* columns() unavailable; fall back to row keys below */ }
      const objRows = stmt.all(...(params ?? []) as never[]) as Record<string, unknown>[];
      if (columns.length === 0 && objRows.length > 0) columns = Object.keys(objRows[0]);
      const capped = objRows.length > QUERY_ROW_CAP;
      if (capped) log.info(`query result capped at ${QUERY_ROW_CAP} rows (was ${objRows.length})`);
      const rows = (capped ? objRows.slice(0, QUERY_ROW_CAP) : objRows)
        .map(r => columns.map(c => r[c]));
      return { columns, rows, capped };
    });

    this.on('listCollections', async () => {
      this.openDb();
      return this.listCollectionsInfo();
    });

    this.on('dropCollection', async (msg: AbjectMessage) => {
      const { name, undo } = msg.payload as { name: string; undo?: string };
      requireNonEmpty(name, 'name');
      precondition(IDENT_RE.test(name), 'invalid collection name');
      this.checkUndoLabel(undo);
      const db = this.openDb();
      if (!this.collections.has(name)) return { success: false };
      if (undo !== undefined) {
        const hiddenAs = this.setAside(name);
        await this.recordStep(msg, undo, { kind: 'drop', name, hiddenAs }, `drop:${hiddenAs}`);
        return { success: true };
      }
      db.exec(`DROP TABLE IF EXISTS "${name}"`);
      db.prepare('DELETE FROM _collections WHERE name = ?').run(name);
      this.collections.delete(name);
      this.checkInvariants();
      this.changed('collectionDropped', { name });
      return { success: true };
    });

    this.on('undo', async (msg: AbjectMessage) => this.undoFor(msg, 'undo'));
    this.on('redo', async (msg: AbjectMessage) => this.undoFor(msg, 'redo'));
    this.on('getUndoState', async (msg: AbjectMessage) =>
      this.journal.state(await this.undoCallerKey(msg.routing.from)));
  }

  // ═══════════════════════════════════════════════════════════════════
  // Undo
  // ═══════════════════════════════════════════════════════════════════

  private checkUndoLabel(undo: unknown): void {
    precondition(undo === undefined || (typeof undo === 'string' && undo.trim().length > 0),
      'undo: the label must be a non-empty string');
  }

  private readRaw(collection: string, id: string): RawRow | null {
    const row = this.openDb().prepare(`SELECT * FROM "${collection}" WHERE id = ?`).get(id) as RawRow | undefined;
    return row ? { ...row } : null;
  }

  /** Write a stored row back as it was, stamped now. */
  private writeRaw(collection: string, row: RawRow): RawRow {
    const written: RawRow = { ...row, updatedAt: Date.now() };
    const cols = Object.keys(written);
    this.openDb().prepare(`INSERT OR REPLACE INTO "${collection}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...Object.values(written) as never[]);
    return written;
  }

  private async journalRows(msg: AbjectMessage, label: string, changes: RowChange[]): Promise<void> {
    await this.recordStep(msg, label, { kind: 'rows', changes }, 'rows');
  }

  private async recordStep(msg: AbjectMessage, label: string, data: CollectionUndoStep, mergeKey: string): Promise<void> {
    const caller = await this.undoCallerKey(msg.routing.from);
    this.journal.for(caller).record(label.trim(), data, { mergeKey });
    this.journalCallers.set(caller, msg.routing.from);
    this.tellUndoState(caller);
  }

  private async undoFor(msg: AbjectMessage, action: UndoAction): Promise<UndoResult> {
    const caller = await this.undoCallerKey(msg.routing.from);
    const history = this.journal.get(caller);
    if (!history) return { ok: false, reason: action === 'undo' ? 'Nothing to undo' : 'Nothing to redo' };
    const result = await history[action](step => this.applyUndoStep(step, action));
    this.journalCallers.set(caller, msg.routing.from);
    this.tellUndoState(caller);
    return result;
  }

  private applyUndoStep(step: UndoStep<CollectionUndoStep>, action: UndoAction): void {
    const verb = action === 'undo' ? 'undone' : 'redone';
    const data = step.data;
    this.openDb();
    if (data.kind === 'drop') {
      if (action === 'undo') {
        this.restoreSetAside(data.name, data.hiddenAs, step.label);
      } else {
        if (!this.collections.has(data.name)) {
          throw new UndoRefused(`Collection '${data.name}' is gone, so "${step.label}" can no longer be redone`);
        }
        data.hiddenAs = this.setAside(data.name);
      }
      return;
    }

    // Every row must still hold what the step left before any is written.
    for (const c of data.changes) {
      if (!this.collections.has(c.collection)) {
        throw new UndoRefused(`Collection '${c.collection}' is gone, so "${step.label}" can no longer be ${verb}`);
      }
      if (!sameRow(this.readRaw(c.collection, c.id), action === 'undo' ? c.after : c.before)) {
        throw new UndoRefused(`A row in '${c.collection}' changed since, so "${step.label}" can no longer be ${verb}`);
      }
    }
    const db = this.openDb();
    const events: Array<{ aspect: string; value: Record<string, unknown> }> = [];
    db.exec('BEGIN');
    try {
      for (const c of data.changes) {
        const target = action === 'undo' ? c.before : c.after;
        const had = action === 'undo' ? c.after : c.before;
        if (!target) {
          db.prepare(`DELETE FROM "${c.collection}" WHERE id = ?`).run(c.id);
          events.push({ aspect: 'recordRemoved', value: { collection: c.collection, id: c.id } });
          continue;
        }
        const record = this.rowToRecord(this.meta(c.collection), this.writeRaw(c.collection, target));
        events.push({ aspect: had ? 'recordUpdated' : 'recordInserted', value: { collection: c.collection, id: c.id, record } });
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    // The same events a write sends, so views and rules follow the undo.
    for (const e of events) this.changed(e.aspect, e.value);
  }

  /**
   * Drop a collection by setting it aside: its table is renamed under
   * `_dropped_` and its catalog row moves to `_dropped`. Returns the hidden
   * name. Announced as a drop.
   */
  private setAside(name: string): string {
    const db = this.openDb();
    const m = this.meta(name);
    const hiddenAs = `_dropped_${Date.now()}_${++this.droppedSeq}_${name}`;
    const row = db.prepare('SELECT schemaJson, synced, createdAt FROM _collections WHERE name = ?').get(name) as
      { schemaJson: string | null; synced: number; createdAt: number } | undefined;
    db.exec('BEGIN');
    try {
      db.exec(`ALTER TABLE "${name}" RENAME TO "${hiddenAs}"`);
      db.prepare('INSERT INTO _dropped (hidden, name, schemaJson, synced, createdAt, droppedAt) VALUES (?, ?, ?, ?, ?, ?)')
        .run(hiddenAs, name, row?.schemaJson ?? (m.schema ? JSON.stringify(m.schema) : null),
          row?.synced ?? (m.synced ? 1 : 0), row?.createdAt ?? m.createdAt, Date.now());
      db.prepare('DELETE FROM _collections WHERE name = ?').run(name);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    this.collections.delete(name);
    this.checkInvariants();
    this.changed('collectionDropped', { name });
    return hiddenAs;
  }

  /** Bring a set-aside collection back under its name, announced as a creation. */
  private restoreSetAside(name: string, hiddenAs: string, label: string): void {
    const db = this.openDb();
    if (this.collections.has(name)) {
      throw new UndoRefused(`A collection named '${name}' exists again, so "${label}" can no longer be undone`);
    }
    const kept = db.prepare('SELECT schemaJson, synced, createdAt FROM _dropped WHERE hidden = ?').get(hiddenAs) as
      { schemaJson: string | null; synced: number; createdAt: number } | undefined;
    if (!kept) throw new UndoRefused(`'${name}' is no longer kept, so "${label}" can no longer be undone`);
    db.exec('BEGIN');
    try {
      db.exec(`ALTER TABLE "${hiddenAs}" RENAME TO "${name}"`);
      db.prepare('INSERT OR REPLACE INTO _collections (name, schemaJson, synced, createdAt) VALUES (?, ?, ?, ?)')
        .run(name, kept.schemaJson, kept.synced, kept.createdAt);
      db.prepare('DELETE FROM _dropped WHERE hidden = ?').run(hiddenAs);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    this.loadCollections();
    this.checkInvariants();
    this.changed('collectionCreated', { name });
  }

  /**
   * Purge collections set aside more than three days ago. Runs when the
   * database opens, so whatever this session set aside lasts the session.
   */
  private purgeDropped(): void {
    const db = this.db!;
    const old = db.prepare('SELECT hidden FROM _dropped WHERE droppedAt < ?').all(Date.now() - DROPPED_KEEP_MS) as { hidden: string }[];
    for (const { hidden } of old) {
      try {
        db.exec(`DROP TABLE IF EXISTS "${hidden}"`);
        db.prepare('DELETE FROM _dropped WHERE hidden = ?').run(hidden);
      } catch (err) {
        log.warn(`Could not purge dropped collection ${hidden}:`, err instanceof Error ? err.message : String(err));
      }
    }
    if (old.length > 0) log.info(`Purged ${old.length} dropped collection(s) kept past three days`);
  }

  private tellUndoState(caller: string): void {
    const to = this.journalCallers.get(caller);
    if (to) this.send(event(this.id, to, 'undoStateChanged', this.journal.state(caller)));
  }

  private listCollectionsInfo(): { name: string; schema?: JsonSchema; synced: boolean; rowCount: number }[] {
    const db = this.openDb();
    return [...this.collections.values()].map(m => {
      let rowCount = 0;
      try {
        const r = db.prepare(`SELECT COUNT(*) AS n FROM "${m.name}"`).get() as { n: number };
        rowCount = Number(r.n);
      } catch { /* table missing */ }
      return { name: m.name, schema: m.schema, synced: m.synced, rowCount };
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Ask protocol: the live catalog is what makes any agent an analyst
  // ═══════════════════════════════════════════════════════════════════

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## CollectionStore Usage Guide

### Create a collection (schema fields become typed, queryable columns)

  await call(await dep('CollectionStore'), 'createCollection', {
    name: 'expenses',
    schema: { type: 'object', properties: {
      amount: { type: 'number' }, category: { type: 'string' }, note: { type: 'string' },
    }, required: ['amount', 'category'] },
  });

Every record automatically gets id, createdAt, updatedAt. Fields outside the
schema are stored too (in a JSON extra column) and come back on reads.

### Write through methods so change events fire

  const { id } = await call(storeId, 'insert', { collection: 'expenses',
    record: { amount: 12.5, category: 'food', note: 'lunch' } });
  await call(storeId, 'update', { collection: 'expenses', id, changes: { amount: 13 } });
  await call(storeId, 'remove', { collection: 'expenses', id });

Writes emit recordInserted/recordUpdated/recordRemoved to dependents, so UIs
and rules stay live. addDependent to receive them.

### Undoable writes
Pass an undo label on insert, update, remove or dropCollection when the person
may want the change back (cleaning up, bulk edits, an import):

  await call(storeId, 'update', { collection: 'expenses', id, changes: { amount: 13 }, undo: 'Fix amounts' });
  await call(storeId, 'dropCollection', { name: 'scratch', undo: 'Drop scratch' });

Writes with the same label in a burst form one step. undo() puts your last step
back (changed rows return, inserted rows go, removed rows return with their ids,
a dropped collection returns whole); redo() takes it forward again; getUndoState()
says what they would do. A row written again since is left alone and the undo is
refused. Undo writes send the usual record events.

### Read with find (simple) or query (full SQL, read-only)

  const rows = await call(storeId, 'find', { collection: 'expenses',
    filter: { category: 'food' }, sort: '-updatedAt', limit: 20 });

  const { columns, rows } = await call(storeId, 'query', {
    sql: 'SELECT category, SUM(amount) AS total FROM expenses GROUP BY category ORDER BY total DESC',
  });

query() accepts one SELECT or WITH statement with ? placeholders (pass params
as an array). Aggregations, joins across collections, GROUP BY, and SQLite
JSON functions (json_extract(extra, '$.field')) all work.

### When to use a collection
Prefer a shared collection over private object state whenever the data could
matter to another object, an agent, or a chart: shared data is how objects
cooperate without negotiating a protocol.`;
  }

  protected override async handleAsk(question: string): Promise<string> {
    let prompt = this.askPrompt(question);
    try {
      const infos = this.listCollectionsInfo();
      prompt += `\n\n### Live Catalog (${infos.length} collection${infos.length === 1 ? '' : 's'})\n`;
      if (infos.length === 0) {
        prompt += 'No collections yet. createCollection starts one.\n';
      }
      for (const info of infos) {
        const m = this.collections.get(info.name)!;
        const cols = [
          'id TEXT', 'createdAt INTEGER', 'updatedAt INTEGER',
          ...m.typedFields.map(f => `${f.name} ${sqlTypeFor(f.jsType)}`),
          'extra JSON',
        ];
        prompt += `\n**${info.name}** (${info.rowCount} rows)\n`;
        prompt += `  Columns: ${cols.join(', ')}\n`;
        const firstTyped = m.typedFields[0]?.name ?? 'id';
        prompt += `  Example find: find({ collection: '${info.name}', filter: {}, sort: '-updatedAt', limit: 20 })\n`;
        prompt += `  Example SQL: SELECT ${['id', ...m.typedFields.map(f => f.name)].slice(0, 4).join(', ')} FROM ${info.name} WHERE ${firstTyped} IS NOT NULL ORDER BY updatedAt DESC LIMIT 20\n`;
      }
    } catch (err) {
      prompt += `\n\n(Catalog unavailable: ${err instanceof Error ? err.message : String(err)})\n`;
    }
    return this.askLlm(prompt, question, 'balanced');
  }
}

export const COLLECTION_STORE_ID = 'abjects:collection-store' as AbjectId;
