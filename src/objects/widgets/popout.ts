/**
 * Pop-out surfaces: 2D layers a widget hangs off its window that may reach
 * past the window's edge, such as an open dropdown list, a tooltip, a menu
 * or a picker.
 *
 * A pop-out is an ordinary kind:'canvas' scene node contributed to the
 * window. params.rect places it in window px from the top-left (the
 * coordinates a widget renders at: its render ox/oy), clip:'none' lets it
 * leave the window, and interactive:true makes it an input target. Its
 * pixels arrive through the window's draw channel ({ nodeId }). Because the
 * widget contributed the node, the UIServer routes the node's input straight
 * back to the widget as nodeInput (x/y in window px) and removes the node if
 * the widget goes away. While a pop-out is open its widget listens to the
 * window as a dependent, so windowFocus { focused: false } can close it the
 * way an outside click does.
 *
 * All of this is plain message passing: any abject, a registerWidgetType
 * widget included, can open the same surface with its window's 'scene' and
 * 'draw'. PopoutSurface packages the sequencing for built-in widgets:
 * placement that flips toward the side of the screen with room, ordered
 * add / move / paint / remove, and latest-wins repaints.
 */

import { AbjectId } from '../../core/types.js';
import { require as contractRequire } from '../../core/contracts.js';
import { shapeOf } from '../../core/theme-data.js';
import { Rect, ThemeData, fontStacks, inkFrame } from './widget-types.js';

// ── Placement ────────────────────────────────────────────────────────────

export type PopoutSide = 'below' | 'above' | 'right' | 'left';
export type PopoutAlign = 'start' | 'center' | 'end';

/** Where the host window sits on screen (workspace px), for flipping. */
export interface PopoutScreen {
  window: { x: number; y: number };
  screen: { width: number; height: number };
}

export interface PopoutPlacement {
  /** What the pop-out hangs from, in window px from the top-left. */
  anchor: Rect;
  width: number;
  height: number;
  /** Preferred side of the anchor (default 'below'). */
  side?: PopoutSide;
  /** Take the opposite side when the preferred one lacks room and the other has more (default true). */
  flip?: boolean;
  /** Alignment along the anchor's edge (default 'start': left or top edges line up). */
  align?: PopoutAlign;
  /** Px between the anchor and the pop-out (default 0). */
  gap?: number;
  /** Px kept clear of the screen edge (default 4). */
  margin?: number;
}

export interface PlacedPopout {
  /** Layer rect in window px (may lie partly or wholly outside the window). */
  rect: Rect;
  side: PopoutSide;
  /** Px available on the chosen side (Infinity when the screen is unknown). */
  room: number;
}

const OPPOSITE: Record<PopoutSide, PopoutSide> = { below: 'above', above: 'below', right: 'left', left: 'right' };

const isVertical = (side: PopoutSide): boolean => side === 'below' || side === 'above';

/**
 * Place a pop-out against its anchor. The room on each side is measured on
 * the screen (the window's workspace position plus the anchor), not inside
 * the window, so a field near a window's bottom still opens downward when
 * the screen below is free. Along the anchor's edge the pop-out shifts to
 * stay on screen. Pure: no messages.
 */
export function placePopout(p: PopoutPlacement, geo?: PopoutScreen | null): PlacedPopout {
  contractRequire(p.width > 0 && p.height > 0, 'placePopout: width and height must be > 0');
  const a = p.anchor;
  const gap = p.gap ?? 0;
  const margin = p.margin ?? 4;
  const wx = geo?.window.x ?? 0;
  const wy = geo?.window.y ?? 0;
  const room = (side: PopoutSide): number => {
    if (!geo) return Number.POSITIVE_INFINITY;
    const { width: sw, height: sh } = geo.screen;
    switch (side) {
      case 'below': return sh - margin - (wy + a.y + a.height + gap);
      case 'above': return wy + a.y - gap - margin;
      case 'right': return sw - margin - (wx + a.x + a.width + gap);
      case 'left': return wx + a.x - gap - margin;
    }
  };

  let side: PopoutSide = p.side ?? 'below';
  if (p.flip !== false) {
    const need = isVertical(side) ? p.height : p.width;
    const other = OPPOSITE[side];
    if (room(side) < need && room(other) > room(side)) side = other;
  }

  const align = p.align ?? 'start';
  const along = (start: number, span: number, size: number): number =>
    align === 'center' ? start + (span - size) / 2 : align === 'end' ? start + span - size : start;

  let x: number;
  let y: number;
  if (isVertical(side)) {
    y = side === 'below' ? a.y + a.height + gap : a.y - gap - p.height;
    x = along(a.x, a.width, p.width);
    if (geo) x = keepOnScreen(x, wx, p.width, geo.screen.width, margin);
  } else {
    x = side === 'right' ? a.x + a.width + gap : a.x - gap - p.width;
    y = along(a.y, a.height, p.height);
    if (geo) y = keepOnScreen(y, wy, p.height, geo.screen.height, margin);
  }

  const placed: PlacedPopout = {
    rect: { x: Math.round(x), y: Math.round(y), width: Math.ceil(p.width), height: Math.ceil(p.height) },
    side,
    room: room(side),
  };
  return placed;
}

