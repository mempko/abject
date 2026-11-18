/**
 * Closing a page from the viewer's tab bar.
 *
 * The viewer's tabs come from WebBrowser.listPages, which lists every open
 * page: an agent's automation page appears as a tab too. WebBrowser.closePage
 * deliberately keeps its ownership check (an agent closes its own page), so a
 * tab close sent through it was refused — "Page X is owned by ..., not ..." —
 * and the viewer's `catch { ... already gone }` swallowed the refusal, leaving
 * the tab (and the page) in place however many times the person confirmed.
 *
 * These tests pin both halves: the guard that caused it, and the viewer-only
 * method the tab close now uses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MessageBus } from '../runtime/message-bus.js';
import { Registry } from './registry.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { WebBrowser } from './capabilities/web-browser.js';
import { WebBrowserViewer } from './web-browser-viewer.js';
import type { AbjectId, AbjectManifest, InterfaceId } from '../core/types.js';
import type { MessageHandlerFn } from '../core/abject.js';

function manifestFor(name: string): AbjectManifest {
  return {
    name,
    description: `${name} test double`,
    version: '1.0.0',
    interface: { id: `test:${name}` as InterfaceId, name, description: `${name} test double`, methods: [] },
    tags: ['test'],
  };
}

/** An abject that can send requests, and whose name counts for built-in checks. */
class Caller extends Abject {
  constructor(name: string) {
    super({ manifest: manifestFor(name) });
  }
  call(to: AbjectId, method: string, payload: unknown = {}): Promise<any> {
    return this.request(request(this.id, to, method, payload), 5000);
  }
}

/** Stands in for WidgetManager answering the close confirmation. */
class Confirmer extends Abject {
  constructor(private readonly answer: boolean) {
    super({ manifest: manifestFor('Confirmer') });
    this.on('showConfirmDialog', () => this.answer);
  }
}

interface FakePage {
  closed: boolean;
  url: () => string;
  title: () => Promise<string>;
  close: () => Promise<void>;
}

