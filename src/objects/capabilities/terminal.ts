/**
 * Terminal - the one object that may start an interactive shell.
 *
 * Shell access today is per-command: ShellExecutor asks PermissionBroker before
 * every command. A terminal is the opposite shape - the person approves one
 * session and everything typed inside it runs for as long as it lives - so the
 * consent question is structural, not per keystroke, and this object exists to
 * keep that one capability in one place:
 *
 * - Only a built-in terminal view (or the CLI gateway) may open a session;
 *   `isBuiltInCaller` decides that by registration, so an agent, a package, a
 *   WASM abject or a peer cannot talk its way in by naming itself.
 * - Opening asks twice through the existing broker: the working directory
 *   (a `directory` ask) and the shell itself (a `shell` ask) whose prompt says
 *   plainly that everything typed afterwards runs without further prompts.
 *   Project autonomy ceilings and the shell master switch apply as they do to
 *   any other command, because the decision is made by PermissionBroker, not
 *   here.
 * - The session it hands back is a separate abject that admits only its owner
 *   and this object (see terminal-session.ts). This object keeps the map so a
 *   view can list and close only its own sessions.
 *
 * One other caller gets a terminal, by a separate door: the LLM object, for a
 * model provider that runs a CLI as a warm interactive session (`openProgram`).
 * That is not a shell handed to anything: the LLM object names the provider's
 * own binary and arguments, the person chose that provider in Settings, and
 * no agent, package or peer can reach the method. It asks no question, as
 * the same provider's one-shot calls ask none, and it is not behind the
 * shell switch, which governs commands objects run, not which model answers.
 *
 * The emulator is libghostty's VT engine via `@slopus/ghostty-wasm`, and the pty
 * is `@lydell/node-pty`; both are reached inside the session, lazily, so nothing
 * else in the system loads a native addon or a wasm module to know about
 * terminals.
 */
import os from 'node:os';
import path from 'node:path';
import { require as contractRequire, invariant } from '../../core/contracts.js';
import { Abject } from '../../core/abject.js';
import type { AbjectId, AbjectMessage, InterfaceId } from '../../core/types.js';
import { request } from '../../core/message.js';
import { PermissionDenied, type PermissionReceipt } from '../../core/permission-outcome.js';
import { MAX_SCREEN_CELLS, TerminalSession, type TerminalSessionSpec } from './terminal-session.js';

export const TERMINAL_ID = 'abjects:terminal' as AbjectId;
export const TERMINAL_INTERFACE = 'abjects:terminal' as InterfaceId;

/** Ask, and let the person take their time: a permission question can wait. */
const PERMISSION_WAIT_MS = 31 * 60 * 1000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_COLS = 500;
const MAX_ROWS = 200;
/**
 * A program read off its screen needs room a person's window never does: a
 * reply that scrolls off the alternate screen is gone, so its terminal is as
 * tall as a long reply.
 */
const PROGRAM_MAX_CELLS = 1000;

/** One open session, with what the person approved for it. */
interface SessionRecord {
  owner: AbjectId;
  taskId?: string;
  cwd: string;
  command: string;
  permission?: PermissionReceipt;
  session: TerminalSession;
}

/** The objects allowed to ask for a terminal: the built-in view, and the CLI gateway. */
const TERMINAL_CALLERS = ['TerminalView', 'CliServer'] as const;
/** The object allowed to run a named program in a terminal: the LLM object, for a CLI model provider. */
const PROGRAM_CALLERS = ['LLM'] as const;

export class Terminal extends Abject {
  /** Mirrors SettingsManager's shell.enabled, pushed in like ShellExecutor's. */
  private shellDisabled = false;
  /** The only AbjectId allowed to answer permission questions. Set once at bootstrap. */
  private permissionsAuthorityId?: AbjectId;
  private sessions = new Map<AbjectId, SessionRecord>();

