/**
 * A terminal session, driven the way a view drives it: write, read the screen,
 * resize, close. These run a real pty and the real libghostty screen, so they
 * fail if either half of the terminal works only in theory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Abject } from '../core/abject.js';
import { MessageBus } from '../runtime/message-bus.js';
import { request } from '../core/message.js';
import type { AbjectId, InterfaceId } from '../core/types.js';
import { TerminalSession } from './capabilities/terminal-session.js';

class Client extends Abject {
  constructor(name: string) {
    super({
      manifest: {
        name, version: '1.0.0', description: 'A test client that calls a terminal session.',
        interface: { id: 'test:terminal-client' as InterfaceId, name, description: 'test client', methods: [] },
        tags: ['test'],
      },
    });
  }

  callTo<T>(target: AbjectId, method: string, payload: unknown = {}): Promise<T> {
    return this.request<T>(request(this.id, target, method, payload));
  }
}

interface ScreenPayload { screen: Array<{ wrapped: boolean; cells: Array<{ text: string; fg?: string; bg?: string; bold?: boolean }> }>; cursor: { x: number; y: number } | null; cols: number; rows: number }

/** The screen as text. Cells arrive one per cell, so a phrase exists only after joining them. */
function screenText(payload: ScreenPayload): string {
  return payload.screen.map(row => row.cells.map(cell => cell.text).join('')).join('\n');
}

async function until<T>(probe: () => Promise<T | undefined>, what: string, timeoutMs = 20000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    last = value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

async function openSession(bus: MessageBus, owner: AbjectId, command: string, args: string[]): Promise<TerminalSession> {
  const session = new TerminalSession({ command, args, cwd: process.cwd(), cols: 80, rows: 24, owner, supervisor: owner });
  await session.init(bus);
  return session;
}

test('a terminal session runs typed commands in a real pty and reports the screen', async () => {
  const bus = new MessageBus();
  const owner = new Client('TerminalOwner'); await owner.init(bus);
  const session = await openSession(bus, owner.id, '/bin/sh', ['-i']);
  try {
    const status = await owner.callTo<{ state: string; cols: number; rows: number; pid?: number }>(session.id, 'status');
    assert.equal(status.state, 'running');
    assert.equal(status.cols, 80);
    assert.equal(status.rows, 24);
    assert.ok(status.pid, 'the shell has a pid');

    // The marker appears only in the command's OUTPUT, not in the echoed input
    // line, so seeing it means the shell really ran it.
    await owner.callTo(session.id, 'write', { text: "printf 'RESULT-%s\\n' 42\n" });
    const screen = await until(async () => {
      const payload = await owner.callTo<ScreenPayload>(session.id, 'screen');
      const text = payload.screen.map(row => row.cells.map(cell => cell.text).join('')).join('\n');
      return text.includes('RESULT-42') ? payload : undefined;
    }, 'the command output on screen');

    assert.ok(screen.cursor, 'the screen has a cursor');
    const lines = (await owner.callTo<{ lines: string[] }>(session.id, 'text')).lines;
    assert.ok(lines.join('\n').includes('RESULT-42'), 'the plain-text view shows the same output');

    await owner.callTo(session.id, 'write', { text: 'exit\n' });
    const finished = await owner.callTo<{ state: string; exitCode?: number }>(session.id, 'wait');
    assert.equal(finished.state, 'exited');
    assert.equal(typeof finished.exitCode, 'number');
  } finally {
    await session.close();
  }
});

test('a full-screen program repaints: colours, a cleared screen and the new frame', async () => {
  const bus = new MessageBus();
  const owner = new Client('TerminalOwner'); await owner.init(bus);
  const painter = [
    "const E = String.fromCharCode(27);",
    "const w = (s) => process.stdout.write(s);",
    "w(E + '[?1049h' + E + '[2J');",
    "for (let i = 1; i <= 3; i += 1) w(E + '[' + i + ';1H' + E + '[3' + i + 'mLINE' + i + E + '[0m');",
    "w(E + '[5;1H' + E + '[1;44mBOLD-BLUE' + E + '[0m');",
    "setTimeout(() => { w(E + '[2J' + E + '[1;1HREPAINTED'); }, 2500);",
    'process.stdin.resume();',
  ].join('\n');
  const session = await openSession(bus, owner.id, process.execPath, ['-e', painter]);
  try {
    const first = await until(async () => {
      const payload = await owner.callTo<ScreenPayload>(session.id, 'screen');
      const text = screenText(payload);
      return text.includes('LINE3') && text.includes('BOLD-BLUE') ? payload : undefined;
    }, 'the first painted frame');

    const second = await until(async () => {
      const payload = await owner.callTo<ScreenPayload>(session.id, 'screen');
      return screenText(payload).includes('REPAINTED') ? payload : undefined;
    }, 'the repainted frame');

    // The repaint cleared the screen: the old frame is gone, so this is a
    // redraw rather than paint accumulating on the same pixels.
    const secondText = screenText(second);
    assert.ok(!secondText.includes('LINE3'), 'the cleared screen no longer shows the first frame');

    // Colours survive the round trip: the first frame carried a foreground for
    // LINE1 (palette 1 is red) and a background for BOLD-BLUE.
    const painted = first.screen.flatMap(row => row.cells);
    const coloured = painted.filter(cell => cell.text.trim().length > 0 && cell.fg);
    assert.ok(coloured.length > 0, 'painted cells carry a foreground colour');
    assert.ok(painted.some(cell => cell.bg), 'the inverse band carries a background colour');

    const resized = await owner.callTo<{ cols: number; rows: number }>(session.id, 'resize', { cols: 100, rows: 30 });
    assert.deepEqual({ cols: resized.cols, rows: resized.rows }, { cols: 100, rows: 30 });
    const afterResize = await owner.callTo<ScreenPayload>(session.id, 'screen');
    assert.equal(afterResize.cols, 100);
    assert.equal(afterResize.rows, 30);
  } finally {
    await session.close();
  }
});

test('a terminal session answers only its owner, and close is safe to repeat', async () => {
  const bus = new MessageBus();
  const owner = new Client('TerminalOwner'); await owner.init(bus);
  const stranger = new Client('Stranger'); await stranger.init(bus);
  const session = await openSession(bus, owner.id, process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  try {
    await assert.rejects(stranger.callTo(session.id, 'screen'), /another caller/);
    await assert.rejects(stranger.callTo(session.id, 'write', { text: 'x' }), /another caller/);
    await assert.rejects(stranger.callTo(session.id, 'close'), /another caller/);
    const closed = await owner.callTo<{ state: string }>(session.id, 'close');
    assert.equal(closed.state, 'exited');
    const again = await owner.callTo<{ state: string }>(session.id, 'close');
    assert.equal(again.state, 'exited');
  } finally {
    await session.close();
  }
});
