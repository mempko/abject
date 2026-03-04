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
      description: 'Update a child\'s preferredSize in this layout',
      parameters: [
        { name: 'widgetId', type: { kind: 'primitive', primitive: 'string' }, description: 'Widget AbjectId' },
        { name: 'preferredSize', type: { kind: 'reference', reference: 'PreferredSize' }, description: 'New preferred size' },
      ],
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
  private expandedChildren: Set<AbjectId> = new Set();
  protected hiddenChildren: Set<AbjectId> = new Set();

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

  private setupLayoutHandlers(): void {
    this.on('addLayoutChild', async (msg: AbjectMessage) => {
      const { widgetId, sizePolicy, preferredSize, alignment, stretch } = msg.payload as {
        widgetId: AbjectId;
        sizePolicy?: { horizontal?: string; vertical?: string };
        preferredSize?: { width?: number; height?: number };
        alignment?: 'left' | 'center' | 'right';
        stretch?: number;
      };
      this.layoutChildren.push({
        widgetId,
        sizePolicy: sizePolicy as LayoutChildConfig['sizePolicy'],
        preferredSize,
        alignment,
        stretch,
      });
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
      if (this.rect.width > 0 && this.rect.height > 0) {
        await this.updateChildRects();
      }
      await this.requestRedraw();
      return true;
    });

    this.on('addLayoutSpacer', async (msg: AbjectMessage) => {
      const { stretch } = msg.payload as { stretch?: number };
      this.layoutChildren.push({
        type: 'spacer',
        stretch: stretch ?? 1,
      });
      if (this.rect.width > 0 && this.rect.height > 0) {
        await this.updateChildRects();
      }
      await this.requestRedraw();
      return true;
    });

    this.on('removeLayoutChild', async (msg: AbjectMessage) => {
      const { widgetId } = msg.payload as { widgetId: AbjectId };
      this.layoutChildren = this.layoutChildren.filter(
        (c) => isSpacer(c) || c.widgetId !== widgetId
      );
      // Clear stale hover reference to prevent handleInput to destroyed widgets
      if (this.hoveredLayoutChildId === widgetId) {
        this.hoveredLayoutChildId = undefined;
      }
      this.expandedChildren.delete(widgetId);
      this.hiddenChildren.delete(widgetId);
      if (this.rect.width > 0 && this.rect.height > 0) {
        await this.updateChildRects();
      }
      await this.requestRedraw();
      return true;
    });

    this.on('updateLayoutChild', async (msg: AbjectMessage) => {
      const { widgetId, preferredSize } = msg.payload as {
        widgetId: AbjectId;
        preferredSize: { width?: number; height?: number };
      };
      for (const child of this.layoutChildren) {
        if (!isSpacer(child) && child.widgetId === widgetId) {
          child.preferredSize = { ...child.preferredSize, ...preferredSize };
          break;
        }
      }
      if (this.rect.width > 0 && this.rect.height > 0) {
        await this.updateChildRects();
      }
      await this.requestRedraw();
      return true;
    });

    this.on('getFocusableWidgets', async () => {
      return this.getFocusableWidgets();
    });

    // Track expanded state of child widgets (e.g. select dropdowns)
    // so we can render them on top and give them priority hit-testing.
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      if (aspect === 'expanded') {
        if (value) {
          this.expandedChildren.add(msg.routing.from);
        } else {
          this.expandedChildren.delete(msg.routing.from);
        }
        await this.requestRedraw();
      }
      if (aspect === 'visibility') {
        if (value) {
          this.hiddenChildren.delete(msg.routing.from);
        } else {
          this.hiddenChildren.add(msg.routing.from);
        }
        if (this.rect.width > 0 && this.rect.height > 0) {
          await this.updateChildRects();
        }
        await this.requestRedraw();
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

  protected async buildDrawCommands(surfaceId: string, ox: number, oy: number): Promise<unknown[]> {
    const contentRect = this.getContentRect();
    const childRects = this.calculateChildRects(contentRect);
    const commands: unknown[] = [];

    // First pass: render all non-expanded children
    for (const cr of childRects) {
      if (this.expandedChildren.has(cr.widgetId)) continue;
      const childOx = ox + cr.rect.x;
      const childOy = oy + cr.rect.y;
      try {
        const childCmds = await this.request<unknown[]>(
          request(this.id, cr.widgetId, 'render', {
            surfaceId,
            ox: childOx,
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

    // Second pass: render expanded children on top so dropdowns paint over siblings
    for (const cr of childRects) {
      if (!this.expandedChildren.has(cr.widgetId)) continue;
      const childOx = ox + cr.rect.x;
      const childOy = oy + cr.rect.y;
      try {
        const childCmds = await this.request<unknown[]>(
          request(this.id, cr.widgetId, 'render', {
            surfaceId,
            ox: childOx,
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

    return commands;
  }

  protected async processInput(input: Record<string, unknown>): Promise<{ consumed: boolean; focusWidgetId?: AbjectId }> {
    const inputType = input.type as string;

    // Handle mouseleave by propagating to hovered child
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

    for (const cr of childRects) {
      try {
        await this.request(
          request(this.id, cr.widgetId, 'update', {
            rect: { x: 0, y: 0, width: cr.rect.width, height: cr.rect.height },
          })
        );
      } catch {
        // Widget may have been destroyed
      }
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
