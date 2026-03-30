/**
 * WebSearch capability object -- searches the web and returns results.
 *
 * This is the Abjects equivalent of Claude Code's `WebSearch` tool.
 * Uses DuckDuckGo HTML search by default (no API key required).
 * Composes HttpClient + WebParser via message passing.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../../core/types.js';
import { Abject, DEFERRED_REPLY } from '../../core/abject.js';
import { request, error as errorMsg } from '../../core/message.js';
import { Capabilities } from '../../core/capability.js';
import { require as contractRequire } from '../../core/contracts.js';
import { Log } from '../../core/timed-log.js';

const log = new Log('WebSearch');
const WEB_SEARCH_INTERFACE: InterfaceId = 'abjects:web-search';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export class WebSearch extends Abject {
  private httpClientId?: AbjectId;
  private webParserId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'WebSearch',
        description:
          'Searches the web and returns results. Equivalent to Claude Code\'s WebSearch tool. ' +
          'Uses DuckDuckGo by default (no API key required). Returns titles, URLs, and snippets.',
        version: '1.0.0',
        interface: {
          id: WEB_SEARCH_INTERFACE,
          name: 'WebSearch',
          description: 'Web search operations',
          methods: [
            {
              name: 'search',
              description: 'Search the web for a query and return results',
              parameters: [
                { name: 'query', type: { kind: 'primitive', primitive: 'string' }, description: 'Search query' },
                { name: 'maxResults', type: { kind: 'primitive', primitive: 'number' }, description: 'Maximum results to return (default 10)', optional: true },
              ],
              returns: { kind: 'object', properties: {
                results: { kind: 'array', elementType: { kind: 'object', properties: {
                  title: { kind: 'primitive', primitive: 'string' },
                  url: { kind: 'primitive', primitive: 'string' },
                  snippet: { kind: 'primitive', primitive: 'string' },
                }}},
              }},
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.HTTP_REQUEST, reason: 'Fetch search result pages', required: true },
        ],
        providedCapabilities: [Capabilities.WEB_SEARCH],
        tags: ['system', 'capability', 'web', 'search'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.httpClientId = await this.discoverDep('HttpClient') ?? undefined;
    this.webParserId = await this.discoverDep('WebParser') ?? undefined;
  }

  private setupHandlers(): void {
    this.on('search', (msg: AbjectMessage) => {
      const { query, maxResults } = msg.payload as { query: string; maxResults?: number };
      this.handleSearch(query, maxResults ?? 10).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => this.send(errorMsg(msg, 'SEARCH_ERROR', err instanceof Error ? err.message : String(err))),
      );
      return DEFERRED_REPLY;
    });
  }

  private async handleSearch(query: string, maxResults: number): Promise<{ results: SearchResult[] }> {
    contractRequire(typeof query === 'string' && query.length > 0, 'query must be a non-empty string');
    contractRequire(maxResults > 0, 'maxResults must be positive');
    log.info(`search: "${query}" (max=${maxResults})`);

    if (!this.httpClientId) {
      this.httpClientId = await this.discoverDep('HttpClient') ?? undefined;
    }
    if (!this.httpClientId) {
      throw new Error('HttpClient not available');
    }

    // Use DuckDuckGo HTML search
    const encoded = encodeURIComponent(query);
    const url = `https://html.duckduckgo.com/html/?q=${encoded}`;

    const response = await this.request<{ status: number; body: string; ok: boolean }>(
      request(this.id, this.httpClientId, 'get', {
        url,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AbjectsBot/1.0)',
          'Accept': 'text/html',
        },
      }),
    );

    if (!response.ok) {
      throw new Error(`Search request failed with status ${response.status}`);
    }

    // Parse results from HTML
    const results = this.parseDuckDuckGoResults(response.body, maxResults);
    log.info(`search results: ${results.length} found`);
    return { results };
  }

  /**
   * Parse search results from DuckDuckGo HTML response.
   */
  private parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
    const results: SearchResult[] = [];

    // DuckDuckGo HTML search results are in <a class="result__a" ...> tags
    // with snippets in <a class="result__snippet" ...> tags
    const resultBlocks = html.split(/class="result\s/);

    for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
      const block = resultBlocks[i];

      // Extract title and URL from result__a link
      const linkMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
      if (!linkMatch) continue;

      let url = linkMatch[1];
      const title = linkMatch[2].replace(/<[^>]*>/g, '').trim();

      // DuckDuckGo wraps URLs through a redirect; extract the actual URL
      const uddgMatch = url.match(/uddg=([^&]*)/);
      if (uddgMatch) {
        url = decodeURIComponent(uddgMatch[1]);
      }

      // Extract snippet
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|span)>/);
      const snippet = snippetMatch
        ? snippetMatch[1].replace(/<[^>]*>/g, '').trim()
        : '';

      if (title && url) {
        results.push({ title, url, snippet });
      }
    }

    return results;
  }
}

export const WEB_SEARCH_ID = 'abjects:web-search' as AbjectId;
