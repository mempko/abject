/**
 * Where FileSystem and CollectionStore keep their data on disk.
 *
 * Every instance keeps all of its data in one directory, ABJECTS_DATA_DIR
 * (absolute in an install; `.abjects` under the working directory in a source
 * checkout), resolved here exactly as NodeStorage resolves it. Data that
 * belongs to one workspace sits in `ws-<workspaceId>/` beside that
 * workspace's storage.db; data that belongs to the instance as a whole sits
 * at the top, beside the instance's storage.db:
 *
 *   <dataDir>/collections.db           CollectionStore with no workspace
 *   <dataDir>/files/                   FileSystem with no workspace
 *   <dataDir>/ws-<id>/collections.db   a workspace's CollectionStore
 *   <dataDir>/ws-<id>/files/           a workspace's FileSystem
 *
 * Older builds kept these two under the person's home directory instead
 * (`~/.abject/ws-<id>/`, `~/.abject/shared/files`,
 * `~/.abject/global/collections.db`), so instances with different data
 * directories shared them and a backup of the data directory missed them.
 * `~/.abject` is now the install root (versions, current, bin, downloads).
 * moveLegacyData() moves the old data into the data directory once, the
 * first time each object opens it, and never touches the install's entries.
 *
 * Plain functions, no Abject: the objects call them while opening their data,
 * possibly in a pool worker thread. Workers share the process's environment
 * and working directory, so every thread resolves the same absolute path.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { require, ensure, requireNonEmpty } from '../core/contracts.js';
import type { Log } from '../core/timed-log.js';

/** The data directory of a source checkout, relative to the working directory. */
const DEFAULT_DATA_DIR = '.abjects';

/** Prefix of a workspace's directory, in the data directory and in the old home location. */
const WORKSPACE_DIR_PREFIX = 'ws-';

/** The old home location, now also the install root. */
const LEGACY_HOME_DIR = '.abject';

/** Entries of ~/.abject that belong to the installer; nothing here moves or removes them. */
const INSTALL_ENTRIES: ReadonlySet<string> = new Set(['versions', 'current', 'bin', 'downloads']);

/** What moveLegacyData did. */
export type LegacyMoveOutcome =
  /** Nothing to move: no old data, or the old and new places are the same. */
  | 'none'
  /** The old data now lives at the new place. */
  | 'moved'
  /** Both existed; the new data was kept and the old left where it was. */
  | 'kept'
  /** The move failed; the old data is untouched where it was. */
  | 'failed';

/** True when `id` can name a directory without leaving its parent. */
function isPathSegment(id: string): boolean {
  return id.length > 0 && id !== '.' && id !== '..' && !/[\\/]/.test(id) && !id.includes('\0');
}

/** The absolute data directory of this instance. */
export function instanceDataDir(): string {
  const dir = path.resolve(process.env.ABJECTS_DATA_DIR ?? DEFAULT_DATA_DIR);
  ensure(path.isAbsolute(dir), 'the data directory resolves to an absolute path');
  return dir;
}

/**
 * The directory holding one workspace's data (`<dataDir>/ws-<id>`), or the
 * data directory itself for data that belongs to no workspace.
 */
export function workspaceDataDir(workspaceId?: string): string {
  require(workspaceId === undefined || isPathSegment(workspaceId),
    `workspaceId must be a single path segment, got '${workspaceId}'`);
  const root = instanceDataDir();
  const dir = workspaceId === undefined ? root : path.join(root, `${WORKSPACE_DIR_PREFIX}${workspaceId}`);
  ensure(path.isAbsolute(dir), 'a workspace data directory is absolute');
  return dir;
}

/** The old home directory, `~/.abject`. */
function legacyHomeRoot(): string {
  return path.join(os.homedir(), LEGACY_HOME_DIR);
}

/**
 * Where older builds kept one workspace's data (`~/.abject/ws-<id>`), or,
 * with no workspace, the named instance-wide entry (`~/.abject/<unscoped>`).
 */
export function legacyHomeDataDir(workspaceId: string | undefined, unscoped: string): string {
  require(workspaceId === undefined || isPathSegment(workspaceId),
    `workspaceId must be a single path segment, got '${workspaceId}'`);
  require(isPathSegment(unscoped), `unscoped entry must be a single path segment, got '${unscoped}'`);
  require(!INSTALL_ENTRIES.has(unscoped), `'${unscoped}' belongs to the install, not to an instance`);
  const entry = workspaceId === undefined ? unscoped : `${WORKSPACE_DIR_PREFIX}${workspaceId}`;
  const dir = path.join(legacyHomeRoot(), entry);
  ensure(path.dirname(dir) === legacyHomeRoot(), 'a legacy data directory is a direct child of ~/.abject');
  return dir;
}

/** The entry of ~/.abject that `p` lives in, or undefined when `p` is not inside it. */
function legacyEntryOf(p: string): string | undefined {
  const rel = path.relative(legacyHomeRoot(), p);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep)[0];
}

/** True when `a` is `b` or lies inside it. */
function isWithin(a: string, b: string): boolean {
  const rel = path.relative(b, a);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Move one path, copying then removing only when a rename cannot cross devices. */
function movePath(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    try {
      fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    } catch (copyErr) {
      // A partial copy must not later pass for the real data.
      fs.rmSync(to, { recursive: true, force: true });
      throw copyErr;
    }
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Move a file or directory from its old place under `~/.abject` to its place
 * in the data directory, once. `companions` are suffixes of paths that travel
 * with it (an SQLite database's `-wal` and `-shm`). When both places exist the
 * new one is kept and the old one is left alone. A failed move leaves the old
 * data where it was. Logs one line whenever there was old data to consider.
 */
export function moveLegacyData(
  from: string,
  to: string,
  what: string,
  log: Log,
  companions: readonly string[] = [],
): LegacyMoveOutcome {
  require(path.isAbsolute(from) && path.isAbsolute(to), 'legacy move paths must be absolute');
  requireNonEmpty(what, 'what');
  const entry = legacyEntryOf(from);
  require(entry !== undefined, `only data under ${legacyHomeRoot()} moves, not ${from}`);
  require(!INSTALL_ENTRIES.has(entry), `${from} belongs to the install and never moves`);
  require(companions.every(s => s.length > 0 && !/[\\/]/.test(s)), 'companion suffixes stay in the same directory');

  // Same place, or one inside the other (a data directory under ~/.abject):
  // there is nothing to move.
  if (isWithin(from, to) || isWithin(to, from)) return 'none';
  if (!fs.existsSync(from)) return 'none';
  if (fs.existsSync(to)) {
    log.info(`Old ${what} left in place at ${from}; keeping ${to}`);
    return 'kept';
  }

  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    movePath(from, to);
    for (const suffix of companions) {
      if (fs.existsSync(from + suffix) && !fs.existsSync(to + suffix)) movePath(from + suffix, to + suffix);
    }
  } catch (err) {
    log.warn(`Could not move old ${what} from ${from} to ${to}; it was left in place: ${
      err instanceof Error ? err.message : String(err)}`);
    return 'failed';
  }

  // The old workspace directory goes once both of its objects have moved out;
  // rmdir refuses while anything is left in it. ~/.abject itself stays.
  const oldParent = path.dirname(from);
  if (oldParent !== legacyHomeRoot()) {
    try { fs.rmdirSync(oldParent); } catch { /* still holds the other object's data */ }
  }

  log.info(`Moved ${what} from ${from} to ${to}`);
  ensure(fs.existsSync(to), 'moved data exists at its new place');
  ensure(!fs.existsSync(from), 'moved data is gone from its old place');
  return 'moved';
}
