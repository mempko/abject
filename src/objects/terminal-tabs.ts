/**
 * The tab set behind the terminal window's strip.
 *
 * This is the model of the tabs: which shells are open, what each one is called,
 * and which of them the canvas is showing. It holds no widget ids, sends no
 * messages and knows nothing about libghostty or a pty, so every rule a person
 * feels in the strip is stated here once and can be exercised without a display:
 *
 * - a new tab goes on the right and becomes the one showing;
 * - its name starts as a sensible default (`Terminal 3`, numbered monotonically
 *   so a closed tab's number is never handed to a new one) and, once the person
 *   renames it, only the person changes it again - `renamed` records that;
 * - closing a tab that is not showing leaves the shown one alone; closing the
 *   shown one moves to its neighbour, the one on its right first;
 * - the last tab closing empties the set, which is what takes the window down.
 */
import { require, ensure, invariant } from '../core/contracts.js';

/** One open shell, as the strip knows it. */
export interface TerminalTab {
  /** Stable for the tab's life; the view stores its widgets under this. */
  id: string;
  /** The TerminalSession this tab stands for. */
  sessionId: string;
  /** What the strip shows, and what the person typed if they renamed it. */
  name: string;
  /** True once the person has named it, so a default is never recomputed. */
  renamed: boolean;
}

export interface TabSetState {
  tabs: TerminalTab[];
  /** The tab the canvas is showing, or null when nothing is open. */
  activeId: string | null;
  /** Monotonic tab numbering, so names and ids are never reused. */
  nextNumber: number;
}

/** More than this in one strip stops being readable, so the window refuses it. */
export const MAX_TABS = 12;
/** A name longer than this is refused rather than silently truncated in the model. */
export const MAX_NAME_CHARS = 60;
/** Below this a label says nothing, so the strip stops shrinking it. */
const MIN_LABEL_CHARS = 4;
/** A label wider than this wastes the strip on one tab. */
const MAX_LABEL_CHARS = 30;

/** The budget the strip has to give each label, after fixed chrome. */
const STRIP_RESERVED_PX = 170;
/** What one tab spends on its close button and padding. */
const TAB_CHROME_PX = 30;

export function emptyTabSet(): TabSetState {
  return { tabs: [], activeId: null, nextNumber: 1 };
}

/** The default name for the n-th tab this window ever opened. */
export function defaultTabName(number: number): string {
  require(Number.isInteger(number) && number >= 1, 'a tab is numbered from one');
  return `Terminal ${number}`;
}

export function findTab(state: TabSetState, tabId: string | undefined | null): TerminalTab | undefined {
  if (!tabId) return undefined;
  return state.tabs.find(tab => tab.id === tabId);
}

export function activeTab(state: TabSetState): TerminalTab | undefined {
  return findTab(state, state.activeId);
}

/** The tab showing a given session, if it is still open. */
export function tabForSession(state: TabSetState, sessionId: string): TerminalTab | undefined {
  return state.tabs.find(tab => tab.sessionId === sessionId);
}

/**
 * Add a tab for a session that has already been opened, and show it.
 *
 * The session is opened first (it is the step that asks the person), so the cap
 * is checked by the caller before anything is asked; this guard is the model's
 * own statement of the same limit.
 */
export function addTab(
  state: TabSetState,
  sessionId: string,
  options: { name?: string } = {},
): { state: TabSetState; tab: TerminalTab } {
  require(typeof sessionId === 'string' && sessionId.length > 0, 'a tab stands for a session');
  require(state.tabs.length < MAX_TABS, `a terminal window holds at most ${MAX_TABS} tabs`);
  require(!state.tabs.some(tab => tab.sessionId === sessionId), 'a session appears in exactly one tab');

  const number = state.nextNumber;
  const asked = options.name?.trim();
  const named = asked !== undefined && asked.length > 0;
  require(!named || asked!.length <= MAX_NAME_CHARS, `a tab name is at most ${MAX_NAME_CHARS} characters`);

  const tab: TerminalTab = {
    id: `tab-${number}`,
    sessionId,
    name: named ? asked! : defaultTabName(number),
    renamed: named,
  };
  return {
    state: { tabs: [...state.tabs, tab], activeId: tab.id, nextNumber: number + 1 },
    tab,
  };
}

