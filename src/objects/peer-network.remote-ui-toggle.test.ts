/**
 * The "Enable remote UI" checkbox in Peer Network, proven against the real
 * objects (#36).
 *
 * The Registry, the CheckboxWidget, PeerNetwork and RemoteUIAccess are the
 * real objects on a real bus, and the checkbox is clicked, and toggled with
 * Space, through its own input handler. The stand-ins are Storage (a Map),
 * the WidgetManager that PeerNetwork's onInit asks for, a Person endpoint that
 * sends the input and serves as the checkbox's UI server, and the signaling
 * server: a `ws` server on 127.0.0.1 that records who is connected and
 * registered, so the test never reaches the public one. The window is not
 * built, so the test makes the two links its Frontends tab makes
 * (peer-network.ts:2296-2297).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, type WebSocket } from 'ws';
import { Abject, type MessageHandlerFn } from '../core/abject.js';
import { MessageBus } from '../runtime/message-bus.js';
import { request } from '../core/message.js';
import type { AbjectId, InterfaceId } from '../core/types.js';
import { Registry } from './registry.js';
import { CheckboxWidget } from './widgets/checkbox-widget.js';
import { PeerNetwork } from './peer-network.js';
import { RemoteUIAccess } from './remote-ui-access.js';

class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'Remote UI fixture',
      interface: { id: `fixture:${name}` as InterfaceId, name, description: 'fixture', methods: [] } } });
  }

  public override on(method: string, fn: MessageHandlerFn): void { super.on(method, fn); }
  call<T = any>(to: AbjectId, method: string, payload: unknown = {}): Promise<T> { return this.request<T>(request(this.id, to, method, payload), 3000); }
}

/** A signaling server that only records who is connected and who registered. */
async function signaling() {
  const sockets = new Set<WebSocket>();
  const registered: string[] = [];
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => wss.once('listening', () => resolve()));
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { type?: string; name?: string };
      if (msg.type === 'register' && msg.name) registered.push(msg.name);
    });
    ws.on('close', () => sockets.delete(ws));
  });
  const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
  const close = () => new Promise<void>(resolve => {
    for (const ws of sockets) ws.terminate();
    wss.close(() => resolve());
  });
  return { url, sockets, registered, close };
}

async function world(signalingUrl: string) {
  // RemoteUIAccess reads this ahead of Storage and the public default (loadConfig).
  const previousUrl = process.env.REMOTE_UI_SIGNALING_URL;
  process.env.REMOTE_UI_SIGNALING_URL = signalingUrl;

  const bus = new MessageBus();
  const registry = new Registry();
  const objects: Abject[] = [];
  const stop = async () => {
    for (const o of objects.reverse()) { try { await o.stop(); } catch { /* already stopped */ } }
    try { await registry.stop(); } catch { /* not started */ }
    if (previousUrl === undefined) delete process.env.REMOTE_UI_SIGNALING_URL;
    else process.env.REMOTE_UI_SIGNALING_URL = previousUrl;
  };
  try {
    await registry.init(bus);
    const add = async <T extends Abject>(o: T): Promise<T> => {
      o.setRegistryHint(registry.id); await o.init(bus); registry.registerObject(o.id, o.manifest); objects.push(o); return o;
    };

    const store = new Map<string, unknown>();
    const storage = await add(new Endpoint('Storage'));
    storage.on('get', (msg: any) => store.get(msg.payload.key) ?? null);
    storage.on('set', (msg: any) => { store.set(msg.payload.key, msg.payload.value); return true; });
    await add(new Endpoint('WidgetManager'));
    const remote = await add(new RemoteUIAccess());
    const network = await add(new PeerNetwork());
    const person = await add(new Endpoint('Person'));
    const checkbox = await add(new CheckboxWidget({
      type: 'checkbox', rect: { x: 0, y: 0, width: 200, height: 28 },
      text: 'Enable remote UI (phone access via WebRTC)', checked: false,
      ownerId: network.id, uiServerId: person.id,
    }));
    (network as any).remoteEnableCheckboxId = checkbox.id;
    await (network as any).request(request(network.id, checkbox.id, 'addDependent', {}));

    const click = () => person.call(checkbox.id, 'handleInput', { type: 'mousedown', x: 5, y: 5 });
    const space = async () => {
      await person.call(checkbox.id, 'setFocused', { focused: true, via: 'keyboard' });
      await person.call(checkbox.id, 'handleInput', { type: 'keydown', key: ' ' });
    };
    const enabled = async () => (await person.call<{ enabled: boolean }>(remote.id, 'getStatus')).enabled;
    const shown = () => person.call<string>(checkbox.id, 'getValue');
    return { store, click, space, enabled, shown, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** Wait up to 3 s for `done`, the toggle's work being asynchronous; fail naming what never happened. */
async function until(what: string, done: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await done())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting until ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

test('unticking "Enable remote UI" turns remote UI off, stores it, and leaves signaling', async () => {
  const server = await signaling();
  try {
    const w = await world(server.url);
    try {
      const on = async (how: string) => {
        await until(`remote UI is on after ${how}`, async () => await w.enabled() && server.sockets.size === 1);
        assert.equal(await w.shown(), 'true');
        assert.equal(w.store.get('remote-ui:enabled'), 'true', `${how}: stored on`);
      };
      const off = async (how: string) => {
        await until(`remote UI is off after ${how}`, async () => !(await w.enabled()) && server.sockets.size === 0);
        assert.equal(await w.shown(), 'false');
        assert.equal(w.store.get('remote-ui:enabled'), 'false', `${how}: stored off, so the next start stays off`);
      };

      await w.click();
      await on('a click');
      await until('the UI bridge registers', () => server.registered.length === 1);
      assert.deepEqual(server.registered, ['ui-bridge:abjects'], 'it registers on signaling as the UI bridge');

      await w.click();
      await off('a second click');

      await w.space();
      await on('Space');
      await w.space();
      await off('Space again');
    } finally {
      await w.stop();
    }
  } finally {
    await server.close();
  }
});
