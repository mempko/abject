/**
 * The Settings → Grants editor against a real PermissionBroker: each edit the
 * editor can make is sent exactly as the window sends it (grantEditPayload),
 * and the grant is then re-read through listGrants to prove the field moved.
 * A success reply alone is not taken as proof.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Abject, type MessageHandlerFn } from '../core/abject.js';
import { request } from '../core/message.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Registry } from './registry.js';
import { PermissionBroker } from './permission-broker.js';
import {
  GRANT_MODE_SELECT_OPTIONS, presetNameFromSelectValue, grantEditPayload, grantMismatches,
  type GrantRow, type GrantEdit,
} from './global-settings.js';

class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'Grants fixture',
      interface: { id: name, name, description: 'fixture', methods: [] } } });
  }
  public override on(method: string, handler: MessageHandlerFn) { super.on(method, handler); }
  call(to: string, method: string, payload: unknown = {}): Promise<any> { return this.request(request(this.id, to, method, payload), 5000); }
}

async function fixture() {
  const bus = new MessageBus(), registry = new Registry(), objects: Abject[] = [registry];
  await registry.init(bus);
  const add = async <T extends Abject>(object: T): Promise<T> => {
    (object as any).onInit = async () => {};
    object.setRegistryHint(registry.id); await object.init(bus); registry.registerObject(object.id, object.manifest); objects.push(object); return object;
  };
  const workspaces = await add(new Endpoint('WorkspaceManager'));
  workspaces.on('listWorkspacesDetailed', () => []);
  // A built-in object named GlobalSettings: the broker admits it as a settings authority.
  const settings = await add(new Endpoint('GlobalSettings'));
  const changes: string[] = [];
  settings.on('changed', async (m) => { changes.push((m.payload as { aspect: string }).aspect); });
  const broker = await add(new PermissionBroker());
  return { settings, broker, changes,
    async stop() { for (const o of objects.reverse()) await o.stop(); } };
}

async function rootGrant(f: Awaited<ReturnType<typeof fixture>>): Promise<GrantRow> {
  const list = await f.settings.call(f.broker.id, 'listGrants') as GrantRow[];
  const root = list.find(g => !g.parent && g.workspaceId === 'ws1');
  assert.ok(root, 'the root grant is listed');
  return root;
}

/** Send one editor edit and return the grant as the broker lists it afterwards. */
async function applyEdit(f: Awaited<ReturnType<typeof fixture>>, edit: GrantEdit): Promise<GrantRow> {
  const before = await rootGrant(f);
  const built = grantEditPayload(before, edit);
  assert.ok(built.ok, `edit ${edit.field} builds a payload: ${!built.ok ? built.reason : ''}`);
  const r = await f.settings.call(f.broker.id, 'grantMode', built.payload);
  assert.equal(r.success, true, `grantMode accepted ${edit.field}: ${r.error ?? ''}`);
  const after = await rootGrant(f);
  assert.equal(after.id, before.id, 'the root keeps its id');
  assert.deepEqual(grantMismatches(after, built.payload), [], `re-read grant shows the ${edit.field} edit`);
  return after;
}

test('the mode select sends preset names, which grantMode parses', () => {
  assert.deepEqual(GRANT_MODE_SELECT_OPTIONS.map(o => o.value), ['plan', 'manual', 'acceptEdits', 'auto', 'unattended', 'fullAccess']);
  assert.equal(presetNameFromSelectValue('acceptEdits'), 'acceptEdits');
  // Labels, indexes and objects are not what SelectWidget sends any more.
  assert.equal(presetNameFromSelectValue('Accept edits'), undefined);
  assert.equal(presetNameFromSelectValue(2), undefined);
  assert.equal(presetNameFromSelectValue({ value: 'auto' }), undefined);
});