/** Shift a position along the anchor's edge so the pop-out stays on screen, when it fits at all. */
function keepOnScreen(pos: number, origin: number, size: number, screen: number, margin: number): number {
  const lo = margin - origin;
  const hi = screen - margin - size - origin;
  if (hi < lo) return pos;
  return Math.min(Math.max(pos, lo), hi);
}

// ── The surface ──────────────────────────────────────────────────────────

/**
 * How a pop-out reaches its window. Widgets use windowChannel(); a window
 * decorating itself talks to the UIServer with its own surface.
 */
export interface PopoutChannel {
  /** Apply scene ops to the window subtree the pop-out lives in. */
  scene(ops: Array<Record<string, unknown>>): Promise<unknown>;
  /** Paint the layer: commands in layer px, applied in order. */
  draw(nodeId: string, commands: unknown[]): Promise<unknown>;
  /** The window's screen position and the screen size (null when unknown). */
  geometry?(): Promise<PopoutScreen | null>;
  /** Start or stop listening to the host window (windowFocus) while open. */
  watchWindow?(watch: boolean): void;
}

export interface PopoutOptions {
  /** An input target (default true): its nodeInput comes back to the contributor. */
  interactive?: boolean;
  /** Hover cursor over an interactive pop-out (default 'default'). */
  cursor?: string;
}

const sameRect = (a?: Rect, b?: Rect): boolean =>
  !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * One pop-out layer. show() / paint() / hide() only record what is wanted;
 * a single queued sync applies the latest wish in order (add, then move or
 * resize, then paint), so bursts of hover repaints collapse into one draw
 * and a hide that lands before the add simply never adds.
 */
export class PopoutSurface {
  readonly nodeId: string;
  private readonly channel: PopoutChannel;
  private readonly interactive: boolean;
  private readonly cursor: string;
  private queue: Promise<void> = Promise.resolve();
  private syncQueued?: Promise<void>;
  private wantOpen = false;
  private added = false;
  private targetRect?: Rect;
  private shownRect?: Rect;
  private pendingPaint?: unknown[];
  private geo?: Promise<PopoutScreen | null>;

  constructor(channel: PopoutChannel, nodeId: string, options: PopoutOptions = {}) {
    contractRequire(typeof nodeId === 'string' && nodeId.length > 0, 'PopoutSurface: nodeId is required');
    this.channel = channel;
    this.nodeId = nodeId;
    this.interactive = options.interactive ?? true;
    this.cursor = options.cursor ?? 'default';
  }

  /** Whether the pop-out is wanted open (it may still be on its way). */
  get isOpen(): boolean {
    return this.wantOpen;
  }

  /** The layer's rect in window px as last placed (undefined while closed). */
  get rect(): Rect | undefined {
    return this.wantOpen ? (this.shownRect ?? this.targetRect) : undefined;
  }

  /** The host window's screen geometry, fetched once per open. */
  screen(): Promise<PopoutScreen | null> {
    if (!this.geo) {
      this.geo = this.channel.geometry
        ? this.channel.geometry().catch(() => null)
        : Promise.resolve(null);
    }
    return this.geo;
  }

  /** placePopout against this open's screen geometry. */
  async place(p: PopoutPlacement): Promise<PlacedPopout> {
    return placePopout(p, await this.screen());
  }

  /**
   * Open (or move / resize) the layer at rect and paint it with commands
   * (layer px; each paint starts from a clear). Resolves once applied;
   * rejects when the window will not take the node (callers fall back).
   */
  show(rect: Rect, commands: unknown[]): Promise<void> {
    contractRequire(rect.width > 0 && rect.height > 0, 'PopoutSurface.show: rect needs a positive size');
    this.wantOpen = true;
    this.targetRect = { ...rect };
    this.pendingPaint = commands;
    return this.scheduleSync();
  }

