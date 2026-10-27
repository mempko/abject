import test from 'node:test';
import assert from 'node:assert/strict';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId } from '../core/types.js';
import { forkConversationEntries } from '../core/conversation-context.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Registry } from './registry.js';
import { ChatManager } from './chat-manager.js';

/** Minimal bus peer that can call and be called. */
class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'fork test fixture',
      interface: { id: `fixture:${name}`, name, description: 'fixture', methods: [] } } });
  }
  call(to: AbjectId, method: string, payload: unknown = {}): Promise<any> {
    return this.request(request(this.id, to, method, payload), 5000);
  }
}

/** The slice of Storage a conversation uses: get / set / delete by key. */
class Store extends Endpoint {
  values = new Map<string, unknown>();
  constructor(name: string) {
    super(name);
    const key = (p: any) => `${p.name ?? ''}:${p.key}`;
    this.on('set', m => { const p = m.payload as any; this.values.set(key(p), structuredClone(p.value)); return true; });
    this.on('get', m => structuredClone(this.values.get(key(m.payload)) ?? null));
    this.on('delete', m => { this.values.delete(key(m.payload)); return true; });
  }
}

/** A Factory that hands out a stable id per spawn, so the fork's Chat is identifiable. */
class Factory extends Endpoint {
  spawned: Array<{ typeId?: string; constructorArgs?: { conversationId?: string } }> = [];
  constructor() {
    super('Factory');
    this.on('spawn', m => {
      const payload = m.payload as any;
      this.spawned.push({ typeId: payload?.typeId, constructorArgs: payload?.constructorArgs });
      return { objectId: `chat:${payload?.constructorArgs?.conversationId}` as AbjectId, typeId: payload?.typeId };
    });
    this.on('kill', () => true);
  }
}

class Chats extends ChatManager { protected override async onInit(): Promise<void> {} }

async function fixture() {
  const registry = new Registry(), bus = new MessageBus(), objects: Abject[] = [registry];
  await registry.init(bus);
  const add = async <T extends Abject>(o: T) => {
    o.setRegistryHint(registry.id); await o.init(bus);
    registry.registerObject(o.id, o.manifest); objects.push(o); return o;
  };
  const storage = await add(new Store('Storage'));
  const factory = await add(new Factory());
  const client = await add(new Endpoint('Client'));
  const chats: any = await add(new Chats());
  chats.storageId = storage.id;
  chats.factoryId = factory.id;
  chats.registryId = registry.id;
  chats.conversations.set('source', {
    conversationId: 'source', title: 'A conversation', createdAt: 1, lastActiveAt: 1,
  });
  return {
    client, storage, factory, chats,
    async stop() { for (const o of objects.reverse()) await o.stop(); },
  };
}

const HISTORY = [
  { id: 'm1', role: 'user' as const, content: 'first question' },
  { id: 'm2', role: 'assistant' as const, content: 'first answer' },
  { id: 'm3', role: 'user' as const, content: 'second question' },
  { id: 'm4', role: 'assistant' as const, content: 'second answer' },
];

test('fork keeps the entries through the chosen message, and only those', () => {
  const forked = forkConversationEntries('c1', HISTORY, 'm2');
  assert.deepEqual(forked.map(e => e.id), ['m1', 'm2']);
  assert.equal(forked[1].content, 'first answer');
});

test('fork copies rows rather than sharing them with the original', () => {
  const forked = forkConversationEntries('c1', HISTORY, 'm4');
  assert.equal(forked.length, 4);
  assert.notEqual(forked[0], HISTORY[0]);
  forked[0].content = 'changed in the copy';
  assert.equal(HISTORY[0].content, 'first question');
});

test('fork names the boundary message it cannot find', () => {
  assert.throws(() => forkConversationEntries('c1', HISTORY, 'nope'), /unavailable/);
});

