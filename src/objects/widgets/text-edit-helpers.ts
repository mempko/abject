/**
 * Shared text-editing primitives for TextInput / TextArea.
 *
 * - `wordBoundaryLeft/Right` find word edges relative to a cursor position.
 *   "Word" matches the convention used by every mainstream editor: a run
 *   of `[A-Za-z0-9_]` characters. Whitespace runs are skipped first when
 *   moving (so Ctrl-Right from `"|hello"` lands at `"hello|"`, but from
 *   `"hello |  world"` skips the spaces and lands at `"hello   world|"`).
 *
 * - `EditHistory<T>` is a generic undo/redo stack with typing-burst
 *   coalescing: consecutive same-kind edits within a 500 ms window collapse
 *   into one undo step, so a user typing "hello" gets one undo, not five.
 *   The snapshot type is per-widget (TextInput vs TextArea differ in
 *   cursor representation) — this class doesn't care.
 */

const WORD_RE = /[A-Za-z0-9_]/;

function isWord(c: string): boolean {
  return c !== '' && WORD_RE.test(c);
}

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t';
}

/**
 * Position to land at after Ctrl-Left from `pos`.
 *
 * Algorithm (matches macOS TextEdit, VS Code, Chrome):
 *   1. Move left over any trailing whitespace.
 *   2. Then move left over the run of characters of the same class
 *      (word or punctuation) you land on.
 */
export function wordBoundaryLeft(text: string, pos: number): number {
  if (pos <= 0) return 0;
  let i = pos;
  // Skip whitespace immediately to the left
  while (i > 0 && isSpace(text[i - 1])) i--;
  if (i === 0) return 0;
  // Determine the class of the character we just landed on
  const wordRun = isWord(text[i - 1]);
  while (i > 0) {
    const c = text[i - 1];
    if (isSpace(c)) break;
    if (isWord(c) !== wordRun) break;
    i--;
  }
  return i;
}

/**
 * Position to land at after Ctrl-Right from `pos`. Mirror of `wordBoundaryLeft`.
 */
export function wordBoundaryRight(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  let i = pos;
  // Skip the run of characters of the same class as `text[i]`
  if (i < text.length) {
    const wordRun = isWord(text[i]);
    while (i < text.length) {
      const c = text[i];
      if (isSpace(c)) break;
      if (isWord(c) !== wordRun) break;
      i++;
    }
  }
  // Then skip following whitespace
  while (i < text.length && isSpace(text[i])) i++;
  return i;
}

// ── Undo / redo ────────────────────────────────────────────────────────

/**
 * Kind of edit. Same-kind edits within the burst window collapse into one
 * undo step; different kinds always start a new step.
 */
export type EditKind = 'typing' | 'delete' | 'paste' | 'edit';

interface HistoryEntry<T> {
  snapshot: T;
  kind: EditKind;
  timestamp: number;
}

const BURST_MS = 500;
const MAX_HISTORY = 100;

export class EditHistory<T> {
  private undoStack: HistoryEntry<T>[] = [];
  private redoStack: HistoryEntry<T>[] = [];

  /**
   * Record `snapshot` as the pre-edit state of an upcoming change.
   *
   * Coalescing: if the previous entry is the same `kind` and was pushed
   * within the burst window, we keep the earlier snapshot — that's the
   * state we want to restore on undo. Pushing always clears the redo
   * stack (the user diverged from the redo branch).
   */
  push(snapshot: T, kind: EditKind = 'edit'): void {
    const now = Date.now();
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && top.kind === kind && (now - top.timestamp) < BURST_MS) {
      // Coalesce — extend the burst's timestamp but keep the older snapshot.
      top.timestamp = now;
      this.redoStack = [];
      return;
    }
    this.undoStack.push({ snapshot, kind, timestamp: now });
    if (this.undoStack.length > MAX_HISTORY) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  /**
   * Undo: returns the previous snapshot, pushes the *current* state to the
   * redo stack so a subsequent redo restores it. Returns null when there
   * is nothing left to undo.
   */
  undo(current: T): T | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push({ snapshot: current, kind: entry.kind, timestamp: Date.now() });
    return entry.snapshot;
  }

  redo(current: T): T | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push({ snapshot: current, kind: entry.kind, timestamp: Date.now() });
    return entry.snapshot;
  }

  /** Reset state — used by widgets when their text is replaced externally. */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
}
