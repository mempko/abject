/**
 * P0 workspace-registry scoping tests.
 *
 *   P0-1  filterForCaller bypass closure — a caller wearing a remote identity
 *         (routed pooled id, mailboxed catalog id, ownerPeerId-stamped entry) is
 *         never treated as local, even though it holds a mailbox on this bus.
 *   P0-2  list / listSummaries are gated: a remote caller gets the curated
 *         slice of local ∪ pooled with NO global-registry fallback chaining.
 *   P0-3  ask/askPrompt curation — a local caller sees the pooled peer objects
 *         in their own section plus the global catalog; a remote caller sees
 *         neither the unexposed locals nor the global catalog.
 *
 * Run: npx tsx --test src/objects/workspace-registry.scoping.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MessageBus } from '../runtime/message-bus.js';
import { Abject } from '../core/abject.js';
import { Registry } from './registry.js';
import { WorkspaceRegistry } from './workspace-registry.js';
import { request } from '../core/message.js';
import type { AbjectId, AbjectManifest, InterfaceId } from '../core/types.js';

function mkManifest(name: string, sharing?: string): AbjectManifest {
  return {
    name,
    description: `${name} test fixture`,
    version: '1.0.0',
    interface: {
      id: `abjects:${name.toLowerCase()}` as InterfaceId,
      name,
      description: `${name} fixture interface`,
      methods: [
        { name: 'echo', description: 'Echo', parameters: [], returns: { kind: 'primitive', primitive: 'string' } },
      ],
    },
    requiredCapabilities: [],
    providedCapabilities: [`abjects:test:${name.toLowerCase()}`],
    tags: ['test'],
    ...(sharing ? { sharing } : {}),
  } as unknown as AbjectManifest;
}

class Fixture extends Abject {
  constructor(name: string, sharing?: string) {
    super({ manifest: mkManifest(name, sharing) });
    this.on('echo', () => ({ ok: true }));
  }
  async ask<T>(to: AbjectId, method: string, payload: unknown = {}): Promise<T> {
    return this.request<T>(request(this.id, to, method, payload));
  }
}

interface Harness {
  bus: MessageBus;
  globalReg: Registry;
  wsReg: WorkspaceRegistry;
  localCaller: Fixture;
  exposed: Fixture;
  secret: Fixture;
  globalObj: Fixture;
  /** A pooled peer object that also holds a real mailbox here — the bypass shape. */
  peerCaller: Fixture;
  /** A pooled peer object with no local mailbox: reachable only by route. */
  routedId: AbjectId;
  stop: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const bus = new MessageBus();

  const globalReg = new Registry();
  await globalReg.init(bus);

  // A system object that lives only in the GLOBAL registry (LLMObject/HttpClient
  // stand-in). A remote caller must never see it.
  const globalObj = new Fixture('HttpClientLike');
  await globalObj.init(bus);
  globalReg.registerObject(globalObj.id, globalObj.manifest, undefined, undefined, undefined, 'HttpClientLike');

  const wsReg = new WorkspaceRegistry();
  await wsReg.init(bus);

  const localCaller = new Fixture('LocalAgent');
  await localCaller.init(bus);

  // Wire the fallback through the MESSAGE handler, exactly as WorkspaceManager
  // does in production: the direct setFallback() setter only records the id and
  // never subscribes, so the 'changed'-event refresh would never arm.
  await localCaller.ask(wsReg.id, 'setFallback', { registryId: globalReg.id });

  const exposed = new Fixture('PublicNotes');
  await exposed.init(bus);
  wsReg.registerObject(exposed.id, exposed.manifest, undefined, undefined, undefined, 'PublicNotes');

  const secret = new Fixture('PrivateJournal');
  await secret.init(bus);
  wsReg.registerObject(secret.id, secret.manifest, undefined, undefined, undefined, 'PrivateJournal');

  // Curation: only PublicNotes is exposed to remote callers.
  wsReg.setExposedObjectIds([exposed.id]);

  // Pooled peer object that ALSO holds a mailbox on this bus under its own
  // AbjectId — the identity the old filterForCaller mistook for local. Nothing
  // mounts a local stand-in any more, but a local registration can still
  // collide with a catalogued peer id, so the bypass must stay closed on its
  // own terms rather than by counting proxies.
  const peerCaller = new Fixture('SeattleWeather', 'shared-live');
  await peerCaller.init(bus);
  (wsReg as any).registerRemote({
    objectId: peerCaller.id,
    manifest: peerCaller.manifest,
    name: 'SeattleWeather',
    ownerPeerId: 'peer-b',
    workspaceId: 'ws-shared-1',
    workspaceName: 'Shared',
  });

  // A second pooled entry with no local mailbox at all: nothing stands in for
  // it here, so it is reachable only as a PeerRouter route to its owner.
  const routedId = 'pooled-routed-0001' as AbjectId;
  (wsReg as any).registerRemote({
    objectId: routedId,
    manifest: mkManifest('PeerCalendar', 'shared-live'),
    name: 'PeerCalendar',
    ownerPeerId: 'peer-b',
    workspaceId: 'ws-shared-1',
    workspaceName: 'Shared',
  });
  await new Promise((r) => setTimeout(r, 20)); // let the 'changed' events settle

  const stop = async () => {
    for (const o of [localCaller, peerCaller, exposed, secret, globalObj]) {
      await o.stop().catch(() => { /* already gone */ });
    }
    await wsReg.stop().catch(() => { /* already gone */ });
    await globalReg.stop().catch(() => { /* already gone */ });
  };

  return { bus, globalReg, wsReg, localCaller, exposed, secret, globalObj, peerCaller, routedId, stop };
}

