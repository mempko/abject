/**
 * WebBrowser capability object — headless browser automation via Playwright.
 *
 * Provides both stateless one-shot methods (getRenderedHtml, screenshot,
 * extractFromPage) and a stateful page API for multi-step browser interactions
 * (openPage → navigateTo → click/fill/type → getContent → closePage).
 *
 * Server-only: requires playwright to be installed.
 */

import { AbjectId, AbjectMessage, MethodDeclaration } from '../../core/types.js';
import { Abject, DEFERRED_REPLY } from '../../core/abject.js';
import { error, request } from '../../core/message.js';
import { require as requireContract } from '../../core/contracts.js';
import { Capabilities } from '../../core/capability.js';

const WEB_BROWSER_INTERFACE = 'abjects:web-browser';

interface BrowseOptions {
  waitFor?: string;
  timeout?: number;
  userAgent?: string;
  viewport?: { width: number; height: number };
}

interface ExtractedElement {
  tag: string;
  text: string;
  attributes: Record<string, string>;
  innerHTML: string;
}

// Consolidated Playwright page type — covers all methods used by both
// one-shot and stateful APIs.
type PlaywrightPage = {
  goto: (url: string, opts?: unknown) => Promise<unknown>;
  waitForSelector: (selector: string, opts?: unknown) => Promise<unknown>;
  content: () => Promise<string>;
  url: () => string;
  title: () => Promise<string>;
  close: () => Promise<void>;
  screenshot: (opts?: unknown) => Promise<Buffer>;
  viewportSize: () => { width: number; height: number } | null;
  click: (selector: string, opts?: unknown) => Promise<void>;
  fill: (selector: string, value: string) => Promise<void>;
  type: (selector: string, text: string, opts?: unknown) => Promise<void>;
  selectOption: (selector: string, values: string | string[]) => Promise<string[]>;
  hover: (selector: string) => Promise<void>;
  check: (selector: string) => Promise<void>;
  uncheck: (selector: string) => Promise<void>;
  getAttribute: (selector: string, attribute: string) => Promise<string | null>;
  textContent: (selector: string) => Promise<string | null>;
  evaluate: (script: string | Function) => Promise<unknown>;
  $$eval: (selector: string, fn: (els: Element[]) => unknown) => Promise<unknown>;
  keyboard: { press: (key: string) => Promise<void> };
  on: (event: string, fn: () => void) => void;
};

interface TrackedPage {
  page: PlaywrightPage;
  owner: AbjectId;
  createdAt: number;
  lastActivity: number;
}

// ---------------------------------------------------------------------------
// Manifest method declarations
// ---------------------------------------------------------------------------

const ONE_SHOT_METHODS: MethodDeclaration[] = [
  {
    name: 'getRenderedHtml',
    description: 'Navigate to a URL in a headless browser, wait for JS to render, and return the final HTML',
    parameters: [
      {
        name: 'url',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'URL to navigate to',
      },
      {
        name: 'options',
        type: { kind: 'reference', reference: 'BrowseOptions' },
        description: 'Navigation options: { waitFor?, timeout?, userAgent?, viewport? }',
        optional: true,
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        html: { kind: 'primitive', primitive: 'string' },
        url: { kind: 'primitive', primitive: 'string' },
        title: { kind: 'primitive', primitive: 'string' },
      },
    },
  },
  {
    name: 'screenshot',
    description: 'Navigate to a URL and return a screenshot as a base64 PNG data URI',
    parameters: [
      {
        name: 'url',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'URL to navigate to',
      },
      {
        name: 'options',
        type: { kind: 'reference', reference: 'BrowseOptions' },
        description: 'Navigation options: { waitFor?, timeout?, userAgent?, viewport? }',
        optional: true,
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        dataUri: { kind: 'primitive', primitive: 'string' },
        width: { kind: 'primitive', primitive: 'number' },
        height: { kind: 'primitive', primitive: 'number' },
      },
    },
  },
  {
    name: 'extractFromPage',
    description: 'Navigate to a URL, wait for a CSS selector, and extract matching elements',
    parameters: [
      {
        name: 'url',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'URL to navigate to',
      },
      {
        name: 'selector',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'CSS selector to extract',
      },
      {
        name: 'options',
        type: { kind: 'reference', reference: 'BrowseOptions' },
        description: 'Navigation options: { waitFor?, timeout?, userAgent?, viewport? }',
        optional: true,
      },
    ],
    returns: {
      kind: 'array',
      elementType: { kind: 'reference', reference: 'ExtractedElement' },
    },
  },
];

