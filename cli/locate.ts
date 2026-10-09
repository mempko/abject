/**
 * Which `abject` this is, where its data lives, and how to reach the backend.
 *
 * The same command ships in three ways, and they differ only in what they may
 * do when nothing is running:
 *
 *   headless  the headless edition's `abject`: it starts its own backend in
 *             the background and connects to it.
 *   desktop   the copy inside the desktop app: the app is the backend, so it
 *             waits for the app to start and then connects.
 *   dev       `pnpm abject` in a source checkout: it waits for `pnpm awaken`
 *             (or `pnpm abject start`, which runs the headless edition from
 *             source).
 *
 * Every edition connects to whatever backend is running on the data
 * directory, desktop or headless: it finds it through the instance.json the
 * backend writes (server/instance-file.ts).
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { defaultDataDir } from '../server/data-dir.js';
import { liveInstance, readInstance, type InstanceRecord } from '../server/instance-file.js';
import type { CliConfig } from './config.js';

export type CliEdition = 'headless' | 'desktop' | 'dev';

/** Set by the launcher that started this process; a source checkout sets none. */
export function cliEdition(): CliEdition {
  const e = process.env.ABJECT_EDITION;
  return e === 'headless' || e === 'desktop' ? e : 'dev';
}

/**
 * The data directory: ABJECTS_DATA_DIR, then what setup chose, then the
 * edition's default (the OS location for installs, `.abjects` in a checkout).
 */
export function cliDataDir(config: CliConfig, explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  const env = process.env.ABJECTS_DATA_DIR?.trim();
  if (env) return path.resolve(env);
  if (config.dataDir) return path.resolve(config.dataDir);
  return cliEdition() === 'dev' ? path.resolve('.abjects') : defaultDataDir();
}

/** Whether a backend has ever run on this data directory (it holds storage). */
export function dataDirInUse(dataDir: string): boolean {
  return ['storage.db', 'storage.json'].some((f) => fs.existsSync(path.join(dataDir, f)));
}

/** A backend the command can talk to. */
export interface BackendTarget {
  url: string;
  /** Present when the backend was found through its instance file. */
  ownerToken?: string;
  instance?: InstanceRecord;
}

/** Whether something accepts TCP connections on a loopback port. */
export function portOpen(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * The running backend for a data directory, or null.
 *
 * An explicit URL wins. Otherwise the data directory's instance file names
 * the backend and carries the owner token. A desktop app from before the
 * instance file existed writes none, so for a data directory that has been
 * used (it holds storage) but has no file, that data directory's gateway
 * port is tried as a last resort. A fresh data directory never is: whatever
 * answers on a default port then belongs to some other instance.
 */
export async function findBackend(dataDir: string, explicitUrl?: string): Promise<BackendTarget | null> {
  if (explicitUrl) return { url: explicitUrl };
  const live = await liveInstance(dataDir);
  if (live) return { url: `ws://127.0.0.1:${live.cliPort}`, ownerToken: live.ownerToken, instance: live };
  if (readInstance(dataDir)) return null; // a record, but its backend is gone
  if (!dataDirInUse(dataDir)) return null;
  const wsPort = Number(process.env.WS_PORT ?? 7719);
  const port = Number(process.env.CLI_PORT ?? wsPort + 4);
  if (await portOpen(port)) return { url: `ws://127.0.0.1:${port}` };
  return null;
}
