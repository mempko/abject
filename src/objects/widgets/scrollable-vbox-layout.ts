/**
 * ScrollableVBoxLayout — a VBoxLayout that clips overflow and supports scrolling.
 *
 * When content exceeds the visible area, wheel events adjust the scroll
 * offset and a scrollbar shows: a thin thumb at the right edge while the
 * pointer is over the layout or it has just scrolled, widening to a grabbable
 * bar with its track under the pointer. At rest it is not drawn, so it never
 * sits on top of the rows. Mouse events are offset by scrollTop before being
 * delegated to the parent VBoxLayout.
 */

import { AbjectId, AbjectMessage } from '../../core/types.js';
import { request, event } from '../../core/message.js';
import { Rect, DEFAULT_CHILD_HEIGHT } from './widget-types.js';
import { VBoxLayout } from './vbox-layout.js';
import { LayoutConfig, ChildRect, isSpacer } from './layout-abject.js';

/** The scrollbar's hit strip at the right edge, and its width while grabbed or pointed at. */
const SCROLLBAR_WIDTH = 8;
/** The thumb's width while it only shows where the view is. */
const THIN_SCROLLBAR = 3;
/** How long the thumb stays after a scroll with the pointer elsewhere. */
const SCROLLBAR_LINGER_MS = 900;
const SCROLL_STEP = 30;

export interface ScrollableVBoxConfig extends LayoutConfig {
  autoScroll?: boolean;
}

export class ScrollableVBoxLayout extends VBoxLayout {
  private scrollTop = 0;
  /** True while the user is dragging the scrollbar thumb. */
  private scrollbarDragging = false;
  /** Offset from the thumb top to the grab point, kept constant during a drag. */
  private scrollbarDragOffset = 0;
  /** Children drawn in the last pass; one that scrolls out hears viewportCulled once. */
  private drawnChildren = new Set<AbjectId>();
  /** The pointer is over this layout / over the scrollbar's strip. */
  private pointerInside = false;
  private pointerOnBar = false;
  /** The thumb shows after a scroll until this timer fires. */
  private lingerTimer?: ReturnType<typeof setTimeout>;

  constructor(config: ScrollableVBoxConfig) {
    super(config);
    // Content taller than the viewport is the normal state here, not a defect.
    this.reportsOverflow = false;

    // Override manifest name
    (this as unknown as { manifest: { name: string } }).manifest.name = 'ScrollableVBoxLayout';

    if (config.autoScroll) {
      this.autoScrollEnabled = true;
      this.autoScroll = true;
    }

    // Keyboard scrolling (PageUp/PageDown/Home/End). The owner forwards keys
    // here when no focused widget consumed them (e.g. Chat bubbling PageDown
    // from its text input). Returns whether the key was a scroll key.
    this.on('scrollKey', async (msg: AbjectMessage) => {
      const { key } = msg.payload as { key?: string };
      return await this.handleScrollKey(key);
    });
  }

  /**
   * Total natural content height: sum of preferred heights for
   * fixed/preferred children plus spacing, ignoring spacers and
   * expanding items.
   */
  private getTotalContentHeight(): number {
    let total = 0;
    let count = 0;
    for (const child of this.layoutChildren) {
      if (isSpacer(child)) continue;
      // A hidden child takes no room (calculateChildRects skips it too).
      if (this.hiddenChildren.has(child.widgetId)) continue;
      const vPolicy = child.sizePolicy?.vertical ?? 'preferred';
      if (vPolicy === 'fixed' || vPolicy === 'preferred') {
        total += child.preferredSize?.height ?? DEFAULT_CHILD_HEIGHT;
        count++;
      }
    }
    // Add spacing between counted children
    if (count > 1) {
      total += (count - 1) * this.spacing;
    }
    return total;
  }

  private get contentRect(): Rect {
    return this.getContentRect();
  }

  private get maxScroll(): number {
    const cr = this.contentRect;
    const totalHeight = this.getTotalContentHeight();
    return Math.max(0, totalHeight - cr.height);
  }