const STATEFUL_METHODS: MethodDeclaration[] = [
  // -- Page lifecycle --
  {
    name: 'openPage',
    description: 'Open a new persistent browser page and return its handle. The page stays open until closePage is called.',
    parameters: [
      {
        name: 'options',
        type: { kind: 'reference', reference: 'BrowseOptions' },
        description: 'Page options: { userAgent?, viewport? }',
        optional: true,
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        pageId: { kind: 'primitive', primitive: 'string' },
      },
    },
  },
  {
    name: 'closePage',
    description: 'Close a previously opened page by its handle.',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle returned by openPage',
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        success: { kind: 'primitive', primitive: 'boolean' },
      },
    },
  },
  {
    name: 'closeAllPages',
    description: 'Close all pages owned by the calling object.',
    parameters: [],
    returns: {
      kind: 'object',
      properties: {
        closed: { kind: 'primitive', primitive: 'number' },
      },
    },
  },
  // -- Navigation --
  {
    name: 'navigateTo',
    description: 'Navigate a persistent page to a URL.',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle',
      },
      {
        name: 'url',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'URL to navigate to',
      },
      {
        name: 'options',
        type: { kind: 'reference', reference: 'BrowseOptions' },
        description: 'Navigation options: { waitFor?, timeout? }',
        optional: true,
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        url: { kind: 'primitive', primitive: 'string' },
        title: { kind: 'primitive', primitive: 'string' },
      },
    },
  },
  // -- Interaction --
  {
    name: 'click',
    description: 'Click an element on a persistent page.',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle',
      },
      {
        name: 'selector',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'CSS selector of element to click',
      },
      {
        name: 'options',
        type: { kind: 'reference', reference: 'ClickOptions' },
        description: 'Click options: { button?, clickCount?, delay? }',
        optional: true,
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        success: { kind: 'primitive', primitive: 'boolean' },
      },
    },
  },
  {
    name: 'fill',
    description: 'Clear and fill an input element on a persistent page.',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle',
      },
      {
        name: 'selector',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'CSS selector of input element',
      },
      {
        name: 'value',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Value to fill',
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        success: { kind: 'primitive', primitive: 'boolean' },
      },
    },
  },
  {
    name: 'type',
    description: 'Type text into an element on a persistent page (simulates keystrokes).',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle',
      },
      {
        name: 'selector',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'CSS selector of element',
      },
      {
        name: 'text',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Text to type',
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        success: { kind: 'primitive', primitive: 'boolean' },
      },
    },
  },
  {
    name: 'select',
    description: 'Select option(s) in a <select> element.',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle',
      },
      {
        name: 'selector',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'CSS selector of <select> element',
      },
      {
        name: 'values',
        type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
        description: 'Option values to select',
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        selected: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
      },
    },
  },
  {
    name: 'hover',
    description: 'Hover over an element on a persistent page.',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle',
      },
      {
        name: 'selector',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'CSS selector of element to hover',
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        success: { kind: 'primitive', primitive: 'boolean' },
      },
    },
  },
  {
    name: 'press',
    description: 'Press a keyboard key (e.g. "Enter", "Tab", "ArrowDown").',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle',
      },
      {
        name: 'key',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Key to press (e.g. "Enter", "Tab", "Escape", "ArrowDown")',
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        success: { kind: 'primitive', primitive: 'boolean' },
      },
    },
  },
  {
    name: 'check',
    description: 'Check a checkbox element.',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle',
      },
      {
        name: 'selector',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'CSS selector of checkbox',
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        success: { kind: 'primitive', primitive: 'boolean' },
      },
    },
  },
  {
    name: 'uncheck',
    description: 'Uncheck a checkbox element.',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle',
      },
      {
        name: 'selector',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'CSS selector of checkbox',
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        success: { kind: 'primitive', primitive: 'boolean' },
      },
    },
  },
  // -- Waiting --
  {
    name: 'waitForSelector',
    description: 'Wait for a CSS selector to appear on a persistent page. Returns {found: false} on timeout instead of throwing.',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle',
      },
      {
        name: 'selector',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'CSS selector to wait for',
      },
      {
        name: 'options',
        type: { kind: 'reference', reference: 'WaitOptions' },
        description: 'Wait options: { timeout?, state? }',
        optional: true,
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        found: { kind: 'primitive', primitive: 'boolean' },
      },
    },
  },
  // -- Reading state --
  {
    name: 'getContent',
    description: 'Get the full HTML content, URL, and title of a persistent page.',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle',
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        html: { kind: 'primitive', primitive: 'string' },
        url: { kind: 'primitive', primitive: 'string' },
        title: { kind: 'primitive', primitive: 'string' },
      },
    },
  },
  {
    name: 'screenshotPage',
    description: 'Take a screenshot of a persistent page.',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle',
      },
      {
        name: 'options',
        type: { kind: 'reference', reference: 'ScreenshotOptions' },
        description: 'Screenshot options: { fullPage? }',
        optional: true,
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        dataUri: { kind: 'primitive', primitive: 'string' },
        width: { kind: 'primitive', primitive: 'number' },
        height: { kind: 'primitive', primitive: 'number' },
      },
    },
  },
  {
    name: 'getAttribute',
    description: 'Get an attribute value from an element on a persistent page.',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle',
      },
      {
        name: 'selector',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'CSS selector of element',
      },
      {
        name: 'attribute',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Attribute name to read',
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        value: {
          kind: 'union',
          variants: [
            { kind: 'primitive', primitive: 'string' },
            { kind: 'primitive', primitive: 'null' },
          ],
        },
      },
    },
  },
  {
    name: 'getTextContent',
    description: 'Get the text content of an element on a persistent page.',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle',
      },
      {
        name: 'selector',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'CSS selector of element',
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        text: {
          kind: 'union',
          variants: [
            { kind: 'primitive', primitive: 'string' },
            { kind: 'primitive', primitive: 'null' },
          ],
        },
      },
    },
  },
  {
    name: 'getUrl',
    description: 'Get the current URL of a persistent page.',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle',
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        url: { kind: 'primitive', primitive: 'string' },
      },
    },
  },
  {
    name: 'getTitle',
    description: 'Get the current title of a persistent page.',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle',
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        title: { kind: 'primitive', primitive: 'string' },
      },
    },
  },
  // -- Escape hatch --
  {
    name: 'evaluate',
    description: 'Execute a JavaScript expression in the context of a persistent page and return the result.',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle',
      },
      {
        name: 'script',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'JavaScript expression to evaluate',
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        result: { kind: 'reference', reference: 'any' },
      },
    },
  },
];

