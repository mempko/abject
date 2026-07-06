/**
 * Clipboard capability object - provides clipboard access.
 */

import { AbjectId, AbjectMessage } from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { Capabilities } from '../../core/capability.js';
import { request } from '../../core/message.js';

const CLIPBOARD_INTERFACE = 'abjects:clipboard';

/**
 * Clipboard capability object.
 */
const isNode = typeof navigator === 'undefined' || typeof navigator.clipboard === 'undefined';

/** Convert a Blob to a data: URI (browser only). */
async function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export class Clipboard extends Abject {
  private memoryClipboard = '';
  private memoryImage = '';
  private uiServerId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'Clipboard',
        description:
          'Provides clipboard read/write capabilities for text and images. Objects can copy and paste text, and copy/read images (as data:image/* URIs). Use cases: copy text or images to the system clipboard, read them back.',
        version: '1.0.0',
        interface: {
            id: CLIPBOARD_INTERFACE,
            name: 'Clipboard',
            description: 'Clipboard operations',
            methods: [
              {
                name: 'read',
                description: 'Read text from clipboard',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'write',
                description: 'Write text to clipboard',
                parameters: [
                  {
                    name: 'text',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Text to write',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hasText',
                description: 'Check if clipboard has text',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'readImage',
                description: 'Read an image from the clipboard as a data:image/* base64 URI (empty string if none). In the backend deployment this returns the last image written via the Clipboard object; an OS-clipboard image pasted into a widget arrives through that widget\'s paste input event, not here.',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'writeImage',
                description: 'Write an image to the system clipboard. Pass a data:image/* base64 URI.',
                parameters: [
                  {
                    name: 'image',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'data:image/* base64 URI to copy to the clipboard',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hasImage',
                description: 'Check if the clipboard has an image',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
          },
        requiredCapabilities: [],
        providedCapabilities: [
          Capabilities.CLIPBOARD_READ,
          Capabilities.CLIPBOARD_WRITE,
        ],
        tags: ['system', 'capability', 'clipboard'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.uiServerId = await this.discoverDep('UIServer') ?? undefined;
  }

  private setupHandlers(): void {
    this.on('read', async () => {
      return this.readClipboard();
    });

    this.on('write', async (msg: AbjectMessage) => {
      const { text } = msg.payload as { text: string };
      return this.writeClipboard(text);
    });

    this.on('hasText', async () => {
      return this.hasClipboardText();
    });

    this.on('readImage', async () => {
      return this.readClipboardImage();
    });

    this.on('writeImage', async (msg: AbjectMessage) => {
      const { image } = msg.payload as { image: string };
      return this.writeClipboardImage(image);
    });

    this.on('hasImage', async () => {
      return this.memoryImage.length > 0;
    });
  }

  /**
   * Read an image from the clipboard as a data:image/* URI. In the backend
   * (isNode) this returns the last image written via this object. In a browser
   * context it attempts a real OS-clipboard image read.
   */
  async readClipboardImage(): Promise<string> {
    if (isNode) {
      return this.memoryImage;
    }
    if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
      return this.memoryImage;
    }
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t: string) => t.startsWith('image/'));
        if (!type) continue;
        const blob = await item.getType(type);
        return await blobToDataUri(blob);
      }
    } catch { /* permission denied or no image — fall through */ }
    return this.memoryImage;
  }

  /**
   * Write an image (data:image/* URI) to the system clipboard. In the backend
   * the actual OS write is delegated to the frontend via UIServer.
   */
  async writeClipboardImage(image: string): Promise<boolean> {
    if (typeof image !== 'string' || !image.startsWith('data:image/')) {
      throw new Error('writeImage expects a data:image/* base64 URI');
    }
    this.memoryImage = image;
    if (isNode) {
      if (this.uiServerId) {
        this.send(request(this.id, this.uiServerId, 'clipboardWriteImage', { image }));
      }
      return true;
    }
    if (!navigator.clipboard || typeof navigator.clipboard.write !== 'function') {
      throw new Error('Clipboard image API not available');
    }
    try {
      const blob = await (await fetch(image)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      return true;
    } catch (err) {
      throw new Error(`Clipboard image write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Read text from clipboard.
   */
  async readClipboard(): Promise<string> {
    if (isNode) {
      return this.memoryClipboard;
    }

    if (!navigator.clipboard) {
      throw new Error('Clipboard API not available');
    }

    try {
      return await navigator.clipboard.readText();
    } catch (err) {
      throw new Error(
        `Clipboard read failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Write text to clipboard.
   */
  async writeClipboard(text: string): Promise<boolean> {
    if (isNode) {
      this.memoryClipboard = text;
      if (this.uiServerId) {
        this.send(request(this.id, this.uiServerId, 'clipboardWrite', { text }));
      }
      return true;
    }

    if (!navigator.clipboard) {
      throw new Error('Clipboard API not available');
    }

    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      throw new Error(
        `Clipboard write failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Check if clipboard has text.
   */
  async hasClipboardText(): Promise<boolean> {
    if (isNode) {
      return this.memoryClipboard.length > 0;
    }

    if (!navigator.clipboard) {
      return false;
    }

    try {
      const text = await navigator.clipboard.readText();
      return text.length > 0;
    } catch {
      return false;
    }
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## Clipboard Usage Guide

### Write Text to Clipboard

  await this.call(
    this.dep('Clipboard'), 'write',
    { text: 'Hello, world!' });

### Read Text from Clipboard

  const text = await this.call(
    this.dep('Clipboard'), 'read', {});

### Check if Clipboard Has Text

  const hasText = await this.call(
    this.dep('Clipboard'), 'hasText', {});

### Write an Image to the Clipboard

  await this.call(
    this.dep('Clipboard'), 'writeImage',
    { image: 'data:image/png;base64,...' });

### Read an Image from the Clipboard

  const dataUri = await this.call(
    this.dep('Clipboard'), 'readImage', {});  // '' if none

### IMPORTANT
- Images are data:image/* base64 URIs (the same form a canvas \`imageUrl\`/\`drawImage\` command draws, and that markdown \`![alt](data:...)\` renders).
- To capture an image a user PASTES into your widget, handle the widget's paste input event — that delivers the pasted image directly; readImage returns only what was written through this object.
- May fail if the browser denies clipboard permissions.
- Do NOT use navigator.clipboard directly — always go through the Clipboard object.`;
  }
}

// Well-known clipboard ID
export const CLIPBOARD_ID = 'abjects:clipboard' as AbjectId;
