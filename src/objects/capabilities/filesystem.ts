/**
 * Filesystem capability object - workspace-scoped, persistent virtual filesystem.
 *
 * Storage model: the logical file tree lives entirely in `metadata.json`, while
 * file *contents* are stored as opaque UUID-named blobs in a single flat
 * `blobs/` directory. Logical paths are normalized to a canonical '/'-rooted
 * form before use, so a path like `../../etc/passwd` simply collapses inside
 * the virtual tree — it can never escape onto the real host filesystem (the
 * only real paths ever touched are `blobs/<uuid>`, which is always safe).
 *
 * What is deleted or overwritten is set aside, not destroyed: its entries and
 * blobs move under `trash/` (index in `trash/index.json`), kept for the
 * session and at least three days within a size cap, so each caller can undo
 * its own changes (`undo` / `redo`, histories in `undo.json`).
 *
 * Each workspace gets its own root in the instance's data directory,
 * `$ABJECTS_DATA_DIR/ws-<workspaceId>/files` (see data-dir-layout.ts); a tree
 * left at `~/.abject/ws-<workspaceId>/files` by an older build moves there the
 * first time the workspace opens it.
 * This is a `src/` capability object that uses Node `fs` directly (like
 * host-filesystem.ts); it only runs on the Node backend / in a worker_thread,
 * never bundled into the browser client.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { AbjectId, AbjectMessage } from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { event } from '../../core/message.js';
import { require, invariant } from '../../core/contracts.js';
import { UndoHistories, UndoRefused, undoMethods, UNDO_EVENTS } from '../../core/undo.js';
import type { UndoAction, UndoHistoryJSON, UndoStep } from '../../core/undo.js';
import { Log } from '../../core/timed-log.js';
import { workspaceDataDir, legacyHomeDataDir, moveLegacyData } from '../data-dir-layout.js';

const log = new Log('FileSystem');

const FILESYSTEM_INTERFACE = 'abjects:filesystem';
const METADATA_VERSION = 1;

/** What is set aside stays this long past the session it was set aside in. */
const TRASH_KEEP_MS = 3 * 24 * 60 * 60_000;
const TRASH_MAX_ITEMS = 500;
const TRASH_MAX_BYTES = 512 * 1024 * 1024;
const TRASH_PURGE_MS = 60 * 60_000;

/**
 * Folders built-in objects keep their own files in (chat uploads, MCP tool
 * images, recordings). Their writes there are bookkeeping, not changes a
 * person makes, so they record no undo step.
 */
const INTERNAL_FOLDERS = ['/uploads', '/mcp', '/recordings'];

export interface FileInfo {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
  createdAt: number;
  modifiedAt: number;
  /** MIME type inferred from the file extension (files only). */
  mimeType?: string;
}

/** Persisted metadata entry. Files carry a `blobId`; directories don't. */
interface FsEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
  createdAt: number;
  modifiedAt: number;
  blobId?: string;
  mimeType?: string;
}

interface FsMetadata {
  version: number;
  entries: Record<string, FsEntry>;
}

/** A tree set aside: its entries as they were under `root`, blobs in trash/<id>/. */
interface TrashItem {
  id: string;
  root: string;
  removedAt: number;
  bytes: number;
  entries: FsEntry[];
}

/**
 * One undoable change. A path's content is "live" (what is there now, by
 * signature, or null for nothing) and "aside" (what the other side of the
 * change holds, in the trash). Undo and redo of a `swap` are the same move:
 * set aside what is live, bring back what is aside. That one shape covers
 * create, overwrite and delete.
 */
type FsStep =
  | { kind: 'swap'; path: string; live: string | null; aside?: string }
  | { kind: 'move'; from: string; to: string; live: string; aside?: string; asideLive?: string }
  | { kind: 'mkdir'; paths: string[] };

/** Minimal extension → MIME map for the metadata (best-effort). */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  pdf: 'application/pdf', json: 'application/json', txt: 'text/plain',
  md: 'text/markdown', csv: 'text/csv', html: 'text/html', xml: 'text/xml',
  js: 'text/javascript', ts: 'text/typescript', css: 'text/css',
};

function inferMime(name: string): string | undefined {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return MIME_BY_EXT[ext];
}

/** The trash items a step brings back. */
function trashIdsOf(step: FsStep): string[] {
  return step.kind === 'mkdir' || !step.aside ? [] : [step.aside];
}

/**
 * Workspace-scoped, on-disk virtual filesystem capability object.
 */
