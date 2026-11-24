import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ModePickerWidget,
  type ModePickerWidgetConfig,
  type ModePickerChainEntry,
} from './mode-picker-widget.js';
import { PopoutSurface } from './popout.js';
import {
  presetMode,
  type PresetName,
} from '../../core/permission-modes.js';

type DrawCmd = { type: string; surfaceId?: string; params?: Record<string, unknown> };
type PopoutChannelArg = ConstructorParameters<typeof PopoutSurface>[0];
type PopoutOptionsArg = ConstructorParameters<typeof PopoutSurface>[2];

interface PopoutLog {
  nodeId: string;
  options?: PopoutOptionsArg;
  surface: PopoutSurface;
  sceneOps: Array<Array<Record<string, unknown>>>;
  draws: DrawCmd[][];
}

class TestModePicker extends ModePickerWidget {
  readonly reported: Array<{ aspect: string; value: unknown }> = [];
  redrawCount = 0;
  popoutLog: PopoutLog | null = null;

  protected override async requestRedraw(): Promise<void> {
    this.redrawCount++;
  }

  protected override changed(aspect: string, value?: unknown): void {
    this.reported.push({ aspect, value });
  }

  protected override createPopout(nodeId: string, options?: PopoutOptionsArg): PopoutSurface {
    const sceneOps: Array<Array<Record<string, unknown>>> = [];
    const draws: DrawCmd[][] = [];
    const channel: PopoutChannelArg = {
      scene: async (ops) => {
        sceneOps.push(ops);
        return true;
      },
      draw: async (_id, commands) => {
        draws.push(commands as DrawCmd[]);
        return true;
      },
    };
    const surface = new PopoutSurface(channel, nodeId, options);
    this.popoutLog = { nodeId, options, surface, sceneOps, draws };
    return surface;
  }

  async render(surfaceId = 'surf-1', ox = 10, oy = 500): Promise<DrawCmd[]> {
    return (await this.buildDrawCommands(surfaceId, ox, oy)) as DrawCmd[];
  }

  async sendInput(input: Record<string, unknown>) {
    return this.processInput(input as never);
  }

  async sendPopoutInput(input: Record<string, unknown>) {
    return this.handlePopoutInput(input as never);
  }

  async sendPopoutWindowFocus(focused: boolean): Promise<void> {
    await this.handlePopoutWindowFocus(focused);
  }

  async applyWidgetUpdate(updates: Record<string, unknown>): Promise<void> {
    await this.applyUpdate(updates as never);
  }

  async stopWidget(): Promise<void> {
    await this.onStop();
  }

  getValue(): string {
    return this.getWidgetValue();
  }

  getTheme() {
    return this.theme;
  }
}

function makePicker(overrides: Partial<ModePickerWidgetConfig> = {}): TestModePicker {
  return new TestModePicker({
    type: 'modePicker',
    rect: { x: 0, y: 0, width: 44, height: 44 },
    ownerId: 'owner-1' as ModePickerWidgetConfig['ownerId'],
    uiServerId: 'ui-1' as ModePickerWidgetConfig['uiServerId'],
    mode: presetMode('auto'),
    ceiling: presetMode('auto'),
    maySetMode: true,
    chain: [
      { id: 'g-parent', holderLabel: 'ChatManager' },
      { id: 'g-self', holderLabel: 'this chat' },
    ] as ModePickerChainEntry[],
    ...overrides,
  });
}

