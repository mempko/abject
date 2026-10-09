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
 *   - Abject messages are routed via WorkerBus ↔ main bus (standard bus:deliver)
 *   - Peer transport send/receive uses custom messages (send-to-peer, remote-message)
 */

// Polyfill Web Crypto API for Node.js worker threads (not global before Node 19)
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) {
  Object.assign(globalThis, { crypto: webcrypto });
}

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
import type { Abject } from '../src/core/abject.js';
import type { TransferListItem } from 'node:worker_threads';
import type { WorkerBus as WorkerBusType } from '../src/runtime/worker-bus.js';

/** Builds the paired-browser access object for an edition that has a display. */
export type RemoteUiBuilder = (args: {
  objectId: AbjectId;
  typeId?: TypeId;
  registryId: AbjectId;
  bus: WorkerBusType;
  /** Post to the main thread, transferring ports. */
  post: (data: unknown, transfer: TransferListItem[]) => void;
}) => Promise<Abject>;

let remoteUiBuilder: RemoteUiBuilder | undefined;

/** Called by the desktop edition's entry before the worker is configured. */
export function setRemoteUiBuilder(builder: RemoteUiBuilder): void {
  remoteUiBuilder = builder;
}

if (!parentPort) {
  throw new Error('the P2P worker must be run inside a worker_threads Worker');
}

const port = parentPort;
const log = new Log('P2PWorker');

// Worker state
const workerBus = new WorkerBus((data) => port.postMessage(data));
let peerRegistryObj: PeerRegistry | null = null;

/**
 * Every object this worker constructs, in construction order.
 *
 * Shutdown walks it backwards. PeerRegistry.onStop() is the reason it
 * exists: it closes every peer transport, stops the auto-connect loop and
 * disconnects the signaling client, and until now nothing ever called it —
 * these objects live inside this thread, so the main thread's runtime.stop()
 * never saw them and the worker went on dialing new peers after the runtime
 * was gone.
 */
const p2pObjects: Array<{ stop(): Promise<void> }> = [];
let peerStatusTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Shut libdatachannel down from inside this worker, on the thread that owns
 * every PeerConnection in the process.
 *
 * The native state is process-global, but the bridge back to JS is not:
 * node-datachannel calls into JS through thread-safe functions bound to the
 * env that created the connections, and that env is this one. Draining from
 * the main thread after this thread was terminated drained nothing — the env
 * those callbacks targeted no longer existed, so `cleanup()` returned in
 * milliseconds having joined nothing, the RTC threads survived into the
 * library's global destructors, and exit blocked there.
 *
 * Worse, the callbacks that were still in flight had nowhere to land. One of
 * them tried to build a JS Error in an env that was already being torn down
 * and took the whole process with it:
 *
 *   FATAL ERROR: Error::Error napi_define_properties
 *     ... node_datachannel.node
 *     uv_run -> SpinEventLoopInternal -> node::worker::Worker::Run
 *
 * `Worker::Run` spinning its loop is this thread on its way out. Running
 * rtc::Cleanup() here joins the RTC threads first, so by the time the env
 * goes away there is no one left to call into it.
 *
 * Synchronous native code — it holds this thread until it converges or hits
 * the library's own 10s deadline. After PeerRegistry.onStop() has closed the
 * transports there should be nothing left to wait for.
 */
async function drainDataChannel(): Promise<boolean> {
  let dc: typeof import('node-datachannel') | undefined;
  try {
    dc = await import('node-datachannel');
  } catch (err) {
    log.warn('node-datachannel not loadable here — skipping cleanup:', err);
    return false;
  }
  const startedAt = Date.now();
  try {
    dc.cleanup();
    log.info(`node-datachannel cleanup returned in ${Date.now() - startedAt}ms`);
    return true;
  } catch (err) {
    // "cleanup timeout (possible deadlock)" lands here. Never silent again.
    log.warn(`node-datachannel cleanup failed after ${Date.now() - startedAt}ms:`, err);
    return false;
  }
}

interface P2PConfig {
  identityId: string;
  peerRegistryId: string;
  remoteRegistryId: string;
  signalingRelayId: string;
  peerDiscoveryId: string;
  remoteUIAccessId?: string;
  registryId: string;
  identityTypeId?: string;
  peerRegistryTypeId?: string;
  remoteRegistryTypeId?: string;
  signalingRelayTypeId?: string;
  peerDiscoveryTypeId?: string;
  remoteUIAccessTypeId?: string;
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
  p2pObjects.push(identityObj);
  log.info('IdentityObject initialized');

