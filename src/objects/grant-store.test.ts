import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrantStore } from './grant-store.js';
import { presetMode, presetOf, meetMode, modeLabel } from '../core/permission-modes.js';

function setup() {
  const store = new GrantStore();
  const root = store.mintRoot({
    holder: 'cm', holderLabel: 'ChatManager', workspaceId: 'ws1',
    mode: presetMode('manual')!, ceiling: { reach: 'full', beyond: 'ask' },
  });
  const chat = store.derive(root.id, 'cm', { holder: 'chat1', conversationId: 'conv1' });
  assert.ok(chat.ok);
  return { store, root, chat: chat.value };
}

test('presets round-trip and Unattended keeps any reach', () => {
  for (const name of ['plan', 'manual', 'acceptEdits', 'auto', 'fullAccess'] as const) {
    assert.equal(presetOf(presetMode(name)!), name);
  }
  assert.equal(presetOf({ reach: 'read', beyond: 'deny', readOnly: false }), 'unattended');
  assert.equal(modeLabel(presetMode('acceptEdits')!), 'Accept edits');
  assert.deepEqual(meetMode(presetMode('auto')!, presetMode('plan')!), { reach: 'read', beyond: 'ask', readOnly: true });
});

test('a chat grant derives from the root with the root mode', () => {
  const { store, chat } = setup();
  assert.equal(store.effective(chat).reach, 'read');
  assert.equal(store.chain(chat).length, 2);
  assert.equal(store.findFor('chat1')?.id, chat.id);
});

test('only the holder derives, and never wider than the ceiling', () => {
  const { store, root } = setup();
  const stolen = store.derive(root.id, 'intruder', { holder: 'x' });
  assert.equal(stolen.ok, false);
  assert.equal(!stolen.ok && stolen.error, 'grant not held by caller');
  const wide = store.derive(root.id, 'cm', { holder: 'x', mode: 'fullAccess' });
  assert.equal(wide.ok, false);
});

test('a holder raises its mode only up to its ceiling', () => {
  const { store, chat } = setup();
  assert.ok(store.setMode(chat.id, 'chat1', 'auto').ok);
  assert.equal(store.setMode(chat.id, 'chat1', 'fullAccess').ok, false);
  assert.equal(store.setMode(chat.id, 'someone-else', 'plan').ok, false);
});

test('an agent task grant may only be lowered', () => {
  const { store, chat } = setup();
  assert.ok(store.setMode(chat.id, 'chat1', 'acceptEdits').ok);
  const task = store.derive(chat.id, 'chat1', { holder: 'agent1', taskId: 't1' });
  assert.ok(task.ok);
  const raised = store.setMode(task.value.id, 'agent1', 'auto');
  assert.equal(!raised.ok && raised.error, 'an agent may only lower its mode');
  assert.ok(store.setMode(task.value.id, 'agent1', 'plan').ok);
  assert.equal(store.findFor('agent1', 't1')?.id, task.value.id);
});

test('lowering or revoking an ancestor narrows every descendant at once', () => {
  const { store, root, chat } = setup();
  assert.ok(store.setMode(chat.id, 'chat1', 'auto').ok);
  // Work the chat started follows it live; an explicit task mode does not rise with it.
  const goal = store.derive(chat.id, 'chat1', { holder: 'gm', inherit: true });
  assert.ok(goal.ok);
  const task = store.derive(goal.value.id, 'gm', { holder: 'agent1', taskId: 't1', inherit: true });
  assert.ok(task.ok);
  assert.equal(store.effective(task.value).reach, 'full');
  assert.ok(store.setMode(chat.id, 'chat1', 'plan').ok);
  assert.equal(store.effective(task.value).readOnly, true);
  assert.equal(store.effective(task.value).reach, 'read');
  assert.ok(store.setMode(chat.id, 'chat1', 'acceptEdits').ok);
  assert.equal(store.effective(task.value).reach, 'edit', 'raising the chat raises its running work');
  // The root's mode is only the default for new chats: it does not move this one.
  assert.ok(store.setMode(root.id, 'cm', 'plan').ok);
  assert.equal(store.effective(chat).reach, 'edit');
  store.revokeTree(root.id);
  assert.equal(store.live(chat), false);
  assert.equal(store.findFor('chat1'), undefined);
});

test('task grants are never persisted; chat grants reload', () => {
  const { store, chat } = setup();
  const task = store.derive(chat.id, 'chat1', { holder: 'agent1', taskId: 't1' });
  assert.ok(task.ok);
  const saved = store.serialize();
  assert.equal(saved.some(g => g.taskId), false);
  const reloaded = new GrantStore();
  reloaded.load(JSON.parse(JSON.stringify(saved)));
  assert.equal(reloaded.forConversation('conv1')?.id, chat.id);
});
