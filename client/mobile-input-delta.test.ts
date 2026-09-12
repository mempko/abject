import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInputDelta } from './mobile-input-delta.js';

/** Keystrokes a delta expands to, for readable assertions. */
function expand(prev: string, cur: string): string {
  const d = computeInputDelta(prev, cur);
  return '\b'.repeat(d.backspaces) + d.inserted;
}

test('plain append (insertText-style typing) yields just the new chars', () => {
  assert.equal(expand('abc', 'abcd'), 'd');
  assert.equal(expand('', 'hello'), 'hello');
});

test('empty-to-empty yields nothing', () => {
  const d = computeInputDelta('', '');
  assert.equal(d.backspaces, 0);
  assert.equal(d.inserted, '');
});

test('deletion yields only backspaces', () => {
  assert.equal(expand('abcd', 'ab'), '\b\b');
});

test('composition growth (insertCompositionText) appends the delta, not the full text', () => {
  // GBoard-style: composition candidate grows each keystroke.
  let sent = '';
  for (const step of ['h', 'he', 'hel', 'hell', 'hello']) {
    const d = computeInputDelta(sent, step);
    sent = step;
    assert.equal(d.backspaces, 0);
    // Total inserted across steps must equal the final text exactly once.
  }
  assert.equal(sent, 'hello');
});

test('composition rewrite shrinks then re-inserts (candidate narrowed)', () => {
  // 'hello' composed, user backs up to 'hell', continues to 'hellw'
  assert.equal(expand('hello', 'hell'), '\b');
  assert.equal(expand('hell', 'hellw'), 'w');
});

test('autocorrect replacement (insertReplacementText) diffs in place', () => {
  // iOS autocorrect swaps 'teh' -> 'the' after the caret.
  assert.equal(expand('sent teh', 'sent the'), '\b\b' + 'he');
  // Word expansion: 'im' -> "I'm" — 'i' vs 'I' differ at index 0, so the
  // whole remainder is re-sent after backspaces.
  const d = computeInputDelta('im', "I'm");
  assert.equal(d.backspaces, 2);
  assert.equal(d.inserted, "I'm");
});

test('backspaces never exceed the previous length (common prefix floor)', () => {
  const d = computeInputDelta('abc', 'xyz');
  assert.equal(d.backspaces, 3);
  assert.equal(d.inserted, 'xyz');
});

test('sentinel-prefixed values diff cleanly after the shared prefix', () => {
  // KB_SENTINEL (U+200B) stays at position 0; typing after it diffs there.
  const s = '\u200b';
  assert.equal(expand(s, s + 'a'), 'a');
  assert.equal(expand(s + 'a', s), '\b');
});

test('inserting in the middle trims the changed suffix', () => {
  assert.equal(expand('ac', 'abc'), '\b' + 'bc');
});

test('unicode: surrogate pairs stay intact when they differ', () => {
  const d = computeInputDelta('a', 'a😀');
  assert.equal(d.inserted, '\uD83D\uDE00');
  const d2 = computeInputDelta('a\uD83D\uDE00', 'a');
  assert.equal(d2.backspaces, 2); // surrogate pair = 2 code units
});
