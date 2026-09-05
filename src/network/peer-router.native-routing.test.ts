import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PeerRouter } from './peer-router.js';
import * as M from '../core/message.js';

// Native routing after RemoteAbjectProxy removal.
//
// Harness follows peer-router.p2p2.test.ts: a bare `new PeerRouter()` driven
// through its private surface, NEVER init(bus). onInit() awaits
// discoverDep('PeerRegistry'/'WorkspaceManager'), which with no Registry on the
// bus blocks for the full 30s request timeout, and it starts the anti-entropy
// setTimeout and the propagation-cleanup setInterval, neither unref()'d — so an
// init()-based harness both stalls and keeps node's event loop open forever.

const mkReq = (M as any).createRequest ?? (M as any).request;
const mkEvt = (M as any).createEvent ?? (M as any).event;

function harness(localIds: string[] = []) {
  const r = new PeerRouter() as any;
  const local = new Set(localIds);
  const wire: Array<{ peer: string; msg: any }> = [];

  // The strictly-local predicate is the load-bearing thing this refactor
  // changed, so the test controls it directly rather than inferring it.
  r._messageBus = { isRegistered: (id: string) => local.has(id), send: () => {} };

  // hasPeerAccess is a prototype getter gating every routing path; an own
  // property shadows it so intercept() runs without a live PeerRegistry.
  Object.defineProperty(r, 'hasPeerAccess', { get: () => true, configurable: true });
  r.isPeerConnected = () => true;
  r.sendToPeerTransport = async (peer: string, msg: any) => { wire.push({ peer, msg }); };

  return { r, wire };
}

test('an announced remote route is LEARNED (no stand-in suppresses ingest)', () => {
  const { r } = harness([]);
  r.handleRouteAnnouncementImpl({
    fromPeerId: 'peerA',
    systemRoutes: [{ objectId: 'remote-1', hops: 1 }],
  });
  const route = r.getRoute('remote-1');
  assert.ok(route, 'an announced route for a non-local id must be installed');
  assert.equal(route.nextHop, 'peerA');
});

test('a genuinely local object is still never shadowed by an announcement', () => {
  const { r } = harness(['local-1']);
  r.handleRouteAnnouncementImpl({
    fromPeerId: 'peerA',
    systemRoutes: [{ objectId: 'local-1', hops: 1 }],
  });
  assert.ok(!r.getRoute('local-1'), 'a real local object must never be shadowed by a remote one');
});

test('a domain method to a routed remote id is forwarded over the wire', () => {
  const { r, wire } = harness([]);
  r.handleRouteAnnouncementImpl({
    fromPeerId: 'peerA',
    systemRoutes: [{ objectId: 'remote-1', hops: 1 }],
  });
  assert.equal(r.intercept(mkReq('caller-1', 'remote-1', 'getForecast', {})), 'drop');
  assert.equal(wire.length, 1);
  assert.equal(wire[0].peer, 'peerA');
});

test("'ask' to a remote id crosses the wire instead of being answered locally", () => {
  const { r, wire } = harness([]);
  r.handleRouteAnnouncementImpl({
    fromPeerId: 'peerA',
    systemRoutes: [{ objectId: 'remote-1', hops: 1 }],
  });
  // With no proxy mounted under the remote id, nothing local holds an 'ask'
  // handler that could shadow the forward; routing decides, and it says wire.
  assert.equal(r.intercept(mkReq('caller-1', 'remote-1', 'ask', { query: 'status?' })), 'drop');
  assert.equal(wire.length, 1);
  assert.equal(wire[0].peer, 'peerA');
});

test('a locally registered recipient is delivered locally, never forwarded', () => {
  const { r, wire } = harness(['local-1']);
  assert.equal(r.intercept(mkReq('caller-1', 'local-1', 'ping', {})), 'pass');
  assert.equal(wire.length, 0);
});

test('a pooled object routes via workspaceRoutes + exposedObjectIds', () => {
  const { r, wire } = harness([]);
  r.workspaceRoutes.set('peerA/ws-1', {
    ownerPeerId: 'peerA',
    workspaceId: 'ws-1',
    nextHop: 'peerA',
    hops: 1,
    ttl: Date.now() + 3600_000,
    registryId: 'reg-1',
    exposedObjectIds: ['pooled-1'],
  });
  r.objectToWorkspace.set('pooled-1', 'peerA/ws-1');

  const route = r.getRoute('pooled-1');
  assert.ok(route, 'a pooled id must resolve through the workspace route table');
  assert.equal(route.nextHop, 'peerA');

  assert.equal(r.intercept(mkEvt('caller-1', 'pooled-1', 'tick', {})), 'drop');
  assert.equal(wire.length, 1);
  assert.equal(wire[0].peer, 'peerA');
});
