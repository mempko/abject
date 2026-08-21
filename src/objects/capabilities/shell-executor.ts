/**
 * ShellExecutor capability object -- executes shell commands on the host.
 *
 * This is the Abjects equivalent of Claude Code's `Bash` tool and OpenClaw's
 * `system.run`. Most developer skills require command execution.
 */

import { execFile, spawn as nodeSpawn } from 'child_process';
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
 * How long to wait for a permission answer. The authority queues prompts and a
 * user may be away from the keyboard; the old two-minute limit turned a coffee
 * break into a tool failure the agent then spent steps recovering from.
 */
const PERMISSION_WAIT_MS = 31 * 60 * 1000;

/**
 * Bound a command's output to the shared truncation contract.
 *
 * stderr is budgeted first and stdout gets what is left, because when a build
 * fails the diagnostics are on stderr and the 40,000 lines of progress chatter
 * on stdout are what you can afford to lose.
 */
function boundOutput(stdout: string, stderr: string, exitCode: number): ExecResult {
  const totalBytes = Buffer.byteLength(stdout, 'utf-8') + Buffer.byteLength(stderr, 'utf-8');

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

  if (!errT.truncated && !outT.truncated) {
    return { stdout, stderr, exitCode };
  }

  const stream: 'stdout' | 'stderr' | 'both' =
    errT.truncated && outT.truncated ? 'both' : errT.truncated ? 'stderr' : 'stdout';

  return {
    stdout: outT.truncated ? droppedNotice(outT) + outT.content : outT.content,
    stderr: errT.truncated ? droppedNotice(errT) + errT.content : errT.content,
    exitCode,
    truncated: {
      stream,
      droppedLines: (outT.totalLines - outT.outputLines) + (errT.totalLines - errT.outputLines),
      totalBytes,
    },
  };
}
const SHELL_INTERFACE: InterfaceId = 'abjects:shell';

export interface ExecRequest {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  /** If true, run through the system shell (enables pipes, globs, etc.). */
  shell?: boolean;
  /** If set, use command-name-only matching against the skill's whitelist. */
  skillName?: string;
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

