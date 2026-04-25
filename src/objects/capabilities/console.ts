/**
 * Console capability object — per-object, per-workspace log buffers.
 *
 * Each Abject's logs land in its own ring buffer (capped) so a noisy object
 * can't evict a quiet object's history. Entries are injected via the explicit
 * `logFor` method (used by LogRouter and the Abject base-class helpers) and
 * via the legacy `debug`/`info`/`warn`/`error` handlers (which derive
 * objectId from `msg.routing.from`). On Registry unregister events, the
 * corresponding object's buffer is dropped so memory doesn't accumulate
 * across object lifetimes.
 */

import { AbjectId, AbjectMessage } from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { Capabilities } from '../../core/capability.js';
import { request } from '../../core/message.js';

const CONSOLE_INTERFACE = 'abjects:console';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  objectId: AbjectId;
  message: string;
  data?: unknown;
}

/**
 * Per-object, per-workspace debug console.
 */
export class Console extends Abject {
  private logsByObject: Map<AbjectId, LogEntry[]> = new Map();
  private maxLogsPerObject = 1000;
  private enabled = true;

  constructor() {
    super({
      manifest: {
        name: 'Console',
        description:
          'Per-object debug console. Each object has its own log buffer capped at 1000 entries. Use logFor to inject entries on behalf of another object; debug/info/warn/error use the sender\'s id. Query a single object\'s history with getObjectLogs.',
        version: '1.0.0',
        interface: {
          id: CONSOLE_INTERFACE,
          name: 'Console',
          description: 'Per-object debug logging operations',
          methods: [
            {
              name: 'debug',
              description: 'Log a debug message under the sender\'s objectId',
              parameters: [
                { name: 'message', type: { kind: 'primitive', primitive: 'string' }, description: 'Message to log' },
                { name: 'data', type: { kind: 'reference', reference: 'any' }, description: 'Additional data', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'info',
              description: 'Log an info message under the sender\'s objectId',
              parameters: [
                { name: 'message', type: { kind: 'primitive', primitive: 'string' }, description: 'Message to log' },
                { name: 'data', type: { kind: 'reference', reference: 'any' }, description: 'Additional data', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'warn',
              description: 'Log a warning message under the sender\'s objectId',
              parameters: [
                { name: 'message', type: { kind: 'primitive', primitive: 'string' }, description: 'Message to log' },
                { name: 'data', type: { kind: 'reference', reference: 'any' }, description: 'Additional data', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'error',
              description: 'Log an error message under the sender\'s objectId',
              parameters: [
                { name: 'message', type: { kind: 'primitive', primitive: 'string' }, description: 'Message to log' },
                { name: 'data', type: { kind: 'reference', reference: 'any' }, description: 'Additional data', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'logFor',
              description: 'Inject a log entry on behalf of an arbitrary object (used by LogRouter)',
              parameters: [
                { name: 'level', type: { kind: 'primitive', primitive: 'string' }, description: 'Log level: debug, info, warn, error' },
                { name: 'objectId', type: { kind: 'primitive', primitive: 'string' }, description: 'Object the entry belongs to' },
                { name: 'message', type: { kind: 'primitive', primitive: 'string' }, description: 'Message to log' },
                { name: 'data', type: { kind: 'reference', reference: 'any' }, description: 'Additional data', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'getLogs',
              description: 'Get recent log entries across all objects, merged and sorted by timestamp',
              parameters: [
                { name: 'count', type: { kind: 'primitive', primitive: 'number' }, description: 'Number of entries to return', optional: true },
                { name: 'level', type: { kind: 'primitive', primitive: 'string' }, description: 'Filter by log level', optional: true },
              ],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'LogEntry' } },
            },
            {
              name: 'getObjectLogs',
              description: 'Get recent log entries for a single object',
              parameters: [
                { name: 'objectId', type: { kind: 'primitive', primitive: 'string' }, description: 'Object whose logs to return' },
                { name: 'count', type: { kind: 'primitive', primitive: 'number' }, description: 'Number of entries to return', optional: true },
                { name: 'level', type: { kind: 'primitive', primitive: 'string' }, description: 'Filter by log level', optional: true },
              ],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'LogEntry' } },
            },
            {
              name: 'clear',
              description: 'Clear all logs for every object',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'clearObjectLogs',
              description: 'Clear logs for a single object',
              parameters: [
                { name: 'objectId', type: { kind: 'primitive', primitive: 'string' }, description: 'Object whose logs to clear' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'setEnabled',
              description: 'Enable or disable logging globally for this Console',
              parameters: [
                { name: 'enabled', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Whether logging is enabled' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.CONSOLE],
        tags: ['system', 'capability', 'console', 'debug'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    const registryId = await this.resolveRegistryId();
    if (registryId) {
      try {
        await this.request(request(this.id, registryId, 'subscribe', {}));
      } catch { /* Registry not ready — skip auto-eviction */ }
    }
  }

  private setupHandlers(): void {
    this.on('debug', (msg: AbjectMessage) => {
      const { message, data } = msg.payload as { message: string; data?: unknown };
      return this.writeLog('debug', msg.routing.from, message, data);
    });

    this.on('info', (msg: AbjectMessage) => {
      const { message, data } = msg.payload as { message: string; data?: unknown };
      return this.writeLog('info', msg.routing.from, message, data);
    });

    this.on('warn', (msg: AbjectMessage) => {
      const { message, data } = msg.payload as { message: string; data?: unknown };
      return this.writeLog('warn', msg.routing.from, message, data);
    });

    this.on('error', (msg: AbjectMessage) => {
      const { message, data } = msg.payload as { message: string; data?: unknown };
      return this.writeLog('error', msg.routing.from, message, data);
    });

    this.on('logFor', (msg: AbjectMessage) => {
      const { level, objectId, message, data } = msg.payload as {
        level: LogLevel; objectId: AbjectId; message: string; data?: unknown;
      };
      return this.writeLog(level, objectId, message, data);
    });

    this.on('getLogs', (msg: AbjectMessage) => {
      const { count, level } = msg.payload as { count?: number; level?: LogLevel };
      return this.getLogs(count, level);
    });

    this.on('getObjectLogs', async (msg: AbjectMessage) => {
      const { objectId, count, level } = msg.payload as {
        objectId: AbjectId; count?: number; level?: LogLevel;
      };
      const resolved = await this.resolveLogTarget(objectId);
      return this.getObjectLogs(resolved ?? objectId, count, level);
    });

    this.on('clear', () => this.clearLogs());

    this.on('clearObjectLogs', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: AbjectId };
      const resolved = await this.resolveLogTarget(objectId);
      return this.clearObjectLogs(resolved ?? objectId);
    });

    this.on('setEnabled', (msg: AbjectMessage) => {
      const { enabled } = msg.payload as { enabled: boolean };
      this.enabled = enabled;
      return true;
    });

    this.on('objectUnregistered', (msg: AbjectMessage) => {
      const objectId = msg.payload as AbjectId;
      this.logsByObject.delete(objectId);
    });
  }

  /**
   * Append a log entry to the specified object's buffer.
   */
  private writeLog(level: LogLevel, objectId: AbjectId, message: string, data?: unknown): boolean {
    if (!this.enabled) return false;

    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      objectId,
      message,
      data,
    };

    let buffer = this.logsByObject.get(objectId);
    if (!buffer) {
      buffer = [];
      this.logsByObject.set(objectId, buffer);
    }
    buffer.push(entry);
    if (buffer.length > this.maxLogsPerObject) {
      buffer.splice(0, buffer.length - this.maxLogsPerObject);
    }

    const prefix = `[${objectId}]`;
    switch (level) {
      case 'debug': console.debug(prefix, message, data ?? ''); break;
      case 'info':  console.info(prefix, message, data ?? '');  break;
      case 'warn':  console.warn(prefix, message, data ?? '');  break;
      case 'error': console.error(prefix, message, data ?? ''); break;
    }

    return true;
  }

  /**
   * Merge entries across all objects, sort by timestamp ascending, and
   * optionally filter/trim. Returns a plain array (callers may receive it
   * through the message bus, so no shared references).
   */
  getLogs(count?: number, level?: LogLevel): LogEntry[] {
    const merged: LogEntry[] = [];
    for (const buf of this.logsByObject.values()) {
      for (const e of buf) {
        if (!level || e.level === level) merged.push(e);
      }
    }
    merged.sort((a, b) => a.timestamp - b.timestamp);
    if (count !== undefined && count >= 0) {
      return merged.slice(-count);
    }
    return merged;
  }

  getObjectLogs(objectId: AbjectId, count?: number, level?: LogLevel): LogEntry[] {
    const buf = this.logsByObject.get(objectId);
    if (!buf) return [];
    let entries = level ? buf.filter((e) => e.level === level) : buf.slice();
    if (count !== undefined && count >= 0) {
      entries = entries.slice(-count);
    }
    return entries;
  }

  clearLogs(): boolean {
    this.logsByObject.clear();
    return true;
  }

  clearObjectLogs(objectId: AbjectId): boolean {
    return this.logsByObject.delete(objectId);
  }

  /**
   * Accept either an AbjectId (UUID) or a registered object name. If direct
   * lookup by AbjectId misses, try to resolve `idOrName` as a name via the
   * Registry's discover handler. This lets agents debug by the familiar
   * registered name without having to look the UUID up first.
   * Returns the resolved AbjectId, or undefined on miss.
   */
  private async resolveLogTarget(idOrName: string): Promise<AbjectId | undefined> {
    if (this.logsByObject.has(idOrName)) return idOrName as AbjectId;
    const registryId = await this.resolveRegistryId().catch(() => null);
    if (!registryId) return undefined;
    try {
      const results = await this.request<Array<{ id: AbjectId }>>(
        request(this.id, registryId, 'discover', { name: idOrName })
      );
      if (results && results.length > 0) return results[0].id;
    } catch { /* registry not available */ }
    return undefined;
  }

  get logCount(): number {
    let total = 0;
    for (const buf of this.logsByObject.values()) total += buf.length;
    return total;
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## Console Usage Guide

### Log at Different Levels

  await this.call(
    this.dep('Console'), 'info',
    { message: 'Operation completed', data: { result: 42 } });

  await this.call(
    this.dep('Console'), 'warn',
    { message: 'Rate limit approaching', data: { remaining: 5 } });

The sender's objectId is recorded automatically for debug/info/warn/error.

### Query a Single Object's History

  const entries = await this.call(
    this.dep('Console'), 'getObjectLogs',
    { objectId: someObjectId, count: 50 });

\`objectId\` accepts either the AbjectId UUID or the registered object name
(e.g. 'TelegramBridge' or 'TelegramBridge-2'). Names are resolved via the
Registry's discover handler, so debugging agents can use the name they
already know without a separate lookup.

### Inject on Behalf of Another Object

  await this.call(
    this.dep('Console'), 'logFor',
    { level: 'error', objectId: someObjectId, message: 'Handler threw', data: { stack } });

### IMPORTANT
- Logs are stored in memory, capped at 1000 entries per object; the oldest
  fall off first. Registry unregister events evict the whole buffer.
- Do NOT use console.log() directly — always go through the Console object.`;
  }
}

export const CONSOLE_ID = 'abjects:console' as AbjectId;
