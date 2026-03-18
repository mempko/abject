/**
 * Dedicated P2P Worker — runs Identity, PeerRegistry, SignalingRelay,
 * PeerDiscovery, and RemoteRegistry in a separate worker_thread.
 *
 * Protocol:
 *   1. Polyfill WebRTC (node-datachannel)
 *   2. Main thread sends { type: 'init-config', config: { identityId, peerRegistryId, ... } }
 *   3. Worker bootstraps P2P objects sequentially (Identity → PeerRegistry → ...)
 *   4. Worker wires onRemoteMessage → post { type: 'remote-message' } to main
 *   5. Worker wires connect/disconnect → post { type: 'peer-status' } to main
 *   6. Worker handles { type: 'send-to-peer' } from main → finds transport, sends
 *   7. Worker posts { type: 'ready' }
 *
 * After ready:
 *   - Abject messages are routed via WorkerBus ↔ main bus (standard bus:deliver/bus:reply)
 *   - Peer transport send/receive uses custom messages (send-to-peer, remote-message)
 */

// Polyfill WebRTC APIs for Node.js before any imports that use them
import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  RTCDataChannel,
} from 'node-datachannel/polyfill';

Object.assign(globalThis, {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  RTCDataChannel,
});

import { parentPort } from 'node:worker_threads';
import { AbjectId, AbjectMessage, TypeId } from '../src/core/types.js';
import { request as createRequest } from '../src/core/message.js';
import { WorkerBus } from '../src/runtime/worker-bus.js';
import type { WorkerInboundMessage } from '../src/runtime/worker-bridge.js';
import { IdentityObject } from '../src/objects/identity.js';
import { PeerRegistry } from '../src/objects/peer-registry.js';
import { RemoteRegistry } from '../src/objects/remote-registry.js';
import { SignalingRelayObject } from '../src/objects/signaling-relay.js';
import { PeerDiscoveryObject } from '../src/objects/peer-discovery.js';
import type { PeerId } from '../src/core/identity.js';
import { Log } from '../src/core/timed-log.js';

if (!parentPort) {
  throw new Error('p2p-worker-node.ts must be run inside a worker_threads Worker');
}

const port = parentPort;
const log = new Log('P2PWorker');

// Worker state
const workerBus = new WorkerBus((data) => port.postMessage(data));
let peerRegistryObj: PeerRegistry | null = null;

interface P2PConfig {
  identityId: string;
  peerRegistryId: string;
  remoteRegistryId: string;
  signalingRelayId: string;
  peerDiscoveryId: string;
  registryId: string;
  identityTypeId?: string;
  peerRegistryTypeId?: string;
  remoteRegistryTypeId?: string;
  signalingRelayTypeId?: string;
  peerDiscoveryTypeId?: string;
}

/**
 * Bootstrap P2P objects sequentially within the worker.
 */