  // Get peerId by sending a message to Identity (it's local to this worker)
  try {
    const BOOT_ID = 'p2p-boot' as AbjectId;
    const bootMailbox = workerBus.register(BOOT_ID);
    workerBus.send(createRequest(BOOT_ID, identityId, 'getIdentity', {}));
    const reply = await bootMailbox.receiveTimeout(5000);
    workerBus.unregister(BOOT_ID);
    if (!reply) throw new Error('getIdentity timed out');
    if (reply.header.type === 'error') {
      throw new Error((reply.payload as { message: string }).message);
    }
    const identity = reply.payload as { peerId: string };
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
  p2pObjects.push(peerRegistryObj);
  log.info('PeerRegistry initialized');

  // 3. SignalingRelay
  const signalingRelayObj = new SignalingRelayObject();
  signalingRelayObj.setId(signalingRelayId);
  signalingRelayObj.setRegistryHint(mainRegistryId);
  if (config.signalingRelayTypeId) {
    signalingRelayObj.setTypeId(config.signalingRelayTypeId as TypeId);
  }
  await signalingRelayObj.init(workerBus);
  p2pObjects.push(signalingRelayObj);

  // 4. PeerDiscovery
  const peerDiscoveryObj = new PeerDiscoveryObject();
  peerDiscoveryObj.setId(peerDiscoveryId);
  peerDiscoveryObj.setRegistryHint(mainRegistryId);
  if (config.peerDiscoveryTypeId) {
    peerDiscoveryObj.setTypeId(config.peerDiscoveryTypeId as TypeId);
  }
  await peerDiscoveryObj.init(workerBus);
  p2pObjects.push(peerDiscoveryObj);

  // 5. RemoteRegistry
  const remoteRegistryObj = new RemoteRegistry();
  remoteRegistryObj.setId(remoteRegistryId);
  remoteRegistryObj.setRegistryHint(mainRegistryId);
  if (config.remoteRegistryTypeId) {
    remoteRegistryObj.setTypeId(config.remoteRegistryTypeId as TypeId);
  }
  await remoteRegistryObj.init(workerBus);
  p2pObjects.push(remoteRegistryObj);

  // Wire direct refs within the worker (same as server/index.ts did)
  signalingRelayObj.setPeerRegistry(peerRegistryObj);
  peerDiscoveryObj.setPeerRegistry(peerRegistryObj);
  peerDiscoveryObj.setSignalingRelay(signalingRelayObj);
  peerRegistryObj.setSignalingRelay(signalingRelayObj);

  log.info('P2P objects wired');

  // 6. RemoteUIAccess (desktop edition only) — also needs WebRTC, so it
  // lives here alongside the rest of the P2P stack. The desktop's entry
  // (p2p-worker-node.ts) supplies the builder; the headless edition has no
  // display for a paired browser to drive, so it supplies none.
  if (config.remoteUIAccessId && remoteUiBuilder) {
    const remoteUIAccessObj = await remoteUiBuilder({
      objectId: config.remoteUIAccessId as AbjectId,
      typeId: config.remoteUIAccessTypeId as TypeId | undefined,
      registryId: mainRegistryId,
      bus: workerBus,
      post: (data, transfer) => port.postMessage(data, transfer),
    });
    p2pObjects.push(remoteUIAccessObj);
    log.info('RemoteUIAccess initialized');
  }

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
  peerStatusTimer = setInterval(() => {
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

    case 'shutdown': {
      const shutdownStartedAt = Date.now();
      let nativeCleanup = false;
      log.info(`Shutdown requested — stopping ${p2pObjects.length} P2P objects...`);
      if (peerStatusTimer) {
        clearInterval(peerStatusTimer);
        peerStatusTimer = null;
      }
      try {
        // Backwards through construction: discovery and the relay go first so
        // nothing can start a new dial, then PeerRegistry — whose onStop()
        // closes every transport and disconnects the signaling client — and
        // Identity last.
        //
        // Each object is named and timed as it goes. "Shutdown requested" on
        // its own only ever proved the handler had been entered; a thread
        // killed halfway through this loop left a log identical to a clean
        // stop, which is how a half-torn-down PeerRegistry — transports still
        // open, libdatachannel still live — hid behind a line that said
        // nothing about finishing.
        for (const obj of [...p2pObjects].reverse()) {
          const name = obj.constructor.name;
          const objStartedAt = Date.now();
          try {
            await obj.stop();
            log.info(`  stopped ${name} (${Date.now() - objStartedAt}ms)`);
          } catch (err) {
            log.warn(`  ${name}.stop() failed after ${Date.now() - objStartedAt}ms:`, err);
          }
        }
        p2pObjects.length = 0;
        // Nothing in this thread may open a PeerConnection past this point,
        // which is the precondition for the main thread's dc.cleanup().
        peerRegistryObj = null;
        log.info(`P2P objects stopped in ${Date.now() - shutdownStartedAt}ms`);

        // Every transport is closed and nothing here can open another, so
        // this is the moment to join libdatachannel's threads — while this
        // env is still alive to receive whatever they have left to say.
        nativeCleanup = await drainDataChannel();
      } catch (err) {
        log.warn('P2P shutdown failed:', err);
      } finally {
        // Always answer. A worker that cannot finish its teardown must still
        // release the main thread rather than make it wait out the timeout —
        // and an escaping rejection here would take the whole thread down.
        // `nativeCleanup` tells the main thread whether libdatachannel is
        // already down. If it is, that thread must not load the addon again
        // just to call cleanup() a second time from an env that never owned
        // a connection.
        port.postMessage({ type: 'shutdown-complete', nativeCleanup });
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

    default:
      log.warn(`Unknown message type: ${type}`);
  }
});

// Signal ready to WorkerBridge (enables waitReady() on main thread)
port.postMessage({ type: 'ready' });
log.info('P2P Worker started, waiting for init-config...');
