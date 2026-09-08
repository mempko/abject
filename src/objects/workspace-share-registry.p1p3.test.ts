/**
 * P1-2 / P1-3 push-side curation verification.
 *
 *   P1-3  every single-entry catalog delta goes through the SAME curation the
 *         snapshot path uses, so an object created AFTER a joiner took its
 *         snapshot cannot slip past a 'public' workspace's whitelist. For
 *         'shared' the gate must reduce to the pre-existing host-local
 *         exclusion, so shared workspaces behave exactly as they did before.
 *   P1-2  that curation is keyed on DURABLE selectors (typeId / registered
 *         name), so it still holds after a restart has rotated every AbjectId.
 *
 * Run: npx tsx --test src/objects/workspace-share-registry.p1p3.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkspaceShareRegistry } from './workspace-share-registry.js';
import type { AbjectId, AbjectManifest, InterfaceId, ObjectRegistration, TypeId } from '../core/types.js';

const WS_ID = 'ws-1';
const REGISTRY_ID = 'registry-abject-id' as AbjectId;

function mkManifest(name: string, sharing?: string): AbjectManifest {
  return {
    name,
    description: `${name} fixture`,
    version: '1.0.0',
    interface: {
      id: `abjects:${name.toLowerCase()}` as InterfaceId,
      name,
      description: `${name} fixture`,
      methods: [],
    },
    requiredCapabilities: [],
    providedCapabilities: [],
    tags: ['test'],
    ...(sharing ? { sharing } : {}),
  } as unknown as AbjectManifest;
}

/** A registration with an EPHEMERAL id and a DURABLE typeId/name. */
function mkReg(name: string, id: string, sharing?: string): ObjectRegistration {
  return {
    id: id as AbjectId,
    typeId: `${WS_ID}/${name}` as TypeId,
    name,
    manifest: mkManifest(name, sharing),
    status: 'running',
    registeredAt: Date.now(),
  } as unknown as ObjectRegistration;
}

interface Emitted {
  kind: string;
  objectId: string;
  name?: string;
}

/**
 * A WorkspaceShareRegistry with the bus cut away: `emitCatalogDelta` is
 * replaced by a recorder, and WorkspaceManager resolution is stubbed to
 * "unreachable" so `readCuratedExposure` falls back to the workspace record we
 * hand it — which is exactly the durable, persisted shape.
 */
function subject(ws: Record<string, unknown>): { wsr: WorkspaceShareRegistry; emitted: Emitted[] } {
  const wsr = new WorkspaceShareRegistry();
  const emitted: Emitted[] = [];
  const anyWsr = wsr as unknown as Record<string, unknown>;
  anyWsr.resolveWorkspaceManagerId = async () => undefined;
  anyWsr.emitCatalogDelta = (
    _workspaceId: string,
    kind: string,
    objectId: string,
    object?: ObjectRegistration,
  ) => {
    emitted.push({ kind, objectId, name: object?.manifest?.name });
  };
  (anyWsr.localShared as Map<string, unknown>).set(WS_ID, ws);
  return { wsr, emitted };
}

async function emitDelta(
  wsr: WorkspaceShareRegistry,
  kind: string,
  objectId: string,
  object?: ObjectRegistration,
): Promise<void> {
  const fn = (wsr as unknown as Record<string, unknown>).emitCuratedCatalogDelta as (
    workspaceId: string,
    kind: string,
    objectId: string,
    object?: ObjectRegistration,
  ) => Promise<void>;
  await fn.call(wsr, WS_ID, kind, objectId, object);
}

const sharedWs = () => ({
  workspaceId: WS_ID,
  name: 'Shared WS',
  accessMode: 'shared',
  registryId: REGISTRY_ID,
  exposedObjectIds: [],
  exposedTypeIds: [],
  curated: false,
  whitelist: ['joiner-peer'],
});

const publicCuratedWs = () => ({
  workspaceId: WS_ID,
  name: 'Public WS',
  accessMode: 'public',
  registryId: REGISTRY_ID,
  // Durable curation only — NO AbjectIds at all, which is the post-restart
  // shape: the ids the user originally clicked no longer exist.
  exposedObjectIds: [],
  exposedTypeIds: [`${WS_ID}/PublicNotes`],
  curated: true,
});

