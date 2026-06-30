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
import { parseMarkdown } from './markdown.js';
import { layoutRichText } from './rich-text-layout.js';
import { renderRichTextCommands } from './markdown-render.js';
import {
  WidgetType,
  Rect,
  ThemeData,
  CANVAS_INTERFACE,
  DRAW_COMMAND_TYPES,
  DRAW_COMMAND_ALIASES,
  CANVAS_CTX_PROPERTIES,
} from './widget-types.js';

const VALID_DRAW_TYPES = new Set<string>(DRAW_COMMAND_TYPES);

/**
 * Required params per command type. Catches the second failure mode after
 * wrong type names: right type, wrong param names (e.g. {w, h, color} instead
 * of {width, height, fill}), which draws nothing. Only the load-bearing
 * fields are checked; optional styling is not. A '|' in an entry lists
 * accepted alternatives (high-level vs canvas-API dialect names).
 */
const REQUIRED_PARAMS: Record<string, string[]> = {
  // High-level shapes
  rect: ['x', 'y', 'width', 'height'],
  text: ['x', 'y', 'text'],
  markdown: ['x', 'y', 'text'],
  line: ['x1', 'y1', 'x2', 'y2'],
  circle: ['cx|x', 'cy|y', 'radius'],
  arc: ['cx|x', 'cy|y', 'radius', 'startAngle', 'endAngle'],
  ellipse: ['cx|x', 'cy|y', 'radiusX', 'radiusY'],
  polygon: ['points'],
  path: ['path'],
  imageUrl: ['x', 'y', 'url'],
  translate: ['x', 'y'],
  rotate: ['angle'],
  linearGradient: ['x0', 'y0', 'x1', 'y1', 'stops'],
  radialGradient: ['cx0', 'cy0', 'r0', 'cx1', 'cy1', 'r1', 'stops'],
  conicGradient: ['startAngle', 'cx', 'cy', 'stops'],
  globalAlpha: ['alpha|value'],
  setLineDash: ['segments|value'],
  // Canvas 2D API methods
  clearRect: ['x', 'y', 'width', 'height'],
  fillRect: ['x', 'y', 'width', 'height'],
  strokeRect: ['x', 'y', 'width', 'height'],
  fillText: ['text', 'x', 'y'],
  strokeText: ['text', 'x', 'y'],
  moveTo: ['x', 'y'],
  lineTo: ['x', 'y'],
  bezierCurveTo: ['cp1x', 'cp1y', 'cp2x', 'cp2y', 'x', 'y'],
  quadraticCurveTo: ['cpx', 'cpy', 'x', 'y'],
  arcTo: ['x1', 'y1', 'x2', 'y2', 'radius'],
  roundRect: ['x', 'y', 'width', 'height'],
  transform: ['a', 'b', 'c', 'd', 'e', 'f'],
  setTransform: ['a', 'b', 'c', 'd', 'e', 'f'],
  drawImage: ['url|data', 'dx|x', 'dy|y'],
  putImageData: ['data', 'width', 'height'],
};

// Context property commands all carry their value as params.value.
for (const prop of CANVAS_CTX_PROPERTIES) {
  REQUIRED_PARAMS[prop] = ['value'];
}

/**
 * Shorthand param names accepted as aliases for the canonical names. Code
 * generators routinely emit the SVG-style short forms ({cx, cy, r} for a
 * circle), so renaming them here keeps pre-existing apps drawing instead of
 * rejecting the whole batch. Gradient params (r0/r1) are unaffected.
 */
const PARAM_ALIASES: Record<string, string> = {
  r: 'radius',
  rx: 'radiusX',
  ry: 'radiusY',
  w: 'width',
  h: 'height',
};

/**
 * Rewrite shorthand param names to their canonical equivalents. A shorthand
 * is only renamed when the canonical name is absent. Input objects are not
 * mutated.
 */
