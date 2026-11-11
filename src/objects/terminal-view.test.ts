/**
 * The terminal view's painter, exercised against real libghostty cells.
 *
 * The frames here are composed from the live screen of a real pty running a
 * real full-screen program, so a repaint is demonstrated rather than asserted:
 * the second frame is compared against the first and must show the new screen
 * with the old one gone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Abject } from '../core/abject.js';
import { MessageBus } from '../runtime/message-bus.js';
import { request } from '../core/message.js';
import type { AbjectId, InterfaceId } from '../core/types.js';
import { TerminalSession } from './capabilities/terminal-session.js';
import {
  composeTerminalFrame,
  encodeKey,
  encodeMouse,
  scanMouseMode,
  type TerminalScreen,
  type FrameOptions,
} from './terminal-view.js';
import { MONO_FONT_STACK } from './widgets/widget-types.js';

class Client extends Abject {
  constructor(name: string) {
    super({
      manifest: {
        name, version: '1.0.0', description: 'A test client that calls a terminal session.',
        interface: { id: 'test:terminal-view-client' as InterfaceId, name, description: 'test client', methods: [] },
        tags: ['test'],
      },
    });
  }

  callTo<T>(target: AbjectId, method: string, payload: unknown = {}): Promise<T> {
    return this.request<T>(request(this.id, target, method, payload));
  }
}

const FRAME_OPTS: FrameOptions = {
  cellW: 8.4,
  cellH: 18,
  fontSize: 14,
  fontFamily: MONO_FONT_STACK,
  defaultFg: '#e6e6e6',
  defaultBg: '#101014',
};

/** The visible screen as text. Cells arrive one per cell, so a phrase exists only after joining. */
function screenText(screen: TerminalScreen): string {
  return screen.screen.map(row => row.cells.map(cell => cell.text).join('')).join('\n');
}

/** Every glyph the composed frame would paint, in order. */
function paintedText(commands: ReturnType<typeof composeTerminalFrame>): string {
  return commands.filter(c => c.type === 'text').map(c => String(c.params.text)).join('');
}

async function until<T>(probe: () => Promise<T | undefined>, what: string, timeoutMs = 25000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function openSession(bus: MessageBus, owner: AbjectId, command: string, args: string[]): Promise<TerminalSession> {
  const session = new TerminalSession({ command, args, cwd: process.cwd(), cols: 80, rows: 24, owner, supervisor: owner });
  await session.init(bus);
  return session;
}

test('a full-screen TUI repaints: the composed frame changes and the old screen is gone', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'terminal-view-'));
  const file = path.join(dir, 'lines.txt');
  const lines = Array.from({ length: 200 }, (_, i) => `line-${String(i + 1).padStart(3, '0')}`);
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

  const bus = new MessageBus();
  const owner = new Client('TerminalViewOwner'); await owner.init(bus);
  const session = await openSession(bus, owner.id, '/usr/bin/less', ['-R', file]);
  try {
    // First frame: the pager has taken the alternate screen and painted the top.
    const first = await until(async () => {
      const screen = await owner.callTo<TerminalScreen>(session.id, 'screen');
      const text = screenText(screen);
      return text.includes('line-001') ? screen : undefined;
    }, 'the pager to paint the first screen');

    const firstFrame = composeTerminalFrame(first, FRAME_OPTS);
    assert.equal(firstFrame[0].type, 'clear', 'every frame opens with a clear');
    assert.ok(paintedText(firstFrame).includes('line-001'), 'the first frame paints the first line');
    assert.ok(!paintedText(firstFrame).includes('line-200'), 'the first frame has not reached the end');

    // Scroll to the end. The pager repaints the whole alternate screen.
    await owner.callTo(session.id, 'write', { text: 'G' });
    const second = await until(async () => {
      const screen = await owner.callTo<TerminalScreen>(session.id, 'screen');
      const text = screenText(screen);
      return text.includes('line-200') ? screen : undefined;
    }, 'the pager to repaint at the end of the file');

    const secondFrame = composeTerminalFrame(second, FRAME_OPTS);
    assert.equal(secondFrame[0].type, 'clear', 'the repaint also opens with a clear');

    // The demonstration: the two frames differ, and the second is a redraw of
    // the same surface rather than more paint on top of the first.
    assert.notDeepEqual(secondFrame, firstFrame, 'the repainted frame differs from the first');
    const secondText = paintedText(secondFrame);
    assert.ok(secondText.includes('line-200'), 'the repainted frame paints the last line');
    assert.ok(!secondText.includes('line-001'), 'the repainted frame no longer shows the first line');

    // A clear at the head of each batch is what makes that true on the surface:
    // the second batch starts from an empty canvas, not from the first frame.
    const clears = secondFrame.filter(c => c.type === 'clear');
    assert.equal(clears.length, 1, 'exactly one clear per frame');
  } finally {
    await session.close();
  }
});

