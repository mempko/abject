/**
 * SignalingRelayObject — relays SDP/ICE signaling between peers over DataChannel.
 *
 * Every connected peer can act as a signaling relay, enabling new peer connections
 * even when the central signaling server is down. Implements SignalingRelay so it
 * can be used as a drop-in replacement for SignalingClient in PeerTransport.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require as precondition } from '../core/contracts.js';
import { event as createEvent } from '../core/message.js';
import { Log } from '../core/timed-log.js';

const log = new Log('SignalingRelay');
import type { PeerId } from '../core/identity.js';
import type { SignalingRelay } from '../network/signaling.js';
import type { PeerRegistry } from './peer-registry.js';

const SIGNALING_RELAY_INTERFACE = 'abjects:signaling-relay' as InterfaceId;
const PEER_REGISTRY_INTERFACE = 'abjects:peer-registry' as InterfaceId;

export const SIGNALING_RELAY_ID = 'abjects:signaling-relay' as AbjectId;

const MAX_TTL = 2;

export class SignalingRelayObject extends Abject implements SignalingRelay {
  private peerRegistry?: PeerRegistry;
  private localPeerId?: PeerId;

  constructor() {
    super({
      manifest: {
        name: 'SignalingRelay',
        description:
          'Relays SDP/ICE signaling between peers over DataChannel, enabling peer connections without a central signaling server.',
        version: '1.0.0',
        interface: {
          id: SIGNALING_RELAY_INTERFACE,
          name: 'SignalingRelay',
          description: 'Peer-to-peer signaling relay',
          methods: [
            {
              name: 'relayOffer',
              description: 'Relay an SDP offer to a target peer',
              parameters: [
                { name: 'fromPeerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Originating peer ID' },
                { name: 'targetPeerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Target peer ID' },
                { name: 'sdp', type: { kind: 'reference', reference: 'RTCSessionDescriptionInit' }, description: 'SDP offer' },
                { name: 'ttl', type: { kind: 'primitive', primitive: 'number' }, description: 'Time-to-live hops', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'relayAnswer',
              description: 'Relay an SDP answer to a target peer',
              parameters: [
                { name: 'fromPeerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Originating peer ID' },
                { name: 'targetPeerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Target peer ID' },
                { name: 'sdp', type: { kind: 'reference', reference: 'RTCSessionDescriptionInit' }, description: 'SDP answer' },
                { name: 'ttl', type: { kind: 'primitive', primitive: 'number' }, description: 'Time-to-live hops', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'relayIceCandidate',
              description: 'Relay an ICE candidate to a target peer',
              parameters: [
                { name: 'fromPeerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Originating peer ID' },
                { name: 'targetPeerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Target peer ID' },
                { name: 'candidate', type: { kind: 'reference', reference: 'RTCIceCandidateInit' }, description: 'ICE candidate' },
                { name: 'ttl', type: { kind: 'primitive', primitive: 'number' }, description: 'Time-to-live hops', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'findRelay',
              description: 'Find a connected peer that can reach the target',
              parameters: [
                { name: 'targetPeerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Target peer ID' },
              ],
              returns: { kind: 'primitive', primitive: 'string' },
            },
          ],
          events: [
            {
              name: 'relayReceived',
              description: 'A signaling relay message was processed',
              payload: { kind: 'object', properties: {
                type: { kind: 'primitive', primitive: 'string' },
                fromPeerId: { kind: 'primitive', primitive: 'string' },
                targetPeerId: { kind: 'primitive', primitive: 'string' },
              } },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'peer'],
      },
    });
    this.setupHandlers();
  }

  /**
   * Wire the PeerRegistry for transport access.
   */
  setPeerRegistry(registry: PeerRegistry): void {
    this.peerRegistry = registry;
    this.localPeerId = registry.getLocalPeerId();

    // Listen for relay messages from remote peers
    registry.onSignalingRelayMessage((msg, fromPeerId) => {
      this.handleRelayMessage(msg, fromPeerId);
    });
  }

  // ==========================================================================
  // SignalingRelay interface — used by PeerTransport as drop-in replacement
  // ==========================================================================

  sendSdpOffer(fromPeerId: PeerId, targetPeerId: PeerId, sdp: RTCSessionDescriptionInit): void {
    this.relayMessage('sdp-offer', fromPeerId, targetPeerId, { sdp }, MAX_TTL);
  }

  sendSdpAnswer(fromPeerId: PeerId, targetPeerId: PeerId, sdp: RTCSessionDescriptionInit): void {
    this.relayMessage('sdp-answer', fromPeerId, targetPeerId, { sdp }, MAX_TTL);
  }

  sendIceCandidate(fromPeerId: PeerId, targetPeerId: PeerId, candidate: RTCIceCandidateInit): void {
    this.relayMessage('ice-candidate', fromPeerId, targetPeerId, { candidate }, MAX_TTL);
  }

  // ==========================================================================
  // Handlers
  // ==========================================================================

  private setupHandlers(): void {
    this.on('relayOffer', async (msg: AbjectMessage) => {
      const { fromPeerId, targetPeerId, sdp, ttl } = msg.payload as {
        fromPeerId: string; targetPeerId: string; sdp: RTCSessionDescriptionInit; ttl?: number;
      };
      return this.relayMessage('sdp-offer', fromPeerId, targetPeerId, { sdp }, ttl ?? MAX_TTL);
    });

    this.on('relayAnswer', async (msg: AbjectMessage) => {
      const { fromPeerId, targetPeerId, sdp, ttl } = msg.payload as {
        fromPeerId: string; targetPeerId: string; sdp: RTCSessionDescriptionInit; ttl?: number;
      };
      return this.relayMessage('sdp-answer', fromPeerId, targetPeerId, { sdp }, ttl ?? MAX_TTL);
    });

    this.on('relayIceCandidate', async (msg: AbjectMessage) => {
      const { fromPeerId, targetPeerId, candidate, ttl } = msg.payload as {
        fromPeerId: string; targetPeerId: string; candidate: RTCIceCandidateInit; ttl?: number;
      };
      return this.relayMessage('ice-candidate', fromPeerId, targetPeerId, { candidate }, ttl ?? MAX_TTL);
    });

    this.on('findRelay', async (msg: AbjectMessage) => {
      const { targetPeerId } = msg.payload as { targetPeerId: string };
      return this.findRelayImpl(targetPeerId);
    });
  }

  // ==========================================================================
  // Relay Logic
  // ==========================================================================

  /**
   * Relay a signaling message to the target peer.
   * If target is directly connected, deliver. Otherwise forward with TTL-1.
   */
  private relayMessage(
    type: string,
    fromPeerId: string,
    targetPeerId: string,
    data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit },
    ttl: number,
  ): boolean {
    if (!this.peerRegistry) return false;
    if (ttl <= 0) return false;

    // Build relay message for DataChannel transport
    const relayMsg = createEvent(this.id, 'abjects:peer-registry' as AbjectId, '_signalingRelay', {
      relayType: type,
      fromPeerId,
      targetPeerId,
      ...data,
      ttl,
    });

    // If target is directly connected, deliver to them
    if (this.peerRegistry.hasTransportTo(targetPeerId)) {
      this.peerRegistry.sendToPeer(targetPeerId, relayMsg).catch(e => log.error('relay error', e));
      return true;
    }

    // Otherwise forward to all connected peers with TTL-1
    if (ttl > 1) {
      const connectedPeers = this.peerRegistry.getConnectedPeers();
      for (const peerId of connectedPeers) {
        if (peerId === fromPeerId) continue; // don't send back to sender
        const fwdMsg = createEvent(this.id, 'abjects:peer-registry' as AbjectId, '_signalingRelay', {
          relayType: type,
          fromPeerId,
          targetPeerId,
          ...data,
          ttl: ttl - 1,
        });
        this.peerRegistry.sendToPeer(peerId, fwdMsg).catch(e => log.error('relay error', e));
      }
    }

    return true;
  }

  /**
   * Handle an incoming relay message from a remote peer.
   */
  private handleRelayMessage(msg: AbjectMessage, _fromPeerId: PeerId): void {
    const { relayType, fromPeerId, targetPeerId, sdp, candidate, ttl } = msg.payload as {
      relayType: string; fromPeerId: string; targetPeerId: string;
      sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit;
      ttl: number;
    };

    this.changed('relayReceived', { type: relayType, fromPeerId, targetPeerId });

    // If the message is for us, process it locally
    if (targetPeerId === this.localPeerId) {
      this.handleLocalRelay(relayType, fromPeerId, sdp, candidate);
      return;
    }

    // Otherwise relay it further
    this.relayMessage(relayType, fromPeerId, targetPeerId, { sdp, candidate }, ttl - 1);
  }

  /**
   * Process a relay message destined for this peer.
   * Creates/updates transports via PeerRegistry for incoming SDP.
   */
  private handleLocalRelay(
    type: string,
    fromPeerId: string,
    sdp?: RTCSessionDescriptionInit,
    candidate?: RTCIceCandidateInit,
  ): void {
    if (!this.peerRegistry) return;

    // Get existing transport or signal PeerRegistry to create one
    const transport = this.peerRegistry.getTransportForPeer(fromPeerId);

    if (type === 'sdp-offer' && sdp) {
      if (transport) {
        transport.handleSdpOffer(sdp).catch(e => log.error('relay error', e));
      } else {
        // No transport yet — create one via PeerRegistry (this acts as SignalingRelay)
        this.peerRegistry.connectToPeerViaRelay(fromPeerId, this).catch(e => log.error('relay error', e));
        // The SDP offer will need to be re-sent once the transport is created
        // For simplicity, we handle it by creating the transport and immediately processing
        setTimeout(() => {
          const newTransport = this.peerRegistry?.getTransportForPeer(fromPeerId);
          if (newTransport) {
            newTransport.handleSdpOffer(sdp).catch(e => log.error('relay error', e));
          }
        }, 100);
      }
    } else if (type === 'sdp-answer' && sdp && transport) {
      transport.handleSdpAnswer(sdp).catch(e => log.error('relay error', e));
    } else if (type === 'ice-candidate' && candidate && transport) {
      transport.handleIceCandidate(candidate).catch(e => log.error('relay error', e));
    }
  }

  /**
   * Find a connected peer that can reach the target.
   */
  private findRelayImpl(targetPeerId: string): string | null {
    if (!this.peerRegistry) return null;

    // Check if we're directly connected
    if (this.peerRegistry.hasTransportTo(targetPeerId)) {
      return this.localPeerId ?? null;
    }

    // We don't have global routing knowledge here — return null.
    // PeerDiscoveryObject handles the gossip-based discovery.
    return null;
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
  }
}