export class FileSystem extends Abject {
  private readonly rootDir: string;
  /** Where an older build kept this tree, under the home directory. */
  private readonly legacyRootDir: string;
  private readonly blobsDir: string;
  private readonly metadataPath: string;

  private readonly trashDir: string;
  private readonly trashIndexPath: string;
  private readonly undoPath: string;

  /** Canonical path → entry. The in-memory source of truth, mirrored to disk. */
  private entries = new Map<string, FsEntry>();
  /** Trees set aside for undo, by trash id. */
  private trash = new Map<string, TrashItem>();
  /** Each caller's changes, kept on disk with the trash they point into. */
  private undo = new UndoHistories<FsStep>({
    merge: (older, newer) => (older.kind === 'swap' && newer.kind === 'swap' ? { ...newer, aside: older.aside } : newer),
  });
  private readonly sessionStartedAt = Date.now();
  /** Changes run one at a time: handlers interleave at every await. */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(workspaceId?: string) {
    super({
      manifest: {
        name: 'FileSystem',
        description:
          'Workspace-scoped, persistent filesystem. Objects can create, read, write, and delete files and directories. File contents are stored as UUID blobs with a metadata index, so logical paths are fully sandboxed. Use cases: store and read uploaded documents and generated files, list directory contents.',
        version: '3.0.0',
        interface: {
            id: FILESYSTEM_INTERFACE,
            name: 'FileSystem',
            description: 'Workspace-scoped filesystem operations',
            methods: [
              {
                name: 'readFile',
                description: 'Read file contents as text',
                parameters: [
                  { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'File path' },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'writeFile',
                description: 'Write text file contents (parent directories are created automatically)',
                parameters: [
                  { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'File path' },
                  { name: 'content', type: { kind: 'primitive', primitive: 'string' }, description: 'File content' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'readFileBytes',
                description: 'Read file contents as base64 (for binary files such as images or PDFs)',
                parameters: [
                  { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'File path' },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'writeFileBytes',
                description: 'Write binary file contents from a base64 string (parent directories are created automatically)',
                parameters: [
                  { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'File path' },
                  { name: 'base64', type: { kind: 'primitive', primitive: 'string' }, description: 'Base64-encoded file content' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'deleteFile',
                description: 'Delete a file',
                parameters: [
                  { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'File path' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'mkdir',
                description: 'Create a directory (recursively)',
                parameters: [
                  { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'Directory path' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'rmdir',
                description: 'Remove an empty directory',
                parameters: [
                  { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'Directory path' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'remove',
                description: 'Remove a file or a directory (recursively, including its contents)',
                parameters: [
                  { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'Path to remove' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'rename',
                description: 'Rename or move a file or directory',
                parameters: [
                  { name: 'from', type: { kind: 'primitive', primitive: 'string' }, description: 'Existing path' },
                  { name: 'to', type: { kind: 'primitive', primitive: 'string' }, description: 'New path' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'readdir',
                description: 'List directory contents',
                parameters: [
                  { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'Directory path' },
                ],
                returns: { kind: 'array', elementType: { kind: 'reference', reference: 'FileInfo' } },
              },
              {
                name: 'stat',
                description: 'Get file/directory info',
                parameters: [
                  { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'Path to stat' },
                ],
                returns: {
                  kind: 'union',
                  variants: [
                    { kind: 'reference', reference: 'FileInfo' },
                    { kind: 'primitive', primitive: 'null' },
                  ],
                },
              },
              {
                name: 'exists',
                description: 'Check if path exists',
                parameters: [
                  { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'Path to check' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              ...undoMethods('your last change to files here (a write, delete, rename, move or new folder you made)'),
            ],
            events: UNDO_EVENTS,
          },
        tags: ['system', 'capability', 'filesystem'],
      },
    });

    // An empty id means no workspace, as it always has.
    const wsId = workspaceId || undefined;
    this.rootDir = path.join(workspaceDataDir(wsId), 'files');
    this.legacyRootDir = path.join(legacyHomeDataDir(wsId, 'shared'), 'files');
    this.blobsDir = path.join(this.rootDir, 'blobs');
    this.metadataPath = path.join(this.rootDir, 'metadata.json');
    this.trashDir = path.join(this.rootDir, 'trash');
    this.trashIndexPath = path.join(this.trashDir, 'index.json');
    this.undoPath = path.join(this.rootDir, 'undo.json');

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    moveLegacyData(this.legacyRootDir, this.rootDir, 'files', log);
    await fs.mkdir(this.blobsDir, { recursive: true });
    await fs.mkdir(this.trashDir, { recursive: true });
    await this.loadMetadata();
    await this.loadTrash();
    await this.exclusive(() => this.purgeTrash());
    this.setRecurringTimer(() => this.exclusive(() => this.purgeTrash()).catch(err =>
      log.warn('Trash purge failed:', err instanceof Error ? err.message : String(err))), TRASH_PURGE_MS);
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    for (const [id, item] of this.trash) invariant(item.id === id, 'FileSystem: a trash item is kept under its own id');
  }

  private setupHandlers(): void {
    this.on('readFile', async (msg: AbjectMessage) => {
      const { path } = msg.payload as { path: string };
      return this.readFile(path);
    });
    this.on('writeFile', async (msg: AbjectMessage) => {
      const { path, content } = msg.payload as { path: string; content: string };
      return this.exclusive(() => this.writeFile(path, content, msg.routing.from));
    });
    this.on('readFileBytes', async (msg: AbjectMessage) => {
      const { path } = msg.payload as { path: string };
      return this.readFileBytes(path);
    });
    this.on('writeFileBytes', async (msg: AbjectMessage) => {
      const { path, base64 } = msg.payload as { path: string; base64: string };
      return this.exclusive(() => this.writeFileBytes(path, base64, msg.routing.from));
    });
    this.on('deleteFile', async (msg: AbjectMessage) => {
      const { path } = msg.payload as { path: string };
      return this.exclusive(() => this.deleteFile(path, msg.routing.from));
    });
    this.on('mkdir', async (msg: AbjectMessage) => {
      const { path } = msg.payload as { path: string };
      return this.exclusive(() => this.mkdir(path, msg.routing.from));
    });
    this.on('rmdir', async (msg: AbjectMessage) => {
      const { path } = msg.payload as { path: string };
      return this.exclusive(() => this.rmdir(path, msg.routing.from));
    });
    this.on('remove', async (msg: AbjectMessage) => {
      const { path } = msg.payload as { path: string };
      return this.exclusive(() => this.remove(path, msg.routing.from));
    });
    this.on('rename', async (msg: AbjectMessage) => {
      const { from, to } = msg.payload as { from: string; to: string };
      return this.exclusive(() => this.rename(from, to, msg.routing.from));
    });
    this.on('readdir', async (msg: AbjectMessage) => {
      const { path } = msg.payload as { path: string };
      return this.readdir(path);
    });
    this.on('stat', async (msg: AbjectMessage) => {
      const { path } = msg.payload as { path: string };
      return this.stat(path);
    });
    this.on('exists', async (msg: AbjectMessage) => {
      const { path } = msg.payload as { path: string };
      return this.exists(path);
    });
    this.on('undo', async (msg: AbjectMessage) => this.undoFor(msg.routing.from, 'undo'));
    this.on('redo', async (msg: AbjectMessage) => this.undoFor(msg.routing.from, 'redo'));
    this.on('getUndoState', async (msg: AbjectMessage) => this.undo.state(await this.undoCallerKey(msg.routing.from)));
  }

  /** Run a change after the ones before it. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  // ── Metadata persistence ────────────────────────────────────────────

  private async loadMetadata(): Promise<void> {
    this.entries.clear();
    try {
      const raw = await fs.readFile(this.metadataPath, 'utf-8');
      const meta = JSON.parse(raw) as FsMetadata;
      for (const [key, entry] of Object.entries(meta.entries ?? {})) {
        this.entries.set(key, entry);
      }
    } catch {
      // No metadata yet — start fresh.
    }
    if (!this.entries.has('/')) {
      const now = Date.now();
      this.entries.set('/', { path: '/', name: '', isDirectory: true, size: 0, createdAt: now, modifiedAt: now });
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    const meta: FsMetadata = { version: METADATA_VERSION, entries: {} };
    for (const [key, entry] of this.entries) meta.entries[key] = entry;
    try {
      await fs.writeFile(this.metadataPath, JSON.stringify(meta, null, 2), 'utf-8');
    } catch (err) {
      log.warn('Failed to persist metadata:', err instanceof Error ? err.message : String(err));
    }
  }

  // ── Path helpers ────────────────────────────────────────────────────

  /**
   * Collapse a logical path to a canonical '/'-rooted form, resolving `.`/`..`
   * within the virtual tree. `..` past the root is clamped at the root, so no
   * input can ever reference anything outside the sandbox.
   */
  private normalize(p: string): string {
    const stack: string[] = [];
    for (const part of p.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') stack.pop();
      else stack.push(part);
    }
    return '/' + stack.join('/');
  }

  private basename(canonical: string): string {
    return canonical === '/' ? '' : canonical.slice(canonical.lastIndexOf('/') + 1);
  }

  private parentPath(canonical: string): string {
    if (canonical === '/') return '/';
    return canonical.slice(0, canonical.lastIndexOf('/')) || '/';
  }

  private blobPath(blobId: string): string {
    return path.join(this.blobsDir, blobId);
  }

  /** Ensure a directory entry and all its ancestors exist (virtual mkdir -p); the ones it made. */
  private ensureDir(canonical: string): string[] {
    const created: string[] = [];
    if (canonical === '/') return created;
    const parts = canonical.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur = cur + '/' + part;
      const existing = this.entries.get(cur);
      if (!existing) {
        const now = Date.now();
        this.entries.set(cur, { path: cur, name: part, isDirectory: true, size: 0, createdAt: now, modifiedAt: now });
        created.push(cur);
      } else {
        require(existing.isDirectory, `Path component is a file, not a directory: ${cur}`);
      }
    }
    return created;
  }

  private toInfo(entry: FsEntry): FileInfo {
    return {
      path: entry.path,
      name: entry.name,
      isDirectory: entry.isDirectory,
      size: entry.size,
      createdAt: entry.createdAt,
      modifiedAt: entry.modifiedAt,
      ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
    };
  }

  // ── File contents ───────────────────────────────────────────────────

  /**
   * Write a file. Each new content gets a new blob, so a file's blob id is
   * its version; the old content is set aside when the write is recorded
   * for undo, else freed. A write of the content already there changes
   * nothing but the modification time.
   */
  private async writeFileBuffer(canonical: string, buf: Buffer, caller?: AbjectId): Promise<void> {
    require(canonical !== '/', 'Cannot write to the filesystem root');
    const existing = this.entries.get(canonical);
    require(!existing || !existing.isDirectory, `Cannot write to a directory: ${canonical}`);

    const now = Date.now();
    if (existing?.blobId && existing.size === buf.length) {
      const old = await fs.readFile(this.blobPath(existing.blobId)).catch(() => null);
      if (old && old.equals(buf)) {
        existing.modifiedAt = now;
        await this.persist();
        return;
      }
    }

    this.ensureDir(this.parentPath(canonical));
    const record = caller !== undefined && await this.recordsWrite(caller, canonical);
    const blobId = uuidv4();
    await fs.writeFile(this.blobPath(blobId), buf);
    const aside = existing && record ? await this.setAside(canonical) : undefined;

    const name = this.basename(canonical);
    this.entries.set(canonical, {
      path: canonical,
      name,
      isDirectory: false,
      size: buf.length,
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now,
      blobId,
      mimeType: inferMime(name),
    });
    await this.persist();
    if (existing?.blobId && !record) await fs.rm(this.blobPath(existing.blobId), { force: true });
    if (record) {
      await this.recordStep(caller!, `${existing ? 'Write' : 'Create'} ${name}`,
        { kind: 'swap', path: canonical, live: this.signature(canonical), ...(aside ? { aside } : {}) },
        `write:${canonical}`);
    }
  }

  async writeFile(publicPath: string, content: string, caller?: AbjectId): Promise<boolean> {
    await this.writeFileBuffer(this.normalize(publicPath), Buffer.from(content, 'utf-8'), caller);
    return true;
  }

  async writeFileBytes(publicPath: string, base64: string, caller?: AbjectId): Promise<boolean> {
    await this.writeFileBuffer(this.normalize(publicPath), Buffer.from(base64, 'base64'), caller);
    return true;
  }

  async readFile(publicPath: string): Promise<string> {
    const entry = this.entries.get(this.normalize(publicPath));
    require(entry !== undefined, `File not found: ${publicPath}`);
    require(!entry!.isDirectory, `Path is a directory: ${publicPath}`);
    if (!entry!.blobId) return '';
    const buf = await fs.readFile(this.blobPath(entry!.blobId));
    return buf.toString('utf-8');
  }

  async readFileBytes(publicPath: string): Promise<string> {
    const entry = this.entries.get(this.normalize(publicPath));
    require(entry !== undefined, `File not found: ${publicPath}`);
    require(!entry!.isDirectory, `Path is a directory: ${publicPath}`);
    if (!entry!.blobId) return '';
    const buf = await fs.readFile(this.blobPath(entry!.blobId));
    return buf.toString('base64');
  }

  async deleteFile(publicPath: string, caller?: AbjectId): Promise<boolean> {
    const canonical = this.normalize(publicPath);
    const entry = this.entries.get(canonical);
    if (!entry || entry.isDirectory) return false;
    await this.deleteTree(canonical, `Delete ${entry.name}`, caller);
    return true;
  }

  // ── Directories ─────────────────────────────────────────────────────

  async mkdir(publicPath: string, caller?: AbjectId): Promise<boolean> {
    const canonical = this.normalize(publicPath);
    if (canonical === '/') return false;
    const created = this.ensureDir(canonical);
    await this.persist();
    if (caller !== undefined && created.length > 0) {
      await this.recordStep(caller, `New folder ${this.basename(canonical)}`, { kind: 'mkdir', paths: created });
    }
    return true;
  }

  async rmdir(publicPath: string, caller?: AbjectId): Promise<boolean> {
    const canonical = this.normalize(publicPath);
    const entry = this.entries.get(canonical);
    if (!entry || !entry.isDirectory || canonical === '/') return false;
    if (this.hasChildren(canonical)) return false; // not empty
    await this.deleteTree(canonical, `Delete folder ${entry.name}`, caller);
    return true;
  }

  async remove(publicPath: string, caller?: AbjectId): Promise<boolean> {
    const canonical = this.normalize(publicPath);
    require(canonical !== '/', 'Cannot remove the filesystem root');
    const entry = this.entries.get(canonical);
    if (!entry) return false;
    // The entry and (for directories) all descendants go aside together.
    await this.deleteTree(canonical, `Delete ${entry.isDirectory ? 'folder ' : ''}${entry.name}`, caller);
    return true;
  }

  /** Set a tree aside and record its deletion for the caller. */
  private async deleteTree(canonical: string, label: string, caller?: AbjectId): Promise<void> {
    const aside = await this.setAside(canonical);
    await this.persist();
    if (caller !== undefined && aside) {
      await this.recordStep(caller, label, { kind: 'swap', path: canonical, live: null, aside });
    } else {
      await this.purgeTrash();
    }
  }

  async rename(fromPath: string, toPath: string, caller?: AbjectId): Promise<boolean> {
    const from = this.normalize(fromPath);
    const to = this.normalize(toPath);
    require(from !== '/', 'Cannot rename the filesystem root');
    require(to !== '/', 'Invalid destination');
    const entry = this.entries.get(from);
    require(entry !== undefined, `Not found: ${fromPath}`);
    if (from === to) return true;
    require(!to.startsWith(from + '/'), `Cannot move a folder into itself: ${toPath}`);

    this.ensureDir(this.parentPath(to));

    // An existing destination file is overwritten (set aside); a dir clash is refused.
    const destExisting = this.entries.get(to);
    if (destExisting) require(!destExisting.isDirectory, `Destination is a directory: ${toPath}`);
    const aside = destExisting ? await this.setAside(to) : undefined;

    this.moveTree(from, to);
    await this.persist();
    if (caller !== undefined) {
      const label = this.parentPath(from) === this.parentPath(to) ? `Rename ${entry!.name}` : `Move ${entry!.name}`;
      await this.recordStep(caller, label, { kind: 'move', from, to, live: this.signature(to)!, ...(aside ? { aside } : {}) });
    } else if (aside) {
      await this.purgeTrash();
    }
    return true;
  }

  /** Move an entry (and a directory's descendants) to a free path. */
  private moveTree(from: string, to: string): void {
    require(!this.entries.has(to), `moveTree: '${to}' is taken`);
    const now = Date.now();
    const entry = this.entries.get(from)!;
    if (entry.isDirectory) {
      // Move the directory and every descendant, rewriting their paths.
      const moves = this.treeAt(from);
      for (const e of moves) this.entries.delete(e.path);
      for (const e of moves) {
        const newPath = to + e.path.slice(from.length);
        this.entries.set(newPath, { ...e, path: newPath, name: this.basename(newPath) });
      }
      this.entries.get(to)!.modifiedAt = now;
    } else {
      this.entries.delete(from);
      this.entries.set(to, {
        ...entry,
        path: to,
        name: this.basename(to),
        modifiedAt: now,
        mimeType: inferMime(this.basename(to)),
      });
    }
  }

  /** An entry and, for a directory, every descendant. */
  private treeAt(canonical: string): FsEntry[] {
    const prefix = canonical + '/';
    const tree: FsEntry[] = [];
    for (const e of this.entries.values()) {
      if (e.path === canonical || e.path.startsWith(prefix)) tree.push(e);
    }
    return tree;
  }

  /**
   * What is at a path, as a step compares it: a file by its blob (a new one
   * per content), a directory by when it was made; null for nothing.
   */
  private signature(canonical: string): string | null {
    const e = this.entries.get(canonical);
    if (!e) return null;
    return e.isDirectory ? `dir:${e.createdAt}` : `file:${e.blobId ?? ''}`;
  }

  // ── Trash ───────────────────────────────────────────────────────────

  /**
   * Take a tree out of the file system but keep it whole: its entries go in
   * the trash index and its blobs move to trash/<id>/. The trash id, or
   * undefined when nothing is at the path.
   */
  private async setAside(canonical: string): Promise<string | undefined> {
    const tree = this.treeAt(canonical);
    if (tree.length === 0) return undefined;
    const id = `${Date.now().toString(36)}-${uuidv4().slice(0, 8)}`;
    const dir = path.join(this.trashDir, id);
    await fs.mkdir(dir, { recursive: true });
    let bytes = 0;
    for (const e of tree) {
      if (!e.blobId) continue;
      try {
        await fs.rename(this.blobPath(e.blobId), path.join(dir, e.blobId));
        bytes += e.size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    for (const e of tree) this.entries.delete(e.path);
    this.trash.set(id, { id, root: canonical, removedAt: Date.now(), bytes, entries: tree.map(e => ({ ...e })) });
    await this.persistTrash();
    return id;
  }

  /**
   * Refuse a step before it changes anything when it could not finish:
   * what it brings back is gone, or a folder it needs is a file now.
   */
  private checkCanPlace(at: string, id?: string): void {
    if (id !== undefined && !this.trash.has(id)) throw new UndoRefused('What it brings back is no longer kept');
    for (let p = this.parentPath(at); p !== '/'; p = this.parentPath(p)) {
      const e = this.entries.get(p);
      if (e && !e.isDirectory) throw new UndoRefused(`'${p}' is a file now`);
    }
  }

  /** Put a tree set aside back, rooted at `at` (a free path). */
  private async bringBack(id: string, at: string): Promise<void> {
    this.checkCanPlace(at, id);
    const item = this.trash.get(id)!;
    require(!this.entries.has(at), `bringBack: '${at}' is taken`);
    this.ensureDir(this.parentPath(at));
    const dir = path.join(this.trashDir, id);
    for (const e of item.entries) {
      if (e.blobId) {
        try {
          await fs.rename(path.join(dir, e.blobId), this.blobPath(e.blobId));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      const p = at + e.path.slice(item.root.length);
      this.entries.set(p, { ...e, path: p, name: this.basename(p) });
    }
    this.trash.delete(id);
    await fs.rm(dir, { recursive: true, force: true });
    await this.persistTrash();
  }

  /** A free path beside `canonical`: "name (restored).ext", numbered if need be. */
  private freeName(canonical: string): string {
    const parent = this.parentPath(canonical);
    const name = this.basename(canonical);
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 1; ; n++) {
      const candidate = `${parent === '/' ? '' : parent}/${stem} (restored${n > 1 ? ` ${n}` : ''})${ext}`;
      if (!this.entries.has(candidate)) return candidate;
    }
  }

  private async loadTrash(): Promise<void> {
    try {
      const items = JSON.parse(await fs.readFile(this.trashIndexPath, 'utf-8')) as TrashItem[];
      for (const item of Array.isArray(items) ? items : []) {
        if (item?.id && typeof item.root === 'string' && Array.isArray(item.entries)) this.trash.set(item.id, item);
      }
    } catch { /* no trash yet */ }
    try {
      this.undo.load(JSON.parse(await fs.readFile(this.undoPath, 'utf-8')) as Record<string, UndoHistoryJSON<FsStep>>);
    } catch { /* no history yet */ }
  }

  private async persistTrash(): Promise<void> {
    try {
      await fs.writeFile(this.trashIndexPath, JSON.stringify([...this.trash.values()]), 'utf-8');
    } catch (err) {
      log.warn('Failed to persist the trash index:', err instanceof Error ? err.message : String(err));
    }
  }

  private async persistUndo(): Promise<void> {
    try {
      await fs.writeFile(this.undoPath, JSON.stringify(this.undo.toJSON()), 'utf-8');
    } catch (err) {
      log.warn('Failed to persist undo history:', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Forget what is set aside past keeping: what no undo step points at any
   * more (nothing else can bring it back), what was set aside before this
   * session and longer ago than TRASH_KEEP_MS, and beyond the count and size
   * caps, oldest first. Steps that pointed at what went are dropped.
   */
  private async purgeTrash(): Promise<void> {
    const referenced = new Set(this.undo.steps().flatMap(s => trashIdsOf(s.data)));
    const now = Date.now();
    const items = [...this.trash.values()].sort((a, b) => a.removedAt - b.removedAt);
    const gone = new Set(items.filter(t => !referenced.has(t.id)
      || (t.removedAt < this.sessionStartedAt && now - t.removedAt > TRASH_KEEP_MS)).map(t => t.id));
    let count = items.length - gone.size;
    let bytes = items.filter(t => !gone.has(t.id)).reduce((n, t) => n + t.bytes, 0);
    for (const t of items) {
      if (count <= TRASH_MAX_ITEMS && bytes <= TRASH_MAX_BYTES) break;
      if (gone.has(t.id)) continue;
      gone.add(t.id);
      count--;
      bytes -= t.bytes;
    }
    if (gone.size > 0) {
      for (const id of gone) {
        this.trash.delete(id);
        await fs.rm(path.join(this.trashDir, id), { recursive: true, force: true });
      }
      await this.persistTrash();
    }
    const before = this.undo.steps().length;
    this.undo.prune(step => trashIdsOf(step.data).every(id => this.trash.has(id)));
    if (this.undo.steps().length !== before) await this.persistUndo();
  }

  // ── Undo ────────────────────────────────────────────────────────────

  /**
   * Whether a write is the caller's own change: everything but a built-in
   * object's bookkeeping in the folders built-ins keep files in.
   */
  private async recordsWrite(caller: AbjectId, canonical: string): Promise<boolean> {
    const internal = INTERNAL_FOLDERS.some(f => canonical === f || canonical.startsWith(f + '/'));
    return !internal || !await this.isBuiltInCaller(caller);
  }

  private async recordStep(callerId: AbjectId, label: string, step: FsStep, mergeKey?: string): Promise<void> {
    const caller = await this.undoCallerKey(callerId);
    this.undo.for(caller).record(label, step, mergeKey !== undefined ? { mergeKey } : {});
    // A new step drops the caller's redo side; what only it kept goes too.
    await this.purgeTrash();
    await this.persistUndo();
    this.send(event(this.id, callerId, 'undoStateChanged', this.undo.state(caller)));
  }

  private async undoFor(callerId: AbjectId, action: UndoAction): Promise<unknown> {
    const caller = await this.undoCallerKey(callerId);
    return this.exclusive(async () => {
      const history = this.undo.get(caller);
      if (!history) return { ok: false, reason: action === 'undo' ? 'Nothing to undo' : 'Nothing to redo' };
      const result = await history[action](step => this.applyStep(step, action));
      await this.persist();
      await this.purgeTrash();
      await this.persistUndo();
      this.send(event(this.id, callerId, 'undoStateChanged', this.undo.state(caller)));
      return result;
    });
  }

  /** Take a step back (undo) or forward again (redo). */
  private async applyStep(step: UndoStep<FsStep>, action: UndoAction): Promise<unknown> {
    const d = step.data;
    switch (d.kind) {
      case 'swap': {
        // Undo and redo are the same move: what is live goes aside, what is aside comes back.
        const current = this.signature(d.path);
        if (d.live !== null && current !== d.live) throw new UndoRefused(`'${d.path}' changed since`);
        // Bringing something back where something else lives now: it comes back beside it.
        const at = d.live === null && current !== null ? this.freeName(d.path) : d.path;
        if (d.aside) this.checkCanPlace(at, d.aside);
        const asideNow = d.live !== null ? await this.setAside(d.path) : undefined;
        if (d.aside) await this.bringBack(d.aside, at);
        const restored = d.aside ? at : undefined;
        d.path = at;
        d.live = d.aside ? this.signature(at) : null;
        if (asideNow) d.aside = asideNow; else delete d.aside;
        return restored ? { path: restored } : {};
      }
      case 'move': {
        const [src, dst] = action === 'undo' ? [d.to, d.from] : [d.from, d.to];
        if (this.signature(src) !== d.live) throw new UndoRefused(`'${src}' changed since`);
        const occupant = this.signature(dst);
        // Redo puts aside again what the rename overwrote; anything else there stays.
        if (occupant !== null && (action === 'undo' || occupant !== d.asideLive)) throw new UndoRefused(`'${dst}' is taken since`);
        this.checkCanPlace(dst);
        if (action === 'undo' && d.aside) this.checkCanPlace(src, d.aside);
        if (occupant !== null) {
          d.aside = await this.setAside(dst);
          delete d.asideLive;
        }
        this.ensureDir(this.parentPath(dst));
        this.moveTree(src, dst);
        if (action === 'undo' && d.aside) {
          await this.bringBack(d.aside, src);
          d.asideLive = this.signature(src) ?? undefined;
          delete d.aside;
        }
        return { path: dst };
      }
      case 'mkdir': {
        if (action === 'undo') {
          const made = new Set(d.paths);
          for (const p of d.paths) {
            const e = this.entries.get(p);
            if (!e) continue;
            if (!e.isDirectory) throw new UndoRefused(`'${p}' is a file now`);
            for (const child of this.treeAt(p)) {
              if (!made.has(child.path)) throw new UndoRefused(`'${p}' is not empty`);
            }
          }
          for (const p of d.paths) this.entries.delete(p);
          return {};
        }
        for (const p of d.paths) {
          if (this.entries.get(p) && !this.entries.get(p)!.isDirectory) throw new UndoRefused(`'${p}' is a file now`);
        }
        this.ensureDir(d.paths[d.paths.length - 1]);
        return { path: d.paths[d.paths.length - 1] };
      }
    }
  }

  // ── Queries ─────────────────────────────────────────────────────────

  async readdir(publicPath: string): Promise<FileInfo[]> {
    const canonical = this.normalize(publicPath);
    const entry = this.entries.get(canonical);
    require(entry !== undefined, `Directory not found: ${publicPath}`);
    require(entry!.isDirectory, `Path is not a directory: ${publicPath}`);
    const result: FileInfo[] = [];
    for (const e of this.entries.values()) {
      if (e.path !== canonical && this.parentPath(e.path) === canonical) {
        result.push(this.toInfo(e));
      }
    }
    return result;
  }

  async stat(publicPath: string): Promise<FileInfo | null> {
    const entry = this.entries.get(this.normalize(publicPath));
    return entry ? this.toInfo(entry) : null;
  }

  async exists(publicPath: string): Promise<boolean> {
    return this.entries.has(this.normalize(publicPath));
  }

  private hasChildren(canonical: string): boolean {
    const prefix = canonical + '/';
    for (const e of this.entries.keys()) {
      if (e.startsWith(prefix)) return true;
    }
    return false;
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## FileSystem Usage Guide

### Write a File

  await this.call(
    this.dep('FileSystem'), 'writeFile',
    { path: '/data/config.json', content: JSON.stringify({ key: 'value' }) });

### Read a File

  const content = await this.call(
    this.dep('FileSystem'), 'readFile',
    { path: '/data/config.json' });

### Write / Read Binary Files (base64)

  await this.call(
    this.dep('FileSystem'), 'writeFileBytes',
    { path: '/uploads/image.png', base64: '<base64>' });
  const base64 = await this.call(
    this.dep('FileSystem'), 'readFileBytes',
    { path: '/uploads/image.png' });

### Create a Directory

  await this.call(this.dep('FileSystem'), 'mkdir', { path: '/data' });

### List Directory Contents

  const entries = await this.call(
    this.dep('FileSystem'), 'readdir', { path: '/' });
  // Returns array of { path, name, isDirectory, size, createdAt, modifiedAt, mimeType? }

### Remove a File or Folder (recursive)

  await this.call(this.dep('FileSystem'), 'remove', { path: '/data' });

### Rename or Move

  await this.call(
    this.dep('FileSystem'), 'rename',
    { from: '/data/old.txt', to: '/data/new.txt' });

### Undo Your Own Changes

  const r = await this.call(this.dep('FileSystem'), 'undo', {});
  // { ok, label, reason }: e.g. { ok: true, label: 'Delete report.md' }
  await this.call(this.dep('FileSystem'), 'redo', {});
  const state = await this.call(this.dep('FileSystem'), 'getUndoState', {});

Each caller has its own history: undo takes back the last write, delete,
rename, move or new folder that *you* made. Deleted and overwritten content is
kept for a few days, so undo brings it back. Undo answers ok: false with a
reason when the file changed again since; a file brought back where another
now lives returns as "name (restored)".

### IMPORTANT
- Paths use '/' separator, root is '/'. Paths are virtual and fully sandboxed:
  '..' segments collapse within the tree and can never escape onto the host.
- This filesystem is workspace-scoped and persists on disk across reloads.
- writeFile/writeFileBytes create parent directories automatically.
- Use writeFileBytes/readFileBytes for binary content (images, PDFs); writeFile/readFile are for text.
- Do NOT use the browser File API directly — always go through the FileSystem object.`;
  }
}

// Well-known filesystem ID
export const FILESYSTEM_ID = 'abjects:filesystem' as AbjectId;
