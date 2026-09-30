/**
 * SplitPaneWidget — a container holding two children side-by-side with a
 * draggable divider between them.
 *
 * Orientation: 'horizontal' = left|right, 'vertical' = top|bottom.
 * The divider can be dragged to resize. Emits 'dividerMoved' when ratio changes.
 * Children set via setLeftChild/setRightChild (or setTopChild/setBottomChild) handlers.
 */

import { AbjectId, AbjectMessage } from '../../core/types.js';
import { request, event } from '../../core/message.js';
import { WidgetAbject, WidgetConfig } from './widget-abject.js';
import { Rect } from './widget-types.js';
import { shapeOf } from '../../core/theme-data.js';

export interface SplitPaneConfig extends WidgetConfig {
  orientation?: 'horizontal' | 'vertical';
  dividerPosition?: number; // 0.0–1.0 ratio, default 0.5
  minSize?: number;         // minimum size per side in px
}

const DIVIDER_SIZE = 4;

export class SplitPaneWidget extends WidgetAbject {
  private orientation: 'horizontal' | 'vertical';
  private dividerPosition: number;
  private minSize: number;
  private leftChildId?: AbjectId;
  private rightChildId?: AbjectId;
  private dragging = false;
  private dividerHovered = false;

  constructor(config: SplitPaneConfig) {
    super(config);
    this.orientation = config.orientation ?? 'horizontal';
    this.dividerPosition = config.dividerPosition ?? 0.5;
    this.minSize = config.minSize ?? 50;

    this.setupSplitPaneHandlers();
  }

  private setupSplitPaneHandlers(): void {
    this.on('setLeftChild', async (msg: AbjectMessage) => {
      const { widgetId } = msg.payload as { widgetId: AbjectId };
      this.holdChild(this.leftChildId, widgetId, this.rightChildId);
      this.leftChildId = widgetId;
      await this.updateChildRects();
      await this.requestRedraw();
      return true;
    });

    this.on('setRightChild', async (msg: AbjectMessage) => {
      const { widgetId } = msg.payload as { widgetId: AbjectId };
      this.holdChild(this.rightChildId, widgetId, this.leftChildId);
      this.rightChildId = widgetId;
      await this.updateChildRects();
      await this.requestRedraw();
      return true;
    });

    // Aliases for vertical orientation
    this.on('setTopChild', async (msg: AbjectMessage) => {
      const { widgetId } = msg.payload as { widgetId: AbjectId };
      this.holdChild(this.leftChildId, widgetId, this.rightChildId);
      this.leftChildId = widgetId;
      await this.updateChildRects();
      await this.requestRedraw();
      return true;
    });

    this.on('setBottomChild', async (msg: AbjectMessage) => {
      const { widgetId } = msg.payload as { widgetId: AbjectId };
      this.holdChild(this.rightChildId, widgetId, this.leftChildId);
      this.rightChildId = widgetId;
      await this.updateChildRects();
      await this.requestRedraw();
      return true;
    });

    // Forward childDirty up
    this.on('childDirty', async () => {
      await this.requestRedraw();
    });
  }

  /**
   * Hold a new pane child and let go of the one it replaces (detach only),
   * the way a layout tells its children (LayoutAbject.tellChildHold), so a
   * pane that also sat in a cleared layout is not released while shown here.
   */
  private holdChild(previous: AbjectId | undefined, next: AbjectId, other: AbjectId | undefined): void {
    if (previous === next) return;
    try {
      if (previous && previous !== other) this.send(event(this.id, previous, 'layoutDetached', {}));
      this.send(event(this.id, next, 'layoutAttached', {}));
    } catch { /* child already gone */ }
  }

  /**
   * The panes go with the split pane, as a layout's children go with the
   * layout: without this every window built on split panes left its pane
   * subtrees alive after it closed. Events, sent while we stop.
   */
  protected override async onStop(): Promise<void> {
    for (const childId of new Set([this.leftChildId, this.rightChildId])) {
      if (!childId) continue;
      try { this.send(event(this.id, childId, 'destroy', {})); } catch { /* already gone */ }
    }
    this.leftChildId = undefined;
    this.rightChildId = undefined;
    await super.onStop();
  }

  // ── Geometry ───────────────────────────────────────────────────────

