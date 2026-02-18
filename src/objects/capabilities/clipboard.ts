/**
 * Clipboard capability object - provides clipboard access.
 */

import { AbjectId, AbjectMessage } from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { Capabilities } from '../../core/capability.js';

const CLIPBOARD_INTERFACE = 'abjects:clipboard';

/**
 * Clipboard capability object.
 */
const isNode = typeof navigator === 'undefined';

export class Clipboard extends Abject {
  private memoryClipboard = '';

  constructor() {
    super({
      manifest: {
        name: 'Clipboard',
        description:
          'Provides clipboard read/write capabilities. Objects can copy and paste text.',
        version: '1.0.0',
        interfaces: [
          {
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
            ],
          },
        ],
        requiredCapabilities: [],
        providedCapabilities: [
          Capabilities.CLIPBOARD_READ,
          Capabilities.CLIPBOARD_WRITE,
        ],
        tags: ['capability', 'clipboard'],
      },
    });

    this.setupHandlers();
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

  protected override getSourceForAsk(): string | undefined {
    return `## Clipboard Usage Guide

### Write Text to Clipboard

  await this.call(
    this.dep('Clipboard'), 'abjects:clipboard', 'write',
    { text: 'Hello, world!' });

### Read Text from Clipboard

  const text = await this.call(
    this.dep('Clipboard'), 'abjects:clipboard', 'read', {});

### Check if Clipboard Has Text

  const hasText = await this.call(
    this.dep('Clipboard'), 'abjects:clipboard', 'hasText', {});

### IMPORTANT
- May fail if the browser denies clipboard permissions.
- Do NOT use navigator.clipboard directly — always go through the Clipboard object.`;
  }
}

// Well-known clipboard ID
export const CLIPBOARD_ID = 'abjects:clipboard' as AbjectId;
