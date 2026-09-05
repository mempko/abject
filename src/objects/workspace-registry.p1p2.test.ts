/**
 * P1/P2 workspace-registry scoping verification.
 *
 *   P1-1  search() override — a LOCAL caller scores over local ∪ pooled and
 *         chains to the global registry only on a miss; a REMOTE caller sees
 *         neither the pooled objects nor the global fallback.
 *   P1-2  durable curation — curation must survive AbjectId churn (a restart
 *         re-spawns objects with fresh ids), so a whitelist keyed on a durable
 *         NAME must still resolve after the id changes.
 *   P2-1  remote writes are refused outright and leave the source byte-identical,
 *         the refusal names the method actually invoked (forkRemote/cloneRemote
 *         share one handler), and the `resolveUri` side door is a curated READ:
 *         a remote caller resolves only into the whitelist, with no chaining to
 *         the global registry.
 *
 * Run: npx tsx --test src/objects/workspace-registry.p1p2.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MessageBus } from '../runtime/message-bus.js';
import { Abject } from '../core/abject.js';
import { Registry } from './registry.js';
import { WorkspaceRegistry } from './workspace-registry.js';
import { request } from '../core/message.js';
import type { AbjectId, AbjectManifest, InterfaceId } from '../core/types.js';

function mkManifest(name: string, description: string, sharing?: string): AbjectManifest {
  return {
    name,
    description,
    version: '1.0.0',
    interface: {
      id: `abjects:${name.toLowerCase()}` as InterfaceId,
      name,
      description,
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
  constructor(name: string, description: string, sharing?: string) {
    super({ manifest: mkManifest(name, description, sharing) });
    this.on('echo', () => ({ ok: true }));
  }
  async ask<T>(to: AbjectId, method: string, payload: unknown = {}): Promise<T> {
    return this.request<T>(request(this.id, to, method, payload));
  }
}

const SOURCE_A = 'export class PublicNotes { /* ORIGINAL SOURCE */ }\n';

interface Harness {
  bus: MessageBus;
  globalReg: Registry;
  wsReg: WorkspaceRegistry;
  localCaller: Fixture;
  exposed: Fixture;
  secret: Fixture;
  globalObj: Fixture;
  peerCaller: Fixture;
  stop: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const bus = new MessageBus();

  const globalReg = new Registry();
  await globalReg.init(bus);

  // Stands in for HttpClient: lives ONLY in the global registry.
  const globalObj = new Fixture('HttpClientLike', 'Performs outbound HTTP fetch requests over the network');
  await globalObj.init(bus);
  globalReg.registerObject(globalObj.id, globalObj.manifest, undefined, undefined, undefined, 'HttpClientLike');

  const wsReg = new WorkspaceRegistry();
  await wsReg.init(bus);

  const localCaller = new Fixture('LocalAgent', 'A local agent');
  await localCaller.init(bus);
  await localCaller.ask(wsReg.id, 'setFallback', { registryId: globalReg.id });

  const exposed = new Fixture('PublicNotes', 'Shared public notes');
  await exposed.init(bus);
  wsReg.registerObject(exposed.id, exposed.manifest, undefined, undefined, SOURCE_A, 'PublicNotes');

  const secret = new Fixture('PrivateJournal', 'Private journal, not shared');
  await secret.init(bus);
  wsReg.registerObject(secret.id, secret.manifest, undefined, undefined, undefined, 'PrivateJournal');

  wsReg.setExposedObjectIds([exposed.id]);

  // Pooled peer object — the weather case.
  const peerCaller = new Fixture('SeattleWeather', 'Reports the weather forecast for Seattle', 'shared-live');
  await peerCaller.init(bus);
  (wsReg as any).registerRemote({
    objectId: peerCaller.id,
    manifest: peerCaller.manifest,
    name: 'SeattleWeather',
    ownerPeerId: 'peer-b',
    workspaceId: 'ws-shared-1',
    workspaceName: 'Shared',
  });
  await new Promise((r) => setTimeout(r, 20));

  const stop = async () => {
    for (const o of [localCaller, peerCaller, exposed, secret, globalObj]) {
      await o.stop().catch(() => { /* already gone */ });
    }
    await wsReg.stop().catch(() => { /* already gone */ });
    await globalReg.stop().catch(() => { /* already gone */ });
  };

  return { bus, globalReg, wsReg, localCaller, exposed, secret, globalObj, peerCaller, stop };
}