/**
 * WebBrowser capability object — headless browser via Playwright.
 */
export class WebBrowser extends Abject {
  private browser: unknown = null;
  private chromium: unknown = null;
  private pages: Map<string, TrackedPage> = new Map();
  private pageCounter = 0;

  constructor() {
    super({
      manifest: {
        name: 'WebBrowser',
        description:
          'Headless browser automation. Navigate to URLs, wait for JavaScript to render, extract rendered HTML, take screenshots, query elements, and interact with pages via a stateful page API (open → navigate → click/fill/type → read → close).',
        version: '2.0.0',
        interface: {
            id: WEB_BROWSER_INTERFACE,
            name: 'WebBrowser',
            description: 'Headless browser operations — one-shot and stateful page API',
            methods: [...ONE_SHOT_METHODS, ...STATEFUL_METHODS],
          },
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.WEB_BROWSE],
        tags: ['capability', 'web', 'browser'],
      },
    });

    this.setupOneShotHandlers();
    this.setupStatefulHandlers();
    this.setupCleanupHandlers();
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private generatePageId(): string {
    return `page-${++this.pageCounter}-${Date.now()}`;
  }

  private getTrackedPage(pageId: string, requesterId: AbjectId): TrackedPage {
    const tracked = this.pages.get(pageId);
    requireContract(tracked !== undefined, `Unknown page handle: ${pageId}`);
    requireContract(tracked!.owner === requesterId,
      `Page ${pageId} is owned by ${tracked!.owner}, not ${requesterId}`);
    tracked!.lastActivity = Date.now();
    return tracked!;
  }

  private async closePagesForOwner(ownerId: AbjectId): Promise<number> {
    let closed = 0;
    for (const [pageId, tracked] of this.pages.entries()) {
      if (tracked.owner === ownerId) {
        this.pages.delete(pageId);
        try { await tracked.page.close(); } catch { /* already closed */ }
        closed++;
      }
    }
    return closed;
  }

