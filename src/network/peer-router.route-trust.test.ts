/**
 * Route trust: a connected peer may change this peer's routes only through
 * the wire protocol (route announcements and digests), only for itself, and
 * never so as to take over objects reached through another peer.
 *
 * Before this, any connected peer, even one in no workspace whitelist, could
 * call registerRoute/removeRoute on PeerRouter and point another peer's object
 * at itself; this peer's next request to that object, payload and all, went
 * to the stranger.
 *
 * In-process: a real Runtime and PeerRouter with a fake P2P bridge that
 * records what would go on the wire. Remote peers are simulated by feeding
 * handleIncomingMessage, which is where the transport delivers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Runtime } from '../runtime/runtime.js';
import { PeerRouter } from './peer-router.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import type { AbjectId, AbjectManifest, AbjectMessage } from '../core/types.js';

const HUB = 'peer-hub';
const STRANGER = 'peer-stranger';
const RELAY = 'peer-relay';

function manifestFor(name: string): AbjectManifest {
  return {
    name, description: name, version: '1.0.0',
    interface: { id: `test:${name.toLowerCase()}`, name, description: name, methods: [] },
    requiredCapabilities: [], providedCapabilities: [], tags: ['test'],
  } as unknown as AbjectManifest;
}

class Caller extends Abject {
  constructor() { super({ manifest: manifestFor('Caller') }); }
  fire(to: AbjectId, method = 'getOrgPolicy'): Promise<unknown> {
    return this.request(request(this.id, to, method, { secret: 'prompt text' }), 300).catch(() => undefined);
  }
}

interface Wire { peerId: string; to: string; method?: string; type: string }

async function start() {
  const rt = new Runtime();
  await rt.start();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const router = new PeerRouter() as any;
  router.setBus(rt.messageBus);
  await rt.objectFactory.spawnInstance(router);
  rt.messageBus.addInterceptor(router);
  const wire: Wire[] = [];
  router.setP2PBridge({
    sendCustom: (m: { peerId: string; message: AbjectMessage }) => wire.push({
      peerId: m.peerId, to: m.message.routing.to, method: m.message.routing.method, type: m.message.header.type,
    }),
  });
  router.updateConnectedPeers([HUB, STRANGER, RELAY]);
  const caller = new Caller();
  await rt.objectFactory.spawnInstance(caller);
  return { rt, router, wire, caller };
}

const settle = () => new Promise((r) => setTimeout(r, 60));

/** A message as the transport delivers it from `peer`, sent by `fromObject`. */
function fromPeer(router: { handleIncomingMessage(m: AbjectMessage, p: string): void }, peer: string,
  fromObject: string, to: string, method: string, payload: unknown): void {
  router.handleIncomingMessage(request(fromObject as AbjectId, to as AbjectId, method, payload), peer);
}

function announce(router: { id: AbjectId; handleIncomingMessage(m: AbjectMessage, p: string): void }, peer: string,
  payload: Record<string, unknown>): void {
  fromPeer(router, peer, `router-of-${peer}`, router.id, 'handleRouteAnnouncement', { fromPeerId: peer, ...payload });
}

const hubWorkspace = {
  type: 'full',
  workspaceRoutes: [{
    ownerPeerId: HUB, workspaceId: 'org', hops: 0, accessMode: 'shared',
    registryId: 'hub-registry', exposedNames: [], exposedObjectIds: ['hub-object'],
  }],
};

test('peers can call only the route protocol on PeerRouter, not its local route-table methods', async () => {
  const { rt, router } = await start();
  try {
    for (const method of ['registerRoute', 'removeRoute', 'clearRoutesForPeer', 'getRoutes', 'announceRoutes',
      'resolveRemoteObject', 'resolveWorkspaceRegistry', 'forwardToPeer']) {
      assert.equal(router.checkInboundPermission(router.id, STRANGER, 'x', method), false, `${method} is local-only`);
    }
    for (const method of ['handleRouteAnnouncement', 'handleRouteDigest']) {
      assert.equal(router.checkInboundPermission(router.id, STRANGER, 'x', method), true, `${method} is the wire protocol`);
    }
  } finally {
    await rt.stop();
  }
});

