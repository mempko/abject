/**
 * HostFileSystem capability object -- provides real filesystem access.
 *
 * This is the Abjects equivalent of Claude Code's Read, Write, Edit, Glob,
 * and Grep tools. Unlike the virtual in-memory FileSystem, this operates on
 * the actual host filesystem.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { AbjectId, AbjectMessage, InterfaceId } from '../../core/types.js';
import { Abject, DEFERRED_REPLY } from '../../core/abject.js';
import { error as errorMsg, request } from '../../core/message.js';
import { Capabilities } from '../../core/capability.js';
import { require as contractRequire } from '../../core/contracts.js';
import { Log } from '../../core/timed-log.js';

const log = new Log('HostFileSystem');

const HOSTFS_INTERFACE: InterfaceId = 'abjects:hostfs';

export interface FileInfo {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
}

export class HostFileSystem extends Abject {
  private allowedPaths?: string[];
  private readOnly: boolean;
  /** The only AbjectId allowed to call updatePermissions. Set once at bootstrap. */
  private permissionsAuthorityId?: AbjectId;

  constructor(config?: {
    allowedPaths?: string[];
    readOnly?: boolean;
  }) {
    super({
      manifest: {
        name: 'HostFileSystem',
        description:
          'Provides real filesystem access on the host. Equivalent to Claude Code\'s Read, Write, Edit, Glob, and Grep tools. ' +
          'Read and write files, search by filename patterns, search file contents with regex.',
        version: '1.0.0',
        interface: {
          id: HOSTFS_INTERFACE,
          name: 'HostFileSystem',
          description: 'Real filesystem operations',
          methods: [
            {
              name: 'readFile',
              description: 'Read a file\'s contents as a string',
              parameters: [
                { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'Absolute file path' },
                { name: 'offset', type: { kind: 'primitive', primitive: 'number' }, description: 'Start reading at this line number (1-based)', optional: true },
                { name: 'limit', type: { kind: 'primitive', primitive: 'number' }, description: 'Maximum number of lines to read', optional: true },
              ],
              returns: { kind: 'object', properties: {
                content: { kind: 'primitive', primitive: 'string' },
                lines: { kind: 'primitive', primitive: 'number' },
              }},
            },
            {
              name: 'writeFile',
              description: 'Write content to a file (creates parent directories as needed)',
              parameters: [
                { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'Absolute file path' },
                { name: 'content', type: { kind: 'primitive', primitive: 'string' }, description: 'File content' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'editFile',
              description: 'Replace a specific text string in a file',
              parameters: [
                { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'Absolute file path' },
                { name: 'oldText', type: { kind: 'primitive', primitive: 'string' }, description: 'Text to find' },
                { name: 'newText', type: { kind: 'primitive', primitive: 'string' }, description: 'Replacement text' },
              ],
              returns: { kind: 'object', properties: {
                success: { kind: 'primitive', primitive: 'boolean' },
                replacements: { kind: 'primitive', primitive: 'number' },
              }},
            },
            {
              name: 'glob',
              description: 'Find files matching a glob pattern',
              parameters: [
                { name: 'pattern', type: { kind: 'primitive', primitive: 'string' }, description: 'Glob pattern (e.g. "**/*.ts")' },
                { name: 'cwd', type: { kind: 'primitive', primitive: 'string' }, description: 'Base directory', optional: true },
              ],
              returns: { kind: 'object', properties: {
                files: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
              }},
            },
            {
              name: 'grep',
              description: 'Search file contents with a regex pattern',
              parameters: [
                { name: 'pattern', type: { kind: 'primitive', primitive: 'string' }, description: 'Regex pattern to search for' },
                { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'File or directory to search in', optional: true },
                { name: 'glob', type: { kind: 'primitive', primitive: 'string' }, description: 'Glob filter for files (e.g. "*.ts")', optional: true },
                { name: 'maxResults', type: { kind: 'primitive', primitive: 'number' }, description: 'Maximum number of matches', optional: true },
              ],
              returns: { kind: 'object', properties: {
                matches: { kind: 'array', elementType: { kind: 'object', properties: {
                  file: { kind: 'primitive', primitive: 'string' },
                  line: { kind: 'primitive', primitive: 'number' },
                  content: { kind: 'primitive', primitive: 'string' },
                }}},
              }},
            },
            {
              name: 'stat',
              description: 'Get file or directory metadata',
              parameters: [
                { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'Absolute path' },
              ],
              returns: { kind: 'object', properties: {
                path: { kind: 'primitive', primitive: 'string' },
                name: { kind: 'primitive', primitive: 'string' },
                isDirectory: { kind: 'primitive', primitive: 'boolean' },
                size: { kind: 'primitive', primitive: 'number' },
                modifiedAt: { kind: 'primitive', primitive: 'number' },
              }},
            },
            {
              name: 'mkdir',
              description: 'Create a directory (including parent directories)',
              parameters: [
                { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'Absolute directory path' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'readdir',
              description: 'List directory contents',
              parameters: [
                { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'Absolute directory path' },
              ],
              returns: { kind: 'object', properties: {
                entries: { kind: 'array', elementType: { kind: 'object', properties: {
                  name: { kind: 'primitive', primitive: 'string' },
                  isDirectory: { kind: 'primitive', primitive: 'boolean' },
                }}},
              }},
            },
            {
              name: 'exists',
              description: 'Check if a path exists',
              parameters: [
                { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'Absolute path' },
              ],
              returns: { kind: 'object', properties: { exists: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'deleteFile',
              description: 'Delete a file',
              parameters: [
                { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'Absolute file path' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.HOSTFS_READ, Capabilities.HOSTFS_WRITE],
        tags: ['system', 'capability', 'filesystem'],
      },
    });

    this.allowedPaths = config?.allowedPaths;
    this.readOnly = config?.readOnly ?? false;

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('readFile', (msg: AbjectMessage) => {
      const { path: filePath, offset, limit } = msg.payload as { path: string; offset?: number; limit?: number };
      this.handleReadFile(filePath, offset, limit).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => this.send(errorMsg(msg, 'HOSTFS_ERROR', err instanceof Error ? err.message : String(err))),
      );
      return DEFERRED_REPLY;
    });

    this.on('writeFile', (msg: AbjectMessage) => {
      const { path: filePath, content } = msg.payload as { path: string; content: string };
      this.handleWriteFile(filePath, content).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => this.send(errorMsg(msg, 'HOSTFS_ERROR', err instanceof Error ? err.message : String(err))),
      );
      return DEFERRED_REPLY;
    });

    this.on('editFile', (msg: AbjectMessage) => {
      const { path: filePath, oldText, newText } = msg.payload as { path: string; oldText: string; newText: string };
      this.handleEditFile(filePath, oldText, newText).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => this.send(errorMsg(msg, 'HOSTFS_ERROR', err instanceof Error ? err.message : String(err))),
      );
      return DEFERRED_REPLY;
    });

    this.on('glob', (msg: AbjectMessage) => {
      const { pattern, cwd } = msg.payload as { pattern: string; cwd?: string };
      this.handleGlob(pattern, cwd).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => this.send(errorMsg(msg, 'HOSTFS_ERROR', err instanceof Error ? err.message : String(err))),
      );
      return DEFERRED_REPLY;
    });

    this.on('grep', (msg: AbjectMessage) => {
      const { pattern, path: searchPath, glob: globFilter, maxResults } =
        msg.payload as { pattern: string; path?: string; glob?: string; maxResults?: number };
      this.handleGrep(pattern, searchPath, globFilter, maxResults).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => this.send(errorMsg(msg, 'HOSTFS_ERROR', err instanceof Error ? err.message : String(err))),
      );
      return DEFERRED_REPLY;
    });

    this.on('stat', (msg: AbjectMessage) => {
      const { path: filePath } = msg.payload as { path: string };
      this.handleStat(filePath).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => this.send(errorMsg(msg, 'HOSTFS_ERROR', err instanceof Error ? err.message : String(err))),
      );
      return DEFERRED_REPLY;
    });

    this.on('mkdir', (msg: AbjectMessage) => {
      const { path: dirPath } = msg.payload as { path: string };
      this.handleMkdir(dirPath).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => this.send(errorMsg(msg, 'HOSTFS_ERROR', err instanceof Error ? err.message : String(err))),
      );
      return DEFERRED_REPLY;
    });

    this.on('readdir', (msg: AbjectMessage) => {
      const { path: dirPath } = msg.payload as { path: string };
      this.handleReaddir(dirPath).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => this.send(errorMsg(msg, 'HOSTFS_ERROR', err instanceof Error ? err.message : String(err))),
      );
      return DEFERRED_REPLY;
    });

    this.on('exists', (msg: AbjectMessage) => {
      const { path: filePath } = msg.payload as { path: string };
      this.handleExists(filePath).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => this.send(errorMsg(msg, 'HOSTFS_ERROR', err instanceof Error ? err.message : String(err))),
      );
      return DEFERRED_REPLY;
    });

    this.on('deleteFile', (msg: AbjectMessage) => {
      const { path: filePath } = msg.payload as { path: string };
      this.handleDeleteFile(filePath).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => this.send(errorMsg(msg, 'HOSTFS_ERROR', err instanceof Error ? err.message : String(err))),
      );
      return DEFERRED_REPLY;
    });

    this.on('setPermissionsAuthority', async (msg: AbjectMessage) => {
      if (this.permissionsAuthorityId) return { success: false, error: 'Authority already set' };
      this.permissionsAuthorityId = msg.routing.from;
      return { success: true };
    });

    this.on('updatePermissions', async (msg: AbjectMessage) => {
      if (this.permissionsAuthorityId && msg.routing.from !== this.permissionsAuthorityId) {
        return { success: false, error: 'Unauthorized: only the permissions authority can update permissions' };
      }
      const { allowedPaths, readOnly } = msg.payload as {
        allowedPaths?: string[];
        readOnly?: boolean;
      };
      if (allowedPaths !== undefined) {
        this.allowedPaths = allowedPaths.length > 0 ? allowedPaths : undefined;
      }
      if (readOnly !== undefined) {
        this.readOnly = readOnly;
      }
      return { success: true };
    });
  }

  // ─── Implementations ────────────────────────────────────────────

  private async handleReadFile(filePath: string, offset?: number, limit?: number): Promise<{ content: string; lines: number }> {
    contractRequire(typeof filePath === 'string' && filePath.length > 0, 'path must be a non-empty string');
    log.info(`readFile: ${filePath}`);
    await this.validatePath(filePath);

    const content = await fs.readFile(filePath, 'utf-8');
    const allLines = content.split('\n');

    if (offset !== undefined || limit !== undefined) {
      const start = (offset ?? 1) - 1; // Convert 1-based to 0-based
      const end = limit !== undefined ? start + limit : allLines.length;
      const sliced = allLines.slice(Math.max(0, start), end);
      return { content: sliced.join('\n'), lines: sliced.length };
    }

    return { content, lines: allLines.length };
  }

  private async handleWriteFile(filePath: string, content: string): Promise<{ success: boolean }> {
    contractRequire(typeof filePath === 'string' && filePath.length > 0, 'path must be a non-empty string');
    log.info(`writeFile: ${filePath} (${content.length} chars)`);
    this.requireWrite();
    await this.validatePath(filePath);

    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
    return { success: true };
  }

  private async handleEditFile(filePath: string, oldText: string, newText: string): Promise<{ success: boolean; replacements: number }> {
    contractRequire(typeof filePath === 'string' && filePath.length > 0, 'path must be a non-empty string');
    log.info(`editFile: ${filePath}`);
    contractRequire(typeof oldText === 'string' && oldText.length > 0, 'oldText must be a non-empty string');
    this.requireWrite();
    await this.validatePath(filePath);

    const content = await fs.readFile(filePath, 'utf-8');
    let replacements = 0;
    const result = content.replaceAll(oldText, () => {
      replacements++;
      return newText;
    });

    if (replacements === 0) {
      return { success: false, replacements: 0 };
    }

    await fs.writeFile(filePath, result, 'utf-8');
    return { success: true, replacements };
  }

  private async handleGlob(pattern: string, cwd?: string): Promise<{ files: string[] }> {
    contractRequire(typeof pattern === 'string' && pattern.length > 0, 'pattern must be a non-empty string');
    log.info(`glob: ${pattern} (cwd=${cwd ?? 'default'})`);
    const baseDir = cwd ?? process.cwd();
    await this.validatePath(baseDir);

    // Simple recursive glob implementation using fs
    const files = await this.walkGlob(baseDir, pattern);
    return { files };
  }

  private async handleGrep(
    pattern: string,
    searchPath?: string,
    globFilter?: string,
    maxResults?: number,
  ): Promise<{ matches: Array<{ file: string; line: number; content: string }> }> {
    contractRequire(typeof pattern === 'string' && pattern.length > 0, 'pattern must be a non-empty string');
    log.info(`grep: ${pattern} (path=${searchPath ?? 'cwd'}, glob=${globFilter ?? 'none'})`);

    const baseDir = searchPath ?? process.cwd();
    await this.validatePath(baseDir);

    const regex = new RegExp(pattern);
    const max = maxResults ?? 100;
    const matches: Array<{ file: string; line: number; content: string }> = [];

    const stat = await fs.stat(baseDir);
    if (stat.isFile()) {
      await this.grepFile(baseDir, regex, matches, max);
    } else {
      const files = globFilter
        ? await this.walkGlob(baseDir, globFilter)
        : await this.walkDir(baseDir);

      for (const file of files) {
        if (matches.length >= max) break;
        await this.grepFile(file, regex, matches, max);
      }
    }

    return { matches };
  }

  private async handleStat(filePath: string): Promise<FileInfo> {
    contractRequire(typeof filePath === 'string' && filePath.length > 0, 'path must be a non-empty string');
    await this.validatePath(filePath);

    const stat = await fs.stat(filePath);
    return {
      path: filePath,
      name: path.basename(filePath),
      isDirectory: stat.isDirectory(),
      size: stat.size,
      modifiedAt: stat.mtimeMs,
    };
  }

  private async handleMkdir(dirPath: string): Promise<{ success: boolean }> {
    contractRequire(typeof dirPath === 'string' && dirPath.length > 0, 'path must be a non-empty string');
    this.requireWrite();
    await this.validatePath(dirPath);

    await fs.mkdir(dirPath, { recursive: true });
    return { success: true };
  }

  private async handleReaddir(dirPath: string): Promise<{ entries: Array<{ name: string; isDirectory: boolean }> }> {
    contractRequire(typeof dirPath === 'string' && dirPath.length > 0, 'path must be a non-empty string');
    await this.validatePath(dirPath);

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return {
      entries: entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() })),
    };
  }

  private async handleExists(filePath: string): Promise<{ exists: boolean }> {
    contractRequire(typeof filePath === 'string' && filePath.length > 0, 'path must be a non-empty string');
    await this.validatePath(filePath);

    try {
      await fs.access(filePath);
      return { exists: true };
    } catch {
      return { exists: false };
    }
  }

  private async handleDeleteFile(filePath: string): Promise<{ success: boolean }> {
    contractRequire(typeof filePath === 'string' && filePath.length > 0, 'path must be a non-empty string');
    this.requireWrite();
    await this.validatePath(filePath);

    await fs.unlink(filePath);
    return { success: true };
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private async validatePath(p: string): Promise<void> {
    const resolved = path.resolve(p);
    if (this.allowedPaths?.some(ap => resolved.startsWith(path.resolve(ap)))) return;

    // Path not in allow list -- ask the permissions authority
    if (this.permissionsAuthorityId) {
      const response = await this.request<{ decision: string }>(
        request(this.id, this.permissionsAuthorityId, 'requestPermission', {
          type: 'directory',
          resource: resolved,
          description: `Filesystem access: ${resolved}`,
        }),
        120000,
      );

      switch (response.decision) {
        case 'accept_always':
          if (!this.allowedPaths) this.allowedPaths = [];
          this.allowedPaths.push(resolved);
          return;
        case 'accept_once':
          return;
        case 'deny_always':
        case 'deny':
        default:
          throw new Error(`Access to "${p}" was denied by user`);
      }
    }

    throw new Error(`Path "${p}" is not allowed. Configure permissions in Settings > Permissions.`);
  }

  private requireWrite(): void {
    if (this.readOnly) {
      throw new Error('HostFileSystem is in read-only mode');
    }
  }

  /** Walk a directory recursively and return all file paths. */
  private async walkDir(dir: string, maxFiles = 10000): Promise<string[]> {
    const result: string[] = [];
    const stack = [dir];

    while (stack.length > 0 && result.length < maxFiles) {
      const current = stack.pop()!;
      let entries;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue; // Skip unreadable directories
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else {
          result.push(full);
          if (result.length >= maxFiles) break;
        }
      }
    }

    return result;
  }

  /** Simple glob matching using minimatch-like patterns. */
  private async walkGlob(baseDir: string, pattern: string): Promise<string[]> {
    const allFiles = await this.walkDir(baseDir);
    const regex = globToRegex(pattern);
    return allFiles.filter(f => {
      const relative = path.relative(baseDir, f);
      return regex.test(relative);
    });
  }

  /** Search a file for regex matches. */
  private async grepFile(
    filePath: string,
    regex: RegExp,
    matches: Array<{ file: string; line: number; content: string }>,
    max: number,
  ): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      return; // Skip unreadable files
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length && matches.length < max; i++) {
      if (regex.test(lines[i])) {
        matches.push({ file: filePath, line: i + 1, content: lines[i] });
      }
    }
  }

  protected override askPrompt(_question: string): string {
    const lines = [
      `## HostFileSystem Usage Guide`,
      ``,
      `### Read a file`,
      `  const result = await this.call(this.dep('HostFileSystem'), 'readFile',`,
      `    { path: '/absolute/path/to/file.txt' });`,
      `  // result = { content: '...', lines: 42 }`,
      ``,
      `### Write a file`,
      `  await this.call(this.dep('HostFileSystem'), 'writeFile',`,
      `    { path: '/absolute/path/to/file.txt', content: 'hello' });`,
      ``,
      `### Search files by pattern (glob)`,
      `  const files = await this.call(this.dep('HostFileSystem'), 'glob',`,
      `    { pattern: '**/*.ts', cwd: '/project/src' });`,
      ``,
      `### Search file contents (grep)`,
      `  const matches = await this.call(this.dep('HostFileSystem'), 'grep',`,
      `    { pattern: 'TODO', cwd: '/project', glob: '*.ts' });`,
      ``,
      `### Restrictions`,
    ];

    if (this.readOnly) {
      lines.push(`Filesystem is in READ-ONLY mode. Write, edit, mkdir, and delete are blocked.`);
    }
    if (this.allowedPaths && this.allowedPaths.length > 0) {
      lines.push(`Allowed directories: ${this.allowedPaths.join(', ')}`);
    } else if (!this.allowedPaths) {
      lines.push(`No path restrictions configured.`);
    } else {
      lines.push(`No directories are allowed. All access will be denied.`);
    }

    return super.askPrompt(_question) + '\n\n' + lines.join('\n');
  }
}

/**
 * Convert a glob pattern to a regex. Handles **, *, and ? wildcards.
 */
function globToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      regex += '.*';
      i += 2;
      if (pattern[i] === '/') i++; // Skip separator after **
    } else if (c === '*') {
      regex += '[^/]*';
      i++;
    } else if (c === '?') {
      regex += '[^/]';
      i++;
    } else if (c === '.') {
      regex += '\\.';
      i++;
    } else {
      regex += c;
      i++;
    }
  }
  return new RegExp(`^${regex}$`);
}

export const HOST_FILESYSTEM_ID = 'abjects:host-filesystem' as AbjectId;
