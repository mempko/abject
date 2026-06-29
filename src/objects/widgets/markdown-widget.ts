/**
 * MarkdownWidget — a first-class widget that renders markdown (bold, italic,
 * inline code, headings, bullet/numbered lists, links, blockquotes, code
 * blocks, and inline images via ![alt](url) where url is a data:image/* URI,
 * an abject:// reference, or http(s)).
 *
 * It is a thin specialization of LabelWidget configured for markdown + word
 * wrap, so it inherits the full rendering pipeline (the shared markdown-render
 * module), image resolution, links, and optional read-only text selection —
 * with zero duplicated rendering logic. Exposing it as its own widget type
 * means any Abject can create rich, image-capable text with one message:
 *   create({ specs: [{ type: 'markdown', windowId, text, style? }] })
 * without knowing the label's `style.markdown` flag.
 */

import { WidgetConfig } from './widget-abject.js';
import { LabelWidget } from './label-widget.js';

export class MarkdownWidget extends LabelWidget {
  constructor(config: WidgetConfig) {
    super({
      ...config,
      type: 'markdown',
      // Force markdown + wrapping on; let caller styles (fontSize, color,
      // selectable, etc.) layer on top.
      style: { wordWrap: true, ...(config.style ?? {}), markdown: true },
    });
  }
}