  private async closeAllTrackedPages(): Promise<void> {
    for (const [pageId, tracked] of this.pages.entries()) {
      this.pages.delete(pageId);
      try { await tracked.page.close(); } catch { /* already closed */ }
    }
  }

  /**
   * Register a deferred handler for a stateful page method.
   * Extracts pageId from payload, validates ownership, runs `fn` with the
   * tracked page, and sends the deferred reply or error automatically.
   */
  private deferredPageHandler(
    method: string,
    fn: (tracked: TrackedPage, payload: Record<string, unknown>, msg: AbjectMessage) => Promise<unknown>,
  ): void {
    this.on(method, (msg: AbjectMessage) => {
      const payload = msg.payload as Record<string, unknown>;
      try {
        const tracked = this.getTrackedPage(payload.pageId as string, msg.routing.from);
        fn(tracked, payload, msg).then(
          (result) => this.sendDeferredReply(msg, result).catch(() => {}),
          (err) => {
            this.send(error(msg, 'BROWSER_ERROR',
              err instanceof Error ? err.message : String(err)
            )).catch(() => {});
          },
        );
      } catch (err) {
        this.send(error(msg, 'BROWSER_ERROR',
          err instanceof Error ? err.message : String(err)
        )).catch(() => {});
      }
      return DEFERRED_REPLY;
    });
  }

  // ===========================================================================
  // One-shot handlers (existing stateless methods — unchanged behavior)
  // ===========================================================================

  private setupOneShotHandlers(): void {
    this.on('getRenderedHtml', (msg: AbjectMessage) => {
      const { url, options } = msg.payload as { url: string; options?: BrowseOptions };
      this.doGetRenderedHtml(url, options).then(
        (result) => this.sendDeferredReply(msg, result).catch(() => {}),
        (err) => {
          this.send(error(msg, 'BROWSER_ERROR',
            err instanceof Error ? err.message : String(err)
          )).catch(() => {});
        },
      );
      return DEFERRED_REPLY;
    });

    this.on('screenshot', (msg: AbjectMessage) => {
      const { url, options } = msg.payload as { url: string; options?: BrowseOptions };
      this.doScreenshot(url, options).then(
        (result) => this.sendDeferredReply(msg, result).catch(() => {}),
        (err) => {
          this.send(error(msg, 'BROWSER_ERROR',
            err instanceof Error ? err.message : String(err)
          )).catch(() => {});
        },
      );
      return DEFERRED_REPLY;
    });

    this.on('extractFromPage', (msg: AbjectMessage) => {
      const { url, selector, options } = msg.payload as {
        url: string; selector: string; options?: BrowseOptions;
      };
      this.doExtractFromPage(url, selector, options).then(
        (result) => this.sendDeferredReply(msg, result).catch(() => {}),
        (err) => {
          this.send(error(msg, 'BROWSER_ERROR',
            err instanceof Error ? err.message : String(err)
          )).catch(() => {});
        },
      );
      return DEFERRED_REPLY;
    });
  }

  // ===========================================================================
  // Stateful page handlers
  // ===========================================================================

