/** One approved subprocess, addressed and controlled through Abject messages. */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Abject } from '../../core/abject.js';
import type { AbjectId, AbjectMessage } from '../../core/types.js';

export interface ProcessSpec {
  command: string; args?: string[]; shell?: boolean; cwd?: string;
  env?: NodeJS.ProcessEnv; timeout?: number; owner: AbjectId; supervisor: AbjectId; taskId?: string;
}
export class RunningProcess extends Abject {
  private child?: ChildProcess;
  private logFile?: fs.FileHandle;
  private logDir?: string;
  private outputBytes = 0;
  private stdout = '';
  private stderr = '';
  private truncatedStreams = new Set<'stdout' | 'stderr'>();
  private droppedLines = 0;
  private exitCode?: number;
  private processError?: string;
  private cancelled = false;
  private processStartedAt = Date.now();
  private timeoutTimer?: ReturnType<typeof setTimeout>;
  private killTimer?: ReturnType<typeof setTimeout>;
  private outputWrites: Promise<void> = Promise.resolve();
  private resolveCompletion!: () => void;
  private completion = new Promise<void>(resolve => { this.resolveCompletion = resolve; });
  private closed = false;

  constructor(private spec: ProcessSpec) {
    super({ manifest: { name: 'RunningProcess', version: '1.0.0', description: 'An approved running command. Inspect output, send input, wait, or stop through messages.', interface: {
      id: 'abjects:running-process', name: 'RunningProcess', description: 'Task-owned process lifecycle', methods: [
        { name: 'status', description: 'Execution state, owner task, elapsed time and output size', parameters: [], returns: { kind: 'object', properties: {} } },
        { name: 'readOutput', description: 'Read retained combined output using byte offset and length (maximum 64 KiB)', parameters: [{ name: 'offset', type: { kind: 'primitive', primitive: 'number' }, description: 'Byte offset', optional: true }, { name: 'length', type: { kind: 'primitive', primitive: 'number' }, description: 'Byte count', optional: true }], returns: { kind: 'object', properties: {} } },
        { name: 'input', description: 'Send text to stdin, optionally close it', parameters: [{ name: 'text', type: { kind: 'primitive', primitive: 'string' }, description: 'Text', optional: true }, { name: 'close', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Close stdin', optional: true }], returns: { kind: 'object', properties: {} } },
        { name: 'stop', description: 'Terminate the process tree; repeated requests are safe', parameters: [], returns: { kind: 'object', properties: {} } },
        { name: 'wait', description: 'Wait for terminal state; includes bounded output previews and an output handle', parameters: [], returns: { kind: 'object', properties: {} } },
      ] }, requiredCapabilities: [], providedCapabilities: [], tags: ['system', 'process'] } });
    this.on('status', msg => { this.authorize(msg); return this.processStatus(); });
    this.on('readOutput', async msg => {
      this.authorize(msg); const p = msg.payload as { offset?: number; length?: number };
      const offset = Math.max(0, Math.floor(p.offset ?? 0)), length = Math.max(1, Math.min(65536, Math.floor(p.length ?? 8192)));
      await this.outputWrites;
      const buffer = Buffer.alloc(length);
      const read = await this.logFile?.read(buffer, 0, length, offset);
      return { text: buffer.subarray(0, read?.bytesRead ?? 0).toString('utf8'), offset, nextOffset: offset + (read?.bytesRead ?? 0), totalBytes: this.outputBytes };
    });
    this.on('input', msg => {
      this.authorize(msg); const p = msg.payload as { text?: string; close?: boolean };
      if (this.closed || !this.child?.stdin?.writable) return { success: false, error: 'Process stdin is closed' };
      if (p.text) this.child.stdin.write(p.text);
      if (p.close) this.child.stdin.end();
      return { success: true };
    });
    this.on('stop', msg => { this.authorize(msg); this.terminate(); return this.processStatus(); });
    this.on('wait', async msg => { this.authorize(msg); await this.completion; return { ...this.processStatus(), stdout: this.stdout, stderr: this.stderr, outputObjectId: this.id }; });
  }
  private authorize(msg: AbjectMessage): void {
    if (msg.routing.from !== this.spec.owner && msg.routing.from !== this.spec.supervisor) throw new Error('Process belongs to another caller');
  }
  private processStatus(): Record<string, unknown> {
    return { processId: this.id, taskId: this.spec.taskId, state: this.closed ? this.cancelled ? 'cancelled' : 'completed' : this.cancelled ? 'stopping' : 'running', exitCode: this.exitCode, error: this.processError, outputBytes: this.outputBytes, elapsedMs: Date.now() - this.processStartedAt, truncated: this.truncatedStreams.size > 0, truncatedStreams: [...this.truncatedStreams], droppedLines: this.droppedLines };
  }
  protected override async onInit(): Promise<void> {
    this.logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'abject-process-'));
    this.logFile = await fs.open(path.join(this.logDir, 'output.log'), 'w+');
    this.child = spawn(this.spec.command, this.spec.args ?? [], { cwd: this.spec.cwd, env: this.spec.env, shell: this.spec.shell, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const append = (kind: 'stdout' | 'stderr', data: Buffer) => {
      const combined = this[kind] + data.toString();
      if (combined.length > 65536) {
        this.truncatedStreams.add(kind);
        this.droppedLines += (combined.slice(0, -65536).match(/\n/g) ?? []).length;
      }
      this[kind] = combined.slice(-65536);
      this.outputBytes += data.length;
      // Pause the producing stream until the disk write finishes: retained
      // output is bounded by stream backpressure, not an unbounded promise queue.
      const stream = this.child?.[kind]; stream?.pause();
      this.outputWrites = this.outputWrites.then(async () => { await this.logFile!.write(data); }).catch(err => { this.processError = `Output retention failed: ${String(err)}`; this.terminate(); }).finally(() => stream?.resume());
      this.changed('output', { processId: this.id, taskId: this.spec.taskId, stream: kind, preview: data.toString().slice(-8192) });
    };
    this.child.stdout?.on('data', (data: Buffer) => append('stdout', data));
    this.child.stderr?.on('data', (data: Buffer) => append('stderr', data));
    this.child.stdin?.on('error', () => {});
    this.child.on('error', err => { this.processError = err.message; void this.finish(1); });
    this.child.on('close', code => { void this.finish(code ?? (this.cancelled ? 130 : 1)); });
    if ((this.spec.timeout ?? 0) > 0) this.timeoutTimer = setTimeout(() => this.terminate(), this.spec.timeout);
  }
  private async finish(code: number): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.exitCode = code;
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    // Keep kill escalation alive for descendants after the group leader exits.
    await this.outputWrites;
    this.resolveCompletion(); this.changed('completed', this.processStatus());
  }
  private signal(signal: NodeJS.Signals): void {
    if (!this.child?.pid) return;
    if (process.platform === 'win32') { execFile('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], () => {}); return; }
    try { process.kill(-this.child.pid, signal); } catch { /* already exited */ }
  }
  private terminate(): void {
    if (this.closed || this.cancelled) return;
    this.cancelled = true; this.signal('SIGTERM');
    this.killTimer = setTimeout(() => this.signal('SIGKILL'), 2000); this.killTimer.unref?.();
  }
  protected override async onStop(): Promise<void> {
    this.terminate(); await this.completion;
    if (this.killTimer) { clearTimeout(this.killTimer); this.signal('SIGKILL'); }
    await this.logFile?.close();
    if (this.logDir) await fs.rm(this.logDir, { recursive: true, force: true });
  }
}