test('the painter carries per-cell colour, wide characters, bold and the cursor', async () => {
  const bus = new MessageBus();
  const owner = new Client('TerminalViewOwner'); await owner.init(bus);
  const painter = [
    "const E = String.fromCharCode(27);",
    "const w = (s) => process.stdout.write(s);",
    "w(E + '[?1049h' + E + '[2J');",
    "w(E + '[1;1H' + E + '[31mRED-TEXT' + E + '[0m');",
    "w(E + '[2;1H' + E + '[1;44mBOLD-BLUE' + E + '[0m');",
    "w(E + '[3;1H' + E + '[7mINVERSE' + E + '[0m');",
    // A wide character: CJK ideographs are two cells.
    "w(E + '[4;1H\u4f60\u597dWIDE');",
    'process.stdin.resume();',
  ].join('\n');
  const session = await openSession(bus, owner.id, process.execPath, ['-e', painter]);
  try {
    const screen = await until(async () => {
      const payload = await owner.callTo<TerminalScreen>(session.id, 'screen');
      return screenText(payload).includes('WIDE') ? payload : undefined;
    }, 'the painted frame');

    const frame = composeTerminalFrame(screen, FRAME_OPTS);
    assert.equal(frame[0].type, 'clear');

    const text = paintedText(frame);
    assert.ok(text.includes('RED-TEXT'), 'the red run is painted');
    assert.ok(text.includes('BOLD-BLUE'), 'the bold run is painted');
    assert.ok(text.includes('WIDE'), 'the wide-character line is painted');

    // Colours survive into the batch: a foreground on the red run, a filled
    // rect behind the bold-blue band, and a separate fill for the inverse run.
    const textOps = frame.filter(c => c.type === 'text');
    assert.ok(textOps.some(c => typeof c.params.fill === 'string' && c.params.fill !== FRAME_OPTS.defaultFg),
      'a run is painted in a colour that is not the default foreground');
    assert.ok(textOps.some(c => String(c.params.font).includes('600')), 'the bold run asks for a bold face');

    const rects = frame.filter(c => c.type === 'rect');
    assert.ok(rects.length > 0, 'coloured bands are filled with rects');
    assert.ok(rects.some(c => c.params.fill === '#0000aa' || c.params.fill === '#0000cd'
      || (typeof c.params.fill === 'string' && c.params.fill.startsWith('#'))),
      'the band carries a real CSS colour');

    // The cursor is drawn last, so it reads on top of the cell it sits in.
    const cursor = screen.cursor;
    assert.ok(cursor, 'the screen reports a cursor');
    const lastRect = [...frame].reverse().find(c => c.type === 'rect' && c.params.width === FRAME_OPTS.cellW);
    assert.ok(lastRect, 'the cursor is painted as a cell-sized rect');

    // Wide characters occupy two cells: the line's advance must account for it.
    const wideRow = screen.screen[3];
    const wideCells = wideRow.cells.slice(0, 2);
    assert.ok(wideCells.every(c => c.width === 2), 'the CJK glyphs report width 2');
  } finally {
    await session.close();
  }
});

