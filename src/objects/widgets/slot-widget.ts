/**
 * SlotWidget — another object shown inside a window.
 *
 * Any object that answers `render` can sit in a slot: a card in a chat, a
 * small live drawing in a dialog, a pinned note on the desktop. The slot asks
 * it `render({ width, host })` and gets back `{ commands, height? }`: draw
 * commands in the object's own coordinates (0,0 at the slot's top left). The
 * slot checks them against the draw vocabulary, moves them into place and
 * clips them to its box, so the object never learns which window it is in
 * and cannot draw outside its slot.
 *
 * The object is kept by AbjectStore (`target` is its typeId). Before it is
 * awake the slot draws its saved preview; while the slot is on screen it
 * holds the object awake (AbjectStore hold), and a while after it scrolls
 * away it lets go so the object can sleep. The object asks for a fresh
 * drawing with `changed('redraw')`; input in the slot reaches it as
 * `handleInput` in its own coordinates. After a new drawing the slot saves it
 * as the object's preview. A render that fails or takes too long leaves the
 * preview (or a quiet placeholder) in place.
 *
 * For the object, the slot (`host`) answers `measureText({ text, font })`
 * and `wrapText({ text, font, maxWidth })`. Colours may be theme names
 * (`$accent`, `$textPrimary`) and fonts may name the theme's faces
 * (`600 26px $display`, `$body`, `$mono`); both follow the person's theme.
 * An object that wants something done (a button tapped) says
 * `changed('action', { say?, open? })`; the slot passes it to its owner, who
 * decides what it means (Chat sends `say` as the person's words).
 *
 * Events:
 *   contentHeight — number  the height the object's drawing needs
 *   action        — { say?, open? }  the shown object asked for something
 */

import { AbjectId, AbjectMessage } from '../../core/types.js';
import { request } from '../../core/message.js';
import { require as contractRequire } from '../../core/contracts.js';
import { WidgetAbject, WidgetConfig } from './widget-abject.js';
import { DRAW_COMMAND_TYPES, fontStacks } from './widget-types.js';
import { wrapText } from './word-wrap.js';

export interface SlotWidgetConfig extends WidgetConfig {
  /** The shown object's typeId (AbjectStore keeps it). */
  target: string;
  /** The AbjectStore that keeps it (the workspace's). */
  storeId: AbjectId;
  /** Height before the object (or its preview) says otherwise. */
  height?: number;
}

/** Draw commands an object may use in a slot: none that reach past it or load from the network. */
const SLOT_COMMANDS = new Set<string>(DRAW_COMMAND_TYPES.filter(t =>
  !['imageUrl', 'videoFrame', 'markdown', 'clear', 'reset', 'putImageData', 'drawImage'].includes(t)));

const MAX_COMMANDS = 4000;
const MIN_HEIGHT = 24;
const MAX_HEIGHT = 4000;
const RENDER_TIMEOUT_MS = 5000;
const INPUT_TIMEOUT_MS = 2000;
/** After scrolling away, how long the slot keeps its object awake. */
const RELEASE_AFTER_MS = 30_000;
const PREVIEW_SAVE_DELAY_MS = 1500;
const MOVE_INTERVAL_MS = 33;

/**
 * The draw commands an object returned, made safe to replay inside the slot:
 * known kinds only, no surface or node of its own, images only as inline
 * data, and every `restore` matched by a `save` the object made, so the
 * slot's clip outlives the object's drawing. Throws on anything else.
 */
export function cleanSlotCommands(raw: unknown): Array<Record<string, unknown>> {
  contractRequire(Array.isArray(raw), 'render must return { commands: [...] }');
  const list = raw as unknown[];
  contractRequire(list.length <= MAX_COMMANDS, `a slot takes at most ${MAX_COMMANDS} draw commands`);
  const out: Array<Record<string, unknown>> = [];
  let depth = 0;
  for (const item of list) {
    contractRequire(!!item && typeof item === 'object', 'each draw command is an object');
    const { type, params } = item as { type?: unknown; params?: unknown };
    contractRequire(typeof type === 'string' && SLOT_COMMANDS.has(type), `draw command '${String(type)}' is not available in a slot`);
    const p = (params && typeof params === 'object' ? { ...(params as Record<string, unknown>) } : {}) as Record<string, unknown>;
    delete p.surfaceId;
    delete p.nodeId;
    if (type === 'image') {
      const src = p.src ?? p.data;
      contractRequire(typeof src === 'string' && src.startsWith('data:image/'), 'a slot image is an inline data:image/ URI');
    }
    if (type === 'save') depth++;
    if (type === 'restore') {
      if (depth === 0) continue;
      depth--;
    }
    out.push({ type, params: p });
  }
  for (; depth > 0; depth--) out.push({ type: 'restore', params: {} });
  return out;
}