test('a stranger can no longer redirect a hub object to itself', async () => {
  const { rt, router, wire, caller } = await start();
  try {
    announce(router, HUB, hubWorkspace);
    await settle();
    assert.equal(router.getRoute('hub-object')?.nextHop, HUB);

    fromPeer(router, STRANGER, 'stranger-obj', router.id, 'removeRoute', { objectId: 'hub-object' });
    fromPeer(router, STRANGER, 'stranger-obj', router.id, 'registerRoute', { objectId: 'hub-object', peerId: STRANGER, hops: 0 });
    fromPeer(router, STRANGER, 'stranger-obj', router.id, 'clearRoutesForPeer', { peerId: HUB });
    await settle();
    assert.equal(router.getRoute('hub-object')?.nextHop, HUB, 'the route is untouched');
    assert.ok(wire.some(w => w.peerId === STRANGER && w.type === 'error'), 'the stranger got ACCESS_DENIED');

    await caller.fire('hub-object' as AbjectId);
    const sent = wire.filter(w => w.to === 'hub-object');
    assert.deepEqual(sent.map(w => w.peerId), [HUB], 'the request went to the hub only');

    // Local objects still manage routes (RemoteRegistry registers discovered objects).
    assert.equal(await router.registerSystemRoute('local-learned', RELAY, 1), true);
  } finally {
    await rt.stop();
  }
});

test('a refused request leaves no reply route; an admitted one does', async () => {
  const { rt, router, caller } = await start();
  try {
    // To a local object no workspace exposes: refused, so 'spoofed-id' gains no route.
    fromPeer(router, STRANGER, 'spoofed-id', caller.id, 'anything', {});
    await settle();
    assert.equal(router.getRoute('spoofed-id'), undefined);

    // The route protocol is admitted, so answers to the remote router can find their way back.
    fromPeer(router, RELAY, 'router-of-relay', router.id, 'handleRouteDigest', { digest: [], fromPeerId: RELAY });
    await settle();
    assert.equal(router.getRoute('router-of-relay')?.nextHop, RELAY);
  } finally {
    await rt.stop();
  }
});

test('announcements: hop counts must be honest and no peer may claim another owner\'s objects', async () => {
  const { rt, router } = await start();
  try {
    announce(router, HUB, hubWorkspace);
    await settle();

    // Negative hops, and hop 0 for a workspace the announcer does not own.
    announce(router, STRANGER, { type: 'full', workspaceRoutes: [
      { ownerPeerId: HUB, workspaceId: 'org', hops: -1, accessMode: 'shared', registryId: 'hub-registry', exposedObjectIds: ['hub-object'] },
    ] });
    announce(router, STRANGER, { type: 'diff', added: [
      { ownerPeerId: 'peer-elsewhere', workspaceId: 'w', hops: 0, accessMode: 'shared', registryId: 'r-elsewhere', exposedObjectIds: ['obj-elsewhere'] },
    ] });
    await settle();
    assert.equal(router.workspaceRoutes.get(`${HUB}/org`)?.nextHop, HUB);
    assert.equal(router.workspaceRoutes.has('peer-elsewhere/w'), false);

    // Its own workspace, listing the hub's object as exposed.
    announce(router, STRANGER, { type: 'full', workspaceRoutes: [
      { ownerPeerId: STRANGER, workspaceId: 'bait', hops: 0, accessMode: 'public', registryId: 'stranger-registry', exposedObjectIds: ['hub-object', 'stranger-object'] },
    ] });
    // A system route for the hub's object.
    announce(router, STRANGER, { type: 'diff', added: [], systemRoutes: [{ objectId: 'hub-object', hops: 0 }] });
    await settle();
    assert.equal(router.getRoute('hub-object')?.nextHop, HUB, 'still the hub');
    assert.equal(router.getRoute('stranger-object')?.nextHop, STRANGER, 'its own objects are mapped');

    // Legacy per-object format with negative hops.
    announce(router, STRANGER, { routes: [{ objectId: 'legacy-obj', hops: -5 }] });
    await settle();
    assert.equal(router.getRoute('legacy-obj'), undefined);

    // An honest relay: another owner's workspace, one hop away, with no better route known.
    announce(router, RELAY, { type: 'diff', added: [
      { ownerPeerId: 'peer-far', workspaceId: 'w', hops: 1, accessMode: 'shared', registryId: 'far-registry', exposedObjectIds: ['far-object'] },
    ] });
    await settle();
    const relayed = router.workspaceRoutes.get('peer-far/w');
    assert.deepEqual([relayed?.nextHop, relayed?.hops], [RELAY, 2]);
    assert.equal(router.getRoute('far-object')?.nextHop, RELAY);
  } finally {
    await rt.stop();
  }
});
