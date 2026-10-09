/**
 * Running the headless backend: in the foreground (`abject serve`), in the
 * background (`abject start`, and plain `abject` when nothing is running),
 * stopping it (`abject stop`), and its log (`abject logs`).
 *
 * The background backend is this same program re-run as `serve`, detached,
 * with its output going to <dataDir>/logs/abject.log. It outlives the
 * terminal that started it: goals keep running when the TUI closes, and
 * `abject stop` (or the service manager) ends it.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { require as contractRequire } from '../src/core/contracts.js';
import { liveInstance, processAlive, readInstance, removeInstance, type InstanceRecord } from '../server/instance-file.js';
import { connectClient } from './connect.js';
import { cliEdition } from './locate.js';

const LOG_FILE = 'abject.log';
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

export function logFilePath(dataDir: string): string {
  return path.join(dataDir, 'logs', LOG_FILE);
}

/**
 * Where an installed headless edition lives: the directory holding the
 * `abject` binary and its lib/. Undefined in a source checkout.
 */
export function installHome(): string | undefined {
  if (process.env.ABJECT_HOME) return process.env.ABJECT_HOME;
  // A bundled CLI sits at <home>/lib/cli/abject.mjs.
  const home = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  return fs.existsSync(path.join(home, 'lib', 'dist-server', 'server', 'headless.js')) ? home : undefined;
}

/** Whether this command can run a backend itself (the headless edition, or a checkout). */
export function canServe(): boolean {
  return cliEdition() !== 'desktop';
}

/**
 * The environment a backend runs in: the data directory, and for an install
 * the bundled packages and its own browser download location.
 */
function serveEnv(dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ABJECTS_DATA_DIR: dataDir };
  const home = installHome();
  if (home) {
    env.ABJECTS_NATIVE_DIR ??= path.join(home, 'lib', 'native');
    // Chromium for web browsing, when setup downloaded it, lives with the data.
    const browsers = path.join(dataDir, 'browsers');
    if (!env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(browsers)) env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  }
  return env;
}

/**
 * Run the headless backend in this process, until it is stopped. For service
 * managers (systemd, launchd, Docker) and for the background launch below.
 */
export async function serve(dataDir: string): Promise<void> {
  contractRequire(canServe(), 'The desktop app runs its own backend: start the Abject app instead of `abject serve`.');
  Object.assign(process.env, serveEnv(dataDir));
  fs.mkdirSync(dataDir, { recursive: true });
  const home = installHome();
  const entry = home
    ? pathToFileURL(path.join(home, 'lib', 'dist-server', 'server', 'headless.js')).href
    : new URL('../server/headless.ts', import.meta.url).href;
  await import(entry);
}

/** How to re-run this program as `serve` in a child process. */
function serveCommand(): { cmd: string; args: string[] } {
  // The packaged binary runs only its own entry and takes the subcommand.
  if (process.env.ABJECT_SEA === '1') return { cmd: process.execPath, args: ['serve'] };
  // Plain Node (an npm install, or tsx in a checkout): the same flags and script.
  return { cmd: process.execPath, args: [...process.execArgv, process.argv[1]!, 'serve'] };
}

/** Rotate a log that grew past its limit, keeping one old copy. */
function rotateLog(file: string): void {
  try {
    if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
  } catch { /* no log yet */ }
}

/** Start the backend in the background. Returns its pid; see waitForBackend. */
export function startInBackground(dataDir: string): number {
  contractRequire(canServe(), 'The desktop app runs its own backend: start the Abject app.');
  const logFile = logFilePath(dataDir);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  rotateLog(logFile);
  const out = fs.openSync(logFile, 'a');
  fs.writeSync(out, `\n── ${new Date().toISOString()} abject start ──\n`);
  const { cmd, args } = serveCommand();
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', out, out],
    env: serveEnv(dataDir),
    windowsHide: true,
    // An install runs from its data directory, so it holds no other folder
    // open. A checkout stays in the repository: its workers load TypeScript
    // through tsx, which resolves from there.
    cwd: installHome() ? dataDir : process.cwd(),
  });
  fs.closeSync(out);
  child.unref();
  contractRequire(typeof child.pid === 'number', 'the backend process did not start');
  return child.pid!;
}