test('P0-1: a routed/pooled/peer-stamped caller is never local, and gets only the whitelist', async () => {
  const h = await harness();
  const isLocal = (id: AbjectId) => (h.wsReg as any).isLocalCaller(id) as boolean;

  // The routed branch: a pooled id with no local mailbox is remotely
  // addressable — PeerRouter carries it to its owner — and reads as remote.
  assert.equal(h.bus.isRegistered(h.routedId), false, 'nothing may stand in for it locally');
  assert.ok(
    (h.wsReg as any).isRemotelyAddressable(h.routedId),
    'a shared-live pooled id must be remotely addressable',
  );
  assert.equal(isLocal(h.routedId), false, 'a routed pooled id must not be local');

  // The pooled branch: holds a real mailbox on this bus (bus.isRegistered true)
  // yet must still read as remote — this is the closed bypass.
  assert.ok(h.bus.isRegistered(h.peerCaller.id), 'precondition: pooled caller holds a local mailbox');
  assert.equal(isLocal(h.peerCaller.id), false, 'a pooled catalog id must not be local (bypass closed)');

  // The ownerPeerId branch: a local registration stamped with an owning peer.
  const stampedId = 'stamped-0001' as AbjectId;
  h.wsReg.registerObject(stampedId, mkManifest('StampedThing'), undefined, undefined, undefined, 'StampedThing');
  (h.wsReg.lookupObject(stampedId) as any).ownerPeerId = 'peer-b';
  assert.equal(isLocal(stampedId), false, 'a peer-stamped registration must not be local');

  // A genuine local caller is still local.
  assert.equal(isLocal(h.localCaller.id), true, 'a real local object must remain local');

  // End to end: discover through the pooled identity yields the whitelist only.
  const discovered = await h.peerCaller.ask<Array<{ id: AbjectId }>>(h.wsReg.id, 'discover', {
    tags: ['test'],
  });
  const ids = new Set((discovered ?? []).map((r) => r.id));
  assert.ok(!ids.has(h.secret.id), 'remote discover must not reveal the uncurated local object');
  assert.ok(!ids.has(h.globalObj.id), 'remote discover must not reveal global system objects');

  await h.stop();
});

