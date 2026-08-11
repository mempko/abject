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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
              description: 'Capture a screenshot of an object\'s window. Returns base64-encoded PNG image data, or { error } describing why nothing could be captured.',
              parameters: [
                {
                  name: 'objectId',
                  type: { kind: 'primitive', primitive: 'string' },
                  description: 'The window\'s owning object: its registered name, full AbjectId, or the windowId returned by show()/createWindowAbject',
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

      const shot = await this.captureForOwner(objectId as AbjectId);
      if (shot) return shot;

      // Callers frequently hold a registered NAME ("RacingGame") rather than
      // an AbjectId — resolve it via the Registry and retry.
      if (!UUID_RE.test(objectId)) {
        const resolved = await this.resolveRegisteredName(objectId);
        if (resolved) {
          const named = await this.captureForOwner(resolved);
          if (named) return named;
        }
      }

      // A bare null reads as success to LLM callers. Say what happened and
      // what to do about it instead.
      return {
        error: `No capturable window found for ${objectId}. Passing the owning object's registered name, its full id, or the windowId returned by show()/createWindowAbject works when the window is visible; use listWindows to see every capturable window. A window also cannot be captured when no frontend client is connected.`,
      };
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

  /**
   * Try every capture route for an owning object's id: direct surface hit,
   * then owner → window(s) via WidgetManager. An empty imageBase64 is a
   * failed capture, never a result — returning it would short-circuit the
   * remaining routes with an image the caller cannot see.
   */
  private async captureForOwner(
    objectId: AbjectId,
  ): Promise<{ imageBase64: string; width: number; height: number } | null> {
    const direct = await this.request<{ imageBase64: string; width: number; height: number } | null>(
      request(this.id, this.uiServerId!, 'captureScreenshot', { objectId }),
      15000,
    );
    if (direct?.imageBase64) return direct;

    // Window surfaces are registered under the WindowAbject's id, so a
    // capture by the OWNING object's id never matches directly — and the
    // owner id is exactly what callers naturally have. Resolve owner →
    // window(s) via WidgetManager and retry with each window id.
    try {
      const wmId = await this.discoverDep('WidgetManager');
      if (wmId) {
        const windows = await this.request<Array<{ windowId: AbjectId; ownerId: AbjectId }>>(
          request(this.id, wmId, 'listWindows', {}),
          10000,
        );
        for (const w of windows ?? []) {
          if (w.ownerId !== objectId) continue;
          const shot = await this.request<{ imageBase64: string; width: number; height: number } | null>(
            request(this.id, this.uiServerId!, 'captureScreenshot', { objectId: w.windowId }),
            15000,
          );
          if (shot?.imageBase64) return shot;
        }
      }
    } catch { /* fall through */ }
    return null;
  }

  /**
   * Resolve a registered name to an AbjectId. Exact-name discover first;
   * Registry search second, because duplicate names are uniquified with a
   * -N suffix ("RacingGame-2") that an exact discover misses.
   */
  private async resolveRegisteredName(name: string): Promise<AbjectId | null> {
    try {
      const exact = await this.discoverDep(name);
      if (exact) return exact;
      const regId = await this.resolveRegistryId();
      if (!regId) return null;
      const results = await this.request<Array<{ id: AbjectId; name: string }>>(
        request(this.id, regId, 'search', { query: name, limit: 5 }),
        10000,
      );
      const lower = name.toLowerCase();
      const best = (results ?? []).find(r => r.name?.toLowerCase().startsWith(lower));
      return best?.id ?? null;
    } catch {
      return null;
    }
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## Screenshot Usage Guide

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
- captureWindow accepts the owning object's registered name, its FULL AbjectId, or a windowId; truncated ids never match.
- When nothing can be captured, captureWindow returns { error: "..." } explaining why — a result WITHOUT imageBase64 means you have NOT seen the window; do not treat it as visual confirmation.
- Screenshots capture the current rendered state; ensure the target has drawn before capturing.
- captureWindow captures the window's region AS COMPOSITED ON SCREEN — widgets, 2D canvas content, AND the window's 3D scene nodes (meshes/lights/bloom) all appear, so it verifies 3D rendering. Because it is a screen crop, a window overlapping the target shows up too: raise the target first (WidgetManager.raiseWindow { windowId }) for a clean capture. When the window is scrolled mostly off-screen the capture falls back to the window's own 2D content, WITHOUT 3D nodes — bring it on-screen to verify 3D.
- Click/type/keyPress are on UIServer, not Screenshot. Use both together for visual interaction.`;
  }
}