/** Show a tab that is already open. */
export function selectTab(state: TabSetState, tabId: string): TabSetState {
  require(!!findTab(state, tabId), 'only an open tab can be shown');
  return { ...state, activeId: tabId };
}

/**
 * Name a tab.
 *
 * The name lives in the tab for as long as the tab does: nothing recomputes a
 * default afterwards, and `renamed` records that a person chose it.
 */
export function renameTab(state: TabSetState, tabId: string, rawName: string): TabSetState {
  require(!!findTab(state, tabId), 'only an open tab can be renamed');
  const name = (rawName ?? '').trim();
  require(name.length > 0, 'a tab keeps a name: an empty name is refused');
  require(name.length <= MAX_NAME_CHARS, `a tab name is at most ${MAX_NAME_CHARS} characters`);
  return {
    ...state,
    tabs: state.tabs.map(tab => (tab.id === tabId ? { ...tab, name, renamed: true } : tab)),
  };
}

/**
 * Close a tab.
 *
 * The neighbour takes over when the closed tab was the one showing: the next
 * tab first, then the previous one, then nothing (which is what ends the window).
 */
export function removeTab(state: TabSetState, tabId: string): { state: TabSetState; wasActive: boolean } {
  const index = state.tabs.findIndex(tab => tab.id === tabId);
  require(index >= 0, 'only an open tab can be closed');
  const tabs = state.tabs.filter(tab => tab.id !== tabId);

  if (state.activeId !== tabId) {
    ensure(tabs.some(tab => tab.id === state.activeId), 'closing a background tab leaves the shown one showing');
    return { state: { ...state, tabs }, wasActive: false };
  }

  const neighbour = tabs[index] ?? tabs[index - 1];
  const next: TabSetState = { ...state, tabs, activeId: neighbour ? neighbour.id : null };
  ensure(next.tabs.length === 0 ? next.activeId === null : !!findTab(next, next.activeId),
    'a non-empty strip always shows one of its tabs');
  return { state: next, wasActive: true };
}

/**
 * The label for a tab, cut to the room the strip can give it.
 *
 * Composed widgets do not ellipsize on their own, so a long name is cut here
 * with an ellipsis rather than drawn past the edge of its button.
 */
export function tabLabel(name: string, budget: number): string {
  const room = Math.max(1, Math.floor(budget));
  if (name.length <= room) return name;
  if (room <= 1) return '…';
  return `${name.slice(0, room - 1)}…`;
}

/**
 * How many characters each label may have, given the strip's width and the
 * number of tabs sharing it. Tabs shrink as more open, down to a floor.
 */
export function labelBudget(stripWidth: number, tabCount: number): number {
  require(tabCount >= 0, 'a strip holds a whole number of tabs');
  if (tabCount === 0) return MAX_LABEL_CHARS;
  const usable = Math.max(0, stripWidth - STRIP_RESERVED_PX);
  const perTab = Math.floor(usable / tabCount) - TAB_CHROME_PX;
  return Math.max(MIN_LABEL_CHARS, Math.min(MAX_LABEL_CHARS, perTab));
}

/** The set's own rules, checked after every change. */
export function tabSetInvariants(state: TabSetState): void {
  invariant(state.tabs.length <= MAX_TABS, 'the strip holds no more tabs than the cap');
  invariant(new Set(state.tabs.map(tab => tab.id)).size === state.tabs.length, 'tab ids are unique');
  invariant(new Set(state.tabs.map(tab => tab.sessionId)).size === state.tabs.length, 'each session appears once');
  invariant(state.tabs.every(tab => tab.name.trim().length > 0 && tab.name.length <= MAX_NAME_CHARS),
    'every tab has a name short enough for the strip');
  invariant(state.activeId === null || !!findTab(state, state.activeId), 'the shown tab is open');
}