  private setupStatefulHandlers(): void {
    // -- openPage: special case — no existing pageId to validate --
    this.on('openPage', (msg: AbjectMessage) => {
      const { options } = msg.payload as { options?: BrowseOptions };
      this.doOpenPage(msg.routing.from, options).then(
        (result) => this.sendDeferredReply(msg, result).catch(() => {}),
        (err) => {
          this.send(error(msg, 'BROWSER_ERROR',
            err instanceof Error ? err.message : String(err)
          )).catch(() => {});
        },
      );
      return DEFERRED_REPLY;
    });

    // -- closePage --
    this.deferredPageHandler('closePage', async (tracked, payload) => {
      const pageId = payload.pageId as string;
      this.pages.delete(pageId);
      try { await tracked.page.close(); } catch { /* already closed */ }
      return { success: true };
    });

    // -- closeAllPages: special case — no pageId, uses msg.routing.from --
    this.on('closeAllPages', (msg: AbjectMessage) => {
      this.closePagesForOwner(msg.routing.from).then(
        (closed) => this.sendDeferredReply(msg, { closed }).catch(() => {}),
        (err) => {
          this.send(error(msg, 'BROWSER_ERROR',
            err instanceof Error ? err.message : String(err)
          )).catch(() => {});
        },
      );
      return DEFERRED_REPLY;
    });

    // -- navigateTo --
    this.deferredPageHandler('navigateTo', async (tracked, payload) => {
      const url = payload.url as string;
      const options = payload.options as BrowseOptions | undefined;
      await this.navigatePage(tracked.page, url, options);
      return { url: tracked.page.url(), title: await tracked.page.title() };
    });

    // -- click --
    this.deferredPageHandler('click', async (tracked, payload) => {
      const selector = payload.selector as string;
      const options = payload.options as Record<string, unknown> | undefined;
      await tracked.page.click(selector, options);
      return { success: true };
    });

    // -- fill --
    this.deferredPageHandler('fill', async (tracked, payload) => {
      await tracked.page.fill(payload.selector as string, payload.value as string);
      return { success: true };
    });

    // -- type --
    this.deferredPageHandler('type', async (tracked, payload) => {
      await tracked.page.type(payload.selector as string, payload.text as string);
      return { success: true };
    });

    // -- select --
    this.deferredPageHandler('select', async (tracked, payload) => {
      const selected = await tracked.page.selectOption(
        payload.selector as string,
        payload.values as string[],
      );
      return { selected };
    });

    // -- hover --
    this.deferredPageHandler('hover', async (tracked, payload) => {
      await tracked.page.hover(payload.selector as string);
      return { success: true };
    });

    // -- press: uses page.keyboard.press, no selector --
    this.deferredPageHandler('press', async (tracked, payload) => {
      await tracked.page.keyboard.press(payload.key as string);
      return { success: true };
    });

    // -- check --
    this.deferredPageHandler('check', async (tracked, payload) => {
      await tracked.page.check(payload.selector as string);
      return { success: true };
    });

    // -- uncheck --
    this.deferredPageHandler('uncheck', async (tracked, payload) => {
      await tracked.page.uncheck(payload.selector as string);
      return { success: true };
    });

    // -- waitForSelector --
    this.deferredPageHandler('waitForSelector', async (tracked, payload) => {
      const selector = payload.selector as string;
      const options = payload.options as { timeout?: number; state?: string } | undefined;
      try {
        await tracked.page.waitForSelector(selector, {
          timeout: options?.timeout ?? 30000,
          ...(options?.state ? { state: options.state } : {}),
        });
        return { found: true };
      } catch {
        return { found: false };
      }
    });

    // -- getContent --
    this.deferredPageHandler('getContent', async (tracked) => {
      return {
        html: await tracked.page.content(),
        url: tracked.page.url(),
        title: await tracked.page.title(),
      };
    });

    // -- screenshotPage --
    this.deferredPageHandler('screenshotPage', async (tracked, payload) => {
      const options = payload.options as { fullPage?: boolean } | undefined;
      const buffer = await tracked.page.screenshot({
        type: 'png',
        fullPage: options?.fullPage ?? false,
      });
      const b64 = Buffer.from(buffer).toString('base64');
      const viewport = tracked.page.viewportSize() ?? { width: 1280, height: 720 };
      return {
        dataUri: `data:image/png;base64,${b64}`,
        width: viewport.width,
        height: viewport.height,
      };
    });

    // -- getAttribute --
    this.deferredPageHandler('getAttribute', async (tracked, payload) => {
      const value = await tracked.page.getAttribute(
        payload.selector as string,
        payload.attribute as string,
      );
      return { value };
    });

    // -- getTextContent --
    this.deferredPageHandler('getTextContent', async (tracked, payload) => {
      const text = await tracked.page.textContent(payload.selector as string);
      return { text };
    });

    // -- getUrl --
    this.deferredPageHandler('getUrl', async (tracked) => {
      return { url: tracked.page.url() };
    });

    // -- getTitle --
    this.deferredPageHandler('getTitle', async (tracked) => {
      return { title: await tracked.page.title() };
    });

    // -- evaluate --
    this.deferredPageHandler('evaluate', async (tracked, payload) => {
      const result = await tracked.page.evaluate(payload.script as string);
      return { result };
    });
  }

  // ===========================================================================
  // Cleanup handlers
  // ===========================================================================

  private setupCleanupHandlers(): void {
    this.on('objectUnregistered', async (msg: AbjectMessage) => {
      const objectId = msg.payload as AbjectId;
      await this.closePagesForOwner(objectId);
    });
  }

