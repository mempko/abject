/**
 * Screenshot capability object - captures window and desktop screenshots.
 */

import { AbjectId, AbjectMessage } from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { require } from '../../core/contracts.js';
import { request } from '../../core/message.js';
import { Capabilities } from '../../core/capability.js';

const SCREENSHOT_INTERFACE = 'abjects:screenshot';

export const SCREENSHOT_ID = 'abjects:screenshot' as AbjectId;

/**
 * Screenshot capability object.
 * Captures screenshots of object windows and the full desktop via the UIServer.
 */
export class Screenshot extends Abject {
  private uiServerId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'Screenshot',
        description:
          'Capture screenshots of windows and the desktop as base64-encoded PNG images. ' +
          'Use cases: capture a specific object\'s window, capture the full desktop, list all visible windows.',
        version: '1.0.0',
        interface: {
          id: SCREENSHOT_INTERFACE,
          name: 'Screenshot',
          description: 'Window and desktop screenshot operations',
          methods: [
            {
              name: 'captureWindow',
              description: 'Capture a screenshot of an object\'s window. Returns base64-encoded PNG image data.',
              parameters: [
                {
                  name: 'objectId',
                  type: { kind: 'primitive', primitive: 'string' },
                  description: 'AbjectId of the object whose window to capture',
                },
              ],
              returns: {
                kind: 'object',
                properties: {
                  imageBase64: { kind: 'primitive', primitive: 'string' },
                  width: { kind: 'primitive', primitive: 'number' },
                  height: { kind: 'primitive', primitive: 'number' },
                },
              },
            },
            {
              name: 'captureDesktop',
              description: 'Capture a screenshot of the entire desktop. Returns base64-encoded PNG image data.',
              parameters: [],
              returns: {
                kind: 'object',
                properties: {
                  imageBase64: { kind: 'primitive', primitive: 'string' },
                  width: { kind: 'primitive', primitive: 'number' },
                  height: { kind: 'primitive', primitive: 'number' },
                },
              },
            },
            {
              name: 'listWindows',
              description: 'List all visible windows with their objectId, title, and position.',
              parameters: [],
              returns: {
                kind: 'array',
                elementType: { kind: 'reference', reference: 'WindowInfo' },
              },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.SCREENSHOT],
        tags: ['system', 'capability', 'screenshot'],
      },
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('captureWindow', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: string };
      require(!!objectId, 'objectId is required');
      require(this.uiServerId !== undefined, 'UIServer not discovered');
      return this.request<{ imageBase64: string; width: number; height: number } | null>(
        request(this.id, this.uiServerId!, 'captureScreenshot', { objectId }),
        15000,
      );
    });

    this.on('captureDesktop', async () => {
      require(this.uiServerId !== undefined, 'UIServer not discovered');
      return this.request<{ imageBase64: string; width: number; height: number }>(
        request(this.id, this.uiServerId!, 'captureDesktop', {}),
        15000,
      );
    });

    this.on('listWindows', async () => {
      require(this.uiServerId !== undefined, 'UIServer not discovered');
      return this.request<Array<{
        objectId: AbjectId;
        title: string;
        surfaceId: string;
        rect: { x: number; y: number; width: number; height: number };
      }>>(
        request(this.id, this.uiServerId!, 'listWindows', {}),
      );
    });
  }

  protected override async onInit(): Promise<void> {
    this.uiServerId = await this.discoverDep('UIServer') ?? undefined;
  }

  protected override getSourceForAsk(): string | undefined {
    return `## Screenshot Usage Guide

### Capture a Window

  const screenshot = await this.call(
    this.dep('Screenshot'), 'captureWindow',
    { objectId: targetObjectId });
  // screenshot = { imageBase64: '...', width: 800, height: 600 } or null

### Capture the Desktop

  const desktop = await this.call(
    this.dep('Screenshot'), 'captureDesktop', {});
  // desktop = { imageBase64: '...', width: 1280, height: 720 }

### List All Windows

  const windows = await this.call(
    this.dep('Screenshot'), 'listWindows', {});
  // windows = [{ objectId, title, surfaceId, rect: { x, y, width, height } }, ...]

### Interacting with Windows

Screenshot captures visuals. To send input to windows, use UIServer:

  // Click at a position
  await this.call(this.dep('UIServer'), 'click',
    { surfaceId, x: 150, y: 30 });

  // Type text
  await this.call(this.dep('UIServer'), 'type',
    { surfaceId, text: 'hello' });

  // Press a key
  await this.call(this.dep('UIServer'), 'keyPress',
    { surfaceId, key: 'Enter' });

Use listWindows to get surfaceIds, then click/type/keyPress to interact.

### IMPORTANT
- imageBase64 is raw base64-encoded PNG data (no data URI prefix).
- To display as an image in a canvas, prepend 'data:image/png;base64,' to create a data URI.
- captureWindow returns null if the object has no visible window.
- Screenshots capture the current rendered state; ensure the target has drawn before capturing.
- Click/type/keyPress are on UIServer, not Screenshot. Use both together for visual interaction.`;
  }
}
