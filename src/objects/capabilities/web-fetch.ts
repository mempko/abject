/**
 * WebFetch capability object -- fetches a URL and returns cleaned text content.
 *
 * This is the Abjects equivalent of Claude Code's `WebFetch` tool.
 * Unlike raw HttpClient, this converts HTML to readable text.
 * Composes HttpClient + WebParser via message passing.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../../core/types.js';
import { Abject, DEFERRED_REPLY } from '../../core/abject.js';
import { request, error as errorMsg } from '../../core/message.js';
import { Capabilities } from '../../core/capability.js';
import { require as contractRequire } from '../../core/contracts.js';
import { Log } from '../../core/timed-log.js';

const log = new Log('WebFetch');
const WEB_FETCH_INTERFACE: InterfaceId = 'abjects:web-fetch';

export interface FetchResult {
  content: string;
  title: string;
  url: string;
  contentType: string;
}

export class WebFetch extends Abject {
  private httpClientId?: AbjectId;
  private webParserId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'WebFetch',
        description:
          'Fetches a URL and returns cleaned text content. Equivalent to Claude Code\'s WebFetch tool. ' +
          'HTML pages are converted to readable text. Returns title, content, URL, and content type.',
        version: '1.0.0',
        interface: {
          id: WEB_FETCH_INTERFACE,
          name: 'WebFetch',
          description: 'URL content fetching with text extraction',
          methods: [
            {
              name: 'fetch',
              description: 'Fetch a URL and return its content as cleaned text',
              parameters: [
                { name: 'url', type: { kind: 'primitive', primitive: 'string' }, description: 'URL to fetch' },
                { name: 'maxLength', type: { kind: 'primitive', primitive: 'number' }, description: 'Maximum content length in characters (default 50000)', optional: true },
              ],
              returns: { kind: 'object', properties: {
                content: { kind: 'primitive', primitive: 'string' },
                title: { kind: 'primitive', primitive: 'string' },
                url: { kind: 'primitive', primitive: 'string' },
                contentType: { kind: 'primitive', primitive: 'string' },
              }},
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.HTTP_REQUEST, reason: 'Fetch URL content', required: true },
        ],
        providedCapabilities: [Capabilities.WEB_FETCH],
        tags: ['system', 'capability', 'web'],
      },
    });

    this.setupHandlers();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## WebFetch Usage Guide

Interface: abjects:web-fetch

WebFetch fetches a URL and returns its content as cleaned, readable text.
HTML pages are automatically converted to plain text (scripts/styles stripped).
JSON responses are pretty-printed. Non-HTML/JSON is returned as-is.

### Fetch a URL

  const result = await this.call(
    this.dep('WebFetch'), 'fetch',
    { url: 'https://example.com/page' });
  // result = { content: '...', title: 'Page Title', url: 'https://...', contentType: 'text/html' }

### Fetch with Max Length

  const result = await this.call(
    this.dep('WebFetch'), 'fetch',
    { url: 'https://example.com/long-article', maxLength: 10000 });
  // Content truncated to 10000 chars (default is 50000)

### Response Structure

Every response has: { content, title, url, contentType }
- content: cleaned text extracted from the page
- title: page title (from <title> tag for HTML, empty otherwise)
- url: the fetched URL
- contentType: the Content-Type header value

### IMPORTANT
- Use WebFetch instead of HttpClient when you need readable text from web pages.
- HTML is automatically cleaned: scripts, styles, and tags are removed.
- JSON responses are pretty-printed for readability.`;
  }

  protected override async onInit(): Promise<void> {
    this.httpClientId = await this.discoverDep('HttpClient') ?? undefined;
    this.webParserId = await this.discoverDep('WebParser') ?? undefined;
  }

  private setupHandlers(): void {
    this.on('fetch', (msg: AbjectMessage) => {
      const { url, maxLength } = msg.payload as { url: string; maxLength?: number };
      this.handleFetch(url, maxLength ?? 50000).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => this.send(errorMsg(msg, 'FETCH_ERROR', err instanceof Error ? err.message : String(err))),
      );
      return DEFERRED_REPLY;
    });
  }

  private async handleFetch(url: string, maxLength: number): Promise<FetchResult> {
    contractRequire(typeof url === 'string' && url.length > 0, 'url must be a non-empty string');
    log.info(`fetch: ${url} (maxLength=${maxLength})`);

    if (!this.httpClientId) {
      this.httpClientId = await this.discoverDep('HttpClient') ?? undefined;
    }
    if (!this.httpClientId) {
      throw new Error('HttpClient not available');
    }

    const response = await this.request<{ status: number; body: string; ok: boolean; headers: Record<string, string> }>(
      request(this.id, this.httpClientId, 'get', {
        url,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AbjectsBot/1.0)',
          'Accept': 'text/html, application/json, text/plain, */*',
        },
      }),
    );

    if (!response.ok) {
      throw new Error(`Fetch failed with status ${response.status}`);
    }

    const contentType = response.headers['content-type'] ?? '';
    const isHtml = contentType.includes('text/html');
    const isJson = contentType.includes('application/json');

    let content: string;
    let title = '';

    if (isHtml) {
      // Use WebParser for HTML-to-text if available
      if (this.webParserId) {
        try {
          const textResult = await this.request<{ text: string }>(
            request(this.id, this.webParserId, 'extractText', { html: response.body }),
          );
          content = textResult.text;

          const metaResult = await this.request<{ title: string }>(
            request(this.id, this.webParserId, 'extractMeta', { html: response.body }),
          );
          title = metaResult.title ?? '';
        } catch {
          // Fallback: simple HTML stripping
          content = this.stripHtml(response.body);
          title = this.extractTitle(response.body);
        }
      } else {
        content = this.stripHtml(response.body);
        title = this.extractTitle(response.body);
      }
    } else if (isJson) {
      // Pretty-print JSON
      try {
        content = JSON.stringify(JSON.parse(response.body), null, 2);
      } catch {
        content = response.body;
      }
    } else {
      content = response.body;
    }

    // Truncate to maxLength
    if (content.length > maxLength) {
      content = content.slice(0, maxLength) + '\n...[truncated]';
    }

    log.info(`fetch result: ${content.length} chars, type=${contentType}, title="${title.slice(0, 60)}"`);
    return { content, title, url, contentType };
  }

  /** Simple HTML tag stripping fallback. */
  private stripHtml(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Extract title from HTML. */
  private extractTitle(html: string): string {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match ? match[1].trim() : '';
  }
}

export const WEB_FETCH_ID = 'abjects:web-fetch' as AbjectId;
