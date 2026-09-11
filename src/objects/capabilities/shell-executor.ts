/**
 * ShellExecutor capability object -- executes shell commands on the host.
 *
 * This is the Abjects equivalent of Claude Code's `Bash` tool and OpenClaw's
 * `system.run`. Most developer skills require command execution.
 */

import { physicalPath, physicalGrantRoots } from '../../core/physical-path.js';
import { PermissionDenied, errorDetails, type PermissionReceipt } from '../../core/permission-outcome.js';
import { describeMessages, protocolText, protocolNumber, protocolObject } from '../../core/protocol-description.js';
import { RunningProcess } from './running-process.js';
import os from 'node:os';
import { AbjectId, AbjectMessage, InterfaceId } from '../../core/types.js';
import { Abject, DEFERRED_REPLY } from '../../core/abject.js';
import { error as errorMsg, request } from '../../core/message.js';
import { Capabilities } from '../../core/capability.js';
import { require as contractRequire } from '../../core/contracts.js';
import { truncateTail, droppedNotice, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from '../../core/tool-output.js';
import { Log } from '../../core/timed-log.js';
import { isInsideAny } from '../../core/path-scope.js';
import { analyzeCommand, isCredentialVarName } from '../../core/command-analysis.js';

interface PlatformInfo {
  os: string;
  arch: string;
  shell: string;
  homeDir: string;
}

const platformInfo: PlatformInfo = {
  os: process.platform,
  arch: os.arch(),
  shell: process.platform === 'win32'
    ? (process.env.COMSPEC ?? 'cmd.exe')
    : (process.env.SHELL ?? '/bin/sh'),
  homeDir: os.homedir(),
};

const log = new Log('ShellExecutor');

/**
 * How long to wait for a permission answer with no sign of life from the
 * dialog. The authority queues prompts and a user may be away from the
 * keyboard; the old two-minute limit turned a coffee break into a tool failure
 * the agent then spent steps recovering from.
 *
 * An open dialog heartbeats, and every beat resets this timer, so a question
 * still on screen waits as long as it takes. Reaching this limit means nothing
 * is asking anyone anything any more.
 */
const PERMISSION_WAIT_MS = 31 * 60 * 1000;

/**
 * Bound a command's output to the shared truncation contract.
 *
 * stderr is budgeted first and stdout gets what is left, because when a build
 * fails the diagnostics are on stderr and the 40,000 lines of progress chatter
 * on stdout are what you can afford to lose.
 */
function boundOutput(stdout: string, stderr: string, exitCode: number, retained?: { outputBytes: number; truncatedStreams: string[]; droppedLines: number }): ExecResult {
  const totalBytes = retained?.outputBytes ?? Buffer.byteLength(stdout, 'utf-8') + Buffer.byteLength(stderr, 'utf-8');

  const errT = truncateTail(stderr, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  const remainingBytes = Math.max(0, DEFAULT_MAX_BYTES - Buffer.byteLength(errT.content, 'utf-8'));
  const remainingLines = Math.max(0, DEFAULT_MAX_LINES - errT.outputLines);
  const outT = truncateTail(stdout, {
    // Always leave a usable window for stdout even when stderr filled the budget:
    // a caller that sees nothing at all cannot tell a quiet success from a flood.
    maxLines: Math.max(200, remainingLines),
    maxBytes: Math.max(8 * 1024, remainingBytes),
  });

  const errTruncated = errT.truncated || retained?.truncatedStreams.includes('stderr');
  const outTruncated = outT.truncated || retained?.truncatedStreams.includes('stdout');
  if (!errTruncated && !outTruncated) {
    return { stdout, stderr, exitCode };
  }

  const stream: 'stdout' | 'stderr' | 'both' =
    errTruncated && outTruncated ? 'both' : errTruncated ? 'stderr' : 'stdout';

  return {
    stdout: outT.truncated ? droppedNotice(outT) + outT.content : outT.content,
    stderr: errT.truncated ? droppedNotice(errT) + errT.content : errT.content,
    exitCode,
    truncated: {
      stream,
      droppedLines: (retained?.droppedLines ?? 0) + (outT.totalLines - outT.outputLines) + (errT.totalLines - errT.outputLines),
      totalBytes,
    },
  };
}
const SHELL_INTERFACE: InterfaceId = 'abjects:shell';

export interface ExecRequest {
  taskId?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  /** If true, run through the system shell (enables pipes, globs, etc.). */
  shell?: boolean;
  /** If set, use command-name-only matching against the skill's whitelist. */
  skillName?: string;
  /**
   * The command runs inside a project the user has NOT trusted. Standing
   * grants (allow lists, per-object grants) are skipped and the request goes
   * to the permissions authority every time, which knows the project's
   * autonomy is "ask" and prompts. Trust is a statement about a directory;
   * a grant is a statement about a program. A grant for `pnpm` made in a
   * trusted project must not run that project's lifecycle scripts in one
   * the user never vouched for.
   */
  untrusted?: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * Set when output was too large to return whole. The kept text is the TAIL,
   * because a build or test run puts the part you need at the bottom.
   */
  truncated?: {
    stream: 'stdout' | 'stderr' | 'both';
    /** Lines dropped off the front, across both streams. */
    droppedLines: number;
    /** Original size, so the caller can say how much it is not seeing. */
    totalBytes: number;
  };
}

export class ShellExecutor extends Abject {
  private allowedCommands?: Set<string>;
  private deniedCommands?: Set<string>;
  private allowedPaths?: string[];
  private defaultTimeout: number;
  /** If true, all command execution is blocked. */
  private shellDisabled = false;
  /**
   * Working directory to use when a caller omits one, keyed by the calling
   * Abject. An agent working inside one project sets this once instead of
   * repeating an absolute cwd on every command, and no other caller's default
   * is affected. Kept here rather than resolved from a project registry so
   * ShellExecutor stays a capability with no opinion about projects.
   */
  private defaultCwds = new Map<AbjectId, string>();
  /** The only AbjectId allowed to call updatePermissions. Set once at bootstrap. */
  private permissionsAuthorityId?: AbjectId;
  /** Per-skill command whitelists (command name only, no args). */
  private skillAllowedCommands: Map<string, Set<string>> = new Map();
  /** Per-calling-object command whitelists (command name only, no args). */
  private objectAllowedCommands: Map<string, Set<string>> = new Map();
  /** Per-calling-object blocklists; outrank every allow list. */
  private objectDeniedCommands: Map<string, Set<string>> = new Map();
  /** Environment variables injected by skills (via SkillRegistry). */
  private skillEnv: Record<string, string> = {};

  constructor(config?: {
    allowedCommands?: string[];
    deniedCommands?: string[];
    allowedPaths?: string[];
    defaultTimeout?: number;
  }) {
    super({
      manifest: {
        name: 'ShellExecutor',
        description:
          'Executes shell commands on the host system. Equivalent to Claude Code\'s Bash tool. ' +
          'Supports command execution with args, working directory, environment variables, and timeout. ' +
          'Use for git, npm, docker, build tools, and other CLI operations.',
        version: '1.0.0',
        interface: {
          id: SHELL_INTERFACE,
          name: 'ShellExecutor',
          description: 'Shell command execution',
          methods: [
            {
              name: 'exec',
              description: 'Execute a shell command and return stdout, stderr, and exit code',
              parameters: [
                { name: 'command', type: { kind: 'primitive', primitive: 'string' }, description: 'Command to execute' },
                { name: 'args', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Command arguments', optional: true },
                { name: 'cwd', type: { kind: 'primitive', primitive: 'string' }, description: 'Working directory', optional: true },
                { name: 'env', type: { kind: 'object', properties: {} }, description: 'Environment variables to set', optional: true },
                { name: 'timeout', type: { kind: 'primitive', primitive: 'number' }, description: 'Timeout in milliseconds', optional: true },
                { name: 'shell', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Run through system shell (enables pipes, globs)', optional: true },
              ],
              returns: {
                kind: 'object',
                properties: {
                  stdout: { kind: 'primitive', primitive: 'string' },
                  stderr: { kind: 'primitive', primitive: 'string' },
                  exitCode: { kind: 'primitive', primitive: 'number' },
                },
              },
            },
            {
              name: 'setDefaultCwd',
              description:
                'Set the working directory this caller gets when it omits cwd on exec. ' +
                'Omit cwd to clear it. Scoped to the calling object only.',
              parameters: [
                { name: 'cwd', type: { kind: 'primitive', primitive: 'string' }, description: 'Absolute directory path', optional: true },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'getPlatformInfo',
              description: 'Get information about the host platform (OS, architecture, shell)',
              parameters: [],
              returns: {
                kind: 'object',
                properties: {
                  os: { kind: 'primitive', primitive: 'string' },
                  arch: { kind: 'primitive', primitive: 'string' },
                  shell: { kind: 'primitive', primitive: 'string' },
                  homeDir: { kind: 'primitive', primitive: 'string' },
                },
              },
            },
            {
              name: 'updatePermissions',
              description: 'Update shell execution permissions at runtime',
              parameters: [
                { name: 'enabled', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Enable/disable shell execution', optional: true },
                { name: 'allowedCommands', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Commands allowed to execute', optional: true },
                { name: 'deniedCommands', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Commands denied from execution', optional: true },
                { name: 'allowedPaths', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Allowed working directories', optional: true },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'setSkillEnv',
              description: 'Set environment variables injected by skills into all future command executions',
              parameters: [
                { name: 'env', type: { kind: 'object', properties: {} }, description: 'Key-value map of environment variables' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.SHELL_EXECUTE],
        tags: ['system', 'capability', 'shell'],
      },
    });

    if (config?.allowedCommands) this.allowedCommands = new Set(config.allowedCommands);
    if (config?.deniedCommands) this.deniedCommands = new Set(config.deniedCommands);
    this.allowedPaths = config?.allowedPaths;
    this.defaultTimeout = config?.defaultTimeout ?? 30000;

    this.setupHandlers();
  }

  private setupHandlers(): void {
    describeMessages(this.manifest, [
      { name: "start", description: "Start an approved command and return a RunningProcess Abject. Ask it how to read output, send input, wait, or stop.", parameters: { "command": protocolText, "cwd?": protocolText, "taskId?": protocolText, "timeout?": protocolNumber } },
      { name: "stopTaskProcesses", description: "Stop only the calling object\u2019s processes belonging to taskId.", parameters: { "taskId": protocolText } },
    ]);
    this.on('getPlatformInfo', async () => {
      return platformInfo;
    });

    this.on('setPermissionsAuthority', async (msg: AbjectMessage) => {
      if (this.permissionsAuthorityId) return { success: false, error: 'Authority already set' };
      this.permissionsAuthorityId = msg.routing.from;
      return { success: true };
    });

    this.on('updatePermissions', async (msg: AbjectMessage) => {
      if (this.permissionsAuthorityId && msg.routing.from !== this.permissionsAuthorityId) {
        return { success: false, error: 'Unauthorized: only the permissions authority can update permissions' };
      }
      const { enabled, allowedCommands, deniedCommands, allowedPaths } = msg.payload as {
        enabled?: boolean;
        allowedCommands?: string[];
        deniedCommands?: string[];
        allowedPaths?: string[];
      };
      if (enabled !== undefined) this.shellDisabled = !enabled;
      if (allowedCommands !== undefined) {
        this.allowedCommands = allowedCommands.length > 0 ? new Set(allowedCommands) : undefined;
      }
      if (deniedCommands !== undefined) {
        this.deniedCommands = deniedCommands.length > 0 ? new Set(deniedCommands) : undefined;
      }
      if (allowedPaths !== undefined) {
        this.allowedPaths = allowedPaths.length > 0 ? allowedPaths : undefined;
      }
      return { success: true };
    });

    this.on('updateSkillPermissions', async (msg: AbjectMessage) => {
      if (this.permissionsAuthorityId && msg.routing.from !== this.permissionsAuthorityId) {
        return { success: false, error: 'Unauthorized' };
      }
      const { skillName, allowedCommands } = msg.payload as { skillName: string; allowedCommands: string[] };
      this.skillAllowedCommands.set(skillName, new Set(allowedCommands));
      return { success: true };
    });

    // Per-object grants: "this named object may run this program". The name is
    // the caller's registered name, resolved here from the message sender, so a
    // caller cannot claim to be someone else by putting a name in the payload.
    this.on('updateObjectPermissions', async (msg: AbjectMessage) => {
      if (this.permissionsAuthorityId && msg.routing.from !== this.permissionsAuthorityId) {
        return { success: false, error: 'Unauthorized' };
      }
      const { objectName, allowedCommands, deniedCommands } = msg.payload as {
        objectName: string;
        allowedCommands?: string[];
        deniedCommands?: string[];
      };
      contractRequire(typeof objectName === 'string' && objectName.length > 0, 'objectName must be a non-empty string');
      if (allowedCommands !== undefined) {
        if (allowedCommands.length > 0) this.objectAllowedCommands.set(objectName, new Set(allowedCommands));
        else this.objectAllowedCommands.delete(objectName);
      }
      if (deniedCommands !== undefined) {
        if (deniedCommands.length > 0) this.objectDeniedCommands.set(objectName, new Set(deniedCommands));
        else this.objectDeniedCommands.delete(objectName);
      }
      return { success: true };
    });

    this.on('setSkillEnv', async (msg: AbjectMessage) => {
      if (msg.routing.from !== await this.discoverDep('SkillRegistry')) return { success: false, error: 'Only SkillRegistry may set skill environment' };
      const { env } = msg.payload as { env: Record<string, string> };
      this.skillEnv = env ?? {};
      log.info(`setSkillEnv: ${Object.keys(this.skillEnv).length} vars`);
      return { success: true };
    });

    this.on('setDefaultCwd', async (msg: AbjectMessage) => {
      const { cwd } = msg.payload as { cwd?: string };
      if (cwd) {
        await this.validatePath(cwd, msg.routing.from);
        this.defaultCwds.set(msg.routing.from, cwd);
      } else {
        this.defaultCwds.delete(msg.routing.from);
      }
      return { success: true };
    });

    this.on('start', async (msg: AbjectMessage) => {
      const context = await this.capabilityCaller(msg);
      const child = await this.startProcess({ ...(msg.payload as ExecRequest), taskId: context.taskId }, context.callerId);
      return { processId: child.id, permission: this.running.get(child.id)?.permission };
    });
    this.on('stopTaskProcesses', async (msg: AbjectMessage) => {
      const { taskId } = msg.payload as { taskId: string };
      let stopped = 0;
      for (const [id, spec] of this.running) {
        if (spec.owner === msg.routing.from && spec.taskId === taskId) {
          await this.request(request(this.id, id, 'stop', {})); stopped++;
        }
      }
      return { stopped };
    });

    this.on('exec', (msg: AbjectMessage) => {
      const req = msg.payload as ExecRequest;
      this.capabilityCaller(msg).then(context => this.executeCommand({ ...req, taskId: context.taskId }, context.callerId)).then(
        (result) => {
          log.info(`exec result: exit=${result.exitCode} stdout=${result.stdout.length}b stderr=${result.stderr.length}b`);
          this.sendDeferredReply(msg, result);
        },
        (err) => {
          log.info(`exec error: ${err instanceof Error ? err.message : String(err)}`);
          this.send(errorMsg(msg, 'SHELL_ERROR',
            err instanceof Error ? err.message : String(err), errorDetails(err)));
        },
      );
      return DEFERRED_REPLY;
    });
  }

  private running = new Map<AbjectId, { owner: AbjectId; taskId?: string; permission?: PermissionReceipt; child: RunningProcess }>();
  protected override async onStop(): Promise<void> {
    await Promise.allSettled([...this.running.values()].map(p=>p.child.stop()));
    this.running.clear();
  }

  private async executeCommand(req: ExecRequest, callerId?: AbjectId): Promise<ExecResult> {
    const child = await this.startProcess(req, callerId ?? this.id);
    const result = await this.request<{ stdout: string; stderr: string; exitCode: number; outputBytes: number; truncatedStreams: string[]; droppedLines: number }>(request(this.id, child.id, 'wait', {}), (req.timeout ?? this.defaultTimeout) + 30000);
    return { ...boundOutput(result.stdout, result.stderr, result.exitCode, result), outputObjectId: child.id, permission: this.running.get(child.id)?.permission } as ExecResult;
  }

  private async startProcess(req: ExecRequest, callerId: AbjectId): Promise<RunningProcess> {
    if (this.shellDisabled) throw new Error('Shell execution is disabled. Enable it in Settings > Permissions.');
    contractRequire(typeof req.command === 'string' && req.command.length > 0, 'command must be a non-empty string');
    log.info(`exec: ${req.command.slice(0, 120)}${req.command.length > 120 ? '...' : ''} (shell=${!!req.shell}, cwd=${req.cwd ?? 'default'})`);

    const command = req.command;
    const args = req.args ?? [];
    const timeout = req.timeout ?? this.defaultTimeout;
    const cwd = await physicalPath(req.cwd ?? this.defaultCwds.get(callerId) ?? process.cwd());

    // Validate command (may prompt user)
    const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command;
    // A skill name describes the request; it cannot select a different permission path.
    const { restrictEnv, permission } = await this.validateCommand(fullCommand, {
      callerId, taskId: req.taskId, usesShell: !!req.shell, cwd, untrusted: req.untrusted === true, skillName: req.skillName,
    });
    await this.validatePath(cwd, callerId, req.taskId);

    // Build environment: process env + skill env + per-request env.
    //
    // A command nobody saw approved does not get the host's credentials. Every
    // approved `curl` used to carry every API key on the box; stripping them by
    // variable NAME leaves PATH, HOME and toolchain settings intact, so builds
    // still work. A command the user was actually shown keeps the full
    // environment, because they saw what they were agreeing to.
    const baseEnv = restrictEnv
      ? Object.fromEntries(Object.entries(process.env).filter(([k]) => !isCredentialVarName(k)))
      : process.env;
    const env = { ...baseEnv, ...this.skillEnv, ...req.env };

    const child = new RunningProcess({ command, args, shell: req.shell, cwd, env, timeout, owner: callerId, supervisor: this.id, taskId: req.taskId });
    await child.init(this.bus, this.id);
    this.running.set(child.id, { owner: callerId, taskId: req.taskId, permission, child });
    // Output remains inspectable after completion; retire it after an hour.
    void this.request(request(this.id, child.id, 'wait', {}), timeout + 30000).finally(() => {
      const retention = setTimeout(() => { this.running.delete(child.id); void child.stop(); }, 3600000);
      retention.unref?.();
    }).catch(() => {});
    return child;
  }

  private async validateCommand(
    fullCommand: string,
    opts: { callerId?: AbjectId; taskId?: string; usesShell: boolean; cwd?: string; untrusted?: boolean; skillName?: string },
  ): Promise<{ restrictEnv: boolean; permission?: PermissionReceipt }> {
    const trimmed = fullCommand.trim();

    const receipt = (decision: string, reason: string): PermissionReceipt => ({
      authority: this.id, callerId: opts.callerId, taskId: opts.taskId,
      operation: 'shell', resource: trimmed, decision, source: 'policy', reason,
    });
    if (this.deniedCommands?.has(trimmed)) {
      throw new PermissionDenied(receipt('deny', `Command "${trimmed}" is permanently denied`));
    }

    const callerName = await this.resolveCallerName(opts.callerId);

    // A compound line is made of several commands, so it reduces to a SET of
    // programs rather than one. The old code gave up the moment it saw a shell
    // metacharacter, which meant the per-object grant below could never fire
    // for an agent (agents pipe constantly) and the user was re-asked forever.
    const analysis = analyzeCommand(trimmed, { cwd: opts.cwd });
    const programs = analysis.segments.map(s => s.program).filter(Boolean);
    // Resolve actual destinations at the owner; the broker remains filesystem-free.
    const physicalPaths = await Promise.all([...new Set([...analysis.reads, ...analysis.writes]
      .flatMap(touched => touched.resolved ? [touched.resolved] : []))].map(async logical => {
      try { return { logical, physical: await physicalPath(logical) }; }
      catch { return { logical, physical: undefined }; }
    }));

    // A block on the object is the narrowest, most deliberate statement the
    // user can make about this pair, so it outranks the broad allow lists. Any
    // one blocked program in the line is enough.
    const blocked = programs.find(p => this.objectDeniedCommands.get(callerName ?? '')?.has(p));
    if (callerName && blocked) {
      throw new PermissionDenied(receipt('deny', `${callerName} is blocked from running "${blocked}"`));
    }

    // Standing permissions answer for trusted ground only. In an untrusted
    // project every command is put to the authority, whose project autonomy
    // for such a directory is "ask", so the user sees each one.
    let preapproved = false;
    if (!opts.untrusted) {
      if (this.allowedCommands?.has(trimmed)) preapproved = true;

      // A grant is on a program, so a line is covered only when every program in
      // it is granted. `cd x && sed … | grep …` passes once cd, sed and grep are
      // all allowed, and stops passing the moment something else joins.
      const grants = callerName ? this.objectAllowedCommands.get(callerName) : undefined;
      if (grants && programs.length > 0 && !analysis.opaque
          && analysis.effect !== 'dangerous'
          && programs.every(p => grants.has(p))) {
        preapproved = true;
      }
    }

    // Every decision passes the authority, including configured local grants.
    // Nothing local covers it: put it to the authority, which knows about
    // projects and workspaces and can answer without a dialog.
    if (this.permissionsAuthorityId) {
      const response = await this.request<{ decision: string; asked?: boolean; restrictEnv?: boolean; receipt?: PermissionReceipt }>(
        request(this.id, this.permissionsAuthorityId, 'requestPermission', {
          type: 'shell', preapproved, physicalPaths, skillName: opts.skillName,
          skillPreapproved: !opts.untrusted && !!opts.skillName && !analysis.opaque && analysis.effect !== 'dangerous'
            && programs.length > 0 && programs.every(program => this.skillAllowedCommands.get(opts.skillName!)?.has(program)),
          resource: trimmed,
          description: callerName
            ? `${callerName} wants to run${opts.untrusted ? ' (in an UNTRUSTED project)' : ''}:`
            : `An object wants to run${opts.untrusted ? ' (in an UNTRUSTED project)' : ''}:`,
          objectName: callerName,
          commandName: analysis.principalProgram,
          callerId: opts.callerId,
          taskId: opts.taskId,
          cwd: opts.cwd,
          usesShell: opts.usesShell,
          // Granting a program is only meaningful when the line reduces to a
          // known set of them.
          canAllow: !analysis.opaque && programs.length > 0,
        }),
        // Long enough to survive the user being away from the keyboard. The
        // authority queues prompts rather than refusing a second one, so a
        // wait here is a wait for a human, not a deadlock.
        PERMISSION_WAIT_MS,
      );

      // Standing rules now live with the authority, which is what makes them
      // survive a takeTheWheel and stay consistent with what Settings shows.
      // Anything that starts with accept is a yes.
      // The authority says whether this ran on policy alone. If it did, the
      // command goes without the host's credentials.
      if (response.decision?.startsWith('accept')) {
        return { restrictEnv: response.restrictEnv === true, permission: response.receipt };
      }
      throw new PermissionDenied(response.receipt ?? receipt(response.decision, 'Shell permission denied by authority'));
    }
    if (preapproved) return { restrictEnv: false, permission: receipt('accept_once', 'Configured shell grant') };
    throw new PermissionDenied(receipt('deny', `Command "${trimmed}" is not allowed. Configure permissions in Settings > Permissions.`));
  }

  /**
   * @param callerId who wants to work here. The authority needs it: whether a
   *        directory is already covered depends on which project it belongs to
   *        and which workspace the caller lives in, and an anonymous request
   *        can be answered only by asking a human.
   */
  private async validatePath(cwd: string, callerId?: AbjectId, taskId?: string): Promise<void> {
    const roots = await physicalGrantRoots(this.allowedPaths ?? []);
    const preapproved = isInsideAny(roots, cwd);
    if (this.permissionsAuthorityId) {
      const response = await this.request<{ decision: string; receipt?: PermissionReceipt }>(
        request(this.id, this.permissionsAuthorityId, 'requestPermission', {
          type: 'directory', operation: 'read', resource: cwd, callerId, taskId, preapproved,
          description: `Shell working directory: ${cwd}`,
        }), PERMISSION_WAIT_MS);
      if (response.decision.startsWith('accept')) return;
      throw new PermissionDenied(response.receipt ?? { authority: this.permissionsAuthorityId, callerId, taskId,
        operation: 'read', resource: cwd, decision: response.decision, source: 'policy', reason: 'Working directory access denied' });
    }
    if (preapproved) return;
    throw new Error(`Working directory "${cwd}" is not allowed. Configure permissions in Settings > Permissions.`);
  }

  protected override askPrompt(_question: string): string {
    const p = platformInfo;
    const lines = [
      `## ShellExecutor Usage Guide`,
      ``,
      `### Platform`,
      `OS: ${p.os}, Arch: ${p.arch}, Shell: ${p.shell}, Home: ${p.homeDir}`,
      ``,
      `### Execute a command`,
      `  const result = await this.call(this.dep('ShellExecutor'), 'exec', {`,
      `    command: 'ls', args: ['-la'], cwd: '/tmp' });`,
      `  // result = { stdout: '...', stderr: '...', exitCode: 0 }`,
      ``,
      `### Default working directory`,
      `  await this.call(this.dep('ShellExecutor'), 'setDefaultCwd', { cwd: '/abs/project' });`,
      `  // Later execs that omit cwd run there. Scoped to you alone.`,
      ``,
      `### Output size`,
      `  Output is bounded (${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES / 1024}KB). The TAIL is kept, since a`,
      `  failing build puts its diagnostics at the end. stderr is budgeted first.`,
      `  A bounded result carries { truncated: { stream, droppedLines, totalBytes } }.`,
      `  Narrow the command (grep, tail, --quiet) rather than asking for more.`,
      ``,
      `### Shell mode (pipes, globs)`,
      `  const result = await this.call(this.dep('ShellExecutor'), 'exec', {`,
      `    command: 'cat file.txt | grep error', shell: true });`,
      ``,
      `### Restrictions`,
    ];

    if (this.shellDisabled) {
      lines.push(`Shell execution is currently DISABLED.`);
    } else {
      if (this.allowedCommands) {
        lines.push(`Allowed commands: ${[...this.allowedCommands].join(', ')}`);
      }
      if (this.deniedCommands) {
        lines.push(`Denied commands: ${[...this.deniedCommands].join(', ')}`);
      }
      if (this.allowedPaths) {
        lines.push(`Allowed working directories: ${this.allowedPaths.join(', ')}`);
      }
      for (const [objectName, cmds] of this.objectAllowedCommands) {
        lines.push(`${objectName} may run: ${[...cmds].join(', ')} (any arguments)`);
      }
      for (const [objectName, cmds] of this.objectDeniedCommands) {
        lines.push(`${objectName} is blocked from: ${[...cmds].join(', ')}`);
      }
      if (!this.allowedCommands && !this.deniedCommands && !this.allowedPaths
          && this.objectAllowedCommands.size === 0 && this.objectDeniedCommands.size === 0) {
        lines.push(`No standing grants configured; operations require permission from the authority.`);
      }
    }

    return super.askPrompt(_question) + '\n\n' + lines.join('\n');
  }
}

/**
 * Reduce a command line to the program being run, for permission matching.
 *
 * Naively taking the first whitespace-delimited word misreads two very common
 * shapes. `TOKEN=abc curl ...` yields `TOKEN=abc` as the "command", which both
 * renders the secret into the permission dialog and guarantees the entry can
 * never match a whitelist (every distinct token value is a distinct "command").
 * `env A=B cmd` has the same problem one level in. So: skip leading `VAR=value`
 * assignments, step through an `env` prefix, and take the basename of what's
 * left.
 */
/** Add one entry to a name -> set-of-commands map, creating the set as needed. */
function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) existing.add(value);
  else map.set(key, new Set([value]));
}

/**
 * Whether a command line contains characters a shell would read as anything
 * other than plain arguments: chaining, piping, substitution, redirection.
 *
 * Only meaningful for `shell: true` requests. Without a shell the command and
 * its args go straight to execFile, where these are ordinary bytes, and tmux
 * send-keys payloads are full of them.
 */
export function hasShellMetacharacters(fullCommand: string): boolean {
  return /[;&|<>`$(){}\n\r]/.test(fullCommand);
}

export function extractCommandName(fullCommand: string): string {
  // Multi-line scripts routinely open with comments or an assignment line, so
  // the program being run is not on the first line. Take the first line that
  // actually runs something.
  const firstRealLine = fullCommand
    .split('\n')
    .map(l => l.trim())
    .find(l => l && !l.startsWith('#') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
    ?? fullCommand;

  const words = firstRealLine.trim().split(/\s+/).filter(Boolean);
  let i = 0;

  // Leading environment assignments, optionally introduced by `env`.
  const isAssignment = (w: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
  while (i < words.length) {
    if (isAssignment(words[i])) { i++; continue; }
    if (words[i] === 'env' || words[i] === '/usr/bin/env') {
      i++;
      while (i < words.length && isAssignment(words[i])) i++;
      continue;
    }
    break;
  }

  const word = words[i] ?? words[0] ?? fullCommand;
  return word.split('/').pop() || word;
}

export const SHELL_EXECUTOR_ID = 'abjects:shell-executor' as AbjectId;