  private clampScrollTop(): void {
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, this.maxScroll));
  }

  /**
   * Geometry of the scrollbar track and thumb in widget-local coordinates
   * (the same space as both buildDrawCommands' ox/oy=0 children and the
   * translated input coordinates). `visible` is false when content fits.
   */
  private scrollbarMetrics(): {
    trackX: number; trackY: number; trackH: number;
    thumbY: number; thumbHeight: number; visible: boolean;
  } {
    const cr = this.contentRect;
    const totalHeight = this.getTotalContentHeight();
    const trackX = cr.x + cr.width - SCROLLBAR_WIDTH;
    const trackY = cr.y;
    const trackH = cr.height;
    const thumbRatio = totalHeight > 0 ? cr.height / totalHeight : 1;
    const thumbHeight = Math.max(20, trackH * thumbRatio);
    const scrollRatio = this.maxScroll > 0 ? this.scrollTop / this.maxScroll : 0;
    const thumbY = trackY + scrollRatio * (trackH - thumbHeight);
    return { trackX, trackY, trackH, thumbY, thumbHeight, visible: totalHeight > cr.height };
  }

  /** Set scrollTop so the thumb's top lands at `thumbY` (clamped). */
  private setScrollFromThumbY(thumbY: number, sb: { trackY: number; trackH: number; thumbHeight: number }): void {
    const range = sb.trackH - sb.thumbHeight;
    const ratio = range > 0 ? (thumbY - sb.trackY) / range : 0;
    this.scrollTop = Math.max(0, Math.min(1, ratio)) * this.maxScroll;
    this.clampScrollTop();
    this.autoScroll = this.scrollTop >= this.maxScroll;
  }

  /** Scroll by ~one viewport page. Returns whether the offset changed. */
  private scrollByPage(direction: 'up' | 'down'): boolean {
    const page = Math.max(SCROLL_STEP, this.contentRect.height * 0.9);
    const old = this.scrollTop;
    this.scrollTop += direction === 'down' ? page : -page;
    this.clampScrollTop();
    if (this.scrollTop === old) return false;
    this.autoScroll = this.scrollTop >= this.maxScroll;
    return true;
  }

  /** Apply a keyboard scroll key. Returns true if it was a scroll key. */
  private async handleScrollKey(key?: string): Promise<boolean> {
    let changed = false;
    if (key === 'PageDown') {
      changed = this.scrollByPage('down');
    } else if (key === 'PageUp') {
      changed = this.scrollByPage('up');
    } else if (key === 'Home') {
      changed = this.scrollTop !== 0;
      this.scrollTop = 0;
      this.autoScroll = this.maxScroll <= 0;
    } else if (key === 'End') {
      changed = this.scrollTop !== this.maxScroll;
      this.scrollTop = this.maxScroll;
      this.autoScroll = true;
    } else {
      return false;
    }
    if (changed) {
      this.lingerScrollbar();
      await this.requestRedraw();
    }
    return true;
  }

  /**
   * Follow the pointer for the scrollbar: x in local px while it moves over
   * the layout, undefined when it leaves. Redraws only when what shows changes.
   */
  private async trackPointer(x: number | undefined): Promise<void> {
    const inside = x !== undefined;
    const sb = this.scrollbarMetrics();
    const onBar = inside && sb.visible && x >= sb.trackX;
    if (inside === this.pointerInside && onBar === this.pointerOnBar) return;
    this.pointerInside = inside;
    this.pointerOnBar = onBar;
    if (sb.visible) await this.requestRedraw();
  }

  /** Keep the thumb showing for a moment after a scroll, then let it go. */
  private lingerScrollbar(): void {
    this.cancelTimer(this.lingerTimer);
    this.lingerTimer = this.setTimer(async () => {
      this.lingerTimer = undefined;
      if (!this.pointerInside) await this.requestRedraw();
    }, SCROLLBAR_LINGER_MS);
  }

  // ── Rendering ─────────────────────────────────────────────────────

  protected override async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    await this.flushPendingRelayout();
    const cr = this.contentRect;
    const childRects = this.calculateChildRects(cr);
    const commands: unknown[] = [];

    // Card/panel background (if styled) paints OUTSIDE the clip below, so the
    // rounded border frames the whole card including the margin gutter while
    // scrolling children stay clipped to the content viewport.
    commands.push(...this.buildBackgroundCommands(surfaceId, ox, oy));

    // Clip to content area. Only the VERTICAL extent must be tight — that is
    // what hides scrolled-away rows. Horizontally nothing scrolls, so clipping
    // children to exactly their own width would shave the left/right edge of a
    // full-width row's border and rounded corners (the active-item highlight in
    // the sidebar). Bleed the horizontal clip a few px into the surrounding
    // margin gutter so those borders render in full; children are still laid
    // out within the content rect, so this never lets content spill visibly.
    const xBleed = 4;
    commands.push({ type: 'save', surfaceId, params: {} });
    commands.push({
      type: 'clip',
      surfaceId,
      params: {
        x: ox + cr.x - xBleed,
        y: oy + cr.y,
        width: cr.width + xBleed * 2,
        height: cr.height,
      },
    });

    // Separate expanded children (e.g. select dropdowns) to render after clip restore
    const normalChildren: typeof childRects = [];
    const expandedChildList: typeof childRects = [];
    for (const child of childRects) {
      if (this.expandedChildren.has(child.widgetId)) {
        expandedChildList.push(child);
      } else {
        normalChildren.push(child);
      }
    }

    const clipTop = oy + cr.y;
    const clipBottom = clipTop + cr.height;

    const viewportClip = { top: clipTop, bottom: clipBottom };

    // Fan render requests out in parallel — they all go through the bus, so
    // queuing them at once removes microtask hops between siblings.
    const normalResults = await Promise.all(
      normalChildren.map(async (child) => {
        const childOy = oy + child.rect.y - this.scrollTop;
        const childBottom = childOy + child.rect.height;
        // Skip fully off-screen children — but ALWAYS render a zero-height
        // child. Self-sizing widgets (e.g. the goal-progress tree) start at
        // height 0 and only learn their real height by drawing once and
        // reporting it back via `contentHeight`. If such a child sits at the
        // scroll bottom (childOy ≈ clipBottom, childBottom == childOy), the
        // off-screen test would cull it, so it never draws, never measures, and
        // stays collapsed forever. Rendering a 0-height child costs ~nothing.
        if (child.rect.height > 0 && (childBottom < clipTop || childOy > clipBottom)) return null;
        try {
          return await this.request<unknown[]>(
            request(this.id, child.widgetId, 'render', {
              surfaceId,
              ox: ox + child.rect.x,
              oy: childOy,
              viewportClip,
            })
          );
        } catch {
          return null;
        }
      })
    );
    for (const childCmds of normalResults) {
      if (Array.isArray(childCmds)) commands.push(...childCmds);
    }

    commands.push({ type: 'restore', surfaceId, params: {} });

    // Render expanded children outside the clip region so dropdowns aren't clipped
    const expandedResults = await Promise.all(
      expandedChildList.map(async (child) => {
        const childOy = oy + child.rect.y - this.scrollTop;
        try {
          return await this.request<unknown[]>(
            request(this.id, child.widgetId, 'render', {
              surfaceId,
              ox: ox + child.rect.x,
              oy: childOy,
            })
          );
        } catch {
          return null;
        }
      })
    );
    for (const childCmds of expandedResults) {
      if (Array.isArray(childCmds)) commands.push(...childCmds);
    }

    // Children that drew last pass and were culled this pass get one notice,
    // so anything they keep in the window's scene (a busy light) leaves too.
    const drawn = new Set<AbjectId>(expandedChildList.map((c) => c.widgetId));
    normalChildren.forEach((c, i) => { if (normalResults[i] !== null) drawn.add(c.widgetId); });
    for (const id of this.drawnChildren) {
      if (drawn.has(id) || !childRects.some((c) => c.widgetId === id)) continue;
      try { this.send(event(this.id, id, 'viewportCulled', {})); } catch { /* child gone */ }
    }
    this.drawnChildren = drawn;

    // The scrollbar, while the pointer is over the layout or it just scrolled.
    const sb = this.scrollbarMetrics();
    if (sb.visible && (this.pointerInside || this.scrollbarDragging || this.lingerTimer)) {
      const trackX = ox + sb.trackX;
      const trackY = oy + sb.trackY;
      const wide = this.scrollbarDragging || this.pointerOnBar;
      if (wide) {
        commands.push({
          type: 'rect', surfaceId,
          params: { x: trackX, y: trackY, width: SCROLLBAR_WIDTH, height: sb.trackH, fill: this.theme.scrollbarTrack },
        });
      }
      // Thumb: a flat slab, thin at the edge until grabbed or pointed at.
      const thumbW = wide ? SCROLLBAR_WIDTH - 2 : THIN_SCROLLBAR;
      commands.push({
        type: 'rect',
        surfaceId,
        params: {
          x: trackX + SCROLLBAR_WIDTH - 1 - thumbW, y: oy + sb.thumbY, width: thumbW, height: sb.thumbHeight,
          fill: this.scrollbarDragging ? this.theme.scrollbarThumbHover : this.theme.scrollbarThumb,
        },
      });
    }

    return commands;
  }

  // ── Input handling ────────────────────────────────────────────────

  protected override async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean; focusWidgetId?: AbjectId }> {
    const inputType = input.type as string;

    // Keyboard scrolling when this layout (or its content) holds focus.
    if (inputType === 'keydown') {
      return { consumed: await this.handleScrollKey(input.key as string) };
    }

    if (inputType === 'mousemove' || inputType === 'mouseleave') {
      await this.trackPointer(inputType === 'mousemove' ? input.x as number : undefined);
    }

    // ── Scrollbar dragging ────────────────────────────────────────────
    // Hit-test the scrollbar before any content routing so the thumb takes
    // priority over bubbles painted beneath it. The scrollbar is fixed in the
    // viewport, so it uses raw (un-scrolled) input coordinates.
    if (inputType === 'mousedown') {
      const mx = input.x as number;
      const my = input.y as number;
      const sb = this.scrollbarMetrics();
      if (sb.visible && mx >= sb.trackX && mx < sb.trackX + SCROLLBAR_WIDTH &&
          my >= sb.trackY && my < sb.trackY + sb.trackH) {
        if (my >= sb.thumbY && my < sb.thumbY + sb.thumbHeight) {
          // Grabbed the thumb — remember where along it we grabbed.
          this.scrollbarDragOffset = my - sb.thumbY;
        } else {
          // Clicked the track — jump so the thumb centers on the cursor, then
          // drag from there.
          this.setScrollFromThumbY(my - sb.thumbHeight / 2, sb);
          this.scrollbarDragOffset = my - this.scrollbarMetrics().thumbY;
        }
        this.scrollbarDragging = true;
        await this.requestRedraw();
        return { consumed: true };
      }
    }

    if (inputType === 'mousemove' && this.scrollbarDragging) {
      const sb = this.scrollbarMetrics();
      this.setScrollFromThumbY((input.y as number) - this.scrollbarDragOffset, sb);
      await this.requestRedraw();
      return { consumed: true };
    }

    if (inputType === 'mouseup' && this.scrollbarDragging) {
      this.scrollbarDragging = false;
      await this.requestRedraw();
      return { consumed: true };
    }

    // Handle wheel events for scrolling — delegate to children first
    if (inputType === 'wheel') {
      // Try forwarding to a nested scrollable child (with Y adjusted for scroll offset)
      const adjusted = { ...input, y: (input.y as number) + this.scrollTop };
      const childResult = await super.processInput(adjusted);
      if (childResult.consumed) return childResult;

      // No child consumed it — scroll ourselves
      const delta = input.deltaY as number;
      const oldScroll = this.scrollTop;
      this.scrollTop += delta > 0 ? SCROLL_STEP : -SCROLL_STEP;
      this.clampScrollTop();
      if (this.scrollTop !== oldScroll) {
        // Disable auto-scroll when user scrolls up, re-enable at bottom
        this.autoScroll = this.scrollTop >= this.maxScroll;
        this.lingerScrollbar();
        await this.requestRedraw();
        return { consumed: true };
      }
      // Already at scroll limit — let parent handle it
      return { consumed: false };
    }

    // For mouse events, offset Y by scrollTop before delegating to parent
    if (inputType === 'mousedown' || inputType === 'mousemove' || inputType === 'mouseup') {
      const adjusted = { ...input, y: (input.y as number) + this.scrollTop };
      return super.processInput(adjusted);
    }

    return super.processInput(input);
  }

  // ── Auto-scroll ─────────────────────────────────────────────────

  /** Whether auto-scroll to bottom is enabled for this widget. Off by default; opt in for chat/log widgets. */
  private autoScrollEnabled = false;
  /** Runtime state: tracks whether the user has scrolled away from the bottom. */
  private autoScroll = false;

  /**
   * After relayout completes, auto-scroll to bottom if we were near the bottom.
   * Called from flushPendingRelayout via scheduleRelayout.
   */
  protected override async flushPendingRelayout(): Promise<void> {
    await super.flushPendingRelayout();
    // `autoScroll` already encodes "the user is pinned to the bottom" — it is
    // cleared the moment they scroll up (wheel/drag/keys) and set again when
    // they return to the bottom. Re-deriving a "was near bottom" flag here would
    // read the post-relayout maxScroll, which has already jumped when a single
    // child grows a lot in one pass (e.g. the goal widget expanding), so the
    // follow would be skipped. Trust the flag, matching the rect branch above.
    if (this.autoScrollEnabled && this.autoScroll) {
      this.scrollTop = this.maxScroll;
    }
  }

  // ── Resize handling ───────────────────────────────────────────────

  protected override async applyUpdate(updates: Record<string, unknown>): Promise<void> {
    await super.applyUpdate(updates);
    // When the layout gains/changes geometry, re-pin to the bottom if
    // auto-scroll is active (e.g. a chat opening with rehydrated history, where
    // the content is added before the window's real rect arrives). Otherwise
    // just keep the existing offset within bounds.
    if (updates.rect !== undefined) {
      if (this.autoScrollEnabled && this.autoScroll) {
        this.scrollTop = this.maxScroll;
      } else {
        this.clampScrollTop();
      }
    }
  }
}
