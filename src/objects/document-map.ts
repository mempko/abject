/**
 * DocumentMap - the workspace's maps: small wikis over collections of sources.
 *
 * A map is the organized view of something that can be re-read: a folder of
 * documents in Files, a folder on the host, or a registered external project.
 * Each page summarizes one subject, cites the sources it came from, and links
 * to related pages with `[[Page Name]]`. A map's home page (its index) is the
 * orientation a reader starts from; a project's index is its project map,
 * which ExternalCreator writes and every task in the project reads.
 *
 * This object stores maps and keeps them honest. It writes no pages of its
 * own and makes no LLM calls: Cartographer and ExternalCreator write pages,
 * agents read them (the runtime `recall` verb forwards map reads here), and
 * the person reads and edits them in Files.
 *
 * Storage is the workspace FileSystem, by message: every map is a folder
 * under /maps/<kind>/<slug>/ holding map.json, index.md, pages/ and
 * archive/, each page a markdown file with frontmatter (src/core/map-page.ts).
 * The files are the truth; the in-memory index is rebuilt from them and
 * re-read when a file changes underneath (an edit made in Files).
 *
 * Keeping it honest:
 * - Every cited source carries the fingerprint it had when the page was
 *   written, so `checkDrift` names the pages whose sources moved.
 * - `lint` reports unwritten links (pages still to write), links to archived
 *   pages, orphans, pages that cite nothing, flagged pages, pages edited in
 *   Files, and a map grown too large against its sources.
 * - Writes to an existing page carry the revision they were based on; a
 *   write against an older revision is a conflict, never a silent overwrite.
 *
 * Only built-in objects write (pages ride into prompts); anyone may read.
 * Maps never sync between peers: they describe sources on this machine.
 */

import MiniSearch, { type SearchOptions, type SearchResult } from 'minisearch';
import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { require as precondition, requireNonEmpty, invariant } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';
import {
  BLOAT_RATIO, INDEX_SLUG, INDEX_TITLE, MAPS_ROOT, MAP_KINDS, OUTSIDE_EDIT_SLACK_MS, PAGE_MAX_CHARS, TITLE_MAX_CHARS,
  fingerprintOf, hasCitation, linkKey, mapDir, mapIdOf, pagePath, parsePage, relativeSource, replaceSection,
  serializePage, slugOf, snippetOf, sourcePath, wikiLinks,
  type MapInfo, type MapKind, type MapLayout, type MapPage, type MapSource, type PageSource,
} from '../core/map-page.js';

const log = new Log('DocumentMap');

const DOCUMENT_MAP_INTERFACE = 'abjects:document-map' as InterfaceId;
export const DOCUMENT_MAP_ID = 'abjects:document-map' as AbjectId;

/** A map's files are re-listed at most this often to catch edits made in Files. */
const REFRESH_MS = 3_000;
/** Most results a search or explore returns. */
const MAX_RESULTS = 20;
/** Most sources one page may cite. */
const MAX_SOURCES = 40;
/** Most flags kept on a page. */
const MAX_FLAGS = 5;
/** Parallel stats when checking a map's sources. */
const STAT_BATCH = 16;
/** Words too common to count as a match when scanning long text for pointers. */
const STOPWORDS = new Set(['that', 'this', 'with', 'from', 'have', 'what', 'when', 'will', 'into', 'them', 'they', 'their', 'there', 'about',
  'which', 'would', 'should', 'could', 'make', 'sure', 'also', 'then', 'than', 'your', 'some', 'each', 'only', 'more', 'most', 'other',
  'task', 'goal', 'please', 'find', 'need', 'want', 'like', 'just', 'over', 'were', 'been', 'does', 'done', 'here', 'where', 'while']);

interface PageRecord {
  slug: string;
  page: MapPage;
  /** The file's modification time when last read or written. */
  fileModifiedAt: number;
  /** Modified in Files after DocumentMap last wrote it. */
  editedInFiles: boolean;
}

interface MapRecord {
  info: MapInfo;
  pages: Map<string, PageRecord>;
  /** Archived pages, by slug: titles and aliases only, for telling a broken link from an unwritten one. */
  archived: Map<string, { title: string; aliases: string[] }>;
  refreshedAt: number;
}

interface FileInfo { path: string; name: string; isDirectory: boolean; size: number; modifiedAt: number }

type Reply = Record<string, unknown>;

export class DocumentMap extends Abject {
  private fsId?: AbjectId;
  private hostFsId?: AbjectId;
  private maps = new Map<string, MapRecord>();
  private index = DocumentMap.newIndex();
  private ready?: Promise<void>;
  /** One write at a time per map: a revision check and its write are one step. */
  private locks = new Map<string, Promise<unknown>>();

