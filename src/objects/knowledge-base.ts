/**
 * KnowledgeBase - persistent agent memory system.
 *
 * Stores structured knowledge entries that agents can remember, recall,
 * and search. Backed by Storage for persistence, SharedState for
 * cross-peer sync, and MiniSearch for full-text retrieval.
 */

import { v4 as uuidv4 } from 'uuid';
import MiniSearch from 'minisearch';
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

export type KnowledgeType = 'learned' | 'fact' | 'insight' | 'reference';

export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  type: KnowledgeType;
  tags: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number;
}

/** MiniSearch needs tags as a single string for indexing. */
interface IndexedEntry {
  id: string;
  title: string;
  content: string;
  tags: string;
  type: string;
}

function toIndexed(e: KnowledgeEntry): IndexedEntry {
  return { id: e.id, title: e.title, content: e.content, tags: e.tags.join(' '), type: e.type };
}

export class KnowledgeBase extends Abject {
  private storageId?: AbjectId;
  private sharedStateId?: AbjectId;
  private entries: Map<string, KnowledgeEntry> = new Map();
  private index: MiniSearch<IndexedEntry>;

  constructor() {
    super({
      manifest: {
        name: 'KnowledgeBase',
        description:
          'Persistent agent memory system. Agents remember facts, insights, and lessons learned, then recall them by keyword search. Knowledge persists across restarts and syncs across peers.',
        version: '1.0.0',
        interface: {
          id: KNOWLEDGE_BASE_INTERFACE,
          name: 'KnowledgeBase',
          description: 'Agent knowledge storage and retrieval',
          methods: [
            {
              name: 'remember',
              description: 'Store a knowledge entry. Deduplicates by title+type (updates if exists).',
              parameters: [
                { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: 'Short summary (max 200 chars)' },
                { name: 'content', type: { kind: 'primitive', primitive: 'string' }, description: 'The knowledge content (markdown)' },
                { name: 'type', type: { kind: 'primitive', primitive: 'string' }, description: "Entry type: 'learned' | 'fact' | 'insight' | 'reference'" },
                { name: 'tags', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Tags for search/filtering', optional: true },
              ],
              returns: { kind: 'object', properties: { id: { kind: 'primitive', primitive: 'string' } } },
            },
            {
              name: 'recall',
              description: 'Search knowledge entries by query, type, or tags',
              parameters: [
                { name: 'query', type: { kind: 'primitive', primitive: 'string' }, description: 'Search query (keywords)', optional: true },
                { name: 'type', type: { kind: 'primitive', primitive: 'string' }, description: 'Filter by type', optional: true },
                { name: 'tags', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Filter by tags', optional: true },
                { name: 'limit', type: { kind: 'primitive', primitive: 'number' }, description: 'Max results (default 10)', optional: true },
              ],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'KnowledgeEntry' } },
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
              ],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'KnowledgeEntry' } },
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

    this.index = new MiniSearch<IndexedEntry>({
      fields: ['title', 'content', 'tags'],
      storeFields: ['title', 'type', 'tags'],
      searchOptions: {
        boost: { title: 3, tags: 2, content: 1 },
        prefix: true,
        fuzzy: 0.2,
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

    // Load persisted entries
    if (this.storageId) {
      try {
        const stored = await this.request<KnowledgeEntry[] | null>(
          request(this.id, this.storageId, 'get', { key: STORAGE_KEY })
        );
        if (Array.isArray(stored)) {
          for (const entry of stored) {
            this.entries.set(entry.id, entry);
          }
          this.rebuildIndex();
          log.info(`Loaded ${this.entries.size} knowledge entries from Storage`);
        }
      } catch (err) {
        log.warn('Failed to load from Storage:', err instanceof Error ? err.message : String(err));
      }
    }

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
  }

  protected override getSourceForAsk(): string | undefined {
    return `## KnowledgeBase Usage Guide

### Remember something (create or update knowledge)

  await call(await dep('KnowledgeBase'), 'remember', {
    title: 'User prefers dark UI themes',
    content: 'When creating widgets, default to dark color schemes with light text.',
    type: 'learned',
    tags: ['ui', 'preferences'],
  });

Types: 'learned' (behavioral lessons), 'fact' (discovered facts), 'insight' (agent analysis), 'reference' (pointers to resources)

### Search knowledge

  const entries = await call(await dep('KnowledgeBase'), 'recall', {
    query: 'ui preferences',
    type: 'learned',       // optional filter
    tags: ['ui'],           // optional filter
    limit: 5,              // default 10
  });

### Update existing entry

  await call(await dep('KnowledgeBase'), 'update', {
    id: entryId,
    content: 'Updated content...',
    tags: ['new', 'tags'],
  });

### Forget (delete) an entry

  await call(await dep('KnowledgeBase'), 'forget', { id: entryId });

### List all entries

  const all = await call(await dep('KnowledgeBase'), 'list', { type: 'learned', limit: 20 });

### When to remember
- Lessons from failed tasks (what went wrong and how to avoid it)
- User preferences discovered during interaction
- Facts about the workspace or project structure
- Useful patterns or shortcuts found while working
- References to external resources or object capabilities

### When to recall
- Before starting a task, check if relevant knowledge exists
- When uncertain about user preferences or project conventions
- When a task is similar to a previous one`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Handlers
  // ═══════════════════════════════════════════════════════════════════

  private setupHandlers(): void {
    this.on('remember', async (msg: AbjectMessage) => {
      const { title, content, type, tags } = msg.payload as {
        title: string; content: string; type: KnowledgeType; tags?: string[];
      };
      requireNonEmpty(title, 'title');
      requireNonEmpty(content, 'content');
      precondition(
        type === 'learned' || type === 'fact' || type === 'insight' || type === 'reference',
        `Invalid knowledge type: ${type}`,
      );

      // Dedup by title+type: update existing if found
      const existing = this.findByTitleAndType(title, type);
      if (existing) {
        this.index.discard(existing.id);
        existing.content = content;
        existing.tags = tags ?? existing.tags;
        existing.updatedAt = Date.now();
        this.index.add(toIndexed(existing));
        this.persist();
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
        createdBy: msg.routing.from,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessCount: 0,
        lastAccessedAt: Date.now(),
      };

      this.entries.set(entry.id, entry);
      this.index.add(toIndexed(entry));
      this.persist();
      this.syncToSharedState();
      this.changed('entryAdded', entry);
      log.info(`Remembered: "${entry.title}" (${entry.type}) [${entry.tags.join(', ')}]`);
      return { id: entry.id };
    });

    this.on('recall', async (msg: AbjectMessage) => {
      const { query, type, tags, limit } = msg.payload as {
        query?: string; type?: KnowledgeType; tags?: string[]; limit?: number;
      };
      const max = Math.min(limit ?? 10, 50);

      let results: KnowledgeEntry[];

      if (query && query.trim().length > 0) {
        // Full-text search via MiniSearch
        const searchResults = this.index.search(query, {
          filter: (result) => {
            if (type && result.type !== type) return false;
            if (tags?.length) {
              const entryTags = (result.tags as string).split(' ');
              if (!tags.some(t => entryTags.includes(t))) return false;
            }
            return true;
          },
        });
        results = searchResults
          .slice(0, max)
          .map(r => this.entries.get(r.id))
          .filter((e): e is KnowledgeEntry => e !== undefined);
      } else {
        // No query: return recent entries filtered by type/tags
        results = [...this.entries.values()]
          .filter(e => {
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
        entry.accessCount++;
        entry.lastAccessedAt = now;
      }

      log.info(`Recall "${query ?? '*'}" => ${results.length} entries`);
      return results;
    });

    this.on('forget', async (msg: AbjectMessage) => {
      const { id } = msg.payload as { id: string };
      requireNonEmpty(id, 'id');
      const entry = this.entries.get(id);
      if (!entry) return { success: false };

      this.index.discard(id);
      this.entries.delete(id);
      this.persist();
      this.syncToSharedState();
      this.changed('entryRemoved', { id });
      log.info(`Forgot: "${entry.title}"`);
      return { success: true };
    });

    this.on('update', async (msg: AbjectMessage) => {
      const { id, content, title, tags } = msg.payload as {
        id: string; content?: string; title?: string; tags?: string[];
      };
      requireNonEmpty(id, 'id');
      const entry = this.entries.get(id);
      if (!entry) return { success: false };

      this.index.discard(id);

      if (content !== undefined) entry.content = content;
      if (title !== undefined) entry.title = title.slice(0, 200);
      if (tags !== undefined) entry.tags = tags;
      entry.updatedAt = Date.now();

      this.index.add(toIndexed(entry));
      this.persist();
      this.syncToSharedState();
      this.changed('entryUpdated', entry);
      log.info(`Updated: "${entry.title}"`);
      return { success: true };
    });

    this.on('list', async (msg: AbjectMessage) => {
      const { type, limit } = msg.payload as { type?: KnowledgeType; limit?: number };
      const max = Math.min(limit ?? 50, 200);

      return [...this.entries.values()]
        .filter(e => !type || e.type === type)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, max);
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
      let merged = false;
      for (const re of remote) {
        const local = this.entries.get(re.id);
        if (!local) {
          this.entries.set(re.id, re);
          merged = true;
        } else if (re.updatedAt > local.updatedAt) {
          this.entries.set(re.id, re);
          merged = true;
        }
      }
      if (merged) {
        this.rebuildIndex();
        this.persist();
        log.info(`Merged remote knowledge, now ${this.entries.size} entries`);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════

  private findByTitleAndType(title: string, type: KnowledgeType): KnowledgeEntry | undefined {
    const lower = title.toLowerCase();
    for (const entry of this.entries.values()) {
      if (entry.type === type && entry.title.toLowerCase() === lower) return entry;
    }
    return undefined;
  }

  private rebuildIndex(): void {
    this.index.removeAll();
    for (const entry of this.entries.values()) {
      this.index.add(toIndexed(entry));
    }
  }

  private persist(): void {
    if (!this.storageId) return;
    this.request(
      request(this.id, this.storageId, 'set', {
        key: STORAGE_KEY,
        value: Array.from(this.entries.values()),
      })
    ).catch(err => {
      log.warn('Failed to persist:', err instanceof Error ? err.message : String(err));
    });
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
