/**
 * The page format of a document map (DocumentMap, src/objects/document-map.ts).
 *
 * A map is a small wiki over a collection of sources: a folder of documents
 * in the workspace's Files, a folder on the host, or a registered project.
 * Each page is one markdown file with a YAML frontmatter block, stored in the
 * workspace FileSystem under /maps/<kind>/<slug>/, so a person can read and
 * edit it in Files like any other document.
 *
 * A page says what its sources say. Its truth is tested by re-reading the
 * sources it cites, which is why each cited source carries the fingerprint it
 * had when the page was written: a page whose sources moved is stale, and the
 * rest of the map is not. (KnowledgeBase entries are the other kind of
 * memory: what was learned from experience, tested by predictions.)
 *
 * Links are written `[[Page Name]]` (or `[[Page Name|shown text]]`) and
 * resolve the way pattern links do: by normalized title or alias, so a link
 * to a page nobody has written yet marks a gap rather than an error.
 *
 * Pure functions only: no messaging here.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** What a map describes: a registered external project, or any collection of documents. */
export type MapKind = 'project' | 'documents';
export const MAP_KINDS: readonly MapKind[] = ['project', 'documents'];

/** Where a map's sources live: the workspace's Files, or a directory on the host. */
export interface MapSource {
  kind: 'workspace' | 'host';
  /** A Files path (`/uploads/contracts`) or an absolute host path. */
  root: string;
}

/**
 * A project's layout when its index page was written: how many files, and
 * how many per directory two levels deep (project-map.ts `shapeOf`). Drift
 * from it says the orientation page needs rewriting.
 */
export interface MapLayout {
  fileCount: number;
  shape: Record<string, number>;
}

/** map.json: what a map is about and where its sources live. */
export interface MapInfo {
  /** `<kind>/<slug>`; also the folder under /maps. */
  id: string;
  kind: MapKind;
  name: string;
  description?: string;
  source: MapSource;
  createdAt: number;
  /** When the index page was last written. */
  builtAt?: number;
  /** Project maps: the layout the index was written from. */
  layout?: MapLayout;
  /** Size of the source collection, as the writer measured it (files and bytes): the bloat check compares the map against it. */
  sourceFiles?: number;
  sourceBytes?: number;
}

/** One cited source of a page, with the fingerprint it had when the page was written. */
export interface PageSource {
  /** Relative to the map's source root. */
  path: string;
  /** `size:modifiedAt` when the page was written; absent when the source could not be read. */
  fp?: string;
}

/** A reader's report that a page misled: kept until the page is rewritten. */
export interface PageFlag {
  reason: string;
  by: string;
  at: number;
}

export interface PageMeta {
  title: string;
  aliases: string[];
  sources: PageSource[];
  /** Who last wrote the page through DocumentMap: an object name, with its task when one was given. */
  writer: string;
  revision: number;
  /** When DocumentMap last wrote the file. A file modified well after this was edited in Files. */
  updatedAt: number;
  flags: PageFlag[];
}

export interface MapPage {
  meta: PageMeta;
  body: string;
}

/** The reserved slug and title of a map's home page, kept at the map's root as index.md. */
export const INDEX_SLUG = 'index';
export const INDEX_TITLE = 'Index';

/** Root folder of every map in a workspace's Files. */
export const MAPS_ROOT = '/maps';
/** Longest page body DocumentMap stores: a page summarizes and points, it does not copy. */
export const PAGE_MAX_CHARS = 16_000;
/** Longest title. */
export const TITLE_MAX_CHARS = 120;
/** A map larger than this share of its sources is copying them rather than abstracting. */
export const BLOAT_RATIO = 0.5;
/** Slack between DocumentMap's own write stamp and the file's modification time. */
export const OUTSIDE_EDIT_SLACK_MS = 5_000;

/** How link names and titles compare: lowercase letters and digits, single spaces. */
export function linkKey(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** A file and folder name for a title: lowercase, dashes, bounded. */
export function slugOf(name: string): string {
  const slug = linkKey(name).replace(/ /g, '-').slice(0, 80).replace(/-+$/, '');
  return slug || 'page';
}

/** A map's id from its kind and name. */
export function mapIdOf(kind: MapKind, name: string): string {
  return `${kind}/${slugOf(name)}`;
}

/** The folder holding a map. */
export function mapDir(id: string): string {
  return `${MAPS_ROOT}/${id}`;
}

/** Where a page's file lives: the index at the map's root, other pages under pages/, archived ones under archive/. */
export function pagePath(mapId: string, slug: string, archived = false): string {
  if (slug === INDEX_SLUG && !archived) return `${mapDir(mapId)}/index.md`;
  return `${mapDir(mapId)}/${archived ? 'archive' : 'pages'}/${slug}.md`;
}

/** The fingerprint of a source as a stat reports it. */
export function fingerprintOf(info: { size?: number; modifiedAt?: number } | null | undefined): string | undefined {
  if (!info || typeof info.size !== 'number' || typeof info.modifiedAt !== 'number') return undefined;
  return `${info.size}:${Math.floor(info.modifiedAt)}`;
}

/** The link names a page body uses, in order, de-duplicated by link key. */
export function wikiLinks(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(/\[\[([^\]|\n]{1,160})(?:\|[^\]\n]*)?\]\]/g)) {
    const name = m[1].trim();
    const key = linkKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Whether a body cites anything: a `path` or `path:12-40` reference in backticks, or a quoted passage. */
export function hasCitation(body: string): boolean {
  return /`[^`\n]*[/.][^`\n]*`/.test(body) || /^>\s/m.test(body);
}

/** A source path relative to the map root, normalized: no leading slash or `./`, forward slashes. */
export function relativeSource(path: string, root: string): string {
  let p = path.trim().replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (r && (p === r || p.startsWith(`${r}/`))) p = p.slice(r.length);
  return p.replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/:\d+(-\d+)?$/, '');
}

