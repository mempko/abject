/**
 * Undo and redo, as abjects offer them to each other.
 *
 * The abject that owns some data keeps the history of changes to it, one
 * history per caller: a window asks the owner to undo *its* last change, so
 * the undo arrives from the same caller as the change did and the owner's
 * usual admission checks still hold. An abject that offers undo declares the
 * `undo`, `redo` and `getUndoState` methods below and emits
 * `undoStateChanged` to the caller whose history moved.
 *
 * `UndoHistory` is the bookkeeping: labeled steps, a burst of steps with the
 * same label merged into one, bounded by count and size. What a step holds
 * and how it is applied belong to the owner. An owner that finds a step no
 * longer applies (the data changed since, the thing it brings back expired)
 * throws `UndoRefused`, and the step is dropped rather than retried.
 */

import type { EventDeclaration, InterfaceId, MethodDeclaration, AbjectManifest } from './types.js';
import { require as precondition } from './contracts.js';

export const UNDOABLE_INTERFACE = 'abjects:undoable' as InterfaceId;

export type UndoAction = 'undo' | 'redo';

/** What undo and redo would do next, as `getUndoState` answers. */
export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  /**
   * When the step undo would take was made, and when the step redo would
   * take was undone: a caller that changed several owners undoes the newest.
   */
  undoAt?: number;
  redoAt?: number;
}

/** The reply to `undo` and `redo`. Owners may add fields (Storage adds `restored`). */
export interface UndoResult {
  ok: boolean;
  /** The step's label, e.g. "Delete Notes". */
  label?: string;
  /** Why nothing happened, when ok is false. */
  reason?: string;
  [extra: string]: unknown;
}

export interface UndoStep<T> {
  label: string;
  /** When the step was made (or last merged into). */
  at: number;
  /** When it was undone, while it waits on the redo side. */
  undoneAt?: number;
  /** Steps merge only with the same label and the same key (e.g. the record they touch). */
  mergeKey?: string;
  data: T;
}

/** A step that can no longer be applied; the history drops it. */
export class UndoRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UndoRefused';
  }
}

export interface UndoHistoryOptions<T> {
  /** Steps kept on both sides together (default 100). */
  maxSteps?: number;
  /** Size kept on both sides together, by `sizeOf` (default 4 MB). */
  maxBytes?: number;
  /** A step made within this long of the last one, same label and key, merges into it (default 1000 ms; 0 never merges). */
  mergeMs?: number;
  /** How two merging steps become one; without it steps never merge. */
  merge?: (older: T, newer: T) => T;
  sizeOf?: (data: T) => number;
}

export interface UndoHistoryJSON<T> {
  done: UndoStep<T>[];
  undone: UndoStep<T>[];
}

function jsonSize(data: unknown): number {
  try { return JSON.stringify(data)?.length ?? 0; } catch { return 0; }
}

/**
 * One caller's undo and redo stacks. `undo` and `redo` run one at a time;
 * the owner's `apply` does the work and the step moves sides only when it
 * succeeds.
 */
