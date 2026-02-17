/**
 * ScrollableVBoxLayout — a VBoxLayout that clips overflow and supports scrolling.
 *
 * When content exceeds the visible area, a scrollbar is rendered and wheel
 * events adjust the scroll offset. Mouse events are offset by scrollTop
 * before being delegated to the parent VBoxLayout.
 */

import { AbjectId } from '../../core/types.js';
import { request } from '../../core/message.js';
import { Rect, WIDGET_INTERFACE } from './widget-types.js';
import { VBoxLayout } from './vbox-layout.js';
import { LayoutConfig, ChildRect, isSpacer } from './layout-abject.js';

const SCROLLBAR_WIDTH = 8;
const SCROLL_STEP = 30;

export class ScrollableVBoxLayout extends VBoxLayout {
  private scrollTop = 0;

  constructor(config: LayoutConfig) {
    super(config);

    // Override manifest name
    (this as unknown as { manifest: { name: string } }).manifest.name = 'ScrollableVBoxLayout';
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

    for (const child of childRects) {
      const childOy = oy + child.rect.y - this.scrollTop;
      const childBottom = childOy + child.rect.height;
      const clipTop = oy + cr.y;
      const clipBottom = clipTop + cr.height;

      // Skip fully off-screen children
      if (childBottom < clipTop || childOy > clipBottom) continue;

      try {
        const childCmds = await this.request<unknown[]>(
          request(this.id, child.widgetId, WIDGET_INTERFACE, 'render', {
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
          fill: 'rgba(255, 255, 255, 0.05)',
        },
      });

      // Thumb
      const thumbRatio = cr.height / totalHeight;
      const thumbHeight = Math.max(20, trackH * thumbRatio);
      const scrollRatio = this.maxScroll > 0 ? this.scrollTop / this.maxScroll : 0;
      const thumbY = trackY + scrollRatio * (trackH - thumbHeight);

      commands.push({
        type: 'rect',
        surfaceId,
        params: {
          x: trackX + 1,
          y: thumbY,
          width: SCROLLBAR_WIDTH - 2,
          height: thumbHeight,
          radius: 3,
          fill: 'rgba(255, 255, 255, 0.2)',
        },
      });
    }

    return commands;
  }

  // ── Input handling ────────────────────────────────────────────────

  protected override async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean; focusWidgetId?: AbjectId }> {
    const inputType = input.type as string;

    // Handle wheel events for scrolling
    if (inputType === 'wheel') {
      const delta = input.deltaY as number;
      const oldScroll = this.scrollTop;
      this.scrollTop += delta > 0 ? SCROLL_STEP : -SCROLL_STEP;
      this.clampScrollTop();
      if (this.scrollTop !== oldScroll) {
        await this.requestRedraw();
      }
      return { consumed: true };
    }

    // For mouse events, offset Y by scrollTop before delegating to parent
    if (inputType === 'mousedown' || inputType === 'mousemove') {
      const adjusted = { ...input, y: (input.y as number) + this.scrollTop };
      return super.processInput(adjusted);
    }

    return super.processInput(input);
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
