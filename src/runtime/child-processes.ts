/**
 * Child processes this thread started that must not outlive the app.
 *
 * Each object that spawns a long-lived process stops it in its own onStop,
 * but only if onStop runs. A teardown that wedges (libdatachannel), runs out
 * of Electron's quit deadline, or crashes on the way out never reaches the
 * objects at the end of the line. A child in its own session, as MCP servers
 * are so their whole tree can be signalled, does not die with us either.
 * Survivors in the packaged Linux app hold the AppImage mount open, so the
 * app never finishes quitting.
 *
 * So spawners record their children here, and shutdown signals every one of
 * them first, before anything slow. Module state is per thread: the main
 * thread and each pool worker keep their own list, and the worker pool asks
 * each worker to signal its own (WorkerPool.signalChildren).
 */

import { spawnSync } from 'node:child_process';

export interface TrackedChild {
  pid: number;
  /** The child leads its own process group (or, on Windows, the tree
   *  taskkill /T walks), and the whole group is signalled. */
  group: boolean;
  /** What it is, for the shutdown log. */
  label: string;
}

const tracked = new Map<number, TrackedChild>();

/** Set once shutdown has signalled this thread's children: anything spawned
 *  after that is signalled as soon as it is tracked. */
let closing = false;

export function trackChild(pid: number | undefined, label: string, options: { group: boolean }): void {
  if (!pid) return;
  const child: TrackedChild = { pid, group: options.group, label };
  tracked.set(pid, child);
  if (closing) signalChild(child, 'SIGTERM');
}

export function untrackChild(pid: number | undefined): void {
  if (pid) tracked.delete(pid);
}

/**
 * Forget a group child once nothing is left in its group. A group leader
 * can exit while the processes it started run on (`sh` -> `npm` -> `node`),
 * and those are what must still be signalled; once the group is empty its
 * id may be reused by an unrelated process, so it must not be kept.
 */
export function untrackIfGone(pid: number | undefined): void {
  const child = pid ? tracked.get(pid) : undefined;
  if (child && !signalChild(child, 0)) tracked.delete(child.pid);
}

export function trackedChildren(): TrackedChild[] {
  return [...tracked.values()];
}

/**
 * Signal one child, its whole group when it leads one. Signal 0 only asks
 * whether anything is there. False when there was nothing to signal.
 */
export function signalChild(child: TrackedChild, signal: NodeJS.Signals | 0): boolean {
  if (process.platform === 'win32') {
    if (signal === 0) {
      try { process.kill(child.pid, 0); return true; } catch { return false; }
    }
    if (child.group) {
      const args = ['/pid', String(child.pid), '/T'];
      if (signal === 'SIGKILL') args.push('/F');
      const result = spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
      return result.status === 0;
    }
    try { process.kill(child.pid, signal); return true; } catch { return false; }
  }
  try {
    process.kill(child.group ? -child.pid : child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Shutdown: signal every child this thread is tracking, and every child it
 * tracks from now on. Returns the ones that were still there; the rest are
 * forgotten.
 */
export function signalAllChildren(signal: NodeJS.Signals): TrackedChild[] {
  closing = true;
  const reached: TrackedChild[] = [];
  for (const child of [...tracked.values()]) {
    if (signalChild(child, signal)) reached.push(child);
    else tracked.delete(child.pid);
  }
  return reached;
}

/** For tests: forget everything and leave the closing state. */
export function resetChildTracking(): void {
  tracked.clear();
  closing = false;
}
