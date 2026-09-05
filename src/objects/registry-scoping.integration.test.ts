/**
 * In-process two-bus integration test for the workspace-registry scoping plan.
 *
 * The two-process `pnpm awaken` harness cannot observe anything: no external
 * entry point can place an arbitrary message on a running peer's bus (the WS
 * gateway answers only {"type":"authNotRequired"}) — see the goal scratchpad
 * key `harness-report`. There is also no `src/network/mock-transport.ts` in this
 * tree, so the peer boundary here is built from two real MessageBuses bridged
 * through their undeliverable handlers: a message addressed to an id that is
 * not registered on its own bus is handed to the other bus. That is a genuine
 * cross-bus boundary using only the public bus API.
 *
 * Topology
 *   busA (host A)  globalReg + HttpClientLike | wsReg | LocalAgent
 *                  PublicNotes (curated, carries SOURCE_A) | PrivateJournal
 *                  weatherProxy — an Abject that ADOPTS peer B's SeattleWeather
 *                  id, so it is genuinely registered on A's bus (the P0-1 case)
 *   busB (peer B)  SeattleWeather (the real object) | PeerBAgent (remote caller)
 *
 * Invariant 1 (convenience): a LOCAL caller sees local ∪ pooled ∪ system fallback.
 * Invariant 2 (security):    a REMOTE caller sees a subset of the whitelist only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MessageBus } from '../runtime/message-bus.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Registry } from './registry.js';
import { WorkspaceRegistry } from './workspace-registry.js';
import type { AbjectId, AbjectManifest, AbjectMessage, InterfaceId } from '../core/types.js';

const SOURCE_A = 'export class PublicNotes { note() { return "A"; } }\n';

function mkManifest(name: string, description: string, sharing?: string): AbjectManifest {
  const iface = {
    id: `abjects:test-${name.toLowerCase()}` as InterfaceId,
    name: `${name}Interface`,
    description,
    methods: [{ name: 'ping', description: `Ping ${name}`, params: [], returns: { type: 'string' } }],
  };
  return {
    name,
    description,
    version: '1.0.0',
    interface: iface,
    interfaces: [iface],
    requiredCapabilities: [],
    providedCapabilities: [],
    tags: ['test'],
    ...(sharing ? { sharing } : {}),
  } as unknown as AbjectManifest;
}

class Fixture extends Abject {
  constructor(name: string, description: string, sharing?: string, id?: AbjectId) {
    super({ manifest: mkManifest(name, description, sharing), ...(id ? { id } : {}) });
    this.on('ping', () => 'pong');
  }

  async ask<T>(to: AbjectId, method: string, payload: unknown = {}): Promise<T> {
    return this.request<T>(request(this.id, to, method, payload));
  }
}

/**
 * The peer boundary.
 *
 * An undeliverable-handler bridge does NOT work here: MessageBus
 * (src/runtime/message-bus.ts:235-266) dispatches a synchronous
 * RECIPIENT_NOT_FOUND error reply BEFORE notifyUndeliverable runs, and
 * notifyUndeliverable returns void — it can observe, never intercept or
 * reroute. So the boundary is a Courier instead: an Abject registered on peer
 * B's bus under host A's registry id, whose wildcard handler forwards every
 * request onto A's bus through the pooled-proxy identity. The forwarded
 * request arrives at A stamped with the peer object's own AbjectId, which is
 * exactly the identity a real pooled peer proxy carries — and, because that id
 * also holds a mailbox on A, it is the P0-1 bypass in its live form.
 *
 * A handler that throws on A produces a HANDLER_ERROR reply, which rejects the
 * Courier's forwarded promise, which makes the Courier's own handler throw,
 * which rejects the caller's promise on B. Registry refusals therefore travel
 * across the boundary as rejections — what P2-1 asserts.
 */
class Courier extends Abject {
  constructor(registryId: AbjectId, forwarder: Fixture) {
    super({ manifest: mkManifest('Courier', 'Forwards peer B requests onto host A'), id: registryId });
    this.on('*', async (msg: AbjectMessage) =>
      forwarder.ask(registryId, msg.routing.method ?? '', msg.payload));
  }
}

