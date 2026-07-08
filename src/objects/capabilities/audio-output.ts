/**
 * AudioOutput capability: sound playback for the whole desktop.
 *
 * The Node backend has no speakers; playback happens on the connected UI
 * client. This object follows the Clipboard/Screenshot relay pattern: it sends
 * playback commands to the UIServer, which forwards them to the frontend where
 * HTMLAudioElement instances do the work. Ended/error notifications flow back
 * up the same channel and re-emit here as playbackEnded/playbackError events,
 * so any Abject can chime, alert, or speak by messaging this one object.
 *
 * abject://<typeId>/<path> sources resolve through the referenced FileSystem
 * Abject into data: URIs before the relay, mirroring how widget images load.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { Capabilities } from '../../core/capability.js';
import { require, invariant } from '../../core/contracts.js';
import { request } from '../../core/message.js';
import { v4 as uuidv4 } from 'uuid';
import {
  isAbjectUrl,
  parseAbjectUrl,
} from '../widgets/markdown-image-resolver.js';

const AUDIO_OUTPUT_INTERFACE: InterfaceId = 'abjects:audio-output';

export const AUDIO_OUTPUT_ID = 'abjects:audio-output' as AbjectId;

/** Extension → audio MIME map for abject:// file resolution. */
const AUDIO_MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  webm: 'audio/webm',
};

function audioMimeForPath(pathOrName: string): string {
  const dot = pathOrName.lastIndexOf('.');
  const ext = dot >= 0 ? pathOrName.slice(dot + 1).toLowerCase() : '';
  return AUDIO_MIME_BY_EXT[ext] ?? 'audio/mpeg';
}

interface Playback {
  playbackId: string;
  /** Compact description of the source (URLs kept, data URIs summarized). */
  source: string;
  state: 'playing' | 'paused';
  loop: boolean;
  startedAt: number;
}

type OscWave = 'sine' | 'square' | 'sawtooth' | 'triangle';

/**
 * One voice of a synthesized audio graph. Mirrors the frontend's AudioVoiceSpec
 * (server/ws-protocol.ts) — the spec is relayed through the UIServer to the
 * client, which materializes the Web Audio nodes. Kept as a local type so this
 * capability does not import server-side wire types.
 */
interface AudioVoiceSpec {
  source?: 'osc' | 'noise';
  wave?: OscWave;
  freq?: number;
  freqRamp?: { to: number; time: number };
  filter?: { type: 'lowpass' | 'highpass' | 'bandpass' | 'notch'; freq: number; q?: number };
  gain?: number;
  attack?: number;
  hold?: number;
  release?: number;
  start?: number;
  duration?: number;
}

export class AudioOutput extends Abject {
  private uiServerId?: AbjectId;
  private playbacks: Map<string, Playback> = new Map();

