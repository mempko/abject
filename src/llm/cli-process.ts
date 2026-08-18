/**
 * Subprocess plumbing shared by the CLI-backed LLM providers.
 *
 * `claude-cli`, `codex-cli`, and `antigravity-cli` all drive a coding-agent
 * binary as a language model, and all of them need the same four things:
 * spawn it without a terminal, give up when it goes quiet rather than when
 * it takes long, read NDJSON off stdout as it arrives, and report a failure
 * with enough detail to replay by hand. Each grew its own copy of that; this
 * is the one copy.
 *
 * What stays with each provider is what genuinely differs: the flags, the
 * event shapes on stdout, and how a conversation is framed as one turn.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { LLMMessage } from './provider.js';
import { getTextContent } from './provider.js';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliRunOptions {
  /**
   * How long the process may be entirely silent before it is killed. Resets
   * on every byte of output, so a long-but-progressing generation keeps
   * running and only a true hang trips it.
   */
  idleTimeoutMs: number;
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
  /** Working directory; inherited from the parent when omitted. */
  cwd?: string;
}

/**
 * SIGTERM now, SIGKILL in 2s if the process ignores it.
 *
 * The escalation is the point: a CLI that traps SIGTERM to tear down a
 * session can outlive the request that started it, and once the watchdog has
 * fired there is nothing left watching. The fallback timer is unref'd so it
 * never holds the event loop open on its own.
 */
export function killProc(proc: ChildProcess): void {
  try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }, 2000);
  t.unref?.();
}

/**
 * Spawn a CLI without a terminal and return its output when it closes.
 *
 * Used for one-shot calls: `--version` probes, and request paths that read
 * the whole reply at the end rather than streaming it.
 */
export function runCliIdle(bin: string, argv: string[], opts: CliRunOptions): Promise<CliResult> {
  return runCli(bin, argv, opts);
}

/**
 * Like {@link runCliIdle}, but hands each complete line of stdout to
 * `onLine` as it arrives, so a long generation keeps resetting the idle
 * timer instead of looking hung. The final line is flushed on close even
 * without a trailing newline, which is where these CLIs put their result
 * event.
 */
export function runCliIdleStreaming(
  bin: string, argv: string[], opts: CliRunOptions,
  onLine: (line: string) => void,
): Promise<CliResult> {
  return runCli(bin, argv, opts, onLine);
}

function runCli(
  bin: string, argv: string[], opts: CliRunOptions,
  onLine?: (line: string) => void,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, argv, { stdio: ['pipe', 'pipe', 'pipe'], cwd: opts.cwd });
    let stdout = '';
    let stderr = '';
    let buffer = '';
    let killed = false;

    let idleTimer: ReturnType<typeof setTimeout>;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        killed = true;
        killProc(proc);
        reject(new Error(`${bin} idle for ${opts.idleTimeoutMs}ms — no output, subprocess killed`));
      }, opts.idleTimeoutMs);
    };
    armIdle();

    proc.stdout.on('data', (b) => {
      const s = b.toString();
      stdout += s;
      armIdle();
      if (!onLine) return;
      buffer += s;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        // A parser fault must never take down the subprocess runner.
        if (line) { try { onLine(line); } catch { /* skip */ } }
      }
    });
    proc.stderr.on('data', (b) => { stderr += b.toString(); armIdle(); });
    proc.on('error', (err) => {
      if (idleTimer) clearTimeout(idleTimer);
      if (!killed) reject(err);
    });
    proc.on('close', (code) => {
      if (idleTimer) clearTimeout(idleTimer);
      if (killed) return;
      const tail = buffer.trim();
      if (tail && onLine) { try { onLine(tail); } catch { /* skip */ } }
      resolve({ code: code ?? 0, stdout, stderr });
    });

    proc.stdin.end(opts.stdin ?? '');
  });
}

/** Everything known about a failed call, so it can be replayed by hand. */
export function formatCliError(
  bin: string, code: number, stderr: string, stdout: string,
  argv: string[], parsedError?: string, hint?: string,
): string {
  const parts = [`${bin} CLI exited ${code}`];
  if (parsedError) parts.push(`error=${parsedError}`);
  if (stderr.trim()) parts.push(`stderr=${stderr.trim().slice(0, 500)}`);
  if (stdout.trim()) parts.push(`stdout=${stdout.trim().slice(-500)}`);
  parts.push(`argv=${bin} ${argv.join(' ')}`);
  if (hint) parts.push(hint);
  return parts.join(' | ');
}

/** A conversation split into the two pieces every CLI prompt is built from. */
export interface FlatConversation {
  /** Every system message, joined. Empty when there were none. */
  system: string;
  /** User and assistant turns, role-labelled and joined. */
  transcript: string;
}

/**
 * Flatten a conversation into the single block of text a CLI accepts as one
 * turn.
 *
 * System messages come back separately rather than pre-framed: none of these
 * binaries takes a per-request system prompt, so each provider wraps them
 * its own way, and that framing is the part worth keeping local. Image parts
 * are dropped here; providers that can carry an image lift it out of the
 * message themselves before calling this.
 */
export function flattenConversation(messages: LLMMessage[]): FlatConversation {
  const systemParts: string[] = [];
  const transcript: string[] = [];
  for (const msg of messages) {
    const text = getTextContent(msg);
    if (msg.role === 'system') systemParts.push(text);
    else if (msg.role === 'assistant') transcript.push(`Assistant: ${text}`);
    else transcript.push(`User: ${text}`);
  }
  return { system: systemParts.join('\n\n'), transcript: transcript.join('\n\n') };
}

/** True when any message carries an image part. */
export function hasImages(messages: LLMMessage[]): boolean {
  return messages.some(m =>
    Array.isArray(m.content) && m.content.some(p => p.type === 'image'));
}
