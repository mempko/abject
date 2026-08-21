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
import * as os from 'os';
import { AbjectId, AbjectMessage, InterfaceId } from '../../core/types.js';
import { Abject, DEFERRED_REPLY } from '../../core/abject.js';
import { error as errorMsg, request } from '../../core/message.js';
import { Capabilities } from '../../core/capability.js';
import { require as contractRequire } from '../../core/contracts.js';
import {
  truncateHead, continuationNotice, formatSize,
  DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES,
} from '../../core/tool-output.js';
import { IgnoreSet } from '../../core/ignore-rules.js';
import { applyEdits, formatEditFailures, type FileEdit } from '../../core/file-edit.js';
import { withFileMutationQueue } from '../../core/file-mutation-queue.js';
import { Log } from '../../core/timed-log.js';
import { isInsideAny } from '../../core/path-scope.js';

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
          'Provides real filesystem access on the host. Read and write files, edit them with exact-text ' +
          'change-sets, list directories, search by filename pattern, and search contents with regex. ' +
          'Reads and searches are bounded and .gitignore-aware, so results stay a readable size.',
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
                { name: 'maxBytes', type: { kind: 'primitive', primitive: 'number' }, description: 'Byte budget for this read; 0 reads the whole file (default 50KB)', optional: true },
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
              name: 'edit',
              description:
                'Apply a whole set of exact-text replacements to one file as a single transaction. ' +
                'Every oldText is matched against the original file and must be unique and non-overlapping; ' +
                'if any edit fails, nothing is written and all failures are reported together.',
              parameters: [
                { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'Absolute file path' },
                { name: 'edits', type: { kind: 'array', elementType: { kind: 'object', properties: {
                  oldText: { kind: 'primitive', primitive: 'string' },
                  newText: { kind: 'primitive', primitive: 'string' },
                }}}, description: 'Replacements, each { oldText, newText }' },
              ],
              returns: { kind: 'object', properties: {
                success: { kind: 'primitive', primitive: 'boolean' },
                applied: { kind: 'primitive', primitive: 'number' },
                diff: { kind: 'primitive', primitive: 'string' },
                error: { kind: 'primitive', primitive: 'string' },
              }},
            },
            {
              name: 'ls',
              description: 'List a directory, sorted, with a trailing slash on directories',
              parameters: [
                { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'Absolute directory path' },
                { name: 'limit', type: { kind: 'primitive', primitive: 'number' }, description: 'Maximum entries (default 500)', optional: true },
              ],
              returns: { kind: 'object', properties: {
                entries: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
                truncated: { kind: 'primitive', primitive: 'boolean' },
              }},
            },
            {
              name: 'glob',
              description: 'Find files matching a glob pattern, skipping .gitignore-d and build directories',
              parameters: [
                { name: 'pattern', type: { kind: 'primitive', primitive: 'string' }, description: 'Glob pattern (e.g. "**/*.ts")' },
                { name: 'cwd', type: { kind: 'primitive', primitive: 'string' }, description: 'Base directory', optional: true },
                { name: 'limit', type: { kind: 'primitive', primitive: 'number' }, description: 'Maximum results (default 1000)', optional: true },
              ],
              returns: { kind: 'object', properties: {
                files: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
                truncated: { kind: 'primitive', primitive: 'boolean' },
              }},
            },
            {
              name: 'grep',
              description: 'Search file contents with a regex pattern',
              parameters: [
                { name: 'pattern', type: { kind: 'primitive', primitive: 'string' }, description: 'Regex pattern to search for' },
                { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'File or directory to search in', optional: true },
                { name: 'glob', type: { kind: 'primitive', primitive: 'string' }, description: 'Glob filter for files (e.g. "*.ts")', optional: true },
                { name: 'maxResults', type: { kind: 'primitive', primitive: 'number' }, description: 'Maximum number of matches (default 100)', optional: true },
                { name: 'ignoreCase', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Case-insensitive search', optional: true },
                { name: 'context', type: { kind: 'primitive', primitive: 'number' }, description: 'Lines of context around each match', optional: true },
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
              name: 'grantPath',
              description:
                'Ask for standing access to a directory. Goes through the same user prompt as any ' +
                'other access, so it grants nothing on its own — it just moves the question to a ' +
                'moment when the user has context (registering a project) instead of mid-task.',
              parameters: [
                { name: 'path', type: { kind: 'primitive', primitive: 'string' }, description: 'Absolute directory path' },
              ],
              returns: { kind: 'object', properties: {
                granted: { kind: 'primitive', primitive: 'boolean' },
                path: { kind: 'primitive', primitive: 'string' },
              }},
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
      const { path: filePath, offset, limit, maxBytes } =
        msg.payload as { path: string; offset?: number; limit?: number; maxBytes?: number };
      this.handleReadFile(filePath, offset, limit, maxBytes).then(
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

    this.on('edit', (msg: AbjectMessage) => {
      const { path: filePath, edits } = msg.payload as { path: string; edits: FileEdit[] };
      this.handleEdit(filePath, edits).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => this.send(errorMsg(msg, 'HOSTFS_ERROR', err instanceof Error ? err.message : String(err))),
      );
      return DEFERRED_REPLY;
    });

    this.on('ls', (msg: AbjectMessage) => {
      const { path: dirPath, limit } = msg.payload as { path: string; limit?: number };
      this.handleLs(dirPath, limit).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => this.send(errorMsg(msg, 'HOSTFS_ERROR', err instanceof Error ? err.message : String(err))),
      );
      return DEFERRED_REPLY;
    });

    this.on('glob', (msg: AbjectMessage) => {
      const { pattern, cwd, limit } = msg.payload as { pattern: string; cwd?: string; limit?: number };
      this.handleGlob(pattern, cwd, limit).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => this.send(errorMsg(msg, 'HOSTFS_ERROR', err instanceof Error ? err.message : String(err))),
      );
      return DEFERRED_REPLY;
    });

    this.on('grep', (msg: AbjectMessage) => {
      const { pattern, path: searchPath, glob: globFilter, maxResults, ignoreCase, context } =
        msg.payload as {
          pattern: string; path?: string; glob?: string;
          maxResults?: number; ignoreCase?: boolean; context?: number;
        };
      this.handleGrep(pattern, searchPath, globFilter, maxResults, ignoreCase, context).then(
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

    this.on('grantPath', (msg: AbjectMessage) => {
      const { path: dirPath } = msg.payload as { path: string };
      // validateAndResolve IS the permission gate: it returns for an already
      // allowed path and otherwise prompts the authority, adding to the allow
      // list only on an explicit "always". Nothing here can widen access that
      // the user did not widen.
      this.validateAndResolve(dirPath).then(
        (resolved) => this.sendDeferredReply(msg, { granted: true, path: resolved }),
        (err) => this.sendDeferredReply(msg, {
          granted: false,
          path: dirPath,
          error: err instanceof Error ? err.message : String(err),
        }),
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

  private async handleReadFile(
    filePath: string,
    offset?: number,
    limit?: number,
    maxBytes?: number,
  ): Promise<{
    content: string; lines: number; totalLines: number;
    truncated: boolean; nextOffset?: number;
  }> {
    contractRequire(typeof filePath === 'string' && filePath.length > 0, 'path must be a non-empty string');
    log.info(`readFile: ${filePath}`);
    filePath = await this.validateAndResolve(filePath);

    const content = await fs.readFile(filePath, 'utf-8');
    const allLines = content.split('\n');
    const totalLines = allLines.length;

    const startLine = Math.max(0, (offset ?? 1) - 1);
    if (startLine >= totalLines && totalLines > 0) {
      throw new Error(`offset ${offset} is past the end of the file (${totalLines} lines)`);
    }

    // An explicit limit is honored first; the budget only trims what is left.
    const userEnd = limit !== undefined ? Math.min(startLine + limit, totalLines) : totalLines;
    const selected = allLines.slice(startLine, userEnd).join('\n');

    // `maxBytes: 0` is the documented escape for "give me the whole file", so
    // it lifts the line budget too. Lifting only the byte budget would still
    // stop at 2000 lines, which is the opposite of what the caller asked for.
    const unbounded = maxBytes === 0;
    const t = truncateHead(selected, unbounded
      ? { maxBytes: 0, maxLines: 0 }
      : { maxBytes: maxBytes ?? DEFAULT_MAX_BYTES });

    if (t.firstLineExceedsLimit) {
      const size = formatSize(Buffer.byteLength(allLines[startLine] ?? '', 'utf-8'));
      return {
        content:
          `[Line ${startLine + 1} alone is ${size}, past this read's byte budget. ` +
          `Reach it with bash: sed -n '${startLine + 1}p' ${filePath} | head -c ${DEFAULT_MAX_BYTES}]`,
        lines: 0,
        totalLines,
        truncated: true,
        nextOffset: startLine + 2,
      };
    }

    if (t.truncated) {
      const nextOffset = startLine + t.outputLines + 1;
      return {
        content: t.content + continuationNotice(t, startLine + 1, totalLines),
        lines: t.outputLines,
        totalLines,
        truncated: true,
        nextOffset,
      };
    }

    // Not budget-truncated, but the caller's own limit may have stopped short.
    if (userEnd < totalLines) {
      const remaining = totalLines - userEnd;
      return {
        content: `${t.content}\n\n[${remaining} more line${remaining === 1 ? '' : 's'} in file. Use offset=${userEnd + 1} to continue.]`,
        lines: t.outputLines,
        totalLines,
        truncated: true,
        nextOffset: userEnd + 1,
      };
    }

    return { content: t.content, lines: t.outputLines, totalLines, truncated: false };
  }

  private async handleWriteFile(filePath: string, content: string): Promise<{ success: boolean }> {
    contractRequire(typeof filePath === 'string' && filePath.length > 0, 'path must be a non-empty string');
    log.info(`writeFile: ${filePath} (${content.length} chars)`);
    this.requireWrite();
    filePath = await this.validateAndResolve(filePath);

    return withFileMutationQueue(filePath, async () => {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await this.atomicWrite(filePath, content);
      return { success: true };
    });
  }

  private async handleEditFile(filePath: string, oldText: string, newText: string): Promise<{ success: boolean; replacements: number }> {
    contractRequire(typeof filePath === 'string' && filePath.length > 0, 'path must be a non-empty string');
    log.info(`editFile: ${filePath}`);
    contractRequire(typeof oldText === 'string' && oldText.length > 0, 'oldText must be a non-empty string');
    this.requireWrite();
    filePath = await this.validateAndResolve(filePath);

    // Read-modify-write: the read and the write have to be one turn, or a
    // concurrent edit between them is lost.
    return withFileMutationQueue(filePath, async () => {
      const content = await fs.readFile(filePath, 'utf-8');
      let replacements = 0;
      const result = content.replaceAll(oldText, () => {
        replacements++;
        return newText;
      });

      if (replacements === 0) {
        return { success: false, replacements: 0 };
      }

      await this.atomicWrite(filePath, result);
      return { success: true, replacements };
    });
  }

  /**
   * Apply an exact-text change-set as one transaction. The all-or-nothing
   * contract lives in core/file-edit.ts; this method owns only permission,
   * IO, and the atomic replace.
   */
  private async handleEdit(
    filePath: string,
    edits: FileEdit[],
  ): Promise<{ success: boolean; applied: number; diff?: string; error?: string; changedLines?: number[] }> {
    contractRequire(typeof filePath === 'string' && filePath.length > 0, 'path must be a non-empty string');
    contractRequire(Array.isArray(edits) && edits.length > 0, 'edits must be a non-empty array');
    log.info(`edit: ${filePath} (${edits.length} edit${edits.length === 1 ? '' : 's'})`);
    this.requireWrite();
    filePath = await this.validateAndResolve(filePath);

    // The whole read-validate-write cycle holds the file: every oldText is
    // matched against the content this call read, so another mutation landing
    // mid-cycle would make the diff describe a file that never existed.
    return withFileMutationQueue(filePath, async () => {
      const original = await fs.readFile(filePath, 'utf-8');
      const result = applyEdits(original, edits);
      if (!result.ok) {
        return { success: false, applied: 0, error: formatEditFailures(result.failures) };
      }

      await this.atomicWrite(filePath, result.content);
      return {
        success: true,
        applied: result.applied,
        diff: result.diff,
        changedLines: result.changedLines,
      };
    });
  }

  private async handleLs(dirPath: string, limit?: number): Promise<{ entries: string[]; truncated: boolean }> {
    contractRequire(typeof dirPath === 'string' && dirPath.length > 0, 'path must be a non-empty string');
    const max = limit ?? 500;
    dirPath = await this.validateAndResolve(dirPath);

    const raw = await fs.readdir(dirPath, { withFileTypes: true });
    const entries = raw
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => a.localeCompare(b));
    return { entries: entries.slice(0, max), truncated: entries.length > max };
  }

  private async handleGlob(
    pattern: string,
    cwd?: string,
    limit?: number,
  ): Promise<{ files: string[]; truncated: boolean }> {
    contractRequire(typeof pattern === 'string' && pattern.length > 0, 'pattern must be a non-empty string');
    log.info(`glob: ${pattern} (cwd=${cwd ?? 'default'})`);
    const max = limit ?? 1000;
    const resolvedBase = await this.validateAndResolve(cwd ?? process.cwd());

    const regex = globToRegex(pattern);
    const files = await this.walkDir(resolvedBase, max + 1, (abs) => {
      const rel = path.relative(resolvedBase, abs).split(path.sep).join('/');
      return regex.test(rel);
    });
    return { files: files.slice(0, max), truncated: files.length > max };
  }

  private async handleGrep(
    pattern: string,
    searchPath?: string,
    globFilter?: string,
    maxResults?: number,
    ignoreCase?: boolean,
    context?: number,
  ): Promise<{
    matches: Array<{ file: string; line: number; content: string; before?: string[]; after?: string[] }>;
    truncated: boolean;
    filesSearched: number;
  }> {
    contractRequire(typeof pattern === 'string' && pattern.length > 0, 'pattern must be a non-empty string');
    log.info(`grep: ${pattern} (path=${searchPath ?? 'cwd'}, glob=${globFilter ?? 'none'})`);

    const resolvedBase = await this.validateAndResolve(searchPath ?? process.cwd());
    const regex = new RegExp(pattern, ignoreCase ? 'i' : undefined);
    const max = maxResults ?? 100;
    const ctx = Math.max(0, Math.min(context ?? 0, 10));
    const matches: Array<{ file: string; line: number; content: string; before?: string[]; after?: string[] }> = [];

    const stat = await fs.stat(resolvedBase);
    let filesSearched = 0;

    if (stat.isFile()) {
      filesSearched = 1;
      await this.grepFile(resolvedBase, regex, matches, max + 1, ctx);
    } else {
      const globRegex = globFilter ? globToRegex(globFilter) : undefined;
      const files = await this.walkDir(resolvedBase, 20000, (abs) => {
        if (!globRegex) return true;
        const rel = path.relative(resolvedBase, abs).split(path.sep).join('/');
        return globRegex.test(rel);
      });
      for (const file of files) {
        if (matches.length > max) break;
        filesSearched++;
        await this.grepFile(file, regex, matches, max + 1, ctx);
      }
    }

    return { matches: matches.slice(0, max), truncated: matches.length > max, filesSearched };
  }

  private async handleStat(filePath: string): Promise<FileInfo> {
    contractRequire(typeof filePath === 'string' && filePath.length > 0, 'path must be a non-empty string');
    filePath = await this.validateAndResolve(filePath);

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
    dirPath = await this.validateAndResolve(dirPath);

    await fs.mkdir(dirPath, { recursive: true });
    return { success: true };
  }

  private async handleReaddir(dirPath: string): Promise<{ entries: Array<{ name: string; isDirectory: boolean }> }> {
    contractRequire(typeof dirPath === 'string' && dirPath.length > 0, 'path must be a non-empty string');
    dirPath = await this.validateAndResolve(dirPath);

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return {
      entries: entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() })),
    };
  }

  private async handleExists(filePath: string): Promise<{ exists: boolean }> {
    contractRequire(typeof filePath === 'string' && filePath.length > 0, 'path must be a non-empty string');
    filePath = await this.validateAndResolve(filePath);

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
    filePath = await this.validateAndResolve(filePath);

    return withFileMutationQueue(filePath, async () => {
      await fs.unlink(filePath);
      return { success: true };
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────

  /** Expand ~ and resolve to an absolute path. */
  private resolvePath(p: string): string {
    if (p.startsWith('~/') || p === '~') {
      return path.resolve(path.join(os.homedir(), p.slice(1)));
    }
    return path.resolve(p);
  }

  /** Validate a path and return the resolved absolute path (with ~ expanded). */
  private async validateAndResolve(p: string): Promise<string> {
    const resolved = this.resolvePath(p);
    // Boundary-aware: a raw prefix test would let a grant on
    // /home/me/project also cover /home/me/project-secrets.
    if (isInsideAny(this.allowedPaths, resolved)) return resolved;

    // Path not in allow list -- ask the permissions authority
    if (this.permissionsAuthorityId) {
      const response = await this.request<{ decision: string }>(
        request(this.id, this.permissionsAuthorityId, 'requestPermission', {
          type: 'directory',
          resource: resolved,
          description: `Filesystem access: ${resolved}`,
        }),
        // A user may be away; the authority queues prompts rather than
        // refusing them, so waiting here waits for a person, not a deadlock.
        31 * 60 * 1000,
      );

      switch (response.decision) {
        case 'accept_always':
          if (!this.allowedPaths) this.allowedPaths = [];
          this.allowedPaths.push(resolved);
          return resolved;
        case 'accept_once':
          return resolved;
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

  /**
   * Walk a directory, honoring .gitignore at every level and the always-skipped
   * build directories. `accept` filters which files are collected; the walk
   * still descends into directories it does not collect from.
   *
   * Bounded by `maxFiles`, and callers pass one more than they need so a full
   * result set is distinguishable from a truncated one.
   */
  private async walkDir(
    dir: string,
    maxFiles = 10000,
    accept?: (absolutePath: string) => boolean,
  ): Promise<string[]> {
    const result: string[] = [];
    const rootIgnores = await IgnoreSet.empty().extend(dir);
    const stack: Array<{ path: string; ignores: IgnoreSet }> = [{ path: dir, ignores: rootIgnores }];

    while (stack.length > 0 && result.length < maxFiles) {
      const current = stack.pop()!;
      let entries;
      try {
        entries = await fs.readdir(current.path, { withFileTypes: true });
      } catch {
        continue; // Unreadable directory: skip rather than fail the whole walk.
      }

      for (const entry of entries) {
        const full = path.join(current.path, entry.name);
        const isDir = entry.isDirectory();
        if (current.ignores.ignores(full, isDir)) continue;

        if (isDir) {
          // A nested .gitignore only governs its own subtree.
          stack.push({ path: full, ignores: await current.ignores.extend(full) });
        } else {
          if (accept && !accept(full)) continue;
          result.push(full);
          if (result.length >= maxFiles) break;
        }
      }
    }

    return result;
  }

  /** Search one file, collecting matches with optional surrounding context. */
  private async grepFile(
    filePath: string,
    regex: RegExp,
    matches: Array<{ file: string; line: number; content: string; before?: string[]; after?: string[] }>,
    max: number,
    contextLines = 0,
  ): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      return; // Unreadable or binary: skip.
    }
    // A NUL in the first block means binary; grepping it produces noise.
    if (content.indexOf('\u0000') !== -1) return;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length && matches.length < max; i++) {
      if (!regex.test(lines[i])) continue;
      const hit: { file: string; line: number; content: string; before?: string[]; after?: string[] } = {
        file: filePath,
        line: i + 1,
        content: truncateLine(lines[i]),
      };
      if (contextLines > 0) {
        hit.before = lines.slice(Math.max(0, i - contextLines), i).map(truncateLine);
        hit.after = lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines)).map(truncateLine);
      }
      matches.push(hit);
    }
  }

  /**
   * Write through a temp file in the same directory, then rename. A crash or a
   * failed write leaves the original intact rather than a half-written file,
   * which matters when the thing being edited is source an agent will read back.
   */
  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const tmp = `${filePath}.abjects-tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.writeFile(tmp, content, 'utf-8');
      await fs.rename(tmp, filePath);
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* nothing to clean up */ }
      throw err;
    }
  }

  protected override askPrompt(_question: string): string {
    const lines = [
      `## HostFileSystem Usage Guide`,
      ``,
      `Reads and searches are bounded (${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}, whichever comes first)`,
      `and skip .gitignore-d and build directories, so a result set stays readable.`,
      ``,
      `### Read a file`,
      `  const r = await this.call(this.dep('HostFileSystem'), 'readFile',`,
      `    { path: '/abs/path/file.ts' });`,
      `  // { content, lines, totalLines, truncated, nextOffset? }`,
      `  // When truncated, continue with { path, offset: r.nextOffset }.`,
      `  // Pass maxBytes: 0 only when you genuinely need the whole file at once.`,
      ``,
      `### Edit a file (the normal way to change one)`,
      `  const r = await this.call(this.dep('HostFileSystem'), 'edit', {`,
      `    path: '/abs/path/file.ts',`,
      `    edits: [`,
      `      { oldText: 'const a = 1;', newText: 'const a = 2;' },`,
      `      { oldText: 'function b() {', newText: 'function b(x) {' },`,
      `    ],`,
      `  });`,
      `  // { success, applied, diff, changedLines } or { success: false, error }`,
      `  // Every oldText is matched against the ORIGINAL file, must be unique, and`,
      `  // must not overlap another edit. If any fails, NOTHING is written and all`,
      `  // failures come back together. Keep oldText as short as it can be while`,
      `  // still unique; do not pad it with unchanged lines.`,
      ``,
      `### Write a file (new files and full rewrites only)`,
      `  await this.call(this.dep('HostFileSystem'), 'writeFile',`,
      `    { path: '/abs/path/file.ts', content: '...' });`,
      ``,
      `### List a directory`,
      `  await this.call(this.dep('HostFileSystem'), 'ls', { path: '/abs/dir' });`,
      ``,
      `### Find files by name (glob)`,
      `  await this.call(this.dep('HostFileSystem'), 'glob',`,
      `    { pattern: '**/*.ts', cwd: '/project/src' });`,
      ``,
      `### Search contents (grep)`,
      `  await this.call(this.dep('HostFileSystem'), 'grep',`,
      `    { pattern: 'TODO', path: '/project', glob: '*.ts', context: 2 });`,
      `  // { matches: [{ file, line, content, before?, after? }], truncated, filesSearched }`,
      `  // grep reports line numbers; that is how you turn a compiler error's`,
      `  // file:line into the unique text an edit needs.`,
      ``,
      `### Concurrency`,
      `Mutations to the SAME file are serialized, so two overlapping edits cannot`,
      `lose each other's change; mutations to different files stay concurrent.`,
      `Reads never wait: writes land by atomic rename, so a read sees the whole`,
      `old file or the whole new one, never a half-written one.`,
      ``,
      `### Restrictions`,
    ];

    return super.askPrompt(_question) + '\n\n' + lines.join('\n');
  }
}

/** Longest single line worth returning from a search hit. */
const GREP_MAX_LINE_LENGTH = 500;

/** Keep one very long line (a minified bundle, a data row) from eating a result set. */
function truncateLine(line: string): string {
  return line.length <= GREP_MAX_LINE_LENGTH
    ? line
    : `${line.slice(0, GREP_MAX_LINE_LENGTH)}… [+${line.length - GREP_MAX_LINE_LENGTH} chars]`;
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