  constructor() {
    super({
      manifest: {
        name: 'DocumentMap',
        description:
          'The workspace\'s maps: small wikis over collections of sources (a folder of documents in Files, a folder on the host, or a registered external project). ' +
          'Each page summarizes one subject, cites the sources it came from, and links to related pages with [[Page Name]]; a map\'s index page is where a reader starts, and a project\'s index is its project map. ' +
          'Stores pages as markdown files under /maps in Files, searches them, follows their links, and keeps them honest: names pages whose cited sources changed, unwritten and broken links, orphans and uncited pages. ' +
          'Reading is open to every object; pages are written by built-in agents (Cartographer builds maps of documents, ExternalCreator writes project maps).',
        version: '1.0.0',
        icon: '🗺️',
        interface: {
          id: DOCUMENT_MAP_INTERFACE,
          name: 'DocumentMap',
          description: 'Wikis over collections of sources',
          methods: [
            { name: 'listMaps', description: 'Every map in this workspace: id, kind, name, description, source, page count, when its index was written.', parameters: [],
              returns: { kind: 'array', elementType: { kind: 'object' } } },
            { name: 'getMap', description: 'One map: its information (source, layout, size) and a row per page (title, aliases, revision, writer, updatedAt, flagged, editedInFiles).',
              parameters: [{ name: 'map', type: { kind: 'primitive', primitive: 'string' }, description: 'Map id ("documents/contracts", "project/abjects") or a name that names one map' }],
              returns: { kind: 'object' } },
            { name: 'createMap', description: 'Create a map over a source collection. A map with the same kind and name answers with its existing id. Built-in callers only.',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'What the map is called' },
                { name: 'kind', type: { kind: 'primitive', primitive: 'string' }, description: "'documents' (default) or 'project'", optional: true },
                { name: 'source', type: { kind: 'object' }, description: "{ kind: 'workspace' | 'host', root }: a Files folder or an absolute host folder" },
                { name: 'description', type: { kind: 'primitive', primitive: 'string' }, description: 'What the collection is', optional: true },
              ],
              returns: { kind: 'object' } },
            { name: 'deleteMap', description: 'Remove a map and its pages (set aside in Files\' trash). Built-in callers only.',
              parameters: [{ name: 'map', type: { kind: 'primitive', primitive: 'string' }, description: 'Map id or name' }], returns: { kind: 'object' } },
            { name: 'readPage', description: 'Read a page by title, alias or slug ("index" for the home page): body, sources, revision, writer, flags, its links (written and unwritten) and the pages that link to it.',
              parameters: [
                { name: 'map', type: { kind: 'primitive', primitive: 'string' }, description: 'Map id or name' },
                { name: 'page', type: { kind: 'primitive', primitive: 'string' }, description: 'Title, alias or slug' },
              ], returns: { kind: 'object' } },
            { name: 'writePage', description: `Write a page (built-in callers only). An existing page needs expectedRevision, the revision the write is based on; a stale one is a conflict to re-read and merge, never an overwrite. Sources are paths relative to the map's source root; each is fingerprinted so a later change marks the page stale. Body at most ${PAGE_MAX_CHARS} characters; link pages with [[Page Name]], cite with \`path:12-40\`, quote exact words where they matter.`,
              parameters: [
                { name: 'map', type: { kind: 'primitive', primitive: 'string' }, description: 'Map id or name' },
                { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: `Page title ("${INDEX_TITLE}" or "index" for the home page)` },
                { name: 'body', type: { kind: 'primitive', primitive: 'string' }, description: 'Markdown body' },
                { name: 'sources', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Source paths the page rests on', optional: true },
                { name: 'aliases', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Other names the page answers to', optional: true },
                { name: 'expectedRevision', type: { kind: 'primitive', primitive: 'number' }, description: 'Revision this write is based on (required for an existing page)', optional: true },
                { name: 'taskId', type: { kind: 'primitive', primitive: 'string' }, description: 'The writing task, recorded as the page\'s writer', optional: true },
                { name: 'layout', type: { kind: 'object' }, description: 'Index of a project map only: { fileCount, shape } the page was written from', optional: true },
              ], returns: { kind: 'object' } },
            { name: 'editSection', description: 'Replace one `## heading` section of a page (or add it), leaving the rest as it is. Needs expectedRevision. Built-in callers only.',
              parameters: [
                { name: 'map', type: { kind: 'primitive', primitive: 'string' }, description: 'Map id or name' },
                { name: 'page', type: { kind: 'primitive', primitive: 'string' }, description: 'Title, alias or slug' },
                { name: 'heading', type: { kind: 'primitive', primitive: 'string' }, description: 'Section heading' },
                { name: 'text', type: { kind: 'primitive', primitive: 'string' }, description: 'New section text' },
                { name: 'expectedRevision', type: { kind: 'primitive', primitive: 'number' }, description: 'Revision this edit is based on' },
                { name: 'sources', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Sources to add to the page', optional: true },
                { name: 'taskId', type: { kind: 'primitive', primitive: 'string' }, description: 'The writing task', optional: true },
              ], returns: { kind: 'object' } },
            { name: 'renamePage', description: 'Retitle a page; the old title stays as an alias so links to it keep resolving. Built-in callers only.',
              parameters: [
                { name: 'map', type: { kind: 'primitive', primitive: 'string' }, description: 'Map id or name' },
                { name: 'page', type: { kind: 'primitive', primitive: 'string' }, description: 'Current title, alias or slug' },
                { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: 'New title' },
              ], returns: { kind: 'object' } },
            { name: 'archivePage', description: 'Move a page to the map\'s archive (restorable from Files). Links to it then read as broken. Built-in callers only.',
              parameters: [
                { name: 'map', type: { kind: 'primitive', primitive: 'string' }, description: 'Map id or name' },
                { name: 'page', type: { kind: 'primitive', primitive: 'string' }, description: 'Title, alias or slug' },
              ], returns: { kind: 'object' } },
            { name: 'flagPage', description: 'Report that a page misled a reader, with what the sources actually say. Kept on the page until it is rewritten; lint lists it. Built-in callers only.',
              parameters: [
                { name: 'map', type: { kind: 'primitive', primitive: 'string' }, description: 'Map id or name' },
                { name: 'page', type: { kind: 'primitive', primitive: 'string' }, description: 'Title, alias or slug' },
                { name: 'reason', type: { kind: 'primitive', primitive: 'string' }, description: 'What was wrong' },
              ], returns: { kind: 'object' } },
            { name: 'search', description: 'Search page titles, aliases and bodies, in one map or all of them. Returns { map, title, snippet, score } rows.',
              parameters: [
                { name: 'query', type: { kind: 'primitive', primitive: 'string' }, description: 'Keywords' },
                { name: 'minTerms', type: { kind: 'primitive', primitive: 'number' }, description: 'Keep only pages matching at least this many distinct query words (default 1)', optional: true },
                { name: 'exact', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Match whole words only, ignoring short and common ones (for scanning long text)', optional: true },
                { name: 'map', type: { kind: 'primitive', primitive: 'string' }, description: 'Limit to one map', optional: true },
                { name: 'limit', type: { kind: 'primitive', primitive: 'number' }, description: `Most results (default 5, at most ${MAX_RESULTS})`, optional: true },
              ], returns: { kind: 'array', elementType: { kind: 'object' } } },
            { name: 'explore', description: 'Search one map, then follow the links of the matching pages (1 or 2 hops). Each page says whether it matched or which page linked to it.',
              parameters: [
                { name: 'map', type: { kind: 'primitive', primitive: 'string' }, description: 'Map id or name' },
                { name: 'query', type: { kind: 'primitive', primitive: 'string' }, description: 'Keywords' },
                { name: 'limit', type: { kind: 'primitive', primitive: 'number' }, description: 'Matching pages (default 3); links add up to twice as many', optional: true },
                { name: 'hops', type: { kind: 'primitive', primitive: 'number' }, description: 'Link hops (1 or 2, default 1)', optional: true },
              ], returns: { kind: 'object' } },
            { name: 'checkDrift', description: 'Re-read the fingerprints of every source a map cites and name the pages whose sources changed or disappeared.',
              parameters: [{ name: 'map', type: { kind: 'primitive', primitive: 'string' }, description: 'Map id or name' }], returns: { kind: 'object' } },
            { name: 'lint', description: 'What needs attention in a map: unwritten links (pages still to write, with who links to them), links to archived pages, orphans, pages citing nothing, flagged pages, pages edited in Files, and size against the sources. Pass drift: true to include stale pages (reads every source fingerprint).',
              parameters: [
                { name: 'map', type: { kind: 'primitive', primitive: 'string' }, description: 'Map id or name' },
                { name: 'drift', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Also check sources for changes', optional: true },
              ], returns: { kind: 'object' } },
            { name: 'setSourceStats', description: 'Record the size of a map\'s source collection (files and bytes), which the bloat check compares the map against. Built-in callers only.',
              parameters: [
                { name: 'map', type: { kind: 'primitive', primitive: 'string' }, description: 'Map id or name' },
                { name: 'files', type: { kind: 'primitive', primitive: 'number' }, description: 'Source files' },
                { name: 'bytes', type: { kind: 'primitive', primitive: 'number' }, description: 'Source bytes' },
              ], returns: { kind: 'object' } },
          ],
          events: [
            { name: 'mapsChanged', description: 'A map was created or removed', payload: { kind: 'object' } },
            { name: 'pageChanged', description: 'A page was written, renamed, archived or flagged: { map, title, revision }', payload: { kind: 'object' } },
          ],
        },
        tags: ['system', 'knowledge', 'maps'],
      },
    });
    this.setupHandlers();
  }

  private static newIndex(): MiniSearch<{ id: string; map: string; slug: string; title: string; aliases: string; body: string }> {
    return new MiniSearch({
      fields: ['title', 'aliases', 'body'],
      storeFields: ['map', 'slug', 'title'],
      searchOptions: { boost: { title: 4, aliases: 3 }, prefix: true, fuzzy: 0.15, combineWith: 'OR' },
    });
  }

  protected override async onInit(): Promise<void> {
    this.fsId = await this.discoverDep('FileSystem') ?? undefined;
    this.hostFsId = await this.discoverDep('HostFileSystem') ?? undefined;
    // Loading reads every page; handlers wait on it rather than holding up boot.
    this.ready = this.loadAll().catch(err => log.warn(`loading maps failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    for (const [id, m] of this.maps) {
      invariant(m.info.id === id, 'DocumentMap: a map is kept under its own id');
      for (const [slug, p] of m.pages) invariant(p.slug === slug, 'DocumentMap: a page is kept under its own slug');
    }
  }

  protected override askPrompt(question: string): string {
    const maps = [...this.maps.values()].map(m => `- ${m.info.id}: ${m.info.name} (${m.info.kind}, ${m.pages.size} pages; source ${m.info.source.kind} ${m.info.source.root})${m.info.description ? ` - ${m.info.description}` : ''}`);
    return `${super.askPrompt(question)}

## DocumentMap

I keep this workspace's maps: small wikis over collections of sources, stored as markdown under ${MAPS_ROOT} in Files. A page summarizes one subject, cites the sources it came from, and links related pages with [[Page Name]]. A map's index is where a reader starts. A project's index is its project map.

Reading: \`search({ query, map? })\` finds pages, \`readPage({ map, page })\` reads one (with its links and the pages linking to it), \`explore({ map, query })\` finds pages and follows their links. Agents can read the same way through their \`recall\` action with a \`map\` field.
Keeping maps honest: \`checkDrift({ map })\` names pages whose cited sources changed, and \`lint({ map })\` lists unwritten and broken links, orphans, uncited and flagged pages.
Writing is for built-in agents: Cartographer builds and repairs maps of documents (ask it, or start a goal such as "map the documents in /uploads/contracts"); ExternalCreator writes each project's index.

Maps right now:
${maps.join('\n') || '(none yet)'}`;
  }

  // ── Loading ─────────────────────────────────────────────────────────

  private async whenReady(): Promise<void> {
    if (this.ready) await this.ready;
  }

  private async fs<T>(method: string, payload: Record<string, unknown>, timeout = 15_000): Promise<T> {
    precondition(!!this.fsId, 'DocumentMap: the workspace FileSystem is not available');
    return this.request<T>(request(this.id, this.fsId!, method, payload), timeout);
  }

  private async loadAll(): Promise<void> {
    if (!this.fsId || !(await this.fs<boolean>('exists', { path: MAPS_ROOT }))) return;
    for (const kind of MAP_KINDS) {
      const kindDir = `${MAPS_ROOT}/${kind}`;
      if (!(await this.fs<boolean>('exists', { path: kindDir }))) continue;
      for (const entry of await this.fs<FileInfo[]>('readdir', { path: kindDir })) {
        if (!entry.isDirectory) continue;
        await this.loadMap(`${kind}/${entry.name}`).catch(err =>
          log.warn(`map ${kind}/${entry.name} did not load: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    log.info(`loaded ${this.maps.size} map(s), ${[...this.maps.values()].reduce((n, m) => n + m.pages.size, 0)} page(s)`);
    this.checkInvariants();
  }

  private async loadMap(id: string): Promise<MapRecord | undefined> {
    const dir = mapDir(id);
    if (!(await this.fs<boolean>('exists', { path: `${dir}/map.json` }))) return undefined;
    const info = JSON.parse(await this.fs<string>('readFile', { path: `${dir}/map.json` })) as MapInfo;
    const [kind] = id.split('/') as [MapKind];
    const record: MapRecord = { info: { ...info, id, kind }, pages: new Map(), archived: new Map(), refreshedAt: 0 };
    this.maps.set(id, record);
    await this.refresh(record, true);
    return record;
  }

  /**
   * Bring a map's pages in line with its files: read new and changed files,
   * drop deleted ones. Edits made in Files arrive this way.
   */
  private async refresh(record: MapRecord, force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - record.refreshedAt < REFRESH_MS) return;
    record.refreshedAt = now;
    const dir = mapDir(record.info.id);
    const files: Array<{ slug: string; path: string; modifiedAt: number }> = [];
    const index = await this.fs<FileInfo | null>('stat', { path: `${dir}/index.md` });
    if (index && !index.isDirectory) files.push({ slug: INDEX_SLUG, path: index.path, modifiedAt: index.modifiedAt });
    if (await this.fs<boolean>('exists', { path: `${dir}/pages` })) {
      for (const f of await this.fs<FileInfo[]>('readdir', { path: `${dir}/pages` })) {
        if (!f.isDirectory && f.name.endsWith('.md')) files.push({ slug: f.name.slice(0, -3), path: f.path, modifiedAt: f.modifiedAt });
      }
    }
    const present = new Set(files.map(f => f.slug));
    for (const slug of [...record.pages.keys()]) {
      if (!present.has(slug)) { record.pages.delete(slug); this.unindex(record.info.id, slug); }
    }
    for (const f of files) {
      const known = record.pages.get(f.slug);
      if (known && known.fileModifiedAt === f.modifiedAt) continue;
      const page = parsePage(await this.fs<string>('readFile', { path: f.path }), f.slug === INDEX_SLUG ? INDEX_TITLE : f.slug.replace(/-/g, ' '));
      if (f.slug === INDEX_SLUG) page.meta.title = INDEX_TITLE;
      const editedInFiles = f.modifiedAt - page.meta.updatedAt > OUTSIDE_EDIT_SLACK_MS;
      record.pages.set(f.slug, { slug: f.slug, page, fileModifiedAt: f.modifiedAt, editedInFiles });
      this.reindex(record.info.id, f.slug, page);
    }
    record.archived.clear();
    if (await this.fs<boolean>('exists', { path: `${dir}/archive` })) {
      for (const f of await this.fs<FileInfo[]>('readdir', { path: `${dir}/archive` })) {
        if (f.isDirectory || !f.name.endsWith('.md')) continue;
        const page = parsePage(await this.fs<string>('readFile', { path: f.path }), f.name.slice(0, -3));
        record.archived.set(f.name.slice(0, -3), { title: page.meta.title, aliases: page.meta.aliases });
      }
    }
  }

  private reindex(mapId: string, slug: string, page: MapPage): void {
    const id = `${mapId}#${slug}`;
    if (this.index.has(id)) this.index.discard(id);
    this.index.add({ id, map: mapId, slug, title: page.meta.title, aliases: page.meta.aliases.join(' '), body: page.body });
  }

  private unindex(mapId: string, slug: string): void {
    const id = `${mapId}#${slug}`;
    if (this.index.has(id)) this.index.discard(id);
  }

  // ── Resolution ──────────────────────────────────────────────────────

  /** A map by id, or by a name or slug that names exactly one map. */
  private async resolveMap(ref: unknown): Promise<MapRecord> {
    await this.whenReady();
    precondition(typeof ref === 'string' && ref.trim() !== '', 'map is required');
    const key = (ref as string).trim();
    const direct = this.maps.get(key);
    const found = direct ?? (() => {
      const want = linkKey(key.includes('/') ? key.split('/').slice(1).join('/') : key);
      const hits = [...this.maps.values()].filter(m => linkKey(m.info.name) === want || linkKey(m.info.id.split('/')[1]) === want);
      precondition(hits.length < 2, `"${key}" names several maps (${hits.map(h => h.info.id).join(', ')}); use the map id`);
      return hits[0];
    })();
    precondition(!!found, `No map "${key}". Maps: ${[...this.maps.keys()].join(', ') || '(none)'}`);
    await this.refresh(found!);
    return found!;
  }

  /** A page of a map by slug, title or alias. */
  private findPage(record: MapRecord, name: string): PageRecord | undefined {
    const raw = name.trim();
    if (raw === INDEX_SLUG || linkKey(raw) === linkKey(INDEX_TITLE)) return record.pages.get(INDEX_SLUG);
    const bySlug = record.pages.get(raw) ?? record.pages.get(slugOf(raw));
    if (bySlug) return bySlug;
    const key = linkKey(raw);
    for (const p of record.pages.values()) {
      if (linkKey(p.page.meta.title) === key || p.page.meta.aliases.some(a => linkKey(a) === key)) return p;
    }
    return undefined;
  }

  private requirePage(record: MapRecord, name: unknown): PageRecord {
    precondition(typeof name === 'string' && name.trim() !== '', 'page is required');
    const page = this.findPage(record, name as string);
    precondition(!!page, `No page "${name}" in ${record.info.id}`);
    return page!;
  }

  private isArchivedName(record: MapRecord, name: string): boolean {
    const key = linkKey(name);
    for (const a of record.archived.values()) if (linkKey(a.title) === key || a.aliases.some(x => linkKey(x) === key)) return true;
    return false;
  }

  /** Every page's outgoing links, resolved: who links where, and which names have no page. */
  private linkGraph(record: MapRecord): { out: Map<string, string[]>; inbound: Map<string, string[]>; unwritten: Map<string, string[]>; broken: Map<string, string[]> } {
    const out = new Map<string, string[]>(), inbound = new Map<string, string[]>();
    const unwritten = new Map<string, string[]>(), broken = new Map<string, string[]>();
    for (const p of record.pages.values()) {
      const targets: string[] = [];
      for (const name of wikiLinks(p.page.body)) {
        const target = this.findPage(record, name);
        if (target) {
          if (target.slug === p.slug) continue;
          targets.push(target.slug);
          inbound.set(target.slug, [...(inbound.get(target.slug) ?? []), p.page.meta.title]);
        } else {
          const bucket = this.isArchivedName(record, name) ? broken : unwritten;
          bucket.set(name, [...(bucket.get(name) ?? []), p.page.meta.title]);
        }
      }
      out.set(p.slug, targets);
    }
    return { out, inbound, unwritten, broken };
  }

  // ── Writing ─────────────────────────────────────────────────────────

  private async requireWriter(msg: AbjectMessage): Promise<void> {
    precondition(await this.isBuiltInCaller(msg.routing.from), 'Maps are written by built-in agents; any object may read them');
  }

  private async writerName(msg: AbjectMessage, taskId: unknown): Promise<string> {
    const name = await this.resolveCallerName(msg.routing.from) ?? 'unknown';
    return typeof taskId === 'string' && taskId.trim() ? `${name} (${taskId.trim().slice(0, 80)})` : name;
  }

  /** Run one change to a map after the ones before it. */
  private serial<T>(mapId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(mapId) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    this.locks.set(mapId, run.catch(() => undefined));
    return run;
  }

  /** Fingerprint each source by asking whoever holds it: Files for a workspace source, HostFileSystem for a host one. */
  private async fingerprints(source: MapSource, paths: string[]): Promise<Map<string, string | undefined>> {
    const out = new Map<string, string | undefined>();
    const unique = [...new Set(paths)];
    for (let i = 0; i < unique.length; i += STAT_BATCH) {
      const batch = unique.slice(i, i + STAT_BATCH);
      const stats = await Promise.all(batch.map(rel => this.statSource(source, rel)));
      batch.forEach((rel, j) => out.set(rel, stats[j]));
    }
    return out;
  }

  private async statSource(source: MapSource, rel: string): Promise<string | undefined> {
    const full = sourcePath(source.root, rel);
    try {
      if (source.kind === 'workspace') return fingerprintOf(await this.fs<FileInfo | null>('stat', { path: full }));
      if (!this.hostFsId) return undefined;
      return fingerprintOf(await this.request<FileInfo | null>(request(this.id, this.hostFsId, 'stat', { path: full }), 30_000));
    } catch {
      return undefined;
    }
  }

  private async pageSources(record: MapRecord, raw: unknown): Promise<PageSource[]> {
    const paths = (Array.isArray(raw) ? raw : [])
      .map(s => (typeof s === 'string' ? s : s && typeof s === 'object' && typeof (s as PageSource).path === 'string' ? (s as PageSource).path : ''))
      .map(s => relativeSource(s, record.info.source.root)).filter(Boolean);
    precondition(paths.length <= MAX_SOURCES, `A page cites at most ${MAX_SOURCES} sources; split the page`);
    const fps = await this.fingerprints(record.info.source, paths);
    return [...new Set(paths)].map(path => ({ path, ...(fps.get(path) ? { fp: fps.get(path) } : {}) }));
  }

  private async persistPage(record: MapRecord, slug: string, page: MapPage): Promise<PageRecord> {
    page.meta.updatedAt = Date.now();
    const path = pagePath(record.info.id, slug);
    await this.fs('writeFile', { path, content: serializePage(page) });
    const info = await this.fs<FileInfo | null>('stat', { path });
    const rec: PageRecord = { slug, page, fileModifiedAt: info?.modifiedAt ?? page.meta.updatedAt, editedInFiles: false };
    record.pages.set(slug, rec);
    this.reindex(record.info.id, slug, page);
    this.changed('pageChanged', { map: record.info.id, title: page.meta.title, revision: page.meta.revision });
    return rec;
  }

  private async writeInfo(record: MapRecord): Promise<void> {
    await this.fs('writeFile', { path: `${mapDir(record.info.id)}/map.json`, content: JSON.stringify(record.info, null, 2) });
  }

  private conflict(rec: PageRecord, expected: unknown): Reply | undefined {
    if (expected === rec.page.meta.revision) return undefined;
    return {
      success: false, conflict: true, revision: rec.page.meta.revision, writer: rec.page.meta.writer,
      error: expected === undefined
        ? `"${rec.page.meta.title}" exists (revision ${rec.page.meta.revision}); read it and write with expectedRevision ${rec.page.meta.revision}`
        : `"${rec.page.meta.title}" is at revision ${rec.page.meta.revision}, not ${expected}; read it again and merge your change into what is there`,
    };
  }

  private pageRow(record: MapRecord, p: PageRecord): Reply {
    return {
      title: p.page.meta.title, slug: p.slug, aliases: p.page.meta.aliases, revision: p.page.meta.revision,
      writer: p.page.meta.writer, updatedAt: p.page.meta.updatedAt, chars: p.page.body.length,
      sources: p.page.meta.sources.length, flagged: p.page.meta.flags.length > 0, editedInFiles: p.editedInFiles,
      path: pagePath(record.info.id, p.slug),
    };
  }

  private mapRow(m: MapRecord): Reply {
    return {
      id: m.info.id, kind: m.info.kind, name: m.info.name, description: m.info.description ?? '', source: m.info.source,
      pages: m.pages.size, hasIndex: m.pages.has(INDEX_SLUG), builtAt: m.info.builtAt ?? null, folder: mapDir(m.info.id),
    };
  }

  // ── Handlers ────────────────────────────────────────────────────────

  private setupHandlers(): void {
    this.on('listMaps', async () => {
      await this.whenReady();
      return [...this.maps.values()].map(m => this.mapRow(m));
    });

    this.on('getMap', async (msg: AbjectMessage) => {
      const record = await this.resolveMap((msg.payload as { map?: string }).map);
      const pages = [...record.pages.values()].sort((a, b) => (a.slug === INDEX_SLUG ? -1 : b.slug === INDEX_SLUG ? 1 : a.page.meta.title.localeCompare(b.page.meta.title)));
      const mapChars = pages.reduce((n, p) => n + p.page.body.length, 0);
      return { ...this.mapRow(record), info: record.info, mapChars, pages: pages.map(p => this.pageRow(record, p)), archived: [...record.archived.values()].map(a => a.title) };
    });

    this.on('createMap', async (msg: AbjectMessage) => {
      await this.requireWriter(msg);
      await this.whenReady();
      const { name, kind = 'documents', source, description } = msg.payload as { name: string; kind?: MapKind; source: MapSource; description?: string };
      requireNonEmpty(name, 'name');
      precondition(MAP_KINDS.includes(kind), `kind must be one of ${MAP_KINDS.join(', ')}`);
      precondition(!!source && (source.kind === 'workspace' || source.kind === 'host') && typeof source.root === 'string' && source.root.trim() !== '',
        "source must be { kind: 'workspace' | 'host', root }");
      precondition(source.kind === 'workspace' || source.root.startsWith('/') || /^[A-Za-z]:[\\/]/.test(source.root) || source.root.startsWith('~'),
        'A host source root is an absolute path');
      const id = mapIdOf(kind, name);
      // A host root is kept as the host resolves it (`~` expanded), so the
      // paths its listings return line up with the root.
      if (source.kind === 'host' && this.hostFsId) {
        const resolved = await this.request<FileInfo | null>(request(this.id, this.hostFsId, 'stat', { path: source.root.trim() }), 30_000).catch(() => null);
        precondition(!resolved || resolved.isDirectory, `${source.root} is a file; a map's source is a folder`);
        if (resolved?.path) source.root = resolved.path;
      } else if (source.kind === 'workspace') {
        const st = await this.fs<FileInfo | null>('stat', { path: source.root.trim() });
        precondition(!!st?.isDirectory, `${source.root} is not a folder in Files`);
        source.root = st!.path;
      }
      return this.serial(id, async () => {
        const existing = this.maps.get(id);
        if (existing) {
          if (existing.info.source.root !== source.root || existing.info.source.kind !== source.kind) {
            existing.info.source = { kind: source.kind, root: source.root.trim() };
            await this.writeInfo(existing);
          }
          return { success: true, id, existed: true };
        }
        const record: MapRecord = {
          info: { id, kind, name: name.trim().slice(0, TITLE_MAX_CHARS), ...(description ? { description: String(description).slice(0, 1000) } : {}),
            source: { kind: source.kind, root: source.root.trim() }, createdAt: Date.now() },
          pages: new Map(), archived: new Map(), refreshedAt: Date.now(),
        };
        await this.writeInfo(record);
        this.maps.set(id, record);
        this.changed('mapsChanged', { maps: [...this.maps.keys()] });
        log.info(`created map ${id} over ${source.kind}:${source.root}`);
        this.checkInvariants();
        return { success: true, id, folder: mapDir(id) };
      });
    });

    this.on('deleteMap', async (msg: AbjectMessage) => {
      await this.requireWriter(msg);
      const record = await this.resolveMap((msg.payload as { map?: string }).map);
      const id = record.info.id;
      return this.serial(id, async () => {
        await this.fs('remove', { path: mapDir(id) });
        for (const slug of record.pages.keys()) this.unindex(id, slug);
        this.maps.delete(id);
        this.changed('mapsChanged', { maps: [...this.maps.keys()] });
        log.info(`removed map ${id}`);
        return { success: true };
      });
    });

    this.on('readPage', async (msg: AbjectMessage) => {
      const { map, page } = msg.payload as { map: string; page: string };
      const record = await this.resolveMap(map);
      const p = this.findPage(record, String(page ?? ''));
      if (!p) {
        const near = this.index.search(String(page ?? ''), { filter: r => r.map === record.info.id }).slice(0, 5).map(r => r.title as string);
        return { found: false, error: `No page "${page}" in ${record.info.id}`, ...(near.length ? { similar: near } : {}) };
      }
      const graph = this.linkGraph(record);
      const links = wikiLinks(p.page.body);
      return {
        found: true, map: record.info.id, ...this.pageRow(record, p), body: p.page.body,
        sources: p.page.meta.sources, flags: p.page.meta.flags, sourceRoot: record.info.source,
        links: links.filter(l => this.findPage(record, l)), unwrittenLinks: links.filter(l => !this.findPage(record, l)),
        linkedFrom: graph.inbound.get(p.slug) ?? [],
      };
    });

    this.on('writePage', async (msg: AbjectMessage) => {
      await this.requireWriter(msg);
      const { map, title, body, sources, aliases, expectedRevision, taskId, layout } = msg.payload as {
        map: string; title: string; body: string; sources?: unknown; aliases?: unknown; expectedRevision?: number; taskId?: string; layout?: MapLayout;
      };
      requireNonEmpty(title, 'title');
      precondition(typeof body === 'string' && body.trim() !== '', 'body must not be empty');
      precondition(body.length <= PAGE_MAX_CHARS, `A page body holds at most ${PAGE_MAX_CHARS} characters (this one has ${body.length}): summarize and link to further pages`);
      const record = await this.resolveMap(map);
      const writer = await this.writerName(msg, taskId);
      return this.serial(record.info.id, async () => {
        await this.refresh(record, true);
        const isIndex = title.trim() === INDEX_SLUG || linkKey(title) === linkKey(INDEX_TITLE);
        const existing = isIndex ? record.pages.get(INDEX_SLUG) : this.findPage(record, title);
        if (existing) { const c = this.conflict(existing, expectedRevision); if (c) return c; }
        const slug = existing?.slug ?? (isIndex ? INDEX_SLUG : this.freeSlug(record, title));
        const cleanAliases = Array.isArray(aliases)
          ? [...new Set(aliases.filter((a): a is string => typeof a === 'string' && a.trim() !== '').map(a => a.trim().slice(0, TITLE_MAX_CHARS)))]
          : existing?.page.meta.aliases ?? [];
        const page: MapPage = {
          meta: {
            title: isIndex ? INDEX_TITLE : (existing?.page.meta.title ?? title.trim().slice(0, TITLE_MAX_CHARS)),
            aliases: cleanAliases,
            sources: sources !== undefined ? await this.pageSources(record, sources) : existing?.page.meta.sources ?? [],
            writer, revision: (existing?.page.meta.revision ?? 0) + 1, updatedAt: 0,
            // A rewrite answers the flags raised against the old text.
            flags: [],
          },
          body: body.trim(),
        };
        const rec = await this.persistPage(record, slug, page);
        if (isIndex) {
          record.info.builtAt = page.meta.updatedAt;
          if (layout && typeof layout.fileCount === 'number' && layout.shape && typeof layout.shape === 'object') {
            record.info.layout = { fileCount: layout.fileCount, shape: Object.fromEntries(Object.entries(layout.shape).filter(([, v]) => typeof v === 'number')) };
          }
          await this.writeInfo(record);
        }
        log.info(`${existing ? 'revised' : 'wrote'} ${record.info.id} / ${page.meta.title} (r${page.meta.revision}, ${page.body.length} chars) by ${writer}`);
        const unwritten = wikiLinks(page.body).filter(l => !this.findPage(record, l));
        return { success: true, map: record.info.id, title: page.meta.title, revision: page.meta.revision, path: pagePath(record.info.id, rec.slug),
          ...(unwritten.length ? { unwrittenLinks: unwritten } : {}),
          ...(page.meta.sources.some(s => !s.fp) ? { unreadSources: page.meta.sources.filter(s => !s.fp).map(s => s.path) } : {}) };
      });
    });

    this.on('editSection', async (msg: AbjectMessage) => {
      await this.requireWriter(msg);
      const { map, page, heading, text, expectedRevision, sources, taskId } = msg.payload as {
        map: string; page: string; heading: string; text: string; expectedRevision?: number; sources?: unknown; taskId?: string;
      };
      requireNonEmpty(heading, 'heading');
      precondition(typeof text === 'string', 'text must be a string');
      const record = await this.resolveMap(map);
      const writer = await this.writerName(msg, taskId);
      return this.serial(record.info.id, async () => {
        await this.refresh(record, true);
        const rec = this.requirePage(record, page);
        const c = this.conflict(rec, expectedRevision); if (c) return c;
        const body = replaceSection(rec.page.body, heading, text);
        precondition(body.length <= PAGE_MAX_CHARS, `The page would hold ${body.length} characters, past ${PAGE_MAX_CHARS}: move detail to its own page and link it`);
        const added = sources !== undefined ? await this.pageSources(record, sources) : [];
        const merged = [...rec.page.meta.sources.filter(s => !added.some(a => a.path === s.path)), ...added];
        const next: MapPage = { meta: { ...rec.page.meta, sources: merged, writer, revision: rec.page.meta.revision + 1, flags: [] }, body };
        await this.persistPage(record, rec.slug, next);
        return { success: true, map: record.info.id, title: next.meta.title, revision: next.meta.revision };
      });
    });

    this.on('renamePage', async (msg: AbjectMessage) => {
      await this.requireWriter(msg);
      const { map, page, title } = msg.payload as { map: string; page: string; title: string };
      requireNonEmpty(title, 'title');
      const record = await this.resolveMap(map);
      return this.serial(record.info.id, async () => {
        const rec = this.requirePage(record, page);
        precondition(rec.slug !== INDEX_SLUG, 'The index keeps its title');
        const clash = this.findPage(record, title);
        precondition(!clash || clash.slug === rec.slug, `"${title}" is already a page in ${record.info.id}`);
        const old = rec.page.meta.title;
        const slug = this.freeSlug(record, title, rec.slug);
        const next: MapPage = { meta: { ...rec.page.meta, title: title.trim().slice(0, TITLE_MAX_CHARS),
          aliases: [...new Set([...rec.page.meta.aliases, old])].filter(a => linkKey(a) !== linkKey(title)), revision: rec.page.meta.revision + 1 }, body: rec.page.body };
        if (slug !== rec.slug) {
          await this.fs('rename', { from: pagePath(record.info.id, rec.slug), to: pagePath(record.info.id, slug) });
          record.pages.delete(rec.slug);
          this.unindex(record.info.id, rec.slug);
        }
        await this.persistPage(record, slug, next);
        return { success: true, title: next.meta.title, aliases: next.meta.aliases, revision: next.meta.revision };
      });
    });

    this.on('archivePage', async (msg: AbjectMessage) => {
      await this.requireWriter(msg);
      const { map, page } = msg.payload as { map: string; page: string };
      const record = await this.resolveMap(map);
      return this.serial(record.info.id, async () => {
        const rec = this.requirePage(record, page);
        await this.fs('rename', { from: pagePath(record.info.id, rec.slug), to: pagePath(record.info.id, rec.slug, true) });
        record.pages.delete(rec.slug);
        record.archived.set(rec.slug, { title: rec.page.meta.title, aliases: rec.page.meta.aliases });
        this.unindex(record.info.id, rec.slug);
        this.changed('pageChanged', { map: record.info.id, title: rec.page.meta.title, archived: true });
        return { success: true };
      });
    });

    this.on('flagPage', async (msg: AbjectMessage) => {
      await this.requireWriter(msg);
      const { map, page, reason } = msg.payload as { map: string; page: string; reason: string };
      requireNonEmpty(reason, 'reason');
      const record = await this.resolveMap(map);
      const by = await this.resolveCallerName(msg.routing.from) ?? 'unknown';
      return this.serial(record.info.id, async () => {
        const rec = this.requirePage(record, page);
        const flags = [...rec.page.meta.flags, { reason: reason.trim().slice(0, 600), by, at: Date.now() }].slice(-MAX_FLAGS);
        // A flag changes no claim: the revision stays, so a writer's expectedRevision still holds.
        await this.persistPage(record, rec.slug, { meta: { ...rec.page.meta, flags }, body: rec.page.body });
        return { success: true, flags: flags.length };
      });
    });

    this.on('search', async (msg: AbjectMessage) => {
      await this.whenReady();
      const { query, map, limit, minTerms, exact } = msg.payload as { query: string; map?: string; limit?: number; minTerms?: number; exact?: boolean };
      requireNonEmpty(query, 'query');
      const only = map ? (await this.resolveMap(map)).info.id : undefined;
      if (!only) for (const m of this.maps.values()) await this.refresh(m);
      const max = Math.max(1, Math.min(MAX_RESULTS, Number(limit) || 5));
      // A caller scanning long text for pointers (a task description) asks
      // for exact words and several of them in common, so one shared common
      // word is not a match.
      const atLeast = Math.max(1, Math.min(5, Number(minTerms) || 1));
      const options: SearchOptions = { ...(only ? { filter: (r: SearchResult) => r.map === only } : {}), ...(exact ? { prefix: false, fuzzy: false } : {}) };
      const words = exact ? query.split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 3 && !STOPWORDS.has(w.toLowerCase())).join(' ') : query;
      if (!words.trim()) return [];
      return this.index.search(words, options).filter(r => new Set(r.terms).size >= atLeast).slice(0, max).map(r => {
        const rec = this.maps.get(r.map as string)?.pages.get(r.slug as string);
        return { map: r.map, title: r.title, score: Math.round(r.score * 100) / 100, snippet: rec ? snippetOf(rec.page.body, query) : '' };
      });
    });

    this.on('explore', async (msg: AbjectMessage) => {
      const { map, query, limit, hops } = msg.payload as { map: string; query: string; limit?: number; hops?: number };
      requireNonEmpty(query, 'query');
      const record = await this.resolveMap(map);
      const max = Math.max(1, Math.min(8, Number(limit) || 3));
      const depth = Math.max(1, Math.min(2, Number(hops) || 1));
      const graph = this.linkGraph(record);
      const seen = new Map<string, string>();
      for (const r of this.index.search(query, { filter: x => x.map === record.info.id }).slice(0, max)) seen.set(r.slug as string, 'matched');
      let frontier = [...seen.keys()];
      for (let h = 0; h < depth && seen.size < max * 3; h++) {
        const next: string[] = [];
        for (const slug of frontier) {
          for (const target of graph.out.get(slug) ?? []) {
            if (seen.has(target) || seen.size >= max * 3) continue;
            seen.set(target, `linked-from: ${record.pages.get(slug)?.page.meta.title ?? slug}`);
            next.push(target);
          }
        }
        frontier = next;
      }
      const pages = [...seen.entries()].map(([slug, via]) => {
        const p = record.pages.get(slug)!;
        return { title: p.page.meta.title, via, revision: p.page.meta.revision, body: p.page.body, flagged: p.page.meta.flags.length > 0 };
      });
      const unwritten = [...graph.unwritten.entries()].filter(([, from]) => pages.some(p => from.includes(p.title))).map(([name]) => name);
      return { map: record.info.id, pages, unwritten };
    });

    this.on('checkDrift', async (msg: AbjectMessage) => {
      const record = await this.resolveMap((msg.payload as { map?: string }).map);
      return this.drift(record);
    });

    this.on('lint', async (msg: AbjectMessage) => {
      const { map, drift } = msg.payload as { map: string; drift?: boolean };
      const record = await this.resolveMap(map);
      const graph = this.linkGraph(record);
      const pages = [...record.pages.values()];
      const mapChars = pages.reduce((n, p) => n + p.page.body.length, 0);
      const ratio = record.info.sourceBytes ? mapChars / record.info.sourceBytes : undefined;
      const orphans = pages.filter(p => p.slug !== INDEX_SLUG && !(graph.inbound.get(p.slug)?.length)).map(p => p.page.meta.title);
      return {
        map: record.info.id,
        pages: pages.length,
        hasIndex: record.pages.has(INDEX_SLUG),
        unwritten: [...graph.unwritten.entries()].map(([name, linkedFrom]) => ({ name, linkedFrom })),
        broken: [...graph.broken.entries()].map(([name, linkedFrom]) => ({ name, linkedFrom })),
        orphans,
        uncited: pages.filter(p => p.slug !== INDEX_SLUG && !p.page.meta.sources.length && !hasCitation(p.page.body)).map(p => p.page.meta.title),
        flagged: pages.filter(p => p.page.meta.flags.length).map(p => ({ title: p.page.meta.title, flags: p.page.meta.flags })),
        editedInFiles: pages.filter(p => p.editedInFiles).map(p => p.page.meta.title),
        size: { mapChars, sourceBytes: record.info.sourceBytes ?? null, ratio: ratio === undefined ? null : Math.round(ratio * 1000) / 1000,
          bloated: ratio !== undefined && ratio > BLOAT_RATIO },
        ...(drift ? { drift: await this.drift(record) } : {}),
      };
    });

    this.on('setSourceStats', async (msg: AbjectMessage) => {
      await this.requireWriter(msg);
      const { map, files, bytes } = msg.payload as { map: string; files: number; bytes: number };
      precondition(Number.isFinite(files) && files >= 0 && Number.isFinite(bytes) && bytes >= 0, 'files and bytes are non-negative numbers');
      const record = await this.resolveMap(map);
      return this.serial(record.info.id, async () => {
        record.info.sourceFiles = Math.floor(files);
        record.info.sourceBytes = Math.floor(bytes);
        await this.writeInfo(record);
        return { success: true };
      });
    });
  }

  /** The pages whose cited sources changed or went missing since each page was written. */
  private async drift(record: MapRecord): Promise<Reply> {
    const pages = [...record.pages.values()];
    const fps = await this.fingerprints(record.info.source, pages.flatMap(p => p.page.meta.sources.map(s => s.path)));
    const stale = pages.flatMap(p => {
      const changed = p.page.meta.sources.filter(s => s.fp && fps.get(s.path) && fps.get(s.path) !== s.fp).map(s => s.path);
      const missing = p.page.meta.sources.filter(s => fps.get(s.path) === undefined).map(s => s.path);
      return changed.length || missing.length ? [{ title: p.page.meta.title, revision: p.page.meta.revision, changed, missing }] : [];
    });
    return { map: record.info.id, checkedSources: fps.size, stale };
  }

  /** A slug for a new title that no other page holds. */
  private freeSlug(record: MapRecord, title: string, own?: string): string {
    const base = slugOf(title) === INDEX_SLUG ? 'index-page' : slugOf(title);
    let slug = base;
    for (let i = 2; (record.pages.has(slug) && slug !== own) || record.archived.has(slug); i++) slug = `${base}-${i}`;
    return slug;
  }
}
