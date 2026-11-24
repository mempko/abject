export interface ClipboardKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function isApplePlatform(platform?: string): boolean {
  const value = platform ?? (typeof navigator !== 'undefined' ? navigator.platform : '');
  return /Mac|iPhone|iPad|iPod/i.test(value);
}

/**
 * Decide whether a keyboard event should be left unhandled by FrontendClient
 * so the browser fires native paste/copy/cut clipboard events instead of
 * forwarding the raw keydown to the backend.
 *
 * - Paste (Ctrl+V on Linux/Windows, Cmd+V on macOS) always defers so
 *   handlePasteEvent can read the system clipboard.
 * - Copy/Cut (Ctrl+C/X on Linux/Windows, Cmd+C/X on macOS) only defer when
 *   there is active widget text selection; otherwise they pass through to the
 *   backend so TerminalView receives Ctrl+C (\x03) / Ctrl+X (\x18).
 * - Ctrl+Shift+C / Ctrl+Shift+V never defer so TerminalView's own copy/paste
 *   bindings receive them.
 * - On Apple platforms, Ctrl-only shortcuts (without Cmd/Meta) never defer,
 *   so Ctrl+C always reaches the terminal even if text is selected.
 */
export function shouldDeferToBrowserClipboard(
  e: ClipboardKeyEvent,
  hasSelection: boolean,
  applePlatform: boolean = isApplePlatform(),
): boolean {
  if (e.altKey || e.shiftKey) return false;
  const isClipboardMod = applePlatform
    ? e.metaKey && !e.ctrlKey
    : e.ctrlKey && !e.metaKey;
  if (!isClipboardMod) return false;
  const key = e.key.toLowerCase();
  if (key === 'v') return true;
  if (key === 'c' || key === 'x') {
    return hasSelection;
  }
  return false;
}
