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
 * Each workspace gets its own root under `~/.abject/ws-<workspaceId>/files`.
 * This is a `src/` capability object that uses Node `fs` directly (like
 * host-filesystem.ts); it only runs on the Node backend / in a worker_thread,
 * never bundled into the browser client.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { AbjectId, AbjectMessage } from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { require } from '../../core/contracts.js';
import { Capabilities } from '../../core/capability.js';
import { Log } from '../../core/timed-log.js';

const log = new Log('FileSystem');

const FILESYSTEM_INTERFACE = 'abjects:filesystem';
const METADATA_VERSION = 1;

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

/**
 * Workspace-scoped, on-disk virtual filesystem capability object.
 */
export class FileSystem extends Abject {
  private readonly rootDir: string;
  private readonly blobsDir: string;
  private readonly metadataPath: string;

  /** Canonical path → entry. The in-memory source of truth, mirrored to disk. */
  private entries = new Map<string, FsEntry>();

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
            ],
          },
        requiredCapabilities: [],
        providedCapabilities: [
          Capabilities.FILESYSTEM_READ,
          Capabilities.FILESYSTEM_WRITE,
        ],
        tags: ['system', 'capability', 'filesystem'],
      },
    });

    const scope = workspaceId ? `ws-${workspaceId}` : 'shared';
    this.rootDir = path.join(os.homedir(), '.abject', scope, 'files');
    this.blobsDir = path.join(this.rootDir, 'blobs');
    this.metadataPath = path.join(this.rootDir, 'metadata.json');

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    await fs.mkdir(this.blobsDir, { recursive: true });
    await this.loadMetadata();
  }

  private setupHandlers(): void {
    this.on('readFile', async (msg: AbjectMessage) => {
      const { path } = msg.payload as { path: string };
      return this.readFile(path);
    });
    this.on('writeFile', async (msg: AbjectMessage) => {
      const { path, content } = msg.payload as { path: string; content: string };
      return this.writeFile(path, content);
    });
    this.on('readFileBytes', async (msg: AbjectMessage) => {
      const { path } = msg.payload as { path: string };
      return this.readFileBytes(path);
    });
    this.on('writeFileBytes', async (msg: AbjectMessage) => {
      const { path, base64 } = msg.payload as { path: string; base64: string };
      return this.writeFileBytes(path, base64);
    });
    this.on('deleteFile', async (msg: AbjectMessage) => {
      const { path } = msg.payload as { path: string };
      return this.deleteFile(path);
    });
    this.on('mkdir', async (msg: AbjectMessage) => {
      const { path } = msg.payload as { path: string };
      return this.mkdir(path);
    });
    this.on('rmdir', async (msg: AbjectMessage) => {
      const { path } = msg.payload as { path: string };
      return this.rmdir(path);
    });
    this.on('remove', async (msg: AbjectMessage) => {
      const { path } = msg.payload as { path: string };
      return this.remove(path);
    });
    this.on('rename', async (msg: AbjectMessage) => {
      const { from, to } = msg.payload as { from: string; to: string };
      return this.rename(from, to);
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

  /** Ensure a directory entry and all its ancestors exist (virtual mkdir -p). */
  private ensureDir(canonical: string): void {
    if (canonical === '/') return;
    const parts = canonical.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur = cur + '/' + part;
      const existing = this.entries.get(cur);
      if (!existing) {
        const now = Date.now();
        this.entries.set(cur, { path: cur, name: part, isDirectory: true, size: 0, createdAt: now, modifiedAt: now });
      } else {
        require(existing.isDirectory, `Path component is a file, not a directory: ${cur}`);
      }
    }
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

  private async writeFileBuffer(canonical: string, buf: Buffer): Promise<void> {
    require(canonical !== '/', 'Cannot write to the filesystem root');
    this.ensureDir(this.parentPath(canonical));
    const existing = this.entries.get(canonical);
    require(!existing || !existing.isDirectory, `Cannot write to a directory: ${canonical}`);

    const blobId = existing?.blobId ?? uuidv4();
    await fs.writeFile(this.blobPath(blobId), buf);

    const now = Date.now();
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
  }

  async writeFile(publicPath: string, content: string): Promise<boolean> {
    await this.writeFileBuffer(this.normalize(publicPath), Buffer.from(content, 'utf-8'));
    return true;
  }

  async writeFileBytes(publicPath: string, base64: string): Promise<boolean> {
    await this.writeFileBuffer(this.normalize(publicPath), Buffer.from(base64, 'base64'));
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

  async deleteFile(publicPath: string): Promise<boolean> {
    const canonical = this.normalize(publicPath);
    const entry = this.entries.get(canonical);
    if (!entry || entry.isDirectory) return false;
    if (entry.blobId) await fs.rm(this.blobPath(entry.blobId), { force: true });
    this.entries.delete(canonical);
    await this.persist();
    return true;
  }

  // ── Directories ─────────────────────────────────────────────────────

  async mkdir(publicPath: string): Promise<boolean> {
    const canonical = this.normalize(publicPath);
    if (canonical === '/') return false;
    this.ensureDir(canonical);
    await this.persist();
    return true;
  }

  async rmdir(publicPath: string): Promise<boolean> {
    const canonical = this.normalize(publicPath);
    const entry = this.entries.get(canonical);
    if (!entry || !entry.isDirectory || canonical === '/') return false;
    if (this.hasChildren(canonical)) return false; // not empty
    this.entries.delete(canonical);
    await this.persist();
    return true;
  }

  async remove(publicPath: string): Promise<boolean> {
    const canonical = this.normalize(publicPath);
    require(canonical !== '/', 'Cannot remove the filesystem root');
    const entry = this.entries.get(canonical);
    if (!entry) return false;

    // Collect the entry and (for directories) all descendants.
    const prefix = canonical + '/';
    const toRemove: FsEntry[] = [];
    for (const e of this.entries.values()) {
      if (e.path === canonical || e.path.startsWith(prefix)) toRemove.push(e);
    }
    for (const e of toRemove) {
      if (e.blobId) await fs.rm(this.blobPath(e.blobId), { force: true });
      this.entries.delete(e.path);
    }
    await this.persist();
    return true;
  }

  async rename(fromPath: string, toPath: string): Promise<boolean> {
    const from = this.normalize(fromPath);
    const to = this.normalize(toPath);
    require(from !== '/', 'Cannot rename the filesystem root');
    require(to !== '/', 'Invalid destination');
    const entry = this.entries.get(from);
    require(entry !== undefined, `Not found: ${fromPath}`);
    if (from === to) return true;

    this.ensureDir(this.parentPath(to));

    // Overwrite an existing destination file (free its blob); refuse a dir clash.
    const destExisting = this.entries.get(to);
    if (destExisting) {
      require(!destExisting.isDirectory, `Destination is a directory: ${toPath}`);
      if (destExisting.blobId) await fs.rm(this.blobPath(destExisting.blobId), { force: true });
      this.entries.delete(to);
    }

    const now = Date.now();
    if (entry!.isDirectory) {
      // Move the directory and every descendant, rewriting their paths.
      const prefix = from + '/';
      const moves: FsEntry[] = [];
      for (const e of this.entries.values()) {
        if (e.path === from || e.path.startsWith(prefix)) moves.push(e);
      }
      for (const e of moves) {
        this.entries.delete(e.path);
        const newPath = to + e.path.slice(from.length);
        this.entries.set(newPath, { ...e, path: newPath, name: this.basename(newPath) });
      }
      const moved = this.entries.get(to)!;
      moved.modifiedAt = now;
    } else {
      this.entries.delete(from);
      this.entries.set(to, {
        ...entry!,
        path: to,
        name: this.basename(to),
        modifiedAt: now,
        mimeType: inferMime(this.basename(to)),
      });
    }
    await this.persist();
    return true;
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