  /** Repaint in place (latest wins). Ignored while closed. */
  paint(commands: unknown[]): void {
    if (!this.wantOpen) return;
    this.pendingPaint = commands;
    this.scheduleSync().catch(() => { /* the owner's show() reports failures */ });
  }

  /** Close: the node is removed (or never added, when still queued). */
  hide(): Promise<void> {
    if (!this.wantOpen && !this.added) return Promise.resolve();
    this.wantOpen = false;
    this.pendingPaint = undefined;
    this.targetRect = undefined;
    this.geo = undefined;
    return this.scheduleSync().catch(() => { /* removal is best effort */ });
  }

  /**
   * Turn a nodeInput point (window px) into layer px. inside says whether
   * the point lies on the layer. Null without a shown layer or a point.
   */
  toLocal(input: { x?: unknown; y?: unknown }): { x: number; y: number; inside: boolean } | null {
    const r = this.shownRect;
    if (!r || typeof input.x !== 'number' || typeof input.y !== 'number') return null;
    const x = input.x - r.x;
    const y = input.y - r.y;
    return { x, y, inside: x >= 0 && y >= 0 && x < r.width && y < r.height };
  }

  /** Whether a window-px point lies on the shown layer. */
  contains(x: number, y: number): boolean {
    const r = this.shownRect;
    return !!r && this.wantOpen && x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
  }

