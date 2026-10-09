/**
 * instance.json -- how a running backend is found, and the one-per-data-dir lock.
 *
 * A backend writes `<dataDir>/instance.json` once its sockets are bound: its
 * pid, which edition it is (desktop or headless), its version, its ports, and
 * an owner token. The `abject` command reads it to find the backend for a data
 * directory (whichever edition is running), and a second backend reads it to
 * refuse to start against data another one is using: two backends on the same
 * SQLite files and ports do not fail cleanly.
 *
 * The owner token is a secret that lets a local terminal in even when a login
 * is required. Anyone who can read the data directory owns the instance anyway
 * (its storage holds every key), so the file is readable by its owner only.
 *
 * Plain functions: the launcher reads this before any object exists.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { require as contractRequire, ensure } from '../src/core/contracts.js';

export type Edition = 'desktop' | 'headless';

export interface InstanceRecord {
  pid: number;
  edition: Edition;
  version: string;
  /** The UI WebSocket on a desktop; the health endpoint on both editions. */
  wsPort: number;
  /** The terminal gateway (CliServer). */
  cliPort: number;
  /** The HTTP gateway, when enabled. */
  httpPort: number;
  /** Lets a local terminal in without the login. Secret. */
  ownerToken: string;
  dataDir: string;
  startedAt: number;
}

export const INSTANCE_FILE = 'instance.json';

export function instanceFilePath(dataDir: string): string {
  return path.join(dataDir, INSTANCE_FILE);
}

export function newOwnerToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The record in a data directory, or null when there is none or it is unreadable. */
export function readInstance(dataDir: string): InstanceRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(instanceFilePath(dataDir), 'utf8')) as Partial<InstanceRecord>;
    if (typeof parsed.pid !== 'number' || typeof parsed.cliPort !== 'number' || typeof parsed.wsPort !== 'number') return null;
    if (parsed.edition !== 'desktop' && parsed.edition !== 'headless') return null;
    return parsed as InstanceRecord;
  } catch {
    return null;
  }
}

/** Write the record, readable by this user only. */
export function writeInstance(record: InstanceRecord): void {
  contractRequire(record.pid > 0 && record.cliPort > 0 && record.wsPort > 0, 'an instance record needs a pid and its ports');
  contractRequire(typeof record.ownerToken === 'string' && record.ownerToken.length >= 32, 'an instance record needs an owner token');
  fs.mkdirSync(record.dataDir, { recursive: true });
  const file = instanceFilePath(record.dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  ensure(readInstance(record.dataDir)?.pid === record.pid, 'the instance record must read back');
}

/** Remove the record if it is still ours (a successor may have replaced it). */
export function removeInstance(dataDir: string, pid = process.pid): void {
  const current = readInstance(dataDir);
  if (current && current.pid !== pid) return;
  try { fs.rmSync(instanceFilePath(dataDir), { force: true }); } catch { /* already gone */ }
}

/** Whether a process with this pid exists (signal 0 tests without signalling). */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** GET /healthz on a backend's UI port. Resolves to its report, or null. */
export function probeHealth(port: number, timeoutMs = 1500): Promise<{ status: string; ready?: boolean; edition?: string; version?: string } | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/**
 * The live backend for a data directory, if there is one: a record whose
 * process is alive and answers its health check. A record left by a backend
 * that died is stale and reported as none.
 */
export async function liveInstance(dataDir: string): Promise<InstanceRecord | null> {
  const record = readInstance(dataDir);
  if (!record || !processAlive(record.pid)) return null;
  const health = await probeHealth(record.wsPort);
  return health ? record : null;
}

/**
 * Refuse to start a second backend on a data directory another live backend
 * is using. Throws with a message naming it; a stale record is left for this
 * backend to overwrite.
 */
export async function assertNoOtherBackend(dataDir: string): Promise<void> {
  const other = await liveInstance(dataDir);
  if (other && other.pid !== process.pid) {
    throw new Error(
      `Abject is already running on ${dataDir} (the ${other.edition} edition, pid ${other.pid}, ` +
      `terminal gateway ws://127.0.0.1:${other.cliPort}). Connect to it with \`abject\`, ` +
      `or stop it with \`abject stop\` before starting another.`);
  }
}
