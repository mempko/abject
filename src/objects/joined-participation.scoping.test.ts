import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceManager, type WorkspaceInfo } from './workspace-manager.js';
import { SharedState } from './capabilities/shared-state.js';
import { PeerRouter } from '../network/peer-router.js';
import type { AbjectId, TypeId } from '../core/types.js';

// Regression cover for the joined-mirror participation split.
//
// A mirror of a remote peer's workspace has to answer two DIFFERENT questions
// with two different answers:
//   * hosting      -- "do I advertise this workspace?"  -> no, it is not mine
//   * participation -- "may this peer message into it?" -> yes, if a member
// Collapsing them either silences P2PChat (mirror stays 'local', nothing syncs)
// or re-advertises someone else's workspace as ours. These tests pin both ends
// and the scoping that must NOT widen in the process.

const id = (s: string) => s as unknown as AbjectId;

function mkWorkspace(o: {
  id: string;
  accessMode?: WorkspaceInfo['accessMode'];
  whitelist?: string[];
  exposedObjectIds?: AbjectId[];
  curated?: boolean;
  childIds?: AbjectId[];
  joined?: boolean;
  ownerPeerId?: string;
  participants?: string[];
}): WorkspaceInfo {
  return {
    id: o.id,
    name: `ws-${o.id}`,
    description: '',
    tags: [],
    accessMode: o.accessMode ?? 'local',
    whitelist: o.whitelist ?? [],
    exposedObjectIds: o.exposedObjectIds ?? [],
    exposedTypeIds: [] as TypeId[],
    curated: o.curated,
    childIds: o.childIds ?? [],
    registryId: id(`reg-${o.id}`),
    storageId: id(`sto-${o.id}`),
    taskbarId: id(`tb-${o.id}`),
    uiObjects: [],
    childTypeIds: new Map<AbjectId, TypeId>(),
    uiSpawned: false,
    joined: o.joined,
    ownerPeerId: o.ownerPeerId,
    participants: o.participants,
  };
}

function managerWith(...workspaces: WorkspaceInfo[]): any {
  const wm = new WorkspaceManager() as any;
  for (const ws of workspaces) wm.workspaces.set(ws.id, ws);
  return wm;
}

// ── WorkspaceManager: hosting vs participation ──────────────────────────────

test('a joined mirror reports participation access (shared + owner/participants)', () => {
  const wm = managerWith(mkWorkspace({
    id: 'mirror',
    accessMode: 'local',
    joined: true,
    ownerPeerId: 'peer-owner',
    participants: ['peer-me', 'peer-friend'],
    childIds: [id('chat-1')],
  }));

  const found = wm.findWorkspaceForObject(id('chat-1'));
  assert.ok(found, 'the mirror\u2019s child object resolves to its workspace');
  assert.equal(found.accessMode, 'shared', 'participation view is shared, not local');
  assert.equal(found.joined, true);
  assert.deepEqual(
    [...found.whitelist].sort(),
    ['peer-friend', 'peer-me', 'peer-owner'],
    'whitelist is exactly owner \u222a participants',
  );
});

test('a joined mirror still reports HOSTING access to the route-announcement view', () => {
  const wm = managerWith(mkWorkspace({
    id: 'mirror',
    accessMode: 'local',
    joined: true,
    ownerPeerId: 'peer-owner',
    participants: ['peer-me'],
  }));

  const [detailed] = wm.listWorkspacesDetailed();
  assert.equal(detailed.accessMode, 'local', 'hosting view must stay local so it is never advertised');
  assert.equal(detailed.joined, true, 'and it is explicitly flagged as a mirror');
});

test('participation never widens a mirror to public', () => {
  const wm = managerWith(mkWorkspace({
    id: 'mirror',
    accessMode: 'local',
    joined: true,
    ownerPeerId: 'peer-owner',
    participants: ['peer-me'],
    childIds: [id('chat-1')],
  }));

  const found = wm.findWorkspaceForObject(id('chat-1'));
  assert.notEqual(found.accessMode, 'public');
  assert.ok(found.whitelist.length > 0, 'shared access with an empty whitelist would admit nobody, not everybody');
});

test('a mirror with no owner and no participants admits nobody', () => {
  const wm = managerWith(mkWorkspace({
    id: 'orphan', accessMode: 'local', joined: true, childIds: [id('chat-1')],
  }));

  const found = wm.findWorkspaceForObject(id('chat-1'));
  assert.equal(found.accessMode, 'shared');
  assert.deepEqual(found.whitelist, [], 'no members \u2192 empty whitelist \u2192 every peer denied');
});