/** Names out of a `list` / `listSummaries` / `search` / `discover` result. */
function names(rows: unknown): string[] {
  const arr = Array.isArray(rows) ? rows : [];
  return arr
    .map((r) => {
      const row = r as { name?: string; manifest?: { name?: string } } | null;
      return row?.name ?? row?.manifest?.name ?? '';
    })
    .filter((n): n is string => Boolean(n));
}

/** askPrompt may answer with a bare string or a wrapper. Normalise both. */
function promptText(r: unknown): string {
  if (typeof r === 'string') return r;
  const o = r as { prompt?: string; text?: string } | null;
  return o?.prompt ?? o?.text ?? JSON.stringify(r ?? '');
}

interface Harness {
  wsReg: WorkspaceRegistry;
  globalReg: Registry;
  local: Fixture;
  exposed: Fixture;
  secret: Fixture;
  /** Genuine remote caller: lives on peer B's bus entirely. */
  peerAgent: Fixture;
  /** P0-1: pooled peer proxy that IS registered on A's bus. */
  weatherProxy: Fixture;
  weatherId: AbjectId;
  stop: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const busA = new MessageBus();
  const busB = new MessageBus();
  const unbridge = () => { /* the Courier is torn down with its bus */ };

  // --- peer B ------------------------------------------------------------
  const weatherB = new Fixture('SeattleWeather', 'Reports the weather forecast for Seattle', 'shared-live');
  await weatherB.init(busB);
  const peerAgent = new Fixture('PeerBAgent', 'An agent running on peer B');
  await peerAgent.init(busB);

  // --- host A ------------------------------------------------------------
  const globalReg = new Registry();
  await globalReg.init(busA);

  const globalObj = new Fixture('HttpClientLike', 'Performs outbound HTTP fetch requests over the network');
  await globalObj.init(busA);
  globalReg.registerObject(globalObj.id, globalObj.manifest, undefined, undefined, undefined, 'HttpClientLike');

  const wsReg = new WorkspaceRegistry();
  await wsReg.init(busA);

  const local = new Fixture('LocalAgent', 'A local agent');
  await local.init(busA);
  await local.ask(wsReg.id, 'setFallback', { registryId: globalReg.id });

  const exposed = new Fixture('PublicNotes', 'Shared public notes');
  await exposed.init(busA);
  wsReg.registerObject(exposed.id, exposed.manifest, undefined, undefined, SOURCE_A, 'PublicNotes');

  const secret = new Fixture('PrivateJournal', 'Private journal, not shared');
  await secret.init(busA);
  wsReg.registerObject(secret.id, secret.manifest, undefined, undefined, undefined, 'PrivateJournal');

  wsReg.setExposedObjectIds([exposed.id]);

  // P0-1: a stand-in on A's bus adopting peer B's object id. bus.isRegistered()
  // is therefore TRUE for this caller — the exact bypass filterForCaller had.
  const weatherProxy = new Fixture(
    'SeattleWeather', 'Reports the weather forecast for Seattle', 'shared-live', weatherB.id,
  );
  await weatherProxy.init(busA);
  assert.equal(busA.isRegistered(weatherB.id), true, 'P0-1 precondition: proxy must hold a mailbox on A');

  // Peer boundary: on B, host A's registry id resolves to the Courier, which
  // relays onto A under the pooled-proxy identity.
  const courier = new Courier(wsReg.id, weatherProxy);
  await courier.init(busB);
  assert.equal(busB.isRegistered(wsReg.id), true, 'courier must answer for A\u2019s registry on B');

  (wsReg as unknown as { registerRemote: (e: unknown) => void }).registerRemote({
    objectId: weatherB.id,
    manifest: weatherB.manifest,
    name: 'SeattleWeather',
    ownerPeerId: 'peer-b',
    workspaceId: 'ws-shared-1',
    workspaceName: 'Shared',
  });
  await new Promise((r) => setTimeout(r, 20));

