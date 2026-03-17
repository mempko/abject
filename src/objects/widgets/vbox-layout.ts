/**
 * VBoxLayout — arranges children vertically.
 *
 * Fixed/preferred children get their preferred height.
 * Expanding children share remaining space proportionally by stretch factor.
 * Width is determined by horizontal size policy.
 */

import { AbjectId } from '../../core/types.js';
import { Rect, LayoutChildConfig, SpacerConfig } from './widget-types.js';
import { LayoutAbject, LayoutConfig, ChildRect, isSpacer } from './layout-abject.js';

export class VBoxLayout extends LayoutAbject {
  constructor(config: LayoutConfig) {
    super(config, 'vbox');
  }

  protected override computePreferredHeight(): number {
    const children = this.layoutChildren.filter(c => {
      if (isSpacer(c)) return false;
      return !this.hiddenChildren.has(c.widgetId);
    });
    if (children.length === 0) return this.margins.top + this.margins.bottom;

    let total = 0;
    for (const child of children) {
      if (isSpacer(child)) continue;
      total += child.preferredSize?.height ?? 0;
    }
    // Add spacing between children
    if (children.length > 1) {
      total += (children.length - 1) * this.spacing;
    }
    return total + this.margins.top + this.margins.bottom;
  }

  protected calculateChildRects(contentRect: Rect): ChildRect[] {
    const children = this.layoutChildren.filter(c => {
      if (isSpacer(c)) return true;
      return !this.hiddenChildren.has(c.widgetId);
    });
    if (children.length === 0) return [];

    // Calculate total spacing
    const totalSpacing = Math.max(0, (children.length - 1) * this.spacing);

    // First pass: sum preferred heights for fixed/preferred items
    let fixedHeight = 0;
    let totalStretch = 0;

    for (const child of children) {
      if (isSpacer(child)) {
        totalStretch += child.stretch ?? 1;
      } else {
        const vPolicy = child.sizePolicy?.vertical ?? 'preferred';
        if (vPolicy === 'fixed' || vPolicy === 'preferred') {
          fixedHeight += child.preferredSize?.height ?? 0;
        } else {
          // expanding
          totalStretch += child.stretch ?? 1;
        }
      }
    }

    // Available space for expanding items
    const availableForExpanding = Math.max(0, contentRect.height - totalSpacing - fixedHeight);

    // Second pass: assign rects
    const result: ChildRect[] = [];
    let y = contentRect.y;

    for (const child of children) {
      if (isSpacer(child)) {
        const stretch = child.stretch ?? 1;
        const spacerHeight = totalStretch > 0
          ? (availableForExpanding * stretch) / totalStretch
          : 0;
        y += spacerHeight + this.spacing;
        continue;
      }

      const vPolicy = child.sizePolicy?.vertical ?? 'preferred';
      const hPolicy = child.sizePolicy?.horizontal ?? 'expanding';

      // Calculate height
      let height: number;
      if (vPolicy === 'fixed' || vPolicy === 'preferred') {
        height = child.preferredSize?.height ?? 0;
      } else {
        const stretch = child.stretch ?? 1;
        height = totalStretch > 0
          ? (availableForExpanding * stretch) / totalStretch
          : 0;
      }

      // Calculate width based on horizontal policy
      let width: number;
      let x = contentRect.x;

      if (hPolicy === 'fixed') {
        width = child.preferredSize?.width ?? contentRect.width;
      } else {
        width = contentRect.width;
      }

      // Cross-axis alignment
      if (width < contentRect.width) {
        const alignment = child.alignment ?? 'left';
        if (alignment === 'center') {
          x = contentRect.x + (contentRect.width - width) / 2;
        } else if (alignment === 'right') {
          x = contentRect.x + contentRect.width - width;
        }
      }

      result.push({
        widgetId: child.widgetId,
        rect: { x, y, width, height },
      });

      y += height + this.spacing;
    }

    return result;
  }
}
