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
    for (const method of ['refreshScreenshot', 'updateUrlLabel', 'updateStatusLabel', 'updateToolbarVisibility']) {
      v[method] = async () => {};
    }

    await v.confirmClosePage(0);

    assert.equal(tracked.closed, true, 'the page closed once the dialog was confirmed');
    assert.deepEqual(v.pages, [], 'and the tab it belonged to is gone');
  } finally { await h.stop(); }
});
