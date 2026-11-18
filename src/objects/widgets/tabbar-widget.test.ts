/**
 * The tab strip's click reporting.
 *
 * The web viewer appends a '+' tab as its new-tab button. With no pages open
 * that '+' is the ONLY tab, so it is also the selected index — and a tab click
 * that only reported a change of selection swallowed it, leaving the person
 * with a '+' that did nothing and no way to start browsing.
 *
 * These tests pin the click contract: a '+' tab reports a PRESS on its own
 * 'newTab' aspect, never a selection (with no pages the '+' is index 0, which is
 * also the page count, so a shared channel made merely showing the strip look
 * like "open a new tab"); a real tab reports only when the selection actually
 * moves (an already-active real tab is the first half of the double-click that
 * renames it).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { TabBarWidget, type TabBarConfig } from './tabbar-widget.js';
import type { AbjectId } from '../../core/types.js';

/** A tab strip with no widget manager behind it: clicks in, reports out. */
class TestTabBar extends TabBarWidget {
  readonly reported: Array<{ aspect: string; value?: unknown }> = [];

  constructor(config: TabBarConfig) {
    super(config);
  }

  protected override async requestRedraw(): Promise<void> {
    // Nothing is on screen; the redraw is the WidgetManager's job.
  }

  protected override changed(aspect: string, value?: unknown): void {
    this.reported.push({ aspect, value });
  }

  /** Click at an x inside the strip, the way the compositor delivers it. */
  click(localX: number): Promise<{ consumed: boolean }> {
    return this.processInput({ type: 'mousedown', localX });
  }

  /** Move the pointer to an x inside the strip. */
  hover(localX: number): Promise<{ consumed: boolean }> {
    return this.processInput({ type: 'mousemove', localX });
  }
}

function tabBar(tabs: string[], selectedIndex: number, width = 300): TestTabBar {
  return new TestTabBar({
    type: 'tabBar',
    rect: { x: 0, y: 0, width, height: 30 },
    ownerId: 'owner-1' as AbjectId,
    uiServerId: 'ui-1' as AbjectId,
    tabs,
    selectedIndex,
    closable: true,
  });
}

test('tab bar: clicking the only + tab reports a press — the empty viewer state', async () => {
  // No pages open, so the strip is just '+', already index 0. The press must
  // still reach the viewer, and must not look like a selection of index 0.
  // The '+' keeps its own button box at the trailing edge, so on a 300px strip
  // it runs from 264 to 300; the rest of the row is not the button.
  const bar = tabBar(['+'], 0);
  const result = await bar.click(280);

  assert.deepEqual(result, { consumed: true });
  assert.deepEqual(bar.reported, [{ aspect: 'newTab', value: undefined }],
    'the + click was reported as a press, not as a selection of index 0');
});

test('tab bar: the + tab reports a press, not its index', async () => {
  const bar = tabBar(['Thetix', 'Example', '+'], 0);
  await bar.click(280); // inside the trailing + button

  assert.deepEqual(bar.reported, [{ aspect: 'newTab', value: undefined }],
    'a consumer never has to compare an index against a page count to spot the +');
});

test('tab bar: a + click never reports a selection change', async () => {
  // The phantom about:blank tab came from exactly this: a value on the
  // selection channel that the viewer read as "open a new page".
  const bar = tabBar(['+'], 0);
  await bar.click(280);

  assert.equal(bar.reported.some((r) => r.aspect === 'change'), false,
    'no selection change is reported for a + press');
});

test('tab bar: clicking the already-selected real tab reports nothing', async () => {
  // A real tab that is already active is the first click of a rename, not a
  // selection change; reporting it would rebuild the consumer's panes.
  const bar = tabBar(['Thetix', 'Example', '+'], 0);
  await bar.click(20);

  assert.deepEqual(bar.reported, []);
});

test('tab bar: clicking a different tab still reports the new selection once', async () => {
  const bar = tabBar(['Thetix', 'Example', '+'], 0);
  await bar.click(150);

  assert.deepEqual(bar.reported, [{ aspect: 'change', value: 1 }]);
});

test('tab bar: a press on empty strip space opens nothing — the phantom-tab regression', async () => {
  // The viewer used to open an about:blank page nobody asked for when it was
  // shown with no pages: the '+' divided the width with the real tabs, so with
  // nothing open it WAS the whole row, and any press on the strip counted as a
  // press on the new-tab button. The button now owns a fixed trailing box and
  // the rest of the row is dead space.
  const bar = tabBar(['+'], 0);
  await bar.click(20);
  await bar.click(150);

  assert.deepEqual(bar.reported, [], 'a press that is nobody\'s press reports nothing');

  // The button itself still works, and only it does.
  await bar.click(280);
  assert.deepEqual(bar.reported, [{ aspect: 'newTab', value: undefined }]);
});

test('tab bar: hovering empty strip space reports nothing', async () => {
  const bar = tabBar(['+'], 0);
  await bar.hover(20);

  assert.deepEqual(bar.reported, [], 'dead space is not a tab');
});
