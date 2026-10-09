/**
 * Connecting to a backend: the login handshake and the plain-terminal
 * prompts the command uses before (or instead of) the full-screen TUI.
 */

import { AbjectClient, type Credentials, type PushedEvent } from './client.js';
import { loadCliConfig, saveToken } from './config.js';
import type { BackendTarget } from './locate.js';

// ── Plain-terminal prompts ─────────────────────────────────────────────

/** Read one line from the terminal; `mask` echoes '*' (passwords, keys). */
export function promptLine(question: string, mask = false): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    let value = '';
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.off('data', onData);
          if (!wasRaw) process.stdin.setRawMode?.(false);
          process.stdin.pause();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\x03') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\x7f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (ch >= ' ') {
          value += ch;
          process.stdout.write(mask ? '*' : ch);
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

/** A yes/no question; Enter takes the default. */
export async function confirmLine(question: string, defaultYes: boolean): Promise<boolean> {
  const answer = (await promptLine(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

/** Pick one of several choices by number; Enter takes the default. */
export async function chooseLine(question: string, choices: string[], defaultIndex = 0): Promise<number> {
  for (;;) {
    process.stdout.write(`${question}\n`);
    choices.forEach((c, i) => process.stdout.write(`  ${i + 1}) ${c}${i === defaultIndex ? '  (default)' : ''}\n`));
    const answer = (await promptLine('> ')).trim();
    if (!answer) return defaultIndex;
    const n = parseInt(answer, 10);
    if (n >= 1 && n <= choices.length) return n - 1;
    process.stdout.write(`Enter a number from 1 to ${choices.length}.\n`);
  }
}

// ── Login ──────────────────────────────────────────────────────────────

/**
 * The credentials to offer, in order: the owner token from the instance
 * file (a local backend), a cached session token, ABJECTS_AUTH_USER and
 * ABJECTS_AUTH_PASSWORD, then a prompt at a terminal.
 */
export function makeCredentialProvider(target: BackendTarget): (attempt: number, error?: string) => Promise<Credentials | null> {
  const offers: Credentials[] = [];
  if (target.ownerToken) offers.push({ ownerToken: target.ownerToken });
  const cached = loadCliConfig().tokens[target.url];
  if (cached) offers.push({ token: cached });
  const envUser = process.env.ABJECTS_AUTH_USER;
  const envPass = process.env.ABJECTS_AUTH_PASSWORD;
  if (envUser && envPass) offers.push({ username: envUser, password: envPass });
  return async (attempt, error) => {
    if (attempt < offers.length) return offers[attempt];
    if (!process.stdin.isTTY) return null;
    if (attempt >= offers.length + 3) return null;
    if (error && attempt > offers.length) process.stdout.write(`${error}\n`);
    const username = await promptLine('username: ');
    const password = await promptLine('password: ', true);
    return { username, password };
  };
}

/** Connect and log in. Events and the close go to the given handlers. */
export async function connectClient(
  target: BackendTarget,
  handlers: { onEvent?: (event: PushedEvent) => void; onClose?: (reason: string) => void } = {},
): Promise<AbjectClient> {
  const client = new AbjectClient({
    url: target.url,
    getCredentials: makeCredentialProvider(target),
    onToken: (token) => saveToken(target.url, token),
    onEvent: handlers.onEvent ?? (() => { /* not listening */ }),
    onClose: handlers.onClose ?? (() => { /* nothing to clean up */ }),
  });
  await client.connect();
  return client;
}