test('every editable grant field lands in the broker and reads back', async () => {
  const f = await fixture();
  try {
    // Start below every edit so each one really changes something.
    const seeded = await f.settings.call(f.broker.id, 'grantMode', { workspaceId: 'ws1', mode: 'manual', ceiling: 'acceptEdits' });
    assert.equal(seeded.success, true);
    let g = await rootGrant(f);
    assert.deepEqual(g.mode, { reach: 'read', beyond: 'ask', readOnly: false });
    assert.deepEqual(g.ceiling, { reach: 'edit', beyond: 'ask' });

    g = await applyEdit(f, { field: 'mode', preset: 'acceptEdits' });
    assert.equal(g.mode.reach, 'edit');

    // Above the ceiling: refused before anything is sent.
    const tooHigh = grantEditPayload(g, { field: 'mode', preset: 'fullAccess' });
    assert.equal(tooHigh.ok, false);

    g = await applyEdit(f, { field: 'ceilingReach', reach: 'full' });
    assert.equal(g.ceiling.reach, 'full');
    g = await applyEdit(f, { field: 'ceilingBeyond', beyond: 'allow' });
    assert.equal(g.ceiling.beyond, 'allow');
    g = await applyEdit(f, { field: 'mode', preset: 'fullAccess' });
    assert.equal(g.mode.reach, 'full');

    // Lowering the ceiling brings the default mode down with it.
    g = await applyEdit(f, { field: 'ceilingReach', reach: 'read' });
    assert.equal(g.ceiling.reach, 'read');
    assert.equal(g.mode.reach, 'read');

    g = await applyEdit(f, { field: 'covers', type: 'outward', on: true });
    assert.ok(g.types?.includes('outward'));
    g = await applyEdit(f, { field: 'covers', type: 'clipboard', on: false });
    assert.ok(!g.types?.includes('clipboard'));

    g = await applyEdit(f, { field: 'mayDerive', levels: 1 });
    assert.equal(g.mayDerive, 1);
    g = await applyEdit(f, { field: 'maySetMode', on: !(g.maySetMode === true) });
    const flipped = g.maySetMode === true;
    g = await applyEdit(f, { field: 'maySetMode', on: !flipped });
    assert.equal(g.maySetMode === true, !flipped);

    // A grant must cover something.
    const only = { ...g, types: ['shell'] };
    assert.equal(grantEditPayload(only, { field: 'covers', type: 'shell', on: false }).ok, false);
  } finally { await f.stop(); }
});