test('P1-1: search finds pooled objects locally, chains on miss, and reveals neither remotely', async () => {
  const h = await harness();

  // Local caller: a pooled peer object is reachable through search.
  const weather = await h.localCaller.ask<Array<{ id: AbjectId; name: string }>>(
    h.wsReg.id, 'search', { query: 'weather' },
  );
  const weatherNames = (weather ?? []).map((r) => r.name);
  assert.ok(
    weatherNames.includes('SeattleWeather'),
    `local search must find the pooled SeattleWeather, got: ${JSON.stringify(weatherNames)}`,
  );

  // Local caller: a MISS in local ∪ pooled chains to the global registry.
  const http = await h.localCaller.ask<Array<{ id: AbjectId; name: string }>>(
    h.wsReg.id, 'search', { query: 'HttpClientLike' },
  );
  const httpNames = (http ?? []).map((r) => r.name);
  assert.ok(
    httpNames.includes('HttpClientLike'),
    `local search must chain to the global registry on a miss, got: ${JSON.stringify(httpNames)}`,
  );

  // Remote caller: neither the pooled object nor the global fallback.
  const rWeather = await h.peerCaller.ask<Array<{ id: AbjectId; name: string }>>(
    h.wsReg.id, 'search', { query: 'weather' },
  );
  const rWeatherNames = (rWeather ?? []).map((r) => r.name);
  assert.ok(
    !rWeatherNames.includes('SeattleWeather'),
    `remote search must not reveal pooled peer objects, got: ${JSON.stringify(rWeatherNames)}`,
  );

  const rHttp = await h.peerCaller.ask<Array<{ id: AbjectId; name: string }>>(
    h.wsReg.id, 'search', { query: 'HttpClientLike' },
  );
  const rHttpNames = (rHttp ?? []).map((r) => r.name);
  assert.ok(
    !rHttpNames.includes('HttpClientLike'),
    `remote search must not chain to the global registry, got: ${JSON.stringify(rHttpNames)}`,
  );

  // Remote search still honours the whitelist.
  const rPublic = await h.peerCaller.ask<Array<{ id: AbjectId; name: string }>>(
    h.wsReg.id, 'search', { query: 'notes' },
  );
  const rPublicNames = (rPublic ?? []).map((r) => r.name);
  assert.ok(
    !rPublicNames.includes('PrivateJournal'),
    `remote search must never reveal uncurated locals, got: ${JSON.stringify(rPublicNames)}`,
  );

  await h.stop();
});

test('P1-2: curation keyed on a durable name survives AbjectId churn (restart)', async () => {
  const h = await harness();

  const anyReg = h.wsReg as any;

  // --- First, demonstrate the DEFECT that P1-2 is meant to close. ---
  // Curation today is keyed on the ephemeral AbjectId (setExposedObjectIds).
  // Simulate a host restart: the object is re-spawned under a FRESH AbjectId.
  const oldId = h.exposed.id;
  h.wsReg.unregisterObject(oldId);
  const respawned = new Fixture('PublicNotes', 'Shared public notes');
  await respawned.init(h.bus);
  h.wsReg.registerObject(
    respawned.id, respawned.manifest, undefined, undefined, SOURCE_A, 'PublicNotes',
  );
  assert.notEqual(respawned.id, oldId, 'precondition: the respawned object has a new AbjectId');

  const afterChurn = await h.peerCaller.ask<Array<{ id: AbjectId; name: string }>>(h.wsReg.id, 'list');
  const churnNames = (afterChurn ?? []).map((r) => r.name);
  // Recorded as evidence: with id-keyed curation the whitelist is dead after a
  // restart — the remote peer sees NOTHING, which is the P1-2 bug.
  assert.deepEqual(
    churnNames, [],
    `evidence: id-keyed curation should collapse to empty after id churn, got: ${JSON.stringify(churnNames)}`,
  );

  // --- Now assert the durable fix exists. ---
  assert.equal(
    typeof anyReg.setExposedSelectors,
    'function',
    'P1-2 requires Registry.setExposedSelectors({ids,typeIds,names}); it is absent from the tree, ' +
    'so curation does NOT survive a restart (see the empty result above)',
  );
  anyReg.setExposedSelectors({ names: ['PublicNotes'] });

  const remote = await h.peerCaller.ask<Array<{ id: AbjectId; name: string }>>(h.wsReg.id, 'list');
  const names = (remote ?? []).map((r) => r.name);
  assert.ok(
    names.includes('PublicNotes'),
    `after a restart the remote peer must still see the curated object by name, got: ${JSON.stringify(names)}`,
  );
  assert.ok(
    !names.includes('PrivateJournal'),
    'and must still not see the uncurated one',
  );

  await respawned.stop().catch(() => { /* already gone */ });
  await h.stop();
});

