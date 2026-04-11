/**
 * MCP STDIO Transport -- spawns an MCP server as a child process and
 * communicates via newline-delimited JSON-RPC 2.0 over stdin/stdout.
 */

import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface as ReadlineInterface } from 'readline';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcMessage,
} from '../core/mcp-types.js';
import { require as contractRequire } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';

const log = new Log('MCPTransport');

export type MCPTransportState = 'idle' | 'starting' | 'connected' | 'error' | 'closed';

export interface MCPTransportEvents {
  onStateChange?: (state: MCPTransportState) => void;
  onNotification?: (method: string, params: unknown) => void;
  onError?: (error: Error) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Spawns an MCP server process and manages bidirectional JSON-RPC 2.0 over stdio.
 */
export class MCPTransport {
  private child: ChildProcess | null = null;
  private reader: ReadlineInterface | null = null;
  private state: MCPTransportState = 'idle';
  private events: MCPTransportEvents = {};
  private nextId = 1;
  private pending = new Map<string | number, PendingRequest>();
  private requestTimeout: number;

  constructor(opts?: { requestTimeout?: number }) {
    this.requestTimeout = opts?.requestTimeout ?? 30_000;
  }

  get currentState(): MCPTransportState { return this.state; }
  get isConnected(): boolean { return this.state === 'connected'; }

  on(events: MCPTransportEvents): void {
    this.events = { ...this.events, ...events };
  }

  /**
   * Spawn the MCP server process and mark as connected once stdio is ready.
   */
  async start(command: string, args: string[] = [], env?: Record<string, string>): Promise<void> {
    contractRequire(this.state === 'idle' || this.state === 'closed' || this.state === 'error',
      'Transport must be idle/closed/error to start');

    this.setState('starting');

    const mergedEnv = { ...process.env, ...env };

    return new Promise<void>((resolve, reject) => {
      try {
        this.child = spawn(command, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: mergedEnv,
          shell: true,
        });
      } catch (err) {
        this.setState('error');
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const child = this.child;

      // Read stdout line-by-line for JSON-RPC messages
      this.reader = createInterface({ input: child.stdout! });
      this.reader.on('line', (line) => this.handleLine(line));

      // Log stderr for diagnostics
      child.stderr?.on('data', (data: Buffer) => {
        log.info(`[stderr] ${data.toString().trimEnd()}`);
      });

      child.on('error', (err) => {
        log.error('Process error:', err.message);
        this.setState('error');
        this.events.onError?.(err);
        this.rejectAll(err);
        reject(err);
      });

      child.on('close', (code, signal) => {
        log.info(`Process exited: code=${code} signal=${signal}`);
        if (this.state !== 'closed') {
          this.setState('closed');
          this.rejectAll(new Error(`MCP server exited: code=${code} signal=${signal}`));
        }
      });

      // Consider the transport ready once the process is spawned and stdio is open
      // (MCP initialization handshake is done by the caller, not the transport)
      child.on('spawn', () => {
        this.setState('connected');
        resolve();
      });
    });
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  async sendRequest(method: string, params?: unknown): Promise<unknown> {
    contractRequire(this.state === 'connected', 'Transport must be connected to send requests');

    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', method, id };
    if (params !== undefined) msg.params = params;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method} (${this.requestTimeout}ms)`));
      }, this.requestTimeout);

      this.pending.set(id, { resolve, reject, timer });
      this.writeLine(JSON.stringify(msg));
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  sendNotification(method: string, params?: unknown): void {
    contractRequire(this.state === 'connected', 'Transport must be connected to send notifications');

    const msg: JsonRpcRequest = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    // Notifications have no id field
    this.writeLine(JSON.stringify(msg));
  }

  /**
   * Gracefully stop the MCP server process.
   */
  async stop(): Promise<void> {
    if (!this.child || this.state === 'closed') return;

    this.setState('closed');
    this.rejectAll(new Error('Transport stopped'));

    this.reader?.close();
    this.reader = null;

    const child = this.child;
    this.child = null;

    // Give the process a chance to exit gracefully
    child.kill('SIGTERM');

    await new Promise<void>((resolve) => {
      const forceTimer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);

      child.on('close', () => {
        clearTimeout(forceTimer);
        resolve();
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Internal
  // ═══════════════════════════════════════════════════════════════════

  private writeLine(json: string): void {
    if (!this.child?.stdin?.writable) {
      throw new Error('Cannot write to MCP server stdin');
    }
    this.child.stdin.write(json + '\n');
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      log.error('Invalid JSON from MCP server:', trimmed.slice(0, 200));
      return;
    }

    if ('method' in msg && msg.id === undefined) {
      // Server-initiated notification
      this.events.onNotification?.(msg.method, msg.params);
      return;
    }

    if ('id' in msg && msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);

        const resp = msg as JsonRpcResponse;
        if (resp.error) {
          pending.reject(new Error(`MCP error ${resp.error.code}: ${resp.error.message}`));
        } else {
          pending.resolve(resp.result);
        }
      }
    }
  }

  private setState(state: MCPTransportState): void {
    if (this.state !== state) {
      this.state = state;
      this.events.onStateChange?.(state);
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