  constructor() {
    super({
      manifest: {
        name: 'Terminal',
        version: '1.0.0',
        description: 'Open an interactive shell in a pseudo-terminal. The session it returns is a separate abject that only its owner may drive.',
        interface: {
          id: TERMINAL_INTERFACE,
          name: 'Terminal',
          description: 'Interactive shell sessions, opened by consent and owned by one view',
          methods: [
            {
              name: 'open',
              description: 'Ask the person to approve one shell in a directory, then start it. Returns the TerminalSession AbjectId.',
              parameters: [
                { name: 'cwd', type: { kind: 'primitive', primitive: 'string' }, description: 'Working directory for the shell (asked about first)', optional: true },
                { name: 'cols', type: { kind: 'primitive', primitive: 'number' }, description: 'Columns the view can show', optional: true },
                { name: 'rows', type: { kind: 'primitive', primitive: 'number' }, description: 'Rows the view can show', optional: true },
                { name: 'taskId', type: { kind: 'primitive', primitive: 'string' }, description: 'The task opening it, when there is one', optional: true },
              ],
              returns: { kind: 'object', properties: {} },
            },
            {
              name: 'openProgram',
              description: 'Run one named program in a terminal of its own, for the LLM object only: the CLI of a model provider the person chose, driven as a warm interactive session. Asks no question. Returns the TerminalSession AbjectId.',
              parameters: [
                { name: 'command', type: { kind: 'primitive', primitive: 'string' }, description: 'The program to run' },
                { name: 'args', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Its arguments', optional: true },
                { name: 'cwd', type: { kind: 'primitive', primitive: 'string' }, description: 'Working directory (an absolute path)' },
                { name: 'cols', type: { kind: 'primitive', primitive: 'number' }, description: 'Columns', optional: true },
                { name: 'rows', type: { kind: 'primitive', primitive: 'number' }, description: 'Rows', optional: true },
                { name: 'dropEnvPrefixes', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Inherited environment variables to withhold, by name prefix', optional: true },
                { name: 'label', type: { kind: 'primitive', primitive: 'string' }, description: 'What the process is, for diagnostics', optional: true },
              ],
              returns: { kind: 'object', properties: {} },
            },
            { name: 'list', description: 'The calling view\u2019s own open sessions', parameters: [], returns: { kind: 'object', properties: {} } },
            { name: 'close', description: 'Close one of the calling view\u2019s sessions', parameters: [{ name: 'sessionId', type: { kind: 'primitive', primitive: 'string' }, description: 'Session AbjectId' }], returns: { kind: 'object', properties: {} } },
            { name: 'updatePermissions', description: 'Applied by SettingsManager: the shell master switch', parameters: [{ name: 'enabled', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Whether shells may be opened', optional: true }], returns: { kind: 'object', properties: {} } },
            { name: 'getPlatformInfo', description: 'Which shell would be started, and where', parameters: [], returns: { kind: 'object', properties: {} } },
          ],
        },
        tags: ['system', 'capability', 'terminal'],
      },
    });
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('open', async (msg: AbjectMessage) => this.openSession(msg));
    this.on('openProgram', async (msg: AbjectMessage) => this.openProgram(msg));

    this.on('list', async (msg: AbjectMessage) => {
      const mine = [...this.sessions.entries()]
        .filter(([, record]) => record.owner === msg.routing.from)
        .map(([sessionId, record]) => ({ sessionId, cwd: record.cwd, command: record.command, taskId: record.taskId }));
      return { sessions: mine, shellEnabled: !this.shellDisabled };
    });

    this.on('close', async (msg: AbjectMessage) => {
      const { sessionId } = msg.payload as { sessionId?: string };
      const record = sessionId ? this.sessions.get(sessionId as AbjectId) : undefined;
      if (!record || !sessionId) return { success: false, error: 'no such terminal session' };
      if (record.owner !== msg.routing.from && msg.routing.from !== this.id) {
        throw new Error('Terminal session belongs to another caller');
      }
      await record.session.close();
      this.sessions.delete(sessionId as AbjectId);
      // Closed for good: off the bus too, so sessions opened and closed over
      // a long run (a provider recycles its warm ones) do not pile up.
      try { await record.session.stop(); } catch { /* already stopped */ }
      this.changed('sessionsChanged', { sessionId, state: 'closed' });
      this.checkInvariants();
      return { success: true };
    });

    this.on('updatePermissions', async (msg: AbjectMessage) => {
      if (this.permissionsAuthorityId && msg.routing.from !== this.permissionsAuthorityId) {
        return { success: false, error: 'Unauthorized: only the permissions authority can update permissions' };
      }
      const { enabled } = msg.payload as { enabled?: boolean };
      if (enabled !== undefined) this.shellDisabled = !enabled;
      this.checkInvariants();
      return { success: true, shellEnabled: !this.shellDisabled };
    });

    this.on('getPlatformInfo', async () => ({
      platform: process.platform,
      shell: this.defaultShell(),
      args: this.defaultShellArgs(),
      home: os.homedir(),
      shellEnabled: !this.shellDisabled,
    }));
  }

  /**
   * One approval, then a session.
   *
   * The order matters: the directory is asked about first (so the shell never
   * starts somewhere the person has not allowed), then the shell itself. Both
   * answers come from PermissionBroker, so a project's autonomy ceiling and the
   * global shell switch have already been applied by the time either returns.
   */
  private async openSession(msg: AbjectMessage): Promise<Record<string, unknown>> {
    if (this.shellDisabled) {
      throw new Error('Shell execution is disabled. Enable it in Settings > Permissions.');
    }
    // A terminal is a person's shell. Only built-in UI code may hold one; an
    // agent, package, WASM abject or peer has no route to one through here.
    if (!await this.isBuiltInCaller(msg.routing.from, TERMINAL_CALLERS)) {
      throw new Error('A terminal session is opened by a terminal view; this caller holds no shell capability');
    }
    const payload = msg.payload as { cwd?: string; cols?: number; rows?: number; taskId?: string };
    const callerId = msg.routing.from;
    const cwd = path.resolve(payload.cwd && payload.cwd.length > 0 ? payload.cwd : os.homedir());
    const cols = clampInt(payload.cols, DEFAULT_COLS, 2, MAX_COLS);
    const rows = clampInt(payload.rows, DEFAULT_ROWS, 2, MAX_ROWS);
    const command = this.defaultShell();
    const args = this.defaultShellArgs();

    await this.askDirectory(cwd, callerId, payload.taskId);
    const permission = await this.askShell(command, args, cwd, callerId, payload.taskId);

    const spec: TerminalSessionSpec = {
      command, args, cwd, cols, rows,
      owner: callerId,
      supervisor: this.id,
      taskId: payload.taskId,
    };
    const session = new TerminalSession(spec);
    await session.init(this.bus, this.id);
    this.sessions.set(session.id, { owner: callerId, taskId: payload.taskId, cwd, command, permission, session });
    this.changed('sessionsChanged', { sessionId: session.id, state: 'open', cwd });
    this.checkInvariants();
    return { success: true, sessionId: session.id, cwd, cols, rows, command, permission };
  }

  /**
   * A terminal for a model provider's CLI, opened for the LLM object alone.
   * The caller is admitted by what it is (the built-in LLM object), never by
   * what the message says.
   */
  private async openProgram(msg: AbjectMessage): Promise<Record<string, unknown>> {
    if (!await this.isBuiltInCaller(msg.routing.from, PROGRAM_CALLERS)) {
      throw new Error('A program terminal is opened by the LLM object for a model provider; this caller holds no such capability');
    }
    const payload = (msg.payload ?? {}) as {
      command?: unknown; args?: unknown; cwd?: unknown; cols?: number; rows?: number; dropEnvPrefixes?: unknown; label?: unknown;
    };
    const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
    contractRequire(typeof payload.command === 'string' && payload.command.length > 0, 'openProgram: command is the program to run');
    contractRequire(payload.args === undefined || isStrings(payload.args), 'openProgram: args is a list of strings');
    contractRequire(typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd), 'openProgram: cwd is an absolute path');
    contractRequire(payload.dropEnvPrefixes === undefined || isStrings(payload.dropEnvPrefixes), 'openProgram: dropEnvPrefixes is a list of strings');
    const callerId = msg.routing.from;
    const command = payload.command as string;
    const cwd = payload.cwd as string;
    const cols = clampInt(payload.cols, DEFAULT_COLS, 2, PROGRAM_MAX_CELLS);
    const rows = clampInt(payload.rows, DEFAULT_ROWS, 2, PROGRAM_MAX_CELLS);
    contractRequire(cols * rows <= MAX_SCREEN_CELLS, `openProgram: a screen holds at most ${MAX_SCREEN_CELLS} cells (${cols}x${rows} asked)`);

    const session = new TerminalSession({
      command, args: (payload.args as string[] | undefined) ?? [], cwd, cols, rows,
      dropEnvPrefixes: (payload.dropEnvPrefixes as string[] | undefined) ?? [],
      ...(typeof payload.label === 'string' && payload.label ? { label: payload.label } : {}),
      // An interactive UI on the alternate screen keeps no scrollback worth holding.
      maxScrollback: 1000,
      owner: callerId,
      supervisor: this.id,
    });
    await session.init(this.bus, this.id);
    this.sessions.set(session.id, { owner: callerId, cwd, command, session });
    this.changed('sessionsChanged', { sessionId: session.id, state: 'open', cwd });
    this.checkInvariants();
    return { success: true, sessionId: session.id, cwd, cols, rows, command };
  }

  /** The working directory is its own question, exactly as it is for a single command. */
  private async askDirectory(cwd: string, callerId: AbjectId, taskId?: string): Promise<PermissionReceipt> {
    return this.ask({
      type: 'directory',
      operation: 'read',
      resource: cwd,
      description: `Terminal working directory: ${cwd}`,
      callerId,
      taskId,
    }, callerId, 'read', cwd, taskId);
  }

  /**
   * The shell question, in the words the person needs to read.
   *
   * A per-command approval would be a lie here: the approval covers the session,
   * and everything typed after it runs without being asked about again.
   */
  private async askShell(command: string, args: string[], cwd: string, callerId: AbjectId, taskId?: string): Promise<PermissionReceipt> {
    const resource = [command, ...args].join(' ');
    return this.ask({
      type: 'shell',
      resource,
      cwd,
      callerId,
      taskId,
      commandName: path.basename(command),
      preapproved: false,
      description: 'Open a terminal: approve this shell for the whole session. Everything typed in it afterwards runs on this machine without further prompts.',
    }, callerId, 'write', resource, taskId);
  }

  /** One round trip to PermissionBroker; a refusal is thrown with its receipt. */
  private async ask(
    payload: Record<string, unknown>,
    callerId: AbjectId,
    operation: 'read' | 'write',
    resource: string,
    taskId?: string,
  ): Promise<PermissionReceipt> {
    const local = (decision: string, source: PermissionReceipt['source'], reason: string): PermissionReceipt => ({
      authority: this.permissionsAuthorityId ?? this.id,
      callerId,
      operation,
      resource,
      decision,
      source,
      reason,
    });
    this.permissionsAuthorityId = await this.resolveDep('PermissionBroker', this.permissionsAuthorityId);
    if (!this.permissionsAuthorityId) {
      throw new PermissionDenied(local('deny', 'unavailable', 'no permission broker is running to ask about a terminal'));
    }
    let response: { decision?: string; receipt?: PermissionReceipt } | undefined;
    try {
      response = await this.request<{ decision?: string; receipt?: PermissionReceipt }>(
        request(this.id, this.permissionsAuthorityId, 'requestPermission', payload),
        PERMISSION_WAIT_MS,
      );
    } catch (err) {
      throw new PermissionDenied(local('deny', 'unavailable',
        `could not ask about the terminal: ${err instanceof Error ? err.message : String(err)}`));
    }
    if (typeof response?.decision === 'string' && response.decision.startsWith('accept')) {
      return response.receipt ?? local(response.decision, 'policy', 'approved');
    }
    throw new PermissionDenied(response?.receipt ?? local(response?.decision ?? 'deny', 'policy', 'Terminal access denied'));
  }

  private defaultShell(): string {
    if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
    return process.env.SHELL ?? '/bin/sh';
  }

  private defaultShellArgs(): string[] {
    // -i makes the program's own startup files run, exactly as a terminal app would.
    return process.platform === 'win32' ? [] : ['-i'];
  }

  protected override async onStop(): Promise<void> {
    const records = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(records.map(record => record.session.close()));
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.sessions.size >= 0, 'the session map exists');
    for (const [sessionId, record] of this.sessions) {
      invariant(record.session.id === sessionId, 'each session is filed under its own id');
      invariant(record.owner !== this.id, 'the capability never owns a session it opened for someone else');
    }
  }
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(min, Math.min(max, raw));
}