test("P1-3: 'shared' delta curation reduces to the host-local exclusion", async () => {
  const { wsr, emitted } = subject(sharedWs());

  // An ordinary workspace abject goes out, exactly as before the gate existed.
  await emitDelta(wsr, 'abject_spawned', 'id-notes', mkReg('PublicNotes', 'id-notes'));
  // A second one created later goes out too — 'shared' has no whitelist.
  await emitDelta(wsr, 'abject_spawned', 'id-later', mkReg('LaterNotes', 'id-later'));
  // Host furniture stays behind.
  await emitDelta(wsr, 'abject_spawned', 'id-taskbar', mkReg('Taskbar', 'id-taskbar'));
  // The workspace registry is the joiner's entry point and is never stripped.
  await emitDelta(wsr, 'abject_spawned', REGISTRY_ID, {
    ...mkReg('WorkspaceRegistry', REGISTRY_ID),
  });
  // 'user-local' never leaves the host, curated or not.
  await emitDelta(wsr, 'abject_spawned', 'id-priv', mkReg('PrivateJournal', 'id-priv', 'user-local'));

  const names = emitted.map((e) => e.name);
  assert.deepEqual(
    names,
    ['PublicNotes', 'LaterNotes', 'WorkspaceRegistry'],
    `shared mode must behave exactly as today, got: ${JSON.stringify(names)}`,
  );
});

test('P1-3: a post-snapshot object cannot leak past a public whitelist', async () => {
  const { wsr, emitted } = subject(publicCuratedWs());

  // On the whitelist (by durable typeId/name).
  await emitDelta(wsr, 'abject_spawned', 'id-notes', mkReg('PublicNotes', 'id-notes'));
  // Created AFTER the joiner's snapshot and NOT on the whitelist: this is the
  // exact leak P1-3 closes — before the gate it rode out on the delta path.
  await emitDelta(wsr, 'abject_spawned', 'id-secret', mkReg('SecretLedger', 'id-secret'));

  const names = emitted.map((e) => e.name);
  assert.deepEqual(
    names,
    ['PublicNotes'],
    `only whitelisted objects may ride the delta path, got: ${JSON.stringify(names)}`,
  );
});

test('P1-2: delta curation survives AbjectId churn (durable typeId/name)', async () => {
  const { wsr, emitted } = subject(publicCuratedWs());

  // A restart re-spawned PublicNotes with a COMPLETELY different AbjectId, and
  // the curated list holds no ids at all. Keyed on ids alone this delta would
  // be withheld and the curated workspace would publish nothing.
  await emitDelta(wsr, 'abject_spawned', 'id-after-restart', mkReg('PublicNotes', 'id-after-restart'));

  assert.equal(emitted.length, 1, 'durable curation must still match after id churn');
  assert.equal(emitted[0]?.objectId, 'id-after-restart');
  assert.equal(emitted[0]?.name, 'PublicNotes');
});

test('P1-3: the workspace registry is never curated away, and destroys still flow', async () => {
  const { wsr, emitted } = subject(publicCuratedWs());

  // The joiner's entry point: exempt even under the strict public whitelist.
  await emitDelta(wsr, 'abject_spawned', REGISTRY_ID, mkReg('WorkspaceRegistry', REGISTRY_ID));
  // A destroy delta carries no object and so cannot be classified; withholding
  // it would strand a stale entry in every joiner's mirror.
  await emitDelta(wsr, 'abject_destroyed', 'id-secret', undefined);

  const ids = emitted.map((e) => e.objectId);
  assert.deepEqual(ids, [REGISTRY_ID, 'id-secret'], `got: ${JSON.stringify(ids)}`);
});

test('P1-3: an UNCURATED public workspace still shares its shareable objects on the delta path', async () => {
  const { wsr, emitted } = subject({
    workspaceId: WS_ID,
    name: 'Public WS',
    accessMode: 'public',
    registryId: REGISTRY_ID,
    exposedObjectIds: [],
    exposedTypeIds: [],
    curated: false,
  });

  await emitDelta(wsr, 'abject_spawned', 'id-notes', mkReg('PublicNotes', 'id-notes'));
  assert.deepEqual(emitted.map((e) => e.name), ['PublicNotes']);
});

/* ---------------------------------------------------------------------------
 * The boot-time seq-0 sync.
 *
 * A host that restored its objects from storage never bumped catalogSeq —
 * restores fire no registry event, and emitCatalogDelta is the only place the
 * sequence advances. So a fresh joiner's `sinceSeq: 0` met the host's
 * `currentSeq: 0`, the equality guard fired, and the response carried an empty
 * delta list instead of the catalog. The joiner mirrored nothing and every
 * retry re-entered the same stalemate. A requester that has applied nothing
 * must fall through to the full snapshot.
 * ------------------------------------------------------------------------- */

interface SyncResponse {
  deltas?: unknown[];
  snapshot?: ObjectRegistration[];
  fromSeq: number;
  currentSeq: number;
}

/**
 * `subject()` with the catalog read cut away too: the host's `listLocal`
 * request to its workspace registry is the only thing between the handler and
 * the catalog, and curation itself is covered by the tests above.
 */
