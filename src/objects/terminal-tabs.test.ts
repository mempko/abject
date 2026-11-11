/**
 * Several shells in one window, proven against the real objects.
 *
 * The tab model is exercised on its own, and the window is driven with real
 * `TerminalSession`s behind it: real ptys and the real libghostty screen. The
 * stand-ins are only the display (a WidgetManager that hands out widget ids) and
 * the consent step (a Terminal that starts a session without asking), so what a
 * person clicks in the strip is what an assertion checks here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Abject, type MessageHandlerFn } from '../core/abject.js';
import { MessageBus } from '../runtime/message-bus.js';
import { request } from '../core/message.js';
import type { AbjectId, InterfaceId } from '../core/types.js';
import { TerminalSession } from './capabilities/terminal-session.js';
import { TerminalView } from './terminal-view.js';
import {
  addTab,
  emptyTabSet,
  labelBudget,
  removeTab,
  renameTab,
  selectTab,
  tabLabel,
  tabSetInvariants,
  MAX_TABS,
} from './terminal-tabs.js';

// ── The tab model on its own ─────────────────────────────────────────────

test('the tab set: add, name, switch, close, and the neighbour rule', () => {
  let state = emptyTabSet();

  const first = addTab(state, 's1');
  state = first.state;
  assert.equal(first.tab.name, 'Terminal 1', 'a new tab is named sensibly');
  assert.equal(first.tab.renamed, false);
  assert.equal(state.activeId, first.tab.id, 'a new tab becomes the one showing');

  const second = addTab(state, 's2');
  state = second.state;
  assert.equal(second.tab.name, 'Terminal 2');
  assert.deepEqual(state.tabs.map(t => t.sessionId), ['s1', 's2'], 'tabs keep the order they were opened in');

  // Renaming lasts: nothing recomputes the default afterwards.
  state = renameTab(state, first.tab.id, '  build  ');
  assert.equal(state.tabs[0].name, 'build', 'the name is trimmed and kept');
  assert.equal(state.tabs[0].renamed, true);
  const third = addTab(state, 's3');
  state = third.state;
  state = renameTab(state, first.tab.id, 'build again');
  assert.equal(state.tabs[0].name, 'build again', 'a later change does not reset a renamed tab');

  // Switching does not disturb any name.
  state = selectTab(state, second.tab.id);
  assert.equal(state.activeId, second.tab.id);
  assert.equal(state.tabs[0].name, 'build again');

  // Closing a background tab leaves the shown one alone.
  const background = removeTab(state, third.tab.id);
  state = background.state;
  assert.equal(background.wasActive, false);
  assert.equal(state.activeId, second.tab.id, 'closing a background tab keeps the shown one');

  // Closing the shown tab hands over to its neighbour.
  const shown = removeTab(state, second.tab.id);
  state = shown.state;
  assert.equal(shown.wasActive, true);
  assert.equal(state.activeId, first.tab.id, 'the neighbour takes over the canvas');

  // The last one leaving empties the set.
  const last = removeTab(state, first.tab.id);
  assert.equal(last.state.tabs.length, 0);
  assert.equal(last.state.activeId, null, 'nothing is showing when nothing is open');
  tabSetInvariants(last.state);
});

test('the tab set refuses what a strip cannot show', () => {
  let state = emptyTabSet();
  for (let i = 0; i < MAX_TABS; i += 1) state = addTab(state, `s${i}`).state;
  assert.throws(() => addTab(state, 'one-too-many'), /at most/);
  assert.throws(() => renameTab(state, state.tabs[0].id, '   '), /keeps a name/);
  assert.throws(() => renameTab(state, 'no-such-tab', 'x'), /open tab/);
  // A session appears in one tab only, checked on a set with room to spare.
  const two = addTab(addTab(emptyTabSet(), 'a').state, 'b').state;
  assert.throws(() => addTab(two, 'a'), /exactly one tab/);

  // Long names are cut for the strip rather than drawn past the edge.
  assert.equal(tabLabel('a-very-long-tab-name', 6), 'a-ver…');
  assert.equal(tabLabel('short', 20), 'short');
  // More tabs share the same strip, so each gets less room, down to a floor.
  // The width is chosen where the crowding shows: at 900px both counts sit on
  // the ceiling, which says nothing about shrinking.
  const roomy = labelBudget(500, 3);
  const crowded = labelBudget(500, 12);
  assert.ok(roomy > crowded, 'the strip gives each tab less room as more open');
  assert.ok(crowded >= 4, 'a label never collapses to nothing');
  assert.equal(labelBudget(900, 2), labelBudget(900, 2), 'the budget is a pure function of width and count');
});

// ── The window, over real sessions ───────────────────────────────────────

class Endpoint extends Abject {
  fields: Record<string, unknown> = {};
  draws: Array<Record<string, unknown>> = [];
  destroyed = false;
  value = '';

  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'Display fixture',
      interface: { id: `fixture:${name}` as InterfaceId, name, description: 'fixture', methods: [] } } });
  }

  public override on(method: string, fn: MessageHandlerFn): void { super.on(method, fn); }
  call(to: AbjectId, method: string, payload: unknown = {}): Promise<any> { return this.request(request(this.id, to, method, payload), 3000); }

  /** Act as the widget would when a person uses it. */
  fire(aspect: string, value?: unknown): void { this.changed(aspect, value); }
}