test('the owner is not duplicated when it also appears in participants', () => {
  const wm = managerWith(mkWorkspace({
    id: 'mirror',
    accessMode: 'local',
    joined: true,
    ownerPeerId: 'peer-owner',
    participants: ['peer-owner', 'peer-me'],
    childIds: [id('chat-1')],
  }));

  const { whitelist } = wm.findWorkspaceForObject(id('chat-1'));
  assert.equal(whitelist.length, new Set(whitelist).size, 'whitelist is deduplicated');
});

test('a genuinely local workspace is untouched by the participation split', () => {
  const wm = managerWith(mkWorkspace({ id: 'private', accessMode: 'local', childIds: [id('secret')] }));

  const found = wm.findWorkspaceForObject(id('secret'));
  assert.equal(found.accessMode, 'local', 'not joined \u2192 stays local \u2192 PeerRouter hard-denies');
  assert.equal(found.joined, false);
});

test('a hosted shared workspace keeps its own whitelist', () => {
  const wm = managerWith(mkWorkspace({
    id: 'hosted', accessMode: 'shared', whitelist: ['peer-a'], childIds: [id('obj-1')],
  }));

  const found = wm.findWorkspaceForObject(id('obj-1'));
  assert.equal(found.accessMode, 'shared');
  assert.deepEqual(found.whitelist, ['peer-a'], 'hosting whitelist is passed through unchanged');
});

// ── PeerRouter: a mirror is never announced ─────────────────────────────────

function routerAnnouncing(workspaces: any[]): any {
  const r = new PeerRouter() as any;
  r.localPeerIdCache = 'peer-local';
  r.workspaceManagerId = id('wm');
  r.request = async () => workspaces;
  return r;
}

test('a joined mirror is never announced as a route, whatever access mode it carries', async () => {
  const r = routerAnnouncing([
    // Hosting view of a mirror: 'local' today...
    { workspaceId: 'mirror-local', name: 'm1', accessMode: 'local', joined: true, registryId: id('reg-1') },
    // ...and the belt-and-braces case, should the mode ever drift.
    { workspaceId: 'mirror-public', name: 'm2', accessMode: 'public', joined: true, registryId: id('reg-2') },
    {
      workspaceId: 'mirror-shared', name: 'm3', accessMode: 'shared', joined: true,
      whitelist: ['peer-remote'], registryId: id('reg-3'),
    },
  ]);

  const routes = await r.collectWorkspaceRoutesForPeer('peer-remote');
  assert.deepEqual(routes, [], 'we mirror these workspaces, we do not host them');
});

test('a hosted workspace is still announced (the guard is not a blanket mute)', async () => {
  const r = routerAnnouncing([
    { workspaceId: 'pub', name: 'p', accessMode: 'public', registryId: id('reg-pub'), exposedObjectIds: [id('reg-pub')] },
    { workspaceId: 'shd', name: 's', accessMode: 'shared', whitelist: ['peer-remote'], registryId: id('reg-shd') },
    { workspaceId: 'other', name: 'o', accessMode: 'shared', whitelist: ['peer-else'], registryId: id('reg-oth') },
    { workspaceId: 'priv', name: 'v', accessMode: 'local', registryId: id('reg-prv') },
  ]);

  const routes = await r.collectWorkspaceRoutesForPeer('peer-remote');
  assert.deepEqual(
    routes.map((x: any) => x.workspaceId).sort(),
    ['pub', 'shd'],
    'public + whitelisted-shared announced; another peer\u2019s share and a private workspace are not',
  );
  assert.ok(routes.every((x: any) => x.ownerPeerId === 'peer-local'));
});

// ── PeerRouter: the two permission gates ────────────────────────────────────

function entry(o: Partial<any>): any {
  return {
    workspaceId: 'ws',
    accessMode: 'shared',
    whitelist: [],
    exposedObjectIds: [],
    exposedTypeIds: [],
    exposedNames: [],
    cachedAt: Date.now(),
    ...o,
  };
}

test('participation access admits a mirror member and refuses a stranger', () => {
  const r = new PeerRouter() as any;
  // Exactly what findWorkspaceForObject now feeds the permission cache for a mirror.
  const mirror = entry({
    accessMode: 'shared',
    whitelist: ['peer-owner', 'peer-me'],
    exposedObjectIds: [id('shared-state-1'), id('reg-mirror')],
  });

  assert.equal(r.evaluatePermission(mirror, 'peer-owner', id('shared-state-1')), true);
  assert.equal(r.evaluatePermission(mirror, 'peer-stranger', id('shared-state-1')), false);
});

