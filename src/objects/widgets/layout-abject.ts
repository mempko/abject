/**
 * LayoutAbject — abstract base class for layout containers (VBox, HBox).
 *
 * A layout is a WidgetAbject that manages children's geometry. It is invisible —
 * its buildDrawCommands delegates to children at computed positions. Mouse events
 * are routed through hit-testing; keyboard events bypass layouts entirely.
 */

import {
  AbjectId,
  AbjectMessage,
  InterfaceDeclaration,
} from '../../core/types.js';
import { request } from '../../core/message.js';

import { WidgetAbject, WidgetConfig } from './widget-abject.js';
import {
  Rect,
  LayoutChildConfig,
  SpacerConfig,
  LAYOUT_INTERFACE,
} from './widget-types.js';

export interface ChildRect {
  widgetId: AbjectId;
  rect: Rect;
}

export interface LayoutMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const LAYOUT_INTERFACE_DECL: InterfaceDeclaration = {
  id: LAYOUT_INTERFACE,
  name: 'Layout',
  description: 'Layout container that manages children geometry',
  methods: [
    {
      name: 'addLayoutChild',
      description: 'Add a widget to this layout',
      parameters: [
        { name: 'widgetId', type: { kind: 'primitive', primitive: 'string' }, description: 'Widget AbjectId' },
        { name: 'sizePolicy', type: { kind: 'reference', reference: 'SizePolicyConfig' }, description: 'Size policy' },
        { name: 'preferredSize', type: { kind: 'reference', reference: 'PreferredSize' }, description: 'Preferred size' },
        { name: 'alignment', type: { kind: 'primitive', primitive: 'string' }, description: 'Cross-axis alignment' },
        { name: 'stretch', type: { kind: 'primitive', primitive: 'number' }, description: 'Stretch factor' },
      ],
      returns: { kind: 'primitive', primitive: 'boolean' },
    },
    {
      name: 'addLayoutSpacer',
      description: 'Add a spacer to this layout',
      parameters: [
        { name: 'stretch', type: { kind: 'primitive', primitive: 'number' }, description: 'Stretch factor' },
      ],
      returns: { kind: 'primitive', primitive: 'boolean' },
    },
    {
      name: 'removeLayoutChild',
      description: 'Remove a widget from this layout',
      parameters: [
        { name: 'widgetId', type: { kind: 'primitive', primitive: 'string' }, description: 'Widget AbjectId to remove' },
      ],
      returns: { kind: 'primitive', primitive: 'boolean' },
    },
    {
      name: 'updateLayoutChild',
      description: 'Update a child\'s layout properties (sizePolicy, preferredSize, alignment, stretch)',
      parameters: [
        { name: 'widgetId', type: { kind: 'primitive', primitive: 'string' }, description: 'Widget AbjectId' },
        { name: 'preferredSize', type: { kind: 'reference', reference: 'PreferredSize' }, description: 'New preferred size (merged)' },
        { name: 'sizePolicy', type: { kind: 'reference', reference: 'SizePolicy' }, description: 'New size policy (merged with existing)' },
        { name: 'alignment', type: { kind: 'primitive', primitive: 'string' }, description: 'Alignment: left, center, or right' },
        { name: 'stretch', type: { kind: 'primitive', primitive: 'number' }, description: 'Stretch factor' },
      ],
      returns: { kind: 'primitive', primitive: 'boolean' },
    },
    {
      name: 'addLayoutChildren',
      description: 'Add multiple widgets to this layout in one call',
      parameters: [
        { name: 'children', type: { kind: 'array', elementType: { kind: 'reference', reference: 'LayoutChildSpec' } }, description: 'Array of child specs' },
      ],
      returns: { kind: 'primitive', primitive: 'boolean' },
    },
    {
      name: 'clearLayoutChildren',
      description: 'Remove all children from this layout',
      parameters: [],
      returns: { kind: 'primitive', primitive: 'boolean' },
    },
    {
      name: 'getFocusableWidgets',
      description: 'Return flat ordered list of all focusable widget AbjectIds',
      parameters: [],
      returns: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
    },
  ],
};