/** Join a map root and a relative source path. */
export function sourcePath(root: string, rel: string): string {
  return `${root.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}`;
}

function strings(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map(v => v.trim().slice(0, max));
}

/**
 * Read a page file. A file without frontmatter (written by hand in Files) is
 * still a page: its first `# heading` or the fallback title names it.
 */
export function parsePage(text: string, fallbackTitle: string): MapPage {
  let body = text;
  let raw: Record<string, unknown> = {};
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    try {
      const parsed = parseYaml(fm[1]) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
    } catch { /* malformed frontmatter: read the file as body */ }
    body = text.slice(fm[0].length);
  }
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const title = (typeof raw.title === 'string' && raw.title.trim()) || heading || fallbackTitle;
  const sources: PageSource[] = Array.isArray(raw.sources)
    ? raw.sources.flatMap((s): PageSource[] => {
      if (typeof s === 'string' && s.trim()) return [{ path: s.trim() }];
      if (s && typeof s === 'object' && typeof (s as PageSource).path === 'string') {
        const fp = (s as PageSource).fp;
        return [{ path: (s as PageSource).path.trim(), ...(typeof fp === 'string' ? { fp } : {}) }];
      }
      return [];
    })
    : [];
  const flags: PageFlag[] = Array.isArray(raw.flags)
    ? raw.flags.flatMap((f): PageFlag[] => f && typeof f === 'object' && typeof (f as PageFlag).reason === 'string'
      ? [{ reason: (f as PageFlag).reason, by: String((f as PageFlag).by ?? ''), at: Number((f as PageFlag).at) || 0 }] : [])
    : [];
  return {
    meta: {
      title: title.slice(0, TITLE_MAX_CHARS),
      aliases: strings(raw.aliases, TITLE_MAX_CHARS),
      sources,
      writer: typeof raw.writer === 'string' ? raw.writer : '',
      revision: Number.isSafeInteger(raw.revision) && (raw.revision as number) > 0 ? raw.revision as number : 1,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
      flags,
    },
    body: body.replace(/^\s+/, ''),
  };
}

/** Write a page file: frontmatter, then the body. */
export function serializePage(page: MapPage): string {
  const { meta } = page;
  const front: Record<string, unknown> = { title: meta.title };
  if (meta.aliases.length) front.aliases = meta.aliases;
  if (meta.sources.length) front.sources = meta.sources.map(s => (s.fp ? { path: s.path, fp: s.fp } : { path: s.path }));
  front.writer = meta.writer;
  front.revision = meta.revision;
  front.updatedAt = meta.updatedAt;
  if (meta.flags.length) front.flags = meta.flags;
  return `---\n${stringifyYaml(front).trimEnd()}\n---\n\n${page.body.trim()}\n`;
}

/** Replace the section under `## heading` (to the next heading of the same or higher level), or append it. */
export function replaceSection(body: string, heading: string, text: string): string {
  const lines = body.split('\n');
  const key = linkKey(heading);
  const start = lines.findIndex(l => /^##\s+/.test(l) && linkKey(l.replace(/^##\s+/, '')) === key);
  const section = [`## ${heading.trim()}`, '', text.trim(), ''];
  if (start < 0) return `${body.trimEnd()}\n\n${section.join('\n')}`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^#{1,2}\s+/.test(lines[i])) { end = i; break; }
  return [...lines.slice(0, start), ...section, ...lines.slice(end)].join('\n').trimEnd() + '\n';
}

/** A plain-text excerpt around the first query term, for search results. */
export function snippetOf(body: string, query: string, width = 200): string {
  const text = body.replace(/^---[\s\S]*?---/, '').replace(/\s+/g, ' ').trim();
  const terms = linkKey(query).split(' ').filter(t => t.length > 2);
  const lower = text.toLowerCase();
  const at = terms.map(t => lower.indexOf(t)).filter(i => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const from = Math.max(0, at - Math.floor(width / 3));
  return `${from > 0 ? '…' : ''}${text.slice(from, from + width)}${from + width < text.length ? '…' : ''}`;
}