    this.on('exec', (msg: AbjectMessage) => {
      const req = msg.payload as ExecRequest;
      this.executeCommand(req, msg.routing.from).then(
        (result) => {
          log.info(`exec result: exit=${result.exitCode} stdout=${result.stdout.length}b stderr=${result.stderr.length}b`);
          this.sendDeferredReply(msg, result);
        },
        (err) => {
          log.info(`exec error: ${err instanceof Error ? err.message : String(err)}`);
          this.send(errorMsg(msg, 'SHELL_ERROR',
            err instanceof Error ? err.message : String(err)));
        },
      );
      return DEFERRED_REPLY;
    });
  }

  private async executeCommand(req: ExecRequest, callerId?: AbjectId): Promise<ExecResult> {
    if (this.shellDisabled) throw new Error('Shell execution is disabled. Enable it in Settings > Permissions.');
    contractRequire(typeof req.command === 'string' && req.command.length > 0, 'command must be a non-empty string');
    log.info(`exec: ${req.command.slice(0, 120)}${req.command.length > 120 ? '...' : ''} (shell=${!!req.shell}, cwd=${req.cwd ?? 'default'})`);

    const command = req.command;
    const args = req.args ?? [];
    const timeout = req.timeout ?? this.defaultTimeout;
    const cwd = req.cwd ?? (callerId ? this.defaultCwds.get(callerId) : undefined);

    // Validate command (may prompt user)
    const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command;
    let restrictEnv = false;
    if (req.skillName) {
      await this.validateSkillCommand(req.skillName, fullCommand);
    } else {
      ({ restrictEnv } = await this.validateCommand(
        fullCommand, { callerId, usesShell: !!req.shell, cwd }));
    }

    // Validate working directory (may prompt user). A default set earlier by
    // this caller was validated when it was set, so only an explicit cwd needs
    // checking again.
    if (req.cwd) {
      await this.validatePath(req.cwd, callerId);
    }

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

    return new Promise<ExecResult>((resolve, reject) => {
      if (req.shell) {
        // Shell mode: combine command + args into a single string
        const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command;
        const child = nodeSpawn(fullCommand, {
          shell: true,
          cwd,
          env,
          timeout,
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
        child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

        child.on('error', (err) => reject(err));
        child.on('close', (code) => {
          resolve(boundOutput(stdout, stderr, code ?? 1));
        });
      } else {
        // No shell: safer, uses execFile
        execFile(command, args, {
          cwd,
          env,
          timeout,
          maxBuffer: 10 * 1024 * 1024, // 10MB
        }, (err, stdout, stderr) => {
          if (err && 'code' in err && typeof err.code === 'number') {
            // Process exited with non-zero code -- not an error, just a non-zero exit
            resolve(boundOutput(stdout ?? '', stderr ?? '', err.code));
          } else if (err) {
            // Some other error (e.g. command not found, timeout)
            reject(err);
          } else {
            resolve(boundOutput(stdout ?? '', stderr ?? '', 0));
          }
        });
      }
    });
  }

  private async validateCommand(
    fullCommand: string,
    opts: { callerId?: AbjectId; usesShell: boolean; cwd?: string },
  ): Promise<{ restrictEnv: boolean }> {
    const trimmed = fullCommand.trim();

    if (this.deniedCommands?.has(trimmed)) {
      throw new Error(`Command "${trimmed}" is permanently denied`);
    }

    const callerName = await this.resolveCallerName(opts.callerId);

    // A compound line is made of several commands, so it reduces to a SET of
    // programs rather than one. The old code gave up the moment it saw a shell
    // metacharacter, which meant the per-object grant below could never fire
    // for an agent (agents pipe constantly) and the user was re-asked forever.
    const analysis = analyzeCommand(trimmed, { cwd: opts.cwd });
    const programs = analysis.segments.map(s => s.program).filter(Boolean);

    // A block on the object is the narrowest, most deliberate statement the
    // user can make about this pair, so it outranks the broad allow lists. Any
    // one blocked program in the line is enough.
    const blocked = programs.find(p => this.objectDeniedCommands.get(callerName ?? '')?.has(p));
    if (callerName && blocked) {
      throw new Error(`${callerName} is blocked from running "${blocked}"`);
    }

    if (this.allowedCommands?.has(trimmed)) return { restrictEnv: false };

    // A grant is on a program, so a line is covered only when every program in
    // it is granted. `cd x && sed … | grep …` passes once cd, sed and grep are
    // all allowed, and stops passing the moment something else joins.
    const grants = callerName ? this.objectAllowedCommands.get(callerName) : undefined;
    if (grants && programs.length > 0 && !analysis.opaque
        && analysis.effect !== 'dangerous'
        && programs.every(p => grants.has(p))) {
      return { restrictEnv: false };
    }

    // Nothing local covers it: put it to the authority, which knows about
    // projects and workspaces and can answer without a dialog.
    if (this.permissionsAuthorityId) {
      const response = await this.request<{ decision: string; asked?: boolean; restrictEnv?: boolean }>(
        request(this.id, this.permissionsAuthorityId, 'requestPermission', {
          type: 'shell',
          resource: trimmed,
          description: callerName
            ? `${callerName} wants to run:`
            : `An object wants to run:`,
          objectName: callerName,
          commandName: analysis.principalProgram,
          callerId: opts.callerId,
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
        return { restrictEnv: response.restrictEnv === true };
      }
      if (response.decision === 'deny_object' && callerName) {
        throw new Error(`${callerName} is blocked from running "${analysis.principalProgram}"`);
      }
      if (response.decision === 'deny_always') {
        if (!this.deniedCommands) this.deniedCommands = new Set();
        this.deniedCommands.add(trimmed);
        throw new Error(`Command "${trimmed}" was permanently denied by user`);
      }
      throw new Error(`Command "${trimmed}" was denied by user`);
    }

    // No authority registered -- deny by default
    throw new Error(`Command "${trimmed}" is not allowed. Configure permissions in Settings > Permissions.`);
  }

  private async validateSkillCommand(skillName: string, fullCommand: string): Promise<void> {
    const cmdName = extractCommandName(fullCommand);

    // Check skill-specific whitelist
    const skillWhitelist = this.skillAllowedCommands.get(skillName);
    if (skillWhitelist?.has(cmdName)) return;

    // Not whitelisted -- ask the permissions authority
    if (this.permissionsAuthorityId) {
      const response = await this.request<{ decision: string }>(
        request(this.id, this.permissionsAuthorityId, 'requestPermission', {
          type: 'skill_shell',
          resource: cmdName,
          skillName,
          description: `Skill "${skillName}" wants to run: ${cmdName}`,
        }),
        PERMISSION_WAIT_MS,
      );

      if (response.decision?.startsWith('accept')) {
        if (!skillWhitelist) {
          this.skillAllowedCommands.set(skillName, new Set([cmdName]));
        } else {
          skillWhitelist.add(cmdName);
        }
        return;
      }
      throw new Error(`Skill "${skillName}" was denied permission to run "${cmdName}"`);
    }

    throw new Error(`Command "${cmdName}" from skill "${skillName}" is not allowed.`);
  }

  /**
   * @param callerId who wants to work here. The authority needs it: whether a
   *        directory is already covered depends on which project it belongs to
   *        and which workspace the caller lives in, and an anonymous request
   *        can be answered only by asking a human.
   */
  private async validatePath(cwd: string, callerId?: AbjectId): Promise<void> {
    // Boundary-aware: see HostFileSystem.validateAndResolve for why a raw
    // startsWith is not good enough here.
    if (isInsideAny(this.allowedPaths, cwd)) return;

    // Path not in allow list -- ask the permissions authority
    if (this.permissionsAuthorityId) {
      const response = await this.request<{ decision: string }>(
        request(this.id, this.permissionsAuthorityId, 'requestPermission', {
          type: 'directory',
          resource: cwd,
          description: `Directory access: ${cwd}`,
          callerId,
        }),
        PERMISSION_WAIT_MS,
      );

      switch (response.decision) {
        case 'accept_always':
          if (!this.allowedPaths) this.allowedPaths = [];
          this.allowedPaths.push(cwd);
          return;
        case 'accept_once':
          return;
        case 'deny_always':
        case 'deny':
        default:
          throw new Error(`Directory "${cwd}" access was denied by user`);
      }
    }

    throw new Error(`Directory "${cwd}" is not allowed. Configure permissions in Settings > Permissions.`);
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
        lines.push(`No restrictions configured.`);
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
