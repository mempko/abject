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
import { Log } from '../../core/timed-log.js';

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
}

export class ShellExecutor extends Abject {
  private allowedCommands?: Set<string>;
  private deniedCommands?: Set<string>;
  private allowedPaths?: string[];
  private defaultTimeout: number;
  /** If true, all command execution is blocked. */
  private shellDisabled = false;
  /** The only AbjectId allowed to call updatePermissions. Set once at bootstrap. */
  private permissionsAuthorityId?: AbjectId;
  /** Per-skill command whitelists (command name only, no args). */
  private skillAllowedCommands: Map<string, Set<string>> = new Map();
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

    this.on('setSkillEnv', async (msg: AbjectMessage) => {
      const { env } = msg.payload as { env: Record<string, string> };
      this.skillEnv = env ?? {};
      log.info(`setSkillEnv: ${Object.keys(this.skillEnv).length} vars`);
      return { success: true };
    });

    this.on('exec', (msg: AbjectMessage) => {
      const req = msg.payload as ExecRequest;
      this.executeCommand(req).then(
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

  private async executeCommand(req: ExecRequest): Promise<ExecResult> {
    if (this.shellDisabled) throw new Error('Shell execution is disabled. Enable it in Settings > Permissions.');
    contractRequire(typeof req.command === 'string' && req.command.length > 0, 'command must be a non-empty string');
    log.info(`exec: ${req.command.slice(0, 120)}${req.command.length > 120 ? '...' : ''} (shell=${!!req.shell}, cwd=${req.cwd ?? 'default'})`);

    const command = req.command;
    const args = req.args ?? [];
    const timeout = req.timeout ?? this.defaultTimeout;

    // Validate command (may prompt user)
    const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command;
    if (req.skillName) {
      await this.validateSkillCommand(req.skillName, fullCommand);
    } else {
      await this.validateCommand(fullCommand);
    }

    // Validate working directory (may prompt user)
    if (req.cwd) {
      await this.validatePath(req.cwd);
    }

    // Build environment: process env + skill env + per-request env
    const env = { ...process.env, ...this.skillEnv, ...req.env };

    return new Promise<ExecResult>((resolve, reject) => {
      if (req.shell) {
        // Shell mode: combine command + args into a single string
        const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command;
        const child = nodeSpawn(fullCommand, {
          shell: true,
          cwd: req.cwd,
          env,
          timeout,
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
        child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

        child.on('error', (err) => reject(err));
        child.on('close', (code) => {
          resolve({ stdout, stderr, exitCode: code ?? 1 });
        });
      } else {
        // No shell: safer, uses execFile
        execFile(command, args, {
          cwd: req.cwd,
          env,
          timeout,
          maxBuffer: 10 * 1024 * 1024, // 10MB
        }, (err, stdout, stderr) => {
          if (err && 'code' in err && typeof err.code === 'number') {
            // Process exited with non-zero code -- not an error, just a non-zero exit
            resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: err.code });
          } else if (err) {
            // Some other error (e.g. command not found, timeout)
            reject(err);
          } else {
            resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 });
          }
        });
      }
    });
  }

  private async validateCommand(fullCommand: string): Promise<void> {
    const trimmed = fullCommand.trim();

    if (this.deniedCommands?.has(trimmed)) {
      throw new Error(`Command "${trimmed}" is permanently denied`);
    }

    if (this.allowedCommands?.has(trimmed)) return;

    // Command not in allow list -- ask the permissions authority
    if (this.permissionsAuthorityId) {
      const response = await this.request<{ decision: string }>(
        request(this.id, this.permissionsAuthorityId, 'requestPermission', {
          type: 'shell',
          resource: trimmed,
          description: `Shell command: ${trimmed}`,
        }),
        120000,
      );

      switch (response.decision) {
        case 'accept_always':
          if (!this.allowedCommands) this.allowedCommands = new Set();
          this.allowedCommands.add(trimmed);
          return;
        case 'accept_once':
          return;
        case 'deny_always':
          if (!this.deniedCommands) this.deniedCommands = new Set();
          this.deniedCommands.add(trimmed);
          throw new Error(`Command "${trimmed}" was permanently denied by user`);
        case 'deny':
        default:
          throw new Error(`Command "${trimmed}" was denied by user`);
      }
    }

    // No authority registered -- deny by default
    throw new Error(`Command "${trimmed}" is not allowed. Configure permissions in Settings > Permissions.`);
  }

  private async validateSkillCommand(skillName: string, fullCommand: string): Promise<void> {
    // Extract command name only (first word, basename) for skill matching
    const firstWord = fullCommand.trim().split(/\s+/)[0] ?? fullCommand;
    const cmdName = firstWord.split('/').pop() ?? firstWord;

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
        120000,
      );

      if (response.decision === 'accept') {
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

  private async validatePath(cwd: string): Promise<void> {
    if (this.allowedPaths?.some(p => cwd.startsWith(p))) return;

    // Path not in allow list -- ask the permissions authority
    if (this.permissionsAuthorityId) {
      const response = await this.request<{ decision: string }>(
        request(this.id, this.permissionsAuthorityId, 'requestPermission', {
          type: 'directory',
          resource: cwd,
          description: `Directory access: ${cwd}`,
        }),
        120000,
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
      if (!this.allowedCommands && !this.deniedCommands && !this.allowedPaths) {
        lines.push(`No restrictions configured.`);
      }
    }

    return super.askPrompt(_question) + '\n\n' + lines.join('\n');
  }
}

export const SHELL_EXECUTOR_ID = 'abjects:shell-executor' as AbjectId;
