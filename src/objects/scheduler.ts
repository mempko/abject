/**
 * Scheduler -- built-in per-workspace system object for cron-like scheduling.
 *
 * Any object can register scheduled entries. When a schedule fires,
 * the Scheduler submits the entry's job code to JobManager. Entries
 * are persisted to Storage and restored on startup.
 *
 * This is infrastructure, not LLM-generated code. It uses Timer
 * internally for ticking and is always available per workspace.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require as precondition, requireNonEmpty, invariant } from '../core/contracts.js';
import { request } from '../core/message.js';
import { Log } from '../core/timed-log.js';

const log = new Log('Scheduler');

const SCHEDULER_INTERFACE: InterfaceId = 'abjects:scheduler';
const STORAGE_KEY = 'scheduler:entries';
const TICK_INTERVAL_MS = 60_000; // check schedules every 60s

export interface ScheduleEntry {
  id: string;
  description: string;
  /** Interval in milliseconds for repeating schedules. */
  intervalMs?: number;
  /** Hour (0-23) for daily time-based schedules. */
  hour?: number;
  /** Minute (0-59) for daily time-based schedules. */
  minute?: number;
  /** IANA timezone (e.g. "America/Los_Angeles"). Defaults to local. */
  timezone?: string;
  /**
   * Absolute unix-ms timestamp for one-shot schedules. When set (and
   * `intervalMs`/`hour` are not), the entry fires once at this time and
   * is deleted from the registry. Use `addScheduleOnce` to create.
   */
  runAt?: number;
  /** JavaScript code to run in JobManager sandbox when the schedule fires. */
  jobCode: string;
  /** JobManager queue name. */
  queue?: string;
  enabled: boolean;
  lastRun: number;
  nextRun: number;
  createdAt: number;
  /** ID of the object that created this entry. */
  owner: string;
}

export class Scheduler extends Abject {
  private storageId?: AbjectId;
  private timerId?: AbjectId;
  private jobManagerId?: AbjectId;
  private tickTimerId?: string;
  private entries = new Map<string, ScheduleEntry>();
  private entryCounter = 0;