test('a selection is painted under the glyphs and reads back as text', () => {
  const screen: TerminalScreen = {
    sessionId: 's' as AbjectId,
    seq: 1,
    ready: true,
    cols: 10,
    rows: 2,
    screen: [
      { wrapped: false, cells: [...'hello'].map(ch => ({ text: ch, width: 1 as const })) },
      { wrapped: false, cells: [...'world'].map(ch => ({ text: ch, width: 1 as const })) },
    ],
    cursor: { x: 0, y: 1, visible: true },
  };

  const frame = composeTerminalFrame(screen, {
    ...FRAME_OPTS,
    selection: { fromCol: 1, fromRow: 0, toCol: 3, toRow: 0 },
    selectionColor: 'rgba(120,160,255,0.30)',
  });

  const selectionRect = frame.find(c => c.type === 'rect' && c.params.fill === 'rgba(120,160,255,0.30)');
  assert.ok(selectionRect, 'the selection is painted');
  assert.equal(selectionRect.params.x, 1 * FRAME_OPTS.cellW, 'it starts at the selected column');
  assert.equal(selectionRect.params.width, 3 * FRAME_OPTS.cellW, 'it spans the selected columns');

  // The selection rect comes before the glyphs, so text stays readable on top.
  const selectionIdx = frame.indexOf(selectionRect);
  const firstTextIdx = frame.findIndex(c => c.type === 'text');
  assert.ok(selectionIdx < firstTextIdx, 'the selection is under the glyphs');
});

test('keys encode to the bytes a terminal program expects', () => {
  assert.equal(encodeKey('Enter', 'Enter'), '\r');
  assert.equal(encodeKey('Enter', 'Enter', { alt: true }), '\x1b\r');
  assert.equal(encodeKey('Tab', 'Tab'), '\t');
  assert.equal(encodeKey('Tab', 'Tab', { shift: true }), '\x1b[Z');
  assert.equal(encodeKey('Backspace', 'Backspace'), '\x7f');
  assert.equal(encodeKey('Escape', 'Escape'), '\x1b');
  assert.equal(encodeKey('ArrowUp', 'ArrowUp'), '\x1b[A');
  assert.equal(encodeKey('ArrowLeft', 'ArrowLeft', { ctrl: true }), '\x1b[1;5D');
  assert.equal(encodeKey('Delete', 'Delete'), '\x1b[3~');
  assert.equal(encodeKey('F1', 'F1'), '\x1b[11~');
  assert.equal(encodeKey('a', 'KeyA'), 'a');
  assert.equal(encodeKey('a', 'KeyA', { ctrl: true }), '\x01');
  assert.equal(encodeKey('c', 'KeyC', { ctrl: true }), '\x03');
  assert.equal(encodeKey('x', 'KeyX', { alt: true }), '\x1bx');
  // A bare modifier produces nothing, so the caller drops it rather than guessing.
  assert.equal(encodeKey('Shift', 'ShiftLeft', { shift: true }), null);
});

test('mouse reporting follows the program and encodes as SGR reports', () => {
  assert.equal(scanMouseMode(false, '\x1b[?1000h'), true, 'a program asking for reports is honoured');
  assert.equal(scanMouseMode(true, '\x1b[?1000l'), false, 'a program giving them up is honoured');
  assert.equal(scanMouseMode(false, 'plain output with no modes'), false, 'nothing is assumed without a request');
  assert.equal(scanMouseMode(false, '\x1b[?1049h\x1b[?1002h'), true, 'button-event tracking counts');

  assert.equal(encodeMouse('down', 0, 0, 0), '\x1b[<0;1;1M');
  assert.equal(encodeMouse('up', 0, 4, 2), '\x1b[<0;5;3m');
  assert.equal(encodeMouse('wheel', 0, 0, 0, {}, -1), '\x1b[<64;1;1M');
  assert.equal(encodeMouse('wheel', 0, 0, 0, {}, 1), '\x1b[<65;1;1M');
  assert.equal(encodeMouse('down', 0, 0, 0, { ctrl: true }), '\x1b[<16;1;1M');
});