function syncSubject(
  ws: Record<string, unknown>,
  catalog: ObjectRegistration[],
): { wsr: WorkspaceShareRegistry; sync: (sinceSeq: number) => Promise<SyncResponse> } {
  const { wsr } = subject(ws);
  const anyWsr = wsr as unknown as Record<string, unknown>;
  anyWsr.readWorkspaceCatalogRaw = async () => catalog;
  const handler = anyWsr.handleCatalogSyncRequest as (
    payload: { workspaceId: string; peerId: string; sinceSeq: number },
  ) => Promise<SyncResponse>;
  return {
    wsr,
    sync: (sinceSeq: number) =>
      handler.call(wsr, { workspaceId: WS_ID, peerId: 'joiner-peer', sinceSeq }),
  };
}

test('P0: a boot-time sinceSeq=0 sync gets the whole catalog, not an empty delta list', async () => {
  const catalog = [mkReg('SeattleWeather', 'id-weather'), mkReg('WorkspaceRegistry', REGISTRY_ID)];
  const { sync } = syncSubject(sharedWs(), catalog);

  // currentSeq is 0: every object came back from storage at boot, so nothing
  // ever advanced the sequence.
  const res = await sync(0);

  assert.equal(res.currentSeq, 0);
  assert.deepEqual(
    (res.snapshot ?? []).map((r) => r.manifest?.name),
    ['SeattleWeather', 'WorkspaceRegistry'],
    `a joiner with nothing mirrored must receive the whole catalog, got: ${JSON.stringify(res)}`,
  );
});

test('P0: a peer reconnecting through catalog sync receives a later exposed-object delta', async () => {
  const { wsr, sync } = syncSubject(sharedWs(), []);
  const anyWsr = wsr as unknown as Record<string, unknown>;
  // syncSubject inherits subject()'s curation-only recorder. Remove that
  // instance stub so this regression exercises the real delta broadcaster.
  delete anyWsr.emitCatalogDelta;
  const remoteWsrId = 'remote-workspace-share-registry' as AbjectId;
  const delivered: Array<{ to: AbjectId; method: string; payload: unknown }> = [];

  anyWsr.localPeerId = 'host-peer';
  anyWsr.peerRegistryId = undefined;
  anyWsr.resolveRemoteWsr = async (peerId: string) => {
    assert.equal(peerId, 'joiner-peer');
    return remoteWsrId;
  };
  anyWsr.request = async (msg: {
    routing: { to: AbjectId; method?: string };
    payload: unknown;
  }) => {
    delivered.push({ to: msg.routing.to, method: msg.routing.method ?? '', payload: msg.payload });
    return undefined;
  };

  // Reconnect/hydration uses catalog sync without another join_request.
  await sync(0);
  assert.deepEqual(
    wsr.getActiveMembers(WS_ID).map((member) => member.peerId),
    ['joiner-peer'],
    'an authorised catalog sync must restore active mesh membership',
  );

  const newlyExposed = mkReg('LaterNotes', 'id-later');
  const emit = anyWsr.emitCuratedCatalogDelta as (
    workspaceId: string,
    kind: string,
    objectId: string,
    object: ObjectRegistration,
  ) => Promise<void>;
  await emit.call(wsr, WS_ID, 'abject_spawned', newlyExposed.id, newlyExposed);

  // emitCatalogDelta intentionally starts mesh delivery in the background.
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(delivered.length, 1, 'the later catalog delta must reach the synced peer');
  assert.equal(delivered[0]?.to, remoteWsrId);
  assert.equal(delivered[0]?.method, 'workspace:catalog_delta');
  assert.deepEqual(delivered[0]?.payload, {
    workspaceId: WS_ID,
    ownerPeerId: 'host-peer',
    kind: 'abject_spawned',
    seq: 1,
    timestamp: (delivered[0]?.payload as { timestamp: number }).timestamp,
    objectId: newlyExposed.id,
    object: newlyExposed,
  });
});

test('P0: a caught-up joiner (sinceSeq === currentSeq > 0) is still sent no deltas', async () => {
  const { wsr, sync } = syncSubject(sharedWs(), [mkReg('SeattleWeather', 'id-weather')]);
  (wsr as unknown as { catalogSeq: Map<string, number> }).catalogSeq.set(WS_ID, 7);

  const res = await sync(7);

  assert.deepEqual(res.deltas, [], 'an up-to-date mirror must not be resent the catalog');
  assert.equal(res.snapshot, undefined, 'and must not be handed a snapshot either');
});

test("P0: the seq-0 snapshot still withholds 'user-local' objects", async () => {
  const catalog = [
    mkReg('SeattleWeather', 'id-weather'),
    mkReg('PrivateJournal', 'id-priv', 'user-local'),
  ];
  const { sync } = syncSubject(sharedWs(), catalog);

  const res = await sync(0);

  assert.deepEqual(
    (res.snapshot ?? []).map((r) => r.manifest?.name),
    ['SeattleWeather'],
    'reopening the seq-0 path must not reopen the user-local gate',
  );
});
