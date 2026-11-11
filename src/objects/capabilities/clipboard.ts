/**
 * Clipboard capability object - provides clipboard access.
 */

import { AbjectId, AbjectMessage } from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { request } from '../../core/message.js';
import { PermissionDenied, PermissionReceipt } from '../../core/permission-outcome.js';

const CLIPBOARD_INTERFACE = 'abjects:clipboard';

/**
 * How long a clipboard question waits for a person. The same span a shell
 * command gets: the answer needs someone at the keyboard, and a shorter wait
 * would turn "nobody is here" into "no".
 */
const PERMISSION_WAIT_MS = 31 * 60 * 1000;

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
  private permissionsAuthorityId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'Clipboard',
        description:
          'Provides clipboard read/write capabilities for text and images. Objects can copy and paste text, and copy/read images (as data:image/* URIs). Use cases: copy text or images to the system clipboard, read them back. Every read and write is put to the person through PermissionBroker first, and a refusal arrives as PermissionDenied.',
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
        tags: ['system', 'capability', 'clipboard'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.uiServerId = await this.discoverDep('UIServer') ?? undefined;
  }

  private setupHandlers(): void {
    // PermissionBroker claims this at boot; first caller wins, as on the other
    // capability objects.
    this.on('setPermissionsAuthority', async (msg: AbjectMessage) => {
      if (this.permissionsAuthorityId) return { success: false, error: 'Authority already set' };
      this.permissionsAuthorityId = msg.routing.from;
      return { success: true };
    });

    this.on('read', async (msg: AbjectMessage) => {
      await this.authorize(msg, 'read', 'text');
      return this.readClipboard();
    });

    this.on('write', async (msg: AbjectMessage) => {
      const { text } = msg.payload as { text: string };
      await this.authorize(msg, 'write', 'text');
      return this.writeClipboard(text);
    });

    this.on('hasText', async (msg: AbjectMessage) => {
      await this.authorize(msg, 'read', 'text');
      return this.hasClipboardText();
    });

    this.on('readImage', async (msg: AbjectMessage) => {
      await this.authorize(msg, 'read', 'image');
      return this.readClipboardImage();
    });

    this.on('writeImage', async (msg: AbjectMessage) => {
      const { image } = msg.payload as { image: string };
      await this.authorize(msg, 'write', 'image');
      return this.writeClipboardImage(image);
    });

    this.on('hasImage', async () => {
      return this.memoryImage.length > 0;
    });
  }

  /**
   * The question every read and write passes through.
   *
   * Nothing on a clipboard belongs to the object asking for it: a read hands
   * over whatever the person copied last, and a write replaces it under them.
   * So the answer comes from PermissionBroker, which puts it to the person
   * unless they already answered for this exact operation — the operation, not
   * the caller's project, since a project's autonomy says nothing about the one
   * place everything copied passes through.
   *
   * A refusal is thrown as PermissionDenied carrying the receipt, so the caller
   * can tell a decline from a rule from an outage. With no broker running
   * nobody can be asked, and that is a refusal: this object keeps no clipboard
   * access of its own to fall back on.
   */
  private async authorize(msg: AbjectMessage, operation: 'read' | 'write', kind: 'text' | 'image'): Promise<void> {
    const resource = `${operation} ${kind}`;
    const local = (decision: string, source: PermissionReceipt['source'], reason: string): PermissionReceipt => ({
      authority: this.permissionsAuthorityId ?? this.id,
      callerId: msg.routing.from,
      operation,
      resource,
      decision,
      source,
      reason,
    });
    this.permissionsAuthorityId = await this.resolveDep('PermissionBroker', this.permissionsAuthorityId);
    if (!this.permissionsAuthorityId) {
      throw new PermissionDenied(local('deny', 'unavailable', 'no permission broker is running to ask about the clipboard'));
    }
    let response: { decision?: string; receipt?: PermissionReceipt } | undefined;
    try {
      response = await this.request<{ decision?: string; receipt?: PermissionReceipt }>(
        request(this.id, this.permissionsAuthorityId, 'requestPermission', {
          type: 'clipboard',
          operation,
          resource,
          callerId: msg.routing.from,
        }),
        PERMISSION_WAIT_MS);
    } catch (err) {
      throw new PermissionDenied(local('deny', 'unavailable',
        `could not ask about the clipboard: ${err instanceof Error ? err.message : String(err)}`));
    }
    if (typeof response?.decision === 'string' && response.decision.startsWith('accept')) return;
    throw new PermissionDenied(response?.receipt
      ?? local(response?.decision ?? 'deny', 'policy', 'Clipboard access denied'));
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
- Every read and write asks the person first (PermissionBroker), who can allow it once or always. A refusal comes back as PermissionDenied, not as an empty string — so handle it rather than treating '' as "nothing there".
- May also fail if the browser denies clipboard permissions.
- Do NOT use navigator.clipboard directly — always go through the Clipboard object.`;
  }
}

// Well-known clipboard ID
export const CLIPBOARD_ID = 'abjects:clipboard' as AbjectId;