test('accessMode local is a hard deny regardless of curation', () => {
  const r = new PeerRouter() as any;
  const local = entry({
    accessMode: 'local',
    whitelist: ['peer-a'],
    exposedObjectIds: [id('obj-1')],
  });

  assert.equal(r.evaluatePermission(local, 'peer-a', id('obj-1')), false);
});

test('the curation gate still denies when nothing is exposed', () => {
  const r = new PeerRouter() as any;
  const uncurated = entry({ accessMode: 'shared', whitelist: ['peer-a'] });

  assert.equal(
    r.evaluatePermission(uncurated, 'peer-a', id('obj-1')), false,
    'passing the access gate is not enough \u2014 nothing curated means deny',
  );
});

test('the curation gate denies a target outside the exposed set', () => {
  const r = new PeerRouter() as any;
  const curated = entry({
    accessMode: 'shared', whitelist: ['peer-a'], exposedObjectIds: [id('obj-1')],
  });

  assert.equal(r.evaluatePermission(curated, 'peer-a', id('obj-1')), true);
  assert.equal(r.evaluatePermission(curated, 'peer-a', id('obj-2')), false);
});

// ── SharedState: the dispatch that carries P2PChat ──────────────────────────

function sharedStateSpy(): { ss: any; discoveries: () => number } {
  const ss = new SharedState() as any;
  let n = 0;
  ss.scheduleDiscovery = () => { n += 1; };
  return { ss, discoveries: () => n };
}

async function dispatchAccessMode(ss: any, payload: Record<string, unknown>): Promise<void> {
  const handler = ss.handlers.get('setAccessMode');
  assert.ok(handler, 'setAccessMode is a registered handler');
  await handler({ payload });
}

test('a shared -> shared dispatch with a widened whitelist re-arms discovery', async () => {
  const { ss, discoveries } = sharedStateSpy();

  await dispatchAccessMode(ss, { accessMode: 'shared', whitelist: ['peer-owner'] });
  const afterFirst = discoveries();

  // The mirror case: restore / re-join / participant change dispatches shared
  // again with more members. Gating on the local->shared transition alone left
  // this silent, which is what stopped P2PChat replicating.
  await dispatchAccessMode(ss, { accessMode: 'shared', whitelist: ['peer-owner', 'peer-new'] });

  assert.ok(discoveries() > afterFirst, 'the second dispatch scheduled discovery too');
  assert.deepEqual(ss._whitelist, ['peer-owner', 'peer-new']);
});

test('local -> shared still arms discovery', async () => {
  const { ss, discoveries } = sharedStateSpy();
  await dispatchAccessMode(ss, { accessMode: 'shared', whitelist: ['peer-a'] });
  assert.equal(discoveries(), 1);
});

test('going local clears remote peers and does not schedule discovery', async () => {
  const { ss, discoveries } = sharedStateSpy();
  await dispatchAccessMode(ss, { accessMode: 'shared', whitelist: ['peer-a'] });
  ss.remotePeers.set('r1', id('r1'));
  ss.remotePeerOwners.set('r1', 'peer-a');
  const armed = discoveries();

  await dispatchAccessMode(ss, { accessMode: 'local' });

  assert.equal(ss.remotePeers.size, 0, 'a local workspace syncs with nobody');
  assert.equal(ss.remotePeerOwners.size, 0);
  assert.equal(discoveries(), armed, 'no discovery scheduled while local');
});

test('tightening the whitelist prunes peers that are no longer members', async () => {
  const { ss } = sharedStateSpy();
  ss.localPeerId = 'peer-me';
  ss.remotePeers.set('r-keep', id('r-keep'));
  ss.remotePeerOwners.set('r-keep', 'peer-a');
  ss.remotePeers.set('r-drop', id('r-drop'));
  ss.remotePeerOwners.set('r-drop', 'peer-b');
  ss.remotePeers.set('r-mine', id('r-mine'));
  ss.remotePeerOwners.set('r-mine', 'peer-me');

  await dispatchAccessMode(ss, { accessMode: 'shared', whitelist: ['peer-a'] });

  assert.deepEqual(
    [...ss.remotePeers.keys()].sort(),
    ['r-keep', 'r-mine'],
    'the de-whitelisted peer is dropped immediately; our own state stays',
  );
});
