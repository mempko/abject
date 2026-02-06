/**
 * HBoxLayout — arranges children horizontally.
 *
 * Fixed/preferred children get their preferred width.
 * Expanding children share remaining space proportionally by stretch factor.
 * Height is determined by vertical size policy.
 */

import { AbjectId } from '../../core/types.js';
import { Rect, LayoutChildConfig, SpacerConfig } from './widget-types.js';
import { LayoutAbject, LayoutConfig, ChildRect, isSpacer } from './layout-abject.js';

export class HBoxLayout extends LayoutAbject {
  constructor(config: LayoutConfig) {
    super(config, 'hbox');
  }

  protected calculateChildRects(contentRect: Rect): ChildRect[] {
    const children = this.layoutChildren;
    if (children.length === 0) return [];

    // Calculate total spacing
    const totalSpacing = Math.max(0, (children.length - 1) * this.spacing);

    // First pass: sum preferred widths for fixed/preferred items
    let fixedWidth = 0;
    let totalStretch = 0;

    for (const child of children) {
      if (isSpacer(child)) {
        totalStretch += child.stretch ?? 1;
      } else {
        const hPolicy = child.sizePolicy?.horizontal ?? 'preferred';
        if (hPolicy === 'fixed' || hPolicy === 'preferred') {
          fixedWidth += child.preferredSize?.width ?? 0;
        } else {
          // expanding
          totalStretch += child.stretch ?? 1;
        }
      }
    }

    // Available space for expanding items
    const availableForExpanding = Math.max(0, contentRect.width - totalSpacing - fixedWidth);

    // Second pass: assign rects
    const result: ChildRect[] = [];
    let x = contentRect.x;

    for (const child of children) {
      if (isSpacer(child)) {
        const stretch = child.stretch ?? 1;
        const spacerWidth = totalStretch > 0
          ? (availableForExpanding * stretch) / totalStretch
          : 0;
        x += spacerWidth + this.spacing;
        continue;
      }

      const hPolicy = child.sizePolicy?.horizontal ?? 'preferred';
      const vPolicy = child.sizePolicy?.vertical ?? 'expanding';

      // Calculate width
      let width: number;
      if (hPolicy === 'fixed' || hPolicy === 'preferred') {
        width = child.preferredSize?.width ?? 0;
      } else {
        const stretch = child.stretch ?? 1;
        width = totalStretch > 0
          ? (availableForExpanding * stretch) / totalStretch
          : 0;
      }

      // Calculate height based on vertical policy
      let height: number;
      let y = contentRect.y;

      if (vPolicy === 'fixed') {
        height = child.preferredSize?.height ?? contentRect.height;
      } else {
        height = contentRect.height;
      }

      // Cross-axis alignment (vertical)
      if (height < contentRect.height) {
        const alignment = child.alignment ?? 'center';
        if (alignment === 'center') {
          y = contentRect.y + (contentRect.height - height) / 2;
        } else if (alignment === 'right') {
          // 'right' maps to bottom in vertical cross-axis
          y = contentRect.y + contentRect.height - height;
        }
      }

      result.push({
        widgetId: child.widgetId,
        rect: { x, y, width, height },
      });

      x += width + this.spacing;
    }

    return result;
  }
}
