import test from 'node:test';
import assert from 'node:assert/strict';
import { Abject, type MessageHandlerFn } from '../../core/abject.js';
import { request } from '../../core/message.js';
import type { AbjectId } from '../../core/types.js';
import { MessageBus } from '../../runtime/message-bus.js';
import { VBoxLayout } from './vbox-layout.js';
import { HBoxLayout } from './hbox-layout.js';
import { ScrollableVBoxLayout } from './scrollable-vbox-layout.js';
import { WidgetManager } from '../widget-manager.js';

class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'Layout fixture',
      interface: { id: `fixture:${name}`, name, description: 'fixture', methods: [] }, requiredCapabilities: [], providedCapabilities: [] } });
  }
  public override on(method: string, fn: MessageHandlerFn): void { super.on(method, fn); }
  call(to: AbjectId, method: string, payload: unknown = {}): Promise<any> { return this.request(request(this.id, to, method, payload), 2000); }
}
class Manager extends WidgetManager { protected override async onInit(): Promise<void> {} }

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('Fixture did not settle');
}

/**
 * A bus with the objects a box layout talks to: the window that owns it, the
 * UIServer widgets measure text through, and a stand-in WidgetManager that
 * records every overflow report. Children are plain endpoints that accept the
 * rect updates a layout pushes.
 */
async function fixture() {
  const bus = new MessageBus(), objects: Abject[] = [];
  const add = async <T extends Abject>(o: T, parentId?: AbjectId): Promise<T> => { await o.init(bus, parentId); objects.push(o); return o; };
  const reports: Array<{ layoutId: string; ownerId: string; overflow: unknown }> = [];
  const manager = await add(new Endpoint('WidgetManager'));
  manager.on('layoutOverflow', msg => { reports.push(msg.payload as any); });
  const ui = await add(new Endpoint('UIServer'));
  ui.on('getFontMetrics', () => ({}));
  const window = await add(new Endpoint('Window'));
  window.on('removeChild', () => true); window.on('childDirty', () => true); window.on('addChild', () => true);
  window.on('getTitle', () => 'Fixture Window');
  const child = async () => {
    const c = await add(new Endpoint('Child'));
    c.on('update', () => true); c.on('addDependent', () => true); c.on('destroy', () => true);
    return c;
  };
  return { bus, add, reports, manager, ui, window, child,
    async stop() { for (const o of objects.reverse()) await o.stop(); } };
}

test('a VBox reports fixed rows that do not fit and clears the report when they do', async () => {
  const f = await fixture();
  try {
    const layout = await f.add(new VBoxLayout({ ownerId: f.window.id, uiServerId: f.ui.id, spacing: 6 }), f.manager.id);
    for (let i = 0; i < 5; i++) {
      const c = await f.child();
      await f.window.call(layout.id, 'addLayoutChild', { widgetId: c.id, sizePolicy: { vertical: 'fixed' }, preferredSize: { height: 26 } });
    }
    // 5 rows of 26 plus 4 gaps of 6 need 154px; the 100px box has 84px of content after the 8px margins.
    await f.window.call(layout.id, 'update', { rect: { x: 0, y: 0, width: 300, height: 100 } });
    await until(() => f.reports.length === 1);
    const first = f.reports[0].overflow as { axis: string; needed: number; available: number; hiddenChildren: number };
    assert.equal(f.reports[0].layoutId, layout.id);
    assert.equal(f.reports[0].ownerId, f.window.id);
    assert.deepEqual(first, { axis: 'vertical', needed: 154, available: 84, hiddenChildren: 3 });
    assert.deepEqual(await f.window.call(layout.id, 'getLayoutOverflow'), first);

    // The same geometry again says nothing new.
    await f.window.call(layout.id, 'update', { rect: { x: 0, y: 0, width: 300, height: 100 } });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(f.reports.length, 1, 'an unchanged overflow is not re-reported');

    await f.window.call(layout.id, 'update', { rect: { x: 0, y: 0, width: 300, height: 400 } });
    await until(() => f.reports.length === 2);
    assert.equal(f.reports[1].overflow, null);
    assert.equal(await f.window.call(layout.id, 'getLayoutOverflow'), null);
  } finally { await f.stop(); }
});

