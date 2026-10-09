/**
 * The P2P worker for the desktop edition: the peer layer, plus RemoteUIAccess,
 * which pairs a remote browser (client.abject.world) with this desktop and
 * relays its UI traffic to the display server on the main thread.
 */

import { MessageChannel } from 'node:worker_threads';
import { RemoteUIAccess } from '../src/objects/remote-ui-access.js';
import type { UITransportLike } from '../src/network/webrtc-ui-transport.js';
import { toUIWireData, postUIWireData } from '../server/ui-transport.js';
import { setRemoteUiBuilder } from './p2p-worker-runtime.js';

setRemoteUiBuilder(async ({ objectId, typeId, registryId, bus, post }) => {
  const remoteUIAccessObj = new RemoteUIAccess();
  remoteUIAccessObj.setId(objectId);
  remoteUIAccessObj.setRegistryHint(registryId);
  if (typeId) remoteUIAccessObj.setTypeId(typeId);
  // When a remote UI client pairs, its UI bytes go to the main thread over a
  // MessagePort, so BackendUI (which lives outside this worker) can drive it.
  remoteUIAccessObj.setAttachHandler((peerId: string, transport: UITransportLike, meta?: { name?: string }) => {
    const { port1, port2 } = new MessageChannel();

    transport.onMessage((data) => postUIWireData(port1, data));
    port1.on('message', (data) => {
      if (transport.ready) transport.send(toUIWireData(data));
    });

    transport.onClose(() => port1.close());
    port1.on('close', () => {
      if (transport.ready) transport.close();
    });

    post({ type: 'remote-ui-attach', peerId, meta, transferPort: port2 }, [port2]);
  });
  await remoteUIAccessObj.init(bus);
  return remoteUIAccessObj;
});
