import test from 'node:test';
import assert from 'node:assert/strict';
import type { AbjectId, AbjectMessage } from '../core/types.js';
import { ExternalProjectBrowser } from './external-project-browser.js';
import type { ExternalProject } from './external-project-registry.js';
import type { Rule } from './permission-broker.js';
import type { ListItem } from './widgets/list-widget.js';

type ManagedRule = { index: number } & Rule;

type BrowserInternals = {
  projects: ExternalProject[];
  permissionRules: ManagedRule[];
  listWidgetId: AbjectId;
  tabBarId: AbjectId;
  detailsWidgetId: AbjectId;
  grantsWidgetId: AbjectId;
  grantRowId: AbjectId;
  activeTab: number;
  selected?: string;
  handleChanged(fromId: AbjectId, aspect: string, value?: unknown): Promise<void>;
};

class BrowserHarness extends ExternalProjectBrowser {
  readonly updates = new Map<AbjectId, ListItem[]>();
  readonly visibility = new Map<AbjectId, boolean>();

  protected override async request<T>(message: AbjectMessage): Promise<T> {
    if (message.routing.method === 'update') {
      const payload = message.payload as { items?: ListItem[]; style?: { visible?: boolean } };
      if (payload.items) this.updates.set(message.routing.to, payload.items);
      if (typeof payload.style?.visible === 'boolean') {
        this.visibility.set(message.routing.to, payload.style.visible);
      }
    }
    return undefined as T;
  }
}