  const stop = async () => {
    unbridge();
    for (const o of [local, exposed, secret, globalObj, weatherProxy, weatherB, peerAgent]) {
      await o.stop().catch(() => { /* already gone */ });
    }
    await wsReg.stop().catch(() => { /* already gone */ });
    await globalReg.stop().catch(() => { /* already gone */ });
  };

  return { wsReg, globalReg, local, exposed, secret, peerAgent, weatherProxy, weatherId: weatherB.id, stop };
}

test('bridge: a caller on peer B\'s bus can actually reach host A\'s registry', async () => {
  const h = await harness();
  try {
    const rows = await h.peerAgent.ask(h.wsReg.id, 'list', {});
    assert.ok(Array.isArray(rows), `cross-bus request must be answered, got: ${JSON.stringify(rows)}`);
  } finally {
    await h.stop();
  }
});

test('P0-1: a pooled peer proxy registered on A\'s own bus is still a REMOTE caller', async () => {
  const h = await harness();
  try {
    // Via discover: the curated object is visible, everything else is not.
    const hit = names(await h.weatherProxy.ask(h.wsReg.id, 'discover', { name: 'PublicNotes' }));
    assert.ok(hit.includes('PublicNotes'), `whitelist must stay reachable, got: ${JSON.stringify(hit)}`);

    const miss = names(await h.weatherProxy.ask(h.wsReg.id, 'discover', { name: 'PrivateJournal' }));
    assert.deepEqual(miss, [], `proxy identity must not see uncurated locals, got: ${JSON.stringify(miss)}`);

    const leak = names(await h.weatherProxy.ask(h.wsReg.id, 'discover', { name: 'HttpClientLike' }));
    assert.deepEqual(leak, [], `proxy identity must not chain to the global registry, got: ${JSON.stringify(leak)}`);

    // And via the bulk surface, which is what the bypass used to hand over whole.
    const listed = names(await h.weatherProxy.ask(h.wsReg.id, 'list', {}));
    assert.deepEqual(
      listed.filter((n) => n !== 'PublicNotes' && n !== 'WorkspaceRegistry').sort(), [],
      `INVARIANT 2 VIOLATED — proxy caller saw more than the whitelist: ${JSON.stringify(listed)}`,
    );
  } finally {
    await h.stop();
  }
});

test('P0-2: list/listSummaries — local keeps the full union, remote never leaks the system registry', async () => {
  const h = await harness();
  try {
    // INVARIANT 1: local ∪ pooled ∪ system fallback.
    const localList = names(await h.local.ask(h.wsReg.id, 'list', {}));
    for (const want of ['PublicNotes', 'PrivateJournal', 'SeattleWeather', 'HttpClientLike']) {
      assert.ok(
        localList.includes(want),
        `INVARIANT 1 VIOLATED — local list lost ${want}: ${JSON.stringify(localList)}`,
      );
    }

    const localSummaries = names(await h.local.ask(h.wsReg.id, 'listSummaries', {}));
    for (const want of ['PublicNotes', 'SeattleWeather']) {
      assert.ok(
        localSummaries.includes(want),
        `INVARIANT 1 VIOLATED — local listSummaries lost ${want}: ${JSON.stringify(localSummaries)}`,
      );
    }

    // INVARIANT 2: a genuine peer-B caller sees the whitelist and nothing else.
    for (const method of ['list', 'listSummaries']) {
      const remote = names(await h.peerAgent.ask(h.wsReg.id, method, {}));
      for (const forbidden of ['PrivateJournal', 'HttpClientLike', 'LocalAgent', 'PeerBAgent']) {
        assert.ok(
          !remote.includes(forbidden),
          `INVARIANT 2 VIOLATED — remote ${method} leaked ${forbidden}: ${JSON.stringify(remote)}`,
        );
      }
      assert.ok(remote.includes('PublicNotes'), `remote ${method} must keep the whitelist: ${JSON.stringify(remote)}`);
    }
  } finally {
    await h.stop();
  }
});