test('P2-1: a remote write is refused and the source stays byte-identical', async () => {
  const h = await harness();

  const before = await h.localCaller.ask<string | null>(h.wsReg.id, 'getSource', { objectId: h.exposed.id });
  assert.equal(before, SOURCE_A, 'precondition: the original source is readable locally');

  // The remote peer attempts to overwrite the source of a CURATED object.
  let refused = false;
  let refusal = '';
  try {
    await h.peerCaller.ask(h.wsReg.id, 'updateSource', {
      objectId: h.exposed.id,
      source: 'export class PublicNotes { /* PWNED */ }\n',
    });
  } catch (err) {
    refused = true;
    refusal = err instanceof Error ? err.message : String(err);
  }
  assert.ok(refused, 'a remote updateSource must be refused with an explicit error, not silently accepted');
  assert.match(refusal, /refused for remote caller|read-only/i, `refusal must be explicit, got: ${refusal}`);

  const after = await h.localCaller.ask<string | null>(h.wsReg.id, 'getSource', { objectId: h.exposed.id });
  assert.equal(after, SOURCE_A, 'the source must be byte-identical after the refused remote write');

  // The same write from a LOCAL caller still succeeds — the guard is scoped.
  const localOk = await h.localCaller.ask<boolean>(h.wsReg.id, 'updateSource', {
    objectId: h.exposed.id,
    source: 'export class PublicNotes { /* LOCAL EDIT */ }\n',
  });
  assert.equal(localOk, true, 'a local updateSource must still be allowed');

  await h.stop();
});

test('P2-1: resolveUri is a curated read for a remote caller, unrestricted locally', async () => {
  const h = await harness();

  // Local caller: resolves anything in its own workspace, curated or not.
  const localPrivate = await h.localCaller.ask<{ name?: string } | null>(
    h.wsReg.id, 'resolveUri', { uri: 'PrivateJournal' },
  );
  assert.equal(localPrivate?.name, 'PrivateJournal', 'a local caller must resolve its own uncurated object');

  const localPublic = await h.localCaller.ask<{ name?: string } | null>(
    h.wsReg.id, 'resolveUri', { uri: 'PublicNotes' },
  );
  assert.equal(localPublic?.name, 'PublicNotes', 'a local caller must resolve the curated object too');

  // Remote caller: the whitelist resolves...
  const remotePublic = await h.peerCaller.ask<{ name?: string } | null>(
    h.wsReg.id, 'resolveUri', { uri: 'PublicNotes' },
  );
  assert.equal(remotePublic?.name, 'PublicNotes', 'a remote caller must still resolve the curated object');

  // ...and nothing else does.
  const remotePrivate = await h.peerCaller.ask<{ name?: string } | null>(
    h.wsReg.id, 'resolveUri', { uri: 'PrivateJournal' },
  );
  assert.equal(remotePrivate, null, 'resolveUri must not reveal an uncurated local object to a remote caller');

  const remotePrivateById = await h.peerCaller.ask<{ name?: string } | null>(
    h.wsReg.id, 'resolveUri', { uri: `abject:${h.secret.id}` },
  );
  assert.equal(remotePrivateById, null, 'nor by URN id');

  // No fallback chaining: the global registry is this host's business.
  const remoteGlobal = await h.peerCaller.ask<{ name?: string } | null>(
    h.wsReg.id, 'resolveUri', { uri: 'HttpClientLike' },
  );
  assert.equal(remoteGlobal, null, 'resolveUri must not chain a remote caller into the global registry');

  // And the pooled peer catalog stays invisible remotely.
  const remotePooled = await h.peerCaller.ask<{ name?: string } | null>(
    h.wsReg.id, 'resolveUri', { uri: 'SeattleWeather' },
  );
  assert.equal(remotePooled, null, 'resolveUri must not reveal pooled peer objects to a remote caller');

  await h.stop();
});

test('P2-1: cloneRemote is refused remotely and the refusal names the invoked method', async () => {
  const h = await harness();

  let refusal = '';
  try {
    await h.peerCaller.ask(h.wsReg.id, 'cloneRemote', { ref: 'PublicNotes' });
  } catch (err) {
    refusal = err instanceof Error ? err.message : String(err);
  }
  assert.match(refusal, /refused for remote caller|read-only/i, `cloneRemote must be refused, got: ${refusal}`);
  assert.match(
    refusal, /cloneRemote/,
    `the refusal must name the method actually invoked, got: ${refusal}`,
  );

  await h.stop();
});

test('INVARIANTS: local result set is a superset of remote, remote is a subset of the whitelist', async () => {
  const h = await harness();

  const localSums = await h.localCaller.ask<Array<{ id: AbjectId; name: string }>>(h.wsReg.id, 'listSummaries');
  const remoteSums = await h.peerCaller.ask<Array<{ id: AbjectId; name: string }>>(h.wsReg.id, 'listSummaries');

  const localIds = new Set((localSums ?? []).map((s) => s.id));
  const remoteIds = (remoteSums ?? []).map((s) => s.id);

  // Invariant 1 (convenience): the local caller never sees less than the remote one.
  for (const id of remoteIds) {
    assert.ok(localIds.has(id), `local listSummaries must be a superset of remote; missing ${id}`);
  }
  // Local retains the pooled peer object and its own private object.
  const localNames = (localSums ?? []).map((s) => s.name);
  assert.ok(localNames.includes('PrivateJournal'), 'local must still see its uncurated local object');

  // Invariant 2 (security): remote ⊆ whitelist.
  const whitelist = new Set([h.exposed.id]);
  for (const id of remoteIds) {
    assert.ok(whitelist.has(id), `remote listSummaries leaked a non-whitelisted object: ${id}`);
  }

  await h.stop();
});
