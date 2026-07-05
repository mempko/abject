/**
 * Speech capability: text-to-speech and speech-to-text for the whole desktop.
 *
 * Two engines serve each direction, tried in order:
 * - LLM providers (via LLMObject.synthesize / LLMObject.transcribe) produce
 *   and consume real audio data, so results are playable, storable, and
 *   provider-quality.
 * - The connected UI client's built-in browser speech APIs cover the
 *   zero-configuration case: speechSynthesis speaks directly on the client
 *   (no audio data returns), and SpeechRecognition transcribes live. When the
 *   browser lacks recognition, the client records the mic and this object
 *   routes the audio to a transcription provider.
 *
 * The relay to the client follows the Clipboard/Screenshot pattern through
 * the UIServer, using the speechSpeak/speechRecognize/speechVoices messages.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { Capabilities } from '../../core/capability.js';
import { require } from '../../core/contracts.js';
import { request } from '../../core/message.js';

const SPEECH_INTERFACE: InterfaceId = 'abjects:speech';

export const SPEECH_ID = 'abjects:speech' as AbjectId;

export class Speech extends Abject {
  private uiServerId?: AbjectId;
  private llmId?: AbjectId;
  private audioOutputId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'Speech',
        description:
          'Text-to-speech and speech-to-text capability. Synthesizes speech through LLM providers or the browser voice, and recognizes speech from provided audio or a live microphone session on the UI client.',
        version: '1.0.0',
        interface: {
          id: SPEECH_INTERFACE,
          name: 'Speech',
          description: 'Speech synthesis and recognition',
          methods: [
            {
              name: 'synthesize',
              description: 'Turn text into speech. With a provider configured, returns encoded audio { base64, mimeType, provider }. Without one, the browser speaks the text aloud on the client and the reply is { spoken: true } with no audio data.',
              parameters: [
                { name: 'text', type: { kind: 'primitive', primitive: 'string' }, description: 'Text to speak' },
                { name: 'voice', type: { kind: 'primitive', primitive: 'string' }, description: 'Voice id (provider voice, or a browser voice name from listVoices)', optional: true },
                { name: 'provider', type: { kind: 'primitive', primitive: 'string' }, description: 'LLM provider name (optional; auto-selected when omitted)', optional: true },
              ],
              returns: { kind: 'object', properties: {
                base64: { kind: 'primitive', primitive: 'string' },
                mimeType: { kind: 'primitive', primitive: 'string' },
                spoken: { kind: 'primitive', primitive: 'boolean' },
              } },
            },
            {
              name: 'speak',
              description: 'Speak text aloud on the desktop client and return { spoken: true }. Uses provider synthesis piped into audio playback when available, otherwise the browser voice.',
              parameters: [
                { name: 'text', type: { kind: 'primitive', primitive: 'string' }, description: 'Text to speak' },
                { name: 'voice', type: { kind: 'primitive', primitive: 'string' }, description: 'Voice id (optional)', optional: true },
              ],
              returns: { kind: 'object', properties: { spoken: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'recognize',
              description: 'Turn speech into text; returns { text }. With audio provided, transcribes it via an LLM provider. Without audio, listens live on the UI client: the browser recognizes directly when it can, otherwise the mic is recorded for maxDurationMs and transcribed by a provider.',
              parameters: [
                { name: 'audio', type: { kind: 'object', properties: { base64: { kind: 'primitive', primitive: 'string' }, mimeType: { kind: 'primitive', primitive: 'string' } } }, description: 'Encoded audio to transcribe (optional; omit for live capture)', optional: true },
                { name: 'maxDurationMs', type: { kind: 'primitive', primitive: 'number' }, description: 'Live listening window in ms (default 10000, max 60000). Windows above ~20000 need a longer request timeout on the caller side.', optional: true },
              ],
              returns: { kind: 'object', properties: { text: { kind: 'primitive', primitive: 'string' } } },
            },
            {
              name: 'listVoices',
              description: 'List the browser speechSynthesis voice names available on the connected client',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
            },
          ],
          events: [],
        },
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.SPEECH_SYNTHESIZE, Capabilities.SPEECH_RECOGNIZE],
        tags: ['system', 'capability', 'speech'],
      },
    });
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('synthesize', async (msg: AbjectMessage) => {
      const { text, voice, provider } = msg.payload as {
        text: string; voice?: string; provider?: string;
      };
      require(typeof text === 'string' && text.length > 0, 'synthesize requires text');
      return this.synthesizeImpl(text, voice, provider);
    });

    this.on('speak', async (msg: AbjectMessage) => {
      const { text, voice } = msg.payload as { text: string; voice?: string };
      require(typeof text === 'string' && text.length > 0, 'speak requires text');
      return this.speakImpl(text, voice);
    });

    this.on('recognize', async (msg: AbjectMessage) => {
      const { audio, maxDurationMs } = msg.payload as {
        audio?: { base64: string; mimeType: string }; maxDurationMs?: number;
      };
      return this.recognizeImpl(audio, maxDurationMs);
    });

    this.on('listVoices', async () => {
      const uiServerId = await this.requireUiServer();
      return this.request<string[]>(request(this.id, uiServerId, 'speechVoices', {}));
    });
  }

  protected override async onInit(): Promise<void> {
    this.uiServerId = await this.discoverDep('UIServer') ?? undefined;
    this.llmId = await this.discoverDep('LLM') ?? undefined;
    this.audioOutputId = await this.discoverDep('AudioOutput') ?? undefined;
  }

  private async requireUiServer(): Promise<AbjectId> {
    if (!this.uiServerId) {
      this.uiServerId = await this.discoverDep('UIServer') ?? undefined;
    }
    require(this.uiServerId !== undefined, 'UIServer not discovered; client speech unavailable');
    return this.uiServerId!;
  }

  private async resolveLlm(): Promise<AbjectId | undefined> {
    if (!this.llmId) {
      this.llmId = await this.discoverDep('LLM') ?? undefined;
    }
    return this.llmId;
  }

  /** Whether a provider currently serves the given speech direction. */
  private async providerSupports(direction: 'transcribe' | 'synthesize'): Promise<boolean> {
    const llmId = await this.resolveLlm();
    if (!llmId) return false;
    try {
      const support = await this.request<{ transcribe: boolean; synthesize: boolean }>(
        request(this.id, llmId, 'supportsSpeech', {}));
      return direction === 'transcribe' ? support.transcribe : support.synthesize;
    } catch {
      return false;
    }
  }

  private async synthesizeImpl(
    text: string,
    voice?: string,
    provider?: string,
  ): Promise<{ base64?: string; mimeType?: string; provider?: string; spoken?: boolean }> {
    if (provider || await this.providerSupports('synthesize')) {
      const llmId = await this.resolveLlm();
      require(llmId !== undefined, 'LLM object not discovered');
      return this.request<{ base64: string; mimeType: string; provider: string }>(
        request(this.id, llmId!, 'synthesize', { text, voice, provider }));
    }
    // Browser fallback: the client speaks; no audio data returns.
    const uiServerId = await this.requireUiServer();
    const reply = await this.request<{ spoken: boolean }>(
      request(this.id, uiServerId, 'speechSpeak', { text, voice }));
    return { spoken: reply.spoken === true };
  }

  private async speakImpl(text: string, voice?: string): Promise<{ spoken: boolean }> {
    if (await this.providerSupports('synthesize')) {
      const llmId = await this.resolveLlm();
      if (llmId) {
        try {
          const audio = await this.request<{ base64: string; mimeType: string }>(
            request(this.id, llmId, 'synthesize', { text, voice }));
          if (!this.audioOutputId) {
            this.audioOutputId = await this.discoverDep('AudioOutput') ?? undefined;
          }
          if (this.audioOutputId) {
            await this.request(request(this.id, this.audioOutputId, 'play', {
              source: `data:${audio.mimeType};base64,${audio.base64}`,
            }));
            return { spoken: true };
          }
        } catch { /* provider or playback failed; fall back to browser voice */ }
      }
    }
    const uiServerId = await this.requireUiServer();
    const reply = await this.request<{ spoken: boolean }>(
      request(this.id, uiServerId, 'speechSpeak', { text, voice }));
    return { spoken: reply.spoken === true };
  }

  private async recognizeImpl(
    audio?: { base64: string; mimeType: string },
    maxDurationMs?: number,
  ): Promise<{ text: string }> {
    if (audio) {
      require(typeof audio.base64 === 'string' && audio.base64.length > 0,
        'recognize audio must carry non-empty base64');
      const llmId = await this.resolveLlm();
      require(llmId !== undefined,
        'No transcription available: configure an LLM provider with speech-to-text (OpenAI or Gemini)');
      const result = await this.request<{ text: string }>(
        request(this.id, llmId!, 'transcribe', { audio }));
      return { text: result.text };
    }

    // Live capture on the client. The reply carries either a transcript
    // (browser recognition) or recorded audio for provider transcription.
    const uiServerId = await this.requireUiServer();
    const reply = await this.request<{ text?: string; audioBase64?: string; mimeType?: string }>(
      request(this.id, uiServerId, 'speechRecognize', { maxDurationMs }));

    if (typeof reply.text === 'string') {
      return { text: reply.text };
    }
    if (reply.audioBase64) {
      const canTranscribe = await this.providerSupports('transcribe');
      require(canTranscribe,
        'The browser recorded audio but no provider supports transcription. Configure OpenAI or Gemini for speech-to-text.');
      const llmId = await this.resolveLlm();
      const result = await this.request<{ text: string }>(
        request(this.id, llmId!, 'transcribe', {
          audio: { base64: reply.audioBase64, mimeType: reply.mimeType ?? 'audio/webm' },
        }));
      return { text: result.text };
    }
    throw new Error('Speech recognition returned neither a transcript nor audio. Check the client microphone permission.');
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## Speech Usage Guide

### Speak a reply aloud
  const speechId = await dep('Speech');
  await call(speechId, 'speak', { text: 'Your build finished.' });

### Voice loop (compose with a chat conversation)
  // 1. Listen: capture and transcribe what the user says
  const { text } = await call(speechId, 'recognize', { maxDurationMs: 8000 });
  // 2. Think: send the transcript to a chat conversation you discover via the registry
  const chatId = await dep('Chat');
  await call(chatId, 'sendMessage', { text });
  // 3. Answer: when the reply arrives (observe the chat's messageAdded event), speak it
  await call(speechId, 'speak', { text: replyText });

### Get audio data instead of speaking
  const { base64, mimeType } = await call(speechId, 'synthesize', { text: 'hello' });
  // Play later, store in a FileSystem, or attach to a message.

### Notes
- With a speech-capable LLM provider configured (OpenAI, or Gemini for transcription), synthesis returns real audio and recognition transcribes recordings. Without one, the connected browser speaks and recognizes directly, and synthesize returns { spoken: true } with no audio data.
- recognize without audio listens on the UI client for maxDurationMs (default 10s). Keep windows under 20s or raise your request timeout.
- listVoices names the browser voices usable in speak/synthesize's voice parameter.`;
  }
}

export function createSpeech(): Speech {
  return new Speech();
}