test('P0-3: askPrompt names the pooled SeattleWeather locally and omits the system catalog remotely', async () => {
  const h = await harness();
  try {
    const q = 'which objects can help with weather?';

    // There is no message method named 'askPrompt'. The registered surface is
    // 'ask' (core/abject.ts:294) -> handleAsk(question, callerId)
    // (registry.ts:386) -> askPromptFor(question, callerId), and driving 'ask'
    // would require a live LLM. askPromptFor IS the landed P0-3 code path, so
    // call it directly, once per caller identity.
    type PromptBuilder = { askPromptFor(question: string, callerId?: AbjectId): string };
    const buildPrompt = (callerId: AbjectId): string =>
      promptText((h.wsReg as unknown as PromptBuilder).askPromptFor(q, callerId));

    const localPrompt = buildPrompt(h.local.id);
    assert.match(
      localPrompt, /SeattleWeather/,
      'INVARIANT 1 VIOLATED — a local agent asking about weather must be told about the pooled SeattleWeather',
    );
    assert.match(localPrompt, /Shared Objects/, 'local prompt must carry the pooled section');
    assert.match(localPrompt, /peer-b/, 'local prompt must name the owning peer');
    assert.match(localPrompt, /HttpClientLike/, 'INVARIANT 1 VIOLATED — local prompt lost the global catalog');

    // Both remote shapes must be scoped: the pooled proxy identity, which holds
    // a mailbox on A's own bus (the P0-1 bypass in its live form), and a caller
    // that lives entirely on peer B.
    const remoteCallers: ReadonlyArray<readonly [string, AbjectId]> = [
      ['pooled proxy', h.weatherId],
      ['peer agent', h.peerAgent.id],
    ];
    for (const [label, callerId] of remoteCallers) {
      const remotePrompt = buildPrompt(callerId);
      assert.ok(
        !/HttpClientLike/.test(remotePrompt),
        `INVARIANT 2 VIOLATED — remote prompt (${label}) leaked the global catalog: ${remotePrompt}`,
      );
      assert.ok(
        !/PrivateJournal/.test(remotePrompt),
        `INVARIANT 2 VIOLATED — remote prompt (${label}) leaked an uncurated local: ${remotePrompt}`,
      );
    }
  } finally {
    await h.stop();
  }
});

test('P1-1: search finds the pooled object and chains on miss locally, and does neither remotely', async () => {
  const h = await harness();
  try {
    const localWeather = names(await h.local.ask(h.wsReg.id, 'search', { query: 'weather' }));
    assert.ok(
      localWeather.includes('SeattleWeather'),
      `INVARIANT 1 VIOLATED — local search lost the pooled object: ${JSON.stringify(localWeather)}`,
    );

    const localHttp = names(await h.local.ask(h.wsReg.id, 'search', { query: 'HttpClientLike' }));
    assert.ok(
      localHttp.includes('HttpClientLike'),
      `INVARIANT 1 VIOLATED — local search lost the miss-only fallback chain: ${JSON.stringify(localHttp)}`,
    );

    for (const caller of [h.peerAgent, h.weatherProxy]) {
      const rWeather = names(await caller.ask(h.wsReg.id, 'search', { query: 'weather' }));
      assert.ok(
        !rWeather.includes('SeattleWeather'),
        `INVARIANT 2 VIOLATED — remote search revealed a pooled object: ${JSON.stringify(rWeather)}`,
      );
      const rHttp = names(await caller.ask(h.wsReg.id, 'search', { query: 'HttpClientLike' }));
      assert.ok(
        !rHttp.includes('HttpClientLike'),
        `INVARIANT 2 VIOLATED — remote search chained to the global registry: ${JSON.stringify(rHttp)}`,
      );
      const rPublic = names(await caller.ask(h.wsReg.id, 'search', { query: 'PublicNotes' }));
      assert.ok(rPublic.includes('PublicNotes'), `remote search must keep the whitelist: ${JSON.stringify(rPublic)}`);
    }
  } finally {
    await h.stop();
  }
});