  constructor() {
    super({
      manifest: {
        name: 'Scheduler',
        description:
          'The system scheduler for all recurring and timed tasks. Use this to run code every N minutes/hours, ' +
          'at a specific time daily, once at a specific date+time, or on any repeating schedule. Handles ' +
          '"every minute do X", "every day at 6:30PM do Y", "next Tuesday at 9am do Z once", ' +
          'and all periodic/recurring/scheduled/timed automation. When a schedule fires, the code runs as a Job. ' +
          'Use cases: say hello every minute, daily briefings, periodic data checks, recurring automation, ' +
          'timed reminders, one-off appointments.',
        version: '1.0.0',
        interface: {
          id: SCHEDULER_INTERFACE,
          name: 'Scheduler',
          description: 'Schedule job code to run periodically or at specific times',
          methods: [
            {
              name: 'addSchedule',
              description: 'Register a new recurring schedule by interval',
              parameters: [
                { name: 'description', type: { kind: 'primitive', primitive: 'string' }, description: 'Human-readable description' },
                { name: 'intervalMs', type: { kind: 'primitive', primitive: 'number' }, description: 'Interval in milliseconds' },
                { name: 'jobCode', type: { kind: 'primitive', primitive: 'string' }, description: 'JavaScript code to run in JobManager sandbox (has access to call, dep, find)' },
                { name: 'queue', type: { kind: 'primitive', primitive: 'string' }, description: 'JobManager queue name', optional: true },
              ],
              returns: { kind: 'object', properties: { scheduleId: { kind: 'primitive', primitive: 'string' } } },
            },
            {
              name: 'addScheduleAt',
              description: 'Register a daily schedule at a specific time',
              parameters: [
                { name: 'description', type: { kind: 'primitive', primitive: 'string' }, description: 'Human-readable description' },
                { name: 'hour', type: { kind: 'primitive', primitive: 'number' }, description: 'Hour (0-23)' },
                { name: 'minute', type: { kind: 'primitive', primitive: 'number' }, description: 'Minute (0-59)' },
                { name: 'timezone', type: { kind: 'primitive', primitive: 'string' }, description: 'IANA timezone (e.g. "America/Los_Angeles"). Defaults to local.', optional: true },
                { name: 'jobCode', type: { kind: 'primitive', primitive: 'string' }, description: 'JavaScript code to run in JobManager sandbox' },
                { name: 'queue', type: { kind: 'primitive', primitive: 'string' }, description: 'JobManager queue name', optional: true },
              ],
              returns: { kind: 'object', properties: { scheduleId: { kind: 'primitive', primitive: 'string' } } },
            },
            {
              name: 'addScheduleOnce',
              description: 'Register a one-shot schedule that fires once at a specific date+time, then auto-deletes',
              parameters: [
                { name: 'description', type: { kind: 'primitive', primitive: 'string' }, description: 'Human-readable description' },
                { name: 'runAt', type: { kind: 'primitive', primitive: 'number' }, description: 'Absolute unix-ms timestamp to fire at (e.g. Date.parse("2026-05-15T14:30:00-07:00"))' },
                { name: 'jobCode', type: { kind: 'primitive', primitive: 'string' }, description: 'JavaScript code to run in JobManager sandbox' },
                { name: 'queue', type: { kind: 'primitive', primitive: 'string' }, description: 'JobManager queue name', optional: true },
              ],
              returns: { kind: 'object', properties: { scheduleId: { kind: 'primitive', primitive: 'string' } } },
            },
            {
              name: 'removeSchedule',
              description: 'Delete a schedule',
              parameters: [
                { name: 'scheduleId', type: { kind: 'primitive', primitive: 'string' }, description: 'Schedule ID' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'enableSchedule',
              description: 'Enable a disabled schedule',
              parameters: [
                { name: 'scheduleId', type: { kind: 'primitive', primitive: 'string' }, description: 'Schedule ID' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'disableSchedule',
              description: 'Disable a schedule without removing it',
              parameters: [
                { name: 'scheduleId', type: { kind: 'primitive', primitive: 'string' }, description: 'Schedule ID' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'listSchedules',
              description: 'Return all schedule entries',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'ScheduleEntry' } },
            },
            {
              name: 'getSchedule',
              description: 'Return a single schedule entry',
              parameters: [
                { name: 'scheduleId', type: { kind: 'primitive', primitive: 'string' }, description: 'Schedule ID' },
              ],
              returns: { kind: 'union', variants: [
                { kind: 'reference', reference: 'ScheduleEntry' },
                { kind: 'primitive', primitive: 'null' },
              ] },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'scheduling'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.storageId = await this.discoverDep('Storage') ?? undefined;
    this.timerId = await this.discoverDep('Timer') ?? undefined;
    this.jobManagerId = await this.discoverDep('JobManager') ?? undefined;

    await this.loadFromStorage();

    if (this.timerId) {
      this.tickTimerId = await this.request<string>(
        request(this.id, this.timerId, 'setInterval', {
          intervalMs: TICK_INTERVAL_MS,
          data: { type: 'schedulerTick' },
        }),
      );
      log.info(`Tick timer started (${TICK_INTERVAL_MS}ms), ${this.entries.size} entries loaded`);
    }
  }

  protected override async onStop(): Promise<void> {
    if (this.tickTimerId && this.timerId) {
      try {
        await this.request(request(this.id, this.timerId, 'clearTimer', { timerId: this.tickTimerId }));
      } catch { /* best effort */ }
    }
  }

  private setupHandlers(): void {
    this.on('addSchedule', async (msg: AbjectMessage) => {
      const { description, intervalMs, jobCode, queue } = msg.payload as {
        description: string; intervalMs: number; jobCode: string; queue?: string;
      };
      requireNonEmpty(description, 'description');
      precondition(intervalMs > 0, 'intervalMs must be positive');
      requireNonEmpty(jobCode, 'jobCode');

      // Deduplicate: if an identical schedule already exists (same jobCode
      // and same interval), return its id instead of creating a duplicate.
      const existing = this.findDuplicate({ intervalMs, jobCode });
      if (existing) {
        log.info(`Schedule already exists for this jobCode (${existing.id}) — returning existing id`);
        return { scheduleId: existing.id };
      }

      const id = `sched-${++this.entryCounter}`;
      const now = Date.now();
      const entry: ScheduleEntry = {
        id, description, intervalMs, jobCode, queue,
        enabled: true, lastRun: 0, nextRun: now + intervalMs,
        createdAt: now, owner: msg.routing.from as string,
      };
      this.entries.set(id, entry);
      await this.persistToStorage();
      this.changed('scheduleAdded', { scheduleId: id, description });
      log.info(`Added interval schedule "${description}" (${intervalMs}ms) -> ${id}`);
      return { scheduleId: id };
    });

    this.on('addScheduleAt', async (msg: AbjectMessage) => {
      const { description, hour, minute, timezone, jobCode, queue } = msg.payload as {
        description: string; hour: number; minute: number;
        timezone?: string; jobCode: string; queue?: string;
      };
      requireNonEmpty(description, 'description');
      precondition(hour >= 0 && hour <= 23, 'hour must be 0-23');
      precondition(minute >= 0 && minute <= 59, 'minute must be 0-59');
      requireNonEmpty(jobCode, 'jobCode');

      // Deduplicate: if an identical daily schedule already exists (same time,
      // timezone, and jobCode), return its id instead of creating a duplicate.
      const existing = this.findDuplicate({ hour, minute, timezone, jobCode });
      if (existing) {
        log.info(`Schedule already exists for this time + jobCode (${existing.id}) — returning existing id`);
        return { scheduleId: existing.id };
      }

      const id = `sched-${++this.entryCounter}`;
      const now = Date.now();
      const nextRun = this.computeNextDailyRun(hour, minute, timezone);
      const entry: ScheduleEntry = {
        id, description, hour, minute, timezone, jobCode, queue,
        enabled: true, lastRun: 0, nextRun,
        createdAt: now, owner: msg.routing.from as string,
      };
      this.entries.set(id, entry);
      await this.persistToStorage();
      this.changed('scheduleAdded', { scheduleId: id, description });
      log.info(`Added daily schedule "${description}" at ${hour}:${String(minute).padStart(2, '0')} ${timezone ?? 'local'} -> ${id}`);
      return { scheduleId: id };
    });

    this.on('addScheduleOnce', async (msg: AbjectMessage) => {
      const { description, runAt, jobCode, queue } = msg.payload as {
        description: string; runAt: number; jobCode: string; queue?: string;
      };
      requireNonEmpty(description, 'description');
      precondition(typeof runAt === 'number' && isFinite(runAt), 'runAt must be a number (unix ms)');
      requireNonEmpty(jobCode, 'jobCode');

      // Deduplicate: if the same one-shot (runAt + jobCode) already
      // exists, return its id. Tolerates a 1-minute jitter window since
      // tick precision is 60s anyway.
      const existing = this.findDuplicate({ runAt, jobCode });
      if (existing) {
        log.info(`One-shot schedule already exists for this runAt + jobCode (${existing.id}) — returning existing id`);
        return { scheduleId: existing.id };
      }

      const id = `sched-${++this.entryCounter}`;
      const now = Date.now();
      const entry: ScheduleEntry = {
        id, description, runAt, jobCode, queue,
        enabled: true, lastRun: 0, nextRun: runAt,
        createdAt: now, owner: msg.routing.from as string,
      };
      this.entries.set(id, entry);
      await this.persistToStorage();
      this.changed('scheduleAdded', { scheduleId: id, description });
      log.info(`Added one-shot schedule "${description}" at ${new Date(runAt).toISOString()} -> ${id}`);
      return { scheduleId: id };
    });

    this.on('removeSchedule', async (msg: AbjectMessage) => {
      const { scheduleId } = msg.payload as { scheduleId: string };
      const deleted = this.entries.delete(scheduleId);
      if (deleted) {
        await this.persistToStorage();
        this.changed('scheduleRemoved', { scheduleId });
        log.info(`Removed schedule ${scheduleId}`);
      }
      return deleted;
    });

    this.on('enableSchedule', async (msg: AbjectMessage) => {
      const { scheduleId } = msg.payload as { scheduleId: string };
      const entry = this.entries.get(scheduleId);
      if (!entry) return false;
      entry.enabled = true;
      await this.persistToStorage();
      this.changed('scheduleUpdated', { scheduleId });
      return true;
    });

    this.on('disableSchedule', async (msg: AbjectMessage) => {
      const { scheduleId } = msg.payload as { scheduleId: string };
      const entry = this.entries.get(scheduleId);
      if (!entry) return false;
      entry.enabled = false;
      await this.persistToStorage();
      this.changed('scheduleUpdated', { scheduleId });
      return true;
    });

    this.on('listSchedules', async () => {
      return [...this.entries.values()];
    });

    this.on('getSchedule', async (msg: AbjectMessage) => {
      const { scheduleId } = msg.payload as { scheduleId: string };
      return this.entries.get(scheduleId) ?? null;
    });

    this.on('timerFired', async (msg: AbjectMessage) => {
      const { data } = msg.payload as { timerId: string; data?: { type?: string } };
      if (data?.type === 'schedulerTick') {
        await this.tick();
      }
    });

    // When a job we submitted fails, JobManager sends a direct jobFailed
    // event. Reject any pending submitJob request so the scheduler's tick
    // unblocks immediately instead of waiting for the 300s stall timer.
    this.on('jobFailed', async (msg: AbjectMessage) => {
      const { error } = msg.payload as { jobId: string; error?: string };
      this.rejectPendingRequestsTo(
        msg.routing.from,
        new Error(error ?? 'Job failed'),
      );
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Tick
  // ═══════════════════════════════════════════════════════════════════

  private async tick(): Promise<void> {
    const now = Date.now();
    let dirty = false;
    const toDelete: string[] = [];

    for (const entry of this.entries.values()) {
      if (!entry.enabled) continue;
      if (now < entry.nextRun) continue;
      if (!this.jobManagerId) continue;

      log.info(`Schedule "${entry.description}" (${entry.id}) firing`);
      try {
        await this.request(
          request(this.id, this.jobManagerId, 'submitJob', {
            description: `[Scheduled] ${entry.description}`,
            code: entry.jobCode,
            queue: entry.queue,
          }),
          300000,
        );
        log.info(`Schedule "${entry.description}" job completed`);
      } catch (err) {
        log.warn(`Schedule "${entry.description}" job failed:`, err instanceof Error ? err.message : String(err));
      }

      entry.lastRun = now;

      if (entry.intervalMs) {
        entry.nextRun = now + entry.intervalMs;
      } else if (entry.hour !== undefined && entry.minute !== undefined) {
        entry.nextRun = this.computeNextDailyRun(entry.hour, entry.minute, entry.timezone);
      } else if (entry.runAt !== undefined) {
        // One-shot: fire-once-and-delete. The job-submit above ran
        // whether or not it succeeded; either way we don't fire again.
        toDelete.push(entry.id);
      }

      dirty = true;
      this.changed('scheduleFired', { scheduleId: entry.id, description: entry.description });
    }

    for (const id of toDelete) {
      this.entries.delete(id);
      this.changed('scheduleRemoved', { scheduleId: id });
    }

    if (dirty) {
      await this.persistToStorage();
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Deduplication
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Find an existing schedule that matches the given key fields. Returns
   * undefined if no duplicate exists. Used to prevent accumulating duplicate
   * schedules across sessions (e.g. the LLM creating the same "daily 6AM
   * briefing" scheduler every time it runs).
   */
  private findDuplicate(criteria: {
    intervalMs?: number;
    hour?: number;
    minute?: number;
    timezone?: string;
    runAt?: number;
    jobCode: string;
  }): ScheduleEntry | undefined {
    const RUN_AT_TOLERANCE_MS = 60_000;
    for (const entry of this.entries.values()) {
      if (entry.jobCode !== criteria.jobCode) continue;
      if (criteria.intervalMs !== undefined) {
        if (entry.intervalMs === criteria.intervalMs) return entry;
        continue;
      }
      if (criteria.hour !== undefined && criteria.minute !== undefined) {
        if (entry.hour === criteria.hour
            && entry.minute === criteria.minute
            && (entry.timezone ?? undefined) === (criteria.timezone ?? undefined)) {
          return entry;
        }
        continue;
      }
      if (criteria.runAt !== undefined) {
        if (entry.runAt !== undefined
            && Math.abs(entry.runAt - criteria.runAt) <= RUN_AT_TOLERANCE_MS) {
          return entry;
        }
      }
    }
    return undefined;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Time computation
  // ═══════════════════════════════════════════════════════════════════

  private computeNextDailyRun(hour: number, minute: number, timezone?: string): number {
    const now = new Date();

    if (timezone) {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      });
      const parts = formatter.formatToParts(now);
      const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);
      const tzHour = get('hour');
      const tzMinute = get('minute');
      const tzYear = get('year');
      const tzMonth = get('month') - 1;
      const tzDay = get('day');

      const isPast = tzHour > hour || (tzHour === hour && tzMinute >= minute);
      const target = new Date(tzYear, tzMonth, tzDay + (isPast ? 1 : 0), hour, minute, 0, 0);

      // Correct for timezone offset
      const localOffset = target.getTimezoneOffset();
      const tzOffset = this.getTimezoneOffsetMinutes(timezone, target);
      return target.getTime() + (localOffset - tzOffset) * 60000;
    }

    // Local timezone
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime();
  }

  private getTimezoneOffsetMinutes(timezone: string, date: Date): number {
    const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC', hour12: false });
    const tzStr = date.toLocaleString('en-US', { timeZone: timezone, hour12: false });
    const utcDate = new Date(utcStr);
    const tzDate = new Date(tzStr);
    return (utcDate.getTime() - tzDate.getTime()) / 60000;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Persistence
  // ═══════════════════════════════════════════════════════════════════

  private async persistToStorage(): Promise<void> {
    if (!this.storageId) return;
    try {
      await this.request(request(this.id, this.storageId, 'set', {
        key: STORAGE_KEY,
        value: { counter: this.entryCounter, entries: [...this.entries.values()] },
      }));
    } catch (err) {
      log.warn('Failed to persist schedules:', err instanceof Error ? err.message : String(err));
    }
  }

  private async loadFromStorage(): Promise<void> {
    if (!this.storageId) return;
    try {
      const data = await this.request<{ counter: number; entries: ScheduleEntry[] } | null>(
        request(this.id, this.storageId, 'get', { key: STORAGE_KEY }),
      );
      if (data?.entries) {
        this.entryCounter = data.counter ?? 0;
        for (const entry of data.entries) {
          this.entries.set(entry.id, entry);
        }
        log.info(`Loaded ${this.entries.size} schedule entries from storage`);

        // Clean up duplicates accumulated from previous sessions.
        // Keys by jobCode + schedule identity (interval / daily / one-shot).
        // Keeps the oldest entry, drops the rest.
        const seen = new Map<string, ScheduleEntry>();
        const toRemove: string[] = [];
        const sorted = [...this.entries.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
        for (const entry of sorted) {
          let key: string;
          if (entry.intervalMs !== undefined) {
            key = `interval:${entry.intervalMs}:${entry.jobCode}`;
          } else if (entry.runAt !== undefined) {
            key = `once:${entry.runAt}:${entry.jobCode}`;
          } else {
            key = `daily:${entry.hour}:${entry.minute}:${entry.timezone ?? ''}:${entry.jobCode}`;
          }
          if (seen.has(key)) {
            toRemove.push(entry.id);
          } else {
            seen.set(key, entry);
          }
        }

        // Drop one-shot entries that have already fired and somehow
        // survived (e.g. the process died between fire and persist).
        // `lastRun > 0` means it ran at least once.
        for (const entry of this.entries.values()) {
          if (entry.runAt !== undefined && entry.lastRun > 0 && !toRemove.includes(entry.id)) {
            toRemove.push(entry.id);
          }
        }

        if (toRemove.length > 0) {
          for (const id of toRemove) this.entries.delete(id);
          log.info(`Dedup: removed ${toRemove.length} duplicate / spent schedule(s) on load`);
          await this.persistToStorage();
        }
      }
    } catch (err) {
      log.warn('Failed to load schedules:', err instanceof Error ? err.message : String(err));
    }
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.entryCounter >= 0, 'entryCounter must be non-negative');
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## Scheduler Usage Guide

Use the Scheduler for ALL recurring/periodic/timed tasks AND one-shot future tasks. Do NOT create new objects for scheduling. Pick the method by the schedule shape:

- \`addSchedule\`     — repeats every N ms forever
- \`addScheduleAt\`   — repeats daily at HH:MM (optional timezone)
- \`addScheduleOnce\` — fires once at an absolute date+time, then auto-deletes

### Simple example: post to chat every minute

  const { scheduleId } = await call(await dep('Scheduler'), 'addSchedule', {
    description: 'Say hello every minute',
    intervalMs: 60000,
    jobCode: 'const chat = await find("Chat"); await call(chat, "addNotification", { sender: "Scheduler", message: "hello world" });',
  });

### Add a recurring schedule (by interval)

  const { scheduleId } = await call(await dep('Scheduler'), 'addSchedule', {
    description: 'Check news every hour',
    intervalMs: 3600000,
    jobCode: 'const gm = await dep("GoalManager"); const ts = await dep("TupleSpace"); const r = await call(gm, "createGoal", { title: "Hourly news check" }); await call(ts, "put", { namespace: r.goalId, fields: { type: "task", status: "pending", goalId: r.goalId, description: "Check news headlines" } }); return r;',
  });

### Add a daily schedule at a specific time

  const { scheduleId } = await call(await dep('Scheduler'), 'addScheduleAt', {
    description: 'Daily weather briefing',
    hour: 6,
    minute: 30,
    timezone: 'America/Los_Angeles',
    jobCode: 'const gm = await dep("GoalManager"); const ts = await dep("TupleSpace"); const r = await call(gm, "createGoal", { title: "Daily weather briefing" }); await call(ts, "put", { namespace: r.goalId, fields: { type: "task", status: "pending", goalId: r.goalId, description: "Fetch weather and news for daily briefing" } }); return r;',
  });

### Add a one-shot schedule (fires once at a specific date+time, then auto-deletes)

  const runAt = Date.parse('2026-05-15T14:30:00-07:00'); // unix-ms timestamp
  const { scheduleId } = await call(await dep('Scheduler'), 'addScheduleOnce', {
    description: 'Remind me about the dentist appointment',
    runAt,
    jobCode: 'const chat = await find("Chat"); await call(chat, "addNotification", { sender: "Scheduler", message: "Dentist appointment in 30 minutes" });',
  });
  // Pass any absolute timestamp: Date.parse(...), Date.UTC(...), Date.now() + delayMs, etc.
  // The entry persists across restarts. After firing it is removed from listSchedules automatically.

### Manage schedules

  await call(await dep('Scheduler'), 'disableSchedule', { scheduleId: 'sched-1' });
  await call(await dep('Scheduler'), 'enableSchedule', { scheduleId: 'sched-1' });
  await call(await dep('Scheduler'), 'removeSchedule', { scheduleId: 'sched-1' });

### List all schedules

  const schedules = await call(await dep('Scheduler'), 'listSchedules', {});
  // schedules: [{ id, description, intervalMs?, hour?, minute?, timezone?, runAt?, enabled, lastRun, nextRun }]

### Job Code

The jobCode runs in JobManager's sandbox with access to:
- \`call(target, method, payload)\` — invoke a method on another object.
- \`dep(name)\` — resolve a dependency by name. Returns a Promise<AbjectId> (a plain string).
- \`find(query)\` — find an object in the registry. Returns a Promise<AbjectId | undefined>.
- \`id\` — the Scheduler's AbjectId.

\`dep\` and \`find\` resolve to AbjectIds. Every method lives on the receiver, so invocations look like \`const id = await dep('Name'); await call(id, 'method', { ...params })\`. The id on its own has no methods attached. A minimal example:

  const storageId = await dep('Storage');
  const prev = await call(storageId, 'get', { key: 'my-counter' });
  await call(storageId, 'set', { key: 'my-counter', value: (prev ?? 0) + 1 });

Ask the objects you plan to call via the ask protocol when you need their specific method signatures — each one's ask response includes its full API.

For longer work, dispatch through GoalManager + TupleSpace so an agent picks it up.

### IMPORTANT
- Schedules persist across restarts (saved to Storage)
- Job code runs in a sandboxed environment -- no require, fetch, setTimeout
- The Scheduler ticks every 60 seconds -- schedules have ~1 minute precision
- For daily schedules, timezone defaults to local if not specified
- One-shot schedules (\`addScheduleOnce\`) auto-delete after firing; if a runAt is in the past, it fires on the next tick and then deletes`;
  }

  protected override async handleAsk(question: string): Promise<string> {
    let prompt = this.askPrompt(question);

    // Include current schedule summary
    const entries = [...this.entries.values()];
    const enabled = entries.filter(e => e.enabled);
    prompt += `\n\n### Current Schedules\n`;
    prompt += `${entries.length} total, ${enabled.length} enabled.\n`;
    if (entries.length > 0) {
      for (const e of entries) {
        let timing: string;
        if (e.intervalMs) {
          timing = `every ${e.intervalMs < 60000 ? Math.round(e.intervalMs / 1000) + 's' : e.intervalMs < 3600000 ? Math.round(e.intervalMs / 60000) + 'm' : (e.intervalMs / 3600000).toFixed(1) + 'h'}`;
        } else if (e.runAt !== undefined) {
          timing = `once at ${new Date(e.runAt).toISOString()}`;
        } else {
          timing = `daily at ${String(e.hour ?? 0).padStart(2, '0')}:${String(e.minute ?? 0).padStart(2, '0')} ${e.timezone ?? 'local'}`;
        }
        const status = e.enabled ? 'enabled' : 'disabled';
        prompt += `- ${e.description} (${timing}, ${status})\n`;
      }
    }

    return this.askLlm(prompt, question, 'balanced');
  }
}

export const SCHEDULER_ID = 'abjects:scheduler' as AbjectId;