async function bootstrapP2P(config: P2PConfig): Promise<void> {
  const identityId = config.identityId as AbjectId;
  const peerRegistryId = config.peerRegistryId as AbjectId;
  const remoteRegistryId = config.remoteRegistryId as AbjectId;
  const signalingRelayId = config.signalingRelayId as AbjectId;
  const peerDiscoveryId = config.peerDiscoveryId as AbjectId;
  const mainRegistryId = config.registryId as AbjectId;

  // 1. Identity
  const identityObj = new IdentityObject();
  identityObj.setId(identityId);
  identityObj.setRegistryHint(mainRegistryId);
  if (config.identityTypeId) {
    identityObj.setTypeId(config.identityTypeId as TypeId);
  }
  await identityObj.init(workerBus);
  log.info('IdentityObject initialized');

  // Get peerId by sending a message to Identity (it's local to this worker)
  try {
    const BOOT_ID = 'p2p-boot' as AbjectId;
    workerBus.register(BOOT_ID);
    const identity = await new Promise<{ peerId: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('getIdentity timed out')), 5000);
      workerBus.setReplyHandler(BOOT_ID, (msg) => {
        clearTimeout(timeout);
        workerBus.removeReplyHandler(BOOT_ID);
        workerBus.unregister(BOOT_ID);
        if (msg.header.type === 'error') {
          reject(new Error((msg.payload as { message: string }).message));
        } else {
          resolve(msg.payload as { peerId: string });
        }
      });
      workerBus.send(createRequest(BOOT_ID, identityId, 'getIdentity', {}));
    });
    port.postMessage({ type: 'peer-id', peerId: identity.peerId });
    log.info(`Local peerId: ${identity.peerId.slice(0, 16)}...`);
  } catch (err) {
    log.warn('Could not get peerId from Identity:', err);
  }

  // 2. PeerRegistry
  peerRegistryObj = new PeerRegistry();
  peerRegistryObj.setId(peerRegistryId);
  peerRegistryObj.setRegistryHint(mainRegistryId);
  if (config.peerRegistryTypeId) {
    peerRegistryObj.setTypeId(config.peerRegistryTypeId as TypeId);
  }
  await peerRegistryObj.init(workerBus);
  log.info('PeerRegistry initialized');

  // 3. SignalingRelay
  const signalingRelayObj = new SignalingRelayObject();
  signalingRelayObj.setId(signalingRelayId);
  signalingRelayObj.setRegistryHint(mainRegistryId);
  if (config.signalingRelayTypeId) {
    signalingRelayObj.setTypeId(config.signalingRelayTypeId as TypeId);
  }
  await signalingRelayObj.init(workerBus);

  // 4. PeerDiscovery
  const peerDiscoveryObj = new PeerDiscoveryObject();
  peerDiscoveryObj.setId(peerDiscoveryId);
  peerDiscoveryObj.setRegistryHint(mainRegistryId);
  if (config.peerDiscoveryTypeId) {
    peerDiscoveryObj.setTypeId(config.peerDiscoveryTypeId as TypeId);
  }
  await peerDiscoveryObj.init(workerBus);

  // 5. RemoteRegistry
  const remoteRegistryObj = new RemoteRegistry();
  remoteRegistryObj.setId(remoteRegistryId);
  remoteRegistryObj.setRegistryHint(mainRegistryId);
  if (config.remoteRegistryTypeId) {
    remoteRegistryObj.setTypeId(config.remoteRegistryTypeId as TypeId);
  }
  await remoteRegistryObj.init(workerBus);

  // Wire direct refs within the worker (same as server/index.ts did)
  signalingRelayObj.setPeerRegistry(peerRegistryObj);
  peerDiscoveryObj.setPeerRegistry(peerRegistryObj);
  peerDiscoveryObj.setSignalingRelay(signalingRelayObj);
  peerRegistryObj.setSignalingRelay(signalingRelayObj);

  log.info('P2P objects wired');

  // Wire PeerRegistry events to post messages to main thread
  peerRegistryObj.onRemoteMessage((msg: AbjectMessage, fromPeerId: PeerId) => {
    port.postMessage({
      type: 'remote-message',
      message: msg,
      fromPeerId,
    });
  });

  // Track connected peers and notify main thread on changes
  peerRegistryObj.onPeerConnected((peerId: string) => {
    const connectedPeers = peerRegistryObj!.getConnectedPeers();
    port.postMessage({
      type: 'peer-status',
      connectedPeers: connectedPeers as string[],
      event: 'connected',
      peerId,
    });
  });

  // Periodic peer-status sync: PeerRegistry's disconnect events go through
  // the Abject event system (bus), but the main thread's PeerRouter also needs
  // the connectedPeersCache to be up-to-date for synchronous isPeerConnected() checks.
  // Poll every 2s — getConnectedPeers is O(n) with n ≈ 20, very cheap.
  setInterval(() => {
    if (peerRegistryObj) {
      const connectedPeers = peerRegistryObj.getConnectedPeers();
      port.postMessage({
        type: 'peer-status',
        connectedPeers: connectedPeers as string[],
        event: 'periodic',
      });
    }
  }, 2000);

  log.info('P2P event wiring complete');
}

/**
 * Handle messages from the main thread.
 */
port.on('message', async (data: { type: string; [key: string]: unknown }) => {
  const { type } = data;

  switch (type) {
    case 'init-config': {
      const config = data.config as P2PConfig;
      log.info('Received config, bootstrapping P2P objects...');

      try {
        await bootstrapP2P(config);
        // Signal p2p-ready AFTER all objects are bootstrapped
        // (distinct from the initial 'ready' that WorkerBridge expects)
        port.postMessage({ type: 'p2p-ready' });
        log.info('P2P Worker ready');
      } catch (err) {
        log.error('P2P bootstrap failed:', err);
        port.postMessage({
          type: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'send-to-peer': {
      const peerId = data.peerId as string as PeerId;
      const message = data.message as AbjectMessage;

      if (!peerRegistryObj) {
        log.warn('send-to-peer: PeerRegistry not initialized');
        break;
      }

      const transport = peerRegistryObj.getTransportForPeer(peerId);
      if (transport?.isConnected) {
        try {
          await transport.send(message);
        } catch (err) {
          log.warn(`send-to-peer failed for ${peerId.slice(0, 16)}:`, err);
          // Notify main thread of send failure
          const connectedPeers = peerRegistryObj.getConnectedPeers();
          port.postMessage({
            type: 'peer-status',
            connectedPeers: connectedPeers as string[],
            event: 'send-failed',
            peerId: peerId as string,
          });
        }
      } else {
        log.warn(`send-to-peer: no connected transport to ${peerId.slice(0, 16)}`);
      }
      break;
    }

    // Standard WorkerBridge protocol messages
    case 'bus:deliver': {
      const msg = (data as WorkerInboundMessage).message;
      if (msg) {
        workerBus.deliverFromMain(msg);
      }
      break;
    }

    case 'bus:reply': {
      const msg = (data as WorkerInboundMessage).message;
      if (msg) {
        workerBus.deliverReplyFromMain(msg);
      }
      break;
    }

    default:
      log.warn(`Unknown message type: ${type}`);
  }
});

// Signal ready to WorkerBridge (enables waitReady() on main thread)
port.postMessage({ type: 'ready' });
log.info('P2P Worker started, waiting for init-config...');