/** What a shown object may ask its slot's owner for: words to send, or an object to open. */
export function cleanSlotAction(raw: unknown): { say?: string; open?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { say, open } = raw as { say?: unknown; open?: unknown };
  const out: { say?: string; open?: string } = {};
  if (typeof say === 'string' && say.trim()) out.say = say.trim().slice(0, 500);
  if (typeof open === 'string' && open.trim()) out.open = open.trim().slice(0, 300);
  return out.say || out.open ? out : undefined;
}

export class SlotWidget extends WidgetAbject {
  private target: string;
  private readonly storeId: AbjectId;
  private liveId?: AbjectId;
  /** The drawing now shown, in the object's coordinates, and the width it was made for. */
  private drawing: Array<Record<string, unknown>> = [];
  private drawnWidth = 0;
  /** A preview drawn at another width is scaled to fit. */
  private drawingScale = 1;
  private contentHeight: number;
  private lastReportedHeight = -1;
  private dirty = true;
  private fetching = false;
  private failed = false;
  private previewAsked = false;
  private live = false;
  private letGoTimer?: ReturnType<typeof setTimeout>;
  private previewTimer?: ReturnType<typeof setTimeout>;
  private lastMoveAt = 0;
  private lastSurfaceId = '';

  constructor(config: SlotWidgetConfig) {
    super(config);
    contractRequire(typeof config.target === 'string' && config.target.length > 0, 'a slot needs the typeId of the object it shows');
    contractRequire(typeof config.storeId === 'string' && config.storeId.length > 0, 'a slot needs the AbjectStore that keeps its object');
    this.target = config.target;
    this.storeId = config.storeId;
    this.contentHeight = clampHeight(config.height ?? 120);

    // The shown object asks for a fresh drawing, or for something to be done.
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = (msg.payload ?? {}) as { aspect?: string; value?: unknown };
      if (msg.routing.from !== this.liveId) return;
      if (aspect === 'redraw') {
        this.dirty = true;
        await this.requestRedraw();
      } else if (aspect === 'action') {
        const action = cleanSlotAction(value);
        if (action) this.changed('action', { ...action, target: this.target });
      }
    });

    // Text measurement for the object, which has no fonts of its own.
    this.on('measureText', async (msg: AbjectMessage) => {
      const { text, font } = (msg.payload ?? {}) as { text?: string; font?: string };
      return this.measureText(this.surfaceIdForMeasure(), String(text ?? ''), this.fontFor(font));
    });
    this.on('wrapText', async (msg: AbjectMessage) => {
      const { text, font, maxWidth } = (msg.payload ?? {}) as { text?: string; font?: string; maxWidth?: number };
      contractRequire(typeof maxWidth === 'number' && maxWidth > 0, 'wrapText needs maxWidth');
      const resolved = this.fontFor(font);
      return wrapText(String(text ?? ''), maxWidth, (t: string) => this.measureText(this.surfaceIdForMeasure(), t, resolved));
    });
  }

  /** Measuring goes through the surface the slot last drew on (any surface measures the same fonts). */
  private surfaceIdForMeasure(): string {
    return this.lastSurfaceId;
  }

  /** A font, with the theme's stacks behind `$body`, `$display` and `$mono`. */
  private fontFor(font: string | undefined): string {
    const stacks = fontStacks(this.theme);
    if (!font) return `14px ${stacks.body}`;
    return font.replace(/\$display\b/g, stacks.display).replace(/\$body\b/g, stacks.body).replace(/\$mono\b/g, stacks.mono);
  }

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    this.lastSurfaceId = surfaceId;
    const w = this.rect.width;
    const h = this.rect.height;
    this.live = true;
    if (this.letGoTimer) { clearTimeout(this.letGoTimer); this.letGoTimer = undefined; }
    if (!this.previewAsked) void this.loadPreview();
    if (w > 0 && !this.fetching && (this.dirty || (w !== this.drawnWidth && this.drawingScale === 1))) void this.refresh(w);

    if (Math.abs(this.contentHeight - this.lastReportedHeight) >= 1) {
      this.lastReportedHeight = this.contentHeight;
      this.changed('contentHeight', this.contentHeight);
    }

    if (this.drawing.length === 0) {
      // Nothing to show yet: a quiet frame, or a note when it could not start.
      const out: unknown[] = [{ type: 'rect', surfaceId, params: { x: ox + 0.5, y: oy + 0.5, width: Math.max(0, w - 1), height: Math.max(0, h - 1), stroke: this.theme.divider } }];
      if (this.failed) {
        out.push({ type: 'text', surfaceId, params: {
          x: ox + 12, y: oy + h / 2, text: 'This could not be shown', font: `13px ${fontStacks(this.theme).body}`,
          fill: this.theme.textMeta, baseline: 'middle', maxWidth: Math.max(0, w - 24),
        } });
      }
      return out;
    }

    const out: unknown[] = [
      { type: 'save', surfaceId, params: {} },
      { type: 'clip', surfaceId, params: { x: ox, y: oy, width: w, height: h } },
      { type: 'translate', surfaceId, params: { x: ox, y: oy } },
    ];
    if (this.drawingScale !== 1) out.push({ type: 'scale', surfaceId, params: { x: this.drawingScale, y: this.drawingScale } });
    for (const c of this.drawing) out.push({ ...c, surfaceId, params: this.themed(c.type as string, c.params as Record<string, unknown>) });
    out.push({ type: 'restore', surfaceId, params: {} });
    return out;
  }

  /**
   * A command's params in the current theme: `$name` colours become the
   * theme's colour of that name, and `$display` / `$body` / `$mono` in a font
   * become the theme's faces. The drawing keeps the names, so a theme change
   * (or a saved preview shown later) follows the person's theme.
   */
  private themed(type: string, params: Record<string, unknown>): Record<string, unknown> {
    const theme = this.theme as unknown as Record<string, unknown>;
    const colour = (v: unknown): unknown => {
      if (typeof v !== 'string' || !v.startsWith('$')) return v;
      const named = theme[v.slice(1)];
      return typeof named === 'string' ? named : v;
    };
    const out: Record<string, unknown> = { ...params };
    for (const key of ['fill', 'stroke', 'color', 'shadowColor']) if (out[key] !== undefined) out[key] = colour(out[key]);
    if (Array.isArray(out.stops)) out.stops = (out.stops as Array<Record<string, unknown>>).map(st => (st && st.color !== undefined ? { ...st, color: colour(st.color) } : st));
    const stacks = fontStacks(this.theme);
    const face = (f: string) => f.replace(/\$display\b/g, stacks.display).replace(/\$body\b/g, stacks.body).replace(/\$mono\b/g, stacks.mono);
    if (typeof out.font === 'string') out.font = face(out.font);
    if (out.value !== undefined) out.value = type === 'font' && typeof out.value === 'string' ? face(out.value) : colour(out.value);
    return out;
  }

  /** The saved preview, shown until the object draws for itself. */
  private async loadPreview(): Promise<void> {
    this.previewAsked = true;
    try {
      const preview = await this.request<{ width: number; height: number; commands: unknown[] } | null>(
        request(this.id, this.storeId, 'getPreview', { objectId: this.target }), RENDER_TIMEOUT_MS);
      if (!preview || this.drawing.length > 0) return;
      this.drawing = cleanSlotCommands(preview.commands);
      const w = this.rect.width || preview.width;
      this.drawingScale = w / preview.width;
      this.contentHeight = clampHeight(preview.height * this.drawingScale);
      await this.requestRedraw();
    } catch { /* no preview: the object draws when it wakes */ }
  }

  /** Hold the object awake and get a fresh drawing at this width. */
  private async refresh(width: number): Promise<void> {
    this.fetching = true;
    this.dirty = false;
    try {
      const objectId = await this.ensureHeld();
      const result = await this.request<{ commands?: unknown; height?: number } | null>(
        request(this.id, objectId, 'render', { width, host: this.id }), RENDER_TIMEOUT_MS);
      const commands = cleanSlotCommands(result?.commands);
      const changed = JSON.stringify(commands) !== JSON.stringify(this.drawing) || this.drawingScale !== 1;
      this.drawing = commands;
      this.drawingScale = 1;
      this.drawnWidth = width;
      if (typeof result?.height === 'number' && Number.isFinite(result.height)) this.contentHeight = clampHeight(result.height);
      this.failed = false;
      if (changed) this.schedulePreviewSave();
    } catch {
      // Keep whatever is shown (the preview); the next redraw request tries again.
      this.failed = true;
    } finally {
      this.fetching = false;
      await this.requestRedraw();
    }
  }

  private async ensureHeld(): Promise<AbjectId> {
    if (this.liveId) return this.liveId;
    const objectId = await this.request<string>(request(this.id, this.storeId, 'hold', { objectId: this.target }), 30_000);
    contractRequire(typeof objectId === 'string' && objectId.length > 0, `'${this.target}' could not be started`);
    this.liveId = objectId as AbjectId;
    // Hear its redraw requests.
    await this.request(request(this.id, this.liveId, 'addDependent', {})).catch(() => undefined);
    return this.liveId;
  }

  private schedulePreviewSave(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => {
      this.previewTimer = undefined;
      if (this.drawing.length === 0 || this.drawnWidth <= 0) return;
      this.request(request(this.id, this.storeId, 'savePreview', {
        objectId: this.target, width: this.drawnWidth, height: this.contentHeight, commands: this.drawing,
      })).catch(() => undefined);
    }, PREVIEW_SAVE_DELAY_MS);
  }

  /** Scrolled away: let go of the object after a while, so it can sleep. */
  protected override onCulled(): void {
    super.onCulled();
    this.live = false;
    if (this.letGoTimer) clearTimeout(this.letGoTimer);
    this.letGoTimer = setTimeout(() => {
      this.letGoTimer = undefined;
      if (!this.live) void this.release();
    }, RELEASE_AFTER_MS);
  }

  private async release(): Promise<void> {
    const liveId = this.liveId;
    if (!liveId) return;
    this.liveId = undefined;
    this.dirty = true;
    this.send(request(this.id, liveId, 'removeDependent', {}));
    await this.request(request(this.id, this.storeId, 'release', { objectId: this.target })).catch(() => undefined);
  }

  protected override async onStop(): Promise<void> {
    if (this.letGoTimer) clearTimeout(this.letGoTimer);
    if (this.previewTimer) clearTimeout(this.previewTimer);
    if (this.liveId) {
      // Stopped: a fire-and-forget release (request would refuse now).
      try { this.send(request(this.id, this.storeId, 'release', { objectId: this.target })); } catch { /* bus gone */ }
      this.liveId = undefined;
    }
    await super.onStop();
  }

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean }> {
    const type = input.type as string;
    // The scroll container scrolls; the object never sees the wheel.
    if (type === 'wheel' || !this.liveId) return { consumed: false };
    if (type === 'mousemove') {
      const now = Date.now();
      if (now - this.lastMoveAt < MOVE_INTERVAL_MS) return { consumed: false };
      this.lastMoveAt = now;
    }
    const forwarded: Record<string, unknown> = { type };
    for (const key of ['x', 'y', 'button', 'key', 'code', 'modifiers', 'shiftKey', 'ctrlKey', 'altKey', 'metaKey']) {
      if (input[key] !== undefined) forwarded[key] = input[key];
    }
    if (this.drawingScale !== 1 && typeof forwarded.x === 'number' && typeof forwarded.y === 'number') {
      forwarded.x = (forwarded.x as number) / this.drawingScale;
      forwarded.y = (forwarded.y as number) / this.drawingScale;
    }
    try {
      const result = await this.request<{ consumed?: boolean } | null>(
        request(this.id, this.liveId, 'handleInput', forwarded), INPUT_TIMEOUT_MS);
      return { consumed: result?.consumed === true };
    } catch {
      return { consumed: false };
    }
  }

  protected getWidgetValue(): string {
    return this.target;
  }

  protected applyUpdate(updates: Record<string, unknown>): void {
    if (typeof updates.target === 'string' && updates.target && updates.target !== this.target) {
      void this.release();
      this.target = updates.target;
      this.drawing = [];
      this.drawingScale = 1;
      this.previewAsked = false;
      this.dirty = true;
    }
    if (typeof updates.height === 'number') this.contentHeight = clampHeight(updates.height);
  }
}

function clampHeight(h: number): number {
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(h)));
}