export interface LayoutConfig {
  ownerId: AbjectId;
  uiServerId: AbjectId;
  margins?: Partial<LayoutMargins>;
  spacing?: number;
}

/**
 * Abstract base class for layout containers.
 */
export abstract class LayoutAbject extends WidgetAbject {
  protected layoutChildren: (LayoutChildConfig | SpacerConfig)[] = [];
  protected margins: LayoutMargins;
  protected spacing: number;
  private hoveredLayoutChildId?: AbjectId;
  private focusedLayoutChildId?: AbjectId;
  protected expandedChildren: Set<AbjectId> = new Set();
  protected hiddenChildren: Set<AbjectId> = new Set();
  private layoutDirty = false;
  protected parentLayoutId: AbjectId | null = null;

  constructor(config: LayoutConfig, layoutType: 'vbox' | 'hbox') {
    super({
      type: 'label', // layouts render nothing themselves
      rect: { x: 0, y: 0, width: 0, height: 0 },
      ownerId: config.ownerId,
      uiServerId: config.uiServerId,
    });

    // Override manifest for layout
    (this as unknown as { manifest: unknown }).manifest = {
      name: layoutType === 'vbox' ? 'VBoxLayout' : 'HBoxLayout',
      description: `${layoutType === 'vbox' ? 'Vertical' : 'Horizontal'} layout container`,
      version: '1.0.0',
      interface: LAYOUT_INTERFACE_DECL,
      requiredCapabilities: [],
      providedCapabilities: [],
      tags: ['widget', 'layout'],
    };

    this.margins = {
      top: config.margins?.top ?? 8,
      right: config.margins?.right ?? 16,
      bottom: config.margins?.bottom ?? 8,
      left: config.margins?.left ?? 16,
    };
    this.spacing = config.spacing ?? 8;

    this.setupLayoutHandlers();
  }

  private relayoutTimer?: ReturnType<typeof setTimeout>;

  private scheduleRelayout(): void {
    // Debounce: reset timer on every mutation so the redraw fires only
    // after a quiet period.  This automatically batches rapid sequential
    // addLayoutChild / removeLayoutChild calls into a single render frame.
    if (this.relayoutTimer) {
      clearTimeout(this.relayoutTimer);
    }
    this.relayoutTimer = setTimeout(() => {
      this.relayoutTimer = undefined;
      if (this.layoutDirty) {
        this.requestRedraw().catch(() => {});
      }
    }, 0);
  }

