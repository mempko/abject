/**
 * Timer capability object - provides timing and scheduling capabilities.
 */

import { AbjectId, AbjectMessage } from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { require } from '../../core/contracts.js';
import { event, request } from '../../core/message.js';
import { Capabilities } from '../../core/capability.js';

const TIMER_INTERFACE = 'abjects:timer';

export interface TimerInfo {
  id: string;
  objectId: AbjectId;
  delayMs: number;
  interval: boolean;
  createdAt: number;
  nextFireAt: number;
}

/**
 * Timer capability object.
 */
export class Timer extends Abject {
  private timers: Map<string, { info: TimerInfo; handle: ReturnType<typeof setTimeout> }> = new Map();
  private timerCounter = 0;

  constructor() {
    super({
      manifest: {
        name: 'Timer',
        description:
          'Provides timing capabilities. Objects can schedule one-shot or repeating timers and receive callbacks. Use cases: create a 60fps animation/game loop, set a one-shot delay, schedule repeating tasks at intervals.',
        version: '1.0.0',
        interface: {
            id: TIMER_INTERFACE,
            name: 'Timer',
            description: 'Timer and scheduling operations',
            methods: [
              {
                name: 'setTimeout',
                description: 'Schedule a one-shot timer',
                parameters: [
                  {
                    name: 'delayMs',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'Delay in milliseconds',
                  },
                  {
                    name: 'data',
                    type: { kind: 'reference', reference: 'any' },
                    description: 'Data to include in callback',
                    optional: true,
                  },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'setInterval',
                description: 'Schedule a repeating timer',
                parameters: [
                  {
                    name: 'intervalMs',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'Interval in milliseconds',
                  },
                  {
                    name: 'data',
                    type: { kind: 'reference', reference: 'any' },
                    description: 'Data to include in callbacks',
                    optional: true,
                  },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'clearTimer',
                description: 'Cancel a timer',
                parameters: [
                  {
                    name: 'timerId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Timer ID to cancel',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getTimerInfo',
                description: 'Get information about a timer',
                parameters: [
                  {
                    name: 'timerId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Timer ID',
                  },
                ],
                returns: {
                  kind: 'union',
                  variants: [
                    { kind: 'reference', reference: 'TimerInfo' },
                    { kind: 'primitive', primitive: 'null' },
                  ],
                },
              },
              {
                name: 'clearTimersForObject',
                description: 'Cancel all timers belonging to a specific object',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Object whose timers to cancel',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'number' },
              },
              {
                name: 'delay',
                description: 'Wait for a specified duration (returns immediately, fires event later)',
                parameters: [
                  {
                    name: 'ms',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'Duration in milliseconds',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
            ],
            events: [
              {
                name: 'timerFired',
                description: 'Timer has fired',
                payload: {
                  kind: 'object',
                  properties: {
                    timerId: { kind: 'primitive', primitive: 'string' },
                    data: { kind: 'reference', reference: 'any' },
                  },
                },
              },
            ],
          },
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.TIMER],
        tags: ['system', 'capability', 'timer', 'scheduling'],
      },
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('setTimeout', async (msg: AbjectMessage) => {
      const { delayMs, data } = msg.payload as {
        delayMs: number;
        data?: unknown;
      };
      return this.scheduleTimeout(msg.routing.from, delayMs, data);
    });

    this.on('setInterval', async (msg: AbjectMessage) => {
      const { intervalMs, data } = msg.payload as {
        intervalMs: number;
        data?: unknown;
      };
      return this.scheduleInterval(msg.routing.from, intervalMs, data);
    });

    this.on('clearTimer', async (msg: AbjectMessage) => {
      const { timerId } = msg.payload as { timerId: string };
      return this.clearTimer(timerId, msg.routing.from);
    });

    this.on('getTimerInfo', async (msg: AbjectMessage) => {
      const { timerId } = msg.payload as { timerId: string };
      return this.getTimerInfo(timerId);
    });

    this.on('delay', async (msg: AbjectMessage) => {
      const { ms } = msg.payload as { ms: number };
      return this.scheduleTimeout(msg.routing.from, ms);
    });

    this.on('clearTimersForObject', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: AbjectId };
      return this.clearTimersForObject(objectId);
    });

    this.on('objectUnregistered', async (msg: AbjectMessage) => {
      const objectId = msg.payload as AbjectId;
      this.clearTimersForObject(objectId);
    });
  }

  protected override async onInit(): Promise<void> {
    const registryId = await this.discoverDep('Registry');
    if (registryId) {
      try {
        await this.request(request(this.id, registryId,
          'subscribe', {}));
      } catch { /* best effort */ }
    }
  }

  /**
   * Cancel all timers belonging to a specific object.
   */
  clearTimersForObject(objectId: AbjectId): number {
    let count = 0;
    for (const [timerId, timer] of this.timers.entries()) {
      if (timer.info.objectId === objectId) {
        if (timer.info.interval) clearInterval(timer.handle);
        else clearTimeout(timer.handle);
        this.timers.delete(timerId);
        count++;
      }
    }
    return count;
  }

  /**
   * Schedule a one-shot timeout.
   */
  scheduleTimeout(objectId: AbjectId, delayMs: number, data?: unknown): string {
    require(delayMs >= 0, 'delayMs must be non-negative');

    const timerId = this.generateTimerId();
    const now = Date.now();

    const info: TimerInfo = {
      id: timerId,
      objectId,
      delayMs,
      interval: false,
      createdAt: now,
      nextFireAt: now + delayMs,
    };

    const handle = setTimeout(() => {
      this.fireTimer(timerId, data);
      this.timers.delete(timerId);
    }, delayMs);

    this.timers.set(timerId, { info, handle });

    return timerId;
  }

  /**
   * Schedule a repeating interval.
   */
  scheduleInterval(
    objectId: AbjectId,
    intervalMs: number,
    data?: unknown
  ): string {
    require(intervalMs > 0, 'intervalMs must be positive');

    const timerId = this.generateTimerId();
    const now = Date.now();

    const info: TimerInfo = {
      id: timerId,
      objectId,
      delayMs: intervalMs,
      interval: true,
      createdAt: now,
      nextFireAt: now + intervalMs,
    };

    const handle = setInterval(() => {
      this.fireTimer(timerId, data);
      const timer = this.timers.get(timerId);
      if (timer) {
        timer.info.nextFireAt = Date.now() + intervalMs;
      }
    }, intervalMs);

    this.timers.set(timerId, { info, handle: handle as unknown as ReturnType<typeof setTimeout> });

    return timerId;
  }

  /**
   * Clear a timer.
   */
  clearTimer(timerId: string, requesterId: AbjectId): boolean {
    const timer = this.timers.get(timerId);
    if (!timer) {
      return false;
    }

    // Only the owning object can clear the timer
    if (timer.info.objectId !== requesterId) {
      return false;
    }

    if (timer.info.interval) {
      clearInterval(timer.handle);
    } else {
      clearTimeout(timer.handle);
    }

    this.timers.delete(timerId);
    return true;
  }

  /**
   * Get timer information.
   */
  getTimerInfo(timerId: string): TimerInfo | null {
    const timer = this.timers.get(timerId);
    return timer?.info ?? null;
  }

  /**
   * Fire a timer - send event to the owning object.
   */
  private async fireTimer(timerId: string, data?: unknown): Promise<void> {
    const timer = this.timers.get(timerId);
    if (!timer) {
      return;
    }

    this.send(
      event(this.id, timer.info.objectId, 'timerFired', {
        timerId,
        data,
      })
    );
  }

  /**
   * Generate a unique timer ID.
   */
  private generateTimerId(): string {
    return `timer-${++this.timerCounter}-${Date.now()}`;
  }

  /**
   * Get active timer count.
   */
  get activeTimerCount(): number {
    return this.timers.size;
  }

  /**
   * Clear all timers (for cleanup).
   */
  clearAllTimers(): void {
    for (const [, timer] of this.timers) {
      if (timer.info.interval) {
        clearInterval(timer.handle);
      } else {
        clearTimeout(timer.handle);
      }
    }
    this.timers.clear();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## Timer Usage Guide

### Setting Up an Animation Timer (setInterval)

  this._timerId = await this.call(
    this.dep('Timer'), 'setInterval',
    { intervalMs: 16, data: { type: 'animate' } });

### One-Shot Timer (setTimeout)

  const timerId = await this.call(
    this.dep('Timer'), 'setTimeout',
    { delayMs: 1000, data: { type: 'delayed-action' } });

### Clearing a Timer

  await this.call(
    this.dep('Timer'), 'clearTimer',
    { timerId: this._timerId });
  this._timerId = null;

### Handling Timer Events

When a timer fires, the Timer object sends a 'timerFired' event to the object that created it.
Implement a handler for it:

  async timerFired(msg) {
    const { timerId, data } = msg.payload;
    if (data && data.type === 'animate') {
      await this._draw();
    }
  }

### IMPORTANT
- ALWAYS clear timers in your hide() handler. Leaking timers causes errors after the surface is destroyed.
- Do NOT use native setTimeout/setInterval directly — they won't work. Always go through the Timer object.
- The 'data' field in setInterval/setTimeout is passed back in the timerFired event, use it to distinguish timer types.`;
  }

  protected async onStop(): Promise<void> {
    this.clearAllTimers();
  }
}

// Well-known timer ID
export const TIMER_ID = 'abjects:timer' as AbjectId;
