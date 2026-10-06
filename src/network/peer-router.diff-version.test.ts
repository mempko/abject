/**
 * A route change made while an announcement is being prepared must still be
 * sent. announceRoutesToPeer awaits the peer's workspace routes before
 * sending, and used to record the route version as of after that wait, so a
 * change made during it (a workspace's exposure updated right after it was
 * shared) counted as sent though it never was, and the next diff skipped it:
 * the peer could reach the workspace's registry but not the object exposed a
 * moment later.
 *
 * Run: npx tsx --test src/network/peer-router.diff-version.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PeerRouter } from './peer-router.js';

test('a change made while a diff is prepared is left for the next one', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = new PeerRouter() as any;
  const peer = 'c'.repeat(64);
  const key = 'hub/ws-1';
  const route = (exposed: string[]) => ({ ownerPeerId: 'hub', workspaceId: 'ws-1', hops: 0, accessMode: 'shared', registryId: 'reg', exposedNames: [], exposedObjectIds: exposed });

  Object.defineProperty(r, 'hasPeerAccess', { get: () => true });
  r.isPeerConnected = () => true;
  r.getLocalPeer = () => 'hub';
  r.collectSystemRoutesForPeer = () => [];
  const sent: Array<{ type: string; added: Array<{ exposedObjectIds: string[] }> }> = [];
  r.sendToPeerTransport = async (_p: string, m: { payload: { type: string; added: Array<{ exposedObjectIds: string[] }> } }) => { sent.push(m.payload); };

  r.recordRouteChange('add', key, route(['reg']));
  r.peerAnnounceState.set(peer, { lastVersion: 0, announcedRoutes: new Set() });

  // While the first announcement collects routes, the exposure changes.
  let first = true;
  r.collectWorkspaceRoutesForPeer = async () => {
    if (first) {
      first = false;
      r.recordRouteChange('update', key, route(['reg', 'instance-manager']));
    }
    return [route(['reg', 'instance-manager'])];
  };

  await r.announceRoutesToPeer(peer);
  await r.announceRoutesToPeer(peer);

  assert.equal(sent.length, 2, 'the second announcement still has something to send');
  assert.deepEqual(sent[1].added[0].exposedObjectIds, ['reg', 'instance-manager']);
});

test('a peer added to a workspace whitelist after it was shared is sent the workspace route', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = new PeerRouter() as any;
  const peer = 'e'.repeat(64);
  const route = { ownerPeerId: 'hub', workspaceId: 'ws-org', hops: 0, accessMode: 'shared', registryId: 'reg-org', exposedNames: [], exposedObjectIds: ['instance-manager'] };
  Object.defineProperty(r, 'hasPeerAccess', { get: () => true });
  r.isPeerConnected = () => true;
  r.getLocalPeer = () => 'hub';
  r.collectSystemRoutesForPeer = () => [];
  const sent: Array<{ added: Array<{ workspaceId: string }>; removed: string[] }> = [];
  r.sendToPeerTransport = async (_p: string, m: { payload: { added: Array<{ workspaceId: string }>; removed: string[] } }) => { sent.push(m.payload); };

  // The workspace was shared (and its route recorded) while the peer was not on its whitelist...
  r.recordRouteChange('add', 'hub/ws-org', route);
  r.peerAnnounceState.set(peer, { lastVersion: r.routeVersion, announcedRoutes: new Set() });
  // ...and now it is: the route itself did not change.
  r.collectWorkspaceRoutesForPeer = async () => [route];
  await r.announceRoutesToPeer(peer);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].added.map(a => a.workspaceId), ['ws-org']);

  // Taken off the whitelist again: the route is withdrawn.
  r.collectWorkspaceRoutesForPeer = async () => [];
  await r.announceRoutesToPeer(peer);
  assert.deepEqual(sent[1].removed, ['hub/ws-org']);
});