  private setupLayoutHandlers(): void {
    this.on('addLayoutChild', async (msg: AbjectMessage) => {
      const { widgetId, sizePolicy, preferredSize, alignment, stretch } = msg.payload as {
        widgetId: AbjectId;
        sizePolicy?: { horizontal?: string; vertical?: string };
        preferredSize?: { width?: number; height?: number };
        alignment?: 'left' | 'center' | 'right';
        stretch?: number;
      };
      const existingIdx = this.layoutChildren.findIndex(
        (c) => !isSpacer(c) && c.widgetId === widgetId
      );
      if (existingIdx >= 0) {
        // Update existing entry (caller is overriding defaults from createNestedLayout)
        this.layoutChildren[existingIdx] = {
          widgetId,
          sizePolicy: sizePolicy as LayoutChildConfig['sizePolicy'],
          preferredSize,
          alignment,
          stretch: stretch ?? 1,
        };
      } else {
        this.layoutChildren.push({
          widgetId,
          sizePolicy: sizePolicy as LayoutChildConfig['sizePolicy'],
          preferredSize,
          alignment,
          stretch,
        });
      }
      // Remove widget from window's direct children to prevent double rendering.
      // When a widget (e.g. canvas) is both a window child and a layout child,
      // it would be rendered twice — once by the window and once by the layout.
      // Use fire-and-forget send() to avoid deadlock: the window may be
      // concurrently requesting this layout to render, creating a circular wait.
      this.send(
        request(this.id, this.ownerId, 'removeChild', { widgetId })
      );
      // Register as dependent to receive expanded/collapsed events from select widgets
      this.send(
        request(this.id, widgetId, 'addDependent', {})
      );
      this.layoutDirty = true;
      this.scheduleRelayout();
      this.notifyParentOfSizeChange().catch(() => {});
      return true;
    });

    this.on('addLayoutSpacer', async (msg: AbjectMessage) => {
      const { stretch } = msg.payload as { stretch?: number };
      this.layoutChildren.push({
        type: 'spacer',
        stretch: stretch ?? 1,
      });
      this.layoutDirty = true;
      this.scheduleRelayout();
      return true;
    });

    this.on('addLayoutChildren', async (msg: AbjectMessage) => {
      const { children } = msg.payload as {
        children: Array<{
          widgetId: AbjectId;
          sizePolicy?: { horizontal?: string; vertical?: string };
          preferredSize?: { width?: number; height?: number };
          alignment?: 'left' | 'center' | 'right';
          stretch?: number;
        }>;
      };
      for (const child of children) {
        const existingIdx = this.layoutChildren.findIndex(
          (c) => !isSpacer(c) && c.widgetId === child.widgetId
        );
        if (existingIdx >= 0) {
          this.layoutChildren[existingIdx] = {
            widgetId: child.widgetId,
            sizePolicy: child.sizePolicy as LayoutChildConfig['sizePolicy'],
            preferredSize: child.preferredSize,
            alignment: child.alignment,
            stretch: child.stretch ?? 1,
          };
        } else {
          this.layoutChildren.push({
            widgetId: child.widgetId,
            sizePolicy: child.sizePolicy as LayoutChildConfig['sizePolicy'],
            preferredSize: child.preferredSize,
            alignment: child.alignment,
            stretch: child.stretch,
          });
        }
        // Fire-and-forget: remove from window direct children + register as dependent
        this.send(
          request(this.id, this.ownerId, 'removeChild', { widgetId: child.widgetId })
        );
        this.send(
          request(this.id, child.widgetId, 'addDependent', {})
        );
      }
      this.layoutDirty = true;
      this.scheduleRelayout();
      this.notifyParentOfSizeChange().catch(() => {});
      return true;
    });

    this.on('removeLayoutChild', async (msg: AbjectMessage) => {
      const { widgetId } = msg.payload as { widgetId: AbjectId };
      this.layoutChildren = this.layoutChildren.filter(
        (c) => isSpacer(c) || c.widgetId !== widgetId
      );
      // Clear stale references to prevent handleInput to destroyed widgets
      if (this.hoveredLayoutChildId === widgetId) {
        this.hoveredLayoutChildId = undefined;
      }
      if (this.focusedLayoutChildId === widgetId) {
        this.focusedLayoutChildId = undefined;
      }
      this.expandedChildren.delete(widgetId);
      this.hiddenChildren.delete(widgetId);
      this.layoutDirty = true;
      this.scheduleRelayout();
      this.notifyParentOfSizeChange().catch(() => {});
      return true;
    });

    this.on('clearLayoutChildren', async () => {
      this.layoutChildren = [];
      this.hoveredLayoutChildId = undefined;
      this.focusedLayoutChildId = undefined;
      this.expandedChildren.clear();
      this.hiddenChildren.clear();
      this.layoutDirty = true;
      this.scheduleRelayout();
      this.notifyParentOfSizeChange().catch(() => {});
      return true;
    });

    this.on('updateLayoutChild', async (msg: AbjectMessage) => {
      const { widgetId, preferredSize, sizePolicy, alignment, stretch } = msg.payload as {
        widgetId: AbjectId;
        preferredSize?: { width?: number; height?: number };
        sizePolicy?: { horizontal?: string; vertical?: string };
        alignment?: 'left' | 'center' | 'right';
        stretch?: number;
      };
      for (const child of this.layoutChildren) {
        if (!isSpacer(child) && child.widgetId === widgetId) {
          if (preferredSize) child.preferredSize = { ...child.preferredSize, ...preferredSize };
          if (sizePolicy) child.sizePolicy = { ...child.sizePolicy, ...sizePolicy } as LayoutChildConfig['sizePolicy'];
          if (alignment !== undefined) child.alignment = alignment;
          if (stretch !== undefined) child.stretch = stretch;
          break;
        }
      }
      this.layoutDirty = true;
      this.scheduleRelayout();
      return true;
    });

    this.on('getFocusableWidgets', async () => {
      return this.getFocusableWidgets();
    });

    // Track expanded state of child widgets (e.g. select dropdowns)
    // so we can render them on top and give them priority hit-testing.
    // Propagate upward so parent layouts also give us priority.
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      if (aspect === 'expanded') {
        if (value) {
          this.expandedChildren.add(msg.routing.from);
        } else {
          this.expandedChildren.delete(msg.routing.from);
        }
        // Propagate: tell our parent layout we have an expanded child
        // so it gives us priority hit-testing beyond our bounds.
        this.changed('expanded', this.expandedChildren.size > 0);
        await this.requestRedraw();
      }
      if (aspect === 'visibility') {
        if (value) {
          this.hiddenChildren.delete(msg.routing.from);
        } else {
          this.hiddenChildren.add(msg.routing.from);
        }
        this.layoutDirty = true;
        this.scheduleRelayout();
      }
    });

    // Forward child dirty notifications up the layout chain
    this.on('childDirty', async () => {
      await this.requestRedraw();
    });
  }

  /**
   * Get the content rect (rect minus margins).
   */
  protected getContentRect(): Rect {
    return {
      x: this.rect.x + this.margins.left,
      y: this.rect.y + this.margins.top,
      width: Math.max(0, this.rect.width - this.margins.left - this.margins.right),
      height: Math.max(0, this.rect.height - this.margins.top - this.margins.bottom),
    };
  }

  /**
   * Calculate child rects — implemented by VBox/HBox.
   */
  protected abstract calculateChildRects(contentRect: Rect): ChildRect[];

  // ── WidgetAbject implementation ───────────────────────────────────

  /**
   * Flush any pending relayout — subclasses that override buildDrawCommands
   * must call this at the top of their override.
   */
  protected async flushPendingRelayout(): Promise<void> {
    if (this.layoutDirty) {
      this.layoutDirty = false;
      if (this.rect.width > 0 && this.rect.height > 0) {
        await this.updateChildRects();
      }
    }
  }

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    // Flush pending relayout before rendering — the render IS the frame
    // boundary, so all mutations between renders are automatically batched.
    await this.flushPendingRelayout();

    const contentRect = this.getContentRect();
    const childRects = this.calculateChildRects(contentRect);
    const commands: unknown[] = [];

    // First pass: render all non-expanded children in parallel
    const nonExpanded = childRects.filter((cr) => !this.expandedChildren.has(cr.widgetId));
    const nonExpandedResults = await Promise.all(
      nonExpanded.map(async (cr) => {
        try {
          return await this.request<unknown[]>(
            request(this.id, cr.widgetId, 'render', {
              surfaceId,
              ox: ox + cr.rect.x,
              oy: oy + cr.rect.y,
            })
          );
        } catch {
          return null;
        }
      })
    );
    for (const childCmds of nonExpandedResults) {
      if (Array.isArray(childCmds)) commands.push(...childCmds);
    }

    // Second pass: render expanded children on top so dropdowns paint over siblings
    const expanded = childRects.filter((cr) => this.expandedChildren.has(cr.widgetId));
    const expandedResults = await Promise.all(
      expanded.map(async (cr) => {
        try {
          return await this.request<unknown[]>(
            request(this.id, cr.widgetId, 'render', {
              surfaceId,
              ox: ox + cr.rect.x,
              oy: oy + cr.rect.y,
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

    return commands;
  }

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean; focusWidgetId?: AbjectId }> {
    const inputType = input.type as string;

    // Handle mouseleave by propagating to hovered and focused children
    if (inputType === 'mouseleave') {
      if (this.hoveredLayoutChildId) {
        try {
          await this.request<{ consumed: boolean }>(
            request(this.id, this.hoveredLayoutChildId, 'handleInput', {
              type: 'mouseleave',
            })
          );
        } catch {
          // Widget gone
        }
        this.hoveredLayoutChildId = undefined;
      }
      // Clear focused child to stop drag-selection forwarding
      if (this.focusedLayoutChildId) {
        try {
          await this.request<{ consumed: boolean }>(
            request(this.id, this.focusedLayoutChildId, 'handleInput', {
              type: 'mouseleave',
            })
          );
        } catch {
          // Widget gone
        }
        this.focusedLayoutChildId = undefined;
      }
      return { consumed: true };
    }

    // Forward mouseup to focused child so it can end drag-selection
    if (inputType === 'mouseup') {
      if (this.focusedLayoutChildId) {
        try {
          await this.request<{ consumed: boolean }>(
            request(this.id, this.focusedLayoutChildId, 'handleInput', {
              ...input,
            })
          );
        } catch {
          // Widget gone
        }
        this.focusedLayoutChildId = undefined;
      }
      return { consumed: true };
    }

    // Only route mouse events through layout
    if (inputType !== 'mousedown' && inputType !== 'mousemove' && inputType !== 'wheel') {
      return { consumed: false };
    }

    const mx = input.x as number;
    const my = input.y as number;

    const contentRect = this.getContentRect();
    const childRects = this.calculateChildRects(contentRect);

    // Priority: forward mousedown/mousemove to expanded children first.
    // Expanded widgets (e.g. select dropdowns) extend beyond their rect,
    // so they need first crack at events before normal hit-testing.
    if (this.expandedChildren.size > 0 && (inputType === 'mousedown' || inputType === 'mousemove')) {
      for (const cr of childRects) {
        if (!this.expandedChildren.has(cr.widgetId)) continue;
        try {
          const result = await this.request<{ consumed: boolean; focusWidgetId?: AbjectId }>(
            request(this.id, cr.widgetId, 'handleInput', {
              ...input,
              x: mx - cr.rect.x,
              y: my - cr.rect.y,
            })
          );
          if (result.consumed) {
            return {
              consumed: true,
              focusWidgetId: result.focusWidgetId ?? cr.widgetId,
            };
          }
        } catch {
          // Widget gone
        }
      }
    }

    // For mousemove, track hover and send mouseleave to old child
    if (inputType === 'mousemove') {
      let hitChildId: AbjectId | undefined;
      for (const cr of childRects) {
        if (mx >= cr.rect.x && mx < cr.rect.x + cr.rect.width &&
            my >= cr.rect.y && my < cr.rect.y + cr.rect.height) {
          hitChildId = cr.widgetId;

          if (hitChildId !== this.hoveredLayoutChildId) {
            // Send mouseleave to old hovered child
            if (this.hoveredLayoutChildId) {
              try {
                await this.request<{ consumed: boolean }>(
                  request(this.id, this.hoveredLayoutChildId, 'handleInput', {
                    type: 'mouseleave',
                  })
                );
              } catch {
                // Widget gone
              }
            }
            this.hoveredLayoutChildId = hitChildId;
          }

          // Forward mousemove to hit child
          try {
            await this.request<{ consumed: boolean }>(
              request(this.id, cr.widgetId, 'handleInput', {
                ...input,
                x: mx - cr.rect.x,
                y: my - cr.rect.y,
              })
            );
          } catch {
            // Widget gone
          }
          return { consumed: true };
        }
      }

      // No child hit — send mouseleave to previous hovered child
      if (!hitChildId && this.hoveredLayoutChildId) {
        try {
          await this.request<{ consumed: boolean }>(
            request(this.id, this.hoveredLayoutChildId, 'handleInput', {
              type: 'mouseleave',
            })
          );
        } catch {
          // Widget gone
        }
        this.hoveredLayoutChildId = undefined;
      }

      // Forward mousemove to focused child even when cursor is outside its bounds
      // (supports drag-selection continuing when cursor leaves the label area)
      if (this.focusedLayoutChildId && this.focusedLayoutChildId !== hitChildId) {
        // Find the focused child's rect for coordinate translation
        for (const cr of childRects) {
          if (cr.widgetId === this.focusedLayoutChildId) {
            try {
              await this.request<{ consumed: boolean }>(
                request(this.id, this.focusedLayoutChildId, 'handleInput', {
                  ...input,
                  x: mx - cr.rect.x,
                  y: my - cr.rect.y,
                })
              );
            } catch {
              // Widget gone
            }
            return { consumed: true };
          }
        }
      }

      return { consumed: false };
    }

    for (const cr of childRects) {
      if (mx >= cr.rect.x && mx < cr.rect.x + cr.rect.width &&
          my >= cr.rect.y && my < cr.rect.y + cr.rect.height) {
        try {
          const result = await this.request<{ consumed: boolean; focusWidgetId?: AbjectId }>(
            request(this.id, cr.widgetId, 'handleInput', {
              ...input,
              x: mx - cr.rect.x,
              y: my - cr.rect.y,
            })
          );
          if (result.consumed) {
            // Track focused child for drag-selection forwarding
            this.focusedLayoutChildId = result.focusWidgetId ?? cr.widgetId;
            return {
              consumed: true,
              focusWidgetId: result.focusWidgetId ?? cr.widgetId,
            };
          }
        } catch {
          // Widget gone
        }
      }
    }

    this.focusedLayoutChildId = undefined;
    return { consumed: false };
  }

  protected getWidgetValue(): string {
    return '';
  }

  protected async applyUpdate(updates: Record<string, unknown>): Promise<void> {
    if (updates.margins !== undefined) {
      const m = updates.margins as Partial<LayoutMargins>;
      this.margins = { ...this.margins, ...m };
    }
    if (updates.spacing !== undefined) {
      this.spacing = updates.spacing as number;
    }

    // When rect changes, cascade rect updates to children
    if (updates.rect !== undefined) {
      await this.updateChildRects();
    }
  }

  /**
   * Recalculate child rects and update each child widget's rect.
   * Called when the layout's own rect changes (e.g. from window resize).
   */
  private async updateChildRects(): Promise<void> {
    const contentRect = this.getContentRect();
    const childRects = this.calculateChildRects(contentRect);

    await Promise.all(childRects.map(async (cr) => {
      try {
        await this.request(
          request(this.id, cr.widgetId, 'update', {
            rect: { x: 0, y: 0, width: cr.rect.width, height: cr.rect.height },
          })
        );
      } catch {
        // Widget may have been destroyed
      }
    }));
  }

  /**
   * Set the parent layout ID so this nested layout can notify the parent
   * when its computed preferred height changes.
   */
  setParentLayoutId(parentId: AbjectId): void {
    this.parentLayoutId = parentId;
  }

  /**
   * Compute the total preferred height of this layout from its children.
   * Subclasses override this for their specific layout direction.
   * Returns the sum of children heights + spacing + margins (for VBox)
   * or the max child height + margins (for HBox).
   */
  protected computePreferredHeight(): number {
    return this.margins.top + this.margins.bottom;
  }

  /**
   * Notify the parent layout that this nested layout's preferred height
   * has changed, so the parent can re-lay-out correctly.
   */
  protected async notifyParentOfSizeChange(): Promise<void> {
    if (!this.parentLayoutId) return;
    const height = this.computePreferredHeight();
    if (height <= 0) return;
    try {
      await this.request(
        request(this.id, this.parentLayoutId, 'updateLayoutChild', {
          widgetId: this.id,
          preferredSize: { height },
          sizePolicy: { vertical: 'preferred' },
        })
      );
    } catch {
      // Parent may have been destroyed
    }
  }

  /**
   * Return flat ordered list of all focusable widget AbjectIds,
   * recursing into nested layouts.
   */
  private async getFocusableWidgets(): Promise<AbjectId[]> {
    const result: AbjectId[] = [];
    for (const child of this.layoutChildren) {
      if (isSpacer(child)) continue;

      // Try to get focusable widgets from this child (if it's a layout)
      try {
        const nested = await this.request<AbjectId[]>(
          request(this.id, child.widgetId, 'getFocusableWidgets', {})
        );
        if (Array.isArray(nested) && nested.length > 0) {
          result.push(...nested);
          continue;
        }
      } catch {
        // Not a layout — it's a regular widget
      }

      result.push(child.widgetId);
    }
    return result;
  }
}

/**
 * Type guard for SpacerConfig.
 */
export function isSpacer(item: LayoutChildConfig | SpacerConfig): item is SpacerConfig {
  return (item as SpacerConfig).type === 'spacer';
}