export class UndoHistory<T> {
  private done: UndoStep<T>[] = [];
  private undone: UndoStep<T>[] = [];
  private readonly maxSteps: number;
  private readonly maxBytes: number;
  private readonly mergeMs: number;
  private readonly merge?: (older: T, newer: T) => T;
  private readonly sizeOf: (data: T) => number;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: UndoHistoryOptions<T> = {}) {
    this.maxSteps = options.maxSteps ?? 100;
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    this.mergeMs = options.mergeMs ?? 1000;
    this.merge = options.merge;
    this.sizeOf = options.sizeOf ?? jsonSize;
    precondition(this.maxSteps > 0, 'UndoHistory: maxSteps must be positive');
  }

  /** Record a change. A new change clears what could be redone. */
  record(label: string, data: T, opts: { mergeKey?: string; at?: number } = {}): void {
    precondition(typeof label === 'string' && label.length > 0, 'UndoHistory.record: a step needs a label');
    const at = opts.at ?? Date.now();
    this.undone = [];
    const top = this.done[this.done.length - 1];
    if (top && this.merge && this.mergeMs > 0 && top.label === label && top.mergeKey === opts.mergeKey
        && at - top.at < this.mergeMs) {
      top.data = this.merge(top.data, data);
      top.at = at;
    } else {
      this.done.push({ label, at, data, ...(opts.mergeKey !== undefined ? { mergeKey: opts.mergeKey } : {}) });
    }
    this.trim();
  }

  state(): UndoState {
    const u = this.done[this.done.length - 1];
    const r = this.undone[this.undone.length - 1];
    return {
      canUndo: !!u,
      canRedo: !!r,
      ...(u ? { undoLabel: u.label, undoAt: u.at } : {}),
      ...(r ? { redoLabel: r.label, redoAt: r.undoneAt ?? r.at } : {}),
    };
  }

  get isEmpty(): boolean {
    return this.done.length === 0 && this.undone.length === 0;
  }

  /** Undo the newest step with `apply`; it moves to the redo side once applied. */
  undo(apply: (step: UndoStep<T>) => Promise<unknown> | unknown): Promise<UndoResult> {
    return this.run('undo', apply);
  }

  /** Redo the newest undone step with `apply`; it moves back once applied. */
  redo(apply: (step: UndoStep<T>) => Promise<unknown> | unknown): Promise<UndoResult> {
    return this.run('redo', apply);
  }

  /** Drop steps `keep` turns down (what they bring back is gone). */
  prune(keep: (step: UndoStep<T>) => boolean): void {
    this.done = this.done.filter(keep);
    this.undone = this.undone.filter(keep);
  }

  /** Every step, both sides, oldest first. */
  steps(): UndoStep<T>[] {
    return [...this.done, ...this.undone];
  }

  clear(): void {
    this.done = [];
    this.undone = [];
  }

  toJSON(): UndoHistoryJSON<T> {
    return { done: this.done.slice(), undone: this.undone.slice() };
  }

  /** Load stacks saved with toJSON, keeping the limits of this history. */
  load(json: UndoHistoryJSON<T> | null | undefined): this {
    const ok = (s: unknown): s is UndoStep<T> =>
      !!s && typeof (s as UndoStep<T>).label === 'string' && typeof (s as UndoStep<T>).at === 'number';
    this.done = Array.isArray(json?.done) ? json!.done.filter(ok) : [];
    this.undone = Array.isArray(json?.undone) ? json!.undone.filter(ok) : [];
    this.trim();
    return this;
  }

  private run(action: UndoAction, apply: (step: UndoStep<T>) => Promise<unknown> | unknown): Promise<UndoResult> {
    const next = this.tail.then(async (): Promise<UndoResult> => {
      const from = action === 'undo' ? this.done : this.undone;
      const step = from.pop();
      if (!step) return { ok: false, reason: action === 'undo' ? 'Nothing to undo' : 'Nothing to redo' };
      try {
        const extra = await apply(step);
        if (action === 'undo') {
          step.undoneAt = Date.now();
          this.undone.push(step);
        } else {
          delete step.undoneAt;
          step.at = Date.now();
          this.done.push(step);
        }
        return { ...(extra && typeof extra === 'object' ? extra as Record<string, unknown> : {}), ok: true, label: step.label };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // A refused step is gone for good; anything else may work next time.
        if (!(err instanceof UndoRefused)) from.push(step);
        return { ok: false, label: step.label, reason };
      }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  private trim(): void {
    while (this.done.length + this.undone.length > this.maxSteps) {
      if (this.done.length > 0) this.done.shift(); else this.undone.shift();
    }
    let bytes = 0;
    for (const s of this.done) bytes += this.sizeOf(s.data);
    for (const s of this.undone) bytes += this.sizeOf(s.data);
    while (bytes > this.maxBytes && this.done.length + this.undone.length > 1) {
      const dropped = this.done.length > 0 ? this.done.shift()! : this.undone.shift()!;
      bytes -= this.sizeOf(dropped.data);
    }
  }
}

/**
 * Histories by caller, for an owner that many callers change. The least
 * recently used caller's history goes first when there are too many.
 */
export class UndoHistories<T> {
  private readonly byCaller = new Map<string, UndoHistory<T>>();

  constructor(
    private readonly options: UndoHistoryOptions<T> = {},
    private readonly maxCallers = 64,
  ) {}

  /** The caller's history, made on first use. */
  for(caller: string): UndoHistory<T> {
    let history = this.byCaller.get(caller);
    if (history) {
      this.byCaller.delete(caller);
    } else {
      history = new UndoHistory<T>(this.options);
    }
    this.byCaller.set(caller, history);
    while (this.byCaller.size > this.maxCallers) this.byCaller.delete(this.byCaller.keys().next().value!);
    return history;
  }

  /** The caller's history if it has one. */
  get(caller: string): UndoHistory<T> | undefined {
    return this.byCaller.get(caller);
  }

  state(caller: string): UndoState {
    return this.byCaller.get(caller)?.state() ?? { canUndo: false, canRedo: false };
  }

  /** Drop steps `keep` turns down. Emptied histories stay: one may have a step in flight. */
  prune(keep: (step: UndoStep<T>) => boolean): void {
    for (const history of this.byCaller.values()) history.prune(keep);
  }

  steps(): UndoStep<T>[] {
    return [...this.byCaller.values()].flatMap(h => h.steps());
  }

  toJSON(): Record<string, UndoHistoryJSON<T>> {
    const out: Record<string, UndoHistoryJSON<T>> = {};
    for (const [caller, history] of this.byCaller) if (!history.isEmpty) out[caller] = history.toJSON();
    return out;
  }

  load(json: Record<string, UndoHistoryJSON<T>> | null | undefined): this {
    this.byCaller.clear();
    for (const [caller, saved] of Object.entries(json ?? {})) {
      const history = new UndoHistory<T>(this.options).load(saved);
      if (!history.isEmpty) this.byCaller.set(caller, history);
    }
    return this;
  }
}

const undoResultType = { kind: 'object' as const, properties: {
  ok: { kind: 'primitive' as const, primitive: 'boolean' as const },
  label: { kind: 'primitive' as const, primitive: 'string' as const },
  reason: { kind: 'primitive' as const, primitive: 'string' as const },
} };

/**
 * The undo methods for a manifest. `what` says what is undone, e.g. "your
 * last change to a kept object".
 */
export function undoMethods(what = 'your last change here'): MethodDeclaration[] {
  return [
    {
      name: 'undo',
      description: `Undo ${what}. Returns { ok, label, reason }: ok is false with a reason when there is nothing to undo or the change can no longer be undone (it changed again since).`,
      parameters: [],
      returns: undoResultType,
    },
    {
      name: 'redo',
      description: 'Redo the change undo last took back. Returns { ok, label, reason }.',
      parameters: [],
      returns: undoResultType,
    },
    {
      name: 'getUndoState',
      description: 'What undo and redo would do next: { canUndo, canRedo, undoLabel, redoLabel, undoAt, redoAt }.',
      parameters: [],
      returns: { kind: 'object', properties: {
        canUndo: { kind: 'primitive', primitive: 'boolean' },
        canRedo: { kind: 'primitive', primitive: 'boolean' },
        undoLabel: { kind: 'primitive', primitive: 'string' },
        redoLabel: { kind: 'primitive', primitive: 'string' },
      } },
    },
  ];
}

export const UNDO_EVENTS: EventDeclaration[] = [
  {
    name: 'undoStateChanged',
    description: 'Sent to a caller when what undo or redo would do for it changed: { canUndo, canRedo, undoLabel, redoLabel }.',
    payload: { kind: 'object', properties: {} },
  },
];

/** Whether a manifest offers undo and redo. */
export function isUndoable(manifest: Pick<AbjectManifest, 'interface'> | undefined): boolean {
  const methods = manifest?.interface?.methods ?? [];
  return methods.some(m => m.name === 'undo') && methods.some(m => m.name === 'redo');
}

/** Whether a key press asks for undo or redo: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y. */
export function undoKeyAction(
  key: string | undefined,
  modifiers: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } | undefined,
): UndoAction | undefined {
  if (!modifiers || modifiers.alt || !(modifiers.ctrl || modifiers.meta)) return undefined;
  const k = (key ?? '').toLowerCase();
  if (k === 'z') return modifiers.shift ? 'redo' : 'undo';
  if (k === 'y' && !modifiers.shift) return 'redo';
  return undefined;
}

/** JSON equality, for "has this changed since the step was made". */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}
