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
import { Log } from '../../core/timed-log.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

const log = new Log('WebBrowser');

const WEB_BROWSER_INTERFACE = 'abjects:web-browser';

interface BrowseOptions {
  waitFor?: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  timeout?: number;
  userAgent?: string;
  viewport?: { width: number; height: number };
  /**
   * Named persistent profile in the caller's workspace. Cookies, localStorage,
   * IndexedDB, and service workers survive across calls and process restarts.
   * Omit (or empty) for a fresh ephemeral session.
   */
  profile?: string;
  /**
   * Launch a real, non-headless browser for this page. Headless Chromium fails
   * anti-bot fingerprints (Cloudflare Turnstile etc.) even when a human clicks
   * the challenge via the viewer takeover; headful passes them. Needs a display
   * (desktop OS or the packaged app). Default false (headless). Cross-platform.
   */
  headful?: boolean;
  /**
   * Browser channel to launch, e.g. 'chrome' or 'msedge' to drive the user's
   * installed branded browser instead of bundled Chromium (stronger, real
   * fingerprint). Falls back to bundled Chromium if the channel isn't
   * installed. When headful, defaults to 'chrome'.
   */
  channel?: string;
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
  goBack: (opts?: unknown) => Promise<unknown>;
  goForward: (opts?: unknown) => Promise<unknown>;
  reload: (opts?: unknown) => Promise<unknown>;
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
  keyboard: {
    press: (key: string) => Promise<void>;
    insertText: (text: string) => Promise<void>;
  };
  mouse: {
    move: (x: number, y: number, opts?: { steps?: number }) => Promise<void>;
    down: (opts?: { button?: string }) => Promise<void>;
    up: (opts?: { button?: string }) => Promise<void>;
    wheel: (deltaX: number, deltaY: number) => Promise<void>;
  };
  setContent: (html: string) => Promise<void>;
  on: (event: string, fn: () => void) => void;
  // ARIA snapshot for AI (private Playwright API, stable since ~1.49)
  _snapshotForAI: (opts: { track: string }) => Promise<{ full: string; incremental?: string }>;
  // Locator-based interaction
  locator: (selector: string) => PlaywrightLocator;
};

type PlaywrightLocator = {
  click: (opts?: unknown) => Promise<void>;
  fill: (value: string) => Promise<void>;
  type: (text: string, opts?: unknown) => Promise<void>;
  selectOption: (values: string | string[] | { label: string }) => Promise<string[]>;
  hover: () => Promise<void>;
  check: () => Promise<void>;
  uncheck: () => Promise<void>;
  textContent: () => Promise<string | null>;
  press: (key: string) => Promise<void>;
};

interface TrackedPage {
  page: PlaywrightPage;
  owner: AbjectId;
  createdAt: number;
  lastActivity: number;
  /** Profile key ({workspaceId}/{profileName}) the page was opened against, if any. */
  profileKey?: string;
}