function normalizeDrawCommands(commands: unknown[]): unknown[] {
  return commands.map((cmd) => {
    const c = cmd as { params?: Record<string, unknown> };
    const params = c?.params;
    if (!params || typeof params !== 'object') return cmd;
    let renamed: Record<string, unknown> | undefined;
    for (const [alias, canonical] of Object.entries(PARAM_ALIASES)) {
      if (params[alias] !== undefined && params[canonical] === undefined) {
        renamed ??= { ...params };
        renamed[canonical] = renamed[alias];
        delete renamed[alias];
      }
    }
    return renamed ? { ...(cmd as object), params: renamed } : cmd;
  });
}

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
      const missing = required.filter((spec) => !spec.split('|').some((k) => params[k] !== undefined));
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
  /** Cache of expanded markdown layouts, keyed by text+geometry, so re-renders
   *  don't re-run the (async, round-tripping) layout for unchanged blocks.
   *  Cleared when an image finishes resolving so resolved dims take effect. */
  private mdCache = new Map<string, unknown[]>();
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
              description: 'Raw mouse/keyboard input forwarded to inputTargetId. Payload fields are on msg.payload: { type: "mousedown"|"mousemove"|"mouseup"|"mouseleave"|"keydown"|"wheel"|"canvasResize"|"paste", x?: number, y?: number, button?: number, code?: string, key?: string, modifiers?: object, width?: number, height?: number, pasteText?: string, image?: string }. A real clipboard paste while this canvas is focused arrives as { type: "paste" } with pasteText (text paste) and/or image (a data:image/* URI when an image was pasted/dropped) — read msg.payload.image to accept a pasted image; do NOT rely on the Clipboard object to read a real OS paste. The same shape is used by both real compositor events and synthetic call(target, "input", payload) calls.',
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

  // Drawing API + theme-token guidance agents consult to render canvas UIs.
  protected override askTier(): 'smart' | 'balanced' | 'fast' {
    return 'balanced';
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## CanvasWidget — Draw Commands

I render the \`draw\` commands you send me. Each command is an object \`{ type, surfaceId: 'c', params }\` (surfaceId is rewritten internally; any string works). Commands execute in order against a stateful 2D context, and two dialects mix freely: high-level self-contained shapes, and the standard HTML5 Canvas 2D API (every context method is a command type with params named after the MDN argument names; every settable context property is a command with params \`{ value }\`). I REJECT the whole batch with an error if any command has an unknown type or is missing required params — nothing is drawn until every command is valid.

### High-level shapes (all take optional \`fill\`, \`stroke\`, \`lineWidth\` in params)
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

State and effects:
- \`clear\` — { color? } (fills the whole canvas; use as the first command each frame)
- \`shadow\` — { color, blur, offsetX?, offsetY? }
- \`linearGradient\` — { x0, y0, x1, y1, stops: [{offset, color},...] } (becomes the fill for subsequent shapes until changed)
- \`radialGradient\` — { cx0, cy0, r0, cx1, cy1, r1, stops: [...] }, \`conicGradient\` — { startAngle, cx, cy, stops: [...] }

### Canvas 2D API commands
Methods (params use the MDN argument names):
- \`fillRect\` / \`strokeRect\` / \`clearRect\` — { x, y, width, height }
- \`fillText\` / \`strokeText\` — { text, x, y, maxWidth? }
- \`beginPath\` / \`closePath\` — {}; \`moveTo\` / \`lineTo\` — { x, y }
- \`arc\` / \`circle\` / \`ellipse\` / \`rect\` with no fill/stroke param build the current path like their ctx counterparts (shapes accept x/y for cx/cy)
- \`roundRect\` — { x, y, width, height, radii }; \`arcTo\` — { x1, y1, x2, y2, radius }
- \`bezierCurveTo\` — { cp1x, cp1y, cp2x, cp2y, x, y }; \`quadraticCurveTo\` — { cpx, cpy, x, y }
- \`fill\` — { fillRule?, fillStyle?, path? } and \`stroke\` — { strokeStyle?, lineWidth?, path? } act on the current path (or on an SVG \`path\` string if given)
- \`clip\` — {} clips to the current path; { x, y, width, height } rect-clips
- \`save\` / \`restore\` — {} (always balance them); \`translate\` — { x, y }; \`rotate\` — { angle }; \`scale\` — { x, y }; \`transform\` / \`setTransform\` — { a, b, c, d, e, f }; \`resetTransform\` — {}
- \`drawImage\` — { url, dx, dy, dWidth?, dHeight?, sx?, sy?, sWidth?, sHeight? }
- \`putImageData\` — { data: <flat RGBA number array>, width, height, dx?, dy? }
- \`setLineDash\` — { segments: [n, n] }

Properties (one command each, params { value }): \`fillStyle\`, \`strokeStyle\`, \`lineWidth\`, \`lineCap\`, \`lineJoin\`, \`miterLimit\`, \`lineDashOffset\`, \`font\`, \`textAlign\`, \`textBaseline\`, \`direction\`, \`letterSpacing\`, \`wordSpacing\`, \`globalAlpha\` (also accepts { alpha }), \`globalCompositeOperation\`, \`filter\`, \`shadowColor\`, \`shadowBlur\`, \`shadowOffsetX\`, \`shadowOffsetY\`, \`imageSmoothingEnabled\`, \`imageSmoothingQuality\`. The \`fillStyle\`/\`strokeStyle\` value may also be a gradient descriptor: { x0, y0, x1, y1, stops } (linear), { cx0, cy0, r0, cx1, cy1, r1, stops } (radial), or { startAngle, cx, cy, stops } (conic).

### Frame pattern

\`\`\`js
async _render() {
  if (!this._canvasId) return;
  const { width: W, height: H } = await this.call(this._canvasId, 'getCanvasSize', {});
  const cmds = [];
  cmds.push({ type: 'clear', surfaceId: 'c', params: { color: '#0f172a' } });
  // High-level dialect:
  cmds.push({ type: 'rect', surfaceId: 'c', params: { x: 16, y: 16, width: 200, height: 80, fill: '#1e293b', stroke: '#334155', radius: 8 } });
  cmds.push({ type: 'text', surfaceId: 'c', params: { x: 24, y: 40, text: 'Hello', fill: '#f1f5f9', font: 'bold 16px sans-serif' } });
  // Canvas-API dialect:
  cmds.push({ type: 'beginPath', surfaceId: 'c', params: {} });
  cmds.push({ type: 'moveTo', surfaceId: 'c', params: { x: 20, y: 140 } });
  cmds.push({ type: 'lineTo', surfaceId: 'c', params: { x: 120, y: 110 } });
  cmds.push({ type: 'fillStyle', surfaceId: 'c', params: { value: '#5be5a0' } });
  cmds.push({ type: 'fill', surfaceId: 'c', params: {} });
  await this.call(this._canvasId, 'draw', { commands: cmds });
}
\`\`\`

Notes:
- Shorthand param names \`r\`, \`rx\`, \`ry\`, \`w\`, \`h\` are accepted and treated as \`radius\`, \`radiusX\`, \`radiusY\`, \`width\`, \`height\`; \`color\` on shapes is rejected (use \`fill\` or \`stroke\`).
- I draw into the parent window's surface, so \`clear\`, \`reset\`, and \`clearRect\` become opaque background fills (default '#000') rather than transparent erases, and \`setTransform\` coordinates are window-absolute — prefer \`save\`/\`translate\`/\`restore\` or \`transform\`.
- Value-returning context APIs (measureText, getImageData, isPointInPath, getTransform, createPattern) have no command form — a draw batch cannot return data.
- For real 3D content (meshes, lights) attach retained scene nodes to your WINDOW instead: \`call(windowId, 'scene', { ops: [...] })\` — ask the window for its scene vocabulary. This canvas stays the way to draw 2D.

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
      const payload = msg.payload as { commands: unknown[] };
      const commands = normalizeDrawCommands(payload.commands ?? []);

      // Reject invalid batches loudly instead of letting the compositor skip
      // unknown commands silently (the caller would see a blank canvas and no
      // error). The thrown message names every distinct problem plus the
      // valid vocabulary, so a code-generating caller can self-correct.
      const problems = validateDrawCommands(commands);
      if (problems.length > 0) {
        throw new Error(
          `Invalid draw commands (nothing was drawn): ${problems.join('; ')}. ` +
          `Valid command types: ${DRAW_COMMAND_TYPES.join(', ')}. ` +
          `Shape: { type, surfaceId, params } — e.g. { type: 'rect', surfaceId: 'c', params: { x, y, width, height, fill: '#0f172a' } }, ` +
          `{ type: 'text', surfaceId: 'c', params: { x, y, text, fill: '#fff', font: '14px sans-serif' } }.`
        );
      }

      this.storedCommands = commands;
      await this.requestRedraw();
      return true;
    });

    this.on('getCanvasSize', async () => {
      return { width: this.rect.width, height: this.rect.height };
    });

    // An image pasted or dropped while this canvas is the focused widget is
    // delivered here by the window (toFocusedWidget). The canvas has no UI of
    // its own, so forward it to the input target as a `paste` input event
    // carrying the image as a data: URI — the same channel mouse/keyboard input
    // uses. Canvas apps read `msg.payload.image` in their input('paste')
    // handler. Without this, pasted images dead-end at the canvas (text inputs
    // get this for free; the canvas did not).
    this.on('fileUploaded', async (msg: AbjectMessage) => {
      const { name, mimeType, base64 } = msg.payload as { name?: string; mimeType?: string; base64?: string };
      if (!base64 || !(mimeType ?? '').startsWith('image/')) return true;
      const image = `data:${mimeType};base64,${base64}`;
      this.send(event(this.id, this.inputTargetId, 'input', { type: 'paste', image, name: name ?? 'image', mimeType }));
      return true;
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

      if (c.type === 'clear' || c.type === 'reset') {
        // Replace with a filled rect (clear/reset would wipe the entire
        // window surface and its context state, including this wrapper's
        // translate/clip)
        const color = (c.params as { color?: string })?.color;
        commands.push({
          type: 'rect',
          surfaceId,
          params: { x: 0, y: 0, width: w, height: h, fill: color ?? '#000' },
        });
      } else if (c.type === 'clearRect') {
        // clearRect would punch a transparent hole in the shared window
        // surface; paint the background color instead
        const p = (c.params ?? {}) as { x?: number; y?: number; width?: number; height?: number };
        commands.push({
          type: 'rect',
          surfaceId,
          params: { x: p.x ?? 0, y: p.y ?? 0, width: p.width ?? w, height: p.height ?? h, fill: '#000' },
        });
      } else if (c.type === 'putImageData') {
        // putImageData ignores the canvas transform, so the wrapper's
        // translate does not apply — bake the widget offset into dx/dy
        const p = (c.params ?? {}) as { dx?: number; dy?: number };
        commands.push({
          ...c,
          surfaceId,
          params: { ...(c.params ?? {}), dx: (p.dx ?? 0) + ox, dy: (p.dy ?? 0) + oy },
        });
      } else if (c.type === 'markdown') {
        // Expand a markdown block into primitive text/imageUrl/rect/line
        // commands using the same engine the label widget uses. Coordinates
        // are canvas-local (the wrapper's translate already applied).
        const expanded = await this.expandMarkdown(surfaceId, (c.params ?? {}) as Record<string, unknown>);
        for (const e of expanded) commands.push(e);
      } else {
        // Replace surfaceId with the window's surfaceId
        commands.push({ ...c, surfaceId });
      }
    }

    commands.push({ type: 'restore', surfaceId, params: {} });

    return commands;
  }

  /** Invalidate the markdown layout cache when an image resolves so the next
   *  render picks up the now-known image dimensions. */
  protected override onImageResolved(): void {
    this.mdCache.clear();
  }

  /**
   * Expand a `markdown` draw command into primitive draw commands (text /
   * imageUrl / rect / line), reusing the shared markdown parser + rich-text
   * layout + image resolver — the same engine the label widget uses. Emits at
   * canvas-local coordinates (the buildDrawCommands wrapper's translate already
   * applied). Params: { x, y, text, maxWidth?, fontSize?, fill?, maxImageHeight? }.
   */
  private async expandMarkdown(surfaceId: string, params: Record<string, unknown>): Promise<unknown[]> {
    const x = Number(params.x ?? 0);
    const y = Number(params.y ?? 0);
    const text = String(params.text ?? '');
    const maxWidth = Number(params.maxWidth ?? params.width ?? this.rect.width - x);
    const fontSize = Number(params.fontSize ?? 14);
    const fill = String(params.fill ?? this.theme.textPrimary);
    const maxImageHeight = params.maxImageHeight !== undefined ? Number(params.maxImageHeight) : undefined;
    if (!text) return [];

    const key = `${x}|${y}|${maxWidth}|${fontSize}|${fill}|${maxImageHeight ?? ''}|${text}`;
    const cached = this.mdCache.get(key);
    if (cached) return cached;

    const measureFn = (t: string, font: string): Promise<number> => this.measureText(surfaceId, t, font);
    let layout;
    try {
      const parsed = parseMarkdown(text);
      layout = await layoutRichText(
        parsed, maxWidth, measureFn, this.theme, fontSize, fill,
        this.imageResolver.resolveDims, maxImageHeight,
      );
    } catch {
      // On any layout failure, fall back to a single plain-text command so the
      // node still shows its content rather than vanishing.
      const fallback = [{ type: 'text', surfaceId, params: { x, y: y + fontSize, text, font: `${fontSize}px sans-serif`, fill, baseline: 'alphabetic' } }];
      return fallback;
    }

    const out = await renderRichTextCommands(layout, {
      surfaceId, ox: x, oy: y, width: maxWidth, height: this.rect.height,
      theme: this.theme, drawableUrl: (u) => this.imageResolver.drawableUrl(u),
      textPadding: 0,
    });

    this.mdCache.set(key, out);
    return out;
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
