/**
 * CanvasWidget — a widget that stores draw commands from a ScriptableAbject
 * and renders them into the parent window's surface.
 *
 * Instead of creating a separate UIServer surface, the canvas widget draws
 * directly into the window's surface at its layout-assigned position.
 * This ensures the drawing area moves with the window and integrates
 * naturally with the widget layout system.
 */

import {
  AbjectId,
  AbjectMessage,
} from '../../core/types.js';
import { event } from '../../core/message.js';
import { WidgetAbject, WidgetConfig } from './widget-abject.js';
import {
  WidgetType,
  Rect,
  ThemeData,
  CANVAS_INTERFACE,
} from './widget-types.js';

export interface CanvasWidgetConfig extends WidgetConfig {
  inputTargetId: AbjectId;
}

/**
 * CanvasWidget — renders user-supplied draw commands into the parent window's surface.
 */
export class CanvasWidget extends WidgetAbject {
  private storedCommands: unknown[] = [];
  private inputTargetId: AbjectId;

  constructor(config: CanvasWidgetConfig) {
    super(config);

    this.inputTargetId = config.inputTargetId;

    // Override manifest to include the canvas interface
    (this as unknown as { manifest: unknown }).manifest = {
      name: 'CanvasWidget',
      description: 'Canvas drawing widget — stores draw commands and renders into parent window surface',
      version: '1.0.0',
      interface: {
          id: CANVAS_INTERFACE,
          name: 'Canvas',
          description: 'Canvas drawing interface',
          methods: [
            {
              name: 'draw',
              description: 'Submit draw commands to render on the canvas',
              parameters: [
                { name: 'commands', type: { kind: 'array', elementType: { kind: 'reference', reference: 'DrawCommand' } }, description: 'Draw commands' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'getCanvasSize',
              description: 'Get the current canvas dimensions',
              parameters: [],
              returns: {
                kind: 'object',
                properties: {
                  width: { kind: 'primitive', primitive: 'number' },
                  height: { kind: 'primitive', primitive: 'number' },
                },
              },
            },
          ],
        },
      requiredCapabilities: [],
      providedCapabilities: [],
      tags: ['widget', 'canvas'],
    };

    this.setupCanvasHandlers();
  }

  private setupCanvasHandlers(): void {
    this.on('draw', async (msg: AbjectMessage) => {
      const { commands } = msg.payload as { commands: unknown[] };
      this.storedCommands = commands ?? [];
      await this.requestRedraw();
      return true;
    });

    this.on('getCanvasSize', async () => {
      return { width: this.rect.width, height: this.rect.height };
    });
  }

  // ---- WidgetAbject implementation ----

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const commands: unknown[] = [];
    const w = this.rect.width;
    const h = this.rect.height;

    // Wrap user commands: save → translate → clip → [user commands] → restore
    commands.push({ type: 'save', surfaceId, params: {} });
    commands.push({ type: 'translate', surfaceId, params: { x: ox, y: oy } });
    commands.push({ type: 'clip', surfaceId, params: { x: 0, y: 0, width: w, height: h } });

    // Process each user command
    for (const cmd of this.storedCommands) {
      const c = cmd as { type: string; surfaceId?: string; params?: Record<string, unknown> };

      if (c.type === 'clear') {
        // Replace 'clear' with a filled rect (clear would affect the entire window surface)
        const color = (c.params as { color?: string })?.color;
        commands.push({
          type: 'rect',
          surfaceId,
          params: { x: 0, y: 0, width: w, height: h, fill: color ?? '#000' },
        });
      } else {
        // Replace surfaceId with the window's surfaceId
        commands.push({ ...c, surfaceId });
      }
    }

    commands.push({ type: 'restore', surfaceId, params: {} });

    return commands;
  }

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean; focusWidgetId?: AbjectId }> {
    const inputType = input.type as string;

    // Forward mouse/key events to the ScriptableAbject
    try {
      this.send(event(
        this.id,
        this.inputTargetId,
        'input',
        input
      ));
    } catch {
      // Target may be gone
    }

    // On mousedown, request focus so keyboard events route to this canvas
    if (inputType === 'mousedown') {
      return { consumed: true, focusWidgetId: this.id };
    }

    // Consume all mouse events
    if (inputType === 'mousemove' || inputType === 'mouseup' || inputType === 'wheel' || inputType === 'mouseleave') {
      return { consumed: true };
    }

    // Forward keyboard events when focused
    if (inputType === 'keydown') {
      return { consumed: true };
    }

    return { consumed: false };
  }

  protected getWidgetValue(): string {
    return '';
  }

  protected async applyUpdate(updates: Record<string, unknown>): Promise<void> {
    // When rect changes (layout recalculation), notify the ScriptableAbject
    if (updates.rect !== undefined) {
      const newRect = updates.rect as Rect;
      if (newRect.width > 0 && newRect.height > 0) {
        try {
          this.send(event(
            this.id,
            this.inputTargetId,
            'input',
            { type: 'canvasResize', width: newRect.width, height: newRect.height }
          ));
        } catch {
          // Target may be gone
        }
      }
    }
  }
}
