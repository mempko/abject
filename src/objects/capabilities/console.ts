/**
 * Console capability object - provides debug logging capabilities.
 */

import { AbjectId, AbjectMessage } from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { Capabilities } from '../../core/capability.js';

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
 * Console capability object for debugging.
 */
export class Console extends Abject {
  private logs: LogEntry[] = [];
  private maxLogs = 1000;
  private enabled = true;

  constructor() {
    super({
      manifest: {
        name: 'Console',
        description:
          'Debug console for logging. Objects can log messages at different levels for debugging. Use cases: log debug messages, record errors and warnings for diagnostics.',
        version: '1.0.0',
        interface: {
            id: CONSOLE_INTERFACE,
            name: 'Console',
            description: 'Debug logging operations',
            methods: [
              {
                name: 'debug',
                description: 'Log a debug message',
                parameters: [
                  {
                    name: 'message',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Message to log',
                  },
                  {
                    name: 'data',
                    type: { kind: 'reference', reference: 'any' },
                    description: 'Additional data',
                    optional: true,
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'info',
                description: 'Log an info message',
                parameters: [
                  {
                    name: 'message',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Message to log',
                  },
                  {
                    name: 'data',
                    type: { kind: 'reference', reference: 'any' },
                    description: 'Additional data',
                    optional: true,
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'warn',
                description: 'Log a warning message',
                parameters: [
                  {
                    name: 'message',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Message to log',
                  },
                  {
                    name: 'data',
                    type: { kind: 'reference', reference: 'any' },
                    description: 'Additional data',
                    optional: true,
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'error',
                description: 'Log an error message',
                parameters: [
                  {
                    name: 'message',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Message to log',
                  },
                  {
                    name: 'data',
                    type: { kind: 'reference', reference: 'any' },
                    description: 'Additional data',
                    optional: true,
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getLogs',
                description: 'Get recent log entries',
                parameters: [
                  {
                    name: 'count',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'Number of entries to return',
                    optional: true,
                  },
                  {
                    name: 'level',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Filter by log level',
                    optional: true,
                  },
                ],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'reference', reference: 'LogEntry' },
                },
              },
              {
                name: 'clear',
                description: 'Clear all logs',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'setEnabled',
                description: 'Enable or disable logging',
                parameters: [
                  {
                    name: 'enabled',
                    type: { kind: 'primitive', primitive: 'boolean' },
                    description: 'Whether logging is enabled',
                  },
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

  private setupHandlers(): void {
    this.on('debug', async (msg: AbjectMessage) => {
      const { message, data } = msg.payload as { message: string; data?: unknown };
      return this.log('debug', msg.routing.from, message, data);
    });

    this.on('info', async (msg: AbjectMessage) => {
      const { message, data } = msg.payload as { message: string; data?: unknown };
      return this.log('info', msg.routing.from, message, data);
    });

    this.on('warn', async (msg: AbjectMessage) => {
      const { message, data } = msg.payload as { message: string; data?: unknown };
      return this.log('warn', msg.routing.from, message, data);
    });

    this.on('error', async (msg: AbjectMessage) => {
      const { message, data } = msg.payload as { message: string; data?: unknown };
      return this.log('error', msg.routing.from, message, data);
    });

    this.on('getLogs', async (msg: AbjectMessage) => {
      const { count, level } = msg.payload as { count?: number; level?: LogLevel };
      return this.getLogs(count, level);
    });

    this.on('clear', async () => {
      return this.clearLogs();
    });

    this.on('setEnabled', async (msg: AbjectMessage) => {
      const { enabled } = msg.payload as { enabled: boolean };
      this.enabled = enabled;
      return true;
    });
  }

  /**
   * Log a message.
   */
  log(level: LogLevel, objectId: AbjectId, message: string, data?: unknown): boolean {
    if (!this.enabled) {
      return false;
    }

    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      objectId,
      message,
      data,
    };

    this.logs.push(entry);

    // Trim if needed
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    // Also log to browser console
    const prefix = `[${objectId}]`;
    switch (level) {
      case 'debug':
        console.debug(prefix, message, data ?? '');
        break;
      case 'info':
        console.info(prefix, message, data ?? '');
        break;
      case 'warn':
        console.warn(prefix, message, data ?? '');
        break;
      case 'error':
        console.error(prefix, message, data ?? '');
        break;
    }

    return true;
  }

  /**
   * Get recent log entries.
   */
  getLogs(count?: number, level?: LogLevel): LogEntry[] {
    let entries = this.logs;

    if (level) {
      entries = entries.filter((e) => e.level === level);
    }

    if (count) {
      entries = entries.slice(-count);
    }

    return entries;
  }

  /**
   * Clear all logs.
   */
  clearLogs(): boolean {
    this.logs = [];
    return true;
  }

  /**
   * Get total log count.
   */
  get logCount(): number {
    return this.logs.length;
  }

  protected override getSourceForAsk(): string | undefined {
    return `## Console Usage Guide

### Log at Different Levels

  await this.call(
    this.dep('Console'), 'info',
    { message: 'Operation completed', data: { result: 42 } });

  await this.call(
    this.dep('Console'), 'debug',
    { message: 'Processing item', data: { id: 'abc' } });

  await this.call(
    this.dep('Console'), 'warn',
    { message: 'Rate limit approaching', data: { remaining: 5 } });

  await this.call(
    this.dep('Console'), 'error',
    { message: 'Request failed', data: { status: 500 } });

### Log Levels

Available levels: 'debug', 'info', 'warn', 'error'
The 'data' field is optional — pass any JSON-serializable value for structured context.

### IMPORTANT
- Do NOT use console.log() directly — always go through the Console object.
- Logs are stored in memory (up to 1000 entries) and also forwarded to the browser console.`;
  }
}

// Well-known console ID
export const CONSOLE_ID = 'abjects:console' as AbjectId;
