/**
 * A peer that restarts under the same identity comes back with no routes, but
 * PeerRouter still remembered what it had announced to the previous run and
 * answered the new connection with a diff against it. The peer then had no
 * base routes and could not reach objects in the workspaces shared with it
 * (RECIPIENT_NOT_FOUND) until an anti-entropy round happened to pick it. Every
 * new connection must start from a full announcement.
 *
 * Run: npx tsx --test src/network/peer-router.reconnect-full.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PeerRouter } from './peer-router.js';
import type { AbjectMessage } from '../core/types.js';

test('a (re)connected peer is announced to from scratch, not with a diff', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const router = new PeerRouter() as any;
  const peer = 'b'.repeat(64);
  router.peerAnnounceState.set(peer, { lastVersion: 7, announcedRoutes: new Set(['hub/ws-1']) });
  const seen: boolean[] = [];
  router.announceRoutesToPeer = async (p: string) => { seen.push(router.peerAnnounceState.has(p)); return true; };

  const changed = router.handlers.get('changed') as (m: AbjectMessage) => Promise<unknown>;
  await changed({ payload: { aspect: 'contactConnected', value: { peerId: peer } }, routing: { from: 'reg', to: 'router' }, header: { type: 'event' } } as unknown as AbjectMessage);

  assert.deepEqual(seen, [false], 'the remembered announce state is gone when the announcement goes out, so it is a full one');
});

test('a peer announcing a new boot id gets every route again; the same boot id does not', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const router = new PeerRouter() as any;
  const peer = 'd'.repeat(64);
  const resent: boolean[] = [];
  router.announceRoutesToPeer = async (p: string) => { resent.push(router.peerAnnounceState.has(p)); return true; };
  const announce = (bootId: string) => router.handleRouteAnnouncementImpl({ type: 'diff', added: [], removed: [], fromPeerId: peer, bootId, systemRoutes: [] });

  announce('run-1');
  router.peerAnnounceState.set(peer, { lastVersion: 5, announcedRoutes: new Set(['hub/ws-1']) });
  announce('run-1');
  assert.deepEqual(resent, [], 'nothing to resend while the peer keeps running');
  announce('run-2');
  assert.deepEqual(resent, [false], 'a restarted peer is announced to from scratch');
});