function project(name: string, root: string, overrides: Partial<ExternalProject> = {}): ExternalProject {
  return {
    name,
    root,
    description: `${name} description`,
    checkCommand: `check-${name}`,
    verifyCommand: `verify-${name}`,
    vcs: 'git',
    trusted: true,
    autonomy: 'ask',
    isolation: 'none',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

type ConfigInternals = {
  projects: ExternalProject[];
  selected?: string;
  registryObjId?: AbjectId;
  configDraft: Map<string, string>;
  configDirty: boolean;
  descInputId: AbjectId;
  checkInputId: AbjectId;
  verifyInputId: AbjectId;
  formatInputId: AbjectId;
  setupInputId: AbjectId;
  sharedInputId: AbjectId;
  protectedInputId: AbjectId;
  isolationSelectId: AbjectId;
  autonomySelectId: AbjectId;
  trustedCheckId: AbjectId;
  saveBtnId: AbjectId;
  revertBtnId: AbjectId;
  handleChanged(fromId: AbjectId, aspect: string, value?: unknown): Promise<void>;
};

/** Captures registry traffic so inline edits can be checked against what is actually sent. */
class ConfigHarness extends BrowserHarness {
  readonly sent: AbjectMessage[] = [];

  protected override async request<T>(message: AbjectMessage): Promise<T> {
    if (message.routing.method === 'update') return super.request<T>(message);
    this.sent.push(message);
    if (message.routing.method === 'listProjects') {
      return (this as unknown as ConfigInternals).projects as unknown as T;
    }
    if (message.routing.method === 'setAutonomy') return { success: true } as unknown as T;
    return undefined as T;
  }

  payloadFor(method: string): Record<string, unknown> | undefined {
    const sent = this.sent.find(m => m.routing.method === method);
    return sent?.payload as Record<string, unknown> | undefined;
  }
}

/** A browser holding one selected project with every editor control wired to a known id. */
function editorBrowser(stored: Partial<ExternalProject> = {}): { browser: ConfigHarness; internals: ConfigInternals } {
  const browser = new ConfigHarness();
  // Widget chrome leaves through send(), which requires a live bus; these tests are
  // about the registry traffic, so record those messages and drop them.
  (browser as unknown as { send: (message: AbjectMessage) => unknown }).send = (message: AbjectMessage): unknown => {
    browser.sent.push(message);
    return undefined;
  };
  const internals = browser as unknown as ConfigInternals;
  internals.registryObjId = 'external-project-registry' as AbjectId;
  internals.projects = [project('alpha', '/tmp/alpha', stored)];
  internals.selected = 'alpha';
  internals.descInputId = 'cfg-desc' as AbjectId;
  internals.checkInputId = 'cfg-check' as AbjectId;
  internals.verifyInputId = 'cfg-verify' as AbjectId;
  internals.formatInputId = 'cfg-format' as AbjectId;
  internals.setupInputId = 'cfg-setup' as AbjectId;
  internals.sharedInputId = 'cfg-shared' as AbjectId;
  internals.protectedInputId = 'cfg-protected' as AbjectId;
  internals.isolationSelectId = 'cfg-isolation' as AbjectId;
  internals.autonomySelectId = 'cfg-autonomy' as AbjectId;
  internals.trustedCheckId = 'cfg-trusted' as AbjectId;
  internals.saveBtnId = 'cfg-save' as AbjectId;
  internals.revertBtnId = 'cfg-revert' as AbjectId;
  return { browser, internals };
}

test('editing a field in the configuration pane records a draft without touching the registry', async () => {
  const { browser, internals } = editorBrowser({ description: 'old' });

  await internals.handleChanged('cfg-desc' as AbjectId, 'change', 'a sharper description');
  await internals.handleChanged('cfg-check' as AbjectId, 'change', 'pnpm typecheck');

  assert.equal(internals.configDraft.get('description'), 'a sharper description');
  assert.equal(internals.configDraft.get('checkCommand'), 'pnpm typecheck');
  assert.equal(internals.configDirty, true);
  assert.equal(browser.payloadFor('updateProject'), undefined);
});

test('saving the pane writes every edited field through one updateProject call', async () => {
  const { browser, internals } = editorBrowser({
    description: 'old',
    checkCommand: 'old check',
    verifyCommand: 'old verify',
    sharedPaths: [],
    protectedPaths: [],
  });

  await internals.handleChanged('cfg-desc' as AbjectId, 'change', 'new description');
  await internals.handleChanged('cfg-check' as AbjectId, 'change', 'pnpm typecheck');
  await internals.handleChanged('cfg-verify' as AbjectId, 'change', '');
  await internals.handleChanged('cfg-shared' as AbjectId, 'change', 'src, docs');
  await internals.handleChanged('cfg-save' as AbjectId, 'click');

  const payload = browser.payloadFor('updateProject') as { name: string; changes: Record<string, unknown> };
  assert.equal(payload.name, 'alpha');
  assert.equal(payload.changes.description, 'new description');
  assert.equal(payload.changes.checkCommand, 'pnpm typecheck');
  assert.equal(payload.changes.verifyCommand, undefined);
  assert.deepEqual(payload.changes.sharedPaths, ['src', 'docs']);
  assert.equal(internals.configDirty, false);
  assert.equal(internals.configDraft.size, 0);
});

test('trust and autonomy leave the pane through their own gated calls', async () => {
  const { browser, internals } = editorBrowser({ trusted: true, autonomy: 'ask', protectedPaths: [] });

  await internals.handleChanged('cfg-trusted' as AbjectId, 'change', 'false');
  await internals.handleChanged('cfg-autonomy' as AbjectId, 'change', 'edit');
  await internals.handleChanged('cfg-save' as AbjectId, 'click');

  assert.deepEqual(browser.payloadFor('setTrusted'), { name: 'alpha', trusted: false });
  assert.deepEqual(browser.payloadFor('setAutonomy'), { name: 'alpha', autonomy: 'edit' });

  const changes = (browser.payloadFor('updateProject') as { changes: Record<string, unknown> }).changes;
  assert.equal('trusted' in changes, false);
  assert.equal('autonomy' in changes, false);
});

test('pressing Enter in a configuration field saves the pane immediately', async () => {
  const { browser, internals } = editorBrowser({ description: 'old', protectedPaths: [] });

  await internals.handleChanged('cfg-desc' as AbjectId, 'submit', 'typed then entered');

  const payload = browser.payloadFor('updateProject') as { changes: Record<string, unknown> };
  assert.equal(payload.changes.description, 'typed then entered');
});

test('reverting throws the unsaved draft away without writing it', async () => {
  const { browser, internals } = editorBrowser({ description: 'old' });

  await internals.handleChanged('cfg-desc' as AbjectId, 'change', 'scratch');
  assert.equal(internals.configDirty, true);

  await internals.handleChanged('cfg-revert' as AbjectId, 'click');

  assert.equal(internals.configDirty, false);
  assert.equal(internals.configDraft.size, 0);
  assert.equal(browser.payloadFor('updateProject'), undefined);
});

test('JSON-encoded project selections populate and refresh configuration and applicable grants', async () => {
  const browser = new BrowserHarness();
  const internals = browser as unknown as BrowserInternals;
  const projectListId = 'project-list' as AbjectId;
  const tabBarId = 'project-tabs' as AbjectId;
  const detailsId = 'project-details' as AbjectId;
  const grantsId = 'project-grants' as AbjectId;
  const grantRowId = 'project-grant-actions' as AbjectId;

  internals.listWidgetId = projectListId;
  internals.tabBarId = tabBarId;
  internals.detailsWidgetId = detailsId;
  internals.grantsWidgetId = grantsId;
  internals.grantRowId = grantRowId;
  internals.projects = [
    project('Alpha', '/projects/alpha'),
    project('Beta', '/projects/beta', { trusted: false }),
  ];
  internals.permissionRules = [
    { index: 1, kind: 'program', caller: 'ExternalCreator', program: 'git', scope: { kind: 'project', name: 'Alpha' }, allow: true },
    { index: 2, kind: 'class', caller: 'ExternalCreator', effect: 'read', scope: { kind: 'project', name: 'Beta' }, allow: false },
    { index: 3, kind: 'program', caller: 'ExternalCreator', program: 'node', scope: { kind: 'anywhere' }, allow: true },
  ];

  await internals.handleChanged(projectListId, 'selectionChanged', JSON.stringify({
    index: 0,
    value: 'Alpha',
    label: 'Alpha',
    via: 'click',
  }));

  const alphaDetails = browser.updates.get(detailsId) ?? [];
  const alphaGrants = browser.updates.get(grantsId) ?? [];
  assert.equal(alphaDetails[0]?.label, 'Configuration — Alpha');
  assert.equal(alphaDetails.find(item => item.value === 'root')?.secondary, '/projects/alpha');
  assert.equal(alphaDetails.find(item => item.value === 'check')?.secondary, 'check-Alpha');
  assert.deepEqual(alphaGrants.map(item => item.value), ['rule:1', 'rule:3']);

  await internals.handleChanged(projectListId, 'selectionChanged', JSON.stringify({
    index: 1,
    value: 'Beta',
    label: 'Beta',
    via: 'click',
  }));

  const betaDetails = browser.updates.get(detailsId) ?? [];
  const betaGrants = browser.updates.get(grantsId) ?? [];
  assert.equal(betaDetails[0]?.label, 'Configuration — Beta');
  assert.equal(betaDetails.find(item => item.value === 'root')?.secondary, '/projects/beta');
  assert.equal(betaDetails.find(item => item.value === 'verify')?.secondary, 'verify-Beta');
  assert.match(betaDetails.find(item => item.value === 'security')?.secondary ?? '', /^Untrusted/);
  assert.deepEqual(betaGrants.map(item => item.value), ['rule:2', 'rule:3']);

  await internals.handleChanged(tabBarId, 'change', 1);
  assert.equal(internals.activeTab, 1);
  assert.equal(internals.selected, 'Beta');
  assert.equal(browser.visibility.get(detailsId), false);
  assert.equal(browser.visibility.get(grantsId), true);
  assert.equal(browser.visibility.get(grantRowId), true);

  await internals.handleChanged(projectListId, 'selectionChanged', JSON.stringify({
    index: 0,
    value: 'Alpha',
    label: 'Alpha',
    via: 'click',
  }));
  assert.equal(internals.activeTab, 1);
  assert.equal(internals.selected, 'Alpha');
  assert.deepEqual((browser.updates.get(grantsId) ?? []).map(item => item.value), ['rule:1', 'rule:3']);

  await internals.handleChanged(tabBarId, 'change', 0);
  assert.equal(internals.activeTab, 0);
  assert.equal(internals.selected, 'Alpha');
  assert.equal(browser.visibility.get(detailsId), true);
  assert.equal(browser.visibility.get(grantsId), false);
  assert.equal(browser.visibility.get(grantRowId), false);
});

// ─── Redesigned right-pane layout (pinned header + scrollable body) ─────────
// These tests drive the real show() construction against a scripted
// WidgetManager so the scroll-container structure, field reachability, and
// regression-guarded sizing constants hold without a live bus or canvas.

type LayoutChildSpec = {
  widgetId: AbjectId;
  sizePolicy?: { vertical?: string; horizontal?: string };
  preferredSize?: { height?: number; width?: number };
};

type RecordedCall = {
  method: string | undefined;
  to: AbjectId | undefined;
  payload: Record<string, unknown>;
};

type ShowInternals = {
  widgetManagerId?: AbjectId;
  rightBodyId?: AbjectId;
  listWidgetId: AbjectId;
  tabBarId: AbjectId;
  detailsWidgetId: AbjectId;
  grantsWidgetId: AbjectId;
  grantRowId: AbjectId;
  configEditorIds: AbjectId[];
};

/** Runs a full show() against a scripted WidgetManager; records every request. */
class ShowHarness extends ExternalProjectBrowser {
  readonly wmId = 'widget-manager' as AbjectId;
  readonly registryId = 'external-project-registry' as AbjectId;
  readonly calls: RecordedCall[] = [];
  private layoutSeq = 0;
  private widgetSeq = 0;

  protected override async discoverDep(name: string): Promise<AbjectId | null> {
    if (name === 'WidgetManager') return this.wmId;
    if (name === 'ExternalProjectRegistry') return this.registryId;
    return null;
  }

  protected override async requireDep(name: string): Promise<AbjectId> {
    const id = await this.discoverDep(name);
    if (!id) throw new Error(`missing dependency: ${name}`);
    return id;
  }

  protected override async resolveDep(
    name: string,
    cached: AbjectId | undefined,
  ): Promise<AbjectId | undefined> {
    return cached ?? (await this.discoverDep(name)) ?? undefined;
  }

  protected override async request<T>(message: AbjectMessage): Promise<T> {
    const method = message.routing.method;
    const payload = (message.payload ?? {}) as Record<string, unknown>;
    this.calls.push({ method, to: message.routing.to, payload });

    if (message.routing.to === this.wmId) {
      if (method === 'getDisplayInfo') return { width: 1600, height: 900 } as unknown as T;
      if (method === 'createWindowAbject') return 'window' as unknown as T;
      if (method === 'createVBox' || method === 'createNestedVBox' ||
          method === 'createNestedHBox' || method === 'createNestedScrollableVBox') {
        return `layout-${this.layoutSeq++}` as unknown as T;
      }
      if (method === 'create') {
        const specs = (payload.specs as unknown[] | undefined) ?? [];
        return { widgetIds: specs.map((_, i) => `widget-${this.widgetSeq++}` as AbjectId) } as unknown as T;
      }
      if (method === 'getValue') return 'false' as unknown as T;
      return undefined as T;
    }
    if (message.routing.to === this.registryId && method === 'listProjects') {
      return [project('Alpha', '/projects/alpha')] as unknown as T;
    }
    return undefined as T;
  }
}

async function shownBrowser(): Promise<{ browser: ShowHarness; internals: ShowInternals }> {
  const browser = new ShowHarness();
  // Widget chrome and dependent pings leave through send(), which needs a bus.
  (browser as unknown as { send: (message: AbjectMessage) => unknown }).send = () => undefined;
  const internals = browser as unknown as ShowInternals;
  internals.widgetManagerId = browser.wmId;
  const shown = await browser.show();
  assert.equal(shown, true);
  return { browser, internals };
}

function childrenOf(browser: ShowHarness, layoutId: AbjectId | undefined): LayoutChildSpec[] {
  if (!layoutId) return [];
  return browser.calls
    .filter(c => c.method === 'addLayoutChildren' && c.to === layoutId)
    .flatMap(c => (c.payload.children as LayoutChildSpec[] | undefined) ?? []);
}

test('right pane pins the tab header and puts overflowing content in a scrollable body', async () => {
  const { browser, internals } = await shownBrowser();

  const scroll = browser.calls.find(c => c.method === 'createNestedScrollableVBox');
  assert.ok(scroll, 'show() must create a nested scrollable vbox for the right pane');
  const tabHeader = browser.calls.find(
    c => c.method === 'addLayoutChild' && (c.payload as { widgetId?: AbjectId }).widgetId === internals.tabBarId,
  );
  assert.ok(tabHeader, 'the tab bar must be added to the right pane');
  assert.equal(
    (scroll.payload as { parentLayoutId?: AbjectId }).parentLayoutId,
    tabHeader.to,
    'the scroll body lives in the same pane as the tab header',
  );
  const headerSpec = tabHeader.payload as { sizePolicy?: { vertical?: string }; preferredSize?: { height?: number } };
  assert.equal(headerSpec.sizePolicy?.vertical, 'fixed', 'the tab header is pinned, not scrolled');
  assert.equal(headerSpec.preferredSize?.height, 34);

  assert.ok(internals.rightBodyId, 'the browser must remember the scroll body id');
  const bodyChildren = childrenOf(browser, internals.rightBodyId);
  assert.ok(bodyChildren.length > 0, 'the scroll body must hold the overflowing widgets');
  const paneChildren = browser.calls.filter(c => c.method === 'addLayoutChild' && c.to === tabHeader.to);
  assert.deepEqual(
    paneChildren.map(c => (c.payload as { widgetId: AbjectId }).widgetId),
    [internals.tabBarId],
    'only the pinned tab header may be a direct child of the pane',
  );
});

test('every configuration field stays reachable inside the scrollable body', async () => {
  const { browser, internals } = await shownBrowser();
  const childIds = new Set(childrenOf(browser, internals.rightBodyId).map(c => c.widgetId));

  assert.equal(internals.configEditorIds.length, 21, 'all inline config editors are created');
  for (const id of internals.configEditorIds) {
    assert.ok(childIds.has(id), `config editor ${id} must live inside the scroll body`);
  }
  assert.ok(childIds.has(internals.detailsWidgetId), 'the details summary must live inside the scroll body');
  const details = childrenOf(browser, internals.rightBodyId).find(c => c.widgetId === internals.detailsWidgetId);
  assert.equal(details?.preferredSize?.height, 116);
});

test('grants list keeps a fixed height and its action row scrolls with the body', async () => {
  const { browser, internals } = await shownBrowser();

  // Regression guard: an expanding grants list inside a scroll container has
  // no stable height, which is what let the pane clip.
  const grants = childrenOf(browser, internals.rightBodyId).find(c => c.widgetId === internals.grantsWidgetId);
  assert.ok(grants, 'the grants list must be parented inside the scroll body');
  assert.equal(grants?.sizePolicy?.vertical, 'fixed', 'the grants list must not expand inside a scroll container');
  assert.equal(grants?.preferredSize?.height, 260);

  // Regression guard: the grant action row is created inside the scroll body
  // at the shared row height, so Add/Edit/Remove stay reachable on short windows.
  const grantRow = browser.calls.find(
    c => c.method === 'createNestedHBox' &&
      (c.payload as { parentLayoutId?: AbjectId }).parentLayoutId === internals.rightBodyId,
  );
  assert.ok(grantRow, 'the grant action row must be created inside the scrollable body');
  const rowSizing = browser.calls.find(
    c => c.method === 'updateLayoutChild' && c.to === internals.rightBodyId &&
      (c.payload as { widgetId?: AbjectId }).widgetId === internals.grantRowId,
  );
  assert.ok(rowSizing, 'the grant action row must be sized by the scroll body');
  const rowSpec = rowSizing.payload as { sizePolicy?: { vertical?: string }; preferredSize?: { height?: number } };
  assert.equal(rowSpec.sizePolicy?.vertical, 'fixed');
  assert.equal(rowSpec.preferredSize?.height, 36, 'the grant action row uses the shared BUTTON_ROW_H');
  assert.equal(childrenOf(browser, internals.grantRowId).length, 3, 'Add/Edit/Remove grant buttons ride the row');
});
