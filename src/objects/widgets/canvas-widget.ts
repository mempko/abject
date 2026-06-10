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
  DRAW_COMMAND_TYPES,
  DRAW_COMMAND_ALIASES,
} from './widget-types.js';

const VALID_DRAW_TYPES = new Set<string>(DRAW_COMMAND_TYPES);

/**
 * Required params per command type for the common shapes. Catches the second
 * failure mode after wrong type names: right type, wrong param names (e.g.
 * {w, h, color} instead of {width, height, fill}), which draws nothing.
 * Only the load-bearing fields are checked; optional styling is not.
 */
const REQUIRED_PARAMS: Record<string, string[]> = {
  rect: ['x', 'y', 'width', 'height'],
  text: ['x', 'y', 'text'],
  line: ['x1', 'y1', 'x2', 'y2'],
  circle: ['cx', 'cy', 'radius'],
  arc: ['cx', 'cy', 'radius', 'startAngle', 'endAngle'],
  ellipse: ['cx', 'cy', 'radiusX', 'radiusY'],
  imageUrl: ['x', 'y', 'url'],
  clip: ['x', 'y', 'width', 'height'],
  translate: ['x', 'y'],
};

/**
 * Validate a draw command batch. Returns a list of human-actionable problem
 * descriptions (empty when the batch is fully valid). Reported problems are
 * deduplicated by type so a 200-command batch yields a short message.
 */
function validateDrawCommands(commands: unknown[]): string[] {
  const problems = new Map<string, string>();
  for (const cmd of commands) {
    const c = cmd as { type?: unknown; params?: Record<string, unknown> };
    const type = typeof c?.type === 'string' ? c.type : undefined;
    if (!type) {
      problems.set('<missing type>', 'command without a string `type` field');
      continue;
    }
    if (!VALID_DRAW_TYPES.has(type)) {
      const hint = DRAW_COMMAND_ALIASES[type];
      problems.set(type, hint
        ? `unknown type '${type}' — use ${hint}`
        : `unknown type '${type}'`);
      continue;
    }
    const required = REQUIRED_PARAMS[type];
    if (required) {
      const params = c.params ?? {};
      const missing = required.filter((k) => params[k] === undefined);
      if (missing.length > 0) {
        problems.set(`${type}:params`, `'${type}' command missing required params {${missing.join(', ')}} — got {${Object.keys(params).join(', ')}}`);
      }
    }
  }
  return [...problems.values()];
}

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
      description: 'Canvas drawing widget — stores draw commands and renders into parent window surface. Forwards mouse/keyboard input from the compositor to the configured inputTargetId via the `input` event.',
      version: '1.0.0',
      interface: {
          id: CANVAS_INTERFACE,
          name: 'Canvas',
          description: 'Canvas drawing interface. Receives draw commands; forwards raw input events to inputTargetId.',
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
          events: [
            {
              name: 'input',
              description: 'Raw mouse/keyboard input forwarded to inputTargetId. Payload fields are on msg.payload: { type: "mousedown"|"mousemove"|"mouseup"|"mouseleave"|"keydown"|"wheel"|"canvasResize", x?: number, y?: number, button?: number, code?: string, key?: string, modifiers?: object, width?: number, height?: number }. The same shape is used by both real compositor events and synthetic call(target, "input", payload) calls.',
              payload: { kind: 'object', properties: {
                type: { kind: 'primitive', primitive: 'string' },
                x: { kind: 'primitive', primitive: 'number' },
                y: { kind: 'primitive', primitive: 'number' },
                button: { kind: 'primitive', primitive: 'number' },
              }},
            },
          ],
        },
      requiredCapabilities: [],
      providedCapabilities: [],
      tags: ['widget', 'canvas'],
    };

    this.setupCanvasHandlers();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## CanvasWidget — Draw Commands