test('a subscribed settings window hears grantsChanged for each edit', async () => {
  const f = await fixture();
  try {
    await f.settings.call(f.broker.id, 'addDependent');
    await f.settings.call(f.broker.id, 'grantMode', { workspaceId: 'ws1', mode: 'manual', ceiling: 'auto' });
    await applyEdit(f, { field: 'mayDerive', levels: 2 });
    for (let i = 0; i < 20 && f.changes.filter(a => a === 'grantsChanged').length < 2; i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(f.changes.filter(a => a === 'grantsChanged').length >= 2, `grantsChanged events seen: ${f.changes.join(', ')}`);
  } finally { await f.stop(); }
});

test('BUG-UI-1: Live grant chains labels child Goal/task grants as task instead of root', async () => {
  const { grantKindLabel, formatGrantChainLines } = await import('./global-settings.js');
  const manual = { reach: 'read' as const, beyond: 'ask' as const, readOnly: false };
  const plan = { reach: 'read' as const, beyond: 'ask' as const, readOnly: true };
  const autoCeiling = { reach: 'edit' as const, beyond: 'allow' as const };

  assert.equal(grantKindLabel({ parent: undefined, conversationId: undefined, taskId: undefined }, 0), 'root');
  assert.equal(grantKindLabel({ parent: 'g-root', conversationId: 'conv-1', taskId: undefined }, 1), 'chat');
  assert.equal(grantKindLabel({ parent: 'g-chat', conversationId: undefined, taskId: undefined }, 2), 'task');
  assert.equal(grantKindLabel({ parent: 'g-goal', conversationId: undefined, taskId: 'task-1' }, 3), 'task');
  assert.equal(grantKindLabel({ parent: 'g-missing', conversationId: undefined, taskId: undefined }, 0), 'task');

  const rows = formatGrantChainLines([
    {
      id: 'g-3ef7b1e0a926',
      holderLabel: 'ChatManager',
      mode: manual,
      effective: manual,
      ceiling: autoCeiling,
      label: 'Manual',
      live: true,
    },
    {
      id: 'g-fb6ec1ef75de',
      parent: 'g-3ef7b1e0a926',
      conversationId: 'conv-1',
      holderLabel: 'Chat Permission modes live test',
      mode: plan,
      effective: plan,
      ceiling: autoCeiling,
      label: 'Plan',
      live: true,
    },
    {
      id: 'g-500572000001',
      parent: 'g-fb6ec1ef75de',
      holderLabel: 'Goal Run the requested shell command',
      mode: manual,
      effective: plan,
      ceiling: autoCeiling,
      label: 'Plan',
      live: true,
    },
  ]);

  assert.equal(rows.length, 3);
  assert.match(rows[0].text, /^▾ root ChatManager \[g-3ef7b1\]/);
  assert.match(rows[1].text, /^    └ chat Chat Permission modes live test \[g-fb6ec1\]/);
  assert.match(rows[2].text, /^        └ task Goal Run the requested shell command \[g-500572\]/);
  assert.doesNotMatch(rows[2].text, /└ root Goal/);
  assert.match(rows[2].text, /← limited by an ancestor or its ceiling$/);
});

test('BUG-UI-2: Live grant chains sizes wrapped lines above 34px and reserves bottom scroll padding', async () => {
  const {
    formatGrantChainLines,
    grantChainLineHeight,
    GRANT_CHAIN_MIN_LINE_HEIGHT,
    GRANT_TAB_BOTTOM_PADDING,
  } = await import('./global-settings.js');
  const manual = { reach: 'read' as const, beyond: 'ask' as const, readOnly: false };
  const plan = { reach: 'read' as const, beyond: 'ask' as const, readOnly: true };
  const auto = { reach: 'edit' as const, beyond: 'allow' as const, readOnly: false };
  const autoCeiling = { reach: 'edit' as const, beyond: 'allow' as const };

  assert.equal(grantChainLineHeight('short line'), GRANT_CHAIN_MIN_LINE_HEIGHT);
  assert.ok(GRANT_TAB_BOTTOM_PADDING >= 24, `expected trailing bottom padding >= 24px, got ${GRANT_TAB_BOTTOM_PADDING}`);

  const rows = formatGrantChainLines([
    { id: 'g-3ef7b100', holderLabel: 'ChatManager', mode: manual, effective: manual, ceiling: autoCeiling, label: 'Manual', live: true },
    { id: 'g-fb6ec100', parent: 'g-3ef7b100', conversationId: 'c1', holderLabel: 'Chat Permission modes live test', mode: plan, effective: plan, ceiling: autoCeiling, label: 'Plan', live: true },
    { id: 'g-50057200', parent: 'g-fb6ec100', holderLabel: 'Goal Run the requested shell command', mode: manual, effective: plan, ceiling: autoCeiling, label: 'Plan', live: true },
    { id: 'g-bada1200', parent: 'g-fb6ec100', holderLabel: 'Goal Create the live plan probe file', mode: plan, effective: plan, ceiling: autoCeiling, label: 'Plan', live: true },
    { id: 'g-5889e000', parent: 'g-3ef7b100', conversationId: 'c2', holderLabel: 'Chat Fresh grant test', mode: manual, effective: manual, ceiling: autoCeiling, label: 'Manual', live: true },
    { id: 'g-9cae1a00', parent: 'g-5889e000', holderLabel: 'Goal Create plan-test.txt in LiveVerifySandbo', mode: plan, effective: plan, ceiling: autoCeiling, label: 'Plan', live: true },
    { id: 'g-a0584e00', parent: 'g-5889e000', holderLabel: 'Goal Create manual-switch-auto.txt in LiveVer', mode: manual, effective: manual, ceiling: autoCeiling, label: 'Manual', live: true },
    { id: 'g-f8a01100', parent: 'g-5889e000', holderLabel: 'Goal Create auto-test.txt in LiveVerifySandbo', mode: auto, effective: manual, ceiling: autoCeiling, label: 'Manual', live: true },
    { id: 'g-b3a6fa00', parent: 'g-5889e000', holderLabel: 'Goal Create deny-stop-test.txt in LiveVerifyS', mode: manual, effective: manual, ceiling: autoCeiling, label: 'Manual', live: true },
  ]);

  assert.equal(rows.length, 9);
  for (const goalRow of [rows[2], rows[3], rows[5], rows[6], rows[7], rows[8]]) {
    assert.match(goalRow.text, /└ task Goal /);
  }
  const ninth = rows[8];
  assert.ok(ninth.height > GRANT_CHAIN_MIN_LINE_HEIGHT, `expected wrapped 9th grant height > 34px, got ${ninth.height}`);
  assert.ok(ninth.height >= 44, `expected 2-line wrapped height >= 44px, got ${ninth.height}`);
  assert.ok(rows[2].height >= 62, `expected 3-line wrapped ancestor-limited height >= 62px, got ${rows[2].height}`);
});
