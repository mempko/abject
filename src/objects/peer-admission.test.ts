/**
 * Fixed signaling and mesh admission in PeerRegistry.
 *
 * Fixed signaling: the instance uses only its configured signaling servers,
 * never ones learned from peers, contacts' addresses, or the default.
 * Admission: in allowlist mode only listed peers may connect, checked on the
 * offer, on outgoing connections, and on the proven identity at onConnect.
 * Both can be pinned by environment variables for provisioning.
 *
 * Harness: a bare PeerRegistry driven through its private surface, never
 * init(bus), with transports and network-facing calls stubbed, so nothing
 * here opens a socket.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PeerRegistry } from './peer-registry.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const HUB = 'c'.repeat(64);

const ENV_KEYS = ['ABJECTS_SIGNALING_URLS', 'ABJECTS_PEER_ADMISSION', 'ABJECTS_ALLOWED_PEERS'] as const;

/** Construct with the given environment, restoring it afterwards (tests share a process). */
function withEnv(env: Partial<Record<typeof ENV_KEYS[number], string>>): any {
  const saved = ENV_KEYS.map(k => [k, process.env[k]] as const);
  for (const k of ENV_KEYS) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    const r = new PeerRegistry() as any;
    r.localIdentity = { peerId: 'self', publicSigningKey: '', publicExchangeKey: '', name: 'self', exchangePrivateKey: {} };
    r.events = [];
    r.changed = (aspect: string, value: unknown) => r.events.push({ aspect, value });
    return r;
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A stand-in transport: captures the registry's event handlers. */
function fakeTransport(remotePeerId = '') {
  const t: any = { disconnected: 0, isConnected: true, signalingState: 'stable', remotePeerId };
  t.on = (handlers: Record<string, (...args: unknown[]) => void>) => { t.handlers = handlers; };
  t.disconnect = async () => { t.disconnected++; };
  return t;
}

test('environment pins: fixed signaling servers, allowlist mode, and always-allowed peers', async () => {
  const r = withEnv({
    ABJECTS_SIGNALING_URLS: 'wss://signal.org.example, https://not-signaling.example',
    ABJECTS_PEER_ADMISSION: 'allowlist',
    ABJECTS_ALLOWED_PEERS: `${HUB},not-a-peer-id`,
  });
  assert.deepEqual(r.signalingPolicy(), { fixed: true, pinned: true, urls: ['wss://signal.org.example'] },
    'only valid ws/wss URLs are kept');
  assert.deepEqual(r.peerAdmission(), { mode: 'allowlist', peers: [], pinnedPeers: [HUB], pinned: true });

  assert.equal((await r.setFixedSignalingImpl(false)).success, false, 'a pinned list cannot be unfixed');
  assert.equal((await r.setPeerAdmissionImpl('open', undefined)).success, false, 'a pinned mode cannot be opened');
  assert.equal((await r.disallowPeerImpl(HUB)).success, false, 'a pinned peer cannot be removed');

  const connectSignaling = r.handlers.get('connectSignaling');
  assert.equal(await connectSignaling({ payload: { url: 'wss://signal.abject.world' } }), false);
  const removeServer = r.handlers.get('removeSignalingServer');
  assert.equal(await removeServer({ payload: { url: 'wss://signal.org.example' } }), false);

  assert.equal(r.admits(HUB), true);
  assert.equal(r.admits(A), false);
});

test('fixed signaling: servers learned from peers or contacts are never used', async () => {
  const r = withEnv({});
  r.savedSignalingUrls.add('wss://ours.example');
  assert.deepEqual(r.signalingPolicy(), { fixed: false, pinned: false, urls: ['wss://ours.example'] });

  // Open (today's behaviour): gossip adds a server.
  const attempted: string[] = [];
  const realConnect = r.connectSignalingImpl.bind(r);
  r.connectSignalingImpl = async (url: string) => { attempted.push(url); return true; };
  r.addSignalingUrlFromGossip('wss://gossip-1.example');
  assert.ok(r.savedSignalingUrls.has('wss://gossip-1.example'));
  r.savedSignalingUrls.delete('wss://gossip-1.example');

  // Fixed: gossip and the federation API add nothing...
  r.connectSignalingImpl = realConnect;
  assert.deepEqual(await r.setFixedSignalingImpl(true), { success: true });
  assert.equal(r.events.at(-1).aspect, 'signalingPolicyChanged');
  r.addSignalingUrlFromGossip('wss://gossip-2.example');
  assert.equal(await r.addSignalingUrl('wss://gossip-3.example'), false);
  assert.deepEqual(Array.from(r.savedSignalingUrls), ['wss://ours.example']);

  // ...and the one gate refuses any other server before a client exists:
  // contacts' addresses and the no-signaling fallback both go through it.
  r.contacts.set(A, { identity: { peerId: A }, state: 'offline', addresses: ['wss://contact-home.example'], addedAt: 0 });
  r.tryAlternativeSignaling();
  assert.equal(await r.connectSignalingImpl('wss://elsewhere.example'), false);
  assert.equal(r.signalingClients.size, 0);
});

test('fixing signaling disconnects servers outside the list', async () => {
  const r = withEnv({});
  r.savedSignalingUrls.add('wss://ours.example');
  const closed: string[] = [];
  for (const url of ['wss://ours.example', 'wss://contact-home.example']) {
    r.signalingClients.set(url, { disconnect: async () => { closed.push(url); } });
  }
  await r.setFixedSignalingImpl(true);
  assert.deepEqual(closed, ['wss://contact-home.example']);
  assert.deepEqual(Array.from(r.signalingClients.keys()), ['wss://ours.example']);
});

test('admission: allowlist mode refuses offers, outgoing connections and proven identities not on the list', async () => {
  const r = withEnv({});
  assert.equal(r.admits(B), true, 'open by default');
  assert.deepEqual(await r.setPeerAdmissionImpl('allowlist', [A.toUpperCase()]), { success: true }, 'ids are normalised');
  assert.deepEqual(r.peerAdmission().peers, [A]);
  assert.equal(r.events.at(-1).aspect, 'peerAdmissionChanged');

  // An offer claiming to be B creates nothing.
  await r.handleIncomingSdpOffer(B, { type: 'offer', sdp: '' }, {});
  assert.equal(r.transports.has(B), false);

  // Outgoing: relay connects, signaling-peer auto-connect, contacts.
  assert.equal(await r.connectToPeerViaRelay(B, {}), false);
  const dialled: string[] = [];
  r.connectToPeerViaRelay = async (peerId: string) => { dialled.push(peerId); return true; };
  r.signalingPeers.set('wss://s', [{ peerId: A }, { peerId: B }]);
  r.autoConnectSignalingPeers('wss://s', {});
  assert.deepEqual(dialled, [A]);
  r.contacts.set(B, { identity: { peerId: B }, state: 'offline', addresses: [], addedAt: 0 });
  assert.equal(await r.connectToPeer(B), false);

  // The proven identity is checked again when the handshake completes.
  const tB = fakeTransport(B);
  r.transports.set(B, tB);
  r.setupTransportEvents(tB, B);
  tB.handlers.onConnect({ authenticatedPeerId: B, sessionEpoch: 1 });
  assert.equal(tB.disconnected, 1);
  assert.equal(r.transports.has(B), false, 'the refused transport is dropped, not left blocking a retry');
  assert.equal(r.authenticatedSessions.has(B), false);

  const tA = fakeTransport(A);
  r.transports.set(A, tA);
  r.setupTransportEvents(tA, A);
  tA.handlers.onConnect({ authenticatedPeerId: A, sessionEpoch: 1 });
  assert.equal(tA.disconnected, 0);
  assert.equal(r.authenticatedSessions.has(A), true);

  // Blocking wins over the list.
  r.blockedPeers.add(A);
  assert.equal(r.admits(A), false);
});

test('changing the list disconnects peers no longer admitted', async () => {
  const r = withEnv({});
  const tA = fakeTransport();
  const tB = fakeTransport();
  r.transports.set(A, tA);
  r.transports.set(B, tB);
  r.networkPeers.set(B, { identity: { peerId: B }, connectedAt: 0 });

  await r.setPeerAdmissionImpl('allowlist', [A]);
  assert.deepEqual([tA.disconnected, tB.disconnected], [0, 1]);
  assert.deepEqual(Array.from(r.transports.keys()), [A]);
  assert.equal(r.networkPeers.has(B), false);

  await r.disallowPeerImpl(A);
  assert.equal(tA.disconnected, 1);
  assert.equal((await r.allowPeerImpl('nope')).success, false);
  assert.equal((await r.setPeerAdmissionImpl('closed', undefined)).success, false);
  assert.equal((await r.setPeerAdmissionImpl(undefined, ['short'])).success, false);
  assert.equal((await r.setPeerAdmissionImpl('open', undefined)).success, true);
  assert.equal(r.admits(B), true);
});

test('the policy persists, and a pinned setting keeps the stored choice for later', async () => {
  const stored = { fixedSignaling: false, admissionMode: 'open', allowedPeers: [A, 'junk'] };
  const writes: unknown[] = [];
  const stub = (r: any) => {
    r.storageId = 'storage';
    r.request = async (msg: any) => {
      if (msg.routing.method === 'get') return stored;
      writes.push(msg.payload.value);
      return true;
    };
  };

  const plain = withEnv({});
  stub(plain);
  await plain.loadNetworkPolicy();
  assert.deepEqual(plain.peerAdmission().peers, [A], 'invalid stored ids are dropped');
  await plain.setFixedSignalingImpl(true);
  assert.deepEqual(writes.at(-1), { fixedSignaling: true, admissionMode: 'open', allowedPeers: [A] });

  const pinned = withEnv({ ABJECTS_PEER_ADMISSION: 'allowlist', ABJECTS_SIGNALING_URLS: 'wss://pinned.example' });
  stub(pinned);
  await pinned.loadNetworkPolicy();
  assert.equal(pinned.peerAdmission().mode, 'allowlist');
  await pinned.allowPeerImpl(B);
  assert.deepEqual(writes.at(-1), { fixedSignaling: false, admissionMode: 'open', allowedPeers: [A, B] },
    'the stored (unpinned) choices are written back unchanged');
});