  constructor() {
    super({
      manifest: {
        name: 'AudioOutput',
        description:
          'Sound playback capability. Plays audio from URLs, data: URIs, or abject:// file references on the connected UI client. Any Abject can chime, alert, or speak through this object.',
        version: '1.0.0',
        interface: {
          id: AUDIO_OUTPUT_INTERFACE,
          name: 'AudioOutput',
          description: 'Audio playback on the desktop client',
          methods: [
            {
              name: 'play',
              description: 'Start playback; returns { playbackId }. Source may be an http(s) URL, a data: URI, or an abject://<typeId>/<path> file reference.',
              parameters: [
                { name: 'source', type: { kind: 'primitive', primitive: 'string' }, description: 'Audio source (URL, data: URI, or abject:// reference)' },
                { name: 'volume', type: { kind: 'primitive', primitive: 'number' }, description: 'Volume 0..1 (default 1)', optional: true },
                { name: 'loop', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Loop until stopped (default false)', optional: true },
              ],
              returns: { kind: 'object', properties: { playbackId: { kind: 'primitive', primitive: 'string' } } },
            },
            {
              name: 'playTone',
              description: 'Synthesize and play a single tone; returns { playbackId }. Use this for beeps, blips, and simple SFX without any audio file.',
              parameters: [
                { name: 'frequency', type: { kind: 'primitive', primitive: 'number' }, description: 'Pitch in Hz (e.g. 440 = A4)' },
                { name: 'wave', type: { kind: 'primitive', primitive: 'string' }, description: "'sine' | 'square' | 'sawtooth' | 'triangle' (default 'sine')", optional: true },
                { name: 'duration', type: { kind: 'primitive', primitive: 'number' }, description: 'Seconds (default 0.2)', optional: true },
                { name: 'volume', type: { kind: 'primitive', primitive: 'number' }, description: 'Peak gain 0..1 (default 0.2)', optional: true },
              ],
              returns: { kind: 'object', properties: { playbackId: { kind: 'primitive', primitive: 'string' } } },
            },
            {
              name: 'playGraph',
              description: 'Synthesize and play a multi-voice Web Audio graph (oscillators and/or white noise, optional biquad filter, attack/hold/release envelope, frequency glide); returns { playbackId }. Use loop:true for sustained ambience (drones, hums) and stop() it later. Abjects have no AudioContext of their own, so describe sound declaratively here instead of building Web Audio directly.',
              parameters: [
                { name: 'voices', type: { kind: 'array', elementType: { kind: 'reference', reference: 'AudioVoiceSpec' } }, description: 'Voices: each { source?: "osc"|"noise", wave?, freq?, freqRamp?: {to,time}, filter?: {type,freq,q}, gain?, attack?, hold?, release?, start?, duration? }' },
                { name: 'volume', type: { kind: 'primitive', primitive: 'number' }, description: 'Master gain 0..1 (default 1)', optional: true },
                { name: 'loop', type: { kind: 'primitive', primitive: 'boolean' }, description: 'Sustain voices at peak until stopped (default false)', optional: true },
              ],
              returns: { kind: 'object', properties: { playbackId: { kind: 'primitive', primitive: 'string' } } },
            },
            {
              name: 'pause',
              description: 'Pause a playback (resume continues it)',
              parameters: [
                { name: 'playbackId', type: { kind: 'primitive', primitive: 'string' }, description: 'Playback to pause' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'resume',
              description: 'Resume a paused playback',
              parameters: [
                { name: 'playbackId', type: { kind: 'primitive', primitive: 'string' }, description: 'Playback to resume' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'stop',
              description: 'Stop a playback and release it',
              parameters: [
                { name: 'playbackId', type: { kind: 'primitive', primitive: 'string' }, description: 'Playback to stop' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'stopAll',
              description: 'Stop every active playback',
              parameters: [],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'listPlaybacks',
              description: 'List active playbacks with their state',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'Playback' } },
            },
          ],
          events: [
            {
              name: 'playbackEnded',
              description: 'A playback reached the end of its source',
              payload: { kind: 'object', properties: {
                playbackId: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'playbackError',
              description: 'A playback failed to load or decode',
              payload: { kind: 'object', properties: {
                playbackId: { kind: 'primitive', primitive: 'string' },
                error: { kind: 'primitive', primitive: 'string' },
              } },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.AUDIO_PLAY],
        tags: ['system', 'capability', 'audio'],
      },
    });
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('play', async (msg: AbjectMessage) => {
      const { source, volume, loop } = msg.payload as {
        source: string; volume?: number; loop?: boolean;
      };
      return this.playImpl(source, volume, loop);
    });

    this.on('playTone', async (msg: AbjectMessage) => {
      const { frequency, wave, duration, volume } = msg.payload as {
        frequency: number; wave?: OscWave; duration?: number; volume?: number;
      };
      require(typeof frequency === 'number' && frequency > 0, 'playTone requires a positive frequency');
      return this.playGraphImpl([{
        source: 'osc', wave, freq: frequency, gain: volume ?? 0.2, duration, attack: 0.01, release: 0.08,
      }]);
    });

    this.on('playGraph', async (msg: AbjectMessage) => {
      const { voices, volume, loop } = msg.payload as {
        voices: AudioVoiceSpec[]; volume?: number; loop?: boolean;
      };
      return this.playGraphImpl(voices, volume, loop);
    });

    this.on('pause', async (msg: AbjectMessage) => {
      const { playbackId } = msg.payload as { playbackId: string };
      return this.controlImpl('pause', playbackId);
    });

    this.on('resume', async (msg: AbjectMessage) => {
      const { playbackId } = msg.payload as { playbackId: string };
      return this.controlImpl('resume', playbackId);
    });

    this.on('stop', async (msg: AbjectMessage) => {
      const { playbackId } = msg.payload as { playbackId: string };
      return this.controlImpl('stop', playbackId);
    });

    this.on('stopAll', async () => {
      if (this.uiServerId) {
        this.send(request(this.id, this.uiServerId, 'audioControl', { action: 'stopAll' }));
      }
      this.playbacks.clear();
      this.checkInvariants();
      return true;
    });

    this.on('listPlaybacks', async () => {
      return Array.from(this.playbacks.values());
    });

    // Frontend notifications relayed by the UIServer.
    this.on('playbackEvent', async (msg: AbjectMessage) => {
      const { playbackId, event: kind, error } = msg.payload as {
        playbackId: string; event: 'ended' | 'error'; error?: string;
      };
      if (!this.playbacks.has(playbackId)) return;
      this.playbacks.delete(playbackId);
      if (kind === 'ended') {
        this.changed('playbackEnded', { playbackId });
      } else {
        this.changed('playbackError', { playbackId, error: error ?? 'playback failed' });
      }
      this.checkInvariants();
    });
  }

  protected override async onInit(): Promise<void> {
    this.uiServerId = await this.discoverDep('UIServer') ?? undefined;
  }

  private async playImpl(source: string, volume?: number, loop?: boolean): Promise<{ playbackId: string }> {
    require(typeof source === 'string' && source.length > 0, 'play requires a source');
    require(volume === undefined || (volume >= 0 && volume <= 1), 'volume must be between 0 and 1');
    if (!this.uiServerId) {
      this.uiServerId = await this.discoverDep('UIServer') ?? undefined;
    }
    require(this.uiServerId !== undefined, 'UIServer not discovered; audio output unavailable');

    let resolved = source;
    if (isAbjectUrl(source)) {
      const dataUri = await this.resolveAbjectAudio(source);
      require(dataUri !== null, `Could not resolve audio file '${source}'`);
      resolved = dataUri!;
    } else {
      require(
        /^https?:\/\//i.test(source) || source.startsWith('data:'),
        'source must be an http(s) URL, a data: URI, or an abject:// reference',
      );
    }

    const playbackId = uuidv4();
    await this.request(request(this.id, this.uiServerId!, 'audioPlay', {
      playbackId,
      source: resolved,
      volume: volume === undefined ? undefined : Math.max(0, Math.min(1, volume)),
      loop: loop ?? false,
      notifyId: this.id,
    }));

    this.playbacks.set(playbackId, {
      playbackId,
      source: source.startsWith('data:') ? `data: URI (${source.length} chars)` : source,
      state: 'playing',
      loop: loop ?? false,
      startedAt: Date.now(),
    });
    this.checkInvariants();
    return { playbackId };
  }

  private async playGraphImpl(voices: AudioVoiceSpec[], volume?: number, loop?: boolean): Promise<{ playbackId: string }> {
    require(Array.isArray(voices) && voices.length > 0, 'playGraph requires a non-empty voices array');
    require(volume === undefined || (volume >= 0 && volume <= 1), 'volume must be between 0 and 1');
    if (!this.uiServerId) {
      this.uiServerId = await this.discoverDep('UIServer') ?? undefined;
    }
    require(this.uiServerId !== undefined, 'UIServer not discovered; audio output unavailable');

    const playbackId = uuidv4();
    await this.request(request(this.id, this.uiServerId!, 'audioGraph', {
      playbackId,
      voices,
      volume: volume === undefined ? undefined : Math.max(0, Math.min(1, volume)),
      loop: loop ?? false,
      notifyId: this.id,
    }));

    this.playbacks.set(playbackId, {
      playbackId,
      source: `synth graph (${voices.length} voice${voices.length === 1 ? '' : 's'})`,
      state: 'playing',
      loop: loop ?? false,
      startedAt: Date.now(),
    });
    this.checkInvariants();
    return { playbackId };
  }

  private async controlImpl(action: 'pause' | 'resume' | 'stop', playbackId: string): Promise<boolean> {
    require(typeof playbackId === 'string' && playbackId.length > 0, `${action} requires playbackId`);
    const playback = this.playbacks.get(playbackId);
    if (!playback || !this.uiServerId) return false;

    this.send(request(this.id, this.uiServerId, 'audioControl', { action, playbackId }));
    if (action === 'stop') {
      this.playbacks.delete(playbackId);
    } else {
      playback.state = action === 'pause' ? 'paused' : 'playing';
    }
    this.checkInvariants();
    return true;
  }

  /** Read abject://<typeId>/<path> bytes from the referenced FileSystem Abject. */
  private async resolveAbjectAudio(url: string): Promise<string | null> {
    const regId = await this.resolveRegistryId();
    if (!regId) return null;
    for (const { typeId, path } of parseAbjectUrl(url)) {
      let fsId: AbjectId | null = null;
      try {
        fsId = await this.request<AbjectId | null>(
          request(this.id, regId, 'resolveType', { typeId }),
        );
      } catch { fsId = null; }
      if (!fsId) continue;
      try {
        const base64 = await this.request<string>(
          request(this.id, fsId, 'readFileBytes', { path }),
        );
        if (base64) return `data:${audioMimeForPath(path)};base64,${base64}`;
      } catch { /* read failed for a resolved typeId */ }
      return null;
    }
    return null;
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    for (const p of this.playbacks.values()) {
      invariant(p.playbackId.length > 0, 'every playback has an id');
      invariant(p.state === 'playing' || p.state === 'paused', 'playback state is playing or paused');
    }
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## AudioOutput Usage Guide

### Play a chime from a URL
  const audioId = await dep('AudioOutput');
  const { playbackId } = await call(audioId, 'play', {
    source: 'https://example.com/sounds/chime.mp3', volume: 0.8,
  });

### Play generated audio (a data: URI) and stop it later
  const { playbackId } = await call(audioId, 'play', {
    source: 'data:audio/wav;base64,...', loop: true,
  });
  // later:
  await call(audioId, 'stop', { playbackId });

### Play a file stored in a workspace FileSystem
  await call(audioId, 'play', { source: 'abject://<typeId>/sounds/alert.ogg' });

### Synthesize sound with no audio file (tones and SFX)
Abjects run in a sandboxed backend with NO AudioContext of their own, so never
construct oscillators/AudioContext in handler code. Describe the sound here and
this object synthesizes it on the client:
  // a quick beep
  await call(audioId, 'playTone', { frequency: 660, wave: 'square', duration: 0.15, volume: 0.3 });
  // a richer one-shot SFX (a falling "blip" with a filtered noise tick)
  await call(audioId, 'playGraph', { voices: [
    { source: 'osc', wave: 'triangle', freq: 900, freqRamp: { to: 300, time: 0.12 }, gain: 0.25, duration: 0.12 },
    { source: 'noise', filter: { type: 'bandpass', freq: 1800, q: 2 }, gain: 0.15, duration: 0.05 },
  ] });

### Sustained ambience (drones/hums) — loop, then stop
  const { playbackId } = await call(audioId, 'playGraph', {
    loop: true, volume: 0.5,
    voices: [
      { source: 'osc', wave: 'sine', freq: 55, gain: 0.2 },
      { source: 'osc', wave: 'sine', freq: 82.5, gain: 0.12 },
      { source: 'noise', filter: { type: 'lowpass', freq: 400 }, gain: 0.05 },
    ],
  });
  // later, to silence it:
  await call(audioId, 'stop', { playbackId });

### React to completion
Register with addDependent and handle 'changed' events:
- playbackEnded: { playbackId }
- playbackError: { playbackId, error }

### Notes
- Playback happens on the connected UI client; when no client is connected, play() fails with a clear error.
- Volume is 0..1. Looping playback continues until stop/stopAll.
- Pair with the Speech object for text-to-speech and with Timer/Scheduler for reminders that make sound.`;
  }
}

export function createAudioOutput(): AudioOutput {
  return new AudioOutput();
}
