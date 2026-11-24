import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isApplePlatform,
  shouldDeferToBrowserClipboard,
  type ClipboardKeyEvent,
} from './clipboard-shortcuts.js';

function keyEvent(
  key: string,
  mods: Partial<Omit<ClipboardKeyEvent, 'key'>> = {},
): ClipboardKeyEvent {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  };
}

describe('shouldDeferToBrowserClipboard', () => {
  it('forwards Ctrl+C to backend on Linux/Windows when nothing is selected (terminal SIGINT)', () => {
    assert.equal(
      shouldDeferToBrowserClipboard(keyEvent('c', { ctrlKey: true }), false, false),
      false,
    );
    // Caps Lock produces uppercase 'C' with shiftKey === false
    assert.equal(
      shouldDeferToBrowserClipboard(keyEvent('C', { ctrlKey: true }), false, false),
      false,
    );
  });

  it('defers Ctrl+C to browser copy on Linux/Windows when text is selected', () => {
    assert.equal(
      shouldDeferToBrowserClipboard(keyEvent('c', { ctrlKey: true }), true, false),
      true,
    );
    assert.equal(
      shouldDeferToBrowserClipboard(keyEvent('C', { ctrlKey: true }), true, false),
      true,
    );
  });

  it('forwards Ctrl+X when nothing is selected and defers when text is selected', () => {
    assert.equal(
      shouldDeferToBrowserClipboard(keyEvent('x', { ctrlKey: true }), false, false),
      false,
    );
    assert.equal(
      shouldDeferToBrowserClipboard(keyEvent('x', { ctrlKey: true }), true, false),
      true,
    );
  });

  it('always defers Ctrl+V (including under Caps Lock) on Linux/Windows for paste', () => {
    assert.equal(
      shouldDeferToBrowserClipboard(keyEvent('v', { ctrlKey: true }), false, false),
      true,
    );
    assert.equal(
      shouldDeferToBrowserClipboard(keyEvent('V', { ctrlKey: true }), false, false),
      true,
    );
  });

  it('never defers Ctrl+Shift+C / Ctrl+Shift+V (handled by TerminalView) or Alt combos', () => {
    assert.equal(
      shouldDeferToBrowserClipboard(keyEvent('C', { ctrlKey: true, shiftKey: true }), true, false),
      false,
    );
    assert.equal(
      shouldDeferToBrowserClipboard(keyEvent('V', { ctrlKey: true, shiftKey: true }), true, false),
      false,
    );
    assert.equal(
      shouldDeferToBrowserClipboard(keyEvent('c', { ctrlKey: true, altKey: true }), true, false),
      false,
    );
  });

  it('forwards Ctrl+C on macOS even when text is selected, while deferring Cmd+C/V/X appropriately', () => {
    assert.equal(
      shouldDeferToBrowserClipboard(keyEvent('c', { ctrlKey: true }), true, true),
      false,
    );
    assert.equal(
      shouldDeferToBrowserClipboard(keyEvent('v', { ctrlKey: true }), true, true),
      false,
    );
    assert.equal(
      shouldDeferToBrowserClipboard(keyEvent('c', { metaKey: true }), true, true),
      true,
    );
    assert.equal(
      shouldDeferToBrowserClipboard(keyEvent('c', { metaKey: true }), false, true),
      false,
    );
    assert.equal(
      shouldDeferToBrowserClipboard(keyEvent('x', { metaKey: true }), true, true),
      true,
    );
    assert.equal(
      shouldDeferToBrowserClipboard(keyEvent('v', { metaKey: true }), false, true),
      true,
    );
  });

  it('never defers non-clipboard Ctrl combos or unmodified keys', () => {
    assert.equal(
      shouldDeferToBrowserClipboard(keyEvent('d', { ctrlKey: true }), true, false),
      false,
    );
    assert.equal(
      shouldDeferToBrowserClipboard(keyEvent('c'), true, false),
      false,
    );
    assert.equal(
      shouldDeferToBrowserClipboard(keyEvent('c', { metaKey: true }), true, false),
      false,
    );
  });
});

describe('isApplePlatform', () => {
  it('detects Apple platforms and excludes Linux/Windows', () => {
    assert.equal(isApplePlatform('MacIntel'), true);
    assert.equal(isApplePlatform('iPhone'), true);
    assert.equal(isApplePlatform('Linux x86_64'), false);
    assert.equal(isApplePlatform('Win32'), false);
    assert.equal(isApplePlatform(''), false);
  });
});