test('P0-2: list/listSummaries gate remote callers and never chain to the global registry', async () => {
  const h = await harness();

  // --- remote caller (pooled identity) ---
  const remoteList = await h.peerCaller.ask<Array<{ id: AbjectId }>>(h.wsReg.id, 'list');
  const remoteIds = new Set(remoteList.map((r) => r.id));
  assert.ok(remoteIds.has(h.exposed.id), 'remote list must contain the curated object');
  assert.ok(!remoteIds.has(h.secret.id), 'remote list must not contain uncurated local objects');
  assert.ok(!remoteIds.has(h.globalObj.id), 'remote list must not chain to the global registry');

  const remoteSummaries = await h.peerCaller.ask<Array<{ id: AbjectId }>>(h.wsReg.id, 'listSummaries');
  const remoteSumIds = new Set(remoteSummaries.map((s) => s.id));
  assert.ok(remoteSumIds.has(h.exposed.id), 'remote listSummaries must contain the curated object');
  assert.ok(!remoteSumIds.has(h.secret.id), 'remote listSummaries must not leak uncurated locals');
  assert.ok(!remoteSumIds.has(h.globalObj.id), 'remote listSummaries must not leak global system objects');

  // --- local caller: the convenience union is unchanged ---
  const localList = await h.localCaller.ask<Array<{ id: AbjectId }>>(h.wsReg.id, 'list');
  const localIds = new Set(localList.map((r) => r.id));
  assert.ok(localIds.has(h.exposed.id), 'local list keeps local objects');
  assert.ok(localIds.has(h.secret.id), 'local list keeps uncurated local objects');
  assert.ok(localIds.has(h.peerCaller.id), 'local list keeps pooled peer objects');
  assert.ok(localIds.has(h.globalObj.id), 'local list still chains to the global registry');

  const localSummaries = await h.localCaller.ask<Array<{ id: AbjectId }>>(h.wsReg.id, 'listSummaries');
  const localSumIds = new Set(localSummaries.map((s) => s.id));
  assert.ok(localSumIds.has(h.secret.id), 'local listSummaries keeps uncurated local objects');
  assert.ok(localSumIds.has(h.peerCaller.id), 'local listSummaries keeps pooled peer objects');
  assert.ok(localSumIds.has(h.globalObj.id), 'local listSummaries still chains to the global registry');

  // listLocal is untouched by the gating: local objects only, no pooled entries.
  const listLocal = await h.localCaller.ask<Array<{ id: AbjectId }>>(h.wsReg.id, 'listLocal');
  const localOnlyIds = new Set(listLocal.map((r) => r.id));
  assert.ok(localOnlyIds.has(h.exposed.id), 'listLocal still returns local objects');
  assert.ok(!localOnlyIds.has(h.peerCaller.id), 'listLocal still excludes pooled peer objects');

  await h.stop();
});

test('P0-3: askPrompt lists pooled objects for local callers and omits the global catalog for remote', async () => {
  const h = await harness();
  const promptFor = (id: AbjectId) =>
    (h.wsReg as any).askPromptFor('which objects can help with weather?', id) as string;

  // --- local caller ---
  const localPrompt = promptFor(h.localCaller.id);
  assert.match(localPrompt, /## Shared Objects \(peer workspaces\)/, 'local prompt needs the pooled section');
  assert.match(localPrompt, /SeattleWeather/, 'local prompt must name the pooled peer object');
  assert.match(localPrompt, /peer-b/, 'local prompt must carry the owning peer id');
  assert.match(localPrompt, /abjects:test:seattleweather/, 'local prompt must carry pooled capabilities');
  assert.match(localPrompt, /## System Capabilities \(global registry\)/, 'local prompt keeps the global catalog');
  assert.match(localPrompt, /HttpClientLike/, 'local prompt names global system objects');

  // --- remote caller ---
  const remotePrompt = promptFor(h.peerCaller.id);
  assert.ok(
    !/## System Capabilities \(global registry\)/.test(remotePrompt),
    'remote prompt must omit the global catalog section entirely',
  );
  assert.ok(!/HttpClientLike/.test(remotePrompt), 'remote prompt must not name global system objects');
  assert.ok(!/PrivateJournal/.test(remotePrompt), 'remote prompt must not name uncurated local objects');
  assert.match(remotePrompt, /PublicNotes/, 'remote prompt still names the curated object');

  await h.stop();
});

test("P0-3: the global catalog cache tracks the fallback registry's changed events", async () => {
  const h = await harness();
  assert.ok(!/LateSpawn/.test((h.wsReg as any)._globalCatalogCache), 'precondition: LateSpawn not yet cached');

  const late = new Fixture('LateSpawn');
  await late.init(h.bus);
  h.globalReg.registerObject(late.id, late.manifest, undefined, undefined, undefined, 'LateSpawn');

  let cached = false;
  for (let i = 0; i < 40 && !cached; i++) {
    await new Promise((r) => setTimeout(r, 50));
    cached = /LateSpawn/.test((h.wsReg as any)._globalCatalogCache);
  }
  assert.ok(cached, 'global catalog cache must refresh on the fallback registry changed event');

  await late.stop();
  await h.stop();
});