async function flushPopout(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function openPicker(picker: TestModePicker, ox = 10, oy = 500): Promise<void> {
  await picker.render('surf-1', ox, oy);
  await picker.sendInput({ type: 'mousedown', x: 22, y: 22 });
  await picker.sendInput({ type: 'mouseup', x: 22, y: 22 });
  await flushPopout();
}

function textCommands(cmds: DrawCmd[]): DrawCmd[] {
  return cmds.filter((c) => c.type === 'text');
}

function rectCommands(cmds: DrawCmd[]): DrawCmd[] {
  return cmds.filter((c) => c.type === 'rect');
}

function findTriggerFaceRect(cmds: DrawCmd[]): DrawCmd | undefined {
  return rectCommands(cmds).find(
    (c) =>
      typeof c.params?.width === 'number' &&
      typeof c.params?.height === 'number' &&
      c.params.width === c.params.height &&
      c.params.width >= 38 &&
      c.params.width <= 44 &&
      c.params?.stroke !== undefined,
  );
}

function latestPopoutCommands(picker: TestModePicker): DrawCmd[] {
  const draws = picker.popoutLog?.draws ?? [];
  assert.ok(draws.length > 0, 'popout should have at least one draw call');
  return draws[draws.length - 1];
}

function findTextCmd(cmds: DrawCmd[], label: string): DrawCmd {
  const cmd = textCommands(cmds).find((c) => String(c.params?.text ?? '') === label);
  assert.ok(cmd, `expected text command "${label}"`);
  return cmd;
}

test('icon-only trigger renders all 6 presets with distinct semantic icons, risk cues, and open highlight', async () => {
  const allPresets: PresetName[] = [
    'plan',
    'manual',
    'acceptEdits',
    'auto',
    'unattended',
    'fullAccess',
  ];
  const iconSignatures = new Set<string>();
  const neutralChrome = new Set<string>();

  for (const preset of allPresets) {
    const picker = makePicker({ mode: presetMode(preset), ceiling: presetMode('fullAccess') });
    const theme = picker.getTheme();
    const cmds = await picker.render('surf-1', 10, 500);

    // Strictly icon-only: no text pill label.
    assert.equal(textCommands(cmds).length, 0, `${preset} trigger must not render text labels`);

    // Raised-block square button face matching the 44x44 attach-file button chrome.
    const buttonRect = findTriggerFaceRect(cmds);
    assert.ok(buttonRect, `${preset} trigger should render a bordered square button face`);

    const faceIdx = cmds.indexOf(buttonRect);
    const iconCmds = cmds.slice(faceIdx + 1);
    assert.ok(iconCmds.length > 0, `${preset} trigger should render icon commands`);

    if (preset === 'unattended') {
      const hasWarningCue = cmds.some(
        (c) => c.params?.stroke === theme.statusWarning || c.params?.fill === theme.statusWarning,
      );
      assert.ok(hasWarningCue, 'unattended trigger should include statusWarning risk cue');
    } else if (preset === 'fullAccess') {
      assert.equal(buttonRect.params?.fill, theme.destructiveBg);
      assert.equal(buttonRect.params?.stroke, theme.destructiveBorder);
      const hasErrorCue = iconCmds.some(
        (c) => c.params?.stroke === theme.statusError || c.params?.fill === theme.statusError,
      );
      assert.ok(hasErrorCue, 'fullAccess trigger icon should use statusError cue');
    } else {
      assert.notEqual(buttonRect.params?.fill, theme.destructiveBg);
      assert.notEqual(buttonRect.params?.fill, theme.activeItemBg);
      neutralChrome.add(`${String(buttonRect.params?.fill)}|${String(buttonRect.params?.stroke)}`);
    }

    const normalizedSig = JSON.stringify(
      iconCmds.map((c) => ({
        type: c.type,
        params: Object.fromEntries(
          Object.entries(c.params ?? {}).filter(([k]) => k !== 'stroke' && k !== 'fill'),
        ),
      })),
    );
    iconSignatures.add(normalizedSig);
  }

  assert.equal(neutralChrome.size, 1, 'interactive presets should share uniform secondary button chrome');
  assert.equal(
    iconSignatures.size,
    allPresets.length,
    'all 6 presets should render distinct semantic icon geometries',
  );

  // Open/active highlight state on the trigger button.
  const openTestPicker = makePicker({ mode: presetMode('auto'), ceiling: presetMode('auto') });
  const theme = openTestPicker.getTheme();
  await openPicker(openTestPicker, 10, 500);
  assert.equal(openTestPicker.popoutLog?.surface.isOpen, true);
  assert.ok(
    openTestPicker.reported.some((e) => e.aspect === 'expanded' && e.value === true),
    'opening picker should emit expanded=true',
  );
  const openCmds = await openTestPicker.render('surf-1', 10, 500);
  const openFace = findTriggerFaceRect(openCmds);
  assert.ok(openFace, 'open trigger should render its bordered button face');
  assert.equal(openFace.params?.fill, theme.activeItemBg);
  assert.equal(openFace.params?.stroke, theme.activeItemBorder);
});

test('floating PopoutSurface opens above trigger with header, ceiling badge, two grouped borderless sections, active indicator, and lock badges', async () => {
  const picker = makePicker({ mode: presetMode('auto'), ceiling: presetMode('auto') });
  const theme = picker.getTheme();
  await openPicker(picker, 10, 500);

  assert.ok(picker.popoutLog, 'popout should be created');
  const { surface } = picker.popoutLog;
  assert.equal(surface.isOpen, true, 'popout should be open');
  assert.ok(surface.rect, 'popout should have a placed rect');

  // Placed above trigger (anchor x=10, y=500, w=44, h=44) with align:'start' and gap:6.
  assert.equal(surface.rect.x, 10, 'popout should align to anchor start');
  assert.ok(
    surface.rect.y < 500 &&
      surface.rect.y + surface.rect.height <= 500 &&
      500 - (surface.rect.y + surface.rect.height) <= 10,
    `popout should open above trigger with gap (rect=${JSON.stringify(surface.rect)})`,
  );
  assert.ok(surface.rect.width >= 352, 'popout width should cover 352px panel');

  const popCmds = latestPopoutCommands(picker);
  const texts = textCommands(popCmds).map((c) => String(c.params?.text ?? ''));

  // Header + ceiling badge.
  assert.ok(texts.includes('PERMISSION MODE'), 'header should show PERMISSION MODE');
  assert.ok(
    texts.some((t) => /CEILING/i.test(t) && /Auto/i.test(t)),
    'header should show Auto ceiling badge',
  );

  // Two grouped sections.
  assert.ok(
    texts.some((t) => t.toUpperCase() === 'INTERACTIVE'),
    'popout should show Interactive section header',
  );
  assert.ok(
    texts.includes('AUTONOMOUS · NO PROMPTS'),
    'popout should show AUTONOMOUS · NO PROMPTS section header',
  );

  // All 6 rows with two lines each (name + description).
  const rowNames = ['Plan', 'Manual', 'Accept edits', 'Auto', 'Unattended', 'Full access'];
  for (const name of rowNames) {
    const nameCmd = findTextCmd(popCmds, name);
    const nameY = Number(nameCmd.params?.y ?? 0);
    const descCmd = textCommands(popCmds).find((c) => {
      const y = Number(c.params?.y ?? 0);
      const text = String(c.params?.text ?? '');
      return y > nameY && y <= nameY + 26 && text.length > 4 && text !== name;
    });
    assert.ok(descCmd, `row ${name} should render a second description line`);
  }

  // Borderless rows: no per-row stroked boxes (width >= 300, height 42).
  const strokedRowBoxes = rectCommands(popCmds).filter(
    (c) =>
      c.params?.stroke !== undefined &&
      Number(c.params?.height) === 42 &&
      Number(c.params?.width) >= 300,
  );
  assert.equal(strokedRowBoxes.length, 0, 'rows must be borderless');

  // Active selection indicator on Auto: selectionBg fill + 2px left accent bar.
  const activeBar = rectCommands(popCmds).find(
    (c) =>
      Number(c.params?.x) <= 10 &&
      c.params?.width === 2 &&
      Number(c.params?.height) >= 24 &&
      Number(c.params?.height) <= 42,
  );
  assert.ok(activeBar, 'active row should render 2px left accent bar');
  const activeBg = rectCommands(popCmds).find(
    (c) =>
      c.params?.fill === theme.selectionBg &&
      Number(c.params?.width) >= 300 &&
      Number(c.params?.height) >= 34 &&
      Number(c.params?.height) <= 42,
  );
  assert.ok(activeBg, 'active row should render selectionBg highlight');

  // Under ceiling Auto (reach:full, beyond:ask), Full access (reach:full, beyond:allow) is above ceiling.
  const aboveCeilingCount = texts.filter((t) => t === 'ABOVE CEILING').length;
  assert.equal(
    aboveCeilingCount,
    1,
    'Full access should show ABOVE CEILING under ceiling Auto',
  );

  // !maySetMode locks all rows with LOCKED badge.
  const lockedPicker = makePicker({
    mode: presetMode('auto'),
    ceiling: presetMode('fullAccess'),
    maySetMode: false,
  });
  await openPicker(lockedPicker);
  const lockedTexts = textCommands(latestPopoutCommands(lockedPicker)).map((c) =>
    String(c.params?.text ?? ''),
  );
  assert.equal(
    lockedTexts.filter((t) => t === 'LOCKED').length,
    6,
    'maySetMode=false should mark all 6 rows LOCKED',
  );
});

test('footer shows grant provenance summary and clickable Grants link emits openGrants', async () => {
  const picker = makePicker({
    mode: presetMode('auto'),
    ceiling: presetMode('auto'),
    chain: [
      { id: 'g-1', holderLabel: 'ChatManager' },
      { id: 'g-2', holderLabel: 'this chat' },
    ],
  });
  await openPicker(picker);
  const popCmds = latestPopoutCommands(picker);
  const texts = textCommands(popCmds).map((c) => String(c.params?.text ?? ''));

  assert.ok(
    texts.some((t) => t.includes('ChatManager') && t.includes('this chat')),
    'footer should render grant provenance chain summary',
  );
  const grantsCmd = findTextCmd(popCmds, 'Grants');
  const origin = picker.popoutLog!.surface.toLocal({ x: 0, y: 0 })!;
  const gx = Math.max(300, Number(grantsCmd.params?.x ?? 316)) - origin.x;
  const gy = Number(grantsCmd.params?.y ?? 0) + 4 - origin.y;

  await picker.sendPopoutInput({
    type: 'mousedown',
    nodeId: picker.popoutLog!.surface.nodeId,
    x: gx,
    y: gy,
  });
  await picker.sendPopoutInput({
    type: 'mouseup',
    nodeId: picker.popoutLog!.surface.nodeId,
    x: gx,
    y: gy,
  });
  await flushPopout();

  const openGrantsEvent = picker.reported.find((e) => e.aspect === 'openGrants');
  assert.ok(openGrantsEvent, 'clicking Grants should emit openGrants');
  assert.deepEqual(openGrantsEvent.value, {});
  assert.equal(picker.popoutLog?.surface.isOpen, false, 'clicking Grants should close popout');
});

test('clicking unlocked row emits change and closes popout; clicking locked row does nothing', async () => {
  const picker = makePicker({
    mode: presetMode('auto'),
    ceiling: presetMode('auto'),
    maySetMode: true,
  });
  await openPicker(picker);
  const popCmds = latestPopoutCommands(picker);
  const nodeId = picker.popoutLog!.surface.nodeId;
  const origin = picker.popoutLog!.surface.toLocal({ x: 0, y: 0 })!;
  const clickX = 100 - origin.x;

  // Click locked above-ceiling row (Full access under ceiling Auto) -> no-op.
  const fullCmd = findTextCmd(popCmds, 'Full access');
  const fullY = Number(fullCmd.params?.y ?? 0) + 6 - origin.y;
  await picker.sendPopoutInput({ type: 'mousedown', nodeId, x: clickX, y: fullY });
  await picker.sendPopoutInput({ type: 'mouseup', nodeId, x: clickX, y: fullY });
  await flushPopout();
  assert.equal(
    picker.reported.filter((e) => e.aspect === 'change').length,
    0,
    'clicking above-ceiling row must not emit change',
  );
  assert.equal(picker.popoutLog?.surface.isOpen, true, 'locked click must keep popout open');
  assert.equal(picker.getValue(), 'auto');

  // Click unlocked row (Accept edits) -> emits change('acceptEdits') and closes popout.
  const editsCmd = findTextCmd(popCmds, 'Accept edits');
  const editsY = Number(editsCmd.params?.y ?? 0) + 6 - origin.y;
  await picker.sendPopoutInput({ type: 'mousedown', nodeId, x: clickX, y: editsY });
  await picker.sendPopoutInput({ type: 'mouseup', nodeId, x: clickX, y: editsY });
  await flushPopout();
  const changeEvents = picker.reported.filter((e) => e.aspect === 'change');
  assert.equal(changeEvents.length, 1, 'clicking unlocked row should emit one change event');
  assert.equal(changeEvents[0].value, 'acceptEdits');
  assert.equal(picker.getValue(), 'acceptEdits');
  assert.equal(picker.popoutLog?.surface.isOpen, false, 'clicking unlocked row should close popout');

  // When maySetMode is false, clicking even Plan does nothing.
  const lockedPicker = makePicker({
    mode: presetMode('auto'),
    ceiling: presetMode('fullAccess'),
    maySetMode: false,
  });
  await openPicker(lockedPicker);
  const lockedCmds = latestPopoutCommands(lockedPicker);
  const planCmd = findTextCmd(lockedCmds, 'Plan');
  const lockedOrigin = lockedPicker.popoutLog!.surface.toLocal({ x: 0, y: 0 })!;
  const lockedClickX = 100 - lockedOrigin.x;
  const planY = Number(planCmd.params?.y ?? 0) + 6 - lockedOrigin.y;
  const lockedNodeId = lockedPicker.popoutLog!.surface.nodeId;
  await lockedPicker.sendPopoutInput({ type: 'mousedown', nodeId: lockedNodeId, x: lockedClickX, y: planY });
  await lockedPicker.sendPopoutInput({ type: 'mouseup', nodeId: lockedNodeId, x: lockedClickX, y: planY });
  await flushPopout();
  assert.equal(
    lockedPicker.reported.filter((e) => e.aspect === 'change').length,
    0,
    'maySetMode=false must prevent selecting any row',
  );
  assert.equal(lockedPicker.popoutLog?.surface.isOpen, true);
});

test('light-dismiss closes popout on outside mousedown, window blur, Escape, and onStop', async () => {
  // 1. Outside mousedown (routed to widget processInput; closes popout without consuming)
  const p1 = makePicker();
  await openPicker(p1);
  assert.equal(p1.popoutLog?.surface.isOpen, true);
  const dismissRes = await p1.sendInput({
    type: 'mousedown',
    x: -20,
    y: -20,
  });
  await flushPopout();
  assert.equal(dismissRes.consumed, false, 'outside mousedown should not consume event');
  assert.equal(p1.popoutLog?.surface.isOpen, false, 'outside mousedown should close popout');

  // 2. Window focus loss
  const p2 = makePicker();
  await openPicker(p2);
  await p2.sendPopoutWindowFocus(false);
  await flushPopout();
  assert.equal(p2.popoutLog?.surface.isOpen, false, 'window blur should close popout');

  // 3. Escape key
  const p3 = makePicker();
  await openPicker(p3);
  await p3.sendInput({ type: 'keydown', key: 'Escape' });
  await flushPopout();
  assert.equal(p3.popoutLog?.surface.isOpen, false, 'Escape should close popout');

  // 4. onStop() closes/hides popout
  const p4 = makePicker();
  await openPicker(p4);
  await p4.stopWidget();
  await flushPopout();
  assert.equal(p4.popoutLog?.surface.isOpen, false, 'onStop should hide popout');
});

test('keyboard navigation skips locked rows and supports ArrowDown, ArrowUp, Home, End, Enter, Space, Escape', async () => {
  // Under ceiling 'auto', unlocked indices are 0..4 (plan..unattended); index 5 (fullAccess) is locked.
  const picker = makePicker({
    mode: presetMode('auto'),
    ceiling: presetMode('auto'),
    maySetMode: true,
  });
  await picker.render('surf-1', 10, 500);

  // Closed Enter opens popout (focused on active 'auto' = index 3).
  await picker.sendInput({ type: 'keydown', key: 'Enter' });
  await flushPopout();
  assert.equal(picker.popoutLog?.surface.isOpen, true, 'Enter when closed opens popout');

  // ArrowDown from 'auto' (3) -> 'unattended' (4) -> skips locked 'fullAccess' (5) and wraps to 'plan' (0).
  await picker.sendInput({ type: 'keydown', key: 'ArrowDown' });
  await picker.sendInput({ type: 'keydown', key: 'ArrowDown' });
  await picker.sendInput({ type: 'keydown', key: 'Enter' });
  await flushPopout();
  assert.equal(picker.getValue(), 'plan', 'ArrowDown should skip locked fullAccess and wrap to plan');
  assert.equal(picker.popoutLog?.surface.isOpen, false);

  // Closed Space opens popout (now focused on 'plan' = index 0).
  await picker.sendInput({ type: 'keydown', key: ' ' });
  await flushPopout();
  assert.equal(picker.popoutLog?.surface.isOpen, true, 'Space when closed opens popout');

  // ArrowUp from 'plan' (0) skips locked 'fullAccess' (5) and wraps to 'unattended' (4).
  await picker.sendInput({ type: 'keydown', key: 'ArrowUp' });
  await picker.sendInput({ type: 'keydown', key: 'Enter' });
  await flushPopout();
  assert.equal(picker.getValue(), 'unattended', 'ArrowUp from plan should skip locked fullAccess to unattended');
  assert.equal(picker.popoutLog?.surface.isOpen, false);

  // Open again: End lands on last unlocked ('unattended'), Home lands on first unlocked ('plan'), ArrowDown -> 'manual'.
  await picker.sendInput({ type: 'keydown', key: 'Enter' });
  await flushPopout();
  await picker.sendInput({ type: 'keydown', key: 'End' });
  await picker.sendInput({ type: 'keydown', key: 'Home' });
  await picker.sendInput({ type: 'keydown', key: 'ArrowDown' });
  await picker.sendInput({ type: 'keydown', key: ' ' });
  await flushPopout();
  assert.equal(picker.getValue(), 'manual', 'Home + ArrowDown + Space should select manual');
  assert.equal(picker.popoutLog?.surface.isOpen, false);

  // Open again and press Escape -> closes without emitting another change.
  const changesBefore = picker.reported.filter((e) => e.aspect === 'change').length;
  await picker.sendInput({ type: 'keydown', key: 'Enter' });
  await flushPopout();
  assert.equal(picker.popoutLog?.surface.isOpen, true);
  await picker.sendInput({ type: 'keydown', key: 'Escape' });
  await flushPopout();
  assert.equal(picker.popoutLog?.surface.isOpen, false);
  assert.equal(
    picker.reported.filter((e) => e.aspect === 'change').length,
    changesBefore,
    'Escape must not emit change',
  );
});

test('applyUpdate repaints open popout live and updates getWidgetValue', async () => {
  const picker = makePicker({
    mode: presetMode('auto'),
    ceiling: presetMode('auto'),
    maySetMode: true,
  });
  assert.equal(picker.getValue(), 'auto');

  await openPicker(picker);
  const drawsBefore = picker.popoutLog!.draws.length;

  await picker.applyWidgetUpdate({
    mode: presetMode('acceptEdits'),
    ceiling: presetMode('fullAccess'),
    chain: [
      { id: 'g-root', holderLabel: 'Root' },
      { id: 'g-live', holderLabel: 'UpdatedChat' },
    ],
  });
  await flushPopout();

  assert.equal(picker.getValue(), 'acceptEdits', 'getWidgetValue should reflect updated mode');
  assert.equal(picker.popoutLog?.surface.isOpen, true, 'popout should stay open across applyUpdate');
  assert.ok(
    picker.popoutLog!.draws.length > drawsBefore,
    'applyUpdate while open should repaint popout live',
  );

  const updatedTexts = textCommands(latestPopoutCommands(picker)).map((c) =>
    String(c.params?.text ?? ''),
  );
  assert.equal(
    updatedTexts.filter((t) => t === 'ABOVE CEILING').length,
    0,
    'raising ceiling to fullAccess should clear ABOVE CEILING badges live',
  );
  assert.ok(
    updatedTexts.some((t) => t.includes('UpdatedChat')),
    'footer provenance should update live',
  );

  await picker.applyWidgetUpdate({ maySetMode: false });
  await flushPopout();
  const lockedTexts = textCommands(latestPopoutCommands(picker)).map((c) =>
    String(c.params?.text ?? ''),
  );
  assert.equal(
    lockedTexts.filter((t) => t === 'LOCKED').length,
    6,
    'applyUpdate(maySetMode: false) should repaint all rows as LOCKED',
  );
});