I render the \`draw\` commands you send me. **This is NOT the HTML5 Canvas API** — there is no fillRect/fillText/beginPath and no stateful context. Each command is a self-contained object: \`{ type, surfaceId: 'c', params }\` (surfaceId is rewritten internally; any string works). I REJECT the whole batch with an error if any command has an unknown type or is missing required params — nothing is drawn until every command is valid.

### Vocabulary (complete)

Shapes (all take optional \`fill\`, \`stroke\`, \`lineWidth\` in params):
- \`rect\` — { x, y, width, height, fill?, stroke?, lineWidth?, radius? }   (radius = rounded corners)
- \`circle\` — { cx, cy, radius, fill?, stroke? }
- \`ellipse\` — { cx, cy, radiusX, radiusY, rotation?, fill?, stroke? }
- \`arc\` — { cx, cy, radius, startAngle, endAngle, fill?, stroke?, counterclockwise? }
- \`polygon\` — { points: [{x,y},...], fill?, stroke? }
- \`line\` — { x1, y1, x2, y2, stroke?, lineWidth?, lineCap? }
- \`path\` — { path: '<SVG path string like M10 10 L90 90 Z>', fill?, stroke? }
- \`bezierCurve\` — { x0, y0, cp1x, cp1y, cp2x, cp2y, x1, y1, fill?, stroke? }
- \`quadraticCurve\` — { x0, y0, cpx, cpy, x1, y1, fill?, stroke? }

Text and images:
- \`text\` — { x, y, text, fill?, font? ('bold 14px sans-serif'), align? ('left'|'center'|'right'), baseline?, maxWidth? }
- \`imageUrl\` — { x, y, width?, height?, url }

State and effects (mirror canvas2d semantics, as commands):
- \`clear\` — { color? } (fills the whole canvas; use as the first command each frame)
- \`save\` / \`restore\` — {} (always balance them)
- \`clip\` — { x, y, width, height }, \`translate\` — { x, y }, \`rotate\` — { angle }, \`scale\` — { x, y }
- \`globalAlpha\` — { alpha }, \`shadow\` — { color, blur, offsetX?, offsetY? }, \`setLineDash\` — { segments: [n, n] }
- \`linearGradient\` — { x0, y0, x1, y1, stops: [{offset, color},...] } (becomes the fill for subsequent shapes until changed)
- \`radialGradient\` — { cx0, cy0, r0, cx1, cy1, r1, stops: [...] }

### Frame pattern

\`\`\`js
async _render() {
  if (!this._canvasId) return;
  const { width: W, height: H } = await this.call(this._canvasId, 'getCanvasSize', {});
  const cmds = [];
  cmds.push({ type: 'clear', surfaceId: 'c', params: { color: '#0f172a' } });
  cmds.push({ type: 'rect', surfaceId: 'c', params: { x: 16, y: 16, width: 200, height: 80, fill: '#1e293b', stroke: '#334155', radius: 8 } });
  cmds.push({ type: 'text', surfaceId: 'c', params: { x: 24, y: 40, text: 'Hello', fill: '#f1f5f9', font: 'bold 16px sans-serif' } });
  await this.call(this._canvasId, 'draw', { commands: cmds });
}
\`\`\`

Common mistakes that I reject: \`fillRect\`/\`strokeRect\` (use \`rect\` with fill/stroke), \`fillText\` (use \`text\`), \`drawImage\` (use \`imageUrl\`), \`w\`/\`h\` (use \`width\`/\`height\`), \`color\` on shapes (use \`fill\` or \`stroke\`).

## CanvasWidget — Input Forwarding

I forward raw input (mouse and keyboard) from the compositor to a single target ScriptableAbject.

### Input forwarding

The compositor → window → layout → me chain delivers input events to my \`processInput\` method. I then send a fire-and-forget \`event\` message named \`input\` to my configured \`inputTargetId\`. The fields land on \`msg.payload\` of the event:

\`\`\`js
async input(msg) {
  const { type, x, y, button, code, key, modifiers, width, height } = msg.payload;
  // type: 'mousedown' | 'mousemove' | 'mouseup' | 'mouseleave' | 'keydown' | 'wheel' | 'canvasResize'
}
\`\`\`

This is the SAME shape whether the event came from a real user click or from a synthetic \`call(canvasId, 'input', payload)\` test. Both go through \`msg.payload\`. If your handler reads only \`msg.payload.type\` you do not need any "top-level fallback" — there is no top-level shape.

### inputTargetId

I receive my \`inputTargetId\` at construction. \`WidgetManager.createCanvas\` accepts an explicit \`inputTargetId\` and falls back to \`msg.routing.from\` (i.e. whatever object sent the createCanvas request) when omitted. **Always pass \`inputTargetId: this.id\` explicitly when creating me from a ScriptableAbject** — this makes the wiring auditable and survives intermediaries.

### Test pitfall

A synthetic \`call(<canvasId>, 'input', { type: 'mousedown', x, y, button: 0 })\` exercises only the input-target's handler logic. It does NOT prove that the compositor → window → layout → canvas chain reaches me, and it does NOT prove that my \`inputTargetId\` is set correctly. To verify the real path, inspect the source for an explicit \`inputTargetId: this.id\` on the createCanvas call, then drive the system end-to-end.

### Methods
- \`draw({commands})\` — store and render draw commands.
- \`getCanvasSize()\` — return current width/height.
- \`addDependent({})\` — be notified of my \`changed\` events (rare; most callers care about \`input\` instead).

### Events
- \`input\` — forwarded to \`inputTargetId\`. See payload shape above.`;
  }

  private setupCanvasHandlers(): void {
    this.on('draw', async (msg: AbjectMessage) => {
      const { commands } = msg.payload as { commands: unknown[] };

      // Reject invalid batches loudly instead of letting the compositor skip
      // unknown commands silently (the caller would see a blank canvas and no
      // error). The thrown message names every distinct problem plus the
      // valid vocabulary, so a code-generating caller can self-correct.
      const problems = validateDrawCommands(commands ?? []);
      if (problems.length > 0) {
        throw new Error(
          `Invalid draw commands (nothing was drawn): ${problems.join('; ')}. ` +
          `Valid command types: ${DRAW_COMMAND_TYPES.join(', ')}. ` +
          `Shape: { type, surfaceId, params } — e.g. { type: 'rect', surfaceId: 'c', params: { x, y, width, height, fill: '#0f172a' } }, ` +
          `{ type: 'text', surfaceId: 'c', params: { x, y, text, fill: '#fff', font: '14px sans-serif' } }.`
        );
      }

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

  // A canvas owns its entire content area; the scriptable content draws its
  // own focus cues if it wants them. Painting the base class accent ring on
  // keyboard focus puts an unwanted border around the drawing surface.
  protected override suppressGenericFocusRing(): boolean {
    return true;
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
