/**
 * ScrollableVBoxLayout — a VBoxLayout that clips overflow and supports scrolling.
 *
 * When content exceeds the visible area, a scrollbar is rendered and wheel
 * events adjust the scroll offset. Mouse events are offset by scrollTop
 * before being delegated to the parent VBoxLayout.
 */

import { AbjectId, AbjectMessage } from '../../core/types.js';
import { request } from '../../core/message.js';
import { Rect } from './widget-types.js';
import { VBoxLayout } from './vbox-layout.js';
import { LayoutConfig, ChildRect, isSpacer } from './layout-abject.js';

const SCROLLBAR_WIDTH = 8;
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

  constructor(config: ScrollableVBoxConfig) {
    super(config);

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
      const vPolicy = child.sizePolicy?.vertical ?? 'preferred';
      if (vPolicy === 'fixed' || vPolicy === 'preferred') {
        total += child.preferredSize?.height ?? 0;
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
    if (changed) await this.requestRedraw();
    return true;
  }

  // ── Rendering ─────────────────────────────────────────────────────

  protected override async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    await this.flushPendingRelayout();
    const cr = this.contentRect;
    const childRects = this.calculateChildRects(cr);
    const commands: unknown[] = [];

    // Clip to content area
    commands.push({ type: 'save', surfaceId, params: {} });
    commands.push({
      type: 'clip',
      surfaceId,
      params: {
        x: ox + cr.x,
        y: oy + cr.y,
        width: cr.width,
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
        // Skip fully off-screen children
        if (childBottom < clipTop || childOy > clipBottom) return null;
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

    // Draw scrollbar if content overflows
    const sb = this.scrollbarMetrics();
    if (sb.visible) {
      const trackX = ox + sb.trackX;
      const trackY = oy + sb.trackY;
      const trackH = sb.trackH;

      // Track
      commands.push({
        type: 'rect',
        surfaceId,
        params: {
          x: trackX,
          y: trackY,
          width: SCROLLBAR_WIDTH,
          height: trackH,
          fill: this.theme.scrollbarTrack,
        },
      });

      // Thumb
      const thumbHeight = sb.thumbHeight;
      const thumbY = oy + sb.thumbY;

      // Scrollbar thumb with gradient
      commands.push({ type: 'save', surfaceId, params: {} });
      commands.push({
        type: 'linearGradient',
        surfaceId,
        params: { x0: trackX, y0: 0, x1: trackX + SCROLLBAR_WIDTH, y1: 0, stops: [
          { offset: 0, color: this.theme.scrollbarThumb },
          { offset: 1, color: this.theme.scrollbarThumbHover },
        ] },
      });
      commands.push({
        type: 'rect',
        surfaceId,
        params: {
          x: trackX + 1,
          y: thumbY,
          width: SCROLLBAR_WIDTH - 2,
          height: thumbHeight,
          radius: 3,
          fill: this.theme.scrollbarThumb,
        },
      });
      commands.push({ type: 'restore', surfaceId, params: {} });
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
    const wasNearBottom = this.maxScroll <= 0 || (this.maxScroll - this.scrollTop) <= SCROLL_STEP * 2;
    await super.flushPendingRelayout();
    if (this.autoScrollEnabled && this.autoScroll && wasNearBottom) {
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