  private getChildRects(): { left: Rect; right: Rect; divider: Rect } {
    const w = this.rect.width;
    const h = this.rect.height;

    if (this.orientation === 'horizontal') {
      const totalWidth = w - DIVIDER_SIZE;
      const leftWidth = Math.max(this.minSize, Math.min(totalWidth - this.minSize, totalWidth * this.dividerPosition));
      const rightWidth = totalWidth - leftWidth;

      return {
        left: { x: 0, y: 0, width: leftWidth, height: h },
        divider: { x: leftWidth, y: 0, width: DIVIDER_SIZE, height: h },
        right: { x: leftWidth + DIVIDER_SIZE, y: 0, width: rightWidth, height: h },
      };
    } else {
      const totalHeight = h - DIVIDER_SIZE;
      const topHeight = Math.max(this.minSize, Math.min(totalHeight - this.minSize, totalHeight * this.dividerPosition));
      const bottomHeight = totalHeight - topHeight;

      return {
        left: { x: 0, y: 0, width: w, height: topHeight },
        divider: { x: 0, y: topHeight, width: w, height: DIVIDER_SIZE },
        right: { x: 0, y: topHeight + DIVIDER_SIZE, width: w, height: bottomHeight },
      };
    }
  }

  private async updateChildRects(): Promise<void> {
    const rects = this.getChildRects();

    if (this.leftChildId) {
      try {
        await this.request(
          request(this.id, this.leftChildId, 'update', {
            rect: { x: 0, y: 0, width: rects.left.width, height: rects.left.height },
          })
        );
      } catch { /* child may be gone */ }
    }

    if (this.rightChildId) {
      try {
        await this.request(
          request(this.id, this.rightChildId, 'update', {
            rect: { x: 0, y: 0, width: rects.right.width, height: rects.right.height },
          })
        );
      } catch { /* child may be gone */ }
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────

  protected async buildDrawCommands(
    surfaceId: string,
    ox: number,
    oy: number
  ): Promise<unknown[]> {
    const commands: unknown[] = [];
    const rects = this.getChildRects();

    // Render left/top child
    if (this.leftChildId) {
      try {
        const childCmds = await this.request<unknown[]>(
          request(this.id, this.leftChildId, 'render', {
            surfaceId,
            ox: ox + rects.left.x,
            oy: oy + rects.left.y,
          })
        );
        if (Array.isArray(childCmds)) commands.push(...childCmds);
      } catch { /* child gone */ }
    }

    // Render right/bottom child
    if (this.rightChildId) {
      try {
        const childCmds = await this.request<unknown[]>(
          request(this.id, this.rightChildId, 'render', {
            surfaceId,
            ox: ox + rects.right.x,
            oy: oy + rects.right.y,
          })
        );
        if (Array.isArray(childCmds)) commands.push(...childCmds);
      } catch { /* child gone */ }
    }

    // Draw divider bar: a heavy ink rule centred in the gutter, turning into
    // a solid red bar while hovered or dragged.
    const d = rects.divider;
    const active = this.dividerHovered || this.dragging;
    const rw = active ? (this.orientation === 'horizontal' ? d.width : d.height) : Math.min(shapeOf(this.theme).ruleWidth, DIVIDER_SIZE);
    const horiz = this.orientation === 'horizontal';
    commands.push({
      type: 'rect',
      surfaceId,
      params: horiz
        ? { x: ox + d.x + Math.floor((d.width - rw) / 2), y: oy + d.y, width: rw, height: d.height, fill: active ? this.theme.accent : this.theme.textPrimary }
        : { x: ox + d.x, y: oy + d.y + Math.floor((d.height - rw) / 2), width: d.width, height: rw, fill: active ? this.theme.accent : this.theme.textPrimary },
    });

    return commands;
  }

  // ── Input handling ─────────────────────────────────────────────────

  protected async processInput(
    input: Record<string, unknown>
  ): Promise<{ consumed: boolean; focusWidgetId?: AbjectId }> {
    const type = input.type as string;
    const mx = (input.x as number) ?? 0;
    const my = (input.y as number) ?? 0;
    const rects = this.getChildRects();

    if (type === 'mousedown') {
      // Check if clicking the divider
      if (this.isInDivider(mx, my, rects.divider)) {
        this.dragging = true;
        await this.requestRedraw();
        return { consumed: true };
      }

      // Forward to children
      return this.forwardToChild(input, mx, my, rects);
    }

    if (type === 'mousemove') {
      if (this.dragging) {
        // Update divider position
        if (this.orientation === 'horizontal') {
          const totalWidth = this.rect.width - DIVIDER_SIZE;
          this.dividerPosition = Math.max(
            this.minSize / totalWidth,
            Math.min(1 - this.minSize / totalWidth, mx / this.rect.width)
          );
        } else {
          const totalHeight = this.rect.height - DIVIDER_SIZE;
          this.dividerPosition = Math.max(
            this.minSize / totalHeight,
            Math.min(1 - this.minSize / totalHeight, my / this.rect.height)
          );
        }
        await this.updateChildRects();
        await this.requestRedraw();
        this.changed('dividerMoved', this.dividerPosition);
        return { consumed: true };
      }

      // Hover detection for divider
      const inDivider = this.isInDivider(mx, my, rects.divider);
      if (inDivider !== this.dividerHovered) {
        this.dividerHovered = inDivider;
        await this.requestRedraw();
      }

      if (!inDivider) {
        // Forward mousemove to appropriate child
        return this.forwardToChild(input, mx, my, rects);
      }
      return { consumed: true };
    }

    if (type === 'mouseup') {
      if (this.dragging) {
        this.dragging = false;
        await this.requestRedraw();
        return { consumed: true };
      }
      return { consumed: false };
    }

    if (type === 'mouseleave') {
      if (this.dividerHovered) {
        this.dividerHovered = false;
        await this.requestRedraw();
      }
      this.dragging = false;
      // Forward mouseleave to both children
      if (this.leftChildId) {
        try {
          await this.request<{ consumed: boolean }>(
            request(this.id, this.leftChildId, 'handleInput', { type: 'mouseleave' })
          );
        } catch { /* gone */ }
      }
      if (this.rightChildId) {
        try {
          await this.request<{ consumed: boolean }>(
            request(this.id, this.rightChildId, 'handleInput', { type: 'mouseleave' })
          );
        } catch { /* gone */ }
      }
      return { consumed: true };
    }

    if (type === 'wheel') {
      // Forward wheel to the child under the mouse
      return this.forwardToChild(input, mx, my, rects);
    }

    return { consumed: false };
  }

  private isInDivider(mx: number, my: number, divider: Rect): boolean {
    // Expand hit area slightly for easier grabbing
    const expand = 2;
    if (this.orientation === 'horizontal') {
      return mx >= divider.x - expand && mx <= divider.x + divider.width + expand;
    } else {
      return my >= divider.y - expand && my <= divider.y + divider.height + expand;
    }
  }

  private async forwardToChild(
    input: Record<string, unknown>,
    mx: number,
    my: number,
    rects: { left: Rect; right: Rect }
  ): Promise<{ consumed: boolean; focusWidgetId?: AbjectId }> {
    // Check left/top child
    if (this.leftChildId &&
        mx >= rects.left.x && mx < rects.left.x + rects.left.width &&
        my >= rects.left.y && my < rects.left.y + rects.left.height) {
      try {
        const result = await this.request<{ consumed: boolean; focusWidgetId?: AbjectId }>(
          request(this.id, this.leftChildId, 'handleInput', {
            ...input,
            x: mx - rects.left.x,
            y: my - rects.left.y,
          })
        );
        if (result.consumed) {
          return { consumed: true, focusWidgetId: result.focusWidgetId ?? this.leftChildId };
        }
      } catch { /* child gone */ }
    }

    // Check right/bottom child
    if (this.rightChildId &&
        mx >= rects.right.x && mx < rects.right.x + rects.right.width &&
        my >= rects.right.y && my < rects.right.y + rects.right.height) {
      try {
        const result = await this.request<{ consumed: boolean; focusWidgetId?: AbjectId }>(
          request(this.id, this.rightChildId, 'handleInput', {
            ...input,
            x: mx - rects.right.x,
            y: my - rects.right.y,
          })
        );
        if (result.consumed) {
          return { consumed: true, focusWidgetId: result.focusWidgetId ?? this.rightChildId };
        }
      } catch { /* child gone */ }
    }

    return { consumed: false };
  }

  // ── Value and update ───────────────────────────────────────────────

  protected getWidgetValue(): string {
    return String(this.dividerPosition);
  }

  protected async applyUpdate(updates: Record<string, unknown>): Promise<void> {
    if (updates.dividerPosition !== undefined) {
      this.dividerPosition = updates.dividerPosition as number;
    }
    if (updates.orientation !== undefined) {
      this.orientation = updates.orientation as 'horizontal' | 'vertical';
    }
    if (updates.minSize !== undefined) {
      this.minSize = updates.minSize as number;
    }
    // When rect changes, cascade to children
    if (updates.rect !== undefined || updates.dividerPosition !== undefined) {
      await this.updateChildRects();
    }
  }
}