test('forking a conversation creates a new one ending at that message, original untouched', async () => {
  const f = await fixture();
  try {
    await f.client.call(f.storage.id, 'set', { key: 'chats:history:source', value: HISTORY });
    const fork = await f.client.call(f.chats.id, 'forkConversation', {
      conversationId: 'source', throughMessageId: 'm2', show: false,
    });

    // A new conversation, distinct from the one it came from.
    assert.equal(typeof fork.conversationId, 'string');
    assert.notEqual(fork.conversationId, 'source');
    assert.ok(f.chats.conversations.has(fork.conversationId), 'the fork is on the roster');

    // Its transcript ends at (and includes) the message that was forked.
    const forkedHistory = await f.client.call(f.storage.id, 'get', {
      key: `chats:history:${fork.conversationId}`,
    });
    assert.deepEqual(forkedHistory.map((e: any) => e.id), ['m1', 'm2']);
    assert.deepEqual(forkedHistory.map((e: any) => e.content), ['first question', 'first answer']);

    // The original is exactly as it was.
    const sourceHistory = await f.client.call(f.storage.id, 'get', { key: 'chats:history:source' });
    assert.deepEqual(sourceHistory.map((e: any) => e.id), ['m1', 'm2', 'm3', 'm4']);
    assert.equal(f.chats.conversations.get('source').title, 'A conversation');

    // The fork's own Chat was started, with the fork's conversation id.
    const spawn = f.factory.spawned.find(s => s.constructorArgs?.conversationId === fork.conversationId);
    assert.ok(spawn, 'a Chat was spawned for the fork');
    assert.equal(fork.chatId, `chat:${fork.conversationId}`);
  } finally { await f.stop(); }
});

test('a forked conversation is a normal conversation that carries on from the fork point', async () => {
  const f = await fixture();
  try {
    await f.client.call(f.storage.id, 'set', { key: 'chats:history:source', value: HISTORY });
    const fork = await f.client.call(f.chats.id, 'forkConversation', {
      conversationId: 'source', throughMessageId: 'm2', show: false,
    });

    // Reading its saved history back through the ordinary accessor works.
    const saved = await f.client.call(f.chats.id, 'getHistory', { conversationId: fork.conversationId });
    assert.deepEqual(saved.map((e: any) => e.id), ['m1', 'm2']);

    // The next turn appends to the fork, and the context it would hand the
    // agent runs from the conversation's start through that new message.
    await f.client.call(f.storage.id, 'set', {
      key: `chats:history:${fork.conversationId}`,
      value: [...saved, { id: 'm3b', role: 'user', content: 'carry on from here' }],
    });
    const context = await f.client.call(f.chats.id, 'getConversationContext', {
      conversationId: fork.conversationId, throughMessageId: 'm3b',
    });
    assert.deepEqual(context.messages.map((m: any) => m.id), ['m1', 'm2', 'm3b']);
    assert.equal(context.throughMessageId, 'm3b');

    // And the original still ends where it always did.
    const sourceContext = await f.client.call(f.chats.id, 'getConversationContext', {
      conversationId: 'source', throughMessageId: 'm4',
    });
    assert.deepEqual(sourceContext.messages.map((m: any) => m.id), ['m1', 'm2', 'm3', 'm4']);
  } finally { await f.stop(); }
});

test('forking at a message the conversation does not have adds nothing', async () => {
  const f = await fixture();
  try {
    await f.client.call(f.storage.id, 'set', { key: 'chats:history:source', value: HISTORY });
    const before = f.chats.conversations.size;
    await assert.rejects(
      f.client.call(f.chats.id, 'forkConversation', { conversationId: 'source', throughMessageId: 'missing', show: false }),
      /unavailable/i,
    );
    assert.equal(f.chats.conversations.size, before, 'no conversation was added');
    const sourceHistory = await f.client.call(f.storage.id, 'get', { key: 'chats:history:source' });
    assert.deepEqual(sourceHistory.map((e: any) => e.id), ['m1', 'm2', 'm3', 'm4']);
  } finally { await f.stop(); }
});