/** A persistent BrowserContext kept alive across openPage calls for one profile. */
interface ProfileContext {
  /** Workspace this profile belongs to (parsed from the caller's typeId). */
  workspaceId: string;
  /** Profile name as supplied by the caller. */
  name: string;
  /** Cached Playwright BrowserContext. */
  context: {
    newPage: (opts?: unknown) => Promise<unknown>;
    close: () => Promise<void>;
    on: (event: string, fn: () => void) => void;
  };
  /** Absolute on-disk directory for the profile. */
  dir: string;
  /** Number of TrackedPages currently using this context. */
  openPages: number;
  /** Whether this context was launched headless (so we can relaunch it when a
   *  later call requests a different mode and no pages are open). */
  headless: boolean;
  /** Wall-clock timestamps for the metadata index. */
  createdAt: number;
  lastUsed: number;
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
        description: 'Page options: { userAgent?, viewport?, profile? (persistent login jar), headful? (launch a real non-headless browser so anti-bot/human-verification challenges like Cloudflare Turnstile can be passed via the viewer takeover — needs a display), channel? (e.g. "chrome" to drive the installed browser) }',
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
  // -- ARIA snapshot --
  {
    name: 'getAriaSnapshot',
    description: 'Get an accessibility tree snapshot of a persistent page with element refs for targeting.',
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
        snapshot: { kind: 'primitive', primitive: 'string' },
        url: { kind: 'primitive', primitive: 'string' },
        title: { kind: 'primitive', primitive: 'string' },
      },
    },
  },
  {
    name: 'refAction',
    description: 'Perform an action on an element identified by its ARIA snapshot ref.',
    parameters: [
      { name: 'pageId', type: { kind: 'primitive', primitive: 'string' }, description: 'Page handle' },
      { name: 'ref', type: { kind: 'primitive', primitive: 'string' }, description: 'Element ref from ARIA snapshot (e.g. "e5")' },
      { name: 'action', type: { kind: 'primitive', primitive: 'string' }, description: 'Action: click, fill, type, hover, check, uncheck, selectOption, press' },
      { name: 'value', type: { kind: 'primitive', primitive: 'string' }, description: 'Value for fill/type/selectOption actions', optional: true },
    ],
    returns: {
      kind: 'object',
      properties: {
        success: { kind: 'primitive', primitive: 'boolean' },
      },
    },
  },
  // -- Escape hatch --
  // -- Viewer methods (no ownership check) --
  {
    name: 'listPages',
    description: 'List all open browser pages with metadata. No ownership check — read-only viewer method.',
    parameters: [],
    returns: {
      kind: 'array',
      elementType: {
        kind: 'object',
        properties: {
          pageId: { kind: 'primitive', primitive: 'string' },
          owner: { kind: 'primitive', primitive: 'string' },
          url: { kind: 'primitive', primitive: 'string' },
          title: { kind: 'primitive', primitive: 'string' },
          createdAt: { kind: 'primitive', primitive: 'number' },
          lastActivity: { kind: 'primitive', primitive: 'number' },
        },
      },
    },
  },
  {
    name: 'viewerScreenshot',
    description: 'Take a screenshot of any page by pageId. Also returns the page\'s current URL and title so viewers can track navigation. No ownership check — read-only viewer method.',
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
        url: { kind: 'primitive', primitive: 'string' },
        title: { kind: 'primitive', primitive: 'string' },
      },
    },
  },
  {
    name: 'viewerNavigate',
    description: 'Navigate any page through its history: back, forward, or reload. No ownership check — viewer navigation method.',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle',
      },
      {
        name: 'nav',
        type: { kind: 'primitive', primitive: 'string' },
        description: "'back' | 'forward' | 'reload'",
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
  {
    name: 'viewerInput',
    description: 'Dispatch a batch of raw human input events (mouse move/down/up, wheel, key press, text insertion) to any page by pageId, in order. Events go through the browser input pipeline so pages see trusted input with real mouse trails. No ownership check — viewer takeover method.',
    parameters: [
      {
        name: 'pageId',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Page handle',
      },
      {
        name: 'events',
        type: {
          kind: 'array',
          elementType: {
            kind: 'object',
            properties: {
              type: { kind: 'primitive', primitive: 'string' },
              x: { kind: 'primitive', primitive: 'number' },
              y: { kind: 'primitive', primitive: 'number' },
              button: { kind: 'primitive', primitive: 'number' },
              deltaY: { kind: 'primitive', primitive: 'number' },
              key: { kind: 'primitive', primitive: 'string' },
              text: { kind: 'primitive', primitive: 'string' },
            },
          },
        },
        description: 'Ordered raw events: { type: "mousemove"|"mousedown"|"mouseup"|"wheel"|"key"|"insertText", x?, y?, button? (0=left,1=middle,2=right), deltaY?, key? (Playwright key name/combo like "Control+a"), text? }',
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        dispatched: { kind: 'primitive', primitive: 'number' },
      },
    },
  },
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

const PROFILE_METHODS: MethodDeclaration[] = [
  {
    name: 'listProfiles',
    description: 'List persistent browser profiles in the caller\'s workspace. Each entry is a named jar of cookies/localStorage/IndexedDB that survives across calls and process restarts.',
    parameters: [],
    returns: {
      kind: 'array',
      elementType: {
        kind: 'object',
        properties: {
          name: { kind: 'primitive', primitive: 'string' },
          createdAt: { kind: 'primitive', primitive: 'number' },
          lastUsed: { kind: 'primitive', primitive: 'number' },
          openPages: { kind: 'primitive', primitive: 'number' },
        },
      },
    },
  },
  {
    name: 'deleteProfile',
    description: 'Permanently delete a persistent browser profile (closes any open context, removes the on-disk directory, and forgets the metadata).',
    parameters: [
      {
        name: 'profile',
        type: { kind: 'primitive', primitive: 'string' },
        description: 'Profile name to delete',
      },
    ],
    returns: {
      kind: 'object',
      properties: {
        deleted: { kind: 'primitive', primitive: 'boolean' },
      },
    },
  },
];

/**
 * WebBrowser capability object — headless browser via Playwright.
 */
export class WebBrowser extends Abject {
  /** Ephemeral (non-profile) browsers, keyed by launch signature so a headless
   *  and a headful browser can coexist. */
  private ephemeralBrowsers: Map<string, unknown> = new Map();
  private chromium: unknown = null;
  private pages: Map<string, TrackedPage> = new Map();
  private pageCounter = 0;

  /** Cached persistent contexts keyed by `{workspaceId}/{profileName}`. */
  private profileContexts: Map<string, ProfileContext> = new Map();
  /** Cached AbjectId → workspaceId so we don't hit the registry on every call. */
  private callerWorkspaceCache: Map<AbjectId, string> = new Map();
  private registryId?: AbjectId;
  private storageId?: AbjectId;
  /** Absolute base dir for all on-disk profile jars. */
  private profilesRoot: string;

  /** Storage key for the profile metadata index ({name, createdAt, lastUsed}). */
  private static readonly PROFILES_INDEX_KEY = 'web-browser:profiles';

  constructor() {
    super({
      manifest: {
        name: 'WebBrowser',
        description:
          'Low-level headless browser engine. Provides raw page operations: navigate, click, fill forms, take screenshots, extract HTML, and query elements via a stateful page API (open, navigate, interact, read, close).',
        version: '2.0.0',
        interface: {
            id: WEB_BROWSER_INTERFACE,
            name: 'WebBrowser',
            description: 'Headless browser operations — one-shot and stateful page API',
            methods: [...ONE_SHOT_METHODS, ...STATEFUL_METHODS, ...PROFILE_METHODS],
          },
        requiredCapabilities: [],
        providedCapabilities: [Capabilities.WEB_BROWSE],
        tags: ['system', 'capability', 'web', 'browser'],
      },
    });

    const dataDir = process.env.ABJECTS_DATA_DIR ?? '.abjects';
    this.profilesRoot = path.resolve(dataDir, 'browser-profiles');

    this.setupOneShotHandlers();
    this.setupStatefulHandlers();
    this.setupProfileHandlers();
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
        this.releasePage(pageId);
        try { await tracked.page.close(); } catch { /* already closed */ }
        closed++;
      }
    }
    return closed;
  }

  private async closeAllTrackedPages(): Promise<void> {
    for (const [pageId, tracked] of this.pages.entries()) {
      this.releasePage(pageId);
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
          (result) => this.sendDeferredReply(msg, result),
          (err) => {
            this.send(error(msg, 'BROWSER_ERROR',
              err instanceof Error ? err.message : String(err)
            ));
          },
        );
      } catch (err) {
        this.send(error(msg, 'BROWSER_ERROR',
          err instanceof Error ? err.message : String(err)
        ));
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
      this.doGetRenderedHtml(msg.routing.from, url, options).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => {
          this.send(error(msg, 'BROWSER_ERROR',
            err instanceof Error ? err.message : String(err)
          ));
        },
      );
      return DEFERRED_REPLY;
    });

    this.on('screenshot', (msg: AbjectMessage) => {
      const { url, options } = msg.payload as { url: string; options?: BrowseOptions };
      this.doScreenshot(msg.routing.from, url, options).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => {
          this.send(error(msg, 'BROWSER_ERROR',
            err instanceof Error ? err.message : String(err)
          ));
        },
      );
      return DEFERRED_REPLY;
    });

    this.on('extractFromPage', (msg: AbjectMessage) => {
      const { url, selector, options } = msg.payload as {
        url: string; selector: string; options?: BrowseOptions;
      };
      this.doExtractFromPage(msg.routing.from, url, selector, options).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => {
          this.send(error(msg, 'BROWSER_ERROR',
            err instanceof Error ? err.message : String(err)
          ));
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
        (result) => this.sendDeferredReply(msg, result),
        (err) => {
          this.send(error(msg, 'BROWSER_ERROR',
            err instanceof Error ? err.message : String(err)
          ));
        },
      );
      return DEFERRED_REPLY;
    });

    // -- closePage --
    this.deferredPageHandler('closePage', async (tracked, payload, msg) => {
      const pageId = payload.pageId as string;
      log.info(`closePage (${pageId}) caller=${msg.routing.from}`);
      this.releasePage(pageId);
      try { await tracked.page.close(); } catch { /* already closed */ }
      this.changed('pageClosed', { pageId });
      return { success: true };
    });

    // -- closeAllPages: special case — no pageId, uses msg.routing.from --
    this.on('closeAllPages', (msg: AbjectMessage) => {
      this.closePagesForOwner(msg.routing.from).then(
        (closed) => this.sendDeferredReply(msg, { closed }),
        (err) => {
          this.send(error(msg, 'BROWSER_ERROR',
            err instanceof Error ? err.message : String(err)
          ));
        },
      );
      return DEFERRED_REPLY;
    });

    // -- navigateTo --
    this.deferredPageHandler('navigateTo', async (tracked, payload) => {
      const url = payload.url as string;
      const options = payload.options as BrowseOptions | undefined;
      const t0 = Date.now();
      await this.navigatePage(tracked.page, url, options);
      const finalUrl = tracked.page.url();
      const title = await this.safeTitle(tracked.page, finalUrl);
      log.info(`navigateTo (${payload.pageId}) → ${url} [${Date.now() - t0}ms]`);
      this.changed('pageNavigated', { pageId: payload.pageId, url: finalUrl, title });
      return { url: finalUrl, title };
    });

    // -- click --
    this.deferredPageHandler('click', async (tracked, payload) => {
      const selector = payload.selector as string;
      const options = payload.options as Record<string, unknown> | undefined;
      const t0 = Date.now();
      await tracked.page.click(selector, options);
      log.info(`click (${payload.pageId}) selector="${selector}" [${Date.now() - t0}ms]`);
      return { success: true };
    });

    // -- fill --
    this.deferredPageHandler('fill', async (tracked, payload) => {
      const t0 = Date.now();
      await tracked.page.fill(payload.selector as string, payload.value as string);
      log.info(`fill (${payload.pageId}) selector="${payload.selector}" [${Date.now() - t0}ms]`);
      return { success: true };
    });

    // -- type --
    this.deferredPageHandler('type', async (tracked, payload) => {
      const t0 = Date.now();
      await tracked.page.type(payload.selector as string, payload.text as string);
      log.info(`type (${payload.pageId}) selector="${payload.selector}" [${Date.now() - t0}ms]`);
      return { success: true };
    });

    // -- select --
    this.deferredPageHandler('select', async (tracked, payload) => {
      const t0 = Date.now();
      const selected = await tracked.page.selectOption(
        payload.selector as string,
        payload.values as string[],
      );
      log.info(`select (${payload.pageId}) selector="${payload.selector}" [${Date.now() - t0}ms]`);
      return { selected };
    });

    // -- hover --
    this.deferredPageHandler('hover', async (tracked, payload) => {
      const t0 = Date.now();
      await tracked.page.hover(payload.selector as string);
      log.info(`hover (${payload.pageId}) selector="${payload.selector}" [${Date.now() - t0}ms]`);
      return { success: true };
    });

    // -- press: uses page.keyboard.press, no selector --
    this.deferredPageHandler('press', async (tracked, payload) => {
      const t0 = Date.now();
      await tracked.page.keyboard.press(payload.key as string);
      log.info(`press (${payload.pageId}) key="${payload.key}" [${Date.now() - t0}ms]`);
      return { success: true };
    });

    // -- check --
    this.deferredPageHandler('check', async (tracked, payload) => {
      const t0 = Date.now();
      await tracked.page.check(payload.selector as string);
      log.info(`check (${payload.pageId}) selector="${payload.selector}" [${Date.now() - t0}ms]`);
      return { success: true };
    });

    // -- uncheck --
    this.deferredPageHandler('uncheck', async (tracked, payload) => {
      const t0 = Date.now();
      await tracked.page.uncheck(payload.selector as string);
      log.info(`uncheck (${payload.pageId}) selector="${payload.selector}" [${Date.now() - t0}ms]`);
      return { success: true };
    });

    // -- waitForSelector --
    this.deferredPageHandler('waitForSelector', async (tracked, payload) => {
      const selector = payload.selector as string;
      const options = payload.options as { timeout?: number; state?: string } | undefined;
      const t0 = Date.now();
      try {
        await tracked.page.waitForSelector(selector, {
          timeout: options?.timeout ?? 30000,
          ...(options?.state ? { state: options.state } : {}),
        });
        log.info(`waitForSelector (${payload.pageId}) selector="${selector}" found [${Date.now() - t0}ms]`);
        return { found: true };
      } catch {
        log.info(`waitForSelector (${payload.pageId}) selector="${selector}" not found [${Date.now() - t0}ms]`);
        return { found: false };
      }
    });

    // -- getContent --
    this.deferredPageHandler('getContent', async (tracked) => {
      const url = tracked.page.url();
      return {
        html: await this.safeContent(tracked.page, `<!-- content unavailable for ${url} -->`),
        url,
        title: await this.safeTitle(tracked.page, url),
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
      const viewport = this.safeViewportSize(tracked.page);
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

    // -- getAriaSnapshot --
    this.deferredPageHandler('getAriaSnapshot', async (tracked) => {
      const t0 = Date.now();
      const url = tracked.page.url();
      const title = await this.safeTitle(tracked.page, url);
      const result = await tracked.page._snapshotForAI({ track: 'response' });
      log.info(`getAriaSnapshot (url=${url}) [${Date.now() - t0}ms]`);
      return { snapshot: result.full, url, title };
    });

    // -- refAction --
    this.deferredPageHandler('refAction', async (tracked, payload) => {
      const ref = payload.ref as string;
      const action = payload.action as string;
      const value = payload.value as string | undefined;
      const t0 = Date.now();

      const locator = tracked.page.locator(`aria-ref=${ref}`);

      switch (action) {
        case 'click':
          await locator.click();
          break;
        case 'fill':
          await locator.fill(value ?? '');
          break;
        case 'type':
          await locator.type(value ?? '');
          break;
        case 'hover':
          await locator.hover();
          break;
        case 'check':
          await locator.check();
          break;
        case 'uncheck':
          await locator.uncheck();
          break;
        case 'selectOption':
          await locator.selectOption(value ? { label: value } : '');
          break;
        case 'press':
          await locator.press(value ?? '');
          break;
        default:
          throw new Error(`Unknown ref action: ${action}`);
      }

      log.info(`refAction (${payload.pageId}) ${action} ref=${ref} [${Date.now() - t0}ms]`);
      return { success: true };
    });

    // -- evaluate --
    this.deferredPageHandler('evaluate', async (tracked, payload) => {
      const t0 = Date.now();
      const script = (payload.script as string).trim();
      const safeScript = /\breturn\b/.test(script)
        ? `(function(){ ${script} })()`
        : script;
      const result = await tracked.page.evaluate(safeScript);
      log.info(`evaluate (${payload.pageId}) [${Date.now() - t0}ms]`);
      return { result };
    });

    // -- listPages: no ownership check --
    this.on('listPages', (msg: AbjectMessage) => {
      const results: Array<{
        pageId: string; owner: string; url: string; title: string;
        createdAt: number; lastActivity: number;
      }> = [];
      const titlePromises: Array<Promise<void>> = [];
      for (const [pageId, tracked] of this.pages.entries()) {
        const entry = {
          pageId,
          owner: tracked.owner,
          url: tracked.page.url(),
          title: '',
          createdAt: tracked.createdAt,
          lastActivity: tracked.lastActivity,
        };
        results.push(entry);
        titlePromises.push(
          tracked.page.title().then((t) => { entry.title = t; }).catch(() => { /* title stays '' */ }),
        );
      }
      Promise.all(titlePromises).then(
        () => this.sendDeferredReply(msg, results),
      );
      return DEFERRED_REPLY;
    });

    // -- viewerScreenshot: no ownership check --
    this.on('viewerScreenshot', (msg: AbjectMessage) => {
      const { pageId, options } = msg.payload as {
        pageId: string; options?: { fullPage?: boolean };
      };
      const tracked = this.pages.get(pageId);
      if (!tracked) {
        this.send(error(msg, 'BROWSER_ERROR', `Unknown page handle: ${pageId}`));
        return DEFERRED_REPLY;
      }
      tracked.page.screenshot({
        type: 'png',
        fullPage: options?.fullPage ?? false,
      }).then(async (buffer) => {
        const b64 = Buffer.from(buffer).toString('base64');
        const viewport = this.safeViewportSize(tracked.page);
        const url = tracked.page.url();
        const title = await this.safeTitle(tracked.page, url);
        this.sendDeferredReply(msg, {
          dataUri: `data:image/png;base64,${b64}`,
          width: viewport.width,
          height: viewport.height,
          url,
          title,
        });
      }).catch((err) => {
        this.send(error(msg, 'BROWSER_ERROR',
          err instanceof Error ? err.message : String(err)
        ));
      });
      return DEFERRED_REPLY;
    });

    // -- viewerNavigate: no ownership check — history navigation from the viewer --
    this.on('viewerNavigate', (msg: AbjectMessage) => {
      const { pageId, nav } = msg.payload as { pageId: string; nav: string };
      requireContract(nav === 'back' || nav === 'forward' || nav === 'reload',
        "viewerNavigate nav must be 'back', 'forward', or 'reload'");
      const tracked = this.pages.get(pageId);
      if (!tracked) {
        this.send(error(msg, 'BROWSER_ERROR', `Unknown page handle: ${pageId}`));
        return DEFERRED_REPLY;
      }
      const go = nav === 'back' ? tracked.page.goBack({ waitUntil: 'domcontentloaded' })
        : nav === 'forward' ? tracked.page.goForward({ waitUntil: 'domcontentloaded' })
        : tracked.page.reload({ waitUntil: 'domcontentloaded' });
      go.then(async () => {
        tracked.lastActivity = Date.now();
        const url = tracked.page.url();
        const title = await this.safeTitle(tracked.page, url);
        this.changed('pageNavigated', { pageId, url, title });
        this.sendDeferredReply(msg, { url, title });
      }).catch((err) => {
        this.send(error(msg, 'BROWSER_ERROR',
          err instanceof Error ? err.message : String(err)
        ));
      });
      return DEFERRED_REPLY;
    });

    // -- viewerInput: no ownership check — human takeover from the viewer --
    this.on('viewerInput', (msg: AbjectMessage) => {
      const { pageId, events } = msg.payload as {
        pageId: string;
        events: Array<{
          type: string; x?: number; y?: number; button?: number;
          deltaY?: number; key?: string; text?: string;
        }>;
      };
      requireContract(Array.isArray(events), 'viewerInput requires an events array');
      const tracked = this.pages.get(pageId);
      if (!tracked) {
        this.send(error(msg, 'BROWSER_ERROR', `Unknown page handle: ${pageId}`));
        return DEFERRED_REPLY;
      }
      this.dispatchViewerInput(tracked, events).then(
        (dispatched) => this.sendDeferredReply(msg, { dispatched }),
        (err) => {
          this.send(error(msg, 'BROWSER_ERROR',
            err instanceof Error ? err.message : String(err)
          ));
        },
      );
      return DEFERRED_REPLY;
    });
  }

  /** Playwright mouse button names by DOM button index. */
  private static readonly MOUSE_BUTTONS = ['left', 'middle', 'right'] as const;

  /**
   * Replay raw human input events on a page, in order, through Playwright's
   * mouse/keyboard (CDP-level trusted input). Returns the count dispatched.
   */
  private async dispatchViewerInput(
    tracked: TrackedPage,
    events: Array<{
      type: string; x?: number; y?: number; button?: number;
      deltaY?: number; key?: string; text?: string;
    }>,
  ): Promise<number> {
    const page = tracked.page;
    let dispatched = 0;
    for (const ev of events) {
      switch (ev.type) {
        case 'mousemove':
          await page.mouse.move(ev.x ?? 0, ev.y ?? 0);
          break;
        case 'mousedown':
          await page.mouse.down({ button: WebBrowser.MOUSE_BUTTONS[ev.button ?? 0] ?? 'left' });
          break;
        case 'mouseup':
          await page.mouse.up({ button: WebBrowser.MOUSE_BUTTONS[ev.button ?? 0] ?? 'left' });
          break;
        case 'wheel':
          if (ev.x !== undefined && ev.y !== undefined) {
            await page.mouse.move(ev.x, ev.y);
          }
          await page.mouse.wheel(0, ev.deltaY ?? 0);
          break;
        case 'key':
          if (ev.key) await page.keyboard.press(ev.key);
          break;
        case 'insertText':
          if (ev.text) await page.keyboard.insertText(ev.text);
          break;
        default:
          continue; // unknown event types are skipped, not fatal
      }
      dispatched++;
    }
    tracked.lastActivity = Date.now();
    return dispatched;
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
    this.registryId = registryId ?? undefined;
    if (registryId) {
      try {
        await this.request(request(this.id, registryId,
          'subscribe', {}));
      } catch { /* best effort */ }
    }
    this.storageId = await this.discoverDep('Storage') ?? undefined;
  }

  // ===========================================================================
  // Page creation
  // ===========================================================================

  private async doOpenPage(
    owner: AbjectId,
    options?: BrowseOptions,
  ): Promise<{ pageId: string }> {
    const profileKey = await this.resolveProfileKey(owner, options?.profile);
    const page = await this.createPage(owner, options) as PlaywrightPage;
    const pageId = this.generatePageId();

    const tracked: TrackedPage = {
      page,
      owner,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      profileKey,
    };

    this.pages.set(pageId, tracked);
    if (profileKey) {
      const ctx = this.profileContexts.get(profileKey);
      if (ctx) ctx.openPages++;
    }
    log.info(`openPage → ${pageId}${profileKey ? ` (profile=${profileKey})` : ''}`);
    this.changed('pageOpened', { pageId, owner });

    // Auto-remove from map if the page closes externally
    page.on('close', () => {
      this.releasePage(pageId);
      this.changed('pageClosed', { pageId });
    });

    return { pageId };
  }

  /**
   * Untrack a page and decrement its profile's open-page count, exactly once.
   * Idempotent: a page closed via closePage and then again by Playwright's
   * 'close' event only releases the first time. (The old split — delete in
   * closePage, decrement in the 'close' handler — leaked the counter because
   * the handler's delete found nothing, so profile contexts looked permanently
   * busy and never relaunched for a mode change.)
   */
  private releasePage(pageId: string): void {
    const tracked = this.pages.get(pageId);
    if (!tracked) return;
    this.pages.delete(pageId);
    if (tracked.profileKey) {
      const ctx = this.profileContexts.get(tracked.profileKey);
      if (ctx && ctx.openPages > 0) ctx.openPages--;
    }
  }

  /** Authoritative count of live pages on a profile context (scans the page
   *  map rather than trusting the openPages counter). */
  private liveProfilePages(profileKey: string): number {
    let n = 0;
    for (const p of this.pages.values()) if (p.profileKey === profileKey) n++;
    return n;
  }

  // ===========================================================================
  // Browser lifecycle
  // ===========================================================================

  /**
   * Whether to launch headless for a given call. Default headless; the caller
   * opts into a real (non-headless) browser per page via options.headful, which
   * an agent sets for sites behind anti-bot / human-verification challenges
   * (Cloudflare Turnstile etc.) so the viewer takeover can actually pass them.
   * Global override: ABJECTS_BROWSER_HEADFUL=1 (force headful) / =0 (force
   * headless) applies when the per-call option is unset.
   */
  private browserHeadless(options?: BrowseOptions): boolean {
    if (options?.headful !== undefined) return !options.headful;
    const v = process.env.ABJECTS_BROWSER_HEADFUL;
    if (v === '1' || v === 'true') return false;
    if (v === '0' || v === 'false') return true;
    return true;
  }

  /**
   * Shared Playwright launch options for both the ephemeral and persistent
   * paths. Always disables the AutomationControlled blink feature (clears
   * navigator.webdriver, harmless when not being fingerprinted). When running
   * headful, prefers the installed Google Chrome (real branded fingerprint and
   * real-GPU WebGL) over bundled Chromium, whose SwiftShader renderer is itself
   * a bot signal — launchWithFallback drops the channel if Chrome is absent.
   * Cross-platform: no OS-specific args beyond the packaged-Electron sandbox
   * flags; the 'chrome' channel resolves the installed browser on any OS.
   */
  private baseLaunchOptions(options?: BrowseOptions): Record<string, unknown> {
    const headless = this.browserHeadless(options);
    const args: string[] = ['--disable-blink-features=AutomationControlled'];
    // Inside an Electron AppImage, the Chromium sandbox requires SUID or user
    // namespaces which are restricted. Same issue afterPack.cjs solves for the
    // Electron binary itself.
    if (process.env.ELECTRON_PACKAGED) {
      args.push('--no-sandbox', '--disable-setuid-sandbox');
    }
    const opts: Record<string, unknown> = { headless, args };
    const channel = options?.channel ?? process.env.ABJECTS_BROWSER_CHANNEL ?? (headless ? undefined : 'chrome');
    if (channel) opts.channel = channel;
    return opts;
  }

  /** Stable key for an ephemeral browser so headless and headful (and distinct
   *  channels) get separate reusable instances. */
  private launchKey(opts: Record<string, unknown>): string {
    return `${opts.headless ? 'headless' : 'headful'}:${(opts.channel as string) ?? 'chromium'}`;
  }

  /**
   * Launch a browser/context with graceful degradation: a requested channel
   * (e.g. real Chrome) that isn't installed, or a headful launch with no
   * usable display, fails hard — retry once with bundled-Chromium headless so
   * browsing still works (interactive anti-bot challenges just won't pass).
   */
  private async launchWithFallback<T>(
    launch: (opts: Record<string, unknown>) => Promise<T>,
    opts: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await launch(opts);
    } catch (err) {
      if (opts.channel || opts.headless === false) {
        log.info(
          `Browser launch failed (${opts.channel ? `channel=${opts.channel} ` : ''}` +
          `headless=${opts.headless}); falling back to bundled headless. ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
        const fallback: Record<string, unknown> = { ...opts, headless: true };
        delete fallback.channel;
        return await launch(fallback);
      }
      throw err;
    }
  }

  /**
   * Lazy-launch (or reuse) an ephemeral browser for the requested mode. A
   * headless and a headful browser can coexist, keyed by launch signature.
   */
  private async ensureBrowser(options?: BrowseOptions): Promise<unknown> {
    const launchOpts = this.baseLaunchOptions(options);
    const key = this.launchKey(launchOpts);
    const existing = this.ephemeralBrowsers.get(key);
    if (existing) return existing;

    try {
      const pw = await import('playwright');
      this.chromium = pw.chromium;

      const browser = await this.launchWithFallback(
        (opts) => (this.chromium as { launch: (o: unknown) => Promise<unknown> }).launch(opts),
        launchOpts,
      );
      this.ephemeralBrowsers.set(key, browser);

      // If the browser disconnects unexpectedly, clear its tracked pages
      (browser as { on: (event: string, fn: () => void) => void }).on('disconnected', () => {
        this.pages.clear();
        if (this.ephemeralBrowsers.get(key) === browser) this.ephemeralBrowsers.delete(key);
      });

      return browser;
    } catch (err) {
      throw new Error(
        `WebBrowser requires playwright. Install with: pnpm add playwright && pnpm exec playwright install chromium. ` +
        `Error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Create a new page. If `options.profile` is set, the page is opened in the
   * caller's persistent BrowserContext (cookies / localStorage / IndexedDB
   * survive across calls). Otherwise the existing ephemeral path is used.
   */
  private async createPage(callerId: AbjectId, options?: BrowseOptions): Promise<unknown> {
    const pageOpts: Record<string, unknown> = {
      acceptDownloads: true,  // Prevent "Download is starting" errors for non-HTML responses
    };
    if (options?.userAgent) pageOpts.userAgent = options.userAgent;
    if (options?.viewport) pageOpts.viewport = options.viewport;

    if (options?.profile) {
      const ctx = await this.ensureProfileContext(callerId, options.profile, options);
      return ctx.context.newPage(pageOpts);
    }

    const browser = await this.ensureBrowser(options) as {
      newPage: (opts?: unknown) => Promise<unknown>;
    };
    return browser.newPage(pageOpts);
  }

  /**
   * Acquire a page and return a release callback that closes the page
   * (ephemeral path) or just releases the reference (persistent profile —
   * keeps the BrowserContext alive so the next call still has cookies).
   */
  private async acquirePage(
    callerId: AbjectId,
    options?: BrowseOptions,
  ): Promise<{ page: PlaywrightPage; release: () => Promise<void> }> {
    const page = await this.createPage(callerId, options) as PlaywrightPage;
    return {
      page,
      release: async () => {
        try { await page.close(); } catch { /* already closed */ }
      },
    };
  }

  /** Safely read page title, returning fallback if execution context was destroyed. */
  private async safeTitle(page: PlaywrightPage, fallback = ''): Promise<string> {
    try {
      return await page.title();
    } catch {
      log.info('safeTitle: execution context unavailable, returning fallback');
      return fallback;
    }
  }

  /** Safely read page content, returning fallback if execution context was destroyed. */
  private async safeContent(page: PlaywrightPage, fallback = ''): Promise<string> {
    try {
      return await page.content();
    } catch {
      log.info('safeContent: execution context unavailable, returning fallback');
      return fallback;
    }
  }

  /** Safely read viewport size, returning defaults if page context is unavailable. */
  private safeViewportSize(page: PlaywrightPage): { width: number; height: number } {
    try {
      return page.viewportSize() ?? { width: 1280, height: 720 };
    } catch {
      return { width: 1280, height: 720 };
    }
  }

  /**
   * Navigate a page to a URL and wait for content.
   */
  private async navigatePage(
    page: Pick<PlaywrightPage, 'goto' | 'waitForSelector' | 'setContent'>,
    url: string,
    options?: BrowseOptions,
  ): Promise<void> {
    const timeout = options?.timeout ?? 30000;
    try {
      await page.goto(url, {
        waitUntil: options?.waitUntil ?? 'domcontentloaded',
        timeout,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Download is starting')) {
        // Non-HTML response (text/plain, application/octet-stream, etc.)
        // Fetch the content directly and inject it into the page as preformatted text
        log.info(`navigatePage: download triggered for ${url}, fetching content directly`);
        try {
          const resp = await fetch(url);
          const text = await resp.text();
          const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          await page.setContent(
            `<html><head><title>${url}</title></head><body><pre>${escaped}</pre></body></html>`
          );
        } catch (fetchErr) {
          throw new Error(`Download response from ${url} and fetch fallback failed: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
        }
        return;
      }
      throw err;
    }
    if (options?.waitFor) {
      await page.waitForSelector(options.waitFor, { timeout });
    }
  }

  // ===========================================================================
  // One-shot implementations (unchanged behavior)
  // ===========================================================================

  private async doGetRenderedHtml(
    callerId: AbjectId,
    url: string,
    options?: BrowseOptions,
  ): Promise<{ html: string; url: string; title: string }> {
    const { page, release } = await this.acquirePage(callerId, options);
    try {
      await this.navigatePage(page, url, options);
      const finalUrl = page.url();
      const html = await this.safeContent(page, `<!-- content unavailable for ${finalUrl} -->`);
      const title = await this.safeTitle(page, finalUrl);
      return { html, url: finalUrl, title };
    } finally {
      await release();
    }
  }

  private async doScreenshot(
    callerId: AbjectId,
    url: string,
    options?: BrowseOptions,
  ): Promise<{ dataUri: string; width: number; height: number }> {
    const { page, release } = await this.acquirePage(callerId, options);
    try {
      await this.navigatePage(page, url, options);
      const buffer = await page.screenshot({ type: 'png', fullPage: false });
      const b64 = Buffer.from(buffer).toString('base64');
      const dataUri = `data:image/png;base64,${b64}`;
      const viewport = this.safeViewportSize(page);
      return { dataUri, width: viewport.width, height: viewport.height };
    } finally {
      await release();
    }
  }

  private async doExtractFromPage(
    callerId: AbjectId,
    url: string,
    selector: string,
    options?: BrowseOptions,
  ): Promise<ExtractedElement[]> {
    const { page, release } = await this.acquirePage(callerId, options);
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
      await release();
    }
  }

  // ===========================================================================
  // Profile (persistent context) management
  // ===========================================================================

  /** Sanitize a profile name to a safe filesystem segment. */
  private sanitizeProfileName(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  }

  /**
   * Resolve the caller's workspace by looking up its registration. Falls back
   * to `system` if the caller has no scoped typeId (legacy / unscoped).
   */
  private async resolveCallerWorkspace(callerId: AbjectId): Promise<string> {
    const cached = this.callerWorkspaceCache.get(callerId);
    if (cached) return cached;

    let workspaceId = 'system';
    if (this.registryId) {
      try {
        const reg = await this.request<{ typeId?: string } | null>(
          request(this.id, this.registryId, 'lookup', { objectId: callerId }),
        );
        const parts = reg?.typeId?.split('/');
        if (parts && parts.length >= 3 && parts[1]) workspaceId = parts[1];
      } catch { /* fall back to 'system' */ }
    }
    this.callerWorkspaceCache.set(callerId, workspaceId);
    return workspaceId;
  }

  /**
   * Return the profile key (`{workspaceId}/{profileName}`) for the caller, or
   * undefined if no profile was requested. Caller-supplied name is sanitized.
   */
  private async resolveProfileKey(
    callerId: AbjectId,
    profile: string | undefined,
  ): Promise<string | undefined> {
    if (!profile) return undefined;
    const sanitized = this.sanitizeProfileName(profile);
    if (!sanitized) return undefined;
    const wsId = await this.resolveCallerWorkspace(callerId);
    return `${wsId}/${sanitized}`;
  }

  /**
   * Lazily launch (or reuse) a persistent BrowserContext for the named profile
   * in the caller's workspace.
   */
  private async ensureProfileContext(
    callerId: AbjectId,
    profileName: string,
    options?: BrowseOptions,
  ): Promise<ProfileContext> {
    const wsId = await this.resolveCallerWorkspace(callerId);
    const safeName = this.sanitizeProfileName(profileName);
    requireContract(safeName.length > 0, `Invalid profile name: ${profileName}`);
    const key = `${wsId}/${safeName}`;

    const wantHeadless = this.browserHeadless(options);
    const existing = this.profileContexts.get(key);
    if (existing) {
      // A persistent context is locked to one user-data-dir, so we can't run
      // two modes at once. If the caller wants a different mode and no pages
      // are open, relaunch it in that mode; otherwise reuse what's live.
      // Use the authoritative live-page scan, not the openPages counter.
      if (existing.headless !== wantHeadless && this.liveProfilePages(key) === 0) {
        try { await existing.context.close(); } catch { /* already gone */ }
        this.profileContexts.delete(key);
      } else {
        existing.lastUsed = Date.now();
        await this.writeProfileIndex(key, existing);
        return existing;
      }
    }

    const dir = path.join(this.profilesRoot, wsId, safeName);
    await fs.mkdir(dir, { recursive: true });

    // Lazy-load Playwright to match the existing pattern in ensureBrowser().
    if (!this.chromium) {
      const pw = await import('playwright');
      this.chromium = pw.chromium;
    }

    const launchOptions: Record<string, unknown> = { ...this.baseLaunchOptions(options) };
    if (options?.userAgent) launchOptions.userAgent = options.userAgent;
    if (options?.viewport) launchOptions.viewport = options.viewport;
    launchOptions.acceptDownloads = true;

    const context = await this.launchWithFallback(
      (opts) => (this.chromium as {
        launchPersistentContext: (dir: string, opts: unknown) => Promise<{
          newPage: (opts?: unknown) => Promise<unknown>;
          close: () => Promise<void>;
          on: (event: string, fn: () => void) => void;
        }>;
      }).launchPersistentContext(dir, opts),
      launchOptions,
    );

    const now = Date.now();
    const entry: ProfileContext = {
      workspaceId: wsId,
      name: safeName,
      context,
      dir,
      openPages: 0,
      headless: (launchOptions.headless as boolean) ?? true,
      createdAt: now,
      lastUsed: now,
    };

    // Drop the cached entry if Playwright closes the context out from under us.
    context.on('close', () => {
      const current = this.profileContexts.get(key);
      if (current === entry) this.profileContexts.delete(key);
    });

    this.profileContexts.set(key, entry);
    await this.writeProfileIndex(key, entry);
    this.changed('profileOpened', { profile: safeName, workspaceId: wsId });
    log.info(`profile context ready: ${key} (${dir})`);
    return entry;
  }

  /** Persist the metadata for a single profile under the Storage index. */
  private async writeProfileIndex(key: string, entry: ProfileContext): Promise<void> {
    if (!this.storageId) return;
    try {
      const index = await this.readProfileIndex();
      index[key] = {
        workspaceId: entry.workspaceId,
        name: entry.name,
        dir: entry.dir,
        createdAt: index[key]?.createdAt ?? entry.createdAt,
        lastUsed: entry.lastUsed,
      };
      await this.request(request(this.id, this.storageId, 'set',
        { key: WebBrowser.PROFILES_INDEX_KEY, value: index }));
    } catch { /* best effort */ }
  }

  /** Drop a single profile entry from the Storage index. */
  private async deleteProfileIndex(key: string): Promise<void> {
    if (!this.storageId) return;
    try {
      const index = await this.readProfileIndex();
      if (key in index) {
        delete index[key];
        await this.request(request(this.id, this.storageId, 'set',
          { key: WebBrowser.PROFILES_INDEX_KEY, value: index }));
      }
    } catch { /* best effort */ }
  }

  private async readProfileIndex(): Promise<Record<string, {
    workspaceId: string; name: string; dir: string; createdAt: number; lastUsed: number;
  }>> {
    if (!this.storageId) return {};
    try {
      const v = await this.request<Record<string, {
        workspaceId: string; name: string; dir: string; createdAt: number; lastUsed: number;
      }> | null>(request(this.id, this.storageId, 'get', { key: WebBrowser.PROFILES_INDEX_KEY }));
      return v ?? {};
    } catch {
      return {};
    }
  }

  private setupProfileHandlers(): void {
    this.on('listProfiles', (msg: AbjectMessage) => {
      this.doListProfiles(msg.routing.from).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => this.send(error(msg, 'BROWSER_ERROR',
          err instanceof Error ? err.message : String(err))),
      );
      return DEFERRED_REPLY;
    });

    this.on('deleteProfile', (msg: AbjectMessage) => {
      const { profile } = msg.payload as { profile: string };
      this.doDeleteProfile(msg.routing.from, profile).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => this.send(error(msg, 'BROWSER_ERROR',
          err instanceof Error ? err.message : String(err))),
      );
      return DEFERRED_REPLY;
    });
  }

  private async doListProfiles(callerId: AbjectId): Promise<Array<{
    name: string; createdAt: number; lastUsed: number; openPages: number;
  }>> {
    const wsId = await this.resolveCallerWorkspace(callerId);
    const index = await this.readProfileIndex();
    const prefix = `${wsId}/`;
    const results: Array<{ name: string; createdAt: number; lastUsed: number; openPages: number }> = [];
    for (const [key, meta] of Object.entries(index)) {
      if (!key.startsWith(prefix)) continue;
      const live = this.profileContexts.get(key);
      results.push({
        name: meta.name,
        createdAt: meta.createdAt,
        lastUsed: live?.lastUsed ?? meta.lastUsed,
        openPages: live?.openPages ?? 0,
      });
    }
    return results;
  }

  private async doDeleteProfile(
    callerId: AbjectId,
    profileName: string,
  ): Promise<{ deleted: boolean }> {
    const wsId = await this.resolveCallerWorkspace(callerId);
    const safeName = this.sanitizeProfileName(profileName);
    requireContract(safeName.length > 0, `Invalid profile name: ${profileName}`);
    const key = `${wsId}/${safeName}`;

    // Close any open context first so Playwright releases the user-data-dir.
    const live = this.profileContexts.get(key);
    if (live) {
      this.profileContexts.delete(key);
      try { await live.context.close(); } catch { /* ignore */ }
    }

    // Remove the on-disk profile directory.
    const dir = path.join(this.profilesRoot, wsId, safeName);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch { /* best effort */ }

    await this.deleteProfileIndex(key);
    this.changed('profileDeleted', { profile: safeName, workspaceId: wsId });
    log.info(`profile deleted: ${key}`);
    return { deleted: true };
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  protected override async onStop(): Promise<void> {
    await this.closeAllTrackedPages();
    for (const [, browser] of this.ephemeralBrowsers) {
      try {
        await (browser as { close: () => Promise<void> }).close();
      } catch { /* ignore cleanup errors */ }
    }
    this.ephemeralBrowsers.clear();
    // Close every persistent profile context.
    for (const [, entry] of this.profileContexts) {
      try { await entry.context.close(); } catch { /* ignore */ }
    }
    this.profileContexts.clear();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## WebBrowser Usage Guide

Use WebBrowser for JavaScript-rendered pages (React SPAs, Instagram, Twitter, etc.).
For static HTML pages, prefer HttpClient.get() + WebParser instead.

### PERSISTENT PROFILES (remember logins)

Pass \`options.profile: '<name>'\` to any method to use a per-workspace persistent
profile. Cookies, localStorage, IndexedDB, and service workers survive across
calls AND process restarts — log in once, stay logged in. Omit \`profile\` for
an ephemeral fresh session.

  // First call: log in interactively, cookies are stored.
  const { pageId } = await this.call(this.dep('WebBrowser'), 'openPage',
    { options: { profile: 'gmail' } });
  await this.call(this.dep('WebBrowser'), 'navigateTo',
    { pageId, url: 'https://mail.google.com' });
  // … perform login …
  await this.call(this.dep('WebBrowser'), 'closePage', { pageId });

  // Days later, same profile name → already logged in:
  const next = await this.call(this.dep('WebBrowser'), 'openPage',
    { options: { profile: 'gmail' } });

Manage profiles:
  await this.call(this.dep('WebBrowser'), 'listProfiles', {});
  // → [{ name: 'gmail', createdAt, lastUsed, openPages }]
  await this.call(this.dep('WebBrowser'), 'deleteProfile', { profile: 'gmail' });

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
Viewer:        viewerScreenshot(pageId), viewerInput(pageId, events), viewerNavigate(pageId, nav) — no ownership check; used by the visual browser monitor for live view, human takeover (raw mouse/keyboard replay), and back/forward/reload

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
    viewport: { width: 1280, height: 720 },
    headful: true,        // launch a real (non-headless) browser
    channel: 'chrome' }   // drive the installed browser instead of bundled Chromium

### Headless vs headful (anti-bot / human verification)

Pages launch HEADLESS by default. Headless Chromium fails Cloudflare Turnstile
and similar fingerprint checks (navigator.webdriver, "HeadlessChrome" UA,
SwiftShader software WebGL) even when a real human clicks the challenge through
the WebBrowserViewer takeover. To let a human pass such a challenge, open the
page with \`options.headful: true\` (defaults to the installed Chrome for a real
branded fingerprint; override with \`options.channel\`). Headful needs a display
— present on the desktop app (mac/windows/linux) and any machine with a GUI;
on a pure headless server it falls back to headless automatically. All other
Playwright capabilities are unchanged in either mode. Global override:
ABJECTS_BROWSER_HEADFUL=1/0, ABJECTS_BROWSER_CHANNEL=chrome.

### Pattern: Display Screenshots on Surface

  const shot = await this.call(this.dep('WebBrowser'), 'screenshot',
    { url: 'https://example.com', options: { viewport: { width: 800, height: 600 } } });
  await this.call(this.dep('UIServer'), 'draw', {
    commands: [{ type: 'imageUrl', surfaceId, params: { x: 0, y: 0, width: 400, height: 300, url: shot.dataUri } }]
  });

### Pattern: OAuth / Login Flow with Redirect Capture

Use this when a site requires login (e.g. Instagram, GitHub, Google) and you need to
capture an auth code or token from a redirect URL.

  const browser = this.dep('WebBrowser');

  // 1. Open a page and navigate to the login/OAuth page
  const { pageId } = await this.call(browser, 'openPage', {});
  await this.call(browser, 'navigateTo',
    { pageId, url: 'https://example.com/oauth/authorize?client_id=...&redirect_uri=https://localhost/callback' });

  // 2. Fill in credentials and submit
  await this.call(browser, 'fill',
    { pageId, selector: 'input[name="username"]', value: username });
  await this.call(browser, 'fill',
    { pageId, selector: 'input[name="password"]', value: password });
  await this.call(browser, 'click',
    { pageId, selector: 'button[type="submit"]' });

  // 3. Wait for redirect, then poll getUrl() to detect the callback URL
  //    (waitForSelector returns {found:false} on timeout — use it to pace the loop)
  let redirectUrl = '';
  for (let i = 0; i < 30; i++) {
    const { url } = await this.call(browser, 'getUrl', { pageId });
    if (url.includes('/callback')) { redirectUrl = url; break; }
    await this.call(browser, 'waitForSelector',
      { pageId, selector: '#nonexistent', options: { timeout: 1000 } });
  }

  // 4. Extract the auth code from the redirect URL
  const code = new URL(redirectUrl).searchParams.get('code');

  // 5. Exchange code for token using HttpClient (fetch() is NOT available)
  const tokenResp = await this.call(this.dep('HttpClient'), 'post', {
    url: 'https://example.com/oauth/token',
    body: { grant_type: 'authorization_code', code, redirect_uri: 'https://localhost/callback' },
    headers: { 'Content-Type': 'application/json' }
  });

  // 6. Clean up the page
  await this.call(browser, 'closePage', { pageId });

Key points:
- Do NOT use fetch(), window.open(), or browser redirects — they are unavailable in the sandbox.
- Use getUrl(pageId) to read the current URL after navigation/redirect.
- Use waitForSelector with a short timeout as a sleep/polling mechanism.
- Use HttpClient for any API calls (token exchange, API requests with the token).
- ALWAYS closePage when done.`;
  }
}

// Well-known WebBrowser ID
export const WEB_BROWSER_ID = 'abjects:web-browser' as AbjectId;
