/**
 * ScrollableVBoxLayout — a VBoxLayout that clips overflow and supports scrolling.
 *
 * When content exceeds the visible area, a scrollbar is rendered and wheel
 * events adjust the scroll offset. Mouse events are offset by scrollTop
 * before being delegated to the parent VBoxLayout.
 */

import { AbjectId } from '../../core/types.js';
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

  constructor(config: ScrollableVBoxConfig) {
    super(config);

    // Override manifest name
    (this as unknown as { manifest: { name: string } }).manifest.name = 'ScrollableVBoxLayout';

    if (config.autoScroll) {
      this.autoScrollEnabled = true;
      this.autoScroll = true;
    }
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

    for (const child of normalChildren) {
      const childOy = oy + child.rect.y - this.scrollTop;
      const childBottom = childOy + child.rect.height;

      // Skip fully off-screen children
      if (childBottom < clipTop || childOy > clipBottom) continue;

      try {
        const childCmds = await this.request<unknown[]>(
          request(this.id, child.widgetId, 'render', {
            surfaceId,
            ox: ox + child.rect.x,
            oy: childOy,
          })
        );
        if (Array.isArray(childCmds)) {
          commands.push(...childCmds);
        }
      } catch {
        // Widget may have been destroyed
      }
    }

    commands.push({ type: 'restore', surfaceId, params: {} });

    // Render expanded children outside the clip region so dropdowns aren't clipped
    for (const child of expandedChildList) {
      const childOy = oy + child.rect.y - this.scrollTop;

      try {
        const childCmds = await this.request<unknown[]>(
          request(this.id, child.widgetId, 'render', {
            surfaceId,
            ox: ox + child.rect.x,
            oy: childOy,
          })
        );
        if (Array.isArray(childCmds)) {
          commands.push(...childCmds);
        }
      } catch {
        // Widget may have been destroyed
      }
    }

    // Draw scrollbar if content overflows
    const totalHeight = this.getTotalContentHeight();
    if (totalHeight > cr.height) {
      const trackX = ox + cr.x + cr.width - SCROLLBAR_WIDTH;
      const trackY = oy + cr.y;
      const trackH = cr.height;

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
      const thumbRatio = cr.height / totalHeight;
      const thumbHeight = Math.max(20, trackH * thumbRatio);
      const scrollRatio = this.maxScroll > 0 ? this.scrollTop / this.maxScroll : 0;
      const thumbY = trackY + scrollRatio * (trackH - thumbHeight);

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
    // Clamp scroll position when the layout resizes
    if (updates.rect !== undefined) {
      this.clampScrollTop();
    }
  }
}
