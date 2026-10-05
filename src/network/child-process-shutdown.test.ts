/**
 * Shutdown leaves no child process behind.
 *
 * MCP servers run in sessions of their own so their whole tree can be
 * signalled, which also means nothing takes them down with the app. They
 * used to be stopped only by their bridge's onStop, at the end of a
 * one-object-at-a-time pool teardown that ran past Electron's quit deadline;
 * the servers outlived the app and held the AppImage mount open.
 *
 * Now spawners record their children (runtime/child-processes.ts), shutdown
 * signals all of them first, and the pool stops its objects all at once
 * within a deadline. These tests use real process trees (POSIX only) and a
 * pool of stand-in workers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { MCPTransport } from './mcp-transport.js';
import {
  resetChildTracking, signalAllChildren, trackChild, trackedChildren, untrackIfGone,
} from '../runtime/child-processes.js';
import { WorkerPool } from '../runtime/worker-pool.js';
import type { WorkerLike } from '../runtime/worker-bridge.js';
import { MessageBus } from '../runtime/message-bus.js';
import type { AbjectId } from '../core/types.js';

const posix = process.platform !== 'win32';

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
}

async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

test('shutdown signals an MCP server\'s whole tree without its bridge stopping it', { skip: !posix }, async () => {
  resetChildTracking();
  const first = new MCPTransport();
  const late = new MCPTransport();
  try {
    // A shell with two descendants, like `sh -> npm -> node`.
    await first.start('sleep 30 & sleep 30');
    const [tracked] = trackedChildren();
    assert.ok(tracked, 'the server was recorded when it started');
    assert.equal(tracked.group, true);
    assert.match(tracked.label, /^MCP server: sleep 30/);
    assert.ok(groupAlive(tracked.pid));

    const reached = signalAllChildren('SIGTERM');
    assert.deepEqual(reached.map((c) => c.pid), [tracked.pid]);
    assert.ok(await until(() => !groupAlive(tracked.pid)), 'the whole group is gone');

    // When the bridge does get to stop it, a server that already left costs nothing:
    // its 'close' has fired, so stop() must not wait out the 3s fallback for it.
    const stopStarted = Date.now();
    await first.stop();
    assert.ok(Date.now() - stopStarted < 1000, `stop() of an exited server is immediate (${Date.now() - stopStarted}ms)`);

    // Anything started after shutdown began is signalled as soon as it is recorded.
    await late.start('sleep 30 & sleep 30');
    const lateChild = trackedChildren().find((c) => c.pid !== tracked.pid)!;
    assert.ok(lateChild);
    assert.ok(await until(() => !groupAlive(lateChild.pid)), 'a late server does not survive either');
  } finally {
    await first.stop();
    await late.stop();
    resetChildTracking();
  }
});

test('a group is forgotten only once nothing is left in it', { skip: !posix }, async () => {
  resetChildTracking();
  // The leader leaves at once; the process it started runs on in its group.
  const leader = spawn('sh', ['-c', 'sleep 30 & exit 0'], { detached: true, stdio: 'ignore' });
  const pgid = leader.pid!;
  trackChild(pgid, 'leader that hands off', { group: true });
  await new Promise((r) => leader.on('exit', r));
  try {
    untrackIfGone(pgid);
    assert.equal(trackedChildren().length, 1, 'still tracked while its descendant runs');
    signalAllChildren('SIGTERM');
    assert.ok(await until(() => !groupAlive(pgid)));
    untrackIfGone(pgid);
    assert.equal(trackedChildren().length, 0, 'forgotten once the group is empty');
  } finally {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
    resetChildTracking();
  }
});

/**
 * A stand-in pool worker: answers spawn at once, kill after `stopMs` (never
 * for ids in `hang`), and children:signal with `children` unless `silent`.
 */
function fakeWorkerFactory(opts: { stopMs: number; hang: Set<string>; silentIndex: number }) {
  const workers: Array<WorkerLike & { killsSeen: string[]; terminated: boolean }> = [];
  const factory = (): WorkerLike => {
    const index = workers.length;
    const worker = {
      onmessage: null as WorkerLike['onmessage'],
      onerror: null as WorkerLike['onerror'],
      onexit: null as WorkerLike['onexit'],
      killsSeen: [] as string[],
      terminated: false,
      postMessage(data: unknown) {
        const msg = data as { type: string; objectId?: string; requestId?: number };
        const reply = (out: unknown, ms = 0) => setTimeout(() => worker.onmessage?.({ data: out }), ms);
        if (msg.type === 'spawn') reply({ type: 'spawned', objectId: msg.objectId });
        if (msg.type === 'kill') {
          worker.killsSeen.push(msg.objectId!);
          if (!opts.hang.has(msg.objectId!)) reply({ type: 'stopped', objectId: msg.objectId }, opts.stopMs);
        }
        if (msg.type === 'children:signal' && index !== opts.silentIndex) {
          reply({ type: 'children:signalled', requestId: msg.requestId,
            children: [{ pid: 4000 + index, group: true, label: `server ${index}` }] });
        }
      },
      terminate() {
        worker.terminated = true;
        setTimeout(() => worker.onexit?.({ code: 1 }), 0);
      },
    };
    workers.push(worker);
    setTimeout(() => worker.onmessage?.({ data: { type: 'ready' } }), 0);
    return worker;
  };
  return { factory, workers };
}

test('the pool stops its objects all at once, within a deadline, and collects every worker\'s children', async () => {
  const hang = new Set(['00000001-0000-4000-8000-000000000009']);
  const { factory, workers } = fakeWorkerFactory({ stopMs: 100, hang, silentIndex: 1 });
  const pool = new WorkerPool({ workerCount: 2, workerFactory: factory }, new MessageBus());
  await pool.start();

  const ids = [
    '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003', '00000001-0000-4000-8000-000000000004',
    '00000001-0000-4000-8000-000000000009',
  ] as AbjectId[];
  for (const id of ids) await pool.spawnInWorker(id, 'Anything');

  // Worker 1 does not answer; the call still returns, with worker 0's children.
  const started = Date.now();
  const children = await pool.signalChildren('SIGTERM', 150);
  assert.deepEqual(children.map((c) => c.label), ['server 0']);
  assert.ok(Date.now() - started < 1000);

  const shutdownStarted = Date.now();
  await pool.shutdown(400);
  const elapsed = Date.now() - shutdownStarted;
  // One at a time this was 4 x 100ms and then forever for the hanging object.
  assert.ok(elapsed >= 380 && elapsed < 650, `bounded by the deadline, not the sum (took ${elapsed}ms)`);
  assert.deepEqual(workers.map((w) => w.killsSeen.length), [3, 2], 'every object was asked to stop');
  assert.ok(workers.every((w) => w.terminated), 'and every worker was terminated');
});