test('P1-2: curation keyed on a durable NAME exposes an object minted after curation', async () => {
  const h = await harness();
  try {
    // Curate by name only — no AbjectId is known to the selector set at all.
    (h.wsReg as unknown as { setExposedSelectors: (s: unknown) => void }).setExposedSelectors({
      names: ['LaterNotes'],
    });

    let remote = names(await h.peerAgent.ask(h.wsReg.id, 'list', {}));
    assert.ok(
      !remote.includes('PublicNotes'),
      `re-curation must drop the old whitelist entry: ${JSON.stringify(remote)}`,
    );

    // Now mint the object. Its id did not exist when curation was written — this
    // is the id churn a host restart produces.
    const reborn = new Fixture('LaterNotes', 'Notes registered after curation was written');
    await reborn.init((h.wsReg as unknown as { bus: MessageBus }).bus);
    h.wsReg.registerObject(reborn.id, reborn.manifest, undefined, undefined, undefined, 'LaterNotes');
    await new Promise((r) => setTimeout(r, 20));

    remote = names(await h.peerAgent.ask(h.wsReg.id, 'list', {}));
    assert.ok(
      remote.includes('LaterNotes'),
      `P1-2 VIOLATED — name-keyed curation did not survive id churn: ${JSON.stringify(remote)}`,
    );
    assert.ok(
      !remote.includes('PrivateJournal') && !remote.includes('HttpClientLike'),
      `INVARIANT 2 VIOLATED — name-keyed curation over-exposed: ${JSON.stringify(remote)}`,
    );
    await reborn.stop().catch(() => { /* already gone */ });
  } finally {
    await h.stop();
  }
});

test('P2-1: remote reads are curated and remote WRITES are refused, source byte-identical after', async () => {
  const h = await harness();
  try {
    // resolveUri: curated read for a remote caller, unrestricted locally.
    const localResolved = await h.local.ask<{ name?: string } | null>(
      h.wsReg.id, 'resolveUri', { uri: 'PrivateJournal' },
    );
    assert.equal(localResolved?.name, 'PrivateJournal', 'INVARIANT 1 VIOLATED — local resolveUri must be unrestricted');

    const remoteOk = await h.peerAgent.ask<{ name?: string } | null>(
      h.wsReg.id, 'resolveUri', { uri: 'PublicNotes' },
    );
    assert.equal(remoteOk?.name, 'PublicNotes', 'remote resolveUri must keep the whitelist');

    for (const caller of [h.peerAgent, h.weatherProxy]) {
      const denied = await caller.ask<{ name?: string } | null>(h.wsReg.id, 'resolveUri', { uri: 'PrivateJournal' });
      assert.equal(denied, null, `INVARIANT 2 VIOLATED — remote resolveUri leaked an uncurated local: ${JSON.stringify(denied)}`);
      const chained = await caller.ask<{ name?: string } | null>(h.wsReg.id, 'resolveUri', { uri: 'HttpClientLike' });
      assert.equal(chained, null, `INVARIANT 2 VIOLATED — remote resolveUri chained to the global registry: ${JSON.stringify(chained)}`);
    }

    // Writes: refused outright.
    await assert.rejects(
      () => h.peerAgent.ask(h.wsReg.id, 'updateSource', {
        objectId: h.exposed.id, id: h.exposed.id, source: 'export class Owned {}\n',
      }),
      /refused|read-only|denied|ACCESS/i,
      'INVARIANT 2 VIOLATED — a remote updateSource was not refused',
    );
    await assert.rejects(
      () => h.peerAgent.ask(h.wsReg.id, 'updateManifest', {
        objectId: h.exposed.id, id: h.exposed.id, manifest: mkManifest('Owned', 'owned'),
      }),
      /refused|read-only|denied|ACCESS/i,
      'INVARIANT 2 VIOLATED — a remote updateManifest was not refused',
    );

    // ...and A's source is byte-identical afterwards.
    const after = await h.local.ask<unknown>(h.wsReg.id, 'getSource', {
      objectId: h.exposed.id, id: h.exposed.id,
    });
    const text = typeof after === 'string' ? after : (after as { source?: string } | null)?.source;
    assert.equal(text, SOURCE_A, 'INVARIANT 2 VIOLATED — a refused remote write still mutated the source');
  } finally {
    await h.stop();
  }
});