test('an HBox reports fixed columns that do not fit', async () => {
  const f = await fixture();
  try {
    const layout = await f.add(new HBoxLayout({ ownerId: f.window.id, uiServerId: f.ui.id, spacing: 4, margins: { left: 0, right: 0 } }), f.manager.id);
    for (let i = 0; i < 3; i++) {
      const c = await f.child();
      await f.window.call(layout.id, 'addLayoutChild', { widgetId: c.id, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 100 } });
    }
    await f.window.call(layout.id, 'update', { rect: { x: 0, y: 0, width: 200, height: 40 } });
    await until(() => f.reports.length === 1);
    assert.deepEqual(f.reports[0].overflow, { axis: 'horizontal', needed: 308, available: 200, hiddenChildren: 2 });
  } finally { await f.stop(); }
});

test('a scrollable VBox never reports overflow: scrolling is how it fits', async () => {
  const f = await fixture();
  try {
    const layout = await f.add(new ScrollableVBoxLayout({ ownerId: f.window.id, uiServerId: f.ui.id }), f.manager.id);
    for (let i = 0; i < 20; i++) {
      const c = await f.child();
      await f.window.call(layout.id, 'addLayoutChild', { widgetId: c.id, sizePolicy: { vertical: 'fixed' }, preferredSize: { height: 26 } });
    }
    await f.window.call(layout.id, 'update', { rect: { x: 0, y: 0, width: 300, height: 100 } });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(f.reports.length, 0);
    assert.equal(await f.window.call(layout.id, 'getLayoutOverflow'), null);
  } finally { await f.stop(); }
});

test('WidgetManager lists overflowing layouts by window and owner, and forgets them when they clear', async () => {
  const f = await fixture();
  try {
    const wm: any = await f.add(new Manager());
    const owner = await f.add(new Endpoint('App'));
    const nested = await f.add(new Endpoint('NestedLayout'));
    wm.windowOwners.set(f.window.id, owner.id);
    wm.layoutOwners.set(nested.id, f.window.id);          // nested layout created in the window
    // A layout nested one level down reports, naming its parent layout as owner.
    const layout = await f.add(new VBoxLayout({ ownerId: nested.id, uiServerId: f.ui.id, spacing: 0 }), wm.id);
    for (let i = 0; i < 4; i++) {
      const c = await f.child();
      await f.window.call(layout.id, 'addLayoutChild', { widgetId: c.id, sizePolicy: { vertical: 'fixed' }, preferredSize: { height: 30 } });
    }
    await f.window.call(layout.id, 'update', { rect: { x: 0, y: 0, width: 200, height: 60 } });
    await until(() => wm.layoutOverflows.size === 1);

    const all = await f.window.call(wm.id, 'listLayoutIssues');
    assert.equal(all.length, 1);
    assert.equal(all[0].windowId, f.window.id);
    assert.equal(all[0].ownerId, owner.id);
    assert.equal(all[0].title, 'Fixture Window');
    assert.equal(all[0].layoutId, layout.id);
    assert.equal(all[0].overflow.axis, 'vertical');
    assert.equal((await f.window.call(wm.id, 'listLayoutIssues', { ownerId: owner.id })).length, 1);
    assert.equal((await f.window.call(wm.id, 'listLayoutIssues', { ownerId: 'someone-else' })).length, 0);
    assert.equal((await f.window.call(wm.id, 'listLayoutIssues', { windowId: f.window.id })).length, 1);

    await f.window.call(layout.id, 'update', { rect: { x: 0, y: 0, width: 200, height: 400 } });
    await until(() => wm.layoutOverflows.size === 0);
    assert.deepEqual(await f.window.call(wm.id, 'listLayoutIssues'), []);
  } finally { await f.stop(); }
});
