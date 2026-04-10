/**
 * Filesystem capability object - provides virtual filesystem capabilities.
 */

import { AbjectId, AbjectMessage } from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { require } from '../../core/contracts.js';
import { Capabilities } from '../../core/capability.js';

const FILESYSTEM_INTERFACE = 'abjects:filesystem';

export interface FileInfo {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
  createdAt: number;
  modifiedAt: number;
}

interface FileEntry {
  info: FileInfo;
  content?: Uint8Array;
  children?: Map<string, FileEntry>;
}

/**
 * Virtual filesystem capability object.
 */
export class FileSystem extends Abject {
  private root: FileEntry;

  constructor() {
    super({
      manifest: {
        name: 'FileSystem',
        description:
          'Virtual in-memory filesystem. Objects can create, read, write, and delete files and directories. Use cases: read and write files in a virtual file tree, list directory contents.',
        version: '1.0.0',
        interface: {
            id: FILESYSTEM_INTERFACE,
            name: 'FileSystem',
            description: 'Virtual filesystem operations',
            methods: [
              {
                name: 'readFile',
                description: 'Read file contents',
                parameters: [
                  {
                    name: 'path',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'File path',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'writeFile',
                description: 'Write file contents',
                parameters: [
                  {
                    name: 'path',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'File path',
                  },
                  {
                    name: 'content',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'File content',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'deleteFile',
                description: 'Delete a file',
                parameters: [
                  {
                    name: 'path',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'File path',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'mkdir',
                description: 'Create a directory',
                parameters: [
                  {
                    name: 'path',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Directory path',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'rmdir',
                description: 'Remove a directory',
                parameters: [
                  {
                    name: 'path',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Directory path',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'readdir',
                description: 'List directory contents',
                parameters: [
                  {
                    name: 'path',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Directory path',
                  },
                ],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'reference', reference: 'FileInfo' },
                },
              },
              {
                name: 'stat',
                description: 'Get file/directory info',
                parameters: [
                  {
                    name: 'path',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Path to stat',
                  },
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
                  {
                    name: 'path',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Path to check',
                  },
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

    // Initialize root directory
    this.root = {
      info: {
        path: '/',
        name: '',
        isDirectory: true,
        size: 0,
        createdAt: Date.now(),
        modifiedAt: Date.now(),
      },
      children: new Map(),
    };

    this.setupHandlers();
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

  /**
   * Normalize a path.
   */
  private normalizePath(path: string): string[] {
    const parts = path.split('/').filter((p) => p !== '' && p !== '.');
    const result: string[] = [];

    for (const part of parts) {
      if (part === '..') {
        result.pop();
      } else {
        result.push(part);
      }
    }

    return result;
  }

  /**
   * Get entry at path.
   */
  private getEntry(path: string): FileEntry | undefined {
    const parts = this.normalizePath(path);

    let current = this.root;
    for (const part of parts) {
      if (!current.children) {
        return undefined;
      }
      const child = current.children.get(part);
      if (!child) {
        return undefined;
      }
      current = child;
    }

    return current;
  }

  /**
   * Get parent entry and name for a path.
   */
  private getParentAndName(path: string): { parent: FileEntry; name: string } | undefined {
    const parts = this.normalizePath(path);
    if (parts.length === 0) {
      return undefined;
    }

    const name = parts.pop()!;
    let parent = this.root;

    for (const part of parts) {
      if (!parent.children) {
        return undefined;
      }
      const child = parent.children.get(part);
      if (!child || !child.info.isDirectory) {
        return undefined;
      }
      parent = child;
    }

    return { parent, name };
  }

  /**
   * Read file contents.
   */
  readFile(path: string): string {
    const entry = this.getEntry(path);
    require(entry !== undefined, `File not found: ${path}`);
    require(!entry!.info.isDirectory, `Path is a directory: ${path}`);

    if (!entry!.content) {
      return '';
    }

    return new TextDecoder().decode(entry!.content);
  }

  /**
   * Write file contents.
   */
  writeFile(path: string, content: string): boolean {
    const result = this.getParentAndName(path);
    require(result !== undefined, `Invalid path: ${path}`);

    const { parent, name } = result!;
    require(parent.children !== undefined, 'Parent is not a directory');

    const now = Date.now();
    const contentBytes = new TextEncoder().encode(content);

    const existing = parent.children!.get(name);
    if (existing) {
      require(!existing.info.isDirectory, `Cannot write to directory: ${path}`);
      existing.content = contentBytes;
      existing.info.size = contentBytes.length;
      existing.info.modifiedAt = now;
    } else {
      const fullPath = '/' + this.normalizePath(path).join('/');
      parent.children!.set(name, {
        info: {
          path: fullPath,
          name,
          isDirectory: false,
          size: contentBytes.length,
          createdAt: now,
          modifiedAt: now,
        },
        content: contentBytes,
      });
    }

    return true;
  }

  /**
   * Delete a file.
   */
  deleteFile(path: string): boolean {
    const result = this.getParentAndName(path);
    if (!result) {
      return false;
    }

    const { parent, name } = result;
    const entry = parent.children?.get(name);
    if (!entry || entry.info.isDirectory) {
      return false;
    }

    parent.children!.delete(name);
    return true;
  }

  /**
   * Create a directory.
   */
  mkdir(path: string): boolean {
    const result = this.getParentAndName(path);
    require(result !== undefined, `Invalid path: ${path}`);

    const { parent, name } = result!;
    require(parent.children !== undefined, 'Parent is not a directory');

    if (parent.children!.has(name)) {
      return false; // Already exists
    }

    const fullPath = '/' + this.normalizePath(path).join('/');
    const now = Date.now();

    parent.children!.set(name, {
      info: {
        path: fullPath,
        name,
        isDirectory: true,
        size: 0,
        createdAt: now,
        modifiedAt: now,
      },
      children: new Map(),
    });

    return true;
  }

  /**
   * Remove a directory.
   */
  rmdir(path: string): boolean {
    const result = this.getParentAndName(path);
    if (!result) {
      return false;
    }

    const { parent, name } = result;
    const entry = parent.children?.get(name);
    if (!entry || !entry.info.isDirectory) {
      return false;
    }

    if (entry.children && entry.children.size > 0) {
      throw new Error(`Directory not empty: ${path}`);
    }

    parent.children!.delete(name);
    return true;
  }

  /**
   * List directory contents.
   */
  readdir(path: string): FileInfo[] {
    const entry = this.getEntry(path);
    require(entry !== undefined, `Directory not found: ${path}`);
    require(entry!.info.isDirectory, `Path is not a directory: ${path}`);

    if (!entry!.children) {
      return [];
    }

    return Array.from(entry!.children.values()).map((e) => e.info);
  }

  /**
   * Get file/directory info.
   */
  stat(path: string): FileInfo | null {
    const entry = this.getEntry(path);
    return entry?.info ?? null;
  }

  /**
   * Check if path exists.
   */
  exists(path: string): boolean {
    return this.getEntry(path) !== undefined;
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

### Create a Directory

  await this.call(
    this.dep('FileSystem'), 'mkdir',
    { path: '/data' });

### List Directory Contents

  const entries = await this.call(
    this.dep('FileSystem'), 'readdir',
    { path: '/' });
  // Returns array of { path, name, isDirectory, size, createdAt, modifiedAt }

### Check if Path Exists

  const exists = await this.call(
    this.dep('FileSystem'), 'exists',
    { path: '/data/config.json' });

### Get File Info

  const info = await this.call(
    this.dep('FileSystem'), 'stat',
    { path: '/data/config.json' });
  // Returns { path, name, isDirectory, size, createdAt, modifiedAt } or null

### Delete a File

  await this.call(
    this.dep('FileSystem'), 'deleteFile',
    { path: '/data/config.json' });

### IMPORTANT
- Paths use '/' separator, root is '/'.
- This is an in-memory filesystem — data does NOT persist across page reloads. Use Storage for persistence.
- Create parent directories before writing files (e.g. mkdir '/data' before writeFile '/data/file.txt').
- Do NOT use the browser File API directly — always go through the FileSystem object.`;
  }
}

// Well-known filesystem ID
export const FILESYSTEM_ID = 'abjects:filesystem' as AbjectId;
