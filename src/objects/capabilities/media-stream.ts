/**
 * MediaStream capability — WebRTC media track management for peer connections.
 *
 * Extends existing PeerTransport connections with MediaStream track support.
 * Provides getUserMedia/getDisplayMedia access and track lifecycle events.
 * This is infrastructure only — no built-in voice/video app.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { Capabilities } from '../../core/capability.js';
import { require as precondition } from '../../core/contracts.js';
import { request as createRequest } from '../../core/message.js';
import type { PeerId } from '../../core/identity.js';

const MEDIA_STREAM_INTERFACE: InterfaceId = 'abjects:media-stream';

export const MEDIA_STREAM_ID = 'abjects:media-stream' as AbjectId;

interface ManagedTrack {
  id: string;
  peerId: string;
  kind: 'audio' | 'video';
  direction: 'local' | 'remote';
  label: string;
  muted: boolean;
}

export class MediaStreamCapability extends Abject {
  private peerRegistryId?: AbjectId;
  private localStreams: Map<string, MediaStream> = new Map();
  private tracks: Map<string, ManagedTrack> = new Map();

  constructor() {
    super({
      manifest: {
        name: 'MediaStream',
        description:
          'WebRTC MediaStream track management. Add/remove audio and video tracks to peer connections. Provides getUserMedia and getDisplayMedia access.',
        version: '1.0.0',
        interface: {
          id: MEDIA_STREAM_INTERFACE,
          name: 'MediaStream',
          description: 'Media track management for peer connections',
          methods: [
            {
              name: 'getUserMedia',
              description: 'Request access to microphone and/or camera',
              parameters: [
                { name: 'audio', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Request audio', optional: true },
                { name: 'video', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Request video', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'string' }, // stream ID
            },
            {
              name: 'getDisplayMedia',
              description: 'Request screen share access',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'string' }, // stream ID
            },
            {
              name: 'addTrack',
              description: 'Add a local media track to a peer connection',
              parameters: [
                { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Target peer ID' },
                { name: 'streamId', type: { kind: 'primitive', primitive: 'string' }, description: 'Local stream ID' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'removeTrack',
              description: 'Remove a media track from a peer connection',
              parameters: [
                { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Peer ID' },
                { name: 'trackId', type: { kind: 'primitive', primitive: 'string' }, description: 'Track ID to remove' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'muteTrack',
              description: 'Mute/unmute a local track',
              parameters: [
                { name: 'trackId', type: { kind: 'primitive', primitive: 'string' }, description: 'Track ID' },
                { name: 'muted', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Whether to mute' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'stopStream',
              description: 'Stop all tracks in a local stream and release resources',
              parameters: [
                { name: 'streamId', type: { kind: 'primitive', primitive: 'string' }, description: 'Stream ID to stop' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'listTracks',
              description: 'List all managed tracks (local and remote)',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'ManagedTrack' } },
            },
          ],
          events: [
            {
              name: 'trackAdded',
              description: 'A remote track was added to a peer connection',
              payload: { kind: 'object', properties: {
                peerId: { kind: 'primitive', primitive: 'string' },
                trackId: { kind: 'primitive', primitive: 'string' },
                kind: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'trackRemoved',
              description: 'A track was removed from a peer connection',
              payload: { kind: 'object', properties: {
                peerId: { kind: 'primitive', primitive: 'string' },
                trackId: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'trackMuted',
              description: 'A track mute state changed',
              payload: { kind: 'object', properties: {
                trackId: { kind: 'primitive', primitive: 'string' },
                muted: { kind: 'primitive', primitive: 'boolean' },
              } },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [
          Capabilities.MEDIA_STREAM,
        ],
        tags: ['system', 'capability', 'media-stream'],
      },
    });
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('getUserMedia', async (msg: AbjectMessage) => {
      const { audio, video } = msg.payload as { audio?: boolean; video?: boolean };
      return this.getUserMediaImpl(audio ?? true, video ?? false);
    });

    this.on('getDisplayMedia', async () => {
      return this.getDisplayMediaImpl();
    });

    this.on('addTrack', async (msg: AbjectMessage) => {
      const { peerId, streamId } = msg.payload as { peerId: string; streamId: string };
      return this.addTrackImpl(peerId, streamId);
    });

    this.on('removeTrack', async (msg: AbjectMessage) => {
      const { peerId, trackId } = msg.payload as { peerId: string; trackId: string };
      return this.removeTrackImpl(peerId, trackId);
    });

    this.on('muteTrack', async (msg: AbjectMessage) => {
      const { trackId, muted } = msg.payload as { trackId: string; muted: boolean };
      return this.muteTrackImpl(trackId, muted);
    });

    this.on('stopStream', async (msg: AbjectMessage) => {
      const { streamId } = msg.payload as { streamId: string };
      return this.stopStreamImpl(streamId);
    });

    this.on('listTracks', async () => {
      return Array.from(this.tracks.values());
    });
  }

  protected override async onInit(): Promise<void> {
    this.peerRegistryId = await this.discoverDep('PeerRegistry') ?? undefined;
  }

  // ==========================================================================
  // Media capture
  // ==========================================================================

  private async getUserMediaImpl(audio: boolean, video: boolean): Promise<string> {
    precondition(audio || video, 'Must request at least audio or video');

    // getUserMedia is available in browser context
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      throw new Error('getUserMedia not available (server-side)');
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio, video });
    const streamId = stream.id;
    this.localStreams.set(streamId, stream);

    for (const track of stream.getTracks()) {
      this.tracks.set(track.id, {
        id: track.id,
        peerId: '', // local
        kind: track.kind as 'audio' | 'video',
        direction: 'local',
        label: track.label,
        muted: !track.enabled,
      });
    }

    return streamId;
  }

  private async getDisplayMediaImpl(): Promise<string> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      throw new Error('getDisplayMedia not available (server-side)');
    }

    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const streamId = stream.id;
    this.localStreams.set(streamId, stream);

    for (const track of stream.getTracks()) {
      this.tracks.set(track.id, {
        id: track.id,
        peerId: '',
        kind: track.kind as 'audio' | 'video',
        direction: 'local',
        label: track.label,
        muted: !track.enabled,
      });
    }

    return streamId;
  }

  // ==========================================================================
  // Track management
  // ==========================================================================

  private async addTrackImpl(peerId: string, streamId: string): Promise<boolean> {
    const stream = this.localStreams.get(streamId);
    if (!stream) return false;

    // Get the PeerTransport's RTCPeerConnection
    const pc = await this.getPeerConnection(peerId);
    if (!pc) return false;

    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
      const managedTrack = this.tracks.get(track.id);
      if (managedTrack) {
        managedTrack.peerId = peerId;
      }
    }

    return true;
  }

  private async removeTrackImpl(peerId: string, trackId: string): Promise<boolean> {
    const pc = await this.getPeerConnection(peerId);
    if (!pc) return false;

    const senders = pc.getSenders();
    for (const sender of senders) {
      if (sender.track?.id === trackId) {
        pc.removeTrack(sender);
        this.tracks.delete(trackId);
        this.changed('trackRemoved', { peerId, trackId });
        return true;
      }
    }
    return false;
  }

  private muteTrackImpl(trackId: string, muted: boolean): boolean {
    // Find the track in local streams
    for (const stream of this.localStreams.values()) {
      for (const track of stream.getTracks()) {
        if (track.id === trackId) {
          track.enabled = !muted;
          const managed = this.tracks.get(trackId);
          if (managed) managed.muted = muted;
          this.changed('trackMuted', { trackId, muted });
          return true;
        }
      }
    }
    return false;
  }

  private stopStreamImpl(streamId: string): boolean {
    const stream = this.localStreams.get(streamId);
    if (!stream) return false;

    for (const track of stream.getTracks()) {
      track.stop();
      this.tracks.delete(track.id);
    }
    this.localStreams.delete(streamId);
    return true;
  }

  // ==========================================================================
  // PeerConnection access
  // ==========================================================================

  /**
   * Get the RTCPeerConnection for a given peer via PeerRegistry.
   * PeerTransport exposes the RTCPeerConnection for media track management.
   */
  private async getPeerConnection(peerId: string): Promise<RTCPeerConnection | null> {
    if (!this.peerRegistryId) return null;

    // We need to access PeerTransport's peerConnection directly.
    // This requires PeerTransport to expose it — handled via getPeerConnectionForMedia().
    try {
      const result = await this.request<{ peerConnection: RTCPeerConnection } | null>(
        createRequest(this.id, this.peerRegistryId, 'getMediaPeerConnection', { peerId }),
      );
      return result?.peerConnection ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Handle remote track events from a PeerConnection.
   * Called when PeerTransport notifies us of a new track.
   */
  handleRemoteTrack(peerId: string, track: MediaStreamTrack): void {
    this.tracks.set(track.id, {
      id: track.id,
      peerId,
      kind: track.kind as 'audio' | 'video',
      direction: 'remote',
      label: track.label,
      muted: !track.enabled,
    });
    this.changed('trackAdded', { peerId, trackId: track.id, kind: track.kind });

    track.onmute = () => {
      const managed = this.tracks.get(track.id);
      if (managed) managed.muted = true;
      this.changed('trackMuted', { trackId: track.id, muted: true });
    };

    track.onunmute = () => {
      const managed = this.tracks.get(track.id);
      if (managed) managed.muted = false;
      this.changed('trackMuted', { trackId: track.id, muted: false });
    };

    track.onended = () => {
      this.tracks.delete(track.id);
      this.changed('trackRemoved', { peerId, trackId: track.id });
    };
  }

  protected override async onStop(): Promise<void> {
    // Stop all local streams
    for (const stream of this.localStreams.values()) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
    this.localStreams.clear();
    this.tracks.clear();
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
  }

  protected override getSourceForAsk(): string | undefined {
    return `## MediaStream Usage Guide

### Request microphone access

  const msId = await dep('MediaStream');
  const streamId = await call(msId, 'getUserMedia', { audio: true, video: false });

### Request camera + mic

  const streamId = await call(msId, 'getUserMedia', { audio: true, video: true });

### Request screen share

  const streamId = await call(msId, 'getDisplayMedia', {});

### Add tracks to a peer connection

  await call(msId, 'addTrack', { peerId: 'remote-peer-id', streamId });

### Remove a track

  await call(msId, 'removeTrack', { peerId: 'remote-peer-id', trackId: 'track-id' });

### Mute/unmute

  await call(msId, 'muteTrack', { trackId: 'track-id', muted: true });

### Stop a stream (release resources)

  await call(msId, 'stopStream', { streamId });

### Events
- trackAdded: { peerId, trackId, kind } — remote peer added a media track
- trackRemoved: { peerId, trackId } — track was removed
- trackMuted: { trackId, muted } — mute state changed

### IMPORTANT
- getUserMedia/getDisplayMedia only work in browser context
- On server-side, media tracks are still routed but capture is unavailable
- Tracks are added to existing PeerTransport RTCPeerConnection instances`;
  }
}