  protected override async onInit(): Promise<void> {
    const registryId = await this.discoverDep('Registry');
    if (registryId) {
      try {
        await this.request(request(this.id, registryId,
          'subscribe', {}));
      } catch { /* best effort */ }
    }
  }

  // ===========================================================================
  // Page creation
  // ===========================================================================

  private async doOpenPage(
    owner: AbjectId,
    options?: BrowseOptions,
  ): Promise<{ pageId: string }> {
    const page = await this.createPage(options) as PlaywrightPage;
    const pageId = this.generatePageId();

    const tracked: TrackedPage = {
      page,
      owner,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    this.pages.set(pageId, tracked);

    // Auto-remove from map if the page closes externally
    page.on('close', () => {
      this.pages.delete(pageId);
    });

    return { pageId };
  }

  // ===========================================================================
  // Browser lifecycle
  // ===========================================================================

  /**
   * Lazy-launch the browser on first use.
   */
  private async ensureBrowser(): Promise<unknown> {
    if (this.browser) return this.browser;

    try {
      const pw = await import('playwright');
      this.chromium = pw.chromium;
      this.browser = await (this.chromium as { launch: (opts: unknown) => Promise<unknown> }).launch({
        headless: true,
      });

      // If the browser disconnects unexpectedly, clear all tracked pages
      (this.browser as { on: (event: string, fn: () => void) => void }).on('disconnected', () => {
        this.pages.clear();
        this.browser = null;
      });

      return this.browser;
    } catch (err) {
      throw new Error(
        `WebBrowser requires playwright. Install with: pnpm add playwright && pnpm exec playwright install chromium. ` +
        `Error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Create a new page with the given options.
   */
  private async createPage(options?: BrowseOptions): Promise<unknown> {
    const browser = await this.ensureBrowser() as {
      newPage: (opts?: unknown) => Promise<unknown>;
    };

    const pageOpts: Record<string, unknown> = {};
    if (options?.userAgent) pageOpts.userAgent = options.userAgent;
    if (options?.viewport) pageOpts.viewport = options.viewport;

    return browser.newPage(Object.keys(pageOpts).length > 0 ? pageOpts : undefined);
  }

  /**
   * Navigate a page to a URL and wait for content.
   */
  private async navigatePage(
    page: Pick<PlaywrightPage, 'goto' | 'waitForSelector'>,
    url: string,
    options?: BrowseOptions,
  ): Promise<void> {
    const timeout = options?.timeout ?? 30000;
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout,
    });
    if (options?.waitFor) {
      await page.waitForSelector(options.waitFor, { timeout });
    }
  }

  // ===========================================================================
  // One-shot implementations (unchanged behavior)
  // ===========================================================================

  private async doGetRenderedHtml(
    url: string,
    options?: BrowseOptions,
  ): Promise<{ html: string; url: string; title: string }> {
    const page = await this.createPage(options) as PlaywrightPage;
    try {
      await this.navigatePage(page, url, options);
      const html = await page.content();
      const finalUrl = page.url();
      const title = await page.title();
      return { html, url: finalUrl, title };
    } finally {
      await page.close();
    }
  }

  private async doScreenshot(
    url: string,
    options?: BrowseOptions,
  ): Promise<{ dataUri: string; width: number; height: number }> {
    const page = await this.createPage(options) as PlaywrightPage;
    try {
      await this.navigatePage(page, url, options);
      const buffer = await page.screenshot({ type: 'png', fullPage: false });
      const b64 = Buffer.from(buffer).toString('base64');
      const dataUri = `data:image/png;base64,${b64}`;
      const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
      return { dataUri, width: viewport.width, height: viewport.height };
    } finally {
      await page.close();
    }
  }

  private async doExtractFromPage(
    url: string,
    selector: string,
    options?: BrowseOptions,
  ): Promise<ExtractedElement[]> {
    const page = await this.createPage(options) as PlaywrightPage;
    try {
      await this.navigatePage(page, url, { ...options, waitFor: options?.waitFor ?? selector });
      const results = await page.$$eval(selector, (els: Element[]) => {
        return els.map(el => {
          const attributes: Record<string, string> = {};
          for (const attr of el.attributes) {
            attributes[attr.name] = attr.value;
          }
          return {
            tag: el.tagName.toLowerCase(),
            text: el.textContent ?? '',
            attributes,
            innerHTML: el.innerHTML,
          };
        });
      });
      return results as ExtractedElement[];
    } finally {
      await page.close();
    }
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  protected override async onStop(): Promise<void> {
    await this.closeAllTrackedPages();
    if (this.browser) {
      try {
        await (this.browser as { close: () => Promise<void> }).close();
      } catch { /* ignore cleanup errors */ }
      this.browser = null;
    }
  }

  protected override getSourceForAsk(): string | undefined {
    return `## WebBrowser Usage Guide

Use WebBrowser for JavaScript-rendered pages (React SPAs, Instagram, Twitter, etc.).
For static HTML pages, prefer HttpClient.get() + WebParser instead.

### ONE-SHOT METHODS (open, do work, auto-close)

#### Get Rendered HTML (after JS executes)

  const result = await this.call(
    this.dep('WebBrowser'), 'getRenderedHtml',
    { url: 'https://example.com', options: { timeout: 30000 } });
  // result = { html: '<html>...</html>', url: 'https://example.com', title: 'Example' }

#### Take a Screenshot

  const result = await this.call(
    this.dep('WebBrowser'), 'screenshot',
    { url: 'https://example.com' });
  // result = { dataUri: 'data:image/png;base64,...', width: 1280, height: 720 }

#### Extract Elements from Rendered Page

  const elements = await this.call(
    this.dep('WebBrowser'), 'extractFromPage',
    { url: 'https://example.com', selector: 'img',
      options: { waitFor: 'img', timeout: 15000 } });
  // elements = [{ tag: 'img', text: '', attributes: { src: '...', alt: '...' }, innerHTML: '' }]

### STATEFUL PAGE API (open a persistent page, interact step-by-step)

Use this when you need to interact with a web app: fill forms, click buttons, navigate between pages, etc.

#### Open a page, navigate, interact, read results, close

  const { pageId } = await this.call(
    this.dep('WebBrowser'), 'openPage',
    { options: { viewport: { width: 1280, height: 720 } } });

  await this.call(this.dep('WebBrowser'), 'navigateTo',
    { pageId, url: 'https://example.com/login' });

  await this.call(this.dep('WebBrowser'), 'fill',
    { pageId, selector: '#username', value: 'myuser' });

  await this.call(this.dep('WebBrowser'), 'fill',
    { pageId, selector: '#password', value: 'mypass' });

  await this.call(this.dep('WebBrowser'), 'click',
    { pageId, selector: 'button[type="submit"]' });

  await this.call(this.dep('WebBrowser'), 'waitForSelector',
    { pageId, selector: '.dashboard' });

  const { html, url, title } = await this.call(
    this.dep('WebBrowser'), 'getContent', { pageId });

  const shot = await this.call(
    this.dep('WebBrowser'), 'screenshotPage', { pageId });

  await this.call(this.dep('WebBrowser'), 'closePage', { pageId });

#### Available stateful methods

Page lifecycle: openPage, closePage, closeAllPages
Navigation:    navigateTo(pageId, url, options?)
Interaction:   click, fill, type, select, hover, press, check, uncheck
Waiting:       waitForSelector(pageId, selector, options?) — returns {found: false} on timeout
Reading:       getContent, screenshotPage, getAttribute, getTextContent, getUrl, getTitle
Escape hatch:  evaluate(pageId, script) — run arbitrary JS in page context

### IMPORTANT
- ALWAYS close pages when done (closePage or closeAllPages). Leaked pages consume memory.
- Pages are automatically cleaned up if the owning object is unregistered.
- press(pageId, key) sends a keyboard key (e.g. "Enter", "Tab") — no selector needed.
- waitForSelector returns {found: false} on timeout instead of throwing an error.

### Options

One-shot methods accept an optional 'options' object:
  { waitFor: 'CSS selector to wait for',
    timeout: 30000,  // ms
    userAgent: 'custom user agent string',
    viewport: { width: 1280, height: 720 } }

### Pattern: Display Screenshots on Surface

  const shot = await this.call(this.dep('WebBrowser'), 'screenshot',
    { url: 'https://example.com', options: { viewport: { width: 800, height: 600 } } });
  await this.call(this.dep('UIServer'), 'draw', {
    commands: [{ type: 'imageUrl', surfaceId, params: { x: 0, y: 0, width: 400, height: 300, url: shot.dataUri } }]
  });`;
  }
}

// Well-known WebBrowser ID
export const WEB_BROWSER_ID = 'abjects:web-browser' as AbjectId;
