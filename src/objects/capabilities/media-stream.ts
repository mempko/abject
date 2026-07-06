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
import { v4 as uuidv4 } from 'uuid';
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

/** Inline recording payloads above this size are rejected (write to a FileSystem instead). */
const MAX_INLINE_RECORDING_BYTES = 8 * 1024 * 1024;

interface PendingRecording {
  recordingId: string;
  streamId: string;
  startedAt: number;
}

export class MediaStreamCapability extends Abject {
  private peerRegistryId?: AbjectId;
  private uiServerId?: AbjectId;
  private localStreams: Map<string, MediaStream> = new Map();
  private tracks: Map<string, ManagedTrack> = new Map();
  /** Streams captured on the UI client via the UIServer relay (id only; the
   *  MediaStream object itself lives in the browser). */
  private relayedStreams: Set<string> = new Set();
  private pendingRecordings: Map<string, PendingRecording> = new Map();

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
            {
              name: 'record',
              description: 'Record a captured stream with the client-side MediaRecorder. Returns { recordingId } immediately; a recordingComplete event follows with { recordingId, path?, base64?, mimeType, durationMs } (path when a workspace FileSystem stored it, base64 inline otherwise).',
              parameters: [
                { name: 'streamId', type: { kind: 'primitive', primitive: 'string' }, description: 'Stream id from getUserMedia/getDisplayMedia' },
                { name: 'maxDurationMs', type: { kind: 'primitive', primitive: 'number' }, description: 'Auto-stop after this many milliseconds', optional: true },
              ],
              returns: { kind: 'object', properties: { recordingId: { kind: 'primitive', primitive: 'string' } } },
            },
            {
              name: 'stopRecording',
              description: 'Stop an in-progress recording early; recordingComplete still fires with what was captured',
              parameters: [
                { name: 'recordingId', type: { kind: 'primitive', primitive: 'string' }, description: 'Recording id from record' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'captureFrame',
              description: 'Grab one still frame of a captured video stream as PNG. Returns { base64, mimeType, width, height }. The result feeds directly into LLM vision via chat/image pipelines, giving agents live camera or screen sight.',
              parameters: [
                { name: 'streamId', type: { kind: 'primitive', primitive: 'string' }, description: 'Stream id of a video-bearing capture' },
              ],
              returns: { kind: 'object', properties: {
                base64: { kind: 'primitive', primitive: 'string' },
                mimeType: { kind: 'primitive', primitive: 'string' },
                width: { kind: 'primitive', primitive: 'number' },
                height: { kind: 'primitive', primitive: 'number' },
              } },
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
            {
              name: 'recordingComplete',
              description: 'A recording finished (duration reached, stopRecording, or error). Carries path when stored in a workspace FileSystem, base64 inline otherwise, or error on failure.',
              payload: { kind: 'object', properties: {
                recordingId: { kind: 'primitive', primitive: 'string' },
                path: { kind: 'primitive', primitive: 'string' },
                base64: { kind: 'primitive', primitive: 'string' },
                mimeType: { kind: 'primitive', primitive: 'string' },
                durationMs: { kind: 'primitive', primitive: 'number' },
                error: { kind: 'primitive', primitive: 'string' },
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

    this.on('record', async (msg: AbjectMessage) => {
      const { streamId, maxDurationMs } = msg.payload as {
        streamId: string; maxDurationMs?: number;
      };
      return this.recordImpl(streamId, maxDurationMs);
    });

    this.on('stopRecording', async (msg: AbjectMessage) => {
      const { recordingId } = msg.payload as { recordingId: string };
      precondition(typeof recordingId === 'string' && recordingId.length > 0, 'stopRecording requires recordingId');
      const uiId = await this.resolveUiServer();
      if (!uiId || !this.pendingRecordings.has(recordingId)) return false;
      this.send(createRequest(this.id, uiId, 'mediaRecordStop', { recordingId }));
      return true;
    });

    this.on('captureFrame', async (msg: AbjectMessage) => {
      const { streamId } = msg.payload as { streamId: string };
      return this.captureFrameImpl(streamId);
    });

    // Recording completion relayed back from the UI client via the UIServer.
    this.on('recordingReady', async (msg: AbjectMessage) => {
      const { recordingId, base64, mimeType, durationMs, error } = msg.payload as {
        recordingId: string; base64?: string; mimeType?: string; durationMs?: number; error?: string;
      };
      const pending = this.pendingRecordings.get(recordingId);
      if (!pending) return;
      this.pendingRecordings.delete(recordingId);

      if (error || !base64) {
        this.changed('recordingComplete', { recordingId, error: error ?? 'recording produced no data' });
        return;
      }

      // Prefer the workspace FileSystem: recordings can be large and a path
      // reference travels well (abject:// refs, attachments, further tooling).
      const ext = (mimeType ?? '').includes('video') ? 'webm' : (mimeType ?? '').includes('ogg') ? 'ogg' : 'webm';
      const path = `/recordings/rec-${recordingId}.${ext}`;
      try {
        const fsId = await this.discoverDep('FileSystem');
        if (fsId) {
          await this.request(createRequest(this.id, fsId, 'writeFileBytes', { path, base64 }));
          this.changed('recordingComplete', { recordingId, path, mimeType, durationMs });
          return;
        }
      } catch { /* fall through to inline delivery */ }

      const approxBytes = Math.floor(base64.length * 3 / 4);
      if (approxBytes > MAX_INLINE_RECORDING_BYTES) {
        this.changed('recordingComplete', {
          recordingId,
          error: `recording is ${Math.round(approxBytes / (1024 * 1024))}MB, above the ${MAX_INLINE_RECORDING_BYTES / (1024 * 1024)}MB inline cap, and no workspace FileSystem was reachable to store it`,
        });
        return;
      }
      this.changed('recordingComplete', { recordingId, base64, mimeType, durationMs });
    });
  }

  protected override async onInit(): Promise<void> {
    this.peerRegistryId = await this.discoverDep('PeerRegistry') ?? undefined;
    this.uiServerId = await this.discoverDep('UIServer') ?? undefined;
  }

  private async resolveUiServer(): Promise<AbjectId | undefined> {
    if (!this.uiServerId) {
      this.uiServerId = await this.discoverDep('UIServer') ?? undefined;
    }
    return this.uiServerId;
  }

  // ==========================================================================
  // Media capture
  // ==========================================================================

  private async getUserMediaImpl(audio: boolean, video: boolean): Promise<string> {
    precondition(audio || video, 'Must request at least audio or video');

    // Server-side (the normal case: this object runs in the Node backend):
    // capture happens on the connected UI client via the UIServer relay. The
    // stream lives in the browser; we track its id and tracks here.
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      return this.relayCapture(audio, video, false);
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
      return this.relayCapture(false, true, true);
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

  /** Capture on the UI client through the UIServer relay; returns the stream id. */
  private async relayCapture(audio: boolean, video: boolean, display: boolean): Promise<string> {
    const uiId = await this.resolveUiServer();
    if (!uiId) {
      throw new Error('Media capture unavailable: no UIServer (and no browser mediaDevices) in this context');
    }
    // 65s bus timeout: the client shows a permission prompt the user answers.
    const reply = await this.request<{ streamId: string; tracks: Array<{ id: string; kind: string; label: string }> }>(
      createRequest(this.id, uiId, 'mediaCapture', { audio, video, display }),
      65000,
    );
    this.relayedStreams.add(reply.streamId);
    for (const t of reply.tracks) {
      this.tracks.set(t.id, {
        id: t.id,
        peerId: '',
        kind: t.kind as 'audio' | 'video',
        direction: 'local',
        label: t.label,
        muted: false,
      });
    }
    return reply.streamId;
  }

  private async recordImpl(streamId: string, maxDurationMs?: number): Promise<{ recordingId: string }> {
    precondition(typeof streamId === 'string' && streamId.length > 0, 'record requires streamId');
    precondition(
      maxDurationMs === undefined || maxDurationMs > 0,
      'maxDurationMs must be positive when given',
    );
    const uiId = await this.resolveUiServer();
    if (!uiId) throw new Error('Recording unavailable: no UIServer in this context');

    const recordingId = uuidv4();
    this.pendingRecordings.set(recordingId, { recordingId, streamId, startedAt: Date.now() });
    try {
      await this.request(createRequest(this.id, uiId, 'mediaRecordStart', {
        recordingId, streamId, maxDurationMs, notifyId: this.id,
      }));
    } catch (err) {
      this.pendingRecordings.delete(recordingId);
      throw err;
    }
    return { recordingId };
  }

  private async captureFrameImpl(streamId: string): Promise<{ base64: string; mimeType: string; width: number; height: number }> {
    precondition(typeof streamId === 'string' && streamId.length > 0, 'captureFrame requires streamId');
    const uiId = await this.resolveUiServer();
    if (!uiId) throw new Error('Frame capture unavailable: no UIServer in this context');
    const reply = await this.request<{ base64: string; width: number; height: number }>(
      createRequest(this.id, uiId, 'mediaCaptureFrame', { streamId }),
      20000,
    );
    return { base64: reply.base64, mimeType: 'image/png', width: reply.width, height: reply.height };
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
    // Relayed (client-held) track: forward the mute to the UI client.
    const managed = this.tracks.get(trackId);
    if (managed && this.uiServerId) {
      this.send(createRequest(this.id, this.uiServerId, 'mediaStreamControl', {
        action: 'muteTrack', trackId, muted,
      }));
      managed.muted = muted;
      this.changed('trackMuted', { trackId, muted });
      return true;
    }
    return false;
  }

  private stopStreamImpl(streamId: string): boolean {
    const stream = this.localStreams.get(streamId);
    if (!stream) {
      // Relayed (client-held) stream: forward the stop to the UI client.
      if (this.relayedStreams.has(streamId) && this.uiServerId) {
        this.send(createRequest(this.id, this.uiServerId, 'mediaStreamControl', {
          action: 'stopStream', streamId,
        }));
        this.relayedStreams.delete(streamId);
        return true;
      }
      return false;
    }

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

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## MediaStream Usage Guide

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

### Record a stream (voice notes, dictation, clips)

  const { recordingId } = await call(msId, 'record', { streamId, maxDurationMs: 10000 });
  // Register with addDependent, then handle the 'recordingComplete' aspect:
  // { recordingId, path?, base64?, mimeType, durationMs } — path points into the
  // workspace FileSystem when one is reachable, base64 arrives inline otherwise.
  await call(msId, 'stopRecording', { recordingId }); // optional early stop

### See through the camera or screen (one still frame)

  const frame = await call(msId, 'captureFrame', { streamId });
  // frame = { base64, mimeType: 'image/png', width, height }
  // Feed it to LLM vision (chat image pipelines accept data:image/png;base64,<base64>).

### Events
- trackAdded: { peerId, trackId, kind } — remote peer added a media track
- trackRemoved: { peerId, trackId } — track was removed
- trackMuted: { trackId, muted } — mute state changed
- recordingComplete: { recordingId, path?, base64?, mimeType, durationMs, error? }

### IMPORTANT
- Capture runs on the connected UI client (browser permission prompts appear there); calls fail with a clear error when no client is connected.
- A voice loop is pure composition: getUserMedia (audio) then record, send the result to Speech 'recognize', reply through Chat, synthesize, and play via AudioOutput.
- Tracks are added to existing PeerTransport RTCPeerConnection instances`;
  }
}
