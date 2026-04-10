/**
 * WebParser capability object — provides HTML parsing and data extraction.
 *
 * Server-only: uses linkedom for lightweight DOM parsing in Node.js.
 */

import { AbjectId, AbjectMessage } from '../../core/types.js';
import { Abject, DEFERRED_REPLY } from '../../core/abject.js';
import { error } from '../../core/message.js';
import { Capabilities } from '../../core/capability.js';
import { Log } from '../../core/timed-log.js';

const log = new Log('WebParser');

const WEB_PARSER_INTERFACE = 'abjects:web-parser';

interface ExtractedElement {
  tag: string;
  text: string;
  attributes: Record<string, string>;
  innerHTML: string;
}

interface ExtractedLink {
  href: string;
  text: string;
}

interface ExtractedImage {
  src: string;
  alt: string;
}

interface ExtractedMeta {
  title: string;
  description: string;
  ogImage: string;
  ogTitle: string;
  ogDescription: string;
  ogUrl: string;
}

/**
 * WebParser capability object — HTML parsing and data extraction.
 */
export class WebParser extends Abject {
  private parseHTML: ((html: string) => { document: Document }) | null = null;

  constructor() {
    super({
      manifest: {
        name: 'WebParser',
        description:
          'HTML parsing and data extraction. Parse HTML strings, extract links, images, text, and metadata using CSS selectors. Use cases: parse HTML and extract links/images/text with CSS selectors, get page metadata (title, OG tags).',
        version: '1.0.0',
        interface: {
            id: WEB_PARSER_INTERFACE,
            name: 'WebParser',
            description: 'HTML parsing operations',
            methods: [
              {
                name: 'querySelector',
                description: 'Query HTML with a CSS selector and return matching elements',
                parameters: [
                  {
                    name: 'html',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'HTML string to parse',
                  },
                  {
                    name: 'selector',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'CSS selector',
                  },
                ],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'reference', reference: 'ExtractedElement' },
                },
              },
              {
                name: 'extractLinks',
                description: 'Extract all links from HTML',
                parameters: [
                  {
                    name: 'html',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'HTML string to parse',
                  },
                  {
                    name: 'baseUrl',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Base URL for resolving relative links',
                    optional: true,
                  },
                ],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'reference', reference: 'ExtractedLink' },
                },
              },
              {
                name: 'extractImages',
                description: 'Extract all image sources from HTML',
                parameters: [
                  {
                    name: 'html',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'HTML string to parse',
                  },
                  {
                    name: 'baseUrl',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Base URL for resolving relative image sources',
                    optional: true,
                  },
                ],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'reference', reference: 'ExtractedImage' },
                },
              },
              {
                name: 'extractText',
                description: 'Extract plain text from HTML, optionally limited to a CSS selector',
                parameters: [
                  {
                    name: 'html',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'HTML string to parse',
                  },
                  {
                    name: 'selector',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'CSS selector to limit text extraction',
                    optional: true,
                  },
                ],
                returns: { kind: 'primitive', primitive: 'string' },
              },
              {
                name: 'extractMeta',
                description: 'Extract metadata (title, description, Open Graph tags) from HTML',
                parameters: [
                  {
                    name: 'html',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'HTML string to parse',
                  },
                ],
                returns: { kind: 'reference', reference: 'ExtractedMeta' },
              },
            ],
          },
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.WEB_PARSE],
        tags: ['system', 'capability', 'web', 'parser'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    // Lazy-load linkedom (only available in Node.js / server mode)
    try {
      const linkedom = await import('linkedom');
      this.parseHTML = linkedom.parseHTML;
    } catch {
      log.warn('linkedom not available — falling back to regex-based extraction');
    }
  }

  private setupHandlers(): void {
    this.on('querySelector', async (msg: AbjectMessage) => {
      const { html, selector } = msg.payload as { html: string; selector: string };
      try {
        return this.querySelectorAll(html, selector);
      } catch (err) {
        throw new Error(`querySelector failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    this.on('extractLinks', async (msg: AbjectMessage) => {
      const { html, baseUrl } = msg.payload as { html: string; baseUrl?: string };
      try {
        return this.doExtractLinks(html, baseUrl);
      } catch (err) {
        throw new Error(`extractLinks failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    this.on('extractImages', async (msg: AbjectMessage) => {
      const { html, baseUrl } = msg.payload as { html: string; baseUrl?: string };
      try {
        return this.doExtractImages(html, baseUrl);
      } catch (err) {
        throw new Error(`extractImages failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    this.on('extractText', async (msg: AbjectMessage) => {
      const { html, selector } = msg.payload as { html: string; selector?: string };
      try {
        return this.doExtractText(html, selector);
      } catch (err) {
        throw new Error(`extractText failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    this.on('extractMeta', async (msg: AbjectMessage) => {
      const { html } = msg.payload as { html: string };
      try {
        return this.doExtractMeta(html);
      } catch (err) {
        throw new Error(`extractMeta failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  private getDocument(html: string): Document {
    if (this.parseHTML) {
      return this.parseHTML(html).document;
    }
    throw new Error('WebParser requires linkedom (server mode only)');
  }

  private resolveUrl(href: string, baseUrl?: string): string {
    if (!baseUrl || !href) return href;
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return href;
    }
  }

  private querySelectorAll(html: string, selector: string): ExtractedElement[] {
    const doc = this.getDocument(html);
    const elements = doc.querySelectorAll(selector);
    const results: ExtractedElement[] = [];
    for (const el of elements) {
      const attributes: Record<string, string> = {};
      for (const attr of el.attributes) {
        attributes[attr.name] = attr.value;
      }
      results.push({
        tag: el.tagName.toLowerCase(),
        text: el.textContent ?? '',
        attributes,
        innerHTML: el.innerHTML,
      });
    }
    return results;
  }

  private doExtractLinks(html: string, baseUrl?: string): ExtractedLink[] {
    const doc = this.getDocument(html);
    const anchors = doc.querySelectorAll('a[href]');
    const results: ExtractedLink[] = [];
    for (const a of anchors) {
      const href = a.getAttribute('href') ?? '';
      results.push({
        href: this.resolveUrl(href, baseUrl),
        text: a.textContent?.trim() ?? '',
      });
    }
    return results;
  }

  private doExtractImages(html: string, baseUrl?: string): ExtractedImage[] {
    const doc = this.getDocument(html);
    const imgs = doc.querySelectorAll('img[src]');
    const results: ExtractedImage[] = [];
    for (const img of imgs) {
      const src = img.getAttribute('src') ?? '';
      results.push({
        src: this.resolveUrl(src, baseUrl),
        alt: img.getAttribute('alt') ?? '',
      });
    }
    return results;
  }

  private doExtractText(html: string, selector?: string): string {
    const doc = this.getDocument(html);
    if (selector) {
      const el = doc.querySelector(selector);
      return el?.textContent?.trim() ?? '';
    }
    return doc.body?.textContent?.trim() ?? '';
  }

  private doExtractMeta(html: string): ExtractedMeta {
    const doc = this.getDocument(html);
    const getMeta = (name: string): string => {
      const el = doc.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
      return el?.getAttribute('content') ?? '';
    };
    return {
      title: doc.querySelector('title')?.textContent?.trim() ?? '',
      description: getMeta('description'),
      ogImage: getMeta('og:image'),
      ogTitle: getMeta('og:title'),
      ogDescription: getMeta('og:description'),
      ogUrl: getMeta('og:url'),
    };
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## WebParser Usage Guide

### Query HTML with CSS Selector

  const elements = await this.call(
    this.dep('WebParser'), 'querySelector',
    { html: htmlString, selector: 'div.article h2' });
  // elements = [{ tag: 'h2', text: 'Title', attributes: { class: 'heading' }, innerHTML: 'Title' }]

### Extract Links

  const links = await this.call(
    this.dep('WebParser'), 'extractLinks',
    { html: htmlString, baseUrl: 'https://example.com' });
  // links = [{ href: 'https://example.com/page', text: 'Click here' }]

### Extract Images

  const images = await this.call(
    this.dep('WebParser'), 'extractImages',
    { html: htmlString, baseUrl: 'https://example.com' });
  // images = [{ src: 'https://example.com/photo.jpg', alt: 'A photo' }]

### Extract Text

  const text = await this.call(
    this.dep('WebParser'), 'extractText',
    { html: htmlString, selector: 'article' });

### Extract Metadata

  const meta = await this.call(
    this.dep('WebParser'), 'extractMeta',
    { html: htmlString });
  // meta = { title, description, ogImage, ogTitle, ogDescription, ogUrl }

### Common Pattern: Fetch + Parse

  // 1. Fetch a page
  const resp = await this.call(this.dep('HttpClient'), 'get', { url: 'https://example.com' });
  // 2. Extract images
  const images = await this.call(this.dep('WebParser'), 'extractImages',
    { html: resp.body, baseUrl: 'https://example.com' });
  // 3. Fetch first image as data URI
  const imgData = await this.call(this.dep('HttpClient'), 'getBase64', { url: images[0].src });
  // 4. Display on surface
  await this.call(this.dep('UIServer'), 'draw', {
    commands: [{ type: 'imageUrl', surfaceId, params: { x: 0, y: 0, width: 300, height: 200, url: imgData.dataUri } }]
  });`;
  }
}

// Well-known WebParser ID
export const WEB_PARSER_ID = 'abjects:web-parser' as AbjectId;
