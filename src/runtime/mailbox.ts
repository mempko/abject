/**
 * Async message queue for objects.
 */

import { AbjectMessage } from '../core/types.js';
import { require, ensure, invariant, requirePositive } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';

const log = new Log('Mailbox');

/**
 * A bounded async message queue.
 */
export class Mailbox {
  private queue: AbjectMessage[] = [];
  private waiters: { resolve: (msg: AbjectMessage) => void; reject: (err: Error) => void }[] = [];
  private closed = false;
  private _droppedClosed = 0;
  private _droppedFull = 0;

  constructor(private readonly maxSize: number = 1000) {
    requirePositive(maxSize, 'maxSize');
  }

  /**
   * Add a message to the queue.
   * Drops if closed or full; drops are counted and logged (throttled).
   */
  send(message: AbjectMessage): void {
    if (this.closed) {
      this._droppedClosed++;
      if (this._droppedClosed === 1 || this._droppedClosed % 100 === 0) {
        log.warn(
          `drop: closed mailbox (to=${message.routing.to}, method=${message.routing.method ?? ''}, type=${message.header.type}, total=${this._droppedClosed})`
        );
      }
      return;
    }
    if (this.queue.length >= this.maxSize) {
      this._droppedFull++;
      if (this._droppedFull === 1 || this._droppedFull % 100 === 0) {
        log.warn(
          `drop: full mailbox (to=${message.routing.to}, method=${message.routing.method ?? ''}, type=${message.header.type}, size=${this.queue.length}/${this.maxSize}, total=${this._droppedFull})`
        );
      }
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(message);
    } else {
      this.queue.push(message);
    }
  }

  /**
   * Count of messages dropped because the mailbox was closed.
   */
  get droppedClosed(): number {
    return this._droppedClosed;
  }

  /**
   * Count of messages dropped because the mailbox was full.
   */
  get droppedFull(): number {
    return this._droppedFull;
  }

  /**
   * Receive the next message, blocking if empty.
   */
  async receive(): Promise<AbjectMessage> {
    const msg = this.queue.shift();
    if (msg) {
      return msg;
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /**
   * Try to receive a message without blocking.
   * Returns undefined if no message is available.
   */
  tryReceive(): AbjectMessage | undefined {
    return this.queue.shift();
  }

  /**
   * Receive with timeout.
   * Returns undefined if timeout expires.
   */
  async receiveTimeout(timeoutMs: number): Promise<AbjectMessage | undefined> {
    require(!this.closed, 'Mailbox is closed');
    requirePositive(timeoutMs, 'timeoutMs');

    const msg = this.queue.shift();
    if (msg) {
      return msg;
    }

    return new Promise((resolve) => {
      let resolved = false;

      const waiterObj = {
        resolve: (m: AbjectMessage) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve(m);
          }
        },
        reject: (_err: Error) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve(undefined);
          }
        },
      };

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          const idx = this.waiters.indexOf(waiterObj);
          if (idx >= 0) {
            this.waiters.splice(idx, 1);
          }
          resolve(undefined);
        }
      }, timeoutMs);

      this.waiters.push(waiterObj);
    });
  }

  /**
   * Peek at the next message without removing it.
   */
  peek(): AbjectMessage | undefined {
    return this.queue[0];
  }

  /**
   * Get the current queue size.
   */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Check if the mailbox is empty.
   */
  get isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Check if the mailbox is full.
   */
  get isFull(): boolean {
    return this.queue.length >= this.maxSize;
  }

  /**
   * Check if the mailbox is closed.
   */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Get the number of waiters.
   */
  get waiterCount(): number {
    return this.waiters.length;
  }

  /**
   * Close the mailbox. No more messages can be sent.
   * Pending receivers will throw.
   */
  close(): void {
    this.closed = true;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(new Error('Mailbox closed'));
    }
    ensure(this.waiters.length === 0, 'All waiters must be cleared');
  }

  /**
   * Clear all messages from the queue.
   */
  clear(): AbjectMessage[] {
    const messages = this.queue.splice(0);
    ensure(this.queue.length === 0, 'Queue must be empty after clear');
    return messages;
  }

  /**
   * Get all messages without removing them.
   */
  drain(): AbjectMessage[] {
    return [...this.queue];
  }

  /**
   * Check class invariants.
   */
  private checkInvariants(): void {
    invariant(this.queue.length >= 0, 'Queue length must be non-negative');
    invariant(
      this.queue.length <= this.maxSize,
      'Queue length must not exceed maxSize'
    );
    invariant(this.waiters.length >= 0, 'Waiter count must be non-negative');
    invariant(
      this.queue.length === 0 || this.waiters.length === 0,
      'Cannot have both queued messages and waiters'
    );
  }
}

/**
 * Priority mailbox that processes messages by priority.
 *
 * Event-driven: receive() parks a waiter until send() arrives. No polling.
 * Inner per-priority mailboxes are used as pure FIFO queues (we never call
 * their receive()), so their waiter lists stay empty and send() always
 * enqueues through the queue path.
 */
export class PriorityMailbox {
  private queues: Map<number, Mailbox> = new Map();
  private priorities: number[] = [];
  private waiters: ((msg: AbjectMessage) => void)[] = [];

  constructor(
    private readonly _maxSizePerPriority: number = 100,
    priorities: number[] = [0, 1, 2]
  ) {
    requirePositive(_maxSizePerPriority, 'maxSizePerPriority');

    this.priorities = [...priorities].sort((a, b) => b - a); // Higher priority first
    for (const p of this.priorities) {
      this.queues.set(p, new Mailbox(_maxSizePerPriority));
    }
  }

  /**
   * Send a message with a priority.
   */
  send(message: AbjectMessage, priority = 0): void {
    let queue = this.queues.get(priority);
    if (!queue) {
      queue = this.queues.get(0);
      require(queue !== undefined, 'Default priority queue must exist');
    }
    queue.send(message);

    // Wake one waiter, handing it the highest-priority pending message
    // (which may not be the message we just sent).
    if (this.waiters.length > 0) {
      const msg = this.tryReceive();
      if (msg) {
        const waiter = this.waiters.shift()!;
        waiter(msg);
      }
    }
  }

  /**
   * Receive the highest priority message. Resolves as soon as a message is
   * available; parks until send() delivers one otherwise.
   */
  async receive(): Promise<AbjectMessage> {
    const msg = this.tryReceive();
    if (msg) return msg;

    return new Promise<AbjectMessage>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * Try to receive without blocking.
   */
  tryReceive(): AbjectMessage | undefined {
    for (const p of this.priorities) {
      const queue = this.queues.get(p)!;
      const msg = queue.tryReceive();
      if (msg) {
        return msg;
      }
    }
    return undefined;
  }

  /**
   * Get total size across all priorities.
   */
  get size(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.size;
    }
    return total;
  }
}
