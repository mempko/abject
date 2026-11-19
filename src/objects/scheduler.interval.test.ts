/**
 * Interval schedules, against the real Scheduler on a real bus.
 *
 * The Registry, the Timer and the Scheduler are the real objects. The only
 * stand-in is the JobManager, which records what the Scheduler submits
 * instead of running it. The Scheduler's own tick comes every 60 s, so the
 * test delivers the Timer's `timerFired` event itself rather than wait.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Abject, type MessageHandlerFn } from '../core/abject.js';
import { MessageBus } from '../runtime/message-bus.js';
import { event, request } from '../core/message.js';
import type { AbjectId, InterfaceId } from '../core/types.js';
import { Registry } from './registry.js';
import { Timer } from './capabilities/timer.js';
import { Scheduler } from './scheduler.js';

class Endpoint extends Abject {
  submitted: Array<{ description: string; code: string }> = [];

  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'Scheduler fixture',
      interface: { id: `fixture:${name}` as InterfaceId, name, description: 'fixture', methods: [] } } });
  }

  public override on(method: string, fn: MessageHandlerFn): void { super.on(method, fn); }
  call<T = any>(to: AbjectId, method: string, payload: unknown = {}): Promise<T> { return this.request<T>(request(this.id, to, method, payload), 3000); }
  /** What the Timer sends the Scheduler every 60 s. */
  tick(to: AbjectId): void { this.send(event(this.id, to, 'timerFired', { timerId: 'tick', data: { type: 'schedulerTick' } })); }
}

async function world() {
  const bus = new MessageBus();
  const registry = new Registry();
  await registry.init(bus);
  const objects: Abject[] = [];
  const add = async <T extends Abject>(o: T): Promise<T> => {
    o.setRegistryHint(registry.id); await o.init(bus); registry.registerObject(o.id, o.manifest); objects.push(o); return o;
  };
  await add(new Timer());
  const jobs = await add(new Endpoint('JobManager'));
  jobs.on('submitJob', (msg: any) => { jobs.submitted.push(msg.payload); return { jobId: 'job-1' }; });
  const scheduler = await add(new Scheduler());
  const caller = await add(new Endpoint('Caller'));
  const stop = async () => { for (const o of objects.reverse()) await o.stop(); await registry.stop(); };
  return { scheduler, jobs, caller, stop };
}

const settle = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test('addSchedule refuses an intervalMs that is not a number, as addScheduleOnce does for runAt', async () => {
  const { scheduler, caller, stop } = await world();
  try {
    for (const intervalMs of ['60000', NaN, Infinity, 0, -5]) {
      await assert.rejects(
        caller.call(scheduler.id, 'addSchedule', { description: 'poll', intervalMs, jobCode: 'return 1;' }),
        /intervalMs must be a positive number/,
        `intervalMs ${JSON.stringify(intervalMs)} (${typeof intervalMs}) is refused`,
      );
    }
    assert.deepEqual(await caller.call(scheduler.id, 'listSchedules'), [], 'nothing was stored');
  } finally { await stop(); }
});

test('an interval schedule keeps a numeric nextRun and fires on the first tick after it', async () => {
  const { scheduler, jobs, caller, stop } = await world();
  try {
    const before = Date.now();
    const { scheduleId } = await caller.call(scheduler.id, 'addSchedule', { description: 'poll', intervalMs: 200, jobCode: 'return 1;' });
    // The reply is the live entry on a local bus, so the first nextRun is copied out here.
    const firstRun: number = (await caller.call(scheduler.id, 'getSchedule', { scheduleId })).nextRun;
    assert.equal(typeof firstRun, 'number');
    assert.ok(firstRun >= before + 200 && firstRun <= Date.now() + 200, 'nextRun is the interval from now');

    caller.tick(scheduler.id);
    await settle(20);
    assert.equal(jobs.submitted.length, 0, 'not due yet');

    await settle(250);
    caller.tick(scheduler.id);
    await settle(20);
    assert.equal(jobs.submitted.length, 1, 'the tick after nextRun submits the job');
    assert.equal(jobs.submitted[0].code, 'return 1;');
    const fired = await caller.call(scheduler.id, 'getSchedule', { scheduleId });
    assert.ok(fired.lastRun >= firstRun, 'lastRun records the firing');
    assert.equal(typeof fired.nextRun, 'number');
    assert.ok(fired.nextRun >= fired.lastRun + 200, 'and the next run is at least one interval later');
  } finally { await stop(); }
});
