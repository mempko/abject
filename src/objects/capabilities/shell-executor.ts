/**
 * ShellExecutor capability object -- executes shell commands on the host.
 *
 * This is the Abjects equivalent of Claude Code's `Bash` tool and OpenClaw's
 * `system.run`. Most developer skills require command execution.
 */

import { execFile, spawn as nodeSpawn } from 'child_process';
import { AbjectId, AbjectMessage, InterfaceId } from '../../core/types.js';
import { Abject, DEFERRED_REPLY } from '../../core/abject.js';
import { error as errorMsg } from '../../core/message.js';
import { Capabilities } from '../../core/capability.js';
import { require as contractRequire } from '../../core/contracts.js';
import { Log } from '../../core/timed-log.js';

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
    contractRequire(typeof req.command === 'string' && req.command.length > 0, 'command must be a non-empty string');
    log.info(`exec: ${req.command.slice(0, 120)}${req.command.length > 120 ? '...' : ''} (shell=${!!req.shell}, cwd=${req.cwd ?? 'default'})`);

    const command = req.command;
    const args = req.args ?? [];
    const timeout = req.timeout ?? this.defaultTimeout;

    // Validate command against allowlist/denylist
    this.validateCommand(command);

    // Validate working directory
    if (req.cwd) {
      this.validatePath(req.cwd);
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

  private validateCommand(command: string): void {
    // Extract base command name (strip path)
    const base = command.split('/').pop() ?? command;

    if (this.deniedCommands?.has(base)) {
      throw new Error(`Command "${base}" is denied`);
    }

    if (this.allowedCommands && !this.allowedCommands.has(base)) {
      throw new Error(`Command "${base}" is not in allowed list`);
    }
  }

  private validatePath(cwd: string): void {
    if (!this.allowedPaths) return;

    const allowed = this.allowedPaths.some(p => cwd.startsWith(p));
    if (!allowed) {
      throw new Error(`Working directory "${cwd}" is not in allowed paths`);
    }
  }
}

export const SHELL_EXECUTOR_ID = 'abjects:shell-executor' as AbjectId;
