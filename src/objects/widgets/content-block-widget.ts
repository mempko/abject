/**
 * ContentBlockWidget — auto-height wrapped/markdown text.
 *
 * A LabelWidget preconfigured for word-wrapped rich text that measures its own
 * natural height and reports it via a `contentHeight` event, so owners size
 * the layout child instead of estimating line counts themselves. This is the
 * same self-sizing pattern GoalProgressWidget established: give the block an
 * expanding width and a provisional fixed height, listen for `contentHeight`,
 * and forward it to the layout with `updateLayoutChild`.
 *
 * Defaults: markdown + wordWrap on, selectable on (readers expect to copy
 * text). Pass `style: { markdown: false }` for plain wrapped text.
 *
 * Events (in addition to LabelWidget's `click`):
 *   contentHeight — number  the natural height needed to show all text
 */

import { LabelWidget } from './label-widget.js';
import { WidgetConfig } from './widget-abject.js';

export class ContentBlockWidget extends LabelWidget {
  private lastReportedHeight = -1;

  constructor(config: WidgetConfig) {
    super({
      ...config,
      style: {
        markdown: true,
        selectable: true,
        ...config.style,
        // wordWrap is load-bearing for self-measurement; always on.
        wordWrap: true,
      },
    });
  }

  protected override async buildDrawCommands(
    surfaceId: string,
    ox: number,
    oy: number,
  ): Promise<unknown[]> {
    const commands = await super.buildDrawCommands(surfaceId, ox, oy);

    // Report natural height once a layout cache exists for the current width.
    // Converges in a frame or two as the layout settles (same contract as
    // GoalProgressWidget). Threshold avoids event storms from ±0.x jitter.
    const natural = this.naturalContentHeight();
    if (natural !== null && this.rect.width > 0
        && Math.abs(natural - this.lastReportedHeight) >= 1) {
      this.lastReportedHeight = natural;
      this.changed('contentHeight', natural);
    }

    return commands;
  }

  protected override applyUpdate(updates: Record<string, unknown>): void {
    super.applyUpdate(updates);
    // Text or style changed: re-report even if the new natural height happens
    // to match a stale rect, so owners re-sync after content swaps.
    if (updates.text !== undefined || updates.style !== undefined) {
      this.lastReportedHeight = -1;
    }
  }
}