/** Track a page the way openPage does, owned by somebody other than the viewer. */
function trackPage(browser: WebBrowser, pageId: string, owner: AbjectId): FakePage {
  const page: FakePage = {
    closed: false,
    url: () => 'https://thetix.ai/',
    title: async () => 'Thetix',
    close: async () => { page.closed = true; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (browser as any).pages.set(pageId, { page, owner, createdAt: Date.now(), lastActivity: Date.now() });
  return page;
}

interface Harness {
  bus: MessageBus;
  browser: WebBrowser;
  viewer: Caller;
  stranger: Caller;
  owner: Caller;
  spawn<T extends Abject>(object: T, name?: string): Promise<T>;
  stop(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const bus = new MessageBus();
  const registry = new Registry();
  await registry.init(bus);
  const objects: Abject[] = [registry];

  const spawn = async <T extends Abject>(object: T, name?: string): Promise<T> => {
    // Skip onInit: these doubles need no dependencies beyond the Registry the
    // browser resolves its callers through.
    (object as unknown as { onInit: () => Promise<void> }).onInit = async () => {};
    object.setRegistryHint(registry.id);
    await object.init(bus);
    // A registration with no source and no owner is what makes a name
    // built-in, the same proof viewerInput's check relies on.
    registry.registerObject(object.id, object.manifest, undefined, undefined, undefined, name);
    objects.push(object);
    return object;
  };

  const browser = await spawn(new WebBrowser());
  const viewer = await spawn(new Caller('WebBrowserViewer'));
  const stranger = await spawn(new Caller('Stranger'));
  const owner = await spawn(new Caller('Automation'));

  return {
    bus,
    browser,
    viewer,
    stranger,
    owner,
    spawn,
    async stop() { for (const object of objects.reverse()) await object.stop(); },
  };
}

// ── The guard that caused the reported bug ──

test('viewer: closePage refuses a page the caller does not own — the reported bug', async () => {
  const h = await harness();
  try {
    const page = trackPage(h.browser, 'page-1', h.owner.id);
    // The tabs the viewer shows are other objects' pages, so this is exactly
    // the call the tab close used to make.
    await assert.rejects(
      h.viewer.call(h.browser.id, 'closePage', { pageId: 'page-1' }),
      /is owned by/,
    );
    assert.equal(page.closed, false, 'the page survived the refused close');
  } finally { await h.stop(); }
});

// ── The fix ──

test('viewer: viewerClosePage closes a page the viewer does not own', async () => {
  const h = await harness();
  try {
    const page = trackPage(h.browser, 'page-2', h.owner.id);
    const result = await h.viewer.call(h.browser.id, 'viewerClosePage', { pageId: 'page-2' });
    assert.deepEqual(result, { success: true });
    assert.equal(page.closed, true, 'the underlying browser page was really closed');
    const pages = await h.viewer.call(h.browser.id, 'listPages', {});
    assert.deepEqual(pages, [], 'the page is gone from the list the tab bar is built from');
  } finally { await h.stop(); }
});

test('viewer: viewerClosePage is refused for anything but the built-in viewer', async () => {
  const h = await harness();
  try {
    const page = trackPage(h.browser, 'page-3', h.owner.id);
    await assert.rejects(
      h.stranger.call(h.browser.id, 'viewerClosePage', { pageId: 'page-3' }),
      /only from WebBrowserViewer/,
    );
    assert.equal(page.closed, false, 'a stranger cannot close somebody else\'s page');
  } finally { await h.stop(); }
});

// ── Pages are shared: any object may act on any open page ──

/** A page that can be navigated, recording where it was sent. */
function trackNavigablePage(browser: WebBrowser, pageId: string, owner: AbjectId) {
  let currentUrl = 'about:blank';
  const gotoCalls: string[] = [];
  const page = {
    closed: false,
    gotoCalls,
    url: () => currentUrl,
    title: async () => 'Example',
    close: async () => { page.closed = true; },
    goto: async (url: string) => { gotoCalls.push(url); currentUrl = url; },
    waitForSelector: async () => {},
    setContent: async () => { currentUrl = 'about:blank'; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (browser as any).pages.set(pageId, { page, owner, createdAt: Date.now(), lastActivity: Date.now() });
  return page;
}

test('viewer: navigateTo works on a page another object opened', async () => {
  const h = await harness();
  try {
    const page = trackNavigablePage(h.browser, 'page-5', h.owner.id);
    // The person's tabs are other objects' pages, so an agent asked to act on
    // what they are browsing makes exactly this call.
    const result = await h.stranger.call(h.browser.id, 'navigateTo', {
      pageId: 'page-5', url: 'https://example.com/',
    });
    assert.equal(result.url, 'https://example.com/');
    assert.deepEqual(page.gotoCalls, ['https://example.com/'], 'the foreign page really navigated');
  } finally { await h.stop(); }
});

// ── The person's tabs outlive the agent task that was running ──

test('viewer: a page the viewer opened survives another object\'s teardown', async () => {
  const h = await harness();
  try {
    // The viewer opens the person's tabs itself, so the owner is the viewer.
    const personTab = trackPage(h.browser, 'page-6', h.viewer.id);
    const agentPage = trackPage(h.browser, 'page-7', h.owner.id);

    // Exactly what WebBrowser's objectUnregistered handler runs when a task
    // that was browsing goes away.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (h.browser as any).closePagesForOwner(h.owner.id);

    const pages = await h.stranger.call(h.browser.id, 'listPages', {});
    assert.deepEqual(pages.map((p: { pageId: string }) => p.pageId), ['page-6'],
      'the person\'s tab is still listed after the agent left');
    assert.equal(personTab.closed, false, 'and it is still open');
    assert.equal(agentPage.closed, true, 'the departing agent\'s own page was cleaned up');
  } finally { await h.stop(); }
});

// ── The address field ──

test('viewer: an address without a scheme gets https, a loopback host gets http', async () => {
  const h = await harness();
  try {
    const viewer = await h.spawn(new WebBrowserViewer(), 'WebBrowserViewer');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = viewer as any;
    assert.equal(v.normalizeAddress('example.com/a?b=1'), 'https://example.com/a?b=1');
    assert.equal(v.normalizeAddress('http://example.com'), 'http://example.com');
    assert.equal(v.normalizeAddress('localhost:3000'), 'http://localhost:3000');
    assert.equal(v.normalizeAddress('   '), undefined, 'nothing typed is not a navigation');
  } finally { await h.stop(); }
});

test('viewer: typing a URL in the address field navigates the selected page', async () => {
  const h = await harness();
  try {
    const page = trackNavigablePage(h.browser, 'page-8', h.owner.id);
    const viewer = await h.spawn(new WebBrowserViewer(), 'WebBrowserViewer');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = viewer as any;
    v.webBrowserId = h.browser.id;
    v.windowId = 'window-test' as AbjectId;
    v.pages = [{ pageId: 'page-8', owner: h.owner.id, url: 'about:blank', title: '' }];
    v.selectedPageIndex = 0;
    for (const method of ['refreshScreenshot', 'updateStatusLabel', 'updateToolbarVisibility', 'updateAddressField', 'syncTabSelection']) {
      v[method] = async () => {};
    }

    await v.navigateToAddress('example.com');

    assert.deepEqual(page.gotoCalls, ['https://example.com'],
      'a bare host was given a scheme and the page was sent there');
  } finally { await h.stop(); }
});

test('viewer: selecting the trailing + tab opens a page instead of selecting one', async () => {
  const h = await harness();
  try {
    const viewer = await h.spawn(new WebBrowserViewer(), 'WebBrowserViewer');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = viewer as any;
    v.pages = [{ pageId: 'page-9', owner: h.owner.id, url: 'https://thetix.ai/', title: 'Thetix' }];
    v.selectedPageIndex = 0;
    v.tabBarId = 'tab-bar' as AbjectId;
    let opened = 0;
    v.openNewTab = async () => { opened++; };

    // The '+' tab reports a press on its own aspect.
    await v.handleChanged(v.tabBarId, 'newTab');

    assert.equal(opened, 1, 'the + tab opened a new page');
    assert.equal(v.selectedPageIndex, 0, 'the selection did not move to a page that does not exist');
  } finally { await h.stop(); }
});

// ── The whole path the person takes: tab × → confirm → page closed ──

test('viewer: confirming the close dialog closes the page and its tab disappears', async () => {
  const h = await harness();
  try {
    const confirmer = await h.spawn(new Confirmer(true));
    const tracked = trackPage(h.browser, 'page-4', h.owner.id);

    // A real viewer instance: confirmClosePage lives here, not on the Caller
    // doubles above. Its window-facing steps are stubbed; the page-list refresh
    // is not, because the tab disappearing is what is under test.
    const viewer = await h.spawn(new WebBrowserViewer(), 'WebBrowserViewer');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = viewer as any;
    v.webBrowserId = h.browser.id;
    v.widgetManagerId = confirmer.id;
    v.windowId = 'window-test' as AbjectId;
    v.pages = [{ pageId: 'page-4', owner: h.owner.id, url: 'https://thetix.ai/', title: 'Thetix' }];
    v.selectedPageIndex = 0;
    for (const method of ['refreshScreenshot', 'updateAddressField', 'updateStatusLabel', 'updateToolbarVisibility']) {
      v[method] = async () => {};
    }

    await v.confirmClosePage(0);

    assert.equal(tracked.closed, true, 'the page closed once the dialog was confirmed');
    assert.deepEqual(v.pages, [], 'and the tab it belonged to is gone');
  } finally { await h.stop(); }
});

// ── Starting to browse from the empty viewer ──

/** One open page as WebBrowser.listPages reports it. */
interface ListedPage {
  pageId: string;
  owner: string;
  url: string;
  title: string;
}

/**
 * A WebBrowser stand-in: it answers the viewer's page questions without
 * Playwright, and records what the viewer asked for, so a test can tell a click
 * that reached the browser from one that was swallowed on the way.
 */
class StubBrowser extends Abject {
  listed: ListedPage[] = [];
  readonly opened: unknown[] = [];
  readonly navigated: Array<{ pageId: string; url: string }> = [];
  /** The owner a page gets when this browser opens one. The viewer's own id is
   *  what makes a tab the person's own tab. */
  openPageOwner = '';

  constructor() {
    super({ manifest: manifestFor('WebBrowser') });
    this.on('listPages', () => this.listed.map((p) => ({ ...p, createdAt: 0, lastActivity: 0 })));
    this.on('openPage', (msg) => {
      const pageId = `page-${this.listed.length + 1}`;
      this.opened.push(msg.payload);
      this.listed.push({ pageId, owner: this.openPageOwner, url: 'about:blank', title: '' });
      return { pageId };
    });
    this.on('viewerNavigateTo', (msg) => {
      const { pageId, url } = msg.payload as { pageId: string; url: string };
      this.navigated.push({ pageId, url });
      const page = this.listed.find((p) => p.pageId === pageId);
      if (page) { page.url = url; page.title = 'Landed'; }
      return { url, title: 'Landed' };
    });
    this.on('addDependent', () => true);
  }

  public override on(method: string, fn: MessageHandlerFn): void { super.on(method, fn); }
}

/** Stands in for a widget, recording what the viewer told it. */
class WidgetRecorder extends Abject {
  readonly updates: Array<Record<string, unknown>> = [];

  constructor() {
    super({ manifest: manifestFor('Button') });
    this.on('update', (msg) => {
      this.updates.push(msg.payload as Record<string, unknown>);
      return true;
    });
    this.on('addDependent', () => true);
  }

  public override on(method: string, fn: MessageHandlerFn): void { super.on(method, fn); }

  /** The last `visible` the viewer asked for. */
  get lastVisible(): unknown {
    return this.updates.at(-1)?.visible;
  }
}

/** A real viewer wired to a stand-in browser, its window-facing work stubbed
 *  (these tests have no WidgetManager). */
async function viewerOn(h: Harness, browser: StubBrowser) {
  const viewer = await h.spawn(new WebBrowserViewer(), 'WebBrowserViewer');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v = viewer as any;
  v.webBrowserId = browser.id;
  v.windowId = 'window-test' as AbjectId;
  for (const method of [
    'refreshScreenshot', 'updateAddressField', 'updateStatusLabel', 'updateNavButtons',
    'syncTabSelection', 'focusAddressField', 'blurAddressField', 'focusCanvas', 'playEffect',
  ]) {
    v[method] = async () => {};
  }
  return v;
}

test('viewer: with no pages open, the + tab opens the first page', async () => {
  const h = await harness();
  try {
    const stub = await h.spawn(new StubBrowser());
    const v = await viewerOn(h, stub);
    v.pages = [];
    v.selectedPageIndex = 0;
    v.tabBarId = 'tab-bar' as AbjectId;
    stub.openPageOwner = v.id; // the viewer opens the person's tabs itself

    await v.openNewTab();

    assert.equal(stub.opened.length, 1, 'the + asked the browser for a page');
    assert.equal(v.pages.length, 1, 'the new page shows up as a tab');
    assert.equal(v.selectedPageIndex, 0, 'and it is the selected tab');
    assert.equal(v.pages[0].owner, v.id, 'the tab belongs to the viewer, so no agent task can take it down');
  } finally { await h.stop(); }
});

test('viewer: a + press during the build opens no page — the phantom about:blank tab', async () => {
  const h = await harness();
  try {
    const stub = await h.spawn(new StubBrowser());
    const v = await viewerOn(h, stub);
    v.pages = [];
    v.selectedPageIndex = 0;
    v.tabBarId = 'tab-bar' as AbjectId;
    stub.openPageOwner = v.id;

    // The window is still being mapped: a press that lands on the freshly
    // created strip (or a synthetic one from the desktop) is not the person
    // asking for a page.
    v.buildingWindow = true;
    await v.handleChanged(v.tabBarId, 'newTab');
    assert.equal(stub.opened.length, 0, 'no page was opened while the window was being built');
    assert.deepEqual(v.pages, [], 'so the empty viewer stays empty');

    // Once it is up, the same press is the person's and works.
    v.buildingWindow = false;
    await v.handleChanged(v.tabBarId, 'newTab');
    assert.equal(stub.opened.length, 1, 'a press on the finished strip still opens a page');
  } finally { await h.stop(); }
});

test('viewer: with no pages open, the + selection opens the first page', async () => {
  const h = await harness();
  try {
    const stub = await h.spawn(new StubBrowser());
    const v = await viewerOn(h, stub);
    v.pages = [];
    v.selectedPageIndex = 0;
    v.tabBarId = 'tab-bar' as AbjectId;
    stub.openPageOwner = v.id;

    // Index 0 is the '+' tab when nothing is open yet.
    await v.handleChanged(v.tabBarId, 'newTab');

    assert.equal(stub.opened.length, 1, 'the swallowed click now reaches the browser');
    assert.equal(v.pages.length, 1);
  } finally { await h.stop(); }
});

test('viewer: with no pages open, typing an address opens a page first', async () => {
  const h = await harness();
  try {
    const stub = await h.spawn(new StubBrowser());
    const v = await viewerOn(h, stub);
    v.pages = [];
    v.selectedPageIndex = 0;
    stub.openPageOwner = v.id;

    await v.navigateToAddress('example.com');

    assert.equal(stub.opened.length, 1, 'a page was opened for the typed address');
    assert.deepEqual(stub.navigated, [{ pageId: 'page-1', url: 'https://example.com' }],
      'and that page was sent to the address');
    assert.equal(v.pages.length, 1);
    assert.equal(v.pages[0].url, 'https://example.com', 'the address bar shows where it landed');
  } finally { await h.stop(); }
});

// ── Who drives a tab by default ──

test('viewer: a tab the person opened is already the person\'s to drive', async () => {
  const h = await harness();
  try {
    const stub = await h.spawn(new StubBrowser());
    const button = await h.spawn(new WidgetRecorder());
    const v = await viewerOn(h, stub);
    v.controlBtnId = button.id;
    stub.listed = [
      { pageId: 'page-person', owner: v.id, url: 'https://thetix.ai/', title: 'Thetix' },
      { pageId: 'page-agent', owner: 'agent-1', url: 'https://example.com/', title: 'Example' },
    ];
    v.selectedPageIndex = 0;

    await v.refreshPageList();

    assert.equal(v.controlMode, true, 'control is on without pressing anything');
    assert.equal(button.lastVisible, false, 'and there is no Take Control button to press');
  } finally { await h.stop(); }
});

test('viewer: a tab an agent opened still starts uncontrolled', async () => {
  const h = await harness();
  try {
    const stub = await h.spawn(new StubBrowser());
    const button = await h.spawn(new WidgetRecorder());
    const v = await viewerOn(h, stub);
    v.controlBtnId = button.id;
    stub.listed = [
      { pageId: 'page-person', owner: v.id, url: 'https://thetix.ai/', title: 'Thetix' },
      { pageId: 'page-agent', owner: 'agent-1', url: 'https://example.com/', title: 'Example' },
    ];
    v.selectedPageIndex = 1;

    await v.refreshPageList();

    assert.equal(v.controlMode, false, 'the agent keeps driving its own page');
    assert.equal(button.lastVisible, true, 'and the person is offered Take Control');

    // The handoff still works, and taking over is remembered for that tab.
    await v.takeControl();
    assert.equal(v.controlMode, true);
    v.selectedPageIndex = 0;
    await v.refreshPageList();
    v.selectedPageIndex = 1;
    await v.refreshPageList();
    assert.equal(v.controlMode, true, 'the agent page stayed under the person\'s control');

    // Handing it back leaves the agent page uncontrolled again.
    await v.releaseControl();
    await v.refreshPageList();
    assert.equal(v.controlMode, false, 'releasing control is remembered too');
  } finally { await h.stop(); }
});

// ── Opening the viewer with nothing open ──

test('viewer: refreshing the page list with no pages opens no page and shows the empty state', async () => {
  const h = await harness();
  try {
    const stub = await h.spawn(new StubBrowser());
    const tabs = await h.spawn(new WidgetRecorder());
    const status = await h.spawn(new WidgetRecorder());
    const button = await h.spawn(new WidgetRecorder());
    const v = await viewerOn(h, stub);
    // The paint steps stay stubbed; the surfaces whose CONTENT is the empty
    // state are recording widgets here, so the wording can be read back.
    delete v.updateStatusLabel;
    v.tabBarId = tabs.id;
    v.statusLabelId = status.id;
    v.controlBtnId = button.id;
    v.pages = [];
    v.selectedPageIndex = 0;
    stub.listed = [];

    // Populate from the browser, as after the last tab is closed. (show() itself
    // then opens a blank tab when this finds nothing; the list refresh never does.)
    await v.refreshPageList();

    assert.equal(stub.opened.length, 0, 'refreshing the list asked the browser for no page');
    assert.deepEqual(v.pages, [], 'so there is no about:blank placeholder tab');
    assert.deepEqual(tabs.updates.at(-1)?.tabs, ['+'], 'the strip is the trailing + and nothing else');
    assert.equal(tabs.updates.at(-1)?.selectedIndex, 0, 'and the + is the selected tab');
    assert.equal(status.updates.at(-1)?.text, 'No browser pages open', 'the status line says so');
    assert.equal(button.lastVisible, false, 'with nothing open there is nothing to take control of');
  } finally { await h.stop(); }
});

test('viewer: a selection report with no pages open opens nothing', async () => {
  const h = await harness();
  try {
    const stub = await h.spawn(new StubBrowser());
    const v = await viewerOn(h, stub);
    v.pages = [];
    v.selectedPageIndex = 0;
    v.tabBarId = 'tab-bar' as AbjectId;
    stub.listed = [];

    // Index 0 sorts at or past pages.length once more than one page is open, so
    // this used to be indistinguishable from a + press.
    await v.handleChanged(v.tabBarId, 'change', 0);
    await v.handleChanged(v.tabBarId, 'change', '0');
    await v.handleChanged(v.tabBarId, 'change', 7);

    assert.equal(stub.opened.length, 0, 'only a + press opens a page, never a selection');
    assert.deepEqual(v.pages, []);
  } finally { await h.stop(); }
});

// ── An agent page must offer Take Control wherever it appears ──

test('viewer: a page an agent opens becomes the selected tab and offers Take Control', async () => {
  const h = await harness();
  try {
    const stub = await h.spawn(new StubBrowser());
    const button = await h.spawn(new WidgetRecorder());
    const v = await viewerOn(h, stub);
    v.controlBtnId = button.id;
    stub.listed = [
      { pageId: 'page-person', owner: v.id, url: 'https://thetix.ai/', title: 'Thetix' },
    ];
    v.selectedPageIndex = 0;
    await v.refreshPageList();
    assert.equal(button.lastVisible, false, 'the person drives their own tab with no button');

    // The agent opens mempko.com while the person is looking at their own tab.
    stub.listed.push({ pageId: 'page-agent', owner: 'agent-1', url: 'https://mempko.com/', title: 'mempko' });
    await v.handleChanged(stub.id, 'pageOpened', { pageId: 'page-agent' });

    assert.equal(v.selectedPageIndex, 1, 'the agent page is brought to the front');
    assert.equal(v.controlMode, false, 'the agent keeps driving its own page');
    assert.equal(button.lastVisible, true, 'and the person is offered Take Control');
  } finally { await h.stop(); }
});

test('viewer: a page the viewer opens for the person does not take over the front tab', async () => {
  const h = await harness();
  try {
    const stub = await h.spawn(new StubBrowser());
    const button = await h.spawn(new WidgetRecorder());
    const v = await viewerOn(h, stub);
    v.controlBtnId = button.id;
    stub.listed = [
      { pageId: 'page-agent', owner: 'agent-1', url: 'https://mempko.com/', title: 'mempko' },
    ];
    v.selectedPageIndex = 0;
    await v.refreshPageList();

    stub.listed.push({ pageId: 'page-person', owner: v.id, url: 'about:blank', title: '' });
    await v.handleChanged(stub.id, 'pageOpened', { pageId: 'page-person' });

    assert.equal(v.selectedPageIndex, 0, 'a page the viewer opened does not yank the tab the person was watching');
  } finally { await h.stop(); }
});
