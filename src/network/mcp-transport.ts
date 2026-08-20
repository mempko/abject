/**
 * MCP STDIO Transport -- spawns an MCP server as a child process and
 * communicates via newline-delimited JSON-RPC 2.0 over stdin/stdout.
 */

import { spawn, spawnSync, ChildProcess } from 'child_process';
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

/** How much of the child's stderr to retain for diagnostics. */
const STDERR_BUFFER_LIMIT = 8192;

/**
 * Lines that are pure launcher noise. Every `npx`-launched server emits a few
 * of these; they crowd out the one line that actually says why the server
 * died, so they are dropped from the diagnostic tail whenever there is any
 * other output to show.
 */
const STDERR_NOISE = /^\s*npm (warn|notice)\b/i;

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
  /**
   * The spawned process group's id, kept after `child` is gone.
   *
   * The direct child is a shell, and a shell that has handed off to its
   * grandchild can exit while the server keeps running. That clears `child`,
   * and a stop with nothing to signal leaves the server alive — reparented,
   * invisible, and still holding its working directory open. The group id
   * outlives the leader as long as the group has members, which is exactly the
   * case worth cleaning up.
   */
  private childPid: number | null = null;
  private reader: ReadlineInterface | null = null;
  private state: MCPTransportState = 'idle';
  private events: MCPTransportEvents = {};
  private nextId = 1;
  private pending = new Map<string | number, PendingRequest>();
  private requestTimeout: number;
  /**
   * Rolling tail of the child's stderr. MCP servers report fatal
   * misconfiguration (missing credentials, bad config file, unsupported
   * flags) on stderr and then exit; without retaining it the only signal
   * that survives is "exited: code=1", which tells a diagnosing agent
   * nothing and sends it hunting through log files for what we already had.
   */
  private stderrChunks: string[] = [];
  private stderrLength = 0;

  constructor(opts?: { requestTimeout?: number }) {
    this.requestTimeout = opts?.requestTimeout ?? 30_000;
  }

  get currentState(): MCPTransportState { return this.state; }
  get isConnected(): boolean { return this.state === 'connected'; }

  /**
   * The most recent stderr output from the child, with launcher noise
   * stripped when there is anything more informative to show. Empty string
   * when the child never wrote to stderr.
   */
  get stderrTail(): string {
    const raw = this.stderrChunks.join('');
    if (!raw.trim()) return '';
    const lines = raw.split('\n');
    const signal = lines.filter(l => l.trim() && !STDERR_NOISE.test(l));
    return (signal.length > 0 ? signal : lines.filter(l => l.trim())).join('\n').trim();
  }

  private recordStderr(text: string): void {
    this.stderrChunks.push(text);
    this.stderrLength += text.length;
    while (this.stderrLength > STDERR_BUFFER_LIMIT && this.stderrChunks.length > 1) {
      this.stderrLength -= this.stderrChunks.shift()!.length;
    }
  }

  /** Append the stderr tail to an error message when there is one. */
  private withStderr(message: string): string {
    const tail = this.stderrTail;
    return tail ? `${message}\nServer stderr:\n${tail}` : message;
  }

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

    this.stderrChunks = [];
    this.stderrLength = 0;

    const mergedEnv = { ...process.env, ...env };

    return new Promise<void>((resolve, reject) => {
      try {
        this.child = spawn(command, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: mergedEnv,
          shell: true,
          // Own process group, so stopping this transport can signal the whole
          // tree. With `shell: true` the direct child is a shell and the real
          // server is its grandchild — `npm exec x` becomes sh -> npm -> node —
          // so signalling the child alone leaves the server running. Those
          // survivors hold their working directory open, which in the packaged
          // Linux app is the AppImage mount, which is what kept a closed app's
          // file busy against the next update.
          //
          // On Windows this instead makes the child the root of a group
          // `taskkill /T` can walk; `windowsHide` keeps that from opening a
          // console window per server.
          detached: true,
          windowsHide: true,
        });
      } catch (err) {
        this.setState('error');
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      this.childPid = this.child.pid ?? null;
      const child = this.child;

      // Read stdout line-by-line for JSON-RPC messages
      this.reader = createInterface({ input: child.stdout! });
      this.reader.on('line', (line) => this.handleLine(line));

      // Retain stderr for diagnostics as well as logging it. The retained
      // tail is what callers get to see when the server dies during startup.
      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        this.recordStderr(text);
        log.info(`[stderr] ${text.trimEnd()}`);
      });

      child.on('error', (err) => {
        log.error('Process error:', err.message);
        this.setState('error');
        const enriched = new Error(this.withStderr(err.message));
        this.events.onError?.(enriched);
        this.rejectAll(enriched);
        reject(enriched);
      });

      child.on('close', (code, signal) => {
        log.info(`Process exited: code=${code} signal=${signal}`);
        if (this.state !== 'closed') {
          this.setState('closed');
          this.rejectAll(new Error(this.withStderr(`MCP server exited: code=${code} signal=${signal}`)));
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
    // The message carries the stderr tail so a server that died before the
    // handshake still explains itself instead of surfacing as a bare
    // "not connected" contract violation.
    contractRequire(this.state === 'connected',
      this.withStderr(`Transport must be connected to send requests (state: ${this.state})`));

    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', method, id };
    if (params !== undefined) msg.params = params;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(this.withStderr(`MCP request timed out: ${method} (${this.requestTimeout}ms)`)));
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
    // Not `!this.child`: a shell that exited after handing off leaves no child
    // to signal and a server still running. The group id is what makes that
    // case reachable, so stop proceeds whenever either is still known.
    if (!this.child && this.childPid === null) return;
    if (this.state === 'closed' && this.childPid === null) return;

    this.setState('closed');
    this.rejectAll(new Error('Transport stopped'));

    this.reader?.close();
    this.reader = null;

    const child = this.child;
    const pid = this.childPid;
    this.child = null;
    this.childPid = null;

    /**
     * End the server and everything it started.
     *
     * POSIX: the negative pid addresses the group `detached: true` created,
     * which reaches the whole tree and still works once the group leader has
     * exited — the case that leaked.
     *
     * Windows has no such groups, and `process.kill` there ignores the signal
     * and terminates that one process, leaving the grandchildren that actually
     * are the server. `taskkill /T` is the equivalent walk, so it gets used
     * instead; the signal only decides whether to ask or insist.
     */
    const signalTree = (sig: NodeJS.Signals): void => {
      if (pid !== null) {
        if (process.platform === 'win32') {
          try {
            const args = ['/pid', String(pid), '/T'];
            if (sig === 'SIGKILL') args.push('/F');
            spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
            return;
          } catch { /* taskkill missing; fall through to the single-process kill */ }
        } else {
          try {
            process.kill(-pid, sig);
            return;
          } catch { /* group already gone */ }
        }
      }
      try {
        child?.kill(sig);
      } catch { /* already exited */ }
    };

    // Give the process a chance to exit gracefully
    signalTree('SIGTERM');

    await new Promise<void>((resolve) => {
      const forceTimer = setTimeout(() => {
        signalTree('SIGKILL');
        resolve();
      }, 3000);

      // No child to wait on when the shell already exited; the group kill above
      // is the whole of the work, so do not sit on the timer for it.
      if (!child) {
        clearTimeout(forceTimer);
        signalTree('SIGKILL');
        resolve();
        return;
      }
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