class Display extends Abject {
  windows: AbjectId[] = [];
  widgets: Endpoint[] = [];
  destroyed: AbjectId[] = [];
  endpoints: Endpoint[] = [];

  constructor() {
    super({ manifest: { name: 'WidgetManager', version: '1', description: 'Display fixture',
      interface: { id: 'fixture:wm' as InterfaceId, name: 'WidgetManager', description: 'fixture', methods: [] } } });
  }

  public override on(method: string, fn: MessageHandlerFn): void { super.on(method, fn); }
  call(to: AbjectId, method: string, payload: unknown = {}): Promise<any> { return this.request(request(this.id, to, method, payload), 3000); }

  private async endpoint(name: string): Promise<Endpoint> {
    // On the same bus as everything else, so the id these widgets hand back is
    // one the window can actually reach.
    const e = new Endpoint(name);
    await e.init(this.bus, this.id);
    e.on('update', (msg: any) => { e.fields = { ...e.fields, ...(msg.payload ?? {}) }; if (typeof msg.payload?.value === 'string') e.value = msg.payload.value; return true; });
    e.on('addDependent', () => true);
    e.on('destroy', () => { e.destroyed = true; return true; });
    e.on('getValue', () => e.value);
    e.on('draw', (msg: any) => { e.draws.push(msg.payload ?? {}); return true; });
    e.on('getCanvasSize', () => ({ width: 800, height: 480 }));
    e.on('setTitle', (msg: any) => { e.fields.title = msg.payload?.title; return true; });
    for (const m of ['addLayoutChild', 'addLayoutChildren', 'addLayoutSpacer', 'updateLayoutChild', 'clearLayoutChildren']) {
      e.on(m, (msg: any) => { e.fields[m] = msg.payload; return true; });
    }
    this.endpoints.push(e);
    return e;
  }

  async wire(bus: MessageBus): Promise<this> {
    await this.init(bus, undefined);
    this.on('getDisplayInfo', () => ({ width: 1400, height: 900 }));
    this.on('createWindowAbject', async (msg: any) => {
      const w = await this.endpoint('Window');
      this.windows.push(w.id);
      (w as any).title = msg.payload?.title;
      return w.id;
    });
    for (const m of ['createVBox', 'createHBox', 'createNestedHBox', 'createNestedVBox', 'createCanvas']) {
      this.on(m, async () => (await this.endpoint(m)).id);
    }
    this.on('create', async (msg: any) => {
      const specs = (msg.payload?.specs ?? []) as Array<{ type: string; text?: string }>;
      const out: AbjectId[] = [];
      for (const spec of specs) {
        const e = await this.endpoint(spec.type);
        e.fields.text = spec.text;
        this.widgets.push(e);
        out.push(e.id);
      }
      return { widgetIds: out };
    });
    this.on('destroyWindowAbject', (msg: any) => { this.destroyed.push(msg.payload?.windowId); return true; });
    return this;
  }

  /** The strip button that is showing a given name right now. */
  buttonShowing(text: string): Endpoint | undefined {
    return this.widgets.find(w => w.fields.text === text);
  }
}

/** Stands in for the Terminal capability: starts a session without asking, and supervises it. */
class Consent extends Abject {
  records = new Map<AbjectId, TerminalSession>();
  closed: AbjectId[] = [];

  constructor() {
    super({ manifest: { name: 'Terminal', version: '1', description: 'Consent fixture',
      interface: { id: 'fixture:terminal' as InterfaceId, name: 'Terminal', description: 'fixture', methods: [] } } });
  }

  public override on(method: string, fn: MessageHandlerFn): void { super.on(method, fn); }

  async wire(bus: MessageBus): Promise<this> {
    await this.init(bus, undefined);
    this.on('open', async (msg: any) => {
      const { cwd, cols, rows } = msg.payload ?? {};
      const session = new TerminalSession({
        command: '/bin/sh', args: ['-i'], cwd: cwd ?? process.cwd(),
        cols: cols ?? 80, rows: rows ?? 24,
        owner: msg.routing.from, supervisor: this.id,
      });
      await session.init(this.bus, this.id);
      this.records.set(session.id, session);
      return { success: true, sessionId: session.id };
    });
    this.on('close', async (msg: any) => {
      const id = msg.payload?.sessionId as AbjectId;
      const session = this.records.get(id);
      if (session) { await session.close(); this.records.delete(id); this.closed.push(id); }
      return { success: true };
    });
    return this;
  }

  /** As the supervisor, drive a session the way a program would be used. */
  async writeTo(sessionId: AbjectId, text: string): Promise<void> {
    await this.request(request(this.id, sessionId, 'write', { text }));
  }

