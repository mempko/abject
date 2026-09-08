import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PeerTransport } from './peer-transport.js';
import { derivePeerIdFromJwk, type PeerId } from '../core/identity.js';
import type { AuthenticatedSessionMetadata } from './transport.js';

class FakeDataChannel {
  readyState: RTCDataChannelState = 'open';
  binaryType: BinaryType = 'arraybuffer';
  onopen: ((this: RTCDataChannel, ev: Event) => unknown) | null = null;
  onclose: ((this: RTCDataChannel, ev: Event) => unknown) | null = null;
  onerror: ((this: RTCDataChannel, ev: Event) => unknown) | null = null;
  onmessage: ((this: RTCDataChannel, ev: MessageEvent) => unknown) | null = null;
  sent: Array<string | ArrayBuffer | ArrayBufferView | Blob> = [];
  closeCount = 0;

  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCount++;
    this.readyState = 'closed';
  }
}

interface IdentityFixture {
  peerId: PeerId;
  signingPublicJwk: string;
  exchangePublicJwk: string;
  exchangePrivateKey: CryptoKey;
}

async function identity(): Promise<IdentityFixture> {
  const signing = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  const exchange = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits', 'deriveKey'],
  ) as CryptoKeyPair;
  const signingPublicJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', signing.publicKey));
  const exchangePublicJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', exchange.publicKey));
  return {
    peerId: await derivePeerIdFromJwk(signingPublicJwk),
    signingPublicJwk,
    exchangePublicJwk,
    exchangePrivateKey: exchange.privateKey,
  };
}

const identities = Promise.all([identity(), identity()]);

async function harness(heartbeatInterval = 10_000) {
  const [local, remote] = await identities;
  const transport = new PeerTransport({
    localPeerId: local.peerId,
    remotePeerId: remote.peerId,
    signalingClient: {
      sendSdpOffer() {},
      sendSdpAnswer() {},
      sendIceCandidate() {},
    } as any,
    localPublicSigningKey: local.signingPublicJwk,
    localPublicExchangeKey: local.exchangePublicJwk,
    localExchangePrivateKey: local.exchangePrivateKey,
    heartbeatInterval,
  }) as any;
  const authenticate = async (channel: FakeDataChannel): Promise<AuthenticatedSessionMetadata> => {
    transport.dataChannel = channel as unknown as RTCDataChannel;
    await transport.handleHandshakeMessage({
      peerId: remote.peerId,
      publicSigningKey: remote.signingPublicJwk,
      publicExchangeKey: remote.exchangePublicJwk,
    }, channel as unknown as RTCDataChannel);
    return transport.authenticatedSession as AuthenticatedSessionMetadata;
  };
  return { transport, authenticate, remote };
}

test('reconnect binds the peer identity to a strictly newer session epoch', async () => {
  const first = await harness();
  const firstConnects: AuthenticatedSessionMetadata[] = [];
  first.transport.on({ onConnect: (session: AuthenticatedSessionMetadata | undefined) => session && firstConnects.push(session) });
  const epoch1 = await first.authenticate(new FakeDataChannel());
  first.transport.stopPing();

  const second = await harness();
  const secondConnects: AuthenticatedSessionMetadata[] = [];
  second.transport.on({ onConnect: (session: AuthenticatedSessionMetadata | undefined) => session && secondConnects.push(session) });
  const epoch2 = await second.authenticate(new FakeDataChannel());
  second.transport.stopPing();

  assert.equal(epoch1.authenticatedPeerId, first.remote.peerId);
  assert.equal(epoch2.authenticatedPeerId, first.remote.peerId);
  assert.ok(epoch2.sessionEpoch > epoch1.sessionEpoch);
  assert.deepEqual(firstConnects, [epoch1]);
  assert.deepEqual(secondConnects, [epoch2]);
});

test('valid authenticated current-session traffic renews the lease', async () => {
  const { transport, authenticate } = await harness();
  const channel = new FakeDataChannel();
  const session = await authenticate(channel);
  transport.stopPing();
  transport.lastAuthenticatedTrafficAt = 1;

  await transport.handleIncomingString(JSON.stringify({ pong: true }), channel as unknown as RTCDataChannel);

  assert.ok(transport.lastAuthenticatedTrafficAt > 1);
  assert.equal(transport.isCurrentSession(channel as unknown as RTCDataChannel, session), true);
  await transport.disconnect();
});

test('lease expiry uses centralized cleanup and emits one disconnect', async () => {
  const { transport, authenticate } = await harness(5);
  const channel = new FakeDataChannel();
  const disconnects: Array<{ reason?: string; session?: AuthenticatedSessionMetadata }> = [];
  transport.on({
    onDisconnect: (reason: string | undefined, session: AuthenticatedSessionMetadata | undefined) => {
      disconnects.push({ reason, session });
    },
  });
  const session = await authenticate(channel);
  transport.lastAuthenticatedTrafficAt = Date.now() - 100;

  await new Promise((resolve) => setTimeout(resolve, 30));
  transport.handleDisconnect('delayed duplicate', session);

  assert.equal(channel.closeCount, 1);
  assert.equal(disconnects.length, 1);
  assert.equal(disconnects[0].reason, 'Authenticated traffic lease expired');
  assert.deepEqual(disconnects[0].session, session);
  assert.equal(transport.connectionState, 'disconnected');
});

test('stale prior-epoch traffic is rejected before chunk assembly or lease refresh', async () => {
  const { transport, authenticate } = await harness();
  const oldChannel = new FakeDataChannel();
  const oldSession = await authenticate(oldChannel);
  transport.stopPing();
  transport.resetForGlare();

  const currentChannel = new FakeDataChannel();
  const currentSession = await authenticate(currentChannel);
  transport.stopPing();
  transport.lastAuthenticatedTrafficAt = 123;
  const staleChunk = new Uint8Array(9);
  staleChunk[0] = 0x05;
  new DataView(staleChunk.buffer).setUint16(7, 2, false);

  await transport.handleIncomingBinary(staleChunk, oldChannel as unknown as RTCDataChannel);
  await transport.handleIncomingString(JSON.stringify({ pong: true }), oldChannel as unknown as RTCDataChannel);

  assert.ok(currentSession.sessionEpoch > oldSession.sessionEpoch);
  assert.equal(transport.pendingChunks.size, 0);
  assert.equal(transport.lastAuthenticatedTrafficAt, 123);
  assert.deepEqual(transport.authenticatedSession, currentSession);
  await transport.disconnect();
});
