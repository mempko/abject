/**
 * A peer added to a shared workspace's whitelist after the workspace was
 * shared must be able to discover it. WorkspaceShareRegistry caches each
 * shared workspace from the `workspaceShared` event; a later whitelist change
 * arrives as `workspaceAccessChanged`, and before this was handled the cache
 * kept the original whitelist, so discovery answered the new peer with
 * nothing even though PeerRouter would have admitted it.
 *
 * Run: npx tsx --test src/objects/workspace-share-registry.access-change.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkspaceShareRegistry } from './workspace-share-registry.js';
import type { AbjectMessage } from '../core/types.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function changed(aspect: string, value: unknown): AbjectMessage {
  return { payload: { aspect, value }, routing: { from: 'wm', to: 'wsr' }, header: { type: 'event' } } as unknown as AbjectMessage;
}

function subject() {
  const wsr = new WorkspaceShareRegistry();
  const any = wsr as unknown as {
    handlers: Map<string, (m: AbjectMessage) => Promise<unknown>>;
    localShared: Map<string, unknown>;
    filterWorkspacesForPeer(peerId: string): Array<{ name: string }>;
    ensureRegistrySubscription(): Promise<void>;
  };
  any.ensureRegistrySubscription = async () => {};
  return {
    send: (aspect: string, value: unknown) => any.handlers.get('changed')!(changed(aspect, value)),
    visibleTo: (peerId: string) => any.filterWorkspacesForPeer(peerId).map(w => w.name),
  };
}

test('a peer whitelisted after sharing discovers the workspace', async () => {
  const s = subject();
  await s.send('workspaceShared', { workspaceId: 'w1', name: 'Team', accessMode: 'shared', whitelist: [A], exposedObjectIds: [] });
  assert.deepEqual(s.visibleTo(B), []);
  await s.send('workspaceAccessChanged', { workspaceId: 'w1', accessMode: 'shared', whitelist: [A, B], exposedObjectIds: [] });
  assert.deepEqual(s.visibleTo(B), ['Team']);
  await s.send('workspaceAccessChanged', { workspaceId: 'w1', accessMode: 'shared', whitelist: [A], exposedObjectIds: [] });
  assert.deepEqual(s.visibleTo(B), [], 'and stops seeing it once taken off again');
  assert.deepEqual(s.visibleTo(A), ['Team']);
});

test('an access change for a workspace that was never shared adds nothing', async () => {
  const s = subject();
  await s.send('workspaceAccessChanged', { workspaceId: 'w2', accessMode: 'shared', whitelist: [B] });
  assert.deepEqual(s.visibleTo(B), []);
});