  private scheduleSync(): Promise<void> {
    if (this.syncQueued) return this.syncQueued;
    const run = this.queue.then(() => {
      this.syncQueued = undefined;
      return this.syncNow();
    });
    this.syncQueued = run;
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async syncNow(): Promise<void> {
    if (!this.wantOpen) {
      if (!this.added) return;
      this.added = false;
      this.shownRect = undefined;
      this.channel.watchWindow?.(false);
      await this.channel.scene([{ op: 'remove', id: this.nodeId }]);
      return;
    }
    const rect = this.targetRect;
    if (!rect) return;
    if (!this.added) {
      await this.channel.scene([{
        op: 'add', id: this.nodeId, kind: 'canvas',
        params: {
          rect, clip: 'none', interactive: this.interactive,
          ...(this.interactive ? { cursor: this.cursor } : {}),
        },
      }]);
      this.added = true;
      this.shownRect = rect;
      this.channel.watchWindow?.(true);
    } else if (!sameRect(rect, this.shownRect)) {
      await this.channel.scene([{ op: 'update', id: this.nodeId, params: { rect } }]);
      this.shownRect = rect;
    }
    const commands = this.pendingPaint;
    this.pendingPaint = undefined;
    if (commands) {
      await this.channel.draw(this.nodeId, [{ type: 'clear', surfaceId: '', params: {} }, ...commands]);
    }
  }
}

// ── A widget's channel: its window's scene and draw ──────────────────────

/** What a widget lends its pop-outs: messages sent as the widget itself. */
export interface PopoutHost {
  /** A request from the host (its id becomes the node's contributor). */
  ask<T>(to: AbjectId, method: string, payload: unknown, timeoutMs?: number): Promise<T>;
  /** A fire-and-forget request from the host. */
  tell(to: AbjectId, method: string, payload: unknown): void;
  windowId: AbjectId;
  uiServerId: AbjectId;
}

/** Screen size cache shared by every pop-out in the process (one client round trip per few seconds). */
let screenCache: { at: number; value: Promise<{ width: number; height: number } | null> } | undefined;
const SCREEN_TTL_MS = 5000;

/** The display size through the UIServer, cached briefly. */
export function cachedScreenSize(
  fetch: () => Promise<{ width: number; height: number } | null>,
): Promise<{ width: number; height: number } | null> {
  const now = Date.now();
  if (!screenCache || now - screenCache.at > SCREEN_TTL_MS) {
    screenCache = {
      at: now,
      value: fetch()
        .then((s) => (s && s.width > 0 && s.height > 0 ? { width: s.width, height: s.height } : null))
        .catch(() => null),
    };
  }
  return screenCache.value;
}

/**
 * The channel for a widget's pop-out: scene and draw through its window
 * (the window stamps its surface; the UIServer records the widget as the
 * node's contributor), geometry from the window's rect and the display size,
 * and a dependent subscription to the window while open.
 */
export function windowChannel(host: PopoutHost): PopoutChannel {
  return {
    scene: (ops) => host.ask(host.windowId, 'scene', { ops }),
    draw: (nodeId, commands) => host.ask(host.windowId, 'draw', { nodeId, commands }),
    geometry: async () => {
      const [win, screen] = await Promise.all([
        host.ask<{ x: number; y: number }>(host.windowId, 'getRect', {}, 3000).catch(() => null),
        cachedScreenSize(() => host.ask<{ width: number; height: number }>(host.uiServerId, 'getDisplayInfo', {}, 3000)),
      ]);
      if (!win || !screen) return null;
      return { window: { x: win.x, y: win.y }, screen };
    },
    watchWindow: (watch) => host.tell(host.windowId, watch ? 'addDependent' : 'removeDependent', {}),
  };
}

// ── Tooltips ─────────────────────────────────────────────────────────────

/** One tooltip per window: every tooltip in a window shares this node id. */
export const TOOLTIP_NODE_ID = 'popout-tooltip';
/** Hover dwell before a tooltip shows. */
export const TOOLTIP_DELAY_MS = 450;
/** A shown tooltip leaves by itself after this long. */
export const TOOLTIP_AUTO_HIDE_MS = 5000;

const TIP_HEIGHT = 26;
const TIP_PAD_X = 10;
const TIP_MAX_WIDTH = 320;
const TIP_SHADOW = 3;

export interface TooltipSpec {
  text: string;
  /** The thing the tip describes, in window px. */
  anchor: Rect;
  /** Pointer in workspace px (the globalX/globalY widgets receive), for wide anchors. */
  pointer?: { x: number; y: number };
  theme: ThemeData;
  measure(text: string, font: string): Promise<number>;
  /** Side of the anchor (default: right of a compact anchor, below the pointer on a wide one). */
  side?: PopoutSide;
}

/**
 * Show a tooltip on a (non-interactive) pop-out: beside a compact anchor
 * (icon buttons, dock rows), below the pointer on a wide one, flipping to
 * the side of the screen with room. Resolves once the layer is applied.
 */
export async function showTooltip(surface: PopoutSurface, spec: TooltipSpec): Promise<void> {
  const font = `12px ${fontStacks(spec.theme).body}`;
  let textW = spec.text.length * 7;
  try {
    const measured = await spec.measure(spec.text, font);
    if (measured > 0) textW = measured;
  } catch { /* keep the estimate */ }
  const w = Math.min(TIP_MAX_WIDTH, Math.ceil(textW) + 2 * TIP_PAD_X);
  const h = TIP_HEIGHT;
  const a = spec.anchor;
  const geo = await surface.screen();
  const compact = a.width <= a.height * 2.5;
  const pointerX = spec.pointer && geo ? spec.pointer.x - geo.window.x : undefined;
  const size = { width: w + TIP_SHADOW, height: h + TIP_SHADOW };
  const placed = await surface.place(spec.side
    ? { anchor: a, ...size, side: spec.side, gap: 6, align: 'center' }
    : compact || pointerX === undefined
      ? { anchor: a, ...size, side: 'right', gap: 8, align: 'center' }
      : { anchor: { x: Math.round(pointerX), y: a.y, width: 1, height: a.height }, ...size, side: 'below', gap: 6 });
  await surface.show(placed.rect, tooltipCommands(spec.text, w, h, spec.theme, font));
}

/** A print tooltip in layer px: a paper slip in an ink rule with a hard shadow. */
export function tooltipCommands(text: string, w: number, h: number, theme: ThemeData, font: string): unknown[] {
  const shape = shapeOf(theme);
  const sid = '';
  return [
    { type: 'rect', surfaceId: sid, params: { x: TIP_SHADOW, y: TIP_SHADOW, width: w, height: h, fill: shape.blockShadowColor } },
    { type: 'rect', surfaceId: sid, params: { x: 0, y: 0, width: w, height: h, fill: theme.windowBg } },
    ...inkFrame(sid, { x: 0, y: 0, width: w, height: h }, theme.windowBorder, shape.ruleWidth),
    { type: 'save', surfaceId: sid, params: {} },
    { type: 'clip', surfaceId: sid, params: { x: TIP_PAD_X / 2, y: 0, width: w - TIP_PAD_X, height: h } },
    { type: 'text', surfaceId: sid, params: { x: w / 2, y: h / 2, text, font, fill: theme.textPrimary, align: 'center', baseline: 'middle' } },
    { type: 'restore', surfaceId: sid, params: {} },
  ];
}