/** The last lines of the backend's log, for a failure message. */
export function logTail(dataDir: string, lines = 30): string {
  try {
    const text = fs.readFileSync(logFilePath(dataDir), 'utf8');
    return text.split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

/**
 * Wait until the backend for a data directory is up (its instance file is
 * written once boot finishes). With a pid, fail as soon as that process dies,
 * and stop it if it never comes up: it was started for this, and a backend
 * stuck in boot would otherwise hold the data directory.
 */
export async function waitForBackend(
  dataDir: string,
  opts: { pid?: number; timeoutMs?: number; onWait?: (seconds: number) => void } = {},
): Promise<InstanceRecord> {
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  const started = Date.now();
  for (;;) {
    const live = await liveInstance(dataDir);
    if (live) return live;
    if (opts.pid !== undefined && !processAlive(opts.pid)) {
      throw new Error(`The backend stopped while starting. The end of its log (${logFilePath(dataDir)}):\n${logTail(dataDir)}`);
    }
    if (Date.now() > deadline) {
      if (opts.pid !== undefined && processAlive(opts.pid)) {
        try { process.kill(opts.pid, 'SIGTERM'); } catch { /* gone */ }
        if (!(await waitForExit(opts.pid, 10_000))) {
          try { process.kill(opts.pid, 'SIGKILL'); } catch { /* gone */ }
        }
      }
      throw new Error(`The backend did not come up within ${Math.round((opts.timeoutMs ?? 180_000) / 1000)}s and was stopped. The end of its log (${logFilePath(dataDir)}):\n${logTail(dataDir)}`);
    }
    opts.onWait?.(Math.round((Date.now() - started) / 1000));
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Wait for a process to exit; true if it did within the time. */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return !processAlive(pid);
}

/**
 * Stop the backend on a data directory: ask it to shut down through its
 * gateway, then signal it if it does not go. Returns what it found.
 */
export async function stopBackend(dataDir: string): Promise<'stopped' | 'not-running'> {
  const record = readInstance(dataDir);
  if (!record || !processAlive(record.pid)) {
    removeInstance(dataDir, record?.pid);
    return 'not-running';
  }
  try {
    const client = await connectClient({ url: `ws://127.0.0.1:${record.cliPort}`, ownerToken: record.ownerToken });
    await client.shutdown().catch(() => false);
    client.close();
  } catch { /* fall through to the signal */ }
  if (await waitForExit(record.pid, 15_000)) return 'stopped';
  try { process.kill(record.pid, 'SIGTERM'); } catch { /* gone */ }
  if (await waitForExit(record.pid, 10_000)) return 'stopped';
  try { process.kill(record.pid, 'SIGKILL'); } catch { /* gone */ }
  await waitForExit(record.pid, 5_000);
  removeInstance(dataDir, record.pid);
  return 'stopped';
}

/** Print the backend's log; with follow, keep printing as it grows. */
export async function showLogs(dataDir: string, follow: boolean, lines = 200): Promise<void> {
  const file = logFilePath(dataDir);
  if (!fs.existsSync(file)) {
    process.stdout.write(cliEdition() === 'desktop'
      ? 'The desktop app keeps its own log; this command logs only backends it started.\n'
      : `No log yet at ${file}.\n`);
    return;
  }
  process.stdout.write(logTail(dataDir, lines) + '\n');
  if (!follow) return;
  let offset = fs.statSync(file).size;
  await new Promise<void>(() => {
    fs.watchFile(file, { interval: 500 }, (curr) => {
      if (curr.size < offset) offset = 0; // rotated
      if (curr.size === offset) return;
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(curr.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = curr.size;
      process.stdout.write(buf.toString('utf8'));
    });
  });
}