  async screenText(sessionId: AbjectId): Promise<string> {
    const screen = await this.request<{ screen: Array<{ cells: Array<{ text: string }> }> }>(
      request(this.id, sessionId, 'screen', {}),
    );
    return screen.screen.map(row => row.cells.map(cell => cell.text).join('')).join('\n');
  }
}

/** The window, with its two collaborators replaced by the fixtures above. */
class Harness extends TerminalView {
  constructor(private display: Display, private consent: Consent) { super(); }
  protected override async discoverDep(name: string): Promise<AbjectId | null> {
    if (name === 'WidgetManager') return this.display.id;
    if (name === 'Terminal') return this.consent.id;
    return null;
  }
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

test('one window holds several shells at once: tabs switch, close and rename', async () => {
  const bus = new MessageBus();
  const display = await new Display().wire(bus);
  const consent = await new Consent().wire(bus);
  const view = new Harness(display, consent);
  await view.init(bus, undefined);

  try {
    assert.equal(await view.show(), true, 'the window opens with its first shell');
    let state = await view.getState() as any;
    assert.equal(state.tabCount, 1);
    assert.equal(state.tabs[0].name, 'Terminal 1', 'the first tab has a default name');
    const firstSession = state.sessionId as AbjectId;

    // Tab one really runs a shell.
    await consent.writeTo(firstSession, "printf 'FIRST-%s\\n' 1\n");
    await until(async () => (await consent.screenText(firstSession)).includes('FIRST-1') ? true : undefined,
      'the first shell to answer');

    // A second tab, opened from the window itself.
    const opened = await view.newTab(undefined, 'second') as any;
    assert.equal(opened.success, true, 'a second shell opens in the same window');
    state = await view.getState() as any;
    assert.equal(state.tabCount, 2, 'both tabs are open at once');
    assert.equal(state.activeTabId, opened.tabId, 'the new tab is the one showing');
    const secondSession = state.sessionId as AbjectId;
    assert.notEqual(secondSession, firstSession, 'the second tab is a different shell');
    assert.equal(consent.records.size, 2, 'two ptys are alive at the same time');

    // Both shells are live and independent.
    await consent.writeTo(secondSession, "printf 'SECOND-%s\\n' 2\n");
    await until(async () => (await consent.screenText(secondSession)).includes('SECOND-2') ? true : undefined,
      'the second shell to answer');
    const firstScreen = await consent.screenText(firstSession);
    assert.ok(firstScreen.includes('FIRST-1'), 'the first shell kept running behind the second');
    assert.ok(!firstScreen.includes('SECOND-2'), 'the shells do not share a screen');

    // Renaming: the name is what the strip shows, and it lasts.
    const renamed = await view.renameTab('build', opened.tabId) as any;
    assert.equal(renamed.success, true);
    state = await view.getState() as any;
    const named = state.tabs.find((t: any) => t.tabId === opened.tabId);
    assert.equal(named.name, 'build', 'the tab carries the name the person gave it');
    assert.equal(named.renamed, true);
    assert.ok(display.buttonShowing('build'), 'the strip button shows that name');

    // Switching shows the other shell's screen, still live.
    const firstTabId = (state.tabs as any[]).find(t => t.sessionId === firstSession).tabId;
    await view.selectTab(firstTabId);
    state = await view.getState() as any;
    assert.equal(state.activeTabId, firstTabId, 'the strip switches the canvas');
    assert.equal(state.sessionId, firstSession);

    // The name survives being hidden behind another tab.
    await view.selectTab(opened.tabId);
    state = await view.getState() as any;
    assert.equal(state.tabs.find((t: any) => t.tabId === opened.tabId).name, 'build',
      'a renamed tab keeps its name across a switch');

    // Closing one tab leaves the other running.
    const closed = await view.closeTab(firstTabId) as any;
    assert.equal(closed.success, true);
    assert.equal(closed.closedWindow, undefined, 'the window stays open with a tab left');
    state = await view.getState() as any;
    assert.equal(state.tabCount, 1, 'only the closed tab is gone');
    assert.equal(state.activeTabId, opened.tabId, 'the remaining tab takes the canvas');
    assert.equal(consent.records.size, 1, 'only that tab\u2019s shell ended');
    assert.ok(consent.closed.includes(firstSession), 'the closed tab\u2019s shell was ended');

    // The surviving shell is still usable.
    await consent.writeTo(secondSession, "printf 'STILL-%s\\n' 3\n");
    await until(async () => (await consent.screenText(secondSession)).includes('STILL-3') ? true : undefined,
      'the surviving shell to answer');

    // Closing the last tab ends the window.
    const last = await view.closeTab(opened.tabId) as any;
    assert.equal(last.closedWindow, true, 'the last tab closing closes the window');
    assert.deepEqual(display.destroyed, display.windows, 'the window was destroyed on screen');
    state = await view.getState() as any;
    assert.equal(state.visible, false);
    assert.equal(state.tabCount, 0);
    assert.equal(consent.records.size, 0, 'no shell outlives the window');
  } finally {
    await view.hide();
  }
});
